"use client"

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "cn"

/**
 * 来源：shadcn base-nova scroll-area registry（MIT）。
 * 本地适配：flex高度约束、Viewport/Content属性、双向轨道；悬浮细轨沿用聊天区token。
 * 非横向模式覆盖Content默认fit-content，保留换行且避免长内容撑宽布局。
 */

/** 轨道方向：只纵向、只横向，或两个方向都显示（含右下交汇角）。 */
type ScrollAreaOrientation = "vertical" | "horizontal" | "both"

function ScrollArea({
  className,
  children,
  viewportProps,
  contentProps,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  /** 视口属性：className 与内置样式合并，ref / onScroll / aria-* 等原样透传。 */
  viewportProps?: ScrollAreaPrimitive.Viewport.Props
  /** 内容层属性：业务 flex / grid 布局与间距写在这里。 */
  contentProps?: ScrollAreaPrimitive.Content.Props
  /** 显示哪些方向的轨道，默认仅纵向。 */
  orientation?: ScrollAreaOrientation
}) {
  const { className: viewportClassName, ...viewportRest } = viewportProps ?? {}
  const { className: contentClassName, style: contentStyle, ...contentRest } = contentProps ?? {}

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      // 纵向 flex 让 Viewport 吃掉剩余高度；min-h-0 / min-w-0 允许在受限高度里继续收缩。
      className={cn("relative flex min-h-0 min-w-0 flex-col", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        {...viewportRest}
        className={cn(
          "w-full flex-1 min-h-0 min-w-0 rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName
        )}
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          {...contentRest}
          className={contentClassName}
          style={
            // 横向内容可随内容扩展，其余模式按可用宽度换行。
            orientation !== "horizontal" ? { minWidth: 0, ...contentStyle } : contentStyle
          }
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {orientation === "vertical" || orientation === "both" ? <ScrollBar /> : null}
      {orientation === "horizontal" || orientation === "both" ? (
        <ScrollBar orientation="horizontal" />
      ) : null}
      {/* 双向滚动时补上 Base UI 的交汇角，竖轨底端会为它让出高度。 */}
      {orientation === "both" ? <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" /> : null}
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        // Base UI 已给轨道绝对定位与起始/结束内缩，这里只补粗细与悬浮留白。
        "rounded-full bg-foreground/5 hover:bg-foreground/10",
        "data-[orientation=vertical]:my-1 data-[orientation=vertical]:me-1 data-[orientation=vertical]:w-2",
        "data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-1 data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="flex-1 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/35"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar, type ScrollAreaOrientation }
