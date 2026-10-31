/**
 * fork / clone 确认弹层。
 *
 * 用于历史用户消息 fork（position=before）、树行 fork 与上下文栏 clone
 * （position=at）。成功后只让发起窗口切换到子会话；父会话与其他窗口保持
 * 原状。运行中不静默中止父会话，先由用户显式停止再重试。
 */
import { useAui, useAuiState } from '@assistant-ui/react'
import type { HarnessThreadForkPosition } from '@huan/protocol'
import { useHarnessController, useHarnessThreadState } from '@huan/react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { AlertTriangleIcon, GitForkIcon, Loader2Icon, SquareIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useWorkspace } from './workspace-context'

const PENDING_ID = '__pending__'

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

export type ForkThreadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** before = 用户消息 fork；at = 当前位置 clone。 */
  position: HarnessThreadForkPosition
  /** fork 的用户消息 entryId；clone 时可省略（宿主使用当前 leaf）。 */
  entryId?: string
  /** 可选：成功创建后关闭其他面板（例如会话树）。 */
  onCompleted?: () => void
}

export function ForkThreadDialog({
  open,
  onOpenChange,
  position,
  entryId,
  onCompleted,
}: ForkThreadDialogProps) {
  const controller = useHarnessController()
  const aui = useAui()
  const { i18n } = useLingui()
  const { refresh, showNotice } = useWorkspace()
  const metadata = useHarnessThreadState((state) => state.metadata)
  const draft = useAuiState((state) => state.composer.text)
  const running = metadata.status === 'running'
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setError(undefined)
    setBusy(false)
    setStopping(false)
  }, [open])

  const isPending = !metadata.id || metadata.id === PENDING_ID
  const forkLabel = position === 'before' ? i18n._(msg`创建独立分支`) : i18n._(msg`克隆为独立会话`)

  const stopRunning = async () => {
    setStopping(true)
    setError(undefined)
    try {
      await controller.cancel()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setStopping(false)
    }
  }

  const confirm = async () => {
    if (isPending) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await controller.forkThread({
        ...(entryId ? { entryId } : {}),
        position,
        ...(metadata.treeRevision ? { expectedRevision: metadata.treeRevision } : {}),
      })
      if (result.status === 'created' && result.threadId) {
        onOpenChange(false)
        onCompleted?.()
        // 切换完成后再写编辑器：草稿必须落在子会话，不能回写父会话。
        await aui.threads.switchToThread(result.threadId)
        aui.composer.setText(
          position === 'before' && result.selectedText !== undefined ? result.selectedText : '',
        )
        await refresh()
        showNotice(
          position === 'before'
            ? i18n._(msg`已从所选用户消息创建独立分支。`)
            : i18n._(msg`已克隆为独立会话。`),
        )
        return
      }
      if (result.status === 'conflict') {
        setError(i18n._(msg`会话树已变化，请关闭后重新打开树面板再试。`))
      } else if (result.status === 'cancelled') {
        setError(result.message ?? i18n._(msg`扩展取消了本次分叉，未创建子会话。`))
      } else {
        setError(result.message ?? i18n._(msg`分叉失败，未创建子会话。`))
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={position === 'before' ? '从消息分叉' : '克隆会话'}>
        <DialogHeader>
          <DialogTitle>
            {position === 'before' ? <Trans>从这条消息分叉</Trans> : <Trans>克隆当前会话</Trans>}
          </DialogTitle>
          <DialogDescription>
            {position === 'before' ? (
              <Trans>
                复制该用户消息之前的活动路径到独立会话，消息原文会恢复到本窗口编辑器；父会话与其他窗口保持不变。
              </Trans>
            ) : (
              <Trans>
                复制当前活动路径到独立会话。父会话与其他窗口保持不变；废弃分支不会进入新会话。
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          {running && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs"
            >
              <AlertTriangleIcon aria-hidden className="size-4 text-destructive" />
              <span className="min-w-0 flex-1">
                <Trans>会话正在运行；需先停止当前响应才能分叉。</Trans>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={stopping}
                onClick={() => void stopRunning()}
              >
                {stopping ? (
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <SquareIcon aria-hidden className="size-3.5" />
                )}
                <Trans>停止运行</Trans>
              </Button>
            </div>
          )}
          {draft.trim().length > 0 && (
            <p className="text-muted-foreground rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
              <Trans>当前输入草稿不会带到新会话；切换后编辑器将显示所选消息原文或清空。</Trans>
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button disabled={busy || running || isPending} onClick={() => void confirm()}>
            {busy ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : (
              <GitForkIcon aria-hidden className="size-4" />
            )}
            {forkLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
