'use client'

import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react'
import { useId, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import {
  getModelEfforts,
  ModelSelectorContext,
  resolveEffort,
  useControllableState,
  useModelSelectorContext,
  useModelSelectorEfforts,
  type ModelOption,
} from './model-selection'

export {
  DEFAULT_EFFORT_OPTIONS,
  resolveModelEffort,
  useModelSelectorContext,
  useModelSelectorEfforts,
} from './model-selection'
export type { ModelOption, ModelSelectorEffortOption } from './model-selection'

export type ModelSelectorRootProps = {
  models: readonly ModelOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  effort?: string
  defaultEffort?: string
  onEffortChange?: (effort: string) => void
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

/**
 * Base UI Combobox 的搜索匹配：模型 id、名称、provider 与附加关键词。
 * 值仍使用 `provider/modelId`，与宿主 setModel 参数拆分保持一致。
 */
const filterModel = (model: ModelOption, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [model.id, model.name, model.description, ...(model.keywords ?? [])].some((value) =>
    value?.toLowerCase().includes(needle),
  )
}

function ModelSelectorRoot({
  models,
  value: valueProp,
  defaultValue,
  onValueChange,
  effort: effortProp,
  defaultEffort,
  onEffortChange,
  open,
  defaultOpen,
  onOpenChange,
  children,
}: ModelSelectorRootProps) {
  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? models[0]?.id,
    onChange: onValueChange,
  })
  const [effort, setEffort] = useControllableState({
    prop: effortProp,
    defaultProp: defaultEffort,
    onChange: onEffortChange,
  })
  const items = useMemo(
    () =>
      ComboboxPrimitive.createItems(models, {
        getValue: (model) => model.id,
        getLabel: (model) => model.name,
      }),
    [models],
  )
  const selectedModel = models.find((model) => model.id === value)
  const efforts = getModelEfforts(selectedModel)
  const activeEffort = resolveEffort(efforts, effort)
  const contextValue = useMemo(
    () => ({
      models,
      value,
      setValue,
      selectedModel,
      efforts,
      effort: activeEffort,
      setEffort,
    }),
    [models, value, setValue, selectedModel, efforts, activeEffort, setEffort],
  )

  return (
    <ModelSelectorContext.Provider value={contextValue}>
      <ComboboxPrimitive.Root
        items={items}
        value={value ?? null}
        onValueChange={(next) => {
          if (next !== null) setValue(next)
        }}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={(next) => onOpenChange?.(next)}
        filter={filterModel}
        autoHighlight
      >
        {children}
      </ComboboxPrimitive.Root>
    </ModelSelectorContext.Provider>
  )
}

export const modelSelectorTriggerVariants = cva(
  'focus-visible:ring-ring/50 flex w-fit items-center justify-between gap-2 overflow-hidden rounded-lg text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-3.5',
  {
    variants: {
      variant: {
        outline: 'border-input hover:bg-accent hover:text-accent-foreground border bg-transparent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        muted: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      },
      size: {
        default: 'h-8 px-2.5 py-1.5',
        sm: 'h-7 rounded-[min(var(--radius-md),12px)] px-2 py-1 text-xs',
        lg: 'h-9 px-3 py-2',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
)

export type ModelSelectorTriggerProps = ComboboxPrimitive.Trigger.Props &
  VariantProps<typeof modelSelectorTriggerVariants>

function ModelSelectorTrigger({
  className,
  variant,
  size,
  children,
  ...props
}: ModelSelectorTriggerProps) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="model-selector-trigger"
      data-variant={variant ?? 'outline'}
      data-size={size ?? 'default'}
      role="combobox"
      aria-haspopup="listbox"
      className={cn(modelSelectorTriggerVariants({ variant, size }), className)}
      {...props}
    >
      {children ?? <ModelSelectorValue />}
      <ChevronDownIcon className="size-4 opacity-50" />
    </ComboboxPrimitive.Trigger>
  )
}

export type ModelSelectorValueProps = {
  placeholder?: ReactNode
  /** 在模型名旁显示当前 Thinking 级别。 */
  showEffort?: boolean
  className?: string
}

function ModelIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5',
        className,
      )}
    >
      {children}
    </span>
  )
}

function ModelSelectorValue({
  placeholder = 'Select model',
  showEffort = true,
  className,
}: ModelSelectorValueProps) {
  const { selectedModel, efforts, effort } = useModelSelectorContext()

  if (!selectedModel) {
    return (
      <span data-slot="model-selector-value" className={cn('text-muted-foreground', className)}>
        {placeholder}
      </span>
    )
  }

  const effortName =
    showEffort && effort !== undefined
      ? efforts?.find((item) => item.id === effort)?.name
      : undefined

  return (
    <span
      data-slot="model-selector-value"
      className={cn('flex min-w-0 items-center gap-2', className)}
    >
      {selectedModel.icon && <ModelIcon>{selectedModel.icon}</ModelIcon>}
      <span className="truncate font-medium">{selectedModel.name}</span>
      {effortName && (
        <span className="text-muted-foreground min-w-7.5 truncate text-center">{effortName}</span>
      )}
    </span>
  )
}

export type ModelSelectorContentProps = ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'collisionPadding'
  >

/** 模型搜索弹层：输入框位于弹层内，列表与 Thinking 控件相互独立。 */
function ModelSelectorContent({
  className,
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 6,
  collisionPadding,
  ...props
}: ModelSelectorContentProps) {
  const { i18n } = useLingui()
  const searchLabel = i18n._(msg`搜索模型`)

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="model-selector-content"
          className={cn(
            'bg-popover text-popover-foreground flex w-72 max-w-(--available-width) min-w-(--anchor-width) flex-col overflow-hidden rounded-lg shadow-md ring-1 ring-foreground/10 outline-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        >
          <div className="flex h-8 items-center gap-2 border-b px-2.5">
            <SearchIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <ComboboxPrimitive.Input
              data-slot="model-selector-search"
              aria-label={searchLabel}
              placeholder={`${searchLabel}…`}
              className="placeholder:text-muted-foreground h-full w-full min-w-0 bg-transparent text-sm outline-none"
            />
          </div>
          <ComboboxPrimitive.Empty data-slot="model-selector-empty" className="p-0">
            <div className="text-muted-foreground px-3 py-4 text-sm">
              <Trans>没有匹配的模型。</Trans>
            </div>
          </ComboboxPrimitive.Empty>
          <ComboboxPrimitive.List
            data-slot="model-selector-list"
            className="max-h-72 overflow-y-auto overscroll-contain p-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            {(model: ModelOption) => (
              <ComboboxPrimitive.Item
                key={model.id}
                value={model.id}
                disabled={model.disabled}
                data-slot="model-selector-item"
                className="group/item relative flex cursor-default items-start gap-2 rounded-md py-2 ps-2 pe-8 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              >
                {model.icon && <ModelIcon className="mt-[3px]">{model.icon}</ModelIcon>}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{model.name}</span>
                  {model.description && (
                    <span className="text-muted-foreground group-data-highlighted/item:text-accent-foreground/80 truncate text-xs">
                      {model.description}
                    </span>
                  )}
                </span>
                <ComboboxPrimitive.ItemIndicator
                  render={<span className="absolute end-2 top-2.5 flex size-4 items-center justify-center" />}
                >
                  <CheckIcon aria-hidden className="size-4" />
                </ComboboxPrimitive.ItemIndicator>
              </ComboboxPrimitive.Item>
            )}
          </ComboboxPrimitive.List>
          <ModelSelectorEffort />
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

export type ModelSelectorEffortProps = ComponentPropsWithoutRef<'div'> & {
  label?: ReactNode
}

/**
 * Thinking 级别作为独立 radiogroup 放在 listbox 之外，
 * 不在 option 内嵌交互控件，保持列表单选语义。
 */
function ModelSelectorEffort({ label, className, ...props }: ModelSelectorEffortProps) {
  const { efforts, effort, setEffort } = useModelSelectorEfforts()
  const labelId = useId()

  if (!efforts?.length) return null

  return (
    <div
      data-slot="model-selector-effort"
      className={cn('flex items-center justify-between gap-3 border-t px-2.5 py-1.5', className)}
      {...props}
    >
      <span id={labelId} className="text-muted-foreground text-xs">
        {label ?? <Trans>Thinking</Trans>}
      </span>
      <RadioGroupPrimitive
        value={effort ?? ''}
        onValueChange={(next) => setEffort(next)}
        aria-labelledby={labelId}
        className="flex items-center gap-0.5"
      >
        {efforts.map((option) => (
          <RadioPrimitive.Root
            key={option.id}
            value={option.id}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 cursor-pointer rounded-md px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-1 data-checked:bg-accent data-checked:font-medium data-checked:text-accent-foreground"
          >
            {option.name}
          </RadioPrimitive.Root>
        ))}
      </RadioGroupPrimitive>
    </div>
  )
}

export {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
  ModelSelectorContent,
  ModelSelectorEffort,
}
