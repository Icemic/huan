/**
 * 消息区压缩状态行：所有手动入口与自动压缩共用。
 *
 * 状态来自服务端 compaction 快照/事件；成功摘要沿用 Pi 既有 compaction entry，
 * 展开内容仍由该 entry 提供。这里不保存结果，也不向其他提示通道复制。
 */

import type { HarnessCompactionPhase } from '@huan/protocol'
import { errorText } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, XCircleIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { useRuntimeStore } from '@/state/app-context'

export interface CompactionSummaryView {
  summary: string
  tokensBefore?: number
}

const plainRowClass = 'text-muted-foreground flex items-center gap-2 text-xs'

/** 单行终态/进行中状态；成功在摘要存在时可展开 Pi 原文。 */
export function CompactionStatusRow({
  phase,
  summary,
  threadId,
}: {
  phase: HarnessCompactionPhase
  summary: CompactionSummaryView | undefined
  threadId: string | undefined
}) {
  const abortThreadCompaction = useRuntimeStore((state) => state.abortThreadCompaction)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | undefined>(undefined)

  if (phase.active) {
    return (
      <div
        data-slot="huan-compaction-status"
        data-status="running"
        role="status"
        className="flex min-h-8 items-center gap-2 text-xs"
      >
        <Loader2Icon aria-hidden className="text-muted-foreground size-3.5 animate-spin" />
        <span>
          <Trans>正在压缩上下文…</Trans>
        </span>
        {threadId ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={cancelling}
            data-slot="huan-compaction-cancel"
            onClick={() => {
              setCancelling(true)
              setCancelError(undefined)
              void abortThreadCompaction(threadId)
                .catch((error) => setCancelError(errorText(error)))
                .finally(() => setCancelling(false))
            }}
          >
            {cancelling ? <Loader2Icon aria-hidden className="size-3 animate-spin" /> : null}
            <Trans>取消压缩</Trans>
          </Button>
        ) : null}
        {cancelError ? <span className="text-destructive">{cancelError}</span> : null}
      </div>
    )
  }

  if (phase.status === 'compacted') {
    if (!summary) {
      return (
        <div
          data-slot="huan-compaction-status"
          data-status="compacted"
          role="status"
          className={plainRowClass}
        >
          <CheckCircle2Icon aria-hidden className="size-3.5" />
          <span>
            <Trans>上下文已压缩</Trans>
          </span>
        </div>
      )
    }
    return (
      <Trace data-slot="huan-compaction-status" data-status="compacted" className="my-2">
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine className="text-xs">
              <TraceIcon>
                <CheckCircle2Icon />
              </TraceIcon>
              <TraceTitle>
                <Trans>上下文已压缩</Trans>
                {summary.tokensBefore !== undefined ? (
                  <span className="text-muted-foreground/70">
                    {' '}
                    · <Trans>压缩前约 {summary.tokensBefore} tokens</Trans>
                  </span>
                ) : null}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <div className="text-xs whitespace-pre-wrap">{summary.summary}</div>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    )
  }

  if (phase.status === 'cancelled') {
    return (
      <div
        data-slot="huan-compaction-status"
        data-status="cancelled"
        role="status"
        className={plainRowClass}
      >
        <XCircleIcon aria-hidden className="size-3.5" />
        <span>
          <Trans>压缩已取消</Trans>
        </span>
      </div>
    )
  }

  if (phase.status !== 'failed') return null

  return (
    <div
      data-slot="huan-compaction-status"
      data-status="failed"
      role="status"
      className="text-destructive flex min-w-0 items-start gap-2 text-xs"
    >
      <AlertCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap">
        <Trans>压缩失败</Trans>
        {phase.error ? `：${phase.error}` : null}
      </span>
    </div>
  )
}
