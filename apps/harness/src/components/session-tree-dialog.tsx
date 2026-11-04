/**
 * 会话树面板：紧凑缩进列表、过滤、标签、摘要导航确认与取消摘要。
 *
 * 面板由 App 根挂载、入口在会话操作菜单；树数据、表单、busy、错误与取回
 * 文本都在 sessions feature Zustand；服务端 treeRevision 变化时只重读。
 * 导航返回的 editorText 只在来源版本仍有效时写入本窗草稿。
 */

import type { HarnessThreadTreeNode, HarnessTreeEntryKind } from '@huan/protocol'
import { useServiceStore, useWindowStore } from '@huan/react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  BotIcon,
  BoxesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import {
  buildSessionTreeIndex,
  projectSessionTree,
  type SessionTreeFilter,
  type SessionTreeVisibleRow,
} from '@/lib/session-tree-view'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state/app-context'

const kindIcon: Record<HarnessTreeEntryKind, typeof UserIcon> = {
  user: UserIcon,
  assistant: BotIcon,
  tool: WrenchIcon,
  summary: FileTextIcon,
  custom: BoxesIcon,
  state: MessageSquareIcon,
}

const formatNodeTime = (timestamp: string | undefined): string | undefined => {
  if (!timestamp) return undefined
  const time = new Date(timestamp)
  if (Number.isNaN(time.getTime())) return undefined
  return time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** 单行摘要、标签与跳转/分叉操作；分支入口额外提供折叠。 */
function TreeNodeRow({
  node,
  depth,
  branch,
  expanded,
  hiddenCount,
  contextOnly,
  first,
  selected,
  busy,
  onToggle,
  onNavigate,
  onEditLabel,
  onFork,
}: {
  node: HarnessThreadTreeNode
  depth: number
  branch: boolean
  expanded: boolean
  hiddenCount: number
  contextOnly: boolean
  first: boolean
  selected: boolean
  busy: boolean
  onToggle: () => void
  onNavigate: () => void
  onEditLabel: () => void
  onFork: () => void
}) {
  const { i18n } = useLingui()
  const Icon = kindIcon[node.kind]
  const time = formatNodeTime(node.timestamp)
  return (
    <div
      data-slot="huan-tree-row"
      data-entry-id={node.entryId}
      data-kind={node.kind}
      data-active={node.active ? 'true' : undefined}
      data-leaf={node.isLeaf ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-branch={branch ? 'true' : undefined}
      data-expanded={branch ? (expanded ? 'true' : 'false') : undefined}
      data-context-only={contextOnly ? 'true' : undefined}
      className={cn(
        'group hover:bg-muted/60 relative flex min-w-0 items-center gap-1.5 rounded-md py-1 pe-1 text-xs transition-colors',
        selected && 'bg-muted',
        contextOnly && 'text-muted-foreground',
        node.active && 'text-foreground',
        branch && !first && 'border-border/60 border-t',
      )}
      style={{ paddingInlineStart: depth * 14 }}
    >
      {depth > 0 && (
        <span
          aria-hidden
          className="bg-border/60 pointer-events-none absolute inset-y-0 w-px"
          style={{ insetInlineStart: depth * 14 - 7 }}
        />
      )}
      {branch ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={expanded ? i18n._(msg`收起分支`) : i18n._(msg`展开分支`)}
          aria-expanded={expanded}
          title={
            expanded
              ? i18n._(msg`收起分支：${node.summary}`)
              : i18n._(msg`展开分支：${node.summary}（另有 ${hiddenCount} 条）`)
          }
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {expanded ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        </Button>
      ) : depth > 0 ? (
        // 同深度的分支行带折叠按钮：非分支行保留等宽占位；depth 0 单链没有按钮，不留空位。
        <span aria-hidden className="size-6 shrink-0" />
      ) : null}
      <span
        aria-hidden
        data-slot="huan-tree-kind-icon"
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
      {hiddenCount > 0 && (
        <span className="text-muted-foreground/80 border-border/60 shrink-0 rounded border px-1 text-[10px] tabular-nums">
          <Trans>另有 {hiddenCount} 条</Trans>
        </span>
      )}
      {time && (
        <span className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">{time}</span>
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

/** 停止运行后取回的未发送消息；留在上下文条内，不随弹层关闭丢失。 */
export function SessionRecoveredQueue() {
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const tree = useSessionsStore((state) => state.tree)
  const dismissRecovered = useSessionsStore((state) => state.dismissRecoveredQueue)
  const restoreRecovered = useSessionsStore((state) => state.restoreRecoveredQueueItem)
  const { copyToClipboard } = useCopyToClipboard()
  const items = [
    ...(tree.recoveredQueue?.steering ?? []).map((content, index) => ({
      key: `steer:${index}`,
      mode: 'steer' as const,
      content,
    })),
    ...(tree.recoveredQueue?.followUp ?? []).map((content, index) => ({
      key: `followUp:${index}`,
      mode: 'followUp' as const,
      content,
    })),
  ]
  if (!threadId || tree.threadId !== threadId || items.length === 0) return null
  return (
    <div
      data-slot="huan-recovered-queue"
      role="status"
      className="w-full basis-full border-t bg-muted/40 px-3 py-2 text-xs"
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
          onClick={dismissRecovered}
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
              onClick={() => copyToClipboard(item.content)}
            >
              <CopyIcon aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="恢复到输入框"
              title="恢复到输入框"
              onClick={() => restoreRecovered(item.content)}
            >
              <MessageSquareIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 会话树面板：由会话操作菜单打开，自身不再渲染触发按钮。 */
export function SessionTreeDialog() {
  const { i18n } = useLingui()
  const tree = useSessionsStore((state) => state.tree)
  // 面板打开时固定会话；关闭动画期间不因选择重置而卸载或清空树。
  const threadId = tree.threadId
  const metadata = useServiceStore((state) => (threadId ? state.threadsById[threadId] : undefined))
  const navigation = useSessionsStore((state) => state.treeNavigation)
  const label = useSessionsStore((state) => state.treeLabel)
  const closeTree = useSessionsStore((state) => state.closeTree)
  const refreshTree = useSessionsStore((state) => state.refreshTree)
  const syncTreeRevision = useSessionsStore((state) => state.syncTreeRevision)
  const setFilter = useSessionsStore((state) => state.setTreeFilter)
  const setSearch = useSessionsStore((state) => state.setTreeSearch)
  const beginNavigation = useSessionsStore((state) => state.beginTreeNavigation)
  const setNavigationMode = useSessionsStore((state) => state.setTreeNavigationMode)
  const setNavigationInstructions = useSessionsStore((state) => state.setTreeNavigationInstructions)
  const setNavigationReplaceInstructions = useSessionsStore(
    (state) => state.setTreeNavigationReplaceInstructions,
  )
  const setNavigationReplaceDraft = useSessionsStore((state) => state.setTreeNavigationReplaceDraft)
  const cancelNavigationForm = useSessionsStore((state) => state.cancelTreeNavigationForm)
  const confirmNavigation = useSessionsStore((state) => state.confirmTreeNavigation)
  const beginLabel = useSessionsStore((state) => state.beginTreeLabel)
  const setLabelValue = useSessionsStore((state) => state.setTreeLabelValue)
  const cancelLabel = useSessionsStore((state) => state.cancelTreeLabel)
  const saveLabel = useSessionsStore((state) => state.saveTreeLabel)
  const cancelSummary = useSessionsStore((state) => state.cancelTreeNavigation)
  const openFork = useSessionsStore((state) => state.openFork)
  const toggleBranch = useSessionsStore((state) => state.toggleTreeBranch)
  // 官方 ScrollArea 不暴露 Viewport ref：根节点挂载后取唯一真实滚动元素。
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null)
  const bindListRoot = useCallback((node: HTMLDivElement | null) => {
    setScrollViewport(
      node?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null,
    )
  }, [])

  const operation = tree.tree?.operation ?? metadata?.treeOperation
  const summarizing = operation?.status === 'summarizing'
  const running = metadata?.status === 'running'

  useEffect(() => {
    if (tree.open) syncTreeRevision(metadata?.treeRevision)
  }, [metadata?.treeRevision, syncTreeRevision, tree.open])

  // 完整树索引只随快照变化；筛选、搜索与折叠再生成一次可见行。
  const index = useMemo(
    () => (tree.tree ? buildSessionTreeIndex(tree.tree.nodes) : undefined),
    [tree.tree],
  )
  const visibleRows = useMemo(
    () =>
      index
        ? projectSessionTree(index, {
            expanded: tree.expandedEntryIds,
            filter: tree.filter,
            search: tree.search,
          })
        : [],
    [index, tree.expandedEntryIds, tree.filter, tree.search],
  )

  // 以真实 Viewport 为滚动元素；行高由 measureElement 动态测量，标签表单也计入同一行。
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollViewport,
    estimateSize: () => 36,
    overscan: 6,
    getItemKey: (rowIndex) => visibleRows[rowIndex]?.node.entryId ?? rowIndex,
  })
  const virtualItems = virtualizer.getVirtualItems()

  // 定位 effect 通过 ref 读取最新可见行，避免展开/折叠引起的行重排也重置滚动位置。
  const visibleRowsRef = useRef<SessionTreeVisibleRow[]>([])
  useEffect(() => {
    visibleRowsRef.current = visibleRows
  }, [visibleRows])

  // 只在打开、选中/leaf、搜索或筛选变化时定位；滚动导致的虚拟行重渲染不触发跳转。
  // biome-ignore lint/correctness/useExhaustiveDependencies: leaf/搜索/筛选变化需要重新定位，可见行由 ref 读取。
  useEffect(() => {
    if (!tree.open || !scrollViewport) return
    const selectedEntryId = tree.selectedEntryId
    if (!selectedEntryId) return
    const rows = visibleRowsRef.current
    const visibleIndices = new Map(rows.map((row, rowIndex) => [row.node.entryId, rowIndex]))
    // 当前落点可能是筛选隐藏的状态记录；定位最近的可见祖先，保留叶子身份本身。
    let targetId: string | null | undefined = selectedEntryId
    let rowIndex = visibleIndices.get(targetId)
    while (rowIndex === undefined && targetId) {
      targetId = index?.parentById.get(targetId)
      if (targetId) rowIndex = visibleIndices.get(targetId)
    }
    if (rowIndex === undefined) return
    // 本版 react-virtual 没有 nearest 字面量：auto 仅在行不可见时按最近边滚动。
    virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }, [
    tree.open,
    tree.selectedEntryId,
    tree.tree?.leafId,
    tree.search,
    tree.filter,
    scrollViewport,
    index,
    virtualizer,
  ])

  const filters: Array<{ value: SessionTreeFilter; label: string }> = [
    { value: 'conversation', label: i18n._(msg`对话`) },
    { value: 'tools', label: i18n._(msg`工具`) },
    { value: 'all', label: i18n._(msg`全部`) },
    { value: 'labeled', label: i18n._(msg`已标记`) },
  ]
  // 桌面放宽到 896px；官方基础 max-w-[calc(100%-2rem)] 继续提供移动端安全边距，高度不变。
  return (
    <Dialog
      open={tree.open}
      onOpenChange={(next) => {
        if (!next) closeTree()
      }}
    >
      <DialogContent
        aria-label={i18n._(msg`会话树`)}
        className="flex h-[min(82dvh,44rem)] flex-col sm:max-w-4xl"
      >
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
            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            {summarizing ? (
              <>
                <span>
                  <Trans>正在生成分支摘要（可能计费）…</Trans>
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  className="ms-auto"
                  onClick={() => void cancelSummary()}
                >
                  <Trans>取消摘要</Trans>
                </Button>
              </>
            ) : (
              <span>
                {operation.kind === 'label' ? (
                  <Trans>正在保存标签…</Trans>
                ) : (
                  <Trans>正在切换会话上下文…</Trans>
                )}
              </span>
            )}
          </div>
        )}

        {tree.error && (
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/10 text-destructive rounded-md border px-2.5 py-1.5 text-xs"
          >
            {tree.error}
          </div>
        )}
        {tree.notice && !tree.error && (
          <div role="status" className="bg-muted/50 rounded-md px-2.5 py-1.5 text-xs">
            {tree.notice}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            className="h-7 max-w-52 text-xs"
            placeholder={i18n._(msg`搜索摘要、标签或 ID`)}
            aria-label={i18n._(msg`搜索会话树`)}
            value={tree.search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex items-center gap-0.5">
            {filters.map((item) => (
              <Button
                key={item.value}
                variant={tree.filter === item.value ? 'secondary' : 'ghost'}
                size="xs"
                aria-pressed={tree.filter === item.value}
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
            disabled={tree.loading || tree.busy}
            onClick={() => void refreshTree()}
          >
            {tree.loading ? (
              <Loader2Icon aria-hidden className="animate-spin" />
            ) : (
              <RefreshCwIcon aria-hidden />
            )}
          </Button>
        </div>

        <ScrollArea
          ref={bindListRoot}
          data-slot="huan-tree-list"
          data-total-count={visibleRows.length}
          className={cn(
            'flex min-h-0 flex-1 flex-col rounded-md border border-border/70',
            '*:data-[slot=scroll-area-viewport]:flex-1',
          )}
        >
          <div className="p-1">
            {tree.loading && !tree.tree ? (
              <div className="text-muted-foreground flex items-center gap-2 p-2 text-xs">
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                <Trans>正在读取会话树…</Trans>
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="text-muted-foreground p-2 text-xs">
                {tree.tree?.nodes.length === 0 ? (
                  <Trans>该会话还没有条目。</Trans>
                ) : (
                  <Trans>没有匹配的节点。</Trans>
                )}
              </div>
            ) : (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualItems.map((virtualRow) => {
                  const row = visibleRows[virtualRow.index]
                  if (!row) return null
                  const node = row.node
                  return (
                    <div
                      key={node.entryId}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <TreeNodeRow
                        node={node}
                        depth={row.depth}
                        branch={row.branch}
                        expanded={row.expanded}
                        hiddenCount={row.hiddenCount}
                        contextOnly={row.contextOnly === true}
                        first={virtualRow.index === 0}
                        selected={tree.selectedEntryId === node.entryId}
                        busy={tree.busy || operation !== undefined}
                        onToggle={() => toggleBranch(node.entryId)}
                        onNavigate={() => beginNavigation(node)}
                        onEditLabel={() => beginLabel(node.entryId)}
                        onFork={() => {
                          if (!threadId) return
                          openFork({
                            threadId,
                            position: 'before',
                            entryId: node.entryId,
                          })
                        }}
                      />
                      {label?.entryId === node.entryId && (
                        <div className="bg-muted/40 mt-1 flex items-center gap-1.5 rounded-md p-1.5">
                          <Input
                            autoFocus
                            className="h-6 text-xs"
                            aria-label={i18n._(msg`节点标签`)}
                            placeholder={i18n._(msg`留空即清除标签`)}
                            value={label.value}
                            onChange={(event) => setLabelValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveLabel()
                              if (event.key === 'Escape') cancelLabel()
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={i18n._(msg`保存标签`)}
                            disabled={tree.busy}
                            onClick={() => void saveLabel()}
                          >
                            <CheckIcon aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={i18n._(msg`取消编辑标签`)}
                            onClick={cancelLabel}
                          >
                            <XIcon aria-hidden />
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </ScrollArea>

        {navigation && tree.tree && (
          <div
            data-slot="huan-tree-navigate-panel"
            className="border-border/70 flex flex-col gap-2 rounded-md border p-2.5 text-xs"
          >
            <div className="min-w-0">
              <span className="text-muted-foreground">
                <Trans>跳转到</Trans>{' '}
              </span>
              <span className="font-medium">{navigation.node.summary}</span>
            </div>
            {running && (
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
                ] as Array<['none' | 'summarize' | 'custom', string]>
              ).map(([value, text]) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="tree-summary-mode"
                    value={value}
                    checked={navigation.mode === value}
                    onChange={() => setNavigationMode(value)}
                  />
                  <span>{text}</span>
                </label>
              ))}
            </fieldset>
            {navigation.mode === 'custom' && (
              <>
                <Textarea
                  className="min-h-14 text-xs"
                  aria-label={i18n._(msg`自定义摘要指令`)}
                  placeholder={i18n._(msg`例如：重点保留文件改动与失败命令`)}
                  value={navigation.instructions}
                  onChange={(event) => setNavigationInstructions(event.target.value)}
                />
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={navigation.replaceInstructions}
                    onChange={(event) => setNavigationReplaceInstructions(event.target.checked)}
                  />
                  <span>
                    <Trans>用自定义指令替换默认摘要提示</Trans>
                  </span>
                </label>
              </>
            )}
            {navigation.draftNonEmpty ||
            navigation.node.kind === 'user' ||
            navigation.node.kind === 'custom' ? (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={navigation.replaceDraft}
                  onChange={(event) => setNavigationReplaceDraft(event.target.checked)}
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
                disabled={tree.busy}
                onClick={cancelNavigationForm}
              >
                <Trans>取消</Trans>
              </Button>
              <Button
                size="xs"
                disabled={
                  tree.busy || (navigation.mode === 'custom' && !navigation.instructions.trim())
                }
                onClick={() => void confirmNavigation()}
              >
                {tree.busy ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
                {running ? <Trans>停止并跳转</Trans> : <Trans>确认跳转</Trans>}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={tree.loading}
            onClick={() => void refreshTree()}
          >
            <RefreshCwIcon aria-hidden />
            <Trans>刷新</Trans>
          </Button>
          <Button variant="outline" size="sm" onClick={closeTree}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
