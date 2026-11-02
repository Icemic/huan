/**
 * G1.4c 认证 HTTP 路由。
 *
 * 复用生产路由与真实浏览器客户端；凭据回填不进入响应，非法的 provider/
 * method/超大正文被明确拒绝，鉴权仍沿用现有中间件。
 */
import type { HarnessClient, HarnessProviderAuthSnapshot } from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react/client'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { ServerConfig } from './config.js'
import { PROVIDER_AUTH_BODY_LIMIT_BYTES } from './provider-auth-routes.js'

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

const snapshot: HarnessProviderAuthSnapshot = {
  seq: 3,
  authRevision: 1,
  providers: [
    {
      providerId: 'synthetic-provider',
      name: '合成 Provider',
      configured: true,
      source: 'stored',
      storedCredentialType: 'api_key',
      methods: [{ type: 'api_key', label: '测试 API key', loginable: true }],
      ambientOnly: false,
    },
  ],
  operations: [],
}

const setup = (overrides: Partial<HarnessClient> = {}) => {
  const client = {
    getProviderAuth: vi.fn(async () => snapshot),
    subscribeProviderAuth: vi.fn(() => () => {}),
    startProviderLogin: vi.fn(async () => ({
      status: 'invalid' as const,
      message: '未知 provider',
    })),
    respondProviderAuthPrompt: vi.fn(async () => ({ status: 'accepted' as const })),
    cancelProviderAuth: vi.fn(async () => ({ status: 'not-found' as const })),
    logoutProvider: vi.fn(async () => ({
      status: 'invalid' as const,
      message: '没有已存凭据',
    })),
    ...overrides,
  } as unknown as HarnessClient
  return { app: createApp(client, config), client }
}

describe('认证路由安全与输入校验', () => {
  it('GET 快照需要 token，真实客户端可解析', async () => {
    const { app } = setup()
    const denied = await app.request('/api/pi/provider-auth', {
      headers: { host: 'localhost:8788', origin: 'http://localhost:8799' },
    })
    expect(denied.status).toBe(401)

    const client = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })
    expect(await client.getProviderAuth()).toEqual(snapshot)
  })

  it('非法 provider/method 返回 400；语义不支持的 provider 返回 typed invalid', async () => {
    const { app, client } = setup()
    const missing = await app.request('/api/pi/provider-auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: '', method: 'api_key' }),
    })
    expect(missing.status).toBe(400)
    const badMethod = await app.request('/api/pi/provider-auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: 'synthetic-provider', method: 'password' }),
    })
    expect(badMethod.status).toBe(400)
    expect(client.startProviderLogin).not.toHaveBeenCalled()

    const unknown = await app.request('/api/pi/provider-auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: 'unknown-provider', method: 'oauth' }),
    })
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ status: 'invalid', message: '未知 provider' })
  })

  it('回填值不进入响应；超长正文按 400/413 拒绝', async () => {
    const { app, client } = setup()
    const secret = 'sk-http-secret-value'
    const accepted = await app.request('/api/pi/provider-auth/respond', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: 'op-1',
        promptId: 'prompt-1',
        value: secret,
      }),
    })
    expect(accepted.status).toBe(200)
    const acceptedText = await accepted.text()
    expect(acceptedText).toBe('{"status":"accepted"}')
    expect(acceptedText).not.toContain(secret)
    expect(client.respondProviderAuthPrompt).toHaveBeenCalledWith({
      operationId: 'op-1',
      promptId: 'prompt-1',
      value: secret,
    })

    const tooLongValue = await app.request('/api/pi/provider-auth/respond', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: 'op-1',
        promptId: 'prompt-1',
        value: 'x'.repeat(9_000),
      }),
    })
    expect(tooLongValue.status).toBe(400)
    expect(await tooLongValue.text()).not.toContain('x'.repeat(20))

    const tooLarge = await app.request('/api/pi/provider-auth/respond', {
      method: 'POST',
      headers: {
        ...headers,
        'content-length': String(PROVIDER_AUTH_BODY_LIMIT_BYTES + 1),
      },
      body: JSON.stringify({ value: 'x'.repeat(PROVIDER_AUTH_BODY_LIMIT_BYTES) }),
    })
    expect(tooLarge.status).toBe(413)
  })

  it('取消与退出走 typed 结果，不泄露内部操作 ID 以外的信息', async () => {
    const { app } = setup()
    const cancelled = await app.request('/api/pi/provider-auth/cancel', {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: 'missing' }),
    })
    expect(await cancelled.json()).toEqual({ status: 'not-found' })
    const logout = await app.request('/api/pi/provider-auth/logout', {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: 'ambient-provider' }),
    })
    expect(await logout.json()).toEqual({ status: 'invalid', message: '没有已存凭据' })
  })
})
