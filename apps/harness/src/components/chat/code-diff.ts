/**
 * 统一补丁与旧版带行号 diff 的最小解析。
 *
 * 只为展示服务：每个 hunk 生成修改前后两份代码，上下文同时进入两侧，
 * 删除只进前侧，新增只进后侧；代码之外的前缀、文件头、hunk 头及
 * "\ No newline at end of file" 都保留原文。高亮和 React 映射不在这里，
 * 调用方按 hunk 独立高亮后按原始顺序取回对应行。
 */

export type DiffLineKind = 'file' | 'hunk' | 'added' | 'removed' | 'context' | 'meta'

export interface ParsedDiffLine {
  kind: DiffLineKind
  /** 原始整行，复制或回退时直接使用。 */
  text: string
  /** 代码行在原文中的前缀，例如 "+"、" " 或旧版 SDK 的 "+  12 "。 */
  prefix?: string
  /** 去掉前缀后的代码；文件头、hunk 头与元信息没有代码。 */
  code?: string
  /** 代码行所属 hunk。 */
  hunkIndex?: number
  /** 在 hunk 修改前代码中的行号。 */
  beforeIndex?: number
  /** 在 hunk 修改后代码中的行号。 */
  afterIndex?: number
}

export interface DiffHunk {
  /** 统一补丁的 hunk 头；旧版带行号 diff 没有单独头部。 */
  header?: string
  beforeLines: string[]
  afterLines: string[]
}

export interface ParsedDiff {
  lines: ParsedDiffLine[]
  hunks: DiffHunk[]
  /** 是否识别为旧版 SDK 带行号 diff。 */
  lineNumbers: boolean
}

const FILE_HEADER = /^(?:---|\+\+\+) /
const LEGACY_LINE = /^[ +-]\s*\d+ /
const NO_NEWLINE = '\\ No newline at end of file'

const linesOf = (value: string): string[] => {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function parseUnified(origin: string[]): ParsedDiff {
  const lines: ParsedDiffLine[] = []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let seenHunk = false

  for (const text of origin) {
    // 文件头只出现在第一个 hunk 之前；hunk 内以 "---" 开头的行是删除内容。
    if (!seenHunk && FILE_HEADER.test(text)) {
      lines.push({ kind: 'file', text })
      continue
    }

    if (text.startsWith('@@')) {
      current = { header: text, beforeLines: [], afterLines: [] }
      hunks.push(current)
      seenHunk = true
      lines.push({ kind: 'hunk', text })
      continue
    }

    if (!current) {
      lines.push({ kind: 'context', text })
      continue
    }

    if (text.startsWith(NO_NEWLINE)) {
      lines.push({ kind: 'meta', text })
      continue
    }

    const marker = text.charAt(0)
    if (marker !== '+' && marker !== '-' && marker !== ' ') {
      // 无法识别的行原样保留，不猜成代码。
      lines.push({ kind: 'context', text })
      continue
    }

    const code = text.slice(1)
    const line: ParsedDiffLine = {
      kind: marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context',
      text,
      prefix: marker,
      code,
      hunkIndex: hunks.length - 1,
    }

    if (marker !== '+') {
      line.beforeIndex = current.beforeLines.length
      current.beforeLines.push(code)
    }
    if (marker !== '-') {
      line.afterIndex = current.afterLines.length
      current.afterLines.push(code)
    }
    lines.push(line)
  }

  return { lines, hunks, lineNumbers: false }
}

function parseLegacy(origin: string[]): ParsedDiff {
  const hunk: DiffHunk = { beforeLines: [], afterLines: [] }
  const lines: ParsedDiffLine[] = []
  let matched = 0

  for (const text of origin) {
    if (text.startsWith(NO_NEWLINE)) {
      lines.push({ kind: 'meta', text })
      continue
    }

    const match = LEGACY_LINE.exec(text)
    if (!match) {
      lines.push({ kind: 'context', text })
      continue
    }

    const prefix = match[0]
    const marker = prefix.charAt(0)
    const code = text.slice(prefix.length)
    const line: ParsedDiffLine = {
      kind: marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context',
      text,
      prefix,
      code,
      hunkIndex: 0,
    }

    if (marker !== '+') {
      line.beforeIndex = hunk.beforeLines.length
      hunk.beforeLines.push(code)
    }
    if (marker !== '-') {
      line.afterIndex = hunk.afterLines.length
      hunk.afterLines.push(code)
    }
    lines.push(line)
    matched++
  }

  return { lines, hunks: matched > 0 ? [hunk] : [], lineNumbers: matched > 0 }
}

/** 旧版 SDK diff 没有 hunk 头；统一补丁至少包含文件头或 hunk 头。 */
export function parseDiff(value: string): ParsedDiff {
  const origin = linesOf(value)
  const unified = origin.some((line) => line.startsWith('@@') || FILE_HEADER.test(line))
  return unified ? parseUnified(origin) : parseLegacy(origin)
}
