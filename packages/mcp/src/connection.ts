/**
 * 单个 MCP 服务器连接（G1.4d2a）。
 *
 * 选择性移植自 `@earendil-works/pi-coding-agent@1.4.0` 的
 * `packages/coding-agent/src/extensions/mcp/runtime.ts`，来源指纹与本地差异见
 * `packages/mcp/THIRD-PARTY-NOTICES.md`。
 *
 * 本模块只管理一个已验证条目的连接生命周期：真实官方 `McpClient` +
 * `StdioTransport` / `StreamableHttpTransport`，opening 单飞，连接/目录状态
 * 发布，动态 tools 刷新，只读请求的一次重试，以及终态关闭。所有 client 的
 * close promise 都被记忆，避免官方 `client.close()` 第二次调用提前完成。
 * 不包含 Pi 工具注册、OAuth 存储/登录或 TUI。
 */

import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type AuthProvider,
  type CallToolResult,
  JSON_RPC_ERROR_CODES,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  type McpRequestOptions,
  McpSessionExpiredError,
  McpTimeoutError,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
} from '@earendil-works/pi-mcp'
import { McpOAuthAuthorizationRequiredError } from '@earendil-works/pi-mcp/oauth'
import type { McpServerEntry } from './config.js'
import {
  expandMcpHomePath,
  type McpCommandRunner,
  McpValueResolutionError,
  resolveMcpEnvValues,
  resolveMcpHeaders,
} from './config-values.js'
import type { McpServerLogSink } from './log.js'

const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_TIMER_MS = 2_147_483_647
const CONNECT_RETRY_DELAYS_MS = [250, 1_000] as const
const READ_RETRY_DELAY_MS = 250
const CLIENT_NAME = 'huan'
const CLIENT_VERSION = '0.0.0'

/** 连接状态；disabled 由 manager 投影，不放这里。 */
export type McpConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs-auth'
  | 'failed'
  | 'closed'

/** 管理快照允许出现的受控错误码。 */
export type McpConnectionErrorCode =
  | 'connect-failed'
  | 'needs-auth'
  | 'connection-closed'
  | 'tools-refresh-failed'
  | 'value-resolution-failed'

/** 管理快照中的错误只含受控码与固定消息。 */
export interface McpConnectionError {
  code: McpConnectionErrorCode
  message: string
}

/** 连接状态快照；不含 tools、instructions、URL、env、headers、stderr 或原始异常。 */
export interface McpConnectionSnapshot {
  state: McpConnectionState
  toolCount: number
  hasResources: boolean
  catalogRevision: number
  error?: McpConnectionError
}

/** 单个操作的受控错误码。 */
export type McpOperationErrorCode =
  | 'manager-closed'
  | 'not-started'
  | 'unknown-server'
  | 'server-disabled'
  | 'server-hidden'
  | 'tool-hidden'
  | 'tool-unavailable'
  | 'connect-failed'
  | 'needs-auth'
  | 'cancelled'
  | 'timeout'
  | 'session-expired'
  | 'connection-closed'
  | 'request-failed'
  | 'resources-unavailable'

const OPERATION_MESSAGES: Readonly<Record<McpOperationErrorCode, string>> = {
  'manager-closed': 'MCP 连接管理器已关闭。',
  'not-started': 'MCP 连接管理器尚未启动。',
  'unknown-server': '未知的 MCP 服务器。',
  'server-disabled': 'MCP 服务器已禁用。',
  'server-hidden': 'MCP 服务器已隐藏。',
  'tool-hidden': 'MCP 工具已隐藏。',
  'tool-unavailable': 'MCP 工具当前不可用。',
  'connect-failed': 'MCP 服务器连接失败。',
  'needs-auth': 'MCP 服务器需要认证。',
  cancelled: 'MCP 请求已取消。',
  timeout: 'MCP 请求超时。',
  'session-expired': 'MCP 会话已过期。',
  'connection-closed': 'MCP 连接已关闭。',
  'request-failed': 'MCP 请求失败。',
  'resources-unavailable': 'MCP 服务器未提供资源。',
}

/** 受控的请求/管理错误；不携带原始异常消息，避免泄露配置值。 */
export class McpOperationError extends Error {
  readonly code: McpOperationErrorCode

  constructor(code: McpOperationErrorCode, message = OPERATION_MESSAGES[code]) {
    super(message)
    this.name = 'McpOperationError'
    this.code = code
  }
}

const CONNECTION_ERROR_MESSAGES: Readonly<Record<McpConnectionErrorCode, string>> = {
  'connect-failed': 'MCP 服务器连接失败。',
  'needs-auth': 'MCP 服务器需要认证。',
  'connection-closed': 'MCP 连接已关闭。',
  'tools-refresh-failed': 'MCP 工具目录刷新失败，目录已撤下。',
  'value-resolution-failed': 'MCP 配置值解析失败。',
}

function connectionError(code: McpConnectionErrorCode): McpConnectionError {
  return { code, message: CONNECTION_ERROR_MESSAGES[code] }
}

/** 把条目里的秒数限制在 Node 定时器合法范围内；非有限值回退默认 60 秒。 */
export function resolveMcpRequestTimeoutMs(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_TIMEOUT_SECONDS * 1000
  }
  const milliseconds = seconds * 1000
  if (!Number.isFinite(milliseconds)) return MAX_TIMER_MS
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(milliseconds)))
}

/** 网络失败、过载或重启中的服务器值得再次连接。 */
function isTransientError(error: unknown): boolean {
  if (error instanceof McpHttpError) {
    return (
      error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
    )
  }
  return error instanceof TypeError
}

function isAuthRequired(error: unknown): boolean {
  return (
    error instanceof McpOAuthAuthorizationRequiredError ||
    error instanceof McpAuthRequiredError ||
    (error instanceof McpHttpError && error.status === 401)
  )
}

function isSessionExpired(error: unknown): boolean {
  return (
    error instanceof McpSessionExpiredError ||
    (error instanceof McpHttpError && error.status === 404)
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof McpAbortError || (error instanceof Error && error.name === 'AbortError')
}

function abortError(): McpOperationError {
  return new McpOperationError('cancelled')
}

/** 等待 promise，但取消信号可以先结束等待；被放弃的 promise 仍由调用方继续持有。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      rejectPromise(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(error)
      },
    )
  })
}

/** 可取消的延迟；返回 false 表示等待期间被取消。 */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolvePromise) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolvePromise(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise(true)
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 注入的 auth provider 包装；settled 在关闭时等待，避免丢失刷新结果。 */
export interface McpAuthProviderHandle {
  provider: AuthProvider
  settled?: () => Promise<void>
}

/** auth provider 工厂上下文。 */
export interface McpAuthProviderFactoryContext {
  entry: McpServerEntry
  url: URL
  /** 连接工作目录；用于异步解析 oauth.clientSecret 的 `!command`。缺省回退进程目录。 */
  cwd?: string
}

/** 只注入官方 AuthProvider；d3 可在这里提供 OAuth provider 与 settled。 */
export type McpAuthProviderFactory = (
  context: McpAuthProviderFactoryContext,
) => McpAuthProviderHandle | undefined

/** transport 工厂上下文。 */
export interface McpTransportFactoryContext {
  entry: McpServerEntry
  cwd: string
  authProvider: AuthProvider | undefined
  signal: AbortSignal
}

/** 可注入 transport，测试可用官方 testing 内存 transport。 */
export type McpTransportFactory = (
  context: McpTransportFactoryContext,
) => McpTransport | Promise<McpTransport>

/** 单连接构造选项。 */
export interface McpServerConnectionOptions {
  entry: McpServerEntry
  cwd: string
  createTransport?: McpTransportFactory
  createAuthProvider?: McpAuthProviderFactory
  /** 动态读取 provider token；每次请求都会调用，不缓存。 */
  providerToken?: (provider: string) => Promise<string | undefined>
  /** 值解析使用的环境；缺省时回退 process.env。 */
  env?: Readonly<Record<string, string | undefined>>
  /** 值解析命令执行器；缺省使用异步 shell。 */
  runCommand?: McpCommandRunner
  /** 发送请求前同步复查当前宿主管理准入，tool 为空表示资源请求。 */
  assertRequestAllowed?: (tool?: string) => void
  /** 状态或目录变化时调用；异常会被吞掉，不影响连接。 */
  onChange?: (connection: McpServerConnection) => void
  /** 收到服务器 `notifications/message` 时调用；不进入普通快照。 */
  onLog?: McpServerLogSink
}

interface OpenResult {
  client: McpClient
  tools: Tool[]
  hasResources: boolean
  instructions: string | undefined
}

/**
 * 单个服务器连接。
 *
 * opening 单飞；close 是终态并等待所有 client/transport 的完整 close promise。
 * 请求在等待连接期间可取消，取消后不会再发送。
 */
export class McpServerConnection {
  readonly entry: McpServerEntry
  readonly cwd: string
  readonly timeoutMs: number

  private readonly options: McpServerConnectionOptions
  private stateValue: McpConnectionState = 'disconnected'
  private errorValue: McpConnectionError | undefined
  private toolsValue: Tool[] = []
  private hasResourcesValue = false
  private instructionsValue: string | undefined
  private catalogRevisionValue = 0
  private client: McpClient | undefined
  private opening: Promise<void> | undefined
  private readonly shutdown = new AbortController()
  private closedValue = false
  private closePromise: Promise<void> | undefined
  private readonly clients = new Set<McpClient>()
  private readonly clientClosings = new WeakMap<McpClient, Promise<void>>()
  private readonly closeTasks = new Set<Promise<void>>()
  private readonly tasks = new Set<Promise<void>>()
  /** 旧 client 正在关闭时，新的 open 必须等它完成，避免重叠 transport。 */
  private closeGate: Promise<void> | undefined
  private authHandle: McpAuthProviderHandle | undefined
  private authHandleCreated = false
  private refreshRunning: Promise<void> | undefined
  private refreshQueuedClient: McpClient | undefined
  private catalogEpoch = 0

  constructor(options: McpServerConnectionOptions) {
    // 构造只保存内存状态，不创建 transport、不解析值、不执行命令。
    this.options = { ...options, ...(options.env ? { env: { ...options.env } } : {}) }
    this.entry = structuredClone(options.entry)
    this.cwd = resolve(options.cwd)
    this.timeoutMs = resolveMcpRequestTimeoutMs(options.entry.config.timeout)
  }

  get name(): string {
    return this.entry.name
  }

  get state(): McpConnectionState {
    return this.stateValue
  }

  get catalogRevision(): number {
    return this.catalogRevisionValue
  }

  getSnapshot(): McpConnectionSnapshot {
    return {
      state: this.stateValue,
      toolCount: this.toolsValue.length,
      hasResources: this.hasResourcesValue,
      catalogRevision: this.catalogRevisionValue,
      ...(this.errorValue ? { error: { ...this.errorValue } } : {}),
    }
  }

  /** 返回复制后的目录；调用方修改不会影响连接内部状态。 */
  getToolCatalog(): {
    revision: number
    tools: readonly Tool[]
    instructions: string | undefined
  } {
    return {
      revision: this.catalogRevisionValue,
      tools: this.toolsValue.map((tool) => structuredClone(tool)),
      instructions: this.instructionsValue,
    }
  }

  /** 首次连接或断线后的懒连接；并发调用共享同一个 opening。 */
  async open(): Promise<void> {
    if (this.closeGate) await this.closeGate.catch(() => undefined)
    if (this.closedValue) throw new McpOperationError('connection-closed')
    if (this.client?.connectionState === 'connected') return
    if (this.opening) {
      await this.opening
      return
    }
    // 异步启动，确保 close() 在 openInternal 开始前就能看到 opening。
    const opening = Promise.resolve().then(() => this.openInternal())
    this.opening = opening
    try {
      await opening
    } finally {
      if (this.opening === opening) this.opening = undefined
    }
  }

  /** 显式重连：关闭旧 client 后重新打开；旧目录在新连接确认前撤下。 */
  async reconnect(): Promise<void> {
    if (this.closedValue) throw new McpOperationError('connection-closed')
    await this.opening?.catch(() => undefined)
    if (this.closedValue) throw new McpOperationError('connection-closed')
    this.catalogEpoch += 1
    this.refreshQueuedClient = undefined
    this.clearCatalog()
    this.catalogRevisionValue += 1
    this.notify()
    const client = this.client
    this.client = undefined
    if (client) await this.dropClient(client)
    await this.open()
  }

  /** 终态关闭；重复调用返回同一个 promise。 */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closedValue = true
      this.closePromise = Promise.resolve().then(() => this.closeInternal())
      this.shutdown.abort()
    }
    return this.closePromise
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: McpRequestOptions,
  ): Promise<CallToolResult> {
    return this.withClient(
      async (client, signal) => {
        if (!this.toolsValue.some((tool) => tool.name === name)) {
          throw new McpOperationError('tool-unavailable')
        }
        this.options.assertRequestAllowed?.(name)
        return client.callTool(name, args, {
          ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
          signal,
          timeoutMs: this.timeoutMs,
        })
      },
      options,
      false,
    )
  }

  async listResourcesPage(
    cursor: string | undefined,
    options?: McpRequestOptions,
  ): Promise<ListResourcesResult> {
    return this.withClient(
      async (client, signal) => {
        this.requireResources()
        return client.listResourcesPage(cursor, {
          ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
          signal,
          timeoutMs: this.timeoutMs,
        })
      },
      options,
      true,
    )
  }

  async listAllResources(options?: McpRequestOptions): Promise<Resource[]> {
    return this.withClient(
      async (client, signal) => {
        this.requireResources()
        return client.listResources({
          ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
          signal,
          timeoutMs: this.timeoutMs,
        })
      },
      options,
      true,
    )
  }

  async listResourceTemplatesPage(
    cursor: string | undefined,
    options?: McpRequestOptions,
  ): Promise<ListResourceTemplatesResult> {
    return this.withClient(
      async (client, signal) => {
        this.requireResources()
        try {
          return await client.listResourceTemplatesPage(cursor, {
            ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
            signal,
            timeoutMs: this.timeoutMs,
          })
        } catch (error) {
          // 不支持 templates/list 的服务器按空模板处理。
          if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) {
            return { resourceTemplates: [] }
          }
          throw error
        }
      },
      options,
      true,
    )
  }

  async listAllResourceTemplates(options?: McpRequestOptions): Promise<ResourceTemplate[]> {
    return this.withClient(
      async (client, signal) => {
        this.requireResources()
        try {
          return await client.listResourceTemplates({
            ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
            signal,
            timeoutMs: this.timeoutMs,
          })
        } catch (error) {
          if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) {
            return []
          }
          throw error
        }
      },
      options,
      true,
    )
  }

  async readResource(uri: string, options?: McpRequestOptions): Promise<ReadResourceResult> {
    return this.withClient(
      async (client, signal) => {
        this.requireResources()
        return client.readResource(uri, {
          ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
          signal,
          timeoutMs: this.timeoutMs,
        })
      },
      options,
      true,
    )
  }

  private requireResources(): void {
    this.options.assertRequestAllowed?.()
    if (!this.hasResourcesValue) throw new McpOperationError('resources-unavailable')
  }

  private async withClient<T>(
    run: (client: McpClient, signal: AbortSignal) => Promise<T>,
    options: McpRequestOptions | undefined,
    readOnly: boolean,
  ): Promise<T> {
    const combined = options?.signal
      ? AbortSignal.any([options.signal, this.shutdown.signal])
      : this.shutdown.signal
    for (let attempt = 1; ; attempt += 1) {
      if (combined.aborted) throw abortError()
      const client = await this.getClient(combined)
      if (combined.aborted) throw abortError()
      try {
        return await run(client, combined)
      } catch (error) {
        if (combined.aborted || isAbortError(error)) throw abortError()
        if (error instanceof McpOperationError) throw error
        if (isAuthRequired(error)) {
          await this.dropClient(client)
          this.markNeedsAuth()
          throw new McpOperationError('needs-auth')
        }
        if (isSessionExpired(error)) {
          // 会话过期后不重用旧 client；下一次调用会建新会话。
          await this.dropClient(client)
          if (!this.closedValue) this.markDisconnected()
          if (readOnly && attempt === 1) {
            if (!(await wait(READ_RETRY_DELAY_MS, combined))) throw abortError()
            continue
          }
          throw new McpOperationError('session-expired')
        }
        if (readOnly && attempt === 1 && isTransientError(error)) {
          if (!(await wait(READ_RETRY_DELAY_MS, combined))) throw abortError()
          continue
        }
        if (error instanceof McpTimeoutError) throw new McpOperationError('timeout')
        if (error instanceof McpError) throw new McpOperationError('request-failed')
        if (client.connectionState !== 'connected') {
          this.handleClientClose(client)
          throw new McpOperationError('connection-closed')
        }
        throw new McpOperationError('request-failed')
      }
    }
  }

  private async getClient(signal: AbortSignal): Promise<McpClient> {
    if (this.closedValue) throw new McpOperationError('connection-closed')
    if (this.client?.connectionState === 'connected') return this.client
    await abortable(this.open(), signal)
    const client = this.client
    if (client?.connectionState !== 'connected') {
      throw new McpOperationError('connection-closed')
    }
    return client
  }

  private async openInternal(): Promise<void> {
    // open() 只会在没有已连接 client 时走到这里；若还残留已断开的 client，先完整关闭。
    const stale = this.client
    if (stale && stale.connectionState !== 'connected') {
      this.client = undefined
      await this.dropClient(stale)
    }
    if (this.closedValue) throw new McpOperationError('connection-closed')
    this.catalogEpoch += 1
    this.refreshQueuedClient = undefined
    this.stateValue = 'connecting'
    this.errorValue = undefined
    this.notify()

    const retries = 'url' in this.entry.config ? CONNECT_RETRY_DELAYS_MS : []
    for (let attempt = 0; ; attempt += 1) {
      if (this.closedValue) throw new McpOperationError('connection-closed')
      try {
        const result = await this.connectOnce()
        if (result.client.connectionState !== 'connected') {
          await this.closeClient(result.client)
          throw new McpOperationError('connection-closed')
        }
        // 在赋值前做最后一次关闭检查；此后同步赋值，close 会看到当前 client。
        if (this.closedValue) {
          await this.closeClient(result.client)
          throw new McpOperationError('connection-closed')
        }
        this.client = result.client
        this.toolsValue = result.tools
        this.hasResourcesValue = result.hasResources
        this.instructionsValue = result.instructions
        this.catalogRevisionValue += 1
        this.stateValue = 'connected'
        this.errorValue = undefined
        this.notify()
        // 初始 tools/list 期间的变更通知也必须在确认 client 后补刷新。
        if (this.refreshQueuedClient === result.client) {
          this.refreshQueuedClient = undefined
          this.scheduleToolsRefresh(result.client)
        }
        return
      } catch (error) {
        if (this.closedValue) {
          this.stateValue = 'closed'
          this.errorValue = undefined
          this.notify()
          throw new McpOperationError('connection-closed')
        }
        const delay = retries[attempt]
        if (delay !== undefined && isTransientError(error)) {
          const slept = await wait(delay, this.shutdown.signal)
          if (!slept || this.closedValue) {
            this.stateValue = 'closed'
            this.errorValue = undefined
            this.notify()
            throw new McpOperationError('connection-closed')
          }
          continue
        }
        this.failConnect(error)
        if (isAuthRequired(error)) throw new McpOperationError('needs-auth')
        throw new McpOperationError('connect-failed')
      }
    }
  }

  private failConnect(error: unknown): void {
    if (isAuthRequired(error)) {
      this.stateValue = 'needs-auth'
      this.errorValue = connectionError('needs-auth')
    } else {
      this.stateValue = 'failed'
      this.errorValue = connectionError(
        error instanceof McpValueResolutionError ? 'value-resolution-failed' : 'connect-failed',
      )
    }
    this.notify()
  }

  private async connectOnce(): Promise<OpenResult> {
    const authProvider = this.getAuthProvider()?.provider
    const createTransport =
      this.options.createTransport ??
      ((context: McpTransportFactoryContext) => this.createDefaultTransport(context))
    const transport = await createTransport({
      entry: structuredClone(this.entry),
      cwd: this.cwd,
      authProvider,
      signal: this.shutdown.signal,
    })
    if (this.closedValue) {
      await transport.close()
      throw new McpOperationError('connection-closed')
    }

    // SDK 在 connect 失败时会自行 close；transport 层也记忆完整关闭，避免旁路提前结算。
    const originalClose = transport.close.bind(transport)
    let transportClosing: Promise<void> | undefined
    const ownedTransport: McpTransport = {
      start: () => transport.start(),
      send: (message, options) => transport.send(message, options),
      onMessage: (listener) => transport.onMessage(listener),
      onError: (listener) => transport.onError(listener),
      onClose: (listener) => transport.onClose(listener),
      ...(transport.setProtocolVersion
        ? { setProtocolVersion: (version: string) => transport.setProtocolVersion?.(version) }
        : {}),
      close: () => {
        transportClosing ??= Promise.resolve().then(originalClose)
        return transportClosing
      },
    }
    const client = new McpClient({
      name: CLIENT_NAME,
      version: CLIENT_VERSION,
      requestTimeoutMs: this.timeoutMs,
      roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
    })
    // 只转发 MCP 日志通知；不读取/记录请求 body、headers 或 OAuth 数据。
    if (this.options.onLog) {
      const onLog = this.options.onLog
      client.onNotification('notifications/message', (params) => {
        try {
          onLog(this.entry.name, params)
        } catch {
          // 日志接收方异常不影响连接。
        }
      })
    }
    this.clients.add(client)
    // close 可能发生在创建 client 的同一轮事件循环里；立即关闭避免晚到初始化继续。
    if (this.closedValue || this.shutdown.signal.aborted) {
      await this.closeClient(client)
      throw new McpOperationError('connection-closed')
    }

    let closing: Promise<void> | undefined
    const closeClient = () => {
      closing ??= this.closeClient(client)
      return closing
    }
    // 关闭期间调用 client.close()，让 initialize/discovery 立即失败并回收 transport。
    const onAbort = () => {
      void closeClient()
    }
    this.shutdown.signal.addEventListener('abort', onAbort, { once: true })

    try {
      await client.connect(ownedTransport)
      if (this.closedValue) throw new McpOperationError('connection-closed')
      client.onNotification('notifications/tools/list_changed', () => {
        this.scheduleToolsRefresh(client)
      })
      client.onClose(() => {
        this.handleClientClose(client)
      })
      const tools = client.serverCapabilities?.tools
        ? await client.listTools({ signal: this.shutdown.signal })
        : []
      if (this.closedValue) throw new McpOperationError('connection-closed')
      if (client.connectionState !== 'connected') throw new McpOperationError('connection-closed')
      return {
        client,
        tools,
        hasResources: client.serverCapabilities?.resources !== undefined,
        instructions: client.instructions?.trim() || undefined,
      }
    } catch (error) {
      await closeClient()
      throw error
    } finally {
      await transportClosing?.catch(() => undefined)
      this.shutdown.signal.removeEventListener('abort', onAbort)
    }
  }

  private getAuthProvider(): McpAuthProviderHandle | undefined {
    if (!('url' in this.entry.config)) return undefined
    if (this.authHandleCreated) return this.authHandle
    const url = new URL(this.entry.config.url)
    let handle: McpAuthProviderHandle | undefined
    const providerName = this.entry.config.auth?.provider
    const hasAuthorization = Object.keys(this.entry.config.headers ?? {}).some(
      (name) => name.toLowerCase() === 'authorization',
    )
    if (providerName) {
      // provider 凭据逐请求读取；不让 OAuth 工厂接管显式 provider 配置。
      handle = { provider: { token: async () => this.options.providerToken?.(providerName) } }
    } else if (!hasAuthorization && this.options.createAuthProvider) {
      handle = this.options.createAuthProvider({
        entry: structuredClone(this.entry),
        url,
        cwd: this.cwd,
      })
    }
    this.authHandle = handle
    this.authHandleCreated = true
    return this.authHandle
  }

  private async createDefaultTransport(context: McpTransportFactoryContext): Promise<McpTransport> {
    const { config } = this.entry
    const description = `MCP server "${this.entry.name}"`
    if ('url' in config) {
      const headers = await resolveMcpHeaders(config.headers, description, {
        ...(this.options.env ? { env: this.options.env } : {}),
        cwd: this.cwd,
        signal: context.signal,
        ...(this.options.runCommand ? { runCommand: this.options.runCommand } : {}),
      })
      return new StreamableHttpTransport({
        url: config.url,
        ...(headers ? { headers } : {}),
        ...(context.authProvider ? { authProvider: context.authProvider } : {}),
      })
    }
    const env = await resolveMcpEnvValues(config.env, description, {
      ...(this.options.env ? { env: this.options.env } : {}),
      cwd: this.cwd,
      signal: context.signal,
      ...(this.options.runCommand ? { runCommand: this.options.runCommand } : {}),
    })
    return new StdioTransport({
      command: expandMcpHomePath(config.command),
      args: config.args?.map(expandMcpHomePath),
      cwd: resolve(this.cwd, expandMcpHomePath(config.cwd ?? '.')),
      env,
      stderr: 'pipe',
    })
  }

  private scheduleToolsRefresh(client: McpClient): void {
    if (this.closedValue) return
    if (this.client !== client) {
      if (this.opening && this.clients.has(client)) this.refreshQueuedClient = client
      return
    }
    if (this.refreshRunning) {
      // 并发通知合并：当前刷新结束后再跑一次，避免旧结果覆盖新结果。
      // 记录通知所属 client，旧 client 的刷新结束时仍能服务新连接的通知。
      this.refreshQueuedClient = client
      return
    }
    const task = this.runToolsRefresh(client).finally(() => {
      if (this.refreshRunning === task) this.refreshRunning = undefined
      const queuedClient = this.refreshQueuedClient
      this.refreshQueuedClient = undefined
      if (queuedClient && !this.closedValue && this.client === queuedClient) {
        this.scheduleToolsRefresh(queuedClient)
      }
    })
    this.refreshRunning = task
    this.track(task)
  }

  private async runToolsRefresh(client: McpClient): Promise<void> {
    const epoch = this.catalogEpoch
    try {
      const tools = await client.listTools({ signal: this.shutdown.signal })
      if (this.closedValue || this.client !== client || this.catalogEpoch !== epoch) return
      this.toolsValue = tools
      this.catalogRevisionValue += 1
      if (this.errorValue?.code === 'tools-refresh-failed') this.errorValue = undefined
      this.notify()
    } catch (error) {
      if (this.closedValue || this.client !== client || this.catalogEpoch !== epoch) return
      if (isAbortError(error)) return
      if (isAuthRequired(error)) {
        await this.dropClient(client)
        this.markNeedsAuth()
        return
      }
      if (isSessionExpired(error)) {
        await this.dropClient(client)
        this.markDisconnected()
        return
      }
      // 刷新失败后当前工具目录无法确认，撤下工具但保留资源能力与 instructions。
      this.clearTools()
      this.catalogRevisionValue += 1
      this.errorValue = connectionError('tools-refresh-failed')
      this.notify()
    }
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task)
    void task.finally(() => {
      this.tasks.delete(task)
    })
  }

  private handleClientClose(client: McpClient): void {
    if (this.closedValue || this.client !== client) return
    this.client = undefined
    this.stateValue = 'disconnected'
    this.errorValue = connectionError('connection-closed')
    // 对端关闭不等于 transport 的完整回收；下次连接先等它完成。
    void this.dropClient(client)
    this.notify()
  }

  private markNeedsAuth(): void {
    if (this.closedValue) return
    this.stateValue = 'needs-auth'
    this.errorValue = connectionError('needs-auth')
    this.notify()
  }

  private markDisconnected(): void {
    if (this.closedValue) return
    this.stateValue = 'disconnected'
    this.errorValue = connectionError('connection-closed')
    this.notify()
  }

  private async dropClient(client: McpClient): Promise<void> {
    if (this.client === client) this.client = undefined
    const gate = this.closeClient(client)
    this.closeGate = gate
    try {
      await gate
    } finally {
      if (this.closeGate === gate) this.closeGate = undefined
    }
  }

  private closeClient(client: McpClient): Promise<void> {
    let promise = this.clientClosings.get(client)
    if (!promise) {
      // 记忆完整 close promise；官方第二次 client.close() 会提前返回。
      const created = client
        .close()
        .catch(() => undefined)
        .finally(() => {
          this.clients.delete(client)
        })
      promise = created
      this.clientClosings.set(client, created)
      this.closeTasks.add(created)
      void created.finally(() => {
        this.closeTasks.delete(created)
      })
    }
    return promise
  }

  private clearTools(): void {
    this.toolsValue = []
  }

  private clearCatalog(): void {
    this.clearTools()
    this.hasResourcesValue = false
    this.instructionsValue = undefined
  }

  private notify(): void {
    try {
      this.options.onChange?.(this)
    } catch {
      // 监听者异常不影响连接。
    }
  }

  private async closeInternal(): Promise<void> {
    this.closedValue = true
    this.shutdown.abort()
    this.catalogEpoch += 1
    this.refreshQueuedClient = undefined
    this.stateValue = 'closed'
    this.errorValue = undefined
    this.clearCatalog()
    this.catalogRevisionValue += 1
    this.client = undefined
    this.notify()

    // 关闭可能正在进行中的 opening 创建的 client；多轮兜底处理创建/关闭竞态。
    for (let round = 0; round < 4; round += 1) {
      const clients = [...this.clients]
      await Promise.allSettled(clients.map((client) => this.closeClient(client)))
      await this.opening?.catch(() => undefined)
      if (this.clients.size === 0 && this.opening === undefined) break
    }

    // 等待所有已登记的完整 close promise 与后台刷新任务。
    await Promise.allSettled([...this.closeTasks])
    await Promise.allSettled([...this.tasks])
    try {
      await this.authHandle?.settled?.()
    } catch {
      // settled 失败不影响关闭完成。
    }
  }
}
