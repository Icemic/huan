import { useAui } from '@assistant-ui/react'
import { Trans } from '@lingui/react/macro'
import { HistoryIcon, Loader2Icon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { harnessHttpClient } from './pi-http-client'
import { useProject } from './project-context'

/** 项目就绪前的边界：失败时不挂载会话运行时；未信任时以只读方式查看冷历史。 */
export function ProjectGate({ children }: { children: ReactNode }) {
  const { hostUnavailable, hostInfo, project, busy, retryProject } = useProject()

  if (hostUnavailable) {
    return (
      <div role="alert" className="text-destructive px-4 py-6 text-sm">
        <Trans>无法连接宿主。请检查服务是否启动、端口和访问凭证是否一致。</Trans>
      </div>
    )
  }
  if (!hostInfo || !project) {
    return (
      <div role="status" className="text-muted-foreground px-4 py-6 text-sm">
        <Trans>正在准备项目…</Trans>
      </div>
    )
  }
  if (project.status === 'failed') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-4 py-6 text-sm">
        <p>
          <Trans>项目不可用：</Trans> <span className="break-all">{project.path}</span>
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void retryProject()}>
            <Trans>重试</Trans>
          </Button>
        </div>
      </div>
    )
  }
  return <>{children}</>
}

/**
 * 继续最近：读取当前项目最近的会话；没有历史时切到空白新建页，不发送消息。
 */
export function ProjectContinueRecent() {
  const { project } = useProject()
  const aui = useAui()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const continueRecent = async () => {
    if (!project) return
    setBusy(true)
    setError(false)
    try {
      const threads = await harnessHttpClient.listThreads({
        workspacePath: project.path,
        includeArchived: false,
      })
      const latest = [...threads].sort((a, b) =>
        (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''),
      )[0]
      if (latest) await aui.threads.switchToThread(latest.id)
      else await aui.threads.switchToNewThread()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="justify-start gap-2"
        disabled={busy}
        onClick={() => void continueRecent()}
        data-slot="huan-continue-recent"
      >
        {busy ? (
          <Loader2Icon aria-hidden className="size-4 animate-spin" />
        ) : (
          <HistoryIcon aria-hidden className="size-4" />
        )}
        <Trans>继续最近</Trans>
      </Button>
      {error && (
        <p role="alert" className="text-destructive px-2 text-xs">
          <Trans>读取最近会话失败，请重试。</Trans>
        </p>
      )}
    </div>
  )
}

/** 信任未决定时的只读提示：历史可读，项目资源与新建运行保持关闭。 */
export function ProjectTrustBanner() {
  const { project, reviewTrust } = useProject()
  if (project?.status !== 'needs-trust') return null
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm"
    >
      <span className="flex-1">
        <Trans>
          该项目包含受保护资源，尚未决定是否信任；当前只读查看历史，项目扩展未加载，发送已禁用。
        </Trans>
      </span>
      <Button size="sm" onClick={() => reviewTrust()}>
        <Trans>查看信任决定</Trans>
      </Button>
    </div>
  )
}
