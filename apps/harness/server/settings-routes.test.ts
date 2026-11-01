/**
 * G1.4a 设置/资源 HTTP 路由。
 *
 * 使用生产路由与受控客户端 mock，不起 SDK；覆盖目标互斥、大小上限、
 * 冲突/未信任/写盘失败等错误码与客户端响应校验。
 */
import { SETTINGS_CONTENT_MAX_BYTES } from '@huan/core'
import type {
  HarnessClient,
  HarnessResourceSnapshot,
  HarnessSettingsSaveResult,
  HarnessSettingsSnapshot,
} from '@huan/protocol'
import { createHarnessHttpClient, HarnessHttpError } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { ServerConfig } from './config.js'

const config: ServerConfig = {
  workspacePath: '/workspace',
  agentDir: '/private/agent',
  port: 8788,
  allowedHosts: ['localhost:8788'],
  allowedOrigins: ['http://localhost:8799'],
  token: 'test-token',
}

const headers = {
  host: 'localhost:8788',
  origin: 'http://localhost:8799',
  'x-huan-token': 'test-token',
  'content-type': 'application/json',
}

const settingsFile = (scope: 'user' | 'project') => ({
  scope,
  path: scope === 'user' ? '/private/agent/settings.json' : '/workspace/.pi/settings.json',
  exists: false,
  content: '',
  revision: null,
  bytes: 0,
  readable: scope === 'user',
  tooLarge: false,
  issues: [],
})

const settingsSnapshot: HarnessSettingsSnapshot = {
  target: { kind: 'workspace', workspacePath: '/workspace' },
  agentDir: '/private/agent',
  projectTrusted: false,
  trust: { decision: 'needs-trust', requiresTrust: true, origin: 'ask' },
  files: { user: settingsFile('user'), project: settingsFile('project') },
  effective: { source: 'disk', values: {}, origins: {} },
}

const savedResult: HarnessSettingsSaveResult = {
  status: 'saved',
  scope: 'user',
  path: '/private/agent/settings.json',
  revision: 'abc',
  bytes: 2,
  snapshot: settingsSnapshot,
  apply: {
    persisted: true,
    reloadRequired: true,
    restartRequiredKeys: [],
    message: '已保存到磁盘；需重载。',
  },
}

const invalidResult: HarnessSettingsSaveResult = {
  status: 'invalid',
  scope: 'user',
  path: '/private/agent/settings.json',
  issues: [{ kind: 'schema', path: '/retry/enabled', message: '类型不符' }],
  message: '设置未保存：请先修复解析或校验问题。',
}

const conflictResult: HarnessSettingsSaveResult = {
  status: 'conflict',
  scope: 'user',
  path: '/private/agent/settings.json',
  revision: 'newer',
  message: '已修改',
}

const untrustedResult: HarnessSettingsSaveResult = {
  status: 'untrusted',
  scope: 'project',
  path: '/workspace/.pi/settings.json',
  message: '项目未信任',
}

const failedResult: HarnessSettingsSaveResult = {
  status: 'failed',
  scope: 'user',
  path: '/private/agent/settings.json',
  message: '写盘失败',
}

const resources: HarnessResourceSnapshot = {
  target: { kind: 'session', threadId: 't1', workspacePath: '/workspace' },
  agentDir: '/private/agent',
  trust: { decision: 'trusted', requiresTrust: false, origin: 'no-resources' },
  loadedFrom: 'assembly',
  projectResourcesLoaded: true,
  instructions: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  packages: [],
  loaded: [],
  diagnostics: [],
}

/** 仅路由实际访问的方法由 mock 提供；其余为未使用的占位。 */
const setup = (overrides: Partial<HarnessClient> = {}) => {
  const client = {
    getSettings: vi.fn(async () => settingsSnapshot),
    saveSettings: vi.fn(async () => savedResult),
    getResources: vi.fn(async () => resources),
    ...overrides,
  } as unknown as HarnessClient
  return { app: createApp(client, config), client }
}

const postSettings = (app: ReturnType<typeof setup>['app'], body: unknown) =>
  app.request('/api/pi/settings', {
    method: 'PUT',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('设置查询路由', () => {
  it('目标必须恰好提供一个', async () => {
    const { app, client } = setup()
    expect((await app.request('/api/pi/settings', { headers })).status).toBe(400)
    expect(
      (
        await app.request('/api/pi/settings?threadId=t1&workspacePath=/workspace', {
          headers,
        })
      ).status,
    ).toBe(400)
    expect(client.getSettings).not.toHaveBeenCalled()

    const ok = await app.request('/api/pi/settings?threadId=t1', { headers })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(settingsSnapshot)
    expect(client.getSettings).toHaveBeenCalledWith({ threadId: 't1' })
  })

  it('资源查询转发 includeText，且目标同样互斥', async () => {
    const { app, client } = setup()
    expect((await app.request('/api/pi/resources', { headers })).status).toBe(400)
    const ok = await app.request('/api/pi/resources?workspacePath=/workspace&includeText=true', {
      headers,
    })
    expect(ok.status).toBe(200)
    expect(client.getResources).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      includeText: true,
    })
  })
})

describe('设置保存路由', () => {
  it('缺少 expectedRevision 返回 400，超过大小上限返回 413', async () => {
    const { app, client } = setup()
    const invalid = await postSettings(app, {
      target: { threadId: 't1' },
      scope: 'user',
      content: '{}',
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid-settings-input' })
    expect(client.saveSettings).not.toHaveBeenCalled()

    const tooLarge = await postSettings(app, {
      target: { threadId: 't1' },
      scope: 'user',
      content: 'x'.repeat(SETTINGS_CONTENT_MAX_BYTES + 1),
      expectedRevision: null,
    })
    expect(tooLarge.status).toBe(413)
    expect((await tooLarge.json()).error).toBe('settings-too-large')
  })

  it('保存成功与校验失败返回结果，冲突/未信任/写失败返回错误码', async () => {
    const saved = setup()
    const ok = await postSettings(saved.app, {
      target: { threadId: 't1' },
      scope: 'user',
      content: '{}',
      expectedRevision: null,
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(savedResult)

    const invalid = setup({
      saveSettings: vi.fn(async () => invalidResult),
    })
    const issues = await postSettings(invalid.app, {
      target: { threadId: 't1' },
      scope: 'user',
      content: '{}',
      expectedRevision: null,
    })
    expect(issues.status).toBe(200)
    expect(await issues.json()).toEqual(invalidResult)

    const conflict = setup({ saveSettings: vi.fn(async () => conflictResult) })
    const conflictResponse = await postSettings(conflict.app, {
      target: { threadId: 't1' },
      scope: 'user',
      content: '{}',
      expectedRevision: null,
    })
    expect(conflictResponse.status).toBe(409)
    expect((await conflictResponse.json()).error).toBe('settings-conflict')

    const untrusted = setup({ saveSettings: vi.fn(async () => untrustedResult) })
    const untrustedResponse = await postSettings(untrusted.app, {
      target: { workspacePath: '/workspace' },
      scope: 'project',
      content: '{}',
      expectedRevision: null,
    })
    expect(untrustedResponse.status).toBe(409)
    expect((await untrustedResponse.json()).error).toBe('settings-untrusted')

    const failed = setup({ saveSettings: vi.fn(async () => failedResult) })
    const failedResponse = await postSettings(failed.app, {
      target: { threadId: 't1' },
      scope: 'user',
      content: '{}',
      expectedRevision: null,
    })
    expect(failedResponse.status).toBe(500)
    expect((await failedResponse.json()).error).toBe('settings-write-failed')
  })
})

describe('真实 HTTP 客户端响应校验', () => {
  it('getSettings/saveSettings/getResources 拒绝畸形载荷', async () => {
    const client = createHarnessHttpClient({
      baseUrl: 'http://host/api/pi',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ target: { kind: 'workspace' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    await expect(client.getSettings({ threadId: 't1' })).rejects.toThrow(/settings snapshot/i)
    await expect(client.getResources({ threadId: 't1' })).rejects.toThrow(/resource snapshot/i)
    await expect(
      client.saveSettings({
        target: { threadId: 't1' },
        scope: 'user',
        content: '{}',
        expectedRevision: null,
      }),
    ).rejects.toThrow(/settings save result/i)
  })

  it('HTTP 4xx 保留冲突错误码', async () => {
    const client = createHarnessHttpClient({
      baseUrl: 'http://host/api/pi',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'settings-conflict', message: '冲突' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    await expect(
      client.saveSettings({
        target: { threadId: 't1' },
        scope: 'user',
        content: '{}',
        expectedRevision: 'old',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'settings-conflict' })
    expect(HarnessHttpError).toBeTypeOf('function')
  })
})
