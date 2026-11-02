/**
 * MCP 配置编辑的纯函数工具（G1.4d4）。
 *
 * 约束：
 * - 完整 JSON 草稿是唯一编辑权威；常用表单只修改目标键，未知字段原样保留；
 * - 项目 override 只写 enabled/exposure/toolExposure 三个字段；
 * - 不读取文件路径、不接触连接或凭据；这里只处理显式配置快照中的原文。
 */
import type { HarnessMcpConfigIssue, HarnessMcpExposure } from '@huan/protocol'

export type McpConfigScope = 'user' | 'project'

export const MCP_EXPOSURES: readonly HarnessMcpExposure[] = [
  'codemode',
  'deferred',
  'direct',
  'hidden',
]

export function isMcpExposure(value: unknown): value is HarnessMcpExposure {
  return typeof value === 'string' && MCP_EXPOSURES.includes(value as HarnessMcpExposure)
}

/** 单个 target/scope 的编辑草稿；原文与基线分开保存以计算未保存状态。 */
export type McpConfigDraft = {
  content: string
  baseContent: string
  revision: string | null
  issues: readonly HarnessMcpConfigIssue[]
}

export type McpConfigDraftMap = Record<string, McpConfigDraft>

export const mcpDraftKey = (targetKey: string, scope: McpConfigScope): string =>
  `${targetKey}|${scope}`

export type ParsedMcpDraft =
  | { value: Record<string, unknown>; error?: undefined }
  | { value?: undefined; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function findUnsafeKey(value: unknown, depth = 0): string | undefined {
  if (depth > 32) return '嵌套深度超过上限'
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findUnsafeKey(item, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) return key
    const hit = findUnsafeKey(item, depth + 1)
    if (hit) return hit
  }
  return undefined
}

/** 浏览器侧预检：JSON 可解析、根为对象、mcpServers 形状正确。 */
export function parseMcpDraft(content: string): ParsedMcpDraft {
  if (content.trim() === '') return { error: 'MCP 配置为空；请写入至少 `{}`。' }
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    // 不回显解析器原文，避免把可能含秘密的片段带进提示。
    return { error: 'JSON 解析失败；请检查括号、引号与逗号是否配对。' }
  }
  if (!isRecord(parsed)) return { error: 'MCP 配置根必须是 JSON 对象。' }
  const unsafe = findUnsafeKey(parsed)
  if (unsafe) return { error: `不允许的键：${unsafe}（原型污染防护）。` }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    return { error: 'mcpServers 必须是 JSON 对象。' }
  }
  return { value: parsed }
}

export type McpDraftServer = {
  name: string
  raw: Record<string, unknown>
  /** 项目作用域中没有 command/url/type 的条目视为 override。 */
  override: boolean
}

/** 列出草稿中的服务器条目；坏形状条目留给 JSON 编辑器修复。 */
export function listDraftServers(
  root: Record<string, unknown>,
  scope: McpConfigScope,
): McpDraftServer[] {
  const servers = root.mcpServers
  if (!isRecord(servers)) return []
  return Object.entries(servers).flatMap(([name, raw]) =>
    isRecord(raw)
      ? [
          {
            name,
            raw,
            override:
              scope === 'project' &&
              raw.command === undefined &&
              raw.url === undefined &&
              raw.type === undefined,
          },
        ]
      : [],
  )
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 在保留完整顶层结构的前提下新增/替换一个服务器条目。 */
export function setDraftServer(
  root: Record<string, unknown>,
  name: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next = clone(root)
  const servers = isRecord(next.mcpServers) ? next.mcpServers : {}
  servers[name] = value
  next.mcpServers = servers
  return next
}

/** 删除服务器条目；不触碰其他顶层字段。 */
export function removeDraftServer(
  root: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const next = clone(root)
  if (!isRecord(next.mcpServers)) return next
  delete next.mcpServers[name]
  return next
}

/** 将完整对象序列化为草稿文本（保留 2 空格与结尾换行）。 */
export function formatMcpDraft(root: Record<string, unknown>): string {
  return `${JSON.stringify(root, null, 2)}\n`
}

/** 读取字符串映射（env/headers/toolExposure）。 */
export function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([, item]) => typeof item === 'string')) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

/** 读取字符串数组（args）。 */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? [...value] : undefined
}

export type PairParseResult =
  | { value: Record<string, string>; error?: undefined }
  | { value?: undefined; error: string }

/** 解析 `NAME=value` 行；只按第一个等号切分，值允许包含等号。 */
export function parsePairs(text: string, label: string): PairParseResult {
  const value: Record<string, string> = {}
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) return { error: `${label}第 ${index + 1} 行缺少 NAME=value。` }
    const key = trimmed.slice(0, separator).trim()
    if (!key) return { error: `${label}第 ${index + 1} 行缺少名称。` }
    if (UNSAFE_KEYS.has(key)) return { error: `${label}包含不允许的保留键。` }
    value[key] = trimmed.slice(separator + 1).trim()
  }
  return { value }
}

/** 将字符串映射格式化为 `NAME=value` 行。 */
export function formatPairs(value: Record<string, string> | undefined): string {
  if (!value) return ''
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join('\n')
}

export type ParsedToolExposure =
  | { value: Record<string, HarnessMcpExposure>; error?: undefined }
  | { value?: undefined; error: string }

/** 解析 `tool=exposure` 行；通配符工具名保持原样。 */
export function parseToolExposure(text: string): ParsedToolExposure {
  const pairs = parsePairs(text, '工具 exposure ')
  if (pairs.error !== undefined) return { error: pairs.error }
  const value: Record<string, HarnessMcpExposure> = {}
  for (const [tool, exposure] of Object.entries(pairs.value)) {
    if (!isMcpExposure(exposure)) {
      return { error: `工具 ${tool} 的 exposure 必须是 ${MCP_EXPOSURES.join('、')} 之一。` }
    }
    value[tool] = exposure
  }
  return { value }
}

export type McpServerKind = 'stdio' | 'http' | 'override'

/** 常用表单的可编辑字段；enabled/exposure 使用 `unset` 表示删除该键。 */
export type McpServerForm = {
  name: string
  kind: McpServerKind
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
  enabled: 'unset' | 'true' | 'false'
  exposure: 'unset' | HarnessMcpExposure
  toolExposureText: string
}

export function serverKindOf(raw: Record<string, unknown>): McpServerKind {
  if (typeof raw.command === 'string') return 'stdio'
  if (typeof raw.url === 'string') return 'http'
  return 'override'
}

/** 从原始条目生成表单；未知字段不进入表单，但编辑时仍会保留。 */
export function formFromServer(
  name: string,
  raw: Record<string, unknown>,
  kind = serverKindOf(raw),
): McpServerForm {
  const enabled =
    raw.enabled === true ? 'true' : raw.enabled === false ? 'false' : ('unset' as const)
  const exposure = isMcpExposure(raw.exposure) ? raw.exposure : ('unset' as const)
  return {
    name,
    kind,
    command: typeof raw.command === 'string' ? raw.command : '',
    argsText: (stringArray(raw.args) ?? []).join('\n'),
    envText: formatPairs(stringRecord(raw.env)),
    url: typeof raw.url === 'string' ? raw.url : '',
    headersText: formatPairs(stringRecord(raw.headers)),
    enabled,
    exposure,
    toolExposureText: formatPairs(stringRecord(raw.toolExposure)),
  }
}

export type ApplyServerFormResult =
  | { root: Record<string, unknown>; error?: undefined }
  | { root?: undefined; error: string }

const SERVER_NAME = /^[A-Za-z0-9_-]+$/

/**
 * 应用表单到草稿：完整条目只改表单字段，override 只写允许的三个字段。
 * 名称变更会移除旧键；未知顶层字段与其他服务器条目保持不变。
 */
export function applyServerForm(
  root: Record<string, unknown>,
  originalName: string | undefined,
  form: McpServerForm,
): ApplyServerFormResult {
  const name = form.name.trim()
  if (!name) return { error: '服务器名称不能为空。' }
  if (!SERVER_NAME.test(name)) {
    return { error: '服务器名称只能使用字母、数字、下划线和连字符。' }
  }
  if (UNSAFE_KEYS.has(name)) return { error: '服务器名称不能使用保留键。' }

  const existingServers = isRecord(root.mcpServers) ? root.mcpServers : undefined
  if (name !== originalName && existingServers && Object.hasOwn(existingServers, name)) {
    return { error: '同名服务器已存在；请修改现有条目或使用其他名称。' }
  }
  const existing =
    originalName && existingServers && isRecord(existingServers[originalName])
      ? (existingServers[originalName] as Record<string, unknown>)
      : undefined

  let next: Record<string, unknown>
  if (form.kind === 'override') {
    const toolExposure = parseToolExposure(form.toolExposureText)
    if (toolExposure.error !== undefined) return { error: toolExposure.error }
    next = {}
    if (form.enabled !== 'unset') next.enabled = form.enabled === 'true'
    if (form.exposure !== 'unset') next.exposure = form.exposure
    if (Object.keys(toolExposure.value).length > 0) next.toolExposure = toolExposure.value
    if (Object.keys(next).length === 0) {
      return { error: '项目 override 至少需要设置 enabled、exposure 或 toolExposure 之一。' }
    }
  } else {
    // 编辑完整条目时保留既有未知字段；新增时从空对象开始。
    next = existing && serverKindOf(existing) === form.kind ? clone(existing) : {}
    if (form.kind === 'stdio') {
      const command = form.command.trim()
      if (!command) return { error: 'stdio 服务器需要 command。' }
      const args = form.argsText === '' ? [] : form.argsText.split('\n')
      const env = parsePairs(form.envText, '环境变量 ')
      if (env.error !== undefined) return { error: env.error }
      next.command = command
      if (args.length > 0) next.args = args
      else delete next.args
      if (Object.keys(env.value).length > 0) next.env = env.value
      else delete next.env
      delete next.url
      delete next.headers
    } else {
      const url = form.url.trim()
      if (!url) return { error: 'HTTP 服务器需要 url。' }
      if (!URL.canParse(url)) return { error: 'HTTP 服务器 url 不是有效 URL。' }
      const headers = parsePairs(form.headersText, 'HTTP headers ')
      if (headers.error !== undefined) return { error: headers.error }
      next.url = url
      if (Object.keys(headers.value).length > 0) next.headers = headers.value
      else delete next.headers
      delete next.command
      delete next.args
      delete next.env
      delete next.cwd
    }
    const toolExposure = parseToolExposure(form.toolExposureText)
    if (toolExposure.error !== undefined) return { error: toolExposure.error }
    if (form.enabled === 'unset') delete next.enabled
    else next.enabled = form.enabled === 'true'
    if (form.exposure === 'unset') delete next.exposure
    else next.exposure = form.exposure
    if (Object.keys(toolExposure.value).length > 0) next.toolExposure = toolExposure.value
    else delete next.toolExposure
  }

  let nextRoot = root
  if (originalName && originalName !== name) {
    nextRoot = removeDraftServer(nextRoot, originalName)
  }
  return { root: setDraftServer(nextRoot, name, next) }
}

/** 新增服务器时的默认表单（模板只填最小可用字段）。 */
export function emptyServerForm(kind: 'stdio' | 'http' | 'override'): McpServerForm {
  return {
    name: '',
    kind,
    command: kind === 'stdio' ? 'node' : '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
    enabled: 'unset',
    exposure: 'unset',
    toolExposureText: '',
  }
}
