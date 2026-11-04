/**
 * 子 agent 定义发现（SDK 版 subagent 第一层）。
 *
 * 每次调用都重新读取 Markdown，不在进程内缓存：
 * - 用户定义固定来自显式传入的 `agentDir/agents`，不读取个人默认目录；
 * - 项目定义来自 `cwd` 最近祖先的 `.pi/agents`，与 Pi 的资源配置目录名保持一致；
 * - `both` 时项目定义按 name 覆盖用户定义。
 *
 * 定义文件是项目可控输入。这里不再像旧 CLI 扩展那样静默跳过坏文件：
 * 缺字段、非法 frontmatter 或错误的 tools/model 类型都会抛出带文件路径的
 * 可理解错误，避免模型把“未加载”误认为“不存在”。
 */
import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_DIR_NAME, parseFrontmatter } from '@earendil-works/pi-coding-agent'

/** 子 agent 定义来源。 */
export type SubagentAgentSource = 'user' | 'project'

/** 定义发现作用域；默认只读取用户目录。 */
export type SubagentAgentScope = 'user' | 'project' | 'both'

/** `discoverSubagentAgents` 支持的全部作用域。 */
export const SUBAGENT_AGENT_SCOPES = ['user', 'project', 'both'] as const

/** 默认作用域与旧扩展保持一致：只使用用户目录。 */
export const SUBAGENT_DEFAULT_AGENT_SCOPE: SubagentAgentScope = 'user'

/**
 * 单个子 agent 定义。
 *
 * `tools` 的三种状态必须区分：
 * - `undefined`：定义未限制工具，由子会话继承父工具配置；
 * - `[]`：定义明确禁用全部工具；
 * - 非空数组：仅使用列出的工具。
 */
export type SubagentAgentDefinition = {
  name: string
  description: string
  model?: string
  tools?: string[]
  /** Markdown 正文；由执行层作为追加系统提示使用。 */
  body: string
  source: SubagentAgentSource
  filePath: string
}

/** 一次定义发现的结果。 */
export type SubagentAgentDiscovery = {
  agents: SubagentAgentDefinition[]
  /** 用户 agents 目录（即使不存在也返回预期路径，便于诊断）。 */
  userDir: string
  /** 最近祖先中的项目 agents 目录；不存在时为 null。 */
  projectDir: string | null
}

/** 定义发现输入。 */
export type DiscoverSubagentAgentsOptions = {
  /** 已解析的 Pi 用户配置目录；用户定义位于其 `agents` 子目录。 */
  agentDir: string
  /** 发起子 agent 的父会话工作目录；用于查找最近祖先项目定义。 */
  cwd: string
  /** 缺省为 `user`。 */
  scope?: SubagentAgentScope
}

/** 定义文件无效或无法读取；消息包含文件路径与具体原因。 */
export class SubagentDefinitionError extends Error {
  readonly code = 'subagent-definition-invalid'

  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(`子agent定义无效 (${filePath}): ${reason}`)
    this.name = 'SubagentDefinitionError'
  }
}

/** 运行时校验作用域，供工具入口防御非 schema 调用。 */
export function isSubagentAgentScope(value: unknown): value is SubagentAgentScope {
  return typeof value === 'string' && (SUBAGENT_AGENT_SCOPES as readonly string[]).includes(value)
}

/**
 * 发现当前调用的全部可用定义。
 *
 * 该函数无状态：每次 subagent 工具调用都会重新读取文件系统。
 */
export function discoverSubagentAgents(
  options: DiscoverSubagentAgentsOptions,
): SubagentAgentDiscovery {
  const scope = options.scope ?? SUBAGENT_DEFAULT_AGENT_SCOPE
  if (!isSubagentAgentScope(scope)) {
    throw new Error(`未知的子agent作用域: ${String(scope)}`)
  }

  const agentDir = resolve(options.agentDir)
  const cwd = resolve(options.cwd)
  const userDir = join(agentDir, 'agents')
  const projectDir = findNearestProjectAgentsDir(cwd)

  const userAgents = scope === 'project' ? [] : loadAgentsFromDir(userDir, 'user')
  const projectAgents =
    scope === 'user' || projectDir === null ? [] : loadAgentsFromDir(projectDir, 'project')

  return {
    agents: mergeAgents(userAgents, projectAgents),
    userDir,
    projectDir,
  }
}

/** 按 name 去重；`both` 时后写入的项目定义覆盖同名用户定义。 */
function mergeAgents(
  userAgents: readonly SubagentAgentDefinition[],
  projectAgents: readonly SubagentAgentDefinition[],
): SubagentAgentDefinition[] {
  const byName = new Map<string, SubagentAgentDefinition>()
  for (const agent of userAgents) byName.set(agent.name, agent)
  for (const agent of projectAgents) byName.set(agent.name, agent)
  return Array.from(byName.values())
}

/** 从单个目录读取全部 `.md` 定义；目录不存在时返回空列表。 */
function loadAgentsFromDir(dir: string, source: SubagentAgentSource): SubagentAgentDefinition[] {
  if (!isDirectory(dir)) return []

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw new SubagentDefinitionError(dir, `无法读取目录: ${errorMessage(error)}`)
  }

  // 固定处理顺序，避免不同文件系统返回顺序导致同名覆盖结果不确定。
  const files = entries
    .filter((entry) => entry.name.endsWith('.md'))
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))

  const agents: SubagentAgentDefinition[] = []
  for (const entry of files) {
    agents.push(loadAgentFile(join(dir, entry.name), source))
  }
  return agents
}

/** 解析并校验一份定义；任何字段错误都带文件路径抛出。 */
function loadAgentFile(filePath: string, source: SubagentAgentSource): SubagentAgentDefinition {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new SubagentDefinitionError(filePath, `无法读取文件: ${errorMessage(error)}`)
  }

  let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content)
  } catch (error) {
    throw new SubagentDefinitionError(filePath, `frontmatter 解析失败: ${errorMessage(error)}`)
  }

  const frontmatter = parsed.frontmatter
  if (!isRecord(frontmatter)) {
    throw new SubagentDefinitionError(filePath, 'frontmatter 必须是键值映射')
  }

  const name = requireNonEmptyString(filePath, frontmatter.name, 'name')
  const description = requireNonEmptyString(filePath, frontmatter.description, 'description')
  const model = optionalNonEmptyString(filePath, frontmatter.model, 'model')
  const tools = parseTools(filePath, frontmatter.tools)

  return {
    name,
    description,
    ...(model === undefined ? {} : { model }),
    ...(tools === undefined ? {} : { tools }),
    body: parsed.body,
    source,
    filePath,
  }
}

/** tools 既接受 `read, bash` 字符串，也接受 `[read, bash]` 数组；空数组保留。 */
function parseTools(filePath: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined

  let items: unknown[]
  if (typeof value === 'string') {
    items = value.split(',')
  } else if (Array.isArray(value)) {
    items = value
  } else {
    throw new SubagentDefinitionError(
      filePath,
      'tools 必须是逗号分隔字符串或字符串数组（使用空数组 [] 明确禁用全部工具）',
    )
  }

  const tools = items.map((item, index) => {
    if (typeof item !== 'string') {
      throw new SubagentDefinitionError(filePath, `tools[${index}] 必须是字符串`)
    }
    const trimmed = item.trim()
    if (trimmed === '') {
      throw new SubagentDefinitionError(filePath, `tools[${index}] 不能为空字符串`)
    }
    return trimmed
  })

  return tools.length === 0 ? [] : tools
}

function requireNonEmptyString(filePath: string, value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SubagentDefinitionError(filePath, `缺少必填字段 ${field}，或该字段不是字符串`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new SubagentDefinitionError(filePath, `字段 ${field} 不能为空`)
  }
  return trimmed
}

function optionalNonEmptyString(
  filePath: string,
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SubagentDefinitionError(filePath, `字段 ${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new SubagentDefinitionError(filePath, `字段 ${field} 不能为空字符串`)
  }
  return trimmed
}

/** 从 cwd 向根目录查找最近的 `.pi/agents`。 */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, 'agents')
    if (isDirectory(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 只把“不存在/不是目录”当作未找到；权限等真实错误向上暴露。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw new SubagentDefinitionError(path, `无法检查目录: ${errorMessage(error)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
