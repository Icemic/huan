/**
 * 模型选择器：目录来自 serviceStore 的目标/版本查询，选择动作归 model feature store。
 *
 * 新会话（windowStore selection.kind === 'new'）写入窗口草稿，随创建请求生效；
 * 已有会话走公共 sessionActions.setModel / setThinkingLevel，真实改变会话配置。
 * 弹层直接组合官方 Combobox/ScrollArea/RadioGroup；不在组件里缓存 models，
 * 也不使用模块级草稿单例。
 */

import type { HarnessModelInfo, HarnessThinkingLevel } from '@huan/protocol'
import { draftIdOf, selectHarnessModelCatalog, useServiceStore, useWindowStore } from '@huan/react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { memo, useEffect, useId, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useModelStore, useSettingsUiStore } from '@/state/app-context'
import type { ModelTarget } from '@/state/model-store'

/** 选择器条目：value 同时作为 Base UI 的选择值与搜索主键。 */
type ModelOption = {
  /** `provider/modelId`，与宿主 setModel 参数拆分保持一致。 */
  value: string
  /** 展示名称；Base UI 用 `value/label` 结构解析已选标签。 */
  label: string
  provider: string
  modelId: string
  /** 模型支持的 Thinking 级别；省略表示不可配置。 */
  thinkingLevels?: readonly HarnessThinkingLevel[]
}

const EMPTY_MODELS: readonly HarnessModelInfo[] = []

/** 把宿主模型目录映射为选择器条目；Thinking 级别完整来自模型能力（含 max）。 */
function toModelOptions(infos: readonly HarnessModelInfo[]): ModelOption[] {
  return infos.map((info) => ({
    value: `${info.provider}/${info.modelId}`,
    label: info.name ?? info.modelId,
    provider: info.provider,
    modelId: info.modelId,
    ...(info.availableThinkingLevels && info.availableThinkingLevels.length > 1
      ? { thinkingLevels: info.availableThinkingLevels }
      : {}),
  }))
}

/** 搜索匹配：provider/modelId、模型名称与 provider。 */
function filterModel(model: ModelOption, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [model.value, model.label, model.provider].some((text) =>
    text.toLowerCase().includes(needle),
  )
}

const targetKeyOf = (target: ModelTarget | undefined): string => {
  if (!target) return 'none'
  if (target.threadId) return `t:${target.threadId}`
  return `w:${target.workspaceId ?? ''}:${target.workspacePath}`
}

export const PiModelSelector = memo(function PiModelSelector({
  owner = 'composer',
}: {
  /** 选择器实例标识；只有触发的实例渲染弹层。 */
  owner?: string
}) {
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
    return workspacePath
      ? {
          workspacePath,
          threadId: selection.threadId,
          ...(metadata?.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
        }
      : undefined
  }, [selection, metadata?.workspaceId, metadata?.workspacePath, host?.workspacePath])
  const currentTargetKey = targetKeyOf(currentTarget)
  const entry = useServiceStore((state) =>
    currentTarget ? selectHarnessModelCatalog(state, currentTarget) : undefined,
  )
  const workspaceRevision = useServiceStore((state) =>
    currentTarget?.workspaceId
      ? state.workspacesById[currentTarget.workspaceId]?.revision
      : undefined,
  )
  const authRevision = useServiceStore((state) => state.providerAuth?.authRevision)
  const readOnly = useServiceStore(
    (state) => state.workspaceState !== undefined && state.workspaceState !== 'ok',
  )
  const models = entry?.models ?? EMPTY_MODELS

  const open = useModelStore((state) => state.open)
  const panelTargetKey = useModelStore((state) => state.targetKey)
  const panelOwner = useModelStore((state) => state.panelOwner)
  const busy = useModelStore((state) => state.busy)
  const notice = useModelStore((state) => state.notice)
  const error = useModelStore((state) => state.error)
  const openPanel = useModelStore((state) => state.openPanel)
  const close = useModelStore((state) => state.close)
  const loadCatalog = useModelStore((state) => state.loadCatalog)
  const chooseModel = useModelStore((state) => state.chooseModel)
  const chooseThinking = useModelStore((state) => state.chooseThinking)
  const openSettingsPage = useSettingsUiStore((state) => state.openPage)
  const { i18n } = useLingui()
  const searchLabel = i18n._(msg`搜索模型`)
  const effortLabelId = useId()

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

  // 目录按目标与认证/工作区/资源/目录版本读取；任一版本推进都会换查询键。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 目录版本是 serviceStore 查询键
  useEffect(() => {
    if (!currentTarget) return
    void loadCatalog(currentTarget)
  }, [
    currentTarget,
    currentTargetKey,
    authRevision,
    workspaceRevision,
    metadata?.workspaceRevision,
    metadata?.modelCatalogRevision,
    loadCatalog,
  ])

  // 选择器可见目标必须仍是当前窗口目标；切换选择时由 bootstrap 关闭旧面板。
  // 同一时刻只有一个实例展开弹层：避免上下文栏与输入区两个同名 popup。
  const visible = open && panelOwner === owner && panelTargetKey === currentTargetKey
  const rootRef = useRef<HTMLDivElement | null>(null)
  const wasVisible = useRef(false)
  // 选中条目后 Base UI 会关闭弹层；焦点在弹层卸载时可能落到不可见的
  // 第一个表单控件上，这里在关闭后把焦点交回触发按钮。
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (wasVisible.current && !visible && restoreFocus.current) {
      restoreFocus.current = false
      requestAnimationFrame(() => {
        const triggerElement = rootRef.current?.querySelector<HTMLElement>(
          '[data-slot="model-selector-trigger"]',
        )
        triggerElement?.focus()
      })
    }
    if (wasVisible.current !== visible) restoreFocus.current = false
    wasVisible.current = visible
  }, [visible])

  const options = useMemo(() => toModelOptions(models), [models])
  const selectedModel = useMemo(
    () => (displayKey ? options.find((option) => option.value === displayKey) : undefined),
    [options, displayKey],
  )
  // 当前会话仍在使用、但已不在最终候选中的旧模型：只用于显示，不进入下拉候选。
  const fallbackLabel = displayKey && !selectedModel ? displayKey : undefined
  const thinkingLevels = selectedModel?.thinkingLevels
  // 只有当前模型确实支持该级别时才把它作为选中值；切换模型不会清掉用户的原始选择。
  const activeEffort = effort && thinkingLevels?.includes(effort) ? effort : undefined

  const emptyContent = (
    <div className="flex flex-col gap-2" data-slot="huan-model-selector-empty-state">
      {entry?.loading ? (
        <p>
          <Trans>正在读取模型目录…</Trans>
        </p>
      ) : (
        <p>
          <Trans>当前范围内没有可用模型。</Trans>
        </p>
      )}
      {entry?.error && (
        <p className="text-destructive break-all text-xs" title={entry.error}>
          {entry.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            close()
            openSettingsPage('models')
          }}
        >
          <Trans>打开设置</Trans>
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            close()
            openSettingsPage('models', { mode: 'login' })
          }}
        >
          <Trans>管理认证</Trans>
        </Button>
      </div>
    </div>
  )

  return (
    <div
      ref={rootRef}
      className="flex min-w-0 items-center gap-1"
      data-slot="huan-model-selector"
      data-model-fallback={fallback?.reason}
      title={fallback?.message}
    >
      <Combobox
        key={currentTargetKey}
        items={options}
        value={selectedModel ?? null}
        onValueChange={(model) => {
          if (!model) return
          void chooseModel({ provider: model.provider, modelId: model.modelId })
        }}
        open={visible}
        onOpenChange={(next, details) => {
          if (next) {
            void openPanel({ owner })
            return
          }
          if (details.reason === 'item-press') restoreFocus.current = true
          close()
        }}
        filter={filterModel}
        autoHighlight
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="default" />}
          data-slot="model-selector-trigger"
          aria-label="选择模型"
          disabled={!currentTarget || readOnly}
          className="shrink justify-between gap-2 overflow-hidden"
        >
          {selectedModel ? (
            <span data-slot="model-selector-value" className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{selectedModel.label}</span>
              {activeEffort && (
                <span className="text-muted-foreground min-w-7.5 truncate text-center">
                  {activeEffort}
                </span>
              )}
            </span>
          ) : (
            <span
              data-slot="model-selector-value"
              data-fallback={fallbackLabel ? 'true' : undefined}
              className={cn(
                'min-w-0 truncate',
                fallbackLabel ? 'font-medium' : 'text-muted-foreground',
              )}
            >
              {fallbackLabel ?? '选择模型'}
            </span>
          )}
        </ComboboxTrigger>
        <ComboboxContent
          data-slot="model-selector-content"
          className="w-72 max-w-(--available-width) min-w-(--anchor-width)"
        >
          <ComboboxInput
            data-slot="model-selector-search"
            aria-label={searchLabel}
            placeholder={`${searchLabel}…`}
            showTrigger={false}
          />
          <ComboboxEmpty
            data-slot="model-selector-empty"
            className="items-stretch justify-start px-3 py-4 text-start text-sm"
          >
            {options.length === 0 ? emptyContent : <Trans>没有匹配的模型。</Trans>}
          </ComboboxEmpty>
          <ScrollArea
            data-slot="model-selector-scroll"
            className="min-h-0 *:data-[slot=scroll-area-viewport]:max-h-72"
          >
            <ComboboxList
              data-slot="model-selector-list"
              className="max-h-none overflow-visible p-1"
            >
              {(model: ModelOption) => (
                <ComboboxItem
                  key={model.value}
                  value={model}
                  data-slot="model-selector-item"
                  className="group/item items-start py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{model.label}</span>
                    <span className="text-muted-foreground group-data-[highlighted]/item:text-accent-foreground/80 truncate text-xs">
                      {model.provider}
                    </span>
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ScrollArea>
          {thinkingLevels?.length ? (
            <div
              data-slot="model-selector-effort"
              className="flex items-center justify-between gap-3 border-t px-2.5 py-1.5"
            >
              <span id={effortLabelId} className="text-muted-foreground shrink-0 text-xs">
                <Trans>Thinking</Trans>
              </span>
              <RadioGroup
                value={activeEffort ?? ''}
                onValueChange={(level) => void chooseThinking(level as HarnessThinkingLevel)}
                aria-labelledby={effortLabelId}
                className="flex w-auto flex-1 flex-wrap items-center justify-end gap-x-2 gap-y-1"
              >
                {thinkingLevels.map((level) => {
                  const levelId = `${effortLabelId}-${level}`
                  return (
                    <label
                      key={level}
                      htmlFor={levelId}
                      className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs"
                    >
                      <RadioGroupItem id={levelId} value={level} aria-label={level} />
                      <span>{level}</span>
                    </label>
                  )
                })}
              </RadioGroup>
            </div>
          ) : null}
        </ComboboxContent>
      </Combobox>
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
