/**
 * 客户端事件与快照载荷的运行时校验（形状守卫）。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的
 * `src/client/validation.ts`（MIT 许可）。改动：类型改用
 * `@huan/protocol`，命名 `Pi*` → `Harness*`，上游内部工具改从
 * `../vendor/anti-corruption.js` 引入，注释译为中文。
 * 逻辑与上游逐行等价。
 *
 * 用途：SSE / HTTP 收到的载荷形状不可信，落进 reducer 之前先做守卫，
 * 使畸形载荷被丢弃而不是污染状态。
 */

import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessAssistantMessageDelta,
  HarnessHostInteractionSnapshot,
  HarnessHostUiRequest,
  HarnessReloadOperation,
  HarnessReloadResult,
  HarnessResourceSnapshot,
  HarnessSettingsSaveResult,
  HarnessSettingsSnapshot,
  HarnessThreadDetails,
  HarnessThreadForkResult,
  HarnessThreadImportPreview,
  HarnessThreadImportResult,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessThreadTreeOperation,
  HarnessTreeCancelResult,
  HarnessTreeLabelResult,
  HarnessTreeNavigateResult,
} from '@huan/protocol'
import { isRecord } from '../vendor/anti-corruption.js'

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean'

const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || typeof value === 'number'

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isUserContentPart = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'image') {
    return typeof value.data === 'string' && typeof value.mimeType === 'string'
  }
  return true
}

const isUserContent = (value: unknown): boolean =>
  typeof value === 'string' || (Array.isArray(value) && value.every(isUserContentPart))

const isToolCall = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === 'toolCall' &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  (value.arguments == null || isRecord(value.arguments)) &&
  isOptionalString(value.thoughtSignature)

const isAssistantContentPart = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') {
    return typeof value.text === 'string' && isOptionalString(value.textSignature)
  }
  if (value.type === 'thinking') {
    return (
      typeof value.thinking === 'string' &&
      isOptionalString(value.thinkingSignature) &&
      isOptionalBoolean(value.redacted)
    )
  }
  if (value.type === 'toolCall') return isToolCall(value)
  return true
}

const isUsage = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.input === 'number' &&
  typeof value.output === 'number' &&
  typeof value.cacheRead === 'number' &&
  typeof value.cacheWrite === 'number' &&
  typeof value.totalTokens === 'number' &&
  isRecord(value.cost) &&
  typeof value.cost.input === 'number' &&
  typeof value.cost.output === 'number' &&
  typeof value.cost.cacheRead === 'number' &&
  typeof value.cost.cacheWrite === 'number' &&
  typeof value.cost.total === 'number'

/** 助手消息守卫。 */
export const isAssistantMessage = (value: unknown): value is HarnessAssistantMessage =>
  isRecord(value) &&
  value.role === 'assistant' &&
  Array.isArray(value.content) &&
  value.content.every(isAssistantContentPart) &&
  typeof value.api === 'string' &&
  typeof value.provider === 'string' &&
  typeof value.model === 'string' &&
  isOptionalString(value.responseModel) &&
  isOptionalString(value.responseId) &&
  isUsage(value.usage) &&
  typeof value.stopReason === 'string' &&
  isOptionalString(value.errorMessage) &&
  typeof value.timestamp === 'number'

/** 完整记录消息守卫（快照/整段加载路径）。 */
export const isCompleteTranscriptMessage = (value: unknown): value is HarnessAgentMessage => {
  if (!isRecord(value) || typeof value.role !== 'string') return false

  switch (value.role) {
    case 'user':
      return isUserContent(value.content) && typeof value.timestamp === 'number'
    case 'assistant':
      return isAssistantMessage(value)
    case 'toolResult':
      return (
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        Array.isArray(value.content) &&
        value.content.every(isUserContentPart) &&
        typeof value.isError === 'boolean' &&
        typeof value.timestamp === 'number'
      )
    case 'bashExecution':
      return (
        typeof value.command === 'string' &&
        typeof value.output === 'string' &&
        (value.exitCode === undefined || typeof value.exitCode === 'number') &&
        typeof value.cancelled === 'boolean' &&
        typeof value.truncated === 'boolean' &&
        isOptionalString(value.fullOutputPath) &&
        typeof value.timestamp === 'number' &&
        isOptionalBoolean(value.excludeFromContext)
      )
    case 'custom':
      return (
        typeof value.customType === 'string' &&
        isUserContent(value.content) &&
        typeof value.display === 'boolean' &&
        typeof value.timestamp === 'number'
      )
    case 'branchSummary':
      return (
        typeof value.summary === 'string' &&
        typeof value.fromId === 'string' &&
        typeof value.timestamp === 'number'
      )
    case 'compactionSummary':
      return (
        typeof value.summary === 'string' &&
        typeof value.tokensBefore === 'number' &&
        typeof value.timestamp === 'number'
      )
    default:
      return true
  }
}

/** 助手消息增量（`assistantMessageEvent`）守卫。 */
export const isAssistantMessageDelta = (value: unknown): value is HarnessAssistantMessageDelta => {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  const hasContentIndex =
    Number.isSafeInteger(value.contentIndex) && (value.contentIndex as number) >= 0

  switch (value.type) {
    case 'start':
      return isAssistantMessage(value.partial)
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      return hasContentIndex && isAssistantMessage(value.partial)
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return hasContentIndex && typeof value.delta === 'string' && isAssistantMessage(value.partial)
    case 'text_end':
    case 'thinking_end':
      return (
        hasContentIndex && typeof value.content === 'string' && isAssistantMessage(value.partial)
      )
    case 'toolcall_end':
      return hasContentIndex && isToolCall(value.toolCall) && isAssistantMessage(value.partial)
    case 'done':
      return typeof value.reason === 'string' && isAssistantMessage(value.message)
    case 'error':
      return typeof value.reason === 'string' && isAssistantMessage(value.error)
    default:
      return true
  }
}

/** 上下文用量守卫。 */
export const isContextUsage = (value: unknown): boolean =>
  isRecord(value) &&
  (value.tokens === null || typeof value.tokens === 'number') &&
  typeof value.contextWindow === 'number' &&
  (value.percent === null || typeof value.percent === 'number')

/** Host UI 请求守卫。 */
export const isHostUiRequest = (value: unknown): value is HarnessHostUiRequest => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string' ||
    !isOptionalString(value.toolCallId) ||
    !isOptionalNumber(value.timeoutMs)
  ) {
    return false
  }

  switch (value.kind) {
    case 'confirm':
      return typeof value.title === 'string' && typeof value.message === 'string'
    case 'select':
      return typeof value.title === 'string' && isStringArray(value.options)
    case 'input':
      return typeof value.title === 'string' && isOptionalString(value.placeholder)
    case 'editor':
      return typeof value.title === 'string' && isOptionalString(value.prefill)
    default:
      return true
  }
}

/** 宿主级交互作用域守卫。 */
const isHostInteractionScope = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.kind === 'project') return typeof value.cwd === 'string'
  if (value.kind === 'session') {
    return typeof value.sessionId === 'string' && isOptionalString(value.cwd)
  }
  return false
}

/** 宿主级交互请求守卫（只接受展示与结算所需字段）。 */
const isHostInteractionRequest = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isHostInteractionScope(value.scope) &&
  (value.kind === 'confirm' ||
    value.kind === 'select' ||
    value.kind === 'input' ||
    value.kind === 'editor') &&
  typeof value.title === 'string' &&
  isOptionalString(value.message) &&
  (value.options === undefined || isStringArray(value.options)) &&
  isOptionalString(value.placeholder) &&
  isOptionalString(value.prefill) &&
  isOptionalString(value.toolCallId) &&
  isOptionalNumber(value.timeoutMs) &&
  typeof value.createdAt === 'number'

const isHostInteractionNotification = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isHostInteractionScope(value.scope) &&
  typeof value.message === 'string' &&
  (value.type === 'info' || value.type === 'warning' || value.type === 'error') &&
  typeof value.createdAt === 'number'

/** 宿主级交互快照守卫。 */
export const isHostInteractionSnapshot = (
  value: unknown,
): value is HarnessHostInteractionSnapshot =>
  isRecord(value) &&
  typeof value.seq === 'number' &&
  Array.isArray(value.requests) &&
  value.requests.every(isHostInteractionRequest) &&
  Array.isArray(value.notifications) &&
  value.notifications.every(isHostInteractionNotification)

/** 会话运行期 Host UI 状态守卫（快照可携带；缺失表示无扩展状态）。 */
export const isThreadHostUi = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.statuses) ||
    !value.statuses.every(
      (item) => isRecord(item) && typeof item.key === 'string' && typeof item.text === 'string',
    ) ||
    !Array.isArray(value.widgets) ||
    !value.widgets.every(
      (item) =>
        isRecord(item) &&
        typeof item.key === 'string' &&
        isStringArray(item.lines) &&
        (item.placement === 'aboveEditor' || item.placement === 'belowEditor'),
    ) ||
    !Array.isArray(value.notifications) ||
    !value.notifications.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.message === 'string' &&
        (item.type === 'info' || item.type === 'warning' || item.type === 'error') &&
        typeof item.createdAt === 'number',
    ) ||
    !isOptionalString(value.title) ||
    !isOptionalString(value.workingMessage) ||
    !isOptionalBoolean(value.workingVisible) ||
    !isOptionalString(value.hiddenThinkingLabel)
  ) {
    return false
  }
  if (value.editorDirective !== undefined) {
    const directive = value.editorDirective
    if (
      !isRecord(directive) ||
      typeof directive.id !== 'string' ||
      typeof directive.text !== 'string' ||
      (directive.mode !== 'set' && directive.mode !== 'paste') ||
      !isOptionalString(directive.callerId) ||
      typeof directive.createdAt !== 'number'
    ) {
      return false
    }
  }
  if (value.commandTarget !== undefined) {
    const target = value.commandTarget
    if (
      !isRecord(target) ||
      typeof target.id !== 'string' ||
      (target.action !== 'newSession' &&
        target.action !== 'fork' &&
        target.action !== 'switchSession' &&
        target.action !== 'navigateTree') ||
      typeof target.threadId !== 'string' ||
      !isOptionalString(target.title) ||
      typeof target.message !== 'string' ||
      typeof target.createdAt !== 'number'
    ) {
      return false
    }
  }
  return true
}

const isQueuedMessage = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.mode === 'string' &&
  typeof value.content === 'string'

const isThreadConfig = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    isOptionalString(value.provider) &&
    isOptionalString(value.modelId) &&
    isOptionalString(value.thinkingLevel))

/** Shell 结果摘要守卫。 */
const isBashResult = (value: unknown): boolean =>
  isRecord(value) &&
  isOptionalNumber(value.exitCode) &&
  typeof value.cancelled === 'boolean' &&
  typeof value.truncated === 'boolean' &&
  isOptionalString(value.fullOutputPath) &&
  typeof value.endedAt === 'string' &&
  isOptionalString(value.error)

/** 用户 Shell 运行态守卫（快照与 bash_* 事件共用）。 */
export const isBashRun = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.command === 'string' &&
  typeof value.excludeFromContext === 'boolean' &&
  typeof value.cwd === 'string' &&
  (value.status === 'running' || value.status === 'complete') &&
  typeof value.output === 'string' &&
  typeof value.outputTruncated === 'boolean' &&
  typeof value.startedAt === 'string' &&
  (value.result === undefined || isBashResult(value.result))

/** 压缩运行态守卫。 */
const isCompactionPhase = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.active === 'boolean' &&
  (value.reason === undefined ||
    value.reason === 'manual' ||
    value.reason === 'threshold' ||
    value.reason === 'overflow') &&
  isOptionalString(value.error)

/** 结构操作状态守卫。 */
const isTreeOperation = (value: unknown): value is HarnessThreadTreeOperation =>
  isRecord(value) &&
  (value.kind === 'navigate' || value.kind === 'label') &&
  (value.status === 'running' || value.status === 'summarizing') &&
  typeof value.startedAt === 'string' &&
  isOptionalString(value.targetId)

/** 会话树节点守卫。 */
const isTreeNode = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.entryId === 'string' &&
  (value.parentId === null || typeof value.parentId === 'string') &&
  typeof value.depth === 'number' &&
  (value.kind === 'user' ||
    value.kind === 'assistant' ||
    value.kind === 'tool' ||
    value.kind === 'summary' ||
    value.kind === 'custom' ||
    value.kind === 'state') &&
  typeof value.entryType === 'string' &&
  isOptionalString(value.role) &&
  typeof value.summary === 'string' &&
  isOptionalString(value.timestamp) &&
  isOptionalString(value.label) &&
  typeof value.active === 'boolean' &&
  typeof value.isLeaf === 'boolean' &&
  typeof value.childCount === 'number' &&
  isOptionalBoolean(value.hasToolCalls)

/** 会话树守卫。 */
export const isThreadTree = (value: unknown): value is HarnessThreadTree =>
  isRecord(value) &&
  typeof value.threadId === 'string' &&
  (value.leafId === null || typeof value.leafId === 'string') &&
  typeof value.revision === 'string' &&
  Array.isArray(value.nodes) &&
  value.nodes.every(isTreeNode) &&
  typeof value.branchSummarySkipPrompt === 'boolean' &&
  (value.operation === undefined || isTreeOperation(value.operation))

/** 树导航结果守卫（只校验 UI 会读取的字段）。 */
export const isTreeNavigateResult = (value: unknown): value is HarnessTreeNavigateResult => {
  if (!isRecord(value) || typeof value.status !== 'string') return false
  if (
    value.status !== 'applied' &&
    value.status !== 'cancelled' &&
    value.status !== 'aborted' &&
    value.status !== 'conflict' &&
    value.status !== 'busy' &&
    value.status !== 'persistence-failed' &&
    value.status !== 'failed'
  ) {
    return false
  }
  if (!(value.leafId === undefined || value.leafId === null || typeof value.leafId === 'string')) {
    return false
  }
  if (!isOptionalString(value.treeRevision) || !isOptionalString(value.editorText)) return false
  if (!isOptionalString(value.message)) return false
  if (!isOptionalBoolean(value.recovered) || !isOptionalBoolean(value.summaryCommitted)) {
    return false
  }
  if (
    value.persistence !== undefined &&
    value.persistence !== 'saved' &&
    value.persistence !== 'failed' &&
    value.persistence !== 'skipped'
  ) {
    return false
  }
  const queue = value.recoveredQueue
  if (
    queue !== undefined &&
    (!isRecord(queue) || !isStringArray(queue.steering) || !isStringArray(queue.followUp))
  ) {
    return false
  }
  return value.snapshot === undefined || isThreadSnapshot(value.snapshot)
}

/** 标签结果守卫。 */
export const isTreeLabelResult = (value: unknown): value is HarnessTreeLabelResult =>
  isRecord(value) &&
  (value.status === 'applied' ||
    value.status === 'conflict' ||
    value.status === 'busy' ||
    value.status === 'failed') &&
  isOptionalString(value.label) &&
  isOptionalString(value.treeRevision) &&
  isOptionalString(value.message) &&
  (value.persistence === undefined ||
    value.persistence === 'saved' ||
    value.persistence === 'failed' ||
    value.persistence === 'skipped') &&
  (value.snapshot === undefined || isThreadSnapshot(value.snapshot))

/** 取消摘要结果守卫。 */
export const isTreeCancelResult = (value: unknown): value is HarnessTreeCancelResult =>
  isRecord(value) && (value.status === 'cancelled' || value.status === 'idle')

/** fork/clone 结果守卫（只校验 GUI 会读取的字段）。 */
export const isThreadForkResult = (value: unknown): value is HarnessThreadForkResult => {
  if (!isRecord(value)) return false
  if (
    value.status !== 'created' &&
    value.status !== 'cancelled' &&
    value.status !== 'busy' &&
    value.status !== 'conflict' &&
    value.status !== 'failed'
  ) {
    return false
  }
  if (!isOptionalString(value.threadId) || !isOptionalString(value.parentThreadId)) return false
  if (!isOptionalString(value.selectedText) || !isOptionalString(value.message)) return false
  return value.snapshot === undefined || isThreadSnapshot(value.snapshot)
}

/** 导入源摘要守卫。 */
const isImportSourceInfo = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === 'path' || value.kind === 'upload') &&
  isOptionalString(value.id) &&
  isOptionalString(value.cwd) &&
  isOptionalString(value.name) &&
  isOptionalNumber(value.entries) &&
  isOptionalNumber(value.version) &&
  isOptionalNumber(value.size) &&
  isOptionalString(value.fingerprint)

const isImportCwd = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.available === 'boolean' &&
  typeof value.workspaceMember === 'boolean'

/** 导入预览结果守卫。 */
export const isThreadImportPreview = (value: unknown): value is HarnessThreadImportPreview => {
  if (!isRecord(value)) return false
  if (value.status !== 'ok' && value.status !== 'invalid' && value.status !== 'failed') {
    return false
  }
  if (value.source !== undefined && !isImportSourceInfo(value.source)) return false
  if (
    !isOptionalString(value.workspaceId) ||
    !isOptionalString(value.cwd) ||
    !isOptionalString(value.sessionDir) ||
    !isOptionalString(value.existingThreadId) ||
    !isOptionalString(value.message) ||
    !isOptionalString(value.error)
  ) {
    return false
  }
  if (
    value.conflict !== undefined &&
    value.conflict !== 'none' &&
    value.conflict !== 'already-exists' &&
    value.conflict !== 'conflict'
  ) {
    return false
  }
  if (!isOptionalBoolean(value.canCopy)) return false
  if (value.sourceCwd !== undefined && !isImportCwd(value.sourceCwd)) return false
  return value.warnings === undefined || isStringArray(value.warnings)
}

/** 确认导入结果守卫。 */
export const isThreadImportResult = (value: unknown): value is HarnessThreadImportResult => {
  if (!isRecord(value)) return false
  if (
    value.status !== 'imported' &&
    value.status !== 'already-exists' &&
    value.status !== 'conflict' &&
    value.status !== 'invalid' &&
    value.status !== 'metadata-failed' &&
    value.status !== 'failed'
  ) {
    return false
  }
  if (
    !isOptionalString(value.threadId) ||
    !isOptionalString(value.existingThreadId) ||
    !isOptionalString(value.error) ||
    !isOptionalString(value.message)
  ) {
    return false
  }
  return value.preview === undefined || isThreadImportPreview(value.preview)
}

/**
 * 资源重载操作守卫。
 *
 * 状态与目标都由宿主生成；这里只接受协议列出的受控值，避免畸形载荷
 * 把未知状态带进 UI（例如把失败当成功显示）。
 */
export const isReloadOperation = (value: unknown): value is HarnessReloadOperation =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  (value.trigger === 'command' ||
    value.trigger === 'settings' ||
    value.trigger === 'extension' ||
    value.trigger === 'api') &&
  (value.status === 'running' ||
    value.status === 'succeeded' ||
    value.status === 'failed' ||
    value.status === 'cancelled') &&
  typeof value.workspacePath === 'string' &&
  isOptionalString(value.threadId) &&
  typeof value.startedAt === 'string' &&
  isOptionalString(value.finishedAt) &&
  typeof value.fromResourceRevision === 'number' &&
  typeof value.resourceRevision === 'number' &&
  isOptionalString(value.message)

/** 资源重载结果守卫（含可选权威快照）。 */
export const isReloadResult = (value: unknown): value is HarnessReloadResult => {
  if (!isRecord(value)) return false
  switch (value.status) {
    case 'reloaded':
      return (
        (value.kind === 'session' || value.kind === 'workspace') &&
        typeof value.workspacePath === 'string' &&
        isOptionalString(value.threadId) &&
        isReloadOperation(value.operation) &&
        typeof value.resourceRevision === 'number' &&
        (value.snapshot === undefined || isThreadSnapshot(value.snapshot))
      )
    case 'busy':
      return (
        typeof value.message === 'string' &&
        typeof value.workspacePath === 'string' &&
        isOptionalString(value.threadId)
      )
    case 'failed':
      return (
        (value.reason === 'trust' || value.reason === 'assembly' || value.reason === 'disposed') &&
        typeof value.message === 'string' &&
        isReloadOperation(value.operation)
      )
    case 'cancelled':
      return typeof value.message === 'string' && isReloadOperation(value.operation)
    default:
      return false
  }
}

/** 会话元数据守卫。 */
export const isThreadMetadata = (value: unknown): value is HarnessThreadMetadata =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  typeof value.status === 'string' &&
  (value.queuedMessages === undefined ||
    (Array.isArray(value.queuedMessages) && value.queuedMessages.every(isQueuedMessage))) &&
  isOptionalString(value.title) &&
  isOptionalString(value.name) &&
  isOptionalString(value.firstMessageText) &&
  isOptionalString(value.workspaceId) &&
  isOptionalString(value.workspacePath) &&
  isOptionalBoolean(value.archived) &&
  isOptionalBoolean(value.compactionActive) &&
  (value.compactionReason === undefined ||
    value.compactionReason === 'manual' ||
    value.compactionReason === 'threshold' ||
    value.compactionReason === 'overflow') &&
  isOptionalBoolean(value.autoCompactionEnabled) &&
  (value.scopedModelKeys === undefined || isStringArray(value.scopedModelKeys)) &&
  isOptionalNumber(value.modelCatalogRevision) &&
  isOptionalBoolean(value.retryActive) &&
  isOptionalNumber(value.retryAttempt) &&
  isOptionalString(value.runningRunId) &&
  isThreadConfig(value.config) &&
  (value.contextUsage === undefined || isContextUsage(value.contextUsage)) &&
  isOptionalString(value.sessionFile) &&
  isOptionalString(value.parentSessionPath) &&
  isOptionalNumber(value.messageCount) &&
  isOptionalString(value.createdAt) &&
  isOptionalString(value.updatedAt) &&
  (value.leafId === undefined || value.leafId === null || typeof value.leafId === 'string') &&
  isOptionalString(value.treeRevision) &&
  (value.treeOperation === undefined || isTreeOperation(value.treeOperation)) &&
  isOptionalNumber(value.resourceRevision) &&
  (value.reload === undefined || isReloadOperation(value.reload))

/** 累计统计守卫：详情面板会直接读取这些数值。 */
const isThreadStats = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.userMessages === 'number' &&
  typeof value.assistantMessages === 'number' &&
  typeof value.toolResults === 'number' &&
  typeof value.toolCalls === 'number' &&
  typeof value.totalMessages === 'number' &&
  isRecord(value.tokens) &&
  typeof value.tokens.input === 'number' &&
  typeof value.tokens.output === 'number' &&
  typeof value.tokens.cacheRead === 'number' &&
  typeof value.tokens.cacheWrite === 'number' &&
  typeof value.tokens.total === 'number' &&
  typeof value.cost === 'number'

/** 只读详情守卫：累计统计与当前上下文必须分别合法。 */
export const isThreadDetails = (value: unknown): value is HarnessThreadDetails =>
  isRecord(value) &&
  isThreadMetadata(value.metadata) &&
  isThreadStats(value.stats) &&
  typeof value.branchEntryCount === 'number' &&
  (value.contextUsage === undefined || isContextUsage(value.contextUsage))

const isRenderableTranscriptMessage = (value: unknown): value is HarnessAgentMessage => {
  if (!isRecord(value) || typeof value.role !== 'string') return false

  switch (value.role) {
    case 'user':
      return isUserContent(value.content)
    case 'assistant':
      return Array.isArray(value.content) && value.content.every(isAssistantContentPart)
    case 'toolResult':
      return (
        typeof value.toolCallId === 'string' &&
        Array.isArray(value.content) &&
        value.content.every(isUserContentPart)
      )
    case 'bashExecution':
      return typeof value.command === 'string' && typeof value.output === 'string'
    case 'custom':
      return typeof value.customType === 'string' && isUserContent(value.content)
    case 'branchSummary':
    case 'compactionSummary':
      return typeof value.summary === 'string'
    default:
      return true
  }
}

/** 会话快照守卫。 */
export const isThreadSnapshot = (value: unknown): value is HarnessThreadSnapshot => {
  if (
    !isRecord(value) ||
    !isThreadMetadata(value.metadata) ||
    !isOptionalNumber(value.seq) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isRenderableTranscriptMessage) ||
    (value.hostUiRequests !== undefined &&
      (!Array.isArray(value.hostUiRequests) || !value.hostUiRequests.every(isHostUiRequest))) ||
    (value.hostUi !== undefined && !isThreadHostUi(value.hostUi)) ||
    (value.bash !== undefined && !isBashRun(value.bash)) ||
    (value.compaction !== undefined && !isCompactionPhase(value.compaction))
  ) {
    return false
  }
  if (value.messageEntryIds === undefined) return true
  return (
    Array.isArray(value.messageEntryIds) &&
    value.messageEntryIds.length === value.messages.length &&
    value.messageEntryIds.every((entry) => entry === null || typeof entry === 'string')
  )
}

/** 设置目标守卫：会话或固定起始目录二选一。 */
const isSettingsTarget = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === 'session' || value.kind === 'workspace') &&
  typeof value.workspacePath === 'string' &&
  isOptionalString(value.threadId)

/** 设置文件守卫：原文、revision 与问题列表。 */
const isSettingsFile = (value: unknown): boolean =>
  isRecord(value) &&
  (value.scope === 'user' || value.scope === 'project') &&
  typeof value.path === 'string' &&
  typeof value.exists === 'boolean' &&
  typeof value.content === 'string' &&
  (value.revision === null || typeof value.revision === 'string') &&
  typeof value.bytes === 'number' &&
  typeof value.readable === 'boolean' &&
  typeof value.tooLarge === 'boolean' &&
  Array.isArray(value.issues) &&
  value.issues.every(
    (issue) =>
      isRecord(issue) &&
      (issue.kind === 'parse' ||
        issue.kind === 'schema' ||
        issue.kind === 'unsafe-key' ||
        issue.kind === 'too-large') &&
      typeof issue.path === 'string' &&
      typeof issue.message === 'string',
  ) &&
  isOptionalString(value.readError)

const isSettingsEffective = (value: unknown): boolean =>
  isRecord(value) &&
  (value.source === 'disk' || value.source === 'session') &&
  isRecord(value.values) &&
  isRecord(value.origins)

const isSettingsTrust = (value: unknown): boolean =>
  isRecord(value) &&
  (value.decision === 'trusted' ||
    value.decision === 'untrusted' ||
    value.decision === 'needs-trust') &&
  typeof value.requiresTrust === 'boolean' &&
  typeof value.origin === 'string'

/** 设置快照守卫。 */
export const isSettingsSnapshot = (value: unknown): value is HarnessSettingsSnapshot =>
  isRecord(value) &&
  isSettingsTarget(value.target) &&
  typeof value.agentDir === 'string' &&
  typeof value.projectTrusted === 'boolean' &&
  isSettingsTrust(value.trust) &&
  isRecord(value.files) &&
  isSettingsFile(value.files.user) &&
  isSettingsFile(value.files.project) &&
  isSettingsEffective(value.effective) &&
  (value.live === undefined || isSettingsEffective(value.live)) &&
  isOptionalBoolean(value.reloadRequired)

/** 设置保存结果守卫。 */
export const isSettingsSaveResult = (value: unknown): value is HarnessSettingsSaveResult => {
  if (!isRecord(value)) return false
  if (value.status === 'saved') {
    return (
      (value.scope === 'user' || value.scope === 'project') &&
      typeof value.path === 'string' &&
      typeof value.revision === 'string' &&
      typeof value.bytes === 'number' &&
      isSettingsSnapshot(value.snapshot) &&
      isRecord(value.apply) &&
      typeof value.apply.persisted === 'boolean' &&
      typeof value.apply.reloadRequired === 'boolean' &&
      isStringArray(value.apply.restartRequiredKeys) &&
      typeof value.apply.message === 'string'
    )
  }
  if (value.status === 'conflict') {
    return (
      (value.scope === 'user' || value.scope === 'project') &&
      typeof value.path === 'string' &&
      (value.revision === null || typeof value.revision === 'string') &&
      typeof value.message === 'string'
    )
  }
  if (value.status === 'invalid') {
    return (
      (value.scope === 'user' || value.scope === 'project') &&
      typeof value.path === 'string' &&
      Array.isArray(value.issues) &&
      value.issues.every(
        (issue) =>
          isRecord(issue) &&
          (issue.kind === 'parse' ||
            issue.kind === 'schema' ||
            issue.kind === 'unsafe-key' ||
            issue.kind === 'too-large') &&
          typeof issue.path === 'string' &&
          typeof issue.message === 'string',
      ) &&
      typeof value.message === 'string'
    )
  }
  if (value.status === 'untrusted' || value.status === 'failed') {
    return (
      (value.scope === 'user' || value.scope === 'project') &&
      typeof value.path === 'string' &&
      typeof value.message === 'string'
    )
  }
  if (value.status === 'too-large') {
    return (
      (value.scope === 'user' || value.scope === 'project') &&
      typeof value.path === 'string' &&
      typeof value.limitBytes === 'number' &&
      typeof value.message === 'string'
    )
  }
  return false
}

const isResourceSourceInfo = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.source === 'string' &&
  (value.scope === 'user' || value.scope === 'project' || value.scope === 'temporary') &&
  (value.origin === 'package' || value.origin === 'top-level') &&
  isOptionalString(value.baseDir)

const isResourceLoadedRef = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === 'extension' ||
    value.kind === 'skill' ||
    value.kind === 'prompt' ||
    value.kind === 'theme') &&
  typeof value.name === 'string' &&
  typeof value.source === 'string' &&
  (value.scope === 'user' || value.scope === 'project' || value.scope === 'temporary') &&
  (value.origin === 'package' || value.origin === 'top-level') &&
  typeof value.path === 'string'

/** 资源清单守卫。 */
export const isResourceSnapshot = (value: unknown): value is HarnessResourceSnapshot =>
  isRecord(value) &&
  isSettingsTarget(value.target) &&
  typeof value.agentDir === 'string' &&
  isSettingsTrust(value.trust) &&
  (value.loadedFrom === 'session' || value.loadedFrom === 'assembly') &&
  typeof value.projectResourcesLoaded === 'boolean' &&
  isOptionalString(value.trustNote) &&
  Array.isArray(value.instructions) &&
  value.instructions.every(
    (item) =>
      isRecord(item) &&
      typeof item.path === 'string' &&
      typeof item.bytes === 'number' &&
      isOptionalString(item.text) &&
      isOptionalBoolean(item.textTruncated),
  ) &&
  (value.systemPrompt === undefined ||
    (isRecord(value.systemPrompt) &&
      typeof value.systemPrompt.bytes === 'number' &&
      isOptionalString(value.systemPrompt.source) &&
      isOptionalString(value.systemPrompt.text) &&
      isOptionalBoolean(value.systemPrompt.textTruncated) &&
      Array.isArray(value.systemPrompt.append) &&
      value.systemPrompt.append.every(
        (item) =>
          isRecord(item) &&
          typeof item.bytes === 'number' &&
          isOptionalString(item.source) &&
          isOptionalString(item.text) &&
          isOptionalBoolean(item.textTruncated),
      ))) &&
  Array.isArray(value.extensions) &&
  value.extensions.every(
    (item) =>
      isRecord(item) &&
      typeof item.path === 'string' &&
      typeof item.hidden === 'boolean' &&
      isResourceSourceInfo(item.sourceInfo) &&
      isStringArray(item.commands) &&
      isStringArray(item.tools),
  ) &&
  Array.isArray(value.skills) &&
  value.skills.every(
    (item) =>
      isRecord(item) &&
      typeof item.name === 'string' &&
      typeof item.description === 'string' &&
      typeof item.path === 'string' &&
      isResourceSourceInfo(item.sourceInfo) &&
      typeof item.disableModelInvocation === 'boolean',
  ) &&
  Array.isArray(value.prompts) &&
  value.prompts.every(
    (item) =>
      isRecord(item) &&
      typeof item.name === 'string' &&
      typeof item.description === 'string' &&
      isOptionalString(item.argumentHint) &&
      typeof item.path === 'string' &&
      isResourceSourceInfo(item.sourceInfo),
  ) &&
  Array.isArray(value.themes) &&
  value.themes.every(
    (item) =>
      isRecord(item) &&
      typeof item.name === 'string' &&
      isOptionalString(item.path) &&
      (item.sourceInfo === undefined || isResourceSourceInfo(item.sourceInfo)),
  ) &&
  Array.isArray(value.packages) &&
  value.packages.every(
    (item) =>
      isRecord(item) &&
      typeof item.source === 'string' &&
      isOptionalBoolean(item.autoload) &&
      (item.extensions === undefined || isStringArray(item.extensions)) &&
      (item.skills === undefined || isStringArray(item.skills)) &&
      (item.prompts === undefined || isStringArray(item.prompts)) &&
      (item.themes === undefined || isStringArray(item.themes)),
  ) &&
  Array.isArray(value.loaded) &&
  value.loaded.every(isResourceLoadedRef) &&
  isStringArray(value.diagnostics)
