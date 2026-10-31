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

import type { HarnessThreadForkInput, HarnessThreadForkResult } from './fork.js'
import type { HarnessHostInfo } from './host.js'
import type {
  HarnessThreadImportInput,
  HarnessThreadImportPreview,
  HarnessThreadImportPreviewInput,
  HarnessThreadImportResult,
} from './import.js'
import type {
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectTrustInput,
  HarnessRecentProject,
} from './project.js'
import type {
  HarnessClientEvent,
  HarnessCreateThreadInput,
  HarnessHostUiResponse,
  HarnessModelInfo,
  HarnessSendMessageInput,
  HarnessThinkingLevel,
  HarnessThreadDetails,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from './thread.js'
import type {
  HarnessThreadTree,
  HarnessTreeCancelResult,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
} from './tree.js'
import type {
  HarnessAssignThreadInput,
  HarnessAssignThreadResult,
  HarnessCreateWorkspaceInput,
  HarnessUpdateWorkspaceInput,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceMutationResult,
} from './workspace.js'

/** 宿主客户端（RPC 形态，JSON-safe）。 */
export interface HarnessClient {
  getHostInfo(): Promise<HarnessHostInfo>
  /** 列出工作区定义与元数据健康状态；不执行项目扩展。 */
  listWorkspaces(): Promise<HarnessWorkspaceCatalog>
  createWorkspace(input: HarnessCreateWorkspaceInput): Promise<HarnessWorkspaceMutationResult>
  updateWorkspace(input: HarnessUpdateWorkspaceInput): Promise<HarnessWorkspaceMutationResult>
  /** 把无归属会话明确加入工作区（不按 cwd 猜测）。 */
  assignThreadWorkspace(input: HarnessAssignThreadInput): Promise<HarnessAssignThreadResult>
  /**
   * 列出当前存储作用域内的会话；按 workspaceId 过滤归属，`unassigned`
   * 列出未归属会话，两者都不传时返回全部。
   *
   * `refresh` 为显式重扫：清空并重新扫描作用域目录（外部 Pi 改动可见）；
   * 缺省时沿用宿主缓存与已有失效机制。
   */
  listThreads(input?: {
    workspaceId?: string
    unassigned?: boolean
    includeArchived?: boolean
    refresh?: boolean
  }): Promise<HarnessThreadMetadata[]>
  createThread(input?: HarnessCreateThreadInput): Promise<HarnessThreadSnapshot>
  getThread(threadId: string): Promise<HarnessThreadSnapshot>
  /**
   * 只读详情：元数据、全文件累计统计与当前活动分支上下文。
   * 冷会话不装配项目扩展、不发起网络请求；热会话直接使用 SDK 统计。
   */
  getThreadDetails(threadId: string): Promise<HarnessThreadDetails>
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
  /**
   * 校验宿主路径（存在且为目录）。只做文件系统检查，不执行项目代码。
   */
  checkProjectPath(path: string): Promise<HarnessProjectPathCheck>
  /**
   * 查询项目信任与装配状态。未回答时返回 needs-trust，不执行需要信任的项目资源。
   */
  getProject(input: { path: string }): Promise<HarnessProjectInfo>
  /**
   * 只读信任摘要：不加载项目扩展/资源，供工作区成员管理展示。
   * 用户级 project_trust 扩展的即时决定仍以 getProject/实际装配为准。
   */
  inspectProjectTrust(input: { path: string }): Promise<HarnessProjectInfo>
  /** 保存本次信任决定（可选写入 trust.json）并立即按结论装配。 */
  decideProjectTrust(input: HarnessProjectTrustInput): Promise<HarnessProjectInfo>
  /** 同一用户空间内的最近项目（按会话活动时间排序）。 */
  listRecentProjects(): Promise<HarnessRecentProject[]>
  getAvailableModels(input?: { workspacePath?: string }): Promise<HarnessModelInfo[]>
  setModel(threadId: string, input: { provider: string; modelId: string }): Promise<void>
  setThinkingLevel(threadId: string, level: HarnessThinkingLevel): Promise<void>
  renameThread(threadId: string, title: string): Promise<void>
  /**
   * 按需读取会话树（真实 entryId、活动路径、标签与结构 revision）。
   * 冷会话只读 JSONL 与 sidecar，不装配项目扩展、不联网。
   */
  getThreadTree(threadId: string): Promise<HarnessThreadTree>
  /**
   * 导航到树节点。校验 expectedRevision；运行中要求显式 stopRunning，
   * 先停止并取回队列。`editorText` 只返回给调用方窗口。
   */
  navigateThreadTree(
    threadId: string,
    input: HarnessTreeNavigateInput,
  ): Promise<HarnessTreeNavigateResult>
  /** 设置/清除节点标签（写入 Pi label entry，不改变活动落点）。 */
  setThreadEntryLabel(
    threadId: string,
    input: HarnessTreeLabelInput,
  ): Promise<HarnessTreeLabelResult>
  /** 取消进行中的分支摘要导航；其他结构操作不在此中止。 */
  cancelThreadTreeNavigation(threadId: string): Promise<HarnessTreeCancelResult>
  /**
   * 独立 fork/clone：使用公开 `session_before_fork` 与独立 SessionManager，
   * 创建子 ID/文件/血缘；父会话保留。扩展取消不创建文件或元数据。
   */
  forkThread(threadId: string, input: HarnessThreadForkInput): Promise<HarnessThreadForkResult>
  /** 预览 JSONL 导入：只解析/校验/检查目录与冲突，不装配项目代码。 */
  previewThreadImport(input: HarnessThreadImportPreviewInput): Promise<HarnessThreadImportPreview>
  /** 确认导入：重新读取并校验源，写入目标作用域后才保存归属。 */
  importThread(input: HarnessThreadImportInput): Promise<HarnessThreadImportResult>
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
