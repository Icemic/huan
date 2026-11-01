/**
 * MCP 配置值解析（G1.4d2a）。
 *
 * 选择性移植自 `@earendil-works/pi-coding-agent@1.4.0` 的
 * `packages/coding-agent/src/core/resolve-config-value.ts`，来源指纹与本地差异见
 * `packages/mcp/THIRD-PARTY-NOTICES.md`。
 *
 * 支持 `$NAME` / `${NAME}` 环境变量、`$$` / `$!` 转义，以及整值 `!command`。
 * 与本地上游实现不同：命令使用异步子进程、10 秒超时、有界输出、可取消，
 * 并通过 SDK 公开的 `getShellConfig()` 解析 shell；不做进程级结果缓存。
 * 解析只在真正建立 transport 时调用，构造与配置读取不会执行命令。
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getShellConfig } from '@earendil-works/pi-coding-agent'

/** `!command` 的默认超时。 */
export const MCP_COMMAND_TIMEOUT_MS = 10_000

/** `!command` stdout 的默认字节上限。 */
export const MCP_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024

/** 值解析失败类别。 */
export type McpValueResolutionErrorCode =
  | 'missing-env'
  | 'command-failed'
  | 'command-cancelled'
  | 'invalid'

/** 受控的值解析错误；消息不回显配置值本身。 */
export class McpValueResolutionError extends Error {
  readonly code: McpValueResolutionErrorCode

  constructor(code: McpValueResolutionErrorCode, message: string) {
    super(message)
    this.name = 'McpValueResolutionError'
    this.code = code
  }
}

/** 注入命令执行器的选项。 */
export interface McpCommandRunOptions {
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
}

/** 异步命令执行器；返回 trim 后的 stdout，失败返回 undefined。 */
export type McpCommandRunner = (
  command: string,
  options: McpCommandRunOptions,
) => Promise<string | undefined>

/** 值解析上下文。 */
export interface McpValueResolutionOptions {
  env?: Readonly<Record<string, string | undefined>>
  cwd?: string
  signal?: AbortSignal
  runCommand?: McpCommandRunner
}

type TemplatePart = { type: 'literal'; value: string } | { type: 'env'; name: string }

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return
  const previous = parts[parts.length - 1]
  if (previous?.type === 'literal') {
    previous.value += value
    return
  }
  parts.push({ type: 'literal', value })
}

/** 解析模板；与 Pi 1.4.0 的规则保持一致。 */
function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let index = 0

  while (index < config.length) {
    const dollarIndex = config.indexOf('$', index)
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index))
      break
    }

    appendLiteral(parts, config.slice(index, dollarIndex))
    const nextChar = config[dollarIndex + 1]

    if (nextChar === '$' || nextChar === '!') {
      appendLiteral(parts, nextChar)
      index = dollarIndex + 2
      continue
    }

    if (nextChar === '{') {
      const endIndex = config.indexOf('}', dollarIndex + 2)
      if (endIndex < 0) {
        appendLiteral(parts, '$')
        index = dollarIndex + 1
        continue
      }
      const name = config.slice(dollarIndex + 2, endIndex)
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ type: 'env', name })
      } else {
        appendLiteral(parts, config.slice(dollarIndex, endIndex + 1))
      }
      index = endIndex + 1
      continue
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE)
    if (match?.[0]) {
      parts.push({ type: 'env', name: match[0] })
      index = dollarIndex + 1 + match[0].length
      continue
    }

    appendLiteral(parts, '$')
    index = dollarIndex + 1
  }

  return parts
}

/** 注入环境优先，其次进程环境；空字符串按未设置处理，与上游一致。 */
function resolveEnvValue(
  name: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  return env?.[name] || process.env[name] || undefined
}

/** 即使注入执行器忽略 signal，也在取消时结束等待。 */
function raceCancellation<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(new McpValueResolutionError('command-cancelled', 'shell 命令已取消'))
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      rejectPromise(new McpValueResolutionError('command-cancelled', 'shell 命令已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(error)
      },
    )
  })
}

/** 整个值以 `!` 开头时按 shell 命令处理；`$!` 只在模板内转义。 */
export function isMcpCommandValue(value: string): boolean {
  return value.startsWith('!')
}

/** 展开 `~` / `~/…`（Windows 也接受 `~\…`）。 */
export function expandMcpHomePath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
    return join(homedir(), value.slice(2))
  }
  return value
}

/** 解析一个配置值；命令失败、缺失环境变量或取消时抛出受控错误。 */
export async function resolveMcpValue(
  raw: string,
  description: string,
  options: McpValueResolutionOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    throw new McpValueResolutionError('command-cancelled', `解析 ${description} 已取消`)
  }

  if (isMcpCommandValue(raw)) {
    const runCommand = options.runCommand ?? runMcpShellCommand
    let value: string | undefined
    const runOptions = {
      cwd: options.cwd ?? process.cwd(),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: MCP_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MCP_COMMAND_MAX_OUTPUT_BYTES,
    }
    try {
      const pending = runCommand(raw.slice(1), runOptions)
      // 默认执行器会在取消后等待进程回收；仅对不受控注入执行器使用提前结束等待。
      value = await (runCommand === runMcpShellCommand
        ? pending
        : raceCancellation(pending, options.signal))
    } catch (error) {
      if (error instanceof McpValueResolutionError) throw error
      if (options.signal?.aborted) {
        throw new McpValueResolutionError('command-cancelled', `解析 ${description} 已取消`)
      }
      throw new McpValueResolutionError('command-failed', `无法从 shell 命令解析 ${description}`)
    }
    const trimmed = value?.trim()
    if (!trimmed) {
      throw new McpValueResolutionError('command-failed', `无法从 shell 命令解析 ${description}`)
    }
    return trimmed
  }

  const parts = parseTemplate(raw)
  let resolved = ''
  for (const part of parts) {
    if (part.type === 'literal') {
      resolved += part.value
      continue
    }
    const value = resolveEnvValue(part.name, options.env)
    if (value === undefined) {
      throw new McpValueResolutionError(
        'missing-env',
        `无法解析 ${description}：环境变量 ${part.name} 未设置`,
      )
    }
    resolved += value
  }
  return resolved
}

/** 解析全部 header 值；没有 header 时返回 undefined。 */
export async function resolveMcpHeaders(
  headers: Record<string, string> | undefined,
  description: string,
  options: McpValueResolutionOptions = {},
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined
  const entries = Object.entries(headers)
  if (entries.length === 0) return undefined
  const resolved: Record<string, string> = {}
  for (const [name, value] of entries) {
    resolved[name] = await resolveMcpValue(value, `${description} header "${name}"`, options)
  }
  return resolved
}

/** 解析全部 stdio env 值；没有 env 时返回空对象。 */
export async function resolveMcpEnvValues(
  env: Record<string, string> | undefined,
  description: string,
  options: McpValueResolutionOptions = {},
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    resolved[name] = await resolveMcpValue(value, `${description} env "${name}"`, options)
  }
  return resolved
}

/** 结束子进程及其子进程；只在超时/取消等失败路径调用。 */
function terminateChild(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolvePromise) => {
      try {
        // 等待 taskkill 完成整棵进程树回收，不先杀根进程以免失去子进程归属。
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        const fallback = () => {
          try {
            child.kill()
          } catch {
            // 进程可能已经退出。
          }
          resolvePromise()
        }
        killer.once('error', fallback)
        killer.once('close', fallback)
      } catch {
        try {
          child.kill()
        } catch {
          // 进程可能已经退出。
        }
        resolvePromise()
      }
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程可能已经退出。
    }
  }
  return Promise.resolve()
}

/**
 * 默认的异步 shell 执行器。
 *
 * 使用 SDK 公开 `getShellConfig()`（不深导入私有路径），命令不是 `shell: true`
 * 的字符串；Git Bash 等 stdin transport 通过 stdin 传入命令。stdout 有界，
 * 超时或取消会结束整个进程组。
 */
export const runMcpShellCommand: McpCommandRunner = (command, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new McpValueResolutionError('command-cancelled', 'shell 命令已取消'))
      return
    }

    let shell: ReturnType<typeof getShellConfig>
    try {
      shell = getShellConfig()
    } catch {
      reject(new McpValueResolutionError('command-failed', '无法解析 shell 配置'))
      return
    }

    const fromStdin = shell.commandTransport === 'stdin'
    const args = fromStdin ? shell.args : [...shell.args, command]
    let child: ChildProcess
    try {
      child = spawn(shell.shell, args, {
        cwd: options.cwd,
        env: process.env,
        stdio: [fromStdin ? 'pipe' : 'ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch {
      reject(new McpValueResolutionError('command-failed', '无法启动 shell 命令'))
      return
    }

    let stdoutBytes = 0
    const stdoutChunks: Buffer[] = []
    let settled = false
    let failing: McpValueResolutionError | undefined
    let terminating: Promise<void> | undefined
    let childClosed = false

    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const finish = (error?: McpValueResolutionError, value?: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }

    const finishFailure = () => {
      if (!failing || !childClosed) return
      void terminating?.then(() => finish(failing))
    }
    const fail = (code: 'command-failed' | 'command-cancelled') => {
      if (failing || settled) return
      failing = new McpValueResolutionError(code, 'shell 命令执行失败')
      terminating = terminateChild(child)
      finishFailure()
    }

    const onAbort = () => fail('command-cancelled')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => fail('command-failed'), options.timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (failing || settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stdoutBytes + buffer.length > options.maxOutputBytes) {
        fail('command-failed')
        return
      }
      stdoutBytes += buffer.length
      stdoutChunks.push(buffer)
    })
    child.stdout?.on('error', () => fail('command-failed'))
    child.on('error', () => fail('command-failed'))
    child.on('close', (code) => {
      childClosed = true
      if (settled) return
      if (failing) {
        finishFailure()
        return
      }
      if (code !== 0) {
        fail('command-failed')
        return
      }
      const value = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8').trim()
      finish(undefined, value || undefined)
    })

    child.stdin?.on('error', () => fail('command-failed'))
    if (fromStdin) child.stdin?.end(command)
    else child.stdin?.end()
  })
