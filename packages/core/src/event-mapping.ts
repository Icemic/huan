/**
 * Pi 会话事件 → 协议事件的映射。
 *
 * 映射保持「结构忠实」（Pi 的消息形状与协议镜像一致，属类型边界而非转换），
 * 对 SDK 事件联合做穷尽检查：新增已知事件若未映射会在编译期报错（never 兜底），
 * 从而避免静默漏事件。
 */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessAssistantMessageDelta,
  HarnessClientEventBody,
} from '@huan/protocol'

/** Pi 会话事件流中本模块负责的「已知」事件类型（其余为 SDK 内部增强事件，走兜底）。 */
type MappedSessionEvent = Exclude<
  AgentSessionEvent,
  { type: 'entry_appended' } | { type: 'session_info_changed' }
>

/** 映射上下文：会话级序号由宿主维护，映射层只补充派生字段。 */
export type MapSessionEventContext = {
  /** turn_start / turn_end 在 SDK 事件中无序号，由宿主按序推导。 */
  turnIndex: number
}

/**
 * 单条会话事件的映射结果：
 * - `event`：要投递给订阅者的事件体；
 * - `ignored`：该事件不进入协议（如 SDK 内部的摘要重试细节），不视为遗漏。
 */
export type MappedSessionEventResult =
  | { kind: 'mapped'; event: HarnessClientEventBody }
  | { kind: 'ignored' }

/**
 * 把 Pi 会话事件映射为协议事件体。
 *
 * 未覆盖的已知事件（summarization_retry_* 等 TUI 内部细节、bash_execution_update 等）
 * 显式归类为 ignored，与「忘记映射」区分开。
 */
export function mapSessionEvent(
  event: AgentSessionEvent,
  ctx: MapSessionEventContext,
): MappedSessionEventResult {
  switch (event.type) {
    case 'agent_start':
      return { kind: 'mapped', event: { type: 'agent_start' } }
    case 'agent_end':
      return { kind: 'mapped', event: { type: 'agent_end', willRetry: event.willRetry } }
    case 'agent_settled':
      return { kind: 'mapped', event: { type: 'agent_settled' } }
    case 'turn_start':
      return { kind: 'mapped', event: { type: 'turn_start', turnIndex: ctx.turnIndex } }
    case 'turn_end':
      return { kind: 'mapped', event: { type: 'turn_end', turnIndex: ctx.turnIndex } }
    case 'message_start':
      return {
        kind: 'mapped',
        event: { type: 'message_start', message: event.message as HarnessAgentMessage },
      }
    case 'message_update':
      return {
        kind: 'mapped',
        event: {
          type: 'message_update',
          message: event.message as HarnessAgentMessage,
          assistantMessageEvent: event.assistantMessageEvent as HarnessAssistantMessageDelta,
        },
      }
    case 'message_end':
      return {
        kind: 'mapped',
        event: { type: 'message_end', message: event.message as HarnessAgentMessage },
      }
    case 'tool_execution_start':
      return {
        kind: 'mapped',
        event: {
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          // 嵌套工具（codemode 脚本等）带父调用 ID；缺失时不写，保持载荷干净。
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      }
    case 'tool_execution_update':
      return {
        kind: 'mapped',
        event: {
          type: 'tool_execution_update',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      }
    case 'tool_execution_end':
      return {
        kind: 'mapped',
        event: {
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      }
    case 'queue_update':
      return {
        kind: 'mapped',
        event: { type: 'queue_update', steering: event.steering, followUp: event.followUp },
      }
    case 'compaction_start':
      return { kind: 'mapped', event: { type: 'compaction_start', reason: event.reason } }
    case 'compaction_end':
      return {
        kind: 'mapped',
        event: {
          type: 'compaction_end',
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
          ...(event.result && event.result.tokensBefore !== undefined
            ? { tokensBefore: event.result.tokensBefore }
            : {}),
          ...(event.result && event.result.estimatedTokensAfter !== undefined
            ? { estimatedTokensAfter: event.result.estimatedTokensAfter }
            : {}),
        },
      }
    case 'entry_appended':
      return {
        kind: 'mapped',
        event: { type: 'entry_appended', entry: event.entry as HarnessAnySessionEntry },
      }
    case 'session_info_changed':
      return event.name === undefined
        ? { kind: 'mapped', event: { type: 'session_info_changed' } }
        : { kind: 'mapped', event: { type: 'session_info_changed', name: event.name } }
    case 'thinking_level_changed':
      return {
        kind: 'mapped',
        event: { type: 'thinking_level_changed', level: event.level },
      }
    case 'auto_retry_start':
      return {
        kind: 'mapped',
        event: { type: 'auto_retry_start', attempt: event.attempt, delayMs: event.delayMs },
      }
    case 'auto_retry_end':
      return { kind: 'mapped', event: { type: 'auto_retry_end', success: event.success } }
    // 以下为 SDK 的 TUI/摘要内部事件：协议不承载，显式忽略。
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
    case 'bash_execution_update':
      return { kind: 'ignored' }
    default: {
      // 穷尽性检查：SDK 新增未映射的已知事件时，此处的 never 赋值会编译报错。
      const exhaustive: never = event
      void exhaustive
      return { kind: 'ignored' }
    }
  }
}

/** 映射中确定不属于 MappedSessionEvent 的两类事件的类型守卫（供单测/宿主调用）。 */
export type { MappedSessionEvent }
