/**
 * fork / clone 确认弹层。
 *
 * 面板、busy、错误与来源会话都在 sessions feature Zustand；确认后才创建子
 * 会话。运行中不静默中止父会话，用户显式停止后重试。成功由 store 按来源
 * 选择版本决定是否切换到子会话。
 */

import { draftIdOf, useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { AlertTriangleIcon, GitForkIcon, Loader2Icon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSessionsStore } from '@/state/app-context'

export function ForkThreadDialog() {
  const panel = useSessionsStore((state) => state.forkPanel)
  const closeFork = useSessionsStore((state) => state.closeFork)
  const confirmFork = useSessionsStore((state) => state.confirmFork)
  const stopForkSource = useSessionsStore((state) => state.stopForkSource)
  const metadata = useServiceStore((state) =>
    panel.sourceThreadId ? state.threadsById[panel.sourceThreadId] : undefined,
  )
  const draft = useWindowStore((state) =>
    panel.sourceThreadId
      ? state.draftsById[draftIdOf({ kind: 'thread', threadId: panel.sourceThreadId })]
      : undefined,
  )

  const running = metadata?.status === 'running'
  const before = panel.position === 'before'

  return (
    <Dialog
      open={panel.open}
      onOpenChange={(next) => {
        if (!next) closeFork()
      }}
    >
      <DialogContent aria-label={before ? '从消息分叉' : '克隆会话'}>
        <DialogHeader>
          <DialogTitle>
            {before ? <Trans>从这条消息分叉</Trans> : <Trans>克隆当前会话</Trans>}
          </DialogTitle>
          <DialogDescription>
            {before ? (
              <Trans>将这条消息之前的对话复制到新会话，并把这条消息填入输入框。</Trans>
            ) : (
              <Trans>将当前分支复制到新会话。</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          {running && (
            <div
              role="alert"
              className="border-destructive/30 bg-destructive/5 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
            >
              <AlertTriangleIcon aria-hidden className="text-destructive size-4" />
              <span className="min-w-0 flex-1">
                <Trans>会话正在运行；需先停止当前响应才能分叉。</Trans>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={panel.stopping}
                onClick={() => void stopForkSource()}
              >
                {panel.stopping ? (
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <SquareIcon aria-hidden className="size-3.5" />
                )}
                <Trans>停止运行</Trans>
              </Button>
            </div>
          )}
          {draft && draft.text.trim().length > 0 && (
            <p className="text-muted-foreground bg-muted/40 rounded-md border px-2.5 py-2 text-xs">
              <Trans>当前输入草稿不会带到新会话；切换后编辑器将显示所选消息原文或清空。</Trans>
            </p>
          )}
          {panel.error && (
            <p role="alert" className="text-destructive text-sm">
              {panel.error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={panel.busy} onClick={closeFork}>
            <Trans>取消</Trans>
          </Button>
          <Button disabled={panel.busy || running} onClick={() => void confirmFork()}>
            {panel.busy ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : (
              <GitForkIcon aria-hidden className="size-4" />
            )}
            {before ? <Trans>创建独立分支</Trans> : <Trans>克隆为独立会话</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
