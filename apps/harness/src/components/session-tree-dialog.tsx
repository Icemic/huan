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
import { useEffect, useMemo, useRef } from 'react'
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
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state/app-context'
import type { SessionTreeFilter } from '@/state/sessions-store'

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

/** 单行摘要、标签与跳转/分叉操作。 */
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
  const time = formatNodeTime(node.timestamp)
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
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const metadata = useServiceStore((state) => (threadId ? state.threadsById[threadId] : undefined))
  const tree = useSessionsStore((state) => state.tree)
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
  const listRef = useRef<HTMLDivElement>(null)

  const operation = tree.tree?.operation ?? metadata?.treeOperation
  const summarizing = operation?.status === 'summarizing'
  const running = metadata?.status === 'running'

  useEffect(() => {
    if (tree.open) syncTreeRevision(metadata?.treeRevision)
  }, [metadata?.treeRevision, syncTreeRevision, tree.open])

  // 选中节点滚动到可视区域；树加载完成后也重新定位。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tree.tree 变化表示加载完成，需要重新定位选中行。
  useEffect(() => {
    if (!tree.selectedEntryId || !tree.open) return
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-entry-id="${tree.selectedEntryId}"]`,
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [tree.selectedEntryId, tree.open, tree.tree])

  const visibleNodes = useMemo(() => {
    if (!tree.tree) return [] as Array<{ node: HarnessThreadTreeNode; depth: number }>
    const needle = tree.search.trim().toLowerCase()
    const matches = (node: HarnessThreadTreeNode): boolean => {
      if (tree.filter === 'conversation') {
        return (
          node.kind === 'user' ||
          node.kind === 'assistant' ||
          node.kind === 'summary' ||
          node.kind === 'custom'
        )
      }
      if (tree.filter === 'tools') return node.kind === 'tool' || node.hasToolCalls === true
      if (tree.filter === 'labeled') return node.label !== undefined
      return true
    }
    const visibleIds = new Set<string>()
    for (const node of tree.tree.nodes) {
      if (!matches(node)) continue
      if (needle) {
        const haystack =
          `${node.summary} ${node.label ?? ''} ${node.role ?? ''} ${node.entryId}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      visibleIds.add(node.entryId)
    }
    // 过滤后按最近可见祖先重算缩进；单次先序，O(n)。
    const depthById = new Map<string, number>()
    const rendered: Array<{ node: HarnessThreadTreeNode; depth: number }> = []
    for (const node of tree.tree.nodes) {
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
  }, [tree.filter, tree.search, tree.tree])

  if (!threadId) return null

  const filters: Array<{ value: SessionTreeFilter; label: string }> = [
    { value: 'conversation', label: i18n._(msg`对话`) },
    { value: 'tools', label: i18n._(msg`工具`) },
    { value: 'all', label: i18n._(msg`全部`) },
    { value: 'labeled', label: i18n._(msg`已标记`) },
  ]
  return (
    <Dialog
      open={tree.open}
      onOpenChange={(next) => {
        if (!next) closeTree()
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
          data-slot="huan-tree-list"
          className={cn(
            'flex min-h-24 flex-1 flex-col rounded-md border border-border/70',
            '*:data-[slot=scroll-area-viewport]:flex-1',
          )}
        >
          <div ref={listRef} className="p-1">
            {tree.loading && !tree.tree ? (
              <div className="text-muted-foreground flex items-center gap-2 p-2 text-xs">
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                <Trans>正在读取会话树…</Trans>
              </div>
            ) : visibleNodes.length === 0 ? (
              <div className="text-muted-foreground p-2 text-xs">
                {tree.tree?.nodes.length === 0 ? (
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
                    selected={tree.selectedEntryId === node.entryId}
                    busy={tree.busy || operation !== undefined}
                    onNavigate={() => beginNavigation(node)}
                    onEditLabel={() => beginLabel(node.entryId)}
                    onFork={() =>
                      openFork({
                        threadId,
                        position: 'before',
                        entryId: node.entryId,
                      })
                    }
                  />
                  {label?.entryId === node.entryId && (
                    <div className="bg-muted/40 mb-1 flex items-center gap-1.5 rounded-md p-1.5">
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
              ))
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
