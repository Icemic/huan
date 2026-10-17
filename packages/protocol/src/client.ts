/**
 * 宿主客户端契约（传输无关）。
 *
 * 浏览器端（迭代④自研 Controller）、HTTP/SSE 客户端或进程内直连都实现此接口。
 * 语义约定见迭代③设计 §3.3 行为契约：
 * - sendMessage 返回 = 输入已被接受（started/queued/handled），不等待运行结束；
 * - subscribe 先交付快照（与实时事件同一序号边界）再接后续事件；
 * - cancelRun 是「停止」语义：中止当前运行、丢弃未送达的排队输入，
 *   并覆盖 prompt 预检窗口（预检期取消不会发出模型请求）；
 *   取消不算失败（不置 lastError、不广播 error 事件）。
 */
import type {
  HarnessClientEvent,
  HarnessCreateThreadInput,
  HarnessHostUiResponse,
  HarnessModelInfo,
  HarnessSendMessageInput,
  HarnessThinkingLevel,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from './thread.js'

/** 宿主客户端（RPC 形态，JSON-safe）。 */
export interface HarnessClient {
  listThreads(input?: {
    workspacePath?: string
    includeArchived?: boolean
  }): Promise<HarnessThreadMetadata[]>
  createThread(input?: HarnessCreateThreadInput): Promise<HarnessThreadSnapshot>
  getThread(threadId: string): Promise<HarnessThreadSnapshot>
  sendMessage(threadId: string, input: HarnessSendMessageInput): Promise<void>
  /**
   * 停止：中止当前运行、丢弃未送达的排队输入，覆盖 prompt 预检窗口。
   * 取消不产生失败状态（不置 lastError、不广播 error）；已产出内容保留。
   */
  cancelRun(threadId: string): Promise<void>
  /**
   * 清空 Pi 服务端队列（steering + follow-up）并返回文本，便于 UI 恢复到输入框。
   * Pi 不提供逐项删除或提升，整体清空是唯一的队列修改操作。
   */
  clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }>
  getAvailableModels(input?: { workspacePath?: string }): Promise<HarnessModelInfo[]>
  setModel(threadId: string, input: { provider: string; modelId: string }): Promise<void>
  setThinkingLevel(threadId: string, level: HarnessThinkingLevel): Promise<void>
  renameThread(threadId: string, title: string): Promise<void>
  archiveThread(threadId: string): Promise<void>
  unarchiveThread(threadId: string): Promise<void>
  /** 完成时该线程已不存在（包括原本就不存在的情况）。 */
  deleteThread(threadId: string): Promise<void>
  /** 应答阻断式扩展 UI 请求（审批/权限界面）。 */
  respondToHostUiRequest(threadId: string, response: HarnessHostUiResponse): Promise<void>
  /**
   * 订阅线程事件；默认先交付快照。已自行加载过 getThread 的调用方可传
   * includeSnapshot: false 跳过首帧；重连（含 SSE 断开后恢复）仍会收到快照。
   */
  subscribe(
    threadId: string,
    listener: (event: HarnessClientEvent) => void,
    options?: { includeSnapshot?: boolean },
  ): () => void
}
