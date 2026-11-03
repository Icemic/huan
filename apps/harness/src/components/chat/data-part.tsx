/**
 * 运行期数据消息的展示：Shell 历史、压缩/分支摘要、扩展自定义与未知数据。
 *
 * 未知数据始终以可读 JSON 回退，不因缺少专用 renderer 丢掉整条记录。
 */

import type { HarnessDataViewPart } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { CheckIcon, CopyIcon, TerminalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function BashExecutionPart({ part }: { part: HarnessDataViewPart }) {
  const data = part.data
  const command = asText(data.command)
  const output = asText(data.output)
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : undefined
  const cancelled = data.cancelled === true
  const excludeFromContext = data.excludeFromContext === true
  const truncated = data.truncated === true
  const fullOutputPath = asText(data.fullOutputPath)
  const { isCopied, copyToClipboard } = useCopyToClipboard()

  return (
    <Trace data-slot="huan-bash-message" className="my-2">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={cancelled ? 'error' : undefined}
            className="text-xs"
            data-slot="huan-bash-trigger"
          >
            <TraceIcon>
              <TerminalIcon />
            </TraceIcon>
            <TraceTitle className="font-mono">{command || 'Shell'}</TraceTitle>
            <span className="text-muted-foreground/70 shrink-0 text-[11px]">
              {excludeFromContext ? <Trans>不进入上下文</Trans> : null}
              {excludeFromContext ? ' · ' : null}
              {cancelled ? (
                <Trans>已取消</Trans>
              ) : exitCode !== undefined ? (
                <Trans>退出码 {exitCode}</Trans>
              ) : (
                <Trans>退出码未知</Trans>
              )}
              {truncated ? ' · 已截断' : ''}
            </span>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {output ? (
            <CodeBlock size="sm" className="bg-background/60">
              <CodeBlockContent className="max-h-64">{output}</CodeBlockContent>
            </CodeBlock>
          ) : (
            <p className="text-xs">
              <Trans>没有可读输出。</Trans>
            </p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              aria-label="复制 Shell 输出"
              onClick={() => copyToClipboard(output)}
            >
              {isCopied ? (
                <CheckIcon aria-hidden className="size-3" />
              ) : (
                <CopyIcon aria-hidden className="size-3" />
              )}
              <Trans>复制输出</Trans>
            </button>
            {fullOutputPath ? (
              <span className="text-muted-foreground truncate text-[11px]">
                <Trans>完整输出：{fullOutputPath}</Trans>
              </span>
            ) : null}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

function SummaryPart({
  part,
  title,
  slot,
  children,
}: {
  part: HarnessDataViewPart
  title: ReactNode
  slot: string
  children?: ReactNode
}) {
  return (
    <Trace data-slot={slot} className="my-2">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine className="text-xs">
            <TraceTitle>{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {children ?? <div className="whitespace-pre-wrap text-xs">{safeJson(part.data)}</div>}
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
            <span className="text-muted-foreground/70"> · 压缩前约 {tokensBefore} tokens</span>
          ) : null}
        </>
      }
    >
      <div className="text-xs whitespace-pre-wrap">{summary}</div>
    </SummaryPart>
  )
}

function BranchSummaryPart({ part }: { part: HarnessDataViewPart }) {
  return (
    <SummaryPart part={part} slot="huan-branch-summary" title={<Trans>分支摘要</Trans>}>
      <div className="text-xs whitespace-pre-wrap">{asText(part.data.summary)}</div>
    </SummaryPart>
  )
}

function CustomMessagePart({ part }: { part: HarnessDataViewPart }) {
  const customType = asText(part.data.customType)
  return (
    <SummaryPart
      part={part}
      slot="huan-custom-message"
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
        <CodeBlockContent className="max-h-64">{safeJson(part.data)}</CodeBlockContent>
      </CodeBlock>
    </div>
  )
}

/** 按数据名分派；没有专用 renderer 时回退为可读 JSON。 */
export function DataPart({ part }: { part: HarnessDataViewPart }) {
  switch (part.name) {
    case 'pi-bash-execution':
      return <BashExecutionPart part={part} />
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
