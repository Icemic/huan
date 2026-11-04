/**
 * 用户 Shell 消息：`!` / `!!` 的持久历史。
 *
 * 与 Agent bash 使用同一套命令/输出内容块，但整组右对齐、收起标题使用
 * 用户消息的 muted 底色，用位置与表面样式表达来源。这里不提供消息复制/
 * 下载栏，也不新增分叉等不适用动作；命令复制不包含提示符。
 */

import type { HarnessDataViewPart, HarnessMessageView } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { ListXIcon, TerminalIcon } from 'lucide-react'
import { Message } from '@/components/ui/message'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
} from '@/components/ui/trace'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/state/app-context'
import { partOpenOf } from '@/state/chat-store'
import { CommandBlock, OutputBlock, ShellOutputInfo } from './content-block'
import {
  commandSummaryOf,
  isShellFailureExit,
  isShellSuccessExit,
  shellExitLabelOf,
} from './tool-presentation'

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 只把完整、独立的数据消息识别为用户 Shell，不猜测混合消息。 */
export const userShellDataPartOf = (view: HarnessMessageView): HarnessDataViewPart | undefined => {
  const part = view.parts[0]
  return view.parts.length === 1 && part?.type === 'data' && part.name === 'pi-bash-execution'
    ? part
    : undefined
}

export function UserShellMessage({
  view,
  part,
  threadId,
}: {
  view: HarnessMessageView
  part: HarnessDataViewPart
  threadId: string | undefined
}) {
  const command = asText(part.data.command)
  const output = asText(part.data.output)
  const exitCode = typeof part.data.exitCode === 'number' ? part.data.exitCode : undefined
  const cancelled = part.data.cancelled === true
  const excludeFromContext = part.data.excludeFromContext === true
  const truncated = part.data.truncated === true
  const fullOutputPath = asText(part.data.fullOutputPath)
  const failure = isShellFailureExit(exitCode, cancelled)
  const success = isShellSuccessExit(exitCode, cancelled)
  const defaultOpen = failure
  const storeKey = `${threadId ?? 'none'}:${view.id}:user-shell`
  const open = useChatStore((state) => partOpenOf(state, storeKey, defaultOpen))
  const setOpen = useChatStore((state) => state.setPartOpen)
  const prompt = excludeFromContext ? '!!' : '!'
  const summary = commandSummaryOf(command)

  return (
    <Message
      data-slot="huan-message"
      data-role="assistant"
      align="end"
      role="group"
      aria-label="用户 Shell"
    >
      <Trace data-slot="huan-bash-message" className="w-full min-w-0">
        <TraceCollapsible
          open={open}
          onOpenChange={(next) => setOpen(storeKey, next)}
          className="w-full"
        >
          <TraceCollapsibleTrigger className="bg-muted hover:bg-muted text-foreground ms-auto min-h-9 gap-2 rounded px-2.5 py-1.5 @max-[480px]/message:w-full [&>[data-slot=trace-icon]:last-child]:text-muted-foreground">
            <TraceIcon className="text-muted-foreground">
              <TerminalIcon />
            </TraceIcon>
            <span className="min-w-0 truncate font-mono">
              {prompt} {summary || 'Shell'}
            </span>
            <span
              className={cn(
                'shrink-0 text-xs leading-[18px] tabular-nums',
                failure ? 'text-destructive' : 'text-muted-foreground',
                success && 'hidden @min-[480px]/message:inline',
              )}
            >
              {shellExitLabelOf(exitCode, cancelled)}
            </span>
            {excludeFromContext ? (
              <Tooltip>
                <TooltipTrigger
                  render={<span />}
                  className="text-muted-foreground inline-flex shrink-0"
                  role="img"
                  aria-label="不进入模型上下文"
                >
                  <ListXIcon aria-hidden className="size-4" />
                </TooltipTrigger>
                <TooltipContent role="tooltip">不进入模型上下文</TooltipContent>
              </Tooltip>
            ) : null}
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-foreground mt-2 mb-0 ml-0 w-full max-w-full border-l-0 p-0">
            {open ? (
              <div className="flex w-full min-w-0 flex-col gap-2">
                <CommandBlock command={command} muted dataSlot="huan-user-shell-command" />
                <OutputBlock
                  output={output}
                  destructive={failure}
                  emptyText={<Trans>无输出</Trans>}
                  exitMeta={
                    success ? (
                      <span className="hidden @max-[480px]/message:inline">
                        <Trans>退出码 0</Trans>
                      </span>
                    ) : undefined
                  }
                  dataSlot="huan-user-shell-output"
                />
                <ShellOutputInfo
                  truncated={truncated}
                  fullOutputPath={fullOutputPath || undefined}
                />
              </div>
            ) : null}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    </Message>
  )
}
