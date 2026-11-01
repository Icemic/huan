/**
 * MCP 配置文件的有界读取与安全写入（G1.4d1；2026-11-02 改为共享配置）。
 *
 * 上游 Pi 1.4.0 的 `config.ts` 直接用 `readFileSync`/`writeFileSync`。huan 的
 * 存储层需要额外的边界与安全约束：
 * - 读取上限 512 KiB（UTF-8 字节），有界短读循环，避免 stat 后文件增长导致无界分配；
 * - 保留原文 BOM，解析时再剥离；revision 基于磁盘上的实际字节；
 * - 拒绝无效 UTF-8（不做有损解码）；
 * - 拒绝目标文件或 `<cwd>/.pi` 下现有组件中的符号链接；根 agentDir/cwd 本身允许是
 *   符号链接（用户可能刻意指定或链接），不因此限制；
 * - 同目录 `wx` 临时文件（0600）+ rename + 有界回读；
 * - 同进程内按规范化路径共享写队列，不同 store 实例不会同时覆盖同一文件。
 *
 * 明确不承诺防御恶意的并发文件系统替换（例如检查后立刻把目录换成符号链接），
 * 只覆盖显式路径别名和普通并发写入。
 */
import { isUtf8 } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 单个 MCP 配置文件读取/保存上限（UTF-8 字节）。 */
export const MCP_CONFIG_FILE_MAX_BYTES = 512 * 1024

/** 读取结果；失败时不返回不完整或不可信原文。 */
export interface McpConfigRead {
  exists: boolean
  content: string
  revision: string | null
  bytes: number
  tooLarge: boolean
  readError?: string
}

/** 受控路径错误，消息可直接用于诊断（不含文件内容）。 */
export class McpConfigPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpConfigPathError'
  }
}

/** 受控写入错误；用于区分可公开的回读失败与普通文件系统错误。 */
export class McpConfigWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpConfigWriteError'
  }
}

/** 文本按 UTF-8 编码后的 SHA-256，与写入磁盘的字节一致。 */
export function mcpConfigRevision(content: string): string {
  return mcpBytesRevision(Buffer.from(content, 'utf8'))
}

/** 字节级 SHA-256；读取时直接对磁盘实际字节计算。 */
export function mcpBytesRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 文本能否无损编码为 UTF-8。
 *
 * 含孤立代理项的 JS 字符串在 `Buffer.from` 时会被替换为 U+FFFD，导致 revision
 * 与回读内容不一致；保存前直接拒绝，避免写入不可预期的字节。
 */
export function mcpConfigContentIsEncodable(content: string): boolean {
  return Buffer.from(content, 'utf8').toString('utf8') === content
}

/**
 * 拒绝目标路径或受管子目录组件中的符号链接。
 *
 * root 本身不做检查：agentDir/cwd 可能由用户指定，也可能本来就是符号链接，允许
 * 它不会让写入越出受管范围。真正需要防止的是目标文件被换成别名，或
 * `<cwd>/.pi` 被换成指向其他目录的符号链接。用户配置文件是 agentDir 的直接子
 * 文件，因此只检查文件本身，不误建 huan 配置目录。
 */
export async function assertMcpConfigPathSafe(root: string, target: string): Promise<void> {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const rel = relative(rootPath, targetPath)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new McpConfigPathError('MCP 配置路径必须位于受管目录内。')
  }
  let current = rootPath
  for (const part of rel.split(sep)) {
    current = join(current, part)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new McpConfigPathError('无法检查 MCP 配置路径；请检查文件权限。')
    }
    if (info.isSymbolicLink()) {
      throw new McpConfigPathError('拒绝使用符号链接作为 MCP 配置路径。')
    }
    if (current === targetPath) {
      if (!info.isFile()) {
        throw new McpConfigPathError('MCP 配置路径不是普通文件。')
      }
    } else if (!info.isDirectory()) {
      throw new McpConfigPathError('MCP 配置路径的父级不是目录。')
    }
  }
}

function missingRead(): McpConfigRead {
  return { exists: false, content: '', revision: null, bytes: 0, tooLarge: false }
}

function failedRead(
  message: string,
  options: { exists?: boolean; bytes?: number } = {},
): McpConfigRead {
  return {
    exists: options.exists ?? false,
    content: '',
    revision: null,
    bytes: options.bytes ?? 0,
    tooLarge: false,
    readError: message,
  }
}

/**
 * 有界读取一个 MCP 配置文件。
 *
 * 缺文件返回 `exists: false`；超限、非普通文件、符号链接、无效 UTF-8 或读取失败
 * 都返回受控错误，不返回部分原文（避免 GUI 把不完整内容当成可安全保存的版本）。
 */
export async function readMcpConfigText(path: string, root: string): Promise<McpConfigRead> {
  try {
    await assertMcpConfigPathSafe(root, path)
  } catch (error) {
    return failedRead(
      error instanceof McpConfigPathError ? error.message : '无法检查 MCP 配置路径。',
    )
  }

  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missingRead()
    return failedRead('无法读取 MCP 配置文件；请检查文件权限。')
  }
  if (!info.isFile()) {
    return failedRead('MCP 配置路径不是普通文件。', { exists: true, bytes: info.size })
  }
  if (info.size > MCP_CONFIG_FILE_MAX_BYTES) {
    return {
      exists: true,
      content: '',
      revision: null,
      bytes: info.size,
      tooLarge: true,
    }
  }

  const buffer = Buffer.alloc(MCP_CONFIG_FILE_MAX_BYTES + 1)
  let bytes = 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    // 有界短读：即使 stat 后文件增长，也最多读到上限 + 1 字节。
    while (bytes < buffer.length) {
      const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (chunk.bytesRead === 0) break
      bytes += chunk.bytesRead
    }
  } catch {
    return failedRead('无法读取 MCP 配置文件；请检查文件权限。', {
      exists: true,
      bytes: info.size,
    })
  } finally {
    await handle?.close().catch(() => {})
  }

  if (bytes > MCP_CONFIG_FILE_MAX_BYTES) {
    return {
      exists: true,
      content: '',
      revision: null,
      bytes: Math.max(info.size, bytes),
      tooLarge: true,
    }
  }

  const raw = buffer.subarray(0, bytes)
  if (!isUtf8(raw)) {
    return failedRead('MCP 配置文件不是有效的 UTF-8。', { exists: true, bytes })
  }
  return {
    exists: true,
    // 保留 BOM 原文；解析层负责剥离。revision 与磁盘字节一致。
    content: raw.toString('utf8'),
    revision: mcpBytesRevision(raw),
    bytes,
    tooLarge: false,
  }
}

/** 同进程写队列；键是规范化后的绝对路径。 */
const writeQueues = new Map<string, Promise<void>>()

/**
 * 计算队列键：尽量解析最近的存在祖先，兼容 agentDir/cwd 的符号链接与 `..` 写法，
 * 让不同 store 实例的同一磁盘文件共享队列。Windows 下大小写不敏感。
 */
async function canonicalQueueKey(path: string): Promise<string> {
  const absolute = resolve(path)
  let current = absolute
  const suffix: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      const key = join(real, ...suffix.reverse())
      return process.platform === 'win32' ? key.toLowerCase() : key
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return process.platform === 'win32' ? absolute.toLowerCase() : absolute
      }
      suffix.push(basename(current))
      current = parent
    }
  }
}

/**
 * 在规范化路径对应的单进程队列中执行任务。
 *
 * 队列只保证同进程内串行，不宣称跨进程 CAS；写入事务仍以 expectedRevision 为准。
 */
export async function withMcpConfigPathQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = await canonicalQueueKey(path)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const current = previous.then(task, task)
  const tail = current.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(key, tail)
  try {
    return await current
  } finally {
    // 只有在没有后续任务接上时才清理，避免误删仍在使用的队列尾部。
    if (writeQueues.get(key) === tail) writeQueues.delete(key)
  }
}

/**
 * 原子写入 MCP 配置并回读校验。
 *
 * 调用方必须先执行 `assertMcpConfigPathSafe` 与内容校验；本函数只负责写入原语：
 * 同目录 `wx` 临时文件（0600）、fsync、close、rename，失败时清理临时文件。
 * 该函数不从公共入口导出，避免绕过存储层的信任与路径检查。
 */
export async function writeMcpConfigFileAtomic(
  path: string,
  content: string,
  root: string = dirname(resolve(path)),
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }

  // 回读仍走有界读取，避免写入层声称成功但磁盘内容不可确认。
  const check = await readMcpConfigText(path, root)
  if (
    check.readError ||
    check.tooLarge ||
    check.content !== content ||
    check.revision !== mcpConfigRevision(content)
  ) {
    throw new McpConfigWriteError('MCP 配置写入后回读不一致；请不要依赖本次保存结果。')
  }
}
