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
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { HarnessModelInfo, HarnessThinkingLevel } from '@huan/protocol'

/** 与 protocol 的 thinking 级别清单一致的顺序。 */
const THINKING_LEVELS: readonly HarnessThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

/** 由模型注册表条目映射为协议模型信息。 */
function mapModelInfo(model: {
  provider: string
  id: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, unknown>
}): HarnessModelInfo {
  const map = model.thinkingLevelMap
  const available = map ? THINKING_LEVELS.filter((level) => map[level] !== null) : undefined
  return {
    provider: String(model.provider),
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    supportsThinking: Boolean(model.reasoning),
    ...(available ? { availableThinkingLevels: available } : {}),
  }
}

/** 目录查询结果：可用模型优先（有认证），否则回退全部注册模型。 */
export function listModelCatalog(runtime: ModelRuntime): HarnessModelInfo[] {
  const available = runtime.getAvailableSnapshot()
  const models = available.length > 0 ? available : runtime.getModels()
  return models.map(mapModelInfo)
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
  agentDir: string | undefined
  modelRuntime: ModelRuntime
}) {
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    modelRuntime: options.modelRuntime,
  })
  return services
}

/** 创建全局共享的 ModelRuntime。 */
export function createSharedModelRuntime(agentDir: string | undefined): Promise<ModelRuntime> {
  return ModelRuntime.create({
    ...(agentDir
      ? { authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` }
      : {}),
  })
}

/**
 * 解析默认模型（供新会话使用）。
 *
 * 优先级：PI_PROVIDER/PI_MODEL_ID 环境变量 → settings.json 的 defaultProvider/defaultModel。
 * 结果：未配置返回 undefined（新会话交 SDK 自行解析）；已配置但解析失败抛出明确错误。
 */
export function resolveDefaultModel(options: {
  modelRuntime: ModelRuntime
  cwd: string
  agentDir: string | undefined
}) {
  const settings = SettingsManager.create(options.cwd, options.agentDir)
  const provider = process.env.PI_PROVIDER?.trim() || settings.getDefaultProvider()
  const modelId = process.env.PI_MODEL_ID?.trim() || settings.getDefaultModel()
  if (!provider || !modelId) return undefined

  const model = new ModelRegistry(options.modelRuntime).find(provider, modelId)
  if (!model) {
    throw new Error(`默认模型 ${provider}/${modelId} 在模型注册表中不存在`)
  }
  return model
}
