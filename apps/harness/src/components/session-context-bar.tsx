/**
 * 当前会话上下文条：工作区、固定起始目录、实际生效 revision 与管理入口。
 *
 * 会话归属只读目录元数据；树/fork/详情/归档/删除/未归属加入都触发 sessions
 * feature 动作；工作区编辑触发 workspace feature。
 */

import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderCogIcon,
  FolderPlusIcon,
  GitForkIcon,
  InfoIcon,
  Loader2Icon,
  Trash2Icon,
} from 'lucide-react'
import { PiModelSelector } from '@/components/pi-model-selector'
import { RuntimeOperationsPanel } from '@/components/runtime-operations'
import { Button } from '@/components/ui/button'
import { useSessionsStore, useWorkspaceStore } from '@/state/app-context'
import { SessionTreeDialog } from './session-tree-dialog'

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
  const openWorkspaceForm = useWorkspaceStore((state) => state.openWorkspaceForm)
  const openFork = useSessionsStore((state) => state.openFork)
  const openDetails = useSessionsStore((state) => state.openDetails)
  const openDelete = useSessionsStore((state) => state.openDelete)
  const openAssign = useSessionsStore((state) => state.openAssign)
  const setThreadArchived = useSessionsStore((state) => state.setThreadArchived)
  const archiveBusy = useSessionsStore((state) => state.archiveBusy)

  if (selection?.kind === 'new') {
    return (
      <div
        data-slot="huan-session-context"
        className="text-muted-foreground flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs"
      >
        <span className="font-medium text-foreground">
          <Trans>新会话目标</Trans>
        </span>
        <span className="max-w-80 truncate">{selection.startProjectPath}</span>
        <span>
          <Trans>发送首条消息时创建；管理面板可按该起始目录打开。</Trans>
        </span>
        <div className="ms-auto flex items-center gap-2">
          <PiModelSelector />
          <RuntimeOperationsPanel />
        </div>
      </div>
    )
  }

  if (!threadId || !metadata) return null

  const currentWorkspace = workspace ?? activeWorkspace
  const cwd =
    metadata.workspacePath ?? (currentWorkspace ? startProjectFor(currentWorkspace.id) : undefined)
  const revisionPending =
    metadata.workspaceRevision !== undefined &&
    metadata.workspaceAppliedRevision !== undefined &&
    metadata.workspaceRevision !== metadata.workspaceAppliedRevision
  const fallback = metadata.modelFallback

  return (
    <div
      data-slot="huan-session-context"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs"
    >
      {!metadata.workspaceId ? (
        <>
          <span className="text-muted-foreground">
            <Trans>未归属会话；可明确加入工作区。</Trans>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => openAssign(threadId)}
          >
            <FolderPlusIcon aria-hidden className="size-3.5" />
            <Trans>加入工作区</Trans>
          </Button>
        </>
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
        </>
      )}

      <div className="ms-auto flex items-center gap-2">
        <PiModelSelector />
        <RuntimeOperationsPanel />
      </div>
      <SessionTreeDialog />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="克隆到新会话"
        onClick={() => openFork({ threadId, position: 'at' })}
      >
        <GitForkIcon aria-hidden className="size-3.5" />
        <Trans>克隆到新会话</Trans>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        onClick={() => void openDetails(threadId)}
      >
        <InfoIcon aria-hidden className="size-3.5" />
        <Trans>详情</Trans>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        disabled={archiveBusy === threadId}
        onClick={() => void setThreadArchived(threadId, metadata.archived !== true)}
      >
        {archiveBusy === threadId ? (
          <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
        ) : metadata.archived ? (
          <ArchiveRestoreIcon aria-hidden className="size-3.5" />
        ) : (
          <ArchiveIcon aria-hidden className="size-3.5" />
        )}
        {metadata.archived ? <Trans>取消归档</Trans> : <Trans>归档</Trans>}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs text-destructive"
        onClick={() => openDelete(threadId)}
      >
        <Trash2Icon aria-hidden className="size-3.5" />
        <Trans>删除</Trans>
      </Button>
      {metadata.workspaceId && (
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto h-6 px-1.5 text-xs"
          onClick={() => openWorkspaceForm(metadata.workspaceId)}
        >
          <Trans>管理项目</Trans>
        </Button>
      )}
      {fallback && (
        <span className="text-destructive w-full" data-slot="huan-session-fallback">
          <Trans>模型回退：</Trans>
          {fallback.message}
        </span>
      )}
    </div>
  )
}
