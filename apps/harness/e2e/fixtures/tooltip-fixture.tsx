/**
 * Tooltip 浏览器夹具：复用真实 Tooltip 组件，覆盖四个方向、碰撞翻转与明暗主题。
 *
 * 只由 Playwright 访问，不注册到生产入口；布局刻意让触发器贴近各边，
 * 以触发 Base UI 的碰撞翻转。
 */
import type { CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import '@/index.css'

type Side = 'top' | 'bottom' | 'left' | 'right'

interface Case {
  id: string
  label: string
  side: Side
  style: CSSProperties
}

const cases: Case[] = [
  {
    id: 'top',
    label: '上方提示',
    side: 'top',
    style: { left: '50%', bottom: 20, transform: 'translateX(-50%)' },
  },
  {
    id: 'bottom',
    label: '下方提示',
    side: 'bottom',
    style: { left: '50%', top: 20, transform: 'translateX(-50%)' },
  },
  {
    id: 'left',
    label: '左侧提示',
    side: 'left',
    style: { right: 20, top: '50%', transform: 'translateY(-50%)' },
  },
  {
    id: 'right',
    label: '右侧提示',
    side: 'right',
    style: { left: 20, top: '50%', transform: 'translateY(-50%)' },
  },
  {
    id: 'flip-top',
    label: '顶部翻转提示',
    side: 'top',
    style: { left: '25%', top: 4 },
  },
  {
    id: 'flip-bottom',
    label: '底部翻转提示',
    side: 'bottom',
    style: { left: '75%', bottom: 4 },
  },
  {
    id: 'flip-left',
    label: '左侧翻转提示',
    side: 'left',
    style: { left: 4, top: '70%' },
  },
  {
    id: 'flip-right',
    label: '右侧翻转提示',
    side: 'right',
    style: { right: 4, top: '70%' },
  },
]

function TooltipFixture() {
  return (
    <TooltipProvider>
      {cases.map((item) => (
        <Tooltip key={item.id}>
          <TooltipTrigger
            data-testid={`tooltip-trigger-${item.id}`}
            aria-label={item.label}
            className="fixed rounded-md border bg-background px-3 py-2 text-sm"
            style={item.style}
          >
            {item.label}
          </TooltipTrigger>
          {/* 本地修正：与生产调用处一致隐藏官方直系 Arrow，保持弹层无尖角。 */}
          <TooltipContent side={item.side} className="[&>[aria-hidden=true]]:hidden">
            <span data-testid={`tooltip-text-${item.id}`}>{item.label}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </TooltipProvider>
  )
}

const params = new URLSearchParams(window.location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const root = document.getElementById('root')
if (!root) throw new Error('Tooltip 夹具缺少根节点')
createRoot(root).render(<TooltipFixture />)
