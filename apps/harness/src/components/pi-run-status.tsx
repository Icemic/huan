/**
 * 运行状态条：把压缩、重试、交互等待、失败与 Shell 运行中显式区分。
 *
 * 空闲（agent_settled 后）不显示；取消不算失败，错误状态由宿主快照清除。
 */
import { useHarnessThreadState } from '@huan/react'
import { Loader2Icon } from 'lucide-react'

const reasonLabel = (reason: 'manual' | 'threshold' | 'overflow' | undefined): string => {
  if (reason === 'manual') return '手动'
  if (reason === 'threshold') return '阈值'
  if (reason === 'overflow') return '超窗'
  return '自动'
}

export function PiRunStatus() {
  const runStatus = useHarnessThreadState((state) => state.runStatus)
  const compaction = useHarnessThreadState((state) => state.compaction)
  const retry = useHarnessThreadState((state) => state.retry)
  const hostUiRequests = useHarnessThreadState((state) => state.hostUiRequests)
  const hostUi = useHarnessThreadState((state) => state.hostUi)
  const bash = useHarnessThreadState((state) => state.bash)
  const lastError = useHarnessThreadState((state) => state.lastError)

  const parts: string[] = []
  if (compaction.active) parts.push(`压缩中（${reasonLabel(compaction.reason)}）`)
  if (retry.active) parts.push(`自动重试第 ${retry.attempt} 次`)
  if (hostUiRequests.length > 0) parts.push(`等待交互应答（${hostUiRequests.length}）`)
  if (bash?.status === 'running') parts.push('Shell 运行中')
  if (runStatus === 'running' && hostUi?.workingVisible !== false && parts.length === 0) {
    parts.push(hostUi?.workingMessage ?? '运行中')
  }
  if (lastError) parts.push(`最近失败：${lastError}`)
  else if (runStatus === 'failed') parts.push('运行失败')
  if (parts.length === 0) return null

  const errorOnly = lastError !== undefined && parts.length === 1
  return (
    <div
      role="status"
      data-slot="huan-run-status"
      className={
        errorOnly
          ? 'text-destructive border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs'
          : 'text-muted-foreground border-b bg-muted/40 px-4 py-1.5 text-xs'
      }
    >
      {runStatus === 'running' && (
        <Loader2Icon aria-hidden className="me-1 inline size-3 animate-spin" />
      )}
      {parts.join(' · ')}
    </div>
  )
}
