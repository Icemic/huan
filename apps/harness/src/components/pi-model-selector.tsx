import { type PiThinkingLevel, usePiRuntimeExtras, usePiSession } from '@assistant-ui/react-pi'
import { useEffect, useState } from 'react'
import {
  type ModelOption,
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
} from '@/components/assistant-ui/elements/model-selector.aui'
import { piHttpClient } from './pi-http-client'

type CatalogModel = {
  provider: string
  modelId: string
  name?: string
  availableThinkingLevels?: readonly string[]
}

/**
 * 把宿主返回的模型目录映射为选择器条目。
 *
 * id 采用 `provider/modelId` 复合形式（与 setModel 的参数拆分一致）。
 */
function toModelOptions(infos: readonly CatalogModel[]): ModelOption[] {
  return infos.map((info) => ({
    id: `${info.provider}/${info.modelId}`,
    name: info.name ?? info.modelId,
    description: info.provider,
    ...(info.availableThinkingLevels?.length
      ? {
          efforts: info.availableThinkingLevels.map((level) => ({ id: level, name: level })),
        }
      : {}),
  }))
}

/**
 * 模型选择器接线：模型目录来自宿主真实注册表（含扩展 provider），
 * 当前值来自当前会话 metadata.config，切换经 extras.setModel / setThinkingLevel。
 */
export function PiModelSelector() {
  const session = usePiSession()
  const extras = usePiRuntimeExtras()
  const [models, setModels] = useState<readonly ModelOption[]>([])

  useEffect(() => {
    let active = true
    piHttpClient
      .getAvailableModels()
      .then((infos) => {
        if (active) setModels(toModelOptions(infos as readonly CatalogModel[]))
      })
      .catch(() => {
        // 目录拉取失败不阻塞 UI：选择器保持为空，具体错误由会话区呈现。
      })
    return () => {
      active = false
    }
  }, [])

  const provider = session?.config?.provider
  const modelId = session?.config?.modelId
  const currentKey = provider && modelId ? `${provider}/${modelId}` : undefined

  return (
    <ModelSelectorRoot
      models={models}
      {...(currentKey ? { value: currentKey } : {})}
      onValueChange={(key) => {
        if (key === currentKey) return
        const next = models.find((model) => model.id === key)
        if (!next) return
        const [nextProvider, ...rest] = key.split('/')
        void extras.setModel({ provider: nextProvider ?? '', modelId: rest.join('/') })
      }}
      {...(session?.config?.thinkingLevel ? { effort: session.config.thinkingLevel } : {})}
      onEffortChange={(level) => void extras.setThinkingLevel(level as PiThinkingLevel)}
    >
      <ModelSelectorTrigger>
        <ModelSelectorValue showEffort />
      </ModelSelectorTrigger>
      <ModelSelectorContent />
    </ModelSelectorRoot>
  )
}
