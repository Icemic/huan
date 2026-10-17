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
 *   删除先 abort 再 dispose 再 unlink；订阅先快照后实时（同一 record、同一 seq 边界）。
 * - **取消与失败口径**：取消以 SDK 的 `agent_settled.aborted` 为权威，
 *   不向前端报告为失败；失败在 `agent_settled` 时结算（不在 `agent_end`，
 *   因为其后仍可能重试/压缩/继续）。
 * - **预检取消兜底（SDL 缺口补偿）**：SDK 的 `abort()` 只在运行激活后生效，
 *   预检期（input hook / 认证 / before_agent_start）的取消需宿主自行兜底，
 *   由三件机制协作（详见 `acquireAdmission` / `createInputGuardExtension` /
 *   `onSessionEvent` 的注释）：准入闸门串行化「预检 → 运行确认」段、
 *   输入守卫在 SDK 提交点否决已取消输入、`agent_start` 时中止已取消的运行。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { unlink } from 'node:fs/promises'
import {
  type AgentSession,
  createAgentSessionFromServices,
  ExtensionRunner,
  type InlineExtension,
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
  deriveReadiness,
  extractMessageText,
  mapColdMetadata,
  mapQueuedMessages,
  mapSessionInfo,
  normalizeTitle,
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
  /** 会话记录管理器（标题推导需从完整记录语义读取，而非投影后的消息）。 */
  sessionManager: SessionManager
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
  /** 当前运行的归属与结局候选（agent_start 建立、agent_settled 结算）。 */
  currentRun: CurrentRun | undefined
  /**
   * 启动窗口的准入控制（每会话同时至多一个发送处于预检→运行确认段）。
   * 作用：防止两个发送并发越过 SDK 的预检，后到者的运行收尾提前结算前者。
   */
  admission: RunAdmission | undefined
  /** 等待准入闸门的发送（取消/退休时唤醒，使其重新检查并尽快退出）。 */
  admissionWaiters: Set<() => void>
  /** 已确认「即将启动运行」、尚未被 `agent_start` 消费的发送（归属单槽）。 */
  startingSend: InFlightSend | undefined
  /** 会话是否已进入收尾（删除/销毁）：此后不再启动新运行，等待者放弃。 */
  retired: boolean
  /**
   * 需要清扫「下一无归属运行」：取消时会置位。
   *
   * 背景：SDK 的延迟动作（`_deferredSettledActions`，如扩展的
   * `sendMessage(..., { triggerTurn: true })`）可能在取消之后启动一个
   * 不属于任何宿主发送（owner 为空）的运行；宿主只能凭此标记在
   * `agent_start` 处中止它，否则取消后仍会发出模型请求。
   */
  sweepUnattendedRun: boolean
  /** 缓存的首条用户消息文本（仅存找到的值；历史只追加，找到后不变）。 */
  firstUserMessageText?: string | undefined
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

/**
 * 发送的启动窗口（宿主侧准入控制）。
 *
 * SDK 的 `prompt()` 在「预检通过」与「运行建立」之间可被其他发送交错：
 * 两者都能越过 `isStreaming` 检查，后到者进入 `_runAgentPrompt()` 后会在
 * 其 finally 中发出 `agent_settled`，提前结算前者的运行（已核对源码：
 * `_runAgentPrompt()` 的 finally 无条件 `_emitAgentSettled()`）。
 * 因此宿主把「预检 → 运行确认」段串行化：每会话同时至多一个发送处于
 * 启动窗口，后来者在此等待，避免并发越过预检以及取消后的输入被入队。
 */
type RunAdmission = {
  /** 启动窗口结束（预检结算或发送退出）时 resolve。 */
  done: Promise<void>
  /** 释放启动窗口（幂等）。 */
  release: () => void
}

/**
 * 当前运行的归属与结局候选。
 *
 * 取消判定必须绑定「当前这次运行」，不能扫描整个在途发送集合：
 * 否则已取消的 A 仍停在预检、而 B 真实失败时，B 的失败会被 A 的取消标记吞掉。
 */
type CurrentRun = {
  /** 触发本次运行的发送（若运行由扩展等外部入口触发则为空）。 */
  owner: InFlightSend | undefined
  /** 运行自身是否被取消（由 agent_start 时的中止或 agent_settled.aborted 置位）。 */
  cancelled: boolean
  /** 候选失败信息：agent_end 时记录，agent_settled 时按取消状态裁定。 */
  pendingError: string | undefined
  /** 运行结算完毕（agent_settled 处理完）后 resolve；供取消后的等待者挂起，免轮询。 */
  settled: Promise<void>
  /** 标记结算完毕（内部使用）。 */
  markSettled: () => void
}

/**
 * 当前 prompt 的身份（供输入守卫精确归属，而非按文本猜测）。
 *
 * 为什么不用文本匹配：SDK 的 `emitInput()` 会把前一个 hook 的
 * `transform.text` 传给后续 handler，被改写的文本会让匹配失效；
 * 同一文本的多次发送也无法区分。用 `AsyncLocalStorage` 沿
 * `prompt()` 的调用链传递发送对象，守卫即可直接读当前发送的取消状态。
 */
const sendContext = new AsyncLocalStorage<InFlightSend | undefined>()

/**
 * 宿主输入守卫（合成扩展）：在 SDK 的 input 拦截点否决「已取消 / 已退休」的输入。
 *
 * 为什么需要：SDK 在 input hook 之后才做「流式中 → 入队 / 空闲 → 启动运行」的
 * 分流，预检期间的取消无法回撤已进入该路径的输入（可能泄漏进队列供下次运行
 * 执行，或在退休后仍启动运行）。`input` 事件的 `handled` 是 SDK 自带的「提交前」
 * 否决点；合成扩展排在文件扩展之后，因此能覆盖「其它扩展 hook 期间发生取消」
 * 这一最宽的窗口。
 */
function createInputGuardExtension(getRecord: () => ThreadRecord | undefined): InlineExtension {
  return {
    name: 'huan-input-guard',
    hidden: true,
    factory: (pi) => {
      pi.on('input', () => {
        const record = getRecord()
        const current = sendContext.getStore()
        if (!record) return undefined
        if (record.retired) return { action: 'handled' as const }
        // 属于宿主发送的输入：直接看该发送的取消状态（不依赖文本）。
        if (current?.cancelled === true) return { action: 'handled' as const }
        return undefined
      })
    },
  }
}

type StartingSend = { cancelled: boolean }

/** 会话收尾（删除/销毁）等待在途发送退出的上限：SDK 层无法中断输入 hook。 */
const RETIRE_DRAIN_TIMEOUT_MS = 5_000

/**
 * 丢弃 SDK 在结算窗口内缓冲的延迟动作（`_deferredSettledActions`）。
 *
 * 为什么需要：扩展 `sendMessage(..., { triggerTurn: true })` 在结算窗口
 * （`_isEmittingAgentSettled`）会被压入该数组，稍后由 SDK 直接调
 * `_runAgentPrompt` 启动运行（agent-session.js:1805）——该路径不经输入守卫、
 * 不经 `preflightResult`，取消/退休时必须主动丢弃，否则会在取消后仍发出
 * 模型请求（已由测试证实：不丢弃时 fetch 计数 +1）。
 *
 * 注：SDK 未暴露公开 API；字段缺失时静默跳过（退化为不拦截，仍由
 * `agent_start` 的无归属清扫兜底）。
 */
const discardDeferredRuns = (session: AgentSession): void => {
  const internal = session as unknown as { _deferredSettledActions?: unknown[] }
  if (Array.isArray(internal._deferredSettledActions)) internal._deferredSettledActions.length = 0
}

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
    const title = deriveLiveTitle(record)
    return {
      id: record.threadId,
      status: runStatus(record),
      compactionActive: session.isCompacting,
      retryActive: session.isRetrying,
      retryAttempt: session.retryAttempt,
      workspacePath: record.workspacePath,
      messageCount: session.messages.length,
      // 标题口径与冷读路径一致：显式会话名 > 首条用户消息（截断）> 会话文件名。
      // 注意：仅「显式命名」会持久化；未命名会话重启后由冷路径推导同一标题。
      ...(title ? { title } : {}),
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

  /**
   * 热会话标题：显式会话名 > 首条用户消息（截断 60）> 会话文件名。
   *
   * 关键：首条用户消息必须从**会话记录（全文件）**读取，而不是：
   * - `session.messages`：压缩感知的投影，压缩后原始首条消息会被省略；
   * - `getBranch()`：仅当前分支，而 Pi 冷目录扫全文件取首条（分支场景会不一致）。
   * 缓存「首条消息文本」而非最终标题：改名/清空名称不影响它，无需失效。
   */
  const deriveLiveTitle = (record: ThreadRecord): string | undefined => {
    const explicit = record.session.sessionName?.trim()
    if (explicit) return explicit
    const firstText = firstUserMessageTextOf(record)
    return normalizeTitle({
      firstMessageText: firstText,
      sessionFilePath: record.session.sessionFile,
    })
  }

  /** 从会话记录（全文件顺序）取首条用户消息文本（带缓存；仅缓存找到的值）。 */
  const firstUserMessageTextOf = (record: ThreadRecord): string | undefined => {
    if (record.firstUserMessageText !== undefined) return record.firstUserMessageText
    for (const entry of record.sessionManager.getEntries()) {
      if (entry.type !== 'message') continue
      const message = (entry as { message?: { role?: string } }).message
      if (message?.role !== 'user') continue
      const text = extractMessageText(message)
      if (text) {
        record.firstUserMessageText = text
        return text
      }
    }
    return undefined
  }

  /**
   * 快照的消息隔离：数组与消息对象都复制。
   *
   * 两个真实的可变源（均已核对 SDK 源码）：
   * 1. `session.messages` 是 agent-core 的活跃数组，后续轮次会直接 push；
   * 2. 扩展在 `message_end` hook 中返回替换消息时，SDK 用
   *    `_replaceMessageInPlace()` **原地改写**已有消息对象（delete + assign），
   *    因此仅复制数组仍不够——已交付给订阅者的消息对象会随后变化。
   *
   * 浅复制单个消息足以覆盖上述两个路径：SDK 内建路径的原地改写只作用于
   * 消息对象的顶层键（替换 `content` 是替换引用，旧快照保留的原引用不受影响）。
   * 注意这是**边界而非全量保证**：扩展若自行修改已有 content 内部结构，
   * 或调用方改动返回值，共享对象仍可能变化。
   */
  const isolateMessages = (messages: readonly unknown[]): HarnessAgentMessage[] =>
    messages.map((message) => ({ ...(message as object) })) as HarnessAgentMessage[]

  const snapshotOf = (record: ThreadRecord): HarnessThreadSnapshot => {
    const pending = record.uiBridge.pending()
    return {
      metadata: metadataOf(record),
      messages: isolateMessages(record.session.messages),
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

    // 运行激活（activeRun 已建立、模型请求尚未发出）时处理预检期取消。
    // 用 agent_start 而非微任务：这是 SDK 语义内的最早稳定时点，
    // 不依赖「preflightResult 回调与运行启动在同一同步块」这类实现细节。
    if (event.type === 'agent_start') {
      if (record.currentRun === undefined) {
        // 一个运行周期开始：消费归属槽。准入闸门保证「预检 → 运行确认」段
        // 每会话串行，因此槽内至多一个发送，且必然属于本次运行。
        const owner = record.startingSend
        record.startingSend = undefined
        let markSettled: () => void = () => {}
        const settled = new Promise<void>((resolve) => {
          markSettled = resolve
        })
        record.currentRun = {
          owner,
          cancelled: owner?.cancelled ?? false,
          pendingError: undefined,
          settled,
          markSettled,
        }
      }
      const run = record.currentRun
      // 中止条件：
      // 1) 归属发送已取消 / 运行自身已取消（常规取消路径）；
      // 2) 会话已退休（延迟动作可能在收尾后启动运行）；
      // 3) 无归属运行 + 清扫标记（SDK 延迟动作在取消后启动的运行）。
      const unattended = run.owner === undefined && !record.retired
      const sweep = unattended && record.sweepUnattendedRun
      if (run.owner?.cancelled || run.cancelled || record.retired || sweep) {
        run.cancelled = true
        record.sweepUnattendedRun = false
        // 同步发起中止（内部置标志并 abort controller），不 await：
        // agent 会等待监听器返回，await 会与 waitForIdle 互锁。
        record.session.abort().catch(() => {})
      } else if (run.owner !== undefined) {
        // 新一轮用户发起的运行：上一次取消的影响到此为止。
        record.sweepUnattendedRun = false
      }
    }

    if (event.type === 'agent_end') {
      // 只记录候选错误，不在此时裁定：agent_end 后 SDK 仍可能重试/压缩/继续。
      // 无条件赋值：「重试成功」的轮次会把候选错误清回 undefined。
      const run = record.currentRun
      if (run) run.pendingError = record.session.state.errorMessage ?? undefined
    }

    // 运行级权威取消标志（SDK 直接取自 _agentRunAbortRequested），不受
    // 消息 stopReason 分类影响（lazyStream 的 setup 失败会把取消写死为 'error'）。
    // 先落地内部状态，再发布事件：同步订阅者在 settled 上必须读到结算后的状态。
    let settledError: string | undefined
    if (event.type === 'agent_settled') {
      const run = record.currentRun
      if (run) {
        if (event.aborted) run.cancelled = true
        if (!run.cancelled) {
          if (run.pendingError !== undefined) {
            record.lastError = run.pendingError
            settledError = run.pendingError
          } else if (record.lastError !== undefined) {
            // 本轮成功结束：清除此前残留的失败状态（失败不在轮次间存留）。
            record.lastError = undefined
          }
        }
        // 取消：保持既有 lastError 不变（取消不消灭此前失败的记录）。
      }
      record.currentRun = undefined
      run?.markSettled()
    }

    const mapped = mapSessionEvent(event, { turnIndex: record.turnIndex })
    if (mapped.kind === 'mapped') emit(record, mapped.event)
    if (settledError !== undefined) emit(record, { type: 'error', error: settledError })

    if (
      event.type === 'turn_end' ||
      event.type === 'agent_end' ||
      event.type === 'compaction_end'
    ) {
      emitContextUsage(record)
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
    // 注入宿主输入守卫（合成扩展，排在文件扩展之后）：在 SDK 的 input 提交点
    // 否决已取消 / 已退休的输入。守卫需要按会话解析 record，用查询函数延迟绑定。
    let guardRecord: ThreadRecord | undefined
    const services = await createHostServices({
      cwd,
      agentDir,
      modelRuntime,
      extensionFactories: [createInputGuardExtension(() => guardRecord)],
    })
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
      sessionManager,
      uiBridge: undefined as unknown as HostUiBridge,
      unsubscribe: () => {},
      listeners: new Set(),
      seq: 0,
      turnIndex: -1,
      workspacePath: cwd,
      lastError: undefined,
      resourceLoader: services.resourceLoader,
      inFlight: new Set(),
      currentRun: undefined,
      admission: undefined,
      admissionWaiters: new Set(),
      startingSend: undefined,
      retired: false,
      sweepUnattendedRun: false,
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
      // agent 级兜底订阅（直连 `session.agent`，**刻意不提供退订**）：
      // 它不受 `session.dispose()` 清理影响（那只断开 agent→session 的转发）。
      // 必要性：SDK 在 `_emitAgentSettled()` 里先 `splice(0)` 把延迟动作取入
      // **局部数组**再逐个 `await`；若退休发生在「第一个动作运行中」，后续
      // 动作就留在这个局部数组里，成员数组清空够不到——只有本订阅能在它们
      // 启动（`agent_start`）时中止（探针实证：不保留则多发出 1 次请求）。
      // 局部批次链的结束没有可靠信号，故永久保留；record 最终成为只被该
      // 闭包引用的孤立环，随会话一起被 GC 回收。
      session.agent.subscribe((event) => {
        if (event.type !== 'agent_start') return
        if (record.retired) {
          // 退休后仍启动的运行：立即中止（不 await，避免与 agent 的监听等待互锁）。
          session.agent.abort()
          return
        }
        // 取消后由延迟动作启动的无归属运行：按清扫标记中止。
        const run = record.currentRun
        if (run && run.owner === undefined && record.sweepUnattendedRun) {
          run.cancelled = true
          record.sweepUnattendedRun = false
          session.agent.abort()
        }
      })
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
    // record 已发布：绑定守卫的目标会话，后续阻断请求输送到订阅者。
    guardRecord = record
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

  /** 唤醒所有等待准入闸门的发送（取消/退休时调用），使其重新检查条件并退出。 */
  const wakeAdmissionWaiters = (record: ThreadRecord): void => {
    for (const wake of [...record.admissionWaiters]) wake()
    record.admissionWaiters.clear()
  }

  /**
   * 等待在途发送退出（会话收尾用）。
   *
   * 有上限：SDK 层无法中断阻塞在输入 hook 里的预检；超时后继续收尾，
   * 此时该发送视为已放弃（不再有能力启动运行——退休标记先行阻止）。
   */
  const drainInFlight = async (record: ThreadRecord): Promise<void> => {
    const waits = [...record.inFlight].map((pending) => pending.finished)
    if (waits.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RETIRE_DRAIN_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 获取启动窗口（准入闸门）。
   *
   * 保证同一会话同时至多一个发送处于「预检 → 运行确认」段（统一占窗，
   * 不在「运行中」时偷跑：否则运行可能先结束、预检后完成，导致两个发送
   * 都走「启动运行」路径而重叠结算）。
   *
   * 返回 undefined 表示放弃本次发送（已取消 / 会话退休）。
   *
   * 为何「任一在途运行」都要等其结算：SDK 在 `_emitAgentSettled()` 期间
   * （`_isEmittingAgentSettled` 为真）会把 `prompt()` 静默压入
   * `_deferredSettledActions` 并立即返回（agent-session.js:1517）；
   * 若此刻放行新发送，宿主会误判「已接受」而移除跟踪，取消再也够不到它。
   *
   * 已知边界：若占窗者的预检被扩展的输入 hook 永久阻塞，后续发送会一直等待
   * （SDK 无法中断 hook）；取消会唤醒等待者退出，但仍会等待阻塞解除。
   */
  const acquireAdmission = async (
    record: ThreadRecord,
    inFlight: InFlightSend,
    isCancelled: () => boolean,
  ): Promise<RunAdmission | undefined> => {
    // 取消来源有二：冷打开窗口的 token（isCancelled）与发送级标记（cancelRun）。
    const cancelled = () => isCancelled() || inFlight.cancelled
    while (true) {
      if (record.retired || cancelled()) return undefined
      const run = record.currentRun
      if (run !== undefined && !record.session.isStreaming) {
        // 「结算窗口」：SDK 已置 `_isAgentRunActive = false`（故 isStreaming 为假）
        // 但仍在 await 扩展的 agent_settled hook；此时 `prompt()` 会被静默压入
        // `_deferredSettledActions` 并立即返回（agent-session.js:1517），宿主会
        // 误判「已接受」而移除跟踪。等它真正结算后再评估。
        // 注册唤醒：本发送自身被取消 / 会话退休时也要能退出。
        let wakeRun: () => void = () => {}
        const wokenRun = new Promise<void>((resolve) => {
          wakeRun = resolve
        })
        record.admissionWaiters.add(wakeRun)
        try {
          await Promise.race([run.settled, wokenRun])
        } finally {
          record.admissionWaiters.delete(wakeRun)
        }
        continue
      }
      // 正常运行中（isStreaming 为真）：交给 SDK 的排队分支（steer/follow-up），
      // 不在此等待——否则排队消息会被推迟到整次运行结算后才送达。
      const current = record.admission
      if (current === undefined) break
      // 等待前一个占窗者的预检结算；期间可被取消/退休路径唤醒以尽快退出。
      let wake: () => void = () => {}
      const woken = new Promise<void>((resolve) => {
        wake = resolve
      })
      record.admissionWaiters.add(wake)
      try {
        await Promise.race([current.done, woken])
      } finally {
        record.admissionWaiters.delete(wake)
      }
    }
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let released = false
    const admission: RunAdmission = {
      done,
      release: () => {
        if (released) return
        released = true
        if (record.admission === admission) record.admission = undefined
        resolveDone()
      },
    }
    record.admission = admission
    return admission
  }

  /**
   * 发送一次 prompt，返回「输入已被接受」的承诺（不等待运行结束）。
   *
   * 预检取消兜底：SDK 的 `abort()` 只在 `_isAgentRunActive` 为真时记录中止意图，
   * 而预检（input hook / 认证检查 / before_agent_start）期间该标志尚未置位，
   * 且 `_runAgentPrompt()` 启动时会重置中止标志——预检期间的取消直接落空。
   * 因此取消意图先随发送登记（`startingSend`），运行激活（`agent_start`）时
   * 取用为当前运行归属并立即中止，阻止模型请求真正发出。
   *
   * 判定口径：一次运行是否属「取消」以 `agent_settled.aborted`（SDK 直接取自
   * `_agentRunAbortRequested`）为权威，不受消息 `stopReason` 分类影响
   * （`lazyStream` 的 setup 失败路径会把取消写死为 `'error'`）。
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

    // 准入闸门：串行化每会话的「预检 → 运行确认」段，防止后到者提前结算前者运行。
    const admission = await acquireAdmission(record, inFlight, isCancelled)
    if (admission === undefined && (record.retired || isCancelled() || inFlight.cancelled)) {
      // 等待期间被取消 / 会话进入收尾：不进入预检，按「未启动即取消」上报。
      emit(record, { type: 'agent_end', cancelledBeforeStart: true })
      record.inFlight.delete(inFlight)
      inFlight.markFinished()
      return
    }

    try {
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

      // 用 AsyncLocalStorage 绑定本次发送：输入守卫据此精确认领（不用文本匹配）。
      // `prompting` 在后台继续（接受语义：不等待运行结束）；其失败已在 catch 内处理。
      void sendContext.run(inFlight, () =>
        record.session
          .prompt(input.content, {
            ...(input.attachments?.length ? { images: input.attachments } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            preflightResult: (disposition) => {
              // 提交点拒绝（已退休 / 已取消）：此刻放行会让 SDK 继续进入
              // `_runAgentPrompt()` 启动运行。
              // - 退休：宿主已退订，无 agent_start 可兜底；
              // - 取消：本发送在闸门等待期间被标记，或以延迟动作身份
              //   在结算窗口后恢复（`_deferredSettledActions`）。
              // 抛错使 prompt 以拒绝收尾（SDK 不捕获此回调异常）。
              if (record.retired) throw new Error('Harness session is retired')
              if (isCancelled() || inFlight.cancelled) throw new Error('Harness send was cancelled')
              inFlight.accepted = true
              settlePreflight()
              // 取消意图统一记入发送级标记。
              if (isCancelled()) inFlight.cancelled = true
              // 仅 'started' 会启动运行；'handled'/'queued' 无独立运行可归属。
              if (disposition !== 'started') return
              record.startingSend = inFlight
              // 运行确认后释放准入闸门：后续发送可以开始它们的预检
              // （SDK 会因运行中而走 queued 分支，不再建立新运行）。
              admission?.release()
            },
          })
          .then(() => {
            settlePreflight()
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            // 已取消 / 已退休的发送被拒（含提交点拒绝与 SDK「Agent is already processing」）：
            // 属取消的预期结果，不记为失败，也不向订阅者抛错误。
            if (inFlight.cancelled || isCancelled() || record.retired) {
              settlePreflight()
              return
            }
            record.lastError = message
            if (preflightSettled) {
              emit(record, { type: 'error', error: message })
            } else {
              settlePreflight(error)
            }
          })
          .finally(() => {
            record.inFlight.delete(inFlight)
            // 运行从未启动（如被拒）时不要留下占用的归属槽。
            if (record.startingSend === inFlight) record.startingSend = undefined
            admission?.release()
            inFlight.markFinished()
          }),
      )

      try {
        await accepted
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        record.lastError = message
        emit(record, { type: 'error', error: message })
        throw error
      }
    } finally {
      // 任一路径退出发送（接受 / 预检异常 / 早起退出）都要释放闸门，
      // 否则后续发送会永久等待（release 幂等）。
      admission?.release()
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
      // 0) 进入收尾：不再接受新运行，并唤醒等待闸门的发送使其退出。
      record.retired = true
      wakeAdmissionWaiters(record)
      // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
      discardDeferredRuns(record.session)
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
      await drainInFlight(record)
      // 5) 收尾：先补发 shutdown（扩展可能在 handler 里再次提交延迟动作），
      //    随后**同步链内**再次清空延迟数组并 dispose，中间不插 await，
      //    否则放行的扩展 hook 会在清空与 dispose 之间启动延迟运行。
      //    注：清空够不到 SDK 已 `splice(0)` 取走的局部批次，那部分由
      //    agent 级兜底订阅在 agent_start 时中止（见 record 字段注释）。
      await emitShutdown(record, 'quit')
      discardDeferredRuns(record.session)
      record.session.dispose()
      record.unsubscribe()
      // 保留 agent 级兜底订阅：局部批次可能在收尾后才启动（见字段注释）。
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
      // 停止语义 = 中止当前运行 + 丢弃尚未送达的排队输入：
      // - 预检中的发送（尚未被接受）标记取消：其运行将在建立后立即被中止；
      // - 当前运行标记取消：使「中止窗口内」的新发送改为等待运行退出并
      //   重新启动，而不是排进一个注定中止的运行（否则会滞留到下次人为触发）；
      // - 已在 SDK 队列中的输入直接丢弃（按停止键的预期语义）；
      // - 已启动的运行交由 abort 中止（其收尾按取消结算，不算失败）。
      for (const pending of record.inFlight) {
        if (!pending.accepted) pending.cancelled = true
      }
      if (record.currentRun) record.currentRun.cancelled = true
      // 丢弃 SDK 缓冲的延迟动作（扩展的 triggerTurn 消息），并置位清扫标记：
      // 它可能在取消后由 SDK 直接启动一个无归属运行。
      discardDeferredRuns(record.session)
      record.sweepUnattendedRun = true
      record.session.clearQueue()
      // 唤醒等待准入闸门的发送（已被取消者可就此退出，不必干等占窗者）。
      wakeAdmissionWaiters(record)
      // 解除阻断式 UI 等待（否则运行可能在等一个永不应答的对话）。
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
        // 进入收尾：不再接受新运行；唤醒等待闸门的发送（随后被取消并排空）。
        record.retired = true
        wakeAdmissionWaiters(record)
        // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
        discardDeferredRuns(record.session)
        // 使在途发送失效，并解除阻断式 UI 等待（避免 abort 等不到对话）。
        for (const pending of record.inFlight) pending.cancelled = true
        record.uiBridge.dismissAll()
        try {
          await record.session.abort()
        } catch {
          // 单个会话中止失败不阻断其余清理。
        }
        // 等待在途发送退出（有上限）。
        await drainInFlight(record)
        // 收尾：先补发 shutdown（扩展可能在 handler 里再次提交延迟动作），随后
        // 同步链内清空延迟数组并 dispose（中间不插 await，否则放行的扩展 hook
        // 会在清空与 dispose 之间启动延迟运行）。清空够不到 SDK 已取走的
        // 局部批次，那部分由 agent 级兜底订阅在 agent_start 时中止。
        await emitShutdown(record, 'quit')
        discardDeferredRuns(record.session)
        record.session.dispose()
        record.unsubscribe()
        // 保留 agent 级兜底订阅：局部批次可能在收尾后才启动（见字段注释）。
      }
      records.clear()
      recordsBySessionFile.clear()
    },
    diagnostics: () => [...diagnostics],
  }
}
