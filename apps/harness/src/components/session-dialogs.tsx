/**
 * 会话只读详情与删除确认弹层。
 *
 * - 详情按需请求宿主：冷会话只做文件聚合，不装配项目扩展、不联网；
 *   同一会话的旧请求结果不得串入新一次打开或切换。
 * - 删除必须先确认：展示名称与完整会话文件路径，说明运行中会先停止任务，
 *   取消不写任何数据；项目文件不受影响。
 */
import { useAui } from '@assistant-ui/react'
import type { HarnessThreadDetails, HarnessThreadMetadata } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, TrashIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { harnessHttpClient } from './pi-http-client'
import { useWorkspace } from './workspace-context'

/** 绝对时间展示：固定格式，不受系统区域设置影响。 */
const formatTime = (value: string | undefined): string => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const formatTokens = (value: number): string => value.toLocaleString('en-US')
const formatCost = (value: number): string => `$${value.toFixed(4)}`

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground w-24 shrink-0 pt-0.5 text-xs">{label}</span>
      <span className="min-w-0 flex-1 break-all">{children}</span>
    </div>
  )
}

/** 会话详情（只读）：元数据、全文件累计统计与当前分支上下文。 */
export function ThreadDetailsDialog({
  open,
  onOpenChange,
  thread,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  thread: HarnessThreadMetadata
}) {
  const { workspaces } = useWorkspace()
  const [details, setDetails] = useState<HarnessThreadDetails>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  /** 请求代次：切换/重开/卸载后旧结果一律丢弃。 */
  const requestRef = useRef(0)
  const threadId = thread.id

  const load = useCallback(async () => {
    requestRef.current += 1
    const request = requestRef.current
    setBusy(true)
    setFailed(false)
    try {
      const next = await harnessHttpClient.getThreadDetails(threadId)
      if (requestRef.current !== request) return
      setDetails(next)
    } catch {
      if (requestRef.current === request) setFailed(true)
    } finally {
      if (requestRef.current === request) setBusy(false)
    }
  }, [threadId])

  useEffect(() => {
    // 每次打开或切换会话都重新请求，避免显示上一会话的旧结果。
    requestRef.current += 1
    if (!open) return
    setDetails(undefined)
    void load()
    return () => {
      // 卸载/关闭后作废在途请求。
      requestRef.current += 1
    }
  }, [load, open])

  const metadata = details?.metadata ?? thread
  const workspace = metadata.workspaceId
    ? workspaces.find((item) => item.id === metadata.workspaceId)
    : undefined
  const stats = details?.stats
  const context = details?.contextUsage
  const config = metadata.config
  const contextPercent =
    context && context.tokens !== null && context.percent !== null
      ? `${context.percent.toFixed(1)}%`
      : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="会话详情" data-slot="huan-thread-details" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>会话详情</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              只读信息。累计统计覆盖整个会话文件（含已压缩历史与其他分支）；当前上下文只按活动分支估算。
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto pe-1">
          <Field label={<Trans>名称</Trans>}>
            {metadata.name ?? metadata.title ?? <Trans>未命名会话</Trans>}
          </Field>
          <Field label={<Trans>会话 ID</Trans>}>{metadata.id}</Field>
          <Field label={<Trans>会话文件</Trans>}>
            {metadata.sessionFile ?? <Trans>尚未创建会话文件</Trans>}
          </Field>
          <Field label={<Trans>起始目录</Trans>}>{metadata.workspacePath ?? '—'}</Field>
          <Field label={<Trans>工作区</Trans>}>
            {workspace?.name ??
              (metadata.workspaceId ? <Trans>工作区不可用</Trans> : <Trans>未归属</Trans>)}
          </Field>
          <Field label={<Trans>父会话</Trans>}>{metadata.parentSessionPath ?? '—'}</Field>
          <Field label={<Trans>创建时间</Trans>}>{formatTime(metadata.createdAt)}</Field>
          <Field label={<Trans>最近活动</Trans>}>{formatTime(metadata.updatedAt)}</Field>
          <Field label={<Trans>模型</Trans>}>
            {config?.provider && config.modelId ? `${config.provider} / ${config.modelId}` : '—'}
            {config?.thinkingLevel ? ` · ${config.thinkingLevel}` : ''}
          </Field>

          {busy && !details ? (
            <p className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              <Trans>正在读取会话统计…</Trans>
            </p>
          ) : failed ? (
            <p role="alert" className="text-destructive text-sm">
              <Trans>读取会话详情失败，请检查宿主连接后重试。</Trans>
            </p>
          ) : stats ? (
            <>
              <Field label={<Trans>消息</Trans>}>
                <Trans>用户 {stats.userMessages}</Trans>
                {' · '}
                <Trans>助手 {stats.assistantMessages}</Trans>
                {' · '}
                <Trans>工具结果 {stats.toolResults}</Trans>
                {' · '}
                <Trans>工具调用 {stats.toolCalls}</Trans>
                {' · '}
                <Trans>共 {stats.totalMessages} 条</Trans>
              </Field>
              <Field label={<Trans>Token</Trans>}>
                <span className="block">
                  <Trans>输入 {formatTokens(stats.tokens.input)}</Trans>
                  {' · '}
                  <Trans>输出 {formatTokens(stats.tokens.output)}</Trans>
                </span>
                <span className="block">
                  <Trans>缓存读 {formatTokens(stats.tokens.cacheRead)}</Trans>
                  {' · '}
                  <Trans>缓存写 {formatTokens(stats.tokens.cacheWrite)}</Trans>
                </span>
                <span className="block">
                  <Trans>总计 {formatTokens(stats.tokens.total)}</Trans>
                </span>
              </Field>
              <Field label={<Trans>累计费用</Trans>}>
                <span title={`$${stats.cost}`}>{formatCost(stats.cost)} USD</span>
              </Field>
              <Field label={<Trans>当前上下文</Trans>}>
                {context === undefined ? (
                  <Trans>模型窗口未知，无法估算</Trans>
                ) : context.tokens === null ? (
                  <span>
                    <Trans>压缩后上下文未知，等待下一次响应</Trans>
                    <span className="text-muted-foreground">
                      {' ('}
                      <Trans>窗口</Trans> {formatTokens(context.contextWindow)})
                    </span>
                  </span>
                ) : (
                  <span>
                    {formatTokens(context.tokens)} / {formatTokens(context.contextWindow)}
                    {contextPercent ? ` (${contextPercent})` : ''}
                  </span>
                )}
                {details && (
                  <span className="text-muted-foreground ms-1 text-xs">
                    <Trans>当前分支 {details.branchEntryCount} 条记录</Trans>
                  </span>
                )}
              </Field>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            {busy ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon aria-hidden className="size-4" />
            )}
            <Trans>刷新详情</Trans>
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 删除会话确认：展示名称与完整路径，运行中先停止任务再永久删除。 */
export function DeleteThreadDialog({
  open,
  onOpenChange,
  thread,
  active = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  thread: HarnessThreadMetadata
  /** 该会话是否为当前窗口正在查看的会话（删除后离开视图）。 */
  active?: boolean
}) {
  const aui = useAui()
  const { refresh, showNotice, showError } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    if (open) setMessage(undefined)
  }, [open])

  const remove = async () => {
    setBusy(true)
    setMessage(undefined)
    try {
      await harnessHttpClient.deleteThread(thread.id)
      // 仅当被删除的会话是当前窗口正在查看的会话时离开视图。
      if (active) await aui.threads.switchToNewThread()
      await refresh()
      showNotice('会话已删除。')
      onOpenChange(false)
    } catch {
      // 文件与 sidecar 没有跨文件事务：删除失败必须可见，不伪报成功。
      setMessage('删除失败：会话文件可能已删除，但元数据清理失败；请查看宿主诊断后重试。')
      showError('load-failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="删除会话">
        <DialogHeader>
          <DialogTitle>
            <Trans>删除会话</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              该操作会永久删除会话文件，无法撤销。若该会话正在运行，会先停止当前任务。项目目录中的文件不会被删除。
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium break-all">
            {thread.name ?? thread.title ?? <Trans>未命名会话</Trans>}
          </span>
          <span className="text-muted-foreground break-all text-xs">
            {thread.sessionFile ?? <Trans>尚未创建会话文件；删除后当前会话记录不会保留。</Trans>}
          </span>
        </div>

        {message && (
          <p role="alert" className="text-destructive text-sm">
            {message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : (
              <TrashIcon aria-hidden className="size-4" />
            )}
            <Trans>删除会话</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
