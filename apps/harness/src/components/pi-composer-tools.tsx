/**
 * 输入区附加 UI：命令/文件补全、队列、长输入与提示。
 *
 * 所有状态读取自 composer feature store；输入文字、附件、队列和提交都不在此复制。
 */

import { Trans } from '@lingui/react/macro'
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronUpIcon,
  Maximize2Icon,
  SquareIcon,
  XIcon,
} from 'lucide-react'
import { memo, type RefObject } from 'react'
import { TooltipIconButton } from '@/components/tooltip-icon-button'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useComposerStore } from '@/state/app-context'
import type { ComposerCompletionItem } from '@/state/composer-store'

/** 把焦点与光标放到输入框指定位置。 */
export const focusTextareaAt = (
  inputRef: RefObject<HTMLTextAreaElement | null>,
  position: number,
): void => {
  // 等待本次 React 提交即可；延迟到下一帧会移动后来输入的光标，甚至打断填入。
  queueMicrotask(() => {
    const element = inputRef.current
    if (!element?.isConnected) return
    element.focus()
    const caret = Math.min(Math.max(position, 0), element.value.length)
    element.setSelectionRange(caret, caret)
  })
}

/** 服务端队列：只呈现权威 steering/followUp，并提供整体取回。 */
export const ComposerQueue = memo(function ComposerQueue({
  queue,
  onRetrieve,
}: {
  queue: { steering: readonly string[]; followUp: readonly string[] }
  onRetrieve: () => Promise<void>
}) {
  const { steering, followUp } = queue
  if (steering.length === 0 && followUp.length === 0) return null
  return (
    <div data-slot="huan-composer-queue" className="mb-1 flex flex-col gap-1">
      {steering.map((content, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 服务端队列只暴露文本，无稳定条目 ID
          key={`steer:${index}`}
          className="border-foreground/10 text-muted-foreground flex items-start gap-2 rounded-md border border-dashed px-3 py-1.5 text-sm"
        >
          <span className="bg-muted rounded px-1 text-[10px] leading-5">
            <Trans>转向</Trans>
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{content}</span>
        </div>
      ))}
      {followUp.map((content, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 服务端队列只暴露文本，无稳定条目 ID
          key={`follow:${index}`}
          className="border-foreground/10 text-muted-foreground flex items-start gap-2 rounded-md border border-dashed px-3 py-1.5 text-sm"
        >
          <span className="bg-muted rounded px-1 text-[10px] leading-5">
            <Trans>后续</Trans>
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{content}</span>
        </div>
      ))}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-slot="huan-queue-retrieve"
          onClick={() => void onRetrieve()}
        >
          <ChevronUpIcon aria-hidden className="size-3" />
          <Trans>取回全部</Trans>
        </Button>
      </div>
    </div>
  )
})

/** 输入上方的补全列表（role=listbox，键盘由输入框处理）。 */
export function ComposerCompletionMenu({
  inputRef,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const completion = useComposerStore((state) => state.completion)
  const chooseCompletion = useComposerStore((state) => state.chooseCompletion)
  if (!completion || completion.items.length === 0) return null
  const apply = (item: ComposerCompletionItem) => {
    const caret = chooseCompletion(item)
    if (caret !== undefined) focusTextareaAt(inputRef, caret)
  }
  return (
    <ScrollArea
      data-slot="huan-composer-completions"
      className={cn(
        'bg-popover text-popover-foreground mb-1 rounded-md border shadow-sm',
        '*:data-[slot=scroll-area-viewport]:max-h-64',
      )}
    >
      <div
        role="listbox"
        aria-label={
          completion.kind === 'file'
            ? '文件引用补全'
            : completion.kind === 'argument'
              ? '命令参数补全'
              : '命令补全'
        }
        className="p-1"
      >
        {completion.items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={index === completion.index}
            data-slot="huan-composer-completion"
            className={cn(
              'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm',
              index === completion.index ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply(item)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs">{item.label}</span>
              {item.description && (
                <span className="text-muted-foreground block truncate text-[11px]">
                  {item.description}
                </span>
              )}
            </span>
            {item.meta && (
              <span className="text-muted-foreground shrink-0 text-[10px]">{item.meta}</span>
            )}
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}

/** 输入区提示（命令不可用、图片拒绝、操作失败等）。 */
export function ComposerNotice() {
  const notice = useComposerStore((state) => state.notice)
  const clearNotice = useComposerStore((state) => state.clearNotice)
  if (!notice) return null
  return (
    <div
      role="status"
      data-slot="huan-composer-notice"
      className="border-foreground/10 text-muted-foreground mx-1 flex items-start gap-2 border-t px-1 pt-1 text-xs whitespace-pre-wrap"
    >
      <span className="flex-1">{notice}</span>
      <button
        type="button"
        aria-label="关闭输入提示"
        className="text-muted-foreground hover:text-foreground"
        onClick={clearNotice}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  )
}

/** 运行中显式选择排队语义。 */
export const ComposerQueueMode = memo(function ComposerQueueMode({
  isRunning,
  queueMode,
  onQueueModeChange,
}: {
  isRunning: boolean
  queueMode: 'followUp' | 'steer'
  onQueueModeChange: (mode: 'followUp' | 'steer') => void
}) {
  if (!isRunning) return null
  return (
    <fieldset
      data-slot="huan-composer-queue-mode"
      aria-label="运行中发送方式"
      className="flex items-center rounded-full border p-0.5 text-[11px]"
    >
      <button
        type="button"
        aria-pressed={queueMode === 'followUp'}
        className={cn(
          'rounded-full px-1.5 py-0.5',
          queueMode === 'followUp' ? 'bg-accent text-accent-foreground' : '',
        )}
        onClick={() => onQueueModeChange('followUp')}
      >
        <Trans>后续</Trans>
      </button>
      <button
        type="button"
        aria-pressed={queueMode === 'steer'}
        className={cn(
          'rounded-full px-1.5 py-0.5',
          queueMode === 'steer' ? 'bg-accent text-accent-foreground' : '',
        )}
        onClick={() => onQueueModeChange('steer')}
      >
        <Trans>转向</Trans>
      </button>
    </fieldset>
  )
})

/** 发送按钮：队列模式由 store 决定，点击统一走命令路由。 */
export const ComposerSendButton = memo(function ComposerSendButton({
  isRunning,
  queueMode,
  busy,
  canSend,
  onSubmit,
}: {
  isRunning: boolean
  queueMode: 'followUp' | 'steer'
  busy: boolean
  canSend: boolean
  onSubmit: () => Promise<void>
}) {
  return (
    <TooltipIconButton
      tooltip={isRunning && queueMode === 'steer' ? '转向发送' : '发送消息'}
      side="bottom"
      type="button"
      variant="default"
      size="icon-sm"
      aria-label="发送消息"
      disabled={!canSend || busy}
      onClick={() => void onSubmit()}
    >
      <ArrowUpIcon aria-hidden />
    </TooltipIconButton>
  )
})

/** 运行中停止当前会话。 */
export const ComposerStopButton = memo(function ComposerStopButton({
  busy,
  onStop,
}: {
  busy: boolean
  onStop: () => Promise<void>
}) {
  return (
    <TooltipIconButton
      tooltip="停止运行"
      side="bottom"
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="停止当前运行"
      disabled={busy}
      onClick={() => void onStop()}
    >
      <SquareIcon aria-hidden />
    </TooltipIconButton>
  )
})

/** 展开长输入编辑。 */
export const ComposerExpandButton = memo(function ComposerExpandButton({
  onExpand,
}: {
  onExpand: () => void
}) {
  return (
    <TooltipIconButton
      tooltip="展开编辑"
      side="bottom"
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="展开编辑长输入"
      onClick={onExpand}
    >
      <Maximize2Icon aria-hidden />
    </TooltipIconButton>
  )
})

/** 长输入编辑：Esc/取消保留原草稿，确认才写回。 */
function LongInputDialog({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const longInput = useComposerStore((state) => state.longInput)
  const setText = useComposerStore((state) => state.setLongInputText)
  const apply = useComposerStore((state) => state.applyLongInput)
  const close = useComposerStore((state) => state.closeLongInput)
  return (
    <Dialog
      open={longInput !== undefined}
      onOpenChange={(next) => {
        if (next) return
        close()
        focusTextareaAt(inputRef, inputRef.current?.value.length ?? 0)
      }}
    >
      <DialogContent data-slot="huan-long-input" aria-label="长输入编辑" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>展开编辑输入</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>取消或按 Esc 不会修改输入框中的原草稿。</Trans>
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="长输入内容"
          autoFocus
          rows={12}
          value={longInput?.text ?? ''}
          onChange={(event) => setText(event.target.value)}
          className="min-h-48"
        />
        {longInput?.conflict ? (
          <p role="alert" className="text-destructive text-xs">
            {longInput.conflict}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            <Trans>取消</Trans>
          </Button>
          <Button
            onClick={() => {
              if (apply()) focusTextareaAt(inputRef, inputRef.current?.value.length ?? 0)
            }}
          >
            <CheckIcon aria-hidden className="size-4" />
            <Trans>应用</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 挂在输入区一次即可的弹层宿主。 */
export function PiComposerDialogs({
  inputRef,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  return <LongInputDialog inputRef={inputRef} />
}
