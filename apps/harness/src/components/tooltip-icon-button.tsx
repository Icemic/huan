'use client'

import { type ComponentPropsWithRef, forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** 图标按钮 + Base UI Tooltip；触发器通过 render 复用同一个 Button 节点。 */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  (
    {
      children,
      tooltip,
      side = 'bottom',
      className,
      variant = 'ghost',
      size = 'icon-xs',
      type = 'button',
      ...rest
    },
    ref,
  ) => {
    return (
      <Tooltip>
        <TooltipTrigger
          delay={0}
          render={
            <Button
              variant={variant}
              size={size}
              type={type}
              {...rest}
              className={cn('p-1 active:scale-90', className)}
              ref={ref}
            >
              {children}
              <span className="sr-only">{tooltip}</span>
            </Button>
          }
        />
        {/* 本地修正：官方旋转方块箭头会压到文字区域，调用处隐藏直系 Arrow，不改上游源码。 */}
        <TooltipContent side={side} className="[&>[aria-hidden=true]]:hidden">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    )
  },
)

TooltipIconButton.displayName = 'TooltipIconButton'
