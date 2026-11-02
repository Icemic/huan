/**
 * 宿主 MCP 管理/配置/OAuth 集成测试（G1.4d3）。
 *
 * 真实 Pi SDK + 隔离用户空间 + 本地 OAuth gateway + 本地 Streamable HTTP MCP
 * 服务：不读取个人 Pi 配置/凭据，不访问外部服务，也不发模型请求。
 *
 * 覆盖：冷目标只读配置不连接、OAuth 登录/回填/取消/退出、登录后同身份重连、
 * 多窗一次回填、identity 互斥、配置 revision/信任、临时管理与 stale。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  HarnessMcpAuthSnapshot,
  HarnessMcpSnapshot,
  HarnessMcpTargetInput,
} from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OAuthTestServer } from '../../mcp/src/test-fixtures/oauth-server.js'
import { createHarnessHost, type HarnessHost } from './host.js'
import { createIsolatedPiEnv, type IsolatedPiEnv, TEST_RESOURCE_ISOLATION } from './test-support.js'

const stdioFixture = fileURLToPath(
  new URL('../../mcp/src/test-fixtures/stdio-server.mjs', import.meta.url),
)

let env: IsolatedPiEnv
let host: HarnessHost
const cleanups: Array<() => Promise<void>> = []
const savedEnv = new Map<string, string | undefined>()
const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async <T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(20)
  }
  throw new Error('等待条件超时')
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const sendJson = (res: ServerResponse, body: unknown, status = 200): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'mcp-session-id': 'local-mcp-session',
  })
  res.end(payload)
}

/**
 * 本地受 OAuth 保护的 MCP 服务。
 *
 * `/mcp` 的 401 challenge 指向 OAuthTestServer 的 resource metadata；它只接受
 * OAuthTestServer 当前签发的 access token，从而验证真实登录与刷新后的请求。
 */
class LocalOAuthMcpServer {
  readonly server: Server
  origin = ''
  requestCount = 0

  private constructor(private readonly oauth: OAuthTestServer) {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  static async start(oauth: OAuthTestServer): Promise<LocalOAuthMcpServer> {
    const instance = new LocalOAuthMcpServer(oauth)
    await new Promise<void>((resolve, reject) => {
      instance.server.once('error', reject)
      instance.server.listen(0, '127.0.0.1', () => {
        instance.server.off('error', reject)
        const address = instance.server.address() as AddressInfo
        instance.origin = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
    return instance
  }

  get url(): string {
    return `${this.origin}/mcp`
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (
      url.pathname === '/resource-metadata' ||
      url.pathname.startsWith('/.well-known/oauth-protected-resource')
    ) {
      sendJson(res, {
        resource: this.url,
        authorization_servers: [this.oauth.origin],
        scopes_supported: ['read', 'write'],
      })
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST, DELETE' })
      res.end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    this.requestCount += 1
    const authorization = req.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    if (!token || !this.oauth.accessTokens.has(token)) {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate': `Bearer resource_metadata="${this.origin}/resource-metadata", scope="read write"`,
      })
      res.end('authentication required')
      return
    }

    let message: {
      id?: string | number
      method?: string
      params?: Record<string, unknown>
    }
    try {
      message = JSON.parse(await readBody(req)) as typeof message
    } catch {
      res.writeHead(400)
      res.end('invalid json')
      return
    }
    if (message.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    const result = this.resultOf(message)
    if ('error' in result) sendJson(res, { jsonrpc: '2.0', id: message.id, error: result.error })
    else sendJson(res, { jsonrpc: '2.0', id: message.id, result: result.result })
  }

  private resultOf(message: {
    method?: string
    params?: Record<string, unknown>
  }): { result: unknown } | { error: { code: number; message: string } } {
    switch (message.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion:
              typeof message.params?.protocolVersion === 'string'
                ? message.params.protocolVersion
                : '2025-11-25',
            capabilities: { tools: { listChanged: true }, resources: {} },
            serverInfo: { name: 'local-oauth-mcp', version: '1.0.0' },
            instructions: '本地 OAuth MCP fixture',
          },
        }
      case 'ping':
        return { result: {} }
      case 'tools/list':
        return {
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo text',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  additionalProperties: false,
                },
              },
            ],
          },
        }
      case 'tools/call':
        return {
          result: { content: [{ type: 'text', text: `echo:${String(message.params?.name)}` }] },
        }
      case 'resources/list':
        return {
          result: {
            resources: [
              { uri: 'resource://local/0', name: 'local-resource', mimeType: 'text/plain' },
            ],
          },
        }
      case 'resources/templates/list':
        return { result: { resourceTemplates: [] } }
      case 'resources/read':
        return {
          result: {
            contents: [
              { uri: 'resource://local/0', mimeType: 'text/plain', text: 'local resource' },
            ],
          },
        }
      default:
        return { error: { code: -32601, message: 'method not found' } }
    }
  }
}

const createHost = () =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
  })

const writeUserMcp = async (servers: Record<string, unknown>) => {
  await writeFile(join(env.agentDir, 'mcp.json'), `${JSON.stringify({ mcpServers: servers })}\n`)
}

const readAuthSnapshot = async (): Promise<HarnessMcpAuthSnapshot> => host.getMcpAuth()

const waitOperation = async (
  operationId: string,
  phase: string,
): Promise<HarnessMcpAuthSnapshot['operations'][number]> =>
  waitFor(async () => {
    const snapshot = await readAuthSnapshot()
    const operation = snapshot.operations.find((candidate) => candidate.id === operationId)
    return operation?.phase === phase ? operation : undefined
  })

const mcpForThread = async (threadId: string): Promise<HarnessMcpSnapshot> =>
  host.getMcp({ threadId })

const targetIsWorkspace = (path: string): HarnessMcpTargetInput => ({ workspacePath: path })

beforeEach(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-mcp-host-')
  host = await createHost()
})

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups
      .pop()?.()
      .catch(() => {})
  }
  await host.dispose().catch(() => {})
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

describe('MCP 冷目标与配置', () => {
  it('冷会话/空白路径只读配置，不启动 stdio 进程', async () => {
    const pidFile = join(env.root, 'cold.pid')
    await writeUserMcp({
      cold: {
        command: process.execPath,
        args: [stdioFixture],
        env: { FIXTURE_PID_FILE: pidFile },
        exposure: 'direct',
      },
    })
    const snapshot = await host.getMcp(targetIsWorkspace(env.workspace))
    expect(snapshot.live).toBe(false)
    expect(snapshot.runtime).toBeUndefined()
    expect(snapshot.servers).toHaveLength(1)
    expect(snapshot.servers[0]?.state).toBe('not-connected')
    expect(snapshot.servers[0]?.auth).toEqual({
      kind: 'stdio',
      loginable: false,
      hasCredentials: false,
      needsRefresh: false,
    })
    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('配置读取/保存保留 revision；旧 revision 冲突且项目未信任不读原文', async () => {
    await writeUserMcp({ demo: { command: 'demo', exposure: 'codemode' } })
    const thread = await host.createThread()
    const before = await host.getMcpConfig({ threadId: thread.metadata.id })
    expect(before.files.user.content).toContain('demo')
    const next = `${JSON.stringify({ mcpServers: { demo: { command: 'demo2' } } }, null, 2)}\n`
    const saved = await host.saveMcpConfig({
      target: { threadId: thread.metadata.id },
      scope: 'user',
      content: next,
      expectedRevision: before.files.user.revision,
    })
    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') throw new Error('保存失败')
    expect(saved.apply.reloadRequired).toBe(true)
    expect(saved.snapshot.files.user.content).toBe(next)

    const conflict = await host.saveMcpConfig({
      target: { threadId: thread.metadata.id },
      scope: 'user',
      content: before.files.user.content,
      expectedRevision: before.files.user.revision,
    })
    expect(conflict.status).toBe('conflict')

    const projectPath = join(env.root, 'project-untrusted')
    await mkdir(join(projectPath, '.pi'), { recursive: true })
    await writeFile(
      join(projectPath, '.pi', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { p: { command: 'p' } } })}\n`,
    )
    const config = await host.getMcpConfig(targetIsWorkspace(projectPath))
    expect(config.projectTrusted).toBe(false)
    expect(config.files.project.readable).toBe(false)
    expect(config.files.project.content).toBe('')
    const untrusted = await host.saveMcpConfig({
      target: targetIsWorkspace(projectPath),
      scope: 'project',
      content: '{}\n',
      expectedRevision: null,
    })
    expect(untrusted.status).toBe('untrusted')
  })
})

describe('MCP OAuth 与宿主管理', () => {
  it('真实登录、回填一次领取、重连、详情、临时管理、退出与取消', async () => {
    const oauth = await OAuthTestServer.start()
    cleanups.push(() => oauth.close())
    const mcp = await LocalOAuthMcpServer.start(oauth)
    cleanups.push(() => mcp.close())
    await writeUserMcp({
      remote: { url: mcp.url, exposure: 'direct' },
    })

    const thread = await host.createThread()
    const threadId = thread.metadata.id
    await waitFor(async () => {
      const snapshot = await mcpForThread(threadId)
      return snapshot.servers[0]?.state === 'needs-auth' ? snapshot : undefined
    })
    const before = await mcpForThread(threadId)
    const runtimeId = before.runtime?.runtimeId
    const server = before.servers[0]
    expect(runtimeId).toBeTruthy()
    expect(server?.identity).toMatch(/^mcp:remote:/)
    expect(server?.auth).toMatchObject({ kind: 'oauth', loginable: true, hasCredentials: false })

    const login = await host.startMcpLogin({
      target: { threadId },
      expectedRuntimeId: runtimeId ?? '',
      server: 'remote',
      expectedIdentity: server?.identity ?? '',
    })
    expect(login.status).toBe('started')
    if (login.status !== 'started') throw new Error('登录未启动')
    const operationId = login.operation.id

    const duplicate = await host.startMcpLogin({
      target: { threadId },
      expectedRuntimeId: runtimeId ?? '',
      server: 'remote',
      expectedIdentity: server?.identity ?? '',
    })
    expect(duplicate.status).toBe('busy')
    if (duplicate.status === 'busy') expect(duplicate.operation?.id).toBe(operationId)

    const prompt = await waitOperation(operationId, 'prompt')
    expect(prompt.authUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(prompt.prompt?.promptId).toBeTruthy()

    const authorization = await fetch(prompt.authUrl ?? '', { redirect: 'manual' })
    const location = authorization.headers.get('location')
    expect(location).toContain('code=')
    const first = await host.respondMcpAuth({
      operationId,
      promptId: prompt.prompt?.promptId ?? '',
      value: location ?? '',
    })
    expect(first).toEqual({ status: 'accepted' })
    const second = await host.respondMcpAuth({
      operationId,
      promptId: prompt.prompt?.promptId ?? '',
      value: location ?? '',
    })
    expect(second).toEqual({ status: 'stale' })

    const succeeded = await waitOperation(operationId, 'succeeded')
    expect(succeeded.result?.status).toBe('succeeded')
    expect(oauth.exchangeCount).toBe(1)

    await waitFor(async () => {
      const snapshot = await mcpForThread(threadId)
      const current = snapshot.servers[0]
      return current?.state === 'connected' && current.auth.hasCredentials ? snapshot : undefined
    })
    const connected = await mcpForThread(threadId)
    expect(connected.servers[0]?.auth).toMatchObject({
      kind: 'oauth',
      hasCredentials: true,
      needsRefresh: false,
    })

    const details = await host.getMcpDetails({
      target: { threadId },
      expectedRuntimeId: connected.runtime?.runtimeId ?? '',
      server: 'remote',
      include: ['tools', 'resources', 'resource-templates'],
    })
    expect(details.status).toBe('ok')
    if (details.status === 'ok') {
      expect(details.details.tools?.map((tool) => tool.name)).toContain('echo')
      expect(details.details.resources?.[0]?.uri).toBe('resource://local/0')
      expect(details.details.resourceTemplates).toEqual([])
    }

    const hidden = await host.manageMcp({
      target: { threadId },
      expectedRuntimeId: connected.runtime?.runtimeId ?? '',
      server: 'remote',
      expectedIdentity: connected.servers[0]?.identity ?? '',
      action: { type: 'setExposure', exposure: 'hidden' },
    })
    expect(hidden.status).toBe('applied')
    if (hidden.status === 'applied') {
      expect(hidden.snapshot.servers[0]?.exposure).toBe('hidden')
    }
    const restore = await host.manageMcp({
      target: { threadId },
      expectedRuntimeId: connected.runtime?.runtimeId ?? '',
      server: 'remote',
      expectedIdentity: connected.servers[0]?.identity ?? '',
      action: { type: 'setExposure', exposure: 'direct' },
    })
    expect(restore.status).toBe('applied')

    const stale = await host.manageMcp({
      target: { threadId },
      expectedRuntimeId: 'stale-runtime',
      server: 'remote',
      expectedIdentity: connected.servers[0]?.identity ?? '',
      action: { type: 'reconnect' },
    })
    expect(stale.status).toBe('stale')

    const logout = await host.logoutMcp({
      target: { threadId },
      expectedRuntimeId: connected.runtime?.runtimeId ?? '',
      server: 'remote',
      expectedIdentity: connected.servers[0]?.identity ?? '',
    })
    expect(logout.status).toBe('started')
    if (logout.status !== 'started') throw new Error('退出未启动')
    await waitOperation(logout.operation.id, 'succeeded')
    await waitFor(async () => {
      const snapshot = await mcpForThread(threadId)
      return snapshot.servers[0]?.auth.hasCredentials === false ? snapshot : undefined
    })

    // 再次登录后取消：保持 cancelling 直到真实流程结算，且不落下新凭据。
    const again = await host.startMcpLogin({
      target: { threadId },
      expectedRuntimeId: connected.runtime?.runtimeId ?? '',
      server: 'remote',
      expectedIdentity: connected.servers[0]?.identity ?? '',
    })
    expect(again.status).toBe('started')
    if (again.status !== 'started') throw new Error('再次登录未启动')
    await waitOperation(again.operation.id, 'prompt')
    const cancelling = await host.cancelMcpAuth(again.operation.id)
    expect(cancelling.status).toBe('cancelling')
    const cancelled = await waitOperation(again.operation.id, 'cancelled')
    expect(cancelled.result?.status).toBe('cancelled')
  }, 30_000)

  it('目标 reload/delete 取消失效旧认证，不允许晚到结果附着新 runtime', async () => {
    const oauth = await OAuthTestServer.start()
    cleanups.push(() => oauth.close())
    const mcp = await LocalOAuthMcpServer.start(oauth)
    cleanups.push(() => mcp.close())
    await writeUserMcp({ remote: { url: mcp.url, exposure: 'direct' } })
    const thread = await host.createThread()
    const threadId = thread.metadata.id
    const initial = await waitFor(async () => {
      const snapshot = await mcpForThread(threadId)
      return snapshot.runtime ? snapshot : undefined
    })

    const startPending = async (snapshot: HarnessMcpSnapshot) => {
      const started = await host.startMcpLogin({
        target: { threadId },
        expectedRuntimeId: snapshot.runtime?.runtimeId ?? '',
        server: 'remote',
        expectedIdentity: snapshot.servers[0]?.identity ?? '',
      })
      if (started.status !== 'started') throw new Error('登录未启动')
      await waitOperation(started.operation.id, 'prompt')
      return started.operation.id
    }

    const beforeReload = await startPending(initial)
    await host.reloadResources({ threadId })
    const cancelledByReload = await waitOperation(beforeReload, 'cancelled')
    expect(cancelledByReload.result?.message).toContain('重载或关闭')

    const reloaded = await waitFor(async () => {
      const snapshot = await mcpForThread(threadId)
      return snapshot.runtime && snapshot.runtime.runtimeId !== initial.runtime?.runtimeId
        ? snapshot
        : undefined
    })
    const beforeDelete = await startPending(reloaded)
    await host.deleteThread(threadId)
    const cancelledByDelete = await waitOperation(beforeDelete, 'cancelled')
    expect(cancelledByDelete.result?.message).toContain('重载或关闭')
  }, 30_000)

  it('目标 dispose 时取消等待回填的登录并收尾 OAuth/log 服务', async () => {
    const oauth = await OAuthTestServer.start()
    cleanups.push(() => oauth.close())
    const mcp = await LocalOAuthMcpServer.start(oauth)
    cleanups.push(() => mcp.close())
    await writeUserMcp({ remote: { url: mcp.url, exposure: 'direct' } })
    const thread = await host.createThread()
    const threadId = thread.metadata.id
    const before = await waitFor(async () => {
      const snapshot = await mcpForThread(threadId)
      return snapshot.runtime ? snapshot : undefined
    })
    const login = await host.startMcpLogin({
      target: { threadId },
      expectedRuntimeId: before.runtime?.runtimeId ?? '',
      server: 'remote',
      expectedIdentity: before.servers[0]?.identity ?? '',
    })
    expect(login.status).toBe('started')
    if (login.status !== 'started') throw new Error('登录未启动')
    await waitOperation(login.operation.id, 'prompt')
    await host.dispose()
    // dispose 后不再对外提供快照；能正常返回即说明 callback/登录流程已收尾。
    expect(oauth.exchangeCount).toBe(0)
    host = await createHost()
  }, 30_000)
})
