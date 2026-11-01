/**
 * 会话级 Host UI：扩展状态、通知、文本 widget、编辑器指令与游离阻断请求。
 *
 * 这些状态都来自线程权威快照：断开/重连后由快照补齐，不依赖本地乐观缓存。
 */
import { useAui } from '@assistant-ui/react'
import type { HarnessHostUiRequest, HarnessHostUiWidgetPlacement } from '@huan/protocol'
import { useHarnessExtras, useHarnessHostUiRequests, useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { setComposerDraftOverride } from './pi-composer-draft-override'
import { harnessWindowId } from './pi-http-client'
import { useWorkspace } from './workspace-context'

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const typeClass = (type: 'info' | 'warning' | 'error'): string =>
  type === 'error'
    ? 'text-destructive'
    : type === 'warning'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-muted-foreground'

/** 游离（不关联工具调用）的阻断式请求。工具关联的请求仍走工具卡片审批。 */
function HostUiRequestCard({ request }: { request: HarnessHostUiRequest }) {
  const { respond } = useHarnessHostUiRequests()
  // editor 以 prefill 作为初始值；input 从空开始。
  const [text, setText] = useState(request.kind === 'editor' ? (request.prefill ?? '') : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const answer = async (response: Parameters<typeof respond>[0]) => {
    setBusy(true)
    setError(undefined)
    try {
      await respond(response)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-slot="huan-host-ui-request"
      data-request-id={request.id}
      className="border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/30 rounded-md border px-3 py-2 text-sm"
    >
      <div className="font-medium">{request.title}</div>
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
              onClick={() => void answer({ requestId: request.id, value: option })}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : null}
      {request.kind === 'input' ? (
        <input
          className="border-input mt-2 w-full rounded border bg-transparent px-2 py-1"
          aria-label="交互输入"
          placeholder={request.placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      {request.kind === 'editor' ? (
        <textarea
          className="border-input mt-2 min-h-24 w-full rounded border bg-transparent px-2 py-1"
          aria-label="交互编辑器"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {request.kind === 'confirm' ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void answer({ requestId: request.id, confirmed: true })}
            >
              <Trans>允许</Trans>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void answer({ requestId: request.id, confirmed: false })}
            >
              <Trans>拒绝</Trans>
            </Button>
          </>
        ) : null}
        {request.kind === 'input' || request.kind === 'editor' ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void answer({ requestId: request.id, value: text })}
          >
            <Trans>提交</Trans>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void answer({ requestId: request.id, dismissed: true })}
        >
          <Trans>取消</Trans>
        </Button>
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
      </div>
    </div>
  )
}

/** 会话内游离阻断请求列表；无请求时不渲染。 */
export function PiHostUiRequests() {
  const { requests } = useHarnessHostUiRequests()
  if (requests.length === 0) return null
  return (
    <div data-slot="huan-host-ui-requests" className="border-b px-3 py-2">
      <div className="mb-1 text-xs font-medium">
        <Trans>等待扩展交互（{requests.length}）</Trans>
      </div>
      <div className="grid gap-2">
        {requests.map((request) => (
          <HostUiRequestCard key={request.id} request={request} />
        ))}
      </div>
    </div>
  )
}

/**
 * 扩展状态/标题/通知与命令目标提示。
 *
 * `setTitle` 只作为会话内的扩展标题提示，不覆盖会话名称或 document.title。
 */
export function PiThreadHostUi() {
  const hostUi = useHarnessThreadState((state) => state.hostUi)
  const extra = useHarnessExtras()
  const aui = useAui()
  const { refresh } = useWorkspace()
  const [error, setError] = useState<string | undefined>()

  const commandTarget =
    hostUi?.commandTarget?.callerId && hostUi.commandTarget.callerId !== harnessWindowId
      ? undefined
      : hostUi?.commandTarget
  const notifications = hostUi?.notifications ?? []
  if (
    !hostUi ||
    (hostUi.statuses.length === 0 &&
      !hostUi.title &&
      notifications.length === 0 &&
      !commandTarget &&
      hostUi.workingMessage === undefined &&
      hostUi.hiddenThinkingLabel === undefined)
  ) {
    return null
  }

  const consume = async (id: string): Promise<boolean> => {
    try {
      return await extra.consumeHostUiDirective(id)
    } catch (cause) {
      setError(errorText(cause))
      return false
    }
  }

  return (
    <div data-slot="huan-thread-host-ui" className="border-b px-3 py-1.5 text-xs">
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
      {commandTarget ? (
        <div data-slot="huan-command-target" className="mt-1 flex flex-wrap items-center gap-2">
          <span>
            {commandTarget.message}
            {commandTarget.title ? `：${commandTarget.title}` : `：${commandTarget.threadId}`}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void consume(commandTarget.id).then(async (accepted) => {
                if (!accepted) return
                if (commandTarget.editorText !== undefined) {
                  setComposerDraftOverride(commandTarget.threadId, commandTarget.editorText)
                }
                await refresh()
                await aui.threads.switchToThread(commandTarget.threadId)
                if (commandTarget.editorText !== undefined) {
                  aui.composer.setText(commandTarget.editorText)
                }
              })
            }}
          >
            <Trans>打开</Trans>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void consume(commandTarget.id)}>
            <Trans>关闭提示</Trans>
          </Button>
        </div>
      ) : null}
      {notifications.length > 0 ? (
        <ul
          data-slot="huan-extension-notifications"
          className="mt-1 max-h-24 space-y-0.5 overflow-auto"
        >
          {notifications.map((item) => (
            <li key={item.id} data-notification-id={item.id} className={typeClass(item.type)}>
              {item.message}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="text-destructive mt-1">{error}</div> : null}
    </div>
  )
}

/** 文本 widget（仅字符串行）；按 placement 放在输入框上方/下方。 */
export function PiComposerWidgets({ placement }: { placement: HarnessHostUiWidgetPlacement }) {
  const widgets = useHarnessThreadState((state) =>
    (state.hostUi?.widgets ?? []).filter((widget) => widget.placement === placement),
  )
  if (widgets.length === 0) return null
  return (
    <div data-slot={`huan-widget-${placement}`} className="text-muted-foreground px-2 text-xs">
      {widgets.map((widget) => (
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
 * - 不自动覆盖：始终由用户点击应用；旧文本保留在窗口内可一键恢复。
 */
export function PiComposerHostUi({
  inputRef,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const threadId = useHarnessThreadState((state) => state.metadata.id)
  return <PiComposerHostUiContent key={threadId} inputRef={inputRef} />
}

function PiComposerHostUiContent({
  inputRef,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const directive = useHarnessThreadState((state) => state.hostUi?.editorDirective)
  const extra = useHarnessExtras()
  const aui = useAui()
  const [previous, setPrevious] = useState<string | undefined>()
  const [appliedId, setAppliedId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const lastDirectiveId = useRef<string | undefined>(undefined)

  useEffect(() => {
    // 只在新指令到来时清理旧恢复条；指令被消费（变为 undefined）时保留恢复入口。
    if (!directive?.id || lastDirectiveId.current === directive.id) return
    lastDirectiveId.current = directive.id
    setPrevious(undefined)
    setAppliedId(undefined)
    setError(undefined)
  }, [directive?.id])

  const [claiming, setClaiming] = useState(false)
  const currentThread = useHarnessThreadState((state) => state.metadata.id)
  const currentThreadRef = useRef(currentThread)
  currentThreadRef.current = currentThread
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const consume = async (id: string): Promise<boolean> => {
    try {
      return await extra.consumeHostUiDirective(id)
    } catch (cause) {
      setError(errorText(cause))
      return false
    }
  }

  const restore = () => {
    if (previous === undefined) return
    aui.composer.setText(previous)
    setPrevious(undefined)
    setAppliedId(undefined)
  }

  // 已消费后的恢复条：指令已从快照移除，但旧文本仍可在本窗口找回。
  if (!directive) {
    if (appliedId === undefined || previous === undefined) return null
    return (
      <div
        data-slot="huan-editor-directive-recovery"
        className="text-muted-foreground mx-2 mt-1 flex items-center gap-2 text-xs"
      >
        <Trans>已应用到输入框，原内容保留在窗口内。</Trans>
        <button type="button" className="underline" onClick={restore}>
          <Trans>恢复原内容</Trans>
        </button>
      </div>
    )
  }
  if (directive.callerId && directive.callerId !== harnessWindowId) return null

  const apply = async () => {
    if (claiming) return
    setClaiming(true)
    const thread = currentThreadRef.current
    const accepted = await consume(directive.id)
    if (!mounted.current) return
    setClaiming(false)
    if (!accepted || thread !== currentThreadRef.current) return
    const current = aui.composer.getState().text
    const cursor = inputRef.current?.selectionStart ?? current.length
    const next =
      directive.mode === 'paste'
        ? `${current.slice(0, cursor)}${directive.text}${current.slice(cursor)}`
        : directive.text
    setPrevious(current)
    setAppliedId(directive.id)
    aui.composer.setText(next)
    inputRef.current?.focus()
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
        <Button size="sm" disabled={claiming} onClick={() => void apply()}>
          <Trans>应用</Trans>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void consume(directive.id)}>
          <Trans>忽略</Trans>
        </Button>
      </div>
      {error ? <div className="text-destructive mt-1">{error}</div> : null}
    </div>
  )
}
