import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主运行配置：端口、工作目录与安全参数。 */
export type ServerConfig = {
  port: number
  /** Agent 操作的工作目录 */
  workspacePath: string
  /** Pi agent 配置目录；未设置时使用 Pi 默认（~/.pi/agent） */
  agentDir: string | undefined
  /** 允许的 Host（防 DNS rebinding；含直连与经 Vite 代理两种形态） */
  allowedHosts: readonly string[]
  /** 允许的来源（Vite dev server） */
  allowedOrigins: readonly string[]
  /** 访问凭证；空字符串表示不校验（仅限受控环境） */
  token: string
}

/** 解析端口：非整数或越界时带变量名报错，避免静默监听随机端口。 */
function parsePort(raw: string | undefined): number {
  const value = Number(raw ?? 8788)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`HUAN_PORT 无效："${raw}"（需为 1-65535 的整数）`)
  }
  return value
}

/** 读取环境变量构建配置；工作目录默认指向仓库内的测试沙箱目录。 */
export function loadConfig(): ServerConfig {
  const workspacePath = process.env.HUAN_WORKSPACE
    ? resolve(process.env.HUAN_WORKSPACE)
    : resolve(appRoot, '../../tmp/agent-workspace')
  const port = parsePort(process.env.HUAN_PORT)

  return {
    port,
    workspacePath,
    agentDir: process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir(),
    allowedHosts: (
      process.env.HUAN_ALLOWED_HOSTS ??
      // 默认放行两种形态：经 Vite 代理（8799）与直连宿主（当前端口）。
      `localhost:8799,127.0.0.1:8799,localhost:${port},127.0.0.1:${port}`
    )
      .split(',')
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
    allowedOrigins: (
      process.env.HUAN_ALLOWED_ORIGINS ?? 'http://localhost:8799,http://127.0.0.1:8799'
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    token: process.env.HUAN_TOKEN ?? '',
  }
}
