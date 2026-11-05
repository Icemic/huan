import { describe, expect, it } from 'vitest'
import { parseDiff } from './code-diff'

describe('统一补丁按 hunk 映射', () => {
  it('上下文进入两侧，删除与新增只进入各自一侧', () => {
    const parsed = parseDiff(
      [
        '--- src/comment.ts',
        '+++ src/comment.ts',
        '@@ -1,4 +1,4 @@',
        ' /* 开头  ',
        '- * 删除  ',
        '+ * 新增  ',
        ' 结束 */',
        ' const value = 1',
        '',
      ].join('\n'),
    )

    expect(parsed.lineNumbers).toBe(false)
    expect(parsed.lines.map((line) => line.kind)).toEqual([
      'file',
      'file',
      'hunk',
      'context',
      'removed',
      'added',
      'context',
      'context',
    ])
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]?.beforeLines).toEqual([
      '/* 开头  ',
      ' * 删除  ',
      '结束 */',
      'const value = 1',
    ])
    expect(parsed.hunks[0]?.afterLines).toEqual([
      '/* 开头  ',
      ' * 新增  ',
      '结束 */',
      'const value = 1',
    ])

    const removed = parsed.lines[4]
    const added = parsed.lines[5]
    expect(removed).toMatchObject({ prefix: '-', beforeIndex: 1 })
    expect(removed?.afterIndex).toBeUndefined()
    expect(added).toMatchObject({ prefix: '+', afterIndex: 1 })
    expect(added?.beforeIndex).toBeUndefined()
  })

  it('多个 hunk 各自维护修改前后代码与顺序', () => {
    const parsed = parseDiff(
      [
        '--- a.ts',
        '+++ b.ts',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        '@@ -10,2 +10,2 @@',
        ' three',
        '-four',
        '+FOUR',
        '',
      ].join('\n'),
    )

    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0]).toMatchObject({
      beforeLines: ['one', 'two'],
      afterLines: ['one', 'TWO'],
    })
    expect(parsed.hunks[1]).toMatchObject({
      beforeLines: ['three', 'four'],
      afterLines: ['three', 'FOUR'],
    })
    expect(
      parsed.lines.filter((line) => line.code !== undefined).map((line) => line.hunkIndex),
    ).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('保留空白、末尾换行与无换行标记，hunk 内 --- 仍按删除代码处理', () => {
    const parsed = parseDiff(
      [
        '--- a.txt',
        '+++ b.txt',
        '@@ -1,2 +1,2 @@',
        '-  ',
        '+',
        '--- old',
        '+++ new',
        ' end  ',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )

    expect(parsed.hunks[0]?.beforeLines).toEqual(['  ', '-- old', 'end  '])
    expect(parsed.hunks[0]?.afterLines).toEqual(['', '++ new', 'end  '])
    expect(parsed.lines.at(-1)).toEqual({
      kind: 'meta',
      text: '\\ No newline at end of file',
    })
    expect(parsed.lines.at(-2)?.code).toBe('end  ')
  })
})

describe('旧版 SDK 带行号 diff', () => {
  it('识别行号前缀并将其从代码中剥离，两侧映射保持不变', () => {
    const parsed = parseDiff(
      ['  1 const a = 1', '- 2 const old = 2', '+ 2 const next = 2', '  3 console.log("x")'].join(
        '\n',
      ),
    )

    expect(parsed.lineNumbers).toBe(true)
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]?.beforeLines).toEqual([
      'const a = 1',
      'const old = 2',
      'console.log("x")',
    ])
    expect(parsed.hunks[0]?.afterLines).toEqual([
      'const a = 1',
      'const next = 2',
      'console.log("x")',
    ])
    expect(parsed.lines[1]).toMatchObject({
      kind: 'removed',
      prefix: '- 2 ',
      code: 'const old = 2',
    })
    expect(parsed.lines[2]).toMatchObject({
      kind: 'added',
      prefix: '+ 2 ',
      code: 'const next = 2',
    })
  })

  it('省略行保持原文且不参与任一侧代码', () => {
    const parsed = parseDiff(['  1 const a = 1', '    ...', '+ 9 const b = 2'].join('\n'))

    expect(parsed.hunks[0]?.beforeLines).toEqual(['const a = 1'])
    expect(parsed.hunks[0]?.afterLines).toEqual(['const a = 1', 'const b = 2'])
    expect(parsed.lines[1]).toEqual({ kind: 'context', text: '    ...' })
  })
})
