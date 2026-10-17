import {
  discoverAndLoadExtensions,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ServerConfig } from './config.js'

/**
 * 解析默认模型（供新会话使用）。
 *
 * Pi CLI 启动时会完成一套「加载扩展 → 注册 provider → 物化模型目录」的装配；
 * SDK 的 createAgentSession 不会消费扩展的 provider 注册（实测：会话内运行时
 * 解析不到扩展 provider，报 "No models available"），因此宿主需要自行装配：
 * 1. 加载用户扩展并提取其中的 provider 注册（自定义 provider 常经此途径注册）；
 * 2. 把这些注册接入 ModelRuntime，再 refresh() 物化目录；
 * 3. PI_PROVIDER + PI_MODEL_ID 环境变量优先，否则回退 settings.json 的
 *    defaultProvider / defaultModel；
 * 4. 未配置时返回 undefined（新会话交由会话内部自行解析）；
 *    已配置但解析失败时抛出带 provider/model 的明确错误。
 *
 * 注意：react-pi supervisor 用于「模型目录 / setModel」的独立 ModelRuntime
 * 同样看不到扩展 provider（其缺口与本函数同源，详见 docs/todo.md）。
 */
export async function resolveDefaultModel(config: ServerConfig) {
  const extensions = await discoverAndLoadExtensions([], config.workspacePath, config.agentDir)

  const runtime = await ModelRuntime.create({
    ...(config.agentDir ? { authPath: `${config.agentDir}/auth.json` } : {}),
  })
  for (const { provider } of extensions.runtime.pendingNativeProviderRegistrations) {
    runtime.registerNativeProvider(provider)
  }
  for (const { name, config: providerConfig } of extensions.runtime.pendingProviderRegistrations) {
    runtime.registerProvider(name, providerConfig)
  }
  // 注册后需要刷新目录，注册的 provider 模型才会物化到可查询状态。
  const refresh = await runtime.refresh()
  const refreshErrors = [...refresh.errors.values()].map((error) => error.message).join('; ')

  const settings = SettingsManager.create(config.workspacePath, config.agentDir)
  const provider = process.env.PI_PROVIDER?.trim() || settings.getDefaultProvider()
  const modelId = process.env.PI_MODEL_ID?.trim() || settings.getDefaultModel()
  if (!provider || !modelId) return undefined

  const model = new ModelRegistry(runtime).find(provider, modelId)
  if (!model) {
    const suffix = refreshErrors ? `（目录刷新错误：${refreshErrors}）` : ''
    throw new Error(`默认模型 ${provider}/${modelId} 在模型注册表中不存在${suffix}`)
  }

  if (refreshErrors) {
    console.warn(`[huan] 模型目录刷新部分失败：${refreshErrors}`)
  }
  return model
}
