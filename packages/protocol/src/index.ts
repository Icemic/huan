/**
 * @huan/protocol：宿主 ↔ UI 的可序列化契约。
 *
 * 纯 TS 类型与常量；无运行时依赖、不依赖 Pi SDK 与 Node（浏览器安全）。
 *
 * - messages.ts：Pi 消息/内容/会话记录形状的 JSON-safe 镜像
 * - thread.ts：会话元数据、快照、事件、Host UI、模型与就绪度
 * - commands.ts：命令目录、参数补全与文件引用
 * - client.ts：宿主客户端接口（传输无关）
 * - queue.ts：输入队列条目 ID 方案
 *
 * 兼容性策略：形状结构与 Pi/react-pi 契约保持一致（迭代③期间浏览器侧仍消费
 * react-pi 客户端）；演进权归本包，破坏性变更递增版本号。
 */

/**
 * 协议版本号。
 *
 * 宿主与 UI 之间的所有可序列化契约都随此版本演进；破坏性形状变更时递增，
 * 增量可选字段不递增（消费方对未知字段宽容）。
 */
export const HARNESS_PROTOCOL_VERSION = 13 as const

export type HarnessProtocolVersion = typeof HARNESS_PROTOCOL_VERSION

export type {
  HarnessProviderAuthCancelResult,
  HarnessProviderAuthEvent,
  HarnessProviderAuthFailureCode,
  HarnessProviderAuthMethod,
  HarnessProviderAuthMethodInfo,
  HarnessProviderAuthOperation,
  HarnessProviderAuthOperationKind,
  HarnessProviderAuthPhase,
  HarnessProviderAuthPrompt,
  HarnessProviderAuthProvider,
  HarnessProviderAuthRespondResult,
  HarnessProviderAuthResult,
  HarnessProviderAuthSnapshot,
  HarnessProviderAuthSource,
  HarnessProviderAuthStartResult,
  HarnessProviderAuthStreamEvent,
} from './auth.js'
export type { HarnessClient } from './client.js'
export type {
  HarnessBuiltinCommand,
  HarnessBuiltinCommandStage,
  HarnessCommandArgumentCompletion,
  HarnessCommandArgumentInput,
  HarnessCommandCatalog,
  HarnessCommandSource,
  HarnessCommandSourceInfo,
  HarnessFileReference,
  HarnessFileSearchInput,
  HarnessFileSearchResult,
  HarnessResourceCommand,
} from './commands.js'
export {
  builtinCommandNameOf,
  HARNESS_BUILTIN_COMMANDS,
  isBuiltinCommandName,
  parseLeadingSlashCommand,
} from './commands.js'
export type {
  HarnessThreadForkInput,
  HarnessThreadForkPosition,
  HarnessThreadForkResult,
  HarnessThreadForkStatus,
} from './fork.js'
export type { HarnessConfigSource, HarnessHostInfo } from './host.js'
export type {
  HarnessThreadImportConflict,
  HarnessThreadImportErrorCode,
  HarnessThreadImportInput,
  HarnessThreadImportPreview,
  HarnessThreadImportPreviewInput,
  HarnessThreadImportResult,
  HarnessThreadImportSource,
  HarnessThreadImportSourceInfo,
  HarnessThreadImportStatus,
} from './import.js'
export type {
  HarnessHostInteractionAnswer,
  HarnessHostInteractionEvent,
  HarnessHostInteractionNotification,
  HarnessHostInteractionRequest,
  HarnessHostInteractionResponse,
  HarnessHostInteractionScope,
  HarnessHostInteractionSnapshot,
} from './interaction.js'
export { hostInteractionScopeKey } from './interaction.js'
export type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessAssistantContent,
  HarnessAssistantMessage,
  HarnessAssistantMessageDelta,
  HarnessBashExecutionMessage,
  HarnessBranchSummaryMessage,
  HarnessCompactionSummaryMessage,
  HarnessCustomMessage,
  HarnessImageContent,
  HarnessKnownAgentMessage,
  HarnessSessionEntry,
  HarnessStopReason,
  HarnessTextContent,
  HarnessThinkingContent,
  HarnessToolCall,
  HarnessToolResultContent,
  HarnessToolResultMessage,
  HarnessUnknownAgentMessage,
  HarnessUnknownSessionEntry,
  HarnessUsage,
  HarnessUserContent,
  HarnessUserMessage,
} from './messages.js'
export type {
  HarnessProjectDefaultPolicy,
  HarnessProjectFailureCode,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectStatus,
  HarnessProjectTrust,
  HarnessProjectTrustDecision,
  HarnessProjectTrustInput,
  HarnessProjectTrustOrigin,
  HarnessRecentProject,
} from './project.js'
export type { HarnessQueueMode } from './queue.js'
export { harnessQueueItemId, isHarnessSteerQueueItemId } from './queue.js'
export type {
  HarnessReloadFailureReason,
  HarnessReloadResult,
  HarnessReloadTargetInput,
} from './reload.js'
export type {
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashResult,
  HarnessBashRun,
  HarnessBashStartResult,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessCompactionPhase,
  HarnessCompactionReason,
  HarnessModelRefreshInput,
  HarnessModelRefreshResult,
  HarnessModelScope,
  HarnessModelScopeDiagnostic,
  HarnessModelScopeModel,
  HarnessModelScopeUpdateInput,
  HarnessModelScopeUpdateResult,
} from './runtime.js'
export type {
  HarnessResourceExtension,
  HarnessResourceInstruction,
  HarnessResourceLoadedRef,
  HarnessResourcePackage,
  HarnessResourcePrompt,
  HarnessResourceQueryInput,
  HarnessResourceSkill,
  HarnessResourceSnapshot,
  HarnessResourceSourceInfo,
  HarnessResourceSystemPrompt,
  HarnessResourceTheme,
  HarnessSettingsApplyState,
  HarnessSettingsEffective,
  HarnessSettingsFile,
  HarnessSettingsIssue,
  HarnessSettingsIssueKind,
  HarnessSettingsOrigin,
  HarnessSettingsSaveInput,
  HarnessSettingsSaveResult,
  HarnessSettingsScope,
  HarnessSettingsSnapshot,
  HarnessSettingsTarget,
  HarnessSettingsTargetInput,
} from './settings.js'
export type {
  HarnessAnyClientEvent,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessClientEventEnvelope,
  HarnessContextUsage,
  HarnessCreateThreadInput,
  HarnessHostUiCommandTarget,
  HarnessHostUiEditorDirective,
  HarnessHostUiNotification,
  HarnessHostUiRequest,
  HarnessHostUiRequestKind,
  HarnessHostUiResponse,
  HarnessHostUiStatus,
  HarnessHostUiWidget,
  HarnessHostUiWidgetPlacement,
  HarnessInputAttachment,
  HarnessModelInfo,
  HarnessModelInput,
  HarnessQueuedMessage,
  HarnessReloadOperation,
  HarnessReloadStatus,
  HarnessReloadTrigger,
  HarnessRuntimeReadiness,
  HarnessSendMessageDisposition,
  HarnessSendMessageInput,
  HarnessSendMessageOptions,
  HarnessSendMessageResult,
  HarnessThinkingLevel,
  HarnessThreadDetails,
  HarnessThreadHostUi,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadStats,
  HarnessThreadStatus,
  HarnessUnknownClientEventBody,
} from './thread.js'
export type {
  HarnessThreadTree,
  HarnessThreadTreeNode,
  HarnessThreadTreeOperation,
  HarnessTreeCancelResult,
  HarnessTreeEntryKind,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
  HarnessTreeNavigateStatus,
  HarnessTreeQueueRecovery,
} from './tree.js'
export type {
  HarnessAssignThreadInput,
  HarnessAssignThreadResult,
  HarnessCreateWorkspaceInput,
  HarnessUpdateWorkspaceInput,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceMutationError,
  HarnessWorkspaceMutationResult,
  HarnessWorkspaceProject,
  HarnessWorkspaceProjectInput,
  HarnessWorkspaceState,
} from './workspace.js'
