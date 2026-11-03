"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "cn"

/**
 * shadcn base-nova separator 官方源码。
 * 方向选择器改为显式 data-[orientation=...]：本仓库未引入 shadcn 的全局 tailwind.css 变体。
 */

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
