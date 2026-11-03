/**
 * 宿主级交互面板：启动装配期的 project_trust/session_start 请求与可见通知。
 *
 * 请求快照来自公共 serviceStore；答案草稿、忙/错误与忽略状态在 host feature
 * Zustand。原始 confirm/select/input/editor 类型直接应答，不转换成 approval。
 */

import type { HarnessHostInteractionRequest } from '@huan/protocol'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useHostStore } from '@/state/app-context'

const scopeLabel = (request: HarnessHostInteractionRequest): string => {
  if (request.scope.kind === 'project') return `项目 ${request.scope.cwd}`
  return `会话 ${request.scope.sessionId}${request.scope.cwd ? `（${request.scope.cwd}）` : ''}`
}

/** 单条待答请求：按 kind 渲染阻断交互；editor 用 prefill 作为初值。 */
function HostInteractionCard({ request }: { request: HarnessHostInteractionRequest }) {
  const draft = useHostStore((state) => state.interactionDrafts[request.id])
  const setAnswer = useHostStore((state) => state.setInteractionAnswer)
  const respond = useHostStore((state) => state.respondInteraction)
  if (!draft) return null
  const busy = draft.busy

  return (
    <div
      data-slot="huan-host-interaction"
      data-request-id={request.id}
      data-kind={request.kind}
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
              onClick={() => void respond(request.id, { requestId: request.id, value: option })}
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
          onChange={(event) => setAnswer(request.id, event.target.value)}
        />
      ) : null}
      {request.kind === 'editor' ? (
        <Textarea
          className="mt-2 min-h-24"
          aria-label="交互编辑器"
          value={draft.text}
          disabled={busy}
          onChange={(event) => setAnswer(request.id, event.target.value)}
        />
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {request.kind === 'confirm' ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void respond(request.id, { requestId: request.id, confirmed: true })}
            >
              <Trans>允许</Trans>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void respond(request.id, { requestId: request.id, confirmed: false })}
            >
              <Trans>拒绝</Trans>
            </Button>
          </>
        ) : null}
        {request.kind === 'input' || request.kind === 'editor' ? (
          <Button size="sm" disabled={busy} onClick={() => void respond(request.id)}>
            <Trans>提交</Trans>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void respond(request.id, { requestId: request.id, dismissed: true })}
        >
          <Trans>取消</Trans>
        </Button>
        {draft.error ? <span className="text-destructive text-xs">{draft.error}</span> : null}
      </div>
    </div>
  )
}

/** 页面级常驻 Host 交互与通知；关闭页面不取消请求，重开以快照恢复。 */
export function PiHostInteractions() {
  const snapshot = useServiceStore((state) => state.hostInteractions)
  const dismissed = useHostStore((state) => state.dismissedNotifications)
  const dismissNotification = useHostStore((state) => state.dismissNotification)

  if (!snapshot) return null
  const notifications = snapshot.notifications.filter((item) => !dismissed.has(item.id))
  if (snapshot.requests.length === 0 && notifications.length === 0) return null

  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="z-[100] max-w-xl">
        <DialogTitle>
          <Trans>宿主交互</Trans>
        </DialogTitle>
        <ScrollArea
          data-slot="huan-host-interactions"
          className="text-sm *:data-[slot=scroll-area-viewport]:max-h-[70vh]"
        >
          <section aria-label="宿主交互" className="grid gap-2">
            {snapshot.requests.length > 0 ? (
              <div className="grid gap-2">
                {snapshot.requests.map((request) => (
                  <HostInteractionCard key={request.id} request={request} />
                ))}
              </div>
            ) : null}
            {notifications.length > 0 ? (
              <ScrollArea
                data-slot="huan-host-notifications"
                className="mt-2 *:data-[slot=scroll-area-viewport]:max-h-32"
              >
                <ul className="space-y-1">
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
              </ScrollArea>
            ) : null}
          </section>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
