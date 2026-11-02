import { describe, expect, it } from 'vitest'
import {
  applyServerForm,
  emptyServerForm,
  formatMcpDraft,
  formFromServer,
  listDraftServers,
  parseMcpDraft,
  parseToolExposure,
  removeDraftServer,
} from './mcp-config'

describe('MCP 配置草稿', () => {
  it('保留未知顶层字段与完整 mcpServers 语义', () => {
    const content = `${JSON.stringify(
      {
        mcpServers: { demo: { command: 'node', unknown: { keep: true } } },
        customTop: { keep: 'yes' },
      },
      null,
      2,
    )}\n`
    const parsed = parseMcpDraft(content)
    expect(parsed.value).toMatchObject({ customTop: { keep: 'yes' } })
    expect(listDraftServers(parsed.value ?? {}, 'user')).toEqual([
      {
        name: 'demo',
        raw: { command: 'node', unknown: { keep: true } },
        override: false,
      },
    ])
  })

  it('拒绝坏 JSON、非对象根与非法 mcpServers 形状', () => {
    expect(parseMcpDraft('{')).toMatchObject({ error: expect.stringContaining('JSON') })
    expect(parseMcpDraft('[]')).toMatchObject({ error: expect.stringContaining('根') })
    expect(parseMcpDraft('{"mcpServers":[]}')).toMatchObject({
      error: expect.stringContaining('mcpServers'),
    })
    expect(parseMcpDraft('{"__proto__":{"x":1}}')).toMatchObject({
      error: expect.stringContaining('__proto__'),
    })
  })

  it('常用表单修改只改目标键并保留未知字段', () => {
    const root = {
      mcpServers: {
        demo: {
          command: 'node',
          args: ['old.mjs'],
          customField: { keep: true },
        },
        other: { command: 'other' },
      },
      top: { keep: true },
    }
    const form = {
      ...formFromServer('demo', root.mcpServers.demo),
      command: 'node',
      argsText: 'new.mjs\n--flag',
      envText: 'TOKEN=value',
      exposure: 'direct' as const,
      toolExposureText: 'echo=hidden',
    }
    const result = applyServerForm(root, 'demo', form)
    expect(result.error).toBeUndefined()
    const value = result.root as typeof root
    expect(value.top).toEqual({ keep: true })
    expect(value.mcpServers.other).toEqual({ command: 'other' })
    expect(value.mcpServers.demo).toEqual({
      command: 'node',
      args: ['new.mjs', '--flag'],
      customField: { keep: true },
      env: { TOKEN: 'value' },
      exposure: 'direct',
      toolExposure: { echo: 'hidden' },
    })
    expect(formatMcpDraft(value)).toContain('"customField"')
  })

  it('项目 override 只写允许的三个字段，且至少需要一个字段', () => {
    const root = { mcpServers: {} }
    const form = {
      ...emptyServerForm('override'),
      name: 'demo',
      enabled: 'false' as const,
      exposure: 'deferred' as const,
      toolExposureText: 'echo=hidden',
    }
    const result = applyServerForm(root, undefined, form)
    expect(result.error).toBeUndefined()
    expect(result.root?.mcpServers).toEqual({
      demo: {
        enabled: false,
        exposure: 'deferred',
        toolExposure: { echo: 'hidden' },
      },
    })

    const empty = applyServerForm(root, undefined, { ...emptyServerForm('override'), name: 'x' })
    expect(empty.error).toContain('至少需要设置')
  })

  it('新增或重命名不覆盖同名服务器，参数空值和空白保持', () => {
    const root = { mcpServers: { demo: { command: 'node' }, other: { command: 'other' } } }
    const form = { ...emptyServerForm('stdio'), name: 'demo' }
    expect(applyServerForm(root, undefined, form).error).toContain('已存在')
    expect(applyServerForm(root, 'other', form).error).toContain('已存在')
    const modified = applyServerForm(root, 'demo', { ...form, argsText: ' spaced \n\nlast' })
    expect(modified.root?.mcpServers).toMatchObject({ demo: { args: [' spaced ', '', 'last'] } })
    expect(
      parseMcpDraft(
        JSON.stringify({
          nest: Array.from({ length: 35 }).reduce((value) => [value], {} as unknown),
        }),
      ).error,
    ).toBeDefined()
  })

  it('删除服务器与工具 exposure 解析不触碰其他条目', () => {
    const root = { mcpServers: { a: { command: 'a' }, b: { command: 'b' } }, keep: true }
    expect(removeDraftServer(root, 'a')).toEqual({
      mcpServers: { b: { command: 'b' } },
      keep: true,
    })
    expect(parseToolExposure('echo=hidden\nslow*=direct')).toEqual({
      value: { echo: 'hidden', 'slow*': 'direct' },
    })
    expect(parseToolExposure('echo=nope')).toMatchObject({
      error: expect.stringContaining('exposure'),
    })
  })
})
