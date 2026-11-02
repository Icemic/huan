/**
 * MCP OAuth 服务测试（G1.4d3）。
 *
 * 使用本地真实 HTTP OAuth 服务（metadata、DCR、authorize、token、resource）验证
 * loopback/回填登录、state/issuer 校验、取消回收 callback、刷新轮换单飞、scope
 * 追加、logout/close、identity 隔离，以及凭据文件的安全边界。
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  McpOAuthAuthorizationRequiredError,
  OAuthIssuerMismatchError,
} from '@earendil-works/pi-mcp/oauth'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMcpOAuthService,
  McpOAuthError,
  type McpOAuthService,
  type McpServerConfig,
  type McpServerEntry,
  McpSignInCancelledError,
  mcpServerIdentity,
} from './index.js'
import { OAuthTestServer } from './test-fixtures/oauth-server.js'

const cleanups: (() => Promise<void>)[] = []

type OAuthConfig = NonNullable<Extract<McpServerConfig, { url: string }>['oauth']>

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = predicate()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await sleep(10)
  }
}

async function tempAgentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'huan-mcp-oauth-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  return agentDir
}

async function startServer(
  options: Parameters<typeof OAuthTestServer.start>[0] = {},
): Promise<OAuthTestServer> {
  const server = await OAuthTestServer.start(options)
  cleanups.push(() => server.close())
  return server
}

function service(options: Parameters<typeof createMcpOAuthService>[0]): McpOAuthService {
  const instance = createMcpOAuthService(options)
  cleanups.push(() => instance.close())
  return instance
}

function makeEntry(name: string, url: string, oauth?: OAuthConfig): McpServerEntry {
  return {
    name,
    config: { url, ...(oauth ? { oauth } : {}) },
    source: '/tmp/mcp.json',
    scope: 'user',
  }
}

function authPath(agentDir: string): string {
  return join(agentDir, 'huan', 'mcp-auth.json')
}

async function readAuthFile(agentDir: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(authPath(agentDir), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

interface LoginDriver {
  promise: Promise<void>
  authorizationUrl(): URL | undefined
  promptSignal(): AbortSignal | undefined
  resolvePrompt(value: string | undefined): void
}

/** 启动一次登录并暴露授权 URL/回填信号，便于测试真实浏览器与粘贴两条路径。 */
function driveLogin(
  instance: McpOAuthService,
  entry: McpServerEntry,
  cwd: string,
  signal?: AbortSignal,
): LoginDriver {
  let authorizationUrl: URL | undefined
  let promptSignal: AbortSignal | undefined
  let resolvePrompt: ((value: string | undefined) => void) | undefined
  const promise = instance.login(entry, {
    cwd,
    ...(signal ? { signal } : {}),
    showAuthorizationUrl: (url) => {
      authorizationUrl = url
    },
    promptForRedirectUrl: (promptAbort) => {
      promptSignal = promptAbort
      return new Promise<string | undefined>((resolve) => {
        resolvePrompt = resolve
      })
    },
  })
  return {
    promise,
    authorizationUrl: () => authorizationUrl,
    promptSignal: () => promptSignal,
    resolvePrompt: (value) => {
      if (!resolvePrompt) throw new Error('prompt not ready')
      resolvePrompt(value)
    },
  }
}

async function redirectLocation(url: URL): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (response.status !== 302 || !location) {
    throw new Error(`OAuth authorize failed: ${response.status} ${await response.text()}`)
  }
  return location
}

async function loginLoopback(
  instance: McpOAuthService,
  entry: McpServerEntry,
  cwd: string,
): Promise<URL> {
  const driver = driveLogin(instance, entry, cwd)
  const authorizationUrl = await waitFor(() => driver.authorizationUrl())
  // prompt 被调用说明 callback.waitForCallback 已登记，避免测试请求抢跑。
  await waitFor(() => driver.promptSignal())
  const location = await redirectLocation(authorizationUrl)
  const callback = await fetch(location)
  expect(callback.status).toBe(200)
  await driver.promise
  return authorizationUrl
}

async function trySymlink(target: string, path: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await symlink(target, path, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'EINVAL') {
      return false
    }
    throw error
  }
}

describe('真实 OAuth 登录', () => {
  it('loopback 登录保存凭据，identity 不含 URL，Pi 文件未动', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    // Pi 同层文件只作为哨兵；huan 不应读写它们。
    const piAuth = join(agentDir, 'mcp-auth.json')
    const piLog = join(agentDir, 'mcp.log')
    await writeFile(piAuth, '{"pi":"sentinel"}')
    await writeFile(piLog, 'pi-log-sentinel')

    const instance = service({ agentDir })
    const entry = makeEntry('demo', server.resourceUrl)
    const authorizationUrl = await loginLoopback(instance, entry, process.cwd())

    expect(authorizationUrl.pathname).toBe('/authorize')
    expect(server.registrationCount).toBe(1)
    expect(server.exchangeCount).toBe(1)
    await expect(instance.hasCredentials(entry)).resolves.toBe(true)

    const states = await readAuthFile(agentDir)
    const identity = mcpServerIdentity(entry)
    expect(identity).not.toContain('http')
    expect(identity).not.toContain(server.origin)
    expect(identity).not.toContain('/mcp')
    expect(Object.keys(states)).toEqual([identity])
    expect(states[identity]).toMatchObject({
      serverUrl: server.resourceUrl,
      tokens: { token_type: 'Bearer' },
    })

    expect(await readFile(piAuth, 'utf8')).toBe('{"pi":"sentinel"}')
    expect(await readFile(piLog, 'utf8')).toBe('pi-log-sentinel')
    if (process.platform !== 'win32') {
      const fileInfo = await stat(authPath(agentDir))
      const dirInfo = await stat(dirname(authPath(agentDir)))
      expect(fileInfo.mode & 0o077).toBe(0)
      expect(dirInfo.mode & 0o077).toBe(0)
    }
  })

  it('回填重定向可完成登录；state 不符被拒绝且 callback 端口可重用', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const port = await freePort()
    const entry = makeEntry('pasted', server.resourceUrl, { callbackPort: port })

    const driver = driveLogin(instance, entry, process.cwd())
    const authorizationUrl = await waitFor(() => driver.authorizationUrl())
    await waitFor(() => driver.promptSignal())
    const location = await redirectLocation(authorizationUrl)
    const wrong = new URL(location)
    wrong.searchParams.set('state', 'not-this-login')
    driver.resolvePrompt(wrong.href)
    await expect(driver.promise).rejects.toMatchObject({ code: 'invalid-redirect' })
    await expect(instance.hasCredentials(entry)).resolves.toBe(false)

    // 失败后 callback 必须已关闭；同一固定端口仍可再次监听并完成登录。
    await loginLoopback(instance, entry, process.cwd())
    await expect(instance.hasCredentials(entry)).resolves.toBe(true)
  })

  it('close 取消待回填登录并等待 callback 回收', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const port = await freePort()
    const entry = makeEntry('close-login', server.resourceUrl, { callbackPort: port })
    const driver = driveLogin(instance, entry, process.cwd())
    await waitFor(() => driver.authorizationUrl())
    await waitFor(() => driver.promptSignal())

    const closing = instance.close()
    await expect(driver.promise).rejects.toMatchObject({ code: 'closed' })
    await closing
    // 关闭后同一端口可由新服务再次监听并完成登录。
    const next = service({ agentDir })
    await loginLoopback(next, entry, process.cwd())
    await expect(next.hasCredentials(entry)).resolves.toBe(true)
  })

  it('issuer 不符拒绝登录，修正后可重试', async () => {
    const server = await startServer({ expiresIn: 3600, authorizationIssuer: 'wrong' })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('issuer', server.resourceUrl)

    const driver = driveLogin(instance, entry, process.cwd())
    const authorizationUrl = await waitFor(() => driver.authorizationUrl())
    await waitFor(() => driver.promptSignal())
    const location = await redirectLocation(authorizationUrl)
    driver.resolvePrompt(location)
    await expect(driver.promise).rejects.toBeInstanceOf(OAuthIssuerMismatchError)
    await expect(instance.hasCredentials(entry)).resolves.toBe(false)

    server.authorizationIssuer = 'auto'
    await loginLoopback(instance, entry, process.cwd())
    await expect(instance.hasCredentials(entry)).resolves.toBe(true)
  })

  it('取消登录回收 callback，信号传给回填提示且可重试', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const port = await freePort()
    const entry = makeEntry('cancel', server.resourceUrl, { callbackPort: port })
    const controller = new AbortController()
    const driver = driveLogin(instance, entry, process.cwd(), controller.signal)

    await waitFor(() => driver.authorizationUrl())
    const promptSignal = await waitFor(() => driver.promptSignal())
    controller.abort()
    await expect(driver.promise).rejects.toBeInstanceOf(McpSignInCancelledError)
    expect(promptSignal.aborted).toBe(true)
    await expect(instance.hasCredentials(entry)).resolves.toBe(false)

    await loginLoopback(instance, entry, process.cwd())
    await expect(instance.hasCredentials(entry)).resolves.toBe(true)
  })
})

describe('刷新、scope 与退出', () => {
  it('过期令牌并发的刷新合并为一次，轮换后的 refresh token 已保存', async () => {
    const server = await startServer({
      expiresIn: 1,
      refreshExpiresIn: 3600,
      refreshDelayMs: 150,
    })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('refresh', server.resourceUrl)
    await loginLoopback(instance, entry, process.cwd())

    const before = await readAuthFile(agentDir)
    const identity = mcpServerIdentity(entry)
    const oldToken = (before[identity]?.tokens as { access_token?: string } | undefined)
      ?.access_token
    const handle = instance.createAuthProvider({
      entry,
      url: new URL(server.resourceUrl),
      cwd: process.cwd(),
    })
    if (!handle) throw new Error('missing auth provider')

    const tokens = await Promise.all(Array.from({ length: 6 }, () => handle.provider.token()))
    expect(server.refreshCount).toBe(1)
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).toMatch(/^access-/)
    expect(tokens[0]).not.toBe(oldToken)

    const after = await readAuthFile(agentDir)
    const stored = after[identity]?.tokens as
      | { access_token?: string; refresh_token?: string }
      | undefined
    expect(stored?.access_token).toBe(tokens[0])
    expect(server.liveRefreshTokens).toEqual([stored?.refresh_token])

    // 新令牌仍在有效期内，不应再次刷新。
    await expect(handle.provider.token()).resolves.toBe(tokens[0])
    expect(server.refreshCount).toBe(1)
  })

  it('insufficient_scope 触发登录并在授权 URL 中保留已授予 scope', async () => {
    const server = await startServer({
      expiresIn: 3600,
      challengeError: 'insufficient_scope',
      challengeScope: 'read write',
    })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('scope', server.resourceUrl, { scope: 'read' })
    const firstAuthorization = await loginLoopback(instance, entry, process.cwd())
    expect(firstAuthorization.searchParams.get('scope')).toBe('read')

    const handler = instance.createAuthProvider({
      entry,
      url: new URL(server.resourceUrl),
      cwd: process.cwd(),
    })
    if (!handler?.provider.onUnauthorized) throw new Error('missing auth provider')
    const token = await handler.provider.token()
    const response = await fetch(server.resourceUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    await expect(
      handler.provider.onUnauthorized({
        response,
        serverUrl: new URL(server.resourceUrl),
        fetch: globalThis.fetch,
        ...(token === undefined ? {} : { token }),
      }),
    ).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError)

    const secondAuthorization = await loginLoopback(instance, entry, process.cwd())
    const scopes = new Set((secondAuthorization.searchParams.get('scope') ?? '').split(/\s+/))
    expect(scopes.has('read')).toBe(true)
    expect(scopes.has('write')).toBe(true)
  })

  it('logout 等待刷新落盘后删除凭据，旧刷新不会重建', async () => {
    const server = await startServer({
      expiresIn: 1,
      refreshExpiresIn: 3600,
      refreshDelayMs: 200,
    })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('logout', server.resourceUrl)
    await loginLoopback(instance, entry, process.cwd())
    const handler = instance.createAuthProvider({
      entry,
      url: new URL(server.resourceUrl),
      cwd: process.cwd(),
    })
    if (!handler) throw new Error('missing auth provider')

    const refreshing = handler.provider.token()
    await waitFor(() => (server.refreshCount > 0 ? true : undefined))
    await expect(instance.logout(entry)).resolves.toBe(true)
    await refreshing
    await expect(instance.hasCredentials(entry)).resolves.toBe(false)
    await expect(instance.logout(entry)).resolves.toBe(false)
    const states = await readAuthFile(agentDir)
    expect(Object.hasOwn(states, mcpServerIdentity(entry))).toBe(false)
  })

  it('close 等待进行中的刷新完成轮换保存', async () => {
    const server = await startServer({
      expiresIn: 1,
      refreshExpiresIn: 3600,
      refreshDelayMs: 250,
    })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('close', server.resourceUrl)
    await loginLoopback(instance, entry, process.cwd())
    const handler = instance.createAuthProvider({
      entry,
      url: new URL(server.resourceUrl),
      cwd: process.cwd(),
    })
    if (!handler) throw new Error('missing auth provider')

    const refreshing = handler.provider.token()
    await waitFor(() => (server.refreshCount > 0 ? true : undefined))
    await instance.close()
    await refreshing

    const states = await readAuthFile(agentDir)
    const stored = states[mcpServerIdentity(entry)]?.tokens as
      | { refresh_token?: string }
      | undefined
    expect(server.liveRefreshTokens).toEqual([stored?.refresh_token])
    await expect(
      instance.login(entry, {
        cwd: process.cwd(),
        showAuthorizationUrl: () => undefined,
        promptForRedirectUrl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('clientSecret 与 identity', () => {
  it('clientSecret 只在登录时异步解析，命令目录正确', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const calls: { cwd: string; signal: AbortSignal | undefined }[] = []
    const instance = service({
      agentDir,
      runCommand: async (_command, options) => {
        calls.push({ cwd: options.cwd, signal: options.signal })
        return 'secret-value'
      },
    })
    const entry = makeEntry('secret', server.resourceUrl, {
      clientId: 'configured-client',
      clientSecret: '!secret-command',
    })

    await expect(instance.hasCredentials(entry)).resolves.toBe(false)
    instance.createAuthProvider({ entry, url: new URL(server.resourceUrl), cwd: process.cwd() })
    expect(calls).toHaveLength(0)

    await loginLoopback(instance, entry, process.cwd())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(process.cwd())
    expect(server.registrationCount).toBe(0)
    expect(
      server.tokenRequests.some((params) => params.get('client_id') === 'configured-client'),
    ).toBe(true)
    expect(
      server.tokenRequests.some((params) => params.get('client_secret') === 'secret-value'),
    ).toBe(true)
  })

  it('clientSecret 命令解析可取消', async () => {
    const agentDir = await tempAgentDir()
    let seen: AbortSignal | undefined
    const instance = service({
      agentDir,
      runCommand: (_command, options) =>
        new Promise((_resolve, reject) => {
          seen = options.signal
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const entry = makeEntry('cancelled-secret', 'http://127.0.0.1:1/mcp', {
      clientSecret: '!slow-secret',
    })
    const controller = new AbortController()
    const promise = instance.login(entry, {
      cwd: process.cwd(),
      signal: controller.signal,
      showAuthorizationUrl: () => undefined,
      promptForRedirectUrl: async () => undefined,
    })
    await waitFor(() => seen)
    controller.abort()
    await expect(promise).rejects.toBeInstanceOf(McpSignInCancelledError)
  })

  it('按名称 + 规范 URL 隔离，identity 不带 URL', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const first = makeEntry('first', `${server.origin}/mcp/a`)
    const second = makeEntry('second', `${server.origin}/mcp/b`)
    const alias = makeEntry('alias', `${server.origin}/mcp/a`)
    const identities = [first, second, alias].map(mcpServerIdentity)
    expect(new Set(identities).size).toBe(3)

    await loginLoopback(instance, first, process.cwd())
    await expect(instance.hasCredentials(first)).resolves.toBe(true)
    await expect(instance.hasCredentials(second)).resolves.toBe(false)
    await expect(instance.hasCredentials(alias)).resolves.toBe(false)

    await loginLoopback(instance, second, process.cwd())
    await loginLoopback(instance, alias, process.cwd())
    await expect(instance.logout(first)).resolves.toBe(true)
    await expect(instance.hasCredentials(first)).resolves.toBe(false)
    await expect(instance.hasCredentials(second)).resolves.toBe(true)
    await expect(instance.hasCredentials(alias)).resolves.toBe(true)

    const states = await readAuthFile(agentDir)
    expect(Object.hasOwn(states, identities[0] ?? '')).toBe(false)
    expect(Object.hasOwn(states, identities[1] ?? '')).toBe(true)
    expect(Object.hasOwn(states, identities[2] ?? '')).toBe(true)

    const secret = makeEntry('secret-url', `${server.origin}/mcp?token=super-secret`)
    const identity = mcpServerIdentity(secret)
    expect(identity).not.toContain('super-secret')
    expect(identity).not.toContain('http')
    expect(identity).not.toContain(server.origin)

    // 规范 URL：默认端口、host 大小写与 fragment 不产生新身份。
    const canonicalA = makeEntry('canonical', 'HTTP://127.0.0.1:80/mcp#fragment')
    const canonicalB = makeEntry('canonical', 'http://127.0.0.1/mcp')
    expect(mcpServerIdentity(canonicalA)).toBe(mcpServerIdentity(canonicalB))
  })
})

describe('凭据文件安全边界', () => {
  it('坏文件不覆盖、不联网', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    await mkdir(dirname(authPath(agentDir)), { recursive: true, mode: 0o700 })
    await writeFile(authPath(agentDir), '{not json')
    const instance = service({ agentDir })
    const entry = makeEntry('bad', server.resourceUrl)

    await expect(instance.hasCredentials(entry)).rejects.toMatchObject({ code: 'storage' })
    await expect(
      instance.login(entry, {
        cwd: process.cwd(),
        showAuthorizationUrl: () => undefined,
        promptForRedirectUrl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'storage' })
    expect(await readFile(authPath(agentDir), 'utf8')).toBe('{not json')
    expect(server.registrationCount).toBe(0)
    expect(server.authorizationRequests).toHaveLength(0)
    expect(server.tokenRequests).toHaveLength(0)
  })

  it('符号链接凭据文件被拒绝且目标不变', async () => {
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const target = join(agentDir, 'target-auth.json')
    await writeFile(target, '{"sentinel":true}')
    await mkdir(dirname(authPath(agentDir)), { recursive: true, mode: 0o700 })
    if (!(await trySymlink(target, authPath(agentDir), 'file'))) return
    const instance = service({ agentDir })
    const entry = makeEntry('symlink', server.resourceUrl)

    await expect(instance.hasCredentials(entry)).rejects.toBeInstanceOf(McpOAuthError)
    await expect(
      instance.login(entry, {
        cwd: process.cwd(),
        showAuthorizationUrl: () => undefined,
        promptForRedirectUrl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'storage' })
    expect(await readFile(target, 'utf8')).toBe('{"sentinel":true}')
    expect(server.registrationCount).toBe(0)
  })

  it('刷新请求 15 秒有界', async () => {
    const server = await startServer({
      expiresIn: 1,
      refreshExpiresIn: 3600,
      refreshDelayMs: 20_000,
    })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('bounded', server.resourceUrl)
    await loginLoopback(instance, entry, process.cwd())
    const handler = instance.createAuthProvider({
      entry,
      url: new URL(server.resourceUrl),
      cwd: process.cwd(),
    })
    if (!handler) throw new Error('missing auth provider')
    const before = await readAuthFile(agentDir)
    const oldToken = (before[mcpServerIdentity(entry)]?.tokens as { access_token?: string })
      ?.access_token

    const started = Date.now()
    await expect(handler.provider.token()).resolves.toBe(oldToken)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThan(14_000)
    expect(elapsed).toBeLessThan(20_000)
    expect(server.refreshCount).toBe(1)
  }, 30_000)

  it('权限修复后仍能安全写入', async () => {
    if (process.platform === 'win32') return
    const server = await startServer({ expiresIn: 3600 })
    const agentDir = await tempAgentDir()
    const instance = service({ agentDir })
    const entry = makeEntry('mode', server.resourceUrl)
    await loginLoopback(instance, entry, process.cwd())
    // 模拟外部把目录/文件放宽，下一次写入应恢复 0600/0700。
    await chmod(authPath(agentDir), 0o644)
    await chmod(dirname(authPath(agentDir)), 0o755)
    await instance.logout(entry)
    expect((await stat(dirname(authPath(agentDir)))).mode & 0o077).toBe(0)
    expect((await stat(authPath(agentDir))).mode & 0o077).toBe(0)
  })
})
