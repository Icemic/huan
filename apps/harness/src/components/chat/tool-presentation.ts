/**
 * 内置文件/命令工具的参数与结果形状解析。
 *
 * 只做纯转换：标准字段转成展示模型，未知字段保留给“其他参数/其他详情”
 * 回退；形状不符时返回 undefined，由调用方继续使用通用工具展示。这里不
 * 读取磁盘，也不根据工具名猜测缺失内容。
 */

export interface ReadToolInput {
  path: string
  offset?: number
  limit?: number
}

export interface WriteToolInput {
  path: string
  content: string
}

export interface EditSegment {
  oldText: string
  newText: string
}

export interface EditToolInput {
  path: string
  segments: EditSegment[]
}

export interface BashToolInput {
  command: string
  timeout?: number
}

export interface EditDetails {
  /** 优先 details.patch，其次 details.diff；不可识别时缺失。 */
  diff?: string
  firstChangedLine?: number
  /** 已经专门展示的字段之外的原始详情。 */
  other?: unknown
}

export interface BashDetails {
  truncation?: string
  fullOutputPath?: string
  other?: unknown
}

export interface ReadDetails {
  truncation?: string
  other?: unknown
}

export type DiffLineKind = 'file' | 'hunk' | 'added' | 'removed' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const hasKeys = (value: Record<string, unknown>): boolean => Object.keys(value).length > 0

const withoutKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  const rest: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!keys.includes(key)) rest[key] = item
  }
  return hasKeys(rest) ? rest : undefined
}

/** 读取工具参数；offset/limit 只接受正整数，其他形状整体回退。 */
export const readToolInputOf = (args: Record<string, unknown>): ReadToolInput | undefined => {
  const { path, offset, limit } = args
  if (!nonEmptyString(path)) return undefined
  if (offset !== undefined && !positiveInteger(offset)) return undefined
  if (limit !== undefined && !positiveInteger(limit)) return undefined
  return {
    path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  }
}

/** 写入工具参数；空字符串是明确内容，不是缺失。 */
export const writeToolInputOf = (args: Record<string, unknown>): WriteToolInput | undefined => {
  const { path, content } = args
  if (!nonEmptyString(path) || typeof content !== 'string') return undefined
  return { path, content }
}

/**
 * 编辑工具参数：优先 edits[]，兼容历史单段 oldText/newText。
 *
 * 只接受完整替换请求；任一段字段缺失或段数组为空时整体回退。
 */
export const editToolInputOf = (args: Record<string, unknown>): EditToolInput | undefined => {
  const { path, edits, oldText, newText } = args
  if (!nonEmptyString(path)) return undefined
  if (Array.isArray(edits)) {
    if (edits.length === 0) return undefined
    const segments: EditSegment[] = []
    for (const edit of edits) {
      if (!isRecord(edit) || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
        return undefined
      }
      segments.push({ oldText: edit.oldText, newText: edit.newText })
    }
    return { path, segments }
  }
  if (typeof oldText === 'string' && typeof newText === 'string') {
    return { path, segments: [{ oldText, newText }] }
  }
  return undefined
}

/** 命令工具参数；timeout 只在显式且合法时保留。 */
export const bashToolInputOf = (args: Record<string, unknown>): BashToolInput | undefined => {
  const { command, timeout } = args
  if (!nonEmptyString(command)) return undefined
  if (timeout !== undefined && !(finiteNumber(timeout) && timeout > 0)) return undefined
  return { command, ...(timeout === undefined ? {} : { timeout }) }
}

/** 收起时展示的读取范围；只描述请求，不声称实际返回行数。 */
export const readRangeSummaryOf = (input: ReadToolInput): string | undefined => {
  const { offset, limit } = input
  if (offset !== undefined && limit !== undefined) return `${offset}–${offset + limit - 1} 行`
  if (offset !== undefined) return `从第${offset}行`
  if (limit !== undefined) return `前${limit}行`
  return undefined
}

/** 展开后的精确请求范围。 */
export const readRangeDetailOf = (input: ReadToolInput): string | undefined => {
  const parts: string[] = []
  if (input.offset !== undefined) parts.push(`起始行 ${input.offset}`)
  if (input.limit !== undefined) parts.push(`最多 ${input.limit} 行`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** 写入行数：空内容为 0，末尾单个换行不多算一行。 */
export const lineCountOf = (content: string): number => {
  if (content.length === 0) return 0
  const withoutTrailingNewline = content.endsWith('\n') ? content.slice(0, -1) : content
  return withoutTrailingNewline.split('\n').length
}

/** 收起的命令只显示第一行；存在后续行时追加省略号。 */
export const commandSummaryOf = (command: string): string => {
  const newline = command.indexOf('\n')
  return newline === -1 ? command : `${command.slice(0, newline)}…`
}

/** 标准参数之外的未知字段；没有剩余字段时返回 undefined。 */
export const otherArgumentsOf = (
  args: Record<string, unknown>,
  tool: 'read' | 'write' | 'edit' | 'bash',
): unknown => {
  const known: Record<typeof tool, readonly string[]> = {
    read: ['path', 'offset', 'limit'],
    write: ['path', 'content'],
    edit: Array.isArray(args.edits) ? ['path', 'edits'] : ['path', 'oldText', 'newText'],
    bash: ['command', 'timeout'],
  }
  const rest = withoutKeys(args, known[tool]) ?? {}
  if (tool === 'edit' && Array.isArray(args.edits)) {
    const extraSegments = args.edits.flatMap((edit, index) => {
      if (!isRecord(edit)) return []
      const extra = withoutKeys(edit, ['oldText', 'newText'])
      return extra ? [{ index: index + 1, ...extra }] : []
    })
    if (extraSegments.length > 0) rest.edits = extraSegments
  }
  return hasKeys(rest) ? rest : undefined
}

const bytesText = (value: unknown): string | undefined => {
  if (!finiteNumber(value) || value < 0) return undefined
  if (value < 1024) return `${value} B`
  const kilobytes = value / 1024
  return `${kilobytes >= 10 ? Math.round(kilobytes) : kilobytes.toFixed(1)} KB`
}

/** 把 SDK 截断详情压缩成一行 12px 信息；原文仍逐字保留。 */
export const truncationTextOf = (value: unknown): string | undefined => {
  if (!isRecord(value) || value.truncated !== true) return undefined
  const parts: string[] = []
  const outputLines = finiteNumber(value.outputLines) ? value.outputLines : undefined
  const totalLines = finiteNumber(value.totalLines) ? value.totalLines : undefined
  if (value.firstLineExceedsLimit === true) {
    parts.push(`首行超过 ${bytesText(value.maxBytes) ?? '大小'} 限制`)
  } else if (value.truncatedBy === 'lines') {
    if (outputLines !== undefined && totalLines !== undefined) {
      parts.push(`已显示 ${outputLines}/${totalLines} 行`)
    }
    const outputBytes = bytesText(value.outputBytes)
    const totalBytes = bytesText(value.totalBytes)
    if (outputBytes && totalBytes) parts.push(`${outputBytes}/${totalBytes}`)
    const maxLines = finiteNumber(value.maxLines) ? value.maxLines : undefined
    if (maxLines !== undefined) parts.push(`上限 ${maxLines} 行`)
  } else if (value.truncatedBy === 'bytes') {
    if (outputLines !== undefined) parts.push(`已显示 ${outputLines} 行`)
    const outputBytes = bytesText(value.outputBytes)
    const totalBytes = bytesText(value.totalBytes)
    if (outputBytes && totalBytes) parts.push(`${outputBytes}/${totalBytes}`)
    const maxBytes = bytesText(value.maxBytes)
    if (maxBytes) parts.push(`上限 ${maxBytes}`)
  }
  if (value.lastLinePartial === true) parts.push('末行不完整')
  return parts.length > 0 ? parts.join(' · ') : '内容已截断'
}

/** 读取详情：truncation 转信息行，其余字段继续可查。 */
export const readDetailsOf = (details: unknown): ReadDetails => {
  if (details === undefined) return {}
  if (!isRecord(details)) return { other: details }
  const { truncation, ...rest } = details
  const truncationText = truncationTextOf(truncation)
  // 原始截断详情包含未单独展示的限制、布尔值和扩展字段，始终保留可查。
  if (truncation !== undefined) rest.truncation = truncation
  return {
    ...(truncationText === undefined ? {} : { truncation: truncationText }),
    ...(hasKeys(rest) ? { other: rest } : {}),
  }
}

/** 写入结果没有标准详情；全部作为其他详情保留。 */
export const writeDetailsOf = (details: unknown): unknown =>
  details === undefined ? undefined : details

/**
 * 编辑详情：成功时只展示一种差异，firstChangedLine 进块头。
 *
 * 失败时调用方传入 `showDiff: false`：完整错误与请求片段已足以表达原因，
 * 旧 partialResult 的差异不作为实际结果展示，原始详情继续保留可查。
 */
export const editDetailsOf = (
  details: unknown,
  options: { showDiff?: boolean } = {},
): EditDetails => {
  if (details === undefined) return {}
  if (!isRecord(details)) return { other: details }
  const { patch, diff, firstChangedLine, ...rest } = details
  if (options.showDiff === false) {
    return hasKeys(details) ? { other: details } : {}
  }
  const patchText = typeof patch === 'string' && patch.trim().length > 0 ? patch : undefined
  const diffText = typeof diff === 'string' && diff.trim().length > 0 ? diff : undefined
  const display = patchText ?? diffText
  const firstLine =
    finiteNumber(firstChangedLine) && firstChangedLine > 0 ? firstChangedLine : undefined
  const other: Record<string, unknown> = { ...rest }
  // 未被采用的差异格式仍必须可取得，已采用的字段不重复出现。
  if (patch !== undefined && patchText === undefined) other.patch = patch
  if (diff !== undefined && diffText === undefined) other.diff = diff
  if (patchText !== undefined && diff !== undefined) other.diff = diff
  if (firstChangedLine !== undefined && (firstLine === undefined || display === undefined)) {
    other.firstChangedLine = firstChangedLine
  }
  return {
    ...(display === undefined ? {} : { diff: display }),
    ...(firstLine === undefined || display === undefined ? {} : { firstChangedLine: firstLine }),
    ...(hasKeys(other) ? { other } : {}),
  }
}

/** 命令详情：截断信息与完整输出路径专门展示，其余字段继续可查。 */
export const bashDetailsOf = (details: unknown): BashDetails => {
  if (details === undefined) return {}
  if (!isRecord(details)) return { other: details }
  const { truncation, fullOutputPath, ...rest } = details
  const path = nonEmptyString(fullOutputPath) ? fullOutputPath : undefined
  const other: Record<string, unknown> = { ...rest }
  if (truncation !== undefined) other.truncation = truncation
  if (fullOutputPath !== undefined && path === undefined) other.fullOutputPath = fullOutputPath
  const truncationText = truncationTextOf(truncation)
  return {
    ...(truncationText === undefined ? {} : { truncation: truncationText }),
    ...(path === undefined ? {} : { fullOutputPath: path }),
    ...(hasKeys(other) ? { other } : {}),
  }
}

/**
 * 解析统一 diff：文件头与 hunk 保留原文，增删行去掉前缀交给行变体展示。
 * 无法识别的行按上下文原样保留，不删除任何内容。
 */
export const diffLinesOf = (diff: string): DiffLine[] => {
  const lines = diff.split('\n')
  if (diff.includes('\0')) return lines.map((text) => ({ kind: 'context', text }))
  if (lines.at(-1) === '') lines.pop()
  return lines.map((text) => {
    if (text.startsWith('+++ ') || text.startsWith('--- ')) return { kind: 'file', text }
    if (text.startsWith('@@')) return { kind: 'hunk', text }
    if (text.startsWith('+')) return { kind: 'added', text: text.slice(1) }
    if (text.startsWith('-')) return { kind: 'removed', text: text.slice(1) }
    return { kind: 'context', text }
  })
}

/** 用户 Shell 标题里的退出结果；取消优先于未知退出码。 */
export const shellExitLabelOf = (exitCode: number | undefined, cancelled: boolean): string => {
  if (cancelled) return '已取消'
  return exitCode === undefined ? '退出码未知' : `退出码 ${exitCode}`
}

/** 只有已知成功退出码才在窄屏隐藏标题状态，展开输出标题补回。 */
export const isShellSuccessExit = (exitCode: number | undefined, cancelled: boolean): boolean =>
  !cancelled && exitCode === 0

/** 非零退出码默认展开，取消保持收起。 */
export const isShellFailureExit = (exitCode: number | undefined, cancelled: boolean): boolean =>
  !cancelled && exitCode !== undefined && exitCode !== 0
