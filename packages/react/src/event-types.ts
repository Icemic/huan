/**
 * 已知客户端事件类型的判据。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/eventTypes.ts`
 * （MIT 许可）。改动：类型改用 `@huan/protocol`，命名 `Pi*` → `Harness*`，
 * 注释译为中文。逻辑与上游等价。
 *
 * `satisfies` 约束保证此表与协议里的事件联合保持同步：
 * 协议新增事件类型时，这里会编译报错直到补齐。
 */

import type { HarnessClientEventBody } from '@huan/protocol'

const KNOWN_HARNESS_CLIENT_EVENT_TYPES = {
  snapshot: true,
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  queue_update: true,
  compaction_start: true,
  compaction_end: true,
  entry_appended: true,
  auto_retry_start: true,
  auto_retry_end: true,
  session_info_changed: true,
  thinking_level_changed: true,
  context_usage: true,
  extension_ui_request: true,
  extension_ui_resolved: true,
  error: true,
} satisfies Record<HarnessClientEventBody['type'], true>

/** 判断事件类型是否属于协议已知集合（用于区分「已知但载荷非法」与「未知类型」）。 */
export const isKnownHarnessClientEventType = (
  type: string,
): type is HarnessClientEventBody['type'] => Object.hasOwn(KNOWN_HARNESS_CLIENT_EVENT_TYPES, type)
