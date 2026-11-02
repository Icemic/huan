import type { HarnessCommandCatalog } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import { findAppCommand, mergeCommandCatalog } from './pi-builtin-commands'

const sourceInfo = {
  path: '/tmp/command.ts',
  source: 'local',
  scope: 'user' as const,
  origin: 'top-level' as const,
}

const catalog: HarnessCommandCatalog = {
  commands: [
    {
      name: 'model',
      description: '扩展同名命令',
      source: 'extension',
      sourceInfo,
      supportsArguments: true,
    },
    {
      name: 'mcp',
      description: '扩展同名 MCP',
      source: 'extension',
      sourceInfo,
      supportsArguments: false,
    },
    {
      name: 'plan',
      description: '模板',
      argumentHint: '[focus]',
      source: 'prompt',
      sourceInfo,
      supportsArguments: true,
      shadowedBy: 'extension',
    },
    {
      name: 'plan',
      description: '扩展',
      source: 'extension',
      sourceInfo,
      supportsArguments: true,
    },
  ],
  skillCommandsEnabled: true,
  diagnostics: [],
}

describe('应用命令索引合并', () => {
  it('内置优先，资源同名被标记；隐藏彩蛋不进入目录', () => {
    const merged = mergeCommandCatalog(catalog)
    const model = merged.filter((command) => command.name === 'model')
    expect(model).toHaveLength(2)
    expect(model.find((command) => command.source === 'builtin')?.available).toBe(true)
    expect(model.find((command) => command.source === 'extension')).toMatchObject({
      available: false,
      shadowedBy: 'builtin',
    })
    expect(merged.some((command) => command.name === 'arminsayshi')).toBe(false)
    expect(findAppCommand(merged, 'settings')).toMatchObject({
      available: true,
      stage: 'available',
    })
    expect(findAppCommand(merged, 'mcp')).toMatchObject({
      available: true,
      supportsArguments: true,
    })
    expect(
      merged.find((command) => command.name === 'mcp' && command.source === 'extension'),
    ).toMatchObject({ available: false, shadowedBy: 'builtin' })
  })

  it('资源间同名保留遮蔽来源', () => {
    const merged = mergeCommandCatalog(catalog)
    expect(
      merged.find((command) => command.name === 'plan' && command.source === 'prompt'),
    ).toMatchObject({
      available: false,
      shadowedBy: 'extension',
    })
    expect(
      merged.find((command) => command.name === 'plan' && command.source === 'extension'),
    ).toMatchObject({ available: true })
  })
})
