/**
 * 宿主级交互通道（G1.3c）。
 *
 * 与线程内 `extension_ui_request` 的区别：
 * - 线程通道只在 record 发布后存在，依赖当前选中会话；
 * - 宿主通道在启动装配期即可查询/应答，不依赖任何线程，支持的应答范围相同。
 *
 * 请求只携带展示与结算所需字段：不包含扩展堆栈、凭据或任意上下文。
 */
import type { HarnessHostUiRequestKind, HarnessHostUiResponse } from './thread.js'

/** 请求作用域：项目装配（信任/启动）或某个会话的启动期。 */
export type HarnessHostInteractionScope =
  | { kind: 'project'; cwd: string }
  | { kind: 'session'; sessionId: string; cwd?: string }

/** 宿主级阻断式交互请求（kind 与线程通道一致）。 */
export type HarnessHostInteractionRequest = {
  id: string
  scope: HarnessHostInteractionScope
  kind: HarnessHostUiRequestKind
  title: string
  message?: string
  options?: readonly string[]
  placeholder?: string
  prefill?: string
  toolCallId?: string
  timeoutMs?: number
  /** 创建时间（epoch 毫秒）。 */
  createdAt: number
}

/** 宿主级可见通知（有界列表，按 ID 去重）。 */
export type HarnessHostInteractionNotification = {
  id: string
  scope: HarnessHostInteractionScope
  message: string
  type: 'info' | 'warning' | 'error'
  createdAt: number
}

/** 宿主级交互权威快照；`seq` 单调递增。 */
export type HarnessHostInteractionSnapshot = {
  seq: number
  requests: readonly HarnessHostInteractionRequest[]
  notifications: readonly HarnessHostInteractionNotification[]
}

/** 订阅事件：每次变化投递完整快照（首帧即恢复，不依赖增量顺序）。 */
export type HarnessHostInteractionEvent = {
  type: 'snapshot'
  seq: number
  snapshot: HarnessHostInteractionSnapshot
}

/** 应答结果：`accepted=false` 表示请求已结算或 ID 不存在（幂等）。 */
export type HarnessHostInteractionAnswer = {
  accepted: boolean
}

/** 与线程通道共享的应答形状。 */
export type HarnessHostInteractionResponse = HarnessHostUiResponse

/** 作用域标识（宿主内部按字符串取消/清理）。 */
export const hostInteractionScopeKey = (scope: HarnessHostInteractionScope): string =>
  scope.kind === 'project' ? `project:${scope.cwd}` : `session:${scope.sessionId}`
