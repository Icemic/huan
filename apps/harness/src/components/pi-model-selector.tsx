import type { HarnessThinkingLevel } from '@huan/protocol'
import { useHarnessActions, useHarnessSession, useHarnessThreadState } from '@huan/react'
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  type ModelOption,
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
} from '@/components/assistant-ui/elements/model-selector'
import { clearPiIntent, usePiIntent } from './pi-command-intents'
import { harnessHttpClient } from './pi-http-client'
import { setModelCatalogCache } from './pi-model-catalog'
import { getDraftModel, setDraftModel, subscribeDraftModel } from './pi-model-draft'
import { useProviderAuthRevision } from './pi-provider-auth-store'
import { useWorkspace } from './workspace-context'

type CatalogModel = {
  provider: string
  modelId: string
  name?: string
  availableThinkingLevels?: readonly string[]
}

/**
 * 运行时在空白会话（尚未创建后端会话）时的占位 threadId。
 * 来源：`EMPTY_THREAD_STATE = createHarnessThreadState("__pending__")`。
 */
const PENDING_THREAD_ID = '__pending__'

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
    // 只有 off 的模型不显示 Thinking 控件；其余按模型声明的级别展示（含 max）。
    ...(info.availableThinkingLevels && info.availableThinkingLevels.length > 1
      ? {
          efforts: info.availableThinkingLevels.map((level) => ({ id: level, name: level })),
        }
      : {}),
  }))
}

/**
 * 模型选择器接线：模型目录来自宿主真实注册表（含扩展 provider）；
 * 当前值来自当前会话 metadata.config；切换经 useHarnessActions 的 setModel / setThinkingLevel。
 *
 * 新会话（空白页，threadId 为占位值）的特殊处理：
 * 运行时此时使用 NOOP controller，`setModel` 是空操作（会被静默丢弃）。
 * 因此把选择写入草稿 store，由包装客户端在创建请求中携带（见 pi-http-client.ts），
 * 保证首条消息就使用选定模型。
 */
export const PiModelSelector = memo(function PiModelSelector({
  openOnCommand = false,
}: {
  openOnCommand?: boolean
}) {
  const { workspaces, activeWorkspaceId, startProjectFor, hostInfo } = useWorkspace()
  const metadata = useHarnessThreadState((state) => state.metadata)
  const metadataWorkspace = metadata.workspaceId
    ? workspaces.find((item) => item.id === metadata.workspaceId)
    : undefined
  const activeWorkspace = workspaces.find((item) => item.id === activeWorkspaceId)
  const workspace = metadataWorkspace ?? activeWorkspace
  const projectPath =
    metadata.workspacePath ?? (workspace ? startProjectFor(workspace) : hostInfo?.workspacePath)
  const session = useHarnessSession()
  const actions = useHarnessActions()
  const [models, setModels] = useState<readonly ModelOption[]>([])
  const [open, setOpen] = useState(false)
  const intent = usePiIntent()
  // 认证完成后宿主的可用模型可能变化；认证版本作为目录失效信号。
  const authRevision = useProviderAuthRevision()

  // /model 与 /thinking 打开同一模型选择器；模型目录缓存也供提交前能力校验。
  useEffect(() => {
    if (!openOnCommand || intent?.kind !== 'model') return
    setOpen(true)
    clearPiIntent(intent.id)
  }, [intent, openOnCommand])

  // 草稿（模块级 store，同步可读）；订阅以便展示即时反馈。
  const draft = useSyncExternalStore(subscribeDraftModel, getDraftModel, getDraftModel)

  // 目录刷新代数或认证版本变化时必须重读共享目录，即使固定 cwd 未变。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 宿主刷新代数是目录失效信号
  useEffect(() => {
    if (!projectPath) return
    let active = true
    harnessHttpClient
      .getAvailableModels({ workspacePath: projectPath })
      .then((infos) => {
        if (!active) return
        setModelCatalogCache(infos)
        setModels(toModelOptions(infos as readonly CatalogModel[]))
      })
      .catch(() => {
        // 目录拉取失败不阻塞 UI：选择器保持为空，具体错误由会话区呈现。
      })
    return () => {
      active = false
    }
  }, [projectPath, metadata.modelCatalogRevision, authRevision])

  // 会话确认后清除草稿（此后以会话自身的 config 为准）。
  const isPendingThread = !session?.id || session.id === PENDING_THREAD_ID
  useEffect(() => {
    if (!isPendingThread) setDraftModel(undefined)
  }, [isPendingThread])

  const provider = session?.config?.provider
  const modelId = session?.config?.modelId
  const confirmedKey = provider && modelId ? `${provider}/${modelId}` : undefined
  const draftKey = draft ? `${draft.provider}/${draft.modelId}` : undefined
  // 展示优先级：新会话草稿 > 会话实际配置。
  const displayKey = isPendingThread ? (draftKey ?? confirmedKey) : (confirmedKey ?? draftKey)

  const onValueChange = useCallback(
    (key: string) => {
      if (key === displayKey) return
      const next = models.find((model) => model.id === key)
      if (!next) return
      const [nextProvider, ...rest] = key.split('/')
      const providerId = nextProvider ?? ''
      const nextModelId = rest.join('/')
      if (isPendingThread) {
        // 新会话：写入草稿，等创建请求携带（首条消息即生效）。
        setDraftModel({
          provider: providerId,
          modelId: nextModelId,
          ...(draft?.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        })
        return
      }
      void actions.setModel({ provider: providerId, modelId: nextModelId })
    },
    [displayKey, models, isPendingThread, draft?.thinkingLevel, actions],
  )

  const scopeKeys = metadata.scopedModelKeys
  const selectableModels =
    !scopeKeys?.length || isPendingThread
      ? models
      : models.map((model) => ({ ...model, disabled: !scopeKeys.includes(model.id) }))

  return (
    <ModelSelectorRoot
      key={session?.id ?? PENDING_THREAD_ID}
      open={open}
      onOpenChange={setOpen}
      models={selectableModels}
      {...(displayKey ? { value: displayKey } : {})}
      onValueChange={onValueChange}
      effort={(isPendingThread ? draft?.thinkingLevel : session?.config?.thinkingLevel) ?? ''}
      onEffortChange={(level) => {
        if (isPendingThread) {
          // 新会话：Thinking 级别一并写入草稿（随创建请求应用）。
          if (draft) setDraftModel({ ...draft, thinkingLevel: level as HarnessThinkingLevel })
          return
        }
        void actions.setThinkingLevel(level as HarnessThinkingLevel)
      }}
    >
      <ModelSelectorTrigger>
        <ModelSelectorValue showEffort />
      </ModelSelectorTrigger>
      <ModelSelectorContent />
    </ModelSelectorRoot>
  )
})
