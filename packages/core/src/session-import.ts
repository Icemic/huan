/**
 * JSONL 会话导入的严格解析与写入计划。
 *
 * 与 SDK 的 `parseSessionEntries`（会静默跳过坏行）不同，这里逐行严格解析：
 * 坏行、重复 header、未知版本、重复 ID、断链与循环一律拒绝，不把宽松读取
 * 得到的空/残缺会话冒充成功。
 *
 * 旧版 v1/v2 使用 SDK 公开的 `migrateSessionEntries` 迁移到当前版本后再校验；
 * 未知扩展条目类型只校验 tree 基字段，其余字段原样保留（透传），不复制一套
 * 庞大的消息 schema。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { CURRENT_SESSION_VERSION, migrateSessionEntries } from '@earendil-works/pi-coding-agent'
import type { HarnessThreadImportErrorCode, HarnessThreadImportSource } from '@huan/protocol'

/** 浏览器上传文本的合理上限（20MiB）。 */
export const IMPORT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/** 宿主路径源文件上限：防止误选超大文件导致宿主一次性读入内存。 */
export const IMPORT_HOST_FILE_MAX_BYTES = 128 * 1024 * 1024

/** 严格解析后的条目（保留原始对象，未知字段透传）。 */
export type ParsedImportEntry = Record<string, unknown> & {
  type: string
  id: string
  parentId: string | null
  timestamp: string
}

/** 严格解析后的会话。 */
export type ParsedImportSession = {
  /** 原始 header 对象（写入时作为基底，保留未知字段）。 */
  header: Record<string, unknown> & {
    id: string
    timestamp: string
    cwd: string
    version: number
    parentSession?: string
  }
  entries: ParsedImportEntry[]
  /** 条目文本行：当前版本保留原文，迁移版本为迁移后的 JSON。 */
  entryLines: string[]
  /** 源文件版本（迁移前）。 */
  sourceVersion: number
  /** 是否执行了版本迁移。 */
  migrated: boolean
  /** 显式会话名称（最后一条非空 session_info）。 */
  name?: string
  /** 源文本内容指纹；用于预览后确认时校验。 */
  fingerprint: string
  size: number
}

/** 解析失败。 */
export type ImportParseFailure = {
  error: HarnessThreadImportErrorCode
  message: string
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))

const failure = (error: HarnessThreadImportErrorCode, message: string): ImportParseFailure => ({
  error,
  message,
})

/** 条目基础结构校验（迁移后执行；未知类型只要求 tree 基字段）。 */
function validateEntry(
  entry: Record<string, unknown>,
  index: number,
): ImportParseFailure | undefined {
  const prefix = `第 ${index} 条`
  if (typeof entry.type !== 'string' || entry.type.length === 0 || entry.type === 'session') {
    return failure('invalid-entry', `${prefix}条目缺少有效 type`)
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0 || /\s/.test(entry.id)) {
    return failure('invalid-entry', `${prefix}条目缺少有效 id`)
  }
  if (entry.parentId !== null && typeof entry.parentId !== 'string') {
    return failure('invalid-entry', `${prefix}条目 parentId 必须是字符串或 null`)
  }
  if (!isValidTimestamp(entry.timestamp)) {
    return failure('invalid-entry', `${prefix}条目时间戳无效`)
  }
  switch (entry.type) {
    case 'message': {
      const message = entry.message
      if (!isRecord(message) || typeof message.role !== 'string') {
        return failure('invalid-entry', `${prefix}消息条目缺少有效 message.role`)
      }
      return undefined
    }
    case 'custom_message':
      return typeof entry.customType === 'string'
        ? undefined
        : failure('invalid-entry', `${prefix}自定义消息缺少 customType`)
    case 'compaction':
      return typeof entry.summary === 'string'
        ? undefined
        : failure('invalid-entry', `${prefix}压缩条目缺少 summary`)
    case 'branch_summary':
      return typeof entry.summary === 'string'
        ? undefined
        : failure('invalid-entry', `${prefix}分支摘要缺少 summary`)
    case 'label':
      return typeof entry.targetId === 'string'
        ? undefined
        : failure('invalid-entry', `${prefix}标签条目缺少 targetId`)
    case 'model_change':
      return typeof entry.provider === 'string' && typeof entry.modelId === 'string'
        ? undefined
        : failure('invalid-entry', `${prefix}模型切换缺少 provider/modelId`)
    case 'thinking_level_change':
      return typeof entry.thinkingLevel === 'string'
        ? undefined
        : failure('invalid-entry', `${prefix}Thinking 切换缺少级别`)
    default:
      // 未知扩展条目类型：只校验 tree 基字段，其余透传。
      return undefined
  }
}

/** 父链校验：所有 parentId 必须存在，且不存在环。 */
function validateParents(entries: readonly ParsedImportEntry[]): ImportParseFailure | undefined {
  const byId = new Map<string, ParsedImportEntry>()
  for (const entry of entries) byId.set(entry.id, entry)
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      return failure('broken-chain', `条目 ${entry.id} 的父节点 ${entry.parentId} 不存在`)
    }
  }
  // 0 = 未访问，1 = 当前链上，2 = 已确认无环（迭代，避免深链递归）。
  const state = new Map<string, 0 | 1 | 2>()
  for (const start of entries) {
    if (state.get(start.id) === 2) continue
    const path: string[] = []
    let cursor: ParsedImportEntry | undefined = start
    while (cursor) {
      const current = state.get(cursor.id) ?? 0
      if (current === 1) return failure('cycle', `条目父链存在循环：${cursor.id}`)
      if (current === 2) break
      state.set(cursor.id, 1)
      path.push(cursor.id)
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    for (const id of path) state.set(id, 2)
  }
  return undefined
}

/**
 * 严格解析 JSONL 会话文本。
 *
 * 空行/纯空白行可跳过；其余每一行都必须是合法 JSON 对象。首个非空行必须是
 * 唯一的 session header。当前版本保留条目原文（未知字段不丢失），旧版迁移后
 * 重新序列化。
 */
export function parseSessionJsonl(text: string): ParsedImportSession | ImportParseFailure {
  const lines = text.split(/\r?\n/)
  const parsed: unknown[] = []
  const rawLines: string[] = []
  for (const [index, rawLine] of lines.entries()) {
    if (rawLine.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(rawLine)
    } catch {
      return failure('invalid-json', `第 ${index + 1} 行不是合法 JSON，不能宽松跳过`)
    }
    if (!isRecord(value)) {
      return failure('invalid-json', `第 ${index + 1} 行不是 JSON 对象`)
    }
    parsed.push(value)
    rawLines.push(rawLine.trim())
  }
  if (parsed.length === 0) return failure('invalid-header', '文件为空，缺少会话 header')

  const first = parsed[0]
  if (!isRecord(first) || first.type !== 'session') {
    return failure('invalid-header', '首个非空行必须是会话 header')
  }
  for (let index = 1; index < parsed.length; index += 1) {
    const entry = parsed[index]
    if (isRecord(entry) && entry.type === 'session') {
      return failure('invalid-header', '文件中存在多个会话 header')
    }
  }

  if (typeof first.id !== 'string' || !SESSION_ID_PATTERN.test(first.id)) {
    return failure('invalid-header', '会话 header 的 id 无效')
  }
  if (!isValidTimestamp(first.timestamp)) {
    return failure('invalid-header', '会话 header 的时间戳无效')
  }
  if (first.cwd !== undefined && typeof first.cwd !== 'string') {
    return failure('invalid-header', '会话 header 的 cwd 必须是字符串')
  }
  if (first.parentSession !== undefined && typeof first.parentSession !== 'string') {
    return failure('invalid-header', '会话 header 的 parentSession 必须是字符串')
  }
  if (
    first.version !== undefined &&
    (typeof first.version !== 'number' || !Number.isInteger(first.version) || first.version < 1)
  ) {
    return failure('invalid-header', '会话 header 的 version 无效')
  }
  const sourceVersion = first.version ?? 1
  if (sourceVersion > CURRENT_SESSION_VERSION) {
    return failure(
      'unsupported-version',
      `不支持的会话版本 ${sourceVersion}（当前最高 ${CURRENT_SESSION_VERSION}）`,
    )
  }

  // 旧版：先做对象级检查，再经公开迁移补齐 id/parentId 与角色重命名。
  const rawEntries = parsed.slice(1) as Record<string, unknown>[]
  if (sourceVersion < 2) {
    for (const [index, entry] of rawEntries.entries()) {
      if (typeof entry.type !== 'string' || entry.type.length === 0) {
        return failure('invalid-entry', `第 ${index + 2} 行条目缺少有效 type`)
      }
    }
  }
  if (sourceVersion < CURRENT_SESSION_VERSION) {
    const fileEntries = [first, ...rawEntries] as unknown as Parameters<
      typeof migrateSessionEntries
    >[0]
    try {
      migrateSessionEntries(fileEntries)
    } catch (error) {
      return failure(
        'invalid-entry',
        `会话迁移失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // 迁移后重新取 header 与条目（v1 迁移会原地补 id/parentId）。
  const header = parsed[0] as Record<string, unknown>
  const entries: ParsedImportEntry[] = []
  const ids = new Set<string>()
  const entryLines: string[] = []
  for (const [index, entry] of (parsed.slice(1) as Record<string, unknown>[]).entries()) {
    const invalid = validateEntry(entry, index + 2)
    if (invalid) return invalid
    const typed = entry as ParsedImportEntry
    if (ids.has(typed.id)) {
      return failure('duplicate-entry', `条目 ID 重复：${typed.id}`)
    }
    ids.add(typed.id)
    entries.push(typed)
    // 迁移过的版本必须重新序列化；当前版本保留原文以避免格式/未知字段漂移。
    entryLines.push(
      sourceVersion < CURRENT_SESSION_VERSION ? JSON.stringify(entry) : (rawLines[index + 1] ?? ''),
    )
  }

  const parentFailure = validateParents(entries)
  if (parentFailure) return parentFailure
  for (const entry of entries) {
    for (const key of entry.type === 'compaction'
      ? ['firstKeptEntryId']
      : entry.type === 'label' || entry.type === 'context_edit'
        ? ['targetId']
        : []) {
      if (typeof entry[key] !== 'string' || !ids.has(entry[key] as string)) {
        return failure('invalid-entry', `条目 ${entry.id} 的 ${key} 引用无效`)
      }
    }
  }

  let name: string | undefined
  for (const entry of entries) {
    if (entry.type !== 'session_info') continue
    const value = entry.name
    name = typeof value === 'string' && value.trim() ? value : undefined
  }

  const normalizedHeader = header as ParsedImportSession['header']
  return {
    header: {
      ...normalizedHeader,
      id: normalizedHeader.id,
      timestamp: normalizedHeader.timestamp,
      cwd: normalizedHeader.cwd ?? '',
      version: CURRENT_SESSION_VERSION,
      ...(typeof normalizedHeader.parentSession === 'string'
        ? { parentSession: normalizedHeader.parentSession }
        : {}),
    },
    entries,
    entryLines,
    sourceVersion,
    migrated: sourceVersion < CURRENT_SESSION_VERSION,
    ...(name ? { name } : {}),
    fingerprint: createHash('sha256').update(text).digest('hex'),
    size: Buffer.byteLength(text, 'utf8'),
  }
}

/** 读取导入源（宿主路径或上传文本）。 */
export async function readImportSource(
  source: HarnessThreadImportSource,
): Promise<{ text: string; sourcePath?: string } | ImportParseFailure> {
  if (source.kind === 'upload') {
    if (typeof source.content !== 'string') {
      return failure('invalid-input', '上传内容必须是文本')
    }
    if (Buffer.byteLength(source.content, 'utf8') > IMPORT_UPLOAD_MAX_BYTES) {
      return failure(
        'source-too-large',
        `上传的 JSONL 超过 ${Math.floor(IMPORT_UPLOAD_MAX_BYTES / (1024 * 1024))}MiB 上限`,
      )
    }
    return { text: source.content }
  }

  const requested = source.path.trim()
  if (!requested || !isAbsolute(requested)) {
    return failure('invalid-input', '请输入宿主机器上的 JSONL 绝对路径')
  }
  try {
    const info = await stat(requested)
    if (!info.isFile()) {
      return failure('source-unreadable', '导入路径不是文件')
    }
    if (info.size > IMPORT_HOST_FILE_MAX_BYTES) {
      return failure('source-too-large', '导入文件超过宿主读取上限（128MiB）')
    }
    return { text: await readFile(requested, 'utf8'), sourcePath: requested }
  } catch (error) {
    return failure(
      'source-unreadable',
      `无法读取导入文件：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** 写入计划：决定 header 的新 ID/cwd/血缘。 */
export type ImportWritePlan = {
  /** 目标会话 ID：默认保留源 ID；副本使用随机 UUID。 */
  id: string
  /** 实际起始目录（源 cwd 或显式替代）。 */
  cwd: string
  /** 父会话血缘；宿主路径源缺省记录源文件路径。 */
  parentSession?: string
  copy: boolean
}

/** 构造确认导入时的写入计划。 */
export function planImportWrite(
  parsed: ParsedImportSession,
  options: { cwd: string; sourcePath?: string; asCopy: boolean },
): ImportWritePlan {
  const parentSession = parsed.header.parentSession ?? options.sourcePath
  return {
    id: options.asCopy ? randomUUID() : parsed.header.id,
    cwd: options.cwd,
    ...(parentSession ? { parentSession } : {}),
    copy: options.asCopy,
  }
}

/** 序列化导入文件文本（header 重写 + 条目原样/迁移后文本）。 */
export function buildImportText(parsed: ParsedImportSession, plan: ImportWritePlan): string {
  const header: Record<string, unknown> = {
    ...parsed.header,
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: plan.id,
    cwd: plan.cwd,
  }
  if (plan.parentSession !== undefined) header.parentSession = plan.parentSession
  else delete header.parentSession
  const entryBlock = parsed.entryLines.length > 0 ? `${parsed.entryLines.join('\n')}\n` : ''
  return `${JSON.stringify(header)}\n${entryBlock}`
}

/**
 * 目标文件名（Pi 的「时间戳_ID.jsonl」约定；不使用上传文件名拼接）。
 *
 * header 时间戳只要求可解析，可能含斜杠（如 `2026/10/31`）。统一规范为
 * ISO 字符串再替换分隔符，避免生成嵌套目录或把路径字符带进文件名。
 */
export function importFileName(parsed: ParsedImportSession, id: string): string {
  const fileTimestamp = new Date(parsed.header.timestamp).toISOString().replace(/[:.]/g, '-')
  return `${fileTimestamp}_${id}.jsonl`
}

/**
 * 判断既有会话文件是否与本次导入「内容完全相同」。
 *
 * 比较语义内容（header 的有效字段 + 条目深度相等），而不是原始文本，
 * 使格式差异不会被误判为冲突；已有文件无法严格解析时按冲突处理。
 */
export function importMatchesExisting(
  existingText: string,
  parsed: ParsedImportSession,
  plan: ImportWritePlan,
): boolean {
  const existing = parseSessionJsonl(existingText)
  if ('error' in existing) return false
  if (existing.header.id !== plan.id) return false
  if (existing.header.cwd !== plan.cwd) return false
  if (existing.header.parentSession !== plan.parentSession) return false
  if (existing.header.timestamp !== parsed.header.timestamp) return false
  if (existing.entries.length !== parsed.entries.length) return false
  for (const [index, entry] of existing.entries.entries()) {
    if (JSON.stringify(entry) !== JSON.stringify(parsed.entries[index])) return false
  }
  return true
}
