/**
 * 运行期数据消息的展示：压缩/分支摘要、扩展自定义与未知数据。
 *
 * 用户 Shell（`pi-bash-execution`）在消息分派处使用专门的右对齐组合，
 * 不再走这里的通用数据回退。未知数据始终以可读 JSON 回退，不因缺少专用
 * renderer 丢掉整条记录。
 */

import type { HarnessDataViewPart } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { HighlightedCodeContent } from './highlighted-code'

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function SummaryPart({
  part,
  title,
  slot,
  compact = false,
  children,
}: {
  part: HarnessDataViewPart
  title: ReactNode
  slot: string
  /** 扩展消息维持原 12px 通用回退；压缩/分支摘要使用正文 14px。 */
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <Trace data-slot={slot} className="my-2">
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="gap-2">
          <TraceLine className={compact ? 'min-h-7 text-xs' : 'min-h-7'}>
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {children ?? (
            <div
              className={
                compact
                  ? 'text-xs whitespace-pre-wrap'
                  : 'text-sm leading-[22px] whitespace-pre-wrap'
              }
            >
              {safeJson(part.data)}
            </div>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

function CompactionSummaryPart({ part }: { part: HarnessDataViewPart }) {
  const summary = asText(part.data.summary)
  const tokensBefore =
    typeof part.data.tokensBefore === 'number' ? part.data.tokensBefore : undefined
  return (
    <SummaryPart
      part={part}
      slot="huan-compaction-summary"
      title={
        <>
          <Trans>上下文已压缩</Trans>
          {tokensBefore !== undefined ? (
            <span className="text-muted-foreground/70 text-xs leading-[18px]">
              {' '}
              · 压缩前约 {tokensBefore} tokens
            </span>
          ) : null}
        </>
      }
    >
      <div className="text-sm leading-[22px] whitespace-pre-wrap">{summary}</div>
    </SummaryPart>
  )
}

function BranchSummaryPart({ part }: { part: HarnessDataViewPart }) {
  return (
    <SummaryPart part={part} slot="huan-branch-summary" title={<Trans>分支摘要</Trans>}>
      <div className="text-sm leading-[22px] whitespace-pre-wrap">{asText(part.data.summary)}</div>
    </SummaryPart>
  )
}

function CustomMessagePart({ part }: { part: HarnessDataViewPart }) {
  const customType = asText(part.data.customType)
  return (
    <SummaryPart
      part={part}
      slot="huan-custom-message"
      compact
      title={
        <>
          <Trans>扩展消息</Trans>
          {customType ? <span className="text-muted-foreground/70"> · {customType}</span> : null}
        </>
      }
    />
  )
}

function UnknownDataPart({ part }: { part: HarnessDataViewPart }) {
  return (
    <div data-slot="huan-unknown-data">
      <CodeBlock className="my-2" size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>{part.name}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={safeJson(part.data)} />
          </CodeBlockActions>
        </CodeBlockHeader>
        <ScrollArea className="min-w-0 data-has-overflow-x:pb-2.5 *:data-[slot=scroll-area-viewport]:max-h-64">
          <HighlightedCodeContent value={safeJson(part.data)} language="json" />
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </CodeBlock>
    </div>
  )
}

/** 按数据名分派；没有专用 renderer 时回退为可读 JSON。 */
export function DataPart({ part }: { part: HarnessDataViewPart }) {
  switch (part.name) {
    case 'pi-compaction-summary':
      return <CompactionSummaryPart part={part} />
    case 'pi-branch-summary':
      return <BranchSummaryPart part={part} />
    case 'pi-custom-message':
      return <CustomMessagePart part={part} />
    default:
      return <UnknownDataPart part={part} />
  }
}
