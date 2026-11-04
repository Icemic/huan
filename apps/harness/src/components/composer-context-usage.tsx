/**
 * 输入区上下文用量入口：28px ghost 环形按钮与官方 Popover。
 *
 * 环形只读取 serviceStore 的实时 metadata；累计统计在浮窗打开时按需读取，
 * 只保存 stats，不用旧详情覆盖当前上下文。悬停 600ms 与点击共用同一受控浮窗。
 */

import type { HarnessContextUsage } from '@huan/protocol'
import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import {
  type ContextUsageTone,
  contextUsageCacheHitRate,
  contextUsageProgress,
  contextUsageTone,
  formatContextPercent,
  formatContextTokenCount,
} from '@/lib/context-usage'
import { cn } from '@/lib/utils'
import { useRuntimeStore } from '@/state/app-context'

const RING_RADIUS = 8
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const textToneClass: Record<ContextUsageTone, string> = {
  unknown: 'text-muted-foreground',
  primary: 'text-primary',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
}

const barToneClass: Record<ContextUsageTone, string> = {
  unknown: 'bg-muted-foreground/50',
  primary: 'bg-primary',
  warning: 'bg-amber-500 dark:bg-amber-400',
  destructive: 'bg-destructive',
}

const strokeToneClass: Record<ContextUsageTone, string> = {
  unknown: 'stroke-muted-foreground',
  primary: 'stroke-primary',
  warning: 'stroke-amber-500 dark:stroke-amber-400',
  destructive: 'stroke-destructive',
}

/** 常驻环形：未知用量只画中性轨道，不伪造 0% 进度。 */
function ContextUsageRing({ usage }: { usage: HarnessContextUsage | undefined }) {
  const percent = usage?.percent
  const tone = contextUsageTone(percent)
  const progress = contextUsageProgress(percent)
  const dash = (progress / 100) * RING_CIRCUMFERENCE
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="size-[18px] -rotate-90">
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2.5"
        className="stroke-muted-foreground/25"
      />
      {tone === 'unknown' ? (
        <circle cx="10" cy="10" r="1.5" className="fill-muted-foreground/50" />
      ) : (
        <circle
          cx="10"
          cy="10"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
          className={strokeToneClass[tone]}
        />
      )}
    </svg>
  )
}

/** 顶部上下文用量、横向进度与累计统计；底部压缩按钮复用运行 feature 的共用动作。 */
export function ComposerContextUsage() {
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const metadata = useServiceStore((state) => (threadId ? state.threadsById[threadId] : undefined))
  const contextUsage = useRuntimeStore((state) => state.contextUsage)
  const openContextUsage = useRuntimeStore((state) => state.openContextUsage)
  const closeContextUsage = useRuntimeStore((state) => state.closeContextUsage)
  const completeClose = useRuntimeStore((state) => state.completeContextUsageClose)
  const refreshContextUsage = useRuntimeStore((state) => state.refreshContextUsage)
  const compactContextUsage = useRuntimeStore((state) => state.compactContextUsage)

  const usage = metadata?.contextUsage
  const tone = contextUsageTone(usage?.percent)
  const progress = contextUsageProgress(usage?.percent)
  const tokensText = usage
    ? `${usage.tokens === null ? '—' : formatContextTokenCount(usage.tokens)} / ${formatContextTokenCount(usage.contextWindow)}`
    : '—'

  const stats = contextUsage.stats
  const hitRate = stats ? contextUsageCacheHitRate(stats.tokens) : undefined
  const tokenStats = stats && stats.tokens.total > 0 ? stats : undefined

  const compactionActive = metadata?.compactionActive === true
  const runActive = metadata?.status === 'running' || metadata?.retryActive === true
  const structureActive = metadata?.treeOperation !== undefined
  const canCompact = Boolean(
    threadId && metadata && !compactionActive && !runActive && !structureActive,
  )

  return (
    <Popover
      open={contextUsage.open}
      onOpenChange={(next) => {
        if (next) openContextUsage()
        else closeContextUsage()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) completeClose()
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={600}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="上下文用量"
            data-huan-context-usage-trigger
          />
        }
      >
        <ContextUsageRing usage={usage} />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" data-huan-context-usage className="w-60 gap-2 p-2">
        <PopoverTitle className="text-sm">
          <Trans>上下文</Trans>
        </PopoverTitle>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-xs" data-slot="huan-context-usage-tokens">
            {tokensText}
          </span>
          <span
            className={cn('text-sm font-medium tabular-nums', textToneClass[tone])}
            data-slot="huan-context-usage-percent"
          >
            {formatContextPercent(usage?.percent)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="上下文窗口占用"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(tone === 'unknown' ? {} : { 'aria-valuenow': Math.round(progress) })}
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
        >
          <div
            data-slot="huan-context-usage-bar"
            className={cn(
              'h-full rounded-full transition-[width] duration-[var(--motion-duration-normal)] motion-reduce:transition-none',
              barToneClass[tone],
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        {!usage ? (
          <p className="text-muted-foreground text-[11px] leading-tight">
            <Trans>暂无用量</Trans>
          </p>
        ) : usage.tokens === null ? (
          <p className="text-muted-foreground text-[11px] leading-tight">
            <Trans>压缩后用量待更新</Trans>
          </p>
        ) : null}

        <div className="flex flex-col gap-1 border-t pt-2" data-slot="huan-context-usage-stats">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium">
              <Trans>本会话累计</Trans>
            </h3>
            {contextUsage.loading ? (
              <Loader2Icon aria-hidden className="text-muted-foreground size-3 animate-spin" />
            ) : null}
          </div>
          {contextUsage.statsError ? (
            <div className="flex flex-col gap-1">
              <p role="alert" className="text-destructive text-[11px] whitespace-pre-wrap">
                <Trans>读取累计统计失败：{contextUsage.statsError}</Trans>
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="self-start"
                onClick={() => void refreshContextUsage()}
              >
                <RefreshCwIcon aria-hidden className="size-3" />
                <Trans>重试</Trans>
              </Button>
            </div>
          ) : null}
          {tokenStats ? (
            <dl className="flex flex-col gap-1.5 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">
                  <Trans>输入</Trans>
                </dt>
                <dd className="font-mono tabular-nums">
                  {formatContextTokenCount(tokenStats.tokens.input)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">
                  <Trans>输出</Trans>
                </dt>
                <dd className="font-mono tabular-nums">
                  {formatContextTokenCount(tokenStats.tokens.output)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">
                  <Trans>缓存读取</Trans>
                </dt>
                <dd className="font-mono tabular-nums">
                  {formatContextTokenCount(tokenStats.tokens.cacheRead)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">
                  <Trans>缓存命中率</Trans>
                </dt>
                <dd className="font-mono tabular-nums">
                  {formatContextPercent(hitRate === undefined ? undefined : hitRate * 100)}
                </dd>
              </div>
            </dl>
          ) : !contextUsage.loading && !contextUsage.statsError ? (
            <p className="text-muted-foreground text-xs">
              <Trans>暂无统计</Trans>
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5 border-t pt-2" data-slot="huan-context-usage-compact">
          {contextUsage.compactError ? (
            <p role="alert" className="text-destructive text-[11px] whitespace-pre-wrap">
              {contextUsage.compactError}
            </p>
          ) : null}
          <div className="flex flex-col">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!canCompact}
              onClick={() => void compactContextUsage()}
            >
              {compactionActive ? (
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              ) : null}
              {compactionActive ? <Trans>压缩中…</Trans> : <Trans>立即压缩上下文</Trans>}
            </Button>
            {runActive ? (
              <span className="text-muted-foreground min-w-0 text-[11px] leading-tight">
                <Trans>运行中暂不可压缩</Trans>
              </span>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
