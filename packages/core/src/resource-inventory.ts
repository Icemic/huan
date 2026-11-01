/**
 * 资源清单投影（G1.4a）。
 *
 * 只读取现有 `ResourceLoader` / `SettingsManager` 的公开 getter：
 * 不调用 `reload()`、不重新执行扩展、不联网重扫。热会话使用正在服务该
 * 会话的 loader；空白页优先复用同 cwd 的 live loader、待消费的受信装配
 * 缓存或最近一次装配结果。
 *
 * 指令与 system prompt 文本只在显式 `includeText` 时返回，并有长度上限；
 * 普通会话快照/事件不包含这些配置文本。
 */
import type { ResourceLoader, SettingsManager, SourceInfo } from '@earendil-works/pi-coding-agent'
import type {
  HarnessResourceExtension,
  HarnessResourceInstruction,
  HarnessResourceLoadedRef,
  HarnessResourcePackage,
  HarnessResourcePrompt,
  HarnessResourceSkill,
  HarnessResourceSnapshot,
  HarnessResourceSourceInfo,
  HarnessResourceSystemPrompt,
  HarnessResourceTheme,
  HarnessSettingsTarget,
} from '@huan/protocol'
import { sourceInfoOf } from './resource-queries.js'

/** 单个文本字段的返回上限（字符）；超出时标记 textTruncated。 */
const RESOURCE_TEXT_MAX_CHARS = 200_000

/** 受控文本入口：返回字节数与（可选）截断后的文本。 */
function boundedText(
  text: string,
  includeText: boolean,
): { bytes: number; text?: string; textTruncated?: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (!includeText) return { bytes }
  if (text.length <= RESOURCE_TEXT_MAX_CHARS) return { bytes, text }
  return { bytes, text: text.slice(0, RESOURCE_TEXT_MAX_CHARS), textTruncated: true }
}

/** 来源投影可为空（主题可能没有 sourceInfo）。 */
function optionalSourceInfo(info: SourceInfo | undefined): HarnessResourceSourceInfo | undefined {
  return info ? sourceInfoOf(info) : undefined
}

/** 声明 package 的 JSON-safe 投影。 */
export function packagesOf(settings: SettingsManager): HarnessResourcePackage[] {
  const declared = settings.getPackages() as unknown[]
  return declared.flatMap((entry) => {
    if (typeof entry === 'string') return [{ source: entry }]
    if (entry === null || typeof entry !== 'object') return []
    const value = entry as {
      source?: unknown
      autoload?: unknown
      extensions?: unknown
      skills?: unknown
      prompts?: unknown
      themes?: unknown
    }
    if (typeof value.source !== 'string') return []
    const strings = (input: unknown): readonly string[] | undefined =>
      Array.isArray(input)
        ? input.filter((item): item is string => typeof item === 'string')
        : undefined
    const extensions = strings(value.extensions)
    const skills = strings(value.skills)
    const prompts = strings(value.prompts)
    const themes = strings(value.themes)
    return [
      {
        source: value.source,
        ...(typeof value.autoload === 'boolean' ? { autoload: value.autoload } : {}),
        ...(extensions ? { extensions } : {}),
        ...(skills ? { skills } : {}),
        ...(prompts ? { prompts } : {}),
        ...(themes ? { themes } : {}),
      },
    ]
  })
}

/** 资源清单来源集合（由宿主决定使用 live session 还是装配缓存）。 */
export type ResourceInventorySource = {
  target: HarnessSettingsTarget
  agentDir: string
  loadedFrom: 'session' | 'assembly'
  trust: {
    decision: 'trusted' | 'untrusted' | 'needs-trust'
    requiresTrust: boolean
    origin: string
  }
  loader: ResourceLoader
  settings: SettingsManager
}

/** 由现有 loader/settings 投影出资源清单（不触发重新加载）。 */
export function resourceSnapshotOf(
  source: ResourceInventorySource,
  options: { includeText?: boolean } = {},
): HarnessResourceSnapshot {
  const includeText = options.includeText === true
  const loader = source.loader
  const extensions = loader.getExtensions()
  const skills = loader.getSkills()
  const prompts = loader.getPrompts()
  const themes = loader.getThemes()
  const agentsFiles = loader.getAgentsFiles().agentsFiles
  // 以实际装配该 loader 的设置管理器为准：热会话可能仍在使用旧的信任结论。
  const projectResourcesLoaded = source.settings.isProjectTrusted()

  const instructions: HarnessResourceInstruction[] = agentsFiles.map((file) => ({
    path: file.path,
    ...boundedText(file.content, includeText),
  }))

  const systemText = loader.getSystemPrompt()
  const systemSource = loader.getSystemPromptSource()
  const appendTexts = loader.getAppendSystemPrompt()
  const appendSources = loader.getAppendSystemPromptSources()
  const systemPrompt: HarnessResourceSystemPrompt | undefined =
    systemText === undefined && appendTexts.length === 0
      ? undefined
      : {
          ...(systemSource ? { source: systemSource.path } : {}),
          ...boundedText(systemText ?? '', includeText),
          append: appendTexts.map((text, index) => ({
            ...(appendSources[index]?.path ? { source: appendSources[index]?.path } : {}),
            ...boundedText(text, includeText),
          })),
        }

  const extensionList: HarnessResourceExtension[] = extensions.extensions.map((extension) => ({
    path: extension.path,
    hidden: extension.hidden === true,
    sourceInfo: sourceInfoOf(extension.sourceInfo),
    commands: [...extension.commands.keys()],
    tools: [...extension.tools.keys()],
  }))

  const skillList: HarnessResourceSkill[] = skills.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    sourceInfo: sourceInfoOf(skill.sourceInfo),
    disableModelInvocation: skill.disableModelInvocation,
  }))

  const promptList: HarnessResourcePrompt[] = prompts.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
    path: prompt.filePath,
    sourceInfo: sourceInfoOf(prompt.sourceInfo),
  }))

  const themeList: HarnessResourceTheme[] = themes.themes.map((theme) => {
    const sourceInfo = optionalSourceInfo(theme.sourceInfo)
    return {
      name: theme.name ?? '(未命名主题)',
      ...(theme.sourcePath ? { path: theme.sourcePath } : {}),
      ...(sourceInfo ? { sourceInfo } : {}),
    }
  })

  const loaded: HarnessResourceLoadedRef[] = [
    ...extensionList.map((item) => ({
      kind: 'extension' as const,
      name: item.path,
      source: item.sourceInfo.source,
      scope: item.sourceInfo.scope,
      origin: item.sourceInfo.origin,
      path: item.path,
    })),
    ...skillList.map((item) => ({
      kind: 'skill' as const,
      name: item.name,
      source: item.sourceInfo.source,
      scope: item.sourceInfo.scope,
      origin: item.sourceInfo.origin,
      path: item.path,
    })),
    ...promptList.map((item) => ({
      kind: 'prompt' as const,
      name: item.name,
      source: item.sourceInfo.source,
      scope: item.sourceInfo.scope,
      origin: item.sourceInfo.origin,
      path: item.path,
    })),
    ...themeList.flatMap((item) =>
      item.sourceInfo
        ? [
            {
              kind: 'theme' as const,
              name: item.name,
              source: item.sourceInfo.source,
              scope: item.sourceInfo.scope,
              origin: item.sourceInfo.origin,
              path: item.sourceInfo.path,
            },
          ]
        : [],
    ),
  ]

  const diagnostics = [
    ...extensions.errors.map((error) => `扩展加载（${error.path}）：${error.error}`),
    ...(extensions.warnings ?? []).map(
      (warning) => `扩展加载（${warning.path}）：${warning.warning}`,
    ),
    ...prompts.diagnostics.map((item) => `模板（${item.path ?? '未知路径'}）：${item.message}`),
    ...skills.diagnostics.map((item) => `Skill（${item.path ?? '未知路径'}）：${item.message}`),
    ...themes.diagnostics.map((item) => `主题（${item.path ?? '未知路径'}）：${item.message}`),
  ]

  const trustNote = projectResourcesLoaded
    ? undefined
    : source.trust.decision === 'needs-trust'
      ? '项目尚未取得信任决定：当前仅展示用户级资源，未执行项目扩展/资源。'
      : '项目未信任：未加载项目扩展/资源；可在项目信任面板允许后重新查询。'

  return {
    target: source.target,
    agentDir: source.agentDir,
    trust: source.trust,
    loadedFrom: source.loadedFrom,
    projectResourcesLoaded,
    ...(trustNote ? { trustNote } : {}),
    instructions,
    ...(systemPrompt ? { systemPrompt } : {}),
    extensions: extensionList,
    skills: skillList,
    prompts: promptList,
    themes: themeList,
    packages: packagesOf(source.settings),
    loaded,
    diagnostics,
  }
}
