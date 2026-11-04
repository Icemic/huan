/**
 * 宿主↔UI 契约：会话、事件、Host UI、模型与就绪度。
 *
 * JSON-safe、可序列化；不依赖 Pi SDK 与 Node（浏览器安全）。
 * 事件形状对照 Pi 会话事件，按「浏览器消费闭包」取必要子集；
 * 未知事件经 HarnessUnknownClientEventBody 兜底（reducer 会忽略其载荷，只记序号）。
 */
import type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessAssistantMessageDelta,
  HarnessImageContent,
} from './messages.js'
import type { HarnessBashRun, HarnessCompactionPhase } from './runtime.js'
import type { HarnessThreadTreeOperation } from './tree.js'

/** 上下文用量。 */
export interface HarnessContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** Thinking 级别（与 Pi 1.4 的 ThinkingLevel 一致，含 max）。 */
export type HarnessThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 模型输入模态（Pi Model.input 的受控子集）。 */
export type HarnessModelInput = 'text' | 'image'

/** 目录中的模型信息。 */
export type HarnessModelInfo = {
  provider: string
  modelId: string
  name?: string
  supportsThinking?: boolean
  /** 模型支持的 Thinking 级别（按 SDK 规则解析，xhigh/max 需显式映射）。 */
  availableThinkingLevels?: readonly HarnessThinkingLevel[]
  /** 输入模态；缺失表示目录未声明。 */
  input?: readonly HarnessModelInput[]
}

/** 就绪度（模型是否可就绪、缺什么）。 */
export type HarnessRuntimeReadiness =
  | {
      state: 'ready'
      selection: { provider: string; modelId: string }
      source: 'env' | 'session' | 'pi-default'
    }
  | { state: 'missing-model'; message: string }
  | { state: 'missing-credentials'; provider?: string; message: string }
  | {
      state: 'unavailable-model'
      selection: { provider: string; modelId: string }
      message: string
    }

/** 线程状态。 */
export type HarnessThreadStatus = 'idle' | 'running' | 'failed'

/** 资源重载触发来源（只用于展示与审计，不参与授权）。 */
export type HarnessReloadTrigger = 'command' | 'settings' | 'extension' | 'api'

/** 一次资源重载的状态。 */
export type HarnessReloadStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * 一次资源重载操作（快照与事件共用）。
 *
 * 每次重载都有独立 id：并发窗口看到的是同一次操作，而不是按时间猜测。
 * `status` 如实反映结局；取消（dispose/会话关闭）不等于成功。
 */
export type HarnessReloadOperation = {
  id: string
  /** 触发来源；扩展命令走 ctx.reload 时为 extension。 */
  trigger: HarnessReloadTrigger
  status: HarnessReloadStatus
  /** 目标会话；空白页目标（只刷新待消费装配）缺失。 */
  threadId?: string
  /** 目标固定 cwd。 */
  workspacePath: string
  startedAt: string
  finishedAt?: string
  /** 重载开始前的资源版本。 */
  fromResourceRevision: number
  /** 成功后的资源版本；失败/取消时保留开始前的值。 */
  resourceRevision: number
  /** 受控失败说明（不含堆栈/凭据）。 */
  message?: string
}

/** 队列中的一条消息（id 形如 "<mode>:<index>"）。 */
export type HarnessQueuedMessage = {
  id: string
  mode: 'followUp' | 'steer'
  content: string
}

/** 模型回退原因（只含受控字段，不含任意错误/凭据）。 */
export type HarnessModelFallbackReason = 'restore-failed' | 'no-model' | 'unknown'

export type HarnessModelFallback = {
  reason: HarnessModelFallbackReason
  requested?: { provider: string; modelId: string }
  active?: { provider: string; modelId: string }
  message: string
}

/** 会话目录条目元数据。 */
export type HarnessThreadMetadata = {
  id: string
  /** 显示标题：显式名称 > 首条用户消息（截断）> 会话文件名。 */
  title?: string
  /** 显式会话名（不含回退标题）；「仅命名」过滤使用，缺失表示未命名。 */
  name?: string
  /** 首条用户消息文本（全文件口径、未截断）；列表搜索使用。 */
  firstMessageText?: string
  /** 会话固定起始目录（cwd）；不是工作区 ID。 */
  workspacePath?: string
  /** 显式归属的工作区；缺失表示未归属（不按 cwd 推断）。 */
  workspaceId?: string
  /** 工作区当前权威 revision（未归属时缺失）。 */
  workspaceRevision?: number
  /** 该会话本轮实际应用的工作区 revision；下一轮生效时与权威值不同。 */
  workspaceAppliedRevision?: number
  archived?: boolean
  status: HarnessThreadStatus
  compactionActive?: boolean
  /** 压缩触发原因（进行中才有意义）。 */
  compactionReason?: 'manual' | 'threshold' | 'overflow'
  /** 当前会话的自动压缩开关（来自该会话的用户设置）；冷会话可能缺失。 */
  autoCompactionEnabled?: boolean
  /** SDK 恢复/默认解析时发生的模型回退；只含受控原因与原/有效模型。 */
  modelFallback?: HarnessModelFallback
  /** 共享模型目录显式刷新代数。 */
  modelCatalogRevision?: number
  /** 当前模型声明的输入模态；用于提交前校验图片能力。 */
  modelInput?: readonly HarnessModelInput[]
  retryActive?: boolean
  retryAttempt?: number
  runningRunId?: string
  queuedMessages?: readonly HarnessQueuedMessage[]
  config?: {
    provider?: string
    modelId?: string
    thinkingLevel?: HarnessThinkingLevel | string
  }
  contextUsage?: HarnessContextUsage
  /** 会话 .jsonl 路径（结构化句柄）。 */
  sessionFile?: string
  /** 跨会话文件的分支血缘。 */
  parentSessionPath?: string
  messageCount?: number
  createdAt?: string
  updatedAt?: string
  /** 当前活动落点（Pi entryId；空会话为 null）。 */
  leafId?: string | null
  /** 结构 revision 指纹：条目或活动落点变化后不同。 */
  treeRevision?: string
  /** 进行中的结构操作；空闲时缺失。 */
  treeOperation?: HarnessThreadTreeOperation
  /** 该会话当前资源版本；每次成功重载递增（用于失效旧查询结果）。 */
  resourceRevision?: number
  /** 最近一次（或进行中的）资源重载操作；从未重载时缺失。 */
  reload?: HarnessReloadOperation
}

/** 图片附件透传（对照 Pi ImageContent）。 */
export type HarnessInputAttachment = HarnessImageContent

/** 发送消息输入。 */
export type HarnessSendMessageInput = {
  content: string
  attachments?: HarnessInputAttachment[]
  /** 运行中必需（Pi `prompt()` 否则抛错）。 */
  streamingBehavior?: 'followUp' | 'steer'
}

/**
 * 发送调用的传输元数据（不进入 Pi 会话记录）。
 *
 * `callerId` 标识发起窗口，用于把扩展的编辑器操作定向到该窗口。
 */
export type HarnessSendMessageOptions = {
  callerId?: string
}

/**
 * 发送提交点处置。
 *
 * `handled` 表示扩展命令或 input hook 已处理输入、不会产生运行事件；
 * 客户端据此撤销乐观消息，而不是等待永远不会到来的消息/快照确认。
 */
export type HarnessSendMessageDisposition = 'started' | 'queued' | 'handled' | 'cancelled'

export type HarnessSendMessageResult = {
  disposition: HarnessSendMessageDisposition
}

/** 创建会话输入。 */
export type HarnessCreateThreadInput = {
  /** 新会话归属的工作区；缺省时宿主使用启动项目对应的默认工作区。 */
  workspaceId?: string
  /** 起始目录必须是工作区成员；缺省使用成员列表首项。 */
  startProjectPath?: string
  title?: string
  /**
   * 新会话首次使用的模型（可选；缺省时由宿主按环境变量/settings 解析）。
   * 显式指定可让「先选模型再发第一条消息」在不额外往返的情况下生效。
   */
  model?: { provider: string; modelId: string }
  /** 新会话的 Thinking 级别（可选；在模型应用之后生效）。 */
  thinkingLevel?: HarnessThinkingLevel
}

/** Host UI 请求种类。 */
export type HarnessHostUiRequestKind = 'confirm' | 'select' | 'input' | 'editor'

/** Host UI 请求（阻断式交互；toolCallId 表示由工具调用关联）。 */
export type HarnessHostUiRequest =
  | {
      id: string
      kind: 'confirm'
      title: string
      message: string
      toolCallId?: string
      timeoutMs?: number
    }
  | {
      id: string
      kind: 'select'
      title: string
      options: readonly string[]
      toolCallId?: string
      timeoutMs?: number
    }
  | {
      id: string
      kind: 'input'
      title: string
      placeholder?: string
      toolCallId?: string
      timeoutMs?: number
    }
  | {
      id: string
      kind: 'editor'
      title: string
      prefill?: string
      toolCallId?: string
      timeoutMs?: number
    }

/** Host UI 响应。 */
export type HarnessHostUiResponse =
  | { requestId: string; confirmed: boolean }
  | { requestId: string; value: string }
  | { requestId: string; dismissed: true }

/** 运行期扩展通知（有界列表；按 id 去重）。 */
export type HarnessHostUiNotification = {
  id: string
  message: string
  type: 'info' | 'warning' | 'error'
  createdAt: number
}

/** 运行期扩展状态行（setStatus；按 key 覆盖/清除）。 */
export type HarnessHostUiStatus = {
  key: string
  text: string
}

/** 文本 widget 的放置位置（仅文本行；组件工厂不支持）。 */
export type HarnessHostUiWidgetPlacement = 'aboveEditor' | 'belowEditor'

export type HarnessHostUiWidget = {
  key: string
  lines: readonly string[]
  placement: HarnessHostUiWidgetPlacement
}

/**
 * 扩展写输入框的定向指令。
 *
 * `callerId` 是发起命令/发送的窗口标识；缺省表示后台扩展，需由任一窗口
 * 主动接受。指令有唯一 id，消费后从快照移除，重连不会重复应用。
 */
export type HarnessHostUiEditorDirective = {
  id: string
  text: string
  mode: 'set' | 'paste'
  callerId?: string
  createdAt: number
}

/** commandContextActions 创建/切换的目标会话提示（供发起窗明确接收）。 */
export type HarnessHostUiCommandTarget = {
  id: string
  action: 'newSession' | 'fork' | 'switchSession' | 'navigateTree'
  threadId: string
  title?: string
  callerId?: string
  editorText?: string
  message: string
  createdAt: number
}

/**
 * 会话运行期 Host UI 状态（快照权威；断线重连补齐）。
 *
 * 不包含 TUI 专属组件/主题；终端专属能力另以通知说明不支持。
 */
export type HarnessThreadHostUi = {
  statuses: readonly HarnessHostUiStatus[]
  widgets: readonly HarnessHostUiWidget[]
  notifications: readonly HarnessHostUiNotification[]
  /** `setTitle` 的扩展标题提示；不覆盖会话名称或 document.title。 */
  title?: string
  workingMessage?: string
  workingVisible?: boolean
  hiddenThinkingLabel?: string
  editorDirective?: HarnessHostUiEditorDirective
  commandTarget?: HarnessHostUiCommandTarget
}

/** 事件包封（每线程单调序号，用于排序与去重）。 */
export type HarnessClientEventEnvelope = {
  threadId: string
  seq: number
}

/** 已知事件体。 */
export type HarnessClientEventBody =
  | { type: 'snapshot'; snapshot: HarnessThreadSnapshot }
  | { type: 'agent_start' }
  | { type: 'agent_end'; willRetry?: boolean; cancelledBeforeStart?: boolean }
  | { type: 'agent_settled' }
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number }
  | { type: 'message_start'; message: HarnessAgentMessage }
  | {
      type: 'message_update'
      message: HarnessAgentMessage
      assistantMessageEvent: HarnessAssistantMessageDelta
    }
  | { type: 'message_end'; message: HarnessAgentMessage }
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: unknown
      /** 由另一个工具（如 codemode 脚本）发起时，指向父工具调用。 */
      parentToolCallId?: string
    }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName?: string
      partialResult: unknown
      parentToolCallId?: string
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      result: unknown
      isError: boolean
      parentToolCallId?: string
    }
  | { type: 'queue_update'; steering: readonly string[]; followUp: readonly string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow'; operationId?: string }
  | {
      type: 'compaction_end'
      reason: 'manual' | 'threshold' | 'overflow'
      aborted: boolean
      willRetry: boolean
      /** 与对应 compaction_start 相同；缺失时由客户端沿用进行中标识。 */
      operationId?: string
      /** 失败原因（取消时不写）。 */
      errorMessage?: string
      /** 压缩前的上下文 token 估算（成功时）。 */
      tokensBefore?: number
      /** 压缩后的上下文 token 估算（成功时）。 */
      estimatedTokensAfter?: number
    }
  | { type: 'bash_start'; run: HarnessBashRun }
  | {
      type: 'bash_output'
      id: string
      /** 本次新增的输出片段。 */
      delta: string
      /** 宿主为保持有界缓冲而丢弃的前缀字符数（客户端同步裁剪）。 */
      dropped: number
    }
  | { type: 'bash_end'; run: HarnessBashRun }
  | { type: 'entry_appended'; entry: HarnessAnySessionEntry }
  | { type: 'auto_retry_start'; attempt: number; delayMs: number }
  | { type: 'auto_retry_end'; success: boolean }
  | { type: 'session_info_changed'; name?: string }
  | { type: 'thinking_level_changed'; level: string }
  | { type: 'context_usage'; contextUsage: HarnessContextUsage }
  | { type: 'extension_ui_request'; request: HarnessHostUiRequest }
  /** 资源重载开始（另一窗口可据此显示“重载中”，不取消工作）。 */
  | { type: 'reload_start'; operation: HarnessReloadOperation }
  /** 资源重载结算（成功/失败/取消）；resourceRevision 供命令目录与设置面板失效。 */
  | { type: 'reload_end'; operation: HarnessReloadOperation; resourceRevision: number }
  | { type: 'host_ui_update'; hostUi?: HarnessThreadHostUi }
  | { type: 'extension_ui_resolved'; requestId: string }
  | {
      type: 'error'
      error: string
      /** 订阅流被客户端终止时置位；重新订阅以继续接收事件。 */
      terminal?: boolean
    }

/**
 * 前向兼容的事件兜底：被增强/未知事件类型。
 * 传输层将其按 HarnessClientEvent 投递；reducer 的默认分支只记录 seq，忽略其余。
 */
export type HarnessUnknownClientEventBody = {
  type: string
  [key: string]: unknown
}

/** 已知事件。 */
export type HarnessClientEvent = HarnessClientEventBody & HarnessClientEventEnvelope

/** 传输边界（subscribe/SSE 解码）使用开放变体。 */
export type HarnessAnyClientEvent =
  | HarnessClientEvent
  | (HarnessUnknownClientEventBody & HarnessClientEventEnvelope)

/** 会话累计统计：全文件（含已压缩历史与其他分支）聚合结果。 */
export type HarnessThreadStats = {
  userMessages: number
  assistantMessages: number
  toolResults: number
  toolCalls: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  /** 累计费用（USD）。 */
  cost: number
}

/**
 * 只读会话详情。
 *
 * 明确区分「全文件累计统计」与「当前活动分支上下文」：前者覆盖已压缩掉
 * 的历史与其他分支的实际计费量，后者只描述下一次请求可见的上下文。
 */
export type HarnessThreadDetails = {
  metadata: HarnessThreadMetadata
  stats: HarnessThreadStats
  /** 当前活动分支的上下文用量；模型窗口未知时缺失。 */
  contextUsage?: HarnessContextUsage
  /** 当前活动分支的条目数（区别于全文件累计统计）。 */
  branchEntryCount: number
}

/** 活动工具执行的瞬态快照（结束后不保留为第二份历史）。 */
export interface HarnessToolExecutionSnapshot {
  toolCallId: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  status: 'running' | 'complete' | 'error'
  parentToolCallId?: string
}

/** 会话快照（权威状态；订阅首帧与重连恢复均用它）。 */
export type HarnessThreadSnapshot = {
  metadata: HarnessThreadMetadata
  messages: HarnessAgentMessage[]
  /**
   * 与 `messages` 等长的来源 entryId（缺失表示尚未落盘/无法定位）。
   * 消息投影据此保留 sourceEntryId，供树定位与后续 fork 复用。
   */
  messageEntryIds?: (string | null)[]
  /** 当前活动的工具调用（重连后恢复运行中提示；结束即移除）。 */
  toolExecutions?: readonly HarnessToolExecutionSnapshot[]
  /** 待处理的阻断式 Host UI 请求（存活于宿主 record，重连后仍可见）。 */
  hostUiRequests?: readonly HarnessHostUiRequest[]
  /** 扩展报告的状态/通知/widget/标题/编辑器指令（运行期快照权威）。 */
  hostUi?: HarnessThreadHostUi
  /** 用户 Shell 的实时/刚完成状态；持久化为历史消息后清除。 */
  bash?: HarnessBashRun
  /** 压缩运行态（进行中/最近结局、操作标识与展示锚点）。 */
  compaction?: HarnessCompactionPhase
  readiness?: HarnessRuntimeReadiness
  /** 快照反映的每线程序号；HTTP 冷读可缺席。 */
  seq?: number
  /** 最近一次运行期错误。 */
  lastError?: string
}
