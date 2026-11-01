/**
 * 会话树面板：紧凑缩进列表、标签、过滤与导航。
 *
 * 树数据按需读取；快照中的 leafId/treeRevision/treeOperation 是权威状态。
 * 导航返回的 editorText 只用于本窗口编辑器，其他窗口仅由快照更新历史。
 */
import type { ThreadMessage } from '@assistant-ui/react'
import { useAui, useAuiState } from '@assistant-ui/react'
import type {
  HarnessThreadTree,
  HarnessThreadTreeNode,
  HarnessTreeEntryKind,
  HarnessTreeQueueRecovery,
} from '@huan/protocol'
import { useHarnessController, useHarnessThreadState } from '@huan/react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import {
  BotIcon,
  BoxesIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  GitForkIcon,
  Loader2Icon,
  MessageSquareIcon,
  RefreshCwIcon,
  TagIcon,
  UserIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearPiIntent, usePiIntent } from '@/components/pi-command-intents'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'
import { ForkThreadDialog } from './session-fork-dialog'
import {
  consumeSessionTreeTarget,
  openSessionTreeAt,
  useSessionTreeTarget,
} from './session-tree-bridge'

type TreeFilter = 'conversation' | 'tools' | 'all' | 'labeled'

type SummaryMode = 'none' | 'summarize' | 'custom'

type PendingNavigation = {
  node: HarnessThreadTreeNode
  mode: SummaryMode
  instructions: string
  replaceInstructions: boolean
  replaceDraft: boolean
}

type RecoveredQueue = {
  threadId: string
  queue: HarnessTreeQueueRecovery
}

const PENDING_ID = '__pending__'

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 树行的紧凑时间（仅时分；无时间戳时不显示）。 */
const formatNodeTime = (timestamp: string | undefined): string | undefined => {
  if (!timestamp) return undefined
  const time = new Date(timestamp)
  if (Number.isNaN(time.getTime())) return undefined
  return time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const kindIcon: Record<HarnessTreeEntryKind, typeof UserIcon> = {
  user: UserIcon,
  assistant: BotIcon,
  tool: WrenchIcon,
  summary: FileTextIcon,
  custom: BoxesIcon,
  state: MessageSquareIcon,
}

/** 单行摘要、标签与跳转操作；缩进由扁平列表计算。 */
function TreeNodeRow({
  node,
  depth,
  selected,
  busy,
  onNavigate,
  onEditLabel,
  onFork,
}: {
  node: HarnessThreadTreeNode
  depth: number
  selected: boolean
  busy: boolean
  onNavigate: () => void
  onEditLabel: () => void
  onFork: () => void
}) {
  const Icon = kindIcon[node.kind]
  return (
    <div
      data-slot="huan-tree-row"
      data-entry-id={node.entryId}
      data-kind={node.kind}
      data-active={node.active ? 'true' : undefined}
      data-leaf={node.isLeaf ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cn(
        'group hover:bg-muted/60 flex min-w-0 items-center gap-1.5 rounded-md py-1 pe-1 text-xs transition-colors',
        selected && 'bg-muted',
        node.active && 'text-foreground',
      )}
      style={{ paddingInlineStart: 6 + depth * 14 }}
    >
      <span
        aria-hidden
        title={node.role ?? node.entryType}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded',
          node.active ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          node.kind === 'state' && 'text-muted-foreground italic',
          node.isLeaf && 'font-medium',
        )}
        title={node.summary}
      >
        {node.summary}
      </span>
      {formatNodeTime(node.timestamp) && (
        <span className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
          {formatNodeTime(node.timestamp)}
        </span>
      )}
      {node.label && (
        <span className="bg-secondary text-secondary-foreground inline-flex max-w-28 shrink-0 items-center gap-0.5 truncate rounded px-1 py-0.5">
          <TagIcon aria-hidden className="size-2.5" />
          {node.label}
        </span>
      )}
      {node.isLeaf && (
        <span className="text-primary shrink-0 text-[10px]">
          <Trans>当前</Trans>
        </span>
      )}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={node.label ? '编辑标签' : '设置标签'}
          title={node.label ? '编辑标签' : '设置标签'}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            onEditLabel()
          }}
        >
          <TagIcon aria-hidden />
        </Button>
        {node.kind === 'user' && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="从这条消息分叉"
            title="从这条消息分叉"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onFork()
            }}
          >
            <GitForkIcon aria-hidden />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="跳转到此节点"
          title="跳转到此节点"
          disabled={busy || node.isLeaf}
          onClick={(event) => {
            event.stopPropagation()
            onNavigate()
          }}
        >
          <GitBranchIcon aria-hidden />
        </Button>
      </span>
    </div>
  )
}

/** 被取回的队列：复制或显式恢复到输入框，不自动发送。 */
function RecoveredQueueBar({
  recovered,
  onRestore,
  onCopy,
  onClose,
}: {
  recovered: RecoveredQueue
  onRestore: (text: string) => void
  onCopy: (text: string) => void
  onClose: () => void
}) {
  const items = [
    ...recovered.queue.steering.map((content, index) => ({
      key: `steer:${index}`,
      mode: 'steer' as const,
      content,
    })),
    ...recovered.queue.followUp.map((content, index) => ({
      key: `followUp:${index}`,
      mode: 'followUp' as const,
      content,
    })),
  ]
  return (
    <div
      data-slot="huan-recovered-queue"
      role="status"
      className="border-b bg-muted/40 px-4 py-2 text-xs basis-full w-full"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">
          <Trans>停止运行后取回 {items.length} 条未发送消息</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>不会自动发送；可复制或恢复到输入框。</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ms-auto"
          aria-label="关闭取回队列"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-2">
            <span className="text-muted-foreground w-14 shrink-0">
              {item.mode === 'steer' ? <Trans>引导</Trans> : <Trans>后续</Trans>}
            </span>
            <span className="min-w-0 flex-1 truncate" title={item.content}>
              {item.content}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="复制取回消息"
              title="复制"
              onClick={() => onCopy(item.content)}
            >
              <CopyIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="恢复到输入框"
              title="恢复到输入框"
              onClick={() => onRestore(item.content)}
            >
              <MessageSquareIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 会话树按钮、面板与取回队列的宿主组件。 */
export function SessionTreeDialog() {
  const metadata = useHarnessThreadState((state) => state.metadata)
  const controller = useHarnessController()
  const aui = useAui()
  const { i18n } = useLingui()
  const { copyToClipboard } = useCopyToClipboard()
  const threadId = metadata.id
  const pendingThread = !threadId || threadId === PENDING_ID
  const locateTarget = useSessionTreeTarget()

  const [open, setOpen] = useState(false)
  const [tree, setTree] = useState<HarnessThreadTree>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [filter, setFilter] = useState<TreeFilter>('conversation')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>()
  // 打开导航确认时记录草稿是否非空；不在组件顶层订阅输入文字，
  // 真正执行导航时再读取最新草稿。
  const [draftNonEmpty, setDraftNonEmpty] = useState(false)
  const [editingLabel, setEditingLabel] = useState<{ entryId: string; value: string }>()
  const [forkTarget, setForkTarget] = useState<HarnessThreadTreeNode>()
  const [recovered, setRecovered] = useState<RecoveredQueue>()
  const listRef = useRef<HTMLDivElement>(null)
  const requestGeneration = useRef(0)
  const currentThread = useRef(threadId)
  currentThread.current = threadId
  const intent = usePiIntent()

  // /tree、/fork 打开同一树面板；空白页不创建会话，只给出原因。
  useEffect(() => {
    if (intent?.kind !== 'session-tree') return
    if (pendingThread) {
      setNotice('先建立或打开会话后才能使用会话树。')
    } else {
      setOpen(true)
    }
    clearPiIntent(intent.id)
  }, [intent, pendingThread])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 会话切换时清除面板局部状态并作废旧请求
  useEffect(() => {
    setTree(undefined)
    setPendingNavigation(undefined)
    setDraftNonEmpty(false)
    setEditingLabel(undefined)
    setForkTarget(undefined)
    return () => {
      requestGeneration.current += 1
    }
  }, [threadId])

  const refreshTree = useCallback(
    async (clearError = false) => {
      if (pendingThread) return
      const generation = ++requestGeneration.current
      if (clearError) setError(undefined)
      setLoading(true)
      try {
        // 先刷新快照以取得最新的 messageEntryIds（历史消息定位依据），
        // 再按需读取树；两者都不执行项目扩展。
        await controller.refresh().catch(() => {})
        const next = await controller.getThreadTree()
        if (generation === requestGeneration.current) setTree(next)
      } catch (caught) {
        if (generation === requestGeneration.current) setError(errorMessage(caught))
      } finally {
        if (generation === requestGeneration.current) setLoading(false)
      }
    },
    [controller, pendingThread],
  )

  // 历史用户消息的定位入口。
  useEffect(() => {
    if (!locateTarget) return
    setOpen(true)
    setSelectedId(locateTarget)
    setFilter('all')
    setSearch('')
    void refreshTree(true)
    consumeSessionTreeTarget()
  }, [locateTarget, refreshTree])

  // 打开时读取当前状态：操作可能在其他窗口发起，重新打开仍能看到。
  useEffect(() => {
    if (!open) return
    void refreshTree(true)
  }, [open, refreshTree])

  // 其他窗口导航/标签后 revision 变化：面板打开时自动重读，保持活动路径与标签同步。
  const currentRevision = metadata.treeRevision
  useEffect(() => {
    if (!open || !tree || !currentRevision) return
    if (tree.revision === currentRevision) return
    void refreshTree()
  }, [open, currentRevision, tree, refreshTree])

  // 选中的节点滚动到可视区域（树加载完成后也需要重新定位）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tree 变化表示重新加载完成
  useEffect(() => {
    if (!selectedId || !open) return
    const container = listRef.current
    const row = container?.querySelector<HTMLElement>(`[data-entry-id="${selectedId}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, open, tree])

  const operation = metadata.treeOperation
  const summarizing = operation?.status === 'summarizing'

  const updateComposer = (text: string) => {
    const current = aui.composer.getState().text
    const next = current.trim() ? `${current}\n\n${text}` : text
    aui.composer.setText(next)
  }

  const mergeRecovered = (queue: HarnessTreeQueueRecovery | undefined) => {
    if (!queue || (queue.steering.length === 0 && queue.followUp.length === 0)) return
    setRecovered((current) => {
      const base =
        current && current.threadId === threadId ? current.queue : { steering: [], followUp: [] }
      return {
        threadId,
        queue: {
          steering: [...base.steering, ...queue.steering],
          followUp: [...base.followUp, ...queue.followUp],
        },
      }
    })
  }

  const startNavigation = (node: HarnessThreadTreeNode) => {
    const draft = aui.composer.getState().text
    setDraftNonEmpty(draft.trim().length > 0)
    setPendingNavigation({
      node,
      mode: 'none',
      instructions: '',
      replaceInstructions: false,
      replaceDraft: draft.trim().length > 0,
    })
  }

  const confirmNavigation = async () => {
    if (!pendingNavigation || !tree) return
    const { node, mode, instructions, replaceInstructions, replaceDraft } = pendingNavigation
    const draft = aui.composer.getState().text
    const running = metadata.status === 'running'
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await controller.navigateThreadTree({
        targetId: node.entryId,
        expectedRevision: tree.revision,
        ...(mode !== 'none' ? { summarize: true } : {}),
        ...(mode !== 'none' && instructions.trim()
          ? { customInstructions: instructions.trim() }
          : {}),
        ...(mode === 'custom' ? { replaceInstructions } : {}),
        ...(running ? { stopRunning: true } : {}),
      })
      mergeRecovered(result.recoveredQueue)
      if (currentThread.current !== threadId) return
      if (result.status === 'applied') {
        // 空草稿直接接收节点原文；非空草稿只在用户确认“替换”后覆盖。
        if (result.editorText !== undefined && (draft.trim().length === 0 || replaceDraft)) {
          aui.composer.setText(result.editorText)
        } else if (result.editorText === undefined && replaceDraft) {
          aui.composer.setText('')
        }
        setNotice(
          result.summaryCommitted
            ? i18n._(msg`已跳转，并已写入分支摘要。`)
            : i18n._(msg`已跳转到所选节点。`),
        )
        setPendingNavigation(undefined)
      } else if (result.status === 'conflict') {
        setError(i18n._(msg`会话树已变化，已刷新，请重新选择。`))
        setPendingNavigation(undefined)
      } else if (result.status === 'aborted') {
        setNotice(i18n._(msg`分支摘要已取消，活动落点未改变。`))
      } else {
        setError(result.message ?? i18n._(msg`导航未完成。`))
      }
      if (result.status !== 'applied' && result.status !== 'conflict') {
        // 保留草稿与目标选择，允许用户重试或取消。
      }
      await refreshTree()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const saveLabel = async () => {
    if (!editingLabel || !tree) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await controller.setThreadEntryLabel({
        entryId: editingLabel.entryId,
        ...(editingLabel.value.trim() ? { label: editingLabel.value.trim() } : {}),
        expectedRevision: tree.revision,
      })
      if (result.status === 'applied') {
        setEditingLabel(undefined)
        setNotice(i18n._(msg`标签已保存。`))
        if (result.persistence === 'failed') {
          setError(result.message ?? i18n._(msg`标签已写入，但落点水位更新失败。`))
        }
      } else {
        setError(result.message ?? i18n._(msg`保存标签失败。`))
      }
      await refreshTree()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const cancelSummary = async () => {
    // 摘要请求进行中时 confirmNavigation 仍占用 busy；取消是独立信令，
    // 不能被全局 busy 禁用。
    setCancelling(true)
    try {
      const result = await controller.cancelThreadTreeNavigation()
      setNotice(
        result.status === 'cancelled'
          ? i18n._(msg`正在取消分支摘要…`)
          : i18n._(msg`当前没有可取消的分支摘要。`),
      )
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setCancelling(false)
    }
  }

  const visibleNodes = useMemo(() => {
    if (!tree) return [] as Array<{ node: HarnessThreadTreeNode; depth: number }>
    const needle = search.trim().toLowerCase()
    const matches = (node: HarnessThreadTreeNode): boolean => {
      if (filter === 'conversation') {
        return (
          node.kind === 'user' ||
          node.kind === 'assistant' ||
          node.kind === 'summary' ||
          node.kind === 'custom'
        )
      }
      if (filter === 'tools') return node.kind === 'tool' || node.hasToolCalls === true
      if (filter === 'labeled') return node.label !== undefined
      return true
    }
    const visibleIds = new Set<string>()
    for (const node of tree.nodes) {
      if (!matches(node)) continue
      if (needle) {
        const haystack =
          `${node.summary} ${node.label ?? ''} ${node.role ?? ''} ${node.entryId}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      visibleIds.add(node.entryId)
    }
    // 过滤后按最近可见祖先重新计算紧凑缩进（单次先序，O(n)）。
    const depthById = new Map<string, number>()
    const rendered: Array<{ node: HarnessThreadTreeNode; depth: number }> = []
    for (const node of tree.nodes) {
      const parentDepth = node.parentId ? depthById.get(node.parentId) : undefined
      const visibleParent = node.parentId !== null && visibleIds.has(node.parentId)
      const depth =
        node.parentId === null || parentDepth === undefined
          ? 0
          : parentDepth + (visibleParent ? 1 : 0)
      depthById.set(node.entryId, depth)
      if (visibleIds.has(node.entryId)) rendered.push({ node, depth })
    }
    return rendered
  }, [tree, filter, search])

  if (pendingThread) return null

  const filters: Array<{ value: TreeFilter; label: string }> = [
    { value: 'conversation', label: i18n._(msg`对话`) },
    { value: 'tools', label: i18n._(msg`工具`) },
    { value: 'all', label: i18n._(msg`全部`) },
    { value: 'labeled', label: i18n._(msg`已标记`) },
  ]

  return (
    <>
      {forkTarget && (
        <ForkThreadDialog
          open
          onOpenChange={(next) => {
            if (!next) setForkTarget(undefined)
          }}
          position="before"
          entryId={forkTarget.entryId}
          onCompleted={() => {
            setForkTarget(undefined)
            setOpen(false)
          }}
        />
      )}
      <Button
        variant="ghost"
        size="xs"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label={i18n._(msg`会话树`)}
        onClick={() => setOpen(true)}
      >
        <GitBranchIcon aria-hidden className="size-3.5" />
        <Trans>会话树</Trans>
      </Button>

      {recovered && recovered.threadId === threadId && (
        <RecoveredQueueBar
          recovered={recovered}
          onCopy={copyToClipboard}
          onRestore={updateComposer}
          onClose={() => setRecovered(undefined)}
        />
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setPendingNavigation(undefined)
        }}
      >
        <DialogContent aria-label={i18n._(msg`会话树`)} className="flex max-h-[82vh] flex-col">
          <DialogHeader>
            <DialogTitle>
              <Trans>会话树</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                跳转只改变会话上下文，不恢复项目文件。运行中导航会先停止当前响应并取回未发送队列。
              </Trans>
            </DialogDescription>
          </DialogHeader>

          {operation && (
            <div
              role="status"
              data-slot="huan-tree-operation"
              className="border-primary/20 bg-primary/5 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
            >
              {summarizing ? (
                <>
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                  <span>
                    <Trans>正在生成分支摘要（可能计费）…</Trans>
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    className="ms-auto"
                    disabled={cancelling}
                    onClick={() => void cancelSummary()}
                  >
                    <Trans>取消摘要</Trans>
                  </Button>
                </>
              ) : (
                <>
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                  <span>
                    {operation.kind === 'label' ? (
                      <Trans>正在保存标签…</Trans>
                    ) : (
                      <Trans>正在切换会话上下文…</Trans>
                    )}
                  </span>
                </>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="border-destructive/20 bg-destructive/10 text-destructive rounded-md border px-2.5 py-1.5 text-xs"
            >
              {error}
            </div>
          )}
          {notice && !error && (
            <div role="status" className="bg-muted/50 rounded-md px-2.5 py-1.5 text-xs">
              {notice}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              className="h-7 max-w-52 text-xs"
              placeholder={i18n._(msg`搜索摘要、标签或 ID`)}
              aria-label={i18n._(msg`搜索会话树`)}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex items-center gap-0.5">
              {filters.map((item) => (
                <Button
                  key={item.value}
                  variant={filter === item.value ? 'secondary' : 'ghost'}
                  size="xs"
                  aria-pressed={filter === item.value}
                  onClick={() => setFilter(item.value)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ms-auto"
              aria-label={i18n._(msg`刷新会话树`)}
              disabled={loading || busy}
              onClick={() => void refreshTree(true)}
            >
              {loading ? (
                <Loader2Icon aria-hidden className="animate-spin" />
              ) : (
                <RefreshCwIcon aria-hidden />
              )}
            </Button>
          </div>

          <div
            ref={listRef}
            data-slot="huan-tree-list"
            className="border-border/70 min-h-24 flex-1 overflow-auto rounded-md border p-1"
          >
            {loading && !tree ? (
              <div className="text-muted-foreground flex items-center gap-2 p-2 text-xs">
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                <Trans>正在读取会话树…</Trans>
              </div>
            ) : visibleNodes.length === 0 ? (
              <div className="text-muted-foreground p-2 text-xs">
                {tree?.nodes.length === 0 ? (
                  <Trans>该会话还没有条目。</Trans>
                ) : (
                  <Trans>没有匹配的节点。</Trans>
                )}
              </div>
            ) : (
              visibleNodes.map(({ node, depth }) => (
                <div key={node.entryId}>
                  <TreeNodeRow
                    node={node}
                    depth={depth}
                    selected={selectedId === node.entryId}
                    busy={busy || operation !== undefined}
                    onNavigate={() => startNavigation(node)}
                    onEditLabel={() => {
                      setEditingLabel({ entryId: node.entryId, value: node.label ?? '' })
                      setSelectedId(node.entryId)
                    }}
                    onFork={() => setForkTarget(node)}
                  />
                  {editingLabel?.entryId === node.entryId && (
                    <div className="bg-muted/40 mb-1 flex items-center gap-1.5 rounded-md p-1.5">
                      <Input
                        autoFocus
                        className="h-6 text-xs"
                        aria-label={i18n._(msg`节点标签`)}
                        placeholder={i18n._(msg`留空即清除标签`)}
                        value={editingLabel.value}
                        onChange={(event) =>
                          setEditingLabel({ entryId: node.entryId, value: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveLabel()
                          if (event.key === 'Escape') setEditingLabel(undefined)
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={i18n._(msg`保存标签`)}
                        disabled={busy}
                        onClick={() => void saveLabel()}
                      >
                        <CheckIcon aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={i18n._(msg`取消编辑标签`)}
                        onClick={() => setEditingLabel(undefined)}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {pendingNavigation && (
            <div
              data-slot="huan-tree-navigate-panel"
              className="border-border/70 flex flex-col gap-2 rounded-md border p-2.5 text-xs"
            >
              <div className="min-w-0">
                <span className="text-muted-foreground">
                  <Trans>跳转到</Trans>{' '}
                </span>
                <span className="font-medium">{pendingNavigation.node.summary}</span>
              </div>
              {metadata.status === 'running' && (
                <div className="text-destructive">
                  <Trans>
                    当前响应仍在运行。确认后将停止响应、取回未发送队列，再切换上下文；该操作不会自动发送任何消息。
                  </Trans>
                </div>
              )}
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-muted-foreground mb-1">
                  <Trans>分支摘要</Trans>
                </legend>
                {(
                  [
                    ['none', i18n._(msg`不摘要（只切换上下文）`)],
                    ['summarize', i18n._(msg`生成摘要（调用模型，可能计费）`)],
                    ['custom', i18n._(msg`自定义摘要指令`)],
                  ] as Array<[SummaryMode, string]>
                ).map(([value, label]) => (
                  <label key={value} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="tree-summary-mode"
                      value={value}
                      checked={pendingNavigation.mode === value}
                      onChange={() => setPendingNavigation({ ...pendingNavigation, mode: value })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              {tree && (
                <p className="text-muted-foreground">
                  {tree.branchSummarySkipPrompt ? (
                    <Trans>Pi 设置当前默认跳过摘要；这里仍可显式选择。</Trans>
                  ) : (
                    <Trans>Pi 设置默认询问摘要；这里默认不摘要，避免意外计费。</Trans>
                  )}
                </p>
              )}
              {pendingNavigation.mode === 'custom' && (
                <>
                  <Textarea
                    className="min-h-14 text-xs"
                    aria-label={i18n._(msg`自定义摘要指令`)}
                    placeholder={i18n._(msg`例如：重点保留文件改动与失败命令`)}
                    value={pendingNavigation.instructions}
                    onChange={(event) =>
                      setPendingNavigation({
                        ...pendingNavigation,
                        instructions: event.target.value,
                      })
                    }
                  />
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={pendingNavigation.replaceInstructions}
                      onChange={(event) =>
                        setPendingNavigation({
                          ...pendingNavigation,
                          replaceInstructions: event.target.checked,
                        })
                      }
                    />
                    <span>
                      <Trans>用自定义指令替换默认摘要提示</Trans>
                    </span>
                  </label>
                </>
              )}
              {draftNonEmpty ||
              pendingNavigation.node.kind === 'user' ||
              pendingNavigation.node.kind === 'custom' ? (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={pendingNavigation.replaceDraft}
                    onChange={(event) =>
                      setPendingNavigation({
                        ...pendingNavigation,
                        replaceDraft: event.target.checked,
                      })
                    }
                  />
                  <span>
                    <Trans>确认替换当前输入框草稿；所选节点没有原文时清空</Trans>
                  </span>
                </label>
              ) : null}
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => setPendingNavigation(undefined)}
                >
                  <Trans>取消</Trans>
                </Button>
                <Button
                  size="xs"
                  disabled={
                    busy ||
                    (pendingNavigation.mode === 'custom' && !pendingNavigation.instructions.trim())
                  }
                  onClick={() => void confirmNavigation()}
                >
                  {busy ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
                  {metadata.status === 'running' ? (
                    <Trans>停止并跳转</Trans>
                  ) : (
                    <Trans>确认跳转</Trans>
                  )}
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void refreshTree(true)}
            >
              <RefreshCwIcon aria-hidden />
              <Trans>刷新</Trans>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              <Trans>关闭</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 历史用户消息的动作：定位到对应会话树节点（entryId 由投影提供）。 */
/** 当前消息对应的真实 Pi entryId（投影提供；缺失表示尚未落盘）。 */
export function useSourceEntryId(): string | undefined {
  return useAuiState((state) => {
    const metadata = state.message.metadata as ThreadMessage['metadata'] | undefined
    const custom = metadata?.custom as { pi?: { sourceEntryId?: unknown } } | undefined
    return typeof custom?.pi?.sourceEntryId === 'string' ? custom.pi.sourceEntryId : undefined
  })
}

export function LocateTreeEntryButton({ className }: { className?: string }) {
  const sourceEntryId = useSourceEntryId()
  const { i18n } = useLingui()
  if (!sourceEntryId) return null
  return (
    <button
      type="button"
      className={cn(
        'text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors',
        className,
      )}
      aria-label={i18n._(msg`在会话树中定位`)}
      title={i18n._(msg`在会话树中定位`)}
      onClick={() => openSessionTreeAt(sourceEntryId)}
    >
      <GitBranchIcon aria-hidden className="size-4" />
    </button>
  )
}
