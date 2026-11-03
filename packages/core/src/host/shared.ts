/**
 * Node 宿主共享类型、错误与无所有权工具。
 *
 * 本模块只放跨服务共用且不持有资源的数据形状：record/装配类型、取消上下文、
 * 超时与并发工具。会话、装配、目录、操作协调器的可变状态仍归各自模块。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  AgentSession,
  createAgentSessionFromServices,
  ExtensionCommandContextActions,
  InlineExtension,
  ResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { McpIntegration } from '@huan/mcp'
import type {
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashResult,
  HarnessBashStartResult,
  HarnessClientEvent,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessCompactionReason,
  HarnessModelInfo,
  HarnessModelRefreshResult,
  HarnessProjectInfo,
  HarnessReloadOperation,
  HarnessReloadResult,
  HarnessSendMessageResult,
  HarnessThinkingLevel,
  HarnessThreadForkResult,
  HarnessThreadHostUi,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessThreadTreeOperation,
  HarnessToolExecutionSnapshot,
  HarnessTreeCancelResult,
  HarnessTreeLabelResult,
  HarnessTreeNavigateResult,
} from '@huan/protocol'
import type { HostUiBridge } from '../host-ui.js'
import type { SessionCatalogInfo } from '../metadata.js'
import type { ProjectTrustResult, ProjectTrustState } from '../project-trust.js'
import type { BoundResourceLoaderTrust } from '../resource-reload.js'
import type { ResolvedSessionDir } from '../session-dir.js'
import type { WorkspaceSnapshot } from '../workspace-path.js'

/** 宿主动作选项。 */
export type HarnessHostOptions = {
  /** 默认工作目录（listThreads/createThread 未指定时使用）。 */
  workspacePath: string
  /**
   * Pi 配置目录（用户空间）。
   * 未提供时用 Pi 的 `getAgentDir()`（读取 `PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`）；
   * 宿主创建时解析为绝对路径并固定，auth/models/settings/资源/默认会话均使用它。
   */
  agentDir?: string
  /**
   * 会话存储目录覆盖（对应 CLI 的 `--session-dir`）。
   * 设置后所有 cwd 共享该平铺目录；未设置时按优先级读取
   * `PI_CODING_AGENT_SESSION_DIR` → 启动工作区合并后的 `sessionDir` setting →
   * 默认 `<agentDir>/sessions/<编码 cwd>`。宿主创建时固定。
   */
  sessionDir?: string
  /**
   * 覆盖默认模型（最高优先级；通常由环境变量解析后传入）。
   * 未提供时，新建会话交 SDK 按 settings 解析；冷打开永不传模型。
   */
  model?: HarnessDefaultModel
  /** 启动时是否允许联网刷新模型目录（默认 true）。 */
  refreshCatalogOnStart?: boolean
  /** 目录刷新超时（毫秒；默认 15000；0 表示不设超时）。 */
  catalogRefreshTimeoutMs?: number
  /**
   * 受约束的资源装配选项（测试隔离用）。
   * 只影响 Skills/模板/主题/上下文等发现的开关；宿主输入守卫始终追加，不可替换。
   */
  resourceLoaderOptions?: import('../model-catalog.js').HarnessResourceLoaderOptions
}

/** 默认模型的宽松形状（SDK Model 的透明转发）。 */
export type HarnessDefaultModel = NonNullable<
  Parameters<typeof createAgentSessionFromServices>[0]['model']
>

/** 项目尚未取得信任决定：拒绝创建/激活会话。 */
export class ProjectTrustRequiredError extends Error {
  readonly code = 'project-needs-trust'
  constructor(readonly project: HarnessProjectInfo) {
    super(`Project requires a trust decision: ${project.path}`)
    this.name = 'ProjectTrustRequiredError'
  }
}

/** 扩展命令上下文能力尚未实现（reload/shutdown 等）。 */
export class UnsupportedHostCommandActionError extends Error {
  readonly code = 'host-command-action-unsupported'
  readonly action: string
  constructor(action: string) {
    super(
      `宿主暂不支持扩展命令上下文操作 “${action}”；该能力将在配置/资源阶段提供，` +
        '请勿以空结果继续。',
    )
    this.name = 'UnsupportedHostCommandActionError'
    this.action = action
  }
}

/** 结构操作互斥：会话已有结构操作或发送/运行在飞时返回 busy。 */
export class ThreadStructureBusyError extends Error {
  readonly code = 'thread-structure-busy'
  constructor(message = '会话结构操作进行中，请稍后再试') {
    super(message)
    this.name = 'ThreadStructureBusyError'
  }
}

/**
 * 已知内置 slash 命令被直接提交为普通 prompt。
 *
 * GUI 应在应用层路由内置动作；宿主守卫用于阻止其他客户端绕过 GUI，
 * 把“/model”等文本发给模型冒充执行。扩展/模板/skill 与未知 slash 不受影响。
 */
export class ReservedBuiltinCommandError extends Error {
  readonly code = 'reserved-builtin-command'
  constructor(readonly command: string) {
    super(`内置命令 /${command} 必须经 GUI 入口执行，不能作为普通 prompt 发送`)
    this.name = 'ReservedBuiltinCommandError'
  }
}

/** 当前模型不接受图片输入；提交前拒绝并保留调用方的草稿。 */
export class ImageInputUnsupportedError extends Error {
  readonly code = 'image-input-unsupported'
  constructor(
    readonly provider: string | undefined,
    readonly modelId: string | undefined,
  ) {
    const name = provider && modelId ? `${provider}/${modelId}` : '当前模型'
    super(`${name} 未声明图像输入能力，无法发送图片附件`)
    this.name = 'ImageInputUnsupportedError'
  }
}

/** 一次装载的项目信任结果与输入守卫绑定槽（loader 只服务一个 live session）。 */
export type PreparedProject = {
  trust: ProjectTrustResult
  guard: { record?: ThreadRecord }
  /**
   * 会话级工作区绑定。
   *
   * loader 在信任查询/启动阶段就可能装配，因此这里用可变槽延迟绑定：
   * 一个 loader 只被一个 live session 消费，消费时写入会话归属；扩展
   * 每次运行开始读取该槽对应的最新工作区定义。查询阶段未绑定时不注入
   * 工作区工具提示。
   */
  workspaceBinding: {
    workspaceId?: string
    /** SDK 实际加载的指令文件（reload 后填充，避免推算）。 */
    loadedInstructionPaths: readonly string[]
    onApplied?: (workspace: WorkspaceSnapshot | null) => void
  }
  /** loader 的宿主信任检查绑定：重载后就地更新 trust.state。 */
  trustBinding: BoundResourceLoaderTrust
  /** 本装配的 MCP 集成 binding；随会话创建/查询装配，由宿主统一关闭。 */
  mcp: McpIntegration
}

/** 每 cwd 的项目状态缓存与可复用的启动/决定装配。 */
export type ProjectRuntime = {
  cwd: string
  info: HarnessProjectInfo
  settingsManager: SettingsManager
  defaultModel: ReturnType<typeof import('../model-catalog.js').resolveDefaultModel>
  /**
   * 已装配但尚未被会话消费的 loader。
   *
   * 启动引导与信任决定都只需要装配一次；首个会话直接复用它，避免扩展工厂
   * 在同一轮启动里重复执行。一个 loader 只能绑定一个 live session。
   */
  pending?: PreparedProject
  /**
   * 最近一次装配的 loader（只读清单用）。
   *
   * 空白页查询设置/资源时复用该装配结果，不重新执行扩展；热会话优先使用
   * 正在服务该会话的 loader，见 `resourceInventoryNow`。
   */
  lastLoader?: { loader: ResourceLoader; settings: SettingsManager }
}

/**
 * SDK 命令上下文的会话替换参数与替换后上下文类型。
 *
 * 根入口未导出 `ReplacedSessionContext`，这里从公开的
 * `ExtensionCommandContextActions` 推导，避免私有深导入。
 */
export type CommandNewSessionOptions = NonNullable<
  Parameters<ExtensionCommandContextActions['newSession']>[0]
>
export type ReplacedSessionContext = Parameters<
  NonNullable<CommandNewSessionOptions['withSession']>
>[0]

/** 每会话的扩展 UI 可变状态（统一由 snapshotOf 投影）。 */
export type ThreadHostUiState = {
  statuses: Map<string, string>
  widgets: Map<
    string,
    { lines: string[]; placement: import('@huan/protocol').HarnessHostUiWidgetPlacement }
  >
  notifications: import('@huan/protocol').HarnessHostUiNotification[]
  notificationCounter: number
  /** 已报告过不支持的终端专属方法（每会话只提示一次）。 */
  unsupportedReported: Set<string>
  title: string | undefined
  workingMessage: string | undefined
  workingVisible: boolean | undefined
  hiddenThinkingLabel: string | undefined
  editorDirective: import('@huan/protocol').HarnessHostUiEditorDirective | undefined
  commandTarget: import('@huan/protocol').HarnessHostUiCommandTarget | undefined
}

/** 当前工具的瞬态状态；只保留活动调用，结束即移除，不形成第二份执行历史。 */
export type ActiveToolExecution = HarnessToolExecutionSnapshot

export type ThreadRecord = {
  threadId: string
  session: AgentSession
  /** 会话记录管理器（标题推导需从完整记录语义读取，而非投影后的消息）。 */
  sessionManager: SessionManager
  /** 本会话装配的 settings（branchSummary.skipPrompt 等展示用）。 */
  settingsManager: SettingsManager
  uiBridge: HostUiBridge
  /**
   * 运行期扩展 UI 状态（setStatus/widget/title/通知/编辑器指令）。
   * 每次变化都经权威快照广播；会话 retire 时随 record 释放。
   */
  hostUi: ThreadHostUiState
  unsubscribe: () => void
  listeners: Set<(event: HarnessClientEvent) => void>
  seq: number
  turnIndex: number
  /** 固定起始 cwd（不是工作区 ID）。 */
  workspacePath: string
  workspaceId: string | undefined
  /** 本轮实际应用的工作区 revision；未运行或刚改归属时可能缺失。 */
  workspaceAppliedRevision: number | undefined
  workspaceBinding: PreparedProject['workspaceBinding']
  lastError: string | undefined
  /** SDK 在恢复/默认解析时回退模型的原因；只保存受控字段。 */
  modelFallback: HarnessThreadMetadata['modelFallback']
  /** 活动工具调用瞬态（重连快照可恢复；工具结束后移除）。 */
  activeTools: Map<string, ActiveToolExecution>
  /** 该会话的资源加载器（用于 dispose 时补发 session_shutdown）。 */
  resourceLoader: ResourceLoader
  /** loader 的信任检查绑定：重载后就地更新，是 live 会话的信任权威。 */
  trustBinding: BoundResourceLoaderTrust
  /** 本会话的 MCP 集成 binding；删除/销毁时由宿主主动关闭。 */
  mcp: McpIntegration
  /** 在途发送（含预检阶段），取消/删除需使它们全部失效并等待退出。 */
  inFlight: Set<InFlightSend>
  /** 当前运行的归属与结局候选（agent_start 建立、agent_settled 结算）。 */
  currentRun: CurrentRun | undefined
  /** 当前/最近一条用户 Shell；持久化为历史消息后才清除。 */
  bash: UserBashRun | undefined
  /** 压缩触发原因（进行中）；由 compaction_start/end 事件维护。 */
  compactionReason: HarnessCompactionReason | undefined
  /** 最近一次压缩失败原因（成功/取消时清除）；取消不算失败。 */
  lastCompactionError: string | undefined
  /** 最近一次 compaction_end 是否为取消（供手动压缩结果映射）。 */
  lastCompactionAborted: boolean
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
  /**
   * 单会话结构闸门：导航/标签/模型/Thinking/重命名/资源重载在同一窗口内互斥。
   * 同步占用（不先 await），发送在预检前检查它并明确拒绝 busy。
   */
  structure: StructureOperation | undefined
  /** 资源版本：成功重载后递增，供命令目录/设置面板失效旧查询结果。 */
  resourceRevision: number
  /** 最近一次（或进行中的）资源重载操作；从未重载时缺失。 */
  reload: HarnessReloadOperation | undefined
}

/** 结构操作种类（只用于互斥与 UI 提示）。 */
export type StructureKind =
  | 'navigate'
  | 'label'
  | 'model'
  | 'thinking'
  | 'rename'
  | 'fork'
  | 'compact'
  | 'reload'
  | 'mcp'

/** 用户 Shell（`!` / `!!`）的宿主内状态（含实时输出与完成标记）。 */
export type UserBashRun = {
  id: string
  command: string
  excludeFromContext: boolean
  cwd: string
  status: 'running' | 'complete'
  output: string
  outputTruncated: boolean
  startedAt: string
  result?: HarnessBashResult
  /** 覆盖 user_bash 扩展等待窗口，防取消后再启动命令。 */
  cancelRequested: boolean
  /** SDK 已接受结果；等待其 pending 队列落盘后可释放完成卡。 */
  recorded: boolean
  /** 实际执行结束（含取消/失败）时 resolve。 */
  done: Promise<void>
}

/** 一次结构操作的租约；`settled` 供删除/销毁在收尾前排空。 */
export type StructureOperation = {
  kind: StructureKind
  targetId?: string
  status: 'running' | 'summarizing'
  /** 分支摘要模型请求是否仍在进行（cancel 只对此生效）。 */
  summaryActive: boolean
  startedAt: string
  settled: Promise<void>
  markSettled: () => void
  /** 取消可中断的部分（分支摘要）；不等待，只发出中止信号。 */
  cancel: () => void
}

export type InFlightSend = {
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
export type RunAdmission = {
  /** 启动窗口结束（预检结算或发送退出）时 resolve。 */
  done: Promise<void>
  /** 释放启动窗口（幂等）。 */
  release: () => void
}

/**
 * 当前运行的归属与结局候选。
 *
 * 取消判定必须绑定「当前这次运行」，不能扫描整个在途发送集合：
 * 否则已取消的 A 仍停在预检、而 B 真实失败时，B 的失败会被 A 的取消吞掉。
 */
export type CurrentRun = {
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

/** 当前命令所属的发送不应阻塞其自身的结构操作。 */
export const hasOtherInFlight = (record: ThreadRecord): boolean => {
  const current = sendContext.getStore()
  return [...record.inFlight].some((send) => send !== current)
}

/**
 * 当前 prompt 的身份（供输入守卫精确归属，而非按文本猜测）。
 *
 * 为什么不用文本匹配：SDK 的 `emitInput()` 会把前一个 hook 的
 * `transform.text` 传给后续 handler，被改写的文本会让匹配失效；
 * 同一文本的多次发送也无法区分。用 `AsyncLocalStorage` 沿
 * `prompt()` 的调用链传递发送对象，守卫即可直接读当前发送的取消状态。
 */
export const sendContext = new AsyncLocalStorage<InFlightSend | undefined>()

/**
 * 调用方窗口上下文（不进入 Pi 会话记录）。
 *
 * 由 HTTP 层的 `x-huan-caller` 头传入 `sendMessage`，沿 `prompt()` 的异步链
 * 传播；扩展命令/工具中的 setEditorText/getEditorText 据此定向到发起窗口。
 * 无调用方的后台扩展得到空串，只能生成“请窗口主动接受”的指令。
 */
export const callerContext = new AsyncLocalStorage<string | undefined>()

/**
 * 宿主输入守卫（合成扩展）：在 SDK 的 input 拦截点否决「已取消 / 已退休」的输入。
 *
 * 为什么需要：SDK 在 input hook 之后才做「流式中 → 入队 / 空闲 → 启动运行」的
 * 分流，预检期间的取消无法回撤已进入该路径的输入（可能泄漏进队列供下次运行
 * 执行，或在退休后仍启动运行）。`input` 事件的 `handled` 是 SDK 自带的「提交前」
 * 否决点；合成扩展排在文件扩展之后，因此能覆盖「其它扩展 hook 期间发生取消」
 * 这一最宽的窗口。
 */
export function createInputGuardExtension(
  getRecord: () => ThreadRecord | undefined,
): InlineExtension {
  return {
    name: 'huan-input-guard',
    hidden: true,
    factory: (pi) => {
      pi.on('input', () => {
        const record = getRecord()
        const current = sendContext.getStore()
        if (!record) return undefined
        if (record.retired || (record.structure && !current)) return { action: 'handled' as const }
        // 属于宿主发送的输入：直接看该发送的取消状态（不依赖文本）。
        if (current?.cancelled === true) return { action: 'handled' as const }
        return undefined
      })
    },
  }
}

export type StartingSend = { cancelled: boolean }

/** 会话收尾（删除/销毁）等待在途发送退出的上限：SDK 层无法中断输入 hook。 */
export const RETIRE_DRAIN_TIMEOUT_MS = 5_000

/** 结构操作收尾等待上限（导航摘要/扩展 hook 可能阻塞）。 */
export const STRUCTURE_SETTLE_TIMEOUT_MS = 5_000

/** 运行中导航：停止并等待运行结算的上限（超时则明确返回 busy，不挂死）。 */
export const STOP_FOR_NAVIGATION_TIMEOUT_MS = 10_000

/**
 * 会话收尾等待 `session.abort()` 返回的上限。
 *
 * Pi 1.4 的 `abort()` 会 `await waitForIdle()`，而运行可能停在无法中断的扩展
 * hook（`input` / `before_agent_start`）里；此时若无限等待，删除/断开会挂死。
 * 超时后继续收尾（会话即将 dispose/退订，不再有模型请求），与
 * `RETIRE_DRAIN_TIMEOUT_MS` 的已知限制同口径。
 */
export const RETIRE_ABORT_TIMEOUT_MS = 5_000

/** 收尾用中止：有上限、不抛错（单会话中止失败不阻断其余清理）。 */
export async function abortForRetire(session: AgentSession): Promise<void> {
  await withTimeout(session.abort(), RETIRE_ABORT_TIMEOUT_MS, '会话中止').catch(() => {})
}

/** 默认空间跨分组枚举的并发上限（与 Pi 自身目录发现的保守值一致）。 */
export const SCOPE_LIST_CONCURRENCY = 8

/**
 * 用户 Shell 实时输出的有界上限（字符）。
 *
 * 目的：断线重连时快照不会携带无限增长的无界输出；超出时丢弃前缀并
 * 在增量事件里告知客户端 `dropped`，使两侧缓冲保持一致。
 */
export const BASH_OUTPUT_MAX_CHARS = 120_000

/** 按上限并发执行（结果保持输入顺序）。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 丢弃 SDK 在结算窗口内缓冲的延迟动作（`_deferredSettledActions`）。
 *
 * 为什么需要：扩展 `sendMessage(..., { triggerTurn: true })` 在结算窗口
 * （`_isEmittingAgentSettled`）会被压入该数组，稍后由 SDK 直接调
 * `_runAgentPrompt` 启动运行（agent-session.js:1805）——该路径不经输入守卫、
 * 不经 `preflightResult`，取消/退休时必须主动丢弃，否则会在取消后仍发出
 * 模型请求（已由测试证实：不丢弃时 fetch 计数 +1）。
 *
 * 注：SDK 未暴露公开 API；字段缺失时保留 `agent_start` 无归属清扫，
 * 同时报告一次诊断，便于升级核对。
 */
let deferredRunsShapeReported = false
export const discardDeferredRuns = (
  session: AgentSession,
  onMissing?: (message: string) => void,
): void => {
  const internal = session as unknown as { _deferredSettledActions?: unknown[] }
  if (Array.isArray(internal._deferredSettledActions)) {
    internal._deferredSettledActions.length = 0
    return
  }
  if (!deferredRunsShapeReported) {
    deferredRunsShapeReported = true
    // 字段缺失不等同于存在问题：agent_start 清扫仍兜底；只记录一次以便诊断。
    const message = 'SDK 延迟动作字段缺失，取消清扫退化为 agent_start 守卫'
    console.warn(`[huan-core] ${message}`)
    onMissing?.(message)
  }
}

/** 给承诺加超时（0 或负数表示不设超时）。 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
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

/** 只读目录信息到会话基础投影的共用类型。 */
export type SessionInfo = SessionCatalogInfo
/** 目录作用域类型别名，避免各模块重复导入。 */
export type SessionScope = ResolvedSessionDir
/** 信任状态别名。 */
export type TrustState = ProjectTrustState

/** 操作结果联合的常用子集（仅用于跨模块声明）。 */
export type SessionOperationResults = {
  bash: HarnessBashStartResult | HarnessBashAbortResult
  compaction: HarnessCompactionOutcome | HarnessCompactionAbortResult
  models: readonly HarnessModelInfo[] | HarnessModelRefreshResult
  fork: HarnessThreadForkResult
  navigate: HarnessTreeNavigateResult
  label: HarnessTreeLabelResult
  cancel: HarnessTreeCancelResult
  reload: HarnessReloadResult
  autoCompaction: HarnessAutoCompactionUpdateResult
}

export type SessionSnapshotView = {
  metadataOf(record: ThreadRecord): HarnessThreadMetadata
  snapshotOf(record: ThreadRecord): HarnessThreadSnapshot
  treeOperationView(record: ThreadRecord): HarnessThreadTreeOperation | undefined
  treeOf(record: ThreadRecord): HarnessThreadTree
}

/** 发送结果别名。 */
export type SendResult = HarnessSendMessageResult
/** Thinking 级别别名。 */
export type ThinkingLevel = HarnessThinkingLevel
/** 快照投影使用的运行 UI 类型。 */
export type HostUiView = HarnessThreadHostUi | undefined
