/**
 * 设置文件读写与校验（G1.4a）。
 *
 * 只使用 Pi SDK 根入口公开能力：
 * - `getPackageDir()` 定位随包分发的 `schemas/settings.schema.json`；
 * - `CONFIG_DIR_NAME` 确定项目设置目录；
 * - `SettingsManager` 计算与运行时一致的合并结果（含迁移与 defaultTools 合并）。
 *
 * 不使用 SDK 的私有 SettingsSchema，也不深导入 dist 内部模块。
 * 原文编辑是「整份文件」语义：校验已知字段、允许未知字段透传、保留用户
 * 手写的扩展配置；不重建配置对象。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_DIR_NAME, getPackageDir, SettingsManager } from '@earendil-works/pi-coding-agent'
import type {
  HarnessSettingsEffective,
  HarnessSettingsFile,
  HarnessSettingsIssue,
  HarnessSettingsOrigin,
  HarnessSettingsScope,
} from '@huan/protocol'
import Ajv2020 from 'ajv/dist/2020.js'

/** 单个设置文件读取上限（字节）。超过时只报告大小，不返回不完整原文。 */
export const SETTINGS_FILE_MAX_BYTES = 512 * 1024

/** 写入/校验上限与读取一致；HTTP 层另有请求体上限。 */
export const SETTINGS_CONTENT_MAX_BYTES = SETTINGS_FILE_MAX_BYTES

/** 需要重启宿主才能生效的顶层字段（保存时提示，不假装已应用）。 */
const RESTART_REQUIRED_KEYS: readonly string[] = [
  'sessionDir',
  'httpProxy',
  'shellPath',
  'shellCommandPrefix',
  'defaultProjectTrust',
  'npmCommand',
  'externalEditor',
  'enableInstallTelemetry',
]

/** 拒绝的原型污染键。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 单个设置文件在磁盘上的状态（与协议形状一致）。 */
export type SettingsFileState = HarnessSettingsFile

/** 项目/用户设置文件的绝对路径（与 SDK 的 FileSettingsStorage 一致）。 */
export function settingsFilePaths(
  cwd: string,
  agentDir: string,
): { user: string; project: string } {
  return {
    user: join(agentDir, 'settings.json'),
    project: join(cwd, CONFIG_DIR_NAME, 'settings.json'),
  }
}

/** 内容 revision：UTF-8 字节的 SHA-256；不存在文件用 null 表示。 */
export function settingsRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 文本的 UTF-8 字节数（用于大小限制，不按 UTF-16 长度计算）。 */
export function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

type SettingsValidator = {
  validate: (value: unknown) => boolean
  errors: () => Ajv2020['errors']
}
let cachedValidator: SettingsValidator | undefined

/**
 * 编译随包 settings schema。
 *
 * 源 schema 当前允许未知顶层字段；若未来版本禁止，这里只把顶层
 * `additionalProperties` 放开，保留扩展配置透传（不修改其他校验规则）。
 */
function settingsValidator(): SettingsValidator {
  if (cachedValidator) return cachedValidator
  const schemaPath = join(getPackageDir(), 'schemas', 'settings.schema.json')
  // 同步读取：校验器只在首次使用时构建一次，避免每次保存都读 700+ 行 schema。
  const raw = readFileSync(schemaPath, 'utf8')
  const schema = JSON.parse(raw) as Record<string, unknown>
  schema.additionalProperties = true
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
  const compiled = ajv.compile(schema)
  cachedValidator = {
    validate: (value) => compiled(value) === true,
    errors: () => compiled.errors,
  }
  return cachedValidator
}

/** 递归检查原型污染键；返回命中的 JSON Pointer。 */
function findUnsafeKey(value: unknown, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findUnsafeKey(item, `${path}/${index}`)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) return `${path}/${key}`
    const hit = findUnsafeKey(item, `${path}/${key}`)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 解析并校验原文；返回解析值（有效时）与问题列表。原文始终可用于修复。 */
export function parseSettingsContent(content: string): {
  value?: Record<string, unknown>
  issues: HarnessSettingsIssue[]
} {
  const issues: HarnessSettingsIssue[] = []
  if (content.trim() === '') {
    issues.push({ kind: 'parse', path: '/', message: '设置文件为空；请写入至少 `{}`。' })
    return { issues }
  }
  // 与 SDK 一致：允许 UTF-8 BOM；保存仍写回原文（不改变字节）。
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    // 不回显解析器错误原文：V8 的 JSON.parse 报错可能带输入片段（含密码等）。
    issues.push({
      kind: 'parse',
      path: '/',
      message: 'JSON 解析失败；请检查括号、引号与逗号是否配对。',
    })
    return { issues }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push({ kind: 'schema', path: '/', message: '设置根必须是 JSON 对象。' })
    return { issues }
  }
  const value = parsed as Record<string, unknown>
  const unsafePath = findUnsafeKey(value)
  if (unsafePath !== undefined) {
    issues.push({
      kind: 'unsafe-key',
      path: unsafePath,
      message: '不允许包含 __proto__/constructor/prototype 键。',
    })
    return { issues }
  }
  const validate = settingsValidator()
  if (!validate.validate(value)) {
    const errors = validate.errors() ?? []
    for (const error of errors.slice(0, 50)) {
      issues.push({
        kind: 'schema',
        path: error.instancePath || '/',
        message: `字段校验失败（${error.keyword}）：${error.message ?? '不符合 schema'}`,
      })
    }
  }
  return { value, issues }
}

/**
 * 读取一个设置文件。
 *
 * 超过上限时不返回不完整原文（避免 GUI 以为可安全保存）；项目未信任时
 * 调用方传入 readable=false，原文恒为空且不读盘。
 */
export async function readSettingsFile(
  path: string,
  scope: HarnessSettingsScope,
  options: { readable?: boolean } = {},
): Promise<SettingsFileState> {
  const readable = options.readable !== false
  if (!readable) {
    return {
      path,
      scope,
      readable: false,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
    }
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        path,
        scope,
        readable: true,
        exists: false,
        content: '',
        revision: null,
        bytes: 0,
        tooLarge: false,
        issues: [],
      }
    }
    return {
      path,
      scope,
      readable: true,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
      readError: '无法读取设置文件；请检查文件权限。',
    }
  }
  if (!info.isFile()) {
    return {
      path,
      scope,
      readable: true,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
      readError: '设置路径不是普通文件。',
    }
  }
  if (info.size > SETTINGS_FILE_MAX_BYTES) {
    return {
      path,
      scope,
      readable: true,
      exists: true,
      content: '',
      revision: null,
      bytes: info.size,
      tooLarge: true,
      issues: [
        {
          kind: 'too-large',
          path: '/',
          message: `设置文件超过读取上限（${SETTINGS_FILE_MAX_BYTES} 字节），未加载原文。`,
        },
      ],
    }
  }
  try {
    // 直接有界读取，防止 stat 后文件增长或被替换造成无界分配。
    const handle = await open(path, 'r')
    let bytes = 0
    const buffer = Buffer.alloc(SETTINGS_FILE_MAX_BYTES + 1)
    try {
      while (bytes < buffer.length) {
        const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
        if (chunk.bytesRead === 0) break
        bytes += chunk.bytesRead
      }
    } finally {
      await handle.close()
    }
    if (bytes > SETTINGS_FILE_MAX_BYTES) {
      return {
        path,
        scope,
        readable: true,
        exists: true,
        content: '',
        revision: null,
        bytes,
        tooLarge: true,
        issues: [{ kind: 'too-large', path: '/', message: '设置文件超过读取上限，未加载原文。' }],
      }
    }
    const content = buffer.toString('utf8', 0, bytes)
    const { issues } = parseSettingsContent(content)
    return {
      path,
      scope,
      readable: true,
      exists: true,
      content,
      revision: settingsRevision(content),
      bytes: byteLengthOf(content),
      tooLarge: false,
      issues,
    }
  } catch {
    return {
      path,
      scope,
      readable: true,
      exists: true,
      content: '',
      revision: null,
      bytes: info.size,
      tooLarge: false,
      issues: [],
      readError: '无法读取设置文件；请检查文件权限。',
    }
  }
}

/**
 * 计算与 SDK 一致的磁盘合并结果（含迁移/defaultTools 合并）。
 *
 * 来源按顶层键判断：项目文件优先，其次用户文件；其余键记为 default。
 * 只将有界读取且通过解析/schema 校验的原文交给 SDK；损坏或过大文件
 * 保留在文件视图中供修复，不参与磁盘合并预览。
 */
export function mergeSettingsFromDisk(options: {
  cwd: string
  agentDir: string
  projectTrusted: boolean
  files: { user: HarnessSettingsFile; project: HarnessSettingsFile }
}): HarnessSettingsEffective {
  // 仅把本次有界读取、校验通过的原文交给 SDK 合并，避免 SDK 重新无界读盘。
  const safeContent = (file: HarnessSettingsFile) =>
    file.readable && file.exists && !file.tooLarge && !file.readError && file.issues.length === 0
      ? file.content
      : '{}'
  const manager = SettingsManager.fromStorage(
    {
      withLock(scope, action) {
        action(safeContent(scope === 'global' ? options.files.user : options.files.project))
      },
    },
    { projectTrusted: options.projectTrusted },
  )
  manager.drainErrors()
  return settingsEffectiveOfManager(manager, 'disk')
}

/** 由指定 manager 的已加载值计算来源（磁盘或 live 会话共用）。 */
export function settingsEffectiveOfManager(
  manager: SettingsManager,
  source: HarnessSettingsEffective['source'],
): HarnessSettingsEffective {
  const global = manager.getGlobalSettings() as Record<string, unknown>
  const project = manager.getProjectSettings() as Record<string, unknown>
  const values = manager.getSettings() as Record<string, unknown>
  const origins: Record<string, HarnessSettingsOrigin> = {}
  for (const key of Object.keys(values)) {
    if (Object.hasOwn(project, key)) origins[key] = 'project'
    else if (Object.hasOwn(global, key)) origins[key] = 'user'
    else origins[key] = 'default'
  }
  return { source, values, origins }
}

/** 稳定序列化：键排序后比较，避免 JSON 键顺序造成“需重载”误报。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
  return `{${entries.join(',')}}`
}

/** 两组合并值是否等价（键顺序不敏感）。 */
export function settingsEquivalent(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return stableJson(left ?? {}) === stableJson(right ?? {})
}

/** 顶层键变化集合（用于提示需重载/重启的字段）。 */
export function changedTopLevelKeys(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const changed: string[] = []
  for (const key of keys) {
    const left = before?.[key]
    const right = after?.[key]
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(key)
  }
  return changed
}

/** 变化中需要重启宿主才能生效的字段。 */
export function restartRequiredKeys(changedKeys: readonly string[]): string[] {
  return changedKeys.filter((key) => RESTART_REQUIRED_KEYS.includes(key))
}

/**
 * 原子写入：同目录临时文件 + rename 覆盖。
 *
 * 不做跨进程锁（设计明确仅单宿主支持写入事务）；宿主内部由 settingsWrites
 * 串行。失败时清理临时文件并抛出受控错误，由调用方如实报告。
 */
export async function writeSettingsFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
