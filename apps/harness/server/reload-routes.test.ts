/**
 * G1.4b 资源重载 HTTP 路由。
 *
 * 使用生产路由与受控客户端 mock，不起 SDK：覆盖目标互斥、触发来源校验、
 * busy/failed 原样转发（不改成 5xx）与客户端响应校验。
 */
import type { HarnessClient, HarnessReloadResult } from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react/client'
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

const operation = {
  id: 't1:reload:1',
  trigger: 'settings' as const,
  status: 'succeeded' as const,
  threadId: 't1',
  workspacePath: '/workspace',
  startedAt: '2026-11-01T00:00:00.000Z',
  finishedAt: '2026-11-01T00:00:01.000Z',
  fromResourceRevision: 0,
  resourceRevision: 1,
}

const reloaded: HarnessReloadResult = {
  status: 'reloaded',
  kind: 'session',
  threadId: 't1',
  workspacePath: '/workspace',
  operation,
  resourceRevision: 1,
}

const busy: HarnessReloadResult = {
  status: 'busy',
  message: '会话正在运行或发送中',
  threadId: 't1',
  workspacePath: '/workspace',
}

const failed: HarnessReloadResult = {
  status: 'failed',
  reason: 'trust',
  message: '项目新增了需要信任的资源',
  operation: { ...operation, status: 'failed' },
}

const setup = (overrides: Partial<HarnessClient> = {}) => {
  const client = {
    reloadResources: vi.fn(async () => reloaded),
    ...overrides,
  } as unknown as HarnessClient
  return { app: createApp(client, config), client }
}

const postReload = (app: ReturnType<typeof setup>['app'], body: unknown) =>
  app.request('/api/pi/reload', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

describe('资源重载路由', () => {
  it('目标必须恰好提供一个，触发来源只接受受控值', async () => {
    const { app, client } = setup()
    expect((await postReload(app, {})).status).toBe(400)
    expect(
      (await postReload(app, { target: { threadId: 't1', workspacePath: '/workspace' } })).status,
    ).toBe(400)
    expect((await postReload(app, { target: { threadId: 't1' }, trigger: 'curl' })).status).toBe(
      400,
    )
    expect(client.reloadResources).not.toHaveBeenCalled()

    const ok = await postReload(app, { target: { threadId: 't1' }, trigger: 'settings' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual(reloaded)
    expect(client.reloadResources).toHaveBeenCalledWith({ threadId: 't1', trigger: 'settings' })

    // 省略触发来源时由宿主按 api 处理。
    const fallback = setup()
    await postReload(fallback.app, { target: { workspacePath: '/workspace' } })
    expect(fallback.client.reloadResources).toHaveBeenCalledWith({ workspacePath: '/workspace' })
  })

  it('busy 与 failed 原样返回（200），不改写成 5xx 或假成功', async () => {
    const busyApp = setup({ reloadResources: vi.fn(async () => busy) })
    const busyResponse = await postReload(busyApp.app, { target: { threadId: 't1' } })
    expect(busyResponse.status).toBe(200)
    expect(await busyResponse.json()).toEqual(busy)

    const failedApp = setup({ reloadResources: vi.fn(async () => failed) })
    const failedResponse = await postReload(failedApp.app, { target: { threadId: 't1' } })
    expect(failedResponse.status).toBe(200)
    expect(await failedResponse.json()).toEqual(failed)
  })
})

describe('真实 HTTP 客户端的重载响应校验', () => {
  it('转发请求体并接受合法结果', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const client = createHarnessHttpClient({
      baseUrl: 'http://host/api/pi',
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        calls.push({ url, body: init?.body })
        return new Response(JSON.stringify(reloaded), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    const result = await client.reloadResources({ threadId: 't1', trigger: 'command' })
    expect(result.status).toBe('reloaded')
    expect(calls[0]?.url).toContain('/reload')
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      target: { threadId: 't1' },
      trigger: 'command',
    })
  })

  it('拒绝畸形载荷（例如未知状态或缺少操作身份）', async () => {
    const client = createHarnessHttpClient({
      baseUrl: 'http://host/api/pi',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ status: 'reloaded', kind: 'session' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    await expect(client.reloadResources({ threadId: 't1' })).rejects.toThrow(/reload result/i)
  })
})
