/**
 * 权威消息记录到独立展示模型的纯投影。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/runtime/messageProjection.ts`
 * （MIT 许可，见包内 THIRD-PARTY-NOTICES.md）。类型改用 `@huan/protocol`，
 * 输出从 assistant-ui 的 `ThreadMessageLike`/`ExportedMessageRepository`
 * 改为本包的独立展示类型，供最终界面组合。
 *
 * 设计：
 * - 每个 Pi **轮次**是一条助手消息（text/thinking/toolCall 部分）。多步运行
 *   是若干助手消息与 `toolResult` 消息交错。我们把一段最长的助手 +
 *   toolResult 消息串**合并**为单条展示消息，使思维链与工具工作保持同组。
 * - `toolResult` 消息按 `toolCallId` 配对进其工具部分（并行工具完成顺序与
 *   来源顺序无关——配对按 id，不按位置）。
 * - 实时流式工具输出（`toolExecutions[id].partialResult`）填充工具输出，在
 *   工具仍在运行时标记 `isPreliminary`，直到最终 `toolResult` 消息落地。
 * - 嵌套工具调用（`parentToolCallId`）作为子工具部分附在同组父工具之后；
 *   父项缺失时仍作为可读工具部分出现。
 * - 工具结果与用户消息中的图片保留为 `image` 部分；未知角色与扩展消息
 *   成为 `data` 部分，不依赖专用 renderer。
 * - 增量投影只重算变更后缀，并通过 `shareHarnessMessageViews` 复用未变消息
 *   的引用；流式性能依赖这一点。
 *
 * 浏览器安全，不导入任何 Pi SDK 或 assistant-ui 包。
 */

import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessBashExecutionMessage,
  HarnessBranchSummaryMessage,
  HarnessCompactionPhase,
  HarnessCompactionSummaryMessage,
  HarnessCustomMessage,
  HarnessImageContent,
  HarnessNestedToolCalls,
  HarnessStopReason,
  HarnessThinkingContent,
  HarnessToolCall,
  HarnessToolResultContent,
  HarnessToolResultMessage,
  HarnessUserContent,
  HarnessUserMessage,
} from '@huan/protocol'
import { isParsableUrl } from '../vendor/anti-corruption.js'
import type { HarnessRunStatus, HarnessToolExecutionState } from './thread-state.js'

/** 展示消息状态。 */
export type HarnessMessageViewStatus =
  | { type: 'running' }
  | { type: 'complete'; reason: 'stop' | 'toolUse' }
  | { type: 'incomplete'; reason: 'cancelled' | 'length' | 'error'; message?: string }

/** 所有展示部分的公共来源字段。 */
interface HarnessMessageViewPartBase {
  /** 来源会话记录 ID；未落盘/未知时缺失。 */
  sourceEntryId?: string
  /** 属于嵌套工具执行时，指向父工具调用。 */
  parentToolCallId?: string
}

export interface HarnessTextViewPart extends HarnessMessageViewPartBase {
  type: 'text'
  text: string
}

export interface HarnessThinkingViewPart extends HarnessMessageViewPartBase {
  type: 'thinking'
  text: string
  /** 思考内容被安全过滤遮蔽时，界面应提示而不是静默隐藏。 */
  redacted?: boolean
}

export interface HarnessImageViewPart extends HarnessMessageViewPartBase {
  type: 'image'
  /** base64 或 data URL。 */
  data: string
  mimeType: string
}

export interface HarnessToolViewPart extends HarnessMessageViewPartBase {
  type: 'tool'
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'running' | 'complete' | 'error'
  /** 文本输出（按序拼接 text 部分）。 */
  output?: string
  /** 输出中的图片，按实际内容呈现。 */
  outputImages?: readonly HarnessImageViewPart[]
  /** 工具特定元数据；运行中来自实时 partialResult，结束后以最终结果为准。 */
  details?: unknown
  /** 历史记录中的子调用有界摘要；不承诺完整子结果。 */
  nestedCalls?: HarnessNestedToolCalls
  /** 实时部分输出（最终结果尚未落地）。 */
  isPreliminary?: boolean
}

export interface HarnessDataViewPart extends HarnessMessageViewPartBase {
  type: 'data'
  /** 数据种类（如 `pi-bash-execution`、`pi-unsupported-message`）。 */
  name: string
  data: Record<string, unknown>
}

export type HarnessMessageViewPart =
  | HarnessTextViewPart
  | HarnessThinkingViewPart
  | HarnessImageViewPart
  | HarnessToolViewPart
  | HarnessDataViewPart

/** 单条展示消息。 */
export interface HarnessMessageView {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  status: HarnessMessageViewStatus
  sourceEntryId?: string
  /** 助手消息的受控元数据；用户消息不填。 */
  metadata?: {
    provider?: string
    model?: string
    api?: string
    stopReason?: HarnessStopReason
    errorMessage?: string
  }
  parts: readonly HarnessMessageViewPart[]
}

/** 投影输入：记录 + 实时运行态。 */
export interface HarnessMessageProjectionInput {
  messages: readonly HarnessAgentMessage[]
  /** 与 messages 等长的来源 entryId；用于树定位，不从下标/时间戳猜测。 */
  messageEntryIds?: readonly (string | null)[]
  toolExecutions: Readonly<Record<string, HarnessToolExecutionState>>
  runStatus: HarnessRunStatus
  /** 当前/最近一次压缩操作；成功摘要会从 SDK 开头位置移出，由状态行承载。 */
  compaction?: HarnessCompactionPhase
}

const messageId = (index: number) => `pi-msg:${index}`

const sourceEntryIdOf = (input: HarnessMessageProjectionInput, index: number): string | undefined =>
  input.messageEntryIds?.[index] ?? undefined

const createdAtOf = (message: { timestamp?: number }): number =>
  typeof message.timestamp === 'number' ? message.timestamp : 0

const toDataUrl = (data: string, mimeType: string) =>
  isParsableUrl(data) ? data : `data:${mimeType};base64,${data}`

const toImagePart = (
  content: HarnessImageContent,
  sourceEntryId?: string,
  parentToolCallId?: string,
): HarnessImageViewPart => ({
  type: 'image',
  data: toDataUrl(content.data, content.mimeType),
  mimeType: content.mimeType,
  ...(sourceEntryId ? { sourceEntryId } : {}),
  ...(parentToolCallId ? { parentToolCallId } : {}),
})

const projectUserContent = (
  content: HarnessUserMessage['content'],
  sourceEntryId?: string,
): HarnessMessageViewPart[] => {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, ...(sourceEntryId ? { sourceEntryId } : {}) }]
  }
  return content.flatMap<HarnessMessageViewPart>((part: HarnessUserContent) => {
    if (part.type === 'image') {
      return [toImagePart(part, sourceEntryId)]
    }
    if (part.type === 'text') {
      return [{ type: 'text', text: part.text, ...(sourceEntryId ? { sourceEntryId } : {}) }]
    }
    return []
  })
}

const readToolResultContent = (value: unknown): readonly HarnessToolResultContent[] | undefined => {
  if (value == null) return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content.filter(
    (part): part is HarnessToolResultContent =>
      typeof part === 'object' &&
      part !== null &&
      (((part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string') ||
        ((part as { type?: unknown }).type === 'image' &&
          typeof (part as { data?: unknown }).data === 'string' &&
          typeof (part as { mimeType?: unknown }).mimeType === 'string')),
  )
}

/**
 * 读取流式部分结果的 details。
 *
 * partialResult 来自 SDK 的未知值，只在校验为普通记录对象后读取自有字段；
 * 不按工具名猜测结构，未知形状仍交给通用 JSON 回退。
 */
const readToolResultDetails = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as { details?: unknown }).details
}

type ProjectedToolResult = {
  toolCallId: string
  toolName: string
  output?: string
  images?: readonly HarnessImageViewPart[]
  details?: unknown
  nestedCalls?: HarnessNestedToolCalls
  isError: boolean
  sourceEntryId?: string
}

const projectToolResultContent = (
  content: readonly HarnessToolResultContent[] | undefined,
  sourceEntryId?: string,
): Pick<ProjectedToolResult, 'output' | 'images'> => {
  if (!content) return {}
  const texts: string[] = []
  const images: HarnessImageViewPart[] = []
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text)
    else images.push(toImagePart(part, sourceEntryId))
  }
  return {
    ...(texts.length > 0 ? { output: texts.join('') } : {}),
    ...(images.length > 0 ? { images } : {}),
  }
}

const projectToolResultMessage = (
  message: HarnessToolResultMessage,
  sourceEntryId: string | undefined,
): ProjectedToolResult => ({
  toolCallId: message.toolCallId,
  toolName: message.toolName,
  ...projectToolResultContent(message.content, sourceEntryId),
  details: message.details,
  ...(message.nestedCalls ? { nestedCalls: message.nestedCalls } : {}),
  isError: message.isError,
  ...(sourceEntryId ? { sourceEntryId } : {}),
})

/** 没有对应助手 toolCall 的历史结果仍按工具内容显示，不丢弃记录。 */
const toolViewOfResult = (result: ProjectedToolResult): HarnessToolViewPart => ({
  type: 'tool',
  toolCallId: result.toolCallId,
  toolName: result.toolName,
  arguments: {},
  status: result.isError ? 'error' : 'complete',
  ...(result.output !== undefined ? { output: result.output } : {}),
  ...(result.images !== undefined ? { outputImages: result.images } : {}),
  ...(result.details !== undefined ? { details: result.details } : {}),
  ...(result.nestedCalls ? { nestedCalls: result.nestedCalls } : {}),
  ...(result.sourceEntryId ? { sourceEntryId: result.sourceEntryId } : {}),
})

const buildToolResultMap = (input: HarnessMessageProjectionInput) => {
  const map = new Map<string, ProjectedToolResult>()
  input.messages.forEach((message, index) => {
    if (message.role !== 'toolResult') return
    const result = message as HarnessToolResultMessage
    map.set(result.toolCallId, projectToolResultMessage(result, sourceEntryIdOf(input, index)))
  })
  return map
}

type GroupAccumulator = {
  firstIndex: number
  parts: HarnessMessageViewPart[]
  lastAssistant: HarnessAssistantMessage
  /** 组内最后一条权威消息的来源 entryId（用于树定位）。 */
  sourceEntryId?: string
}

const toolViewOfExecution = (
  execution: HarnessToolExecutionState,
  sourceEntryId?: string,
): HarnessToolViewPart => {
  const result = projectToolResultContent(
    readToolResultContent(execution.partialResult),
    sourceEntryId,
  )
  const details = readToolResultDetails(execution.partialResult)
  return {
    type: 'tool',
    toolCallId: execution.toolCallId,
    toolName: execution.toolName ?? 'unknown',
    arguments: (execution.args as Record<string, unknown> | undefined) ?? {},
    status: execution.status,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.images !== undefined ? { outputImages: result.images } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(execution.status === 'running' && result.output !== undefined
      ? { isPreliminary: true }
      : {}),
    ...(execution.parentToolCallId ? { parentToolCallId: execution.parentToolCallId } : {}),
    ...(sourceEntryId ? { sourceEntryId } : {}),
  }
}

/** 把实时工具执行映射为展示部分（用于独立子调用）。 */
const toolViewOfCall = (
  call: HarnessToolCall,
  input: HarnessMessageProjectionInput,
  toolResults: ReadonlyMap<string, ProjectedToolResult>,
  sourceEntryId?: string,
): HarnessToolViewPart => {
  const paired = toolResults.get(call.id)
  const live = input.toolExecutions[call.id]
  const output = paired ?? projectToolResultContent(readToolResultContent(live?.partialResult))
  // 已有最终结果时整体采用其 details，避免残留运行期任务状态。
  const details = paired ? paired.details : readToolResultDetails(live?.partialResult)
  const status: HarnessToolViewPart['status'] =
    paired !== undefined ? (paired.isError ? 'error' : 'complete') : (live?.status ?? 'running')
  return {
    type: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    arguments: call.arguments,
    status,
    ...(output.output !== undefined ? { output: output.output } : {}),
    ...(output.images !== undefined ? { outputImages: output.images } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(paired?.nestedCalls ? { nestedCalls: paired.nestedCalls } : {}),
    ...(paired === undefined && live?.status === 'running' && output.output !== undefined
      ? { isPreliminary: true }
      : {}),
    ...(live?.parentToolCallId ? { parentToolCallId: live.parentToolCallId } : {}),
    ...(sourceEntryId ? { sourceEntryId } : {}),
  }
}

const projectAssistantContent = (
  group: GroupAccumulator,
  message: HarnessAssistantMessage,
  input: HarnessMessageProjectionInput,
  toolResults: ReadonlyMap<string, ProjectedToolResult>,
  sourceEntryId: string | undefined,
) => {
  group.lastAssistant = message
  group.sourceEntryId = sourceEntryId ?? group.sourceEntryId

  for (const part of message.content) {
    if (part.type === 'text') {
      group.parts.push({
        type: 'text',
        text: part.text,
        ...(sourceEntryId ? { sourceEntryId } : {}),
      })
    } else if (part.type === 'thinking') {
      const thinking = part as HarnessThinkingContent
      group.parts.push({
        type: 'thinking',
        text: thinking.thinking || (thinking.redacted ? '[reasoning redacted]' : ''),
        ...(thinking.redacted ? { redacted: true } : {}),
        ...(sourceEntryId ? { sourceEntryId } : {}),
      })
    } else if (part.type === 'toolCall') {
      group.parts.push(toolViewOfCall(part, input, toolResults, sourceEntryId))
    }
    // 未知的助手内容部分被丢弃（开放联合的前向兼容：记录仍是权威，
    // 快照会自愈）。
  }
}

const assistantStatus = (
  group: GroupAccumulator,
  input: HarnessMessageProjectionInput,
  isLastMessageInTranscript: boolean,
): HarnessMessageViewStatus => {
  const last = group.lastAssistant
  if (last.stopReason === 'error') {
    return {
      type: 'incomplete',
      reason: 'error',
      ...(last.errorMessage ? { message: last.errorMessage } : {}),
    }
  }
  if (last.stopReason === 'aborted') {
    return { type: 'incomplete', reason: 'cancelled' }
  }
  if (last.stopReason === 'length') {
    return { type: 'incomplete', reason: 'length' }
  }
  if (input.runStatus === 'running' && isLastMessageInTranscript) {
    return { type: 'running' }
  }
  return { type: 'complete', reason: last.stopReason === 'toolUse' ? 'toolUse' : 'stop' }
}

const buildAssistantView = (
  group: GroupAccumulator,
  input: HarnessMessageProjectionInput,
  isLastMessageInTranscript: boolean,
): HarnessMessageView => {
  const last = group.lastAssistant
  return {
    id: messageId(group.firstIndex),
    role: 'assistant',
    createdAt: createdAtOf(last),
    status: assistantStatus(group, input, isLastMessageInTranscript),
    ...(group.sourceEntryId ? { sourceEntryId: group.sourceEntryId } : {}),
    metadata: {
      provider: last.provider,
      model: last.model,
      api: last.api,
      stopReason: last.stopReason,
      ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}),
    },
    parts: group.parts,
  }
}

const dataView = (
  index: number,
  message: { timestamp?: number },
  name: string,
  data: Record<string, unknown>,
  sourceEntryId?: string,
): HarnessMessageView => ({
  id: messageId(index),
  role: 'assistant',
  createdAt: createdAtOf(message),
  status: { type: 'complete', reason: 'stop' },
  ...(sourceEntryId ? { sourceEntryId } : {}),
  parts: [
    {
      type: 'data',
      name,
      data,
      ...(sourceEntryId ? { sourceEntryId } : {}),
    },
  ],
})

const projectFrom = (
  input: HarnessMessageProjectionInput,
  startIndex: number,
  toolResults: ReadonlyMap<string, ProjectedToolResult>,
  toolCallIndices: ReadonlyMap<string, number>,
): HarnessMessageView[] => {
  const { messages } = input
  const out: HarnessMessageView[] = []
  let group: GroupAccumulator | null = null
  /** 已作为内容部分出现的工具调用 ID。 */
  const contentToolIds = new Set<string>()
  /** 已输出（内容或嵌套）的工具执行 ID。 */
  const emittedExecutionIds = new Set<string>()

  const childrenByParent = new Map<string, HarnessToolExecutionState[]>()
  for (const execution of Object.values(input.toolExecutions)) {
    if (!execution.parentToolCallId) continue
    const siblings = childrenByParent.get(execution.parentToolCallId)
    if (siblings) siblings.push(execution)
    else childrenByParent.set(execution.parentToolCallId, [execution])
  }

  /** 找到执行的根工具调用下标；没有可定位的根时回落到最后一条助手消息。 */
  const rootIndexOfExecution = (execution: HarnessToolExecutionState): number | undefined => {
    let current = execution
    const seen = new Set<string>()
    while (current.parentToolCallId) {
      if (seen.has(current.toolCallId)) break
      seen.add(current.toolCallId)
      const parent = input.toolExecutions[current.parentToolCallId]
      if (parent) {
        current = parent
        continue
      }
      return toolCallIndices.get(current.parentToolCallId)
    }
    return toolCallIndices.get(current.toolCallId) ?? trailingAssistantMessageIndex(messages)
  }

  const appendNested = (
    parentId: string,
    sourceEntryId: string | undefined,
    sink: HarnessMessageViewPart[],
  ) => {
    const children = childrenByParent.get(parentId)
    if (!children) return
    for (const child of children) {
      if (emittedExecutionIds.has(child.toolCallId)) continue
      emittedExecutionIds.add(child.toolCallId)
      sink.push(toolViewOfExecution(child, sourceEntryId))
      appendNested(child.toolCallId, sourceEntryId, sink)
    }
  }

  const flush = (isLast: boolean) => {
    if (!group) return
    for (const part of group.parts) {
      if (part.type === 'tool') emittedExecutionIds.add(part.toolCallId)
    }
    for (const id of contentToolIds) appendNested(id, group.sourceEntryId, group.parts)
    out.push(buildAssistantView(group, input, isLast))
    group = null
    contentToolIds.clear()
  }

  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index]
    if (message === undefined) continue
    if (
      index === input.compaction?.messageIndex ||
      index === input.compaction?.summary?.messageIndex
    ) {
      flush(false)
    }
    const isLast = index === messages.length - 1
    const sourceEntryId = sourceEntryIdOf(input, index)
    switch (message.role) {
      case 'assistant': {
        if (!group) {
          group = {
            firstIndex: index,
            parts: [],
            lastAssistant: message as HarnessAssistantMessage,
            sourceEntryId,
          }
        }
        projectAssistantContent(
          group,
          message as HarnessAssistantMessage,
          input,
          toolResults,
          sourceEntryId,
        )
        for (const part of (message as HarnessAssistantMessage).content) {
          if (part.type === 'toolCall') contentToolIds.add(part.id)
        }
        // 若这是记录的末条消息，组状态要反映实时运行；flush 使它传播出去。
        if (isLast) flush(true)
        break
      }

      case 'toolResult': {
        // 能找到助手 toolCall 的结果由该工具部分配对；找不到调用来源的
        // 历史结果仍单独显示，不能因为记录顺序/裁剪而整条消失。
        const result = message as HarnessToolResultMessage
        if (toolCallIndices.has(result.toolCallId)) {
          // 保持助手组打开，使后续助手轮次合并进来。
          break
        }
        const projected = toolResults.get(result.toolCallId)
        if (!projected) break
        flush(false)
        out.push({
          id: messageId(index),
          role: 'assistant',
          createdAt: createdAtOf(result),
          status: { type: 'complete', reason: 'stop' },
          sourceEntryId: sourceEntryId ?? projected.sourceEntryId,
          parts: [
            toolViewOfResult({
              ...projected,
              ...(sourceEntryId ? { sourceEntryId } : {}),
            }),
          ],
        })
        break
      }

      case 'user': {
        flush(false)
        out.push({
          id: messageId(index),
          role: 'user',
          createdAt: createdAtOf(message as HarnessUserMessage),
          status: { type: 'complete', reason: 'stop' },
          ...(sourceEntryId ? { sourceEntryId } : {}),
          parts: projectUserContent((message as HarnessUserMessage).content, sourceEntryId),
        })
        break
      }

      case 'bashExecution': {
        flush(false)
        const bash = message as HarnessBashExecutionMessage
        out.push(
          dataView(
            index,
            bash,
            'pi-bash-execution',
            {
              command: bash.command,
              output: bash.output,
              exitCode: bash.exitCode,
              cancelled: bash.cancelled,
              truncated: bash.truncated,
              fullOutputPath: bash.fullOutputPath,
              // `!!` 的历史卡片需要标明「不进入模型上下文」。
              excludeFromContext: bash.excludeFromContext === true,
            },
            sourceEntryId,
          ),
        )
        break
      }

      case 'custom': {
        flush(false)
        const custom = message as HarnessCustomMessage
        if (!custom.display) break // 对 UI 隐藏，仍在 LLM 上下文中
        const parts: HarnessMessageViewPart[] = [
          {
            type: 'data',
            name: 'pi-custom-message',
            data: { customType: custom.customType, details: custom.details },
            ...(sourceEntryId ? { sourceEntryId } : {}),
          },
          ...projectUserContent(custom.content, sourceEntryId),
        ]
        out.push({
          id: messageId(index),
          role: 'assistant',
          createdAt: createdAtOf(custom),
          status: { type: 'complete', reason: 'stop' },
          ...(sourceEntryId ? { sourceEntryId } : {}),
          parts,
        })
        break
      }

      case 'system': {
        // 系统提示快照是会话元数据（含绝对路径与工具清单），不是对话轮次；
        // 未知角色仍走下面的可读回退，这里只跳过已知的 system 记录。
        break
      }

      case 'branchSummary': {
        flush(false)
        const branch = message as HarnessBranchSummaryMessage
        out.push(
          dataView(
            index,
            branch,
            'pi-branch-summary',
            { summary: branch.summary, fromId: branch.fromId },
            sourceEntryId,
          ),
        )
        break
      }

      case 'compactionSummary': {
        const compaction = message as HarnessCompactionSummaryMessage
        // 当前成功操作对应的摘要由消息区状态行展示；不改变模型消息顺序。
        if (
          (input.compaction?.summary?.entryId === sourceEntryId ||
            (input.compaction?.status === 'compacted' &&
              input.compaction.entryId === sourceEntryId)) &&
          sourceEntryId !== undefined
        ) {
          flush(false)
          break
        }
        flush(false)
        out.push(
          dataView(
            index,
            compaction,
            'pi-compaction-summary',
            { summary: compaction.summary, tokensBefore: compaction.tokensBefore },
            sourceEntryId,
          ),
        )
        break
      }

      default: {
        flush(false)
        out.push(
          dataView(
            index,
            message,
            'pi-unsupported-message',
            { role: message.role, message },
            sourceEntryId,
          ),
        )
        break
      }
    }
  }

  // 记录以 `toolResult` 结尾会让助手组保持打开；标记为 last
  // 使实时运行状态（"running"）传播出去。
  flush(true)

  // 缺父项的嵌套执行（或没有内容部分的独立执行）仍必须可读。
  // 只输出属于本次投影范围的根执行；否则增量后缀会把已在前缀展示的
  // 历史工具重复附到末尾。
  const executions = Object.values(input.toolExecutions)
  const executionIds = new Set(executions.map((item) => item.toolCallId))
  const orphanRoots = executions
    .filter((execution) => {
      if (emittedExecutionIds.has(execution.toolCallId)) return false
      if (contentToolIds.has(execution.toolCallId)) return false
      const parentId = execution.parentToolCallId
      // 有父执行或父调用时由祖先统一递归输出；只有完全缺父项的子树才是根。
      if (parentId && (executionIds.has(parentId) || toolCallIndices.has(parentId))) {
        return false
      }
      const rootIndex = rootIndexOfExecution(execution)
      return rootIndex === undefined || rootIndex >= startIndex
    })
    .sort((left, right) => {
      const leftIndex = rootIndexOfExecution(left) ?? Number.MAX_SAFE_INTEGER
      const rightIndex = rootIndexOfExecution(right) ?? Number.MAX_SAFE_INTEGER
      return leftIndex === rightIndex
        ? left.toolCallId.localeCompare(right.toolCallId)
        : leftIndex - rightIndex
    })

  if (orphanRoots.length > 0) {
    const last = out.at(-1)
    const orphanParts: HarnessMessageViewPart[] = []
    for (const root of orphanRoots) {
      if (emittedExecutionIds.has(root.toolCallId)) continue
      emittedExecutionIds.add(root.toolCallId)
      orphanParts.push(toolViewOfExecution(root, last?.sourceEntryId))
      appendNested(root.toolCallId, last?.sourceEntryId, orphanParts)
    }
    if (last && last.role === 'assistant') {
      out[out.length - 1] = { ...last, parts: [...last.parts, ...orphanParts] }
    } else {
      out.push({
        id: messageId(messages.length),
        role: 'assistant',
        createdAt: 0,
        status: { type: 'complete', reason: 'stop' },
        parts: orphanParts,
      })
    }
  }
  return out
}

/** 投影整段记录为展示消息数组。 */
export const projectHarnessMessages = (
  input: HarnessMessageProjectionInput,
): HarnessMessageView[] =>
  projectFrom(input, 0, buildToolResultMap(input), buildToolCallIndices(input.messages))

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

const sameMessageView = (a: HarnessMessageView, b: HarnessMessageView): boolean =>
  a.id === b.id &&
  a.role === b.role &&
  a.createdAt === b.createdAt &&
  deepEqual(a.status, b.status) &&
  a.sourceEntryId === b.sourceEntryId &&
  deepEqual(a.metadata, b.metadata) &&
  deepEqual(a.parts, b.parts)

/**
 * 与上一轮投影共享引用：内容未变的展示消息复用旧对象，
 * 使 React 的引用比较不产生无谓重渲染。
 */
export const shareHarnessMessageViews = (
  next: readonly HarnessMessageView[],
  previous: readonly HarnessMessageView[],
): readonly HarnessMessageView[] => {
  let changed = next.length !== previous.length
  const shared = next.map((message, index) => {
    const prev = previous[index]
    if (prev && sameMessageView(message, prev)) return prev
    changed = true
    return message
  })
  return changed ? shared : previous
}

const firstChangedMessageIndex = (
  previous: readonly HarnessAgentMessage[],
  next: readonly HarnessAgentMessage[],
): number | undefined => {
  const sharedLength = Math.min(previous.length, next.length)
  for (let index = 0; index < sharedLength; index++) {
    if (previous[index] !== next[index]) return index
  }
  return previous.length === next.length ? undefined : sharedLength
}

const collectToolResultIds = (
  messages: readonly HarnessAgentMessage[],
  startIndex: number,
  ids: Set<string>,
) => {
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index]
    if (message === undefined || message.role !== 'toolResult') continue
    ids.add((message as HarnessToolResultMessage).toolCallId)
  }
}

const isAssistantGroupMessage = (message: HarnessAgentMessage | undefined) => {
  const role = message?.role
  return role === 'assistant' || role === 'toolResult'
}

const assistantGroupStart = (messages: readonly HarnessAgentMessage[], index: number) => {
  if (index >= messages.length || !isAssistantGroupMessage(messages[index])) return index
  let start = index
  while (start > 0 && isAssistantGroupMessage(messages[start - 1])) start -= 1
  return start
}

const trailingAssistantMessageIndex = (messages: readonly HarnessAgentMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = messages[index]?.role
    if (role === undefined) continue
    if (role === 'assistant') return index
    if (role !== 'toolResult') return undefined
  }
  return undefined
}

const projectedSourceIndex = (message: HarnessMessageView) => {
  if (typeof message.id !== 'string' || !message.id.startsWith('pi-msg:')) return undefined
  const index = Number(message.id.slice('pi-msg:'.length))
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined
}

/** 压缩状态行在展示消息中的插入下标；按服务端消息锚点而不是摘要位置。 */
export const compactionStatusViewIndex = (
  views: readonly HarnessMessageView[],
  compaction: HarnessCompactionPhase | undefined,
): number => {
  const messageIndex = compaction?.messageIndex
  if (messageIndex === undefined) return views.length
  // 展示消息按来源下标递增；使用二分查找避免流式渲染逐条扫描。
  let low = 0
  let high = views.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const sourceIndex = projectedSourceIndex(views[middle] as HarnessMessageView)
    if (sourceIndex === undefined) {
      for (let index = 0; index < views.length; index++) {
        const fallback = projectedSourceIndex(views[index] as HarnessMessageView)
        if (fallback !== undefined && fallback >= messageIndex) return index
      }
      return views.length
    }
    if (sourceIndex >= messageIndex) high = middle
    else low = middle + 1
  }
  return low
}

const validatedProjectedSourceIndices = (
  messages: readonly HarnessMessageView[],
  minimumExclusive = -1,
): number[] | undefined => {
  const indices: number[] = []
  let previous = minimumExclusive
  for (const message of messages) {
    const index = projectedSourceIndex(message)
    if (index === undefined || index <= previous) return undefined
    indices.push(index)
    previous = index
  }
  return indices
}

const firstProjectedIndexAtOrAfter = (indices: readonly number[], sourceIndex: number) => {
  let low = 0
  let high = indices.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const projectedIndex = indices[middle]
    if (projectedIndex !== undefined && projectedIndex >= sourceIndex) high = middle
    else low = middle + 1
  }
  return low
}

const updateToolResults = (
  toolResults: Map<string, ProjectedToolResult>,
  previous: readonly HarnessAgentMessage[],
  next: readonly HarnessAgentMessage[],
  nextEntryIds: readonly (string | null)[] | undefined,
  startIndex: number,
) => {
  for (let index = startIndex; index < previous.length; index++) {
    const message = previous[index]
    if (message === undefined || message.role !== 'toolResult') continue
    toolResults.delete((message as HarnessToolResultMessage).toolCallId)
  }
  for (let index = startIndex; index < next.length; index++) {
    const message = next[index]
    if (message === undefined || message.role !== 'toolResult') continue
    const result = message as HarnessToolResultMessage
    toolResults.set(
      result.toolCallId,
      projectToolResultMessage(result, nextEntryIds?.[index] ?? undefined),
    )
  }
}

const buildToolCallIndices = (messages: readonly HarnessAgentMessage[]) => {
  const indices = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    for (const part of (message as HarnessAssistantMessage).content) {
      if (part.type === 'toolCall' && !indices.has(part.id)) indices.set(part.id, index)
    }
  })
  return indices
}

const changedToolExecutionIds = (
  previous: Readonly<Record<string, HarnessToolExecutionState>>,
  next: Readonly<Record<string, HarnessToolExecutionState>>,
): Set<string> => {
  const ids = new Set<string>()
  if (previous === next) return ids
  for (const id of Object.keys(previous)) {
    if (previous[id] !== next[id]) ids.add(id)
  }
  for (const id of Object.keys(next)) {
    if (previous[id] !== next[id]) ids.add(id)
  }
  return ids
}

/** 找到工具执行所属的顶层工具调用下标；缺父项时回落到最后一条助手消息。 */
const rootToolCallIndex = (
  id: string,
  executions: Readonly<Record<string, HarnessToolExecutionState>>,
  indices: ReadonlyMap<string, number>,
  messages: readonly HarnessAgentMessage[],
): number | undefined => {
  let current: string | undefined = id
  const seen = new Set<string>()
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const index = indices.get(current)
    if (index !== undefined) return index
    current = executions[current]?.parentToolCallId
  }
  return trailingAssistantMessageIndex(messages)
}

/**
 * 增量投影器：缓存上一次输入与投影结果，只重投影变更的后缀。
 *
 * 这是流式性能的关键——每帧只重算受影响的部分，
 * 并通过 `shareHarnessMessageViews` 复用未变消息的引用。
 */
export class HarnessMessageViewProjector {
  private previousInput: HarnessMessageProjectionInput | undefined
  private views: readonly HarnessMessageView[] = []
  private projectedSourceIndices: number[] | undefined = []
  private changedViewIndex: number | undefined
  private toolResults = new Map<string, ProjectedToolResult>()
  private toolCallIndices = new Map<string, number>()

  /** 本次投影中首个发生变化的展示消息下标（供订阅者判断是否需要通知）。 */
  public getChangedViewIndex() {
    return this.changedViewIndex
  }

  public project(input: HarnessMessageProjectionInput): readonly HarnessMessageView[] {
    const previousInput = this.previousInput
    if (!previousInput) {
      const previousViews = this.views
      this.toolResults = buildToolResultMap(input)
      this.toolCallIndices = buildToolCallIndices(input.messages)
      this.views = shareHarnessMessageViews(
        projectFrom(input, 0, this.toolResults, this.toolCallIndices),
        this.views,
      )
      this.projectedSourceIndices = validatedProjectedSourceIndices(this.views)
      this.changedViewIndex = this.views === previousViews ? undefined : 0
      this.previousInput = input
      return this.views
    }

    // 压缩状态变化会影响摘要是否展示与插入位置；直接重投影，避免增量边界错位。
    if (previousInput.compaction !== input.compaction) {
      const previousViews = this.views
      this.toolResults = buildToolResultMap(input)
      this.toolCallIndices = buildToolCallIndices(input.messages)
      this.views = shareHarnessMessageViews(
        projectFrom(input, 0, this.toolResults, this.toolCallIndices),
        this.views,
      )
      this.projectedSourceIndices = validatedProjectedSourceIndices(this.views)
      this.changedViewIndex = this.views === previousViews ? undefined : 0
      this.previousInput = input
      return this.views
    }

    const messageChangeIndex = firstChangedMessageIndex(previousInput.messages, input.messages)
    const changedTools = changedToolExecutionIds(previousInput.toolExecutions, input.toolExecutions)

    const affectedToolCallIds = changedTools
    let dirtyIndex = messageChangeIndex
    if (previousInput.messageEntryIds !== input.messageEntryIds) {
      const previousIds = previousInput.messageEntryIds ?? []
      const nextIds = input.messageEntryIds ?? []
      const length = Math.max(previousIds.length, nextIds.length)
      for (let index = 0; index < length; index++) {
        if (previousIds[index] !== nextIds[index]) {
          dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
          break
        }
      }
    }
    if (messageChangeIndex !== undefined) {
      dirtyIndex = Math.min(
        dirtyIndex ?? messageChangeIndex,
        ...[
          trailingAssistantMessageIndex(previousInput.messages),
          trailingAssistantMessageIndex(input.messages),
        ].filter((index) => index !== undefined),
      )
      collectToolResultIds(previousInput.messages, messageChangeIndex, affectedToolCallIds)
      collectToolResultIds(input.messages, messageChangeIndex, affectedToolCallIds)
    }

    const toolExecutionById = { ...previousInput.toolExecutions, ...input.toolExecutions }
    for (const id of affectedToolCallIds) {
      const index = rootToolCallIndex(id, toolExecutionById, this.toolCallIndices, input.messages)
      if (index !== undefined)
        dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
    }

    if (
      messageChangeIndex !== undefined ||
      previousInput.messageEntryIds !== input.messageEntryIds
    ) {
      updateToolResults(
        this.toolResults,
        previousInput.messages,
        input.messages,
        input.messageEntryIds,
        messageChangeIndex ?? 0,
      )
      this.toolCallIndices = buildToolCallIndices(input.messages)
      for (const id of affectedToolCallIds) {
        const index = rootToolCallIndex(id, toolExecutionById, this.toolCallIndices, input.messages)
        if (index !== undefined) {
          dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
        }
      }
    }

    if (previousInput.runStatus !== input.runStatus) {
      const index = trailingAssistantMessageIndex(input.messages)
      if (index !== undefined)
        dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
    }

    if (dirtyIndex === undefined) {
      this.changedViewIndex = undefined
      this.previousInput = input
      return this.views
    }

    const startIndex = Math.min(
      assistantGroupStart(previousInput.messages, dirtyIndex),
      assistantGroupStart(input.messages, dirtyIndex),
    )
    const projectedBoundary = this.projectedSourceIndices
      ? firstProjectedIndexAtOrAfter(this.projectedSourceIndices, startIndex)
      : undefined
    const projectedStartIndex = projectedBoundary ?? 0
    const projectionStartIndex = projectedBoundary === undefined ? 0 : startIndex
    const previousSuffix = this.views.slice(projectedStartIndex)
    const nextSuffix = shareHarnessMessageViews(
      projectFrom(input, projectionStartIndex, this.toolResults, this.toolCallIndices),
      previousSuffix,
    )

    if (
      nextSuffix.length === previousSuffix.length &&
      nextSuffix.every((message, index) => message === this.views[projectedStartIndex + index])
    ) {
      if (this.projectedSourceIndices === undefined) {
        this.projectedSourceIndices = validatedProjectedSourceIndices(this.views)
      }
      this.changedViewIndex = undefined
      this.previousInput = input
      return this.views
    }

    if (this.projectedSourceIndices) {
      const suffixSourceIndices = validatedProjectedSourceIndices(
        nextSuffix,
        this.projectedSourceIndices[projectedStartIndex - 1],
      )
      if (suffixSourceIndices) {
        this.projectedSourceIndices.splice(
          projectedStartIndex,
          this.projectedSourceIndices.length - projectedStartIndex,
        )
        for (const index of suffixSourceIndices) this.projectedSourceIndices.push(index)
      } else {
        this.projectedSourceIndices = undefined
      }
    } else {
      this.projectedSourceIndices = validatedProjectedSourceIndices(nextSuffix)
    }
    this.views = [...this.views.slice(0, projectedStartIndex), ...nextSuffix]
    this.changedViewIndex = projectedStartIndex
    this.previousInput = input
    return this.views
  }
}
