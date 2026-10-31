import type { HarnessHostInfo } from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from './config.js'
import { registerHostRoutes } from './host-routes.js'

const info: HarnessHostInfo = {
  workspacePath: '/workspace',
  agentDir: '/private/agent',
  agentDirSource: 'option',
  sessionStorage: {
    mode: 'grouped',
    root: '/private/agent/sessions',
    directory: '/private/agent/sessions/--workspace--',
    source: 'default',
  },
  defaultModel: {
    providerSource: 'default',
    modelIdSource: 'default',
    readiness: { state: 'missing-model', message: '请选择模型' },
  },
  diagnostics: [],
}
const config: ServerConfig = {
  workspacePath: '/workspace',
  agentDir: '/private/agent',
  port: 8788,
  allowedHosts: ['localhost:8788'],
  allowedOrigins: ['http://localhost:8799'],
  token: 'test-token',
}

function setup() {
  const app = new Hono()
  const getHostInfo = vi.fn(async () => info)
  registerHostRoutes(app, { getHostInfo }, config)
  return { app, getHostInfo }
}

describe('宿主状态路由安全与真实 HTTP 客户端', () => {
  it('health 无凭据也只返回 ok，不携带路径或诊断', async () => {
    const { app, getHostInfo } = setup()
    const response = await app.request('/api/pi/health', { headers: { host: 'localhost:8788' } })
    expect(await response.json()).toEqual({ ok: true })
    expect(getHostInfo).not.toHaveBeenCalled()
  })

  it('Host、Origin、token 校验均先于状态读取', async () => {
    const { app, getHostInfo } = setup()
    const cases: Array<Record<string, string>> = [
      { host: 'attacker.invalid', origin: 'http://localhost:8799', 'x-huan-token': 'test-token' },
      { host: 'localhost:8788', origin: 'http://attacker.invalid', 'x-huan-token': 'test-token' },
      { host: 'localhost:8788', origin: 'http://localhost:8799' },
    ]
    for (const headers of cases) {
      const response = await app.request('/api/pi/host', { headers })
      expect(response.status).toBe(headers['x-huan-token'] ? 403 : 401)
      expect(await response.text()).not.toContain(info.agentDir)
    }
    expect(getHostInfo).not.toHaveBeenCalled()
    expect(
      (await app.request('/api/pi/health', { headers: { host: 'attacker.invalid' } })).status,
    ).toBe(403)
  })

  it('HTTP 客户端携带凭据并读取经过同一生产路由返回的宿主信息', async () => {
    const { app, getHostInfo } = setup()
    const client = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers: {
        host: 'localhost:8788',
        origin: 'http://localhost:8799',
        'x-huan-token': 'test-token',
      },
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })
    expect(await client.getHostInfo()).toEqual(info)
    expect(getHostInfo).toHaveBeenCalledOnce()
  })

  it('拒绝畸形状态响应和未经约定的诊断原文', async () => {
    for (const value of [null, {}, { ...info, diagnostics: ['secret-error-content'] }]) {
      const client = createHarnessHttpClient({
        fetchImpl: (async () => Response.json(value)) as typeof fetch,
      })
      await expect(client.getHostInfo()).rejects.toThrow('Invalid Pi HTTP response')
    }
  })
})
