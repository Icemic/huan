/**
 * 命令路由需要的常驻弹层宿主：会话详情与项目信任。
 *
 * 这两个弹层原先只从侧栏/工作区管理打开；/session 与 /trust 通过意图桥
 * 复用同一组件，不复制状态或写第二套数据路径。
 */
import { useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
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
import { clearPiIntent, usePiIntent } from './pi-command-intents'
import { ThreadDetailsDialog } from './session-dialogs'
import { TrustDecisionPanel } from './workspace-manager'

const PENDING_ID = '__pending__'

export function PiCommandPanels() {
  const metadata = useHarnessThreadState((state) => state.metadata)
  const intent = usePiIntent()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [trustPath, setTrustPath] = useState<string>()
  const pending = !metadata.id || metadata.id === PENDING_ID

  useEffect(() => {
    if (!intent) return
    if (intent.kind === 'session-details' && !pending) {
      setDetailsOpen(true)
      clearPiIntent(intent.id)
      return
    }
    if (intent.kind === 'trust' && intent.payload?.path) {
      setTrustPath(intent.payload.path)
      clearPiIntent(intent.id)
    }
  }, [intent, pending])

  return (
    <>
      {!pending && (
        <ThreadDetailsDialog open={detailsOpen} onOpenChange={setDetailsOpen} thread={metadata} />
      )}
      <Dialog
        open={trustPath !== undefined}
        onOpenChange={(open) => !open && setTrustPath(undefined)}
      >
        <DialogContent data-slot="huan-command-trust" aria-label="项目信任">
          <DialogHeader>
            <DialogTitle>
              <Trans>项目信任</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>信任是加载项目资源的前提，不等同于操作系统沙箱。</Trans>
            </DialogDescription>
          </DialogHeader>
          {trustPath && (
            <TrustDecisionPanel path={trustPath} onDone={() => setTrustPath(undefined)} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTrustPath(undefined)}>
              <Trans>关闭</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
