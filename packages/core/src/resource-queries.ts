/**
 * 资源命令目录、扩展参数补全与有界文件引用查询。
 *
 * 只使用 Pi 1.4.0 的公开导出：
 * - `AgentSession.promptTemplates/extensionRunner`
 * - `ResourceLoader.getExtensions/getPrompts/getSkills`
 * - `SettingsManager.getEnableSkillCommands`
 *
 * 不深导入 SDK 的内置 slash 表，也不展开模板/skill 内容。文件查询只读目录
 * 条目，不读取文件内容；扫描有总量、深度与结果上限，并跳过符号链接、
 * 隐藏条目与常见依赖目录，避免从工作区逃逸或按键盘输入做无界全仓遍历。
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentSession,
  LoadExtensionsResult,
  ResourceDiagnostic,
  ResourceLoader,
  SettingsManager,
  SourceInfo,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessCommandArgumentCompletion,
  HarnessCommandCatalog,
  HarnessCommandSource,
  HarnessCommandSourceInfo,
  HarnessFileReference,
  HarnessFileSearchResult,
  HarnessResourceCommand,
} from '@huan/protocol'
import ignore, { type Ignore } from 'ignore'

/** 参数补全的结构化形状（Pi AutocompleteItem 的公开字段）。 */
type ArgumentCompletionItem = {
  value: string
  label: string
  description?: string
}

/** 扩展命令的解析结果（与 ExtensionRunner 的 invocationName 规则一致）。 */
type ResolvedLoaderCommand = {
  name: string
  description?: string
  sourceInfo: SourceInfo
  getArgumentCompletions?: (
    prefix: string,
  ) => ArgumentCompletionItem[] | null | Promise<ArgumentCompletionItem[] | null>
}

/** 来源投影：只保留路径/来源/作用域等展示字段。 */
export function sourceInfoOf(info: SourceInfo): HarnessCommandSourceInfo {
  return {
    path: info.path,
    source: info.source,
    scope: info.scope,
    origin: info.origin,
    ...(info.baseDir ? { baseDir: info.baseDir } : {}),
  }
}

function diagnosticMessages(diagnostics: readonly ResourceDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.message)
}

/** 将命令按优先级顺序标记同名遮蔽：扩展 > skill > 模板。 */
function markShadowed(
  commands: readonly Omit<HarnessResourceCommand, 'shadowedBy'>[],
): HarnessResourceCommand[] {
  const seen = new Map<string, HarnessCommandSource>()
  const priority: Record<HarnessCommandSource, number> = { extension: 0, skill: 1, prompt: 2 }
  return [...commands]
    .sort((left, right) => priority[left.source] - priority[right.source])
    .map((command) => {
      const shadowedBy = seen.get(command.name)
      if (!seen.has(command.name)) seen.set(command.name, command.source)
      return shadowedBy ? { ...command, shadowedBy } : command
    })
}

/**
 * 活会话目录：与 Pi 的优先级顺序一致（扩展 → skill → 模板）。
 *
 * AgentSession 不公开 getCommands；这里组合公开的
 * `extensionRunner.getRegisteredCommands()`、`promptTemplates` 与 loader
 * 的 skills，不深导入 SDK 的 slash 表。
 */
export function commandCatalogFromSession(session: AgentSession): HarnessCommandCatalog {
  const settings = session.settingsManager
  const skillsEnabled = settings.getEnableSkillCommands()
  const loader = session.resourceLoader
  const mapped: Omit<HarnessResourceCommand, 'shadowedBy'>[] = []
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    mapped.push({
      name: command.invocationName,
      ...(command.description ? { description: command.description } : {}),
      source: 'extension',
      sourceInfo: sourceInfoOf(command.sourceInfo),
      supportsArguments: true,
    })
  }
  for (const prompt of session.promptTemplates) {
    mapped.push({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      source: 'prompt',
      sourceInfo: sourceInfoOf(prompt.sourceInfo),
      supportsArguments: true,
    })
  }
  if (skillsEnabled) {
    for (const skill of loader.getSkills().skills) {
      mapped.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skill',
        sourceInfo: sourceInfoOf(skill.sourceInfo),
        supportsArguments: true,
      })
    }
  }
  const diagnostics: string[] = []
  if (!skillsEnabled) diagnostics.push('Pi 设置已关闭 skill 命令；/skill:name 不在目录中。')
  for (const error of loader.getExtensions().errors) {
    diagnostics.push(`扩展加载（${error.path}）：${error.error}`)
  }
  for (const warning of loader.getExtensions().warnings ?? []) {
    diagnostics.push(`扩展加载（${warning.path}）：${warning.warning}`)
  }
  diagnostics.push(...diagnosticMessages(loader.getPrompts().diagnostics))
  diagnostics.push(...diagnosticMessages(loader.getSkills().diagnostics))
  return {
    commands: markShadowed(mapped),
    skillCommandsEnabled: skillsEnabled,
    diagnostics,
  }
}

/**
 * 空白页目录：loader 未绑定 live session 时无法拿到 ExtensionRunner，
 * 这里按公开的 Extension.commands 与 SDK 同名规则解析 invocationName。
 */
function resolveLoaderCommands(extensions: LoadExtensionsResult): ResolvedLoaderCommand[] {
  const commands: Array<{
    name: string
    description?: string
    sourceInfo: SourceInfo
    getArgumentCompletions?: ResolvedLoaderCommand['getArgumentCompletions']
  }> = []
  for (const extension of extensions.extensions) {
    for (const command of extension.commands.values()) {
      commands.push({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        sourceInfo: command.sourceInfo,
        ...(command.getArgumentCompletions
          ? { getArgumentCompletions: command.getArgumentCompletions }
          : {}),
      })
    }
  }
  const counts = new Map<string, number>()
  for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1)
  const seen = new Map<string, number>()
  const taken = new Set<string>()
  return commands.map((command) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1
    seen.set(command.name, occurrence)
    let invocationName =
      (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name
    if (taken.has(invocationName)) {
      let suffix = occurrence
      do {
        suffix += 1
        invocationName = `${command.name}:${suffix}`
      } while (taken.has(invocationName))
    }
    taken.add(invocationName)
    return { ...command, name: invocationName }
  })
}

function resourceCommandsFromLoader(
  loader: ResourceLoader,
  settings: SettingsManager,
): {
  commands: HarnessResourceCommand[]
  skillsEnabled: boolean
  diagnostics: string[]
} {
  const extensions = loader.getExtensions()
  const prompts = loader.getPrompts()
  const skills = loader.getSkills()
  const skillsEnabled = settings.getEnableSkillCommands()
  const extensionCommands = resolveLoaderCommands(extensions)
  const mapped: Omit<HarnessResourceCommand, 'shadowedBy'>[] = []
  for (const command of extensionCommands) {
    mapped.push({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      source: 'extension',
      sourceInfo: sourceInfoOf(command.sourceInfo),
      supportsArguments: true,
    })
  }
  for (const prompt of prompts.prompts) {
    mapped.push({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      source: 'prompt',
      sourceInfo: sourceInfoOf(prompt.sourceInfo),
      supportsArguments: true,
    })
  }
  if (skillsEnabled) {
    for (const skill of skills.skills) {
      mapped.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skill',
        sourceInfo: sourceInfoOf(skill.sourceInfo),
        supportsArguments: true,
      })
    }
  }
  const diagnostics = [
    ...extensions.errors.map((error) => `扩展加载（${error.path}）：${error.error}`),
    ...(extensions.warnings ?? []).map(
      (warning) => `扩展加载（${warning.path}）：${warning.warning}`,
    ),
    ...diagnosticMessages(prompts.diagnostics),
    ...diagnosticMessages(skills.diagnostics),
  ]
  if (!skillsEnabled) diagnostics.push('Pi 设置已关闭 skill 命令；/skill:name 不在目录中。')
  return { commands: markShadowed(mapped), skillsEnabled, diagnostics }
}

/** 空白页目录（loader 尚未被 live session 消费）。 */
export function commandCatalogFromLoader(
  loader: ResourceLoader,
  settings: SettingsManager,
): HarnessCommandCatalog {
  const result = resourceCommandsFromLoader(loader, settings)
  return {
    commands: result.commands,
    skillCommandsEnabled: result.skillsEnabled,
    diagnostics: result.diagnostics,
  }
}

function normalizeCompletions(
  items: ArgumentCompletionItem[] | null | undefined,
): HarnessCommandArgumentCompletion[] {
  if (!items?.length) return []
  return items.slice(0, 100).map((item) => ({
    value: item.value,
    label: item.label,
    ...(item.description ? { description: item.description } : {}),
  }))
}

/** 活会话扩展参数补全；命令不存在或未声明时返回空数组。 */
export async function commandArgumentsFromSession(
  session: AgentSession,
  name: string,
  prefix: string,
): Promise<HarnessCommandArgumentCompletion[]> {
  const command = session.extensionRunner.getCommand(name)
  if (!command?.getArgumentCompletions) return []
  try {
    return normalizeCompletions(await command.getArgumentCompletions(prefix))
  } catch {
    return []
  }
}

/** 空白页扩展参数补全。 */
export async function commandArgumentsFromLoader(
  loader: ResourceLoader,
  name: string,
  prefix: string,
): Promise<HarnessCommandArgumentCompletion[]> {
  const command = resolveLoaderCommands(loader.getExtensions()).find(
    (candidate) => candidate.name === name,
  )
  if (!command?.getArgumentCompletions) return []
  try {
    return normalizeCompletions(await command.getArgumentCompletions(prefix))
  } catch {
    return []
  }
}

/** 搜索根：alias 缺失表示单目录（无工作区）模式。 */
export type FileSearchRoot = {
  alias?: string
  path: string
  projectName: string
  workspaceName?: string
}

/** 单次查询最多访问的目录条目数（跨全部根）。 */
const MAX_SCAN_ENTRIES = 6_000
/** 最大目录深度，避免异常深的仓库拖慢输入。 */
const MAX_DEPTH = 12
/** 默认结果数。 */
const DEFAULT_LIMIT = 30
/** 结果数硬上限。 */
const MAX_LIMIT = 100
/** 常见依赖/版本目录：与隐藏规则一起跳过。 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'bower_components', 'vendor'])

function normalizeQuery(query: string): string {
  return query.trim().replace(/^@/, '').toLowerCase()
}

/** 简单子序列匹配（保持 O(query + candidate)）。 */
function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1
    if (cursor === needle.length) return true
  }
  return false
}

function scoreMatch(reference: string, relativePath: string, query: string): number | undefined {
  if (!query) return 10
  const ref = reference.toLowerCase()
  const rel = relativePath.toLowerCase()
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (ref === query || rel === query) return 0
  if (base === query) return 1
  if (base.startsWith(query)) return 2
  if (base.includes(query)) return 3
  if (rel.includes(query)) return 4
  if (isSubsequence(query, ref)) return 5
  return undefined
}

type Candidate = {
  file: HarnessFileReference
  score: number
}

/**
 * 有界文件查询：BFS 遍历每个根，只返回路径与类型。
 *
 * 符号链接（文件或目录）一律跳过，避免通过链接逃逸工作区；隐藏条目与
 * node_modules 等依赖目录不进入结果。达到条目上限时返回 truncated。
 */
export async function searchWorkspaceFiles(
  roots: readonly FileSearchRoot[],
  input: { query?: string; limit?: number },
  signal?: AbortSignal,
): Promise<HarnessFileSearchResult> {
  const query = normalizeQuery(input.query ?? '')
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(input.limit) ? Math.floor(input.limit as number) : DEFAULT_LIMIT),
  )
  const candidates: Candidate[] = []
  let scanned = 0
  let truncated = false

  type IgnoreRule = { relative: string; matcher: Ignore }
  const rulesByDirectory = new Map<string, readonly IgnoreRule[]>()
  for (const root of roots) {
    if (signal?.aborted) throw new Error('文件查询已取消')
    const queue: Array<{
      directory: string
      relative: string
      depth: number
      rules: readonly IgnoreRule[]
    }> = [{ directory: root.path, relative: '', depth: 0, rules: [] }]
    let cursor = 0
    while (cursor < queue.length) {
      const current = queue[cursor++]
      if (!current) break
      if (signal?.aborted) throw new Error('文件查询已取消')
      let entries: Dirent[]
      try {
        entries = await readdir(current.directory, { withFileTypes: true })
      } catch {
        continue
      }
      let rules = rulesByDirectory.get(current.directory)
      if (!rules) {
        const content = await readFile(join(current.directory, '.gitignore'), 'utf8').catch(
          () => '',
        )
        rules = content
          ? [...current.rules, { relative: current.relative, matcher: ignore().add(content) }]
          : current.rules
        rulesByDirectory.set(current.directory, rules)
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        scanned += 1
        if (scanned > MAX_SCAN_ENTRIES) {
          truncated = true
          return finish(candidates, truncated, limit)
        }
        // 隐藏条目、依赖目录与符号链接一律不进入索引。
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name
        const isDirectory = entry.isDirectory()
        if (isDirectory && SKIPPED_DIRECTORIES.has(entry.name)) continue
        let ignored = false
        for (const rule of rules) {
          const path = rule.relative ? relativePath.slice(rule.relative.length + 1) : relativePath
          const verdict = rule.matcher.test(`${path}${isDirectory ? '/' : ''}`)
          if (verdict.ignored) ignored = true
          if (verdict.unignored) ignored = false
        }
        if (ignored) continue
        const reference = root.alias ? `@${root.alias}/${relativePath}` : relativePath
        const score = scoreMatch(reference, relativePath, query)
        if (score !== undefined) {
          candidates.push({
            score,
            file: {
              path: join(root.path, ...relativePath.split('/')),
              reference,
              relativePath,
              kind: isDirectory ? 'directory' : 'file',
              ...(root.alias ? { alias: root.alias } : {}),
              ...(root.workspaceName ? { workspaceName: root.workspaceName } : {}),
            },
          })
        }
        if (isDirectory && current.depth + 1 < MAX_DEPTH) {
          queue.push({
            directory: join(current.directory, entry.name),
            relative: relativePath,
            depth: current.depth + 1,
            rules,
          })
        }
      }
    }
  }
  return finish(candidates, truncated, limit)
}

function finish(
  candidates: readonly Candidate[],
  truncated: boolean,
  limit: number,
): HarnessFileSearchResult {
  const sorted = [...candidates].sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score
    const byLength = left.file.reference.length - right.file.reference.length
    if (byLength !== 0) return byLength
    return left.file.reference.localeCompare(right.file.reference)
  })
  const files = sorted.slice(0, limit).map((candidate) => candidate.file)
  return { files, truncated: truncated || sorted.length > limit }
}
