/**
 * 会话详情与管理确认：只读统计、命名、归档、删除确认与未归属加入。
 *
 * 请求代次、详情结果、表单、busy 与错误都在 sessions feature Zustand；
 * 详情按需冷读，不装配项目扩展；删除/归属成功后刷新唯一目录。
 */

import type { HarnessThreadMetadata } from '@huan/protocol'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Loader2Icon,
  RefreshCwIcon,
  TrashIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state/app-context'

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

const fallbackLabel = (metadata: HarnessThreadMetadata | undefined): string | undefined => {
  const fallback = metadata?.modelFallback
  if (!fallback) return undefined
  return [
    fallback.reason === 'restore-failed'
      ? '历史恢复时原模型不可用'
      : fallback.reason === 'no-model'
        ? '没有可用模型'
        : '模型回退',
    fallback.message,
  ].join('：')
}

/** 会话详情与管理动作。 */
export function SessionDetailsDialog() {
  const panel = useSessionsStore((state) => state.details)
  const metadata = useServiceStore((state) =>
    panel.threadId ? state.threadsById[panel.threadId] : undefined,
  )
  const workspace = useServiceStore((state) =>
    metadata?.workspaceId ? state.workspacesById[metadata.workspaceId] : undefined,
  )
  const closeDetails = useSessionsStore((state) => state.closeDetails)
  const refreshDetails = useSessionsStore((state) => state.refreshDetails)
  const setRenameValue = useSessionsStore((state) => state.setRenameValue)
  const renameThread = useSessionsStore((state) => state.renameCurrentThread)
  const toggleArchive = useSessionsStore((state) => state.toggleArchiveCurrent)
  const openDelete = useSessionsStore((state) => state.openDelete)
  const openAssign = useSessionsStore((state) => state.openAssign)

  if (!panel.open || !panel.threadId) return null

  const details = panel.details
  const current = details?.metadata ? { ...details.metadata, ...metadata } : metadata
  const stats = details?.stats
  const context = details?.contextUsage
  const config = current?.config
  const percent =
    context && context.tokens !== null && context.percent !== null
      ? `${context.percent.toFixed(1)}%`
      : undefined
  const fallback = fallbackLabel(current)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDetails()
      }}
    >
      <DialogContent
        aria-label="会话详情"
        data-slot="huan-thread-details"
        className="flex max-h-[85dvh] max-w-xl flex-col"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>会话详情</Trans>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            '*:data-[slot=scroll-area-viewport]:flex-1',
          )}
        >
          <div className="flex flex-col gap-2 pe-1">
            <div className="flex items-end gap-2">
              <label htmlFor="huan-session-name" className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  <Trans>会话名称</Trans>
                </span>
                <Input
                  id="huan-session-name"
                  value={panel.renameValue}
                  aria-label="会话名称"
                  disabled={panel.renameBusy}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={panel.renameBusy}
                onClick={() => void renameThread()}
              >
                {panel.renameBusy && <Loader2Icon aria-hidden className="size-3.5 animate-spin" />}
                <Trans>保存名称</Trans>
              </Button>
            </div>
            {panel.renameError && (
              <p role="alert" className="text-destructive text-xs">
                {panel.renameError}
              </p>
            )}
            {panel.actionError && (
              <p role="alert" className="text-destructive text-xs">
                {panel.actionError}
              </p>
            )}
            {panel.notice && (
              <p role="status" className="bg-muted/50 rounded-md px-2 py-1 text-xs">
                {panel.notice}
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <Field label={<Trans>会话 ID</Trans>}>{current?.id ?? panel.threadId}</Field>
              <Field label={<Trans>会话文件</Trans>}>
                {current?.sessionFile ?? <Trans>尚未创建会话文件</Trans>}
              </Field>
              <Field label={<Trans>起始目录</Trans>}>{current?.workspacePath ?? '—'}</Field>
              <Field label={<Trans>工作区</Trans>}>
                {workspace?.name ??
                  (current?.workspaceId ? <Trans>工作区不可用</Trans> : <Trans>未归属</Trans>)}
              </Field>
              <Field label={<Trans>归档</Trans>}>
                {current?.archived ? <Trans>已归档</Trans> : <Trans>未归档</Trans>}
              </Field>
              <Field label={<Trans>父会话</Trans>}>{current?.parentSessionPath ?? '—'}</Field>
              <Field label={<Trans>创建时间</Trans>}>{formatTime(current?.createdAt)}</Field>
              <Field label={<Trans>最近活动</Trans>}>{formatTime(current?.updatedAt)}</Field>
              <Field label={<Trans>模型</Trans>}>
                {config?.provider && config.modelId
                  ? `${config.provider} / ${config.modelId}`
                  : '—'}
                {config?.thinkingLevel ? ` · ${config.thinkingLevel}` : ''}
              </Field>
              {fallback && (
                <Field label={<Trans>模型回退</Trans>}>
                  <span data-slot="huan-details-fallback" className="text-destructive">
                    {fallback}
                  </span>
                </Field>
              )}
            </div>

            {panel.loading && !details ? (
              <p className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                <Trans>正在读取会话统计…</Trans>
              </p>
            ) : panel.error ? (
              <p role="alert" className="text-destructive text-sm">
                <Trans>读取会话详情失败，请检查宿主连接后重试。</Trans>
              </p>
            ) : stats ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-muted-foreground text-xs">
                  <Trans>累计统计覆盖整个会话文件（含已压缩历史与其他分支）。</Trans>
                </p>
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
                      {percent ? ` (${percent})` : ''}
                    </span>
                  )}
                  {details && (
                    <span className="text-muted-foreground ms-1 text-xs">
                      <Trans>当前分支 {details.branchEntryCount} 条记录</Trans>
                    </span>
                  )}
                  <span className="text-muted-foreground block text-xs">
                    <Trans>只按当前活动分支估算。</Trans>
                  </span>
                </Field>
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-wrap">
          <Button
            variant="outline"
            disabled={panel.actionBusy}
            onClick={() => void toggleArchive()}
          >
            {panel.actionBusy ? (
              <Loader2Icon aria-hidden />
            ) : current?.archived ? (
              <ArchiveRestoreIcon aria-hidden />
            ) : (
              <ArchiveIcon aria-hidden />
            )}
            {current?.archived ? <Trans>取消归档</Trans> : <Trans>归档</Trans>}
          </Button>
          {!current?.workspaceId && (
            <Button variant="outline" onClick={() => openAssign(panel.threadId ?? '')}>
              <Trans>加入工作区</Trans>
            </Button>
          )}
          <Button
            variant="destructive"
            onClick={() => panel.threadId && openDelete(panel.threadId)}
          >
            <TrashIcon aria-hidden />
            <Trans>删除会话</Trans>
          </Button>
          <Button variant="outline" disabled={panel.loading} onClick={() => void refreshDetails()}>
            <RefreshCwIcon aria-hidden />
            <Trans>刷新详情</Trans>
          </Button>
          <Button variant="ghost" onClick={closeDetails}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 删除会话确认：展示名称与完整路径，运行中会先停止任务。 */
export function DeleteThreadDialog() {
  const panel = useSessionsStore((state) => state.deleteConfirm)
  const metadata = useServiceStore((state) =>
    panel.threadId ? state.threadsById[panel.threadId] : undefined,
  )
  const closeDelete = useSessionsStore((state) => state.closeDelete)
  const confirmDelete = useSessionsStore((state) => state.confirmDelete)

  if (!panel.open || !panel.threadId) return null
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDelete()
      }}
    >
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
            {metadata?.name ?? metadata?.title ?? <Trans>未命名会话</Trans>}
          </span>
          <span className="text-muted-foreground break-all text-xs">
            {metadata?.sessionFile ?? <Trans>尚未创建会话文件；删除后当前会话记录不会保留。</Trans>}
          </span>
        </div>

        {panel.error && (
          <p role="alert" className="text-destructive text-sm">
            {panel.error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={panel.busy} onClick={closeDelete}>
            <Trans>取消</Trans>
          </Button>
          <Button variant="destructive" disabled={panel.busy} onClick={() => void confirmDelete()}>
            {panel.busy ? (
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

/** 未归属会话明确加入工作区。 */
export function AssignWorkspaceDialog() {
  const panel = useSessionsStore((state) => state.assign)
  const workspaceIds = useServiceStore((state) => state.workspaceIds)
  const workspacesById = useServiceStore((state) => state.workspacesById)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const setAssignWorkspace = useSessionsStore((state) => state.setAssignWorkspace)
  const closeAssign = useSessionsStore((state) => state.closeAssign)
  const confirmAssign = useSessionsStore((state) => state.confirmAssign)
  const metadata = useServiceStore((state) =>
    panel.threadId ? state.threadsById[panel.threadId] : undefined,
  )

  if (!panel.open || !panel.threadId) return null
  const disabled = workspaceState !== undefined && workspaceState !== 'ok'

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeAssign()
      }}
    >
      <DialogContent aria-label="加入工作区">
        <DialogHeader>
          <DialogTitle>
            <Trans>加入工作区</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>选择目标工作区。</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <span className="break-all">
            {metadata?.title ?? <Trans>未命名会话</Trans>}
            {metadata?.workspacePath ? ` — ${metadata.workspacePath}` : ''}
          </span>
          <Select
            value={panel.workspaceId}
            items={Object.fromEntries(
              workspaceIds.flatMap((id) => {
                const workspace = workspacesById[id]
                return workspace ? [[id, workspace.name] as const] : []
              }),
            )}
            onValueChange={(value) => {
              if (value) setAssignWorkspace(value)
            }}
          >
            <SelectTrigger aria-label="目标工作区" size="sm" className="w-full justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="overflow-hidden" alignItemWithTrigger={false}>
              <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[min(18rem,var(--available-height))]">
                {workspaceIds.map((id) => {
                  const workspace = workspacesById[id]
                  return workspace ? (
                    <SelectItem key={id} value={id}>
                      {workspace.name}
                    </SelectItem>
                  ) : null
                })}
              </ScrollArea>
            </SelectContent>
          </Select>
        </div>
        {disabled && (
          <p role="alert" className="text-destructive text-sm">
            <Trans>工作区元数据不可用，会话归属修改已禁用。</Trans>
          </p>
        )}
        {panel.error && (
          <p role="alert" className="text-destructive text-sm">
            {panel.error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={panel.busy} onClick={closeAssign}>
            <Trans>取消</Trans>
          </Button>
          <Button
            disabled={panel.busy || disabled || !panel.workspaceId}
            onClick={() => void confirmAssign()}
          >
            {panel.busy && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            <Trans>加入</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 应用常驻会话管理弹层；不包含聊天主体。 */
export function SessionDialogs() {
  return (
    <>
      <SessionDetailsDialog />
      <DeleteThreadDialog />
      <AssignWorkspaceDialog />
    </>
  )
}
