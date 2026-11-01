/**
 * 宿主级交互面板：启动装配期的 project_trust/session_start 请求与可见通知。
 *
 * 该组件不依赖当前选中会话，始终挂在页面级；关闭页面不会取消请求，
 * 重新打开后会以权威快照恢复待答项。
 */
import type { HarnessHostInteractionRequest, HarnessHostInteractionSnapshot } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { harnessHttpClient } from './pi-http-client'

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const scopeLabel = (request: HarnessHostInteractionRequest): string => {
  if (request.scope.kind === 'project') return `项目 ${request.scope.cwd}`
  return `会话 ${request.scope.sessionId}${request.scope.cwd ? `（${request.scope.cwd}）` : ''}`
}

type AnswerDraft = {
  text: string
}

/** 单条待答请求：按 kind 渲染对应的阻断交互。 */
function HostInteractionCard({ request }: { request: HarnessHostInteractionRequest }) {
  const [draft, setDraft] = useState<AnswerDraft>({
    text: request.kind === 'editor' ? (request.prefill ?? '') : '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const answer = async (
    response: Parameters<typeof harnessHttpClient.respondToHostInteraction>[0],
  ) => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await harnessHttpClient.respondToHostInteraction(response)
      if (!result.accepted) setError('该请求已结束或应答无效')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const dismiss = () => answer({ requestId: request.id, dismissed: true })

  return (
    <div
      data-slot="huan-host-interaction"
      data-request-id={request.id}
      className="rounded-md border bg-background p-3 text-sm shadow-sm"
    >
      <div className="text-muted-foreground mb-1 text-xs">{scopeLabel(request)}</div>
      <div className="font-medium">{request.title}</div>
      {request.kind === 'confirm' ? (
        <p className="text-muted-foreground mt-1 whitespace-pre-wrap">{request.message}</p>
      ) : null}
      {request.kind === 'select' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {(request.options ?? []).map((option) => (
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
          value={draft.text}
          onChange={(event) => setDraft({ text: event.target.value })}
        />
      ) : null}
      {request.kind === 'editor' ? (
        <textarea
          className="border-input mt-2 min-h-24 w-full rounded border bg-transparent px-2 py-1"
          aria-label="交互编辑器"
          value={draft.text}
          onChange={(event) => setDraft({ text: event.target.value })}
        />
      ) : null}
      <div className="mt-2 flex items-center gap-2">
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
            onClick={() => void answer({ requestId: request.id, value: draft.text })}
          >
            <Trans>提交</Trans>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss()}>
          <Trans>取消</Trans>
        </Button>
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
      </div>
    </div>
  )
}

/** 页面级常驻订阅与待答列表。 */
export function PiHostInteractions() {
  const [snapshot, setSnapshot] = useState<HarnessHostInteractionSnapshot | undefined>()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    const release = harnessHttpClient.subscribeHostInteractions((event) => {
      setSnapshot(event.snapshot)
      setError(undefined)
    })
    return release
  }, [])

  if (!snapshot) return null
  const notifications = snapshot.notifications.filter((item) => !dismissed.has(item.id))
  if (snapshot.requests.length === 0 && notifications.length === 0) return null

  const dismissNotification = (id: string) => setDismissed((current) => new Set(current).add(id))

  return (
    <Dialog open={snapshot.requests.length > 0 || notifications.length > 0}>
      <DialogContent showCloseButton={false} className="z-[100] max-w-xl">
        <DialogTitle>
          <Trans>宿主交互</Trans>
        </DialogTitle>
        <section
          aria-label="宿主交互"
          data-slot="huan-host-interactions"
          className="grid max-h-[70vh] gap-2 overflow-auto text-sm"
        >
          {snapshot.requests.length > 0 ? (
            <div className="grid gap-2">
              {snapshot.requests.map((request) => (
                <HostInteractionCard key={request.id} request={request} />
              ))}
            </div>
          ) : null}
          {notifications.length > 0 ? (
            <ul
              className="mt-2 max-h-32 space-y-1 overflow-auto"
              data-slot="huan-host-notifications"
            >
              {notifications.map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-xs">
                  <span
                    className={
                      item.type === 'error'
                        ? 'text-destructive'
                        : item.type === 'warning'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-muted-foreground'
                    }
                  >
                    {item.message}
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground ms-auto shrink-0 underline"
                    onClick={() => dismissNotification(item.id)}
                  >
                    <Trans>忽略</Trans>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <div className="text-destructive mt-1 text-xs">{error}</div> : null}
        </section>
      </DialogContent>
    </Dialog>
  )
}
