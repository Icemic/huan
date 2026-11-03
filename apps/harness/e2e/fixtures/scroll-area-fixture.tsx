/**
 * ScrollArea 浏览器夹具：复用真实官方 Select/DropdownMenu/Combobox/ScrollArea 组合，
 * 覆盖长列表键盘导航、max-h 高度约束与横向拖动。
 *
 * 只由 Playwright 访问，不注册到生产入口；不通过改写 DOM 制造溢出，
 * 所有内容尺寸都由组件与实际布局产生。
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import '@/index.css'

const OPTIONS = Array.from(
  { length: 40 },
  (_, index) => `选项 ${String(index + 1).padStart(2, '0')}`,
)

type FixtureModel = {
  value: string
  label: string
}

const MODELS: FixtureModel[] = Array.from({ length: 30 }, (_, index) => {
  const suffix = String(index + 1).padStart(2, '0')
  return {
    value: `fixture/model-${suffix}`,
    label: `模型 ${suffix}`,
  }
})

const SHORT_ROWS = ['短内容 1', '短内容 2', '短内容 3']
const LONG_ROWS = Array.from({ length: 30 }, (_, index) => `长内容 ${index + 1}`)
const HORIZONTAL_ITEMS = Array.from({ length: 16 }, (_, index) => `横向 ${index + 1}`)

function ScrollAreaFixture() {
  const [selectValue, setSelectValue] = useState(OPTIONS[0])
  const [menuValue, setMenuValue] = useState('未选择')
  const [comboboxValue, setComboboxValue] = useState<FixtureModel | null>(MODELS[0] ?? null)

  return (
    <div
      data-testid="scroll-fixture"
      className="mx-auto flex w-[min(56rem,calc(100vw-2rem))] flex-col gap-8 p-6"
    >
      <section data-testid="select-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">Select 长列表</p>
        <Select
          value={selectValue}
          onValueChange={(value) => {
            if (value) setSelectValue(value)
          }}
        >
          <SelectTrigger data-testid="select-trigger" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-56 overflow-hidden" alignItemWithTrigger={false}>
            {/* 官方 Select 只在 List 内滚动；业务侧用 ScrollArea 承担视觉轨道与限高。 */}
            <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[min(18rem,var(--available-height))]">
              {OPTIONS.map((label) => (
                <SelectItem key={label} value={label}>
                  {label}
                </SelectItem>
              ))}
            </ScrollArea>
          </SelectContent>
        </Select>
      </section>

      <section data-testid="menu-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">DropdownMenu 长列表</p>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="menu-trigger"
              className="w-56 rounded-lg border px-3 py-1.5 text-left text-sm"
            >
              打开菜单
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-64">
                {OPTIONS.map((label) => (
                  <DropdownMenuItem key={label} onClick={() => setMenuValue(label)}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
          <span data-testid="menu-value" className="text-sm">
            {menuValue}
          </span>
        </div>
      </section>

      <section data-testid="combobox-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">Combobox 长列表</p>
        <Combobox
          items={MODELS}
          value={comboboxValue}
          onValueChange={(model) => setComboboxValue(model)}
          autoHighlight
        >
          <ComboboxTrigger
            data-testid="combobox-trigger"
            className="bg-background w-56 rounded-lg border px-3 py-1.5 text-left text-sm"
          >
            {comboboxValue?.label ?? '选择模型'}
          </ComboboxTrigger>
          <ComboboxContent className="w-72 max-w-(--available-width) min-w-(--anchor-width)">
            <ComboboxInput
              data-testid="combobox-search"
              aria-label="搜索模型"
              placeholder="搜索模型…"
              showTrigger={false}
            />
            <ScrollArea className="min-h-0 *:data-[slot=scroll-area-viewport]:max-h-72">
              <ComboboxList className="max-h-none overflow-visible p-1">
                {(model: FixtureModel) => (
                  <ComboboxItem key={model.value} value={model} className="py-2">
                    {model.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ScrollArea>
          </ComboboxContent>
        </Combobox>
      </section>

      <section data-testid="max-height-section" className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">max-h 短内容</p>
          <ScrollArea data-testid="maxheight-short" className="w-64 rounded-lg border">
            <div className="p-2">
              {SHORT_ROWS.map((label) => (
                <div key={label} className="flex h-6 items-center text-sm">
                  {label}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">max-h 长内容</p>
          <ScrollArea
            data-testid="maxheight-long"
            className="w-64 rounded-lg border *:data-[slot=scroll-area-viewport]:max-h-40"
          >
            <div className="p-2">
              {LONG_ROWS.map((label) => (
                <div key={label} className="flex h-6 items-center text-sm">
                  {label}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </section>

      <section data-testid="horizontal-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">横向滚动</p>
        <ScrollArea data-testid="horizontal-scroll" className="h-20 w-64 rounded-lg border">
          <div data-testid="horizontal-content" className="flex w-[40rem] gap-2 p-2">
            {HORIZONTAL_ITEMS.map((label) => (
              <span
                key={label}
                className="bg-muted shrink-0 rounded px-2 py-1 text-xs whitespace-nowrap"
              >
                {label}
              </span>
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </section>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('ScrollArea 夹具缺少根节点')
createRoot(root).render(<ScrollAreaFixture />)
