/**
 * 工具与 Thinking 过程展示：官方 Trace 单层折叠。
 *
 * read / write / edit / bash 使用专门内容与标题；其他工具、损坏参数与
 * 扩展工具保留通用参数/输出 JSON 回退。工具参数、输出、图片、子调用摘要
 * 和父子执行都在同一折叠内；等待交互的摘要留在折叠外，应答入口统一由
 * 输入区上方的 Host UI 请求区提供，避免同一请求出现两个答案入口。错误
 * 默认展开，运行中显示 shimmer 状态。
 */

import type { HarnessSubagentDetails, HarnessSubagentTask } from '@huan/protocol'
import type { HarnessThinkingViewPart, HarnessToolViewPart } from '@huan/react'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  FileOutputIcon,
  FilePenLineIcon,
  FileTextIcon,
  Loader2Icon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { SubagentTaskCard } from '@/components/subagent-task-card'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { cn } from '@/lib/utils'
import { useChatStore, useHarnessApp, useSubagentStore } from '@/state/app-context'
import { partOpenOf } from '@/state/chat-store'
import {
  SpecializedToolBody,
  type SpecializedToolView,
  specializedHasAttachments,
  specializedToolTitleOf,
  specializedToolViewOf,
} from './specialized-tool-parts'
import { NestedCallsSummary, ToolImages } from './tool-attachments'
import { otherArgumentsOf } from './tool-presentation'

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const subagentTaskStatuses: readonly HarnessSubagentTask['status'][] = [
  'waiting',
  'running',
  'completed',
  'failed',
  'cancelled',
]

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 只接受页面会读取的字段；任何未知形状都回退到通用 JSON 展示。 */
const subagentTaskOf = (value: unknown): HarnessSubagentTask | undefined => {
  if (!isRecord(value)) return undefined
  const { taskId, parentThreadId, agent, task, status, model, output, error, usage } = value
  if (
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    typeof parentThreadId !== 'string' ||
    parentThreadId.length === 0 ||
    typeof agent !== 'string' ||
    typeof task !== 'string' ||
    typeof status !== 'string' ||
    !subagentTaskStatuses.includes(status as HarnessSubagentTask['status']) ||
    !isRecord(usage) ||
    !finiteNumber(usage.input) ||
    !finiteNumber(usage.output) ||
    !finiteNumber(usage.cacheRead) ||
    !finiteNumber(usage.cacheWrite) ||
    !finiteNumber(usage.cost) ||
    (model !== undefined && typeof model !== 'string') ||
    (output !== undefined && typeof output !== 'string') ||
    (error !== undefined && typeof error !== 'string')
  ) {
    return undefined
  }
  return {
    taskId,
    parentThreadId,
    agent,
    task,
    status: status as HarnessSubagentTask['status'],
    ...(model === undefined ? {} : { model }),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(typeof value.pendingRequestCount === 'number'
      ? { pendingRequestCount: value.pendingRequestCount }
      : {}),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost,
    },
  }
}

/** 识别内置 SDK 子任务 details；未知或损坏的 details 仍显示通用 JSON。 */
const subagentDetailsOf = (value: unknown): HarnessSubagentDetails | undefined => {
  if (!isRecord(value) || value.kind !== 'huan-subagent' || !Array.isArray(value.tasks)) {
    return undefined
  }
  if (value.mode !== 'single' && value.mode !== 'parallel' && value.mode !== 'chain') {
    return undefined
  }
  const tasks: HarnessSubagentTask[] = []
  for (const item of value.tasks) {
    const task = subagentTaskOf(item)
    if (!task) return undefined
    tasks.push(task)
  }
  return { kind: 'huan-subagent', mode: value.mode, tasks }
}

function SubagentToolBody({
  part,
  details,
}: {
  part: HarnessToolViewPart
  details: HarnessSubagentDetails
}) {
  const openTask = useSubagentStore((state) => state.openTask)
  const { browser } = useHarnessApp()
  return (
    <div data-slot="huan-subagent-tool" className="flex min-w-0 flex-col gap-1.5">
      {details.tasks.length === 0 ? (
        <p className="text-muted-foreground whitespace-pre-wrap text-xs">
          {part.output?.trim() || <Trans>正在准备子任务…</Trans>}
        </p>
      ) : (
        details.tasks.map((task) => (
          <SubagentTaskCard
            key={task.taskId}
            task={task}
            onOpen={() => void openTask(task.parentThreadId, task.taskId)}
            onCancel={() => browser.client.cancelSubagentTask(task.parentThreadId, task.taskId)}
          />
        ))
      )}
    </div>
  )
}

/** 专门工具的类型图标；运行中由调用方替换为加载标记。 */
function SpecializedToolIcon({ view }: { view: SpecializedToolView }) {
  switch (view.kind) {
    case 'read':
      return <FileTextIcon />
    case 'write':
      return <FileOutputIcon />
    case 'edit':
      return <FilePenLineIcon />
    case 'bash':
      return <TerminalIcon />
  }
}

function SpecializedAction({ view }: { view: SpecializedToolView }) {
  switch (view.kind) {
    case 'read':
      return <Trans>读取</Trans>
    case 'write':
      return <Trans>写入</Trans>
    case 'edit':
      return <Trans>编辑</Trans>
    case 'bash':
      return <Trans>执行</Trans>
  }
}

/** 专门工具标题：图标 / 动作 / 对象 / 元数据 / 状态 / 箭头。 */
function SpecializedTitleLine({
  part,
  view,
  awaitingReply,
  depth,
}: {
  part: HarnessToolViewPart
  view: SpecializedToolView
  awaitingReply: boolean
  depth: number
}) {
  const title = useMemo(() => specializedToolTitleOf(view), [view])
  const running = part.status === 'running' && !awaitingReply
  const failed = part.status === 'error'
  const statusText = awaitingReply
    ? '等待交互'
    : part.status === 'running'
      ? '运行中'
      : failed
        ? '失败'
        : undefined
  return (
    <TraceLine
      status={failed ? 'error' : running ? 'running' : undefined}
      className="min-h-7"
      data-tool-call-id={part.toolCallId}
      data-parent-tool-call-id={part.parentToolCallId}
      data-tool-name={part.toolName}
    >
      <TraceIcon>
        {running ? <Loader2Icon className="animate-spin" /> : <SpecializedToolIcon view={view} />}
      </TraceIcon>
      <TraceTitle className="flex min-w-0 items-center gap-2">
        <span className={cn('shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}>
          <SpecializedAction view={view} />
        </span>
        <span className="text-foreground min-w-0 truncate font-mono">{title.object}</span>
        {title.meta ? (
          <span className="text-muted-foreground hidden shrink-0 text-xs leading-[18px] tabular-nums @min-[480px]/message:inline">
            {title.meta}
          </span>
        ) : null}
        {depth > 0 ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            <Trans>子调用</Trans>
          </span>
        ) : null}
      </TraceTitle>
      {statusText ? (
        <span
          className={cn(
            'shrink-0',
            awaitingReply
              ? 'text-amber-700 dark:text-amber-300'
              : failed
                ? 'text-destructive'
                : 'text-muted-foreground',
          )}
        >
          {statusText}
        </span>
      ) : null}
    </TraceLine>
  )
}

/** 通用工具标题：保留扩展工具与损坏参数的原有用词。 */
function GenericTitleLine({
  part,
  pending,
  awaitingReply,
  depth,
}: {
  part: HarnessToolViewPart
  pending: boolean
  awaitingReply: boolean
  depth: number
}) {
  const summary = argumentSummary(part)
  const statusText = awaitingReply
    ? '等待交互'
    : part.isPreliminary
      ? '输出中'
      : part.status === 'running'
        ? '运行中'
        : part.status === 'error'
          ? '失败'
          : '完成'
  const title = pending
    ? `等待交互：${part.toolName}`
    : part.status === 'error'
      ? `失败：${part.toolName}`
      : part.status === 'running'
        ? `运行 ${part.toolName}`
        : `已运行 ${part.toolName}`
  return (
    <TraceLine
      status={
        pending
          ? 'pending'
          : part.status === 'error'
            ? 'error'
            : part.status === 'running'
              ? 'running'
              : undefined
      }
      className="min-h-7"
      data-tool-call-id={part.toolCallId}
      data-parent-tool-call-id={part.parentToolCallId}
      data-tool-name={part.toolName}
    >
      <TraceIcon>
        {part.status === 'running' && !awaitingReply ? (
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
}

/**
 * 专门工具是否存在可展开内容；read 在运行中且尚无结果时不显示空折叠。
 * 此判断不解析大段文本，只检查字段是否存在。
 */
const specializedHasBody = (part: HarnessToolViewPart, view: SpecializedToolView): boolean => {
  if (view.kind !== 'read') return true
  return (
    part.output !== undefined ||
    part.status !== 'running' ||
    specializedHasAttachments(part) ||
    otherArgumentsOf(part.arguments, 'read') !== undefined ||
    view.details.truncation !== undefined ||
    view.details.other !== undefined
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
  const { toolName, arguments: toolArguments, details: toolDetails, status: toolStatus } = part
  const subagent = useMemo(
    () => (toolName === 'subagent' ? subagentDetailsOf(toolDetails) : undefined),
    [toolName, toolDetails],
  )
  const special = useMemo(
    () =>
      subagent === undefined
        ? specializedToolViewOf({
            toolName,
            arguments: toolArguments,
            details: toolDetails,
            status: toolStatus,
          })
        : undefined,
    [toolName, toolArguments, toolDetails, toolStatus, subagent],
  )
  const childPending = subagent?.tasks.some((task) => (task.pendingRequestCount ?? 0) > 0) ?? false
  const awaitingReply = pending || childPending
  const defaultOpen = part.status === 'error'
  const open = useChatStore((state) => partOpenOf(state, key, defaultOpen))
  const setOpen = useChatStore((state) => state.setPartOpen)
  const argumentsText = useMemo(
    () => (!special && Object.keys(toolArguments).length > 0 ? safeJson(toolArguments) : ''),
    [special, toolArguments],
  )
  const hasDetails = argumentsText.length > 0 || part.details !== undefined
  const hasBody = special
    ? specializedHasBody(part, special) || node.children.length > 0
    : subagent !== undefined ||
      hasDetails ||
      part.output !== undefined ||
      (part.outputImages?.length ?? 0) > 0 ||
      (part.nestedCalls?.calls.length ?? 0) > 0 ||
      node.children.length > 0

  const line = special ? (
    <SpecializedTitleLine part={part} view={special} awaitingReply={awaitingReply} depth={depth} />
  ) : (
    <GenericTitleLine part={part} pending={pending} awaitingReply={awaitingReply} depth={depth} />
  )

  if (!hasBody) return <Trace className="min-w-0">{line}</Trace>

  return (
    <Trace className="min-w-0">
      <TraceCollapsible open={open} onOpenChange={(next) => setOpen(key, next)}>
        <TraceCollapsibleTrigger className="gap-2">{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="text-foreground">
          {open ? (
            <div className="flex min-w-0 flex-col gap-2">
              {pending ? (
                <p
                  className={cn(
                    'text-amber-700 dark:text-amber-300',
                    special ? 'text-sm' : 'text-xs',
                  )}
                >
                  <Trans>等待你的答复</Trans>
                </p>
              ) : null}
              {special ? (
                <SpecializedToolBody part={part} view={special} storeKey={key} />
              ) : subagent !== undefined ? (
                <SubagentToolBody part={part} details={subagent} />
              ) : (
                <>
                  {part.isPreliminary ? (
                    <p className="text-muted-foreground text-xs">
                      <Trans>工具仍在运行，以下为部分输出。</Trans>
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
                      <ScrollArea className="min-w-0 *:data-[slot=scroll-area-viewport]:max-h-48">
                        <CodeBlockContent
                          wrap
                          className="overflow-visible *:data-[slot=code-block-code]:grid-cols-[minmax(0,1fr)]"
                          style={{ maskImage: 'none' }}
                        >
                          {argumentsText}
                        </CodeBlockContent>
                      </ScrollArea>
                    </CodeBlock>
                  ) : null}
                  {part.output !== undefined ? (
                    <CodeBlock
                      size="sm"
                      variant={part.status === 'error' ? 'destructive' : 'default'}
                    >
                      <CodeBlockHeader>
                        <CodeBlockTitle>
                          <Trans>输出</Trans>
                        </CodeBlockTitle>
                        <CodeBlockActions>
                          <CodeBlockCopyButton value={part.output} />
                        </CodeBlockActions>
                      </CodeBlockHeader>
                      <ScrollArea className="min-w-0 *:data-[slot=scroll-area-viewport]:max-h-64">
                        <CodeBlockContent
                          wrap
                          className="overflow-visible *:data-[slot=code-block-code]:grid-cols-[minmax(0,1fr)]"
                          style={{ maskImage: 'none' }}
                        >
                          {part.output}
                        </CodeBlockContent>
                      </ScrollArea>
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
                        <ScrollArea className="min-w-0 *:data-[slot=scroll-area-viewport]:max-h-48">
                          <CodeBlockContent
                            wrap
                            className="overflow-visible *:data-[slot=code-block-code]:grid-cols-[minmax(0,1fr)]"
                            style={{ maskImage: 'none' }}
                          >
                            {safeJson(part.details)}
                          </CodeBlockContent>
                        </ScrollArea>
                      </CodeBlock>
                    </details>
                  ) : null}
                </>
              )}
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
          ) : null}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

export function ToolPart({ node, threadId }: { node: ToolNode; threadId: string | undefined }) {
  // 只在紧邻上一条工具行时抵消 8px，连续工具之间保留父级 12px 间距中的 4px。
  return (
    <div data-slot="huan-tool-part" className="min-w-0 [[data-slot=huan-tool-part]+&]:-mt-2">
      <ToolNodeView node={node} threadId={threadId} depth={0} />
    </div>
  )
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
        <TraceCollapsibleTrigger className="gap-2">
          <TraceLine status={running ? 'running' : undefined} className="min-h-7">
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
