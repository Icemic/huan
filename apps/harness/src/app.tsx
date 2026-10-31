import { useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, XIcon } from 'lucide-react'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { PiHostStatus } from '@/components/pi-host-status'
import { PiLiveSubscription } from '@/components/pi-live-subscription'
import { PiRuntimeProvider } from '@/components/pi-runtime-provider'
import { SessionContextBar } from '@/components/session-context-bar'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspace, WorkspaceProvider } from '@/components/workspace-context'
import { WorkspaceSidebar } from '@/components/workspace-sidebar'

/** 就绪度横幅：模型/凭据不可用时给出提示。 */
function ReadinessBanner() {
  const readiness = useHarnessThreadState((state) => state.readiness)
  if (!readiness || readiness.state === 'ready') return null
  return (
    <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {readiness.message ?? <Trans>Pi 运行时没有可用模型。</Trans>}
    </div>
  )
}

/** 工作区加载/持久化错误与普通操作提示。 */
function WorkspaceStatusBanner() {
  const { state, error, notice, busy, refresh, clearError, clearNotice } = useWorkspace()

  if (error === 'load-failed') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <span className="flex-1">
          <Trans>无法读取工作区与会话列表，请检查宿主连接后重试。</Trans>
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
          <Trans>重试</Trans>
        </Button>
        <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={clearError}>
          <XIcon aria-hidden className="size-4" />
        </Button>
      </div>
    )
  }

  if (state !== undefined && state !== 'ok') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <span className="flex-1">
          <Trans>
            工作区元数据不可用（{state}
            ）。冷历史仍可只读查看；新建会话、会话归属和成员修改已禁用。请修复宿主 huan/state.json
            后重启宿主。
          </Trans>
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCwIcon aria-hidden className="size-4" />
          <Trans>重新查询</Trans>
        </Button>
      </div>
    )
  }

  if (!notice) return null
  return (
    <div role="status" className="flex items-center gap-3 border-b bg-muted/50 px-4 py-1.5 text-sm">
      <span className="flex-1">{notice}</span>
      <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={clearNotice}>
        <XIcon aria-hidden className="size-4" />
      </Button>
    </div>
  )
}

/** 应用主体：工作区两级侧栏 + 当前会话聊天区。 */
function WorkspaceApp() {
  const { hostInfo, createThreadInput, showNotice, state } = useWorkspace()

  if (!hostInfo) {
    return (
      <div role="status" className="flex h-dvh items-center justify-center gap-2 text-sm">
        <Loader2Icon aria-hidden className="size-4 animate-spin" />
        <Trans>正在连接宿主…</Trans>
        <WorkspaceStatusBanner />
      </div>
    )
  }

  return (
    <PiRuntimeProvider
      createThreadInput={createThreadInput}
      readOnly={state !== undefined && state !== 'ok'}
      onError={() => showNotice('会话操作失败，请检查左侧工作区状态、项目信任或宿主诊断后重试。')}
    >
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b px-4 py-2">
          <span className="font-semibold">幻</span>
          <span className="text-muted-foreground text-xs">
            <Trans>多项目工作区</Trans>
          </span>
        </header>
        <WorkspaceStatusBanner />
        {state === 'ok' && <PiLiveSubscription />}
        <div className="flex min-h-0 flex-grow">
          <WorkspaceSidebar />
          <main className="flex min-h-0 min-w-0 flex-grow flex-col overflow-hidden">
            <SessionContextBar />
            <PiHostStatus />
            <ReadinessBanner />
            <Thread />
          </main>
        </div>
      </div>
    </PiRuntimeProvider>
  )
}

/** 应用入口：窗口状态在最外层，运行时在内层共享同一份 client。 */
export function App() {
  return (
    <WorkspaceProvider>
      <TooltipProvider>
        <WorkspaceApp />
      </TooltipProvider>
    </WorkspaceProvider>
  )
}
