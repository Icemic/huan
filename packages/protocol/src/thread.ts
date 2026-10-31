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
import type { HarnessThreadTreeOperation } from './tree.js'

/** 上下文用量。 */
export interface HarnessContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** Thinking 级别。 */
export type HarnessThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** 目录中的模型信息。 */
export type HarnessModelInfo = {
  provider: string
  modelId: string
  name?: string
  supportsThinking?: boolean
  availableThinkingLevels?: readonly HarnessThinkingLevel[]
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

/** 队列中的一条消息（id 形如 "<mode>:<index>"）。 */
export type HarnessQueuedMessage = {
  id: string
  mode: 'followUp' | 'steer'
  content: string
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
  initialMessage?: HarnessSendMessageInput
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
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName?: string; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError: boolean }
  | { type: 'queue_update'; steering: readonly string[]; followUp: readonly string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | { type: 'compaction_end'; aborted: boolean; willRetry: boolean }
  | { type: 'entry_appended'; entry: HarnessAnySessionEntry }
  | { type: 'auto_retry_start'; attempt: number; delayMs: number }
  | { type: 'auto_retry_end'; success: boolean }
  | { type: 'session_info_changed'; name?: string }
  | { type: 'thinking_level_changed'; level: string }
  | { type: 'context_usage'; contextUsage: HarnessContextUsage }
  | { type: 'extension_ui_request'; request: HarnessHostUiRequest }
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

/** 会话快照（权威状态；订阅首帧与重连恢复均用它）。 */
export type HarnessThreadSnapshot = {
  metadata: HarnessThreadMetadata
  messages: HarnessAgentMessage[]
  /**
   * 与 `messages` 等长的来源 entryId（缺失表示尚未落盘/无法定位）。
   * 消息投影据此保留 sourceEntryId，供树定位与后续 fork 复用。
   */
  messageEntryIds?: (string | null)[]
  /** 待处理的阻断式 Host UI 请求（存活于宿主 record，重连后仍可见）。 */
  hostUiRequests?: readonly HarnessHostUiRequest[]
  readiness?: HarnessRuntimeReadiness
  /** 快照反映的每线程序号；HTTP 冷读可缺席。 */
  seq?: number
  /** 最近一次运行期错误。 */
  lastError?: string
}
