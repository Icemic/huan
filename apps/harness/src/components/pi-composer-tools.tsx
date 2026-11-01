/**
 * 输入区附加 UI：命令/文件补全、队列、长输入、命令面板与提示。
 *
 * 全部使用现有 Base UI 对话框/按钮与原生可访问角色；不引入 Radix/cmdk。
 */
import { useAuiState } from '@assistant-ui/react'
import { Trans } from '@lingui/react/macro'
import {
  ArrowUpIcon,
  AtSignIcon,
  CheckIcon,
  ChevronUpIcon,
  Maximize2Icon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button'
import {
  type AppCommand,
  commandSourceLabel,
  commandStageLabel,
} from '@/components/pi-builtin-commands'
import type { PiComposerController } from '@/components/pi-composer-controller'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/** 队列展示：标注 steer/follow-up，并支持整体取回。 */
export function ComposerQueue({ controller }: { controller: PiComposerController }) {
  const { steering, followUp } = controller.queue
  if (steering.length === 0 && followUp.length === 0) return null
  return (
    <div data-slot="huan-composer-queue" className="mb-1 flex flex-col gap-1">
      {steering.map((content, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 队列只暴露文本，无稳定条目 ID
          key={`steer:${index}`}
          className="border-foreground/10 text-muted-foreground flex items-start gap-2 rounded-(--composer-radius) border border-dashed px-3 py-1.5 text-sm"
        >
          <span className="rounded bg-muted px-1 text-[10px] leading-5">
            <Trans>转向</Trans>
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{content}</span>
        </div>
      ))}
      {followUp.map((content, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: 队列只暴露文本，无稳定条目 ID
          key={`follow:${index}`}
          className="border-foreground/10 text-muted-foreground flex items-start gap-2 rounded-(--composer-radius) border border-dashed px-3 py-1.5 text-sm"
        >
          <span className="rounded bg-muted px-1 text-[10px] leading-5">
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
          onClick={() => void controller.retrieveQueue()}
        >
          <ChevronUpIcon aria-hidden className="size-3" />
          <Trans>取回全部</Trans>
        </Button>
      </div>
    </div>
  )
}

/** 输入上方的补全列表（role=listbox，键盘由输入框处理）。 */
export function ComposerCompletionMenu({ controller }: { controller: PiComposerController }) {
  const completion = controller.completion
  if (!completion || completion.items.length === 0) return null
  return (
    <div
      data-slot="huan-composer-completions"
      role="listbox"
      aria-label={
        completion.kind === 'file'
          ? '文件引用补全'
          : completion.kind === 'argument'
            ? '命令参数补全'
            : '命令补全'
      }
      className="border-foreground/10 bg-popover text-popover-foreground mb-1 max-h-64 overflow-y-auto rounded-(--composer-radius) border p-1 shadow-sm"
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
          onClick={() => controller.chooseCompletion(item)}
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
  )
}

/** 输入区提示（命令不可用、图片拒绝、操作失败等）。 */
export function ComposerNotice({ controller }: { controller: PiComposerController }) {
  if (!controller.notice) return null
  return (
    <div
      role="status"
      data-slot="huan-composer-notice"
      className="border-foreground/10 text-muted-foreground mx-1 flex items-start gap-2 border-t px-1 pt-1 text-xs whitespace-pre-wrap"
    >
      <span className="flex-1">{controller.notice}</span>
      <button
        type="button"
        aria-label="关闭输入提示"
        className="text-muted-foreground hover:text-foreground"
        onClick={controller.clearNotice}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  )
}

/** 左侧工具按钮：命令面板与 @ 文件引用。 */
export function ComposerTools({ controller }: { controller: PiComposerController }) {
  return (
    <>
      <TooltipIconButton
        tooltip="命令"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-full"
        aria-label="打开命令面板"
        onClick={controller.openPalette}
      >
        <SquareTerminalIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="引用文件"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-full"
        aria-label="插入文件引用"
        onClick={controller.insertMention}
      >
        <AtSignIcon className="size-4" />
      </TooltipIconButton>
    </>
  )
}

/** 运行中显式选择排队语义。 */
export function ComposerQueueMode({ controller }: { controller: PiComposerController }) {
  if (!controller.isRunning) return null
  return (
    <fieldset
      data-slot="huan-composer-queue-mode"
      aria-label="运行中发送方式"
      className="flex items-center rounded-full border p-0.5 text-[11px]"
    >
      <button
        type="button"
        aria-pressed={controller.queueMode === 'followUp'}
        className={cn(
          'rounded-full px-1.5 py-0.5',
          controller.queueMode === 'followUp' ? 'bg-accent text-accent-foreground' : '',
        )}
        onClick={() => controller.setQueueMode('followUp')}
      >
        <Trans>后续</Trans>
      </button>
      <button
        type="button"
        aria-pressed={controller.queueMode === 'steer'}
        className={cn(
          'rounded-full px-1.5 py-0.5',
          controller.queueMode === 'steer' ? 'bg-accent text-accent-foreground' : '',
        )}
        onClick={() => controller.setQueueMode('steer')}
      >
        <Trans>转向</Trans>
      </button>
    </fieldset>
  )
}

/** 自定义发送按钮：保留队列模式并统一走命令路由。 */
export function ComposerSendButton({ controller }: { controller: PiComposerController }) {
  const canSend = useAuiState((state) => state.composer.canSend)
  return (
    <TooltipIconButton
      tooltip={controller.isRunning && controller.queueMode === 'steer' ? '转向发送' : '发送消息'}
      side="bottom"
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-send size-7 rounded-full"
      aria-label="Send message"
      disabled={!canSend || controller.busy !== undefined}
      onClick={() => void controller.submit()}
    >
      <ArrowUpIcon className="size-4" />
    </TooltipIconButton>
  )
}

/** 展开长输入编辑。 */
export function ComposerExpandButton({ controller }: { controller: PiComposerController }) {
  return (
    <TooltipIconButton
      tooltip="展开编辑"
      side="bottom"
      type="button"
      variant="ghost"
      size="icon"
      className="text-muted-foreground size-7 rounded-full"
      aria-label="展开编辑长输入"
      onClick={() => {
        controller.setLongInputText(controller.text)
        controller.setLongInputOpen(true)
      }}
    >
      <Maximize2Icon className="size-3.5" />
    </TooltipIconButton>
  )
}

/** 命令面板：可搜索、可键盘选择，插入到当前光标位置。 */
function CommandPaletteDialog({ controller }: { controller: PiComposerController }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!controller.paletteOpen) return
    setQuery('')
    setIndex(0)
  }, [controller.paletteOpen])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return controller.catalog.filter(
      (command) =>
        !needle ||
        command.name.toLowerCase().includes(needle) ||
        (command.description ?? '').toLowerCase().includes(needle),
    )
  }, [controller.catalog, query])
  useEffect(() => {
    if (index >= filtered.length) setIndex(0)
  }, [filtered.length, index])

  const choose = (command: AppCommand | undefined) => {
    if (!command) return
    controller.insertCommandFromPalette(command)
  }

  return (
    <Dialog open={controller.paletteOpen} onOpenChange={controller.setPaletteOpen}>
      <DialogContent data-slot="huan-command-palette" aria-label="命令面板" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>命令面板</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              内置命令优先；扩展、模板与 Skill
              由宿主目录提供。未实施的内置命令只显示阶段与原因，不会发送给模型。
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="搜索命令"
          placeholder="搜索命令或说明"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((current) => (filtered.length ? (current + 1) % filtered.length : 0))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((current) =>
                filtered.length ? (current - 1 + filtered.length) % filtered.length : 0,
              )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              choose(filtered[index])
            }
          }}
        />
        <div
          role="listbox"
          aria-label="命令列表"
          className="max-h-[50dvh] overflow-y-auto rounded-md border p-1"
        >
          {filtered.length === 0 ? (
            <p className="text-muted-foreground p-2 text-sm">
              <Trans>没有匹配的命令。</Trans>
            </p>
          ) : (
            filtered.map((command, itemIndex) => (
              <button
                key={`${command.source}:${command.name}`}
                type="button"
                role="option"
                aria-selected={itemIndex === index}
                className={cn(
                  'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm',
                  itemIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => choose(command)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs">
                    /{command.name}
                    {command.argumentHint ? ` ${command.argumentHint}` : ''}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {command.description}
                  </span>
                  {!command.available && command.availability && (
                    <span className="text-destructive block text-[11px]">
                      {command.availability}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {commandSourceLabel(command.source)}
                  {commandStageLabel(command.stage) ? ` · ${commandStageLabel(command.stage)}` : ''}
                </span>
              </button>
            ))
          )}
        </div>
        {controller.catalogDiagnostics.length > 0 && (
          <p className="text-muted-foreground text-[11px] whitespace-pre-wrap">
            {controller.catalogDiagnostics.join('\n')}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => controller.setPaletteOpen(false)}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 长输入编辑：Esc/取消保留原草稿，确认才写回。 */
function LongInputDialog({ controller }: { controller: PiComposerController }) {
  return (
    <Dialog open={controller.longInputOpen} onOpenChange={controller.setLongInputOpen}>
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
          value={controller.longInputText}
          onChange={(event) => controller.setLongInputText(event.target.value)}
          className="min-h-48"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => controller.setLongInputOpen(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button onClick={controller.applyLongInput}>
            <CheckIcon aria-hidden className="size-4" />
            <Trans>应用</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 挂在输入区一次即可的弹层宿主。 */
export function PiComposerDialogs({ controller }: { controller: PiComposerController }) {
  return (
    <>
      <CommandPaletteDialog controller={controller} />
      <LongInputDialog controller={controller} />
    </>
  )
}
