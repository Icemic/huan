import {
  HarnessBrowserProvider,
  useServiceStore,
  useThreadLease,
  useWindowStore,
} from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, XIcon } from 'lucide-react'
import { useEffect } from 'react'
import { ChatView } from '@/components/chat/chat-view'
import { ImportThreadButton, ImportThreadDialog } from '@/components/import-thread-dialog'
import { PiHostInteractions } from '@/components/pi-host-interactions'
import { PiHostStatus } from '@/components/pi-host-status'
import { McpDialog } from '@/components/pi-mcp-panel'
import { ProviderAuthDialog } from '@/components/pi-provider-auth'
import { PiRunStatus } from '@/components/pi-run-status'
import { PiThreadHostUi } from '@/components/pi-thread-host-ui'
import { SessionContextBar } from '@/components/session-context-bar'
import { SessionDialogs } from '@/components/session-dialogs'
import { ForkThreadDialog } from '@/components/session-fork-dialog'
import { SettingsResourcesDialog } from '@/components/settings-resources-dialog'
import { ThemeSelector } from '@/components/theme-selector'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TrustDecisionDialog } from '@/components/workspace-manager'
import { WorkspaceSidebar } from '@/components/workspace-sidebar'
import {
  HarnessAppContextProvider,
  type HarnessAppInstance,
  useWorkspaceStore,
} from '@/state/app-context'

/** 工作区加载/持久化错误与普通操作提示。 */
function WorkspaceStatusBanner() {
  const error = useWorkspaceStore((state) => state.error)
  const notice = useWorkspaceStore((state) => state.notice)
  const busy = useWorkspaceStore((state) => state.busy)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const refresh = useWorkspaceStore((state) => state.refresh)
  const clearError = useWorkspaceStore((state) => state.clearError)
  const clearNotice = useWorkspaceStore((state) => state.clearNotice)

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

  if (error === 'state-unavailable' || (workspaceState !== undefined && workspaceState !== 'ok')) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <span className="flex-1">
          <Trans>
            工作区元数据不可用（{workspaceState}
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

/** 应用主体：顶栏、工作区侧栏与最终聊天视图。 */
function AppShell() {
  const initialize = useWorkspaceStore((state) => state.initialize)
  const hostLoading = useServiceStore((state) => state.hostLoading)
  const host = useServiceStore((state) => state.host)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const selection = useWindowStore((state) => state.selection)
  // 元数据损坏或尚未确认健康时只允许冷读；不为保持实时订阅装配项目扩展。
  const readOnly = workspaceState !== 'ok'
  useThreadLease(!readOnly && selection?.kind === 'thread' ? selection.threadId : undefined)

  useEffect(() => {
    void initialize()
  }, [initialize])

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header
        data-slot="huan-header"
        className="flex h-10 items-center gap-3 border-b px-3 text-sm"
      >
        <span className="font-semibold">幻</span>
        <span className="text-muted-foreground text-xs">
          <Trans>多项目工作区</Trans>
        </span>
        <div className="ms-auto flex items-center gap-2">
          {hostLoading && !host ? (
            <Loader2Icon aria-hidden className="text-muted-foreground size-4 animate-spin" />
          ) : null}
          <ImportThreadButton />
          <SettingsResourcesDialog />
          <McpDialog />
          <ProviderAuthDialog />
          <PiHostStatus />
          <ThemeSelector />
        </div>
      </header>
      <WorkspaceStatusBanner />
      <PiHostInteractions />
      <div className="flex min-h-0 flex-grow">
        <WorkspaceSidebar />
        <main className="flex min-h-0 min-w-0 flex-grow flex-col overflow-hidden">
          <SessionContextBar />
          <PiThreadHostUi />
          <PiRunStatus threadId={selection?.kind === 'thread' ? selection.threadId : undefined} />
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatView />
          </div>
        </main>
      </div>
      <SessionDialogs />
      <ForkThreadDialog />
      <ImportThreadDialog />
      <TrustDecisionDialog />
    </div>
  )
}

/** 应用入口：Provider 只传 bootstrap 创建的实例。 */
export function App({ app }: { app: HarnessAppInstance }) {
  return (
    <HarnessAppContextProvider app={app}>
      <HarnessBrowserProvider browser={app.browser}>
        <TooltipProvider>
          <AppShell />
        </TooltipProvider>
      </HarnessBrowserProvider>
    </HarnessAppContextProvider>
  )
}
