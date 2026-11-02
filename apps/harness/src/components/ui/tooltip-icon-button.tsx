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
  ({ children, tooltip, side = 'bottom', className, ...rest }, ref) => {
    return (
      <Tooltip>
        <TooltipTrigger
          delay={0}
          render={
            <Button
              variant="ghost"
              size="icon"
              type="button"
              {...rest}
              className={cn('size-6 p-1 active:scale-90', className)}
              ref={ref}
            >
              {children}
              <span className="sr-only">{tooltip}</span>
            </Button>
          }
        />
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    )
  },
)

TooltipIconButton.displayName = 'TooltipIconButton'
