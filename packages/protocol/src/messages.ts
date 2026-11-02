/**
 * 消息镜（message mirror）：Pi 消息与内容形状的 JSON-safe 镜像。
 *
 * 本模块与 @huan/protocol 的其他部分一样：不依赖 Pi SDK、可在浏览器安全求值。
 * 形状对照 Pi（@earendil-works/pi-ai / pi-coding-agent）的消息类型，按「浏览器
 * 消费闭包」取必要子集；未知角色经 PiUnknownAgentMessage 兜底，不阻断序列化。
 */

/** 文本内容块。 */
export interface HarnessTextContent {
  type: 'text'
  text: string
  textSignature?: string
}

/** 思考（reasoning）内容块。 */
export interface HarnessThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  /** 为 true 时思考内容被安全过滤遮蔽，载荷在 thinkingSignature 中；UI 应提示而不是静默隐藏。 */
  redacted?: boolean
}

/** 图片内容（base64 或 data URL）。 */
export interface HarnessImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** 工具调用内容块。 */
export interface HarnessToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
  thoughtSignature?: string
}

/** 助手消息内容块。 */
export type HarnessAssistantContent = HarnessTextContent | HarnessThinkingContent | HarnessToolCall

/** 用户消息内容块。 */
export type HarnessUserContent = HarnessTextContent | HarnessImageContent

/** 工具结果内容块。 */
export type HarnessToolResultContent = HarnessTextContent | HarnessImageContent

/** Token 用量（含成本）。 */
export interface HarnessUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

/** 停止原因。 */
export type HarnessStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'

/** 用户消息。 */
export interface HarnessUserMessage {
  role: 'user'
  content: string | HarnessUserContent[]
  timestamp: number
}

/** 助手消息。 */
export interface HarnessAssistantMessage {
  role: 'assistant'
  content: HarnessAssistantContent[]
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  usage: HarnessUsage
  stopReason: HarnessStopReason
  errorMessage?: string
  timestamp: number
}

/** 嵌套工具调用摘要（SDK 有界记录；不承诺完整历史子结果）。 */
export interface HarnessNestedToolCall {
  id: string
  name: string
  arguments?: Record<string, unknown>
  argumentsBytes?: number
  status: 'ok' | 'error' | 'unfinished'
  durationMs?: number
  error?: string
}

export interface HarnessNestedToolCalls {
  calls: HarnessNestedToolCall[]
  complete: boolean
}

/** 工具结果消息（content 为可渲染输出；details 为工具特定元数据）。 */
export interface HarnessToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: HarnessToolResultContent[]
  details?: unknown
  /** 本次模型工具调用所发起的嵌套调用摘要；缺失表示无或旧记录。 */
  nestedCalls?: HarnessNestedToolCalls
  isError: boolean
  timestamp: number
}

/** 经 `!` 执行的 bash 消息（Pi 的一种消息角色，不是工具调用）。 */
export interface HarnessBashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  timestamp: number
  /** `!!` 前缀：不进入 LLM 上下文。 */
  excludeFromContext?: boolean
}

/** 扩展经 `sendMessage()` 注入的消息。 */
export interface HarnessCustomMessage {
  role: 'custom'
  customType: string
  content: string | HarnessUserContent[]
  /** 为 false 时参与 LLM 上下文但在 UI 中隐藏。 */
  display: boolean
  details?: unknown
  timestamp: number
}

/** 分支摘要消息。 */
export interface HarnessBranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId: string
  timestamp: number
}

/** 压缩摘要消息。 */
export interface HarnessCompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

/** 已知角色的消息联合。 */
export type HarnessKnownAgentMessage =
  | HarnessUserMessage
  | HarnessAssistantMessage
  | HarnessToolResultMessage
  | HarnessBashExecutionMessage
  | HarnessCustomMessage
  | HarnessBranchSummaryMessage
  | HarnessCompactionSummaryMessage

/** 前向兼容兜底：未知/增强角色。 */
export interface HarnessUnknownAgentMessage {
  role: string
  timestamp?: number
  [key: string]: unknown
}

/** 消息联合（含未知兜底）。 */
export type HarnessAgentMessage = HarnessKnownAgentMessage | HarnessUnknownAgentMessage

/** 会话分支记录（entry）的公共字段。 */
interface HarnessSessionEntryBase {
  id: string
  parentId: string | null
  timestamp: string
}

/** 已知类型的会话记录。 */
export type HarnessSessionEntry =
  | (HarnessSessionEntryBase & { type: 'message'; message: HarnessAgentMessage })
  | (HarnessSessionEntryBase & { type: 'thinking_level_change'; thinkingLevel: string })
  | (HarnessSessionEntryBase & { type: 'model_change'; provider: string; modelId: string })
  | (HarnessSessionEntryBase & {
      type: 'compaction'
      summary: string
      firstKeptEntryId: string
      tokensBefore: number
      details?: unknown
      fromHook?: boolean
    })
  | (HarnessSessionEntryBase & {
      type: 'branch_summary'
      fromId: string
      summary: string
      details?: unknown
      fromHook?: boolean
    })
  | (HarnessSessionEntryBase & { type: 'custom'; customType: string; data?: unknown })
  | (HarnessSessionEntryBase & {
      type: 'custom_message'
      customType: string
      content: string | (HarnessTextContent | HarnessImageContent)[]
      details?: unknown
      display: boolean
    })
  | (HarnessSessionEntryBase & { type: 'label'; targetId: string; label?: string | undefined })
  | (HarnessSessionEntryBase & { type: 'session_info'; name?: string })

/** 未知类型的会话记录（前向兼容）。 */
export interface HarnessUnknownSessionEntry extends HarnessSessionEntryBase {
  type: string
  [key: string]: unknown
}

/** 会话记录联合（含未知兜底）。 */
export type HarnessAnySessionEntry = HarnessSessionEntry | HarnessUnknownSessionEntry

/** 助手消息的流式增量事件（对应 Pi 的 assistantMessageEvent）。 */
export type HarnessAssistantMessageDelta =
  | { type: 'start'; partial: HarnessAssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: HarnessAssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: HarnessAssistantMessage }
  | {
      type: 'text_end'
      contentIndex: number
      content: string
      partial: HarnessAssistantMessage
    }
  | { type: 'thinking_start'; contentIndex: number; partial: HarnessAssistantMessage }
  | {
      type: 'thinking_delta'
      contentIndex: number
      delta: string
      partial: HarnessAssistantMessage
    }
  | {
      type: 'thinking_end'
      contentIndex: number
      content: string
      partial: HarnessAssistantMessage
    }
  | { type: 'toolcall_start'; contentIndex: number; partial: HarnessAssistantMessage }
  | {
      type: 'toolcall_delta'
      contentIndex: number
      delta: string
      partial: HarnessAssistantMessage
    }
  | {
      type: 'toolcall_end'
      contentIndex: number
      toolCall: HarnessToolCall
      partial: HarnessAssistantMessage
    }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: HarnessAssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: HarnessAssistantMessage }
