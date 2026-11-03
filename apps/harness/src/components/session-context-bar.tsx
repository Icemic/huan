/**
 * 当前会话上下文条：工作区、固定起始目录与会话操作菜单。
 *
 * 会话归属只读目录元数据；树/fork/详情/归档/删除/未归属加入都触发 sessions
 * feature 动作；工作区编辑触发 workspace feature。模型选择只保留在输入区，
 * 会话操作统一收进一个菜单；弹层由 App 根挂载，关闭后焦点回到菜单入口。
 */

import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import type { LucideIcon } from 'lucide-react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  FolderCogIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  InfoIcon,
  Loader2Icon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { type ReactNode, type RefObject, useRef } from 'react'
import { SessionRecoveredQueue } from '@/components/session-tree-dialog'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { useRestoreFocusOnClose } from '@/hooks/use-restore-trigger-focus'
import { useRuntimeStore, useSessionsStore, useWorkspaceStore } from '@/state/app-context'

/** 菜单条目；打开弹层的动作在关闭后由入口侧标记焦点回退。 */
interface SessionAction {
  key: string
  label: ReactNode
  icon: LucideIcon
  disabled?: boolean
  destructive?: boolean
  /** 操作进行中时把图标换成旋转的加载标记。 */
  spin?: boolean
  onSelect: () => void
}

/** 单一“会话操作”菜单；等菜单关闭动画结束后再执行弹层动作，避免关闭抢焦点。 */
function SessionActionsMenu({
  triggerRef,
  actions,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>
  actions: readonly SessionAction[]
}) {
  const pendingAction = useRef<(() => void) | undefined>(undefined)
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (open) return
        const action = pendingAction.current
        pendingAction.current = undefined
        action?.()
      }}
    >
      <MenuTrigger
        ref={triggerRef}
        render={<Button variant="ghost" size="xs" className="h-6 gap-1 px-1.5 text-xs" />}
      >
        <EllipsisIcon aria-hidden className="size-3.5" />
        <Trans>会话操作</Trans>
      </MenuTrigger>
      <MenuContent>
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <MenuItem
              key={action.key}
              disabled={action.disabled}
              className={
                action.destructive
                  ? 'text-destructive data-highlighted:text-destructive'
                  : undefined
              }
              onClick={() => {
                pendingAction.current = action.onSelect
              }}
            >
              <Icon aria-hidden className={action.spin ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {action.label}
            </MenuItem>
          )
        })}
      </MenuContent>
    </Menu>
  )
}

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
  const formOpen = useWorkspaceStore((state) => state.form.open)
  const openPanel = useRuntimeStore((state) => state.openPanel)
  const runtimeOpen = useRuntimeStore((state) => state.open)
  const openTree = useSessionsStore((state) => state.openTree)
  const openFork = useSessionsStore((state) => state.openFork)
  const openDetails = useSessionsStore((state) => state.openDetails)
  const openDelete = useSessionsStore((state) => state.openDelete)
  const openAssign = useSessionsStore((state) => state.openAssign)
  const setThreadArchived = useSessionsStore((state) => state.setThreadArchived)
  const archiveBusy = useSessionsStore((state) => state.archiveBusy)
  const treeOpen = useSessionsStore((state) => state.tree.open)
  const detailsOpen = useSessionsStore((state) => state.details.open)
  const deleteOpen = useSessionsStore((state) => state.deleteConfirm.open)
  const assignOpen = useSessionsStore((state) => state.assign.open)
  const forkOpen = useSessionsStore((state) => state.forkPanel.open)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  // 只有经菜单打开的弹层才在关闭时把焦点还给入口，别处打开的表单不受影响。
  const restoreMenuFocus = useRef(false)
  useRestoreFocusOnClose(
    formOpen || runtimeOpen || treeOpen || detailsOpen || deleteOpen || assignOpen || forkOpen,
    menuTriggerRef,
    restoreMenuFocus,
  )

  if (selection?.kind === 'new') {
    const newSessionActions: SessionAction[] = [
      {
        key: 'runtime',
        label: <Trans>运行操作</Trans>,
        icon: TerminalIcon,
        onSelect: () => {
          restoreMenuFocus.current = true
          void openPanel()
        },
      },
      ...(selection.workspaceId
        ? [
            {
              key: 'workspace',
              label: <Trans>管理项目</Trans>,
              icon: FolderCogIcon,
              onSelect: () => {
                restoreMenuFocus.current = true
                openWorkspaceForm(selection.workspaceId)
              },
            },
          ]
        : []),
    ]
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
          <SessionActionsMenu triggerRef={menuTriggerRef} actions={newSessionActions} />
        </div>
      </div>
    )
  }

  if (!threadId || !metadata) return null

  const currentWorkspace = workspace ?? activeWorkspace
  const cwd =
    metadata.workspacePath ?? (currentWorkspace ? startProjectFor(currentWorkspace.id) : undefined)
  const fallback = metadata.modelFallback
  const archived = metadata.archived === true
  const archivePending = archiveBusy === threadId
  const workspaceId = metadata.workspaceId

  const actions: SessionAction[] = [
    {
      key: 'runtime',
      label: <Trans>运行操作</Trans>,
      icon: TerminalIcon,
      onSelect: () => {
        restoreMenuFocus.current = true
        void openPanel()
      },
    },
    {
      key: 'tree',
      label: <Trans>会话树</Trans>,
      icon: GitBranchIcon,
      onSelect: () => {
        restoreMenuFocus.current = true
        openTree(threadId)
      },
    },
    {
      key: 'fork',
      label: <Trans>克隆到新会话</Trans>,
      icon: GitForkIcon,
      onSelect: () => {
        restoreMenuFocus.current = true
        openFork({ threadId, position: 'at' })
      },
    },
    {
      key: 'details',
      label: <Trans>详情</Trans>,
      icon: InfoIcon,
      onSelect: () => {
        restoreMenuFocus.current = true
        void openDetails(threadId)
      },
    },
    {
      key: 'archive',
      label: archived ? <Trans>取消归档</Trans> : <Trans>归档</Trans>,
      icon: archivePending ? Loader2Icon : archived ? ArchiveRestoreIcon : ArchiveIcon,
      disabled: archivePending,
      spin: archivePending,
      onSelect: () => void setThreadArchived(threadId, !archived),
    },
    {
      key: 'delete',
      label: <Trans>删除</Trans>,
      icon: Trash2Icon,
      destructive: true,
      onSelect: () => {
        restoreMenuFocus.current = true
        openDelete(threadId)
      },
    },
    ...(workspaceId
      ? []
      : [
          {
            key: 'assign',
            label: <Trans>加入工作区</Trans>,
            icon: FolderPlusIcon,
            onSelect: () => {
              restoreMenuFocus.current = true
              openAssign(threadId)
            },
          },
        ]),
    ...(workspaceId
      ? [
          {
            key: 'workspace',
            label: <Trans>管理项目</Trans>,
            icon: FolderCogIcon,
            onSelect: () => {
              restoreMenuFocus.current = true
              openWorkspaceForm(workspaceId)
            },
          },
        ]
      : []),
  ]

  return (
    <div
      data-slot="huan-session-context"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs"
    >
      {!metadata.workspaceId ? (
        <span className="text-muted-foreground">
          <Trans>未归属会话；可明确加入工作区。</Trans>
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

      <div className="ms-auto flex items-center gap-2">
        <SessionActionsMenu triggerRef={menuTriggerRef} actions={actions} />
      </div>
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
