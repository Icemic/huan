/**
 * 左侧两级会话列表：工作区一级、会话二级。
 *
 * 数据来源（R3 迁移）：
 * - 会话元数据与目录 ID 只来自公共 serviceStore（`threadsById` + `catalog.ids`）；
 * - 当前会话只来自公共 windowStore 的显式选择；
 * - 搜索/排序/范围/展开/提示只来自应用工作区 feature store。
 *
 * 本组件不再持有第二份目录、aiu 运行时列表或 localId/remoteId 合并。
 */

import type { HarnessThreadMetadata, HarnessWorkspace } from '@huan/protocol'
import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
} from 'lucide-react'
import { memo, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/state/app-context'
import type { WorkspaceThreadScope, WorkspaceThreadSort } from '@/state/workspace-store'
import { NewSessionDialog, WorkspaceManagerDialog } from './workspace-manager'

const titleOf = (thread: HarnessThreadMetadata): string => thread.title ?? '新会话'

/** 活动时间（排序键）：最近活动优先，缺失时回退创建时间。 */
const activityOf = (thread: HarnessThreadMetadata): string =>
  thread.updatedAt ?? thread.createdAt ?? ''

/** 同一工作区内的「继续最近」比较：先活动时间降序，同值以 ID 升序稳定。 */
const compareRecent = (left: HarnessThreadMetadata, right: HarnessThreadMetadata): number => {
  const diff = activityOf(right).localeCompare(activityOf(left))
  return diff !== 0 ? diff : left.id.localeCompare(right.id)
}

const compareThreads =
  (sort: WorkspaceThreadSort) =>
  (left: HarnessThreadMetadata, right: HarnessThreadMetadata): number => {
    if (sort === 'name') {
      const diff = titleOf(left).localeCompare(titleOf(right), 'zh-Hans-CN')
      return diff !== 0 ? diff : left.id.localeCompare(right.id)
    }
    const key = sort === 'created' ? 'createdAt' : 'updatedAt'
    const leftKey = left[key] ?? left.createdAt ?? ''
    const rightKey = right[key] ?? right.createdAt ?? ''
    const diff = rightKey.localeCompare(leftKey)
    return diff !== 0 ? diff : left.id.localeCompare(right.id)
  }

const sortThreads = (threads: readonly HarnessThreadMetadata[], sort: WorkspaceThreadSort) =>
  [...threads].sort(compareThreads(sort))

/** 副行路径：只取末尾两段，完整路径放在悬浮提示里。 */
const shortPath = (path: string): string => {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.slice(-2).join('/') || path
}

/** 副行时间：固定格式，不依赖系统区域设置。 */
const formatActivity = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function SessionRowComponent({
  thread,
  unassigned = false,
  active,
}: {
  thread: HarnessThreadMetadata
  unassigned?: boolean
  active: boolean
}) {
  const selectThread = useWorkspaceStore((state) => state.selectThread)
  const title = titleOf(thread)
  const subtitle = [
    thread.workspacePath ? shortPath(thread.workspacePath) : undefined,
    formatActivity(thread.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ')
  const tooltip = [title, thread.workspacePath, thread.updatedAt].filter(Boolean).join('\n')

  return (
    <div
      data-slot="huan-session-row"
      className={cn(
        'group relative flex min-h-9 items-center rounded-md transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted/70',
      )}
    >
      <button
        type="button"
        data-slot="huan-session-trigger"
        title={tooltip}
        className={cn(
          'flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 py-1 text-start text-sm',
          unassigned ? 'pe-8' : 'pe-2.5',
        )}
        onClick={() => selectThread(thread.id)}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            {thread.status === 'running' && (
              <Loader2Icon
                aria-hidden
                className="text-muted-foreground size-3.5 shrink-0 animate-spin"
              />
            )}
            <span className="min-w-0 truncate">{title}</span>
          </span>
          <span className="text-muted-foreground truncate text-[10px] leading-3">{subtitle}</span>
        </span>
        {thread.status === 'running' && <span className="sr-only">Running</span>}
      </button>
    </div>
  )
}

const SessionRow = memo(SessionRowComponent, (previous, next) => {
  const before = previous.thread
  const after = next.thread
  return (
    previous.active === next.active &&
    previous.unassigned === next.unassigned &&
    before.id === after.id &&
    before.title === after.title &&
    before.workspacePath === after.workspacePath &&
    before.status === after.status &&
    before.updatedAt === after.updatedAt
  )
})

function WorkspaceGroup({
  workspace,
  threads,
  recentThread,
  activeThreadId,
}: {
  workspace: HarnessWorkspace
  threads: readonly HarnessThreadMetadata[]
  recentThread: HarnessThreadMetadata | undefined
  activeThreadId?: string
}) {
  const expanded = useWorkspaceStore((state) => state.expandedWorkspaceIds)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace)
  const toggleWorkspace = useWorkspaceStore((state) => state.toggleWorkspace)
  const selectThread = useWorkspaceStore((state) => state.selectThread)
  const openNewSession = useWorkspaceStore((state) => state.openNewSession)
  const openWorkspaceForm = useWorkspaceStore((state) => state.openWorkspaceForm)
  const isExpanded = expanded.has(workspace.id)
  const isActive = activeWorkspaceId === workspace.id
  const disabled = workspaceState !== undefined && workspaceState !== 'ok'

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
          onClick={() => selectWorkspace(workspace.id)}
        >
          {workspace.name}
          <span className="text-muted-foreground ms-1 text-xs">({threads.length})</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="继续最近"
          disabled={disabled}
          onClick={() => {
            selectWorkspace(workspace.id)
            // 继续最近只看活动时间与归档标记，不受当前搜索/排序/命名过滤影响。
            if (recentThread) {
              selectThread(recentThread.id)
              return
            }
            // 新会话统一走预检表单，避免跳过路径可用性与信任检查。
            openNewSession(workspace.id)
          }}
        >
          <PlayIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="新建会话"
          disabled={disabled}
          onClick={() => openNewSession(workspace.id)}
        >
          <PlusIcon aria-hidden className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="管理工作区"
          disabled={disabled}
          onClick={() => openWorkspaceForm(workspace.id)}
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
              <SessionRow key={thread.id} thread={thread} active={activeThreadId === thread.id} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** 工作区侧栏。 */
export function WorkspaceSidebar() {
  const catalogIds = useServiceStore((state) => state.catalog.ids)
  const threadsById = useServiceStore((state) => state.threadsById)
  const workspaceIds = useServiceStore((state) => state.workspaceIds)
  const workspacesById = useServiceStore((state) => state.workspacesById)
  const selection = useWindowStore((state) => state.selection)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const search = useWorkspaceStore((state) => state.search)
  const scope = useWorkspaceStore((state) => state.scope)
  const sort = useWorkspaceStore((state) => state.sort)
  const namedOnly = useWorkspaceStore((state) => state.namedOnly)
  const showArchived = useWorkspaceStore((state) => state.showArchived)
  const busy = useWorkspaceStore((state) => state.busy)
  const refresh = useWorkspaceStore((state) => state.refresh)
  const setSearch = useWorkspaceStore((state) => state.setSearch)
  const setScope = useWorkspaceStore((state) => state.setScope)
  const setSort = useWorkspaceStore((state) => state.setSort)
  const setNamedOnly = useWorkspaceStore((state) => state.setNamedOnly)
  const setShowArchived = useWorkspaceStore((state) => state.setShowArchived)
  const openWorkspaceForm = useWorkspaceStore((state) => state.openWorkspaceForm)

  const threads = useMemo(
    () =>
      catalogIds.flatMap((id) => {
        const thread = threadsById[id]
        return thread ? [thread] : []
      }),
    [catalogIds, threadsById],
  )
  const workspaces = useMemo(
    () =>
      workspaceIds.flatMap((id) => {
        const workspace = workspacesById[id]
        return workspace ? [workspace] : []
      }),
    [workspaceIds, workspacesById],
  )
  const activeThreadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const query = search.trim().toLowerCase()

  /** 继续最近的候选：未归档 + 有归属，按活动时间挑一条（不受视图过滤影响）。 */
  const recentByWorkspace = useMemo(() => {
    const map = new Map<string, HarnessThreadMetadata>()
    for (const thread of threads) {
      if (thread.archived || !thread.workspaceId) continue
      const current = map.get(thread.workspaceId)
      if (!current || compareRecent(thread, current) < 0) map.set(thread.workspaceId, thread)
    }
    return map
  }, [threads])

  const grouped = useMemo(() => {
    const byWorkspace = new Map<string, HarnessThreadMetadata[]>()
    const unassigned: HarnessThreadMetadata[] = []
    const workspaceIdSet = new Set(workspaceIds)
    for (const thread of threads) {
      if (Boolean(thread.archived) !== showArchived) continue
      if (namedOnly && !thread.name) continue
      if (scope === 'workspace' && thread.workspaceId !== activeWorkspaceId) continue
      if (query) {
        // 明确限定：显式名称与首条用户消息，不做全文搜索。
        const name = (thread.name ?? '').toLowerCase()
        const firstMessage = (thread.firstMessageText ?? '').toLowerCase()
        if (!name.includes(query) && !firstMessage.includes(query)) continue
      }
      if (!thread.workspaceId || !workspaceIdSet.has(thread.workspaceId)) unassigned.push(thread)
      else {
        const list = byWorkspace.get(thread.workspaceId) ?? []
        list.push(thread)
        byWorkspace.set(thread.workspaceId, list)
      }
    }
    return { byWorkspace, unassigned: sortThreads(unassigned, sort) }
  }, [activeWorkspaceId, namedOnly, query, scope, showArchived, sort, threads, workspaceIds])

  const visibleWorkspaces = useMemo(() => {
    if (scope === 'workspace') {
      const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      return active ? [active] : []
    }
    if (!query) return workspaces
    return workspaces.filter(
      (workspace) =>
        workspace.name.toLowerCase().includes(query) ||
        (grouped.byWorkspace.get(workspace.id)?.length ?? 0) > 0,
    )
  }, [activeWorkspaceId, grouped.byWorkspace, query, scope, workspaces])

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r">
      <div className="flex flex-col gap-1 border-b p-2">
        <div className="flex items-center gap-1">
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="搜索会话"
            placeholder="搜索名称或首条消息"
            className="h-8 min-w-0 flex-1 ps-2 text-sm"
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="刷新工作区"
            disabled={busy}
            onClick={() => void refresh({ rescan: true })}
          >
            {busy ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon aria-hidden className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="新建工作区"
            onClick={() => openWorkspaceForm()}
          >
            <PlusIcon aria-hidden className="size-4" />
          </Button>
        </div>
        <p className="text-muted-foreground px-1 text-[10px]">
          <Trans>搜索范围：会话名称与首条消息</Trans>
        </p>
        <div className="flex items-center gap-1">
          <Select
            value={scope}
            items={{
              all: <Trans>全部工作区（含未归属）</Trans>,
              workspace: <Trans>当前工作区</Trans>,
            }}
            onValueChange={(value) => setScope((value ?? 'all') as WorkspaceThreadScope)}
          >
            <SelectTrigger
              size="sm"
              aria-label="会话范围"
              className="h-7 min-w-0 flex-1 justify-between px-1.5 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                <Trans>全部工作区（含未归属）</Trans>
              </SelectItem>
              <SelectItem value="workspace">
                <Trans>当前工作区</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sort}
            items={{
              recent: <Trans>最近活动</Trans>,
              created: <Trans>创建时间</Trans>,
              name: <Trans>名称</Trans>,
            }}
            onValueChange={(value) => setSort((value ?? 'recent') as WorkspaceThreadSort)}
          >
            <SelectTrigger
              size="sm"
              aria-label="会话排序"
              className="h-7 min-w-0 flex-1 justify-between px-1.5 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">
                <Trans>最近活动</Trans>
              </SelectItem>
              <SelectItem value="created">
                <Trans>创建时间</Trans>
              </SelectItem>
              <SelectItem value="name">
                <Trans>名称</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="text-muted-foreground flex items-center gap-3 px-1 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={namedOnly}
              onChange={(event) => setNamedOnly(event.target.checked)}
            />
            <Trans>仅命名</Trans>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            <Trans>已归档会话</Trans>
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {visibleWorkspaces.length === 0 && grouped.unassigned.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-1 py-3 text-sm">
            <p className="text-muted-foreground">
              {query ? <Trans>没有匹配的会话。</Trans> : <Trans>还没有工作区。</Trans>}
            </p>
            {!query && (
              <Button variant="outline" size="sm" onClick={() => openWorkspaceForm()}>
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
                threads={sortThreads(grouped.byWorkspace.get(workspace.id) ?? [], sort)}
                recentThread={recentByWorkspace.get(workspace.id)}
                activeThreadId={activeThreadId}
              />
            ))}
            {scope === 'all' && grouped.unassigned.length > 0 && (
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
                      unassigned
                      active={activeThreadId === thread.id}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <WorkspaceManagerDialog />
      <NewSessionDialog />
    </aside>
  )
}
