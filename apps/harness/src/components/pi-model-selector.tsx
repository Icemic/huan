import { type PiThinkingLevel, usePiRuntimeExtras, usePiSession } from '@assistant-ui/react-pi'
import {
  type ModelOption,
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
} from '@/components/assistant-ui/elements/model-selector.aui'

/**
 * 临时 mock：模型目录。
 *
 * react-pi 的 supervisor 未加载用户扩展，getAvailableModels 拿不到扩展注册的
 * provider（如 my-provider），会回退到不含认证的内置全量目录。在宿主装配
 * 打通前，先以本地常量提供当前在用的模型（见 docs/todo.md 待细化事项）。
 */
const MOCK_MODELS: readonly ModelOption[] = [
  {
    id: 'my-provider/deepseek-v4.1-flash',
    name: 'deepseek-v4.1-flash',
    description: 'my-provider',
  },
]

/**
 * 模型选择器接线：把模型目录与当前会话配置接到通用选择器组件。
 *
 * - 模型目录：当前为本地 mock（见上方说明）；
 * - 当前值来自当前会话 metadata.config；
 * - 切换后调用 extras.setModel / setThinkingLevel。
 */
export function PiModelSelector() {
  const session = usePiSession()
  const extras = usePiRuntimeExtras()

  const provider = session?.config?.provider
  const modelId = session?.config?.modelId
  const currentKey = provider && modelId ? `${provider}/${modelId}` : undefined

  return (
    <ModelSelectorRoot
      models={MOCK_MODELS}
      {...(currentKey ? { value: currentKey } : {})}
      onValueChange={(key) => {
        // 与当前值相同时跳过：setModel 会经 supervisor 的模型注册表校验，
        // 而该注册表尚未加载扩展注册的 provider（见上方 mock 说明）。
        if (key === currentKey) return
        const next = MOCK_MODELS.find((model) => model.id === key)
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
