import { HarnessBrowserProvider, useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, XIcon } from 'lucide-react'
import { useEffect } from 'react'
import { ThemeSelector } from '@/components/theme-selector'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
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

/** 当前选择摘要；聊天展示由 R7 接通，不在此恢复旧 aui 面板。 */
function SelectionSummary() {
  const selection = useWindowStore((state) => state.selection)
  const thread = useServiceStore((state) =>
    selection?.kind === 'thread' ? state.threadsById[selection.threadId] : undefined,
  )
  const workspacePath =
    selection?.kind === 'new' ? selection.startProjectPath : (thread?.workspacePath ?? undefined)

  if (selection?.kind === 'new') {
    return (
      <div className="flex flex-col gap-2 p-6 text-sm">
        <p className="font-medium">
          <Trans>新会话目标已确定</Trans>
        </p>
        <p className="text-muted-foreground break-all">{workspacePath}</p>
      </div>
    )
  }

  if (selection?.kind === 'thread') {
    return (
      <div className="flex flex-col gap-2 p-6 text-sm">
        <p className="font-medium">{thread?.title ?? <Trans>未命名会话</Trans>}</p>
        {workspacePath && <p className="text-muted-foreground break-all">{workspacePath}</p>}
        <p className="text-muted-foreground text-xs">
          <Trans>会话已选中；聊天展示将在展示接入阶段接通。</Trans>
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6 text-sm">
      <p className="text-muted-foreground">
        <Trans>从左侧选择会话或新建会话。</Trans>
      </p>
    </div>
  )
}

/** 应用主体：顶栏 + 工作区侧栏；旧聊天/管理面板在后续阶段接入。 */
function AppShell() {
  const initialize = useWorkspaceStore((state) => state.initialize)
  const hostLoading = useServiceStore((state) => state.hostLoading)
  const host = useServiceStore((state) => state.host)

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
          <ThemeSelector />
        </div>
      </header>
      <WorkspaceStatusBanner />
      <div className="flex min-h-0 flex-grow">
        <WorkspaceSidebar />
        <main className="flex min-h-0 min-w-0 flex-grow flex-col overflow-hidden">
          <SelectionSummary />
        </main>
      </div>
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
