/**
 * MCP HTTP 路由测试（G1.4d3）。
 *
 * 复用生产 createApp 与真实浏览器 HTTP 客户端：验证 Host/Origin/token 边界、
 * typed 成功/失败结果、配置冲突状态码、正文大小限制（含无 Content-Length）。
 */
import type {
  HarnessClient,
  HarnessMcpAuthSnapshot,
  HarnessMcpConfigSnapshot,
  HarnessMcpDetailsResult,
  HarnessMcpSnapshot,
} from '@huan/protocol'
import {
  HARNESS_MCP_CONFIG_BODY_LIMIT_BYTES,
  HARNESS_MCP_SMALL_BODY_LIMIT_BYTES,
} from '@huan/protocol'
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

const target = { kind: 'session' as const, threadId: 't1', workspacePath: '/workspace' }

const snapshot: HarnessMcpSnapshot = {
  target,
  live: true,
  runtime: { runtimeId: 'mcp-runtime:1', revision: 3, started: true, closed: false },
  projectTrusted: true,
  trust: { decision: 'trusted', requiresTrust: false, origin: 'trust' },
  servers: [
    {
      name: 'remote',
      identity: 'mcp:remote:abcdef',
      scope: 'user',
      override: false,
      enabled: true,
      exposure: 'direct',
      state: 'needs-auth',
      toolCount: 0,
      hasResources: false,
      toolRevision: 1,
      auth: { kind: 'oauth', loginable: true, hasCredentials: false, needsRefresh: false },
    },
  ],
}

const configSnapshot: HarnessMcpConfigSnapshot = {
  target,
  projectTrusted: true,
  trust: { decision: 'trusted', requiresTrust: false, origin: 'trust' },
  files: {
    user: {
      scope: 'user',
      path: '/private/agent/mcp.json',
      readable: true,
      exists: true,
      content: '{"mcpServers":{"remote":{"url":"https://example.invalid/mcp"}}}\n',
      revision: 'rev-1',
      bytes: 60,
      tooLarge: false,
      issues: [],
    },
    project: {
      scope: 'project',
      path: '/workspace/.pi/mcp.json',
      readable: true,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
    },
  },
  effective: {
    servers: [
      {
        name: 'remote',
        identity: 'mcp:remote:abcdef',
        scope: 'user',
        override: false,
        enabled: true,
        exposure: 'direct',
      },
    ],
    issues: [],
  },
}

const details: HarnessMcpDetailsResult = {
  status: 'ok',
  details: {
    target,
    runtimeId: 'mcp-runtime:1',
    server: {
      name: 'remote',
      identity: 'mcp:remote:abcdef',
      state: 'connected',
      exposure: 'direct',
      toolRevision: 2,
    },
    tools: [
      {
        name: 'echo',
        inputSchema: { type: 'object' },
        exposure: 'direct',
      },
    ],
  },
}

const authSnapshot: HarnessMcpAuthSnapshot = {
  seq: 2,
  authRevision: 1,
  operations: [],
}

const setup = (overrides: Partial<HarnessClient> = {}) => {
  const client = {
    getHostInfo: vi.fn(),
    getMcp: vi.fn(async () => snapshot),
    getMcpDetails: vi.fn(async () => details),
    getMcpConfig: vi.fn(async () => configSnapshot),
    saveMcpConfig: vi.fn(async () => ({
      status: 'saved' as const,
      scope: 'user' as const,
      path: '/private/agent/mcp.json',
      revision: 'rev-2',
      bytes: 60,
      snapshot: configSnapshot,
      apply: { persisted: true, reloadRequired: true, message: '需要显式重载资源。' },
    })),
    manageMcp: vi.fn(async () => ({ status: 'applied' as const, snapshot })),
    getMcpAuth: vi.fn(async () => authSnapshot),
    startMcpLogin: vi.fn(async () => ({
      status: 'invalid' as const,
      message: '该服务器使用静态 Authorization 头，不能通过 MCP OAuth 登录。',
    })),
    respondMcpAuth: vi.fn(async () => ({ status: 'accepted' as const })),
    cancelMcpAuth: vi.fn(async () => ({ status: 'not-found' as const })),
    logoutMcp: vi.fn(async () => ({
      status: 'invalid' as const,
      message: '没有已存 OAuth 凭据。',
    })),
    ...overrides,
  } as unknown as HarnessClient
  return { app: createApp(client, config), client }
}

const httpClient = (app: ReturnType<typeof createApp>) =>
  createHarnessHttpClient({
    baseUrl: 'http://localhost:8788/api/pi',
    headers,
    fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
  })

/** 生成没有 Content-Length 的流式请求体。 */
const streamingBody = (bytes: number): RequestInit => {
  let sent = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close()
        return
      }
      sent = true
      controller.enqueue(new Uint8Array(bytes).fill(0x20))
    },
  })
  return {
    method: 'POST',
    headers: {
      host: 'localhost:8788',
      origin: 'http://localhost:8799',
      'x-huan-token': 'test-token',
      'content-type': 'application/json',
    },
    body: stream,
    duplex: 'half',
  } as RequestInit
}

describe('MCP 路由安全与输入边界', () => {
  it('GET 快照需要 Host/Origin/token；真实客户端可解析 typed 快照', async () => {
    const { app, client } = setup()
    const denied = await app.request('/api/pi/mcp?threadId=t1', {
      headers: { host: 'localhost:8788', origin: 'http://localhost:8799' },
    })
    expect(denied.status).toBe(401)

    expect(await httpClient(app).getMcp({ threadId: 't1' })).toEqual(snapshot)
    expect(client.getMcp).toHaveBeenCalledWith({ threadId: 't1' })

    const invalid = await app.request('/api/pi/mcp', { headers })
    expect(invalid.status).toBe(400)
  })

  it('配置读取/保存与详情/管理/认证均经 typed 结果返回', async () => {
    const { app, client } = setup()
    const http = httpClient(app)
    expect(await http.getMcpConfig({ threadId: 't1' })).toEqual(configSnapshot)
    const saved = await http.saveMcpConfig({
      target: { threadId: 't1' },
      scope: 'user',
      content: configSnapshot.files.user.content,
      expectedRevision: 'rev-1',
    })
    expect(saved.status).toBe('saved')
    expect(
      await http.getMcpDetails({
        target: { threadId: 't1' },
        expectedRuntimeId: 'mcp-runtime:1',
        server: 'remote',
        include: ['tools'],
      }),
    ).toEqual(details)
    expect(
      await http.manageMcp({
        target: { threadId: 't1' },
        expectedRuntimeId: 'mcp-runtime:1',
        server: 'remote',
        expectedIdentity: 'mcp:remote:abcdef',
        action: { type: 'setEnabled', enabled: false },
      }),
    ).toEqual({ status: 'applied', snapshot })
    expect(await http.getMcpAuth()).toEqual(authSnapshot)

    const login = await http.startMcpLogin({
      target: { threadId: 't1' },
      expectedRuntimeId: 'mcp-runtime:1',
      server: 'remote',
      expectedIdentity: 'mcp:remote:abcdef',
    })
    expect(login).toEqual({
      status: 'invalid',
      message: '该服务器使用静态 Authorization 头，不能通过 MCP OAuth 登录。',
    })
    expect(client.startMcpLogin).toHaveBeenCalledOnce()
    expect(await http.cancelMcpAuth('missing')).toEqual({ status: 'not-found' })
  })

  it('配置冲突/未信任映射为 409；回填值不进入响应', async () => {
    const { app } = setup({
      saveMcpConfig: vi.fn(async () => ({
        status: 'conflict' as const,
        scope: 'user' as const,
        path: '/private/agent/mcp.json',
        revision: 'rev-new',
        message: 'MCP 配置已被其他窗口修改，请重读后再保存。',
      })) as unknown as HarnessClient['saveMcpConfig'],
      respondMcpAuth: vi.fn(async () => ({ status: 'accepted' as const })),
    })
    const conflict = await app.request('/api/pi/mcp/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        target: { threadId: 't1' },
        scope: 'user',
        content: '{}\n',
        expectedRevision: 'rev-old',
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'mcp-config-conflict' })

    const secret = 'http://127.0.0.1:1234/callback?code=secret-code&state=secret-state'
    const accepted = await app.request('/api/pi/mcp/auth/respond', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: 'op-1',
        promptId: 'prompt-1',
        value: secret,
      }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).not.toContain('secret-code')
  })

  it('管理/认证请求体与配置请求体即使没有 Content-Length 也受限', async () => {
    const { app } = setup()
    const small = await app.fetch(
      new Request(
        'http://localhost:8788/api/pi/mcp/manage',
        streamingBody(HARNESS_MCP_SMALL_BODY_LIMIT_BYTES + 1),
      ),
    )
    expect(small.status).toBe(413)

    const large = await app.fetch(
      new Request(
        'http://localhost:8788/api/pi/mcp/config',
        streamingBody(HARNESS_MCP_CONFIG_BODY_LIMIT_BYTES + 1),
      ),
    )
    expect(large.status).toBe(413)
  })
})
