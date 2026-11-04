import {
  HarnessBrowserProvider,
  useServiceStore,
  useThreadLease,
  useWindowStore,
} from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ChatView } from '@/components/chat/chat-view'
import { ImportThreadButton, ImportThreadDialog } from '@/components/import-thread-dialog'
import { PiHostInteractions } from '@/components/pi-host-interactions'
import { PiRunStatus } from '@/components/pi-run-status'
import { PiThreadHostUi } from '@/components/pi-thread-host-ui'
import { RuntimeOperationsDialog } from '@/components/runtime-operations'
import { SessionContextBar } from '@/components/session-context-bar'
import { SessionDialogs } from '@/components/session-dialogs'
import { ForkThreadDialog } from '@/components/session-fork-dialog'
import { SessionTreeDialog } from '@/components/session-tree-dialog'
import { ContextDialogs, SettingsButton, SettingsDialog } from '@/components/settings-dialog'
import { SubagentTaskDialog } from '@/components/subagent-task-dialog'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TrustDecisionDialog } from '@/components/workspace-manager'
import { WorkspaceSidebar } from '@/components/workspace-sidebar'
import {
  HarnessAppContextProvider,
  type HarnessAppInstance,
  useHarnessApp,
  useWorkspaceStore,
} from '@/state/app-context'

/** 普通提示默认展示时长；错误提示不自动消失。 */
const NOTICE_TIMEOUT_MS = 5000

/** 工作区加载/持久化错误与普通操作提示：顶部居中悬浮，不占据布局高度。 */
function WorkspaceToast() {
  const workspaceStore = useHarnessApp().workspaceStore
  const error = useWorkspaceStore((state) => state.error)
  const notice = useWorkspaceStore((state) => state.notice)
  const noticeRevision = useWorkspaceStore((state) => state.noticeRevision)
  const busy = useWorkspaceStore((state) => state.busy)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const refresh = useWorkspaceStore((state) => state.refresh)
  const clearError = useWorkspaceStore((state) => state.clearError)
  const clearNotice = useWorkspaceStore((state) => state.clearNotice)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const remainingRef = useRef(NOTICE_TIMEOUT_MS)
  const deadlineRef = useRef(0)
  const stateError = workspaceState !== undefined && workspaceState !== 'ok'
  const hasError = error === 'load-failed' || error === 'state-unavailable' || stateError

  // 暂无普通提示时复位交互状态；错误只暂时覆盖提示，不丢弃业务反馈。
  useEffect(() => {
    if (!notice || hasError) {
      setHovered(false)
      setFocused(false)
    }
  }, [notice, hasError])

  // 每条提示（含同一文本重复提示）都重置自己的剩余时间。
  // biome-ignore lint/correctness/useExhaustiveDependencies: noticeRevision 只用于让同文本提示重新计时，计时起点在 ref 中。
  useEffect(() => {
    remainingRef.current = NOTICE_TIMEOUT_MS
    deadlineRef.current = Date.now() + NOTICE_TIMEOUT_MS
  }, [notice, noticeRevision])

  // 自动消失：悬停或键盘聚焦时暂停，离开后按剩余时间继续；换提示/卸载时清理旧计时。
  useEffect(() => {
    if (!notice || hasError || paused) return
    deadlineRef.current = Date.now() + remainingRef.current
    const timer = window.setTimeout(() => {
      // 旧计时可能在提交新提示前触发；代次不一致时绝不能清掉后来内容。
      if (workspaceStore.getState().noticeRevision === noticeRevision) clearNotice()
    }, remainingRef.current)
    return () => {
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now())
      window.clearTimeout(timer)
    }
  }, [notice, noticeRevision, hasError, paused, clearNotice, workspaceStore])

  const loadFailed = error === 'load-failed'
  const unavailable = !loadFailed && (error === 'state-unavailable' || stateError)
  if (!loadFailed && !unavailable && !notice) return null

  return (
    <div
      data-slot="huan-workspace-toast"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center px-4"
    >
      {loadFailed ? (
        <div
          role="alert"
          data-slot="huan-workspace-error"
          className="border-destructive/40 bg-popover text-destructive pointer-events-auto flex w-full max-w-md flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
        >
          <span className="flex-1">
            <Trans>无法读取工作区与会话列表，请检查宿主连接后重试。</Trans>
          </span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <Trans>重试</Trans>
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="关闭提示" onClick={clearError}>
            <XIcon aria-hidden className="size-4" />
          </Button>
        </div>
      ) : unavailable ? (
        <div
          role="alert"
          data-slot="huan-workspace-error"
          className="border-destructive/40 bg-popover text-destructive pointer-events-auto flex w-full max-w-md flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
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
      ) : notice ? (
        <div
          role="status"
          data-slot="huan-workspace-notice"
          className="bg-popover pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
          }}
        >
          <span className="flex-1">{notice}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="-me-1 mt-0.5 shrink-0"
            aria-label="关闭提示"
            onClick={clearNotice}
          >
            <XIcon aria-hidden className="size-4" />
          </Button>
        </div>
      ) : null}
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
          <SettingsButton />
        </div>
      </header>
      <WorkspaceToast />
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
      <SessionTreeDialog />
      <SubagentTaskDialog />
      <RuntimeOperationsDialog />
      <ForkThreadDialog />
      <ImportThreadDialog />
      <TrustDecisionDialog />
      <SettingsDialog />
      <ContextDialogs />
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
