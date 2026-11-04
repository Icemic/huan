/**
 * 父工具中的子任务摘要卡。
 *
 * 只展示协议任务摘要并触发“查看/取消”；不复制子会话消息，也不把子任务
 * 加入普通会话列表。取消由调用方直接调用子任务接口，父工具的实时更新
 * 负责回写新状态。
 */

import type { HarnessSubagentTask, HarnessSubagentTaskStatus } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { BanIcon, CheckIcon, Clock3Icon, EyeIcon, Loader2Icon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const compactTokens = (value: number): string => {
  if (value < 1000) return String(value)
  const scaled = value / 1000
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}k`
}

/** 任务用量摘要：输入/输出 token 与总费用（费用为 0 时不显示）。 */
export const subagentUsageText = (task: HarnessSubagentTask): string => {
  const input = Math.max(0, task.usage.input)
  const output = Math.max(0, task.usage.output)
  const parts: string[] = []
  if (input + output > 0) parts.push(`↑${compactTokens(input)} ↓${compactTokens(output)} tokens`)
  if (task.usage.cost > 0) parts.push(`$${task.usage.cost.toFixed(4)}`)
  return parts.join(' · ')
}

/** 悬浮提示使用完整用量，卡片本身只显示紧凑摘要。 */
export const subagentUsageDetail = (task: HarnessSubagentTask): string =>
  [
    `输入 ${task.usage.input}`,
    `输出 ${task.usage.output}`,
    `缓存读 ${task.usage.cacheRead}`,
    `缓存写 ${task.usage.cacheWrite}`,
    `费用 $${task.usage.cost.toFixed(4)}`,
  ].join(' · ')

const statusLabel = (status: HarnessSubagentTaskStatus) => {
  switch (status) {
    case 'waiting':
      return <Trans>等待</Trans>
    case 'running':
      return <Trans>运行中</Trans>
    case 'completed':
      return <Trans>完成</Trans>
    case 'failed':
      return <Trans>失败</Trans>
    case 'cancelled':
      return <Trans>已取消</Trans>
  }
}

const statusVariant = (
  status: HarnessSubagentTaskStatus,
): 'secondary' | 'destructive' | 'outline' => {
  if (status === 'failed') return 'destructive'
  if (status === 'running' || status === 'completed') return 'secondary'
  return 'outline'
}

/** 子任务状态徽标；运行中保留旋转图标，与父工具状态一致。 */
export function SubagentTaskStatusBadge({ status }: { status: HarnessSubagentTaskStatus }) {
  return (
    <Badge variant={statusVariant(status)} data-slot="huan-subagent-status" data-status={status}>
      {status === 'running' ? (
        <Loader2Icon aria-hidden className="animate-spin" />
      ) : status === 'waiting' ? (
        <Clock3Icon aria-hidden />
      ) : status === 'completed' ? (
        <CheckIcon aria-hidden />
      ) : status === 'failed' ? (
        <XIcon aria-hidden />
      ) : (
        <BanIcon aria-hidden />
      )}
      {statusLabel(status)}
    </Badge>
  )
}

export function SubagentTaskCard({
  task,
  onOpen,
  onCancel,
}: {
  task: HarnessSubagentTask
  onOpen?: () => void
  onCancel?: () => Promise<void>
}) {
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | undefined>(undefined)
  const usage = subagentUsageText(task)
  const output = task.error?.trim() || task.output?.trim()
  const active = task.status === 'running' || task.status === 'waiting'
  const canCancel = active && onCancel !== undefined

  const cancel = async () => {
    if (!onCancel || cancelling) return
    setCancelling(true)
    setCancelError(undefined)
    try {
      await onCancel()
    } catch (error) {
      setCancelError(error instanceof Error && error.message ? error.message : String(error))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div
      data-slot="huan-subagent-task"
      data-task-id={task.taskId}
      data-status={task.status}
      className="bg-muted/30 flex min-w-0 flex-col gap-1.5 rounded-md border px-2.5 py-2 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 max-w-48 truncate font-medium" title={task.agent}>
          {task.agent}
        </span>
        <SubagentTaskStatusBadge status={task.status} />
        {task.pendingRequestCount ? (
          <span className="text-amber-700 dark:text-amber-400">
            <Trans>等待你的答复</Trans>
          </span>
        ) : null}
        {task.model ? (
          <span
            className="text-muted-foreground max-w-48 truncate font-mono text-[11px]"
            title={task.model}
          >
            {task.model}
          </span>
        ) : null}
        {usage ? (
          <span className="text-muted-foreground tabular-nums" title={subagentUsageDetail(task)}>
            {usage}
          </span>
        ) : null}
        <div className="ms-auto flex items-center gap-0.5">
          {onOpen ? (
            <Button variant="ghost" size="xs" onClick={onOpen}>
              <EyeIcon aria-hidden />
              <Trans>查看</Trans>
            </Button>
          ) : null}
          {canCancel ? (
            <Button variant="ghost" size="xs" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? (
                <Loader2Icon aria-hidden className="animate-spin" />
              ) : (
                <BanIcon aria-hidden />
              )}
              <Trans>取消</Trans>
            </Button>
          ) : null}
        </div>
      </div>
      <p
        className="text-muted-foreground line-clamp-2 whitespace-pre-wrap break-words"
        title={task.task}
      >
        {task.task}
      </p>
      {output ? (
        <p
          className={
            task.status === 'failed'
              ? 'text-destructive line-clamp-3 whitespace-pre-wrap break-words'
              : 'line-clamp-3 whitespace-pre-wrap break-words'
          }
        >
          {output}
        </p>
      ) : active ? (
        <p className="text-muted-foreground">
          <Trans>等待任务输出…</Trans>
        </p>
      ) : null}
      {cancelError ? (
        <p className="text-destructive">
          <Trans>取消失败：</Trans>
          {cancelError}
        </p>
      ) : null}
    </div>
  )
}
