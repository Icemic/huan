/** 两种Shell共用的颜色环境；显式NO_COLOR/FORCE_COLOR由用户决定。 */
import {
  type BashOperations,
  type BashSpawnContext,
  createBashTool,
  createLocalBashOperations,
} from '@earendil-works/pi-coding-agent'

export function colorShellContext(context: BashSpawnContext): BashSpawnContext {
  const env = { ...context.env }
  if (env.NO_COLOR === undefined && env.FORCE_COLOR === undefined) env.FORCE_COLOR = '1'
  env.TERM ??= 'xterm-256color'
  env.COLORTERM ??= 'truecolor'
  return { ...context, env }
}

/** 复用SDK工具的输出累积与落盘，保留ANSI；记录仍由会话负责。 */
export async function executeColoredBash(
  command: string,
  cwd: string,
  options: {
    signal: AbortSignal
    onChunk: (value: string) => void
    operations?: BashOperations
    shellPath?: string
    commandPrefix?: string
  },
) {
  const operations = options.operations ?? createLocalBashOperations({ shellPath: options.shellPath })
  const decoder = new TextDecoder()
  const tool = createBashTool(cwd, {
    shellPath: options.shellPath,
    commandPrefix: options.commandPrefix,
    spawnHook: colorShellContext,
    exposeSessionEnvironment: false,
    operations: {
      async exec(value, directory, execution) {
        try {
          return await operations.exec(value, directory, {
            ...execution,
            onData(data) {
              execution.onData(data)
              options.onChunk(decoder.decode(data, { stream: true }))
            },
          })
        } catch (error) {
          // 取消仍让SDK完成输出累积及临时文件收尾，再由调用方标记取消。
          if (!options.signal.aborted) throw error
          return { exitCode: 0 }
        } finally {
          const rest = decoder.decode()
          if (rest) options.onChunk(rest)
        }
      },
    },
  })
  let output = ''
  let fullOutputPath: string | undefined
  let truncated = false
  const result = await tool.execute('user-bash', { command }, options.signal, (update) => {
    output = update.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    const details = update.details as { fullOutputPath?: string; truncation?: { truncated: boolean } } | undefined
    fullOutputPath = details?.fullOutputPath
    truncated = details?.truncation?.truncated === true
  })
  const structured = result.structuredContent as { exit_code: number }
  return {
    output,
    exitCode: options.signal.aborted ? undefined : structured.exit_code,
    cancelled: options.signal.aborted,
    truncated,
    fullOutputPath,
  }
}
