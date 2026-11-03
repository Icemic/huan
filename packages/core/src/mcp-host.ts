/**
 * 宿主级 MCP 管理 broker（G1.4d3）。
 *
 * 该模块只做协议投影、配置读写协调、临时管理准入与 OAuth 操作生命周期；
 * 不重复解析路径/信任，也不创建第二套连接。宿主通过 adapter 提供：
 * - resolveTarget：复用既有会话/空白路径解析与信任权威；
 * - getLive：当前 live manager、唯一 runtimeId、运行繁忙检查与 idle 结构闸门。
 *
 * 安全边界：
 * - 普通快照与认证快照都不含 URL、env、headers、令牌、回填值或原始异常；
 * - 配置原文只在显式编辑查询返回；
 * - 工具/资源目录只在显式详情查询读取，普通快照不探测；
 * - OAuth 回填值只交给内存 resolver，promptId 原子领取一次；
 * - 取消保持 cancelling 直到真实流程结算，重连在安全 idle 准入内进行。
 */
import {
  createMcpConfigStore,
  type LoadedMcpConfig,
  type McpConfigFileState,
  type McpConfigIssue,
  type McpConfigScope,
  type McpConfigStore,
  type McpConnectionManager,
  type McpOAuthService,
  type McpServerEntry,
  mcpServerIdentity,
} from '@huan/mcp'
import type {
  HarnessMcpAuthCancelResult,
  HarnessMcpAuthFailureCode,
  HarnessMcpAuthOperation,
  HarnessMcpAuthPhase,
  HarnessMcpAuthPrompt,
  HarnessMcpAuthRespondInput,
  HarnessMcpAuthRespondResult,
  HarnessMcpAuthResult,
  HarnessMcpAuthSnapshot,
  HarnessMcpAuthStartInput,
  HarnessMcpAuthStartResult,
  HarnessMcpConfigFile,
  HarnessMcpConfigIssue,
  HarnessMcpConfigSaveInput,
  HarnessMcpConfigSaveResult,
  HarnessMcpConfigSnapshot,
  HarnessMcpConfiguredServer,
  HarnessMcpDetailSection,
  HarnessMcpDetails,
  HarnessMcpDetailsInput,
  HarnessMcpDetailsResult,
  HarnessMcpExposure,
  HarnessMcpManageInput,
  HarnessMcpManageResult,
  HarnessMcpResourceSummary,
  HarnessMcpResourceTemplateSummary,
  HarnessMcpServerAuth,
  HarnessMcpServerState,
  HarnessMcpServerSummary,
  HarnessMcpSnapshot,
  HarnessMcpTarget,
  HarnessMcpTargetInput,
  HarnessMcpToolSummary,
  HarnessMcpTrust,
} from '@huan/protocol'

/** 宿主解析目标后的结果；record 为宿主内部会话对象，broker 不解释其结构。 */
export type McpHostResolvedTarget = {
  target: HarnessMcpTarget
  /** 全局目标为空串；该项目路径不得被读取。 */
  cwd: string
  trust: HarnessMcpTrust
  record?: unknown
  /** 只管理用户配置；不读取项目文件、不提供运行连接。 */
  global?: boolean
}

/** 同步占用 idle 结构闸门的租约；release 必须幂等。 */
export type McpHostIdleLease = {
  release: () => void
}

/** live manager 绑定；busy 为只读检查，acquireIdle 为原子准入。 */
export type McpHostLiveBinding = {
  runtimeId: string
  manager: McpConnectionManager
  busy: boolean
  acquireIdle: () => McpHostIdleLease | undefined
}

/** 宿主 adapter；所有路径/信任/会话身份判断都留在 core host。 */
export type McpHostAdapters = {
  resolveTarget: (input: HarnessMcpTargetInput) => Promise<McpHostResolvedTarget>
  getLive: (record: unknown) => McpHostLiveBinding | undefined
  /** 已打开会话；用于同身份凭据变化后的安全重连，不冷打开会话。 */
  listLive?: () => readonly unknown[]
}

export type McpHostOptions = McpHostAdapters & {
  agentDir: string
  oauth: McpOAuthService
  now?: () => number
  createId?: (prefix: string) => string
}

/** 宿主 MCP broker；所有操作最终由宿主 dispose 统一收尾。 */
export type McpHost = {
  getMcp: (input: HarnessMcpTargetInput) => Promise<HarnessMcpSnapshot>
  getMcpDetails: (input: HarnessMcpDetailsInput) => Promise<HarnessMcpDetailsResult>
  getMcpConfig: (input: HarnessMcpTargetInput) => Promise<HarnessMcpConfigSnapshot>
  saveMcpConfig: (input: HarnessMcpConfigSaveInput) => Promise<HarnessMcpConfigSaveResult>
  manageMcp: (input: HarnessMcpManageInput) => Promise<HarnessMcpManageResult>
  getMcpAuth: () => Promise<HarnessMcpAuthSnapshot>
  startMcpLogin: (input: HarnessMcpAuthStartInput) => Promise<HarnessMcpAuthStartResult>
  respondMcpAuth: (input: HarnessMcpAuthRespondInput) => HarnessMcpAuthRespondResult
  cancelMcpAuth: (operationId: string) => HarnessMcpAuthCancelResult
  logoutMcp: (input: HarnessMcpAuthStartInput) => Promise<HarnessMcpAuthStartResult>
  /** 目标重载/删除/dispose：取消该 runtimeId 下尚未结算的认证操作。 */
  invalidateRuntime: (runtimeId: string) => void
  /** 停止操作表并等待真实流程结算；共享 OAuth/log 由宿主随后关闭。 */
  dispose: () => Promise<void>
}

const MAX_OPERATIONS = 30
const MAX_AUTH_URL_CHARS = 2_048
const MAX_PROMPT_VALUE_CHARS = 8_192
const DETAIL_REQUEST_TIMEOUT_MS = 15_000

type PromptEntry = HarnessMcpAuthPrompt & {
  resolve: (value: string) => void
  reject: (error: Error) => void
  cleanup: () => void
}

type InternalAuthOperation = {
  operation: HarnessMcpAuthOperation
  entry: McpServerEntry
  controller: AbortController
  record?: unknown
  run?: Promise<void>
  settled: boolean
  terminal: boolean
  cancelRequested: boolean
  invalidated: boolean
  prompt?: PromptEntry
}

const abortError = (): Error => {
  const error = new Error('MCP 认证操作已取消')
  error.name = 'AbortError'
  return error
}

const safeUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, MAX_AUTH_URL_CHARS)
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined
  } catch {
    return undefined
  }
}

const isScope = (value: unknown): value is McpConfigScope => value === 'user' || value === 'project'

const isExposure = (value: unknown): value is HarnessMcpExposure =>
  value === 'codemode' || value === 'deferred' || value === 'direct' || value === 'hidden'

const isDetailSection = (value: unknown): value is HarnessMcpDetailSection =>
  value === 'tools' || value === 'resources' || value === 'resource-templates'

const trustViewOf = (trust: HarnessMcpTrust): HarnessMcpTrust => ({ ...trust })

const issueViewOf = (issue: McpConfigIssue): HarnessMcpConfigIssue => ({
  kind: issue.kind,
  scope: issue.scope,
  file: issue.file,
  ...(issue.server ? { server: issue.server } : {}),
  message: issue.message,
})

const fileViewOf = (file: McpConfigFileState): HarnessMcpConfigFile => ({
  scope: file.scope,
  path: file.path,
  readable: file.readable,
  exists: file.exists,
  content: file.content,
  revision: file.revision,
  bytes: file.bytes,
  tooLarge: file.tooLarge,
  issues: file.issues.map(issueViewOf),
  ...(file.readError === undefined ? {} : { readError: file.readError }),
})

/** HTTP 条目无静态 Authorization/provider 时可由 huan OAuth 接管。 */
function authKindOf(entry: McpServerEntry): HarnessMcpServerAuth['kind'] {
  if (!('url' in entry.config)) return 'stdio'
  const headers = entry.config.headers ?? {}
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    return 'static-header'
  }
  if (entry.config.auth?.provider !== undefined) return 'provider'
  return 'oauth'
}

function identityOf(entry: McpServerEntry): string {
  try {
    return mcpServerIdentity(entry)
  } catch {
    return `mcp:${entry.name}:unknown`
  }
}

function configuredServerOf(entry: McpServerEntry): HarnessMcpConfiguredServer {
  return {
    name: entry.name,
    identity: identityOf(entry),
    scope: entry.scope === 'project' ? 'project' : 'user',
    override: entry.override !== undefined,
    enabled: entry.config.enabled !== false,
    exposure: entry.config.exposure ?? 'codemode',
  }
}

function serverStateOfLive(snapshot: { state: string; enabled: boolean }): HarnessMcpServerState {
  if (snapshot.state === 'disabled' || !snapshot.enabled) return 'disabled'
  if (
    snapshot.state === 'connecting' ||
    snapshot.state === 'connected' ||
    snapshot.state === 'disconnected' ||
    snapshot.state === 'needs-auth' ||
    snapshot.state === 'failed' ||
    snapshot.state === 'closed'
  ) {
    return snapshot.state
  }
  return 'disconnected'
}

function resultMessage(code: 'stale' | 'busy' | 'unavailable' | 'failed' | 'invalid'): string {
  switch (code) {
    case 'stale':
      return 'MCP 目标已重载或服务器身份已变化；请刷新后重试。'
    case 'busy':
      return '会话正在运行、发送或结构操作中；MCP 管理/认证暂不可用。'
    case 'unavailable':
      return '该目标没有 live MCP manager；请先打开会话并等待 MCP 初始化。'
    case 'invalid':
      return 'MCP 管理输入无效。'
    case 'failed':
      return 'MCP 操作失败；未显示服务器原始错误。'
  }
}

const emptyAuth = (kind: HarnessMcpServerAuth['kind']): HarnessMcpServerAuth => ({
  kind,
  loginable: kind === 'oauth',
  hasCredentials: false,
  needsRefresh: false,
})

/** 创建宿主级 MCP broker；构造无 I/O、无连接。 */
export function createMcpHost(options: McpHostOptions): McpHost {
  const now = options.now ?? (() => Date.now())
  let idCounter = 0
  const createId =
    options.createId ??
    ((prefix: string) => {
      idCounter += 1
      return `${prefix}:${idCounter}:${Math.random().toString(36).slice(2, 8)}`
    })
  const operations = new Map<string, InternalAuthOperation>()
  const activeByIdentity = new Map<string, InternalAuthOperation>()
  const needsRefreshByRuntime = new Map<string, Set<string>>()
  /** 后台重连任务；dispose 时等待，避免在共享服务关闭后仍写 token/连接。 */
  const reconnectTasks = new Set<Promise<void>>()
  let seq = 0
  let authRevision = 0
  let promptCounter = 0
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const timestamp = (): string => new Date(now()).toISOString()

  const emit = (): void => {
    if (disposed) return
    seq += 1
  }

  const touch = (op: InternalAuthOperation): void => {
    op.operation.updatedAt = timestamp()
  }

  const cloneOperation = (op: InternalAuthOperation): HarnessMcpAuthOperation =>
    structuredClone(op.operation)

  const removeActive = (op: InternalAuthOperation): void => {
    if (activeByIdentity.get(op.operation.identity) === op) {
      activeByIdentity.delete(op.operation.identity)
    }
  }

  const clearNeedsRefresh = (runtimeId: string, server: string): void => {
    const set = needsRefreshByRuntime.get(runtimeId)
    if (!set) return
    set.delete(server)
    if (set.size === 0) needsRefreshByRuntime.delete(runtimeId)
  }

  const markNeedsRefresh = (runtimeId: string, server: string): void => {
    let set = needsRefreshByRuntime.get(runtimeId)
    if (!set) {
      set = new Set()
      needsRefreshByRuntime.set(runtimeId, set)
    }
    set.add(server)
  }

  const needsRefreshFor = (runtimeId: string, server: string): boolean =>
    needsRefreshByRuntime.get(runtimeId)?.has(server) === true

  const rejectPrompt = (op: InternalAuthOperation): void => {
    const prompt = op.prompt
    if (!prompt) return
    op.prompt = undefined
    delete op.operation.prompt
    prompt.cleanup()
    try {
      prompt.reject(abortError())
    } catch {
      // resolver 已结算时忽略。
    }
    if (!op.terminal && op.operation.phase === 'prompt') op.operation.phase = 'waiting'
    touch(op)
  }

  const settle = (
    op: InternalAuthOperation,
    phase: Extract<HarnessMcpAuthPhase, 'succeeded' | 'failed' | 'cancelled'>,
    result: HarnessMcpAuthResult,
  ): void => {
    if (op.terminal) return
    rejectPrompt(op)
    op.terminal = true
    op.operation.phase = phase
    op.operation.result = result
    delete op.operation.prompt
    touch(op)
    if (op.settled) removeActive(op)
    emit()
  }

  const reconnectAfterLogin = (op: InternalAuthOperation): HarnessMcpAuthResult['reconnect'] => {
    try {
      if (op.invalidated) return 'not-live'
      const records = options.listLive?.() ?? (op.record ? [op.record] : [])
      let outcome: HarnessMcpAuthResult['reconnect'] = 'not-live'
      for (const record of records) {
        const live = options.getLive(record)
        if (!live || live.manager.snapshot().closed) continue
        if (record === op.record && live.runtimeId !== op.operation.runtimeId) continue
        let entry: McpServerEntry
        try {
          entry = live.manager.getServerEntry(op.operation.server)
        } catch {
          continue
        }
        if (identityOf(entry) !== op.operation.identity || entry.config.enabled === false) continue
        if (live.busy) {
          markNeedsRefresh(live.runtimeId, op.operation.server)
          outcome = 'deferred'
          continue
        }
        const lease = live.acquireIdle()
        if (!lease) {
          markNeedsRefresh(live.runtimeId, op.operation.server)
          outcome = 'deferred'
          continue
        }
        // 先完成认证终态，再在 idle 闸门内后台重连；不阻塞用户看到登录结果。
        const runtimeId = live.runtimeId
        const server = op.operation.server
        const task = (async () => {
          try {
            await live.manager.reconnect(server)
            clearNeedsRefresh(runtimeId, server)
          } catch {
            markNeedsRefresh(runtimeId, server)
          } finally {
            lease.release()
          }
        })()
        reconnectTasks.add(task)
        void task.finally(() => {
          reconnectTasks.delete(task)
        })
        if (outcome !== 'deferred') outcome = 'started'
      }
      return outcome
    } catch {
      // 管理/宿主 adapter 异常不能阻止认证终态；凭据已经保存。
      return 'not-live'
    }
  }

  const finishSuccess = (op: InternalAuthOperation): void => {
    op.settled = true
    removeActive(op)
    if (disposed) {
      settle(op, 'cancelled', {
        status: 'cancelled',
        code: 'cancelled',
        message: '宿主已停止；认证结果未再用于连接。',
      })
      return
    }
    authRevision += 1
    if (op.operation.kind === 'login') {
      const reconnect = reconnectAfterLogin(op)
      settle(op, 'succeeded', {
        status: 'succeeded',
        message:
          reconnect === 'deferred'
            ? '登录成功，凭据已保存；会话正忙，未强制重连，下一次连接会使用新令牌。'
            : reconnect === 'not-live'
              ? '登录成功，凭据已保存；原 live 目标已失效，未自动重连。'
              : '登录成功，凭据已保存；正在重新连接该 MCP 服务器。',
        ...(reconnect ? { reconnect } : {}),
      })
      return
    }
    settle(op, 'succeeded', {
      status: 'succeeded',
      message: '已退出 MCP 登录，已存 OAuth 凭据已移除。',
    })
  }

  const failureCodeOf = (error: unknown): HarnessMcpAuthFailureCode => {
    const code = (error as { code?: unknown } | undefined)?.code
    if (code === 'storage') return 'storage-failed'
    if (code === 'not-oauth') return 'unsupported'
    return 'login-failed'
  }

  const finishFailure = (op: InternalAuthOperation, error: unknown): void => {
    op.settled = true
    removeActive(op)
    if (disposed || op.invalidated || op.cancelRequested || op.controller.signal.aborted) {
      settle(op, 'cancelled', {
        status: 'cancelled',
        code: 'cancelled',
        message: op.invalidated
          ? 'MCP 目标已重载或关闭，原认证操作已失效。'
          : 'MCP 登录已取消；若认证流程在取消前已提交，凭据可能已保存。',
      })
      return
    }
    const code = op.operation.kind === 'login' ? failureCodeOf(error) : 'logout-failed'
    settle(op, 'failed', {
      status: 'failed',
      code,
      message:
        code === 'storage-failed'
          ? 'MCP 凭据文件无法安全读写；请检查文件权限后重试。'
          : op.operation.kind === 'login'
            ? 'MCP 登录失败；未显示 OAuth 服务器原始错误。'
            : 'MCP 退出登录失败；未显示凭据存储原始错误。',
      retryable: code !== 'unsupported',
    })
  }

  const attachRun = (op: InternalAuthOperation, run: Promise<void>): void => {
    op.run = run
    void run.then(
      () => finishSuccess(op),
      (error: unknown) => finishFailure(op, error),
    )
  }

  const finalizeCancelled = async (op: InternalAuthOperation): Promise<void> => {
    const run = op.run
    if (!run) {
      op.settled = true
      settle(op, 'cancelled', {
        status: 'cancelled',
        code: 'cancelled',
        message: 'MCP 操作已取消。',
      })
      return
    }
    // 必须等真实流程结算；旧刷新/退出晚到的成功不能被取消覆盖。
    await run.then(
      () => undefined,
      () => undefined,
    )
    if (op.terminal) return
    settle(op, 'cancelled', {
      status: 'cancelled',
      code: 'cancelled',
      message: op.invalidated
        ? 'MCP 目标已重载或关闭，原认证操作已失效。'
        : 'MCP 登录已取消；若认证流程在取消前已提交，凭据可能已保存。',
    })
  }

  const requestPrompt = (op: InternalAuthOperation, signal: AbortSignal): Promise<string> => {
    if (op.terminal || disposed) return Promise.reject(abortError())
    if (signal.aborted) return Promise.reject(abortError())
    promptCounter += 1
    const prompt: HarnessMcpAuthPrompt = {
      promptId: `${createId('mcp-prompt')}:${promptCounter}`,
      kind: 'redirect_url',
      message: '请粘贴浏览器地址栏中的完整回调 URL（包含 code 与 state）。',
      placeholder: 'http://127.0.0.1:<port>/callback?code=…&state=…',
    }
    rejectPrompt(op)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
      }
      const finishResolve = (value: string) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const finishReject = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = () => {
        if (op.prompt?.promptId !== prompt.promptId) return
        op.prompt = undefined
        delete op.operation.prompt
        if (!op.terminal && op.operation.phase === 'prompt') op.operation.phase = 'waiting'
        touch(op)
        emit()
        finishReject(abortError())
      }
      op.prompt = { ...prompt, resolve: finishResolve, reject: finishReject, cleanup }
      op.operation.prompt = { ...prompt }
      op.operation.phase = 'prompt'
      touch(op)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      else emit()
    })
  }

  const beginAuth = async (
    kind: 'login' | 'logout',
    input: HarnessMcpAuthStartInput,
  ): Promise<HarnessMcpAuthStartResult> => {
    if (disposed) return { status: 'unavailable', message: '宿主已停止。' }
    if (input.target.global === true) {
      return { status: 'unavailable', message: '全局 MCP 配置不提供运行连接。' }
    }
    if (typeof input.server !== 'string' || !input.server.trim()) {
      return { status: 'invalid', message: 'MCP 服务器名无效。' }
    }
    if (
      typeof input.expectedRuntimeId !== 'string' ||
      !input.expectedRuntimeId ||
      typeof input.expectedIdentity !== 'string' ||
      !input.expectedIdentity
    ) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    const resolved = await options.resolveTarget(input.target)
    if (disposed) return { status: 'unavailable', message: '宿主已停止。' }
    if (!resolved.record) {
      return { status: 'unavailable', message: resultMessage('unavailable') }
    }
    const live = options.getLive(resolved.record)
    if (!live) return { status: 'unavailable', message: resultMessage('unavailable') }
    if (live.runtimeId !== input.expectedRuntimeId) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    let entry: McpServerEntry
    try {
      entry = live.manager.getServerEntry(input.server)
    } catch {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (live.manager.snapshot().closed) {
      return { status: 'unavailable', message: resultMessage('unavailable') }
    }
    const identity = identityOf(entry)
    if (identity !== input.expectedIdentity) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    const active = activeByIdentity.get(identity)
    if (active) {
      return { status: 'busy', operation: cloneOperation(active) }
    }
    if (kind === 'login' && authKindOf(entry) !== 'oauth') {
      return {
        status: 'invalid',
        message:
          authKindOf(entry) === 'stdio'
            ? 'stdio MCP 服务器不使用 OAuth，无法交互登录。'
            : authKindOf(entry) === 'provider'
              ? '该服务器使用宿主 provider 凭据，不能通过 MCP OAuth 登录。'
              : '该服务器使用静态 Authorization 头，不能通过 MCP OAuth 登录。',
      }
    }
    if (live.busy) {
      return { status: 'busy', message: resultMessage('busy') }
    }
    if (kind === 'logout') {
      const hasCredentials = await options.oauth.hasCredentials(entry).catch(() => false)
      if (disposed) return { status: 'unavailable', message: '宿主已停止。' }
      if (!hasCredentials) {
        return { status: 'invalid', message: '该 MCP 服务器没有已存 OAuth 凭据可退出。' }
      }
      // 读凭据期间另一窗口可能启动操作、重载或开始运行，必须重查准入。
      const current = options.getLive(resolved.record)
      if (
        !current ||
        current.runtimeId !== live.runtimeId ||
        identityOf(current.manager.getServerEntry(input.server)) !== identity
      ) {
        return { status: 'stale', message: resultMessage('stale') }
      }
      const concurrent = activeByIdentity.get(identity)
      if (concurrent) return { status: 'busy', operation: cloneOperation(concurrent) }
      if (current.busy) return { status: 'busy', message: resultMessage('busy') }
    }

    // 同一 identity 只保留最近一次已结算操作；总操作数有界。
    for (const [id, existing] of operations) {
      if (existing.terminal && existing.settled && existing.operation.identity === identity) {
        operations.delete(id)
      }
    }
    while (operations.size >= MAX_OPERATIONS) {
      const oldestTerminal = [...operations.values()].find(
        (existing) => existing.terminal && existing.settled,
      )
      if (!oldestTerminal) break
      operations.delete(oldestTerminal.operation.id)
    }
    if (operations.size >= MAX_OPERATIONS) {
      return {
        status: 'invalid',
        message: 'MCP 认证操作过多，请等待现有操作结束后重试。',
      }
    }

    const startedAt = timestamp()
    const operation: HarnessMcpAuthOperation = {
      id: createId(kind === 'login' ? 'mcp-login' : 'mcp-logout'),
      server: entry.name,
      identity,
      kind,
      phase: 'starting',
      target: structuredClone(resolved.target),
      runtimeId: live.runtimeId,
      startedAt,
      updatedAt: startedAt,
    }
    const controller = new AbortController()
    const op: InternalAuthOperation = {
      operation,
      entry,
      controller,
      ...(resolved.record ? { record: resolved.record } : {}),
      settled: false,
      terminal: false,
      cancelRequested: false,
      invalidated: false,
    }
    operations.set(operation.id, op)
    activeByIdentity.set(identity, op)
    emit()

    operation.phase = 'waiting'
    touch(op)
    emit()

    if (kind === 'login') {
      const run = options.oauth.login(entry, {
        cwd: resolved.cwd,
        signal: controller.signal,
        showAuthorizationUrl: (url) => {
          if (op.terminal || op.cancelRequested) return
          const safe = safeUrl(url.href)
          if (safe) op.operation.authUrl = safe
          op.operation.phase = 'waiting'
          touch(op)
          emit()
        },
        promptForRedirectUrl: (signal) => {
          // 服务端会把宿主关闭信号与操作信号合并后传入。
          return requestPrompt(op, signal)
        },
      })
      attachRun(op, run)
    } else {
      const run = options.oauth.logout(entry).then(() => undefined)
      attachRun(op, run)
    }

    return { status: 'started', operation: cloneOperation(op) }
  }

  const authSnapshotOf = (): HarnessMcpAuthSnapshot =>
    structuredClone({
      seq,
      authRevision,
      operations: [...operations.values()].map((op) => op.operation),
    })

  const hasCredentialsFor = async (entry: McpServerEntry): Promise<boolean> => {
    if (authKindOf(entry) !== 'oauth') return false
    return options.oauth.hasCredentials(entry).catch(() => false)
  }

  const serverAuthOf = async (
    entry: McpServerEntry,
    runtimeId: string | undefined,
  ): Promise<HarnessMcpServerAuth> => {
    const kind = authKindOf(entry)
    if (kind !== 'oauth') return emptyAuth(kind)
    return {
      kind,
      loginable: true,
      hasCredentials: await hasCredentialsFor(entry),
      needsRefresh: runtimeId !== undefined && needsRefreshFor(runtimeId, entry.name),
    }
  }

  const serverSummaryFromLive = async (
    manager: McpConnectionManager,
    runtimeId: string,
    server: {
      name: string
      scope: 'user' | 'project' | 'extension'
      override?: string
      enabled: boolean
      exposure: HarnessMcpExposure
      state: string
      toolCount: number
      hasResources: boolean
      toolRevision: number
      error?: { code: string; message: string }
    },
  ): Promise<HarnessMcpServerSummary> => {
    let entry: McpServerEntry | undefined
    try {
      entry = manager.getServerEntry(server.name)
    } catch {
      entry = undefined
    }
    const auth = entry ? await serverAuthOf(entry, runtimeId) : emptyAuth('stdio')
    return {
      name: server.name,
      identity: entry ? identityOf(entry) : `mcp:${server.name}:unknown`,
      scope: server.scope,
      override: server.override !== undefined,
      enabled: server.enabled,
      exposure: server.exposure,
      state: serverStateOfLive(server),
      toolCount: server.toolCount,
      hasResources: server.hasResources,
      toolRevision: server.toolRevision,
      auth,
      ...(server.error
        ? { error: { code: server.error.code, message: server.error.message } }
        : {}),
    }
  }

  const snapshotFromLive = async (
    resolved: McpHostResolvedTarget,
    live: McpHostLiveBinding,
  ): Promise<HarnessMcpSnapshot> => {
    const manager = live.manager
    const managerSnapshot = manager.snapshot()
    const servers = await Promise.all(
      managerSnapshot.servers.map((server) =>
        serverSummaryFromLive(manager, live.runtimeId, server),
      ),
    )
    return {
      target: structuredClone(resolved.target),
      live: true,
      runtime: {
        runtimeId: live.runtimeId,
        revision: managerSnapshot.revision,
        started: managerSnapshot.started,
        closed: managerSnapshot.closed,
      },
      projectTrusted: resolved.trust.decision === 'trusted',
      trust: trustViewOf(resolved.trust),
      servers,
    }
  }

  const configStoreFor = (resolved: McpHostResolvedTarget): McpConfigStore =>
    resolved.global === true
      ? createMcpConfigStore({ agentDir: options.agentDir, userOnly: true })
      : createMcpConfigStore({ agentDir: options.agentDir, cwd: resolved.cwd })

  const configSnapshotOf = async (
    resolved: McpHostResolvedTarget,
  ): Promise<HarnessMcpConfigSnapshot> => {
    const store = configStoreFor(resolved)
    const projectTrusted = resolved.trust.decision === 'trusted'
    const [user, project] = await Promise.all([
      store.read('user'),
      store.read('project', { projectTrusted }),
    ])
    const loaded = await store.load({ projectTrusted })
    return {
      target: structuredClone(resolved.target),
      projectTrusted,
      trust: trustViewOf(resolved.trust),
      files: { user: fileViewOf(user), project: fileViewOf(project) },
      effective: {
        ...(loaded.autoEnableCodemode === undefined
          ? {}
          : { autoEnableCodemode: loaded.autoEnableCodemode }),
        servers: loaded.servers.map(configuredServerOf),
        issues: loaded.issues.map(issueViewOf),
      },
    }
  }

  const coldServerSummary = async (entry: McpServerEntry): Promise<HarnessMcpServerSummary> => {
    const auth = await serverAuthOf(entry, undefined)
    return {
      name: entry.name,
      identity: identityOf(entry),
      scope: entry.scope,
      override: entry.override !== undefined,
      enabled: entry.config.enabled !== false,
      exposure: entry.config.exposure ?? 'codemode',
      state: entry.config.enabled === false ? 'disabled' : 'not-connected',
      toolCount: 0,
      hasResources: false,
      toolRevision: 0,
      auth,
    }
  }

  const snapshotFromConfig = async (
    resolved: McpHostResolvedTarget,
  ): Promise<HarnessMcpSnapshot> => {
    const store = configStoreFor(resolved)
    const projectTrusted = resolved.trust.decision === 'trusted'
    const loaded: LoadedMcpConfig = await store.load({ projectTrusted })
    return {
      target: structuredClone(resolved.target),
      live: resolved.record !== undefined,
      projectTrusted,
      trust: trustViewOf(resolved.trust),
      servers: await Promise.all(loaded.servers.map(coldServerSummary)),
      issues: loaded.issues.map(issueViewOf),
    }
  }

  const snapshotOfResolved = async (
    resolved: McpHostResolvedTarget,
  ): Promise<HarnessMcpSnapshot> => {
    const live = resolved.record ? options.getLive(resolved.record) : undefined
    if (live) return snapshotFromLive(resolved, live)
    return snapshotFromConfig(resolved)
  }

  const toolSummaryOf = (
    tool: ReturnType<McpConnectionManager['getToolCatalog']>['tools'][number],
  ): HarnessMcpToolSummary => ({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: structuredClone(tool.outputSchema) }),
    ...(tool.annotations === undefined ? {} : { annotations: structuredClone(tool.annotations) }),
    ...(tool.execution === undefined ? {} : { execution: structuredClone(tool.execution) }),
    ...(tool._meta === undefined ? {} : { _meta: structuredClone(tool._meta) }),
    exposure: tool.exposure,
  })

  const resourceSummaryOf = (resource: {
    uri: string
    name: string
    title?: string
    description?: string
    mimeType?: string
    size?: number
    annotations?: {
      audience?: ('user' | 'assistant')[]
      priority?: number
      lastModified?: string
    }
    _meta?: Record<string, unknown>
  }): HarnessMcpResourceSummary => ({
    uri: resource.uri,
    name: resource.name,
    ...(resource.title === undefined ? {} : { title: resource.title }),
    ...(resource.description === undefined ? {} : { description: resource.description }),
    ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
    ...(resource.size === undefined ? {} : { size: resource.size }),
    ...(resource.annotations === undefined
      ? {}
      : { annotations: structuredClone(resource.annotations) }),
    ...(resource._meta === undefined ? {} : { _meta: structuredClone(resource._meta) }),
  })

  const templateSummaryOf = (template: {
    uriTemplate: string
    name: string
    title?: string
    description?: string
    mimeType?: string
    annotations?: {
      audience?: ('user' | 'assistant')[]
      priority?: number
      lastModified?: string
    }
    _meta?: Record<string, unknown>
  }): HarnessMcpResourceTemplateSummary => ({
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(template.title === undefined ? {} : { title: template.title }),
    ...(template.description === undefined ? {} : { description: template.description }),
    ...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
    ...(template.annotations === undefined
      ? {}
      : { annotations: structuredClone(template.annotations) }),
    ...(template._meta === undefined ? {} : { _meta: structuredClone(template._meta) }),
  })

  const getMcpDetails = async (input: HarnessMcpDetailsInput): Promise<HarnessMcpDetailsResult> => {
    if (disposed) return { status: 'unavailable', message: '宿主已停止。' }
    if (input.target.global === true) {
      return { status: 'unavailable', message: '全局 MCP 配置不提供运行连接。' }
    }
    if (typeof input.server !== 'string' || !input.server.trim()) {
      return { status: 'invalid', message: 'MCP 服务器名无效。' }
    }
    if (typeof input.expectedRuntimeId !== 'string' || !input.expectedRuntimeId) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (!Array.isArray(input.include) || input.include.length === 0) {
      return { status: 'invalid', message: '详情查询必须显式指定要读取的目录。' }
    }
    const include = [...new Set(input.include)]
    if (!include.every(isDetailSection)) {
      return { status: 'invalid', message: '详情查询包含未知目录。' }
    }
    const resolved = await options.resolveTarget(input.target)
    if (!resolved.record) return { status: 'unavailable', message: resultMessage('unavailable') }
    const live = options.getLive(resolved.record)
    if (!live) return { status: 'unavailable', message: resultMessage('unavailable') }
    if (live.runtimeId !== input.expectedRuntimeId) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (live.manager.snapshot().closed) {
      return { status: 'unavailable', message: resultMessage('unavailable') }
    }
    let entry: McpServerEntry
    try {
      entry = live.manager.getServerEntry(input.server)
    } catch {
      return { status: 'stale', message: resultMessage('stale') }
    }
    const liveServer = live.manager.snapshot().servers.find((server) => server.name === entry.name)
    if (!liveServer) return { status: 'stale', message: resultMessage('stale') }

    const details: HarnessMcpDetails = {
      target: structuredClone(resolved.target),
      runtimeId: live.runtimeId,
      server: {
        name: entry.name,
        identity: identityOf(entry),
        state: serverStateOfLive(liveServer),
        exposure: liveServer.exposure,
        toolRevision: liveServer.toolRevision,
      },
    }

    if (include.includes('tools')) {
      const catalog = live.manager.getToolCatalog(entry.name)
      details.tools = catalog.tools.map(toolSummaryOf)
      if (catalog.instructions !== undefined) details.instructions = catalog.instructions
    }

    const signal = AbortSignal.timeout(DETAIL_REQUEST_TIMEOUT_MS)
    try {
      if (include.includes('resources')) {
        const resources = await live.manager.listAllResources(entry.name, { signal })
        details.resources = resources.map(resourceSummaryOf)
      }
      if (include.includes('resource-templates')) {
        const templates = await live.manager.listAllResourceTemplates(entry.name, { signal })
        details.resourceTemplates = templates.map(templateSummaryOf)
      }
    } catch {
      return { status: 'failed', message: '读取 MCP 资源目录失败；未显示服务器原始错误。' }
    }

    const current = options.getLive(resolved.record)
    if (
      !current ||
      current.runtimeId !== live.runtimeId ||
      identityOf(current.manager.getServerEntry(entry.name)) !== identityOf(entry)
    ) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    return { status: 'ok', details }
  }

  const manageMcp = async (input: HarnessMcpManageInput): Promise<HarnessMcpManageResult> => {
    if (disposed) return { status: 'unavailable', message: '宿主已停止。' }
    if (input.target.global === true) {
      return { status: 'unavailable', message: '全局 MCP 配置不提供运行连接。' }
    }
    if (typeof input.server !== 'string' || !input.server.trim()) {
      return { status: 'invalid', message: 'MCP 服务器名无效。' }
    }
    if (
      typeof input.expectedRuntimeId !== 'string' ||
      !input.expectedRuntimeId ||
      typeof input.expectedIdentity !== 'string' ||
      !input.expectedIdentity
    ) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (!input.action || typeof input.action !== 'object') {
      return { status: 'invalid', message: resultMessage('invalid') }
    }
    if (
      input.action.type !== 'setEnabled' &&
      input.action.type !== 'setExposure' &&
      input.action.type !== 'setToolExposure' &&
      input.action.type !== 'reconnect'
    ) {
      return { status: 'invalid', message: resultMessage('invalid') }
    }
    if (input.action.type === 'setEnabled' && typeof input.action.enabled !== 'boolean') {
      return { status: 'invalid', message: resultMessage('invalid') }
    }
    if (
      (input.action.type === 'setExposure' || input.action.type === 'setToolExposure') &&
      !isExposure(input.action.exposure) &&
      !(input.action.type === 'setToolExposure' && input.action.exposure === null)
    ) {
      return { status: 'invalid', message: resultMessage('invalid') }
    }
    if (
      input.action.type === 'setToolExposure' &&
      (typeof input.action.tool !== 'string' || !input.action.tool)
    ) {
      return { status: 'invalid', message: resultMessage('invalid') }
    }

    const resolved = await options.resolveTarget(input.target)
    if (!resolved.record) return { status: 'unavailable', message: resultMessage('unavailable') }
    const live = options.getLive(resolved.record)
    if (!live) return { status: 'unavailable', message: resultMessage('unavailable') }
    if (live.runtimeId !== input.expectedRuntimeId) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (live.manager.snapshot().closed) {
      return { status: 'unavailable', message: resultMessage('unavailable') }
    }
    let entry: McpServerEntry
    try {
      entry = live.manager.getServerEntry(input.server)
    } catch {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (identityOf(entry) !== input.expectedIdentity) {
      return { status: 'stale', message: resultMessage('stale') }
    }
    if (live.busy) return { status: 'busy', message: resultMessage('busy') }
    const lease = live.acquireIdle()
    if (!lease) return { status: 'busy', message: resultMessage('busy') }
    try {
      // 准入内再次确认未发生替换；结构闸门阻止同会话 reload/发送。
      const currentEntry = live.manager.getServerEntry(input.server)
      if (identityOf(currentEntry) !== input.expectedIdentity) {
        return { status: 'stale', message: resultMessage('stale') }
      }
      switch (input.action.type) {
        case 'setEnabled':
          await live.manager.setEnabled(input.server, input.action.enabled)
          clearNeedsRefresh(live.runtimeId, input.server)
          break
        case 'setExposure':
          live.manager.setExposure(input.server, input.action.exposure)
          break
        case 'setToolExposure':
          live.manager.setToolExposure(
            input.server,
            input.action.tool,
            input.action.exposure === null ? undefined : input.action.exposure,
          )
          break
        case 'reconnect':
          await live.manager.reconnect(input.server)
          clearNeedsRefresh(live.runtimeId, input.server)
          break
      }
      const current = options.getLive(resolved.record)
      if (!current || current.runtimeId !== live.runtimeId) {
        return { status: 'stale', message: resultMessage('stale') }
      }
      return { status: 'applied', snapshot: await snapshotFromLive(resolved, current) }
    } catch {
      return { status: 'failed', message: 'MCP 管理操作失败；未显示连接原始错误。' }
    } finally {
      lease.release()
    }
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise
    disposed = true
    const runs: Promise<unknown>[] = []
    for (const op of operations.values()) {
      op.cancelRequested = true
      op.invalidated = true
      op.controller.abort()
      rejectPrompt(op)
      if (op.run) runs.push(op.run.catch(() => undefined))
      if (op.operation.phase !== 'prompt') op.operation.phase = 'cancelling'
      touch(op)
    }
    disposePromise = (async () => {
      await Promise.allSettled([...runs, ...reconnectTasks])
      operations.clear()
      activeByIdentity.clear()
      needsRefreshByRuntime.clear()
    })()
    return disposePromise
  }

  return {
    async getMcp(input) {
      if (disposed) throw new Error('MCP host is disposed')
      if (input.global === true) throw new Error('全局 MCP 配置不提供运行连接')
      const resolved = await options.resolveTarget(input)
      return snapshotOfResolved(resolved)
    },
    getMcpDetails,
    async getMcpConfig(input) {
      if (disposed) throw new Error('MCP host is disposed')
      const resolved = await options.resolveTarget(input)
      return configSnapshotOf(resolved)
    },
    async saveMcpConfig(input) {
      if (disposed) {
        return {
          status: 'failed',
          scope: input.scope,
          path: '',
          message: '宿主已停止，无法保存 MCP 配置。',
        }
      }
      if (!isScope(input.scope)) {
        return {
          status: 'failed',
          scope: 'user',
          path: '',
          message: 'MCP 配置 scope 无效。',
        }
      }
      if (input.target.global === true && input.scope !== 'user') {
        return {
          status: 'failed',
          scope: input.scope,
          path: '',
          message: '全局 MCP 配置只能写入用户配置；项目配置需要明确项目目标。',
        }
      }
      const resolved = await options.resolveTarget(input.target)
      const store = configStoreFor(resolved)
      const result = await store.save({
        scope: input.scope,
        content: input.content,
        expectedRevision: input.expectedRevision,
        projectTrusted: resolved.trust.decision === 'trusted',
      })
      if (result.status === 'saved') {
        return {
          status: 'saved',
          scope: result.scope,
          path: result.path,
          revision: result.revision,
          bytes: result.bytes,
          snapshot: await configSnapshotOf(resolved),
          apply: {
            persisted: true,
            reloadRequired: true,
            message: 'MCP 配置已保存到共享文件；需要显式重载资源后 live 会话才会使用新配置。',
          },
        }
      }
      if (result.status === 'conflict') {
        return {
          status: 'conflict',
          scope: result.scope,
          path: result.path,
          revision: result.revision,
          message: result.message,
        }
      }
      if (result.status === 'invalid') {
        return {
          status: 'invalid',
          scope: result.scope,
          path: result.path,
          issues: result.issues.map(issueViewOf),
          message: result.message,
        }
      }
      if (result.status === 'too-large') {
        return {
          status: 'too-large',
          scope: result.scope,
          path: result.path,
          limitBytes: result.limitBytes,
          message: result.message,
        }
      }
      if (result.status === 'untrusted') {
        return {
          status: 'untrusted',
          scope: result.scope,
          path: result.path,
          message: result.message,
        }
      }
      return {
        status: 'failed',
        scope: result.scope,
        path: result.path,
        message: result.message,
      }
    },
    manageMcp,
    async getMcpAuth() {
      if (disposed) throw new Error('MCP host is disposed')
      return authSnapshotOf()
    },
    startMcpLogin(input) {
      return beginAuth('login', input)
    },
    logoutMcp(input) {
      return beginAuth('logout', input)
    },
    respondMcpAuth(input) {
      if (disposed) return { status: 'stale' }
      if (
        typeof input.operationId !== 'string' ||
        typeof input.promptId !== 'string' ||
        typeof input.value !== 'string'
      ) {
        return { status: 'invalid', message: '回填参数无效。' }
      }
      if (input.value.length > MAX_PROMPT_VALUE_CHARS) {
        return { status: 'invalid', message: '回填内容过长。' }
      }
      const op = operations.get(input.operationId)
      if (!op || op.terminal || op.operation.phase !== 'prompt') return { status: 'stale' }
      const prompt = op.prompt
      if (!prompt || prompt.promptId !== input.promptId) return { status: 'stale' }
      // 先原子移出快照，再交付 resolver；值不保留在 broker 状态中。
      op.prompt = undefined
      delete op.operation.prompt
      op.operation.phase = 'verifying'
      touch(op)
      emit()
      prompt.resolve(input.value)
      return { status: 'accepted' }
    },
    cancelMcpAuth(operationId) {
      if (disposed) return { status: 'not-found' }
      const op = operations.get(operationId)
      if (!op) return { status: 'not-found' }
      if (op.terminal) return { status: 'finished', operation: cloneOperation(op) }
      if (!op.cancelRequested) {
        op.cancelRequested = true
        op.operation.phase = 'cancelling'
        touch(op)
        rejectPrompt(op)
        op.controller.abort()
        emit()
        void finalizeCancelled(op)
      }
      return { status: 'cancelling', operation: cloneOperation(op) }
    },
    invalidateRuntime(runtimeId) {
      if (typeof runtimeId !== 'string' || !runtimeId) return
      needsRefreshByRuntime.delete(runtimeId)
      for (const op of operations.values()) {
        if (op.terminal || op.operation.runtimeId !== runtimeId) continue
        op.invalidated = true
        op.cancelRequested = true
        op.operation.phase = 'cancelling'
        touch(op)
        rejectPrompt(op)
        op.controller.abort()
        emit()
        void finalizeCancelled(op)
      }
    },
    dispose,
  }
}
