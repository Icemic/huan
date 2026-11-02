/**
 * 工具与 Thinking 过程展示：官方 Trace 单层折叠。
 *
 * 工具参数、输出、图片、子调用摘要和父子执行都在同一折叠内；等待交互的
 * 摘要留在折叠外，应答入口统一由输入区上方的 Host UI 请求区提供，避免
 * 同一请求出现两个答案入口。错误默认展开，运行中显示 shimmer 状态。
 */

import type { HarnessThinkingViewPart, HarnessToolViewPart } from '@huan/react'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, WrenchIcon } from 'lucide-react'
import { useCallback } from 'react'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { useChatStore } from '@/state/app-context'
import { partOpenOf } from '@/state/chat-store'
import { MessageImage } from './message-image'

export interface ToolNode {
  key: string
  part: HarnessToolViewPart
  children: ToolNode[]
}

const argumentSummary = (part: HarnessToolViewPart): string | undefined => {
  const value = part.arguments.command ?? part.arguments.path ?? part.arguments.query
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.length > 80 ? `${value.slice(0, 80)}…` : value
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function ToolImages({ part }: { part: HarnessToolViewPart }) {
  const images = part.outputImages ?? []
  if (images.length === 0) return null
  return (
    <div data-slot="huan-tool-images" className="grid max-w-full grid-cols-1 gap-2 sm:grid-cols-2">
      {images.map((image, index) => (
        <MessageImage
          // biome-ignore lint/suspicious/noArrayIndexKey: 图片没有独立业务 ID，顺序来自工具结果
          key={`${part.toolCallId}:image:${index}`}
          src={image.data}
          alt={`工具 ${part.toolName} 输出图片 ${index + 1}`}
          className="max-h-48 w-full object-cover"
        />
      ))}
    </div>
  )
}

function NestedCallsSummary({ part }: { part: HarnessToolViewPart }) {
  const nested = part.nestedCalls
  if (!nested || nested.calls.length === 0) return null
  const failed = nested.calls.filter((call) => call.status === 'error').length
  return (
    <details
      data-slot="huan-nested-calls"
      className="bg-muted/30 rounded-md border px-2 py-1.5 text-xs"
    >
      <summary className="cursor-pointer">
        <Trans>子调用摘要</Trans>
        <span className="text-muted-foreground">
          {' '}
          {nested.complete ? <Trans>完整</Trans> : <Trans>不完整</Trans>} · {nested.calls.length}
          {failed > 0 ? ` · ${failed} 失败` : ''}
        </span>
      </summary>
      <ul className="mt-1 space-y-0.5">
        {nested.calls.map((call) => (
          <li key={call.id} className="flex min-w-0 items-start gap-2">
            <span
              className={
                call.status === 'error'
                  ? 'text-destructive shrink-0'
                  : 'text-muted-foreground shrink-0'
              }
            >
              {call.status === 'error' ? '×' : call.status === 'ok' ? '✓' : '…'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono">
              {call.name}
              {call.arguments && Object.keys(call.arguments).length > 0
                ? ` ${safeJson(call.arguments).replace(/\s+/g, ' ')}`
                : ''}
            </span>
            {call.durationMs !== undefined ? (
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {call.durationMs}ms
              </span>
            ) : null}
            {call.error ? (
              <span className="text-destructive max-w-40 truncate" title={call.error}>
                {call.error}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

function ToolNodeView({
  node,
  threadId,
  depth,
}: {
  node: ToolNode
  threadId: string | undefined
  depth: number
}) {
  const { part, key } = node
  const pending = useServiceStore(
    useCallback(
      (state) =>
        threadId
          ? (state.sessionDataById[threadId]?.hostUiRequests ?? []).some(
              (request) => request.toolCallId === part.toolCallId,
            )
          : false,
      [threadId, part.toolCallId],
    ),
  )
  const defaultOpen = part.status === 'error'
  const open = useChatStore((state) => partOpenOf(state, key, defaultOpen))
  const setOpen = useChatStore((state) => state.setPartOpen)
  const argumentsText = Object.keys(part.arguments).length > 0 ? safeJson(part.arguments) : ''
  const hasDetails = argumentsText.length > 0 || part.details !== undefined
  const hasBody =
    hasDetails ||
    part.output !== undefined ||
    (part.outputImages?.length ?? 0) > 0 ||
    (part.nestedCalls?.calls.length ?? 0) > 0 ||
    node.children.length > 0
  const summary = argumentSummary(part)
  const status = pending ? 'pending' : part.status
  const title = pending
    ? `等待交互：${part.toolName}`
    : part.status === 'error'
      ? `失败：${part.toolName}`
      : part.status === 'running'
        ? `运行 ${part.toolName}`
        : `已运行 ${part.toolName}`
  const statusText = pending
    ? '等待交互'
    : part.isPreliminary
      ? '输出中'
      : part.status === 'running'
        ? '运行中'
        : part.status === 'error'
          ? '失败'
          : '完成'

  const line = (
    <TraceLine
      status={
        status === 'pending'
          ? 'pending'
          : status === 'error'
            ? 'error'
            : status === 'running'
              ? 'running'
              : undefined
      }
      data-tool-call-id={part.toolCallId}
      data-parent-tool-call-id={part.parentToolCallId}
    >
      <TraceIcon>
        {part.status === 'running' && !pending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <WrenchIcon />
        )}
      </TraceIcon>
      <TraceTitle>
        {title}
        {summary ? <span className="text-muted-foreground/70"> · {summary}</span> : null}
        {depth > 0 ? <span className="text-muted-foreground/60"> · 子调用</span> : null}
      </TraceTitle>
      <TraceDescription>{statusText}</TraceDescription>
    </TraceLine>
  )

  if (!hasBody) return <Trace className="min-w-0">{line}</Trace>

  return (
    <Trace className="min-w-0">
      <TraceCollapsible open={open} onOpenChange={(next) => setOpen(key, next)}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="text-foreground">
          <div className="flex min-w-0 flex-col gap-2">
            {part.isPreliminary ? (
              <p className="text-muted-foreground text-xs">
                <Trans>工具仍在运行，以下为部分输出。</Trans>
              </p>
            ) : null}
            {pending ? (
              <p className="text-amber-700 text-xs dark:text-amber-300">
                <Trans>该工具关联请求正在等待应答；入口在输入区上方，不在折叠内容内。</Trans>
              </p>
            ) : null}
            {part.status === 'error' && !part.output ? (
              <p className="text-destructive text-xs">
                <Trans>工具执行失败，未返回可读输出。</Trans>
              </p>
            ) : null}
            {argumentsText ? (
              <CodeBlock size="sm">
                <CodeBlockHeader>
                  <CodeBlockTitle>
                    <Trans>参数</Trans>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton value={argumentsText} />
                  </CodeBlockActions>
                </CodeBlockHeader>
                <CodeBlockContent className="max-h-48">{argumentsText}</CodeBlockContent>
              </CodeBlock>
            ) : null}
            {part.output !== undefined ? (
              <CodeBlock size="sm" variant={part.status === 'error' ? 'destructive' : 'default'}>
                <CodeBlockHeader>
                  <CodeBlockTitle>
                    <Trans>输出</Trans>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton value={part.output} />
                  </CodeBlockActions>
                </CodeBlockHeader>
                <CodeBlockContent className="max-h-64">{part.output}</CodeBlockContent>
              </CodeBlock>
            ) : null}
            <ToolImages part={part} />
            <NestedCallsSummary part={part} />
            {part.details !== undefined ? (
              <details className="text-xs">
                <summary className="text-muted-foreground cursor-pointer">
                  <Trans>工具详情</Trans>
                </summary>
                <CodeBlock size="sm" className="mt-1">
                  <CodeBlockContent className="max-h-48">{safeJson(part.details)}</CodeBlockContent>
                </CodeBlock>
              </details>
            ) : null}
            {node.children.length > 0 ? (
              <div
                data-slot="huan-nested-tools"
                className="flex min-w-0 flex-col gap-1 border-s ps-2"
              >
                {node.children.map((child) => (
                  <ToolNodeView
                    key={child.key}
                    node={child}
                    threadId={threadId}
                    depth={depth + 1}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

export function ToolPart({ node, threadId }: { node: ToolNode; threadId: string | undefined }) {
  return <ToolNodeView node={node} threadId={threadId} depth={0} />
}

/** Thinking 折叠：运行中默认展开，完成后收起；被过滤内容给出提示。 */
export function ThinkingPart({
  part,
  partKey,
  running,
}: {
  part: HarnessThinkingViewPart
  partKey: string
  running: boolean
}) {
  const open = useChatStore((state) => partOpenOf(state, partKey, running))
  const setOpen = useChatStore((state) => state.setPartOpen)
  if (!part.text.trim()) return null
  return (
    <Trace className="min-w-0">
      <TraceCollapsible open={open} onOpenChange={(next) => setOpen(partKey, next)}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? 'running' : undefined}>
            <TraceTitle>
              {running ? <Trans>思考中</Trans> : <Trans>思考完成</Trans>}
              {part.redacted ? (
                <span className="text-muted-foreground"> · 已隐藏部分内容</span>
              ) : null}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="whitespace-pre-wrap">
          {part.text}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
