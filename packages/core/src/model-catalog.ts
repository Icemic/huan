/**
 * 模型目录与默认模型解析。
 *
 * 由宿主在启动时执行一次（共享 modelRuntime），以及按需刷新目录。
 * 关键事实（已实测）：SDK 的 createAgentSession 会加载扩展但不消费其中的
 * provider 注册；官方装配入口 createAgentSessionServices 会完成「注册 provider
 * → 物化目录」；装配期内自带 refresh({ allowNetwork: false })，扩展的动态模型
 * （fetchModels）在此不拉网络，需宿主另行显式刷新。
 */
import {
  createAgentSessionServices,
  type InlineExtension,
  ModelRuntime,
  type ModelScopeDiagnostic,
  resolveModelScopeWithDiagnostics,
  type ScopedModel,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessHostInfo,
  HarnessModelInfo,
  HarnessRuntimeReadiness,
  HarnessThinkingLevel,
} from '@huan/protocol'

/**
 * 宿主可控的资源装配选项（受约束子集）。
 *
 * 用途：自动化测试关闭 Skills/模板/主题/上下文发现，避免读到个人或祖先目录
 * 资源；不提供 `extensionFactories` 等可替换宿主守卫的字段——宿主注入的合成
 * 扩展始终由宿主追加在调用者选项之后。生产环境保持默认（不关闭原生发现）。
 */
export type HarnessResourceLoaderOptions = {
  noExtensions?: boolean
  noSkills?: boolean
  noPromptTemplates?: boolean
  noThemes?: boolean
  noContextFiles?: boolean
  /** 追加资源路径（须为绝对路径；与 Pi CLI 的临时启用含义一致）。 */
  additionalExtensionPaths?: readonly string[]
  additionalSkillPaths?: readonly string[]
  additionalPromptTemplatePaths?: readonly string[]
  additionalThemePaths?: readonly string[]
}

/** 与 protocol 的 thinking 级别清单一致的顺序（含 Pi 1.4 的 max）。 */
const THINKING_LEVELS: readonly HarnessThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * 模型可用的 Thinking 级别（与 Pi 的 `getSupportedThinkingLevels` 同规则）。
 *
 * - 非推理模型只有 `off`；
 * - `null` 映射的级别不可用；
 * - `xhigh` / `max` 必须由模型显式映射才可用（避免高估能力后请求被拒）。
 */
function supportedThinkingLevels(model: {
  reasoning?: boolean
  thinkingLevelMap?: Record<string, unknown>
}): HarnessThinkingLevel[] {
  if (!model.reasoning) return ['off']
  const map = model.thinkingLevelMap
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/** 由模型注册表条目映射为协议模型信息。 */
function mapModelInfo(model: {
  provider: string
  id: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, unknown>
  input?: readonly string[]
}): HarnessModelInfo {
  const input = model.input?.filter(
    (modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image',
  )
  return {
    provider: String(model.provider),
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    supportsThinking: Boolean(model.reasoning),
    availableThinkingLevels: supportedThinkingLevels(model),
    ...(input ? { input: [...input] } : {}),
  }
}

/** 目录查询结果：可用模型优先（有认证），否则回退全部注册模型。 */
export function listModelCatalog(runtime: ModelRuntime): HarnessModelInfo[] {
  const available = runtime.getAvailableSnapshot()
  const models = available.length > 0 ? available : runtime.getModels()
  return models.map(mapModelInfo)
}

/** 两层模型范围的解析结果（模式、命中模型与 Pi 诊断）。 */
export type ResolvedModelScope = {
  patterns: string[]
  scopedModels: ScopedModel[]
  diagnostics: ModelScopeDiagnostic[]
}

/** 规范化模型模式：去空白、去重并保持顺序；空数组表示不限制。 */
export function normalizeModelPatterns(patterns: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const pattern of patterns ?? []) {
    const value = pattern.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** 用户全局启用的模型模式（只读用户设置，不使用项目覆盖）。 */
export function globalModelPatterns(settings: SettingsManager): string[] {
  return normalizeModelPatterns(settings.getGlobalSettings().enabledModels)
}

/**
 * 用 Pi 公开解析器把模式解析为可用模型。
 *
 * 通配符与 Thinking 后缀由 Pi 处理；无匹配时返回空候选（不退全部）。
 * 解析异常同样按空候选报告，不静默扩大范围。
 */
export async function resolveModelScopePatterns(
  runtime: ModelRuntime,
  patterns: readonly string[],
  options: { diagnose?: (message: string) => void } = {},
): Promise<ResolvedModelScope> {
  const normalized = normalizeModelPatterns(patterns)
  if (normalized.length === 0) return { patterns: [], scopedModels: [], diagnostics: [] }
  try {
    const result = await resolveModelScopeWithDiagnostics(normalized, runtime, {
      signal: AbortSignal.timeout(10_000),
    })
    return { patterns: normalized, ...result }
  } catch (error) {
    options.diagnose?.(`模型范围解析：${error instanceof Error ? error.message : String(error)}`)
    return {
      patterns: normalized,
      scopedModels: [],
      diagnostics: [
        {
          type: 'warning',
          code: 'no-match',
          pattern: normalized.join(', '),
          message: '模型范围解析失败，请检查模型范围或先刷新模型目录',
        },
      ],
    }
  }
}

/** 显式目录刷新（唯一允许联网的入口）。失败不抛，交由调用方决定提示。 */
export async function refreshModelCatalog(
  runtime: ModelRuntime,
  options: { allowNetwork: boolean },
): Promise<{ errors: readonly string[] }> {
  const result = await runtime.refresh({ allowNetwork: options.allowNetwork })
  return { errors: [...result.errors.values()].map((error) => error.message) }
}

/**
 * 装配一份 cwd 绑定的宿主服务。
 *
 * 每 live session 独立调用：resourceLoader / 扩展 runtime 归该会话独占
 * （扩展 runner 会把动作绑定写入共享 runtime，复用会导致会话串扰）。
 * modelRuntime 由调用方传入并在全宿主共享（provider 注册为合并语义，重注册幂等）。
 */
export async function createHostServices(options: {
  cwd: string
  /** 已解析为绝对路径的用户空间目录。 */
  agentDir: string
  modelRuntime: ModelRuntime
  /** 调用者的受约束资源选项（宿主守卫随后追加，不可被替换）。 */
  resourceLoaderOptions?: HarnessResourceLoaderOptions | undefined
  /** 宿主注入的合成扩展（追加在文件扩展之后；用于输入守卫等提交前拦截）。 */
  extensionFactories?: InlineExtension[]
}) {
  const resourceLoaderOptions = {
    ...toResourceLoaderOptions(options.resourceLoaderOptions),
    ...(options.extensionFactories?.length
      ? { extensionFactories: options.extensionFactories }
      : {}),
  }
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    ...(Object.keys(resourceLoaderOptions).length ? { resourceLoaderOptions } : {}),
  })
  // SDK 的装配诊断不包含所有扩展加载错误，补入本地诊断；对 GUI 只投影安全代码。
  const loaded = services.resourceLoader.getExtensions()
  for (const error of loaded.errors) {
    services.diagnostics.push({
      type: 'error',
      message: `扩展加载（${error.path}）：${error.error}`,
    })
  }
  for (const warning of loaded.warnings ?? []) {
    services.diagnostics.push({
      type: 'warning',
      message: `扩展加载（${warning.path}）：${warning.warning}`,
    })
  }
  return services
}

/**
 * 把受约束选项映射为 SDK 选项（数组复制为可变数组，避免调用者后续改动）。
 *
 * 供信任预装配复用：`prepareProjectTrust` 直接接收 SDK 选项，两条路径必须同口径。
 */
export function toResourceLoaderOptions(options: HarnessResourceLoaderOptions | undefined) {
  if (!options) return {}
  return {
    ...(options.noExtensions !== undefined ? { noExtensions: options.noExtensions } : {}),
    ...(options.noSkills !== undefined ? { noSkills: options.noSkills } : {}),
    ...(options.noPromptTemplates !== undefined
      ? { noPromptTemplates: options.noPromptTemplates }
      : {}),
    ...(options.noThemes !== undefined ? { noThemes: options.noThemes } : {}),
    ...(options.noContextFiles !== undefined ? { noContextFiles: options.noContextFiles } : {}),
    ...(options.additionalExtensionPaths
      ? { additionalExtensionPaths: [...options.additionalExtensionPaths] }
      : {}),
    ...(options.additionalSkillPaths
      ? { additionalSkillPaths: [...options.additionalSkillPaths] }
      : {}),
    ...(options.additionalPromptTemplatePaths
      ? { additionalPromptTemplatePaths: [...options.additionalPromptTemplatePaths] }
      : {}),
    ...(options.additionalThemePaths
      ? { additionalThemePaths: [...options.additionalThemePaths] }
      : {}),
  }
}

/** 创建全局共享的 ModelRuntime。 */
export function createSharedModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
  })
}

/** 仅查询本地目录和认证快照，不联网刷新或返回凭据。 */
export function getModelReadiness(
  runtime: ModelRuntime,
  selection: { provider: string; modelId: string } | undefined,
  source: 'env' | 'session' | 'pi-default',
): HarnessRuntimeReadiness {
  if (!selection)
    return { state: 'missing-model', message: '未配置完整默认模型，可先在界面选择模型。' }
  if (!runtime.getModel(selection.provider, selection.modelId)) {
    return {
      state: 'unavailable-model',
      selection,
      message: '所选模型不在注册表中，请选择其他模型或修正配置后重启宿主。',
    }
  }
  if (!runtime.hasConfiguredAuth(selection.provider)) {
    return {
      state: 'missing-credentials',
      provider: selection.provider,
      message: '所选模型缺少凭据，请在模型认证面板登录对应 provider 后重新查询。',
    }
  }
  return { state: 'ready', selection, source }
}

/**
 * 默认模型按原有逐字段优先级解析：显式模型 > 环境变量 > settings。
 * 无效模型成为可诊断的结构化状态，不能阻止宿主启动和读取其他历史会话。
 */
export function resolveDefaultModel(options: {
  modelRuntime: ModelRuntime
  cwd: string
  agentDir: string
  model?: ReturnType<ModelRuntime['getModel']>
  /** 已按项目信任结论创建的设置管理器；缺省按未信任新建（不读取项目设置）。 */
  settingsManager?: SettingsManager
}): {
  model: ReturnType<ModelRuntime['getModel']>
  info: HarnessHostInfo['defaultModel']
} {
  const settings =
    options.settingsManager ??
    SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false })
  const envProvider = process.env.PI_PROVIDER?.trim()
  const envModel = process.env.PI_MODEL_ID?.trim()
  const provider = options.model?.provider ?? (envProvider || settings.getDefaultProvider())
  const modelId = options.model?.id ?? (envModel || settings.getDefaultModel())
  const selection = provider && modelId ? { provider, modelId } : undefined
  return {
    model:
      options.model ??
      (selection
        ? options.modelRuntime.getModel(selection.provider, selection.modelId)
        : undefined),
    info: {
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
      providerSource: options.model
        ? 'option'
        : envProvider
          ? 'env'
          : provider
            ? 'settings'
            : 'default',
      modelIdSource: options.model ? 'option' : envModel ? 'env' : modelId ? 'settings' : 'default',
      readiness: getModelReadiness(
        options.modelRuntime,
        selection,
        envProvider || envModel ? 'env' : 'pi-default',
      ),
    },
  }
}
