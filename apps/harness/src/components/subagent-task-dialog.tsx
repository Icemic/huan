/**
 * 子任务只读查看弹层。
 *
 * 数据只来自注入的子任务读取接口：任务摘要、子会话快照与待答 Host UI 请求。
 * 这里不通过 serviceStore 加载普通会话、不挂父会话租约，也不提供发送、导航、
 * 分叉或克隆动作；子会话正文复用消息投影与 ChatMessage 的只读模式。
 */

import type {
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessSubagentTask,
  HarnessSubagentTaskView,
} from '@huan/protocol'
import {
  type HarnessMessageView,
  HarnessMessageViewProjector,
  type HarnessToolExecutionState,
} from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { BanIcon, Loader2Icon } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { ChatMessage } from '@/components/chat/chat-message'
import {
  SubagentTaskStatusBadge,
  subagentUsageDetail,
  subagentUsageText,
} from '@/components/subagent-task-card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useSubagentStore } from '@/state/app-context'
import type { SubagentAnswerDraft } from '@/state/subagent-store'

const EMPTY_MESSAGES: readonly HarnessMessageView[] = []

const taskSourceOf = (task: HarnessSubagentTask): string =>
  `${task.agent} · ${task.taskId.slice(0, 8)}`

/** 子会话轮询只替换当前快照，不写入普通会话缓存。 */
const useSubagentMessages = (
  view: HarnessSubagentTaskView | undefined,
): readonly HarnessMessageView[] => {
  const cache = useRef<{ taskId: string; projector: HarnessMessageViewProjector } | undefined>(
    undefined,
  )

  return useMemo(() => {
    const snapshot = view?.snapshot
    if (!view || !snapshot) {
      cache.current = undefined
      return EMPTY_MESSAGES
    }
    if (cache.current?.taskId !== view.task.taskId) {
      cache.current = {
        taskId: view.task.taskId,
        projector: new HarnessMessageViewProjector(),
      }
    }
    const status = snapshot.metadata.status
    return cache.current.projector.project({
      messages: snapshot.messages,
      messageEntryIds: snapshot.messageEntryIds,
      // 持久快照保存工具执行数组；投影使用按 toolCallId 索引的活动态。
      toolExecutions: Object.fromEntries(
        (snapshot.toolExecutions ?? []).map((execution) => [execution.toolCallId, execution]),
      ) as Record<string, HarnessToolExecutionState>,
      runStatus: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'idle',
    })
  }, [view])
}

/** 待答请求卡片：保持 confirm/select/input/editor 原始语义并标明任务来源。 */
function SubagentRequestCard({
  task,
  request,
  draft,
  onAnswer,
  onRespond,
}: {
  task: HarnessSubagentTask
  request: HarnessHostUiRequest
  draft: SubagentAnswerDraft | undefined
  onAnswer: (requestId: string, text: string) => void
  onRespond: (requestId: string, response?: HarnessHostUiResponse) => Promise<boolean>
}) {
  if (!draft) return null
  const busy = draft.busy
  const reply = (response?: HarnessHostUiResponse) => {
    void onRespond(request.id, response)
  }

  return (
    <div
      data-slot="huan-subagent-request"
      data-request-id={request.id}
      data-kind={request.kind}
      className="border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/30 flex flex-col gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{request.title}</span>
        <span
          className="text-muted-foreground text-xs"
          data-slot="huan-subagent-request-source"
          title={task.taskId}
        >
          <Trans>来源：</Trans>
          {taskSourceOf(task)}
        </span>
      </div>
      {request.kind === 'confirm' ? (
        <p className="text-muted-foreground whitespace-pre-wrap">{request.message}</p>
      ) : null}
      {request.kind === 'select' ? (
        <div className="flex flex-wrap gap-2">
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
          aria-label="子任务交互输入"
          placeholder={request.placeholder}
          value={draft.text}
          disabled={busy}
          onChange={(event) => onAnswer(request.id, event.target.value)}
        />
      ) : null}
      {request.kind === 'editor' ? (
        <Textarea
          className="min-h-24"
          aria-label="子任务交互编辑器"
          value={draft.text}
          disabled={busy}
          onChange={(event) => onAnswer(request.id, event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
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
          <Trans>取消请求</Trans>
        </Button>
        {draft.error ? <span className="text-destructive text-xs">{draft.error}</span> : null}
      </div>
    </div>
  )
}

function SubagentMessages({ view }: { view: HarnessSubagentTaskView | undefined }) {
  const views = useSubagentMessages(view)
  const task = view?.task
  if (!task) return null
  if (!view.snapshot) {
    const text =
      task.status === 'waiting' ? (
        <Trans>任务尚未开始运行，暂无子会话记录。</Trans>
      ) : task.status === 'running' ? (
        <Trans>子会话正在启动，暂无消息。</Trans>
      ) : (
        <Trans>该任务没有可读取的子会话记录。</Trans>
      )
    return <p className="text-muted-foreground text-xs">{text}</p>
  }
  if (views.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        <Trans>子会话暂无消息。</Trans>
      </p>
    )
  }
  return (
    <div data-slot="huan-subagent-messages" className="flex flex-col gap-4">
      {views.map((message) => (
        <ChatMessage
          key={message.id}
          view={message}
          threadId={task.taskId}
          title={task.agent}
          readOnly
        />
      ))}
    </div>
  )
}

export function SubagentTaskDialog() {
  const open = useSubagentStore((state) => state.open)
  const view = useSubagentStore((state) => state.view)
  const loading = useSubagentStore((state) => state.loading)
  const error = useSubagentStore((state) => state.error)
  const busy = useSubagentStore((state) => state.busy)
  const answers = useSubagentStore((state) => state.answers)
  const close = useSubagentStore((state) => state.close)
  const completeClose = useSubagentStore((state) => state.completeClose)
  const refresh = useSubagentStore((state) => state.refresh)
  const cancelTask = useSubagentStore((state) => state.cancelTask)
  const respond = useSubagentStore((state) => state.respond)
  const setAnswer = useSubagentStore((state) => state.setAnswer)

  const task = view?.task
  const requests = view?.requests ?? []
  const active = task?.status === 'running' || task?.status === 'waiting'

  // 只在面板打开且任务非终态时轮询；进入终态后由 effect 清理计时器。
  useEffect(() => {
    if (!open || !active) return
    let cancelled = false
    let timer: number | undefined
    const tick = () => {
      timer = window.setTimeout(async () => {
        await refresh()
        if (!cancelled) tick()
      }, 1000)
    }
    tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [open, active, refresh])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) completeClose()
      }}
    >
      <DialogContent
        data-slot="huan-subagent-dialog"
        className="flex h-[min(82dvh,44rem)] flex-col sm:max-w-4xl"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{task?.agent ?? <Trans>子任务</Trans>}</span>
            {task ? <SubagentTaskStatusBadge status={task.status} /> : null}
          </DialogTitle>
          <DialogDescription className="line-clamp-2" title={task?.task}>
            {task?.task ?? <Trans>读取子任务摘要与只读会话…</Trans>}
          </DialogDescription>
        </DialogHeader>

        {task ? (
          <div
            data-slot="huan-subagent-dialog-status"
            className="bg-muted/30 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs"
          >
            {task.model ? (
              <span className="min-w-0 max-w-64 truncate" title={task.model}>
                <span className="text-muted-foreground">
                  <Trans>模型：</Trans>
                </span>
                <span className="font-mono">{task.model}</span>
              </span>
            ) : null}
            {subagentUsageText(task) ? (
              <span className="text-muted-foreground" title={subagentUsageDetail(task)}>
                <Trans>用量：</Trans>
                {subagentUsageText(task)}
              </span>
            ) : null}
            <span
              className="text-muted-foreground max-w-64 truncate font-mono"
              title={`${task.parentThreadId}/${task.taskId}`}
            >
              {task.parentThreadId}/{task.taskId}
            </span>
            {active ? (
              <Button
                variant="outline"
                size="xs"
                className="ms-auto"
                disabled={busy}
                onClick={() => void cancelTask()}
              >
                {busy ? (
                  <Loader2Icon aria-hidden className="animate-spin" />
                ) : (
                  <BanIcon aria-hidden />
                )}
                <Trans>取消任务</Trans>
              </Button>
            ) : null}
          </div>
        ) : null}

        {task?.error ? (
          <div
            role="alert"
            data-slot="huan-subagent-task-error"
            className="border-destructive/20 bg-destructive/10 text-destructive shrink-0 rounded-md border px-2.5 py-1.5 text-xs whitespace-pre-wrap"
          >
            {task.error}
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/10 text-destructive flex shrink-0 flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="outline" size="xs" onClick={() => void refresh()}>
              <Trans>重试</Trans>
            </Button>
          </div>
        ) : null}

        <ScrollArea
          data-slot="huan-subagent-dialog-scroll"
          className="flex min-h-0 flex-1 flex-col rounded-md border border-border/70 *:data-[slot=scroll-area-viewport]:flex-1"
        >
          <div className="flex flex-col gap-4 p-3">
            {loading && !view ? (
              <div
                role="status"
                className="text-muted-foreground flex items-center gap-2 py-6 text-xs"
              >
                <Loader2Icon aria-hidden className="size-4 animate-spin" />
                <Trans>正在读取子任务…</Trans>
              </div>
            ) : null}
            {requests.length > 0 && task ? (
              <section data-slot="huan-subagent-requests" className="flex flex-col gap-2">
                <h3 className="text-xs font-medium">
                  <Trans>等待子任务交互（{requests.length}）</Trans>
                </h3>
                {requests.map((request) => (
                  <SubagentRequestCard
                    key={request.id}
                    task={task}
                    request={request}
                    draft={answers[request.id]}
                    onAnswer={setAnswer}
                    onRespond={respond}
                  />
                ))}
              </section>
            ) : null}
            <section className="flex min-w-0 flex-col gap-2">
              <h3 className="text-xs font-medium">
                <Trans>子会话（只读）</Trans>
              </h3>
              <SubagentMessages view={view} />
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
