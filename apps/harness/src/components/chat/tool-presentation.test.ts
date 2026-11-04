import { describe, expect, it } from 'vitest'
import {
  bashDetailsOf,
  bashToolInputOf,
  commandSummaryOf,
  diffLinesOf,
  editDetailsOf,
  editToolInputOf,
  isShellFailureExit,
  isShellSuccessExit,
  lineCountOf,
  otherArgumentsOf,
  readDetailsOf,
  readRangeDetailOf,
  readRangeSummaryOf,
  readToolInputOf,
  shellExitLabelOf,
  truncationTextOf,
  writeToolInputOf,
} from './tool-presentation'

describe('read 参数与范围', () => {
  it('只把请求范围写进标题与展开信息', () => {
    const input = readToolInputOf({ path: 'src/app.tsx', offset: 20, limit: 61 })
    expect(input).toEqual({ path: 'src/app.tsx', offset: 20, limit: 61 })
    if (!input) throw new Error('read 参数应有效')
    expect(readRangeSummaryOf(input)).toBe('20–80 行')
    expect(readRangeDetailOf(input)).toBe('起始行 20 · 最多 61 行')
  })

  it('分别处理只有 offset 或只有 limit 的请求', () => {
    const offsetOnly = readToolInputOf({ path: 'a.ts', offset: 3 })
    const limitOnly = readToolInputOf({ path: 'a.ts', limit: 5 })
    if (!offsetOnly || !limitOnly) throw new Error('read 参数应有效')
    expect(readRangeSummaryOf(offsetOnly)).toBe('从第3行')
    expect(readRangeDetailOf(offsetOnly)).toBe('起始行 3')
    expect(readRangeSummaryOf(limitOnly)).toBe('前5行')
    expect(readRangeDetailOf(limitOnly)).toBe('最多 5 行')
    expect(readRangeSummaryOf({ path: 'a.ts' })).toBeUndefined()
  })

  it('形状不符时整体回退，未知字段另存为其他参数', () => {
    expect(readToolInputOf({ path: '', offset: 1 })).toBeUndefined()
    expect(readToolInputOf({ path: 'a.ts', offset: '1' })).toBeUndefined()
    expect(readToolInputOf({ path: 'a.ts', limit: 0 })).toBeUndefined()
    expect(otherArgumentsOf({ path: 'a.ts', offset: 1, marker: true }, 'read')).toEqual({
      marker: true,
    })
    expect(otherArgumentsOf({ path: 'a.ts' }, 'read')).toBeUndefined()
  })
})

describe('write 行数与 edit 段数', () => {
  it('空内容为 0 行，末尾单个换行不多算，内部空行保留', () => {
    expect(lineCountOf('')).toBe(0)
    expect(lineCountOf('a')).toBe(1)
    expect(lineCountOf('a\n')).toBe(1)
    expect(lineCountOf('a\nb\n')).toBe(2)
    expect(lineCountOf('a\n\n')).toBe(2)
    expect(lineCountOf('\n')).toBe(1)
  })

  it('write 允许明确空内容', () => {
    expect(writeToolInputOf({ path: 'a.ts', content: '' })).toEqual({
      path: 'a.ts',
      content: '',
    })
    expect(writeToolInputOf({ path: 'a.ts' })).toBeUndefined()
  })

  it('edit 优先 edits[]，兼容历史单段形状', () => {
    const multi = editToolInputOf({
      path: 'a.ts',
      edits: [
        { oldText: 'old-1', newText: 'new-1' },
        { oldText: 'old-2', newText: 'new-2' },
      ],
    })
    expect(multi?.segments).toHaveLength(2)
    expect(editToolInputOf({ path: 'a.ts', oldText: 'old', newText: 'new' })?.segments).toEqual([
      { oldText: 'old', newText: 'new' },
    ])
    expect(editToolInputOf({ path: 'a.ts', edits: [{ oldText: 'old' }] })).toBeUndefined()
    expect(editToolInputOf({ path: 'a.ts', edits: [] })).toBeUndefined()
  })
})

describe('命令摘要与 Shell 状态', () => {
  it('多行命令只显示第一行并追加省略号', () => {
    expect(commandSummaryOf('pnpm typecheck')).toBe('pnpm typecheck')
    expect(commandSummaryOf('echo a\necho b')).toBe('echo a…')
    expect(commandSummaryOf('echo a\n')).toBe('echo a…')
  })

  it('退出码与取消按状态给出唯一标题文案', () => {
    expect(shellExitLabelOf(0, false)).toBe('退出码 0')
    expect(shellExitLabelOf(1, false)).toBe('退出码 1')
    expect(shellExitLabelOf(undefined, false)).toBe('退出码未知')
    expect(shellExitLabelOf(undefined, true)).toBe('已取消')
    expect(isShellSuccessExit(0, false)).toBe(true)
    expect(isShellSuccessExit(0, true)).toBe(false)
    expect(isShellFailureExit(1, false)).toBe(true)
    expect(isShellFailureExit(undefined, false)).toBe(false)
    expect(isShellFailureExit(1, true)).toBe(false)
  })

  it('bash 参数保留显式 timeout，非法值回退', () => {
    expect(bashToolInputOf({ command: 'ls', timeout: 60 })).toEqual({
      command: 'ls',
      timeout: 60,
    })
    expect(bashToolInputOf({ command: 'ls' })).toEqual({ command: 'ls' })
    expect(bashToolInputOf({ command: 'ls', timeout: 0 })).toBeUndefined()
    expect(bashToolInputOf({ command: 'ls', timeout: '60' })).toBeUndefined()
  })
})

describe('diff 行分派', () => {
  it('保留文件头与 hunk，增删行去掉前缀交给展示变体', () => {
    const lines = diffLinesOf(
      [
        '--- a/src/greeting.ts',
        '+++ b/src/greeting.ts',
        '@@ -1,3 +1,3 @@',
        ' export function greeting(name: string) {',
        '-  return `你好，世界`',
        '+  return `你好，世界。`',
        ' }',
        '',
      ].join('\n'),
    )
    expect(lines).toEqual([
      { kind: 'file', text: '--- a/src/greeting.ts' },
      { kind: 'file', text: '+++ b/src/greeting.ts' },
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: ' export function greeting(name: string) {' },
      { kind: 'removed', text: '  return `你好，世界`' },
      { kind: 'added', text: '  return `你好，世界。`' },
      { kind: 'context', text: ' }' },
    ])
  })

  it('无法识别的行按上下文原样保留，不删除内容', () => {
    expect(diffLinesOf('\\ No newline at end of file\nplain')).toEqual([
      { kind: 'context', text: '\\ No newline at end of file' },
      { kind: 'context', text: 'plain' },
    ])
  })
})

describe('工具详情映射', () => {
  it('edit 优先 patch，diff 仍进入其他详情', () => {
    const details = editDetailsOf({
      patch: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b',
      diff: '+1 b',
      firstChangedLine: 4,
      extra: { note: true },
    })
    expect(details.diff).toBe('--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b')
    expect(details.firstChangedLine).toBe(4)
    expect(details.other).toMatchObject({
      diff: '+1 b',
      extra: { note: true },
    })
  })

  it('edit 缺少 patch 时使用 diff，空 patch 不冒充差异', () => {
    expect(editDetailsOf({ diff: '+1 b' }).diff).toBe('+1 b')
    expect(editDetailsOf({ patch: '   ', diff: '+1 b' }).diff).toBe('+1 b')
    expect(editDetailsOf({ patch: '   ' }).diff).toBeUndefined()
    expect(editDetailsOf({ diff: '+1 b' }).other).toBeUndefined()
  })

  it('失败时不将旧差异当结果展示，原始详情仍保留', () => {
    const original = { patch: 'patch', diff: '+1 b', firstChangedLine: 2, marker: true }
    expect(editDetailsOf(original, { showDiff: false })).toEqual({ other: original })
  })

  it('read 与 bash 的截断和完整输出路径专门展示，其余字段保留', () => {
    const truncation = {
      truncated: true,
      truncatedBy: 'lines',
      outputLines: 10,
      totalLines: 100,
      maxLines: 10,
      maxBytes: 51200,
      lastLinePartial: false,
    }
    expect(truncationTextOf(truncation)).toBe('已显示 10/100 行 · 上限 10 行')
    expect(readDetailsOf({ truncation, marker: 1 })).toMatchObject({
      truncation: '已显示 10/100 行 · 上限 10 行',
      other: { marker: 1 },
    })
    expect(
      bashDetailsOf({
        truncation: {
          truncated: true,
          truncatedBy: 'bytes',
          outputLines: 3,
          outputBytes: 2048,
          totalBytes: 10240,
          maxBytes: 51200,
        },
        fullOutputPath: '/tmp/pi-bash.log',
        marker: 2,
      }),
    ).toEqual({
      truncation: '已显示 3 行 · 2.0 KB/10 KB · 上限 50 KB',
      fullOutputPath: '/tmp/pi-bash.log',
      other: {
        marker: 2,
        truncation: {
          truncated: true,
          truncatedBy: 'bytes',
          outputLines: 3,
          outputBytes: 2048,
          totalBytes: 10240,
          maxBytes: 51200,
        },
      },
    })
    expect(truncationTextOf({ truncated: false })).toBeUndefined()
    expect(truncationTextOf(null)).toBeUndefined()
  })

  it('未知截断字段、替换段字段及未采用参数均能取得', () => {
    expect(readDetailsOf({ truncation: { truncated: false, vendor: 'read' } }).other).toEqual({
      truncation: { truncated: false, vendor: 'read' },
    })
    expect(bashDetailsOf({ truncation: { vendor: 'bash' } }).other).toEqual({
      truncation: { vendor: 'bash' },
    })
    const args = {
      path: 'a.ts',
      edits: [{ oldText: 'a', newText: 'b', reason: 'keep' }],
      oldText: 'unused',
    }
    expect(otherArgumentsOf(args, 'edit')).toEqual({
      oldText: 'unused',
      edits: [{ index: 1, reason: 'keep' }],
    })
  })

  it('首行超限与末行不完整给出可读原因', () => {
    expect(
      truncationTextOf({
        truncated: true,
        truncatedBy: 'bytes',
        firstLineExceedsLimit: true,
        maxBytes: 51200,
      }),
    ).toBe('首行超过 50 KB 限制')
    expect(
      truncationTextOf({
        truncated: true,
        truncatedBy: 'bytes',
        lastLinePartial: true,
      }),
    ).toBe('末行不完整')
  })
})
