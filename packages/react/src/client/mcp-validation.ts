/**
 * MCP 客户端载荷形状守卫（G1.4d3）。
 *
 * HTTP/宿主返回不可信；这里只接受页面会读取的受控字段，畸形响应在进入
 * Controller/UI 前被拒绝。守卫不解析配置内容，也不把任何秘密当作可展示字段。
 */
import type {
  HarnessMcpAuthCancelResult,
  HarnessMcpAuthOperation,
  HarnessMcpAuthRespondResult,
  HarnessMcpAuthSnapshot,
  HarnessMcpAuthStartResult,
  HarnessMcpConfigSaveResult,
  HarnessMcpConfigSnapshot,
  HarnessMcpDetailsResult,
  HarnessMcpManageResult,
  HarnessMcpServerSummary,
  HarnessMcpSnapshot,
} from '@huan/protocol'
import { isRecord } from '../vendor/anti-corruption.js'

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'
const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || typeof value === 'number'
const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean'

const isExposure = (value: unknown): boolean =>
  value === 'codemode' || value === 'deferred' || value === 'direct' || value === 'hidden'

const isTarget = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === 'session' || value.kind === 'workspace') &&
  typeof value.workspacePath === 'string' &&
  isOptionalString(value.threadId) &&
  (value.kind !== 'session' || typeof value.threadId === 'string')

const isTrust = (value: unknown): boolean =>
  isRecord(value) &&
  (value.decision === 'trusted' ||
    value.decision === 'untrusted' ||
    value.decision === 'needs-trust') &&
  typeof value.requiresTrust === 'boolean' &&
  typeof value.origin === 'string'

const isIssue = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  (value.scope === 'user' || value.scope === 'project') &&
  typeof value.file === 'string' &&
  isOptionalString(value.server) &&
  typeof value.message === 'string'

const isIssueArray = (value: unknown): boolean => Array.isArray(value) && value.every(isIssue)

const isConfigFile = (value: unknown): boolean =>
  isRecord(value) &&
  (value.scope === 'user' || value.scope === 'project') &&
  typeof value.path === 'string' &&
  typeof value.readable === 'boolean' &&
  typeof value.exists === 'boolean' &&
  typeof value.content === 'string' &&
  (value.revision === null || typeof value.revision === 'string') &&
  typeof value.bytes === 'number' &&
  typeof value.tooLarge === 'boolean' &&
  isIssueArray(value.issues) &&
  isOptionalString(value.readError)

const isConfiguredServer = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.identity === 'string' &&
  (value.scope === 'user' || value.scope === 'project') &&
  typeof value.override === 'boolean' &&
  typeof value.enabled === 'boolean' &&
  isExposure(value.exposure)

export const isMcpConfigSnapshot = (value: unknown): value is HarnessMcpConfigSnapshot =>
  isRecord(value) &&
  isTarget(value.target) &&
  typeof value.projectTrusted === 'boolean' &&
  isTrust(value.trust) &&
  isRecord(value.files) &&
  isConfigFile(value.files.user) &&
  isConfigFile(value.files.project) &&
  isRecord(value.effective) &&
  isOptionalBoolean(value.effective.autoEnableCodemode) &&
  Array.isArray(value.effective.servers) &&
  value.effective.servers.every(isConfiguredServer) &&
  isIssueArray(value.effective.issues)

const isApplyState = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.persisted === 'boolean' &&
  typeof value.reloadRequired === 'boolean' &&
  typeof value.message === 'string'

export const isMcpConfigSaveResult = (value: unknown): value is HarnessMcpConfigSaveResult => {
  if (!isRecord(value) || (value.scope !== 'user' && value.scope !== 'project')) return false
  if (value.status === 'saved') {
    return (
      typeof value.path === 'string' &&
      typeof value.revision === 'string' &&
      typeof value.bytes === 'number' &&
      isMcpConfigSnapshot(value.snapshot) &&
      isApplyState(value.apply)
    )
  }
  if (value.status === 'conflict') {
    return (
      typeof value.path === 'string' &&
      (value.revision === null || typeof value.revision === 'string') &&
      typeof value.message === 'string'
    )
  }
  if (value.status === 'invalid') {
    return (
      typeof value.path === 'string' &&
      isIssueArray(value.issues) &&
      typeof value.message === 'string'
    )
  }
  if (value.status === 'too-large') {
    return (
      typeof value.path === 'string' &&
      typeof value.limitBytes === 'number' &&
      typeof value.message === 'string'
    )
  }
  if (value.status === 'untrusted' || value.status === 'failed') {
    return typeof value.path === 'string' && typeof value.message === 'string'
  }
  return false
}

const isServerAuth = (value: unknown): boolean =>
  isRecord(value) &&
  (value.kind === 'oauth' ||
    value.kind === 'static-header' ||
    value.kind === 'provider' ||
    value.kind === 'stdio') &&
  typeof value.loginable === 'boolean' &&
  typeof value.hasCredentials === 'boolean' &&
  typeof value.needsRefresh === 'boolean'

const isServerSummary = (value: unknown): value is HarnessMcpServerSummary =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.identity === 'string' &&
  (value.scope === 'user' || value.scope === 'project' || value.scope === 'extension') &&
  typeof value.override === 'boolean' &&
  typeof value.enabled === 'boolean' &&
  isExposure(value.exposure) &&
  typeof value.state === 'string' &&
  typeof value.toolCount === 'number' &&
  typeof value.hasResources === 'boolean' &&
  typeof value.toolRevision === 'number' &&
  isServerAuth(value.auth) &&
  (value.error === undefined ||
    (isRecord(value.error) &&
      typeof value.error.code === 'string' &&
      typeof value.error.message === 'string'))

export const isMcpSnapshot = (value: unknown): value is HarnessMcpSnapshot =>
  isRecord(value) &&
  isTarget(value.target) &&
  typeof value.live === 'boolean' &&
  (value.runtime === undefined ||
    (isRecord(value.runtime) &&
      typeof value.runtime.runtimeId === 'string' &&
      typeof value.runtime.revision === 'number' &&
      typeof value.runtime.started === 'boolean' &&
      typeof value.runtime.closed === 'boolean')) &&
  typeof value.projectTrusted === 'boolean' &&
  isTrust(value.trust) &&
  Array.isArray(value.servers) &&
  value.servers.every(isServerSummary) &&
  (value.issues === undefined || isIssueArray(value.issues))

const isTool = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  isOptionalString(value.title) &&
  isOptionalString(value.description) &&
  isRecord(value.inputSchema) &&
  (value.outputSchema === undefined || isRecord(value.outputSchema)) &&
  (value.annotations === undefined || isRecord(value.annotations)) &&
  (value.execution === undefined || isRecord(value.execution)) &&
  (value._meta === undefined || isRecord(value._meta)) &&
  isExposure(value.exposure)

const isResource = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.uri === 'string' &&
  typeof value.name === 'string' &&
  isOptionalString(value.title) &&
  isOptionalString(value.description) &&
  isOptionalString(value.mimeType) &&
  isOptionalNumber(value.size) &&
  (value.annotations === undefined || isRecord(value.annotations)) &&
  (value._meta === undefined || isRecord(value._meta))

const isTemplate = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.uriTemplate === 'string' &&
  typeof value.name === 'string' &&
  isOptionalString(value.title) &&
  isOptionalString(value.description) &&
  isOptionalString(value.mimeType) &&
  (value.annotations === undefined || isRecord(value.annotations)) &&
  (value._meta === undefined || isRecord(value._meta))

export const isMcpDetailsResult = (value: unknown): value is HarnessMcpDetailsResult => {
  if (!isRecord(value)) return false
  if (value.status === 'ok') {
    return (
      isRecord(value.details) &&
      isTarget(value.details.target) &&
      typeof value.details.runtimeId === 'string' &&
      isRecord(value.details.server) &&
      typeof value.details.server.name === 'string' &&
      typeof value.details.server.identity === 'string' &&
      typeof value.details.server.state === 'string' &&
      isExposure(value.details.server.exposure) &&
      typeof value.details.server.toolRevision === 'number' &&
      isOptionalString(value.details.instructions) &&
      (value.details.tools === undefined ||
        (Array.isArray(value.details.tools) && value.details.tools.every(isTool))) &&
      (value.details.resources === undefined ||
        (Array.isArray(value.details.resources) && value.details.resources.every(isResource))) &&
      (value.details.resourceTemplates === undefined ||
        (Array.isArray(value.details.resourceTemplates) &&
          value.details.resourceTemplates.every(isTemplate)))
    )
  }
  return (
    (value.status === 'busy' ||
      value.status === 'stale' ||
      value.status === 'unavailable' ||
      value.status === 'failed' ||
      value.status === 'invalid') &&
    typeof value.message === 'string'
  )
}

export const isMcpManageResult = (value: unknown): value is HarnessMcpManageResult => {
  if (!isRecord(value)) return false
  if (value.status === 'applied') return isMcpSnapshot(value.snapshot)
  return (
    (value.status === 'busy' ||
      value.status === 'stale' ||
      value.status === 'unavailable' ||
      value.status === 'failed' ||
      value.status === 'invalid') &&
    typeof value.message === 'string'
  )
}

const isAuthPhase = (value: unknown): boolean =>
  value === 'starting' ||
  value === 'waiting' ||
  value === 'prompt' ||
  value === 'verifying' ||
  value === 'cancelling' ||
  value === 'succeeded' ||
  value === 'failed' ||
  value === 'cancelled'

const isAuthPrompt = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.promptId === 'string' &&
  value.kind === 'redirect_url' &&
  typeof value.message === 'string' &&
  isOptionalString(value.placeholder)

const isAuthResult = (value: unknown): boolean =>
  isRecord(value) &&
  (value.status === 'succeeded' || value.status === 'failed' || value.status === 'cancelled') &&
  isOptionalString(value.code) &&
  typeof value.message === 'string' &&
  isOptionalBoolean(value.retryable) &&
  (value.reconnect === undefined ||
    value.reconnect === 'started' ||
    value.reconnect === 'deferred' ||
    value.reconnect === 'not-live')

const isAuthOperation = (value: unknown): value is HarnessMcpAuthOperation =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.server === 'string' &&
  typeof value.identity === 'string' &&
  (value.kind === 'login' || value.kind === 'logout') &&
  isAuthPhase(value.phase) &&
  isTarget(value.target) &&
  typeof value.runtimeId === 'string' &&
  typeof value.startedAt === 'string' &&
  typeof value.updatedAt === 'string' &&
  isOptionalString(value.authUrl) &&
  (value.prompt === undefined || isAuthPrompt(value.prompt)) &&
  (value.result === undefined || isAuthResult(value.result))

export const isMcpAuthSnapshot = (value: unknown): value is HarnessMcpAuthSnapshot =>
  isRecord(value) &&
  typeof value.seq === 'number' &&
  typeof value.authRevision === 'number' &&
  Array.isArray(value.operations) &&
  value.operations.every(isAuthOperation)

export const isMcpAuthStartResult = (value: unknown): value is HarnessMcpAuthStartResult => {
  if (!isRecord(value)) return false
  if (value.status === 'started') return isAuthOperation(value.operation)
  if (value.status === 'busy') {
    return (
      (value.operation === undefined || isAuthOperation(value.operation)) &&
      isOptionalString(value.message)
    )
  }
  if (value.status === 'stale' || value.status === 'unavailable' || value.status === 'invalid') {
    return typeof value.message === 'string'
  }
  return false
}

export const isMcpAuthRespondResult = (value: unknown): value is HarnessMcpAuthRespondResult => {
  if (!isRecord(value)) return false
  if (value.status === 'accepted' || value.status === 'stale') return true
  return value.status === 'invalid' && typeof value.message === 'string'
}

export const isMcpAuthCancelResult = (value: unknown): value is HarnessMcpAuthCancelResult => {
  if (!isRecord(value)) return false
  if (value.status === 'not-found') return true
  return (
    (value.status === 'cancelling' || value.status === 'finished') &&
    isAuthOperation(value.operation)
  )
}
