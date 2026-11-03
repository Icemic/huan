/**
 * 输入区的会话操作菜单。
 *
 * 动作与会话归属只读目录元数据；树/fork/详情/归档/删除/未归属加入都触发
 * sessions feature 动作，工作区编辑触发 workspace feature。弹层由 App 根挂载，
 * 关闭后焦点回到菜单入口。
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
  ServerIcon,
  Settings2Icon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react'
import { type ReactNode, type RefObject, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useRestoreFocusOnClose } from '@/hooks/use-restore-trigger-focus'
import {
  useMcpStore,
  useRuntimeStore,
  useSessionsStore,
  useSettingsStore,
  useWorkspaceStore,
} from '@/state/app-context'

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
    <DropdownMenu
      onOpenChangeComplete={(open) => {
        if (open) return
        const action = pendingAction.current
        pendingAction.current = undefined
        action?.()
      }}
    >
      <DropdownMenuTrigger
        ref={triggerRef}
        // 位于输入区表单内，显式声明按钮类型，避免点击时提交消息。
        render={<Button type="button" variant="ghost" size="icon-sm" aria-label="会话操作" />}
      >
        <EllipsisIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-auto overflow-hidden">
        <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[min(24rem,var(--available-height))]">
          {actions.map((action) => {
            const Icon = action.icon
            return (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                variant={action.destructive ? 'destructive' : 'default'}
                onClick={() => {
                  pendingAction.current = action.onSelect
                }}
              >
                <Icon aria-hidden className={action.spin ? 'size-3.5 animate-spin' : 'size-3.5'} />
                {action.label}
              </DropdownMenuItem>
            )
          })}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ComposerSessionActions() {
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const metadata = useServiceStore((state) => (threadId ? state.threadsById[threadId] : undefined))
  const openWorkspaceForm = useWorkspaceStore((state) => state.openWorkspaceForm)
  const formOpen = useWorkspaceStore((state) => state.form.open)
  const openPanel = useRuntimeStore((state) => state.openPanel)
  const runtimeOpen = useRuntimeStore((state) => state.open)
  const openContextSettings = useSettingsStore((state) => state.openPanel)
  const contextSettingsOpen = useSettingsStore((state) => state.open)
  const openContextMcp = useMcpStore((state) => state.openPanel)
  const contextMcpOpen = useMcpStore((state) => state.open)
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
    formOpen ||
      runtimeOpen ||
      treeOpen ||
      detailsOpen ||
      deleteOpen ||
      assignOpen ||
      forkOpen ||
      contextSettingsOpen ||
      contextMcpOpen,
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
    return <SessionActionsMenu triggerRef={menuTriggerRef} actions={newSessionActions} />
  }

  if (!threadId || !metadata) return null

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
      key: 'resources',
      label: <Trans>资源</Trans>,
      icon: Settings2Icon,
      onSelect: () => {
        restoreMenuFocus.current = true
        void openContextSettings({ threadId })
      },
    },
    {
      key: 'mcp',
      label: <Trans>MCP</Trans>,
      icon: ServerIcon,
      onSelect: () => {
        restoreMenuFocus.current = true
        void openContextMcp({ target: { threadId } })
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

  return <SessionActionsMenu triggerRef={menuTriggerRef} actions={actions} />
}
