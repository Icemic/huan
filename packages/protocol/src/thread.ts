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
  title?: string
  workspacePath?: string
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
  workspacePath?: string
  title?: string
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

/** 会话快照（权威状态；订阅首帧与重连恢复均用它）。 */
export type HarnessThreadSnapshot = {
  metadata: HarnessThreadMetadata
  messages: HarnessAgentMessage[]
  /** 待处理的阻断式 Host UI 请求（存活于宿主 record，重连后仍可见）。 */
  hostUiRequests?: readonly HarnessHostUiRequest[]
  readiness?: HarnessRuntimeReadiness
  /** 快照反映的每线程序号；HTTP 冷读可缺席。 */
  seq?: number
  /** 最近一次运行期错误。 */
  lastError?: string
}
