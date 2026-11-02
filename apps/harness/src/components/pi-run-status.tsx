/**
 * 运行状态条：压缩、重试、交互等待、失败与 Shell 运行中显式区分。
 *
 * 空闲（服务端 settled 后）不显示；agent_end 不提前视为结束。状态全部来自
 * 当前会话元数据与运行数据，不维护第二份运行状态。
 */

import {
  selectThreadIsRunning,
  selectThreadRunStatus,
  useThreadMetadata,
  useThreadSession,
} from '@huan/react'
import { Loader2Icon } from 'lucide-react'

const reasonLabel = (reason: 'manual' | 'threshold' | 'overflow' | undefined): string => {
  if (reason === 'manual') return '手动'
  if (reason === 'threshold') return '阈值'
  if (reason === 'overflow') return '超窗'
  return '自动'
}

export function PiRunStatus({ threadId }: { threadId: string | undefined }) {
  const metadata = useThreadMetadata(threadId)
  const session = useThreadSession(threadId)
  if (!threadId || !metadata) return null

  const runStatus = selectThreadRunStatus(metadata)
  const busy = selectThreadIsRunning(metadata)
  const parts: string[] = []
  if (metadata.compactionActive) parts.push(`压缩中（${reasonLabel(metadata.compactionReason)}）`)
  if (metadata.retryActive) parts.push(`自动重试第 ${metadata.retryAttempt ?? 0} 次`)
  if ((session?.hostUiRequests.length ?? 0) > 0) {
    parts.push(`等待交互应答（${session?.hostUiRequests.length}）`)
  }
  if (session?.bash?.status === 'running') parts.push('Shell 运行中')
  if (busy && session?.hostUi?.workingVisible !== false && parts.length === 0) {
    parts.push(session?.hostUi?.workingMessage ?? '运行中')
  }
  if (session?.lastError) parts.push(`最近失败：${session.lastError}`)
  else if (runStatus === 'failed') parts.push('运行失败')
  if (parts.length === 0) return null

  const errorOnly = session?.lastError !== undefined && parts.length === 1
  return (
    <div
      role="status"
      data-slot="huan-run-status"
      className={
        errorOnly
          ? 'text-destructive border-destructive/20 bg-destructive/10 border-b px-4 py-1.5 text-xs'
          : 'text-muted-foreground bg-muted/40 border-b px-4 py-1.5 text-xs'
      }
    >
      {busy && <Loader2Icon aria-hidden className="me-1 inline size-3 animate-spin" />}
      {parts.join(' · ')}
    </div>
  )
}
