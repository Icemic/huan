/**
 * 最终聊天视图：单一消息滚动容器、单一输入列和官方组件组合。
 *
 * 数据来自当前会话的权威运行数据（serviceStore）与纯投影；滚动跟随、
 * 新输出提示和回底按钮是 DOM 交互。无选择时输入区会明确落到工作区目标。
 */

import { useServiceStore, useThreadMetadata, useThreadSession, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { ArrowDownIcon, MessagesSquareIcon } from 'lucide-react'
import { memo, type ReactNode, type UIEvent, useCallback, useEffect } from 'react'
import { PiHostUiRequests } from '@/components/pi-thread-host-ui'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ChatMessage } from './chat-message'
import { ChatComposer } from './composer'
import { useMessageViews } from './use-message-views'
import { useStickToBottom } from './use-stick-to-bottom'

const MemoChatComposer = memo(ChatComposer)
const MemoHostUiRequests = memo(PiHostUiRequests)

function HistorySkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载会话"
      className="flex flex-col gap-5 py-4"
      data-slot="huan-chat-loading"
    >
      <Skeleton className="ms-auto h-8 w-2/5 rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <Skeleton className="ms-auto h-8 w-1/3 rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <p className="text-muted-foreground text-center text-xs">
        <Trans>正在加载会话…</Trans>
      </p>
    </div>
  )
}

function ChatEmpty({
  title,
  description,
  path,
}: {
  title: ReactNode
  description?: ReactNode
  path?: string | undefined
}) {
  return (
    <Empty className="min-h-72 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessagesSquareIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
        {path ? (
          <p className="text-muted-foreground max-w-full truncate font-mono text-xs" title={path}>
            {path}
          </p>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}

export function ChatView() {
  const selection = useWindowStore((state) => state.selection)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const metadata = useThreadMetadata(threadId)
  const session = useThreadSession(threadId)
  const loadThread = useServiceStore((state) => state.loadThread)
  const views = useMessageViews(threadId)
  // 无 live lease（例如工作区元数据损坏的冷读）时也显式读取一次快照；
  // 有 lease 时 applyThreadEvent/快照会自愈，loadThread 本身按会话去重。
  useEffect(() => {
    if (!threadId || session?.loadState === 'loaded' || session?.loadState === 'loading') {
      return
    }
    void loadThread(threadId).catch(() => undefined)
  }, [loadThread, session, threadId])
  const title = metadata?.title ?? metadata?.name
  const threadKey =
    selection?.kind === 'thread'
      ? `thread:${selection.threadId}`
      : selection?.kind === 'new'
        ? `new:${selection.workspaceId ?? ''}:${selection.startProjectPath}`
        : 'none'
  const { scrollRef, contentRef, following, hasNewOutput, onScroll, scrollToBottom } =
    useStickToBottom(threadKey, views)

  // 官方 ScrollArea 不暴露 Viewport ref：根节点挂载后取唯一视口，
  // 滚动跟随仍以真实滚动元素为准。
  const bindScrollRoot = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current =
        node?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
    },
    [scrollRef],
  )

  const handleScrollCapture = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      // 只响应消息视口；消息内代码块、表格的局部滚动不改变跟随状态。
      if (event.target === scrollRef.current) onScroll()
    },
    [onScroll, scrollRef],
  )

  const loading = threadId !== undefined && views.length === 0 && session?.loadState !== 'loaded'
  let body: ReactNode
  if (!selection) {
    body = (
      <ChatEmpty
        title={<Trans>开始对话</Trans>}
        description={<Trans>从左侧选择会话，或直接在下方输入以新建会话。</Trans>}
      />
    )
  } else if (selection.kind === 'new') {
    body = <ChatEmpty title={<Trans>新会话</Trans>} path={selection.startProjectPath} />
  } else if (loading) {
    body = <HistorySkeleton />
  } else if (views.length === 0 && session?.lastError) {
    body = (
      <Empty className="min-h-72 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquareIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>会话暂时不可用</Trans>
          </EmptyTitle>
          <EmptyDescription>{session.lastError}</EmptyDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (threadId) void loadThread(threadId, { force: true }).catch(() => undefined)
            }}
          >
            <Trans>重试</Trans>
          </Button>
        </EmptyHeader>
      </Empty>
    )
  } else if (views.length === 0) {
    body = (
      <ChatEmpty
        title={<Trans>还没有消息</Trans>}
        description={<Trans>在下方输入内容，继续这个会话。</Trans>}
      />
    )
  } else {
    body = (
      <div data-slot="huan-chat-messages" className="flex flex-col gap-6">
        {views.map((view) => (
          <ChatMessage key={view.id} view={view} threadId={threadId} title={title} />
        ))}
      </div>
    )
  }

  return (
    <div data-slot="huan-chat-view" className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        {/* 单 Viewport 承担滚轮/键盘/滚动跟随；官方根组合负责竖轨与角。 */}
        <ScrollArea
          ref={bindScrollRoot}
          className="h-full min-h-0"
          onScrollCapture={handleScrollCapture}
        >
          {/* 内容层保持业务宽度约束，并作为尺寸监听的稳定锚点。 */}
          <div
            ref={contentRef}
            data-slot="huan-chat-content"
            className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col gap-2 px-4 py-6"
          >
            <div
              className={cn(
                'flex flex-1 flex-col',
                views.length === 0 && !loading && 'justify-center',
              )}
            >
              {body}
            </div>
          </div>
        </ScrollArea>
        {!following ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-events-auto rounded-md"
              data-slot="huan-scroll-to-bottom"
              onClick={() => scrollToBottom('smooth')}
            >
              <ArrowDownIcon aria-hidden />
              {hasNewOutput ? <Trans>有新输出</Trans> : <Trans>回到底部</Trans>}
            </Button>
          </div>
        ) : null}
      </div>
      <div
        data-slot="huan-composer-dock"
        className="bg-background/95 supports-backdrop-filter:bg-background/80 shrink-0 border-t px-2 pt-2 pb-3 backdrop-blur"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
          <MemoHostUiRequests />
          <MemoChatComposer />
        </div>
      </div>
    </div>
  )
}
