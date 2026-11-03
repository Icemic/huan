import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { cn } from 'cn'
import { ScrollBar } from './scroll-area'

/**
 * Base UI Menu 基础封装。
 * 视觉沿用 Select 弹层的紧凑尺度；条目由调用方决定语义与禁用状态。
 */
const Menu = MenuPrimitive.Root

function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />
}

function MenuContent({
  className,
  children,
  side = 'bottom',
  align = 'end',
  sideOffset = 4,
  alignOffset = 0,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            'bg-popover text-popover-foreground relative isolate z-50 flex max-h-(--available-height) min-w-40 origin-(--transform-origin) flex-col overflow-hidden rounded-lg p-1 shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        >
          {/* Popup 保留菜单弹层与过渡状态；ScrollArea 负责实际滚动，
              两者分层避免过渡状态与滚动状态落在同一元素上。 */}
          <ScrollAreaPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col rounded-[inherit]">
            {/* List 直接渲染成 Viewport：菜单语义、键盘导航和滚动跟随都以 listElement 为准。 */}
            <MenuPrimitive.List
              render={
                <ScrollAreaPrimitive.Viewport
                  data-slot="menu-viewport"
                  // 两个原语都管理overflow；统一使用长属性，避免默认缩写冲突。
                  style={{ overflow: undefined, overflowX: 'hidden', overflowY: 'auto' }}
                  className="w-full flex-1 min-h-0 min-w-0 rounded-[inherit] overscroll-contain outline-none"
                />
              }
            >
              <ScrollAreaPrimitive.Content style={{ minWidth: 0 }}>
                {children}
              </ScrollAreaPrimitive.Content>
            </MenuPrimitive.List>
            <ScrollBar />
          </ScrollAreaPrimitive.Root>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        'relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm whitespace-nowrap outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    />
  )
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger }
