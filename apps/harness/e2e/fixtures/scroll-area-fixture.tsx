/**
 * ScrollArea 浏览器夹具：复用真实共享组件、Select/Menu/Combobox 封装，
 * 覆盖长列表键盘导航、max-h 高度约束与横向拖动。
 *
 * 只由 Playwright 访问，不注册到生产入口；不通过改写 DOM 制造溢出，
 * 所有内容尺寸都由组件与实际布局产生。
 */
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import {
  ModelSelectorContent,
  ModelSelectorRoot,
  ModelSelectorTrigger,
} from '@/components/ui/model-selector'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import '@/index.css'

// 夹具只读取组件可访问标记，不依赖生产语言包；空目录即可让 Lingui 提供者可用。
i18n.loadAndActivate({ locale: 'zh-CN', messages: {} })

const OPTIONS = Array.from(
  { length: 40 },
  (_, index) => `选项 ${String(index + 1).padStart(2, '0')}`,
)

const MODELS = Array.from({ length: 30 }, (_, index) => {
  const suffix = String(index + 1).padStart(2, '0')
  return {
    id: `fixture/model-${suffix}`,
    name: `模型 ${suffix}`,
    description: '夹具服务商',
  }
})

const SHORT_ROWS = ['短内容 1', '短内容 2', '短内容 3']
const LONG_ROWS = Array.from({ length: 30 }, (_, index) => `长内容 ${index + 1}`)
const HORIZONTAL_ITEMS = Array.from({ length: 16 }, (_, index) => `横向 ${index + 1}`)

function ScrollAreaFixture() {
  const [selectValue, setSelectValue] = useState(OPTIONS[0])
  const [menuValue, setMenuValue] = useState('未选择')

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
          <SelectContent className="w-56">
            {OPTIONS.map((label) => (
              <SelectItem key={label} value={label}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section data-testid="menu-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">Menu 长列表</p>
        <div className="flex items-center gap-2">
          <Menu>
            <MenuTrigger
              data-testid="menu-trigger"
              className="w-56 rounded-lg border px-3 py-1.5 text-left text-sm"
            >
              打开菜单
            </MenuTrigger>
            <MenuContent className="w-56">
              {OPTIONS.map((label) => (
                <MenuItem key={label} onClick={() => setMenuValue(label)}>
                  {label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <span data-testid="menu-value" className="text-sm">
            {menuValue}
          </span>
        </div>
      </section>

      <section data-testid="combobox-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">Combobox 长列表</p>
        <ModelSelectorRoot models={MODELS} defaultValue={MODELS[0]?.id}>
          <ModelSelectorTrigger data-testid="combobox-trigger" />
          <ModelSelectorContent />
        </ModelSelectorRoot>
      </section>

      <section data-testid="max-height-section" className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">max-h 短内容</p>
          <ScrollArea
            data-testid="maxheight-short"
            className="w-64 rounded-lg border"
            contentProps={{ className: 'p-2' }}
          >
            {SHORT_ROWS.map((label) => (
              <div key={label} className="flex h-6 items-center text-sm">
                {label}
              </div>
            ))}
          </ScrollArea>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">max-h 长内容</p>
          <ScrollArea
            data-testid="maxheight-long"
            className="max-h-40 w-64 rounded-lg border"
            contentProps={{ className: 'p-2' }}
          >
            {LONG_ROWS.map((label) => (
              <div key={label} className="flex h-6 items-center text-sm">
                {label}
              </div>
            ))}
          </ScrollArea>
        </div>
      </section>

      <section data-testid="horizontal-section" className="flex flex-col gap-2">
        <p className="text-sm font-medium">横向滚动</p>
        <ScrollArea
          data-testid="horizontal-scroll"
          orientation="horizontal"
          className="h-20 w-64 rounded-lg border"
          viewportProps={{ 'aria-label': '横向滚动内容' }}
        >
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
        </ScrollArea>
      </section>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('ScrollArea 夹具缺少根节点')
createRoot(root).render(
  <I18nProvider i18n={i18n}>
    <ScrollAreaFixture />
  </I18nProvider>,
)
