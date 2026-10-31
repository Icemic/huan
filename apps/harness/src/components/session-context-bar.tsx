/**
 * 当前会话上下文条：所属工作区、项目数量、固定起始目录与实际生效 revision。
 *
 * 会话归属只在元数据中读取；新会话（尚未创建）使用本窗口当前工作区。
 */
import { useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { FolderCogIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useWorkspace } from './workspace-context'
import { WorkspaceManagerDialog } from './workspace-manager'

const PENDING_ID = '__pending__'

export function SessionContextBar() {
  const metadata = useHarnessThreadState((state) => state.metadata)
  const { workspaces, activeWorkspaceId, startProjectFor, state } = useWorkspace()
  const [managerOpen, setManagerOpen] = useState(false)
  const pendingThread = !metadata.id || metadata.id === PENDING_ID
  const threadWorkspace = metadata.workspaceId
    ? workspaces.find((workspace) => workspace.id === metadata.workspaceId)
    : undefined
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const workspace = threadWorkspace ?? (pendingThread ? activeWorkspace : undefined)
  const cwd = metadata.workspacePath ?? (workspace ? startProjectFor(workspace) : undefined)
  const revisionPending =
    workspace &&
    metadata.workspaceRevision !== undefined &&
    metadata.workspaceAppliedRevision !== undefined &&
    metadata.workspaceRevision !== metadata.workspaceAppliedRevision

  if (!workspace && !metadata.workspaceId) {
    return (
      <div
        data-slot="huan-session-context"
        className="text-muted-foreground flex items-center gap-2 border-b px-4 py-1.5 text-xs"
      >
        <Trans>未归属会话；可在左侧明确加入工作区。</Trans>
      </div>
    )
  }

  return (
    <div
      data-slot="huan-session-context"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs"
    >
      <span className="inline-flex items-center gap-1 font-medium">
        <FolderCogIcon aria-hidden className="size-3.5" />
        {workspace?.name ?? <Trans>工作区不可用</Trans>}
      </span>
      {workspace && (
        <>
          <span className="text-muted-foreground">
            <Trans>{workspace.projects.length} 个项目</Trans>
          </span>
          {cwd && <span className="text-muted-foreground max-w-80 truncate">{cwd}</span>}
          <span className="text-muted-foreground">
            {revisionPending ? (
              <Trans>
                成员 v{metadata.workspaceRevision}，本轮仍使用 v{metadata.workspaceAppliedRevision}
                （下次运行生效）
              </Trans>
            ) : metadata.workspaceAppliedRevision !== undefined ? (
              <Trans>实际生效 v{metadata.workspaceAppliedRevision}</Trans>
            ) : (
              <Trans>成员变更将在下一次运行生效</Trans>
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto h-6 px-1.5 text-xs"
            disabled={state !== 'ok'}
            onClick={() => setManagerOpen(true)}
          >
            <Trans>管理项目</Trans>
          </Button>
        </>
      )}
      {workspace && (
        <WorkspaceManagerDialog
          open={managerOpen}
          onOpenChange={setManagerOpen}
          workspace={workspace}
        />
      )}
    </div>
  )
}
