/**
 * MCP OAuth 凭据、登录与刷新协调（G1.4d3）。
 *
 * 选择性移植自 `@earendil-works/pi-coding-agent@1.4.0` 的
 * `packages/coding-agent/src/extensions/mcp/oauth.ts`，来源指纹与本地差异见
 * `packages/mcp/THIRD-PARTY-NOTICES.md`。
 *
 * 与上游不同：
 * - 凭据固定写入 `<agentDir>/huan/mcp-auth.json`，不读取 Pi 的同名文件；
 * - 使用本包的有界读取、原子写入与同进程路径队列，不依赖私有 auth storage 或
 *   proper-lockfile；
 * - 登录/刷新/退出按“服务器名 + 规范 URL”在本进程内共享锁与单飞；
 * - 不包含浏览器自动打开、HTML 页面与 TUI 链路。
 *
 * OAuth 协议本身（PKCE、discovery、DCR、CIMD、state/issuer 校验、scope）全部
 * 交给官方 `@earendil-works/pi-mcp/oauth`。
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { McpFetch } from '@earendil-works/pi-mcp'
import {
  type AuthorizationServerMetadata,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthCallback,
  OAuthCallbackServer,
  type OAuthCallbackServerOptions,
  type OAuthChallenge,
  type OAuthClientInformationMixed,
  type OAuthClientMetadataDocument,
  parseWwwAuthenticate,
  stepUpScope,
} from '@earendil-works/pi-mcp/oauth'
import type { McpServerEntry } from './config.js'
import { type McpCommandRunner, McpValueResolutionError, resolveMcpValue } from './config-values.js'
import type { McpAuthProviderFactory, McpAuthProviderHandle } from './connection.js'
import {
  assertMcpConfigPathSafe,
  readMcpConfigText,
  withMcpConfigPathQueue,
  writeMcpConfigFileAtomic,
} from './file-io.js'
import { MCP_AUTH_FILE_NAME, MCP_STATE_DIR } from './paths.js'

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'
/** Client ID Metadata Document 前缀；与上游保持一致，不在本地伪造新的 CIMD 身份。 */
const CLIENT_METADATA_BASE_URL = 'https://pi.dev/oauth'
/** 刷新时没有已注册 redirect URI 的后备值；刷新不会打开浏览器。 */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`
/** 访问令牌接近过期时提前刷新。 */
const REFRESH_SKEW_MS = 30_000
/** 每个 OAuth 请求的上限；刷新整体也使用同一上限。 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000
/** 默认的 DCR client_name；huan 不冒充 Pi。 */
const DEFAULT_CLIENT_NAME = 'huan'

/** 受控的 OAuth 服务错误码；不包含令牌或配置值。 */
export type McpOAuthErrorCode =
  | 'not-oauth'
  | 'cancelled'
  | 'storage'
  | 'closed'
  | 'invalid-redirect'
  | 'protocol'

/** OAuth 服务错误基类；message 可直接用于受控诊断，不含秘密。 */
export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode

  constructor(code: McpOAuthErrorCode, message: string) {
    super(message)
    this.name = 'McpOAuthError'
    this.code = code
  }
}

/** 登录被用户或宿主取消。 */
export class McpSignInCancelledError extends McpOAuthError {
  constructor(message = 'MCP 登录已取消。') {
    super('cancelled', message)
    this.name = 'McpSignInCancelledError'
  }
}

/** 凭据文件不可读、损坏或无法安全写入。 */
export class McpOAuthStorageError extends McpOAuthError {
  constructor(message: string) {
    super('storage', message)
    this.name = 'McpOAuthStorageError'
  }
}

/** 服务已关闭。 */
export class McpOAuthServiceClosedError extends McpOAuthError {
  constructor() {
    super('closed', 'MCP OAuth 服务已关闭。')
    this.name = 'McpOAuthServiceClosedError'
  }
}

/** 条目不是可由 OAuth 接管的 HTTP 连接。 */
export class McpOAuthNotSupportedError extends McpOAuthError {
  constructor() {
    super('not-oauth', '该 MCP 服务器不使用 OAuth。')
    this.name = 'McpOAuthNotSupportedError'
  }
}

/** 登录提示；实现方负责展示授权链接并等待用户回填。 */
export interface McpOAuthLoginOptions {
  /** clientSecret 中 `!command` 的执行目录。 */
  cwd: string
  /** 取消登录；也会关闭 loopback callback。 */
  signal?: AbortSignal
  /** 只展示授权链接，不自动打开浏览器。 */
  showAuthorizationUrl: (url: URL) => void
  /** 让用户粘贴浏览器地址栏中的完整回填 URL；取消时返回 undefined。 */
  promptForRedirectUrl: (signal: AbortSignal) => Promise<string | undefined>
}

/** OAuth 服务构造选项；构造只保存路径/注入，不读盘、不联网、不执行命令。 */
export interface McpOAuthServiceOptions {
  agentDir: string
  env?: Readonly<Record<string, string | undefined>>
  runCommand?: McpCommandRunner
  /** 注入的 fetch；默认使用全局 fetch。 */
  fetch?: McpFetch
}

/** 宿主域共享的 OAuth 服务；同一进程内所有会话复用。 */
export interface McpOAuthService {
  /** 连接层 auth provider 工厂；只接管无 Authorization、无 auth.provider 的 HTTP 条目。 */
  createAuthProvider: McpAuthProviderFactory
  /** 登录并保存凭据；同一 identity 的刷新/登录/退出互斥。 */
  login(entry: McpServerEntry, options: McpOAuthLoginOptions): Promise<void>
  /** 删除凭据；返回是否确实删除了内容。 */
  logout(entry: McpServerEntry): Promise<boolean>
  /** 是否存有令牌；不读取 Pi 凭据。 */
  hasCredentials(entry: McpServerEntry): Promise<boolean>
  /** 停止接受新操作，并等待进行中的刷新完成落盘。 */
  close(): Promise<void>
}

/** 回调监听设置。 */
interface CallbackSettings {
  host: string
  redirectHost: string
  port: number | undefined
  path: string
  /** 固定端口时发送给授权服务器的精确 redirect URI。 */
  fixedRedirectUrl: string | undefined
}

/** 从配置生成回调设置；保留官方 callbackUrl/callbackPort 语义。 */
function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
  const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`)
  const address = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port ? Number(url.port) : settings.callbackPort
  let fixedRedirectUrl: string | undefined
  // 带端口配置的 URI 按原文发送，因为授权服务器按字符串比较。
  if (url.port) fixedRedirectUrl = settings.callbackUrl
  else if (port !== undefined) {
    url.port = String(port)
    fixedRedirectUrl = url.href
  }
  return {
    host: address === 'localhost' ? CALLBACK_HOST : address,
    redirectHost: address,
    port,
    path: url.pathname,
    fixedRedirectUrl,
  }
}

/** 合并多个 scope 列表，去重并保持首次出现顺序。 */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))]
  return merged.length > 0 ? merged.join(' ') : undefined
}

/** 已注册 client 的 redirect_uris；非完整 client 返回空数组。 */
function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
  return client && 'redirect_uris' in client ? client.redirect_uris : []
}

/** 与上游一致的服务器 URL 回调标识。 */
function callbackId(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.hash = ''
  return createHash('sha256').update(url.href).digest().subarray(0, 9).toString('base64url')
}

/**
 * 官方 Client ID Metadata Document 选择逻辑。
 *
 * 没有 RFC 9207 `iss` 时，redirect URI 与文档都按 MCP 服务器区分，避免把响应
 * 混到另一个授权服务器。该行为与上游保持一致。
 */
function clientMetadataDocument(
  serverUrl: string,
  redirectUrl: string,
  metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
  if (
    !metadata?.client_id_metadata_document_supported ||
    !metadata.token_endpoint_auth_methods_supported?.includes('none')
  ) {
    throw new Error(
      'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
    )
  }
  if (metadata.authorization_response_iss_parameter_supported) {
    return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl }
  }
  const id = callbackId(serverUrl)
  const redirect = new URL(redirectUrl)
  redirect.pathname = `${CALLBACK_PATH}/${id}`
  return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href }
}

/** 已解析的 OAuth 设置；clientSecret 只在实际需要时解析。 */
interface McpOAuthSettings {
  clientId?: string
  clientSecret?: string
  callbackPort?: number
  callbackUrl?: string
  scope?: string
  clientName?: string
  clientRegistration?: 'dcr' | 'cimd'
  authServerMetadataUrl?: URL
}

/** 条目是否允许使用 OAuth：HTTP、且没有静态 Authorization 或 auth.provider。 */
function entryUsesOAuth(entry: McpServerEntry): boolean {
  if (!('url' in entry.config)) return false
  const headers = entry.config.headers ?? {}
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) return false
  return entry.config.auth?.provider === undefined
}

/** 规范服务器 URL：去掉 fragment；其余由 URL 解析器归一化。 */
function canonicalServerUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.href
  } catch {
    return raw
  }
}

/**
 * 受控的服务器身份字符串。
 *
 * 身份 = 服务器名 + 规范 URL 的截断 SHA-256；不包含 URL、查询参数、凭据或令牌，
 * 因此可以安全地交给宿主匹配或普通界面使用。stdio 条目只包含名称。
 */
export function mcpServerIdentity(entry: McpServerEntry): string {
  if ('url' in entry.config) {
    const digest = createHash('sha256')
      .update(canonicalServerUrl(entry.config.url))
      .digest('hex')
      .slice(0, 32)
    return `mcp:${entry.name}:${digest}`
  }
  return `mcp:${entry.name}:stdio`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneState(state: McpOAuthState): McpOAuthState {
  return structuredClone(state)
}

/**
 * `<agentDir>/huan/mcp-auth.json` 的安全存储。
 *
 * 文件结构为 `identity -> McpOAuthState` 的扁平 JSON 对象。写入始终走同进程
 * 路径队列与原子 rename；读取/写入都拒绝符号链接与损坏内容，绝不在坏文件上
 * 覆盖。文件权限由底层写入原语设置为 0600，目录首次创建为 0700。
 */
class McpOAuthCredentialStore {
  readonly path: string
  private readonly agentDir: string

  constructor(agentDir: string) {
    this.agentDir = resolve(agentDir)
    this.path = join(this.agentDir, MCP_STATE_DIR, MCP_AUTH_FILE_NAME)
  }

  async load(identity: string): Promise<McpOAuthState | undefined> {
    // 读也走路径队列，避免与 rename 在 Windows 上交错；队列只做短读，不会阻塞网络。
    return withMcpConfigPathQueue(this.path, async () => {
      const states = await this.readAll()
      const state = states[identity]
      return state ? cloneState(state) : undefined
    })
  }

  async save(identity: string, state: McpOAuthState): Promise<void> {
    await withMcpConfigPathQueue(this.path, async () => {
      const states = await this.readAll()
      states[identity] = cloneState(state)
      await this.writeAll(states)
    })
  }

  async remove(identity: string): Promise<boolean> {
    return withMcpConfigPathQueue(this.path, async () => {
      const states = await this.readAll()
      if (!Object.hasOwn(states, identity)) return false
      delete states[identity]
      await this.writeAll(states)
      return true
    })
  }

  private async readAll(): Promise<Record<string, McpOAuthState>> {
    const read = await readMcpConfigText(this.path, this.agentDir)
    if (read.readError || read.tooLarge) {
      throw new McpOAuthStorageError('无法读取 MCP 认证凭据文件。')
    }
    if (!read.exists) return Object.create(null) as Record<string, McpOAuthState>
    const content = read.content.replace(/^\uFEFF/, '')
    if (!content.trim()) return Object.create(null) as Record<string, McpOAuthState>
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new McpOAuthStorageError('MCP 认证凭据文件不是有效的 JSON。')
    }
    if (!isRecord(parsed)) {
      throw new McpOAuthStorageError('MCP 认证凭据文件结构无效。')
    }
    const states = Object.create(null) as Record<string, McpOAuthState>
    for (const [identity, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        throw new McpOAuthStorageError('MCP 认证凭据文件结构无效。')
      }
      states[identity] = value as unknown as McpOAuthState
    }
    return states
  }

  private async writeAll(states: Record<string, McpOAuthState>): Promise<void> {
    const directory = dirname(this.path)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await assertMcpConfigPathSafe(this.agentDir, this.path)
      // 已有目录也尽量收紧权限；失败不影响原子写入本身。
      await chmod(directory, 0o700).catch(() => undefined)
      const content = `${JSON.stringify(states, null, 2)}\n`
      if (Buffer.byteLength(content) > 512 * 1024) {
        throw new McpOAuthStorageError('MCP 认证凭据文件超过大小上限。')
      }
      await writeMcpConfigFileAtomic(this.path, content, this.agentDir)
    } catch (error) {
      if (error instanceof McpOAuthStorageError) throw error
      throw new McpOAuthStorageError('无法安全写入 MCP 认证凭据文件。')
    }
  }
}

/** 同进程 identity 互斥队列；跨会话/跨 manager 共享。 */
class IdentityLocks {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(identity: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(identity) ?? Promise.resolve()
    const current = previous.then(task, task)
    const tail = current.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(identity, tail)
    try {
      return await current
    } finally {
      if (this.tails.get(identity) === tail) this.tails.delete(identity)
    }
  }
}

/** 同一凭据文件在进程内共享同一组 identity 锁，避免多个 service 实例并发刷新。 */
const identityLockGroups = new Map<string, IdentityLocks>()

type AuthorizationResponse = Pick<OAuthCallback, 'code' | 'iss'>

/** 解析用户回填的 redirect URL，严格校验 origin/path/state。 */
function responseFromRedirectUrl(
  input: string,
  state: string,
  redirectUrl: URL,
): AuthorizationResponse {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new McpOAuthError('invalid-redirect', '回填内容不是完整的重定向 URL。')
  }
  // 服务器专属 redirect URI 用于区分授权服务器，因此必须精确匹配。
  if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
    throw new McpOAuthError('invalid-redirect', '回填的重定向 URL 不属于本次登录。')
  }
  const error = url.searchParams.get('error')
  if (error) {
    throw new McpOAuthError('invalid-redirect', '授权服务器返回失败。')
  }
  if (url.searchParams.get('state') !== state) {
    throw new McpOAuthError('invalid-redirect', '回填的重定向 URL 来自另一次登录。')
  }
  const code = url.searchParams.get('code')
  if (!code) {
    throw new McpOAuthError('invalid-redirect', '回填的重定向 URL 没有授权码。')
  }
  return { code, iss: url.searchParams.get('iss') ?? undefined }
}

/** 等待浏览器回调或用户回填，先到者生效；取消时立即结束。 */
async function waitForAuthorizationResponse(
  callback: OAuthCallbackServer,
  state: string,
  redirectUrl: URL,
  prompt: McpOAuthLoginOptions,
  signal: AbortSignal | undefined,
): Promise<AuthorizationResponse> {
  if (signal?.aborted) throw new McpSignInCancelledError()
  const controller = new AbortController()
  const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname)
  // 先挂上拒绝处理：即使 prompt 同步抛错或 callback 被关闭，也不产生未处理拒绝。
  fromBrowser.catch(() => undefined)
  let fromUser: Promise<AuthorizationResponse> | undefined
  let abortReject: ((error: McpSignInCancelledError) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abortReject = reject
  })
  const onAbort = () => abortReject?.(new McpSignInCancelledError())
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
      if (!input?.trim()) throw new McpSignInCancelledError()
      return responseFromRedirectUrl(input, state, redirectUrl)
    })
    fromUser.catch(() => undefined)
    return await Promise.race([fromBrowser, fromUser, aborted])
  } finally {
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
    fromUser?.catch(() => undefined)
  }
}

/** 监听固定或空闲端口；固定端口被占用时按配置失败。 */
async function listenForCallback(
  settings: CallbackSettings,
  extraPaths: string[],
  port: number | undefined,
  required: boolean,
): Promise<OAuthCallbackServer> {
  const options: OAuthCallbackServerOptions = {
    host: settings.host,
    redirectHost: settings.redirectHost,
    path: settings.path,
    extraPaths,
  }
  try {
    return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 })
  } catch (error) {
    if (required || port === undefined) throw error
    return OAuthCallbackServer.listen(options)
  }
}

/** 本进程内按 identity 共享的 OAuth 协调服务。 */
export class McpOAuthServiceHost implements McpOAuthService {
  private readonly agentDir: string
  private readonly env: Readonly<Record<string, string | undefined>> | undefined
  private readonly runCommand: McpCommandRunner | undefined
  private readonly fetchImpl: McpFetch
  private readonly store: McpOAuthCredentialStore
  private readonly locks: IdentityLocks
  /** 服务级单飞：同 identity 的刷新请求共享一次。 */
  private readonly refreshing = new Map<string, Promise<void>>()
  /** 进行中的刷新任务；close 等待它们完成落盘。 */
  private readonly refreshTasks = new Set<Promise<void>>()
  /** 进行中的登录任务；close 会取消并等待 callback 回收。 */
  private readonly loginTasks = new Set<Promise<void>>()
  /** 宿主关闭信号；只取消登录，不影响必须落盘的刷新。 */
  private readonly shutdown = new AbortController()
  /** 最近一次 401 的 challenge；登录时使用 resource metadata URL 与 scope。 */
  private readonly challenges = new Map<string, OAuthChallenge>()
  private closedValue = false
  private closePromise: Promise<void> | undefined

  constructor(options: McpOAuthServiceOptions) {
    if (typeof options.agentDir !== 'string' || !options.agentDir) {
      throw new McpOAuthError('storage', 'MCP OAuth 服务需要 agentDir。')
    }
    this.agentDir = resolve(options.agentDir)
    this.env = options.env ? { ...options.env } : undefined
    this.runCommand = options.runCommand
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    // 构造只计算路径，不读盘、不联网、不执行命令。
    this.store = new McpOAuthCredentialStore(this.agentDir)
    // 同一 agentDir 的多个 service 实例共享 identity 锁；文件写入另由路径队列串行。
    const lockKey = process.platform === 'win32' ? this.store.path.toLowerCase() : this.store.path
    const existingLocks = identityLockGroups.get(lockKey)
    if (existingLocks) this.locks = existingLocks
    else {
      this.locks = new IdentityLocks()
      identityLockGroups.set(lockKey, this.locks)
    }
  }

  readonly createAuthProvider: McpAuthProviderFactory = (context) => {
    if (!entryUsesOAuth(context.entry)) return undefined
    const entry = structuredClone(context.entry)
    const identity = mcpServerIdentity(entry)
    const cwd = context.cwd ?? process.cwd()
    let refreshing: Promise<void> | undefined

    const runRefresh = (
      staleToken: string | undefined,
      challenge: OAuthChallenge | undefined,
      fetch: McpFetch | undefined,
    ): Promise<void> => {
      refreshing ??= this.refresh(entry, identity, cwd, staleToken, challenge, fetch).finally(
        () => {
          refreshing = undefined
        },
      )
      return refreshing
    }

    const provider: McpAuthProviderHandle['provider'] = {
      token: async () => {
        await refreshing?.catch(() => undefined)
        const state = await this.store.load(identity)
        const token = state?.tokens?.access_token
        const expired =
          state?.tokensExpireAt !== undefined &&
          state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now()
        if (!expired || !state?.tokens?.refresh_token) return token
        // 刷新失败时让请求先带旧令牌发出，由 401 决定后续；与官方语义一致。
        await runRefresh(token, undefined, undefined).catch(() => undefined)
        return (await this.store.load(identity))?.tokens?.access_token
      },
      onUnauthorized: async (unauthorized) => {
        const challenge = parseWwwAuthenticate(
          unauthorized.response.headers.get('www-authenticate'),
        )
        // challenge 供显式登录使用（resource metadata URL 与追加 scope）。
        this.challenges.set(identity, challenge)
        // 刷新保留已授予 scope；追加 scope 必须重新走浏览器授权。
        if (challenge.error === 'insufficient_scope') {
          throw new McpOAuthAuthorizationRequiredError()
        }
        await runRefresh(unauthorized.token, challenge, unauthorized.fetch)
      },
    }

    return {
      provider,
      settled: async () => {
        await refreshing?.catch(() => undefined)
      },
    }
  }

  async login(entry: McpServerEntry, options: McpOAuthLoginOptions): Promise<void> {
    if (this.closedValue) throw new McpOAuthServiceClosedError()
    if (!entryUsesOAuth(entry)) throw new McpOAuthNotSupportedError()
    const identity = mcpServerIdentity(entry)
    if (options.signal?.aborted) throw new McpSignInCancelledError()
    // 宿主关闭也取消登录，但刷新不受 shutdown 影响（轮换结果必须落盘）。
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.shutdown.signal])
      : this.shutdown.signal
    const loginOptions: McpOAuthLoginOptions = { ...options, signal }
    const task = this.locks.run(identity, async () => {
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      if (signal.aborted) throw new McpSignInCancelledError()
      await this.loginLocked(entry, identity, loginOptions)
    })
    this.loginTasks.add(task)
    const cleanup = () => {
      this.loginTasks.delete(task)
    }
    void task.then(cleanup, cleanup)
    try {
      await task
    } catch (error) {
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      // clientSecret 命令解析等登录前置步骤被取消时也统一为取消错误。
      if (options.signal?.aborted) throw new McpSignInCancelledError()
      throw error
    }
  }

  async logout(entry: McpServerEntry): Promise<boolean> {
    if (!entryUsesOAuth(entry)) return false
    if (this.closedValue) throw new McpOAuthServiceClosedError()
    const identity = mcpServerIdentity(entry)
    return this.locks.run(identity, async () => {
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      const removed = await this.store.remove(identity)
      this.challenges.delete(identity)
      return removed
    })
  }

  async hasCredentials(entry: McpServerEntry): Promise<boolean> {
    if (!entryUsesOAuth(entry)) return false
    const state = await this.store.load(mcpServerIdentity(entry))
    const tokens = state?.tokens
    if (!isRecord(tokens)) return false
    return typeof tokens.access_token === 'string' || typeof tokens.refresh_token === 'string'
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closedValue = true
    // 取消等待用户回填的登录；刷新故意不取消，必须等待轮换结果保存。
    this.shutdown.abort()
    this.closePromise = (async () => {
      while (this.refreshTasks.size > 0 || this.loginTasks.size > 0) {
        await Promise.allSettled([...this.refreshTasks, ...this.loginTasks])
      }
    })()
    return this.closePromise
  }

  private async loginLocked(
    entry: McpServerEntry,
    identity: string,
    options: McpOAuthLoginOptions,
  ): Promise<void> {
    if (!('url' in entry.config)) throw new McpOAuthNotSupportedError()
    const signal = options.signal
    const stored = await this.store.load(identity)
    const settings = await this.resolveSettings(entry, options.cwd, signal)
    const challenge = this.challenges.get(identity)
    const stepUp = challenge?.error === 'insufficient_scope'
    const callbackOptions = callbackSettings(settings)
    // 复用已注册 redirect URI 的端口，让已注册 client 保持有效。
    const registered = registeredRedirectUrls(stored?.clientInformation)[0]
    let registeredPort: number | undefined
    if (registered) {
      try {
        registeredPort = Number(new URL(registered).port) || undefined
      } catch {
        // 忽略损坏的已注册 redirect URI；本次登录仍可使用配置的回调地址。
      }
    }
    const preferredPort = callbackOptions.port ?? registeredPort
    const cimd = settings.clientRegistration === 'cimd'
    const callback = await listenForCallback(
      callbackOptions,
      // 无 iss 时 CIMD 使用服务器专属 callback path。
      cimd ? [`${CALLBACK_PATH}/${callbackId(entry.config.url)}`] : [],
      preferredPort,
      callbackOptions.port !== undefined,
    )
    const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl
    try {
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      if (stored) {
        const next: McpOAuthState = { ...stored }
        // 每次登录都换新的 state。
        delete next.oauthState
        // 已注册 client 不能换 redirect URI；CIMD 不保存 client，因此旧 client 被替换。
        const keepClient = Boolean(
          settings.clientId ||
            (cimd
              ? !stored.clientInformation
              : registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)),
        )
        if (!keepClient) {
          delete next.clientInformation
          delete next.tokens
          delete next.tokensExpireAt
        }
        await this.store.save(identity, next)
        if (signal?.aborted) throw new McpSignInCancelledError()
      }

      let authorizationUrl: URL | undefined
      const provider = this.createProvider(entry, identity, settings, redirectUrl, (url) => {
        authorizationUrl = url
      })
      const flow = {
        serverUrl: canonicalServerUrl(entry.config.url),
        fetch: this.timedFetch(signal),
        ...(signal ? { signal } : {}),
        ...(challenge?.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        ...(settings.authServerMetadataUrl
          ? { authorizationServerMetadataUrl: settings.authServerMetadataUrl }
          : {}),
        // 追加 scope 叠加配置 scope 与已授予 scope，避免刷新/登录丢掉权限。
        scope: mergeScopes(
          settings.scope,
          stepUp ? stepUpScope(stored?.tokens?.scope, challenge?.scope) : challenge?.scope,
        ),
      }
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      // 刷新会保留已授予 scope；追加 scope 必须走浏览器授权。
      if ((await authorizeMcp(provider, { ...flow, skipRefresh: stepUp })) === 'AUTHORIZED') {
        this.challenges.delete(identity)
        return
      }
      if (!authorizationUrl) {
        throw new McpOAuthError('protocol', 'OAuth 流程没有生成授权链接。')
      }

      const state = await provider.state()
      // 流程可能选择服务器专属 redirect URI。
      const authorizationRedirectUrl = new URL(
        authorizationUrl.searchParams.get('redirect_uri') ?? redirectUrl,
      )
      options.showAuthorizationUrl(authorizationUrl)
      const { code, iss } = await waitForAuthorizationResponse(
        callback,
        state,
        authorizationRedirectUrl,
        options,
        signal,
      )
      // close 后不再用已拿到的授权码写新凭据。
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      await authorizeMcp(provider, {
        ...flow,
        authorizationCode: code,
        ...(iss === undefined ? {} : { iss }),
      })
      this.challenges.delete(identity)
    } catch (error) {
      if (signal?.aborted) throw new McpSignInCancelledError()
      throw error
    } finally {
      // 取消或失败也必须回收 callback 端口。
      await callback.close().catch(() => undefined)
    }
  }

  /** 刷新：服务级单飞 + identity 锁 + 整体 15 秒上限。 */
  private refresh(
    entry: McpServerEntry,
    identity: string,
    cwd: string,
    staleToken: string | undefined,
    challenge: OAuthChallenge | undefined,
    fetch: McpFetch | undefined,
  ): Promise<void> {
    if (!('url' in entry.config)) {
      return Promise.reject(new McpOAuthNotSupportedError())
    }
    const serverUrl = entry.config.url
    if (this.closedValue) return Promise.reject(new McpOAuthServiceClosedError())
    const existing = this.refreshing.get(identity)
    if (existing) return existing

    const task = this.locks.run(identity, async () => {
      if (this.closedValue) throw new McpOAuthServiceClosedError()
      const state = await this.store.load(identity)
      // 令牌已变化（另一个刷新/登录完成）或已被退出，直接结束；不重放旧 refresh token。
      if (state?.tokens?.access_token !== staleToken) return
      if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError()

      // 刷新整体有界，包含 clientSecret 命令解析与所有 OAuth 请求。
      const deadline = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)
      const settings = await this.resolveSettings(entry, cwd, deadline)
      const redirectUrl =
        callbackSettings(settings).fixedRedirectUrl ??
        registeredRedirectUrls(state.clientInformation)[0] ??
        FALLBACK_REDIRECT_URL
      const provider = this.createProvider(entry, identity, settings, redirectUrl, () => {})
      const result = await authorizeMcp(provider, {
        serverUrl: canonicalServerUrl(serverUrl),
        ...(challenge?.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        ...(settings.authServerMetadataUrl
          ? { authorizationServerMetadataUrl: settings.authServerMetadataUrl }
          : {}),
        ...(challenge?.scope === undefined ? {} : { scope: challenge.scope }),
        fetch: this.timedFetch(undefined, deadline, fetch),
        signal: deadline,
      })
      if (result === 'REDIRECT') throw new McpOAuthAuthorizationRequiredError()
      this.challenges.delete(identity)
    })

    this.refreshing.set(identity, task)
    this.refreshTasks.add(task)
    const cleanup = () => {
      if (this.refreshing.get(identity) === task) this.refreshing.delete(identity)
      this.refreshTasks.delete(task)
    }
    void task.then(cleanup, cleanup)
    return task
  }

  private createProvider(
    entry: McpServerEntry,
    identity: string,
    settings: McpOAuthSettings,
    redirectUrl: string,
    onRedirect: (url: URL) => void,
  ): McpOAuthProvider {
    if (!('url' in entry.config)) throw new McpOAuthNotSupportedError()
    const serverUrl = canonicalServerUrl(entry.config.url)
    const store: McpOAuthStateStore = {
      load: () => this.store.load(identity),
      save: (state) => this.store.save(identity, state),
    }
    return new McpOAuthProvider({
      serverUrl,
      redirectUrl,
      clientMetadata: { client_name: settings.clientName ?? DEFAULT_CLIENT_NAME },
      ...(settings.clientRegistration === 'cimd'
        ? {
            clientMetadataDocument: (metadata: AuthorizationServerMetadata | undefined) =>
              clientMetadataDocument(serverUrl, redirectUrl, metadata),
          }
        : {}),
      ...(settings.clientId === undefined ? {} : { clientId: settings.clientId }),
      ...(settings.clientSecret === undefined ? {} : { clientSecret: settings.clientSecret }),
      store,
      onRedirect,
    })
  }

  /** 只在真正需要时解析 clientSecret；`!command` 可取消且不会在构造时执行。 */
  private async resolveSettings(
    entry: McpServerEntry,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<McpOAuthSettings> {
    const oauth = 'url' in entry.config ? entry.config.oauth : undefined
    if (!oauth) return {}
    const settings: McpOAuthSettings = {
      ...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
      ...(oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort }),
      ...(oauth.callbackUrl === undefined ? {} : { callbackUrl: oauth.callbackUrl }),
      ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
      ...(oauth.clientName === undefined ? {} : { clientName: oauth.clientName }),
      ...(oauth.clientRegistration === undefined
        ? {}
        : { clientRegistration: oauth.clientRegistration }),
      ...(oauth.authServerMetadataUrl === undefined
        ? {}
        : { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }),
    }
    if (oauth.clientSecret !== undefined) {
      try {
        settings.clientSecret = await resolveMcpValue(
          oauth.clientSecret,
          `MCP 服务器 "${entry.name}" 的 oauth.clientSecret`,
          {
            ...(this.env ? { env: this.env } : {}),
            cwd,
            ...(signal ? { signal } : {}),
            ...(this.runCommand ? { runCommand: this.runCommand } : {}),
          },
        )
      } catch (error) {
        if (error instanceof McpValueResolutionError) throw error
        throw new McpValueResolutionError('invalid', '无法解析 MCP oauth.clientSecret。')
      }
    }
    return settings
  }

  /** 为每个请求加 15 秒上限，并叠加调用方的整体取消信号。 */
  private timedFetch(
    overall: AbortSignal | undefined,
    deadline?: AbortSignal,
    base: McpFetch = this.fetchImpl,
  ): McpFetch {
    return (input, init) => {
      const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)
      const signals = [init?.signal, timeout, overall, deadline].filter(
        (signal): signal is AbortSignal => signal !== undefined && signal !== null,
      )
      const signal =
        signals.length === 0
          ? undefined
          : signals.length === 1
            ? signals[0]
            : AbortSignal.any(signals)
      return base(input, { ...init, ...(signal ? { signal } : {}) })
    }
  }
}

/** 创建宿主域共享的 OAuth 服务；构造无 I/O。 */
export function createMcpOAuthService(options: McpOAuthServiceOptions): McpOAuthService {
  return new McpOAuthServiceHost(options)
}
