/**
 * MCP 配置的固定路径（G1.4d1；2026-11-02 改为与 Pi 共享配置）。
 *
 * 用户/项目配置与 Pi 共用同一文件：`<agentDir>/mcp.json` 与 `<cwd>/.pi/mcp.json`，
 * 这样 huan 与 Pi 读到同一套服务器定义。huan 专属的 OAuth 凭据与运行日志仍放在
 * `<agentDir>/huan/` 子目录，不读写 Pi 的同名认证/日志文件。
 */
import { join, resolve } from 'node:path'

/**
 * huan 专属状态目录（相对 agentDir）。
 *
 * 只承载凭据与日志，不是配置目录；配置文件位于 agentDir 本层。
 */
export const MCP_STATE_DIR = 'huan'

/** 项目级 MCP 配置目录（相对 cwd）；与 Pi 相同。 */
export const MCP_PROJECT_CONFIG_DIR = '.pi'

/** MCP 配置文件名；用户/项目与 Pi 共用。 */
export const MCP_CONFIG_FILE_NAME = 'mcp.json'

/** MCP OAuth 凭据文件名（后续连接阶段实现，本阶段只定义路径）。 */
export const MCP_AUTH_FILE_NAME = 'mcp-auth.json'

/** MCP 运行日志文件名（后续连接阶段实现，本阶段只定义路径）。 */
export const MCP_LOG_FILE_NAME = 'mcp.log'

/** MCP 配置与后续运行状态的固定路径集合。 */
export interface McpConfigPaths {
  /** `<agentDir>/mcp.json`，与 Pi 共享。 */
  user: string
  /** `<cwd>/.pi/mcp.json`，与 Pi 共享。 */
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
  const stateDir = join(userRoot, MCP_STATE_DIR)
  return {
    user: join(userRoot, MCP_CONFIG_FILE_NAME),
    project: join(projectRoot, MCP_PROJECT_CONFIG_DIR, MCP_CONFIG_FILE_NAME),
    auth: join(stateDir, MCP_AUTH_FILE_NAME),
    log: join(stateDir, MCP_LOG_FILE_NAME),
  }
}
