/**
 * 模型选择器：目录来自 serviceStore 的目标/版本查询，选择动作归 model feature store。
 *
 * 新会话（windowStore selection.kind === 'new'）写入窗口草稿，随创建请求生效；
 * 已有会话走公共 sessionActions.setModel / setThinkingLevel，真实改变会话配置。
 * 不在组件里缓存 models，也不使用模块级草稿单例。
 */

import type { HarnessModelInfo, HarnessThinkingLevel } from '@huan/protocol'
import { draftIdOf, selectHarnessModelCatalog, useServiceStore, useWindowStore } from '@huan/react'
import { memo, useEffect, useMemo } from 'react'
import {
  type ModelOption,
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
} from '@/components/ui/model-selector'
import { useModelStore } from '@/state/app-context'
import type { ModelTarget } from '@/state/model-store'

/** 把宿主模型目录映射为选择器条目；Thinking 级别完整来自模型能力（含 max）。 */
function toModelOptions(infos: readonly HarnessModelInfo[]): ModelOption[] {
  return infos.map((info) => ({
    id: `${info.provider}/${info.modelId}`,
    name: info.name ?? info.modelId,
    description: info.provider,
    ...(info.availableThinkingLevels && info.availableThinkingLevels.length > 1
      ? {
          efforts: info.availableThinkingLevels.map((level) => ({ id: level, name: level })),
        }
      : {}),
  }))
}

const targetKeyOf = (target: ModelTarget | undefined): string => {
  if (!target) return 'none'
  if (target.threadId) return `t:${target.threadId}`
  return `w:${target.workspaceId ?? ''}:${target.workspacePath}`
}

export const PiModelSelector = memo(function PiModelSelector() {
  const selection = useWindowStore((state) => state.selection)
  const metadata = useServiceStore((state) =>
    selection?.kind === 'thread' ? state.threadsById[selection.threadId] : undefined,
  )
  const host = useServiceStore((state) => state.host)
  const currentTarget = useMemo<ModelTarget | undefined>(() => {
    if (selection?.kind === 'new') {
      return {
        workspacePath: selection.startProjectPath,
        ...(selection.workspaceId ? { workspaceId: selection.workspaceId } : {}),
      }
    }
    if (selection?.kind !== 'thread') return undefined
    const workspacePath = metadata?.workspacePath ?? host?.workspacePath
    return workspacePath ? { workspacePath, threadId: selection.threadId } : undefined
  }, [selection, metadata?.workspacePath, host?.workspacePath])
  const currentTargetKey = targetKeyOf(currentTarget)
  const entry = useServiceStore((state) =>
    currentTarget ? selectHarnessModelCatalog(state, currentTarget) : undefined,
  )
  const authRevision = useServiceStore((state) => state.providerAuth?.authRevision)
  const readOnly = useServiceStore(
    (state) => state.workspaceState !== undefined && state.workspaceState !== 'ok',
  )
  const models = entry?.models ?? []

  const open = useModelStore((state) => state.open)
  const panelTargetKey = useModelStore((state) => state.targetKey)
  const busy = useModelStore((state) => state.busy)
  const notice = useModelStore((state) => state.notice)
  const error = useModelStore((state) => state.error)
  const openPanel = useModelStore((state) => state.openPanel)
  const close = useModelStore((state) => state.close)
  const loadCatalog = useModelStore((state) => state.loadCatalog)
  const chooseModel = useModelStore((state) => state.chooseModel)
  const chooseThinking = useModelStore((state) => state.chooseThinking)

  const draft = useWindowStore((state) =>
    selection ? state.draftsById[draftIdOf(selection)] : undefined,
  )
  const isNew = selection?.kind === 'new'
  const confirmedKey =
    metadata?.config?.provider && metadata.config.modelId
      ? `${metadata.config.provider}/${metadata.config.modelId}`
      : undefined
  const draftKey = draft?.model ? `${draft.model.provider}/${draft.model.modelId}` : undefined
  // 新会话以草稿预选为准；已有会话以服务端实际配置为准。
  const displayKey = isNew ? draftKey : confirmedKey
  const effort = isNew
    ? draft?.thinkingLevel
    : (metadata?.config?.thinkingLevel as HarnessThinkingLevel | undefined)
  const fallback = metadata?.modelFallback

  // 目录按目标与认证/资源/目录版本读取；认证刷新会得到新的查询键。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 认证/目录版本是 serviceStore 查询键
  useEffect(() => {
    if (!currentTarget) return
    void loadCatalog(currentTarget)
  }, [currentTarget, currentTargetKey, authRevision, metadata?.modelCatalogRevision, loadCatalog])

  // 选择器可见目标必须仍是当前窗口目标；切换选择时由 bootstrap 关闭旧面板。
  const visible = open && panelTargetKey === currentTargetKey
  const options = useMemo(() => toModelOptions(models), [models])
  const scopeKeys = metadata?.scopedModelKeys
  const selectableModels =
    !scopeKeys?.length || isNew
      ? options
      : options.map((option) => ({ ...option, disabled: !scopeKeys.includes(option.id) }))

  const onValueChange = (key: string) => {
    const model = models.find((item) => `${item.provider}/${item.modelId}` === key)
    if (!model) return
    void chooseModel({ provider: model.provider, modelId: model.modelId })
  }

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      data-slot="huan-model-selector"
      data-model-fallback={fallback?.reason}
      title={fallback?.message}
    >
      <ModelSelectorRoot
        key={currentTargetKey}
        models={selectableModels}
        value={displayKey ?? ''}
        onValueChange={onValueChange}
        effort={effort ?? ''}
        onEffortChange={(level) => void chooseThinking(level as HarnessThinkingLevel)}
        open={visible}
        onOpenChange={(next) => {
          if (next) void openPanel()
          else close()
        }}
      >
        <ModelSelectorTrigger
          size="sm"
          variant="ghost"
          aria-label="选择模型"
          disabled={!currentTarget || readOnly}
        >
          <ModelSelectorValue showEffort placeholder="选择模型" />
        </ModelSelectorTrigger>
        <ModelSelectorContent />
      </ModelSelectorRoot>
      {busy ? (
        <span className="text-muted-foreground text-[10px]">…</span>
      ) : error ? (
        <span
          role="status"
          className="text-destructive max-w-40 truncate text-[10px]"
          title={error}
        >
          {error}
        </span>
      ) : notice ? (
        <span
          role="status"
          className="text-muted-foreground max-w-40 truncate text-[10px]"
          title={notice}
        >
          {notice}
        </span>
      ) : null}
    </div>
  )
})
