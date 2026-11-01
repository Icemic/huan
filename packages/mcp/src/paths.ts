/**
 * MCP 配置的固定路径（G1.4d1）。
 *
 * huan 的 MCP 配置与 Pi 自身的 MCP 配置隔离，不读取、不迁移、不修改
 * `<agentDir>/mcp.json` 或 `<cwd>/.pi/mcp.json`。用户空间锚点仍然复用
 * Pi agentDir，但目录和文件名由 huan 自己固定。
 */
import { join, resolve } from 'node:path'

/** 用户级 MCP 配置目录（相对 agentDir）。 */
export const MCP_USER_CONFIG_DIR = 'huan'

/** 项目级 MCP 配置目录（相对 cwd）。 */
export const MCP_PROJECT_CONFIG_DIR = '.huan'

/** 用户级 MCP 配置文件名。 */
export const MCP_CONFIG_FILE_NAME = 'mcp.json'

/** MCP OAuth 凭据文件名（后续连接阶段实现，本阶段只定义路径）。 */
export const MCP_AUTH_FILE_NAME = 'mcp-auth.json'

/** MCP 运行日志文件名（后续连接阶段实现，本阶段只定义路径）。 */
export const MCP_LOG_FILE_NAME = 'mcp.log'

/** MCP 配置与后续运行状态的固定路径集合。 */
export interface McpConfigPaths {
  /** `<agentDir>/huan/mcp.json` */
  user: string
  /** `<cwd>/.huan/mcp.json` */
  project: string
  /** `<agentDir>/huan/mcp-auth.json`，本阶段不读写。 */
  auth: string
  /** `<agentDir>/huan/mcp.log`，本阶段不读写。 */
  log: string
}

/**
 * 计算固定路径。只接受 agentDir/cwd，不接受任意文件路径。
 */
export function mcpConfigPaths(agentDir: string, cwd: string): McpConfigPaths {
  const userRoot = resolve(agentDir)
  const projectRoot = resolve(cwd)
  const userDir = join(userRoot, MCP_USER_CONFIG_DIR)
  return {
    user: join(userDir, MCP_CONFIG_FILE_NAME),
    project: join(projectRoot, MCP_PROJECT_CONFIG_DIR, MCP_CONFIG_FILE_NAME),
    auth: join(userDir, MCP_AUTH_FILE_NAME),
    log: join(userDir, MCP_LOG_FILE_NAME),
  }
}
