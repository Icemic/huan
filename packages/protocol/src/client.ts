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
  HarnessProviderAuthCancelResult,
  HarnessProviderAuthMethod,
  HarnessProviderAuthRespondResult,
  HarnessProviderAuthSnapshot,
  HarnessProviderAuthStartResult,
  HarnessProviderAuthStreamEvent,
} from './auth.js'
import type {
  HarnessCommandArgumentCompletion,
  HarnessCommandArgumentInput,
  HarnessCommandCatalog,
  HarnessFileSearchInput,
  HarnessFileSearchResult,
} from './commands.js'
import type { HarnessThreadForkInput, HarnessThreadForkResult } from './fork.js'
import type { HarnessHostInfo } from './host.js'
import type {
  HarnessThreadImportInput,
  HarnessThreadImportPreview,
  HarnessThreadImportPreviewInput,
  HarnessThreadImportResult,
} from './import.js'
import type {
  HarnessHostInteractionAnswer,
  HarnessHostInteractionEvent,
  HarnessHostInteractionResponse,
  HarnessHostInteractionSnapshot,
} from './interaction.js'
import type {
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectTrustInput,
  HarnessRecentProject,
} from './project.js'
import type { HarnessReloadResult, HarnessReloadTargetInput } from './reload.js'
import type {
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashStartResult,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessModelRefreshInput,
  HarnessModelRefreshResult,
  HarnessModelScope,
  HarnessModelScopeUpdateInput,
  HarnessModelScopeUpdateResult,
} from './runtime.js'
import type {
  HarnessResourceQueryInput,
  HarnessResourceSnapshot,
  HarnessSettingsSaveInput,
  HarnessSettingsSaveResult,
  HarnessSettingsSnapshot,
  HarnessSettingsTargetInput,
} from './settings.js'
import type {
  HarnessClientEvent,
  HarnessCreateThreadInput,
  HarnessHostUiResponse,
  HarnessModelInfo,
  HarnessSendMessageInput,
  HarnessSendMessageOptions,
  HarnessSendMessageResult,
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
  /** 宿主级交互快照：启动装配期也可查询，不依赖选中会话。 */
  getHostInteractions(): Promise<HarnessHostInteractionSnapshot>
  /** 订阅宿主级交互；首帧为权威快照，断线重连同样以快照恢复。 */
  subscribeHostInteractions(listener: (event: HarnessHostInteractionEvent) => void): () => void
  /**
   * 认证权威快照：provider 可登录方法、凭据类型与进行中的操作。
   * 不包含凭据原文、auth.json 内容或 provider 原始错误。
   */
  getProviderAuth(): Promise<HarnessProviderAuthSnapshot>
  /** 订阅认证快照（传输层可轮询）；首帧即权威快照，多窗口共享同一 broker。 */
  subscribeProviderAuth(listener: (event: HarnessProviderAuthStreamEvent) => void): () => void
  /** 启动登录；返回 started 后流程在后台继续，进度经订阅恢复。 */
  startProviderLogin(input: {
    providerId: string
    method: HarnessProviderAuthMethod
  }): Promise<HarnessProviderAuthStartResult>
  /** 回填当前提示；值只进入宿主内存 resolver，不出现在任何响应/快照中。 */
  respondProviderAuthPrompt(input: {
    operationId: string
    promptId: string
    value: string
  }): Promise<HarnessProviderAuthRespondResult>
  /** 请求取消登录/退出；与持久化提交点竞态以操作终态为准。 */
  cancelProviderAuth(operationId: string): Promise<HarnessProviderAuthCancelResult>
  /** 移除已存凭据；同 provider 的登录/退出互斥。 */
  logoutProvider(providerId: string): Promise<HarnessProviderAuthStartResult>
  /** 应答宿主级请求；已结算/未知 ID 返回 accepted=false（幂等）。 */
  respondToHostInteraction(
    response: HarnessHostInteractionResponse,
  ): Promise<HarnessHostInteractionAnswer>
  /** 消费会话级 Host UI 指令（编辑器文本/命令目标）；成功后从快照移除。 */
  consumeHostUiDirective(
    threadId: string,
    directiveId: string,
    options?: { callerId?: string },
  ): Promise<boolean>
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
  createThread(
    input?: HarnessCreateThreadInput,
    options?: { callerId?: string },
  ): Promise<HarnessThreadSnapshot>
  getThread(threadId: string): Promise<HarnessThreadSnapshot>
  /**
   * 只读详情：元数据、全文件累计统计与当前活动分支上下文。
   * 冷会话不装配项目扩展、不发起网络请求；热会话直接使用 SDK 统计。
   */
  getThreadDetails(threadId: string): Promise<HarnessThreadDetails>
  /**
   * 公开 SDK 资源命令目录（扩展/模板/skill）；内置命令由应用合并。
   * 会话或空白页固定起始目录二选一，不隐式使用窗口工作区。
   */
  listCommands(input?: {
    threadId?: string
    workspacePath?: string
  }): Promise<HarnessCommandCatalog>
  /**
   * 读取用户/项目 settings.json 原文、revision、校验问题与磁盘合并预览。
   * 会话或空白页固定起始目录二选一；项目未信任时不读取其原文。
   */
  getSettings(input: HarnessSettingsTargetInput): Promise<HarnessSettingsSnapshot>
  /**
   * 保存完整设置文件原文（乐观 revision）；只写指定文件，不改变 live 会话。
   * 保存成功后返回磁盘合并预览与“需重载/重启”说明。
   */
  saveSettings(input: HarnessSettingsSaveInput): Promise<HarnessSettingsSaveResult>
  /**
   * 读取实际加载的指令/system prompt/扩展/skill/模板/主题/packages 与诊断。
   * 热会话使用正在服务的 loader；不重跑扩展、不联网重扫。
   */
  getResources(input: HarnessResourceQueryInput): Promise<HarnessResourceSnapshot>
  /**
   * 资源重载：同一会话调用公开 AgentSession.reload（消息/分支/订阅不替换），
   * 刷新设置、指令、扩展与命令目录；空白页目标只刷新该 cwd 的待消费装配。
   * 与会话运行、发送、Shell 与结构操作互斥；失败如实报告，不虚报完成。
   */
  reloadResources(input: HarnessReloadTargetInput): Promise<HarnessReloadResult>
  /** 按需调用扩展的参数补全；不适用时返回空数组。 */
  getCommandArgumentCompletions(
    input: HarnessCommandArgumentInput,
    options?: { signal?: AbortSignal },
  ): Promise<readonly HarnessCommandArgumentCompletion[]>
  /**
   * 查询当前会话/选中工作区成员内的文件引用；只返回路径与类型，
   * 不读取文件内容，不扫描个人空间。
   */
  searchFiles(
    input: HarnessFileSearchInput,
    options?: { signal?: AbortSignal },
  ): Promise<HarnessFileSearchResult>
  sendMessage(
    threadId: string,
    input: HarnessSendMessageInput,
    options?: HarnessSendMessageOptions,
  ): Promise<HarnessSendMessageResult>
  /**
   * 直接执行用户 Shell（`!` 纳入上下文，`!!` 排除）。
   * 返回 started 即已登记并开始执行；输出/完成经 bash_* 事件与快照同步。
   * 同一会话同时至多一条用户 Shell；结构操作进行中返回 busy。
   */
  runThreadBash(
    threadId: string,
    input: { command: string; excludeFromContext?: boolean },
  ): Promise<HarnessBashStartResult>
  /** 取消当前用户 Shell；不中止模型运行。 */
  abortThreadBash(threadId: string): Promise<HarnessBashAbortResult>
  /** 手动压缩上下文（可附指令）；失败保留原始消息树。 */
  compactThread(
    threadId: string,
    input?: { customInstructions?: string },
  ): Promise<HarnessCompactionOutcome>
  /** 取消进行中的压缩（手动或自动）。 */
  abortThreadCompaction(threadId: string): Promise<HarnessCompactionAbortResult>
  /**
   * 保存自动压缩开关到当前 agentDir 的用户设置（全局），
   * 并同步所有已打开会话的有效状态。写盘失败时回滚内存并如实返回 failed。
   */
  setAutoCompaction(threadId: string, enabled: boolean): Promise<HarnessAutoCompactionUpdateResult>
  /** 读取会话模型范围（会话级）与已保存的用户默认。 */
  getThreadModelScope(threadId: string): Promise<HarnessModelScope>
  /** 更新会话模型范围；saveAsDefault 才写入用户设置。 */
  setThreadModelScope(
    threadId: string,
    input: HarnessModelScopeUpdateInput,
  ): Promise<HarnessModelScopeUpdateResult>
  /**
   * 显式刷新模型目录（可以不重建 live session 或发起模型请求）。
   * 必须显式指定会话或固定起始目录，不接受隐式窗口工作区。
   */
  refreshModels(input: HarnessModelRefreshInput): Promise<HarnessModelRefreshResult>
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
