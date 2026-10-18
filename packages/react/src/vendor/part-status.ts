/**
 * `toMessagePartStatus` 的本地副本（anti-corruption layer）。
 *
 * 出处：`@assistant-ui/core@0.3.27` 的 `utils/normalizePartStatus`。
 * 许可：MIT。该模块只经 `@assistant-ui/core/internal` 暴露。
 *
 * 改动：改为直接使用 `@assistant-ui/react` 的公共类型；逻辑与上游等价。
 * 用途：测试断言消息部分状态（`complete` / `running` / `incomplete`）。
 */

import type {
  MessagePartStatus,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadUserMessagePart,
  ToolCallMessagePart,
  ToolCallMessagePartStatus,
} from '@assistant-ui/react'

/** 完成状态常量（冻结共享实例以减少分配）。 */
export const COMPLETE_STATUS: MessagePartStatus = Object.freeze({ type: 'complete' })
/** 运行中状态常量。 */
export const RUNNING_STATUS: MessagePartStatus = Object.freeze({ type: 'running' })

const INCOMPLETE_STATUSES = Object.freeze({
  cancelled: Object.freeze({ type: 'incomplete', reason: 'cancelled' }),
  length: Object.freeze({ type: 'incomplete', reason: 'length' }),
  'content-filter': Object.freeze({ type: 'incomplete', reason: 'content-filter' }),
  other: Object.freeze({ type: 'incomplete', reason: 'other' }),
  error: Object.freeze({ type: 'incomplete', reason: 'error' }),
} as const)

/** 规范化部分的 status 字段；无法识别时返回 undefined。 */
export const normalizePartStatus = (
  part: ThreadUserMessagePart | ThreadAssistantMessagePart,
): MessagePartStatus | undefined => {
  const status = (part as { status?: unknown }).status
  if (!status || typeof status !== 'object') return undefined
  const { type } = status as { type?: unknown }
  if (type === 'running') return RUNNING_STATUS
  if (type === 'complete') return COMPLETE_STATUS
  if (type !== 'incomplete') return undefined
  const { reason } = status as { reason?: unknown }
  return INCOMPLETE_STATUSES[
    reason === 'cancelled' ||
    reason === 'length' ||
    reason === 'content-filter' ||
    reason === 'other' ||
    reason === 'error'
      ? reason
      : 'other'
  ]
}

/** 工具调用部分是否仍有未决操作（中断或待审批）。 */
export const hasPendingToolAction = (
  part: Pick<ToolCallMessagePart, 'approval' | 'interrupt'>,
): boolean =>
  part.interrupt != null ||
  (part.approval != null &&
    part.approval.approved === undefined &&
    part.approval.resolution === undefined)

/** 计算消息某部分的状态。 */
export const toMessagePartStatus = (
  message: ThreadMessage,
  partIndex: number,
  part: ThreadUserMessagePart | ThreadAssistantMessagePart,
): ToolCallMessagePartStatus => {
  if (message.role !== 'assistant') return COMPLETE_STATUS
  if (part.type === 'tool-call') {
    const toolPart = part as ToolCallMessagePart
    if (toolPart.result === undefined || toolPart.isPreliminary || hasPendingToolAction(toolPart)) {
      return message.status
    }
    return COMPLETE_STATUS
  }
  if (message.status.type === 'running') {
    const status = normalizePartStatus(part)
    if (status) return status
  }
  const isLastPart = partIndex === Math.max(0, message.content.length - 1)
  if (message.status.type === 'requires-action') return COMPLETE_STATUS
  return isLastPart ? message.status : COMPLETE_STATUS
}
