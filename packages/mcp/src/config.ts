/**
 * MCP 服务器配置的解析、校验与合并（G1.4d1）。
 *
 * 选择性移植自 `@earendil-works/pi-coding-agent@1.4.0`：
 * - `packages/coding-agent/src/extensions/mcp/config.ts`
 * - `packages/coding-agent/src/core/mcp-servers.ts`
 * 原实现为 MIT 许可，版权与指纹见 `packages/mcp/THIRD-PARTY-NOTICES.md`。
 *
 * 本地差异：
 * - 路径与 Pi 共享：`<agentDir>/mcp.json` 与 `<cwd>/.pi/mcp.json`；
 * - 项目是否读取由调用方显式传入的 projectTrusted 决定，不以文件存在代替信任；
 * - 结构化逐项诊断，错误信息不回显原文或配置值；
 * - 增加原型污染键与嵌套深度检查；
 * - 仅保留配置阶段需要的校验、exposure、namespace 与合并逻辑，不包含 registry、
 *   连接、工具注册或 OAuth 运行时。
 */

import { resolve } from 'node:path'
import type { McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent'
import { MCP_CONFIG_FILE_MAX_BYTES, type McpConfigRead, readMcpConfigText } from './file-io.js'
import { mcpConfigPaths } from './paths.js'

/** 配置作用域。 */
export type McpConfigScope = 'user' | 'project'

/** 配置嵌套深度上限；超过时受控拒绝，避免递归扫描爆栈。 */
export const MCP_CONFIG_MAX_DEPTH = 32

/** 项目 override 允许设置的唯一三个字段。 */
export const MCP_SERVER_OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'] as const

const OVERRIDE_KEY_SET: ReadonlySet<string> = new Set(MCP_SERVER_OVERRIDE_KEYS)

/** 当前支持的 exposure 值。 */
export const MCP_EXPOSURES: readonly McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden']

/** 旧 exposure 名称；校验时归一化为当前名称。 */
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = {
  'codemode-deferred': 'codemode',
}

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** 单个诊断项。`file` 是配置文件路径，`server` 是出错条目名（若有）。 */
export type McpConfigIssueKind =
  | 'parse'
  | 'shape'
  | 'unsafe-key'
  | 'too-deep'
  | 'too-large'
  | 'read'
  | 'invalid-server'
  | 'invalid-override'
  | 'namespace-collision'
  | 'project-auth'

/** 逐项诊断；消息只描述字段/原因，不回显配置值。 */
export interface McpConfigIssue {
  kind: McpConfigIssueKind
  scope: McpConfigScope
  file: string
  server?: string
  message: string
}

/** 项目 override 的三个字段。 */
export interface McpServerOverrides {
  enabled?: boolean
  exposure?: McpExposure
  toolExposure?: Record<string, McpExposure>
}

/** 解析后的单个服务器条目。 */
export interface McpConfigDocumentServer {
  name: string
  override: boolean
  raw: Record<string, unknown>
  /** 完整条目校验后的配置；override 条目为空。 */
  config?: McpServerConfig
  /** override 条目归一化后的三个字段。 */
  overrides?: McpServerOverrides
}

/** 单个配置文件的解析结果。`value` 保留未知顶层字段。 */
export interface McpConfigDocument {
  scope: McpConfigScope
  path: string
  value?: Record<string, unknown>
  servers: McpConfigDocumentServer[]
  autoEnableCodemode?: boolean
  issues: McpConfigIssue[]
}

/** 合并后的服务器条目。override 条目的 source/scope 仍指向用户条目。 */
export interface McpServerEntry {
  name: string
  config: McpServerConfig
  source: string
  scope: McpConfigScope
  /** 项目 override 文件路径。 */
  override?: string
}

/** 合并后的有效配置。 */
export interface LoadedMcpConfig {
  servers: McpServerEntry[]
  /** codemode 自动启用开关；缺省时由连接层按 true 处理。 */
  autoEnableCodemode?: boolean
  issues: McpConfigIssue[]
  /** 项目配置路径；仅项目已信任时提供。 */
  projectConfig?: string
}

/** 读取并合并配置的输入。 */
export interface LoadMcpConfigOptions {
  agentDir: string
  cwd: string
  projectTrusted: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

/** 解析时剥离 UTF-8 BOM；原文仍保留 BOM，revision 按实际字节计算。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 工具名模式：`*` 匹配任意字符，其余字符按字面量处理。 */
function toolPatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`)
}

/** 服务器工具命名空间：`mcp__<server>`，`-` 替换为 `_`。 */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`
}

/** 服务器名是否合法。 */
export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME.test(name)
}

/** 诊断信息中使用的安全条目名：转义并截断，避免异常名称污染日志。 */
function serverLabel(name: string): string {
  const clipped = name.length > 64 ? `${name.slice(0, 61)}...` : name
  return JSON.stringify(clipped)
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && MCP_EXPOSURES.includes(value as McpExposure)
}

/** 旧 exposure 名称归一化为当前名称；其它值原样返回。 */
export function resolveMcpExposureAlias(value: unknown): unknown {
  if (typeof value !== 'string') return value
  // 用 hasOwn 避免 __proto__/constructor 等键命中 Object 原型。
  return Object.hasOwn(MCP_EXPOSURE_ALIASES, value) ? MCP_EXPOSURE_ALIASES[value] : value
}

/** 复制条目并归一化 exposure/toolExposure 别名，未知字段保持不变。 */
function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
  const { exposure, toolExposure } = value
  const resolved: Record<string, unknown> = { ...value }
  if (exposure !== undefined) resolved.exposure = resolveMcpExposureAlias(exposure)
  if (isRecord(toolExposure)) {
    resolved.toolExposure = Object.fromEntries(
      Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveMcpExposureAlias(entry)]),
    )
  }
  return resolved
}

/** 单个工具的 exposure：精确名优先，其次按对象顺序首个通配匹配，最后服务器默认值。 */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
  const overrides = config.toolExposure ?? {}
  // 只读取自有键，避免工具名恰好是 __proto__/constructor 时命中 Object 原型。
  const exact = Object.hasOwn(overrides, toolName) ? overrides[toolName] : undefined
  if (exact !== undefined) return exact
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes('*') && toolPatternRegExp(pattern).test(toolName)) return exposure
  }
  return config.exposure ?? 'codemode'
}

/** 是否是可被 loopback 回调服务器承载的 redirect URI。 */
function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.search === '' &&
    url.hash === ''
  )
}

/** 校验 OAuth 配置；返回错误消息或 undefined。 */
function validateOAuth(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return 'oauth 必须是对象'
  if (value.clientId !== undefined && typeof value.clientId !== 'string') {
    return 'oauth.clientId 必须是字符串'
  }
  if (value.clientSecret !== undefined && typeof value.clientSecret !== 'string') {
    return 'oauth.clientSecret 必须是字符串'
  }
  const port = value.callbackPort
  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    return 'oauth.callbackPort 必须是有效端口号'
  }
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== 'string' || !isLoopbackRedirectUri(value.callbackUrl)) {
      return 'oauth.callbackUrl 必须是 localhost、127.0.0.1 或 [::1] 上不带查询/片段的 http URI'
    }
    const urlPort = new URL(value.callbackUrl).port
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return 'oauth.callbackUrl 与 oauth.callbackPort 指定的端口不一致'
    }
  }
  if (value.scope !== undefined && typeof value.scope !== 'string') {
    return 'oauth.scope 必须是字符串'
  }
  if (
    value.clientName !== undefined &&
    (typeof value.clientName !== 'string' || !value.clientName.trim())
  ) {
    return 'oauth.clientName 必须是非空字符串'
  }
  if (value.clientRegistration !== undefined && value.clientRegistration !== 'dcr') {
    if (value.clientRegistration !== 'cimd') {
      return 'oauth.clientRegistration 必须是 "dcr" 或 "cimd"'
    }
    if (value.clientId !== undefined || value.clientName !== undefined) {
      return 'oauth.clientRegistration "cimd" 不能与 oauth.clientId 或 oauth.clientName 同时使用'
    }
    const callback = typeof value.callbackUrl === 'string' ? new URL(value.callbackUrl) : undefined
    if (callback && (callback.hostname === '[::1]' || callback.pathname !== '/callback')) {
      return 'oauth.clientRegistration "cimd" 要求 callbackUrl 使用 localhost 或 127.0.0.1 且路径为 /callback'
    }
  }
  const metadataUrl = value.authServerMetadataUrl
  if (metadataUrl !== undefined) {
    const url =
      typeof metadataUrl === 'string' && URL.canParse(metadataUrl)
        ? new URL(metadataUrl)
        : undefined
    if (
      !url ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))
      )
    ) {
      return 'oauth.authServerMetadataUrl 必须是 https URL，或 localhost/127.0.0.1/[::1] 上的 http URL'
    }
  }
  return undefined
}

/** 校验一个 override 条目的三个字段。 */
function validateMcpServerOverrides(
  name: string,
  raw: Record<string, unknown>,
): McpServerOverrides | string {
  const label = serverLabel(name)
  const value = resolveExposureAliases(raw)
  const { enabled, exposure, toolExposure } = value
  const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join('、')
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return `server ${label}: enabled 必须是布尔值`
  }
  if (exposure !== undefined && !isExposure(exposure)) {
    return `server ${label}: exposure 必须是 ${exposures} 之一`
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) {
      return `server ${label}: toolExposure 必须把工具名映射到 exposure`
    }
    for (const [tool, entry] of Object.entries(toolExposure)) {
      if (!isExposure(entry)) {
        return `server ${label}: toolExposure 的 ${serverLabel(tool)} 必须是 ${exposures} 之一`
      }
    }
  }
  const overrides: McpServerOverrides = {}
  if (enabled !== undefined) overrides.enabled = enabled
  if (exposure !== undefined) overrides.exposure = exposure
  if (toolExposure !== undefined) {
    overrides.toolExposure = toolExposure as Record<string, McpExposure>
  }
  return overrides
}

/**
 * 校验 `mcpServers` 形状中的单个完整条目。
 *
 * 返回归一化 exposure 别名后的配置副本（未知字段保留），或错误消息。
 * 移植自上游 `validateMcpServerConfig`，错误消息不回显配置值。
 */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
  const label = serverLabel(name)
  if (!isValidMcpServerName(name)) {
    return `server ${label} 名称无效（只能使用字母、数字、_ 和 -）`
  }
  if (!isRecord(raw)) return `server ${label} 必须是对象`
  const value = resolveExposureAliases(raw)
  const { type, exposure, enabled, timeout, toolExposure, description } = value
  const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join('、')
  if (exposure !== undefined && !isExposure(exposure)) {
    return `server ${label}: exposure 必须是 ${exposures} 之一`
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) {
      return `server ${label}: toolExposure 必须把工具名映射到 exposure`
    }
    for (const [tool, entry] of Object.entries(toolExposure)) {
      if (!isExposure(entry)) {
        return `server ${label}: toolExposure 的 ${serverLabel(tool)} 必须是 ${exposures} 之一`
      }
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return `server ${label}: enabled 必须是布尔值`
  }
  if (description !== undefined && typeof description !== 'string') {
    return `server ${label}: description 必须是字符串`
  }
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' || !Number.isFinite(timeout) || !(timeout > 0))
  ) {
    return `server ${label}: timeout 必须是有限的正数秒`
  }
  if (type === 'sse') {
    return `server ${label}: 不支持旧版 SSE transport；请使用 streamable HTTP URL`
  }

  if (
    typeof value.url === 'string' &&
    (type === undefined || type === 'http' || type === 'streamable-http')
  ) {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
      return `server ${label}: url 必须是 http 或 https URL`
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return `server ${label}: headers 必须把名称映射到字符串`
    }
    const oauthError = validateOAuth(value.oauth)
    if (oauthError) return `server ${label}: ${oauthError}`
    if (value.auth !== undefined) {
      if (
        !isRecord(value.auth) ||
        typeof value.auth.provider !== 'string' ||
        !value.auth.provider
      ) {
        return `server ${label}: auth.provider 必须是 provider 名称`
      }
      const url = new URL(value.url)
      if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
        return `server ${label}: auth 要求 https URL，或 localhost/127.0.0.1/[::1] 上的 http URL`
      }
    }
    return value as unknown as McpServerConfig
  }

  if (typeof value.command === 'string' && (type === undefined || type === 'stdio')) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string'))
    ) {
      return `server ${label}: args 必须是字符串数组`
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return `server ${label}: env 必须把名称映射到字符串`
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
      return `server ${label}: cwd 必须是字符串`
    }
    return value as unknown as McpServerConfig
  }

  return `server ${label} 需要 "command"（stdio）或 "url"（streamable HTTP）`
}

/** 条目是否只覆盖 enabled/exposure/toolExposure，而不是定义新服务器。 */
export function isMcpServerConfigOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined
}

interface ScanIssue {
  kind: 'unsafe-key' | 'too-deep'
  message: string
}

/** 受控深度递归扫描原型污染键；超过深度上限立即停止。 */
function scanConfigValue(value: unknown, depth: number, path: string): ScanIssue | undefined {
  if (depth > MCP_CONFIG_MAX_DEPTH) {
    return {
      kind: 'too-deep',
      message: `配置嵌套超过上限（${MCP_CONFIG_MAX_DEPTH} 层）`,
    }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = scanConfigValue(value[index], depth + 1, `${path}/${index}`)
      if (issue) return issue
    }
    return undefined
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) {
        return { kind: 'unsafe-key', message: `禁止的原型污染键：${path}/${key}` }
      }
      const issue = scanConfigValue(child, depth + 1, `${path}/${key}`)
      if (issue) return issue
    }
  }
  return undefined
}

/** 解析错误只保留 JSON 位置，绝不回显可能包含秘密的原文片段。 */
function parseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const position = /position\s+(\d+)/i.exec(message)?.[1]
  return position ? `JSON 解析失败（位置 ${position}）` : 'JSON 解析失败'
}

function makeIssue(
  kind: McpConfigIssueKind,
  context: { scope: McpConfigScope; path: string },
  message: string,
  server?: string,
): McpConfigIssue {
  return {
    kind,
    scope: context.scope,
    file: context.path,
    ...(server === undefined ? {} : { server }),
    message,
  }
}

/**
 * 解析并校验单个配置文件。
 *
 * 无效条目逐项诊断并跳过；文件级解析/形状/污染/深度错误返回空 servers。
 * 项目 override 的“是否存在同名用户条目”在合并阶段判断。
 */
export function parseMcpConfigContent(
  content: string,
  context: { scope: McpConfigScope; path: string },
): McpConfigDocument {
  const document: McpConfigDocument = {
    scope: context.scope,
    path: context.path,
    servers: [],
    issues: [],
  }
  const push = (kind: McpConfigIssueKind, message: string, server?: string) => {
    document.issues.push(makeIssue(kind, context, message, server))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(content))
  } catch (error) {
    push('parse', parseErrorMessage(error))
    return document
  }

  const scanIssue = scanConfigValue(parsed, 0, '')
  if (scanIssue) {
    push(scanIssue.kind, scanIssue.message)
    return document
  }
  if (!isRecord(parsed)) {
    push('shape', '配置顶层必须是对象。')
    return document
  }
  document.value = parsed

  const rawServers = parsed.mcpServers
  if (rawServers !== undefined && !isRecord(rawServers)) {
    push('shape', 'mcpServers 必须是对象。')
    return document
  }
  if (parsed.autoEnableCodemode !== undefined) {
    if (typeof parsed.autoEnableCodemode === 'boolean') {
      document.autoEnableCodemode = parsed.autoEnableCodemode
    } else {
      push('shape', 'autoEnableCodemode 必须是布尔值。')
    }
  }
  if (rawServers === undefined) return document

  // 同一文件内的完整条目必须命名空间唯一；override 的碰撞依赖用户条目，留给合并阶段。
  const namespaces = new Map<string, string>()
  for (const [name, raw] of Object.entries(rawServers)) {
    if (!isRecord(raw)) {
      push('invalid-server', `server ${serverLabel(name)} 必须是对象。`, name)
      continue
    }
    if (!isValidMcpServerName(name)) {
      push(
        'invalid-server',
        `server ${serverLabel(name)} 名称无效（只能使用字母、数字、_ 和 -）。`,
        name,
      )
      continue
    }

    if (context.scope === 'project' && isMcpServerConfigOverride(raw)) {
      const extraKeys = Object.keys(raw).filter((key) => !OVERRIDE_KEY_SET.has(key))
      if (extraKeys.length > 0) {
        push(
          'invalid-override',
          `server ${serverLabel(name)}: 项目 override 只能设置 ${MCP_SERVER_OVERRIDE_KEYS.join('、')}`,
          name,
        )
        continue
      }
      const overrides = validateMcpServerOverrides(name, raw)
      if (typeof overrides === 'string') {
        push('invalid-override', overrides, name)
        continue
      }
      document.servers.push({ name, override: true, raw, overrides })
      continue
    }

    const config = validateMcpServerConfig(name, raw)
    if (typeof config === 'string') {
      push('invalid-server', config, name)
      continue
    }
    if (context.scope === 'project' && 'url' in config && config.auth) {
      push('project-auth', `server ${serverLabel(name)}: 项目配置不允许 auth.provider`, name)
      continue
    }
    const namespace = mcpNamespace(name)
    const clash = namespaces.get(namespace)
    if (clash !== undefined && clash !== name) {
      push(
        'namespace-collision',
        `server ${serverLabel(name)} 与 ${serverLabel(clash)} 的命名空间冲突（${namespace}）`,
        name,
      )
      continue
    }
    namespaces.set(namespace, name)
    document.servers.push({ name, override: false, raw, config })
  }
  return document
}

/**
 * 合并用户与项目配置。
 *
 * - 项目完整条目替换同名用户条目；
 * - 项目 override 只取 enabled/exposure/toolExposure，保留用户连接字段与凭据；
 * - 命名空间碰撞通过 Map 线性检查；
 * - 无效条目已由解析阶段跳过，这里只补充跨文件诊断。
 */
export function mergeMcpConfigDocuments(
  user: McpConfigDocument,
  project?: McpConfigDocument,
): LoadedMcpConfig {
  const issues: McpConfigIssue[] = [...user.issues]
  const servers = new Map<string, McpServerEntry>()
  const namespaces = new Map<string, string>()

  const addFull = (
    entry: McpConfigDocumentServer,
    scope: McpConfigScope,
    source: string,
    context: { scope: McpConfigScope; path: string },
  ) => {
    if (!entry.config) return
    // 防御性重复检查：即使调用方手工构造 project 文档，也不允许完整条目使用 auth.provider。
    if (scope === 'project' && 'url' in entry.config && entry.config.auth) {
      issues.push(
        makeIssue(
          'project-auth',
          context,
          `server ${serverLabel(entry.name)}: 项目配置不允许 auth.provider`,
          entry.name,
        ),
      )
      return
    }
    const namespace = mcpNamespace(entry.name)
    const clash = namespaces.get(namespace)
    if (clash !== undefined && clash !== entry.name) {
      issues.push(
        makeIssue(
          'namespace-collision',
          context,
          `server ${serverLabel(entry.name)} 与 ${serverLabel(clash)} 的命名空间冲突（${namespace}）`,
          entry.name,
        ),
      )
      return
    }
    namespaces.set(namespace, entry.name)
    servers.set(entry.name, {
      name: entry.name,
      config: entry.config,
      source,
      scope,
    })
  }

  for (const entry of user.servers) {
    addFull(entry, 'user', user.path, { scope: 'user', path: user.path })
  }

  if (project) {
    issues.push(...project.issues)
    for (const entry of project.servers) {
      if (entry.override) {
        const base = servers.get(entry.name)
        if (!base) {
          issues.push(
            makeIssue(
              'invalid-override',
              { scope: 'project', path: project.path },
              `server ${serverLabel(entry.name)}: 需要 command 或 url，或同名用户条目以供 override`,
              entry.name,
            ),
          )
          continue
        }
        const namespace = mcpNamespace(entry.name)
        const clash = namespaces.get(namespace)
        if (clash !== undefined && clash !== entry.name) {
          issues.push(
            makeIssue(
              'namespace-collision',
              { scope: 'project', path: project.path },
              `server ${serverLabel(entry.name)} 与 ${serverLabel(clash)} 的命名空间冲突（${namespace}）`,
              entry.name,
            ),
          )
          continue
        }
        // override 继承用户条目的 auth 等字段；只对三个允许字段做归一化覆盖。
        const config = validateMcpServerConfig(entry.name, {
          ...base.config,
          ...entry.overrides,
        })
        if (typeof config === 'string') {
          issues.push(
            makeIssue(
              'invalid-override',
              { scope: 'project', path: project.path },
              config,
              entry.name,
            ),
          )
          continue
        }
        servers.set(entry.name, { ...base, config, override: project.path })
        continue
      }
      addFull(entry, 'project', project.path, { scope: 'project', path: project.path })
    }
  }

  const autoEnableCodemode = project?.autoEnableCodemode ?? user.autoEnableCodemode
  return {
    servers: [...servers.values()],
    ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }),
    issues,
    ...(project ? { projectConfig: project.path } : {}),
  }
}

/** 把读取结果转换为解析文档；读取失败/超限也变成逐项诊断。 */
export function configDocumentFromRead(
  scope: McpConfigScope,
  path: string,
  read: McpConfigRead,
): McpConfigDocument {
  const document: McpConfigDocument = { scope, path, servers: [], issues: [] }
  if (read.readError) {
    document.issues.push(makeIssue('read', { scope, path }, read.readError))
    return document
  }
  if (read.tooLarge) {
    document.issues.push(
      makeIssue(
        'too-large',
        { scope, path },
        `MCP 配置文件超过上限（${MCP_CONFIG_FILE_MAX_BYTES} 字节），未加载原文。`,
      ),
    )
    return document
  }
  if (!read.exists) return document
  return parseMcpConfigContent(read.content, { scope, path })
}

/**
 * 读取用户配置，并在项目已信任时读取项目配置，然后合并。
 *
 * 项目未信任时不触碰项目路径，也不把文件存在视为信任。
 */
export async function loadMcpConfig(options: LoadMcpConfigOptions): Promise<LoadedMcpConfig> {
  const paths = mcpConfigPaths(options.agentDir, options.cwd)
  const userRead = await readMcpConfigText(paths.user, resolve(options.agentDir))
  const user = configDocumentFromRead('user', paths.user, userRead)
  // 只接受严格的 true；其它运行时值（包括 truthy 字符串）一律按未信任处理。
  if (options.projectTrusted !== true) return mergeMcpConfigDocuments(user)

  const projectRead = await readMcpConfigText(paths.project, resolve(options.cwd))
  const project = configDocumentFromRead('project', paths.project, projectRead)
  return mergeMcpConfigDocuments(user, project)
}
