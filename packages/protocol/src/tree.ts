/**
 * 会话树与结构导航契约。
 *
 * 树由宿主按需从 Pi SessionManager 读取，快照只携带 leafId / revision /
 * 进行中的结构操作，不把整棵树塞进每个 token 事件。节点一律使用 Pi 的真实
 * entryId 定位，不使用 transcript 下标。
 */
import type { HarnessThreadSnapshot } from './thread.js'

/** 树节点的呈现分类（GUI 过滤用，不替代 Pi 原始条目类型）。 */
export type HarnessTreeEntryKind = 'user' | 'assistant' | 'tool' | 'summary' | 'custom' | 'state'

/** 扁平化后的树节点（按先序排列，`depth` 由宿主按完整树计算）。 */
export type HarnessThreadTreeNode = {
  entryId: string
  parentId: string | null
  /** 完整树中的深度；根为 0。 */
  depth: number
  kind: HarnessTreeEntryKind
  /** Pi 原始条目类型（message / custom_message / compaction / ...）。 */
  entryType: string
  /** 消息角色；非消息条目缺失。 */
  role?: string
  /** 单行展示摘要（已截断）。 */
  summary: string
  timestamp?: string
  label?: string
  /** 是否位于根到当前 leaf 的活动路径上。 */
  active: boolean
  /** 该节点自身是否当前 leaf。 */
  isLeaf: boolean
  /** 直接子节点数量。 */
  childCount: number
  /** 助手消息是否包含工具调用（工具过滤使用）。 */
  hasToolCalls?: boolean
}

/** 进行中的会话结构操作（随快照广播给所有窗口）。 */
export type HarnessThreadTreeOperation = {
  kind: 'navigate' | 'label'
  /** summarizing 表示导航内的分支摘要正在生成，可取消。 */
  status: 'running' | 'summarizing'
  /** 导航/标签的目标节点。 */
  targetId?: string
  startedAt: string
}

/** 树读取结果。 */
export type HarnessThreadTree = {
  threadId: string
  leafId: string | null
  /** 结构 revision 指纹：条目数或活动落点变化后不同。 */
  revision: string
  /** 先序扁平节点；空会话为空数组。 */
  nodes: HarnessThreadTreeNode[]
  /** Pi branchSummary.skipPrompt：true 时默认建议不摘要。 */
  branchSummarySkipPrompt: boolean
  /** 当前结构操作（导航/摘要/标签）；空闲时缺失。 */
  operation?: HarnessThreadTreeOperation
}

/** 导航输入。 */
export type HarnessTreeNavigateInput = {
  targetId: string
  /** 读取树时得到的 revision；不一致时返回 conflict，不按旧落点修改。 */
  expectedRevision: string
  /** 是否生成分支摘要（可能调用真实模型并计费）。 */
  summarize?: boolean
  /** 追加给摘要器的自定义指令。 */
  customInstructions?: string
  /** true 时自定义指令替换默认提示，而不是追加。 */
  replaceInstructions?: boolean
  /**
   * 运行中导航必须显式置 true（GUI 文案「停止并跳转」）。
   * 宿主先按停止语义使预检失效、取回整体队列并排空运行，再执行导航。
   */
  stopRunning?: boolean
}

/** 被取回的队列内容（只返回给发起导航的窗口）。 */
export type HarnessTreeQueueRecovery = {
  steering: string[]
  followUp: string[]
}

/** 导航结果状态。 */
export type HarnessTreeNavigateStatus =
  | 'applied'
  | 'cancelled'
  | 'aborted'
  | 'conflict'
  | 'busy'
  | 'persistence-failed'
  | 'failed'

/** 导航结果；`editorText` 只交给发起窗口，不进入广播快照。 */
export type HarnessTreeNavigateResult = {
  status: HarnessTreeNavigateStatus
  /** 最终活动落点（失败时也尽量返回权威值）。 */
  leafId?: string | null
  /** 最终结构 revision，供发起窗口刷新树。 */
  treeRevision?: string
  /** 用户/custom_message 节点的原文；仅发起窗口使用。 */
  editorText?: string
  /** 运行中被停止时取回的队列；失败也不得静默丢失。 */
  recoveredQueue?: HarnessTreeQueueRecovery
  /** 最终权威快照（发起窗口直接应用，其他窗口由事件广播获得）。 */
  snapshot?: HarnessThreadSnapshot
  /** 落点 sidecar 的保存结果。 */
  persistence?: 'saved' | 'failed' | 'skipped'
  /** 是否已把活动落点/上下文恢复到可恢复状态（持久化失败边界）。 */
  recovered?: boolean
  /** 摘要条目是否已真实追加到 Pi 文件（不可逆，不伪装跨文件事务）。 */
  summaryCommitted?: boolean
  /** 可读说明（失败原因、不可逆摘要提示）。 */
  message?: string
}

/** 标签设置输入；空字符串或缺失表示清除标签。 */
export type HarnessTreeLabelInput = {
  entryId: string
  label?: string
  expectedRevision?: string
}

/** 标签设置结果。 */
export type HarnessTreeLabelResult = {
  status: 'applied' | 'conflict' | 'busy' | 'failed'
  /** 设置后的标签；清除时为缺失。 */
  label?: string
  treeRevision?: string
  snapshot?: HarnessThreadSnapshot
  /** 落点水位刷新结果；标签本身已写入 Pi 文件时如实反映 sidecar 状态。 */
  persistence?: 'saved' | 'failed' | 'skipped'
  message?: string
}

/** 取消摘要导航的结果。 */
export type HarnessTreeCancelResult = {
  status: 'cancelled' | 'idle'
}
