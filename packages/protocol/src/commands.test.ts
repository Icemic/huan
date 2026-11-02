import { describe, expect, it } from 'vitest'
import {
  builtinCommandNameOf,
  HARNESS_BUILTIN_COMMANDS,
  isBuiltinCommandName,
  parseLeadingSlashCommand,
} from './commands'

describe('内置命令行为索引', () => {
  it('解析 slash 首词与参数，非 slash 不命中', () => {
    expect(parseLeadingSlashCommand('/model huan/a')).toEqual({ name: 'model', args: 'huan/a' })
    expect(parseLeadingSlashCommand('/skill:demo arg')).toEqual({
      name: 'skill:demo',
      args: 'arg',
    })
    expect(parseLeadingSlashCommand('hello /model')).toBeUndefined()
    expect(parseLeadingSlashCommand('/')).toBeUndefined()
    expect(parseLeadingSlashCommand('/bad/name')).toBeUndefined()
  })

  it('已知内置命令被识别，未知扩展/skill 不在守卫名单', () => {
    expect(builtinCommandNameOf('/settings now')).toBe('settings')
    expect(builtinCommandNameOf('/mcp login demo')).toBe('mcp')
    expect(isBuiltinCommandName('debug')).toBe(true)
    expect(isBuiltinCommandName('mcp')).toBe(true)
    expect(builtinCommandNameOf('/plan alpha')).toBeUndefined()
    expect(builtinCommandNameOf('/skill:demo')).toBeUndefined()
    expect(new Set(HARNESS_BUILTIN_COMMANDS.map((command) => command.name)).size).toBe(
      HARNESS_BUILTIN_COMMANDS.length,
    )
  })
})
