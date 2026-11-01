import type {
  ExternalStoreAdapter,
  ExternalStoreSharedOptions,
  ThreadMessageLike,
} from '@assistant-ui/react'
import type {
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashRun,
  HarnessBashStartResult,
  HarnessClient,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessContextUsage,
  HarnessCreateThreadInput,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessModelRefreshResult,
  HarnessModelScope,
  HarnessModelScopeUpdateInput,
  HarnessModelScopeUpdateResult,
  HarnessRuntimeReadiness,
  HarnessThinkingLevel,
  HarnessThreadMetadata,
  HarnessThreadStatus,
  HarnessThreadTree,
  HarnessTreeCancelResult,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
} from '@huan/protocol'
import type { HarnessInterruptAnswer } from './host-ui.js'
import type { HarnessThreadControllerLike } from './thread-controller.js'
import type { HarnessThreadState } from './thread-state.js'

export type HarnessRuntimeOptions = ExternalStoreSharedOptions & {
  /** 传输无关的 Harness 客户端（HTTP/SSE、RPC、IPC）。 */
  client: HarnessClient
  /** 会话列表的工作区过滤；省略时列出整个存储作用域。 */
  workspaceId?: string
  /** 只列出未归属会话（与 workspaceId 互斥，优先由调用方保证）。 */
  unassigned?: boolean
  /** 新建会话输入（工作区与起始项目）；在真正创建时求值。 */
  createThreadInput?: () => HarnessCreateThreadInput
  /** 是否列出已归档会话。 */
  includeArchived?: boolean
  /** 首次打开的会话 ID（Harness 会话 ID）。 */
  initialThreadId?: string
  /** 当前展示的会话 ID。 */
  threadId?: string
  /** 当前会话的已确认远端 ID 变化时通知；仍处乐观态时为 `undefined`。 */
  onThreadIdChange?: ((threadId: string | undefined) => void) | undefined
  /** 错误回调（用户提供的回调抛错会被隔离并记录）。 */
  onError?: (error: unknown) => void
  /** assistant-ui 的附件等适配器。 */
  adapters?: ExternalStoreAdapter<ThreadMessageLike>['adapters']
}

/**
 * 与单个 Controller 生命周期绑定的动作集合。
 *
 * 这些动作只转发到 Controller，不读取当前线程状态；因此可以在 Controller
 * 不变时保持引用稳定，让只需动作的消费方不必随消息/流式状态重渲染。
 */
export interface HarnessRuntimeActions {
  /**
   * 维持长期事件订阅（多窗口场景下空闲会话也需实时更新）。
   * 每次调用递增保留计数，返回的函数释放它；计数归零后由 Controller
   * 在宽限期内断开连接。
   */
  connect: () => () => void
  cancel: () => Promise<void>
  refresh: () => Promise<void>
  /**
   * 清空 Pi 服务端队列（steering + follow-up）并返回文本，便于 UI 恢复到输入框。
   */
  clearQueue: () => Promise<{ steering: string[]; followUp: string[] }>
  /** 按需读取会话树。 */
  getThreadTree: () => Promise<HarnessThreadTree>
  /** 导航会话树；运行中需显式 stopRunning。 */
  navigateThreadTree: (input: HarnessTreeNavigateInput) => Promise<HarnessTreeNavigateResult>
  /** 设置/清除节点标签。 */
  setThreadEntryLabel: (input: HarnessTreeLabelInput) => Promise<HarnessTreeLabelResult>
  /** 取消进行中的分支摘要导航。 */
  cancelThreadTreeNavigation: () => Promise<HarnessTreeCancelResult>
  setModel: (input: { provider: string; modelId: string }) => Promise<void>
  setThinkingLevel: (level: HarnessThinkingLevel) => Promise<void>
  /** 直接执行用户 Shell；`excludeFromContext` 对应 `!!`。 */
  runBash: (input: {
    command: string
    excludeFromContext?: boolean
  }) => Promise<HarnessBashStartResult>
  abortBash: () => Promise<HarnessBashAbortResult>
  compact: (input?: { customInstructions?: string }) => Promise<HarnessCompactionOutcome>
  abortCompaction: () => Promise<HarnessCompactionAbortResult>
  setAutoCompaction: (enabled: boolean) => Promise<HarnessAutoCompactionUpdateResult>
  getModelScope: () => Promise<HarnessModelScope>
  setModelScope: (input: HarnessModelScopeUpdateInput) => Promise<HarnessModelScopeUpdateResult>
  refreshModels: (input?: { workspacePath?: string }) => Promise<HarnessModelRefreshResult>
  respondToHostUiRequest: (response: HarnessHostUiResponse) => Promise<void>
  /** 消费会话级 Host UI 指令（编辑器文本/命令目标）；成功后从快照移除。 */
  consumeHostUiDirective: (directiveId: string) => Promise<boolean>
  respondToToolApproval: (id: string, approved: boolean) => Promise<void>
  resumeToolCall: (toolCallId: string, payload: HarnessInterruptAnswer) => Promise<void>
}

export interface HarnessRuntimeExtras extends HarnessRuntimeActions {
  state: HarnessThreadState
  metadata: HarnessThreadMetadata
  status: HarnessThreadStatus
  readiness: HarnessRuntimeReadiness | undefined
  contextUsage: HarnessContextUsage | undefined
  /**
   * 待处理的游离（side-channel）Host UI 请求——不挂在工具调用上的那些。
   * 工具关联的请求改为渲染为工具调用的 approval。
   */
  hostUiRequests: readonly HarnessHostUiRequest[]
  /** 全部待处理的 Host UI 请求，含工具关联的。 */
  allHostUiRequests: readonly HarnessHostUiRequest[]
  queue: HarnessThreadState['queue']
  compaction: HarnessThreadState['compaction']
  /** 用户 Shell（`!` / `!!`）的实时/刚完成状态。 */
  bash: HarnessBashRun | undefined
  retry: HarnessThreadState['retry']
  lastError: string | undefined
  /**
   * 与当前 Controller 绑定的稳定动作集合。
   * 只需动作的消费方应使用 `useHarnessActions()`，避免随完整 extras 更新。
   */
  actions: HarnessRuntimeActions
}

export type HarnessRuntimeExtrasInternal = HarnessRuntimeExtras & {
  controller: HarnessThreadControllerLike
}
