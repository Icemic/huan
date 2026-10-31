/**
 * 左侧两级会话列表：工作区一级、会话二级。
 *
 * 数据来自宿主工作区目录与整存储作用域的会话列表；展开状态属于窗口。
 * 切换会话/工作区只改变本窗口视图，不停止宿主运行。
 */

import { useAui, useAuiState } from '@assistant-ui/react'
import type { HarnessThreadMetadata, HarnessWorkspace } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  TrashIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { harnessHttpClient } from './pi-http-client'
import { useWorkspace } from './workspace-context'
import {
  AssignWorkspaceDialog,
  NewSessionDialog,
  WorkspaceManagerDialog,
} from './workspace-manager'

const titleOf = (thread: HarnessThreadMetadata, remoteTitle?: string): string =>
  thread.title ?? remoteTitle ?? '新会话'

const sortThreads = (threads: readonly HarnessThreadMetadata[]) =>
  [...threads].sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? '').localeCompare(
      left.updatedAt ?? left.createdAt ?? '',
    ),
  )

function SessionRow({
  thread,
  remoteTitle,
  unassigned = false,
}: {
  thread: HarnessThreadMetadata
  remoteTitle?: string
  unassigned?: boolean
}) {
  const aui = useAui()
  const { refresh, showError, showNotice, state, selectWorkspace } = useWorkspace()
  const active = useAuiState((current) => current.threads.mainThreadId === thread.id)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const title = titleOf(thread, remoteTitle)

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    try {
      await action()
      await refresh()
      showNotice(success)
    } catch {
      showError('load-failed')
    } finally {
      setBusy(false)
    }
  }

  const commitRename = () => {
    const next = draft.trim()
    setRenaming(false)
    if (!next || next === title) return
    void run(() => harnessHttpClient.renameThread(thread.id, next), '会话已改名。')
  }

  return (
    <div
      data-slot="huan-session-row"
      className={cn(
        'group relative flex h-8 items-center rounded-md transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted/70',
      )}
    >
      {renaming ? (
        <Input
          autoFocus
          aria-label="重命名会话"
          className="h-7 flex-1 text-sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          data-slot="huan-session-trigger"
          className="flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm group-hover:pe-9 group-has-data-[popup-open]:pe-9"
          onClick={() => {
            if (thread.workspaceId) selectWorkspace(thread.workspaceId)
            void aui.threads.switchToThread(thread.id)
          }}
        >
          {thread.status === 'running' && (
            <Loader2Icon
              aria-hidden
              className="text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {thread.status === 'running' && <span className="sr-only">Running</span>}
        </button>
      )}
      {unassigned ? (
        <Button
          variant="ghost"
          size="icon"
          className="absolute end-1.5 top-1/2 size-6 -translate-y-1/2"
          aria-label="加入工作区"
          disabled={state !== 'ok' || busy}
          onClick={() => setAssignOpen(true)}
        >
          <FolderPlusIcon aria-hidden className="size-3.5" />
        </Button>
      ) : (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="absolute end-1.5 top-1/2 size-6 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:bg-accent data-popup-open:opacity-100"
                aria-label="会话操作"
              />
            }
          >
            <MoreHorizontalIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-40 p-1">
            <button
              type="button"
              className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm"
              onClick={() => {
                setMenuOpen(false)
                setDraft(title)
                setRenaming(true)
              }}
            >
              <PencilIcon aria-hidden className="size-4" />
              <Trans>重命名</Trans>
            </button>
            <button
              type="button"
              className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false)
                void run(
                  async () => {
                    if (thread.archived) await harnessHttpClient.unarchiveThread(thread.id)
                    else await harnessHttpClient.archiveThread(thread.id)
                    if (active) await aui.threads.switchToNewThread()
                  },
                  thread.archived ? '会话已恢复。' : '会话已归档。',
                )
              }}
            >
              <ArchiveIcon aria-hidden className="size-4" />
              {thread.archived ? <Trans>恢复</Trans> : <Trans>归档</Trans>}
            </button>
            <button
              type="button"
              className="text-destructive hover:bg-destructive/10 flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false)
                void run(async () => {
                  await harnessHttpClient.deleteThread(thread.id)
                  if (active) await aui.threads.switchToNewThread()
                }, '会话已删除。')
              }}
            >
              <TrashIcon aria-hidden className="size-4" />
              <Trans>删除</Trans>
            </button>
          </PopoverContent>
        </Popover>
      )}
      <AssignWorkspaceDialog open={assignOpen} onOpenChange={setAssignOpen} thread={thread} />
    </div>
  )
}

function WorkspaceGroup({
  workspace,
  threads,
  remoteTitles,
  onManage,
  onNewSession,
}: {
  workspace: HarnessWorkspace
  threads: readonly HarnessThreadMetadata[]
  remoteTitles: ReadonlyMap<string, string | undefined>
  onManage: (workspace: HarnessWorkspace) => void
  onNewSession: (workspace: HarnessWorkspace) => void
}) {
  const aui = useAui()
  const { beginNewSession, startProjectFor } = useWorkspace()
  const { expanded, toggleWorkspace, selectWorkspace, activeWorkspaceId, state } = useWorkspace()
  const isExpanded = expanded.has(workspace.id)
  const isActive = activeWorkspaceId === workspace.id

  return (
    <div data-slot="huan-workspace-group" className="flex flex-col gap-0.5">
      <div
        data-slot="huan-workspace-row"
        className={cn(
          'flex h-8 items-center gap-1 rounded-md px-1',
          isActive ? 'bg-accent/70' : 'hover:bg-muted/60',
        )}
      >
        <button
          type="button"
          className="text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded"
          aria-label={isExpanded ? '收起工作区' : '展开工作区'}
          onClick={() => toggleWorkspace(workspace.id)}
        >
          {isExpanded ? (
            <ChevronDownIcon aria-hidden className="size-4" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-4" />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-start text-sm font-medium"
          onClick={() => {
            selectWorkspace(workspace.id)
            if (!isExpanded) toggleWorkspace(workspace.id)
          }}
        >
          {workspace.name}
          <span className="text-muted-foreground ms-1 text-xs">({threads.length})</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="继续最近"
          disabled={state !== 'ok'}
          onClick={() => {
            selectWorkspace(workspace.id)
            const recent = threads[0]
            if (recent) void aui.threads.switchToThread(recent.id)
            else {
              const startPath = startProjectFor(workspace)
              if (startPath) beginNewSession(workspace.id, startPath)
              void aui.threads.switchToNewThread()
            }
          }}
        >
          <PlayIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="新建会话"
          disabled={state !== 'ok'}
          onClick={() => onNewSession(workspace)}
        >
          <PlusIcon aria-hidden className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="管理工作区"
          disabled={state !== 'ok'}
          onClick={() => onManage(workspace)}
        >
          <Settings2Icon aria-hidden className="size-4" />
        </Button>
      </div>
      {isExpanded && (
        <div data-slot="huan-workspace-sessions" className="ms-3 flex flex-col gap-0.5">
          {threads.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
              <Trans>暂无会话</Trans>
            </p>
          ) : (
            threads.map((thread) => (
              <SessionRow
                key={thread.id}
                thread={thread}
                remoteTitle={remoteTitles.get(thread.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** 工作区侧栏。 */
export function WorkspaceSidebar() {
  const { workspaces, threads, expanded, state, refresh, selectWorkspace, toggleWorkspace } =
    useWorkspace()
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [manager, setManager] = useState<{ open: boolean; workspace?: HarnessWorkspace }>({
    open: false,
  })
  const [newSession, setNewSession] = useState<HarnessWorkspace>()
  const remoteItems = useAuiState((current) => current.threads.threadItems)
  const mainThreadId = useAuiState((current) => current.threads.mainThreadId)
  const syncedThreadRef = useRef<string | undefined>(undefined)
  // 新会话首次发送后 ID 才落到运行时；此时补一次宿主列表，避免侧栏要刷新页面才出现。
  useEffect(() => {
    if (!mainThreadId) return
    if (threads.some((thread) => thread.id === mainThreadId)) {
      syncedThreadRef.current = mainThreadId
      return
    }
    if (syncedThreadRef.current === mainThreadId) return
    syncedThreadRef.current = mainThreadId
    void refresh()
  }, [mainThreadId, refresh, threads])
  const remoteTitles = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const item of remoteItems) map.set(item.id, item.title)
    return map
  }, [remoteItems])

  const query = search.trim().toLowerCase()
  const grouped = useMemo(() => {
    const byWorkspace = new Map<string, HarnessThreadMetadata[]>()
    const unassigned: HarnessThreadMetadata[] = []
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
    for (const thread of threads) {
      if (Boolean(thread.archived) !== showArchived) continue
      const title = titleOf(thread, remoteTitles.get(thread.id)).toLowerCase()
      if (query && !title.includes(query)) continue
      if (!thread.workspaceId || !workspaceIds.has(thread.workspaceId)) unassigned.push(thread)
      else {
        const list = byWorkspace.get(thread.workspaceId) ?? []
        list.push(thread)
        byWorkspace.set(thread.workspaceId, list)
      }
    }
    return {
      byWorkspace,
      unassigned: sortThreads(unassigned),
    }
  }, [query, remoteTitles, threads, workspaces, showArchived])

  const visibleWorkspaces = workspaces.filter((workspace) => {
    if (!query) return true
    return (
      workspace.name.toLowerCase().includes(query) ||
      (grouped.byWorkspace.get(workspace.id)?.length ?? 0) > 0
    )
  })

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r">
      <div className="flex items-center gap-1 border-b p-2">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="搜索会话"
          placeholder="搜索会话"
          className="h-8 min-w-0 flex-1 ps-2 text-sm"
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="刷新工作区"
          onClick={() => void refresh()}
        >
          <RefreshCwIcon aria-hidden className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="新建工作区"
          disabled={state !== 'ok'}
          onClick={() => setManager({ open: true })}
        >
          <PlusIcon aria-hidden className="size-4" />
        </Button>
      </div>

      <label className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        <Trans>已归档会话</Trans>
      </label>
      <div className="flex-1 overflow-y-auto p-2">
        {visibleWorkspaces.length === 0 && grouped.unassigned.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-1 py-3 text-sm">
            <p className="text-muted-foreground">
              {query ? <Trans>没有匹配的会话。</Trans> : <Trans>还没有工作区。</Trans>}
            </p>
            {!query && state === 'ok' && (
              <Button variant="outline" size="sm" onClick={() => setManager({ open: true })}>
                <PlusIcon aria-hidden className="size-4" />
                <Trans>新建工作区</Trans>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleWorkspaces.map((workspace) => (
              <WorkspaceGroup
                key={workspace.id}
                workspace={workspace}
                threads={sortThreads(grouped.byWorkspace.get(workspace.id) ?? [])}
                remoteTitles={remoteTitles}
                onManage={(target) => setManager({ open: true, workspace: target })}
                onNewSession={(target) => {
                  selectWorkspace(target.id)
                  if (!expanded.has(target.id)) toggleWorkspace(target.id)
                  setNewSession(target)
                }}
              />
            ))}
            {grouped.unassigned.length > 0 && (
              <div data-slot="huan-unassigned-group" className="mt-2 flex flex-col gap-0.5">
                <div className="text-muted-foreground flex items-center gap-1 px-2 py-1 text-xs font-medium">
                  <Trans>未归属会话</Trans>
                  <span>({grouped.unassigned.length})</span>
                </div>
                <div className="ms-3 flex flex-col gap-0.5">
                  {grouped.unassigned.map((thread) => (
                    <SessionRow
                      key={thread.id}
                      thread={thread}
                      remoteTitle={remoteTitles.get(thread.id)}
                      unassigned
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <WorkspaceManagerDialog
        open={manager.open}
        workspace={manager.workspace}
        onOpenChange={(open) => setManager((current) => ({ ...current, open }))}
      />
      {newSession && (
        <NewSessionDialog
          open={Boolean(newSession)}
          onOpenChange={(open) => {
            if (!open) setNewSession(undefined)
          }}
          workspace={newSession}
        />
      )}
    </aside>
  )
}
