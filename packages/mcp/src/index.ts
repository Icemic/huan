/**
 * @huan/mcp：独立 MCP 配置与（后续）运行时的 Node 集成层。
 *
 * G1.4d1 只交付隔离配置基础：固定路径、解析/合并、逐项诊断、有界读取与
 * 安全整份保存。不连接服务器、不执行 `!command`、不访问网络、不读写 Pi 的
 * mcp.json / mcp-auth.json / mcp.log，也不预建连接或工具架构。
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
} from './config.js'
export {
  configDocumentFromRead,
  getMcpToolExposure,
  isMcpServerConfigOverride,
  isValidMcpServerName,
  loadMcpConfig,
  MCP_CONFIG_MAX_DEPTH,
  MCP_SERVER_OVERRIDE_KEYS,
  mcpNamespace,
  mergeMcpConfigDocuments,
  parseMcpConfigContent,
  resolveMcpExposureAlias,
  validateMcpServerConfig,
} from './config.js'
export type { McpConfigRead } from './file-io.js'
export {
  MCP_CONFIG_FILE_MAX_BYTES,
  mcpConfigContentIsEncodable,
  mcpConfigRevision,
} from './file-io.js'
export type { McpConfigPaths } from './paths.js'
export {
  MCP_AUTH_FILE_NAME,
  MCP_CONFIG_FILE_NAME,
  MCP_LOG_FILE_NAME,
  MCP_PROJECT_CONFIG_DIR,
  MCP_USER_CONFIG_DIR,
  mcpConfigPaths,
} from './paths.js'
export type {
  McpConfigFileState,
  McpConfigReadOptions,
  McpConfigSaveInput,
  McpConfigSaveResult,
  McpConfigStore,
  McpConfigStoreOptions,
} from './store.js'
export { createMcpConfigStore } from './store.js'
