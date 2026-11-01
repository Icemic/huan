/**
 * 应用命令索引：合并 huan 内置行为索引与宿主公开资源目录。
 *
 * 内置命令优先级最高（与 Pi TUI 一致）：资源命令与内置同名时标记为被内置
 * 遮蔽，不能作为普通 prompt 发送。未实施的内置命令保留在目录中并显示阶段
 * 与等价入口，不伪装成功。
 */
import {
  HARNESS_BUILTIN_COMMANDS,
  type HarnessBuiltinCommand,
  type HarnessCommandCatalog,
  type HarnessCommandSource,
} from '@huan/protocol'

export type AppCommand = {
  name: string
  description?: string
  argumentHint?: string
  source: 'builtin' | HarnessCommandSource
  stage?: HarnessBuiltinCommand['stage']
  available: boolean
  /** 不可用/被遮蔽时的说明。 */
  availability?: string
  supportsArguments: boolean
  shadowedBy?: 'builtin' | HarnessCommandSource
}

const BUILTIN_BY_NAME = new Map(HARNESS_BUILTIN_COMMANDS.map((command) => [command.name, command]))

export function builtinCommandOf(name: string): HarnessBuiltinCommand | undefined {
  return BUILTIN_BY_NAME.get(name)
}

const mapBuiltin = (command: HarnessBuiltinCommand): AppCommand => ({
  name: command.name,
  description: command.description,
  ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
  source: 'builtin',
  stage: command.stage,
  available: command.stage === 'available',
  ...(command.stage !== 'available'
    ? { availability: command.availability ?? '该内置命令尚无 GUI 入口。' }
    : {}),
  supportsArguments: command.argumentHint !== undefined,
})

/** 合并资源目录；隐藏彩蛋不进入可发现目录，但仍由核心守卫阻挡。 */
export function mergeCommandCatalog(catalog: HarnessCommandCatalog | undefined): AppCommand[] {
  const builtins = HARNESS_BUILTIN_COMMANDS.filter((command) => command.stage !== 'hidden').map(
    mapBuiltin,
  )
  const builtinNames = new Set(builtins.map((command) => command.name))
  const resources: AppCommand[] = (catalog?.commands ?? []).map((command) => {
    const shadowedBy = builtinNames.has(command.name) ? 'builtin' : command.shadowedBy
    return {
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      source: command.source,
      available: shadowedBy === undefined,
      ...(shadowedBy
        ? {
            availability:
              shadowedBy === 'builtin'
                ? '与内置命令同名，内置命令优先。'
                : `与更高优先级的 ${shadowedBy === 'extension' ? '扩展' : '模板'}命令同名，已被遮蔽。`,
            shadowedBy,
          }
        : {}),
      supportsArguments: command.supportsArguments,
      ...(shadowedBy ? { shadowedBy } : {}),
    }
  })
  return [...builtins, ...resources]
}

export function findAppCommand(
  commands: readonly AppCommand[],
  name: string,
): AppCommand | undefined {
  return commands.find((command) => command.name === name)
}

/** 来源标签（目录与补全共用）。 */
export function commandSourceLabel(source: AppCommand['source']): string {
  switch (source) {
    case 'builtin':
      return '内置'
    case 'extension':
      return '扩展'
    case 'prompt':
      return '模板'
    case 'skill':
      return 'Skill'
  }
}

/** 阶段标签：只有不可用内置命令展示。 */
export function commandStageLabel(stage: AppCommand['stage']): string | undefined {
  if (stage === 'g1.4') return 'G1.4'
  if (stage === 'g1.5') return 'G1.5'
  return undefined
}
