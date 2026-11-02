/**
 * MCP 服务器日志（G1.4d3）。
 *
 * 选择性移植自 `@earendil-works/pi-coding-agent@1.4.0` 的
 * `packages/coding-agent/src/extensions/mcp/log.ts`，来源指纹见
 * `packages/mcp/THIRD-PARTY-NOTICES.md`。
 *
 * 只接收 MCP `notifications/message`，不记录 OAuth 请求、HTTP body/headers 或配置。
 * 与上游同步 append 不同，本实现：
 * - 构造无 I/O；
 * - 所有写入进入有界队列，`write` / `flush` / `close` 都可等待；
 * - 单条消息有界，文件超过上限后轮换到 `<path>.1`；
 * - 新建目录 0700、文件 0600，并拒绝把符号链接当作日志目标；
 * - 写失败只忽略当前消息，不阻塞后续写入，也不让工具调用失败。
 */

import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 默认日志文件轮换上限（5 MiB）。 */
export const MCP_LOG_MAX_BYTES = 5 * 1024 * 1024

/** 单条日志消息的默认字节上限。 */
export const MCP_LOG_MAX_MESSAGE_BYTES = 16 * 1024

/** 队列中最多保留的消息条数与字节数；超出后丢弃新消息，避免内存无界增长。 */
const MAX_PENDING_MESSAGES = 256
const MAX_PENDING_BYTES = 1024 * 1024

/** 日志写入回调；实现可同步忽略返回的 promise。 */
export type McpServerLogSink = (server: string, params: unknown) => void

/** 日志构造选项；测试可缩小上限，生产默认 5 MiB / 16 KiB。 */
export interface McpServerLogOptions {
  maxBytes?: number
  maxMessageBytes?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatData(data: unknown): string {
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data) ?? String(data)
  } catch {
    return String(data)
  }
}

function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/** 按 UTF-8 字节截断一行，确保截断后仍以换行结尾。 */
function boundLine(line: string, maxBytes: number): string {
  const buffer = Buffer.from(line, 'utf8')
  if (buffer.length <= maxBytes) return line
  const suffix = '…[truncated]\n'
  const suffixBytes = Buffer.byteLength(suffix)
  if (maxBytes <= suffixBytes) return '\n'.slice(0, maxBytes)
  let budget = Math.max(0, maxBytes - suffixBytes)
  while (budget > 0 && ((buffer[budget] ?? 0) & 0xc0) === 0x80) budget -= 1
  return `${buffer.subarray(0, budget).toString('utf8')}${suffix}`
}

/**
 * 把一条 `notifications/message` 格式化为日志行。
 *
 * 只读取 `level` / `logger` / `data`；其它字段（包括可能出现的 headers、body、
 * config、token）不会被序列化。续行缩进，单条消息按字节有界。
 */
export function formatMcpLogMessage(
  server: string,
  params: unknown,
  now: Date = new Date(),
  maxMessageBytes: number = MCP_LOG_MAX_MESSAGE_BYTES,
): string {
  const message = isRecord(params) ? params : { data: params }
  const level = singleLine(typeof message.level === 'string' ? message.level : 'info')
  const loggerName = typeof message.logger === 'string' ? singleLine(message.logger) : ''
  const logger = loggerName ? ` ${loggerName}:` : ''
  const text = formatData(message.data).replace(/\r?\n/g, '\n    ')
  const line = `${now.toISOString()} [${singleLine(server)}] ${singleLine(level)}${logger} ${text}\n`
  return boundLine(line, Math.max(1, Math.floor(maxMessageBytes)))
}

interface PendingLine {
  line: string
  bytes: number
  resolve: () => void
}

/**
 * 有界 MCP 日志写入器。
 *
 * 构造只保存路径与上限；第一次 `write` 才会创建目录/文件。多个写入按调用顺序
 * 串行落盘，轮换在追加前完成。写失败不向调用方抛出。
 */
export class McpServerLog {
  readonly path: string
  private readonly maxBytes: number
  private readonly maxMessageBytes: number
  private readonly pending: PendingLine[] = []
  private pendingBytes = 0
  private pumping = false
  private closedValue = false
  private ensured = false
  private readonly idleWaiters = new Set<() => void>()

  constructor(path: string, options: McpServerLogOptions = {}) {
    this.path = path
    const maxBytes = options.maxBytes
    this.maxBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : MCP_LOG_MAX_BYTES
    const maxMessageBytes = options.maxMessageBytes
    const messageLimit =
      typeof maxMessageBytes === 'number' && Number.isFinite(maxMessageBytes) && maxMessageBytes > 0
        ? Math.floor(maxMessageBytes)
        : MCP_LOG_MAX_MESSAGE_BYTES
    // 单条不能超过文件轮换上限，否则当前文件可能永久越界。
    this.maxMessageBytes = Math.min(messageLimit, this.maxBytes)
  }

  /** 入队一条日志；返回的 promise 在该条消息被处理（或丢弃）后完成。 */
  readonly write = (server: string, params: unknown): Promise<void> => {
    if (this.closedValue) return Promise.resolve()
    let line: string
    try {
      line = formatMcpLogMessage(server, params, new Date(), this.maxMessageBytes)
    } catch {
      return Promise.resolve()
    }
    const bytes = Buffer.byteLength(line)
    if (
      this.pending.length >= MAX_PENDING_MESSAGES ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      // 日志是尽力而为；队列有界，溢出时丢弃新消息而不是无限占用内存。
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.pending.push({ line, bytes, resolve })
      this.pendingBytes += bytes
      void this.pump()
    })
  }

  /** 等待当前所有已入队消息处理完毕。 */
  async flush(): Promise<void> {
    if (!this.pumping && this.pending.length === 0) return
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve)
    })
  }

  /** 停止接受新消息，等待队列清空。 */
  async close(): Promise<void> {
    this.closedValue = true
    await this.flush()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const item = this.pending.shift()
        if (!item) break
        this.pendingBytes -= item.bytes
        try {
          await this.append(item.line)
        } catch {
          // 日志写入失败不影响服务器与工具。
        } finally {
          item.resolve()
        }
      }
    } finally {
      this.pumping = false
      if (this.pending.length > 0) {
        // 还有新消息：继续处理，flush 等待者留在下一轮完成。
        void this.pump()
      } else {
        for (const resolve of [...this.idleWaiters]) {
          try {
            resolve()
          } catch {
            // 等待者异常不影响日志。
          }
        }
        this.idleWaiters.clear()
      }
    }
  }

  private async append(line: string): Promise<void> {
    const directory = dirname(this.path)
    if (!this.ensured) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const directoryInfo = await lstat(directory).catch(() => undefined)
      // 目录被换成符号链接/非目录时拒绝写入，避免日志越出 huan 状态目录。
      if (directoryInfo?.isSymbolicLink() || (directoryInfo && !directoryInfo.isDirectory())) {
        return
      }
      await chmod(directory, 0o700).catch(() => undefined)
      this.ensured = true
    }
    const directoryInfo = await lstat(directory).catch(() => undefined)
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return
    const info = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (info?.isSymbolicLink() || (info && !info.isFile())) return

    const lineBytes = Buffer.byteLength(line)
    const current = info ? info.size : 0
    if (current > 0 && current + lineBytes > this.maxBytes) {
      // 轮换到固定后缀；跨进程同时轮换只当作尽力而为。
      await rm(`${this.path}.1`, { force: true }).catch(() => undefined)
      await rename(this.path, `${this.path}.1`).catch(() => undefined)
    }

    const handle = await open(this.path, 'a', 0o600)
    try {
      await chmod(this.path, 0o600).catch(() => undefined)
      await handle.writeFile(line, 'utf8')
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
