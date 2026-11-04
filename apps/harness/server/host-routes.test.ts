import {
  HARNESS_PROTOCOL_VERSION,
  type HarnessHostInfo,
  type HarnessSubagentTask,
  type HarnessSubagentTaskView,
} from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react/client'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from './config.js'
import { registerHostRoutes } from './host-routes.js'

const info: HarnessHostInfo = {
  protocolVersion: HARNESS_PROTOCOL_VERSION,
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
const subagentTask: HarnessSubagentTask = {
  taskId: 'task-1',
  parentThreadId: 't1',
  agent: 'reviewer',
  task: '审查改动',
  status: 'running',
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
}

const subagentView: HarnessSubagentTaskView = {
  task: subagentTask,
  snapshot: { metadata: { id: 't1', status: 'running' }, messages: [] },
  requests: [{ id: 'r1', kind: 'confirm', title: '继续？', message: '子任务等待确认。' }],
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
  const getSubagentTask = vi.fn(async () => subagentView)
  const cancelSubagentTask = vi.fn(async () => undefined)
  const respondSubagentTask = vi.fn(async () => undefined)
  registerHostRoutes(
    app,
    { getHostInfo, getSubagentTask, cancelSubagentTask, respondSubagentTask },
    config,
  )
  return { app, getHostInfo, getSubagentTask, cancelSubagentTask, respondSubagentTask }
}

const headers = {
  host: 'localhost:8788',
  origin: 'http://localhost:8799',
  'x-huan-token': 'test-token',
}

/** 用真实 HTTP 客户端验证生产路由；测试只替换宿主实现。 */
const authorizedClient = (app: Hono) =>
  createHarnessHttpClient({
    baseUrl: 'http://localhost:8788/api/pi',
    headers,
    fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
  })

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
    const client = authorizedClient(app)
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

  it('子任务查看、取消与应答经同一鉴权路由转发给宿主', async () => {
    const { app, getSubagentTask, cancelSubagentTask, respondSubagentTask } = setup()
    const client = authorizedClient(app)

    await expect(client.getSubagentTask('t1', 'task-1')).resolves.toEqual(subagentView)
    await client.cancelSubagentTask('t1', 'task-1')
    await client.respondSubagentTask('t1', 'task-1', { requestId: 'r1', confirmed: true })

    expect(getSubagentTask).toHaveBeenCalledWith('t1', 'task-1')
    expect(cancelSubagentTask).toHaveBeenCalledWith('t1', 'task-1')
    expect(respondSubagentTask).toHaveBeenCalledWith('t1', 'task-1', {
      requestId: 'r1',
      confirmed: true,
    })
  })

  it('子任务路由在读取任务前拒绝缺少凭据的请求', async () => {
    const { app, getSubagentTask, cancelSubagentTask, respondSubagentTask } = setup()
    const cases = [
      ['GET', '/api/pi/threads/t1/subagents/task-1'],
      ['POST', '/api/pi/threads/t1/subagents/task-1/cancel'],
      ['POST', '/api/pi/threads/t1/subagents/task-1/respond'],
    ] as const
    for (const [method, path] of cases) {
      const response = await app.request(path, {
        method,
        headers: { host: 'localhost:8788', origin: 'http://localhost:8799' },
      })
      expect(response.status).toBe(401)
    }
    expect(getSubagentTask).not.toHaveBeenCalled()
    expect(cancelSubagentTask).not.toHaveBeenCalled()
    expect(respondSubagentTask).not.toHaveBeenCalled()
  })

  it('拒绝不安全的任务 ID 与字段形状非法的应答', async () => {
    const { app, getSubagentTask, cancelSubagentTask, respondSubagentTask } = setup()
    const unsafe = [
      ['GET', '/api/pi/threads/-t1/subagents/task-1'],
      ['GET', '/api/pi/threads/t1/subagents/task-'],
      ['POST', '/api/pi/threads/t1/subagents/bad%2Ftask/cancel'],
    ] as const
    for (const [method, path] of unsafe) {
      const response = await app.request(path, { method, headers })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid-subagent-input' })
    }
    expect(getSubagentTask).not.toHaveBeenCalled()
    expect(cancelSubagentTask).not.toHaveBeenCalled()

    const bodies: unknown[] = [
      {},
      { response: { requestId: 'r1' } },
      { response: { requestId: '', confirmed: true } },
      { response: { requestId: 'r1', confirmed: true, value: 'x' } },
      { response: { requestId: 'r1', dismissed: false } },
    ]
    for (const body of bodies) {
      const response = await app.request('/api/pi/threads/t1/subagents/task-1/respond', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(respondSubagentTask).not.toHaveBeenCalled()
  })
})
