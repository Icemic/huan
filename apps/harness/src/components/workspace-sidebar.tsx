/**
 * 左侧两级会话列表：工作区一级、会话二级。
 *
 * 数据来自宿主工作区目录与整存储作用域的会话列表；展开状态属于窗口。
 * 切换会话/工作区只改变本窗口视图，不停止宿主运行。
 *
 * 列表控制（G1.2b）：
 * - 搜索只匹配显式名称与首条用户消息（不是全文），范围可选全部工作区或当前工作区；
 * - 排序支持最近活动、创建时间、名称，同值以 ID 稳定排序；
 * - 「仅命名」只显示有显式名称的会话；「已归档会话」切换归档视图；
 * - 「继续最近」始终按活动时间从未归档会话中选取，不受搜索、排序与过滤影响。
 */

import { type AssistantState, useAui, useAuiState } from '@assistant-ui/react'
import type { HarnessThreadMetadata, HarnessWorkspace } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  InfoIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  TrashIcon,
} from 'lucide-react'
import { type ComponentProps, memo, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ImportThreadButton } from './import-thread-dialog'
import { clearPiIntent, usePiIntent } from './pi-command-intents'
import { harnessHttpClient } from './pi-http-client'
import { DeleteThreadDialog, ThreadDetailsDialog } from './session-dialogs'
import { useWorkspace, useWorkspaceActions } from './workspace-context'
import {
  AssignWorkspaceDialog,
  NewSessionDialog,
  WorkspaceManagerDialog,
} from './workspace-manager'

/** 列表排序模式。 */
type ThreadSort = 'recent' | 'created' | 'name'

/** 列表范围：全部工作区（含未归属）或当前工作区。 */
type ThreadScope = 'all' | 'workspace'

const titleOf = (thread: HarnessThreadMetadata, remoteTitle?: string): string =>
  thread.title ?? remoteTitle ?? '新会话'

/** 活动时间（排序键）：最近活动优先，缺失时回退创建时间。 */
const activityOf = (thread: HarnessThreadMetadata): string =>
  thread.updatedAt ?? thread.createdAt ?? ''

/** 同一工作区内的「继续最近」比较：先活动时间降序，同值以 ID 升序稳定。 */
const compareRecent = (left: HarnessThreadMetadata, right: HarnessThreadMetadata): number => {
  const diff = activityOf(right).localeCompare(activityOf(left))
  return diff !== 0 ? diff : left.id.localeCompare(right.id)
}

const compareThreads =
  (sort: ThreadSort) =>
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

const sortThreads = (threads: readonly HarnessThreadMetadata[], sort: ThreadSort) =>
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

/** 侧栏从运行时列表需要的字段：远端标题与当前主线程的宿主 ID。 */
type RemoteThreadProjection = {
  titles: ReadonlyMap<string, string | undefined>
  activeThreadId: string | undefined
}

const sameRemoteThreadProjection = (
  previous: RemoteThreadProjection,
  titles: ReadonlyMap<string, string | undefined>,
  activeThreadId: string | undefined,
): boolean => {
  if (previous.activeThreadId !== activeThreadId) return false
  if (previous.titles.size !== titles.size) return false
  for (const [id, title] of titles) {
    if (!previous.titles.has(id) || previous.titles.get(id) !== title) return false
  }
  return true
}

/**
 * 选择侧栏真正需要的会话列表字段。
 *
 * assistant-ui 在输入文字时会重建 `threadItems` 数组；这里逐项比较条目 ID、
 * 标题与远端 ID，字段未变时复用上一次投影，使数组容器变化不再触发侧栏渲染。
 * 不序列化整条会话：只比较 UI 实际读取的字段。
 */
const useRemoteThreadProjection = (): RemoteThreadProjection => {
  const cached = useRef<RemoteThreadProjection | undefined>(undefined)
  const select = useMemo(
    () =>
      (current: AssistantState): RemoteThreadProjection => {
        const items = current.threads.threadItems
        const mainId = current.threads.mainThreadId
        const titles = new Map<string, string | undefined>()
        let mainRemoteId: string | undefined
        for (const item of items) {
          titles.set(item.id, item.title)
          // 本地映射 ID 与宿主 ID 并存时，两个键都可用于查找标题。
          if (item.remoteId && item.remoteId !== item.id) titles.set(item.remoteId, item.title)
          if (mainId && item.id === mainId) mainRemoteId = item.remoteId
        }
        // 经 initialize() 创建的远端会话保留本地映射 ID（__LOCALID_*），
        // 活动会话用 remoteId 回退为原 ID；与侧栏宿主会话 ID 比较。
        const activeThreadId = mainId ? (mainRemoteId ?? mainId) : undefined
        const previous = cached.current
        if (previous && sameRemoteThreadProjection(previous, titles, activeThreadId)) {
          return previous
        }
        const next = { titles, activeThreadId }
        cached.current = next
        return next
      },
    [],
  )
  return useAuiState(select)
}

/**
 * 单条会话行。
 *
 * 只接收自身需要的稳定字段：父级列表刷新（搜索、展开、选中）不应导致无关行
 * 重新执行；内部持久操作弹层按需挂载，关闭时不分配组件与 hook。
 */
function SessionRowComponent({
  thread,
  remoteTitle,
  unassigned = false,
  active,
  actionsDisabled,
}: {
  thread: HarnessThreadMetadata
  remoteTitle?: string
  unassigned?: boolean
  /** 当前窗口的活动会话；由父级比较后传入，避免每行持有最新 ID。 */
  active: boolean
  /** 工作区元数据不可用时禁用写操作。 */
  actionsDisabled: boolean
}) {
  const aui = useAui()
  const { refresh, showError, showNotice, selectWorkspace } = useWorkspaceActions()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const title = titleOf(thread, remoteTitle)
  const subtitle = [
    thread.workspacePath ? shortPath(thread.workspacePath) : undefined,
    formatActivity(thread.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ')
  const tooltip = [title, thread.workspacePath, thread.updatedAt].filter(Boolean).join('\n')

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
    if (next === (thread.name ?? '')) return
    void run(() => harnessHttpClient.renameThread(thread.id, next), '会话已改名。')
  }

  return (
    <div
      data-slot="huan-session-row"
      className={cn(
        'group relative flex min-h-9 items-center rounded-md transition-colors',
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
          title={tooltip}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 py-1 text-start text-sm',
            unassigned ? 'pe-8 group-hover:pe-16' : 'pe-8 group-hover:pe-9',
            'group-has-data-[popup-open]:pe-16',
          )}
          onClick={() => {
            if (thread.workspaceId) selectWorkspace(thread.workspaceId)
            void aui.threads.switchToThread(thread.id)
          }}
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
      )}
      <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-data-[popup-open]:opacity-100">
        {unassigned && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="加入工作区"
            disabled={actionsDisabled || busy}
            onClick={() => setAssignOpen(true)}
          >
            <FolderPlusIcon aria-hidden className="size-3.5" />
          </Button>
        )}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-6 data-popup-open:bg-accent"
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
                setDetailsOpen(true)
              }}
            >
              <InfoIcon aria-hidden className="size-4" />
              <Trans>详情</Trans>
            </button>
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
                setDeleteOpen(true)
              }}
            >
              <TrashIcon aria-hidden className="size-4" />
              <Trans>删除</Trans>
            </button>
          </PopoverContent>
        </Popover>
      </div>
      {assignOpen && <AssignWorkspaceDialog open onOpenChange={setAssignOpen} thread={thread} />}
      {detailsOpen && <ThreadDetailsDialog open onOpenChange={setDetailsOpen} thread={thread} />}
      {deleteOpen && (
        <DeleteThreadDialog open onOpenChange={setDeleteOpen} thread={thread} active={active} />
      )}
    </div>
  )
}

function sameSessionRowProps(
  previous: ComponentProps<typeof SessionRowComponent>,
  next: ComponentProps<typeof SessionRowComponent>,
) {
  // 目录重查会产生新元数据对象；只比较本行及其按需弹层实际使用的字段。
  const before = previous.thread
  const after = next.thread
  return (
    previous.active === next.active &&
    previous.actionsDisabled === next.actionsDisabled &&
    previous.unassigned === next.unassigned &&
    previous.remoteTitle === next.remoteTitle &&
    before.id === after.id &&
    before.title === after.title &&
    before.name === after.name &&
    before.workspacePath === after.workspacePath &&
    before.workspaceId === after.workspaceId &&
    before.status === after.status &&
    before.updatedAt === after.updatedAt &&
    before.archived === after.archived &&
    before.sessionFile === after.sessionFile
  )
}

const SessionRow = memo(SessionRowComponent, sameSessionRowProps)

function WorkspaceGroup({
  workspace,
  threads,
  recentThread,
  remoteTitles,
  activeThreadId,
  onManage,
  onNewSession,
}: {
  workspace: HarnessWorkspace
  threads: readonly HarnessThreadMetadata[]
  recentThread: HarnessThreadMetadata | undefined
  remoteTitles: ReadonlyMap<string, string | undefined>
  activeThreadId?: string
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
            // 继续最近只看活动时间与归档标记，不受当前搜索/排序/命名过滤影响。
            if (recentThread) {
              void aui.threads.switchToThread(recentThread.id)
              return
            }
            const startPath = startProjectFor(workspace)
            if (startPath) beginNewSession(workspace.id, startPath)
            void aui.threads.switchToNewThread()
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
                active={activeThreadId === thread.id}
                actionsDisabled={state !== 'ok'}
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
  const {
    workspaces,
    threads,
    expanded,
    state,
    refresh,
    selectWorkspace,
    toggleWorkspace,
    activeWorkspaceId,
  } = useWorkspace()
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<ThreadScope>('all')
  const [sort, setSort] = useState<ThreadSort>('recent')
  const [namedOnly, setNamedOnly] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [manager, setManager] = useState<{ open: boolean; workspace?: HarnessWorkspace }>({
    open: false,
  })
  const [newSession, setNewSession] = useState<HarnessWorkspace>()
  const intent = usePiIntent()
  // /new 打开现有“新建会话”弹层，由用户在弹层里确认起始项目。
  useEffect(() => {
    if (intent?.kind !== 'new-session') return
    const target =
      workspaces.find((workspace) => workspace.id === intent.payload?.workspaceId) ??
      workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    if (target) setNewSession(target)
    clearPiIntent(intent.id)
  }, [activeWorkspaceId, intent, workspaces])
  const remote = useRemoteThreadProjection()
  const remoteTitles = remote.titles
  const activeThreadId = remote.activeThreadId
  const syncedThreadRef = useRef<string | undefined>(undefined)
  // 新会话首次发送后 ID 才落到运行时；此时补一次宿主列表，避免侧栏要刷新页面才出现。
  useEffect(() => {
    if (!activeThreadId) return
    if (threads.some((thread) => thread.id === activeThreadId)) {
      syncedThreadRef.current = activeThreadId
      return
    }
    if (syncedThreadRef.current === activeThreadId) return
    syncedThreadRef.current = activeThreadId
    void refresh()
  }, [activeThreadId, refresh, threads])
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
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
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
      if (!thread.workspaceId || !workspaceIds.has(thread.workspaceId)) unassigned.push(thread)
      else {
        const list = byWorkspace.get(thread.workspaceId) ?? []
        list.push(thread)
        byWorkspace.set(thread.workspaceId, list)
      }
    }
    return { byWorkspace, unassigned: sortThreads(unassigned, sort) }
  }, [activeWorkspaceId, namedOnly, query, scope, showArchived, sort, threads, workspaces])

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
            onClick={() => void refresh({ rescan: true })}
          >
            <RefreshCwIcon aria-hidden className="size-4" />
          </Button>
          <ImportThreadButton />
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
            onValueChange={(value) => setScope((value ?? 'all') as ThreadScope)}
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
            onValueChange={(value) => setSort((value ?? 'recent') as ThreadSort)}
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
                threads={sortThreads(grouped.byWorkspace.get(workspace.id) ?? [], sort)}
                recentThread={recentByWorkspace.get(workspace.id)}
                remoteTitles={remoteTitles}
                activeThreadId={activeThreadId}
                onManage={(target) => setManager({ open: true, workspace: target })}
                onNewSession={(target) => {
                  selectWorkspace(target.id)
                  if (!expanded.has(target.id)) toggleWorkspace(target.id)
                  setNewSession(target)
                }}
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
                      remoteTitle={remoteTitles.get(thread.id)}
                      unassigned
                      active={activeThreadId === thread.id}
                      actionsDisabled={state !== 'ok'}
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
