/**
 * 消息区压缩状态行：所有手动入口与自动压缩共用。
 *
 * 状态来自服务端 compaction 快照/事件；成功摘要沿用 Pi 既有 compaction entry，
 * 展开内容仍由该 entry 提供。这里不保存结果，也不向其他提示通道复制。
 * 所有终态与运行态统一 14px 主文案、16px 图标与 28px 最小行高；普通终态
 * 不添加大面积背景，失败只使用现有 destructive 色。
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
        className="flex min-h-7 flex-col gap-1"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm leading-5">
          <Loader2Icon aria-hidden className="text-muted-foreground size-4 shrink-0 animate-spin" />
          <span className="min-w-0">
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
              {cancelling ? <Loader2Icon aria-hidden className="size-3.5 animate-spin" /> : null}
              <Trans>取消压缩</Trans>
            </Button>
          ) : null}
        </div>
        {cancelError ? (
          <p className="text-destructive min-w-0 text-sm leading-5 break-words whitespace-pre-wrap">
            {cancelError}
          </p>
        ) : null}
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
          className="text-muted-foreground flex min-h-7 items-center gap-2 text-sm leading-5"
        >
          <CheckCircle2Icon aria-hidden className="size-4 shrink-0" />
          <span>
            <Trans>上下文已压缩</Trans>
          </span>
        </div>
      )
    }
    return (
      <Trace data-slot="huan-compaction-status" data-status="compacted" className="my-2">
        <TraceCollapsible>
          <TraceCollapsibleTrigger className="gap-2">
            <TraceLine className="min-h-7">
              <TraceIcon>
                <CheckCircle2Icon />
              </TraceIcon>
              <TraceTitle>
                <Trans>上下文已压缩</Trans>
                {summary.tokensBefore !== undefined ? (
                  <span className="text-muted-foreground hidden text-xs leading-[18px] tabular-nums @min-[480px]/message:inline">
                    {' '}
                    · <Trans>压缩前约 {summary.tokensBefore} tokens</Trans>
                  </span>
                ) : null}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-sm leading-[22px]">
            {summary.tokensBefore !== undefined ? (
              <p className="text-muted-foreground mb-1 text-xs leading-[18px] tabular-nums @min-[480px]/message:hidden">
                <Trans>压缩前约 {summary.tokensBefore} tokens</Trans>
              </p>
            ) : null}
            <div className="whitespace-pre-wrap">{summary.summary}</div>
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
        className="text-muted-foreground flex min-h-7 items-center gap-2 text-sm leading-5"
      >
        <XCircleIcon aria-hidden className="size-4 shrink-0" />
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
      className="text-destructive flex min-h-7 min-w-0 items-start gap-2 text-sm leading-5"
    >
      <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words whitespace-pre-wrap">
        <Trans>压缩失败</Trans>
        {phase.error ? `：${phase.error}` : null}
      </span>
    </div>
  )
}
