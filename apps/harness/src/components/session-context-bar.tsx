/**
 * 当前会话上下文条：工作区、固定起始目录与会话恢复队列。
 *
 * 会话操作已移入输入区 ComposerSessionActions；这里只展示归属目录元数据、
 * 模型回退与恢复队列，不订阅操作弹层状态。
 */

import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { FolderCogIcon } from 'lucide-react'
import { SessionRecoveredQueue } from '@/components/session-tree-dialog'
import { useWorkspaceStore } from '@/state/app-context'

export function SessionContextBar() {
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const metadata = useServiceStore((state) => (threadId ? state.threadsById[threadId] : undefined))
  const workspace = useServiceStore((state) =>
    metadata?.workspaceId ? state.workspacesById[metadata.workspaceId] : undefined,
  )
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const activeWorkspace = useServiceStore((state) =>
    activeWorkspaceId ? state.workspacesById[activeWorkspaceId] : undefined,
  )
  const startProjectFor = useWorkspaceStore((state) => state.startProjectFor)

  if (selection?.kind === 'new') {
    return (
      <div
        data-slot="huan-session-context"
        className="text-muted-foreground flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs"
      >
        <span className="font-medium text-foreground">
          <Trans>新会话</Trans>
        </span>
        <span className="max-w-80 truncate">{selection.startProjectPath}</span>
      </div>
    )
  }

  if (!threadId || !metadata) return null

  const currentWorkspace = workspace ?? activeWorkspace
  const cwd =
    metadata.workspacePath ?? (currentWorkspace ? startProjectFor(currentWorkspace.id) : undefined)
  const fallback = metadata.modelFallback

  return (
    <div
      data-slot="huan-session-context"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs"
    >
      {!metadata.workspaceId ? (
        <span className="text-muted-foreground">
          <Trans>未归属会话</Trans>
        </span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1 font-medium">
            <FolderCogIcon aria-hidden className="size-3.5" />
            {workspace?.name ?? <Trans>工作区不可用</Trans>}
          </span>
          {workspace && (
            <span className="text-muted-foreground">
              <Trans>{workspace.projects.length} 个项目</Trans>
            </span>
          )}
          {cwd && <span className="text-muted-foreground max-w-80 truncate">{cwd}</span>}
        </>
      )}

      {fallback && (
        <span className="text-destructive w-full" data-slot="huan-session-fallback">
          <Trans>模型回退：</Trans>
          {fallback.message}
        </span>
      )}
      <SessionRecoveredQueue />
    </div>
  )
}
