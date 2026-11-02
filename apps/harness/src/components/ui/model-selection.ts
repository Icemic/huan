'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ModelSelectorEffortOption = {
  id: string
  name: string
}

export const DEFAULT_EFFORT_OPTIONS: readonly ModelSelectorEffortOption[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Med' },
  { id: 'high', name: 'High' },
]

export type ModelOption = {
  id: string
  name: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
  /** 除 id、name、description 外参与搜索匹配的附加词。 */
  keywords?: readonly string[]
  /** 模型支持的 Thinking 级别；省略表示不可配置。 */
  efforts?: boolean | readonly ModelSelectorEffortOption[]
}

export function getModelEfforts(
  model: ModelOption | undefined,
): readonly ModelSelectorEffortOption[] | undefined {
  if (!model?.efforts) return undefined
  return model.efforts === true ? DEFAULT_EFFORT_OPTIONS : model.efforts
}

export function resolveEffort(
  efforts: readonly ModelSelectorEffortOption[] | undefined,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined
  return efforts?.some((item) => item.id === effort) ? effort : undefined
}

/**
 * 仅在当前模型支持时返回 Thinking 级别；切换模型时保留用户选择，
 * 由当前模型的可用级别决定是否实际生效。
 */
export function resolveModelEffort(
  models: readonly ModelOption[],
  modelId: string | undefined,
  effort: string | undefined,
): string | undefined {
  return resolveEffort(
    getModelEfforts(models.find((model) => model.id === modelId)),
    effort,
  )
}

export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop: T | undefined
  defaultProp: T | undefined
  onChange: ((next: T) => void) | undefined
}) {
  const [internal, setInternal] = useState(defaultProp)
  const isControlled = prop !== undefined
  const value = isControlled ? prop : internal
  // 用 ref 读取 onChange，避免内联回调让 setter 与 context 每次渲染都重建。
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next)
      onChangeRef.current?.(next)
    },
    [isControlled],
  )
  return [value, setValue] as const
}

type ModelSelectorContextValue = {
  models: readonly ModelOption[]
  value: string | undefined
  setValue: (value: string) => void
  /** 当前值对应的模型，供所有子组件复用。 */
  selectedModel: ModelOption | undefined
  /** 当前模型的 Thinking 级别；不可配置时为 undefined。 */
  efforts: readonly ModelSelectorEffortOption[] | undefined
  /** 已按当前模型能力解析过的 Thinking 选择。 */
  effort: string | undefined
  setEffort: (effort: string) => void
}

export const ModelSelectorContext = createContext<ModelSelectorContextValue | null>(null)

export function useModelSelectorContext() {
  const context = useContext(ModelSelectorContext)
  if (!context) {
    throw new Error('ModelSelector 子组件必须在 ModelSelector.Root 内使用')
  }
  return context
}

/** 读取当前模型的 Thinking 级别与设置函数，供自定义级别控件使用。 */
export function useModelSelectorEfforts(): {
  efforts: readonly ModelSelectorEffortOption[] | undefined
  effort: string | undefined
  setEffort: (effort: string) => void
} {
  const { efforts, effort, setEffort } = useModelSelectorContext()
  return { efforts, effort, setEffort }
}
