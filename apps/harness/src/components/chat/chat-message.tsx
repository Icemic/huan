/**
 * 单条消息：用户右侧 muted 气泡，助手开放正文，动作在消息底部。
 *
 * 消息内容来自纯投影；动作只调用会话树/fork 与剪贴板/下载，不复制消息
 * 到本地 store。来源 entryId 缺失时隐藏树定位与分叉，不猜测节点。
 */

import type { HarnessMessageView, HarnessMessageViewPart } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GitForkIcon,
  Loader2Icon,
  LocateFixedIcon,
} from 'lucide-react'
import { memo } from 'react'
import { TooltipIconButton } from '@/components/tooltip-icon-button'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { useSessionsStore } from '@/state/app-context'
import { AssistantMessageParts } from './message-body'
import {
  downloadTextFile,
  markdownFileName,
  markdownOfMessage,
  textOfMessage,
} from './message-format'
import { MessageImage } from './message-image'

const userImages = (parts: readonly HarnessMessageViewPart[]) =>
  parts.flatMap((part) => (part.type === 'image' ? [part] : []))

const MessageStatus = ({ view }: { view: HarnessMessageView }) => {
  if (view.status.type !== 'incomplete') return null
  const text =
    view.status.reason === 'cancelled'
      ? '本轮已取消。'
      : view.status.reason === 'length'
        ? '输出达到长度上限，内容可能不完整。'
        : `运行失败${view.status.message ? `：${view.status.message}` : ''}`
  return (
    <p
      role="status"
      data-slot="huan-message-status"
      data-reason={view.status.reason}
      className={
        view.status.reason === 'error'
          ? 'text-destructive border-destructive/20 bg-destructive/5 rounded-md border px-2.5 py-1.5 text-xs whitespace-pre-wrap'
          : 'text-muted-foreground text-xs whitespace-pre-wrap'
      }
    >
      {text}
    </p>
  )
}

function MessageActions({
  view,
  threadId,
  title,
}: {
  view: HarnessMessageView
  threadId: string | undefined
  title: string | undefined
}) {
  const openTree = useSessionsStore((state) => state.openTree)
  const selectTreeEntry = useSessionsStore((state) => state.selectTreeEntry)
  const openFork = useSessionsStore((state) => state.openFork)
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const sourceEntryId = view.sourceEntryId
  const copyText = textOfMessage(view)
  const canLocate = Boolean(threadId && sourceEntryId)
  const canFork = Boolean(threadId && sourceEntryId && view.role === 'user')

  return (
    <MessageFooter className="gap-0.5 px-0 opacity-70 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100">
      <TooltipIconButton
        tooltip={isCopied ? '已复制' : '复制文本'}
        side="bottom"
        size="icon-xs"
        aria-label={isCopied ? '已复制消息' : '复制消息'}
        disabled={!copyText}
        onClick={() => copyToClipboard(copyText)}
      >
        {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="下载 Markdown"
        side="bottom"
        size="icon-xs"
        aria-label="下载此消息的 Markdown"
        onClick={() => downloadTextFile(markdownFileName(view, title), markdownOfMessage(view))}
      >
        <DownloadIcon aria-hidden />
      </TooltipIconButton>
      {canLocate ? (
        <TooltipIconButton
          tooltip="在会话树中定位"
          side="bottom"
          size="icon-xs"
          aria-label="在会话树中定位此消息"
          onClick={() => {
            if (!threadId || !sourceEntryId) return
            openTree(threadId)
            selectTreeEntry(sourceEntryId)
          }}
        >
          <LocateFixedIcon aria-hidden />
        </TooltipIconButton>
      ) : null}
      {canFork ? (
        <TooltipIconButton
          tooltip="从这条用户消息分叉"
          side="bottom"
          size="icon-xs"
          aria-label="从这条用户消息分叉"
          onClick={() => {
            if (!threadId || !sourceEntryId) return
            openFork({ threadId, position: 'before', entryId: sourceEntryId })
          }}
        >
          <GitForkIcon aria-hidden />
        </TooltipIconButton>
      ) : null}
    </MessageFooter>
  )
}

function UserMessage({
  view,
  threadId,
  title,
}: {
  view: HarnessMessageView
  threadId: string | undefined
  title: string | undefined
}) {
  const images = userImages(view.parts)
  const text = textOfMessage(view)
  return (
    <Message align="end" data-slot="huan-message" data-role="user">
      <MessageContent className="items-end gap-2">
        {images.length > 0 ? (
          <div className="flex max-w-full flex-wrap justify-end gap-2">
            {images.map((image, index) => (
              <MessageImage
                // biome-ignore lint/suspicious/noArrayIndexKey: 用户图片没有独立业务 ID
                key={`${view.id}:image:${index}`}
                src={image.data}
                alt={`用户消息图片 ${index + 1}`}
                className="max-h-56"
              />
            ))}
          </div>
        ) : null}
        {text ? (
          <Bubble align="end" variant="muted">
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        ) : null}
        <MessageActions view={view} threadId={threadId} title={title} />
      </MessageContent>
    </Message>
  )
}

function AssistantMessage({
  view,
  threadId,
  title,
}: {
  view: HarnessMessageView
  threadId: string | undefined
  title: string | undefined
}) {
  const emptyRunning = view.status.type === 'running' && view.parts.length === 0
  return (
    <Message data-slot="huan-message" data-role="assistant">
      <MessageContent className="gap-2">
        {emptyRunning ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            <Trans>正在等待模型输出…</Trans>
          </div>
        ) : (
          <AssistantMessageParts view={view} threadId={threadId} />
        )}
        <MessageStatus view={view} />
        <MessageActions view={view} threadId={threadId} title={title} />
      </MessageContent>
    </Message>
  )
}

/** 消息行：来源 entryId 保留在 DOM，便于树定位与回归断言。 */
export const ChatMessage = memo(function ChatMessage({
  view,
  threadId,
  title,
}: {
  view: HarnessMessageView
  threadId: string | undefined
  title: string | undefined
}) {
  const shared = {
    'data-message-id': view.id,
    ...(view.sourceEntryId ? { 'data-source-entry-id': view.sourceEntryId } : {}),
    'data-status': view.status.type,
  }
  return (
    <div {...shared} className="min-w-0">
      {view.role === 'user' ? (
        <UserMessage view={view} threadId={threadId} title={title} />
      ) : (
        <AssistantMessage view={view} threadId={threadId} title={title} />
      )}
    </div>
  )
})
