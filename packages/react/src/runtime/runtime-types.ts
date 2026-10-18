import type {
  ExternalStoreAdapter,
  ExternalStoreSharedOptions,
  ThreadMessageLike,
} from '@assistant-ui/react'
import type {
  HarnessClient,
  HarnessContextUsage,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessRuntimeReadiness,
  HarnessThinkingLevel,
  HarnessThreadMetadata,
  HarnessThreadStatus,
} from '@huan/protocol'
import type { HarnessInterruptAnswer } from './host-ui.js'
import type { HarnessThreadControllerLike } from './thread-controller.js'
import type { HarnessThreadState } from './thread-state.js'

export type HarnessRuntimeOptions = ExternalStoreSharedOptions & {
  /** 传输无关的 Harness 客户端（HTTP/SSE、RPC、IPC）。 */
  client: HarnessClient
  /** 会话列表的工作区范围。 */
  workspacePath?: string
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

export interface HarnessRuntimeExtras {
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
  retry: HarnessThreadState['retry']
  lastError: string | undefined
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
  setModel: (input: { provider: string; modelId: string }) => Promise<void>
  setThinkingLevel: (level: HarnessThinkingLevel) => Promise<void>
  respondToHostUiRequest: (response: HarnessHostUiResponse) => Promise<void>
  respondToToolApproval: (id: string, approved: boolean) => Promise<void>
  resumeToolCall: (toolCallId: string, payload: HarnessInterruptAnswer) => Promise<void>
}

export type HarnessRuntimeExtrasInternal = HarnessRuntimeExtras & {
  controller: HarnessThreadControllerLike
}
