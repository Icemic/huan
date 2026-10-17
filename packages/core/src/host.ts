/**
 * 自研宿主（@huan/core）：Pi 会话运行时的所有者，实现协议 HarnessClient。
 *
 * 设计要点（对照迭代③设计 §3.3）：
 * - **装配粒度**：modelRuntime 全宿主共享一份（provider 注册为合并语义）；
 *   settingsManager / resourceLoader / 扩展 runtime 每 live session 独立装配
 *   （扩展 runner 会把动作绑定写入共享 runtime，复用会导致会话串扰）。
 * - **新/冷语义分离**：新建会话传默认模型；冷打开历史会话不传 model，
 *   让 SDK 从会话记录恢复（否则默认模型会覆盖会话自身记录）。
 * - **行为契约**：sendMessage 返回 = 输入已被接受（不等待运行结束）；
 *   取消翻 token 并 abort（含预检窗口兜底）；删除先 abort 再 dispose 再 unlink；
 *   订阅先快照后实时（同一 record、同一 seq 边界）。
 */
import { unlink } from 'node:fs/promises'
import {
  type AgentSession,
  createAgentSessionFromServices,
  ExtensionRunner,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessClient,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessCreateThreadInput,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessSendMessageInput,
  HarnessThinkingLevel,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { deriveContextUsage } from './context-usage.js'
import { mapSessionEvent } from './event-mapping.js'
import { createHostUiBridge, type HostUiBridge } from './host-ui.js'
import {
  baseName,
  deriveReadiness,
  mapColdMetadata,
  mapQueuedMessages,
  mapSessionInfo,
  readinessFromSessionContext,
  type SessionCatalogInfo,
} from './metadata.js'
import {
  createHostServices,
  createSharedModelRuntime,
  listModelCatalog,
  refreshModelCatalog,
  resolveDefaultModel,
} from './model-catalog.js'

/** 宿主动作选项。 */
export type HarnessHostOptions = {
  /** 默认工作目录（listThreads/createThread 未指定时使用）。 */
  workspacePath: string
  /** Pi 配置目录（默认 Pi 自行解析）。 */
  agentDir?: string
  /**
   * 覆盖默认模型（最高优先级；通常由环境变量解析后传入）。
   * 未提供时，新建会话交 SDK 按 settings 解析；冷打开永不传模型。
   */
  model?: HarnessDefaultModel
  /** 启动时是否允许联网刷新模型目录（默认 true）。 */
  refreshCatalogOnStart?: boolean
  /** 目录刷新超时（毫秒；默认 15000；0 表示不设超时）。 */
  catalogRefreshTimeoutMs?: number
}

/** 默认模型的宽松形状（SDK Model 的透明转发）。 */
export type HarnessDefaultModel = NonNullable<
  Parameters<typeof createAgentSessionFromServices>[0]['model']
>

/** 宿主：协议客户端 + 生命周期管理。 */
export type HarnessHost = HarnessClient & {
  dispose(): Promise<void>
  /** 启动期诊断（模型目录刷新错误、扩展装配诊断等），供应用呈现。 */
  diagnostics(): readonly string[]
}

type ThreadRecord = {
  threadId: string
  session: AgentSession
  uiBridge: HostUiBridge
  unsubscribe: () => void
  listeners: Set<(event: HarnessClientEvent) => void>
  seq: number
  turnIndex: number
  workspacePath: string
  lastError: string | undefined
  /** 该会话的资源加载器（用于 dispose 时补发 session_shutdown）。 */
  resourceLoader: ResourceLoader
  /** 在途发送（含预检阶段），取消/删除需使它们全部失效并等待退出。 */
  inFlight: Set<InFlightSend>
}

type InFlightSend = {
  /** 已确认被接受（started/queued/handled）。 */
  accepted: boolean
  /** 已被取消（取消后不得再启动运行）。 */
  cancelled: boolean
  /** 预检完成（无论接受或失败）；用于删除时等待退出。 */
  finished: Promise<void>
  /** 标记预检完成（内部使用）。 */
  markFinished: () => void
}

type StartingSend = { cancelled: boolean }

/** 给承诺加超时（0 或负数表示不设超时）。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!(timeoutMs > 0)) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function createHarnessHost(options: HarnessHostOptions): Promise<HarnessHost> {
  const workspacePath = options.workspacePath
  const agentDir = options.agentDir
  const diagnostics: string[] = []

  // ---- 装配层：共享 modelRuntime（全宿主一份），其余每会话独立 ----
  const modelRuntime = await createSharedModelRuntime(agentDir)
  // 启动引导装配：经官方入口加载扩展并把 provider（含虚拟模型）注册进共享
  // modelRuntime。默认模型解析与目录查询都依赖这一步（否则扩展 provider 不可见）；
  // 该次装配的 resourceLoader 仅为注册服务，随用随弃。
  const bootstrap = await createHostServices({ cwd: workspacePath, agentDir, modelRuntime })
  for (const diagnostic of bootstrap.diagnostics) {
    if (diagnostic.type !== 'info') diagnostics.push(`启动装配：${diagnostic.message}`)
  }
  const startRefresh = options.refreshCatalogOnStart ?? true
  const refreshTimeoutMs = options.catalogRefreshTimeoutMs ?? 15_000
  if (startRefresh) {
    try {
      // 联网刷新可能因扩展 provider 的远程拉取而长期挂起；超时后放弃等待
      // （目录保留缓存内容，服务照常启动）。
      await withTimeout(
        refreshModelCatalog(modelRuntime, { allowNetwork: true }),
        refreshTimeoutMs,
        '模型目录刷新',
      ).then(
        ({ errors }) => diagnostics.push(...errors.map((message) => `模型目录刷新：${message}`)),
        (error: unknown) => diagnostics.push(`模型目录刷新失败：${String(error)}`),
      )
    } catch (error) {
      diagnostics.push(`模型目录刷新失败：${String(error)}`)
    }
  }

  // 默认模型：显式 options.model 优先；否则启动时解析（env → settings）。
  const resolvedDefault =
    options.model ?? resolveDefaultModel({ modelRuntime, cwd: workspacePath, agentDir })

  const records = new Map<string, ThreadRecord>()
  /** 进行中的冷打开（并发调用共享同一 promise，避免同文件双开）。 */
  const pendingOpens = new Map<
    string,
    { promise: Promise<ThreadRecord>; controller: AbortController }
  >()
  /** 每线程的发送取消令牌（覆盖「冷打开中 → 启动 prompt」窗口）。 */
  const startingSends = new Map<string, Set<StartingSend>>()
  const pendingDeletes = new Map<string, Promise<void>>()
  const recordsBySessionFile = new Map<string, ThreadRecord>()
  /** 归档标记（内存态；重启丢失为已知限制）。 */
  const archivedSessionFiles = new Set<string>()
  /** dispose 后拒绝新操作。 */
  let disposed = false
  /** 代数计数：使 dispose 前发起的异步打开失效。 */
  let generation = 0

  const catalogCache = new Map<
    string,
    { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> }
  >()
  const catalogInfoByThreadId = new Map<string, SessionCatalogInfo>()

  const assertActive = () => {
    if (disposed) throw new Error('Harness host has been disposed')
  }

  // ---- 目录读取（SessionManager.list 带缓存，用于 thread 列表与冷读定位） ----
  const listSessionInfos = async (cwd: string): Promise<SessionCatalogInfo[]> => {
    const existing = catalogCache.get(cwd)
    if (existing?.infos) return existing.infos
    if (existing?.promise) return existing.promise
    const entry: { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> } = {}
    const promise = SessionManager.list(cwd)
      .then((infos) => {
        const mapped = infos as unknown as SessionCatalogInfo[]
        entry.infos = mapped
        rememberSessionInfos(mapped)
        return mapped
      })
      .finally(() => {
        entry.promise = undefined
      })
    entry.promise = promise
    catalogCache.set(cwd, entry)
    return promise
  }

  const rememberSessionInfos = (infos: readonly SessionCatalogInfo[]) => {
    for (const info of infos) catalogInfoByThreadId.set(info.id, info)
  }

  const invalidateCatalog = (cwd: string = workspacePath) => {
    catalogCache.delete(cwd)
    // 同时丢弃冷路径的元数据缓存，避免删除/更名后仍读到旧值。
    for (const [threadId, info] of catalogInfoByThreadId) {
      if (info.cwd === cwd || info.cwd === '') catalogInfoByThreadId.delete(threadId)
    }
  }

  const findSessionInfo = async (threadId: string): Promise<SessionCatalogInfo | undefined> => {
    const cached = catalogInfoByThreadId.get(threadId)
    if (cached) return cached
    const hit = (await listSessionInfos(workspacePath)).find((info) => info.id === threadId)
    if (hit) return hit
    const all = (await SessionManager.listAll()) as unknown as SessionCatalogInfo[]
    rememberSessionInfos(all)
    return all.find((info) => info.id === threadId)
  }

  // ---- 状态推导（热/冷共用口径） ----
  const runStatus = (record: ThreadRecord): HarnessThreadMetadata['status'] => {
    const session = record.session
    if (session.isStreaming || session.isCompacting || session.isRetrying) return 'running'
    return record.lastError ? 'failed' : 'idle'
  }

  const metadataOf = (record: ThreadRecord): HarnessThreadMetadata => {
    const session = record.session
    const model = session.model
    const usage = session.getContextUsage()
    const queued = mapQueuedMessages(session.getSteeringMessages(), session.getFollowUpMessages())
    return {
      id: record.threadId,
      status: runStatus(record),
      compactionActive: session.isCompacting,
      retryActive: session.isRetrying,
      retryAttempt: session.retryAttempt,
      workspacePath: record.workspacePath,
      messageCount: session.messages.length,
      ...(session.sessionName ? { title: session.sessionName } : {}),
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      ...(model
        ? {
            config: {
              provider: model.provider,
              modelId: model.id,
              thinkingLevel: session.thinkingLevel,
            },
          }
        : { config: { thinkingLevel: session.thinkingLevel } }),
      ...(usage ? { contextUsage: usage } : {}),
      ...(session.sessionFile && archivedSessionFiles.has(session.sessionFile)
        ? { archived: true }
        : {}),
      ...(queued.length ? { queuedMessages: queued } : {}),
    }
  }

  const snapshotOf = (record: ThreadRecord): HarnessThreadSnapshot => {
    const pending = record.uiBridge.pending()
    return {
      metadata: metadataOf(record),
      messages: record.session.messages as HarnessAgentMessage[],
      readiness: deriveReadiness({
        model: record.session.model
          ? { provider: record.session.model.provider, id: record.session.model.id }
          : undefined,
        source: 'session',
      }),
      seq: record.seq,
      ...(pending.length ? { hostUiRequests: pending } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
    }
  }

  // ---- 事件投递 ----
  const emit = (record: ThreadRecord, body: HarnessClientEventBody) => {
    record.seq += 1
    const event = { ...body, threadId: record.threadId, seq: record.seq } as HarnessClientEvent
    for (const listener of [...record.listeners]) {
      try {
        listener(event)
      } catch {
        // 单个订阅者抛错不影响其他订阅者。
      }
    }
  }

  const emitContextUsage = (record: ThreadRecord) => {
    const usage = record.session.getContextUsage()
    if (usage) emit(record, { type: 'context_usage', contextUsage: usage })
  }

  function onSessionEvent(
    record: ThreadRecord,
    event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0],
  ): void {
    if (event.type === 'turn_start') record.turnIndex += 1
    if (event.type === 'session_info_changed') invalidateCatalog(record.workspacePath)

    const mapped = mapSessionEvent(event, { turnIndex: record.turnIndex })
    if (mapped.kind === 'mapped') emit(record, mapped.event)

    if (
      event.type === 'turn_end' ||
      event.type === 'agent_end' ||
      event.type === 'compaction_end'
    ) {
      emitContextUsage(record)
    }
    if (event.type === 'agent_end') {
      const message = record.session.state.errorMessage
      if (message) {
        record.lastError = message
        emit(record, { type: 'error', error: message })
      }
    }
  }

  // ---- 会话打开 ----
  const openSession = async (
    sessionManager: SessionManager,
    cwd: string,
    opts: {
      isNew: boolean
      signal?: AbortSignal
      /** 新会话的显式模型（优先于宿主启动时解析的默认模型）。 */
      model?: HarnessDefaultModel
      /** 新会话的 Thinking 级别（在模型应用后设置）。 */
      thinkingLevel?: HarnessThinkingLevel
    },
  ): Promise<ThreadRecord> => {
    const openedGeneration = generation
    throwIfOpenCancelled(opts.signal, openedGeneration)

    // 每 live session 独立装配（扩展 runtime 隔离）。
    const services = await createHostServices({ cwd, agentDir, modelRuntime })
    for (const diagnostic of services.diagnostics) {
      if (diagnostic.type !== 'info') diagnostics.push(`扩展装配（${cwd}）：${diagnostic.message}`)
    }
    throwIfOpenCancelled(opts.signal, openedGeneration)

    // 新会话：显式模型 > 启动时解析的默认模型；冷打开不传，由 SDK 从会话记录恢复。
    const newSessionModel = opts.model ?? resolvedDefault
    const { session, modelFallbackMessage } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(opts.isNew && newSessionModel ? { model: newSessionModel } : {}),
    })
    // SDK 在恢复失败时会回退到其他模型；该原因必须可见（不静默）。
    if (modelFallbackMessage) {
      diagnostics.push(`模型回退（${cwd}）：${modelFallbackMessage}`)
    }

    if (openWasCancelled(opts.signal, openedGeneration)) {
      session.dispose()
      throwOpenCancelled()
    }

    // Thinking 级别在模型应用之后设置（SDK 的 setModel 自身会调整级别）。
    if (opts.isNew && opts.thinkingLevel) {
      try {
        await session.setThinkingLevel(opts.thinkingLevel)
      } catch (error) {
        diagnostics.push(`Thinking 级别设置（${cwd}）：${String(error)}`)
      }
      throwIfOpenCancelled(opts.signal, openedGeneration)
    }

    const threadId = session.sessionId
    const record: ThreadRecord = {
      threadId,
      session,
      uiBridge: undefined as unknown as HostUiBridge,
      unsubscribe: () => {},
      listeners: new Set(),
      seq: 0,
      turnIndex: -1,
      workspacePath: cwd,
      lastError: undefined,
      resourceLoader: services.resourceLoader,
      inFlight: new Set(),
    }

    const uiBridge = createHostUiBridge({
      nextRequestId: () => `${threadId}:ui:${record.seq}:${Math.random().toString(36).slice(2, 8)}`,
      currentToolCallId: () => {
        const pending = session.state.pendingToolCalls
        return pending.size === 1 ? [...pending][0] : undefined
      },
      emitRequest: (request: HarnessHostUiRequest) => {
        emit(record, { type: 'extension_ui_request', request })
      },
      emitResolved: (requestId: string) => {
        emit(record, { type: 'extension_ui_resolved', requestId })
      },
      onNotify: (message, type) => {
        // 装配期的自动忽略等提示：记入诊断（无订阅者时也能被应用看到）。
        if (type !== 'info') diagnostics.push(`Host UI（${cwd}）：${message}`)
      },
    })
    record.uiBridge = uiBridge

    // 装配期：session_start handler 发起的阻断请求立即结算（record 尚未发布）。
    uiBridge.setStartup(true)

    try {
      await session.bindExtensions({
        uiContext: uiBridge.ui,
        onError: (error) => {
          record.lastError = error.error
          emit(record, { type: 'error', error: error.error })
        },
      })
    } catch (error) {
      uiBridge.dismissAll()
      session.dispose()
      throw error
    }

    if (openWasCancelled(opts.signal, openedGeneration)) {
      uiBridge.dismissAll()
      session.dispose()
      throwOpenCancelled()
    }

    try {
      record.unsubscribe = session.subscribe((event) => onSessionEvent(record, event))
    } catch (error) {
      try {
        uiBridge.dismissAll()
      } catch {
        // 清理失败不掩盖原始错误。
      }
      try {
        session.dispose()
      } catch {
        // 同上。
      }
      throw error
    }

    records.set(threadId, record)
    if (session.sessionFile) recordsBySessionFile.set(session.sessionFile, record)
    // record 已发布：后续阻断请求输送到订阅者。
    uiBridge.setStartup(false)
    return record
  }

  const openWasCancelled = (signal: AbortSignal | undefined, openedGeneration: number) =>
    signal?.aborted === true || openedGeneration !== generation

  const throwIfOpenCancelled = (signal: AbortSignal | undefined, openedGeneration = generation) => {
    if (openWasCancelled(signal, openedGeneration)) throwOpenCancelled()
  }

  const throwOpenCancelled = () => {
    throw new Error('Harness session open was cancelled')
  }

  const ensureOpen = async (threadId: string): Promise<ThreadRecord> => {
    assertActive()
    if (pendingDeletes.has(threadId)) throwOpenCancelled()
    const existing = records.get(threadId)
    if (existing) return existing
    const pending = pendingOpens.get(threadId)
    if (pending) return pending.promise

    const controller = new AbortController()
    const open = openCold(threadId, controller.signal).finally(() => {
      if (pendingOpens.get(threadId)?.promise === open) pendingOpens.delete(threadId)
    })
    pendingOpens.set(threadId, { promise: open, controller })
    return open
  }

  const openCold = async (threadId: string, signal: AbortSignal): Promise<ThreadRecord> => {
    const info = await findSessionInfo(threadId)
    throwIfOpenCancelled(signal)
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    const existingBySessionFile = recordsBySessionFile.get(info.path)
    if (existingBySessionFile) {
      records.set(threadId, existingBySessionFile)
      return existingBySessionFile
    }
    const sessionManager = SessionManager.open(info.path)
    return openSession(sessionManager, info.cwd || workspacePath, { isNew: false, signal })
  }

  // ---- 发送 ----
  /**
   * 发送一次 prompt，返回「输入已被接受」的承诺（不等待运行结束）。
   *
   * 预检取消兜底：SDK 的 `abort()` 只在 `_isAgentRunActive` 为真时记录中止意图，
   * 而预检（input hook / 认证检查 / before_agent_start）期间该标志尚未置位，
   * 因此取消必须由宿主在预检结束后自行拦截——若已取消，则立即 abort，
   * 阻止 `_runAgentPrompt()` 真正启动模型调用。
   */
  const send = async (
    record: ThreadRecord,
    input: HarnessSendMessageInput,
    isCancelled: () => boolean,
  ): Promise<void> => {
    assertActive()

    let resolveFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const inFlight: InFlightSend = {
      accepted: false,
      cancelled: false,
      finished,
      markFinished: () => resolveFinished(),
    }
    record.inFlight.add(inFlight)

    // 预检承诺：接受（含入队）或被拒绝时结算一次。
    let settlePreflight: (error?: unknown) => void = () => {}
    let preflightSettled = false
    const accepted = new Promise<void>((resolve, reject) => {
      settlePreflight = (error) => {
        if (preflightSettled) return
        preflightSettled = true
        if (error) reject(error)
        else resolve()
      }
    })

    // 运行中 Pi 要求显式声明排队语义；默认 followUp。
    const streamingBehavior =
      input.streamingBehavior ?? (record.session.isStreaming ? 'followUp' : undefined)

    record.session
      .prompt(input.content, {
        ...(input.attachments?.length ? { images: input.attachments } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
        preflightResult: () => {
          inFlight.accepted = true
          settlePreflight()
          // 预检期间被取消：必须等 SDK 进入运行态后再 abort。
          // `_runAgentPrompt()` 在回调返回后才会置 `_isAgentRunActive` 并建立
          // agent 的 activeRun（abortController），因此这里用微任务延后到下一轮
          // 事件循环，确保 abort 命中真实的运行（同步调用会被随后的状态重置吞掉）。
          if (isCancelled() || inFlight.cancelled) {
            queueMicrotask(() => {
              void record.session.abort().catch(() => {})
            })
          }
        },
      })
      .then(() => {
        settlePreflight()
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        record.lastError = message
        if (preflightSettled) {
          emit(record, { type: 'error', error: message })
        } else {
          settlePreflight(error)
        }
      })
      .finally(() => {
        record.inFlight.delete(inFlight)
        inFlight.markFinished()
      })

    try {
      await accepted
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record.lastError = message
      emit(record, { type: 'error', error: message })
      throw error
    }
  }

  // ---- 删除 ----
  const deleteThreadNow = async (threadId: string): Promise<void> => {
    pendingOpens.get(threadId)?.controller.abort()
    const record = records.get(threadId)
    const info = record ? undefined : await findSessionInfo(threadId)
    if (!record && !info) return
    const sessionFile = record?.session.sessionFile ?? info?.path
    const cwd = record?.workspacePath ?? info?.cwd
    if (!sessionFile) throw new Error(`Unknown thread: ${threadId}`)

    if (record) {
      // 1) 使在途发送（含预检）失效，避免删除后仍启动运行。
      for (const pending of record.inFlight) pending.cancelled = true
      // 2) 先解除阻断式 UI 等待，否则 abort 可能等一个永不应答的对话（工具在等 UI）。
      record.uiBridge.dismissAll()
      // 3) 中止运行并等待收尾（此时工具/UI 已不再阻断）。
      try {
        await record.session.abort()
      } catch {
        // 已空闲或中止失败不阻断删除。
      }
      // 4) 等待在途发送的预检退出（它们不再启动运行）。
      await Promise.allSettled([...record.inFlight].map((pending) => pending.finished))
      record.unsubscribe()
      await emitShutdown(record, 'quit')
      record.session.dispose()
      records.delete(threadId)
      recordsBySessionFile.delete(sessionFile)
    }
    archivedSessionFiles.delete(sessionFile)
    catalogInfoByThreadId.delete(threadId)
    await unlink(sessionFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (cwd) invalidateCatalog(cwd)
  }

  /**
   * 补发 `session_shutdown`。
   *
   * SDK 的 `AgentSession.dispose()` 只做 abort 与内部清理，不发 shutdown 事件；
   * 官方 runtime 在销毁前显式发它（`agent-session-runtime.js`）。扩展若在
   * `session_start` 建连接/定时器并在 `session_shutdown` 释放，缺这一步会泄漏。
   */
  const emitShutdown = async (
    record: ThreadRecord,
    reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork',
  ): Promise<void> => {
    try {
      const extensionsResult = record.resourceLoader.getExtensions()
      const runner = new ExtensionRunner(
        extensionsResult.extensions,
        extensionsResult.runtime,
        record.workspacePath,
        SessionManager.open(record.session.sessionFile ?? ''),
        new ModelRegistry(modelRuntime),
      )
      await runner.emit({ type: 'session_shutdown', reason })
    } catch (error) {
      diagnostics.push(`session_shutdown（${record.workspacePath}）：${String(error)}`)
    }
  }

  const client: HarnessClient = {
    async listThreads(input) {
      assertActive()
      const cwd = input?.workspacePath ?? workspacePath
      return (await listSessionInfos(cwd))
        .filter((info) => input?.includeArchived || !archivedSessionFiles.has(info.path))
        .map((info) => {
          const live = records.get(info.id)
          if (live) return metadataOf(live)
          // 冷条目也要叠加归档标记（过滤与呈现口径一致）。
          return {
            ...mapSessionInfo(info, { liveStatus: 'idle' }),
            ...(archivedSessionFiles.has(info.path) ? { archived: true } : {}),
          }
        })
    },

    async createThread(input?: HarnessCreateThreadInput) {
      assertActive()
      const cwd = input?.workspacePath ?? workspacePath
      // 显式模型：按 registry 校验并解析为模型对象（找不到时报错，不静默回退）。
      let explicitModel: HarnessDefaultModel | undefined
      if (input?.model) {
        const resolved = modelRuntime.getModel(input.model.provider, input.model.modelId)
        if (!resolved) {
          throw new Error(
            `${input.model.provider}/${input.model.modelId} is not in Pi's model registry`,
          )
        }
        explicitModel = resolved
      }
      const sessionManager = SessionManager.create(cwd)
      const record = await openSession(sessionManager, cwd, {
        isNew: true,
        ...(explicitModel ? { model: explicitModel } : {}),
        ...(input?.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      })
      invalidateCatalog(cwd)
      if (input?.title) record.session.setSessionName(input.title)
      if (input?.initialMessage) await send(record, input.initialMessage, () => false)
      return snapshotOf(record)
    },

    async getThread(threadId: string) {
      assertActive()
      const live = records.get(threadId)
      if (live) return snapshotOf(live)
      const info = await findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      return snapshotFromSessionFile(info)
    },

    async sendMessage(threadId, input) {
      assertActive()
      const token: StartingSend = { cancelled: false }
      let tokens = startingSends.get(threadId)
      if (!tokens) {
        tokens = new Set()
        startingSends.set(threadId, tokens)
      }
      tokens.add(token)
      try {
        const record = await ensureOpen(threadId)
        if (token.cancelled) {
          emit(record, { type: 'agent_end', cancelledBeforeStart: true })
          return
        }
        // 取消判断合并两个来源：冷打开窗口的 token 与 record 上的在途取消标记。
        await send(record, input, () => token.cancelled)
      } finally {
        tokens.delete(token)
        if (tokens.size === 0) startingSends.delete(threadId)
      }
    },

    async cancelRun(threadId) {
      const tokens = startingSends.get(threadId)
      if (tokens) for (const token of tokens) token.cancelled = true
      const record = records.get(threadId)
      if (!record) return
      // 同时标记在途发送（含预检），使它们在预检结束后不再启动运行；
      // 并解除阻断式 UI 等待（否则运行可能在等一个永不应答的对话）。
      for (const pending of record.inFlight) pending.cancelled = true
      record.uiBridge.dismissAll()
      await record.session.abort()
    },

    async clearQueue(threadId) {
      const record = records.get(threadId)
      if (!record) return { steering: [], followUp: [] }
      return record.session.clearQueue()
    },

    async getAvailableModels() {
      assertActive()
      return listModelCatalog(modelRuntime)
    },

    async setModel(threadId, input) {
      const record = await ensureOpen(threadId)
      const model = modelRuntime.getModel(input.provider, input.modelId)
      if (!model)
        throw new Error(`${input.provider}/${input.modelId} is not in Pi's model registry`)
      await record.session.setModel(model)
      record.lastError = undefined
      emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    async setThinkingLevel(threadId, level: HarnessThinkingLevel) {
      const record = await ensureOpen(threadId)
      await record.session.setThinkingLevel(level)
    },

    async renameThread(threadId, title) {
      const record = records.get(threadId)
      if (record) {
        record.session.setSessionName(title)
        invalidateCatalog(record.workspacePath)
        return
      }
      const info = await findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      SessionManager.open(info.path).appendSessionInfo(title)
      invalidateCatalog(info.cwd || workspacePath)
    },

    async archiveThread(threadId) {
      const record = records.get(threadId)
      const info = record ? undefined : await findSessionInfo(threadId)
      const sessionFile = record?.session.sessionFile ?? info?.path
      if (!sessionFile) throw new Error(`Unknown thread: ${threadId}`)
      archivedSessionFiles.add(sessionFile)
      invalidateCatalog(record?.workspacePath ?? info?.cwd ?? workspacePath)
      if (record) emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    async unarchiveThread(threadId) {
      const info = await findSessionInfo(threadId)
      if (info) archivedSessionFiles.delete(info.path)
      const record = records.get(threadId)
      if (record) emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    deleteThread(threadId) {
      const pending = pendingDeletes.get(threadId)
      if (pending) return pending
      const deletion = deleteThreadNow(threadId).finally(() => {
        if (pendingDeletes.get(threadId) === deletion) pendingDeletes.delete(threadId)
      })
      pendingDeletes.set(threadId, deletion)
      return deletion
    },

    async respondToHostUiRequest(threadId, response: HarnessHostUiResponse) {
      records.get(threadId)?.uiBridge.resolve(response)
    },

    subscribe(threadId, listener, subOptions) {
      let active = true
      let record: ThreadRecord | undefined
      ensureOpen(threadId)
        .then((opened) => {
          if (!active) return
          record = opened
          opened.listeners.add(listener)
          if (subOptions?.includeSnapshot !== false) {
            try {
              listener({
                type: 'snapshot',
                snapshot: snapshotOf(opened),
                threadId,
                seq: opened.seq,
              })
            } catch {
              // 订阅者抛错不影响其他订阅者。
            }
          }
        })
        .catch((error: unknown) => {
          if (active) {
            try {
              listener({
                type: 'error',
                error: error instanceof Error ? error.message : String(error),
                threadId,
                seq: 0,
              })
            } catch {
              // 同上。
            }
          }
        })
      return () => {
        active = false
        record?.listeners.delete(listener)
      }
    },
  }

  /** 冷读快照（不经 AgentSession）。 */
  const snapshotFromSessionFile = (info: SessionCatalogInfo): HarnessThreadSnapshot => {
    const sessionManager = SessionManager.open(info.path)
    const branch = sessionManager.getBranch() as unknown as HarnessAnySessionEntry[]
    const context = sessionManager.buildSessionContext()
    const contextWindow = context.model
      ? (modelRuntime.getModel(context.model.provider, context.model.modelId)?.contextWindow ?? 0)
      : 0
    const contextUsage = deriveContextUsage(contextWindow, branch, context.messages)
    const metadata = mapColdMetadata(
      info,
      branch,
      {
        messages: context.messages,
        thinkingLevel: context.thinkingLevel,
        model: context.model,
      },
      { archived: archivedSessionFiles.has(info.path), ...(contextUsage ? { contextUsage } : {}) },
    )
    return {
      metadata,
      messages: context.messages as HarnessAgentMessage[],
      readiness: readinessFromSessionContext(context),
    }
  }

  return {
    ...client,
    async dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      for (const pending of pendingOpens.values()) pending.controller.abort()
      pendingOpens.clear()
      for (const record of [...records.values()]) {
        // 使在途发送失效，并解除阻断式 UI 等待（避免 abort 等不到对话）。
        for (const pending of record.inFlight) pending.cancelled = true
        record.uiBridge.dismissAll()
        try {
          await record.session.abort()
        } catch {
          // 单个会话中止失败不阻断其余清理。
        }
        record.unsubscribe()
        await emitShutdown(record, 'quit')
        record.session.dispose()
      }
      records.clear()
      recordsBySessionFile.clear()
    },
    diagnostics: () => [...diagnostics],
  }
}

/** 冷读分支记录的最小形状（协议镜像）。 */
export { baseName }
