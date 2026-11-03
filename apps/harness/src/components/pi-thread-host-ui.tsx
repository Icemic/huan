/**
 * 会话级 Host UI：扩展状态、通知、文本 widget、命令目标、编辑器指令与
 * 游离/工具关联的阻断请求。
 *
 * 状态全部来自选中会话的权威快照；答案草稿在 host feature Zustand，编辑器
 * 应用/恢复在 sessions feature。请求保持原始四种类型，不转成 approval。
 */

import type { HarnessHostUiRequest, HarnessHostUiWidgetPlacement } from '@huan/protocol'
import { draftIdOf, useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useChatStore, useHarnessApp, useHostStore, useSessionsStore } from '@/state/app-context'

const typeClass = (type: 'info' | 'warning' | 'error'): string =>
  type === 'error'
    ? 'text-destructive'
    : type === 'warning'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-muted-foreground'

/** 会话级阻断请求卡片；工具关联请求同样在此列出，不因无可见工具而隐藏。 */
function ThreadRequestCard({
  threadId,
  request,
}: {
  threadId: string
  request: HarnessHostUiRequest
}) {
  const key = `${threadId}:${request.id}`
  const draft = useHostStore((state) => state.threadAnswers[key])
  const setAnswer = useHostStore((state) => state.setThreadAnswer)
  const respond = useHostStore((state) => state.respondThreadRequest)
  const markAnswered = useChatStore((state) => state.markRequestAnswered)
  if (!draft) return null
  const busy = draft.busy
  const reply = (response: Parameters<typeof respond>[2]) => {
    void respond(threadId, request.id, response).then((accepted) => {
      if (accepted) markAnswered(request.id)
    })
  }

  return (
    <div
      data-slot="huan-host-ui-request"
      data-request-id={request.id}
      data-kind={request.kind}
      data-tool-call-id={request.toolCallId}
      className="border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/30 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{request.title}</span>
        {request.toolCallId && (
          <span className="text-muted-foreground text-xs" data-slot="huan-request-tool">
            <Trans>工具关联：</Trans>
            {request.toolCallId}
          </span>
        )}
      </div>
      {request.kind === 'confirm' ? (
        <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{request.message}</p>
      ) : null}
      {request.kind === 'select' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {request.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => reply({ requestId: request.id, value: option })}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : null}
      {request.kind === 'input' ? (
        <Input
          className="mt-2"
          aria-label="交互输入"
          placeholder={request.placeholder}
          value={draft.text}
          disabled={busy}
          onChange={(event) => setAnswer(threadId, request.id, event.target.value)}
        />
      ) : null}
      {request.kind === 'editor' ? (
        <Textarea
          className="mt-2 min-h-24"
          aria-label="交互编辑器"
          value={draft.text}
          disabled={busy}
          onChange={(event) => setAnswer(threadId, request.id, event.target.value)}
        />
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {request.kind === 'confirm' ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => reply({ requestId: request.id, confirmed: true })}
            >
              <Trans>允许</Trans>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => reply({ requestId: request.id, confirmed: false })}
            >
              <Trans>拒绝</Trans>
            </Button>
          </>
        ) : null}
        {request.kind === 'input' || request.kind === 'editor' ? (
          <Button size="sm" disabled={busy} onClick={() => reply(undefined)}>
            <Trans>提交</Trans>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => reply({ requestId: request.id, dismissed: true })}
        >
          <Trans>取消</Trans>
        </Button>
        {draft.error ? <span className="text-destructive text-xs">{draft.error}</span> : null}
      </div>
    </div>
  )
}

/** 当前会话的待答请求列表；无请求时不渲染。 */
export function PiHostUiRequests() {
  const selection = useWindowStore((state) => state.selection)
  const requests = useServiceStore((state) =>
    selection?.kind === 'thread'
      ? state.sessionDataById[selection.threadId]?.hostUiRequests
      : undefined,
  )
  const syncThreadRequests = useHostStore((state) => state.syncThreadRequests)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined

  useEffect(() => {
    if (!threadId) return
    syncThreadRequests(threadId, requests ?? [])
  }, [requests, syncThreadRequests, threadId])

  if (!threadId || !requests || requests.length === 0) return null
  return (
    <div data-slot="huan-host-ui-requests" className="border-b px-3 py-2">
      <div className="mb-1 text-xs font-medium">
        <Trans>等待扩展交互（{requests.length}）</Trans>
      </div>
      <div className="grid gap-2">
        {requests.map((request) => (
          <ThreadRequestCard key={request.id} threadId={threadId} request={request} />
        ))}
      </div>
    </div>
  )
}

/** 扩展状态/标题/通知、命令目标与待应用目标提示。 */
export function PiThreadHostUi() {
  const { browser } = useHarnessApp()
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const hostUi = useServiceStore((state) =>
    threadId ? state.sessionDataById[threadId]?.hostUi : undefined,
  )
  const pendingCommandTarget = useSessionsStore((state) => state.pendingCommandTarget)
  const pendingEditorDirective = useSessionsStore((state) => state.pendingEditorDirective)
  const consumeCommandTarget = useSessionsStore((state) => state.consumeCommandTarget)
  const dismissCommandTarget = useSessionsStore((state) => state.dismissCommandTarget)
  const applyPendingCommandTarget = useSessionsStore((state) => state.applyPendingCommandTarget)
  const applyPendingEditorDirective = useSessionsStore((state) => state.applyPendingEditorDirective)

  if (!threadId) return null
  // 只展示面向当前窗口或未定向的指令；其他窗口的定向目标不显示。
  const visibleCommandTarget =
    hostUi?.commandTarget &&
    (!hostUi.commandTarget.callerId || hostUi.commandTarget.callerId === browser.windowId)
      ? hostUi.commandTarget
      : undefined
  const notifications = hostUi?.notifications ?? []
  const hasHostUi =
    hostUi &&
    (hostUi.statuses.length > 0 ||
      Boolean(hostUi.title) ||
      notifications.length > 0 ||
      visibleCommandTarget !== undefined ||
      hostUi.workingMessage !== undefined ||
      hostUi.hiddenThinkingLabel !== undefined)
  const hasPending = pendingCommandTarget !== undefined || pendingEditorDirective !== undefined

  if (!hasHostUi && !hasPending) return null

  return (
    <div data-slot="huan-thread-host-ui" className="border-b px-3 py-1.5 text-xs">
      {hostUi && (
        <div className="flex flex-wrap items-center gap-2">
          {hostUi.statuses.map((status) => (
            <span
              key={status.key}
              data-slot="huan-extension-status"
              className="bg-muted rounded px-1.5 py-0.5"
            >
              {status.key}: {status.text}
            </span>
          ))}
          {hostUi.title ? (
            <span data-slot="huan-extension-title" className="text-muted-foreground">
              <Trans>扩展标题：</Trans>
              {hostUi.title}
            </span>
          ) : null}
          {hostUi.workingMessage ? (
            <span data-slot="huan-extension-working" className="text-muted-foreground">
              {hostUi.workingMessage}
            </span>
          ) : null}
          {hostUi.hiddenThinkingLabel ? (
            <span data-slot="huan-extension-thinking-label" className="text-muted-foreground">
              <Trans>思考折叠标签：</Trans>
              {hostUi.hiddenThinkingLabel}
            </span>
          ) : null}
        </div>
      )}
      {visibleCommandTarget ? (
        <div data-slot="huan-command-target" className="mt-1 flex flex-wrap items-center gap-2">
          <span>
            {visibleCommandTarget.message}
            {visibleCommandTarget.title
              ? `：${visibleCommandTarget.title}`
              : `：${visibleCommandTarget.threadId}`}
          </span>
          <Button size="sm" variant="outline" onClick={() => void consumeCommandTarget(threadId)}>
            <Trans>打开</Trans>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void dismissCommandTarget(threadId)}>
            <Trans>关闭提示</Trans>
          </Button>
        </div>
      ) : null}
      {pendingCommandTarget ? (
        <div
          data-slot="huan-pending-command-target"
          className="mt-1 flex flex-wrap items-center gap-2"
        >
          <span className="text-muted-foreground">
            <Trans>有待打开的会话。</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (applyPendingCommandTarget()) return
            }}
          >
            <Trans>打开会话</Trans>
          </Button>
        </div>
      ) : null}
      {pendingEditorDirective ? (
        <div
          data-slot="huan-pending-editor-directive"
          className="mt-1 flex flex-wrap items-center gap-2"
        >
          <span className="text-muted-foreground">
            <Trans>有待填入的内容。</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (applyPendingEditorDirective()) return
            }}
          >
            <Trans>填入输入框</Trans>
          </Button>
        </div>
      ) : null}
      {notifications.length > 0 ? (
        <ScrollArea
          data-slot="huan-extension-notifications"
          className="mt-1 *:data-[slot=scroll-area-viewport]:max-h-24"
        >
          <ul className="space-y-0.5">
            {notifications.map((item) => (
              <li key={item.id} data-notification-id={item.id} className={typeClass(item.type)}>
                {item.message}
              </li>
            ))}
          </ul>
        </ScrollArea>
      ) : null}
    </div>
  )
}

/** 文本 widget（仅字符串行）；按 placement 放在输入框上方/下方。 */
export function PiComposerWidgets({ placement }: { placement: HarnessHostUiWidgetPlacement }) {
  const selection = useWindowStore((state) => state.selection)
  const widgets = useServiceStore((state) =>
    selection?.kind === 'thread'
      ? state.sessionDataById[selection.threadId]?.hostUi?.widgets
      : undefined,
  )
  const placed = useMemo(
    () => (widgets ?? []).filter((widget) => widget.placement === placement),
    [placement, widgets],
  )
  if (placed.length === 0) return null
  return (
    <div data-slot={`huan-widget-${placement}`} className="text-muted-foreground px-2 text-xs">
      {placed.map((widget) => (
        <div key={widget.key} data-widget-key={widget.key} className="whitespace-pre-wrap">
          {widget.lines.join('\n')}
        </div>
      ))}
    </div>
  )
}

/**
 * 扩展写输入框的指令。
 *
 * - 定向调用方：只在发起窗口显示；其他窗口忽略。
 * - 无调用方（后台扩展）：任一窗口主动接受，先消费者生效。
 * - 始终由用户点击应用；应用前保存旧草稿，可在本窗口恢复。
 */
export function PiComposerHostUi({
  inputRef,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const { browser } = useHarnessApp()
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const directive = useServiceStore((state) =>
    threadId ? state.sessionDataById[threadId]?.hostUi?.editorDirective : undefined,
  )
  const draft = useWindowStore((state) =>
    threadId ? state.draftsById[draftIdOf({ kind: 'thread', threadId })] : undefined,
  )
  const recovery = useSessionsStore((state) => state.editorRecovery)
  const consume = useSessionsStore((state) => state.consumeEditorDirective)
  const discard = useSessionsStore((state) => state.discardEditorDirective)
  const restore = useSessionsStore((state) => state.restoreEditorPrevious)

  if (!threadId) return null

  const visible = directive && (!directive.callerId || directive.callerId === browser.windowId)
  if (!visible) {
    if (recovery?.threadId !== threadId) return null
    return (
      <div
        data-slot="huan-editor-directive-recovery"
        className="text-muted-foreground mx-2 mt-1 flex items-center gap-2 text-xs"
      >
        <Trans>已填入输入框。</Trans>
        <button
          type="button"
          className="underline"
          onClick={() => {
            if (restore()) inputRef.current?.focus()
          }}
        >
          <Trans>恢复原内容</Trans>
        </button>
      </div>
    )
  }
  return (
    <div
      data-slot="huan-editor-directive"
      data-directive-id={directive.id}
      className="border-primary/30 bg-primary/5 mx-2 mt-1 rounded-md border px-2 py-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {directive.callerId ? (
            <Trans>扩展请求修改输入框</Trans>
          ) : (
            <Trans>后台扩展请求修改输入框</Trans>
          )}
        </span>
        <span className="text-muted-foreground max-w-64 truncate">{directive.text}</span>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            const cursor = inputRef.current?.selectionStart ?? draft?.text.length ?? 0
            void consume(threadId, cursor).then((accepted) => {
              if (accepted) inputRef.current?.focus()
            })
          }}
        >
          <Trans>应用</Trans>
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void discard(threadId)}>
          <Trans>忽略</Trans>
        </Button>
      </div>
    </div>
  )
}
