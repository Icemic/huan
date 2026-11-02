/**
 * @huan/mcp：MCP 配置与连接管理的 Node 集成层。
 *
 * G1.4d1 交付配置基础；G1.4d2a 增加每会话独立的连接管理器；G1.4d2b 增加
 * Pi 工具/资源桥接与无界面集成绑定。配置文件与 Pi 共享（`<agentDir>/mcp.json`、
 * `<cwd>/.pi/mcp.json`）；凭据/日志仍在 `<agentDir>/huan/` 下，不读写 Pi 的
 * mcp-auth.json / mcp.log。连接管理器构造无 I/O，显式 start 后使用官方
 * pi-mcp 客户端与 stdio/streamable HTTP transport。
 */

export type { McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent'
export type {
  LoadedMcpConfig,
  LoadMcpConfigOptions,
  McpConfigDocument,
  McpConfigDocumentServer,
  McpConfigIssue,
  McpConfigIssueKind,
  McpConfigScope,
  McpServerEntry,
  McpServerOverrides,
  McpServerScope,
} from './config.js'
export {
  configDocumentFromRead,
  getMcpToolExposure,
  isMcpServerConfigOverride,
  isValidMcpServerName,
  loadMcpConfig,
  MCP_CONFIG_MAX_DEPTH,
  MCP_EXPOSURES,
  MCP_SERVER_OVERRIDE_KEYS,
  mcpNamespace,
  mergeMcpConfigDocuments,
  parseMcpConfigContent,
  resolveMcpExposureAlias,
  validateMcpServerConfig,
} from './config.js'
export type {
  McpCommandRunner,
  McpCommandRunOptions,
  McpValueResolutionErrorCode,
  McpValueResolutionOptions,
} from './config-values.js'
export {
  expandMcpHomePath,
  isMcpCommandValue,
  MCP_COMMAND_MAX_OUTPUT_BYTES,
  MCP_COMMAND_TIMEOUT_MS,
  McpValueResolutionError,
  resolveMcpEnvValues,
  resolveMcpHeaders,
  resolveMcpValue,
  runMcpShellCommand,
} from './config-values.js'
export type {
  McpAuthProviderFactory,
  McpAuthProviderFactoryContext,
  McpAuthProviderHandle,
  McpConnectionError,
  McpConnectionErrorCode,
  McpConnectionSnapshot,
  McpConnectionState,
  McpOperationErrorCode,
  McpServerConnectionOptions,
  McpTransportFactory,
  McpTransportFactoryContext,
} from './connection.js'
export {
  McpOperationError,
  McpServerConnection,
  resolveMcpRequestTimeoutMs,
} from './connection.js'
export type { McpConfigRead } from './file-io.js'
export {
  MCP_CONFIG_FILE_MAX_BYTES,
  mcpConfigContentIsEncodable,
  mcpConfigRevision,
} from './file-io.js'
export type { McpIntegration, McpIntegrationOptions, McpServerListing } from './integration.js'
export {
  createMcpIntegration,
  MAX_SERVER_DESCRIPTION_CHARS,
  MAX_SERVERS_SECTION_CHARS,
  MCP_SERVERS_SECTION,
  renderMcpServersSection,
} from './integration.js'
export type {
  McpConnectionManagerOptions,
  McpConnectionManagerSnapshot,
  McpManagerInputErrorCode,
  McpManagerListener,
  McpServerSnapshot,
  McpToolCatalog,
  McpToolCatalogEntry,
} from './manager.js'
export {
  createMcpConnectionManager,
  McpConnectionManager,
  McpManagerInputError,
} from './manager.js'
export type { McpConfigPaths } from './paths.js'
export {
  MCP_AUTH_FILE_NAME,
  MCP_CONFIG_FILE_NAME,
  MCP_LOG_FILE_NAME,
  MCP_PROJECT_CONFIG_DIR,
  MCP_STATE_DIR,
  mcpConfigPaths,
} from './paths.js'
export type { McpResourceServer } from './resources.js'
export {
  createMcpResourceToolDefinitions,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  LIST_MCP_RESOURCES_TOOL,
  MCP_RESOURCE_TOOL_NAMES,
  READ_MCP_RESOURCE_TOOL,
} from './resources.js'
export type {
  McpConfigFileState,
  McpConfigReadOptions,
  McpConfigSaveInput,
  McpConfigSaveResult,
  McpConfigStore,
  McpConfigStoreOptions,
} from './store.js'
export { createMcpConfigStore } from './store.js'
export type {
  ConvertMcpResultOptions,
  CreateMcpToolDefinitionOptions,
  JsonSchema,
  McpOutputSaver,
  McpToolCaller,
  McpToolDefinition,
  McpToolDetails,
} from './tools.js'
export {
  convertMcpResult,
  createMcpResultSchema,
  createMcpToolDefinition,
  createMcpToolName,
  limitMcpContent,
  MCP_OUTPUT_MAX_BYTES,
  saveToTempFile,
  toModelContent,
  toToolExposure,
} from './tools.js'
