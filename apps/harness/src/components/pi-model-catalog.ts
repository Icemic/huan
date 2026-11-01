import type { HarnessModelInfo } from '@huan/protocol'

/** 模型目录缓存：模型选择器写入，命令路由与图片能力校验读取。 */
let models: readonly HarnessModelInfo[] = []

export function setModelCatalogCache(next: readonly HarnessModelInfo[]): void {
  models = next
}

export function getModelCatalogCache(): readonly HarnessModelInfo[] {
  return models
}

export function findCachedModel(
  provider: string | undefined,
  modelId: string | undefined,
): HarnessModelInfo | undefined {
  if (!provider || !modelId) return undefined
  return models.find((model) => model.provider === provider && model.modelId === modelId)
}
