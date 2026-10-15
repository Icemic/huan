import {
  discoverAndLoadExtensions,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ServerConfig } from './config.js'

/**
 * 解析默认模型。
 *
 * Pi SDK 的 createAgentSession 不读取 settings.json 的默认模型，也不加载
 * 用户扩展（CLI 会，SDK 不会），因此宿主需要完整复现 CLI 的解析链路：
 * 1. 加载用户扩展，提取其中的 provider 注册（自定义 provider 常经此途径注册）；
 * 2. 把这些注册接入 ModelRuntime，使其能解析自定义 provider 的模型；
 * 3. PI_PROVIDER + PI_MODEL_ID 环境变量优先，否则回退 settings.json 的
 *    defaultProvider / defaultModel；
 * 4. 全部未配置时返回 undefined（新会话无预设模型）。
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
  await runtime.refresh()

  const settings = SettingsManager.create(config.workspacePath, config.agentDir)
  const provider = process.env.PI_PROVIDER?.trim() || settings.getDefaultProvider()
  const modelId = process.env.PI_MODEL_ID?.trim() || settings.getDefaultModel()
  if (!provider || !modelId) return undefined

  const registry = new ModelRegistry(runtime)
  return registry.find(provider, modelId)
}
