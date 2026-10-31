import { ProjectTrustRequiredError } from '@huan/core'
import type {
  HarnessClient,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessRecentProject,
} from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react'
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
}

const project: HarnessProjectInfo = {
  path: '/projects/app',
  name: 'app',
  status: 'needs-trust',
  trust: {
    decision: 'unknown',
    origin: 'ask',
    requiresTrust: true,
    defaultPolicy: 'ask',
    extensionErrorCount: 0,
  },
}

const pathCheck: HarnessProjectPathCheck = {
  input: '/projects/app',
  path: '/projects/app',
  exists: true,
  isDirectory: true,
}

const recent: HarnessRecentProject[] = [{ path: '/projects/app', name: 'app' }]

function setup(overrides: Partial<HarnessClient> = {}) {
  const client = {
    getHostInfo: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    getThread: vi.fn(),
    sendMessage: vi.fn(),
    cancelRun: vi.fn(),
    clearQueue: vi.fn(),
    checkProjectPath: vi.fn(async () => pathCheck),
    getProject: vi.fn(async () => project),
    decideProjectTrust: vi.fn(async () => ({ ...project, status: 'ready' as const })),
    listRecentProjects: vi.fn(async () => recent),
    getAvailableModels: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn(),
    unarchiveThread: vi.fn(),
    deleteThread: vi.fn(),
    respondToHostUiRequest: vi.fn(),
    subscribe: vi.fn(),
    ...overrides,
  } satisfies HarnessClient
  return { app: createApp(client, config), client }
}

describe('项目入口路由与真实 HTTP 客户端', () => {
  it('路径校验、查询、信任决定与最近项目都经统一鉴权路由', async () => {
    const { app, client } = setup()
    const pathResponse = await app.request('/api/pi/projects/check', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/projects/app' }),
    })
    expect(await pathResponse.json()).toEqual(pathCheck)
    expect(client.checkProjectPath).toHaveBeenCalledWith('/projects/app')

    const infoResponse = await app.request('/api/pi/projects/info?path=%2Fprojects%2Fapp', {
      headers,
    })
    expect(await infoResponse.json()).toEqual(project)
    expect(client.getProject).toHaveBeenCalledWith({ path: '/projects/app' })

    const trustResponse = await app.request('/api/pi/projects/trust', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/projects/app', trusted: true, remember: true }),
    })
    expect(await trustResponse.json()).toMatchObject({ status: 'ready' })
    expect(client.decideProjectTrust).toHaveBeenCalledWith({
      path: '/projects/app',
      trusted: true,
      remember: true,
    })

    expect(await (await app.request('/api/pi/projects', { headers })).json()).toEqual(recent)
  })

  it('未信任创建返回可识别的 409，而不是通用 500', async () => {
    const { app } = setup({
      createThread: vi.fn(async () => {
        throw new ProjectTrustRequiredError(project)
      }),
    })
    const response = await app.request('/api/pi/threads', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/projects/app' }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'project-needs-trust', project })
  })

  it('客户端解析项目响应并拒绝畸形载荷', async () => {
    const { app } = setup()
    const client = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })
    expect(await client.checkProjectPath('/projects/app')).toEqual(pathCheck)
    expect(await client.getProject({ path: '/projects/app' })).toEqual(project)
    expect(
      await client.decideProjectTrust({ path: '/projects/app', trusted: true, remember: true }),
    ).toMatchObject({ status: 'ready' })
    expect(await client.listRecentProjects()).toEqual(recent)

    const invalid = createHarnessHttpClient({
      fetchImpl: (async () => Response.json({ path: '/x' })) as typeof fetch,
    })
    await expect(invalid.getProject({ path: '/x' })).rejects.toThrow('Invalid Pi HTTP response')
    await expect(invalid.listRecentProjects()).rejects.toThrow('Invalid Pi HTTP response')
  })
})
