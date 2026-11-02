/**
 * MCP typed HTTP 客户端测试（G1.4d3）。
 *
 * 验证请求路径/查询、成功结果解析、typed stale/busy/failed 结果与畸形响应拒绝。
 */
import type {
  HarnessMcpAuthOperation,
  HarnessMcpAuthSnapshot,
  HarnessMcpConfigSnapshot,
  HarnessMcpSnapshot,
} from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import { createHarnessHttpClient, HarnessHttpError } from './http-client.js'

type Call = { url: string; method: string; body: unknown }

const fakeFetch = (responder: (url: string) => Response) => {
  const calls: Call[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return responder(url)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const target = { kind: 'workspace' as const, workspacePath: '/ws' }

const snapshot: HarnessMcpSnapshot = {
  target,
  live: false,
  projectTrusted: true,
  trust: { decision: 'trusted', requiresTrust: false, origin: 'trust' },
  servers: [
    {
      name: 'demo',
      identity: 'mcp:demo:stdio',
      scope: 'user',
      override: false,
      enabled: true,
      exposure: 'codemode',
      state: 'not-connected',
      toolCount: 0,
      hasResources: false,
      toolRevision: 0,
      auth: { kind: 'stdio', loginable: false, hasCredentials: false, needsRefresh: false },
    },
  ],
  issues: [],
}

const configSnapshot: HarnessMcpConfigSnapshot = {
  target,
  projectTrusted: true,
  trust: { decision: 'trusted', requiresTrust: false, origin: 'trust' },
  files: {
    user: {
      scope: 'user',
      path: '/agent/mcp.json',
      readable: true,
      exists: true,
      content: '{}\n',
      revision: 'r1',
      bytes: 3,
      tooLarge: false,
      issues: [],
    },
    project: {
      scope: 'project',
      path: '/ws/.pi/mcp.json',
      readable: true,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
    },
  },
  effective: { servers: [], issues: [] },
}

const authOperation: HarnessMcpAuthOperation = {
  id: 'op-1',
  server: 'demo',
  identity: 'mcp:demo:stdio',
  kind: 'login',
  phase: 'prompt',
  target,
  runtimeId: 'r1',
  startedAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:01.000Z',
  authUrl: 'http://127.0.0.1:1234/authorize',
  prompt: {
    promptId: 'p1',
    kind: 'redirect_url',
    message: '粘贴回调 URL',
  },
}

const authSnapshot: HarnessMcpAuthSnapshot = {
  seq: 1,
  authRevision: 0,
  operations: [authOperation],
}

describe('MCP typed HTTP 客户端', () => {
  it('getMcp 使用 target query，getMcpConfig 解析原文快照', async () => {
    const { fn, calls } = fakeFetch((url) =>
      json(url.includes('/config') ? configSnapshot : snapshot),
    )
    const client = createHarnessHttpClient({ fetchImpl: fn })
    expect(await client.getMcp({ workspacePath: '/ws' })).toEqual(snapshot)
    expect(calls[0]).toMatchObject({
      url: '/api/pi/mcp?workspacePath=%2Fws',
      method: 'GET',
    })
    expect(await client.getMcpConfig({ workspacePath: '/ws' })).toEqual(configSnapshot)
    expect(calls[1]?.url).toBe('/api/pi/mcp/config?workspacePath=%2Fws')
  })

  it('详情/管理/认证的 typed 失败结果不被误判为畸形', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/details')) return json({ status: 'stale', message: '目标已重载' })
      if (url.endsWith('/manage')) return json({ status: 'busy', message: '会话正忙' })
      if (url.endsWith('/auth/login')) return json({ status: 'started', operation: authOperation })
      if (url.endsWith('/auth/respond')) return json({ status: 'accepted' })
      if (url.endsWith('/auth/cancel'))
        return json({ status: 'finished', operation: authOperation })
      if (url.endsWith('/auth/logout')) return json({ status: 'stale', message: '旧目标' })
      return json(authSnapshot)
    })
    const client = createHarnessHttpClient({ fetchImpl: fn })
    expect(
      await client.getMcpDetails({
        target,
        expectedRuntimeId: 'r1',
        server: 'demo',
        include: ['tools'],
      }),
    ).toEqual({ status: 'stale', message: '目标已重载' })
    expect(
      await client.manageMcp({
        target,
        expectedRuntimeId: 'r1',
        server: 'demo',
        expectedIdentity: 'mcp:demo:stdio',
        action: { type: 'reconnect' },
      }),
    ).toEqual({ status: 'busy', message: '会话正忙' })
    expect(await client.getMcpAuth()).toEqual(authSnapshot)
    expect(
      await client.startMcpLogin({
        target,
        expectedRuntimeId: 'r1',
        server: 'demo',
        expectedIdentity: 'mcp:demo:stdio',
      }),
    ).toEqual({ status: 'started', operation: authOperation })
    expect(
      await client.respondMcpAuth({ operationId: 'op-1', promptId: 'p1', value: 'http://x' }),
    ).toEqual({ status: 'accepted' })
    expect(await client.cancelMcpAuth('op-1')).toEqual({
      status: 'finished',
      operation: authOperation,
    })
    expect(
      await client.logoutMcp({
        target,
        expectedRuntimeId: 'r1',
        server: 'demo',
        expectedIdentity: 'mcp:demo:stdio',
      }),
    ).toEqual({ status: 'stale', message: '旧目标' })
    expect(calls.map((call) => call.method)).toContain('POST')
  })

  it('畸形快照被拒绝，HTTP 冲突保留状态码与受控错误码', async () => {
    const malformed = fakeFetch(() => json({ target, live: 'yes' }))
    await expect(
      createHarnessHttpClient({ fetchImpl: malformed.fn }).getMcp({ workspacePath: '/ws' }),
    ).rejects.toThrow('Invalid Pi HTTP response')

    const conflict = fakeFetch(() => json({ error: 'mcp-config-conflict', message: '冲突' }, 409))
    await expect(
      createHarnessHttpClient({ fetchImpl: conflict.fn }).saveMcpConfig({
        target,
        scope: 'user',
        content: '{}\n',
        expectedRevision: 'old',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'mcp-config-conflict' })
    await expect(
      createHarnessHttpClient({ fetchImpl: conflict.fn }).saveMcpConfig({
        target,
        scope: 'user',
        content: '{}\n',
        expectedRevision: 'old',
      }),
    ).rejects.toBeInstanceOf(HarnessHttpError)
  })
})
