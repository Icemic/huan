/**
 * 文件与 Shell 展示共用的内容块。
 *
 * 只组合现有 CodeBlock / ScrollArea / 图标按钮：标题统一 12px 次要文字，
 * 正文 14px 等宽，复制按钮静止隐藏并在 hover/键盘聚焦/触屏可见。复制值
 * 始终是原始字符串，空字符串也允许复制。
 */

import { Trans } from '@lingui/react/macro'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TooltipIconButton } from '@/components/tooltip-icon-button'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 24px ghost 复制按钮；空字符串也调用剪贴板。 */
export function CopyIconButton({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <TooltipIconButton
      tooltip={copied ? '已复制' : label}
      aria-label={copied ? '已复制' : label}
      size="icon-xs"
      className={cn('size-6 [&_svg]:size-3.5', className)}
      onClick={() => {
        if (typeof navigator === 'undefined' || !navigator.clipboard) return
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true)
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              setCopied(false)
            }, 2000)
          },
          () => {},
        )
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </TooltipIconButton>
  )
}

/** 内容块操作区：静止隐藏，hover/focus-within 与粗指针设备可见。 */
export function ContentActions({ children }: { children: ReactNode }) {
  return (
    <CodeBlockActions className="pointer-coarse:opacity-100 opacity-0 transition-opacity group-focus-within/code-block:opacity-100 group-hover/code-block:opacity-100">
      {children}
    </CodeBlockActions>
  )
}

interface ContentBlockFrameProps {
  title: ReactNode
  titleClassName?: string
  meta?: ReactNode
  actions?: ReactNode
  muted?: boolean
  destructive?: boolean
  dataSlot?: string
  className?: string
  children: ReactNode
}

/** 1px 边框、4px 圆角的内容块外壳；标题横向 8px、正文横向 12px。 */
export function ContentBlockFrame({
  title,
  titleClassName,
  meta,
  actions,
  muted = false,
  destructive = false,
  dataSlot = 'code-block',
  className,
  children,
}: ContentBlockFrameProps) {
  return (
    <CodeBlock
      variant={destructive ? 'destructive' : 'default'}
      data-slot={dataSlot}
      className={cn('rounded', muted && 'border-transparent bg-muted dark:bg-muted', className)}
    >
      <CodeBlockHeader className="min-h-8 px-2 py-1.5">
        <CodeBlockTitle
          className={cn(
            'min-w-0 flex-1 font-normal text-xs leading-[18px] text-muted-foreground',
            'group-data-[variant=destructive]/code-block:text-destructive',
            titleClassName,
          )}
        >
          {title}
        </CodeBlockTitle>
        {meta ? (
          <span
            className={cn(
              'min-w-0 text-xs leading-[18px] text-muted-foreground tabular-nums',
              destructive && 'text-destructive',
            )}
          >
            {meta}
          </span>
        ) : null}
        {actions ? <ContentActions>{actions}</ContentActions> : null}
      </CodeBlockHeader>
      {children}
    </CodeBlock>
  )
}

/** 双向滚动区：每个代码/输出区最多 40vh 或 320px。 */
export function BlockScroll({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollArea
      className={cn(
        'min-w-0 *:data-[slot=scroll-area-viewport]:max-h-[min(40vh,320px)]',
        className,
      )}
    >
      {children}
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

/** 代码正文；不显示行号时保留原文换行与缩进。 */
export function CodeText({
  value,
  emptyText,
  lineNumbers = false,
  wrap = false,
  className,
}: {
  value: string
  emptyText?: ReactNode
  lineNumbers?: boolean
  wrap?: boolean
  className?: string
}) {
  if (value.length === 0 && emptyText !== undefined) {
    return (
      <div
        className={cn(
          'text-muted-foreground px-3 pt-2 pb-3 font-mono text-sm leading-[22px]',
          className,
        )}
      >
        {emptyText}
      </div>
    )
  }
  return (
    <CodeBlockContent
      wrap={wrap}
      lineNumbers={lineNumbers}
      startLine={1}
      className={cn(
        'overflow-visible pt-2 pb-3 leading-[22px] [&_[data-slot=code-block-line]]:before:text-xs',
        className,
      )}
      style={{ maskImage: 'none' }}
    >
      {value}
    </CodeBlockContent>
  )
}

/** 命令块：Agent bash 与用户 Shell 共用；用户 Shell 使用 muted 底色。 */
export function CommandBlock({
  command,
  timeout,
  muted = false,
  dataSlot = 'huan-command-block',
}: {
  command: string
  timeout?: number
  muted?: boolean
  dataSlot?: string
}) {
  return (
    <ContentBlockFrame
      title={<Trans>命令</Trans>}
      meta={timeout === undefined ? undefined : `超时 ${timeout}s`}
      titleClassName="truncate"
      muted={muted}
      dataSlot={dataSlot}
      actions={<CopyIconButton value={command} label="复制命令" />}
    >
      <BlockScroll>
        <CodeText value={command} wrap />
      </BlockScroll>
    </ContentBlockFrame>
  )
}

/** 输出块：标题在部分结果时为“输出中”，错误只换边框与标题色。 */
export function OutputBlock({
  output,
  partial = false,
  destructive = false,
  emptyText,
  exitMeta,
  dataSlot = 'huan-output-block',
}: {
  output: string
  partial?: boolean
  destructive?: boolean
  emptyText?: ReactNode
  exitMeta?: ReactNode
  dataSlot?: string
}) {
  return (
    <ContentBlockFrame
      title={partial ? <Trans>输出中</Trans> : <Trans>输出</Trans>}
      destructive={destructive}
      meta={exitMeta}
      dataSlot={dataSlot}
      actions={<CopyIconButton value={output} label="复制输出" />}
    >
      <BlockScroll>
        <CodeText value={output} emptyText={emptyText} className="text-foreground" />
      </BlockScroll>
    </ContentBlockFrame>
  )
}

/** 截断状态与完整输出路径；路径允许换行并可单独复制。 */
export function ShellOutputInfo({
  truncated,
  fullOutputPath,
}: {
  truncated?: boolean
  fullOutputPath?: string
}) {
  if (!truncated && !fullOutputPath) return null
  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-2 text-xs leading-[18px]">
      {truncated ? (
        <span>
          <Trans>输出已截断</Trans>
        </span>
      ) : null}
      {fullOutputPath ? (
        <>
          <span className="min-w-0 font-mono break-all">{fullOutputPath}</span>
          <CopyIconButton value={fullOutputPath} label="复制完整输出路径" className="shrink-0" />
        </>
      ) : null}
    </div>
  )
}

/** 其他参数/详情：默认收起，保留可读 JSON。 */
export function JsonDetails({ label, value }: { label: ReactNode; value: unknown }) {
  const text = safeJson(value)
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground cursor-pointer">{label}</summary>
      <CodeBlock size="sm" className="mt-1 rounded">
        <BlockScroll>
          <CodeBlockContent
            wrap
            className="overflow-visible pt-2 pb-3 *:data-[slot=code-block-code]:grid-cols-[minmax(0,1fr)]"
            style={{ maskImage: 'none' }}
          >
            {text}
          </CodeBlockContent>
        </BlockScroll>
      </CodeBlock>
    </details>
  )
}
