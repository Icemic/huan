/**
 * `createHarnessHttpClient`——浏览器侧 `HarnessClient`，由一层薄 HTTP/SSE
 * 路由对接宿主的 `@huan/core` 宿主实现。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/client/httpClient.ts`
 * （MIT 许可）。改动：
 * - 类型改用 `@huan/protocol`（含 `createThread` 的 `model` / `thinkingLevel`
 *   扩展字段——react-pi 类型未声明）；
 * - 命名 `Pi*` → `Harness*`；上游内部工具改从 `../vendor/anti-corruption.js`
 *   引入；注释译为中文；
 * - `subscribe` 由 `createSharedStreamCache`（多组件共享单个 SSE 连接，
 *   469 行）改为**单订阅实现**——见下。
 *
 * **订阅实现说明**：上游用 sharedStreamCache 让同页多个组件共享一条 SSE 连接。
 * 本项目经调研（迭代文档决策点 5）确认无此场景，故不移植共享逻辑，
 * 但保留其**对外语义**：每次 subscribe 建立独立连接；`includeSnapshot: false`
 * 时首帧跳过快照、断线重连切到带快照的 URL 以恢复；终止性流错误
 *（解码器大小/配置限制）向监听者投递带外 error 事件并关闭连接。
 * 防抖由 Controller 侧的 30 秒断开定时器承担，客户端不再叠加延迟。
 *
 * 浏览器安全：不导入任何 Pi SDK 包。路由层是唯一接触 Pi SDK 之处，
 * 且位于服务端的 `@huan/core` 中。
 *
 * 线契约（相对 `baseUrl`，默认 `/api/pi`）：
 *   GET    /workspaces              → HarnessWorkspaceCatalog
 *   POST   /workspaces              → HarnessWorkspaceMutationResult (body: 创建输入)
 *   PATCH  /workspaces/:id          → HarnessWorkspaceMutationResult (body: 修改输入)
 *   GET    /threads                 → HarnessThreadMetadata[]   (?workspaceId=&unassigned=&includeArchived=&refresh=)
 *   POST   /threads                 → HarnessThreadSnapshot      (body: workspaceId + startProjectPath 等)
 *   POST   /threads/:id/workspace   → HarnessAssignThreadResult  (body: { workspaceId })
 *   GET    /threads/:id             → HarnessThreadSnapshot
 *   GET    /threads/:id/details     → HarnessThreadDetails       (只读详情与累计统计)
 *   GET    /commands                → HarnessCommandCatalog      (?threadId= 或 ?workspacePath=)
 *   POST   /commands/arguments      → HarnessCommandArgumentCompletion[]
 *   GET    /settings                → HarnessSettingsSnapshot      (?threadId= 或 ?workspacePath=)
 *   PUT    /settings                → HarnessSettingsSaveResult    (body: target/scope/content/expectedRevision)
 *   GET    /resources               → HarnessResourceSnapshot      (?threadId= 或 ?workspacePath=，includeText=true 时含文本)
 *   POST   /reload                  → HarnessReloadResult          (body: { target, trigger? })
 *   POST   /files                   → HarnessFileSearchResult
 *   GET    /threads/:id/tree        → HarnessThreadTree          (按需读取会话树)
 *   POST   /threads/:id/tree/navigate → HarnessTreeNavigateResult
 *   POST   /threads/:id/tree/label  → HarnessTreeLabelResult
 *   POST   /threads/:id/tree/cancel → HarnessTreeCancelResult
 *   POST   /threads/:id/fork       → HarnessThreadForkResult
 *   POST   /threads/import/preview → HarnessThreadImportPreview
 *   POST   /threads/import         → HarnessThreadImportResult
 *   PATCH  /threads/:id             → 204                        (body: { title })
 *   POST   /threads/:id/messages    → 204                        (body: { input })
 *   POST   /threads/:id/cancel      → 204
 *   POST   /threads/:id/queue/clear → { steering, followUp }      (被清空的文本)
 *   GET    /projects                → HarnessRecentProject[]
 *   POST   /projects/check          → HarnessProjectPathCheck     (body: { path })
 *   GET    /projects/info?path=     → HarnessProjectInfo
 *   GET    /projects/trust-summary?path= → HarnessProjectInfo     (只读信任摘要)
 *   POST   /projects/trust          → HarnessProjectInfo          (body: { path, trusted, remember? })
 *   POST   /threads/:id/bash        → HarnessBashStartResult       (body: { command, excludeFromContext? })
 *   POST   /threads/:id/bash/abort  → HarnessBashAbortResult
 *   POST   /threads/:id/compact     → HarnessCompactionOutcome     (body: { customInstructions? })
 *   POST   /threads/:id/compact/abort → HarnessCompactionAbortResult
 *   POST   /threads/:id/auto-compaction → HarnessAutoCompactionUpdateResult (body: { enabled })
 *   GET    /threads/:id/model-scope → HarnessModelScope
 *   POST   /threads/:id/model-scope → HarnessModelScopeUpdateResult (body: { patterns, saveAsDefault? })
 *   GET    /models                  → HarnessModelInfo[]
 *   POST   /models/refresh          → HarnessModelRefreshResult    (body: { threadId?, workspacePath? })
 *   POST   /threads/:id/model       → 204                        (body: { provider, modelId })
 *   POST   /threads/:id/thinking    → 204                        (body: { level })
 *   POST   /threads/:id/archive     → 204
 *   POST   /threads/:id/unarchive   → 204
 *   DELETE /threads/:id             → 204（线程本就不存在时同样）
 *   POST   /threads/:id/host-ui     → 204                        (body: { response })
 *   GET    /threads/:id/events      → HarnessClientEvent 的 SSE（?snapshot=false 跳过首帧快照）
 *   GET    /provider-auth           → HarnessProviderAuthSnapshot（客户端订阅用轮询）
 *   POST   /provider-auth/login     → HarnessProviderAuthStartResult  (body: { providerId, method })
 *   POST   /provider-auth/respond   → HarnessProviderAuthRespondResult (body: { operationId, promptId, value })
 *   POST   /provider-auth/cancel    → HarnessProviderAuthCancelResult (body: { operationId })
 *   POST   /provider-auth/logout    → HarnessProviderAuthStartResult  (body: { providerId })
 *   GET    /mcp                     → HarnessMcpSnapshot            (?threadId= 或 ?workspacePath=)
 *   POST   /mcp/details             → HarnessMcpDetailsResult       (body: target/expectedRuntimeId/server/include)
 *   GET    /mcp/config              → HarnessMcpConfigSnapshot      (?threadId= 或 ?workspacePath=)
 *   PUT    /mcp/config              → HarnessMcpConfigSaveResult    (body: target/scope/content/expectedRevision)
 *   POST   /mcp/manage              → HarnessMcpManageResult        (body: target/expectedRuntimeId/server/expectedIdentity/action)
 *   GET    /mcp/auth                → HarnessMcpAuthSnapshot        (客户端轮询)
 *   POST   /mcp/auth/login          → HarnessMcpAuthStartResult     (body: target/expectedRuntimeId/server/expectedIdentity)
 *   POST   /mcp/auth/logout         → HarnessMcpAuthStartResult
 *   POST   /mcp/auth/respond        → HarnessMcpAuthRespondResult   (body: operationId/promptId/value)
 *   POST   /mcp/auth/cancel         → HarnessMcpAuthCancelResult    (body: operationId)
 */

import type {
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashStartResult,
  HarnessClient,
  HarnessClientEvent,
  HarnessCommandArgumentCompletion,
  HarnessCommandArgumentInput,
  HarnessCommandCatalog,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessFileSearchInput,
  HarnessFileSearchResult,
  HarnessHostInfo,
  HarnessHostInteractionAnswer,
  HarnessHostInteractionEvent,
  HarnessHostUiResponse,
  HarnessMcpAuthCancelResult,
  HarnessMcpAuthRespondInput,
  HarnessMcpAuthRespondResult,
  HarnessMcpAuthSnapshot,
  HarnessMcpAuthStartInput,
  HarnessMcpAuthStartResult,
  HarnessMcpConfigSaveInput,
  HarnessMcpConfigSaveResult,
  HarnessMcpConfigSnapshot,
  HarnessMcpDetailsInput,
  HarnessMcpDetailsResult,
  HarnessMcpManageInput,
  HarnessMcpManageResult,
  HarnessMcpSnapshot,
  HarnessMcpTargetInput,
  HarnessModelInfo,
  HarnessModelRefreshResult,
  HarnessModelScope,
  HarnessModelScopeUpdateResult,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectTrustInput,
  HarnessProviderAuthCancelResult,
  HarnessProviderAuthRespondResult,
  HarnessProviderAuthStartResult,
  HarnessProviderAuthStreamEvent,
  HarnessRecentProject,
  HarnessReloadResult,
  HarnessResourceQueryInput,
  HarnessResourceSnapshot,
  HarnessSendMessageInput,
  HarnessSendMessageOptions,
  HarnessSendMessageResult,
  HarnessSettingsSaveInput,
  HarnessSettingsSaveResult,
  HarnessSettingsSnapshot,
  HarnessSettingsTargetInput,
  HarnessThinkingLevel,
  HarnessThreadForkInput,
  HarnessThreadForkResult,
  HarnessThreadImportInput,
  HarnessThreadImportPreview,
  HarnessThreadImportPreviewInput,
  HarnessThreadImportResult,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceMutationResult,
} from '@huan/protocol'
import { invokeUserCallback, isRecord } from '../vendor/anti-corruption.js'
import {
  createHarnessEventStreamConnection,
  createHarnessSseDecoder,
  isTerminalStreamError,
} from './event-source.js'
import {
  isMcpAuthCancelResult,
  isMcpAuthRespondResult,
  isMcpAuthSnapshot,
  isMcpAuthStartResult,
  isMcpConfigSaveResult,
  isMcpConfigSnapshot,
  isMcpDetailsResult,
  isMcpManageResult,
  isMcpSnapshot,
} from './mcp-validation.js'
import {
  isHostInteractionSnapshot,
  isProviderAuthCancelResult,
  isProviderAuthRespondResult,
  isProviderAuthSnapshot,
  isProviderAuthStartResult,
  isReloadResult,
  isResourceSnapshot,
  isSettingsSaveResult,
  isSettingsSnapshot,
  isThreadDetails,
  isThreadForkResult,
  isThreadImportPreview,
  isThreadImportResult,
  isThreadMetadata,
  isThreadSnapshot,
  isThreadTree,
  isTreeCancelResult,
  isTreeLabelResult,
  isTreeNavigateResult,
} from './validation.js'

/** HTTP 客户端选项。 */
export interface HarnessHttpClientOptions {
  /** 路由层的基路径/URL。默认 `/api/pi`。 */
  baseUrl?: string
  /** 注入的 `fetch`（默认全局）。 */
  fetchImpl?: typeof fetch
  /** 应用于每个请求的额外头（如鉴权）。 */
  headers?: Record<string, string>
  /** 调用方窗口标识；发送消息时经 `x-huan-caller` 头传递（不进入会话记录）。 */
  callerId?: string
  /**
   * SSE 流错误。其后会重连，除非是解码器限制错误——那会结束流并向监听者
   * 发送一条 error 事件。
   */
  onStreamError?: (error: unknown) => void
  /** 事件流重连退避；为测试可注入。 */
  reconnectDelay?: () => Promise<void>
  /** 单条 SSE 行接受的最大 UTF-16 码元数。默认 16 MiB。 */
  maxStreamLineLength?: number | undefined
  /** 单个 SSE 事件累计保留的最大 UTF-16 码元数。默认 16 MiB。 */
  maxStreamEventLength?: number | undefined
}

const trimTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value

/** 对任何非 2xx 响应抛出可诊断错误（含响应体）。 */
/**
 * 宿主 HTTP 错误（保留状态码与类型化错误码）。
 *
 * 运行时据此把“请求未被接受”的 4xx 重新包成 assistant-ui 的
 * MessageNotSentError，让输入框恢复文字与附件；5xx 不自动重投。
 */
export class HarnessHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly command?: string,
  ) {
    super(message)
    this.name = 'HarnessHttpError'
  }
}

/** 对任何非 2xx 响应抛出可诊断错误（含响应体与受控错误码）。 */
const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return
  const body = await response.text().catch(() => '')
  let code: string | undefined
  let command: string | undefined
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (isRecord(parsed)) {
        if (typeof parsed.error === 'string') code = parsed.error
        if (typeof parsed.command === 'string') command = parsed.command
      }
    } catch {
      // 非 JSON 错误体仍按文本报告。
    }
  }
  throw new HarnessHttpError(
    `Pi HTTP request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
    response.status,
    code,
    command,
  )
}

const invalidResponse = (operation: string, expectation: string, cause?: unknown): Error =>
  new Error(
    `Invalid Pi HTTP response while ${operation}: ${expectation}`,
    cause === undefined ? undefined : { cause },
  )

const readJson = async (response: Response, operation: string): Promise<unknown> => {
  await assertOk(response)
  try {
    return await response.json()
  } catch (error) {
    throw invalidResponse(operation, 'expected valid JSON.', error)
  }
}

const parseThreadListResponse = (value: unknown): HarnessThreadMetadata[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse('listing threads', 'expected an array of threads.')
  }

  for (const [index, thread] of value.entries()) {
    if (!isThreadMetadata(thread)) {
      throw invalidResponse(
        'listing threads',
        `thread at index ${index} must have a non-empty string "id", a string "status", and correctly typed known fields.`,
      )
    }
  }
  return value
}

const parseThreadSnapshotResponse = (
  value: unknown,
  operation: 'creating a thread' | 'fetching a thread',
): HarnessThreadSnapshot => {
  if (!isThreadSnapshot(value)) {
    throw invalidResponse(
      operation,
      'expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  }
  return value
}

const parseClearQueueResponse = (value: unknown): { steering: string[]; followUp: string[] } => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.steering) ||
    !value.steering.every((item) => typeof item === 'string') ||
    !Array.isArray(value.followUp) ||
    !value.followUp.every((item) => typeof item === 'string')
  ) {
    throw invalidResponse(
      'clearing a thread queue',
      'expected an object with string arrays "steering" and "followUp".',
    )
  }
  return value as { steering: string[]; followUp: string[] }
}

/** 项目摘要守卫：只接受页面会读取的受控字段。 */
const isProjectTrust = (value: unknown): boolean =>
  isRecord(value) &&
  (value.decision === 'trusted' ||
    value.decision === 'untrusted' ||
    value.decision === 'unknown') &&
  typeof value.origin === 'string' &&
  typeof value.requiresTrust === 'boolean' &&
  (value.defaultPolicy === 'ask' ||
    value.defaultPolicy === 'always' ||
    value.defaultPolicy === 'never') &&
  (value.savedPath === undefined || typeof value.savedPath === 'string') &&
  typeof value.extensionErrorCount === 'number'

const isProjectInfo = (value: unknown): value is HarnessProjectInfo =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.name === 'string' &&
  (value.status === 'ready' ||
    value.status === 'needs-trust' ||
    value.status === 'loading' ||
    value.status === 'failed') &&
  isProjectTrust(value.trust) &&
  (value.failure === undefined ||
    (isRecord(value.failure) && typeof value.failure.code === 'string'))

const isProjectPathCheck = (value: unknown): value is HarnessProjectPathCheck =>
  isRecord(value) &&
  typeof value.input === 'string' &&
  typeof value.path === 'string' &&
  typeof value.exists === 'boolean' &&
  typeof value.isDirectory === 'boolean' &&
  (value.error === undefined ||
    (isRecord(value.error) &&
      (value.error.code === 'invalid-path' ||
        value.error.code === 'not-found' ||
        value.error.code === 'not-directory')))

const isRecentProject = (value: unknown): value is HarnessRecentProject =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.name === 'string' &&
  (value.lastActiveAt === undefined || typeof value.lastActiveAt === 'string')

const isWorkspaceProject = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.alias === 'string' &&
  typeof value.path === 'string' &&
  typeof value.available === 'boolean'

const isWorkspace = (value: unknown): value is HarnessWorkspace =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.revision === 'number' &&
  Array.isArray(value.projects) &&
  value.projects.every(isWorkspaceProject)

const isWorkspaceCatalog = (value: unknown): value is HarnessWorkspaceCatalog =>
  isRecord(value) &&
  Array.isArray(value.workspaces) &&
  value.workspaces.every(isWorkspace) &&
  (value.state === 'ok' ||
    value.state === 'corrupted' ||
    value.state === 'unsupported-version' ||
    value.state === 'unreadable') &&
  (value.startupWorkspaceId === undefined || typeof value.startupWorkspaceId === 'string')

const isWorkspaceMutationResult = (value: unknown): value is HarnessWorkspaceMutationResult => {
  if (!isRecord(value)) return false
  if (value.ok === true) return isWorkspace(value.workspace)
  if (value.ok !== false) return false
  return (
    (value.error === 'conflict' ||
      value.error === 'state-unavailable' ||
      value.error === 'not-found' ||
      value.error === 'invalid') &&
    (value.workspace === undefined || isWorkspace(value.workspace)) &&
    (value.reason === undefined || typeof value.reason === 'string')
  )
}

const isAssignThreadResult = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.ok === true) return isThreadMetadata(value.thread)
  return (
    value.ok === false &&
    (value.error === 'state-unavailable' ||
      value.error === 'not-found' ||
      value.error === 'invalid') &&
    (value.reason === undefined || typeof value.reason === 'string')
  )
}

const parseProjectInfo = (value: unknown): HarnessProjectInfo => {
  if (!isProjectInfo(value)) {
    throw invalidResponse('fetching a project', 'expected a valid project summary.')
  }
  return value
}

const parseProjectPathCheck = (value: unknown): HarnessProjectPathCheck => {
  if (!isProjectPathCheck(value)) {
    throw invalidResponse('checking a project path', 'expected a valid path check result.')
  }
  return value
}

const parseRecentProjects = (value: unknown): HarnessRecentProject[] => {
  if (!Array.isArray(value) || !value.every(isRecentProject)) {
    throw invalidResponse('listing recent projects', 'expected an array of recent projects.')
  }
  return value
}

const isModelInfo = (value: unknown): value is HarnessModelInfo =>
  isRecord(value) &&
  typeof value.provider === 'string' &&
  value.provider.length > 0 &&
  typeof value.modelId === 'string' &&
  value.modelId.length > 0 &&
  (value.name === undefined || typeof value.name === 'string') &&
  (value.supportsThinking === undefined || typeof value.supportsThinking === 'boolean') &&
  (value.availableThinkingLevels === undefined ||
    (Array.isArray(value.availableThinkingLevels) &&
      value.availableThinkingLevels.every((level) => typeof level === 'string'))) &&
  (value.input === undefined ||
    (Array.isArray(value.input) && value.input.every((item) => typeof item === 'string')))

const parseModelListResponse = (value: unknown): HarnessModelInfo[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse('listing models', 'expected an array of models.')
  }

  for (const [index, model] of value.entries()) {
    if (!isModelInfo(model)) {
      throw invalidResponse(
        'listing models',
        `model at index ${index} must have non-empty string "provider" and "modelId" fields.`,
      )
    }
  }
  return value
}

const isCommandSourceInfo = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.source === 'string' &&
  (value.scope === 'user' || value.scope === 'project' || value.scope === 'temporary') &&
  (value.origin === 'package' || value.origin === 'top-level') &&
  (value.baseDir === undefined || typeof value.baseDir === 'string')

const isResourceCommand = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  (value.description === undefined || typeof value.description === 'string') &&
  (value.argumentHint === undefined || typeof value.argumentHint === 'string') &&
  (value.source === 'extension' || value.source === 'prompt' || value.source === 'skill') &&
  isCommandSourceInfo(value.sourceInfo) &&
  typeof value.supportsArguments === 'boolean' &&
  (value.shadowedBy === undefined ||
    value.shadowedBy === 'extension' ||
    value.shadowedBy === 'prompt' ||
    value.shadowedBy === 'skill')

const parseCommandCatalogResponse = (value: unknown): HarnessCommandCatalog => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.commands) ||
    !value.commands.every(isResourceCommand) ||
    typeof value.skillCommandsEnabled !== 'boolean' ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every((item) => typeof item === 'string')
  ) {
    throw invalidResponse('listing commands', 'expected a valid command catalog.')
  }
  return value as HarnessCommandCatalog
}

const parseCommandArgumentsResponse = (
  value: unknown,
): readonly HarnessCommandArgumentCompletion[] => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isRecord(item) &&
        typeof item.value === 'string' &&
        typeof item.label === 'string' &&
        (item.description === undefined || typeof item.description === 'string'),
    )
  ) {
    throw invalidResponse(
      'completing command arguments',
      'expected an array of argument completions.',
    )
  }
  return value as readonly HarnessCommandArgumentCompletion[]
}

const parseFileSearchResponse = (value: unknown): HarnessFileSearchResult => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === 'string' &&
        typeof item.reference === 'string' &&
        typeof item.relativePath === 'string' &&
        (item.kind === 'file' || item.kind === 'directory') &&
        (item.alias === undefined || typeof item.alias === 'string') &&
        (item.workspaceName === undefined || typeof item.workspaceName === 'string'),
    ) ||
    typeof value.truncated !== 'boolean'
  ) {
    throw invalidResponse('searching files', 'expected a valid file search result.')
  }
  return value as HarnessFileSearchResult
}

const parseSendMessageResult = (value: unknown): HarnessSendMessageResult => {
  if (
    !isRecord(value) ||
    (value.disposition !== 'started' &&
      value.disposition !== 'queued' &&
      value.disposition !== 'handled' &&
      value.disposition !== 'cancelled')
  ) {
    throw invalidResponse('sending a message', 'expected a valid send disposition.')
  }
  return { disposition: value.disposition }
}

const isBashRunPayload = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.command === 'string' &&
  typeof value.excludeFromContext === 'boolean' &&
  typeof value.cwd === 'string' &&
  (value.status === 'running' || value.status === 'complete') &&
  typeof value.output === 'string' &&
  typeof value.outputTruncated === 'boolean' &&
  typeof value.startedAt === 'string' &&
  (value.result === undefined ||
    (isRecord(value.result) &&
      (value.result.exitCode === undefined || typeof value.result.exitCode === 'number') &&
      typeof value.result.cancelled === 'boolean' &&
      typeof value.result.truncated === 'boolean' &&
      (value.result.fullOutputPath === undefined ||
        typeof value.result.fullOutputPath === 'string') &&
      typeof value.result.endedAt === 'string' &&
      (value.result.error === undefined || typeof value.result.error === 'string')))

const parseBashStartResponse = (value: unknown): HarnessBashStartResult => {
  if (!isRecord(value)) throw invalidResponse('starting a shell command', 'expected an object.')
  if (value.status === 'started') {
    if (!isBashRunPayload(value.run)) {
      throw invalidResponse('starting a shell command', 'expected a valid bash run.')
    }
    return value as HarnessBashStartResult
  }
  if ((value.status === 'busy' || value.status === 'failed') && typeof value.message === 'string') {
    return value as HarnessBashStartResult
  }
  throw invalidResponse('starting a shell command', 'expected status started, busy or failed.')
}

const parseBashAbortResponse = (value: unknown): HarnessBashAbortResult => {
  if (isRecord(value) && (value.status === 'requested' || value.status === 'idle')) {
    return value as HarnessBashAbortResult
  }
  throw invalidResponse('aborting a shell command', 'expected status requested or idle.')
}

const parseCompactionOutcome = (value: unknown): HarnessCompactionOutcome => {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw invalidResponse('compacting a thread', 'expected an object with a status.')
  }
  if (value.status === 'compacted') {
    if (
      (value.tokensBefore !== undefined && typeof value.tokensBefore !== 'number') ||
      (value.estimatedTokensAfter !== undefined && typeof value.estimatedTokensAfter !== 'number')
    ) {
      throw invalidResponse('compacting a thread', 'expected numeric token counts.')
    }
    return value as HarnessCompactionOutcome
  }
  if (value.status === 'cancelled') {
    if (value.message !== undefined && typeof value.message !== 'string') {
      throw invalidResponse('compacting a thread', 'expected a string message.')
    }
    return value as HarnessCompactionOutcome
  }
  if ((value.status === 'busy' || value.status === 'failed') && typeof value.message === 'string') {
    return value as HarnessCompactionOutcome
  }
  throw invalidResponse('compacting a thread', 'expected a known compaction outcome.')
}

const isCompactionAbortResult = (value: unknown): value is HarnessCompactionAbortResult =>
  isRecord(value) && (value.status === 'requested' || value.status === 'idle')

const parseAutoCompactionResponse = (value: unknown): HarnessAutoCompactionUpdateResult => {
  if (!isRecord(value)) {
    throw invalidResponse('updating auto compaction', 'expected an object.')
  }
  if (value.status === 'saved') {
    if (typeof value.enabled !== 'boolean' || value.scope !== 'global') {
      throw invalidResponse('updating auto compaction', 'expected enabled and global scope.')
    }
    if (value.overridden !== undefined && typeof value.overridden !== 'boolean') {
      throw invalidResponse('updating auto compaction', 'expected boolean overridden.')
    }
    if (value.message !== undefined && typeof value.message !== 'string') {
      throw invalidResponse('updating auto compaction', 'expected a string message.')
    }
    return value as HarnessAutoCompactionUpdateResult
  }
  if (value.status === 'failed' && typeof value.message === 'string') {
    return value as HarnessAutoCompactionUpdateResult
  }
  throw invalidResponse('updating auto compaction', 'expected saved or failed.')
}

const isModelScopeModel = (value: unknown): boolean =>
  isRecord(value) && typeof value.provider === 'string' && typeof value.modelId === 'string'

const isModelScopeDiagnostic = (value: unknown): boolean =>
  isRecord(value) &&
  (value.code === 'no-match' ||
    value.code === 'invalid-thinking-level' ||
    value.code === 'ambiguous') &&
  typeof value.message === 'string' &&
  typeof value.pattern === 'string'

const parseModelScopeResponse = (value: unknown): HarnessModelScope => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.patterns) ||
    !value.patterns.every((item) => typeof item === 'string') ||
    !Array.isArray(value.models) ||
    !value.models.every(isModelScopeModel) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isModelScopeDiagnostic) ||
    (value.savedPatterns !== undefined &&
      (!Array.isArray(value.savedPatterns) ||
        !value.savedPatterns.every((item) => typeof item === 'string')))
  ) {
    throw invalidResponse('reading a model scope', 'expected a valid model scope.')
  }
  return value as HarnessModelScope
}

const parseModelScopeUpdateResponse = (value: unknown): HarnessModelScopeUpdateResult => {
  parseModelScopeResponse(value)
  if (!isRecord(value)) throw invalidResponse('updating a model scope', 'expected an object.')
  if (
    value.persistence !== 'saved' &&
    value.persistence !== 'failed' &&
    value.persistence !== 'skipped'
  ) {
    throw invalidResponse('updating a model scope', 'expected a persistence marker.')
  }
  if (value.message !== undefined && typeof value.message !== 'string') {
    throw invalidResponse('updating a model scope', 'expected a string message.')
  }
  return value as HarnessModelScopeUpdateResult
}

const parseSettingsSnapshotResponse = (
  value: unknown,
  operation: 'reading settings' | 'saving settings',
): HarnessSettingsSnapshot => {
  if (!isSettingsSnapshot(value)) {
    throw invalidResponse(operation, 'expected a valid settings snapshot.')
  }
  return value
}

const parseSettingsSaveResponse = (value: unknown): HarnessSettingsSaveResult => {
  if (!isSettingsSaveResult(value)) {
    throw invalidResponse('saving settings', 'expected a valid settings save result.')
  }
  return value
}

const parseResourceSnapshotResponse = (value: unknown): HarnessResourceSnapshot => {
  if (!isResourceSnapshot(value)) {
    throw invalidResponse('reading resources', 'expected a valid resource snapshot.')
  }
  return value
}

const parseReloadResultResponse = (value: unknown): HarnessReloadResult => {
  if (!isReloadResult(value)) {
    throw invalidResponse('reloading resources', 'expected a valid reload result.')
  }
  return value
}

/** 设置/资源查询串：threadId 与 workspacePath 由宿主校验互斥。 */
const configTargetQuery = (input: HarnessSettingsTargetInput): string => {
  const params = new URLSearchParams()
  if (input.threadId) params.set('threadId', input.threadId)
  if (input.workspacePath) params.set('workspacePath', input.workspacePath)
  return params.toString()
}

const parseModelRefreshResponse = (value: unknown): HarnessModelRefreshResult => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.models) ||
    !value.models.every(isModelInfo) ||
    !Array.isArray(value.failedProviders) ||
    !value.failedProviders.every((item) => typeof item === 'string')
  ) {
    throw invalidResponse('refreshing models', 'expected models and failedProviders.')
  }
  return value as HarnessModelRefreshResult
}

/** 校验 GUI 实际读取的宿主字段；诊断只接受约定代码，不展示任意扩展文案。 */
const isHostInfo = (value: unknown): value is HarnessHostInfo => {
  if (!isRecord(value) || !isRecord(value.sessionStorage) || !isRecord(value.defaultModel))
    return false
  const storage = value.sessionStorage
  const model = value.defaultModel
  return (
    typeof value.workspacePath === 'string' &&
    typeof value.agentDir === 'string' &&
    typeof value.agentDirSource === 'string' &&
    typeof storage.root === 'string' &&
    typeof storage.directory === 'string' &&
    typeof storage.source === 'string' &&
    (storage.mode === 'grouped' || storage.mode === 'flat') &&
    typeof model.providerSource === 'string' &&
    typeof model.modelIdSource === 'string' &&
    isRecord(model.readiness) &&
    typeof model.readiness.state === 'string' &&
    (model.readiness.message === undefined || typeof model.readiness.message === 'string') &&
    (model.provider === undefined || typeof model.provider === 'string') &&
    (model.modelId === undefined || typeof model.modelId === 'string') &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(
      (code) =>
        code === 'assembly-warning' ||
        code === 'catalog-refresh-failed' ||
        code === 'model-fallback',
    )
  )
}

/**
 * 创建浏览器侧 HTTP 客户端。
 *
 * 无内部连接状态：SSE 仅在 `subscribe` 期间开启，因此可作为模块级单例在
 * 运行时与模型选择器之间共享。
 */
export const createHarnessHttpClient = (options: HarnessHttpClientOptions = {}): HarnessClient => {
  const { baseUrl = '/api/pi', fetchImpl = fetch, headers, callerId } = options
  const { onStreamError, reconnectDelay, maxStreamLineLength, maxStreamEventLength } = options

  const base = trimTrailingSlash(baseUrl)
  const threadUrl = (threadId: string) => `${base}/threads/${encodeURIComponent(threadId)}`

  const jsonHeaders = { 'content-type': 'application/json', ...headers }

  const send = (
    url: string,
    method: string,
    body?: unknown,
    requestOptions?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) => {
    const requestHeaders = {
      ...(body !== undefined ? jsonHeaders : (headers ?? {})),
      ...(requestOptions?.headers ?? {}),
    }
    return fetchImpl(url, {
      method,
      ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
      ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  /**
   * 订阅线程事件。
   *
   * 每次调用建立独立 SSE 连接（不做跨组件共享，见文件头说明）。
   * 监听者抛错被隔离，不影响传输层。
   */
  const subscribe: HarnessClient['subscribe'] = (threadId, listener, subscribeOptions) => {
    const includeSnapshot = subscribeOptions?.includeSnapshot !== false
    const eventsUrl = `${threadUrl(threadId)}/events${includeSnapshot ? '' : '?snapshot=false'}`
    let listening = true
    let connection: { close: () => void } | undefined

    const notify = (event: HarnessClientEvent) => {
      if (!listening) return
      try {
        listener(event)
      } catch (error) {
        console.error('[huan-react] Listener threw an error', error)
      }
    }

    connection = createHarnessEventStreamConnection({
      url: eventsUrl,
      expectedThreadId: threadId,
      // includeSnapshot=false 的订阅在断线后要切回带快照的 URL 才能恢复
      ...(!includeSnapshot && { snapshotRecoveryUrl: `${threadUrl(threadId)}/events` }),
      fetchImpl,
      ...(headers ? { headers } : {}),
      ...(reconnectDelay ? { reconnectDelay } : {}),
      maxStreamLineLength,
      maxStreamEventLength,
      onError: (error) => {
        if (!isTerminalStreamError(error)) {
          onStreamError?.(error)
          return
        }
        // 终止性错误：解码器限制无法继续重连，投递带外 error 事件后关闭。
        // 监听者（Controller）据此重置订阅状态，使后续 connect() 能重新建立。
        queueMicrotask(() => {
          connection?.close()
          void invokeUserCallback('huan-react', 'onError', onStreamError, error)
          notify({
            type: 'error',
            threadId,
            seq: 0,
            error: (error as Error).message,
            terminal: true,
          })
        })
      },
      onEvent: (event) => {
        notify(event as HarnessClientEvent)
      },
    })

    return () => {
      listening = false
      connection?.close()
    }
  }

  const subscribeHostInteractions: HarnessClient['subscribeHostInteractions'] = (listener) => {
    let closed = false
    const controller = new AbortController()
    const sseDecoder = createHarnessSseDecoder({
      maxLineLength: maxStreamLineLength,
      maxEventLength: maxStreamEventLength,
    })
    const textDecoder = new TextDecoder()
    const wait = reconnectDelay ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1000)))

    const run = async () => {
      while (!closed) {
        try {
          const response = await fetchImpl(`${base}/interactions/events`, {
            headers: { ...(headers ?? {}), accept: 'text/event-stream' },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            throw new Error(`Host interaction stream failed with status ${response.status}`)
          }
          const reader = response.body.getReader()
          try {
            while (!closed) {
              const { value, done } = await reader.read()
              if (done) break
              const chunk = textDecoder.decode(value, { stream: true })
              for (const frame of sseDecoder.push(chunk)) {
                if (frame.event === 'ping' || frame.data === '') continue
                let parsed: unknown
                try {
                  parsed = JSON.parse(frame.data)
                } catch {
                  continue
                }
                if (
                  isRecord(parsed) &&
                  parsed.type === 'snapshot' &&
                  isHostInteractionSnapshot(parsed.snapshot)
                ) {
                  const event: HarnessHostInteractionEvent = {
                    type: 'snapshot',
                    seq: parsed.snapshot.seq,
                    snapshot: parsed.snapshot,
                  }
                  void invokeUserCallback('huan-react', 'onHostInteraction', listener, event)
                }
              }
            }
          } finally {
            reader.releaseLock()
          }
        } catch (error) {
          if (closed || controller.signal.aborted) break
          onStreamError?.(error)
          if (isTerminalStreamError(error)) break
        }
        if (closed) break
        await wait()
      }
    }

    void run()
    return () => {
      closed = true
      controller.abort()
    }
  }

  /**
   * 认证快照订阅。
   *
   * 认证事件频率低，但每个窗口都需要在登录/退出后更新模型目录与宿主状态。
   * 这里用轻量轮询而不是独立 SSE：避免每个窗口再占一条长连接（多窗口下会
   * 挤占浏览器同源连接上限），同时仍保持“首帧 + 后续快照”的订阅语义。
   * 有进行中操作时 1s 轮询，空闲时 2s；断开由调用方取消计时器。
   */
  const subscribeProviderAuth: HarnessClient['subscribeProviderAuth'] = (listener) => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let latestSeq = -1

    const poll = async () => {
      let delay = 2_000
      try {
        const value = await readJson(
          await send(`${base}/provider-auth`, 'GET'),
          'fetching provider auth',
        )
        if (closed) return
        if (!isProviderAuthSnapshot(value)) {
          throw invalidResponse(
            'fetching provider auth',
            'expected a valid provider auth snapshot.',
          )
        }
        if (value.seq !== latestSeq) {
          latestSeq = value.seq
          void invokeUserCallback('huan-react', 'onProviderAuth', listener, {
            type: 'snapshot',
            seq: value.seq,
            snapshot: value,
          } satisfies HarnessProviderAuthStreamEvent)
        }
        const active = value.operations.some(
          (operation) =>
            operation.phase !== 'succeeded' &&
            operation.phase !== 'failed' &&
            operation.phase !== 'cancelled',
        )
        if (active) delay = 1_000
      } catch (error) {
        if (closed) return
        onStreamError?.(error)
      }
      if (!closed) timer = setTimeout(() => void poll(), delay)
    }

    void poll()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
    }
  }

  return {
    getHostInfo: async () => {
      const value = await readJson(await send(`${base}/host`, 'GET'), 'fetching host information')
      if (!isHostInfo(value))
        throw invalidResponse('fetching host information', 'expected valid host information.')
      return value
    },

    getHostInteractions: async () => {
      const value = await readJson(
        await send(`${base}/interactions`, 'GET'),
        'fetching host interactions',
      )
      if (!isHostInteractionSnapshot(value)) {
        throw invalidResponse(
          'fetching host interactions',
          'expected a valid interaction snapshot.',
        )
      }
      return value
    },

    subscribeHostInteractions,

    getProviderAuth: async () => {
      const value = await readJson(
        await send(`${base}/provider-auth`, 'GET'),
        'fetching provider auth',
      )
      if (!isProviderAuthSnapshot(value)) {
        throw invalidResponse('fetching provider auth', 'expected a valid provider auth snapshot.')
      }
      return value
    },

    subscribeProviderAuth,

    startProviderLogin: async (input) => {
      const value = await readJson(
        await send(`${base}/provider-auth/login`, 'POST', input),
        'starting provider login',
      )
      if (!isProviderAuthStartResult(value)) {
        throw invalidResponse('starting provider login', 'expected a valid login start result.')
      }
      return value as HarnessProviderAuthStartResult
    },

    respondProviderAuthPrompt: async (input) => {
      const value = await readJson(
        await send(`${base}/provider-auth/respond`, 'POST', input),
        'responding to provider auth',
      )
      if (!isProviderAuthRespondResult(value)) {
        throw invalidResponse(
          'responding to provider auth',
          'expected a valid auth response result.',
        )
      }
      return value as HarnessProviderAuthRespondResult
    },

    cancelProviderAuth: async (operationId) => {
      const value = await readJson(
        await send(`${base}/provider-auth/cancel`, 'POST', { operationId }),
        'cancelling provider auth',
      )
      if (!isProviderAuthCancelResult(value)) {
        throw invalidResponse('cancelling provider auth', 'expected a valid cancel result.')
      }
      return value as HarnessProviderAuthCancelResult
    },

    logoutProvider: async (providerId) => {
      const value = await readJson(
        await send(`${base}/provider-auth/logout`, 'POST', { providerId }),
        'logging out provider',
      )
      if (!isProviderAuthStartResult(value)) {
        throw invalidResponse('logging out provider', 'expected a valid logout start result.')
      }
      return value as HarnessProviderAuthStartResult
    },

    getMcp: async (input: HarnessMcpTargetInput) => {
      const query = configTargetQuery(input)
      const value = await readJson(await send(`${base}/mcp?${query}`, 'GET'), 'reading MCP')
      if (!isMcpSnapshot(value)) {
        throw invalidResponse('reading MCP', 'expected a valid MCP snapshot.')
      }
      return value as HarnessMcpSnapshot
    },

    getMcpDetails: async (input: HarnessMcpDetailsInput) => {
      const value = await readJson(
        await send(`${base}/mcp/details`, 'POST', input),
        'reading MCP details',
      )
      if (!isMcpDetailsResult(value)) {
        throw invalidResponse('reading MCP details', 'expected a valid MCP details result.')
      }
      return value as HarnessMcpDetailsResult
    },

    getMcpConfig: async (input: HarnessMcpTargetInput) => {
      const query = configTargetQuery(input)
      const value = await readJson(
        await send(`${base}/mcp/config?${query}`, 'GET'),
        'reading MCP config',
      )
      if (!isMcpConfigSnapshot(value)) {
        throw invalidResponse('reading MCP config', 'expected a valid MCP config snapshot.')
      }
      return value as HarnessMcpConfigSnapshot
    },

    saveMcpConfig: async (input: HarnessMcpConfigSaveInput) => {
      const value = await readJson(
        await send(`${base}/mcp/config`, 'PUT', input),
        'saving MCP config',
      )
      if (!isMcpConfigSaveResult(value)) {
        throw invalidResponse('saving MCP config', 'expected a valid MCP config save result.')
      }
      return value as HarnessMcpConfigSaveResult
    },

    manageMcp: async (input: HarnessMcpManageInput) => {
      const value = await readJson(await send(`${base}/mcp/manage`, 'POST', input), 'managing MCP')
      if (!isMcpManageResult(value)) {
        throw invalidResponse('managing MCP', 'expected a valid MCP manage result.')
      }
      return value as HarnessMcpManageResult
    },

    getMcpAuth: async () => {
      const value = await readJson(await send(`${base}/mcp/auth`, 'GET'), 'reading MCP auth')
      if (!isMcpAuthSnapshot(value)) {
        throw invalidResponse('reading MCP auth', 'expected a valid MCP auth snapshot.')
      }
      return value as HarnessMcpAuthSnapshot
    },

    startMcpLogin: async (input: HarnessMcpAuthStartInput) => {
      const value = await readJson(
        await send(`${base}/mcp/auth/login`, 'POST', input),
        'starting MCP login',
      )
      if (!isMcpAuthStartResult(value)) {
        throw invalidResponse('starting MCP login', 'expected a valid MCP login start result.')
      }
      return value as HarnessMcpAuthStartResult
    },

    respondMcpAuth: async (input: HarnessMcpAuthRespondInput) => {
      const value = await readJson(
        await send(`${base}/mcp/auth/respond`, 'POST', input),
        'responding to MCP auth',
      )
      if (!isMcpAuthRespondResult(value)) {
        throw invalidResponse(
          'responding to MCP auth',
          'expected a valid MCP auth response result.',
        )
      }
      return value as HarnessMcpAuthRespondResult
    },

    cancelMcpAuth: async (operationId) => {
      const value = await readJson(
        await send(`${base}/mcp/auth/cancel`, 'POST', { operationId }),
        'cancelling MCP auth',
      )
      if (!isMcpAuthCancelResult(value)) {
        throw invalidResponse('cancelling MCP auth', 'expected a valid MCP auth cancel result.')
      }
      return value as HarnessMcpAuthCancelResult
    },

    logoutMcp: async (input: HarnessMcpAuthStartInput) => {
      const value = await readJson(
        await send(`${base}/mcp/auth/logout`, 'POST', input),
        'logging out MCP',
      )
      if (!isMcpAuthStartResult(value)) {
        throw invalidResponse('logging out MCP', 'expected a valid MCP logout start result.')
      }
      return value as HarnessMcpAuthStartResult
    },

    respondToHostInteraction: async (response) => {
      const value = await readJson(
        await send(`${base}/interactions/respond`, 'POST', { response }),
        'responding to a host interaction',
      )
      if (!isRecord(value) || typeof value.accepted !== 'boolean') {
        throw invalidResponse(
          'responding to a host interaction',
          'expected an object with boolean "accepted".',
        )
      }
      return { accepted: value.accepted } as HarnessHostInteractionAnswer
    },

    consumeHostUiDirective: async (threadId, directiveId, consumeOptions) => {
      const value = await readJson(
        await send(
          `${threadUrl(threadId)}/host-ui/consume`,
          'POST',
          { id: directiveId },
          {
            headers: { 'x-huan-caller': consumeOptions?.callerId ?? callerId ?? '' },
          },
        ),
        'consuming a host UI directive',
      )
      if (!isRecord(value) || typeof value.accepted !== 'boolean') {
        throw invalidResponse('consuming a host UI directive', 'expected boolean accepted.')
      }
      return value.accepted
    },

    listWorkspaces: async () => {
      const value = await readJson(await send(`${base}/workspaces`, 'GET'), 'listing workspaces')
      if (!isWorkspaceCatalog(value)) {
        throw invalidResponse('listing workspaces', 'expected a valid workspace catalog.')
      }
      return value
    },

    createWorkspace: async (input) => {
      const value = await readJson(
        await send(`${base}/workspaces`, 'POST', input),
        'creating a workspace',
      )
      if (!isWorkspaceMutationResult(value)) {
        throw invalidResponse('creating a workspace', 'expected a workspace mutation result.')
      }
      return value
    },

    updateWorkspace: async (input) => {
      const value = await readJson(
        await send(`${base}/workspaces/${encodeURIComponent(input.workspaceId)}`, 'PATCH', {
          expectedRevision: input.expectedRevision,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.projects !== undefined ? { projects: input.projects } : {}),
        }),
        'updating a workspace',
      )
      if (!isWorkspaceMutationResult(value)) {
        throw invalidResponse('updating a workspace', 'expected a workspace mutation result.')
      }
      return value
    },

    assignThreadWorkspace: async (input) => {
      const value = await readJson(
        await send(`${threadUrl(input.threadId)}/workspace`, 'POST', {
          workspaceId: input.workspaceId,
        }),
        'assigning a thread workspace',
      )
      if (!isAssignThreadResult(value)) {
        throw invalidResponse(
          'assigning a thread workspace',
          'expected a thread assignment result.',
        )
      }
      return value as Awaited<ReturnType<HarnessClient['assignThreadWorkspace']>>
    },

    listThreads: async (input) => {
      const params = new URLSearchParams()
      if (input?.workspaceId) params.set('workspaceId', input.workspaceId)
      if (input?.unassigned) params.set('unassigned', 'true')
      if (input?.includeArchived) params.set('includeArchived', 'true')
      // 显式刷新清除宿主作用域缓存并重新扫描（外部 Pi 改动可见）。
      if (input?.refresh) params.set('refresh', 'true')
      const query = params.toString()
      return parseThreadListResponse(
        await readJson(
          await send(`${base}/threads${query ? `?${query}` : ''}`, 'GET'),
          'listing threads',
        ),
      )
    },

    createThread: async (input, createOptions) =>
      parseThreadSnapshotResponse(
        await readJson(
          await send(`${base}/threads`, 'POST', input ?? {}, {
            headers: { 'x-huan-caller': createOptions?.callerId ?? callerId ?? '' },
          }),
          'creating a thread',
        ),
        'creating a thread',
      ),

    getThread: async (threadId) =>
      parseThreadSnapshotResponse(
        await readJson(await send(threadUrl(threadId), 'GET'), 'fetching a thread'),
        'fetching a thread',
      ),

    getThreadDetails: async (threadId) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/details`, 'GET'),
        'fetching thread details',
      )
      if (!isThreadDetails(value)) {
        throw invalidResponse(
          'fetching thread details',
          'expected metadata, accumulated stats and an optional context usage.',
        )
      }
      return value
    },

    getThreadTree: async (threadId) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/tree`, 'GET'),
        'fetching a thread tree',
      )
      if (!isThreadTree(value)) {
        throw invalidResponse(
          'fetching a thread tree',
          'expected a valid tree revision, leaf and nodes.',
        )
      }
      return value as HarnessThreadTree
    },

    navigateThreadTree: async (threadId, input: HarnessTreeNavigateInput) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/tree/navigate`, 'POST', input),
        'navigating a thread tree',
      )
      if (!isTreeNavigateResult(value)) {
        throw invalidResponse(
          'navigating a thread tree',
          'expected a valid navigation status and optional snapshot.',
        )
      }
      return value as HarnessTreeNavigateResult
    },

    setThreadEntryLabel: async (threadId, input: HarnessTreeLabelInput) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/tree/label`, 'POST', input),
        'setting a thread entry label',
      )
      if (!isTreeLabelResult(value)) {
        throw invalidResponse('setting a thread entry label', 'expected a valid label result.')
      }
      return value as HarnessTreeLabelResult
    },

    cancelThreadTreeNavigation: async (threadId) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/tree/cancel`, 'POST'),
        'cancelling tree navigation',
      )
      if (!isTreeCancelResult(value)) {
        throw invalidResponse('cancelling tree navigation', 'expected a valid cancel status.')
      }
      return value
    },

    forkThread: async (threadId, input: HarnessThreadForkInput) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/fork`, 'POST', input),
        'forking a thread',
      )
      if (!isThreadForkResult(value)) {
        throw invalidResponse(
          'forking a thread',
          'expected a valid fork status and optional child snapshot.',
        )
      }
      return value as HarnessThreadForkResult
    },

    previewThreadImport: async (input: HarnessThreadImportPreviewInput) => {
      const value = await readJson(
        await send(`${base}/threads/import/preview`, 'POST', input),
        'previewing a thread import',
      )
      if (!isThreadImportPreview(value)) {
        throw invalidResponse('previewing a thread import', 'expected a valid import preview.')
      }
      return value as HarnessThreadImportPreview
    },

    importThread: async (input: HarnessThreadImportInput) => {
      const value = await readJson(
        await send(`${base}/threads/import`, 'POST', input),
        'importing a thread',
      )
      if (!isThreadImportResult(value)) {
        throw invalidResponse('importing a thread', 'expected a valid import result.')
      }
      return value as HarnessThreadImportResult
    },

    getSettings: async (input) => {
      const query = configTargetQuery(input)
      const value = await readJson(
        await send(`${base}/settings?${query}`, 'GET'),
        'reading settings',
      )
      return parseSettingsSnapshotResponse(value, 'reading settings')
    },

    saveSettings: async (input: HarnessSettingsSaveInput) => {
      const value = await readJson(await send(`${base}/settings`, 'PUT', input), 'saving settings')
      return parseSettingsSaveResponse(value)
    },

    reloadResources: async (input) => {
      // 与设置/资源路由同形：目标放在 target 对象里，触发来源单独传递。
      const { trigger, ...target } = input
      const value = await readJson(
        await send(`${base}/reload`, 'POST', {
          target,
          ...(trigger ? { trigger } : {}),
        }),
        'reloading resources',
      )
      return parseReloadResultResponse(value)
    },

    getResources: async (input: HarnessResourceQueryInput) => {
      const query = configTargetQuery(input)
      const value = await readJson(
        await send(
          `${base}/resources?${query}${input.includeText ? '&includeText=true' : ''}`,
          'GET',
        ),
        'reading resources',
      )
      return parseResourceSnapshotResponse(value)
    },

    listCommands: async (input) => {
      const params = new URLSearchParams()
      if (input?.threadId) params.set('threadId', input.threadId)
      if (input?.workspacePath) params.set('workspacePath', input.workspacePath)
      const query = params.size ? `?${params.toString()}` : ''
      return parseCommandCatalogResponse(
        await readJson(await send(`${base}/commands${query}`, 'GET'), 'listing commands'),
      )
    },

    getCommandArgumentCompletions: async (
      input: HarnessCommandArgumentInput,
      options?: { signal?: AbortSignal },
    ) =>
      parseCommandArgumentsResponse(
        await readJson(
          await send(
            `${base}/commands/arguments`,
            'POST',
            input,
            options?.signal ? { signal: options.signal } : undefined,
          ),
          'completing command arguments',
        ),
      ),

    searchFiles: async (input: HarnessFileSearchInput, options?: { signal?: AbortSignal }) =>
      parseFileSearchResponse(
        await readJson(
          await send(
            `${base}/files`,
            'POST',
            input,
            options?.signal ? { signal: options.signal } : undefined,
          ),
          'searching files',
        ),
      ),

    sendMessage: async (
      threadId,
      input: HarnessSendMessageInput,
      sendOptions?: HarnessSendMessageOptions,
    ) =>
      parseSendMessageResult(
        await readJson(
          await send(
            `${threadUrl(threadId)}/messages`,
            'POST',
            { input },
            callerId || sendOptions?.callerId
              ? { headers: { 'x-huan-caller': sendOptions?.callerId ?? callerId ?? '' } }
              : undefined,
          ),
          'sending a message',
        ),
      ),

    cancelRun: async (threadId) => {
      await assertOk(await send(`${threadUrl(threadId)}/cancel`, 'POST'))
    },

    runThreadBash: async (threadId, input) =>
      parseBashStartResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/bash`, 'POST', {
            command: input.command,
            ...(input.excludeFromContext === true ? { excludeFromContext: true } : {}),
          }),
          'starting a shell command',
        ),
      ),

    abortThreadBash: async (threadId) =>
      parseBashAbortResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/bash/abort`, 'POST'),
          'aborting a shell command',
        ),
      ),

    compactThread: async (threadId, input) =>
      parseCompactionOutcome(
        await readJson(
          await send(`${threadUrl(threadId)}/compact`, 'POST', {
            ...(input?.customInstructions ? { customInstructions: input.customInstructions } : {}),
          }),
          'compacting a thread',
        ),
      ),

    abortThreadCompaction: async (threadId) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/compact/abort`, 'POST'),
        'aborting compaction',
      )
      if (!isCompactionAbortResult(value)) {
        throw invalidResponse('aborting compaction', 'expected status requested or idle.')
      }
      return value
    },

    setAutoCompaction: async (threadId, enabled) =>
      parseAutoCompactionResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/auto-compaction`, 'POST', { enabled }),
          'updating auto compaction',
        ),
      ),

    getThreadModelScope: async (threadId) =>
      parseModelScopeResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/model-scope`, 'GET'),
          'reading a model scope',
        ),
      ),

    setThreadModelScope: async (threadId, input) =>
      parseModelScopeUpdateResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/model-scope`, 'POST', {
            patterns: [...input.patterns],
            ...(input.saveAsDefault === true ? { saveAsDefault: true } : {}),
          }),
          'updating a model scope',
        ),
      ),

    refreshModels: async (input) =>
      parseModelRefreshResponse(
        await readJson(
          await send(`${base}/models/refresh`, 'POST', {
            ...(input?.threadId ? { threadId: input.threadId } : {}),
            ...(input?.workspacePath ? { workspacePath: input.workspacePath } : {}),
          }),
          'refreshing models',
        ),
      ),

    clearQueue: async (threadId) =>
      parseClearQueueResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/queue/clear`, 'POST'),
          'clearing a thread queue',
        ),
      ),

    checkProjectPath: async (path) =>
      parseProjectPathCheck(
        await readJson(
          await send(`${base}/projects/check`, 'POST', { path }),
          'checking a project path',
        ),
      ),

    getProject: async (input) => {
      const params = new URLSearchParams({ path: input.path })
      return parseProjectInfo(
        await readJson(
          await send(`${base}/projects/info?${params.toString()}`, 'GET'),
          'fetching a project',
        ),
      )
    },

    inspectProjectTrust: async (input) => {
      const params = new URLSearchParams({ path: input.path })
      return parseProjectInfo(
        await readJson(
          await send(`${base}/projects/trust-summary?${params.toString()}`, 'GET'),
          'fetching project trust summary',
        ),
      )
    },

    decideProjectTrust: async (input: HarnessProjectTrustInput) =>
      parseProjectInfo(
        await readJson(
          await send(`${base}/projects/trust`, 'POST', input),
          'deciding project trust',
        ),
      ),

    listRecentProjects: async () =>
      parseRecentProjects(
        await readJson(await send(`${base}/projects`, 'GET'), 'listing recent projects'),
      ),

    getAvailableModels: async (input) => {
      const params = new URLSearchParams()
      if (input?.workspacePath) params.set('workspacePath', input.workspacePath)
      const query = params.toString()
      return parseModelListResponse(
        await readJson(
          await send(`${base}/models${query ? `?${query}` : ''}`, 'GET'),
          'listing models',
        ),
      )
    },

    setModel: async (threadId, input) => {
      await assertOk(await send(`${threadUrl(threadId)}/model`, 'POST', input))
    },

    setThinkingLevel: async (threadId, level: HarnessThinkingLevel) => {
      await assertOk(await send(`${threadUrl(threadId)}/thinking`, 'POST', { level }))
    },

    renameThread: async (threadId, title) => {
      await assertOk(await send(threadUrl(threadId), 'PATCH', { title }))
    },

    archiveThread: async (threadId) => {
      await assertOk(await send(`${threadUrl(threadId)}/archive`, 'POST'))
    },

    unarchiveThread: async (threadId) => {
      await assertOk(await send(`${threadUrl(threadId)}/unarchive`, 'POST'))
    },

    deleteThread: async (threadId) => {
      const response = await send(threadUrl(threadId), 'DELETE')
      if (response.status === 404) return
      await assertOk(response)
    },

    respondToHostUiRequest: async (threadId, response: HarnessHostUiResponse) => {
      await assertOk(await send(`${threadUrl(threadId)}/host-ui`, 'POST', { response }))
    },

    subscribe,
  }
}
