/**
 * 受控模型范围编辑：普通模型多选，高级 patterns 原文按需展开。
 *
 * 组件只编辑 patterns 数组，不读写任何 store 或目录缓存；全局设置与工作区表单
 * 各自保存草稿。空 patterns 沿用 Pi 语义表示全部模型，因此普通名单默认全部勾选；
 * 自定义范围需要在父表单保证保存时至少有一个模式。
 */

import type { HarnessModelInfo } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'

/** 模型模式中的 Thinking 后缀；匹配时忽略，回写时保留原文。 */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i

/** 模型在目录中的稳定键。 */
export const modelKeyOf = (model: Pick<HarnessModelInfo, 'provider' | 'modelId'>): string =>
  `${model.provider}/${model.modelId}`

/** 去掉模式末尾的 Thinking 后缀；只用于匹配，不修改原文。 */
export const stripModelThinkingSuffix = (pattern: string): string =>
  pattern.trim().replace(THINKING_SUFFIX, '')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 简单 glob：`*` 与 `?`，与 Pi 的通配模式保持大小写不敏感。 */
const globMatches = (value: string, pattern: string): boolean => {
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*'
      if (character === '?') return '.'
      return escapeRegExp(character)
    })
    .join('')
  return new RegExp(`^${source}$`, 'i').test(value)
}

/**
 * 单个 patterns 行是否包含目录中的模型。
 *
 * 与 Pi 一致：通配模式可匹配 `provider/modelId` 或仅模型 ID；普通模式同时接受
 * 完整键与模型 ID，Thinking 后缀不参与匹配。
 */
export const modelPatternMatchesModel = (
  pattern: string,
  model: Pick<HarnessModelInfo, 'provider' | 'modelId'>,
): boolean => {
  const base = stripModelThinkingSuffix(pattern)
  if (!base) return false
  const key = modelKeyOf(model)
  if (base.includes('*') || base.includes('?')) {
    return globMatches(key, base) || globMatches(model.modelId, base)
  }
  return (
    base.toLowerCase() === key.toLowerCase() || base.toLowerCase() === model.modelId.toLowerCase()
  )
}

/** 高级 textarea 原文拆行；空行忽略，其余内容按原样保留。 */
export const parseModelPatternText = (text: string): string[] =>
  text.split(/\r?\n/).filter((line) => line.trim().length > 0)

const isExactModelPattern = (pattern: string, model: HarnessModelInfo): boolean =>
  stripModelThinkingSuffix(pattern).toLowerCase() === modelKeyOf(model).toLowerCase()

/** 普通多选当前可见的勾选状态；空 patterns 表示全部。 */
export const modelPatternsSelectModel = (
  patterns: readonly string[],
  model: HarnessModelInfo,
): boolean =>
  patterns.length === 0 || patterns.some((pattern) => modelPatternMatchesModel(pattern, model))

/**
 * 普通多选切换后的 patterns。
 *
 * `checked` 是复选框切换后的新状态：勾选只追加精确键，取消只删除该模型的精确
 * 模式（含 Thinking 后缀）。空 patterns 在 Pi 中表示全部，因此取消最后一项时保持
 * 原数组；只由高级通配模式包含的模型也无法用普通多选表达排除，调用方应禁用该行。
 */
export const toggleModelPattern = (
  patterns: readonly string[],
  models: readonly HarnessModelInfo[],
  model: HarnessModelInfo,
  checked: boolean,
): string[] => {
  const exact = patterns.some((pattern) => isExactModelPattern(pattern, model))
  if (checked) {
    if (patterns.length === 0 || exact) return [...patterns]
    return [...patterns, modelKeyOf(model)]
  }
  if (patterns.length === 0) {
    const remaining = models.filter((item) => item !== model).map(modelKeyOf)
    return remaining.length > 0 ? remaining : [...patterns]
  }
  if (!exact) return [...patterns]
  const remaining = patterns.filter((pattern) => !isExactModelPattern(pattern, model))
  return remaining.length > 0 ? remaining : [...patterns]
}

export type ModelScopeEditorProps = {
  models: readonly HarnessModelInfo[]
  value: readonly string[]
  onChange: (patterns: string[]) => void
  disabled?: boolean
}

/** 受控模型范围编辑；目录刷新与保存由父组件负责。 */
export function ModelScopeEditor({
  models,
  value,
  onChange,
  disabled = false,
}: ModelScopeEditorProps) {
  const patterns = useMemo(() => [...value], [value])
  const visibleModels = useMemo(
    () => models.filter((model) => model.provider.length > 0 && model.modelId.length > 0),
    [models],
  )
  // 高级原文保留正在输入的换行；只有外部 patterns 真正变化时才覆盖本地文本。
  const [advancedText, setAdvancedText] = useState(() => value.join('\n'))
  useEffect(() => {
    const current = parseModelPatternText(advancedText)
    const unchanged =
      current.length === value.length && current.every((line, index) => line === value[index])
    if (!unchanged) setAdvancedText(value.join('\n'))
  }, [advancedText, value])

  return (
    <div className="flex flex-col gap-2" data-slot="huan-model-scope-editor">
      {visibleModels.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>没有可用模型。</Trans>
        </p>
      ) : (
        <fieldset
          aria-label="模型范围"
          className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border p-1"
        >
          {visibleModels.map((model) => {
            const key = modelKeyOf(model)
            const selected = modelPatternsSelectModel(patterns, model)
            const exact = patterns.some((pattern) => isExactModelPattern(pattern, model))
            // 通配包含的行无法用普通多选排除；最后一项取消后会变成空 patterns（全部）。
            const lockedByPattern = !disabled && patterns.length > 0 && selected && !exact
            const lockedAsLast =
              !disabled &&
              selected &&
              (patterns.length === 0
                ? visibleModels.length === 1
                : patterns.every((pattern) => isExactModelPattern(pattern, model)))
            const locked = lockedByPattern || lockedAsLast
            return (
              <label
                key={key}
                data-slot="huan-model-scope-option"
                data-model-key={key}
                data-locked={locked ? 'true' : undefined}
                title={
                  lockedByPattern
                    ? '该模型由高级 patterns 通配包含，请在高级模式中修改。'
                    : lockedAsLast
                      ? '至少保留一项模型；可改用高级 patterns 调整。'
                      : undefined
                }
                className="hover:bg-accent flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-current"
                  checked={selected}
                  disabled={disabled || locked}
                  onChange={(event) =>
                    onChange(
                      toggleModelPattern(patterns, visibleModels, model, event.target.checked),
                    )
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{model.name ?? model.modelId}</span>
                  <span className="text-muted-foreground break-all font-mono text-xs">{key}</span>
                </span>
              </label>
            )
          })}
        </fieldset>
      )}

      <details data-slot="huan-model-scope-advanced">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
          <Trans>高级 patterns</Trans>
        </summary>
        <div className="flex flex-col gap-1 pt-2">
          <p className="text-muted-foreground text-xs">
            <Trans>每行一个模式，可保留 :thinking 后缀与通配符。</Trans>
          </p>
          <Textarea
            aria-label="模型 patterns"
            className="min-h-24 font-mono text-xs"
            value={advancedText}
            disabled={disabled}
            placeholder={'provider/model\nanthropic/*:high'}
            onChange={(event) => {
              const text = event.target.value
              setAdvancedText(text)
              onChange(parseModelPatternText(text))
            }}
          />
        </div>
      </details>
    </div>
  )
}
