/**
 * 模型认证 broker（G1.4c）。
 *
 * 为什么单独成模块：认证流程包含用户回填、授权回调、取消与凭据持久化提交点
 * 竞态，不能借助普通 Host UI 通道（那条通道面向扩展，且请求会进入线程快照）。
 * 本模块只把安全投影写入认证快照：
 * - provider 原始错误与 prompt 回填值不进入快照/事件；
 * - 授权链接只接受 http(s)；
 * - 回填值提交后立即从 Resolver 移除，后续重复/过期请求返回 stale。
 *
 * 取消语义：取消先 abort 并把阶段置为 cancelling，然后等待 SDK 结算。
 * 若 SDK 以成功或 CredentialSynchronizationError 结算（说明凭据可能已经
 * 提交），终态以 SDK 结果为准，不把已保存的凭据误标为“取消丢失”。
 */
import { CredentialSynchronizationError, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
  HarnessProviderAuthCancelResult,
  HarnessProviderAuthEvent,
  HarnessProviderAuthMethod,
  HarnessProviderAuthOperation,
  HarnessProviderAuthOperationKind,
  HarnessProviderAuthPrompt,
  HarnessProviderAuthProvider,
  HarnessProviderAuthRespondResult,
  HarnessProviderAuthResult,
  HarnessProviderAuthSnapshot,
  HarnessProviderAuthSource,
  HarnessProviderAuthStartResult,
  HarnessProviderAuthStreamEvent,
} from '@huan/protocol'

/** 登录交互类型直接从公开 login 参数推导，不深导入 SDK 私有模块。 */
type AuthInteraction = Parameters<ModelRuntime['login']>[2]
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0]
type AuthNotification = Parameters<AuthInteraction['notify']>[0]
type CredentialInfo = Awaited<ReturnType<ModelRuntime['listCredentials']>>[number]
type AuthStatus = ReturnType<ModelRuntime['getProviderAuthStatus']>

/**
 * broker 只依赖公开的 ModelRuntime 方法；真实实例与测试替身都按此结构注入。
 */
export type ProviderAuthRuntime = Pick<
  ModelRuntime,
  'getProviders' | 'listCredentials' | 'getProviderAuthStatus' | 'login' | 'logout'
>

export type ProviderAuthBrokerOptions = {
  runtime: ProviderAuthRuntime
  /**
   * 凭据状态变化后的本地刷新钩子（宿主用于刷新模型可用性并广播版本）。
   * 不在此处发起联网请求；错误被吞掉，不影响认证终态。
   */
  onAvailabilityChanged?: (providerId: string) => void | Promise<void>
  /** 取消后等待 SDK 结算的宽限期；超时按“取消结果未确认”处理。 */
  cancelGraceMs?: number
  /** 宿主销毁时等待在途流程排空的上限（测试可缩短）。 */
  disposeDrainMs?: number
  now?: () => number
  createId?: (prefix: string) => string
}

export type ProviderAuthBroker = {
  snapshot: () => HarnessProviderAuthSnapshot
  subscribe: (listener: (event: HarnessProviderAuthStreamEvent) => void) => () => void
  /** 重新读取 provider/凭据状态（不解析密钥、不执行配置命令）。 */
  refresh: () => Promise<void>
  startLogin: (
    providerId: string,
    method: HarnessProviderAuthMethod,
  ) => Promise<HarnessProviderAuthStartResult>
  logout: (providerId: string) => Promise<HarnessProviderAuthStartResult>
  respond: (input: {
    operationId: string
    promptId: string
    value: string
  }) => HarnessProviderAuthRespondResult
  cancel: (operationId: string) => HarnessProviderAuthCancelResult
  /** 中止全部流程并等待结算；销毁后不再广播任何快照。 */
  dispose: () => Promise<void>
}

const MAX_EVENTS = 20
const MAX_EVENT_TEXT = 2_000
const MAX_LABEL_TEXT = 200
const MAX_PROMPT_VALUE_CHARS = 8_192
const MAX_OPERATIONS = 30
const DEFAULT_CANCEL_GRACE_MS = 5_000
const DISPOSE_DRAIN_MS = 2_000

type PromptEntry = HarnessProviderAuthPrompt & {
  resolve: (value: string) => void
  reject: (error: Error) => void
  cleanup: () => void
}

type InternalOperation = {
  operation: HarnessProviderAuthOperation
  controller: AbortController
  run?: Promise<unknown>
  promptEntry?: PromptEntry
  settled: boolean
  terminal: boolean
  cancelRequested: boolean
  availabilityNotified: boolean
}

const abortError = (): Error => {
  const error = new Error('认证操作已取消')
  error.name = 'AbortError'
  return error
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const safeText = (value: unknown, max = MAX_EVENT_TEXT): string | undefined => {
  if (typeof value !== 'string') return undefined
  // 去掉控制字符，避免伪造多行/终端控制序列；保留正常空白便于展示。
  // 用码点过滤而不是正则，避免把控制字符直接写进正则字面量。
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const control =
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    result += control ? ' ' : char
    if (result.length >= max) break
  }
  return result.slice(0, max)
}

const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, 2_048)
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined
  } catch {
    return undefined
  }
}

const positiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), 3_600)
}

const mapAuthSource = (source: AuthStatus['source']): HarnessProviderAuthSource | undefined => {
  switch (source) {
    case 'stored':
      return 'stored'
    case 'runtime':
      return 'runtime'
    case 'environment':
      return 'environment'
    case 'fallback':
      return 'fallback'
    case 'models_json_key':
      return 'models-json-key'
    case 'models_json_command':
      return 'models-json-command'
    default:
      return undefined
  }
}

/** 把 provider 提供的 notify 事件投影为白名单形状；非法 URL 直接丢弃。 */
function safeAuthEvent(
  event: AuthNotification,
  eventId: string,
): HarnessProviderAuthEvent | undefined {
  switch (event.type) {
    case 'info': {
      const message = safeText(event.message)
      if (!message) return undefined
      const links = (event.links ?? []).flatMap((link) => {
        const url = httpUrl(link.url)
        if (!url) return []
        const label = safeText(link.label, MAX_LABEL_TEXT)
        return [label ? { url, label } : { url }]
      })
      return {
        eventId,
        type: 'info',
        message,
        ...(links.length ? { links } : {}),
      }
    }
    case 'auth_url': {
      const url = httpUrl(event.url)
      if (!url) return undefined
      const instructions = safeText(event.instructions)
      return {
        eventId,
        type: 'auth_url',
        url,
        ...(instructions ? { instructions } : {}),
      }
    }
    case 'device_code': {
      const verificationUri = httpUrl(event.verificationUri)
      const userCode = safeText(event.userCode, MAX_LABEL_TEXT)
      if (!verificationUri || !userCode) return undefined
      const intervalSeconds = positiveNumber(event.intervalSeconds)
      const expiresInSeconds = positiveNumber(event.expiresInSeconds)
      return {
        eventId,
        type: 'device_code',
        userCode,
        verificationUri,
        ...(intervalSeconds ? { intervalSeconds } : {}),
        ...(expiresInSeconds ? { expiresInSeconds } : {}),
      }
    }
    case 'progress': {
      const message = safeText(event.message)
      return message ? { eventId, type: 'progress', message } : undefined
    }
    default:
      return undefined
  }
}

/** 把 prompt 投影为快照形状；未知/畸形类型不显示。 */
function safeAuthPrompt(
  prompt: AuthPrompt,
  promptId: string,
): HarnessProviderAuthPrompt | undefined {
  const message = safeText(prompt.message)
  if (!message) return undefined
  const placeholder =
    'placeholder' in prompt ? safeText(prompt.placeholder, MAX_LABEL_TEXT) : undefined
  const base = {
    promptId,
    message,
    ...(placeholder ? { placeholder } : {}),
  }
  switch (prompt.type) {
    case 'text':
      return { ...base, kind: 'text' }
    case 'secret':
      return { ...base, kind: 'secret' }
    case 'manual_code':
      return { ...base, kind: 'manual_code' }
    case 'select': {
      const options = (prompt.options ?? []).flatMap((option) => {
        const id = safeText(option.id, MAX_LABEL_TEXT)
        const label = safeText(option.label, MAX_LABEL_TEXT)
        if (!id || !label) return []
        const description = safeText(option.description)
        return [{ id, label, ...(description ? { description } : {}) }]
      })
      if (options.length === 0) return undefined
      return { ...base, kind: 'select', options }
    }
    default:
      return undefined
  }
}

/**
 * 创建认证 broker。
 *
 * 单宿主一份：多个浏览器窗口共享同一操作表，任一窗口都可回填/取消。
 * 同一 provider 的登录与退出互斥；不同 provider 可并行。
 */
export function createProviderAuthBroker(options: ProviderAuthBrokerOptions): ProviderAuthBroker {
  const { runtime } = options
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
  const disposeDrainMs = options.disposeDrainMs ?? DISPOSE_DRAIN_MS
  const now = options.now ?? (() => Date.now())
  let idCounter = 0
  const createId =
    options.createId ??
    ((prefix: string) => {
      idCounter += 1
      return `${prefix}:${idCounter}:${Math.random().toString(36).slice(2, 8)}`
    })

  const operations = new Map<string, InternalOperation>()
  const activeByProvider = new Map<string, InternalOperation>()
  const listeners = new Set<(event: HarnessProviderAuthStreamEvent) => void>()
  let providers: readonly HarnessProviderAuthProvider[] = []
  /** 上次广播的 provider 投影签名：轮询刷新无变化时不制造新快照。 */
  let providerSignature: string | undefined
  let seq = 0
  let authRevision = 0
  let catalogSeq = 0
  let disposed = false
  let promptCounter = 0

  const timestamp = (): string => new Date(now()).toISOString()

  const cloneOperation = (operation: HarnessProviderAuthOperation): HarnessProviderAuthOperation =>
    structuredClone(operation)

  const cloneSnapshot = (): HarnessProviderAuthSnapshot =>
    structuredClone({
      seq,
      authRevision,
      providers,
      operations: [...operations.values()].map((entry) => entry.operation),
    })

  const emit = (): void => {
    if (disposed) return
    seq += 1
    for (const listener of [...listeners]) {
      try {
        listener({ type: 'snapshot', seq, snapshot: cloneSnapshot() })
      } catch {
        // 单个订阅者异常不影响其他窗口。
      }
    }
  }

  const touch = (op: InternalOperation): void => {
    op.operation.updatedAt = timestamp()
  }

  const settle = (
    op: InternalOperation,
    phase: HarnessProviderAuthOperation['phase'],
    result: HarnessProviderAuthResult,
  ): void => {
    if (op.terminal) return
    // 终态结算会让当前提示立即失效（例如 OAuth 回调先完成），不能让
    // provider 还挂在一个已经无人可答的提示上。
    rejectPrompt(op)
    op.terminal = true
    op.operation.phase = phase
    op.operation.result = result
    delete op.operation.prompt
    op.promptEntry = undefined
    touch(op)
    if (op.settled && activeByProvider.get(op.operation.providerId) === op) {
      activeByProvider.delete(op.operation.providerId)
    }
    emit()
    void afterTerminal(op)
  }

  /**
   * 终态后本地刷新凭据/目录并递增可用性版本。
   * 常规终态只做一次；晚到结果（取消宽限期后成功/同步失败）需要强制
   * 再刷新一次，避免目录停留在旧的取消状态。
   */
  const afterTerminal = async (op: InternalOperation, force = false): Promise<void> => {
    if (!force && op.availabilityNotified) return
    op.availabilityNotified = true
    if (disposed) return
    try {
      await options.onAvailabilityChanged?.(op.operation.providerId)
    } catch {
      // 本地刷新失败由宿主诊断处理；认证终态已经确定，不反向改写。
    }
    if (disposed) return
    authRevision += 1
    // 可用性版本变化本身也要让轮询客户端看到；随后 refresh 再投影最新目录。
    emit()
    await refresh()
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    const generation = ++catalogSeq
    // 一次性读取全部 provider 与凭据元数据；不调用 getAuth/checkAuth，
    // 避免执行 secret command 或解析出密钥。
    const runtimeProviders = runtime.getProviders()
    let credentials: readonly CredentialInfo[] = []
    let credentialsReadable = true
    try {
      credentials = await runtime.listCredentials()
    } catch {
      // 存储读取失败不把原始错误带入协议；状态退化为“未确认凭据”。
      credentials = []
      credentialsReadable = false
    }
    if (disposed || generation !== catalogSeq) return
    const credentialTypes = new Map(
      credentials.map((credential) => [credential.providerId, credential.type]),
    )
    const nextProviders = runtimeProviders.map((provider) => {
      const credentialType = credentialTypes.get(provider.id)
      let status: AuthStatus = { configured: false }
      try {
        status = runtime.getProviderAuthStatus(provider.id)
      } catch {
        status = { configured: false }
      }
      const methods: Array<HarnessProviderAuthProvider['methods'][number]> = []
      const apiKey = provider.auth.apiKey
      if (apiKey) {
        const label = safeText(apiKey.name, MAX_LABEL_TEXT) ?? 'API key'
        methods.push({
          type: 'api_key',
          label,
          loginable: typeof apiKey.login === 'function',
        })
      }
      const oauth = provider.auth.oauth
      if (oauth) {
        const label = safeText(oauth.loginLabel ?? oauth.name, MAX_LABEL_TEXT) ?? 'OAuth'
        methods.push({
          type: 'oauth',
          label,
          loginable: typeof oauth.login === 'function',
          ...(oauth.isSubscription ? { subscription: true } : {}),
        })
      }
      // 凭据列表可读且没有该 provider、但状态仍声称 stored：视为外部删除，
      // 不继续显示“已配置”。列表读取失败时保留 SDK 状态，避免误报丢失。
      const staleStored = credentialsReadable && status.source === 'stored' && !credentialType
      const configured = credentialType !== undefined || (status.configured && !staleStored)
      const source = credentialType
        ? 'stored'
        : staleStored
          ? undefined
          : mapAuthSource(status.source)
      return {
        providerId: provider.id,
        name: safeText(provider.name, MAX_LABEL_TEXT) ?? provider.id,
        configured,
        ...(source ? { source } : {}),
        ...(credentialType ? { storedCredentialType: credentialType } : {}),
        methods,
        ambientOnly: methods.every((method) => !method.loginable),
      }
    })
    providers = nextProviders
    const signature = JSON.stringify(nextProviders)
    if (signature !== providerSignature) {
      providerSignature = signature
      emit()
    }
  }

  const providerEntry = (providerId: string): HarnessProviderAuthProvider | undefined =>
    providers.find((entry) => entry.providerId === providerId)

  const rejectPrompt = (op: InternalOperation): void => {
    const prompt = op.promptEntry
    if (!prompt) return
    op.promptEntry = undefined
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

  const finishLoginFailure = (op: InternalOperation, error: unknown): void => {
    if (disposed) return
    // 凭据写入成功但本地快照同步失败：明确“可能已保存”，不能按取消或
    // 普通失败处理，也不能自动重试覆盖。
    if (error instanceof CredentialSynchronizationError) {
      if (op.terminal) {
        // 宽限期后已按取消结算，但晚到的同步失败说明凭据仍可能已提交：
        // 升级为可诊断的 sync-failed，而不是让取消掩盖真实状态。
        op.operation.phase = 'failed'
        op.operation.result = {
          status: 'failed',
          code: 'sync-failed',
          message:
            op.operation.kind === 'login'
              ? '凭据可能已保存，但本地模型/认证状态同步失败。请刷新 provider 状态确认，不要直接重试登录覆盖。'
              : '凭据可能已移除，但本地模型/认证状态同步失败。请刷新 provider 状态确认，不要直接重试退出。',
          credentialUncertain: true,
        }
        touch(op)
        emit()
        void afterTerminal(op, true)
        return
      }
      settle(op, 'failed', {
        status: 'failed',
        code: 'sync-failed',
        message:
          op.operation.kind === 'login'
            ? '凭据可能已保存，但本地模型/认证状态同步失败。请刷新 provider 状态确认，不要直接重试登录覆盖。'
            : '凭据可能已移除，但本地模型/认证状态同步失败。请刷新 provider 状态确认，不要直接重试退出。',
        credentialUncertain: true,
      })
      return
    }
    if (op.cancelRequested || op.controller.signal.aborted) {
      settle(op, 'cancelled', {
        status: 'cancelled',
        code: 'cancelled',
        message:
          op.operation.kind === 'login'
            ? '登录已取消。若认证流程在取消前已提交，凭据可能已保存；请刷新 provider 状态确认。'
            : '退出登录已取消。若删除在取消前已提交，凭据可能已移除；请刷新 provider 状态确认。',
        credentialUncertain: true,
      })
      return
    }
    settle(op, 'failed', {
      status: 'failed',
      code: op.operation.kind === 'login' ? 'login-failed' : 'logout-failed',
      message:
        op.operation.kind === 'login'
          ? '登录失败。请检查 provider 配置或网络后重试；未显示 provider 原始错误。'
          : '退出登录失败。请稍后重试；未显示 provider 原始错误。',
      retryable: true,
    })
  }

  const finishLoginSuccess = (op: InternalOperation): void => {
    if (disposed) return
    // 取消竞态：若 SDK 已成功返回（凭据已提交），以成功为准，不能随后
    // 被取消流程改写成“丢失”。已终态的取消操作允许晚到的成功结果升级。
    if (op.terminal) {
      op.operation.phase = 'succeeded'
      op.operation.result = {
        status: 'succeeded',
        message:
          op.operation.kind === 'login'
            ? '认证在取消后完成，凭据已保存。'
            : '退出在取消后完成，凭据已移除。',
      }
      touch(op)
      emit()
      void afterTerminal(op, true)
      return
    }
    settle(op, 'succeeded', {
      status: 'succeeded',
      message:
        op.operation.kind === 'login'
          ? op.cancelRequested
            ? '取消请求到达前认证已完成，凭据已保存。'
            : '登录成功，凭据已保存到当前用户空间。'
          : op.cancelRequested
            ? '取消请求到达前退出已完成，凭据已移除。'
            : '已退出登录，已存凭据已移除。',
    })
  }

  const attachRun = (op: InternalOperation, run: Promise<unknown>): void => {
    op.run = run
    void run.then(
      () => {
        op.settled = true
        if (activeByProvider.get(op.operation.providerId) === op) {
          activeByProvider.delete(op.operation.providerId)
        }
        finishLoginSuccess(op)
      },
      (error: unknown) => {
        op.settled = true
        if (activeByProvider.get(op.operation.providerId) === op) {
          activeByProvider.delete(op.operation.providerId)
        }
        finishLoginFailure(op, error)
      },
    )
  }

  const beginOperation = (
    kind: HarnessProviderAuthOperationKind,
    provider: HarnessProviderAuthProvider,
    method?: HarnessProviderAuthMethod,
  ): HarnessProviderAuthStartResult => {
    const active = activeByProvider.get(provider.providerId)
    if (active) {
      return { status: 'busy', operation: cloneOperation(active.operation) }
    }
    // 同一 provider 只保留最近一次终态操作，避免操作表无界增长。
    for (const [id, entry] of operations) {
      if (entry.terminal && entry.settled && entry.operation.providerId === provider.providerId) {
        operations.delete(id)
      }
    }
    while (operations.size >= MAX_OPERATIONS) {
      const oldestTerminal = [...operations.values()].find(
        (entry) => entry.terminal && entry.settled,
      )
      if (!oldestTerminal) break
      operations.delete(oldestTerminal.operation.id)
    }
    const startedAt = timestamp()
    const controller = new AbortController()
    const operation: HarnessProviderAuthOperation = {
      id: createId('auth'),
      providerId: provider.providerId,
      providerName: provider.name,
      kind,
      ...(method ? { method } : {}),
      phase: 'starting',
      startedAt,
      updatedAt: startedAt,
      events: [],
    }
    const op: InternalOperation = {
      operation,
      controller,
      settled: false,
      terminal: false,
      cancelRequested: false,
      availabilityNotified: false,
    }
    operations.set(operation.id, op)
    activeByProvider.set(provider.providerId, op)
    emit()

    if (kind === 'login') {
      operation.phase = 'waiting'
      touch(op)
      emit()
      const interaction: AuthInteraction = {
        signal: controller.signal,
        prompt: (prompt) =>
          controller.signal.aborted ? Promise.reject(abortError()) : requestPrompt(op, prompt),
        notify: (event) => notifyEvent(op, event),
      }
      try {
        // method 由调用方保证存在于 provider.methods；这里再窄化一次类型。
        if (!method) throw new Error('missing auth method')
        attachRun(op, runtime.login(provider.providerId, method, interaction))
      } catch (error) {
        attachRun(op, Promise.reject(error))
      }
    } else {
      operation.phase = 'waiting'
      touch(op)
      emit()
      try {
        attachRun(op, runtime.logout(provider.providerId, { signal: controller.signal }))
      } catch (error) {
        attachRun(op, Promise.reject(error))
      }
    }
    return { status: 'started', operation: cloneOperation(operation) }
  }

  const requestPrompt = (op: InternalOperation, prompt: AuthPrompt): Promise<string> => {
    if (op.terminal || disposed) return Promise.reject(abortError())
    const promptId = createId('prompt')
    promptCounter += 1
    const safe = safeAuthPrompt(prompt, `${promptId}:${promptCounter}`)
    if (!safe) return Promise.reject(new Error('认证提示不受支持'))
    if (prompt.signal?.aborted) return Promise.reject(abortError())
    // 同一操作同时只允许一个提示；新提示到达时旧提示立即失效。
    rejectPrompt(op)
    const controller = op.controller
    return new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false
      const cleanup = () => {
        prompt.signal?.removeEventListener('abort', onPromptAbort)
      }
      const finishResolve = (value: string) => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise(value)
      }
      const finishReject = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(error)
      }
      const onPromptAbort = () => {
        if (op.promptEntry?.promptId !== safe.promptId) return
        op.promptEntry = undefined
        delete op.operation.prompt
        if (!op.terminal && op.operation.phase === 'prompt') op.operation.phase = 'waiting'
        touch(op)
        emit()
        finishReject(abortError())
      }
      const entry: PromptEntry = {
        ...safe,
        resolve: finishResolve,
        reject: finishReject,
        cleanup,
      }
      op.promptEntry = entry
      op.operation.prompt = { ...safe }
      op.operation.phase = 'prompt'
      touch(op)
      prompt.signal?.addEventListener('abort', onPromptAbort, { once: true })
      if (controller.signal.aborted) {
        onPromptAbort()
      } else {
        emit()
      }
    })
  }

  const notifyEvent = (op: InternalOperation, event: AuthNotification): void => {
    if (op.terminal || disposed) return
    const safe = safeAuthEvent(event, createId('event'))
    if (!safe) return
    op.operation.events = [...op.operation.events, safe].slice(-MAX_EVENTS)
    if (!op.operation.prompt && op.operation.phase === 'waiting') {
      op.operation.phase = safe.type === 'info' ? 'waiting' : 'verifying'
    }
    touch(op)
    emit()
  }

  const finalizeCancelled = async (op: InternalOperation): Promise<void> => {
    const run = op.run
    if (!run) {
      settle(op, 'cancelled', {
        status: 'cancelled',
        code: 'cancelled',
        message: '操作已取消。',
      })
      return
    }
    // 先等待 SDK 结算；宽限期内成功会由 attachRun 处理，取消不会覆盖成功。
    await Promise.race([
      run.then(
        () => undefined,
        () => undefined,
      ),
      delay(cancelGraceMs),
    ])
    if (disposed || op.settled || op.terminal) return
    // provider 自定义回调可能不响应 signal：界定为“取消结果未确认”。
    // 晚到的成功仍可把操作升级为 succeeded（凭据确实已提交）。
    settle(op, 'cancelled', {
      status: 'cancelled',
      code: 'cancelled',
      message:
        op.operation.kind === 'login'
          ? '已请求取消。认证流程未在等待期内结算；若其随后提交，凭据可能已保存，请刷新 provider 状态确认。'
          : '已请求取消退出。删除流程未在等待期内结算；凭据可能已移除，请刷新 provider 状态确认。',
      credentialUncertain: true,
    })
  }

  const startLogin = async (
    providerId: string,
    method: HarnessProviderAuthMethod,
  ): Promise<HarnessProviderAuthStartResult> => {
    if (disposed) return { status: 'invalid', message: '宿主已停止，无法开始认证。' }
    if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 200) {
      return { status: 'invalid', message: 'provider ID 无效。' }
    }
    if (method !== 'api_key' && method !== 'oauth') {
      return { status: 'invalid', message: '认证方法无效。' }
    }
    await refresh()
    if (disposed) return { status: 'invalid', message: '宿主已停止，无法开始认证。' }
    const provider = providerEntry(providerId)
    if (!provider) return { status: 'invalid', message: '未知 provider；未向模型发送该 ID。' }
    const active = activeByProvider.get(providerId)
    if (active) {
      return { status: 'busy', operation: cloneOperation(active.operation) }
    }
    const methodInfo = provider.methods.find((item) => item.type === method)
    if (!methodInfo?.loginable) {
      return {
        status: 'invalid',
        message: provider.ambientOnly
          ? '该 provider 只支持环境变量或配置文件凭据，没有交互登录入口。'
          : '该 provider 不支持所选的交互登录方法。',
      }
    }
    return beginOperation('login', provider, method)
  }

  const logout = async (providerId: string): Promise<HarnessProviderAuthStartResult> => {
    if (disposed) return { status: 'invalid', message: '宿主已停止，无法退出登录。' }
    if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 200) {
      return { status: 'invalid', message: 'provider ID 无效。' }
    }
    await refresh()
    if (disposed) return { status: 'invalid', message: '宿主已停止，无法退出登录。' }
    const provider = providerEntry(providerId)
    if (!provider) return { status: 'invalid', message: '未知 provider。' }
    // 互斥优先于来源校验：同 provider 的登录尚未完成时，退出也必须明确 busy，
    // 而不是因为“当前还没有已存凭据”误报 invalid。
    const active = activeByProvider.get(providerId)
    if (active) {
      return { status: 'busy', operation: cloneOperation(active.operation) }
    }
    // 环境/配置/运行时凭据无法通过 logout 清除，明确说明而不是伪装成功。
    if (provider.source === 'runtime') {
      return {
        status: 'invalid',
        message: '当前凭据只存在于宿主运行时，退出登录不会清除它；请重启宿主或修改对应配置。',
      }
    }
    if (
      provider.source === 'environment' ||
      provider.source === 'fallback' ||
      provider.source === 'models-json-key' ||
      provider.source === 'models-json-command'
    ) {
      return {
        status: 'invalid',
        message:
          '当前凭据来自环境变量或 models.json，退出登录不会清除这些来源；请修改对应配置后重启宿主。',
      }
    }
    if (!provider.configured) {
      return {
        status: 'invalid',
        message: '当前没有已存凭据可退出；环境变量或 models.json 凭据不会被此操作清除。',
      }
    }
    return beginOperation('logout', provider)
  }

  const respond = (input: {
    operationId: string
    promptId: string
    value: string
  }): HarnessProviderAuthRespondResult => {
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
    const entry = op.promptEntry
    if (!entry || entry.promptId !== input.promptId) return { status: 'stale' }
    if (entry.kind === 'select') {
      const valid = entry.options?.some((option) => option.id === input.value)
      if (!valid) return { status: 'invalid', message: '所选选项无效。' }
    }
    // 先移出快照再交付 resolver：值不保留在 broker 状态中。
    op.promptEntry = undefined
    delete op.operation.prompt
    op.operation.phase = 'waiting'
    touch(op)
    emit()
    entry.resolve(input.value)
    return { status: 'accepted' }
  }

  const cancel = (operationId: string): HarnessProviderAuthCancelResult => {
    if (disposed) return { status: 'not-found' }
    const op = operations.get(operationId)
    if (!op) return { status: 'not-found' }
    if (op.terminal) return { status: 'finished', operation: cloneOperation(op.operation) }
    if (!op.cancelRequested) {
      op.cancelRequested = true
      op.operation.phase = 'cancelling'
      touch(op)
      rejectPrompt(op)
      op.controller.abort()
      emit()
      void finalizeCancelled(op)
    }
    return { status: 'cancelling', operation: cloneOperation(op.operation) }
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    const runs: Promise<unknown>[] = []
    for (const op of operations.values()) {
      op.controller.abort()
      rejectPrompt(op)
      if (op.run) runs.push(op.run.catch(() => undefined))
    }
    // 排空但不无限等待：自定义 provider 可能忽略 signal；此处之后任何
    // 晚结果都因 disposed 而不再广播，也不保留回填输入。
    await Promise.race([Promise.allSettled(runs), delay(disposeDrainMs)])
    operations.clear()
    activeByProvider.clear()
    providers = []
    listeners.clear()
    catalogSeq += 1
  }

  return {
    snapshot: cloneSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      try {
        listener({ type: 'snapshot', seq, snapshot: cloneSnapshot() })
      } catch {
        // 首帧投递失败不应阻止后续订阅。
      }
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    startLogin,
    logout,
    respond,
    cancel,
    dispose,
  }
}
