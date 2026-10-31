/**
 * 独立分支契约：历史用户消息 fork 与当前位置 clone。
 *
 * 语义对照 Pi 的 `session_before_fork`：
 * - `before`：从用户消息之前分叉，返回该消息原文供发起窗口编辑；
 * - `at`：从目标节点（缺省当前 leaf）包含该节点分叉。
 *
 * 两种操作都创建独立 ID/文件/父会话血缘，不替换、不停止父会话；
 * 扩展可经 `session_before_fork` 取消，宿主不得在取消时创建文件或元数据。
 */
import type { HarnessThreadSnapshot } from './thread.js'

/** 分叉位置：before 对应用户消息 fork，at 对应 clone。 */
export type HarnessThreadForkPosition = 'before' | 'at'

/** fork/clone 输入。 */
export type HarnessThreadForkInput = {
  /**
   * 目标节点（Pi entryId）。
   * `before` 必须指向一条用户消息；`at` 省略时使用当前活动落点（空会话为 null）。
   */
  entryId?: string
  /** 缺省 `before`。 */
  position?: HarnessThreadForkPosition
  /** 读取树时的 revision；不一致时返回 conflict，不按旧落点分叉。 */
  expectedRevision?: string
}

/** fork/clone 结果状态。 */
export type HarnessThreadForkStatus = 'created' | 'cancelled' | 'busy' | 'conflict' | 'failed'

/** fork/clone 结果。 */
export type HarnessThreadForkResult = {
  status: HarnessThreadForkStatus
  /** 子会话 ID（created 时）。 */
  threadId?: string
  /** 父会话 ID（created 时）。 */
  parentThreadId?: string
  /** 被分叉的用户消息原文；仅发起窗口使用，不进入广播快照。 */
  selectedText?: string
  /** 子会话权威快照（created 时，供发起窗口切换后立即使用）。 */
  snapshot?: HarnessThreadSnapshot
  /** 失败/取消原因；扩展取消时也会说明是扩展决定。 */
  message?: string
}
