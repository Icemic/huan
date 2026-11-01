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
 * - **存储作用域（G1.1 §3）**：agentDir 与 sessionDir 在宿主创建时解析为绝对路径
 *   并固定（显式 > `PI_CODING_AGENT_SESSION_DIR` > 启动工作区 setting >
 *   `<agentDir>/sessions/<编码 cwd>`）；创建、枚举、按 ID 查找、打开、改名、
 *   删除均限定在该作用域，无覆盖时跨 cwd 只枚举当前 agentDir 下的分组目录。
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
import { realpathSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  type AgentSession,
  type AgentSessionServices,
  createAgentSessionFromServices,
  type ExtensionCommandContextActions,
  ExtensionRunner,
  hasTrustRequiringProjectResources,
  type InlineExtension,
  type LoadExtensionsResult,
  ModelRegistry,
  type ProjectTrustContext,
  ProjectTrustStore,
  type ResourceLoader,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  type SessionStartEvent,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashResult,
  HarnessBashRun,
  HarnessBashStartResult,
  HarnessClient,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessCommandArgumentCompletion,
  HarnessCommandArgumentInput,
  HarnessCommandCatalog,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessCompactionReason,
  HarnessCreateThreadInput,
  HarnessFileSearchInput,
  HarnessFileSearchResult,
  HarnessHostInteractionScope,
  HarnessHostInteractionSnapshot,
  HarnessHostUiCommandTarget,
  HarnessHostUiEditorDirective,
  HarnessHostUiNotification,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessHostUiWidgetPlacement,
  HarnessModelRefreshInput,
  HarnessModelRefreshResult,
  HarnessModelScope,
  HarnessModelScopeDiagnostic,
  HarnessModelScopeUpdateInput,
  HarnessModelScopeUpdateResult,
  HarnessProjectFailureCode,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectTrust,
  HarnessProjectTrustInput,
  HarnessRecentProject,
  HarnessReloadOperation,
  HarnessReloadResult,
  HarnessReloadTargetInput,
  HarnessReloadTrigger,
  HarnessResourceQueryInput,
  HarnessResourceSnapshot,
  HarnessSendMessageInput,
  HarnessSendMessageOptions,
  HarnessSendMessageResult,
  HarnessSettingsSaveInput,
  HarnessSettingsSaveResult,
  HarnessSettingsSnapshot,
  HarnessSettingsTarget,
  HarnessSettingsTargetInput,
  HarnessThinkingLevel,
  HarnessThreadDetails,
  HarnessThreadForkInput,
  HarnessThreadForkResult,
  HarnessThreadHostUi,
  HarnessThreadImportErrorCode,
  HarnessThreadImportInput,
  HarnessThreadImportPreview,
  HarnessThreadImportPreviewInput,
  HarnessThreadImportResult,
  HarnessThreadImportSource,
  HarnessThreadImportSourceInfo,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessThreadTreeOperation,
  HarnessTreeCancelResult,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
  HarnessTreeQueueRecovery,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceMutationResult,
  HarnessWorkspaceProject,
} from '@huan/protocol'
import { builtinCommandNameOf } from '@huan/protocol'
import { createBuiltinExtensionFactories } from './builtin-extensions.js'
import { deriveContextUsage } from './context-usage.js'
import { mapSessionEvent } from './event-mapping.js'
import { createHostInteractions } from './host-interactions.js'
import { createHostUiBridge, type HostUiBridge } from './host-ui.js'
import {
  extractMessageText,
  mapColdMetadata,
  mapQueuedMessages,
  mapSessionInfo,
  normalizeTitle,
  type SessionCatalogInfo,
} from './metadata.js'
import {
  createSharedModelRuntime,
  getModelReadiness,
  type HarnessResourceLoaderOptions,
  listModelCatalog,
  refreshModelCatalog,
  resolveDefaultModel,
  toResourceLoaderOptions,
} from './model-catalog.js'
import {
  type ProjectTrustResult,
  type ProjectTrustSource,
  prepareProjectTrust,
} from './project-trust.js'
import { resourceSnapshotOf } from './resource-inventory.js'
import {
  commandArgumentsFromLoader,
  commandArgumentsFromSession,
  commandCatalogFromLoader,
  commandCatalogFromSession,
  type FileSearchRoot,
  searchWorkspaceFiles,
} from './resource-queries.js'
import {
  type BoundResourceLoaderTrust,
  bindResourceLoaderTrust,
  ResourceReloadTrustError,
} from './resource-reload.js'
import {
  createSessionDirResolver,
  defaultSessionsRoot,
  ENV_SESSION_DIR,
  isPathWithinScope,
  type ResolvedSessionDir,
  readSessionDirSetting,
  resolveAgentDir,
} from './session-dir.js'
import {
  createForkSessionManager,
  ForkSessionCreateError,
  resolveForkTarget,
} from './session-fork.js'
import {
  buildImportText,
  importFileName,
  importMatchesExisting,
  type ParsedImportSession,
  parseSessionJsonl,
  planImportWrite,
  readImportSource,
} from './session-import.js'
import { aggregateSessionStats } from './session-stats.js'
import { applyStoredSessionLeaf, buildSessionTree, sessionTreeRevision } from './session-tree.js'
import {
  byteLengthOf,
  changedTopLevelKeys,
  mergeSettingsFromDisk,
  parseSettingsContent,
  readSettingsFile,
  restartRequiredKeys,
  SETTINGS_CONTENT_MAX_BYTES,
  settingsEffectiveOfManager,
  settingsEquivalent,
  settingsFilePaths,
  settingsRevision,
  writeSettingsFileAtomic,
} from './settings-store.js'
import { pathKey, type WorkspaceSnapshot } from './workspace-path.js'
import {
  defaultWorkspaceId,
  sessionStoreId,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceStateUnavailableError,
  WorkspaceStore,
  type WorkspaceStoreWorkspace,
  WorkspaceValidationError,
} from './workspace-store.js'
import { createWorkspaceToolsExtension } from './workspace-tools.js'

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
  resourceLoaderOptions?: HarnessResourceLoaderOptions
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

/**
 * 项目尚未取得信任决定：拒绝创建/激活会话。
 *
 * HTTP 层据此返回 409 与项目状态，页面先展示信任提示；不能静默按拒绝装配
 *（那会一信任就执行代码却没有任何提示）。
 */
export class ProjectTrustRequiredError extends Error {
  readonly code = 'project-needs-trust'
  constructor(readonly project: HarnessProjectInfo) {
    super(`Project requires a trust decision: ${project.path}`)
    this.name = 'ProjectTrustRequiredError'
  }
}

/**
 * 扩展命令上下文能力尚未实现（reload/shutdown 等）。
 *
 * 明确拒绝并携带方法名，避免用默认空成功冒充“已执行”。
 */
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

/** 一次装载的项目信任结果与输入守卫绑定槽（loader 只服务一个 live session）。 */
type PreparedProject = {
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
}

/** 每 cwd 的项目状态缓存与可复用的启动/决定装配。 */
type ProjectRuntime = {
  cwd: string
  info: HarnessProjectInfo
  settingsManager: SettingsManager
  defaultModel: ReturnType<typeof resolveDefaultModel>
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
type CommandNewSessionOptions = NonNullable<
  Parameters<ExtensionCommandContextActions['newSession']>[0]
>
type ReplacedSessionContext = Parameters<NonNullable<CommandNewSessionOptions['withSession']>>[0]

/** 当前命令所属的发送不应阻塞其自身的结构操作。 */
const hasOtherInFlight = (record: ThreadRecord): boolean => {
  const current = sendContext.getStore()
  return [...record.inFlight].some((send) => send !== current)
}

/** 每会话的扩展 UI 可变状态（统一由 snapshotOf 投影）。 */
type ThreadHostUiState = {
  statuses: Map<string, string>
  widgets: Map<string, { lines: string[]; placement: HarnessHostUiWidgetPlacement }>
  notifications: HarnessHostUiNotification[]
  notificationCounter: number
  /** 已报告过不支持的终端专属方法（每会话只提示一次）。 */
  unsupportedReported: Set<string>
  title: string | undefined
  workingMessage: string | undefined
  workingVisible: boolean | undefined
  hiddenThinkingLabel: string | undefined
  editorDirective: HarnessHostUiEditorDirective | undefined
  commandTarget: HarnessHostUiCommandTarget | undefined
}

type ThreadRecord = {
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
  /** 该会话的资源加载器（用于 dispose 时补发 session_shutdown）。 */
  resourceLoader: ResourceLoader
  /** loader 的信任检查绑定：重载后就地更新，是 live 会话的信任权威。 */
  trustBinding: BoundResourceLoaderTrust
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
  /** 缓存的首条用户消息文本（仅存找到的值；历史只追加，找到后不变）。 */
  firstUserMessageText?: string | undefined
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
type StructureKind =
  | 'navigate'
  | 'label'
  | 'model'
  | 'thinking'
  | 'rename'
  | 'fork'
  | 'compact'
  | 'reload'

/** 用户 Shell（`!` / `!!`）的宿主内状态（含实时输出与完成标记）。 */
type UserBashRun = {
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
type StructureOperation = {
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
 * 调用方窗口上下文（不进入 Pi 会话记录）。
 *
 * 由 HTTP 层的 `x-huan-caller` 头传入 `sendMessage`，沿 `prompt()` 的异步链
 * 传播；扩展命令/工具中的 setEditorText/getEditorText 据此定向到发起窗口。
 * 无调用方的后台扩展得到空串，只能生成“请窗口主动接受”的指令。
 */
const callerContext = new AsyncLocalStorage<string | undefined>()

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
        if (record.retired || (record.structure && !current)) return { action: 'handled' as const }
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

/** 结构操作收尾等待上限（导航摘要/扩展 hook 可能阻塞）。 */
const STRUCTURE_SETTLE_TIMEOUT_MS = 5_000

/** 运行中导航：停止并等待运行结算的上限（超时则明确返回 busy，不挂死）。 */
const STOP_FOR_NAVIGATION_TIMEOUT_MS = 10_000

/**
 * 会话收尾等待 `session.abort()` 返回的上限。
 *
 * Pi 1.4 的 `abort()` 会 `await waitForIdle()`，而运行可能停在无法中断的扩展
 * hook（`input` / `before_agent_start`）里；此时若无限等待，删除/断开会挂死。
 * 超时后继续收尾（会话即将 dispose/退订，不再有模型请求），与
 * `RETIRE_DRAIN_TIMEOUT_MS` 的已知限制同口径。
 */
const RETIRE_ABORT_TIMEOUT_MS = 5_000

/** 收尾用中止：有上限、不抛错（单会话中止失败不阻断其余清理）。 */
async function abortForRetire(session: AgentSession): Promise<void> {
  await withTimeout(session.abort(), RETIRE_ABORT_TIMEOUT_MS, '会话中止').catch(() => {})
}

/** 默认空间跨分组枚举的并发上限（与 Pi 自身目录发现的保守值一致）。 */
const SCOPE_LIST_CONCURRENCY = 8

/**
 * 用户 Shell 实时输出的有界上限（字符）。
 *
 * 目的：断线重连时快照不会携带无限增长的无界输出；超出时丢弃前缀并
 * 在增量事件里告知客户端 `dropped`，使两侧缓冲保持一致。
 */
const BASH_OUTPUT_MAX_CHARS = 120_000

/** 按上限并发执行（结果保持输入顺序）。 */
async function mapWithConcurrency<T, R>(
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
  // 用户空间在宿主创建时固定：显式值 > PI_CODING_AGENT_DIR > 默认 ~/.pi/agent。
  // 全进程只在这里解析一次，不在运行中改写 process.env（支持同进程多空间）。
  const agentDir = resolveAgentDir(options.agentDir)
  const agentDirSource = options.agentDir?.trim()
    ? 'option'
    : process.env.PI_CODING_AGENT_DIR?.trim()
      ? 'env'
      : 'default'
  // 会话目录覆盖同理只读一次；无覆盖时每个目标 cwd 使用自己的默认分组。
  const resolveSessionDirFor = createSessionDirResolver({
    agentDir,
    workspacePath,
    option: options.sessionDir,
    env: process.env[ENV_SESSION_DIR],
    setting: readSessionDirSetting(workspacePath, agentDir),
  })
  const resourceLoaderOptions = options.resourceLoaderOptions
  const diagnostics: string[] = []
  // GUI 只接收受控诊断代码，原始扩展/网络错误可能包含密钥，留在宿主本地。
  const safeDiagnostics = new Set<
    'assembly-warning' | 'catalog-refresh-failed' | 'model-fallback'
  >()
  /** 追加本地诊断并去重：重复重载同一失败不应无限增长。 */
  const pushDiagnostic = (message: string): void => {
    if (!diagnostics.includes(message)) diagnostics.push(message)
  }

  // ---- 装配层：共享 modelRuntime（全宿主一份），其余每会话独立 ----
  const modelRuntime = await createSharedModelRuntime(agentDir)
  const startRefresh = options.refreshCatalogOnStart ?? true
  const refreshTimeoutMs = options.catalogRefreshTimeoutMs ?? 15_000

  const records = new Map<string, ThreadRecord>()
  /** 宿主级交互通道：启动期 project_trust/session_start 请求也经它发现与应答。 */
  const interactions = createHostInteractions()
  /**
   * 调用方窗口的临时草稿镜像。
   *
   * key = `<threadId>\0<callerId>`；仅驻留内存，供扩展同步 getEditorText，
   * 不进入 JSONL/全局用户配置。会话 retire/宿主销毁时清理。
   */
  const editorMirrors = new Map<string, string>()
  /** 进行中的冷打开（并发调用共享同一 promise，避免同文件双开）。 */
  const pendingOpens = new Map<
    string,
    { promise: Promise<ThreadRecord>; controller: AbortController }
  >()
  /** 每线程的发送取消令牌（覆盖「冷打开中 → 启动 prompt」窗口）。 */
  const startingSends = new Map<string, Set<StartingSend>>()
  const pendingDeletes = new Map<string, Promise<void>>()
  /** 尚未 live 的会话结构操作（重命名），与打开/发送互斥。 */
  const coldStructure = new Set<string>()
  const recordsBySessionFile = new Map<string, ThreadRecord>()
  /** dispose 后拒绝新操作。 */
  let disposed = false
  /** 代数计数：使 dispose 前发起的异步打开失效。 */
  let generation = 0
  /** 资源版本：每次成功重载递增；新装配沿用当前值（表示已是最新资源）。 */
  let resourceRevisionSeq = 0
  /** 重载操作序号：每次调用生成独立身份，前端据此区分并发窗口看到的操作。 */
  let reloadCounter = 0

  /** 编辑器镜像 key（同一会话内按窗口隔离）。 */
  const editorMirrorKey = (threadId: string, callerId: string): string =>
    `${threadId}\u0000${callerId}`
  const forgetEditorMirrors = (threadId: string): void => {
    const prefix = `${threadId}\u0000`
    for (const key of [...editorMirrors.keys()]) {
      if (key.startsWith(prefix)) editorMirrors.delete(key)
    }
  }

  /** 项目状态与可复用装配按规范化 cwd 缓存；live session 仍各自重新装配。 */
  const projectRuntimes = new Map<string, ProjectRuntime>()
  const pendingProjects = new Map<string, Promise<ProjectRuntime>>()
  const trustStore = new ProjectTrustStore(agentDir)
  /**
   * 本宿主内的显式信任决定（按规范化 cwd）。
   *
   * `decideProjectTrust` 未勾选“记住”时不会写 trust.json，但同一宿主内的后续
   * 资源重载必须能看到该决定，否则用户刚允许的项目会被重载误拒。它不是第二套
   * 信任权威：只是把同一次显式决定的 override 保留到本次进程生命周期。
   */
  const explicitTrust = new Map<string, boolean>()
  const workspaceReloads = new Set<string>()

  /** 与 SDK 相同的 realpath 口径；目标不存在时保留绝对路径。 */
  const canonicalProjectPath = (path: string): string => {
    const absolute = resolve(path)
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }

  const projectNameOf = (path: string): string => basename(path) || path

  // ---- 工作区元数据（单文件、串行原子写） ----
  // 存储作用域标识按实际会话存储根计算：默认空间是 <agentDir>/sessions，
  // 显式覆盖是解析后的平铺 sessionDir。它与会话 cwd 无关。
  const startupScope = resolveSessionDirFor(workspacePath)
  const sessionStoreRoot = startupScope.grouped ? defaultSessionsRoot(agentDir) : startupScope.dir
  const storeId = sessionStoreId(sessionStoreRoot)
  const workspaceStore = new WorkspaceStore(agentDir)
  await workspaceStore.load()

  const isAvailableDirectory = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  const workspaceViewOf = (workspace: WorkspaceStoreWorkspace): HarnessWorkspace => ({
    id: workspace.id,
    name: workspace.name,
    revision: workspace.revision,
    projects: workspace.projects.map(
      (project): HarnessWorkspaceProject => ({
        alias: project.alias,
        path: project.path,
        available: isAvailableDirectory(project.path),
      }),
    ),
  })

  /** 扩展运行边界读取的权威快照：每次都从已提交的内存状态生成。 */
  const workspaceSnapshotOf = (workspaceId: string): WorkspaceSnapshot | null => {
    const workspace = workspaceStore.workspace(workspaceId)
    if (!workspace) return null
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      revision: workspace.revision,
      roots: workspace.projects.map((project) => ({
        alias: project.alias,
        path: project.path,
        available: isAvailableDirectory(project.path),
      })),
    }
  }

  // 单项目也走同一工作区模型：状态健康且没有任何定义时，提供一个仅存于
  // 内存的启动工作区；首次写入时随状态文件落盘。已有无元数据的 Pi 会话
  // 不会被自动归入，仍需用户明确接入。
  let startupWorkspaceId: string | undefined
  if (workspaceStore.healthy) {
    const startupPath = canonicalProjectPath(workspacePath)
    const existing = workspaceStore
      .listWorkspaces()
      .find((workspace) =>
        workspace.projects.some((project) => pathKey(project.path) === pathKey(startupPath)),
      )
    if (existing) {
      startupWorkspaceId = existing.id
    } else if (workspaceStore.listWorkspaces().length === 0) {
      const id = defaultWorkspaceId(agentDir, startupPath)
      try {
        workspaceStore.seedDefaultWorkspace({
          id,
          name: projectNameOf(startupPath),
          path: startupPath,
        })
        startupWorkspaceId = id
      } catch (error) {
        diagnostics.push(`默认工作区初始化：${String(error)}`)
      }
    }
    // 启动路径不属于任何已有工作区时保持未选中：不把新会话静默放进第一个
    // 无关工作区；GUI 会按窗口选择显式传入 workspaceId。
  }

  /** 工作区修改结果投影：冲突时附带权威定义供页面立即重读。 */
  const workspaceMutationResult = async (
    run: () => Promise<WorkspaceStoreWorkspace>,
  ): Promise<HarnessWorkspaceMutationResult> => {
    try {
      return { ok: true, workspace: workspaceViewOf(await run()) }
    } catch (error) {
      if (error instanceof WorkspaceConflictError) {
        return { ok: false, error: 'conflict', workspace: workspaceViewOf(error.current) }
      }
      if (error instanceof WorkspaceNotFoundError) return { ok: false, error: 'not-found' }
      if (error instanceof WorkspaceStateUnavailableError) {
        return { ok: false, error: 'state-unavailable' }
      }
      if (error instanceof WorkspaceValidationError) {
        return { ok: false, error: 'invalid', reason: error.reason }
      }
      throw error
    }
  }

  /** 工作区定义变更后，让已订阅该工作区的窗口立即读到最新的待生效 revision。 */
  const emitWorkspaceSnapshots = (workspaceId: string): void => {
    for (const record of records.values()) {
      if (record.workspaceId !== workspaceId) continue
      emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    }
  }

  /** 路径校验只做文件系统检查，不执行任何项目代码。 */
  const inspectProjectPath = async (input: string): Promise<HarnessProjectPathCheck> => {
    const requested = input.trim()
    if (!requested) {
      return { input, path: '', exists: false, isDirectory: false, error: { code: 'invalid-path' } }
    }
    const path = canonicalProjectPath(requested)
    try {
      const info = await stat(path)
      if (!info.isDirectory()) {
        return { input, path, exists: true, isDirectory: false, error: { code: 'not-directory' } }
      }
      return { input, path, exists: true, isDirectory: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        input,
        path,
        exists: false,
        isDirectory: false,
        error: { code: code === 'ENOENT' ? 'not-found' : 'invalid-path' },
      }
    }
  }

  const failedProjectInfo = (
    path: string,
    code: HarnessProjectFailureCode,
  ): HarnessProjectInfo => ({
    path,
    name: projectNameOf(path),
    status: 'failed',
    failure: { code },
    trust: {
      decision: 'unknown',
      origin: 'none',
      requiresTrust: false,
      defaultPolicy: 'ask',
      extensionErrorCount: 0,
    },
  })

  /** 把核心信任结果投影为 JSON-safe 项目摘要（不传扩展错误原文）。 */
  const projectInfoOf = (prepared: { trust: ProjectTrustResult }): HarnessProjectInfo => {
    const state = prepared.trust.state
    return {
      path: state.cwd,
      name: projectNameOf(state.cwd),
      status: state.status === 'needs-trust' ? 'needs-trust' : 'ready',
      trust: {
        decision: state.status === 'needs-trust' ? 'unknown' : state.status,
        origin: state.source,
        requiresTrust: state.requiresTrust,
        defaultPolicy: state.defaultProjectTrust,
        ...(state.savedPath ? { savedPath: state.savedPath } : {}),
        extensionErrorCount: state.extensionErrors.length,
      },
    }
  }

  /** 把扩展装配期登记的项目 provider/虚拟模型写入共享 modelRuntime。 */
  const registerPreparedProviders = (extensions: LoadExtensionsResult): void => {
    const runtime = extensions.runtime
    for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
      try {
        modelRuntime.registerProvider(name, config)
      } catch (error) {
        diagnostics.push(`扩展 provider（${extensionPath}）：${String(error)}`)
        safeDiagnostics.add('assembly-warning')
      }
    }
    runtime.pendingProviderRegistrations = []
    for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
      try {
        modelRuntime.registerNativeProvider(provider)
      } catch (error) {
        diagnostics.push(`原生 provider（${extensionPath}）：${String(error)}`)
        safeDiagnostics.add('assembly-warning')
      }
    }
    runtime.pendingNativeProviderRegistrations = []
    for (const { definition, extensionPath } of runtime.pendingVirtualModelRegistrations) {
      try {
        modelRuntime.registerVirtualModel(definition)
      } catch (error) {
        diagnostics.push(`虚拟模型（${extensionPath}）：${String(error)}`)
        safeDiagnostics.add('assembly-warning')
      }
    }
    runtime.pendingVirtualModelRegistrations = []
  }

  /** 宿主级交互请求 ID（与线程请求 ID 命名空间分离）。 */
  let interactionRequestCounter = 0
  const nextInteractionRequestId = (): string => {
    interactionRequestCounter += 1
    return `host:ui:${interactionRequestCounter}:${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 项目信任扩展的真实 UI 上下文。
   *
   * 与 CLI 一致地声明 `mode: 'rpc'`、`hasUI: true`；confirm/select 进入
   * 宿主级交互域，notify 作为有界可见通知。`inspectProjectTrust` 仍走无 UI
   * 路径，不在此触发任何交互。
   */
  const projectTrustContextOf = (cwd: string): ProjectTrustContext => {
    const canonicalCwd = canonicalProjectPath(cwd)
    const scope: HarnessHostInteractionScope = { kind: 'project', cwd: canonicalCwd }
    return {
      cwd: canonicalCwd,
      mode: 'rpc',
      hasUI: true,
      ui: {
        select: async (title, options, opts) => {
          const answer = await interactions.ask(
            {
              id: nextInteractionRequestId(),
              kind: 'select',
              title,
              options,
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            },
            scope,
            opts,
          )
          return answer.dismissed ? undefined : answer.value
        },
        confirm: async (title, message, opts) => {
          const answer = await interactions.ask(
            {
              id: nextInteractionRequestId(),
              kind: 'confirm',
              title,
              message,
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            },
            scope,
            opts,
          )
          return answer.confirmed ?? false
        },
        input: async (title, placeholder, opts) => {
          const answer = await interactions.ask(
            {
              id: nextInteractionRequestId(),
              kind: 'input',
              title,
              ...(placeholder !== undefined ? { placeholder } : {}),
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            },
            scope,
            opts,
          )
          return answer.dismissed ? undefined : answer.value
        },
        notify: (message, type) => interactions.notify(scope, message, type),
      },
    }
  }

  /**
   * 经统一信任入口准备一份会话装配。
   *
   * 只在这里创建 loader：上一版 `prepareProjectTrust` + `createHostServices`
   * 会把扩展工厂执行两次，且第二次装配没有信任回调。
   */
  const prepareProjectSession = async (
    cwd: string,
    override?: boolean,
  ): Promise<PreparedProject> => {
    const guard: { record?: ThreadRecord } = {}
    const workspaceBinding: PreparedProject['workspaceBinding'] = {
      loadedInstructionPaths: [],
    }
    const trust = await prepareProjectTrust({
      cwd,
      agentDir,
      ...(override !== undefined ? { override } : {}),
      trustStore,
      resourceLoaderOptions: {
        ...toResourceLoaderOptions(resourceLoaderOptions),
        extensionFactories: [
          createInputGuardExtension(() => guard.record),
          // 工作区扩展按会话实例装配。loader 若先用于查询，绑定槽为空；
          // 被某个 live session 消费时才写入归属，不会按 cwd 复用给另一个工作区。
          createWorkspaceToolsExtension({
            getWorkspace: () =>
              workspaceBinding.workspaceId
                ? workspaceSnapshotOf(workspaceBinding.workspaceId)
                : null,
            getLoadedInstructionPaths: () => workspaceBinding.loadedInstructionPaths,
            onWorkspaceApplied: (workspace) => workspaceBinding.onApplied?.(workspace),
          }),
          // codemode / tool_search 按 CLI 的 named builtin + replaceable 约定装配；
          // 默认不激活，遵循 extensions 启停/替换与 defaultTools。
          ...createBuiltinExtensionFactories(),
        ],
      },
      // 项目信任扩展可以获得真实 RPC UI；请求在 record 发布前也可发现/应答。
      projectTrustContext: projectTrustContextOf(cwd),
    })
    for (const message of [...trust.loadErrors, ...trust.state.extensionErrors]) {
      diagnostics.push(`扩展装配（${trust.state.cwd}）：${message}`)
      safeDiagnostics.add('assembly-warning')
    }
    const extensions = trust.resourceLoader.getExtensions()
    // 上游 pi-workspaces 与本宿主的同名工具职责重叠。若用户仍安装该插件，
    // 明确拒绝装配并给出诊断，避免双重注册/双重权威静默并存。
    const conflicting = extensions.extensions.find((extension) => {
      const segments = extension.path.split(/[\\/]/)
      return segments.some(
        (segment) => segment === 'pi-workspaces' || segment.startsWith('pi-workspaces.'),
      )
    })
    if (conflicting) {
      const message =
        `检测到 pi-workspaces 扩展（${conflicting.path}）；huan 已内置工作区工具，` +
        '请移除该扩展后重新打开项目，避免同名工具重复注册。'
      diagnostics.push(`扩展装配（${trust.state.cwd}）：${message}`)
      safeDiagnostics.add('assembly-warning')
      throw new Error(message)
    }
    registerPreparedProviders(extensions)
    // 与 SDK 服务装配一致：注册完 provider 后物化本地目录，不触发联网。
    await modelRuntime.refresh({ allowNetwork: false })
    workspaceBinding.loadedInstructionPaths = trust.resourceLoader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.path)
    // SDK 的 AgentSession.reload() 调 loader.reload() 时不传信任回调；宿主必须
    // 保证重载不能绕过信任门控（新出现的项目资源不得沿用 no-resources 结论）。
    const trustBinding = bindResourceLoaderTrust(trust.resourceLoader, {
      cwd: trust.state.cwd,
      settingsManager: trust.settingsManager,
      trustStore,
      state: trust.state,
      explicitDecision: () => explicitTrust.get(pathKey(trust.state.cwd)),
      projectTrustContext: () => projectTrustContextOf(trust.state.cwd),
      onExtensionErrors: (errors) => {
        for (const message of errors) {
          pushDiagnostic(`重载信任扩展（${trust.state.cwd}）：${message}`)
          safeDiagnostics.add('assembly-warning')
        }
      },
    })
    return { trust, guard, workspaceBinding, trustBinding }
  }

  /** 由一次装配结果建立/替换项目缓存。旧 loader 未被消费时直接丢弃。 */
  const projectRuntimeFrom = (
    prepared: PreparedProject,
    originOverride?: ProjectTrustSource,
  ): ProjectRuntime => {
    const info = projectInfoOf(prepared)
    const runtime: ProjectRuntime = {
      cwd: info.path,
      info: originOverride ? { ...info, trust: { ...info.trust, origin: originOverride } } : info,
      settingsManager: prepared.trust.settingsManager,
      defaultModel: resolveDefaultModel({
        modelRuntime,
        cwd: info.path,
        agentDir,
        ...(options.model ? { model: options.model } : {}),
        settingsManager: prepared.trust.settingsManager,
      }),
      pending: prepared,
    }
    runtime.lastLoader = {
      loader: prepared.trust.resourceLoader,
      settings: prepared.trust.settingsManager,
    }
    projectRuntimes.set(runtime.cwd, runtime)
    return runtime
  }

  /** 装载一个新的项目装配并缓存状态（可能停在 needs-trust）。 */
  const loadProjectRuntime = (cwd: string): Promise<ProjectRuntime> => {
    const existing = pendingProjects.get(cwd)
    if (existing) return existing
    const pending = prepareProjectSession(cwd)
      .then(projectRuntimeFrom)
      .finally(() => {
        pendingProjects.delete(cwd)
      })
    pendingProjects.set(cwd, pending)
    return pending
  }

  /** 查询项目：优先缓存；项目资源集合变化时重新评估，不用过期结论。 */
  const queryProject = async (input: string): Promise<HarnessProjectInfo> => {
    const check = await inspectProjectPath(input)
    if (check.error) return failedProjectInfo(check.path || input, check.error.code)
    const cached = projectRuntimes.get(check.path)
    if (cached && cached.info.status !== 'failed') {
      const requiresTrust = hasTrustRequiringProjectResources(check.path)
      if (requiresTrust === cached.info.trust.requiresTrust) return cached.info
    }
    try {
      return (await loadProjectRuntime(check.path)).info
    } catch (error) {
      diagnostics.push(`项目装配（${check.path}）：${String(error)}`)
      safeDiagnostics.add('assembly-warning')
      return failedProjectInfo(check.path, 'load-failed')
    }
  }

  /**
   * 只读信任摘要：用于工作区成员管理展示，不加载项目扩展或资源。
   *
   * 该路径只读取 trust.json、全局默认策略与项目资源存在性；用户级
   * project_trust 扩展的实际决定仍会在真正装配/新建会话时执行。
   */
  const inspectProjectTrust = async (input: string): Promise<HarnessProjectInfo> => {
    const check = await inspectProjectPath(input)
    if (check.error) return failedProjectInfo(check.path || input, check.error.code)
    try {
      const trust = await prepareProjectTrust({
        cwd: check.path,
        agentDir,
        trustStore,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      })
      return projectInfoOf({ trust })
    } catch (error) {
      diagnostics.push(`项目信任摘要（${check.path}）：${String(error)}`)
      return failedProjectInfo(check.path, 'load-failed')
    }
  }

  /** 会话装配：复用未消费的启动/决定 loader，否则按已知结论重新装配。 */
  const acquireProjectSession = async (
    input: string,
  ): Promise<{ runtime: ProjectRuntime; prepared: PreparedProject }> => {
    const check = await inspectProjectPath(input)
    if (workspaceReloads.has(check.path)) {
      throw new ThreadStructureBusyError('起始目录资源正在重载，请稍后重试')
    }
    if (check.error) {
      throw new Error(`项目路径不可用：${check.error.code}`)
    }
    const takePending = (runtime: ProjectRuntime): PreparedProject | undefined => {
      const prepared = runtime.pending
      runtime.pending = undefined
      return prepared
    }
    let runtime = projectRuntimes.get(check.path)
    if (runtime?.info.status === 'needs-trust') {
      throw new ProjectTrustRequiredError(runtime.info)
    }
    if (runtime?.info.status === 'failed') {
      // 上次装配失败：本次会话重新尝试，不复用失败结论。
      runtime.pending = undefined
      runtime = await loadProjectRuntime(check.path)
      if (runtime.info.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(runtime.info)
      }
    } else if (runtime) {
      // 项目资源集合变化：旧结论与旧 loader 都不能再用。
      const requiresTrust = hasTrustRequiringProjectResources(check.path)
      if (requiresTrust !== runtime.info.trust.requiresTrust) {
        runtime.pending = undefined
        runtime = await loadProjectRuntime(check.path)
        if (runtime.info.status === 'needs-trust') {
          throw new ProjectTrustRequiredError(runtime.info)
        }
      }
    } else {
      runtime = await loadProjectRuntime(check.path)
      if (runtime.info.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(runtime.info)
      }
    }

    const pending = takePending(runtime)
    if (pending) return { runtime, prepared: pending }

    // 缓存中的结论仍然有效：按同一结论重新装配，不再次询问用户。
    const prepared = await prepareProjectSession(
      runtime.cwd,
      runtime.info.trust.decision === 'trusted',
    )
    runtime.settingsManager = prepared.trust.settingsManager
    runtime.defaultModel = resolveDefaultModel({
      modelRuntime,
      cwd: runtime.cwd,
      agentDir,
      ...(options.model ? { model: options.model } : {}),
      settingsManager: prepared.trust.settingsManager,
    })
    runtime.lastLoader = {
      loader: prepared.trust.resourceLoader,
      settings: prepared.trust.settingsManager,
    }
    return { runtime, prepared }
  }

  /**
   * 读取空白页资源目录所需的装配，但不消费 loader。
   *
   * 目录查询会在首个会话创建前发生；这里把装配结果留在 pending，
   * 后续 createThread 直接复用，避免扩展工厂因浏览命令目录被重复执行。
   */
  const peekProjectSession = async (input: string): Promise<PreparedProject> => {
    const check = await inspectProjectPath(input)
    if (workspaceReloads.has(check.path)) {
      throw new ThreadStructureBusyError('起始目录资源正在重载，请稍后重试')
    }
    if (check.error) throw new Error(`项目路径不可用：${check.error.code}`)
    let runtime = projectRuntimes.get(check.path)
    if (!runtime || runtime.info.status === 'failed') {
      runtime = await loadProjectRuntime(check.path)
    }
    if (runtime.info.status === 'needs-trust') {
      throw new ProjectTrustRequiredError(runtime.info)
    }
    if (runtime.pending) return runtime.pending
    const prepared = await prepareProjectSession(
      runtime.cwd,
      runtime.info.trust.decision === 'trusted',
    )
    runtime.pending = prepared
    runtime.settingsManager = prepared.trust.settingsManager
    runtime.lastLoader = {
      loader: prepared.trust.resourceLoader,
      settings: prepared.trust.settingsManager,
    }
    return prepared
  }

  /** 解析文件查询的可见根：仅会话/选中工作区成员，退化为空白页固定 cwd。 */
  const fileSearchRootsOf = async (input: HarnessFileSearchInput): Promise<FileSearchRoot[]> => {
    let workspaceId = input.workspaceId
    let cwd = input.workspacePath
    if (input.threadId) {
      const live = records.get(input.threadId)
      if (live) {
        workspaceId ??= live.workspaceId
        cwd ??= live.workspacePath
      } else {
        const info = await findSessionInfo(input.threadId)
        if (!info) throw new Error(`Unknown thread: ${input.threadId}`)
        cwd ??= info.cwd
        workspaceId ??= workspaceStore.sessionWorkspace(storeId, info.id)
      }
    }
    const workspace = workspaceId ? workspaceSnapshotOf(workspaceId) : null
    if (workspace) {
      return workspace.roots.map((root) => ({
        alias: root.alias,
        path: root.path,
        projectName: projectNameOf(root.path),
        workspaceName: workspace.name,
      }))
    }
    if (!cwd) throw new Error('文件查询需要会话、工作区或固定起始目录')
    return [{ path: cwd, projectName: projectNameOf(cwd) }]
  }

  /** 保存决定后立即装配；保留本次显式来源与保存路径供页面展示。 */
  const decideProject = async (input: HarnessProjectTrustInput): Promise<HarnessProjectInfo> => {
    const check = await inspectProjectPath(input.path)
    if (check.error) return failedProjectInfo(check.path || input.path, check.error.code)
    if (input.remember === true) trustStore.set(check.path, input.trusted)
    // 显式决定即使不保存也必须对本次进程内的后续重载可见（否则重载会误拒）。
    explicitTrust.set(pathKey(check.path), input.trusted)
    try {
      const prepared = await prepareProjectSession(check.path, input.trusted)
      const runtime = projectRuntimeFrom(prepared, 'explicit')
      if (input.remember === true) {
        runtime.info = {
          ...runtime.info,
          trust: { ...runtime.info.trust, savedPath: check.path },
        }
      }
      if (input.trusted && startRefresh) await refreshCatalog()
      return runtime.info
    } catch (error) {
      diagnostics.push(`信任决定（${check.path}）：${String(error)}`)
      safeDiagnostics.add('assembly-warning')
      return failedProjectInfo(check.path, 'load-failed')
    }
  }

  /** 最近项目：同一 agentDir 的会话 header + 缓存过的项目；按活动时间排序。 */
  const listRecentProjects = async (): Promise<HarnessRecentProject[]> => {
    const projects = new Map<string, { lastActiveAt?: string }>()
    for (const info of await listScopeInfos()) {
      if (!info.cwd) continue
      const path = canonicalProjectPath(info.cwd)
      const time = info.modified.toISOString()
      const existing = projects.get(path)
      if (!existing?.lastActiveAt || time > existing.lastActiveAt) {
        projects.set(path, { lastActiveAt: time })
      }
    }
    for (const runtime of projectRuntimes.values()) {
      if (!projects.has(runtime.cwd)) projects.set(runtime.cwd, {})
    }
    const startup = canonicalProjectPath(workspacePath)
    if (!projects.has(startup)) projects.set(startup, {})
    return [...projects.entries()]
      .map(([path, activity]) => ({
        path,
        name: projectNameOf(path),
        ...(activity.lastActiveAt ? { lastActiveAt: activity.lastActiveAt } : {}),
      }))
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
      .slice(0, 20)
  }

  /** 受控目录刷新：失败只记诊断，不阻断启动或信任决定。 */
  const refreshCatalog = async (): Promise<void> => {
    try {
      // 联网刷新可能因扩展 provider 的远程拉取而长期挂起；超时后放弃等待。
      await withTimeout(
        refreshModelCatalog(modelRuntime, { allowNetwork: true }),
        refreshTimeoutMs,
        '模型目录刷新',
      ).then(
        ({ errors }) => {
          diagnostics.push(...errors.map((message) => `模型目录刷新：${message}`))
          if (errors.length) safeDiagnostics.add('catalog-refresh-failed')
        },
        (error: unknown) => {
          diagnostics.push(`模型目录刷新失败：${String(error)}`)
          safeDiagnostics.add('catalog-refresh-failed')
        },
      )
    } catch (error) {
      diagnostics.push(`模型目录刷新失败：${String(error)}`)
      safeDiagnostics.add('catalog-refresh-failed')
    }
  }

  // 启动引导：先准备启动项目（未知信任时只装配用户资源），再注册 provider。
  // 该 loader 留给首个会话复用；needs-trust 时跳过联网目录刷新。
  //
  // 若装配期扩展发起阻断式 UI 请求（project_trust/session_start），不能在这里
  // 等待浏览器：HTTP 必须先可用。于是让位给宿主交互通道，装配继续在后台完成；
  // 同一 cwd 的后续 getProject/首次会话会复用同一个进行中的装配，不重复执行。
  let resolvedDefault = resolveDefaultModel({
    modelRuntime,
    cwd: workspacePath,
    agentDir,
    ...(options.model ? { model: options.model } : {}),
  })
  const startupGeneration = generation
  const startupAssembly = loadProjectRuntime(workspacePath)
  let startupBlocked = false
  let resolveStartupBlocked: () => void = () => {}
  const startupBlockedSignal = new Promise<void>((resolveBlocked) => {
    resolveStartupBlocked = resolveBlocked
  })
  const unsubscribeStartupInteraction = interactions.subscribe((snapshot) => {
    if (snapshot.requests.length === 0) return
    startupBlocked = true
    resolveStartupBlocked()
  })

  const finishStartupAssembly = async (runtime: ProjectRuntime): Promise<void> => {
    if (generation !== startupGeneration) return
    resolvedDefault = runtime.defaultModel
    if (startRefresh && runtime.info.status !== 'needs-trust') await refreshCatalog()
  }

  try {
    const outcome = await Promise.race([
      startupAssembly.then((runtime) => ({ kind: 'done' as const, runtime })),
      startupBlockedSignal.then(() => ({ kind: 'blocked' as const })),
    ])
    if (outcome.kind === 'done') {
      await finishStartupAssembly(outcome.runtime)
    } else if (startupBlocked) {
      // 装配仍在等待用户应答：完成后再回填默认模型与诊断。
      void startupAssembly
        .then((runtime) => finishStartupAssembly(runtime))
        .catch((error: unknown) => {
          if (generation !== startupGeneration) return
          diagnostics.push(`启动项目装配（${workspacePath}）：${String(error)}`)
          safeDiagnostics.add('assembly-warning')
        })
    }
  } catch (error) {
    diagnostics.push(`启动项目装配（${workspacePath}）：${String(error)}`)
    safeDiagnostics.add('assembly-warning')
  } finally {
    unsubscribeStartupInteraction()
  }

  /** 整个存储作用域（默认空间或平铺覆盖）的跨 cwd 列表缓存，按作用域目录区分。 */
  const scopeCatalogCache = new Map<
    string,
    { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> }
  >()

  const assertActive = () => {
    if (disposed) throw new Error('Harness host has been disposed')
  }

  /** 作用域目录：记录本身的 cwd（空值回退启动工作区）。 */
  const scopeOf = (cwd: string | undefined): ResolvedSessionDir =>
    resolveSessionDirFor(cwd?.trim() ? cwd : workspacePath)

  /** 作用域根：默认空间为 `<agentDir>/sessions`（可跨分组），平铺覆盖为其自身。 */
  const scopeRootOf = (scope: ResolvedSessionDir): string =>
    scope.grouped ? defaultSessionsRoot(agentDir) : scope.dir

  /**
   * 存储作用域校验：仅接受当前空间内的会话文件。
   * 作用域外的路径（包括指向外部的符号链接）一律拒绝，用于打开/改名/删除。
   */
  const assertSessionFileInScope = (
    filePath: string,
    cwd: string | undefined,
  ): ResolvedSessionDir => {
    const scope = scopeOf(cwd)
    if (!isPathWithinScope(scopeRootOf(scope), filePath)) {
      throw new Error(`会话文件不在当前存储作用域内：${filePath}`)
    }
    return scope
  }

  /**
   * 打开作用域内的会话记录并统一应用有效树落点。
   *
   * 冷树、冷快照、冷详情与 ensureOpen 必须共用这一入口，避免任一路径遗漏
   * 水位/节点校验或错误地写入 Pi 文件。
   */
  const openScopedSessionManager = (info: SessionCatalogInfo): SessionManager => {
    const scope = assertSessionFileInScope(info.path, info.cwd)
    const sessionManager = SessionManager.open(info.path, scope.dir)
    applyStoredSessionLeaf(
      sessionManager,
      workspaceStore.healthy ? workspaceStore.sessionLeaf(storeId, info.id) : undefined,
    )
    return sessionManager
  }

  /**
   * 默认空间的跨 cwd 枚举：只扫描当前 agentDir 下 sessions 的直接分组目录。
   *
   * 不用无参 `SessionManager.listAll()`（它读进程默认用户空间，会泄漏到另一个
   * agentDir）；也不用递归扫描。路径符号链接的分组目录不作为隐式入口（避免
   * 默认空间变成任意外部目录的入口）。
   */
  const listGroupedScopeInfos = async (): Promise<SessionCatalogInfo[]> => {
    const sessionsRoot = defaultSessionsRoot(agentDir)
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>
    try {
      entries = await readdir(sessionsRoot, { withFileTypes: true })
    } catch (error) {
      // 只有「不存在」等价于空目录；权限、非目录等故障必须上报，
      // 不能笼统吞成空列表（否则用户看到的是「没有会话」而不是「目录不可用」）。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(
        `会话目录不可用（${sessionsRoot}）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(sessionsRoot, entry.name))
    // 限制并发：项目多的用户空间不应一次性打开所有分组目录（Pi 自己的
    // listAll 也做并发限制）；总工作量仍为 O(会话数)。
    const listed = await mapWithConcurrency(dirs, SCOPE_LIST_CONCURRENCY, (dir) =>
      SessionManager.listAll(dir),
    )
    return listed.flat() as unknown as SessionCatalogInfo[]
  }

  /**
   * 存储作用域内的全部会话（跨 cwd，按需重新扫描）。
   *
   * 默认空间：枚举 `<agentDir>/sessions/` 的直接分组目录，逐个经公开列表方法读取；
   * 显式平铺目录：`SessionManager.listAll(explicitDir)`。不把平铺目录当默认根递归扫描。
   */
  const scanScopeInfos = async (scope: ResolvedSessionDir): Promise<SessionCatalogInfo[]> =>
    scope.grouped
      ? await listGroupedScopeInfos()
      : ((await SessionManager.listAll(scope.dir)) as unknown as SessionCatalogInfo[])

  const listScopeInfos = async (): Promise<SessionCatalogInfo[]> => {
    const scope = scopeOf(workspacePath)
    const key = scopeRootOf(scope)
    const existing = scopeCatalogCache.get(key)
    if (existing?.infos) return existing.infos
    if (existing?.promise) return existing.promise
    const entry: { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> } = {}
    const promise = (async () => {
      const infos = await scanScopeInfos(scope)
      // 只在本次扫描仍是当前缓存条目时写回：显式刷新可能已用新条目替换它，
      // 旧 promise 不得覆盖新结果，也不能删掉新条目。
      if (scopeCatalogCache.get(key) !== entry) return infos
      // 空结果不缓存（同上：会话可能在创建后落盘）。
      if (infos.length === 0) scopeCatalogCache.delete(key)
      else entry.infos = infos
      return infos
    })().finally(() => {
      entry.promise = undefined
    })
    entry.promise = promise
    scopeCatalogCache.set(key, entry)
    return promise
  }

  const invalidateCatalog = (_cwd: string = workspacePath) => {
    // 列表已统一走跨 cwd 作用域缓存；任何会话文件变化都清整份缓存，
    // 避免删除/更名/首条消息落盘后仍读到旧值。
    scopeCatalogCache.clear()
  }

  /**
   * 在给定列表里按 ID 定位会话；同一 ID 对应多个文件时报歧义（不静默选一个）。
   */
  const pickSessionInfo = (
    infos: readonly SessionCatalogInfo[],
    threadId: string,
  ): SessionCatalogInfo | undefined => {
    let hit: SessionCatalogInfo | undefined
    const paths = new Set<string>()
    for (const info of infos) {
      if (info.id !== threadId) continue
      paths.add(info.path)
      hit = info
    }
    if (paths.size > 1) {
      throw new Error(`会话 ID ${threadId} 在存储作用域内对应多个文件，无法安全定位`)
    }
    return hit
  }

  const findSessionInfo = async (threadId: string): Promise<SessionCatalogInfo | undefined> => {
    // 统一经作用域缓存（默认空间跨分组 / 平铺覆盖）定位，不先做「本地命中即返回」：
    // 本地列表只是作用域的子集，直接返回会让「同一 ID 存在于另一个 cwd 分组」
    // 的重复 ID 被静默选中，违背作用域内重复 ID 必须报歧义的约定。
    // 缓存命中时这里是纯内存 O(n) 过滤，不逐次重扫目录。
    return pickSessionInfo(await listScopeInfos(), threadId)
  }

  // ---- 状态推导（热/冷共用口径） ----
  const runStatus = (record: ThreadRecord): HarnessThreadMetadata['status'] => {
    const session = record.session
    if (session.isStreaming || session.isCompacting || session.isRetrying) return 'running'
    return record.lastError ? 'failed' : 'idle'
  }

  /** 工作区相关元数据；归属按会话元数据定位，绝不按 cwd 推断。 */
  const workspaceFields = (
    workspaceId: string | undefined,
    appliedRevision?: number,
  ): Pick<
    HarnessThreadMetadata,
    'workspaceId' | 'workspaceRevision' | 'workspaceAppliedRevision'
  > => {
    if (!workspaceId) return {}
    const workspace = workspaceStore.workspace(workspaceId)
    if (!workspace) return {}
    return {
      workspaceId,
      workspaceRevision: workspace.revision,
      ...(appliedRevision !== undefined ? { workspaceAppliedRevision: appliedRevision } : {}),
    }
  }

  const sessionWorkspaceFields = (
    threadId: string,
    appliedRevision?: number,
  ): ReturnType<typeof workspaceFields> =>
    workspaceFields(workspaceStore.sessionWorkspace(storeId, threadId), appliedRevision)

  const metadataOf = (record: ThreadRecord): HarnessThreadMetadata => {
    const session = record.session
    const model = session.model
    const usage = session.getContextUsage()
    const queued = mapQueuedMessages(session.getSteeringMessages(), session.getFollowUpMessages())
    const title = deriveLiveTitle(record)
    const explicitName = session.sessionName?.trim()
    const firstMessageText = firstUserMessageTextOf(record)
    const treeOperation = treeOperationView(record)
    return {
      id: record.threadId,
      status: runStatus(record),
      compactionActive: session.isCompacting,
      ...(session.isCompacting && record.compactionReason
        ? { compactionReason: record.compactionReason }
        : {}),
      autoCompactionEnabled: record.settingsManager.getCompactionEnabled(),
      scopedModelKeys: session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
      modelCatalogRevision,
      ...(model?.input ? { modelInput: [...model.input] } : {}),
      retryActive: session.isRetrying,
      retryAttempt: session.retryAttempt,
      workspacePath: record.workspacePath,
      ...workspaceFields(record.workspaceId, record.workspaceAppliedRevision),
      messageCount: session.messages.length,
      leafId: record.sessionManager.getLeafId(),
      treeRevision: sessionTreeRevision(record.sessionManager),
      ...(treeOperation ? { treeOperation } : {}),
      // 标题口径与冷读路径一致：显式会话名 > 首条用户消息（截断）> 会话文件名。
      // 注意：仅「显式命名」会持久化；未命名会话重启后由冷路径推导同一标题。
      ...(title ? { title } : {}),
      // 命名状态与首条消息独立暴露：与冷读路径同为全文件口径。
      ...(explicitName ? { name: explicitName } : {}),
      ...(firstMessageText ? { firstMessageText } : {}),
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
      ...(workspaceStore.sessionArchived(storeId, record.threadId) ? { archived: true } : {}),
      ...(queued.length ? { queuedMessages: queued } : {}),
      resourceRevision: record.resourceRevision,
      ...(record.reload ? { reload: { ...record.reload } } : {}),
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

  /**
   * 把权威消息映射到来源 entryId。
   *
   * 只使用公开 `buildSessionProjection()` 的 sourceEntry 对应关系，再按对象
   * 身份对齐实时 `session.messages`；转换型消息按 SDK 投影顺序回退。两者都
   * 来自 sourceEntry，不使用时间戳或 transcript 下标；尚未落盘的尾消息为 null。
   */
  const messageEntryIds = (
    sessionManager: SessionManager,
    messages: readonly unknown[],
  ): (string | null)[] => {
    const projection = sessionManager.buildSessionProjection()
    const byMessage = new Map<unknown, string>()
    const projected: string[] = []
    for (const entry of projection.entries) {
      for (const message of entry.messages) {
        byMessage.set(message, entry.sourceEntry.id)
        projected.push(entry.sourceEntry.id)
      }
    }
    // 身份匹配优先；转换型条目（custom_message/摘要等）每次投影会生成新对象，
    // 因此按 SDK 投影顺序回退（sourceEntry 顺序，不是 transcript 下标）。
    return messages.map((message, index) => byMessage.get(message) ?? projected[index] ?? null)
  }

  /** 结构操作在快照中的可见部分（仅导航/标签需要跨窗提示）。 */
  const treeOperationView = (record: ThreadRecord): HarnessThreadTreeOperation | undefined => {
    const operation = record.structure
    if (!operation) return undefined
    if (operation.kind !== 'navigate' && operation.kind !== 'label') return undefined
    return {
      kind: operation.kind,
      status: operation.status,
      ...(operation.targetId ? { targetId: operation.targetId } : {}),
      startedAt: operation.startedAt,
    }
  }

  /** 把宿主内部的 Shell 运行态投影为 JSON-safe 协议形状（不含 done/执行器）。 */
  const bashViewOf = (run: UserBashRun): HarnessBashRun => ({
    id: run.id,
    command: run.command,
    excludeFromContext: run.excludeFromContext,
    cwd: run.cwd,
    status: run.status,
    output: run.output,
    outputTruncated: run.outputTruncated,
    startedAt: run.startedAt,
    ...(run.result ? { result: run.result } : {}),
  })

  /**
   * Shell 完成且已持久化为 bashExecution 消息后，释放运行态。
   *
   * `recordBashResult` 在运行中会把消息缓冲到运行结算后才落盘，因此完成卡
   * 需要保留到消息真正出现，然后由快照取代，避免重复展示或空洞。
   */
  const releasePersistedBash = (record: ThreadRecord): void => {
    const run = record.bash
    if (run?.status === 'complete' && run.recorded && !record.session.hasPendingBashMessages) {
      record.bash = undefined
    }
  }

  /** 压缩运行态（快照与 UI 共用；失败原因成功后清除）。 */
  const compactionPhaseOf = (record: ThreadRecord) => ({
    active: record.session.isCompacting,
    ...(record.compactionReason ? { reason: record.compactionReason } : {}),
    ...(record.lastCompactionError ? { error: record.lastCompactionError } : {}),
  })

  // ---- 运行期扩展 UI 状态（线程快照权威） ----

  /** 每次状态变化广播权威快照；断开重连即以快照补齐。 */
  const emitHostUiSnapshot = (record: ThreadRecord): void => {
    if (record.retired) return
    emit(record, { type: 'host_ui_update', hostUi: hostUiViewOf(record) })
  }

  const notifyHostUi = (
    record: ThreadRecord,
    message: string,
    type: HarnessHostUiNotification['type'],
  ): void => {
    record.hostUi.notificationCounter += 1
    record.hostUi.notifications = [
      ...record.hostUi.notifications,
      {
        id: `${record.threadId}:notify:${record.hostUi.notificationCounter}`,
        message,
        type,
        createdAt: Date.now(),
      },
    ].slice(-20)
    emitHostUiSnapshot(record)
  }

  const setHostUiStatus = (record: ThreadRecord, key: string, text: string | undefined): void => {
    const current = record.hostUi.statuses.get(key)
    if (text === undefined) {
      if (current === undefined) return
      record.hostUi.statuses.delete(key)
    } else {
      if (current === text) return
      record.hostUi.statuses.set(key, text)
    }
    emitHostUiSnapshot(record)
  }

  const setHostUiWidget = (
    record: ThreadRecord,
    key: string,
    lines: string[] | undefined,
    placement: HarnessHostUiWidgetPlacement,
  ): void => {
    const current = record.hostUi.widgets.get(key)
    if (lines === undefined) {
      if (!current) return
      record.hostUi.widgets.delete(key)
    } else {
      if (
        current &&
        current.placement === placement &&
        current.lines.length === lines.length &&
        current.lines.every((line, index) => line === lines[index])
      ) {
        return
      }
      record.hostUi.widgets.set(key, { lines: [...lines], placement })
    }
    emitHostUiSnapshot(record)
  }

  const setHostUiTitle = (record: ThreadRecord, title: string): void => {
    if (record.hostUi.title === title) return
    // 扩展标题只作为提示，不改 Pi 会话名称，也不改 document.title。
    record.hostUi.title = title
    emitHostUiSnapshot(record)
  }

  const setHostUiWorkingMessage = (record: ThreadRecord, message: string | undefined): void => {
    if (record.hostUi.workingMessage === message) return
    record.hostUi.workingMessage = message
    emitHostUiSnapshot(record)
  }

  const setHostUiWorkingVisible = (record: ThreadRecord, visible: boolean): void => {
    if (record.hostUi.workingVisible === visible) return
    record.hostUi.workingVisible = visible
    emitHostUiSnapshot(record)
  }

  const setHostUiHiddenThinkingLabel = (record: ThreadRecord, label: string | undefined): void => {
    if (record.hostUi.hiddenThinkingLabel === label) return
    record.hostUi.hiddenThinkingLabel = label
    emitHostUiSnapshot(record)
  }

  /** 终端专属能力：记录可见的不支持说明，不执行扩展传入的工厂。 */
  const reportUnsupportedHostUi = (record: ThreadRecord, method: string): void => {
    if (record.hostUi.unsupportedReported.has(method)) return
    record.hostUi.unsupportedReported.add(method)
    notifyHostUi(record, `扩展 UI 能力 ${method} 在 GUI 宿主中不支持，已跳过。`, 'warning')
  }

  /** 调用方窗口的草稿镜像（仅内存，不持久化）。 */
  const callerDraftOf = (threadId: string): string => {
    const callerId = callerContext.getStore()
    if (!callerId) return ''
    return editorMirrors.get(editorMirrorKey(threadId, callerId)) ?? ''
  }

  const rememberCallerDraft = (threadId: string, callerId: string, text: string): void => {
    editorMirrors.set(editorMirrorKey(threadId, callerId), text)
  }

  /**
   * 扩展写输入框。
   *
   * 有调用方窗口时标记定向；无调用方（后台扩展）时保留 callerId 缺失，
   * 由任一窗口主动接受。同时更新调用方镜像，供同一命令链的 getEditorText。
   */
  const writeHostUiEditor = (record: ThreadRecord, text: string, mode: 'set' | 'paste'): void => {
    const callerId = callerContext.getStore()
    if (callerId) {
      const key = editorMirrorKey(record.threadId, callerId)
      const current = editorMirrors.get(key) ?? ''
      // paste 没有光标位置信息；镜像按末尾追加以保持同步可读。
      editorMirrors.set(key, mode === 'paste' ? `${current}${text}` : text)
    }
    const previous = record.hostUi.editorDirective
    const mergePaste = mode === 'paste' && previous !== undefined && previous.callerId === callerId
    record.hostUi.notificationCounter += 1
    record.hostUi.editorDirective = {
      id: `${record.threadId}:editor:${record.hostUi.notificationCounter}`,
      text: mergePaste ? `${previous.text}${text}` : text,
      mode: mergePaste ? previous.mode : mode,
      ...(callerId ? { callerId } : {}),
      createdAt: Date.now(),
    }
    emitHostUiSnapshot(record)
  }

  const setHostUiCommandTarget = (
    record: ThreadRecord,
    action: HarnessHostUiCommandTarget['action'],
    threadId: string,
    message: string,
    title?: string,
    editorText?: string,
  ): void => {
    const callerId = callerContext.getStore()
    record.hostUi.notificationCounter += 1
    record.hostUi.commandTarget = {
      id: `${record.threadId}:target:${record.hostUi.notificationCounter}`,
      action,
      threadId,
      ...(title ? { title } : {}),
      ...(callerId ? { callerId } : {}),
      ...(editorText !== undefined ? { editorText } : {}),
      message,
      createdAt: Date.now(),
    }
    emitHostUiSnapshot(record)
  }

  /** 投影为协议形状；全空时返回 undefined，避免每个快照携带空对象。 */
  const hostUiViewOf = (record: ThreadRecord): HarnessThreadHostUi | undefined => {
    const ui = record.hostUi
    const statuses = [...ui.statuses.entries()].map(([key, text]) => ({ key, text }))
    const widgets = [...ui.widgets.entries()].map(([key, value]) => ({ key, ...value }))
    if (
      statuses.length === 0 &&
      widgets.length === 0 &&
      ui.notifications.length === 0 &&
      ui.title === undefined &&
      ui.workingMessage === undefined &&
      ui.workingVisible === undefined &&
      ui.hiddenThinkingLabel === undefined &&
      !ui.editorDirective &&
      !ui.commandTarget
    ) {
      return undefined
    }
    return structuredClone({
      statuses,
      widgets,
      notifications: ui.notifications,
      ...(ui.title !== undefined ? { title: ui.title } : {}),
      ...(ui.workingMessage !== undefined ? { workingMessage: ui.workingMessage } : {}),
      ...(ui.workingVisible !== undefined ? { workingVisible: ui.workingVisible } : {}),
      ...(ui.hiddenThinkingLabel !== undefined
        ? { hiddenThinkingLabel: ui.hiddenThinkingLabel }
        : {}),
      ...(ui.editorDirective ? { editorDirective: ui.editorDirective } : {}),
      ...(ui.commandTarget ? { commandTarget: ui.commandTarget } : {}),
    })
  }

  const snapshotOf = (record: ThreadRecord): HarnessThreadSnapshot => {
    // 已持久化的 Shell 结果不再以运行态重复出现。
    releasePersistedBash(record)
    const pending = record.uiBridge.pending()
    const hostUi = hostUiViewOf(record)
    return {
      metadata: metadataOf(record),
      messages: isolateMessages(record.session.messages),
      messageEntryIds: messageEntryIds(record.sessionManager, record.session.messages),
      ...(record.bash ? { bash: bashViewOf(record.bash) } : {}),
      compaction: compactionPhaseOf(record),
      readiness: getModelReadiness(
        modelRuntime,
        record.session.model
          ? {
              provider: record.session.model.provider,
              modelId: record.session.model.id,
            }
          : undefined,
        'session',
      ),
      seq: record.seq,
      ...(pending.length ? { hostUiRequests: pending } : {}),
      ...(hostUi ? { hostUi } : {}),
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

  const emitSnapshot = (record: ThreadRecord) => {
    if (record.retired) return
    emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
  }

  /**
   * 同步占用结构闸门。
   *
   * 必须在任何 await 之前调用：占窗成功后，发送会在预检前看到它并拒绝，
   * 其他结构操作也会明确返回 busy，不存在「await 后请求从旧状态穿过」的窗口。
   * 结构操作与发送互斥但不互相等待（避免与 run admission 形成环）。
   */
  const beginStructure = (
    record: ThreadRecord,
    kind: StructureKind,
    options: { targetId?: string; allowRunning?: boolean } = {},
  ): StructureOperation => {
    assertActive()
    if (record.retired) throw new ThreadStructureBusyError('会话正在关闭，不能修改结构')
    if (record.structure) throw new ThreadStructureBusyError()
    if (record.session.isCompacting) throw new ThreadStructureBusyError('会话正在压缩，请稍后重试')
    // 用户 Shell 直接产生副作用；结构操作（含压缩/分叉/导航）不得越过它，
    // 否则可能在命令执行中切换上下文或分支。
    if (record.bash?.status === 'running' || record.session.isBashRunning) {
      throw new ThreadStructureBusyError('用户 Shell 正在执行，请先取消或等待完成')
    }
    if (
      !options.allowRunning &&
      (record.session.isStreaming || record.currentRun !== undefined || hasOtherInFlight(record))
    ) {
      throw new ThreadStructureBusyError('会话正在运行或发送中，请先停止后再修改结构')
    }
    let markSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    const operation: StructureOperation = {
      kind,
      ...(options.targetId ? { targetId: options.targetId } : {}),
      status: 'running',
      summaryActive: false,
      startedAt: new Date().toISOString(),
      settled,
      markSettled,
      cancel: () => {
        // 收尾可中断长操作：分支摘要与压缩；普通导航/标签是短操作，等待其结束。
        if (kind === 'navigate') record.session.abortBranchSummary()
        if (kind === 'compact') record.session.abortCompaction()
      },
    }
    record.structure = operation
    emitSnapshot(record)
    return operation
  }

  const markStructureSummarizing = (record: ThreadRecord, operation: StructureOperation) => {
    if (record.structure !== operation || operation.status === 'summarizing') return
    operation.status = 'summarizing'
    operation.summaryActive = true
    emitSnapshot(record)
  }

  const releaseStructure = (record: ThreadRecord, operation: StructureOperation) => {
    if (record.structure !== operation) return
    record.structure = undefined
    operation.markSettled()
    emitSnapshot(record)
  }

  /** 删除/销毁前取消并排空结构操作（有上限，不阻塞收尾）。 */
  const cancelAndDrainStructure = async (record: ThreadRecord): Promise<void> => {
    const operation = record.structure
    if (!operation) return
    operation.cancel()
    await withTimeout(operation.settled, STRUCTURE_SETTLE_TIMEOUT_MS, '会话结构操作').catch(
      () => {},
    )
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
    // 压缩运行态：原因从事件维护，失败原因在成功后清除（取消不算失败）。
    if (event.type === 'compaction_start') {
      record.compactionReason = event.reason
      record.lastCompactionAborted = false
    }
    if (event.type === 'compaction_end') {
      record.lastCompactionAborted = event.aborted
      // 取消不算失败；成功会自然清空为 undefined。
      record.lastCompactionError = event.aborted ? undefined : event.errorMessage
      record.compactionReason = undefined
    }
    if (event.type === 'session_info_changed') invalidateCatalog(record.workspacePath)
    // 新会话的 JSONL 直到首条用户消息才真正落盘；空会话创建后列表缓存可能
    // 仍是旧结果。首条用户消息开始时清一次目录缓存，让后续列表看到文件与标题。
    if (event.type === 'message_start' && event.message.role === 'user') {
      invalidateCatalog(record.workspacePath)
    }

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
        // 仅清扫无归属/延迟动作运行（sweep）时只中止 agent，不调用
        // session.abort：后者会顺带中止正在进行的结构摘要，而摘要属于另一个
        // 已占窗的结构操作。其余取消/退休路径仍走完整 session 中止。
        if (sweep && !run.owner?.cancelled && !record.retired) {
          record.session.agent.abort()
        } else {
          // 同步发起中止（内部置标志并 abort controller），不 await：
          // agent 会等待监听器返回，await 会与 waitForIdle 互锁。
          record.session.abort().catch(() => {})
        }
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
    // 运行结算/压缩完成时补权威来源映射与树版本，不在每个 token 聚合整树。
    if (event.type === 'agent_settled' || event.type === 'compaction_end') emitSnapshot(record)

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
      /** 新会话的显式模型（优先于目标项目的默认模型）。 */
      model?: HarnessDefaultModel
      /** 新会话的 Thinking 级别（在模型应用后设置）。 */
      thinkingLevel?: Parameters<AgentSession['setThinkingLevel']>[0]
      /** 已获取的项目装配（createThread 在检查默认模型前已取得）。 */
      project?: { runtime: ProjectRuntime; prepared: PreparedProject }
      /** 会话显式归属的工作区；未归属时为空。 */
      workspaceId?: string
      /**
       * `session_start` 的最小启动事件：fork 子会话传 reason=fork 与父文件，
       * 对照 CLI runtime 行为；其他入口保持 SDK 默认（startup）。
       */
      sessionStartEvent?: SessionStartEvent
      /** 继承的工作区运行快照（fork 子会话复制父会话已应用 revision）。 */
      workspaceAppliedRevision?: number
    },
  ): Promise<ThreadRecord> => {
    const openedGeneration = generation
    throwIfOpenCancelled(opts.signal, openedGeneration)

    // 同一份 loader 直接交给会话：不再经 createHostServices 重装扩展，
    // 避免扩展工厂在一次会话装配中执行两次（第二次也没有信任回调）。
    // 输入守卫在 prepareProjectSession 中已作为合成扩展追加。
    const project = opts.project ?? (await acquireProjectSession(cwd))
    const prepared = project.prepared
    const projectCwd = project.runtime.cwd
    // loader 只能服务一个 live session；这里写入本次会话的工作区归属。
    prepared.workspaceBinding.workspaceId = opts.workspaceId
    const services: AgentSessionServices = {
      cwd: projectCwd,
      agentDir,
      modelRuntime,
      settingsManager: prepared.trust.settingsManager,
      resourceLoader: prepared.trust.resourceLoader,
      diagnostics: [],
    }
    throwIfOpenCancelled(opts.signal, openedGeneration)

    // 查询时缓存的 loader 可能早于用户设置保存；消费前重读设置，资源不重复装配。
    await prepared.trust.settingsManager.reload()
    // 新会话：显式模型 > 目标项目默认模型；冷打开不传，由 SDK 从会话记录恢复。
    const currentDefault = resolveDefaultModel({
      modelRuntime,
      cwd: projectCwd,
      agentDir,
      ...(options.model ? { model: options.model } : {}),
      settingsManager: prepared.trust.settingsManager,
    })
    const newSessionModel = opts.model ?? currentDefault.model
    // 新会话/冷打开都读取已保存的用户默认范围（与 CLI 同口径）：
    // 范围是会话内存状态，不写入 Pi 会话记录；影响模型循环与选择器候选。
    const savedScopePatterns = prepared.trust.settingsManager.getEnabledModels()
    const savedScope = savedScopePatterns?.length
      ? await resolveScopePatterns(savedScopePatterns)
      : { scopedModels: [], diagnostics: [] }
    for (const diagnostic of savedScope.diagnostics) {
      diagnostics.push(`模型范围（${projectCwd}）：${diagnostic.message}`)
    }
    const { session, modelFallbackMessage } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(opts.isNew && newSessionModel ? { model: newSessionModel } : {}),
      ...(savedScope.scopedModels.length ? { scopedModels: savedScope.scopedModels } : {}),
      ...(opts.sessionStartEvent ? { sessionStartEvent: opts.sessionStartEvent } : {}),
    })
    // SDK 在恢复失败时会回退到其他模型；该原因必须可见（不静默）。
    if (modelFallbackMessage) {
      diagnostics.push(`模型回退（${projectCwd}）：${modelFallbackMessage}`)
      safeDiagnostics.add('model-fallback')
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
        diagnostics.push(`Thinking 级别设置（${projectCwd}）：${String(error)}`)
      }
      throwIfOpenCancelled(opts.signal, openedGeneration)
    }

    const threadId = session.sessionId
    const record: ThreadRecord = {
      threadId,
      session,
      sessionManager,
      settingsManager: prepared.trust.settingsManager,
      uiBridge: undefined as unknown as HostUiBridge,
      hostUi: {
        statuses: new Map(),
        widgets: new Map(),
        notifications: [],
        notificationCounter: 0,
        unsupportedReported: new Set(),
        title: undefined,
        workingMessage: undefined,
        workingVisible: undefined,
        hiddenThinkingLabel: undefined,
        editorDirective: undefined,
        commandTarget: undefined,
      },
      unsubscribe: () => {},
      listeners: new Set(),
      seq: 0,
      turnIndex: -1,
      workspacePath: projectCwd,
      workspaceId: opts.workspaceId,
      workspaceAppliedRevision:
        opts.workspaceAppliedRevision ??
        (opts.workspaceId ? workspaceStore.workspace(opts.workspaceId)?.revision : undefined),
      workspaceBinding: prepared.workspaceBinding,
      lastError: undefined,
      resourceLoader: prepared.trust.resourceLoader,
      trustBinding: prepared.trustBinding,
      inFlight: new Set(),
      currentRun: undefined,
      bash: undefined,
      compactionReason: undefined,
      lastCompactionError: undefined,
      lastCompactionAborted: false,
      admission: undefined,
      admissionWaiters: new Set(),
      startingSend: undefined,
      retired: false,
      sweepUnattendedRun: false,
      structure: undefined,
      // 新装配即当前资源版本；成功重载后再递增。
      resourceRevision: resourceRevisionSeq,
      reload: undefined,
    }

    /** 装配期请求的宿主作用域：record 发布前也允许另一窗口发现/应答。 */
    const startupScope: HarnessHostInteractionScope = {
      kind: 'session',
      sessionId: threadId,
      cwd: projectCwd,
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
        notifyHostUi(
          record,
          message,
          type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info',
        )
      },
      onStatus: (key, text) => setHostUiStatus(record, key, text),
      onWidget: (key, lines, placement) => setHostUiWidget(record, key, lines, placement),
      onTitle: (title) => setHostUiTitle(record, title),
      onWorkingMessage: (message) => setHostUiWorkingMessage(record, message),
      onWorkingVisible: (visible) => setHostUiWorkingVisible(record, visible),
      onHiddenThinkingLabel: (label) => setHostUiHiddenThinkingLabel(record, label),
      getEditorText: () => callerDraftOf(threadId),
      onEditorWrite: (text, mode) => writeHostUiEditor(record, text, mode),
      onUnsupported: (method) => reportUnsupportedHostUi(record, method),
      startup: {
        ask: (request, options) =>
          interactions.ask(request, startupScope, {
            ...options,
            signal:
              opts.signal && options?.signal
                ? AbortSignal.any([opts.signal, options.signal])
                : (opts.signal ?? options?.signal),
          }),
        dismissAll: () => interactions.cancelScope(startupScope),
        notify: (message, type) =>
          interactions.notify(
            startupScope,
            message,
            type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info',
          ),
      },
    })
    record.uiBridge = uiBridge
    // 运行边界回调：before_agent_start 固定本轮 revision，供页面显示实际生效版本。
    prepared.workspaceBinding.onApplied = (workspace) => {
      if (record.workspaceAppliedRevision === workspace?.revision) return
      record.workspaceAppliedRevision = workspace?.revision
      emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    }

    // 装配期：session_start handler 的阻断请求进入宿主交互域（另一通道可应答）。
    uiBridge.setStartup(true)

    const onOpenAbort = () => uiBridge.dismissAll()
    opts.signal?.addEventListener('abort', onOpenAbort, { once: true })

    try {
      await session.bindExtensions({
        uiContext: uiBridge.ui,
        // 与 CLI RPC 一致：扩展据此判断非终端环境，不尝试 TUI 专属界面。
        mode: 'rpc',
        commandContextActions: commandActionsFor(record),
        shutdownHandler: () => {
          throw new UnsupportedHostCommandActionError('shutdown')
        },
        onError: (error) => {
          record.lastError = error.error
          emit(record, { type: 'error', error: error.error })
        },
      })
    } catch (error) {
      uiBridge.dismissAll()
      session.dispose()
      throw error
    } finally {
      opts.signal?.removeEventListener('abort', onOpenAbort)
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
    prepared.guard.record = record
    // 离开装配期：清掉 handler 未 await 的遗留请求，避免线程通道出现重复。
    uiBridge.setStartup(false)
    return record
  }

  /**
   * 把新/已打开的 record 包装成 SDK 期望的替换会话上下文。
   *
   * 基础上下文由新会话自己的 ExtensionRunner 生成（绑定到该会话的
   * commandContextActions），再补上 RPC 模式提供的发送方法。
   */
  const replacedContextOf = (target: ThreadRecord): ReplacedSessionContext => {
    const base = target.session.extensionRunner.createCommandContext()
    const context = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base)) as Record<
      string,
      unknown
    >
    context.sendMessage = (
      message: Parameters<AgentSession['sendCustomMessage']>[0],
      options?: Parameters<AgentSession['sendCustomMessage']>[1],
    ) => target.session.sendCustomMessage(message, options)
    context.sendUserMessage = (
      content: Parameters<AgentSession['sendUserMessage']>[0],
      options?: Parameters<AgentSession['sendUserMessage']>[1],
    ) => target.session.sendUserMessage(content, options)
    return context as unknown as ReplacedSessionContext
  }

  /** 会话目标提示：只写入发起会话的快照，父 live record 不替换。 */
  const announceCommandTarget = (
    source: ThreadRecord,
    action: HarnessHostUiCommandTarget['action'],
    target: ThreadRecord,
    message: string,
    editorText?: string,
  ): void => {
    setHostUiCommandTarget(
      source,
      action,
      target.threadId,
      message,
      metadataOf(target).title,
      editorText,
    )
  }

  /** `ctx.newSession()`：设置初始化内容与血缘后绑定独立会话，保留父 record。 */
  const commandNewSession = async (
    source: ThreadRecord,
    options?: CommandNewSessionOptions,
  ): Promise<{ cancelled: boolean }> => {
    const before = await source.session.extensionRunner.emit({
      type: 'session_before_switch',
      reason: 'new',
    })
    if (before?.cancel || source.retired) return { cancelled: true }
    const dir = resolveSessionDirFor(source.workspacePath).dir
    assertSessionFileInScope(join(dir, '.huan-scope-check'), source.workspacePath)
    const manager = SessionManager.create(source.workspacePath, dir, {
      ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
    })
    await options?.setup?.(manager)
    if (source.retired) return { cancelled: true }
    const target = await openSession(manager, source.workspacePath, {
      isNew: true,
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
      ...(source.session.model ? { model: source.session.model } : {}),
      thinkingLevel: source.session.thinkingLevel,
      sessionStartEvent: {
        type: 'session_start',
        reason: 'new',
        ...(source.session.sessionFile ? { previousSessionFile: source.session.sessionFile } : {}),
      },
    })
    try {
      if (source.retired) {
        await abandonRecord(target)
        return { cancelled: true }
      }
      if (source.workspaceId) {
        await workspaceStore.assignSession({
          storeId,
          sessionId: target.threadId,
          workspaceId: source.workspaceId,
        })
      }
    } catch (error) {
      await abandonRecord(target)
      throw error
    }
    announceCommandTarget(source, 'newSession', target, '扩展已新建独立会话')
    if (options?.withSession) await options.withSession(replacedContextOf(target))
    return { cancelled: false }
  }

  /** `ctx.fork()`：复用独立 fork 语义；父会话与历史不变。 */
  const commandFork = async (
    source: ThreadRecord,
    entryId: string,
    options?: Parameters<ExtensionCommandContextActions['fork']>[1],
  ): Promise<{ cancelled: boolean }> => {
    const result = await forkThreadNow(source.threadId, {
      entryId,
      position: options?.position ?? 'before',
    })
    if (result.status === 'cancelled') return { cancelled: true }
    if (result.status !== 'created' || !result.threadId) {
      throw new Error(result.message ?? `分叉失败：${result.status}`)
    }
    const target = records.get(result.threadId)
    if (!target) throw new Error('分叉会话已创建但未取得运行记录')
    announceCommandTarget(source, 'fork', target, '扩展已创建独立分叉会话', result.selectedText)
    if (options?.withSession) await options.withSession(replacedContextOf(target))
    return { cancelled: false }
  }

  /** `ctx.navigateTree()`：走宿主既有结构闸门/摘要语义，不绕过队列恢复。 */
  const commandNavigateTree = async (
    source: ThreadRecord,
    targetId: string,
    options?: Parameters<ExtensionCommandContextActions['navigateTree']>[1],
  ): Promise<{ cancelled: boolean }> => {
    const result = await navigateThreadTreeNow(source.threadId, {
      targetId,
      expectedRevision: sessionTreeRevision(source.sessionManager),
      ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
      ...(options?.customInstructions !== undefined
        ? { customInstructions: options.customInstructions }
        : {}),
      ...(options?.replaceInstructions !== undefined
        ? { replaceInstructions: options.replaceInstructions }
        : {}),
    })
    if (result.status === 'cancelled') return { cancelled: true }
    if (result.status !== 'applied') {
      throw new Error(result.message ?? `会话树导航失败：${result.status}`)
    }
    announceCommandTarget(source, 'navigateTree', source, '扩展已切换会话树落点', result.editorText)
    return { cancelled: false }
  }

  /** `ctx.switchSession()`：把目标文件作为独立会话打开，不替换当前 record。 */
  const commandSwitchSession = async (
    source: ThreadRecord,
    sessionPath: string,
    options?: Parameters<ExtensionCommandContextActions['switchSession']>[1],
  ): Promise<{ cancelled: boolean }> => {
    const file = resolve(sessionPath)
    const before = await source.session.extensionRunner.emit({
      type: 'session_before_switch',
      reason: 'resume',
      targetSessionFile: file,
    })
    if (before?.cancel) return { cancelled: true }
    const scope = assertSessionFileInScope(file, source.workspacePath)
    // 先只读打开获取 sessionId（不传 cwdOverride，否则 SDK 会跳过 header 并新建 ID）。
    const manager = SessionManager.open(file, scope.dir)
    const targetId = manager.getSessionId()
    invalidateCatalog(source.workspacePath)
    const target = await ensureOpen(targetId)
    if (target.threadId !== source.threadId) {
      announceCommandTarget(source, 'switchSession', target, '扩展已切换到另一个独立会话')
      if (options?.withSession) await options.withSession(replacedContextOf(target))
    }
    return { cancelled: false }
  }

  /** 扩展命令上下文动作（与 SDK RPC 模式同形）。 */
  const commandActionsFor = (record: ThreadRecord): ExtensionCommandContextActions => ({
    waitForIdle: () => record.session.waitForIdle(),
    newSession: (options) => commandNewSession(record, options),
    fork: (entryId, options) => commandFork(record, entryId, options),
    navigateTree: (targetId, options) => commandNavigateTree(record, targetId, options),
    switchSession: (sessionPath, options) => commandSwitchSession(record, sessionPath, options),
    // 扩展命令的 ctx.reload：与 GUI /reload、设置面板按钮走同一条受控路径。
    // 命令本身运行在在途发送内，闸门只等待其他发送/运行，因此不会自等死锁。
    reload: async () => {
      const result = await reloadThreadNow(record, 'extension')
      if (result.status === 'busy') throw new ThreadStructureBusyError(result.message)
      if (result.status === 'cancelled') throw new Error(result.message)
      if (result.status === 'failed') throw new Error(result.message)
    },
  })

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
    if (!workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
        workspaceStore.stateFile,
      )
    }
    if (pendingDeletes.has(threadId)) throwOpenCancelled()
    if (coldStructure.has(threadId)) throw new ThreadStructureBusyError()
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
    // 打开也使用同一存储规则（含符号链接真实路径）与统一树落点规则。
    const sessionManager = openScopedSessionManager(info)
    // 归属只在 huan 元数据中查找；没有记录的旧会话保持未归属，不按 cwd 猜测。
    const workspaceId = workspaceStore.sessionWorkspace(storeId, info.id)
    return openSession(sessionManager, info.cwd || workspacePath, {
      isNew: false,
      signal,
      ...(workspaceId ? { workspaceId } : {}),
    })
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
      // 结构操作可能以 allowRunning 占窗（停止并跳转/重命名）；等待者被唤醒后
      // 必须重新检查，不能越过闸门进入预检。
      if (record.structure) return undefined
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

  /** 提交前守卫：已知内置 slash 不能作为普通 prompt 进入模型。 */
  const assertNotReservedCommand = (content: string): void => {
    const command = builtinCommandNameOf(content)
    if (command) throw new ReservedBuiltinCommandError(command)
  }

  /**
   * 提交前图片能力校验。
   *
   * 以当前 live session 的模型元数据为准；模型缺失或未声明 image 都拒绝。
   * 拒绝发生在预检之前，不产生模型请求，也不写会话历史。
   */
  const assertImagesSupported = (record: ThreadRecord, input: HarnessSendMessageInput): void => {
    if (!input.attachments?.some((attachment) => attachment.type === 'image')) return
    const model = record.session.model
    if (model?.input?.includes('image')) return
    throw new ImageInputUnsupportedError(model?.provider, model?.id)
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
  ): Promise<HarnessSendMessageResult> => {
    assertActive()
    // 提交前同步调用方窗口的草稿镜像（扩展 getEditorText 的同步来源）。
    const callerId = callerContext.getStore()
    if (callerId) rememberCallerDraft(record.threadId, callerId, input.content)
    // 内置命令与图片能力都在登记发送前同步拒绝，避免进入 SDK 预检。
    assertNotReservedCommand(input.content)
    assertImagesSupported(record, input)
    // 与结构操作互斥：在登记任何在途发送之前同步检查，结构操作占窗后
    // 这里明确报 busy，不会在 await 后潜入预检。
    if (record.structure) throw new ThreadStructureBusyError()
    if (record.retired) throw new Error('Harness session is retired')

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
    if (admission === undefined) {
      if (record.retired || isCancelled() || inFlight.cancelled) {
        // 等待期间被取消 / 会话进入收尾：不进入预检，按「未启动即取消」上报。
        emit(record, { type: 'agent_end', cancelledBeforeStart: true })
        record.inFlight.delete(inFlight)
        inFlight.markFinished()
        return { disposition: 'cancelled' }
      }
      if (record.structure) {
        // 结构操作（如运行中重命名）在等待期间占窗：明确拒绝，不进入预检。
        record.inFlight.delete(inFlight)
        inFlight.markFinished()
        throw new ThreadStructureBusyError()
      }
    }

    // 占窗返回后再次同步确认结构闸门（防御未来新增的等待路径）。
    if (admission && record.structure) {
      admission.release()
      record.inFlight.delete(inFlight)
      inFlight.markFinished()
      throw new ThreadStructureBusyError()
    }

    try {
      // 预检承诺：接受（含入队）或被拒绝时结算一次。
      let settlePreflight: (error?: unknown) => void = () => {}
      let preflightSettled = false
      const accepted = new Promise<HarnessSendMessageResult>((resolve, reject) => {
        settlePreflight = (error) => {
          if (preflightSettled) return
          preflightSettled = true
          if (error) reject(error)
          else resolve({ disposition: disposition ?? 'handled' })
        }
      })

      // 运行中 Pi 要求显式声明排队语义；默认 followUp。
      const streamingBehavior =
        input.streamingBehavior ?? (record.session.isStreaming ? 'followUp' : undefined)
      // 提交点处置：'handled' 不会产生运行事件，需要补一次权威快照，
      // 否则客户端的乐观输入和侧栏标题会一直停留在未确认状态。
      let disposition: 'started' | 'queued' | 'handled' | undefined

      // 用 AsyncLocalStorage 绑定本次发送：输入守卫据此精确认领（不用文本匹配）。
      // `prompting` 在后台继续（接受语义：不等待运行结束）；其失败已在 catch 内处理。
      void sendContext.run(inFlight, () =>
        record.session
          .prompt(input.content, {
            ...(input.attachments?.length ? { images: input.attachments } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            preflightResult: (dispositionArg) => {
              // 提交点拒绝（已退休 / 已取消）：此刻放行会让 SDK 继续进入
              // `_runAgentPrompt()` 启动运行。
              // - 退休：宿主已退订，无 agent_start 可兜底；
              // - 取消：本发送在闸门等待期间被标记，或以延迟动作身份
              //   在结算窗口后恢复（`_deferredSettledActions`）。
              // 抛错使 prompt 以拒绝收尾（SDK 不捕获此回调异常）。
              if (record.retired) throw new Error('Harness session is retired')
              if (isCancelled() || inFlight.cancelled) throw new Error('Harness send was cancelled')
              inFlight.accepted = true
              disposition = dispositionArg
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
        const result = await accepted
        if (result.disposition === 'handled') emitSnapshot(record)
        return result
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

  // ---- 会话树与结构导航 ----

  /** 运行中导航前按停止语义失效预检、取回整体队列并排空运行。 */
  const stopRunForNavigation = async (record: ThreadRecord): Promise<HarnessTreeQueueRecovery> => {
    const tokens = startingSends.get(record.threadId)
    if (tokens) for (const token of tokens) token.cancelled = true
    for (const pending of record.inFlight) {
      if (!pending.accepted) pending.cancelled = true
    }
    // 已进入「预检通过 → agent_start」窗口的发送也必须失效；否则它可能在
    // 导航开始后启动一个新的运行。
    if (record.startingSend) record.startingSend.cancelled = true
    if (record.currentRun) record.currentRun.cancelled = true
    discardDeferredRuns(record.session)
    record.sweepUnattendedRun = true
    const recovered = record.session.clearQueue()
    wakeAdmissionWaiters(record)
    record.uiBridge.dismissAll()
    await withTimeout(record.session.abort(), STOP_FOR_NAVIGATION_TIMEOUT_MS, '停止运行').catch(
      () => {},
    )
    const run = record.currentRun
    if (run) {
      await withTimeout(run.settled, STOP_FOR_NAVIGATION_TIMEOUT_MS, '等待运行结算').catch(() => {})
    }
    await drainInFlight(record)
    // 停止窗口内仍可能有已通过预检的发送把输入补入 SDK 队列；排空后再取一次，
    // 避免「先清空、后入队」的条目被随运行收尾静默丢弃。
    const late = record.session.clearQueue()
    return {
      steering: [...recovered.steering, ...late.steering],
      followUp: [...recovered.followUp, ...late.followUp],
    }
  }

  /** 落点 sidecar 保存（导航/标签边界唯一写入点）。 */
  const saveSessionLeaf = async (
    record: ThreadRecord,
    leafId: string | null,
  ): Promise<'saved' | 'failed'> => {
    if (!workspaceStore.healthy) return 'failed'
    try {
      await workspaceStore.setSessionLeaf({
        storeId,
        sessionId: record.threadId,
        leaf: { leafId, entryCount: record.sessionManager.getEntryCount() },
      })
      return 'saved'
    } catch (error) {
      diagnostics.push(`会话树落点（${record.threadId}）：${String(error)}`)
      return 'failed'
    }
  }

  /**
   * 持久化失败后恢复可恢复的原落点/上下文。
   *
   * 使用公开 branch/resetLeaf + refreshContext 恢复精确落点，包含用户节点和
   * null；回滚不再次触发扩展导航钩子。已追加摘要无法撤销，另行如实报告。
   */
  const restoreNavigationPosition = async (
    record: ThreadRecord,
    previousLeafId: string | null,
  ): Promise<boolean> => {
    if (!record.retired) {
      if (previousLeafId === null) record.sessionManager.resetLeaf()
      else if (record.sessionManager.getEntry(previousLeafId)) {
        record.sessionManager.branch(previousLeafId)
      } else return false
      record.session.refreshContext()
      return record.sessionManager.getLeafId() === previousLeafId
    }
    return false
  }

  const navigateThreadTreeNow = async (
    threadId: string,
    input: HarnessTreeNavigateInput,
  ): Promise<HarnessTreeNavigateResult> => {
    assertActive()
    const record = await ensureOpen(threadId)
    let operation: StructureOperation
    try {
      operation = beginStructure(record, 'navigate', {
        targetId: input.targetId,
        allowRunning: input.stopRunning === true,
      })
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return {
        status: 'busy',
        leafId: record.sessionManager.getLeafId(),
        treeRevision: sessionTreeRevision(record.sessionManager),
        message: error.message,
      }
    }

    /** 释放结构闸门后再生成快照，避免返回帧携带已结束的操作状态。 */
    const finalize = (result: HarnessTreeNavigateResult): HarnessTreeNavigateResult => {
      releaseStructure(record, operation)
      return {
        ...result,
        leafId: record.sessionManager.getLeafId(),
        treeRevision: sessionTreeRevision(record.sessionManager),
        ...(record.retired ? {} : { snapshot: snapshotOf(record) }),
      }
    }

    let recovered: HarnessTreeQueueRecovery | undefined
    try {
      const revisionAtStart = sessionTreeRevision(record.sessionManager)
      if (input.expectedRevision !== revisionAtStart) {
        return finalize({ status: 'conflict', message: '会话树已变化，请刷新后重试' })
      }
      if (!record.sessionManager.getEntry(input.targetId)) {
        return finalize({ status: 'failed', message: '目标节点不存在，请刷新会话树' })
      }
      if (record.sessionManager.getLeafId() === input.targetId) {
        return finalize({ status: 'applied', persistence: 'skipped' })
      }

      if (
        record.session.isStreaming ||
        record.currentRun !== undefined ||
        hasOtherInFlight(record)
      ) {
        if (input.stopRunning !== true) {
          return finalize({
            status: 'busy',
            message: '会话正在运行，请使用“停止并跳转”',
          })
        }
        recovered = await stopRunForNavigation(record)
        if (record.retired) {
          return finalize({
            status: 'cancelled',
            recoveredQueue: recovered,
            message: '会话已关闭，导航未执行',
          })
        }
        if (record.session.isStreaming || record.session.isCompacting) {
          return finalize({
            status: 'busy',
            recoveredQueue: recovered,
            message: '运行未能在限定时间内停止；队列已取回，请稍后重试',
          })
        }
      }

      const previousLeafId = record.sessionManager.getLeafId()
      const previousTools = record.session.getActiveToolNames()
      if (input.summarize === true) markStructureSummarizing(record, operation)

      let outcome: Awaited<ReturnType<AgentSession['navigateTree']>>
      try {
        outcome = await record.session.navigateTree(input.targetId, {
          summarize: input.summarize === true,
          ...(input.customInstructions?.trim()
            ? { customInstructions: input.customInstructions.trim() }
            : {}),
          ...(input.replaceInstructions === true ? { replaceInstructions: true } : {}),
        })
      } catch (error) {
        operation.summaryActive = false
        return finalize({
          status: 'failed',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          message: error instanceof Error ? error.message : String(error),
        })
      }
      operation.summaryActive = false
      if (operation.status === 'summarizing') {
        // 摘要已完成，后续只剩落点持久化；不再对外宣称可取消摘要。
        operation.status = 'running'
        emitSnapshot(record)
      }

      if (outcome.cancelled) {
        return finalize({
          status: outcome.aborted ? 'aborted' : 'cancelled',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          ...(outcome.summaryEntry ? { summaryCommitted: true } : {}),
          message: outcome.aborted ? '分支摘要已取消，活动落点未改变' : '导航已取消',
        })
      }

      const summaryCommitted = outcome.summaryEntry !== undefined
      if (record.retired) {
        // 退休后的导航只在即将销毁的内存会话中生效，不写 sidecar。
        return finalize({
          status: 'cancelled',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          ...(summaryCommitted ? { summaryCommitted: true } : {}),
          persistence: 'skipped',
          message: '会话已关闭，导航落点未持久化',
        })
      }
      const persistence = await saveSessionLeaf(record, record.sessionManager.getLeafId())
      if (persistence === 'failed') {
        const restored = await restoreNavigationPosition(record, previousLeafId)
        if (restored) record.session.setActiveToolsByName(previousTools)
        return finalize({
          status: 'persistence-failed',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          persistence: 'failed',
          recovered: restored,
          ...(summaryCommitted ? { summaryCommitted: true } : {}),
          message: restored
            ? summaryCommitted
              ? '导航落点保存失败，已恢复原上下文；分支摘要已写入 Pi 文件，无法撤销。'
              : '导航落点保存失败，已恢复原上下文。'
            : '导航落点保存失败，原上下文未能完全恢复；请检查宿主元数据状态。',
        })
      }

      return finalize({
        status: 'applied',
        ...(outcome.editorText !== undefined ? { editorText: outcome.editorText } : {}),
        ...(recovered ? { recoveredQueue: recovered } : {}),
        persistence: 'saved',
        ...(summaryCommitted ? { summaryCommitted: true } : {}),
      })
    } finally {
      // finalize 已释放；此处的幂等调用覆盖异常路径。
      releaseStructure(record, operation)
    }
  }

  const setThreadEntryLabelNow = async (
    threadId: string,
    input: HarnessTreeLabelInput,
  ): Promise<HarnessTreeLabelResult> => {
    assertActive()
    const record = await ensureOpen(threadId)
    let operation: StructureOperation
    try {
      operation = beginStructure(record, 'label', { targetId: input.entryId })
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return {
        status: 'busy',
        treeRevision: sessionTreeRevision(record.sessionManager),
        message: error.message,
      }
    }

    const finalize = (result: HarnessTreeLabelResult): HarnessTreeLabelResult => {
      releaseStructure(record, operation)
      return {
        ...result,
        treeRevision: sessionTreeRevision(record.sessionManager),
        ...(record.retired ? {} : { snapshot: snapshotOf(record) }),
      }
    }

    try {
      const revision = sessionTreeRevision(record.sessionManager)
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
        return finalize({ status: 'conflict', message: '会话树已变化，请刷新后重试' })
      }
      if (!record.sessionManager.getEntry(input.entryId)) {
        return finalize({ status: 'failed', message: '目标节点不存在，请刷新会话树' })
      }
      const beforeLeaf = record.sessionManager.getLeafId()
      const beforeCount = record.sessionManager.getEntryCount()
      const stored = workspaceStore.healthy
        ? workspaceStore.sessionLeaf(storeId, record.threadId)
        : undefined
      const label = input.label?.trim() || undefined
      try {
        record.sessionManager.appendLabelChange(input.entryId, label)
      } catch (error) {
        return finalize({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      // 标签是书签而不是导航：恢复操作前的活动落点，避免后续发送挂到 label entry 下。
      if (record.sessionManager.getLeafId() !== beforeLeaf) {
        if (beforeLeaf === null) record.sessionManager.resetLeaf()
        else record.sessionManager.branch(beforeLeaf)
      }
      // 既有落点仍然有效时只刷新水位，使标签追加的条目不会让落点被误判为过期。
      let persistence: 'saved' | 'failed' | 'skipped' = 'skipped'
      if (
        !record.retired &&
        stored &&
        stored.leafId === beforeLeaf &&
        stored.entryCount === beforeCount
      ) {
        persistence = await saveSessionLeaf(record, beforeLeaf)
      }
      return finalize({
        status: 'applied',
        ...(label ? { label } : {}),
        persistence,
        ...(persistence === 'failed'
          ? { message: '标签已写入 Pi 文件，但落点水位更新失败；重启后可能不恢复该落点。' }
          : {}),
      })
    } finally {
      releaseStructure(record, operation)
    }
  }

  /** 冷树读取：只开 SessionManager 与只读 settings，不装配项目扩展。 */
  const coldBranchSummarySkipPrompt = (cwd: string | undefined): boolean => {
    try {
      return SettingsManager.create(cwd?.trim() || workspacePath, agentDir, {
        projectTrusted: false,
      }).getBranchSummarySkipPrompt()
    } catch {
      return false
    }
  }

  /**
   * 冷读的自动压缩开关（用户级设置，不加载项目设置）。
   *
   * 与热会话同一显示口径：重启后未打开会话也能看到当前用户默认值。
   */
  const coldAutoCompactionEnabled = (cwd: string | undefined): boolean | undefined => {
    try {
      return SettingsManager.create(cwd?.trim() || workspacePath, agentDir, {
        projectTrusted: false,
      }).getCompactionEnabled()
    } catch {
      return undefined
    }
  }

  // ---- 独立分支（fork / clone） ----
  const errorText = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : String(error)

  /**
   * fork/clone：独立子会话文件 + 独立 live record，父会话保留。
   *
   * 关键边界：
   * - 源会话必须空闲；运行中返回 busy，GUI 显式停止后重试；
   * - `session_before_fork` 可取消，取消时不创建文件/元数据；
   * - 子文件由独立 SessionManager 创建，绝不触碰 live 父 manager；
   * - 子 record 独立装配并继承工作区归属，但不继承归档标记；
   * - 失败只清理本次新建的文件与 record，不删除源或已有冲突文件。
   */
  const forkThreadNow = async (
    threadId: string,
    input: HarnessThreadForkInput,
  ): Promise<HarnessThreadForkResult> => {
    assertActive()
    /**
     * 冷打开前先记录文件中的 revision。
     *
     * SDK 在首次打开无 Thinking 记录的旧会话时会补写一条规范化条目，冷树读取
     * 得到的 revision 与随后 live record 不再相同。只用文件版 revision 兼容这个
     * 可预期的差异；若外部/其他窗口在树读取后真的追加了条目，两份 revision
     * 都会不同，仍返回 conflict。
     */
    let preOpenRevision: string | undefined
    if (!records.has(threadId) && input.expectedRevision !== undefined) {
      try {
        const info = await findSessionInfo(threadId)
        if (info) preOpenRevision = sessionTreeRevision(openScopedSessionManager(info))
      } catch {
        // 定位失败交给 ensureOpen 报告可读错误。
      }
    }
    const record = await ensureOpen(threadId)
    const position = input.position ?? 'before'
    let operation: StructureOperation
    try {
      operation = beginStructure(record, 'fork', input.entryId ? { targetId: input.entryId } : {})
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return { status: 'busy', message: error.message }
    }

    const finalize = (result: HarnessThreadForkResult): HarnessThreadForkResult => {
      releaseStructure(record, operation)
      return result
    }

    try {
      if (input.expectedRevision !== undefined) {
        const revision = sessionTreeRevision(record.sessionManager)
        if (input.expectedRevision !== revision && input.expectedRevision !== preOpenRevision) {
          return finalize({ status: 'conflict', message: '会话树已变化，请刷新后重试' })
        }
      }
      // 源会话必须空闲：运行中不静默中止父会话，交由 GUI 显式停止。
      if (
        record.session.isStreaming ||
        record.session.isCompacting ||
        record.currentRun !== undefined ||
        hasOtherInFlight(record)
      ) {
        return finalize({ status: 'busy', message: '会话正在运行，请先停止后再分叉' })
      }

      const target = resolveForkTarget(record.sessionManager, position, input.entryId)
      if (!target.ok) return finalize({ status: 'failed', message: target.message })

      // 扩展取消：只在存在可 fork 节点时发事件（空会话 clone 没有节点）。
      // 事件可能在父会话上触发延迟动作；fork 不得改变父历史，统一丢弃。
      if (target.entryId) {
        const runner = record.session.extensionRunner
        if (runner.hasHandlers('session_before_fork')) {
          try {
            const result = await runner.emit({
              type: 'session_before_fork',
              entryId: target.entryId,
              position,
            })
            if (result?.cancel === true) {
              return finalize({ status: 'cancelled', message: '扩展取消了本次分叉' })
            }
          } catch (error) {
            return finalize({ status: 'failed', message: errorText(error) })
          } finally {
            discardDeferredRuns(record.session)
          }
          if (record.retired) {
            return finalize({ status: 'cancelled', message: '会话已关闭，未创建分叉' })
          }
        }
      }

      const cwd = record.workspacePath
      const sessionDir = resolveSessionDirFor(cwd).dir
      // 尚未生成子文件名，先用探针路径挡住越界/符号链接。
      try {
        assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
      } catch (error) {
        return finalize({ status: 'failed', message: errorText(error) })
      }

      let child: ReturnType<typeof createForkSessionManager>
      try {
        child = createForkSessionManager({
          sourceFile: record.session.sessionFile,
          cwd,
          sessionDir,
          targetLeafId: target.targetLeafId,
        })
      } catch (error) {
        return finalize({
          status: 'failed',
          message: error instanceof ForkSessionCreateError ? error.message : errorText(error),
        })
      }

      let childRecord: ThreadRecord | undefined
      try {
        const project = await acquireProjectSession(cwd)
        // 删除/关闭可能在本操作 await 期间开始；已退役时不得再创建子文件。
        if (record.retired) throw new ForkSessionCreateError('会话已关闭，未创建分叉')
        const parentModel = record.session.model
        const empty = target.targetLeafId === null
        childRecord = await openSession(child.sessionManager, cwd, {
          // 空子会话没有历史可恢复：显式继承父会话当前模型/Thinking；
          // 非空子会话交 SDK 从分支条目恢复（不拿父当前状态覆盖分支历史）。
          isNew: empty,
          project,
          ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
          ...(empty && parentModel ? { model: parentModel } : {}),
          ...(empty ? { thinkingLevel: record.session.thinkingLevel } : {}),
          ...(record.workspaceAppliedRevision !== undefined
            ? { workspaceAppliedRevision: record.workspaceAppliedRevision }
            : {}),
          sessionStartEvent: {
            type: 'session_start',
            reason: 'fork',
            ...(record.session.sessionFile
              ? { previousSessionFile: record.session.sessionFile }
              : {}),
          },
        })
        if (record.retired) throw new ForkSessionCreateError('会话已关闭，未创建分叉')
        // 子会话继承显式工作区归属；新 ID 没有归档标记，不继承归档。
        if (record.workspaceId) {
          await workspaceStore.assignSession({
            storeId,
            sessionId: childRecord.threadId,
            workspaceId: record.workspaceId,
          })
        }
      } catch (error) {
        const createdFile = childRecord?.session.sessionFile ?? child.sessionFile
        if (childRecord) await abandonRecord(childRecord).catch(() => {})
        if (createdFile) await unlink(createdFile).catch(() => {})
        invalidateCatalog(cwd)
        return finalize(
          record.retired
            ? { status: 'cancelled', message: '会话已关闭，未创建分叉' }
            : { status: 'failed', message: errorText(error) },
        )
      }

      invalidateCatalog(cwd)
      return finalize({
        status: 'created',
        threadId: childRecord.threadId,
        parentThreadId: record.threadId,
        ...(target.selectedText !== undefined ? { selectedText: target.selectedText } : {}),
        snapshot: snapshotOf(childRecord),
      })
    } catch (error) {
      return finalize({ status: 'failed', message: errorText(error) })
    } finally {
      // finalize 已释放；此处的幂等调用覆盖异常路径。
      releaseStructure(record, operation)
    }
  }

  // ---- JSONL 导入（预览只读文件；确认重验并串行写入） ----

  /** 导入确认在宿主内串行提交，避免同 ID 的并发请求各写一份。 */
  let importQueue: Promise<unknown> = Promise.resolve()
  const withImportLock = <T>(run: () => Promise<T>): Promise<T> => {
    const result = importQueue.then(run, run)
    importQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const workspaceMember = (workspace: WorkspaceStoreWorkspace, path: string): boolean =>
    workspace.projects.some((project) => pathKey(project.path) === pathKey(path))

  /** 预览/确认共用的源摘要。 */
  const importSourceInfo = (
    source: HarnessThreadImportSource,
    parsed: ParsedImportSession,
  ): HarnessThreadImportSourceInfo => ({
    kind: source.kind,
    id: parsed.header.id,
    cwd: parsed.header.cwd,
    ...(parsed.name ? { name: parsed.name } : {}),
    entries: parsed.entries.length,
    version: parsed.sourceVersion,
    size: parsed.size,
    fingerprint: parsed.fingerprint,
  })

  /** 起始目录解析：源 cwd 可用且为成员时默认使用，否则要求显式替代成员。 */
  type ImportCwdResolution =
    | {
        ok: true
        cwd: string
        overrideUsed: boolean
        sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
      }
    | {
        ok: false
        error: 'cwd-required' | 'cwd-unavailable' | 'cwd-not-member'
        message: string
        sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
      }

  const resolveImportCwd = (
    workspace: WorkspaceStoreWorkspace,
    sourceCwdRaw: string,
    cwdOverride: string | undefined,
  ): ImportCwdResolution => {
    const sourceCwdPath = sourceCwdRaw.trim()
    // 源 cwd 必须是绝对路径；相对路径会按宿主进程目录隐式解析，不能作为
    // 用户选择的目标。缺失/非法时要求显式选择工作区成员作为替代目录。
    const sourceCwd =
      sourceCwdPath && isAbsolute(sourceCwdPath) ? canonicalProjectPath(sourceCwdPath) : undefined
    const sourceCwdInfo = sourceCwd
      ? {
          path: sourceCwd,
          available: isAvailableDirectory(sourceCwd),
          workspaceMember: workspaceMember(workspace, sourceCwd),
        }
      : undefined

    const override = cwdOverride?.trim()
    if (override) {
      const cwd = canonicalProjectPath(override)
      if (!workspaceMember(workspace, cwd)) {
        return {
          ok: false,
          error: 'cwd-not-member',
          message: '替代起始目录必须是目标工作区的成员',
          ...(sourceCwdInfo ? { sourceCwd: sourceCwdInfo } : {}),
        }
      }
      if (!isAvailableDirectory(cwd)) {
        return {
          ok: false,
          error: 'cwd-unavailable',
          message: '替代起始目录不存在或不可用',
          ...(sourceCwdInfo ? { sourceCwd: sourceCwdInfo } : {}),
        }
      }
      return {
        ok: true,
        cwd,
        overrideUsed: true,
        ...(sourceCwdInfo ? { sourceCwd: sourceCwdInfo } : {}),
      }
    }

    if (!sourceCwdInfo) {
      return {
        ok: false,
        error: 'cwd-required',
        message: '源会话没有起始目录，请选择目标工作区成员作为替代目录',
      }
    }
    if (!sourceCwdInfo.workspaceMember) {
      return {
        ok: false,
        error: 'cwd-not-member',
        message: '源起始目录不在目标工作区内，请选择成员作为替代目录',
        sourceCwd: sourceCwdInfo,
      }
    }
    if (!sourceCwdInfo.available) {
      return {
        ok: false,
        error: 'cwd-unavailable',
        message: '源起始目录不存在，请选择成员作为替代目录',
        sourceCwd: sourceCwdInfo,
      }
    }
    return { ok: true, cwd: sourceCwdInfo.path, overrideUsed: false, sourceCwd: sourceCwdInfo }
  }

  /** 预览/确认共用的分析和结果。 */
  type ImportAnalysis =
    | {
        ok: true
        parsed: ParsedImportSession
        sourcePath?: string
        workspaceId: string
        cwd: string
        sessionDir: string
        sourceInfo: HarnessThreadImportSourceInfo
        sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
        warnings: string[]
        existing?: { id: string; path: string }
        conflict: 'none' | 'already-exists' | 'conflict'
      }
    | { ok: false; preview: HarnessThreadImportPreview }

  const importFailure = (
    error: HarnessThreadImportErrorCode,
    message: string,
    extra: Partial<HarnessThreadImportPreview> = {},
  ): ImportAnalysis => ({
    ok: false,
    preview: { status: 'invalid', error, message, ...extra },
  })

  /**
   * 读取源、严格解析、解析 cwd、检查目标作用域与同 ID 冲突。
   *
   * 只读文件与 sidecar，不装配项目、不执行项目代码；确认路径会再次调用本函数。
   */
  const analyzeImport = async (input: HarnessThreadImportPreviewInput): Promise<ImportAnalysis> => {
    const workspaceId = input.workspaceId ?? startupWorkspaceId
    if (!workspaceId) {
      return importFailure('invalid-input', '没有可用工作区，不能导入会话')
    }
    const workspace = workspaceStore.workspace(workspaceId)
    if (!workspace) return importFailure('invalid-input', '目标工作区不存在')

    const read = await readImportSource(input.source)
    if ('error' in read) {
      return importFailure(read.error, read.message, {
        workspaceId,
        source: { kind: input.source.kind },
      })
    }
    const parsed = parseSessionJsonl(read.text)
    if ('error' in parsed) {
      return importFailure(parsed.error, parsed.message, {
        workspaceId,
        source: { kind: input.source.kind },
      })
    }
    const sourceInfo = importSourceInfo(input.source, parsed)

    const cwdResolution = resolveImportCwd(workspace, parsed.header.cwd, input.cwdOverride)
    if (!cwdResolution.ok) {
      return importFailure(cwdResolution.error, cwdResolution.message, {
        workspaceId,
        source: sourceInfo,
        ...(cwdResolution.sourceCwd ? { sourceCwd: cwdResolution.sourceCwd } : {}),
      })
    }
    const cwd = cwdResolution.cwd
    const sessionDir = resolveSessionDirFor(cwd).dir
    try {
      // 目标目录不得越过存储作用域（含符号链接/父目录链接）。
      assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
    } catch (error) {
      return importFailure('scope-invalid', errorText(error), {
        workspaceId,
        source: sourceInfo,
        cwd,
        sessionDir,
        ...(cwdResolution.sourceCwd ? { sourceCwd: cwdResolution.sourceCwd } : {}),
      })
    }

    // 冲突检查必须重新扫描整个目标作用域，不能信任目录缓存。
    let infos: SessionCatalogInfo[]
    try {
      infos = await scanScopeInfos(scopeOf(cwd))
    } catch (error) {
      return importFailure('scope-invalid', `无法读取目标存储目录：${errorText(error)}`, {
        workspaceId,
        source: sourceInfo,
        cwd,
        sessionDir,
      })
    }
    const existing = pickSessionInfo(infos, parsed.header.id)
    let conflict: 'none' | 'already-exists' | 'conflict' = 'none'
    if (existing) {
      const plan = planImportWrite(parsed, {
        cwd,
        ...(read.sourcePath ? { sourcePath: read.sourcePath } : {}),
        asCopy: false,
      })
      const sameFile = read.sourcePath
        ? pathKey(canonicalProjectPath(read.sourcePath)) ===
          pathKey(canonicalProjectPath(existing.path))
        : false
      if (sameFile) conflict = 'already-exists'
      else {
        const existingText = await readFile(existing.path, 'utf8').catch(() => undefined)
        conflict =
          existingText !== undefined && importMatchesExisting(existingText, parsed, plan)
            ? 'already-exists'
            : 'conflict'
      }
    }

    const warnings: string[] = [
      '导入会把文件内容复制到本机会话目录；请确认其中没有不希望持久化的敏感信息。',
    ]
    if (parsed.migrated) {
      warnings.push(
        `源会话是旧版 v${parsed.sourceVersion}，导入时会迁移到 v${parsed.header.version}。`,
      )
    }
    if (cwdResolution.overrideUsed) {
      warnings.push('源起始目录不可用或不属于目标工作区，将使用所选成员作为替代起始目录。')
    }
    if (conflict === 'conflict') {
      warnings.push(
        '目标存储已有同 ID 但内容不同的会话；作为副本导入会生成新会话 ID 并保留完整树。',
      )
    }

    return {
      ok: true,
      parsed,
      ...(read.sourcePath ? { sourcePath: read.sourcePath } : {}),
      workspaceId,
      cwd,
      sessionDir,
      sourceInfo,
      ...(cwdResolution.sourceCwd ? { sourceCwd: cwdResolution.sourceCwd } : {}),
      warnings,
      ...(existing ? { existing: { id: existing.id, path: existing.path } } : {}),
      conflict,
    }
  }

  const previewOf = (analysis: ImportAnalysis): HarnessThreadImportPreview => {
    if (!analysis.ok) return analysis.preview
    return {
      status: 'ok',
      source: analysis.sourceInfo,
      workspaceId: analysis.workspaceId,
      cwd: analysis.cwd,
      ...(analysis.sourceCwd ? { sourceCwd: analysis.sourceCwd } : {}),
      sessionDir: analysis.sessionDir,
      conflict: analysis.conflict,
      ...(analysis.existing ? { existingThreadId: analysis.existing.id } : {}),
      ...(analysis.conflict === 'conflict' ? { canCopy: true } : {}),
      warnings: analysis.warnings,
    }
  }

  const previewThreadImportNow = async (
    input: HarnessThreadImportPreviewInput,
  ): Promise<HarnessThreadImportPreview> => {
    assertActive()
    if (!workspaceStore.healthy) {
      return {
        status: 'failed',
        error: 'state-unavailable',
        message: '工作区元数据不可用，无法检查导入目标；请修复 state.json 后重启宿主',
      }
    }
    try {
      return previewOf(await analyzeImport(input))
    } catch (error) {
      return { status: 'failed', error: 'invalid-input', message: errorText(error) }
    }
  }

  /**
   * 确认导入：重新读取/校验源与冲突，再走项目信任入口，最后独占写入。
   *
   * 预览不是授权 token；期间的源变化、目录变化与同 ID 占用都会在此被拒绝。
   */
  const importThreadNow = async (
    input: HarnessThreadImportInput,
  ): Promise<HarnessThreadImportResult> => {
    assertActive()
    if (!workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
        workspaceStore.stateFile,
      )
    }
    const analysis = await analyzeImport({
      source: input.source,
      workspaceId: input.workspaceId,
      ...(input.cwdOverride !== undefined ? { cwdOverride: input.cwdOverride } : {}),
    })
    const preview = previewOf(analysis)
    if (!analysis.ok) {
      return {
        status: 'invalid',
        preview,
        ...(preview.error ? { error: preview.error } : {}),
        ...(preview.message ? { message: preview.message } : {}),
      }
    }
    if (
      (input.expectedSourceId && analysis.sourceInfo.id !== input.expectedSourceId) ||
      (input.expectedSourceFingerprint &&
        analysis.parsed.fingerprint !== input.expectedSourceFingerprint)
    ) {
      return {
        status: 'invalid',
        preview,
        error: 'source-changed',
        message: '源会话内容或 ID 已变化，请重新预览后再导入',
      }
    }
    if (analysis.conflict === 'already-exists') {
      return {
        status: 'already-exists',
        ...(analysis.existing ? { existingThreadId: analysis.existing.id } : {}),
        preview,
        message: '目标存储中已有内容完全相同的会话',
      }
    }
    if (analysis.conflict === 'conflict' && input.asCopy !== true) {
      return {
        status: 'conflict',
        preview,
        message: '同一会话 ID 的内容不同；如确需导入，请选择“作为独立副本导入”',
      }
    }

    // 信任入口：与新建/激活会话一致；needs-trust 抛可识别错误，GUI 决定后重试。
    const projectInfo = await queryProject(analysis.cwd)
    if (projectInfo.status === 'needs-trust') {
      throw new ProjectTrustRequiredError(projectInfo)
    }
    if (projectInfo.status === 'failed') {
      return {
        status: 'failed',
        preview,
        error: 'scope-invalid',
        message: '目标项目装配失败，请检查路径与宿主诊断',
      }
    }

    assertActive()
    // 项目装配可能异步等待；提交前复查工作区成员，避免已移除目录仍被导入。
    const currentWorkspace = workspaceStore.workspace(analysis.workspaceId)
    if (!currentWorkspace || !workspaceMember(currentWorkspace, analysis.cwd)) {
      return {
        status: 'invalid',
        error: 'cwd-not-member',
        message: '目标工作区成员已变化，请重新预览',
      }
    }
    // 是否生成新 ID：冲突副本或用户显式要求副本；已完全相同的情况已在上面返回。
    const asCopy = analysis.existing !== undefined || input.asCopy === true
    const plan = planImportWrite(analysis.parsed, {
      cwd: analysis.cwd,
      ...(analysis.sourcePath ? { sourcePath: analysis.sourcePath } : {}),
      asCopy,
    })
    const targetPath = join(analysis.sessionDir, importFileName(analysis.parsed, plan.id))
    try {
      assertSessionFileInScope(targetPath, analysis.cwd)
    } catch (error) {
      return { status: 'failed', preview, error: 'scope-invalid', message: errorText(error) }
    }

    try {
      await mkdir(analysis.sessionDir, { recursive: true })
      // 独占写入：绝不覆盖既有文件；内部并发已由导入队列串行化。
      await writeFile(targetPath, buildImportText(analysis.parsed, plan), { flag: 'wx' })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        status: code === 'EEXIST' ? 'conflict' : 'failed',
        preview,
        error: 'write-failed',
        message:
          code === 'EEXIST'
            ? '目标文件已存在，请重新预览后再导入'
            : `写入导入文件失败：${errorText(error)}`,
      }
    }
    // 文件已出现：先让列表缓存失效，再保存归属。
    invalidateCatalog(analysis.cwd)
    try {
      await workspaceStore.assignSession({
        storeId,
        sessionId: plan.id,
        workspaceId: analysis.workspaceId,
      })
    } catch (error) {
      // 文件保留为可发现的未归属会话，不删除、不伪报成功。
      return {
        status: 'metadata-failed',
        threadId: plan.id,
        preview,
        error: 'metadata-failed',
        message: `导入文件已写入，但会话归属保存失败：${errorText(error)}`,
      }
    }
    return {
      status: 'imported',
      threadId: plan.id,
      preview: { ...preview, conflict: 'none', canCopy: false },
    }
  }

  // ---- 删除 ----
  const deleteThreadNow = async (threadId: string): Promise<void> => {
    // 冷重命名等尚未 live 的结构操作先拒绝删除，避免边写边删。
    if (coldStructure.has(threadId)) throw new ThreadStructureBusyError()
    pendingOpens.get(threadId)?.controller.abort()
    const record = records.get(threadId)
    const info = record ? undefined : await findSessionInfo(threadId)
    if (!record && !info) {
      // 上次可能已删除文件但侧车清理失败；重试仍须完成清理。
      await workspaceStore.removeSessionMetadata({ storeId, sessionId: threadId })
      return
    }
    // 已知侧车不可写时在删除文件前拒绝，避免可预知的部分删除。
    if (!workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
        workspaceStore.stateFile,
      )
    }
    const sessionFile = record?.session.sessionFile ?? info?.path
    const cwd = record?.workspacePath ?? info?.cwd
    if (!sessionFile) throw new Error(`Unknown thread: ${threadId}`)
    // 在中止或移除 live record 之前拒绝越界路径，失败不得先破坏当前会话。
    assertSessionFileInScope(sessionFile, cwd)

    if (record) {
      // 0) 进入收尾：不再接受新运行，并唤醒等待闸门的发送使其退出。
      record.retired = true
      wakeAdmissionWaiters(record)
      // 0.4) 取消并等待用户 Shell 结束（外部副作用不可撤销，但必须释放清理）。
      await abortUserBashForRetire(record)
      // 0.5) 取消并排空结构操作（导航摘要可中止），不能在退休 record 上继续提交。
      await cancelAndDrainStructure(record)
      // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
      discardDeferredRuns(record.session)
      // 1) 使在途发送（含预检）失效，避免删除后仍启动运行。
      for (const pending of record.inFlight) pending.cancelled = true
      // 2) 先解除阻断式 UI 等待，否则 abort 可能等一个永不应答的对话（工具在等 UI）。
      record.uiBridge.dismissAll()
      // 3) 中止运行并等待收尾（此时工具/UI 已不再阻断；等待有上限）。
      await abortForRetire(record.session)
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
      forgetEditorMirrors(threadId)
    }
    // 删除同样限于当前存储作用域（防止作用域外路径被作用到）。
    assertSessionFileInScope(sessionFile, cwd)
    await unlink(sessionFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (cwd) invalidateCatalog(cwd)
    // 文件删除成功后才清理归属与归档元数据。文件与 sidecar 没有跨文件事务，
    // 清理失败必须报告（由调用方呈现），不伪造成功。
    await workspaceStore.removeSessionMetadata({ storeId, sessionId: threadId })
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
        SessionManager.open(
          record.session.sessionFile ?? '',
          resolveSessionDirFor(record.workspacePath).dir,
        ),
        new ModelRegistry(modelRuntime),
      )
      await runner.emit({ type: 'session_shutdown', reason })
    } catch (error) {
      diagnostics.push(`session_shutdown（${record.workspacePath}）：${String(error)}`)
    }
  }

  /**
   * 收尾一个刚创建但归属保存失败的会话：保留 Pi 文件供「未归属」发现，
   * 不删除、不伪报创建成功。
   */
  const abandonRecord = async (record: ThreadRecord): Promise<void> => {
    record.retired = true
    wakeAdmissionWaiters(record)
    await abortUserBashForRetire(record)
    await cancelAndDrainStructure(record)
    discardDeferredRuns(record.session)
    for (const pending of record.inFlight) pending.cancelled = true
    record.uiBridge.dismissAll()
    await abortForRetire(record.session)
    await drainInFlight(record)
    await emitShutdown(record, 'quit')
    discardDeferredRuns(record.session)
    record.session.dispose()
    record.unsubscribe()
    records.delete(record.threadId)
    if (record.session.sessionFile) recordsBySessionFile.delete(record.session.sessionFile)
    forgetEditorMirrors(record.threadId)
  }

  /** 作用域模式去重（保持输入顺序）；空字符串忽略。 */
  const normalizePatterns = (patterns: readonly string[]): string[] => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const pattern of patterns) {
      const value = pattern.trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      result.push(value)
    }
    return result
  }

  /**
   * 用公开解析器把范围模式解析为会话可用的 scoped models。
   *
   * 解析失败不阻断会话打开：返回空范围（= 全部）并附诊断；不得静默丢弃
   * 用户配置而不提示。
   */
  const resolveScopePatterns = async (
    patterns: readonly string[],
  ): Promise<{
    scopedModels: Awaited<ReturnType<typeof resolveModelScopeWithDiagnostics>>['scopedModels']
    diagnostics: HarnessModelScopeDiagnostic[]
  }> => {
    const cleaned = normalizePatterns(patterns)
    if (cleaned.length === 0) return { scopedModels: [], diagnostics: [] }
    try {
      const result = await resolveModelScopeWithDiagnostics(cleaned, modelRuntime, {
        signal: AbortSignal.timeout(10_000),
      })
      return {
        scopedModels: result.scopedModels,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          pattern: diagnostic.pattern,
        })),
      }
    } catch (error) {
      diagnostics.push(`模型范围解析：${errorText(error)}`)
      safeDiagnostics.add('assembly-warning')
      return {
        scopedModels: [],
        diagnostics: [
          {
            code: 'no-match',
            pattern: cleaned.join(', '),
            message: '模型范围解析失败，本次按全部可用模型处理',
          },
        ],
      }
    }
  }

  /** 当前会话范围（空 = 全部）与已保存用户默认。 */
  const modelScopeOf = async (record: ThreadRecord): Promise<HarnessModelScope> => {
    const scoped = record.session.scopedModels
    // 展示的是「用户默认」（agentDir 全局）；项目设置覆盖不伪装成用户默认。
    const saved = record.settingsManager
      .getGlobalSettings()
      .enabledModels?.filter((item) => typeof item === 'string')
    // 已保存默认的解析诊断只在读取时计算（可能含 no-match/ambiguous），不影响会话。
    const savedResolution = saved?.length ? await resolveScopePatterns(saved) : undefined
    return {
      patterns: scoped.map((item) => `${item.model.provider}/${item.model.id}`),
      models: scoped.map((item) => ({
        provider: item.model.provider,
        modelId: item.model.id,
        ...(item.thinkingLevel ? { thinkingLevel: item.thinkingLevel } : {}),
      })),
      diagnostics: savedResolution?.diagnostics ?? [],
      ...(saved?.length ? { savedPatterns: saved } : {}),
    }
  }

  let settingsWrites: Promise<unknown> = Promise.resolve()
  const withSettingsWrite = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = settingsWrites.then(action)
    settingsWrites = pending.catch(() => {})
    return pending
  }

  /**
   * 用独立管理器保存用户设置，失败不改 live 会话缓存。
   * SDK 按修改字段合并磁盘并持有文件锁；串行提交后再同步各会话。
   */
  const writeGlobalSetting = async (
    record: ThreadRecord,
    label: string,
    apply: (manager: SettingsManager) => void,
    verify: () => Promise<boolean>,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    assertActive()
    if (record.retired) return { ok: false, message: '会话正在关闭，设置未保存' }
    const manager = SettingsManager.create(record.workspacePath, agentDir, {
      projectTrusted: false,
    })
    // 先清掉之前积压的写盘错误，避免误归因到本次设置。
    for (const stale of manager.drainErrors()) {
      diagnostics.push(`${label}（旧错误）${record.workspacePath}：${String(stale.error)}`)
    }
    try {
      apply(manager)
      await manager.flush()
    } catch (error) {
      diagnostics.push(`${label}（${record.workspacePath}）：${errorText(error)}`)
    }
    const errors = manager.drainErrors()
    for (const error of errors) {
      diagnostics.push(`${label}（${record.workspacePath}）：${String(error.error)}`)
    }
    const persisted = errors.length === 0 ? await verify().catch(() => false) : false
    if (persisted) return { ok: true }
    return {
      ok: false,
      message: `${label}保存失败或未能确认，请检查用户设置文件（settings.json）。`,
    }
  }

  /** 读取 agentDir 用户设置原文（校验写盘结果用）；坏文件按不可确认处理。 */
  const readUserSettings = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const text = await readFile(join(agentDir, 'settings.json'), 'utf8')
      const parsed: unknown = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 全局设置变更后同步其他已打开会话的设置缓存并广播快照。
   *
   * 每个 live session 有独立的 SettingsManager；不刷新则旧会话仍显示旧值。
   */
  const syncSettingsCaches = async (source: ThreadRecord): Promise<void> => {
    for (const other of [...records.values()]) {
      if (other.retired) continue
      try {
        // 先排空其他会话自己的待写入，避免 reload 丢弃尚未落盘的修改。
        await other.settingsManager.flush()
        await other.settingsManager.reload()
      } catch (error) {
        diagnostics.push(`设置同步（${other.workspacePath}）：${errorText(error)}`)
      }
      emitSnapshot(other)
    }
    emitSnapshot(source)
  }

  /** 把 Pi 的 BashResult 投影为协议结果摘要。 */
  const bashResultOf = (result: {
    exitCode: number | undefined
    cancelled: boolean
    truncated: boolean
    fullOutputPath?: string
  }): HarnessBashResult => ({
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    cancelled: result.cancelled,
    truncated: result.truncated,
    ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
    endedAt: new Date().toISOString(),
  })

  /** 截断有界输出并返回被丢弃的字符数。 */
  const boundBashOutput = (run: UserBashRun): number => {
    if (run.output.length <= BASH_OUTPUT_MAX_CHARS) return 0
    const dropped = run.output.length - BASH_OUTPUT_MAX_CHARS
    run.output = run.output.slice(dropped)
    run.outputTruncated = true
    return dropped
  }

  /**
   * 直接执行用户 Shell（`!` / `!!`）。
   *
   * 与 CLI 同口径：先发 `user_bash` 扩展事件；扩展给出完整结果时按
   * `recordBashResult` 语义入历史，否则本地执行；扩展报错时不回退执行。
   * 扩展事件 await 之前先同步登记启动占位，防止并发启动第二条 Shell；
   * 运行态（输出/取消/快照）在占位转为正式运行后立即可见。
   */
  const runThreadBashNow = async (
    threadId: string,
    input: { command: string; excludeFromContext?: boolean },
  ): Promise<HarnessBashStartResult> => {
    assertActive()
    const command = input.command
    if (!command.trim()) return { status: 'failed', message: '命令不能为空' }
    const record = await ensureOpen(threadId)
    const busy = (): HarnessBashStartResult | undefined => {
      if (record.retired) return { status: 'failed', message: '会话正在关闭，无法执行 Shell' }
      if (record.bash?.status === 'running' || record.session.isBashRunning) {
        return { status: 'busy', message: '当前会话已有一条用户 Shell 在执行，请先取消或等待完成' }
      }
      if (record.structure || record.session.isCompacting) {
        return { status: 'busy', message: '会话结构操作或压缩进行中，请稍后再执行 Shell' }
      }
      return undefined
    }
    const blocked = busy()
    if (blocked) return blocked

    const excludeFromContext = input.excludeFromContext === true
    let markDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      markDone = resolve
    })
    const run: UserBashRun = {
      id: `bash:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      command,
      excludeFromContext,
      cwd: record.workspacePath,
      status: 'running',
      output: '',
      outputTruncated: false,
      startedAt: new Date().toISOString(),
      cancelRequested: false,
      recorded: false,
      done,
    }
    record.bash = run
    emit(record, { type: 'bash_start', run: bashViewOf(run) })

    const onChunk = (chunk: string): void => {
      if (record.bash !== run) return
      run.output += chunk
      const dropped = boundBashOutput(run)
      emit(record, { type: 'bash_output', id: run.id, delta: chunk, dropped })
    }

    // 后台执行：RPC 返回 started 即「已登记」，不等待命令结束。
    void (async () => {
      let result: HarnessBashResult
      try {
        // 先发布运行态再等待扩展：启动 HTTP 不阻塞于交互，取消可覆盖钩子窗口。
        const extensionResult = await record.session.extensionRunner.emitUserBash({
          type: 'user_bash',
          command,
          excludeFromContext,
          cwd: record.workspacePath,
        })
        if (run.cancelRequested || record.retired || disposed) {
          result = {
            cancelled: true,
            truncated: false,
            endedAt: new Date().toISOString(),
          }
        } else if (extensionResult?.result) {
          const custom = extensionResult.result
          record.session.recordBashResult(command, custom, { excludeFromContext })
          run.recorded = true
          result = bashResultOf(custom)
          run.output = custom.output
          run.outputTruncated = false
        } else {
          const sdkResult = await record.session.executeBash(command, onChunk, {
            excludeFromContext,
            id: run.id,
            ...(extensionResult?.operations ? { operations: extensionResult.operations } : {}),
          })
          run.recorded = true
          result = bashResultOf(sdkResult)
          // 完成态以 SDK 的清理/截断后输出为准（同时消除实时缓冲差异）。
          run.output = sdkResult.output
          run.outputTruncated = false
        }
      } catch (error) {
        result = {
          cancelled: false,
          truncated: false,
          endedAt: new Date().toISOString(),
          error: errorText(error),
        }
      }
      boundBashOutput(run)
      run.status = 'complete'
      run.result = result
      if (record.bash === run) {
        emit(record, { type: 'bash_end', run: bashViewOf(run) })
        // 历史消息在运行中会被 SDK 缓冲到结算后落盘；快照保留完成卡直到那时。
        emitSnapshot(record)
      }
      markDone()
    })()

    return { status: 'started', run: bashViewOf(run) }
  }

  /** 取消当前用户 Shell（不影响模型运行）。 */
  const abortThreadBashNow = (threadId: string): HarnessBashAbortResult => {
    const record = records.get(threadId)
    if (record?.bash?.status !== 'running') return { status: 'idle' }
    record.bash.cancelRequested = true
    record.session.abortBash()
    record.uiBridge.dismissAll()
    return { status: 'requested' }
  }

  /** 收尾：取消并等待正在运行的 Shell（有上限，不阻塞删除/销毁）。 */
  const abortUserBashForRetire = async (record: ThreadRecord): Promise<void> => {
    // 扩展直接调用 executeBash 启动的 Shell 也按会话级状态兜底中止。
    if (record.session.isBashRunning) record.session.abortBash()
    const run = record.bash
    if (run?.status !== 'running') return
    run.cancelRequested = true
    record.uiBridge.dismissAll()
    await withTimeout(run.done, RETIRE_ABORT_TIMEOUT_MS, 'Shell 命令').catch(() => {})
  }

  /**
   * 手动压缩。必须在任何 await 之前占用结构闸门：压缩期间发送/导航/分叉
   * 一律明确 busy，不越过正在改写的上下文。
   */
  const compactThreadNow = async (
    threadId: string,
    input?: { customInstructions?: string },
  ): Promise<HarnessCompactionOutcome> => {
    assertActive()
    const record = await ensureOpen(threadId)
    let operation: StructureOperation
    try {
      operation = beginStructure(record, 'compact')
    } catch (error) {
      if (error instanceof ThreadStructureBusyError) {
        return { status: 'busy', message: error.message }
      }
      throw error
    }
    try {
      const customInstructions = input?.customInstructions?.trim()
      const result = await record.session.compact(
        customInstructions ? customInstructions : undefined,
      )
      return {
        status: 'compacted',
        ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
        ...(result.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: result.estimatedTokensAfter }
          : {}),
      }
    } catch (error) {
      if (record.lastCompactionAborted) {
        return { status: 'cancelled', message: '压缩已取消，原始消息树保持不变' }
      }
      // 优先使用 SDK compaction_end 的错误文案（含 "Compaction failed" 前缀），
      // 其次是 compact() 抛出的原始错误。
      return { status: 'failed', message: record.lastCompactionError ?? errorText(error) }
    } finally {
      releaseStructure(record, operation)
    }
  }

  /** 取消进行中的压缩（手动或自动）。 */
  const abortThreadCompactionNow = (threadId: string): HarnessCompactionAbortResult => {
    const record = records.get(threadId)
    if (!record?.session.isCompacting) return { status: 'idle' }
    record.session.abortCompaction()
    return { status: 'requested' }
  }

  /** 保存自动压缩开关（用户全局设置）并同步所有 live 会话的缓存。 */
  const setAutoCompactionNow = async (
    threadId: string,
    enabled: boolean,
  ): Promise<HarnessAutoCompactionUpdateResult> => {
    assertActive()
    const record = await ensureOpen(threadId)
    const written = await writeGlobalSetting(
      record,
      '自动压缩设置',
      (manager) => {
        manager.setCompactionEnabled(enabled)
      },
      async () => {
        const settings = await readUserSettings()
        const compaction =
          settings?.compaction !== null && typeof settings?.compaction === 'object'
            ? (settings.compaction as { enabled?: unknown })
            : undefined
        return compaction?.enabled === enabled
      },
    )
    if (!written.ok) return { status: 'failed', message: written.message }
    await syncSettingsCaches(record)
    const effective = record.settingsManager.getCompactionEnabled()
    return {
      status: 'saved',
      enabled: effective,
      scope: 'global',
      ...(effective === enabled
        ? {}
        : {
            overridden: true,
            message: '用户默认已保存，但项目设置覆盖了该开关，当前会话仍按项目设置生效。',
          }),
    }
  }

  /** 更新会话模型范围；保存用户默认是独立显式操作。 */
  const setThreadModelScopeNow = async (
    threadId: string,
    input: HarnessModelScopeUpdateInput,
  ): Promise<HarnessModelScopeUpdateResult> => {
    assertActive()
    const record = await ensureOpen(threadId)
    const patterns = normalizePatterns(input.patterns)
    const operation = beginStructure(record, 'model')
    try {
      const resolved = await resolveScopePatterns(patterns)
      assertActive()
      if (record.retired) throw new ThreadStructureBusyError('会话正在关闭')
      // 非空模式但没有任何匹配：保持会话原范围（不静默扩大为全部），并如实诊断。
      if (patterns.length > 0 && resolved.scopedModels.length === 0) {
        return {
          ...(await modelScopeOf(record)),
          diagnostics: resolved.diagnostics,
          persistence: 'skipped',
          message: '没有匹配的模型，会话范围未修改；请检查模式或先刷新模型目录。',
        }
      }
      record.session.setScopedModels(
        resolved.scopedModels.map((item) => ({
          model: item.model,
          ...(item.thinkingLevel ? { thinkingLevel: item.thinkingLevel } : {}),
        })),
      )
      let persistence: HarnessModelScopeUpdateResult['persistence'] = 'skipped'
      let message: string | undefined
      if (input.saveAsDefault === true) {
        const written = await writeGlobalSetting(
          record,
          '用户默认模型范围',
          (manager) => {
            manager.setEnabledModels(patterns.length > 0 ? patterns : undefined)
          },
          async () => {
            const settings = await readUserSettings()
            const saved = settings?.enabledModels
            if (patterns.length === 0) return saved === undefined
            return (
              Array.isArray(saved) &&
              saved.length === patterns.length &&
              saved.every((item, index) => item === patterns[index])
            )
          },
        )
        if (written.ok) {
          persistence = 'saved'
          await syncSettingsCaches(record)
        } else {
          persistence = 'failed'
          message = '会话范围已生效，但用户默认保存失败；新会话仍按原配置解析。'
        }
      }
      const scope = await modelScopeOf(record)
      return {
        ...scope,
        diagnostics: resolved.diagnostics,
        persistence,
        ...(message ? { message } : {}),
      }
    } finally {
      releaseStructure(record, operation)
    }
  }

  /**
   * 显式刷新模型目录（共享 modelRuntime）。
   *
   * 必须显式指定会话或固定起始目录：不使用窗口当前工作区替代 live cwd。
   * 不重建 live session、不发起付费模型请求；失败时返回缓存目录与失败 provider。
   */
  const refreshModelsNow = async (
    input: HarnessModelRefreshInput,
  ): Promise<HarnessModelRefreshResult> => {
    assertActive()
    if (input.threadId) {
      await ensureOpen(input.threadId)
    } else {
      const path = input.workspacePath?.trim()
      if (!path || !isAbsolute(path)) {
        throw new Error('模型目录刷新需要指定会话或绝对起始目录')
      }
      const check = await inspectProjectPath(path)
      if (check.error) throw new Error('模型目录刷新的起始目录不可用')
    }
    // 同一时刻只跑一次联网刷新，避免重复请求 provider 目录。
    if (!catalogRefreshInFlight) {
      catalogRefreshInFlight = (async () => {
        let failedProviders: string[] = []
        try {
          const result = await withTimeout(
            modelRuntime.refresh({ allowNetwork: true }),
            refreshTimeoutMs,
            '模型目录刷新',
          )
          failedProviders = [...result.errors.keys()]
          for (const [provider, error] of result.errors) {
            diagnostics.push(`模型目录刷新（${provider}）：${error.message}`)
          }
          if (failedProviders.length) safeDiagnostics.add('catalog-refresh-failed')
        } catch (error) {
          diagnostics.push(`模型目录刷新失败：${errorText(error)}`)
          safeDiagnostics.add('catalog-refresh-failed')
          // 超时/异常时无法区分 provider：整体标记失败（UI 显示为刷新未完成）。
          failedProviders = ['*']
        }
        modelCatalogRevision += 1
        for (const record of records.values()) emitSnapshot(record)
        return { models: listModelCatalog(modelRuntime), failedProviders }
      })().finally(() => {
        catalogRefreshInFlight = undefined
      })
    }
    return catalogRefreshInFlight
  }

  /** 进行中的目录刷新（共享，避免并发重复联网）。 */
  let modelCatalogRevision = 0
  let catalogRefreshInFlight: Promise<HarnessModelRefreshResult> | undefined

  /**
   * 解析设置/资源查询目标。
   *
   * 只接受会话 ID 或绝对起始目录，且两者互斥；不接受任意配置文件路径。
   * 冷会话只按会话头解析 cwd，不构造 AgentSession。
   */
  const resolveConfigTarget = async (
    input: HarnessSettingsTargetInput,
  ): Promise<{ target: HarnessSettingsTarget; cwd: string; record?: ThreadRecord }> => {
    const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : ''
    const requestedPath = typeof input.workspacePath === 'string' ? input.workspacePath.trim() : ''
    if (threadId.length > 0 === requestedPath.length > 0) {
      throw new Error('配置查询需要且只能指定会话或起始目录')
    }
    if (threadId) {
      const record = records.get(threadId)
      if (record) {
        return {
          target: { kind: 'session', threadId, workspacePath: record.workspacePath },
          cwd: record.workspacePath,
          record,
        }
      }
      const info = await findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      // 会话头缺失 cwd 时退回宿主启动目录；不使用调用方未提供的路径。
      const cwd = canonicalProjectPath(info.cwd || workspacePath)
      return { target: { kind: 'session', threadId, workspacePath: cwd }, cwd }
    }
    if (!isAbsolute(requestedPath)) throw new Error('起始目录必须是绝对路径')
    const check = await inspectProjectPath(requestedPath)
    if (check.error) throw new Error('起始目录不可用')
    return { target: { kind: 'workspace', workspacePath: check.path }, cwd: check.path }
  }

  /**
   * 目标项目的信任结论。
   *
   * live 会话以正在服务的 loader 的信任状态为准（重载就地更新）；其余优先
   * 复用已装配的项目缓存，没有缓存时走只读摘要（不加载项目扩展）。
   */
  const configTrustOf = async (
    cwd: string,
    record?: ThreadRecord,
  ): Promise<HarnessProjectTrust> => {
    // live 会话：以它正在使用的 loader 的信任状态为权威。资源重载会就地更新
    // 该状态，因此「重载因新资源被拒」后页面不会仍显示旧的 trusted 结论。
    if (record) {
      const state = record.trustBinding.state()
      if (state.source === 'no-resources' && hasTrustRequiringProjectResources(cwd)) {
        return (await inspectProjectTrust(cwd)).trust
      }
      return {
        decision:
          state.status === 'trusted'
            ? 'trusted'
            : state.status === 'untrusted'
              ? 'untrusted'
              : 'unknown',
        origin: state.source,
        requiresTrust: state.requiresTrust,
        defaultPolicy: state.defaultProjectTrust,
        ...(state.savedPath ? { savedPath: state.savedPath } : {}),
        extensionErrorCount: state.extensionErrors.length,
      }
    }
    const cached = projectRuntimes.get(cwd)
    if (
      cached &&
      cached.info.status !== 'failed' &&
      (cached.info.trust.requiresTrust === hasTrustRequiringProjectResources(cwd) ||
        cached.info.trust.origin !== 'no-resources')
    )
      return cached.info.trust
    return (await inspectProjectTrust(cwd)).trust
  }

  const trustViewOf = (trust: HarnessProjectTrust) => ({
    decision:
      trust.decision === 'trusted'
        ? ('trusted' as const)
        : trust.decision === 'untrusted'
          ? ('untrusted' as const)
          : ('needs-trust' as const),
    requiresTrust: trust.requiresTrust,
    origin: trust.origin,
  })

  /** 读取用户/项目原文与磁盘合并预览；项目未信任时不读取其原文。 */
  const settingsSnapshotOf = async (
    target: HarnessSettingsTarget,
    cwd: string,
    record?: ThreadRecord,
  ): Promise<HarnessSettingsSnapshot> => {
    const trust = await configTrustOf(cwd, record)
    const trusted = trust.decision === 'trusted'
    const paths = settingsFilePaths(cwd, agentDir)
    const [user, project] = await Promise.all([
      readSettingsFile(paths.user, 'user'),
      readSettingsFile(paths.project, 'project', { readable: trusted }),
    ])
    const effective = mergeSettingsFromDisk({
      cwd,
      agentDir,
      projectTrusted: trusted,
      files: { user, project },
    })
    const live = record ? settingsEffectiveOfManager(record.settingsManager, 'session') : undefined
    return {
      target,
      agentDir,
      projectTrusted: trusted,
      trust: trustViewOf(trust),
      files: { user, project },
      effective,
      ...(live ? { live } : {}),
      ...(live ? { reloadRequired: !settingsEquivalent(live.values, effective.values) } : {}),
    }
  }

  /**
   * 保存设置原文。
   *
   * 设计约束：
   * - 只改指定文件，内容为完整文件语义（未知字段由调用方保留）；
   * - 先校验 JSON/schema/原型污染键，再检查 revision（乐观并发）；
   * - 与自动压缩/模型范围写入共用 settingsWrites 队列；
   * - 原子写入 + 回读校验，失败如实报告；
   * - 不触碰任何 live SettingsManager 缓存（保存不等于应用）。
   */
  const saveSettingsNow = async (
    input: HarnessSettingsSaveInput,
  ): Promise<HarnessSettingsSaveResult> => {
    assertActive()
    const resolved = await resolveConfigTarget(input.target)
    const trust = await configTrustOf(resolved.cwd, resolved.record)
    const trusted = trust.decision === 'trusted'
    const paths = settingsFilePaths(resolved.cwd, agentDir)
    const path = input.scope === 'project' ? paths.project : paths.user
    if (input.scope === 'project' && !trusted) {
      return {
        status: 'untrusted',
        scope: input.scope,
        path,
        message: '项目未取得信任：不读取也不写入项目设置；用户设置仍可编辑。',
      }
    }
    if (typeof input.content !== 'string') {
      return {
        status: 'invalid',
        scope: input.scope,
        path,
        issues: [{ kind: 'parse', path: '/', message: '设置内容必须是字符串。' }],
        message: '设置未保存：内容形状无效。',
      }
    }
    const bytes = byteLengthOf(input.content)
    if (bytes > SETTINGS_CONTENT_MAX_BYTES) {
      return {
        status: 'too-large',
        scope: input.scope,
        path,
        limitBytes: SETTINGS_CONTENT_MAX_BYTES,
        message: `设置文件超过上限（${SETTINGS_CONTENT_MAX_BYTES} 字节），未保存。`,
      }
    }
    // revision 检查在队列内部执行：并发保存不会相互覆盖。
    const current = await readSettingsFile(path, input.scope)
    if (current.readError) {
      return { status: 'failed', scope: input.scope, path, message: current.readError }
    }
    if (current.tooLarge) {
      // 不返回不完整原文时无法可靠比较 revision；拒绝覆盖未知的大文件。
      return {
        status: 'too-large',
        scope: input.scope,
        path,
        limitBytes: SETTINGS_CONTENT_MAX_BYTES,
        message: '现有设置文件超过读取上限；为避免覆盖未知内容，请先手动处理该文件。',
      }
    }
    if (current.revision !== input.expectedRevision) {
      return {
        status: 'conflict',
        scope: input.scope,
        path,
        revision: current.revision,
        message: '设置文件已被其他窗口或进程修改；请重新加载原文后再保存。',
      }
    }
    const parsed = parseSettingsContent(input.content)
    if (!parsed.value || parsed.issues.length > 0) {
      return {
        status: 'invalid',
        scope: input.scope,
        path,
        issues: parsed.issues,
        message: '设置未保存：请先修复解析或校验问题。',
      }
    }
    const before =
      current.issues.length === 0 ? parseSettingsContent(current.content).value : undefined
    const changed = changedTopLevelKeys(before, parsed.value)
    try {
      await writeSettingsFileAtomic(path, input.content)
    } catch (error) {
      diagnostics.push(`设置写入（${path}）：${errorText(error)}`)
      return {
        status: 'failed',
        scope: input.scope,
        path,
        message: '设置写入失败；磁盘文件保持原状。',
      }
    }
    const verify = await readFile(path, 'utf8').catch(() => undefined)
    if (verify !== input.content) {
      return {
        status: 'failed',
        scope: input.scope,
        path,
        message: '写入后回读与提交内容不一致；请不要依赖本次保存结果。',
      }
    }
    const snapshot = await settingsSnapshotOf(resolved.target, resolved.cwd, resolved.record)
    const restartKeys = restartRequiredKeys(changed)
    const reloadRequired = changed.length > 0
    return {
      status: 'saved',
      scope: input.scope,
      path,
      revision: settingsRevision(input.content),
      bytes,
      snapshot,
      apply: {
        persisted: true,
        reloadRequired,
        restartRequiredKeys: restartKeys,
        message: !reloadRequired
          ? '内容未变化；已确认磁盘文件与提交一致。'
          : restartKeys.length > 0
            ? `已保存到磁盘；需重启宿主后生效：${restartKeys.join('、')}。当前会话仍使用已加载的设置。`
            : '已保存到磁盘；常用运行设置与资源需重载宿主后才会被会话使用。当前会话未被静默修改。',
      },
    }
  }

  /**
   * 资源清单：只读取现有 loader 的公开 getter。
   *
   * 热会话用正在使用的 loader；空白页/冷会话复用同 cwd 的 live loader、
   * 待消费的受信装配缓存或最近一次装配结果。除首次无缓存时按现有受信
   * 装配路径装配一次外，不调用 reload、不重新执行扩展、不联网重扫。
   */
  const resourceInventoryNow = async (
    input: HarnessResourceQueryInput,
  ): Promise<HarnessResourceSnapshot> => {
    assertActive()
    const resolved = await resolveConfigTarget(input)
    let loader: ResourceLoader
    let settings: SettingsManager
    let loadedFrom: 'session' | 'assembly'
    if (resolved.record) {
      loader = resolved.record.resourceLoader
      settings = resolved.record.settingsManager
      loadedFrom = 'session'
    } else {
      const sameCwd = [...records.values()].find(
        (record) => !record.retired && pathKey(record.workspacePath) === pathKey(resolved.cwd),
      )
      const runtime = projectRuntimes.get(resolved.cwd)
      if (runtime?.pending) {
        loader = runtime.pending.trust.resourceLoader
        settings = runtime.pending.trust.settingsManager
        loadedFrom = 'assembly'
      } else if (sameCwd) {
        loader = sameCwd.resourceLoader
        settings = sameCwd.settingsManager
        loadedFrom = 'session'
      } else if (runtime?.lastLoader) {
        loader = runtime.lastLoader.loader
        settings = runtime.lastLoader.settings
        loadedFrom = 'assembly'
      } else {
        // 首次查询仍由正常装配路径处理信任，不复用装配前推测的结论。
        const loaded = runtime ?? (await loadProjectRuntime(resolved.cwd))
        const prepared =
          loaded.pending ??
          (await prepareProjectSession(loaded.cwd, loaded.info.trust.decision === 'trusted'))
        loaded.pending = prepared
        loaded.lastLoader = {
          loader: prepared.trust.resourceLoader,
          settings: prepared.trust.settingsManager,
        }
        loader = prepared.trust.resourceLoader
        settings = prepared.trust.settingsManager
        loadedFrom = 'assembly'
      }
    }
    return resourceSnapshotOf(
      {
        target: resolved.target,
        agentDir,
        loadedFrom,
        trust: trustViewOf(await configTrustOf(resolved.cwd, resolved.record)),
        loader,
        settings,
      },
      { includeText: input.includeText === true },
    )
  }

  // ---- 资源重载（G1.4b） ----

  /**
   * 清空旧运行时的扩展 UI 状态与定向指令。
   *
   * 旧 ExtensionRunner 在 reload 中会被 invalidate，status/widget/标题/编辑器
   * 指令都不再有人负责清理；留着会让页面展示已失效扩展的残留状态，甚至把
   * 旧指令应用到新运行时的输入框。通知是历史信息，保留。
   */
  const resetHostUiForReload = (record: ThreadRecord): void => {
    const ui = record.hostUi
    ui.statuses.clear()
    ui.widgets.clear()
    ui.title = undefined
    ui.workingMessage = undefined
    ui.workingVisible = undefined
    ui.hiddenThinkingLabel = undefined
    ui.editorDirective = undefined
    ui.commandTarget = undefined
    emitHostUiSnapshot(record)
  }

  /**
   * 重载成功后刷新与资源绑定的宿主缓存。
   *
   * 只做本地动作：登记新扩展 provider、物化本地模型目录（不联网）、更新
   * 工作区绑定实际加载的指令路径，并保留最近一次 loader 供只读清单查询。
   * 不覆盖用户已选模型/Thinking，也不重新执行扩展工厂（loader 负责一次）。
   */
  const applyReloadedResources = async (record: ThreadRecord): Promise<void> => {
    const loader = record.resourceLoader
    const extensions = loader.getExtensions()
    // 新 ExtensionRunner 已把 provider 注册写入共享 modelRuntime；这里对未消费
    // 的登记做兜底（幂等），并显式物化本地目录，保证选择器立即看到新模型。
    registerPreparedProviders(extensions)
    try {
      await modelRuntime.refresh({ allowNetwork: false })
    } catch (error) {
      pushDiagnostic(`模型目录本地刷新（${record.workspacePath}）：${errorText(error)}`)
      safeDiagnostics.add('catalog-refresh-failed')
    }
    record.workspaceBinding.loadedInstructionPaths = loader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.path)
    for (const { path: file, error } of extensions.errors) {
      pushDiagnostic(`扩展装配重载（${record.workspacePath}）：${file}：${error}`)
      safeDiagnostics.add('assembly-warning')
    }
    const runtime = projectRuntimes.get(record.workspacePath)
    if (runtime) runtime.lastLoader = { loader, settings: record.settingsManager }
  }

  /** 会话目标的重载结果投影（成功时附带权威快照）。 */
  const reloadedResultOf = (
    record: ThreadRecord,
    operation: HarnessReloadOperation,
  ): HarnessReloadResult => ({
    status: 'reloaded',
    kind: 'session',
    threadId: record.threadId,
    workspacePath: record.workspacePath,
    operation: { ...operation },
    resourceRevision: operation.resourceRevision,
    ...(record.retired ? {} : { snapshot: snapshotOf(record) }),
  })

  /**
   * 在同一 Pi 会话内重载设置、指令、扩展与资源。
   *
   * 生命周期的关键顺序：
   * 1) 占用结构闸门（与运行/发送/Shell/其他结构操作互斥，busy 如实返回）；
   * 2) 广播 reload_start 并结算旧交互（pending + 会话作用域启动请求）；
   * 3) 清空旧扩展 UI 状态，进入 startup 模式，使 reload 期间的 session_start
   *    请求经宿主交互通道可发现、可从任一窗口应答（断开前端不取消工作）；
   * 4) flush 设置 → 公开 AgentSession.reload（loader 重载前由宿主信任包装检查）；
   * 5) 结算为 succeeded/failed/cancelled，广播 reload_end 与权威快照。
   *
   * 失败不清空消息/草稿，也不伪报成功；旧扩展可能已被关闭，可修复后重试。
   */
  const reloadThreadNow = async (
    record: ThreadRecord,
    trigger: HarnessReloadTrigger,
  ): Promise<HarnessReloadResult> => {
    assertActive()
    const workspacePath = record.workspacePath
    reloadCounter += 1
    const operation: HarnessReloadOperation = {
      id: `${record.threadId}:reload:${reloadCounter}`,
      trigger,
      status: 'running',
      threadId: record.threadId,
      workspacePath,
      startedAt: new Date().toISOString(),
      fromResourceRevision: record.resourceRevision,
      resourceRevision: record.resourceRevision,
    }
    let structure: StructureOperation
    try {
      structure = beginStructure(record, 'reload')
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return {
        status: 'busy',
        message: error.message,
        threadId: record.threadId,
        workspacePath,
      }
    }
    // 退休/销毁时先解除阻断请求，避免重载卡在无人应答的启动期对话。
    structure.cancel = () => record.uiBridge.dismissAll()
    record.reload = operation
    emit(record, { type: 'reload_start', operation: { ...operation } })
    emitSnapshot(record)

    const fail = (
      reason: 'trust' | 'assembly' | 'disposed',
      message: string,
    ): HarnessReloadResult => {
      operation.status = reason === 'disposed' ? 'cancelled' : 'failed'
      operation.finishedAt = new Date().toISOString()
      operation.message = message
      if (!record.retired) {
        emit(record, {
          type: 'reload_end',
          operation: { ...operation },
          resourceRevision: record.resourceRevision,
        })
      }
      if (operation.status === 'cancelled') {
        return { status: 'cancelled', message, operation: { ...operation } }
      }
      return { status: 'failed', reason, message, operation: { ...operation } }
    }

    try {
      // 1) 旧交互不能跨运行时存活：本地 pending 与宿主级会话作用域请求一起结算。
      record.uiBridge.dismissAll()
      resetHostUiForReload(record)
      record.uiBridge.setStartup(true)
      // 2) 先排空本会话的设置写入，避免 reload 丢弃尚未落盘的修改。
      try {
        await record.settingsManager.flush()
      } catch (error) {
        pushDiagnostic(`设置落盘（${workspacePath}）：${errorText(error)}`)
      }
      await record.session.reload({
        beforeSessionStart: async () => {
          if (record.retired || disposed) throw new Error('会话正在关闭')
          await applyReloadedResources(record)
          if (record.retired || disposed) throw new Error('会话正在关闭')
        },
      })
      if (record.retired || disposed) {
        return fail('disposed', '会话正在关闭，资源重载已取消；请重新打开会话后再试。')
      }
      resourceRevisionSeq += 1
      record.resourceRevision = resourceRevisionSeq
      operation.status = 'succeeded'
      operation.finishedAt = new Date().toISOString()
      operation.resourceRevision = resourceRevisionSeq
      delete operation.message
      emit(record, {
        type: 'reload_end',
        operation: { ...operation },
        resourceRevision: resourceRevisionSeq,
      })
      return reloadedResultOf(record, operation)
    } catch (error) {
      if (record.retired || disposed) {
        return fail('disposed', '会话正在关闭，资源重载已取消；请重新打开会话后再试。')
      }
      if (error instanceof ResourceReloadTrustError) {
        pushDiagnostic(`资源重载信任（${workspacePath}）：${error.message}`)
        safeDiagnostics.add('assembly-warning')
        return fail('trust', error.message)
      }
      pushDiagnostic(`资源重载（${workspacePath}）：${errorText(error)}`)
      safeDiagnostics.add('assembly-warning')
      return fail(
        'assembly',
        `资源重载失败：${errorText(error)}。旧扩展可能已关闭；修复后可在同一会话重试。`,
      )
    } finally {
      record.uiBridge.setStartup(false)
      structure.cancel = () => {}
      releaseStructure(record, structure)
    }
  }

  /**
   * 空白页目标：只刷新该 cwd 的待消费装配。
   *
   * 不创建会话、不停止同 cwd 的其他会话；已有的 live 会话使用自己的 loader，
   * 不会被本操作替换。结果明确标记 kind=workspace，便于页面提示“只重载本目标”。
   */
  const reloadWorkspaceNow = async (
    cwd: string,
    trigger: HarnessReloadTrigger,
  ): Promise<HarnessReloadResult> => {
    assertActive()
    reloadCounter += 1
    const workspacePath = canonicalProjectPath(cwd)
    const operation: HarnessReloadOperation = {
      id: `workspace:${workspacePath}:reload:${reloadCounter}`,
      trigger,
      status: 'running',
      workspacePath,
      startedAt: new Date().toISOString(),
      fromResourceRevision: resourceRevisionSeq,
      resourceRevision: resourceRevisionSeq,
    }
    if (workspaceReloads.has(workspacePath) || pendingProjects.has(workspacePath)) {
      return { status: 'busy', message: '该起始目录正在装配或重载', workspacePath }
    }
    workspaceReloads.add(workspacePath)
    try {
      const runtime = projectRuntimes.get(workspacePath)
      let prepared: PreparedProject
      if (runtime?.pending) {
        // 已有待消费装配：用带信任检查的 loader.reload 刷新（不重复装配工厂）。
        prepared = runtime.pending
        await prepared.trust.resourceLoader.reload()
        // 待消费 loader 没有 runner 负责登记 provider；下次会话复用它之前补上。
        registerPreparedProviders(prepared.trust.resourceLoader.getExtensions())
      } else {
        // 无待消费装配：经正常受信装配路径准备一次（首次查询不猜测信任）。
        prepared = await prepareProjectSession(
          workspacePath,
          explicitTrust.get(pathKey(workspacePath)),
        )
        if (disposed) throw new Error('宿主已关闭')
        if (prepared.trust.state.status === 'needs-trust') {
          throw new ResourceReloadTrustError(prepared.trust.state)
        }
        projectRuntimeFrom(prepared)
      }
      if (disposed) throw new Error('宿主已关闭')
      // 只物化本地目录；联网刷新仍由显式 refreshModels 触发。
      await modelRuntime.refresh({ allowNetwork: false })
      if (disposed) throw new Error('宿主已关闭')
      prepared.workspaceBinding.loadedInstructionPaths = prepared.trust.resourceLoader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.path)
      const target = projectRuntimes.get(workspacePath)
      if (target) {
        target.lastLoader = {
          loader: prepared.trust.resourceLoader,
          settings: prepared.trust.settingsManager,
        }
      }
      resourceRevisionSeq += 1
      operation.status = 'succeeded'
      operation.finishedAt = new Date().toISOString()
      operation.resourceRevision = resourceRevisionSeq
      return {
        status: 'reloaded',
        kind: 'workspace',
        workspacePath,
        operation: { ...operation },
        resourceRevision: resourceRevisionSeq,
      }
    } catch (error) {
      if (disposed) {
        operation.status = 'cancelled'
        operation.finishedAt = new Date().toISOString()
        return { status: 'cancelled', message: '宿主已关闭，资源重载已取消', operation }
      }
      if (error instanceof ResourceReloadTrustError || error instanceof ProjectTrustRequiredError) {
        const message =
          error instanceof ResourceReloadTrustError
            ? error.message
            : '项目需要信任决定；请先在项目信任面板完成允许/拒绝，再重试资源重载。'
        pushDiagnostic(`待消费装配重载信任（${workspacePath}）：${message}`)
        safeDiagnostics.add('assembly-warning')
        operation.status = 'failed'
        operation.finishedAt = new Date().toISOString()
        operation.message = message
        return { status: 'failed', reason: 'trust', message, operation: { ...operation } }
      }
      const message = `资源重载失败：${errorText(error)}。请修正后重试。`
      pushDiagnostic(`待消费装配重载（${workspacePath}）：${errorText(error)}`)
      safeDiagnostics.add('assembly-warning')
      operation.status = 'failed'
      operation.finishedAt = new Date().toISOString()
      operation.message = message
      return { status: 'failed', reason: 'assembly', message, operation: { ...operation } }
    } finally {
      workspaceReloads.delete(workspacePath)
    }
  }

  /** 资源重载入口：会话与空白页目标二选一（与设置/资源查询同形）。 */
  const reloadResourcesNow = async (
    input: HarnessReloadTargetInput,
  ): Promise<HarnessReloadResult> => {
    assertActive()
    const trigger = input.trigger ?? 'api'
    const resolved = await resolveConfigTarget(input)
    if (resolved.target.kind === 'session') {
      const threadId = resolved.target.threadId
      if (!threadId) throw new Error('资源重载缺少会话 ID')
      const record = resolved.record ?? (await ensureOpen(threadId))
      return reloadThreadNow(record, trigger)
    }
    return reloadWorkspaceNow(resolved.cwd, trigger)
  }

  const client: HarnessClient = {
    async getHostInfo() {
      assertActive()
      const scope = scopeOf(workspacePath)
      return {
        workspacePath,
        agentDir,
        agentDirSource,
        sessionStorage: {
          mode: scope.grouped ? 'grouped' : 'flat',
          root: scopeRootOf(scope),
          directory: scope.dir,
          source: scope.source,
        },
        defaultModel: {
          ...resolvedDefault.info,
          readiness: getModelReadiness(
            modelRuntime,
            resolvedDefault.info.provider && resolvedDefault.info.modelId
              ? {
                  provider: resolvedDefault.info.provider,
                  modelId: resolvedDefault.info.modelId,
                }
              : undefined,
            resolvedDefault.info.providerSource === 'env' ||
              resolvedDefault.info.modelIdSource === 'env'
              ? 'env'
              : 'pi-default',
          ),
        },
        diagnostics: [...safeDiagnostics],
      }
    },
    async listWorkspaces() {
      assertActive()
      const workspaces = workspaceStore.listWorkspaces().map(workspaceViewOf)
      const startup = startupWorkspaceId
        ? workspaces.find((workspace) => workspace.id === startupWorkspaceId)
        : undefined
      return {
        workspaces,
        state: workspaceStore.integrity,
        ...(startup ? { startupWorkspaceId: startup.id } : {}),
      } satisfies HarnessWorkspaceCatalog
    },

    async createWorkspace(input) {
      assertActive()
      return workspaceMutationResult(() =>
        workspaceStore.createWorkspace({
          ...input,
          projects: input.projects.map((project) => ({
            ...project,
            path: canonicalProjectPath(project.path),
          })),
        }),
      )
    },

    async updateWorkspace(input) {
      assertActive()
      const result = await workspaceMutationResult(() =>
        workspaceStore.updateWorkspace({
          ...input,
          ...(input.projects
            ? {
                projects: input.projects.map((project) => ({
                  ...project,
                  path: canonicalProjectPath(project.path),
                })),
              }
            : {}),
        }),
      )
      if (result.ok) emitWorkspaceSnapshots(result.workspace.id)
      else if (result.workspace) emitWorkspaceSnapshots(result.workspace.id)
      return result
    },

    async assignThreadWorkspace(input) {
      assertActive()
      const info = records.get(input.threadId) ? undefined : await findSessionInfo(input.threadId)
      const record = records.get(input.threadId)
      if (!record && !info) return { ok: false, error: 'not-found' as const }
      try {
        await workspaceStore.assignSession({
          storeId,
          sessionId: input.threadId,
          workspaceId: input.workspaceId,
        })
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          return { ok: false, error: 'not-found' as const }
        }
        if (error instanceof WorkspaceStateUnavailableError) {
          return { ok: false, error: 'state-unavailable' as const }
        }
        throw error
      }
      if (record) {
        record.workspaceId = input.workspaceId
        // 归属变更在下一轮运行开始时应用；当前轮保持原快照。
        record.workspaceAppliedRevision = undefined
        record.workspaceBinding.workspaceId = input.workspaceId
        emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
        return { ok: true as const, thread: metadataOf(record) }
      }
      const workspace = workspaceStore.workspace(input.workspaceId)
      // 到这里 record 为空，info 必然存在（已在上面按 not-found 返回）。
      const catalogInfo = info as SessionCatalogInfo
      return {
        ok: true as const,
        thread: {
          ...mapSessionInfo(catalogInfo, { liveStatus: 'idle' }),
          ...(workspace
            ? {
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
                workspaceAppliedRevision: workspace.revision,
              }
            : {}),
          ...(workspaceStore.sessionArchived(storeId, catalogInfo.id) ? { archived: true } : {}),
        },
      }
    },

    async listThreads(input) {
      assertActive()
      // 显式刷新（含窗口重新聚焦）：清空作用域缓存后重新扫描，外部 Pi 新增/
      // 删除/改名可见；普通操作仍复用已有失效机制。
      if (input?.refresh) scopeCatalogCache.clear()
      // 工作区会话跨 cwd 聚合：使用整个存储作用域列表，而不是只过滤 header.cwd。
      const infos = await listScopeInfos()
      return infos
        .filter(
          (info) => input?.includeArchived || !workspaceStore.sessionArchived(storeId, info.id),
        )
        .flatMap((info) => {
          const storedWorkspaceId = workspaceStore.sessionWorkspace(storeId, info.id)
          const workspace = storedWorkspaceId
            ? workspaceStore.workspace(storedWorkspaceId)
            : undefined
          const workspaceId = workspace?.id
          if (input?.workspaceId && workspaceId !== input.workspaceId) return []
          if (input?.unassigned && workspaceId) return []
          const live = records.get(info.id)
          if (live) {
            // live 元数据本身不带时间（事件路径避免逐次 stat）；列表补上目录时间，
            // 使「继续最近」等排序与冷条目同一口径。
            return [
              {
                ...metadataOf(live),
                ...(workspace
                  ? {
                      workspaceId: workspace.id,
                      workspaceRevision: workspace.revision,
                    }
                  : {}),
                createdAt: info.created.toISOString(),
                updatedAt: info.modified.toISOString(),
              },
            ]
          }
          // 冷条目也要叠加归档标记与工作区归属（过滤与呈现口径一致）。
          return [
            {
              ...mapSessionInfo(info, { liveStatus: 'idle' }),
              ...(workspace
                ? {
                    workspaceId: workspace.id,
                    workspaceRevision: workspace.revision,
                    workspaceAppliedRevision: workspace.revision,
                  }
                : {}),
              ...(workspaceStore.sessionArchived(storeId, info.id) ? { archived: true } : {}),
            },
          ]
        })
    },

    async checkProjectPath(path: string) {
      assertActive()
      return inspectProjectPath(path)
    },

    async getProject(input) {
      assertActive()
      return queryProject(input.path)
    },

    async inspectProjectTrust(input) {
      assertActive()
      return inspectProjectTrust(input.path)
    },

    async decideProjectTrust(input) {
      assertActive()
      return decideProject(input)
    },

    async listRecentProjects() {
      assertActive()
      return listRecentProjects()
    },

    async createThread(input?: HarnessCreateThreadInput, createOptions?: { callerId?: string }) {
      if (createOptions?.callerId && callerContext.getStore() !== createOptions.callerId) {
        return callerContext.run(createOptions.callerId, () => client.createThread(input))
      }
      assertActive()
      if (input?.initialMessage) assertNotReservedCommand(input.initialMessage.content)
      if (!workspaceStore.healthy) {
        throw new WorkspaceStateUnavailableError(
          workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
          workspaceStore.stateFile,
        )
      }
      const workspaceId = input?.workspaceId ?? startupWorkspaceId
      if (!workspaceId) throw new Error('没有可用工作区，不能新建会话')
      const workspace = workspaceStore.workspace(workspaceId)
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId)
      const requestedStart = input?.startProjectPath?.trim()
      const startProject = requestedStart
        ? workspace.projects.find((project) => pathKey(project.path) === pathKey(requestedStart))
        : workspace.projects[0]
      if (!startProject) {
        throw new WorkspaceValidationError('invalid-path')
      }
      // 统一信任入口：只按起始 cwd 装配项目资源；其他成员不装配扩展/MCP。
      const project = await acquireProjectSession(startProject.path)
      const cwd = project.runtime.cwd
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
      if (
        !input?.model &&
        project.runtime.defaultModel.info.readiness.state === 'unavailable-model'
      ) {
        throw new Error('默认模型不在注册表中，请先选择有效模型，或修正配置后重启宿主。')
      }
      // 首条消息的图片能力在创建会话前检查，避免先产生空会话再拒绝。
      if (input?.initialMessage?.attachments?.some((item) => item.type === 'image')) {
        const initialModel = explicitModel ?? project.runtime.defaultModel.model
        if (!initialModel?.input?.includes('image')) {
          throw new ImageInputUnsupportedError(initialModel?.provider, initialModel?.id)
        }
      }
      const sessionDir = resolveSessionDirFor(cwd).dir
      // 尚未生成文件名，先检查目录中的探针路径；父目录链接也不得越过默认空间。
      assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
      const sessionManager = SessionManager.create(cwd, sessionDir)
      const record = await openSession(sessionManager, cwd, {
        isNew: true,
        project,
        workspaceId,
        ...(explicitModel ? { model: explicitModel } : {}),
        ...(input?.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      })
      // 先保存归属再返回成功；失败时保留 Pi 文件作为未归属会话，不删除。
      try {
        await workspaceStore.assignSession({
          storeId,
          sessionId: record.threadId,
          workspaceId,
        })
      } catch (error) {
        await abandonRecord(record)
        throw error
      }
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

    async getThreadDetails(threadId: string) {
      assertActive()
      return threadDetailsOf(threadId)
    },

    async listCommands(input?: {
      threadId?: string
      workspacePath?: string
    }): Promise<HarnessCommandCatalog> {
      assertActive()
      if (input?.threadId) {
        const record = await ensureOpen(input.threadId)
        return commandCatalogFromSession(record.session)
      }
      if (input?.workspacePath) {
        const prepared = await peekProjectSession(input.workspacePath)
        return commandCatalogFromLoader(
          prepared.trust.resourceLoader,
          prepared.trust.settingsManager,
        )
      }
      throw new Error('命令目录需要会话或固定起始目录')
    },

    async getCommandArgumentCompletions(
      input: HarnessCommandArgumentInput,
    ): Promise<readonly HarnessCommandArgumentCompletion[]> {
      assertActive()
      if (input.threadId) {
        const record = await ensureOpen(input.threadId)
        return commandArgumentsFromSession(record.session, input.name, input.prefix)
      }
      if (input.workspacePath) {
        const prepared = await peekProjectSession(input.workspacePath)
        return commandArgumentsFromLoader(prepared.trust.resourceLoader, input.name, input.prefix)
      }
      return []
    },

    async getSettings(input) {
      assertActive()
      const resolved = await resolveConfigTarget(input)
      return settingsSnapshotOf(resolved.target, resolved.cwd, resolved.record)
    },

    async saveSettings(input) {
      // 与既有自动压缩/模型范围写入共享同一队列，避免同一文件并发写。
      return withSettingsWrite(() => saveSettingsNow(input))
    },

    async getResources(input) {
      return resourceInventoryNow(input)
    },

    async reloadResources(input) {
      return reloadResourcesNow(input)
    },

    async searchFiles(
      input: HarnessFileSearchInput,
      options?: { signal?: AbortSignal },
    ): Promise<HarnessFileSearchResult> {
      assertActive()
      const roots = await fileSearchRootsOf(input)
      return searchWorkspaceFiles(
        roots,
        {
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
        options?.signal,
      )
    },

    async getThreadTree(threadId: string): Promise<HarnessThreadTree> {
      assertActive()
      const live = records.get(threadId)
      if (live) {
        const operation = treeOperationView(live)
        return buildSessionTree(threadId, live.sessionManager, {
          branchSummarySkipPrompt: live.settingsManager.getBranchSummarySkipPrompt(),
          ...(operation ? { operation } : {}),
        })
      }
      const info = await findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      // 冷树：只读 JSONL + sidecar，不构造 AgentSession、不装配项目扩展。
      const sessionManager = openScopedSessionManager(info)
      return buildSessionTree(threadId, sessionManager, {
        branchSummarySkipPrompt: coldBranchSummarySkipPrompt(info.cwd),
      })
    },

    async navigateThreadTree(threadId, input) {
      return navigateThreadTreeNow(threadId, input)
    },

    async setThreadEntryLabel(threadId, input) {
      return setThreadEntryLabelNow(threadId, input)
    },

    async cancelThreadTreeNavigation(threadId): Promise<HarnessTreeCancelResult> {
      const record = records.get(threadId)
      const operation = record?.structure
      // 只取消仍在进行的摘要模型请求；摘要已返回、正在保存落点时不可取消。
      if (operation?.kind !== 'navigate' || !operation.summaryActive) {
        return { status: 'idle' }
      }
      operation.cancel()
      return { status: 'cancelled' }
    },

    async forkThread(threadId, input) {
      return forkThreadNow(threadId, input)
    },

    async previewThreadImport(input) {
      return previewThreadImportNow(input)
    },

    async importThread(input) {
      assertActive()
      // 宿主范围内串行提交：两个同 ID 请求不会各写一份文件。
      return withImportLock(() => importThreadNow(input))
    },

    async sendMessage(threadId, input, options?: HarnessSendMessageOptions) {
      assertActive()
      // 调用方窗口上下文沿 prompt/工具异步链传播；命令处理与工具可据此定向。
      return callerContext.run(options?.callerId, async () => {
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
            return { disposition: 'cancelled' }
          }
          // 取消判断合并两个来源：冷打开窗口的 token 与 record 上的在途取消标记。
          return await send(record, input, () => token.cancelled)
        } finally {
          tokens.delete(token)
          if (tokens.size === 0) startingSends.delete(threadId)
        }
      })
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

    async runThreadBash(threadId, input) {
      return runThreadBashNow(threadId, input)
    },

    async abortThreadBash(threadId) {
      assertActive()
      return abortThreadBashNow(threadId)
    },

    async compactThread(threadId, input) {
      return compactThreadNow(threadId, input)
    },

    async abortThreadCompaction(threadId) {
      assertActive()
      return abortThreadCompactionNow(threadId)
    },

    async setAutoCompaction(threadId, enabled) {
      return withSettingsWrite(() => setAutoCompactionNow(threadId, enabled))
    },

    async getThreadModelScope(threadId) {
      assertActive()
      const record = await ensureOpen(threadId)
      return modelScopeOf(record)
    },

    async setThreadModelScope(threadId, input) {
      return withSettingsWrite(() => setThreadModelScopeNow(threadId, input))
    },

    async refreshModels(input) {
      return refreshModelsNow(input)
    },

    async getAvailableModels(input) {
      assertActive()
      const info = await queryProject(input?.workspacePath ?? workspacePath)
      if (info.status === 'needs-trust') throw new ProjectTrustRequiredError(info)
      if (info.status === 'failed') throw new Error('项目装配失败')
      return listModelCatalog(modelRuntime)
    },

    async setModel(threadId, input) {
      const record = await ensureOpen(threadId)
      const model = modelRuntime.getModel(input.provider, input.modelId)
      if (!model)
        throw new Error(`${input.provider}/${input.modelId} is not in Pi's model registry`)
      const operation = beginStructure(record, 'model')
      try {
        await record.session.setModel(model)
        record.lastError = undefined
      } finally {
        releaseStructure(record, operation)
      }
    },

    async setThinkingLevel(threadId, level: HarnessThinkingLevel) {
      const record = await ensureOpen(threadId)
      const operation = beginStructure(record, 'thinking')
      try {
        await record.session.setThinkingLevel(level)
      } finally {
        releaseStructure(record, operation)
      }
    },

    async renameThread(threadId, title) {
      const record = records.get(threadId)
      if (record) {
        // 重命名只追加 session_info（不改变上下文），允许在运行中执行；
        // 仍占用结构闸门，与导航/标签/模型切换互斥。
        const operation = beginStructure(record, 'rename', { allowRunning: true })
        try {
          record.session.setSessionName(title)
          invalidateCatalog(record.workspacePath)
        } finally {
          releaseStructure(record, operation)
        }
        return
      }
      // 冷会话重命名不装配项目扩展；用进程内标记与打开/导航互斥，
      // 并在发现已出现 live record 时拒绝，避免两个管理器同时改同一文件。
      if (coldStructure.has(threadId) || pendingOpens.has(threadId)) {
        throw new ThreadStructureBusyError()
      }
      coldStructure.add(threadId)
      try {
        const live = records.get(threadId)
        if (live) {
          const operation = beginStructure(live, 'rename', { allowRunning: true })
          try {
            live.session.setSessionName(title)
            invalidateCatalog(live.workspacePath)
          } finally {
            releaseStructure(live, operation)
          }
          return
        }
        const info = await findSessionInfo(threadId)
        if (!info) throw new Error(`Unknown thread: ${threadId}`)
        const scope = assertSessionFileInScope(info.path, info.cwd)
        SessionManager.open(info.path, scope.dir).appendSessionInfo(title)
        invalidateCatalog(info.cwd || workspacePath)
      } finally {
        coldStructure.delete(threadId)
      }
    },

    async archiveThread(threadId) {
      assertActive()
      const record = records.get(threadId)
      const info = record ? undefined : await findSessionInfo(threadId)
      if (!record && !info) throw new Error(`Unknown thread: ${threadId}`)
      // 归档是 huan 侧车组织标记：不改 Pi JSONL、不改工作区 revision、不停止任务。
      await workspaceStore.setSessionArchived({ storeId, sessionId: threadId, archived: true })
      if (record) emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    async unarchiveThread(threadId) {
      assertActive()
      const record = records.get(threadId)
      const info = record ? undefined : await findSessionInfo(threadId)
      if (!record && !info) throw new Error(`Unknown thread: ${threadId}`)
      await workspaceStore.setSessionArchived({ storeId, sessionId: threadId, archived: false })
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

    async getHostInteractions(): Promise<HarnessHostInteractionSnapshot> {
      assertActive()
      return interactions.snapshot()
    },

    subscribeHostInteractions(listener) {
      if (disposed) return () => {}
      return interactions.subscribe((snapshot) => {
        listener({ type: 'snapshot', seq: snapshot.seq, snapshot })
      })
    },

    async respondToHostInteraction(response: HarnessHostUiResponse) {
      assertActive()
      return { accepted: interactions.respond(response) }
    },

    async consumeHostUiDirective(threadId, directiveId, options) {
      assertActive()
      const record = records.get(threadId)
      if (!record) return false
      let changed = false
      const directive = record.hostUi.editorDirective
      if (directive?.id === directiveId) {
        if (directive.callerId && directive.callerId !== options?.callerId) return false
        record.hostUi.editorDirective = undefined
        changed = true
      }
      if (record.hostUi.commandTarget?.id === directiveId) {
        const callerId = record.hostUi.commandTarget.callerId
        if (callerId && callerId !== options?.callerId) return false
        record.hostUi.commandTarget = undefined
        changed = true
      }
      if (changed) emitHostUiSnapshot(record)
      return changed
    },

    subscribe(threadId, listener, subOptions) {
      // 损坏元数据仅允许冷读，订阅也不能隐式装配项目代码。
      if (!workspaceStore.healthy) {
        let active = true
        void client
          .getThread(threadId)
          .then((snapshot) => {
            if (active && subOptions?.includeSnapshot !== false) {
              listener({ type: 'snapshot', snapshot, threadId, seq: 0 })
            }
          })
          .catch(() => {})
        return () => {
          active = false
        }
      }
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

  /**
   * 冷读装载：只打开作用域校验后的 SessionManager，读取活动分支与上下文。
   *
   * 不构造 AgentSession、不装配项目设置/扩展、不联网；未知模型窗口时
   * `contextUsage` 缺失（不填 0）；压缩后无有效助手 usage 时由
   * `deriveContextUsage` 返回 tokens=null。
   */
  const loadColdSession = (info: SessionCatalogInfo) => {
    // 冷树/快照/详情共享同一落点规则，不装配项目扩展也不联网。
    const sessionManager = openScopedSessionManager(info)
    const branch = sessionManager.getBranch() as unknown as HarnessAnySessionEntry[]
    const context = sessionManager.buildSessionContext()
    const contextWindow = context.model
      ? (modelRuntime.getModel(context.model.provider, context.model.modelId)?.contextWindow ?? 0)
      : 0
    const contextUsage = deriveContextUsage(contextWindow, branch, context.messages)
    const storedWorkspaceId = workspaceStore.sessionWorkspace(storeId, info.id)
    const workspaceMetadata = sessionWorkspaceFields(
      info.id,
      storedWorkspaceId ? workspaceStore.workspace(storedWorkspaceId)?.revision : undefined,
    )
    const metadata: HarnessThreadMetadata = {
      ...mapColdMetadata(
        info,
        {
          messages: context.messages,
          thinkingLevel: context.thinkingLevel,
          model: context.model,
        },
        {
          archived: workspaceStore.sessionArchived(storeId, info.id),
          ...(contextUsage ? { contextUsage } : {}),
        },
      ),
      leafId: sessionManager.getLeafId(),
      treeRevision: sessionTreeRevision(sessionManager),
      ...(() => {
        const enabled = coldAutoCompactionEnabled(info.cwd)
        return enabled === undefined ? {} : { autoCompactionEnabled: enabled }
      })(),
      ...workspaceMetadata,
    }
    return { sessionManager, branch, context, contextUsage, metadata }
  }

  /** 冷读快照（不经 AgentSession）。 */
  const snapshotFromSessionFile = (info: SessionCatalogInfo): HarnessThreadSnapshot => {
    const cold = loadColdSession(info)
    return {
      metadata: cold.metadata,
      messages: cold.context.messages as HarnessAgentMessage[],
      messageEntryIds: messageEntryIds(cold.sessionManager, cold.context.messages),
      readiness: getModelReadiness(
        modelRuntime,
        cold.context.model
          ? {
              provider: cold.context.model.provider,
              modelId: cold.context.model.modelId,
            }
          : undefined,
        'session',
      ),
    }
  }

  /**
   * 只读详情：热会话直接使用 SDK 统计，冷会话按 SDK 同口径聚合全文件条目。
   *
   * 详情按需请求，不随每个 token 事件聚合整棵树，也不建立全历史索引。
   */
  const threadDetailsOf = async (threadId: string): Promise<HarnessThreadDetails> => {
    const info = await findSessionInfo(threadId)
    const record = records.get(threadId)
    if (record) {
      // 热会话：`getSessionStats()` 是权威口径（全文件累计），上下文复用同一会话。
      const stats = record.session.getSessionStats()
      return {
        metadata: {
          ...metadataOf(record),
          ...(info
            ? {
                createdAt: info.created.toISOString(),
                updatedAt: info.modified.toISOString(),
                ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
              }
            : {}),
        },
        stats: {
          userMessages: stats.userMessages,
          assistantMessages: stats.assistantMessages,
          toolResults: stats.toolResults,
          toolCalls: stats.toolCalls,
          totalMessages: stats.totalMessages,
          tokens: stats.tokens,
          cost: stats.cost,
        },
        ...(stats.contextUsage ? { contextUsage: stats.contextUsage } : {}),
        branchEntryCount: record.sessionManager.getBranch().length,
      }
    }
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    const cold = loadColdSession(info)
    return {
      metadata: cold.metadata,
      stats: aggregateSessionStats(cold.sessionManager.getEntries()),
      ...(cold.contextUsage ? { contextUsage: cold.contextUsage } : {}),
      branchEntryCount: cold.branch.length,
    }
  }

  return {
    ...client,
    async dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      // 先结算所有宿主级启动请求，解除 project/session 装配等待。
      interactions.dispose()
      for (const pending of pendingOpens.values()) pending.controller.abort()
      pendingOpens.clear()
      for (const record of [...records.values()]) {
        // 进入收尾：不再接受新运行；唤醒等待闸门的发送（随后被取消并排空）。
        record.retired = true
        wakeAdmissionWaiters(record)
        // 先取消用户 Shell 与结构操作（摘要/导航），再中止运行与收尾。
        await abortUserBashForRetire(record)
        await cancelAndDrainStructure(record)
        // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
        discardDeferredRuns(record.session)
        // 使在途发送失效，并解除阻断式 UI 等待（避免 abort 等不到对话）。
        for (const pending of record.inFlight) pending.cancelled = true
        record.uiBridge.dismissAll()
        // 中止运行并等待收尾（等待有上限：SDK 的 abort() 会等 idle）。
        await abortForRetire(record.session)
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
      editorMirrors.clear()
    },
    diagnostics: () => [...diagnostics],
  }
}
