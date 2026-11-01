/**
 * 真实本地 Streamable HTTP transport 测试（G1.4d2a）。
 *
 * 使用 Node HTTP fixture 验证初始化、工具/资源/模板、auth.provider 动态 token、
 * 401 needs-auth、HTTP 连接退避、只读重试一次、tools/call 不重试（含 404 会话
 * 过期）以及快照不含 URL/header/秘密。
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpOAuthAuthorizationRequiredError } from '@earendil-works/pi-mcp/oauth'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMcpConnectionManager,
  type McpConnectionManager,
  type McpConnectionManagerOptions,
  type McpServerConfig,
  type McpServerEntry,
} from './index.js'

const fixturePath = fileURLToPath(new URL('./test-fixtures/http-server.mjs', import.meta.url))

interface HttpFixture {
  port: number
  dir: string
  authLog: string
  requestLog: string
  child: ChildProcess
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function makeEntry(config: McpServerConfig): McpServerEntry {
  return { name: 'demo', config, source: '/tmp/mcp.json', scope: 'user' }
}

async function startHttpFixture(env: Record<string, string> = {}): Promise<HttpFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-http-'))
  const authLog = join(dir, 'auth.log')
  const requestLog = join(dir, 'requests.log')
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      ...process.env,
      ...env,
      FIXTURE_AUTH_LOG_FILE: authLog,
      FIXTURE_REQUEST_LOG_FILE: requestLog,
      FIXTURE_SIDE_EFFECT_FILE: join(dir, 'side-effects.txt'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`HTTP fixture timeout: ${stderr}`)), 5_000)
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as { port: number }
        resolve(parsed.port)
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`HTTP fixture exited ${code}: ${stderr}`)))
  })
  const fixture = { port, dir, authLog, requestLog, child }
  cleanups.push(async () => {
    await stopHttpFixture(child)
    await rm(dir, { recursive: true, force: true })
  })
  return fixture
}

async function stopHttpFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

function createHttpManager(
  fixture: HttpFixture,
  config: Partial<McpServerConfig>,
  options: Partial<McpConnectionManagerOptions> = {},
): McpConnectionManager {
  const manager = createMcpConnectionManager({
    cwd: fixture.dir,
    servers: [
      makeEntry({
        url: `http://127.0.0.1:${fixture.port}/mcp`,
        ...config,
      } as McpServerConfig),
    ],
    ...options,
  })
  cleanups.push(async () => {
    await manager.close()
  })
  return manager
}

async function authHeaders(fixture: HttpFixture): Promise<string[]> {
  try {
    return (await readFile(fixture.authLog, 'utf8')).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function countMethods(fixture: HttpFixture, method: string): Promise<number> {
  try {
    const lines = (await readFile(fixture.requestLog, 'utf8')).trim().split('\n')
    return lines.filter((line) => line === method).length
  } catch {
    return 0
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('真实本地 HTTP', () => {
  it('初始化、工具、资源分页/模板与读取', async () => {
    const fixture = await startHttpFixture({
      FIXTURE_RESOURCE_PAGE_SIZE: '2',
      FIXTURE_RESOURCE_COUNT: '3',
      FIXTURE_TEMPLATE_PAGE_SIZE: '2',
      FIXTURE_TEMPLATE_COUNT: '3',
    })
    const manager = createHttpManager(fixture, {})
    await manager.start()
    expect(manager.snapshot().servers[0]).toMatchObject({
      state: 'connected',
      hasResources: true,
      toolCount: 5,
    })
    // 连接阶段只发现 tools 能力，不提前列资源。
    expect(await countMethods(fixture, 'resources/list')).toBe(0)
    await expect(manager.callTool('demo', 'echo', { text: 'http' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'echo:http' }],
    })
    const resources = await manager.listResources('demo')
    expect(resources.resources).toHaveLength(2)
    expect(resources.nextCursor).toBe('2')
    const next = await manager.listResources('demo', resources.nextCursor)
    expect(next.resources).toHaveLength(1)
    const templates = await manager.listResourceTemplates('demo')
    expect(templates.resourceTemplates).toHaveLength(2)
    const allTemplates = await manager.listAllResourceTemplates('demo')
    expect(allTemplates).toHaveLength(3)
    await expect(manager.readResource('demo', 'resource://fixture/0')).resolves.toMatchObject({
      contents: [{ text: 'resource:resource://fixture/0' }],
    })
  })

  it('auth.provider 每次请求动态取 token，401 投影 needs-auth，重连后恢复', async () => {
    const fixture = await startHttpFixture({ FIXTURE_REQUIRE_TOKEN: 'good-token' })
    let tokenCalls = 0
    const manager = createHttpManager(
      fixture,
      { auth: { provider: 'test-provider' } },
      {
        providerToken: async () => {
          tokenCalls += 1
          return tokenCalls === 1 ? 'bad-token' : 'good-token'
        },
      },
    )
    await manager.start()
    expect(manager.snapshot().servers[0]?.state).toBe('needs-auth')
    expect(tokenCalls).toBe(1)
    expect(JSON.stringify(manager.snapshot())).not.toContain('bad-token')

    await manager.reconnect('demo')
    expect(manager.snapshot().servers[0]?.state).toBe('connected')
    expect(tokenCalls).toBeGreaterThan(1)
    const headers = await authHeaders(fixture)
    expect(headers).toContain('Bearer bad-token')
    expect(headers).toContain('Bearer good-token')
  })

  it('注入官方 AuthProvider 与可选 settled', async () => {
    const fixture = await startHttpFixture({ FIXTURE_REQUIRE_TOKEN: 'good-token' })
    let settled = false
    const manager = createHttpManager(
      fixture,
      {},
      {
        createAuthProvider: () => ({
          provider: { token: async () => 'good-token' },
          settled: async () => {
            settled = true
          },
        }),
      },
    )
    await manager.start()
    expect(manager.snapshot().servers[0]?.state).toBe('connected')
    await manager.close()
    expect(settled).toBe(true)
  })

  it('显式 Authorization 不启用 OAuth；provider 配置不被 OAuth 工厂覆盖', async () => {
    const fixture = await startHttpFixture({ FIXTURE_REQUIRE_TOKEN: 'good-token' })
    let oauthFactories = 0
    const createAuthProvider = () => {
      oauthFactories += 1
      throw new Error('不应运行')
    }
    const headerManager = createHttpManager(
      fixture,
      { headers: { Authorization: 'Bearer good-token' } } as Partial<McpServerConfig>,
      { createAuthProvider },
    )
    await headerManager.start()
    expect(headerManager.snapshot().servers[0]?.state).toBe('connected')
    const providerManager = createHttpManager(
      fixture,
      { auth: { provider: 'test' } } as Partial<McpServerConfig>,
      { createAuthProvider, providerToken: async () => 'good-token' },
    )
    await providerManager.start()
    expect(providerManager.snapshot().servers[0]?.state).toBe('connected')
    expect(oauthFactories).toBe(0)
  })

  it('官方 OAuth 需要授权错误投影 needs-auth', async () => {
    const fixture = await startHttpFixture()
    const manager = createHttpManager(
      fixture,
      {},
      {
        createAuthProvider: () => ({
          provider: {
            token: async () => {
              throw new McpOAuthAuthorizationRequiredError()
            },
          },
        }),
      },
    )
    await manager.start()
    expect(manager.snapshot().servers[0]?.state).toBe('needs-auth')
  })

  it('取消等待 auth token 后不发送 tools/call', async () => {
    const fixture = await startHttpFixture({ FIXTURE_REQUIRE_TOKEN: 'good-token' })
    let release: (() => void) | undefined
    let blockToken = false
    const manager = createHttpManager(
      fixture,
      {},
      {
        createAuthProvider: () => ({
          provider: {
            token: async () => {
              if (blockToken)
                await new Promise<void>((resolve) => {
                  release = resolve
                })
              return 'good-token'
            },
          },
        }),
      },
    )
    await manager.start()
    blockToken = true
    const controller = new AbortController()
    const result = manager.callTool('demo', 'echo', {}, { signal: controller.signal })
    const outcome = result.catch((error: unknown) => error)
    const deadline = Date.now() + 1000
    while (!release) {
      if (Date.now() > deadline) throw new Error('未等待认证')
      await wait(5)
    }
    controller.abort()
    release()
    expect(await outcome).toMatchObject({ code: 'cancelled' })
    expect(await countMethods(fixture, 'tools/call')).toBe(0)
  })

  it('HTTP 连接瞬态失败按退避重试', async () => {
    const fixture = await startHttpFixture({ FIXTURE_INIT_FAILS: '1' })
    const manager = createHttpManager(fixture, {})
    const started = Date.now()
    await manager.start()
    expect(manager.snapshot().servers[0]?.state).toBe('connected')
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(await countMethods(fixture, 'initialize')).toBe(2)
  })

  it('只读请求遇到瞬态错误额外重试一次', async () => {
    const fixture = await startHttpFixture({ FIXTURE_RESOURCE_500_ONCE: '1' })
    const manager = createHttpManager(fixture, {})
    await manager.start()
    const started = Date.now()
    const resources = await manager.listResources('demo')
    expect(resources.resources).toHaveLength(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(await countMethods(fixture, 'resources/list')).toBe(2)
  })

  it('tools/call 遇到 HTTP 500 不在应用层重试，不重复副作用', async () => {
    const fixture = await startHttpFixture({ FIXTURE_TOOL_500: 'side-effect' })
    const sideEffectFile = join(fixture.dir, 'side-effects.txt')
    const manager = createHttpManager(fixture, {})
    await manager.start()
    await expect(manager.callTool('demo', 'side-effect')).rejects.toMatchObject({
      code: 'request-failed',
    })
    await wait(350)
    expect((await readFile(sideEffectFile, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(await countMethods(fixture, 'tools/call')).toBe(1)
  })

  it('tools/call 遇到 HTTP 404 会话过期也不重发', async () => {
    const fixture = await startHttpFixture({ FIXTURE_TOOL_404: 'side-effect' })
    const sideEffectFile = join(fixture.dir, 'side-effects.txt')
    const manager = createHttpManager(fixture, {})
    await manager.start()
    await expect(manager.callTool('demo', 'side-effect')).rejects.toMatchObject({
      code: 'session-expired',
    })
    await wait(350)
    expect((await readFile(sideEffectFile, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(await countMethods(fixture, 'tools/call')).toBe(1)
  })

  it('快照与错误不包含 URL、Authorization 或秘密', async () => {
    const secret = 'HUAN-SECRET-HTTP'
    const fixture = await startHttpFixture({ FIXTURE_REJECT_ALL_AUTH: '1' })
    const manager = createHttpManager(fixture, {
      url: `http://127.0.0.1:${fixture.port}/mcp?token=${secret}`,
      headers: { Authorization: `Bearer ${secret}` },
    } as Partial<McpServerConfig>)
    await manager.start()
    const snapshot = manager.snapshot()
    expect(snapshot.servers[0]).toMatchObject({
      state: 'needs-auth',
      error: { code: 'needs-auth' },
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('127.0.0.1')
    try {
      await manager.callTool('demo', 'echo')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})
