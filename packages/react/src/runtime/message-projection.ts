/**
 * 权威 Pi 记录（`HarnessAgentMessage[]`）到 assistant-ui
 * `ThreadMessageLike[]` / `ExportedMessageRepository` 的纯投影。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的
 * `src/runtime/messageProjection.ts`（MIT 许可）。改动：类型改用
 * `@huan/protocol`，命名 `Pi*` → `Harness*`，上游内部工具改从
 * `../vendor/anti-corruption.js` 引入，注释译为中文。
 * 逻辑与上游逐行等价。
 *
 * 设计：
 * - 每个 Pi **轮次**是一条助手消息（text/thinking/toolCall 部分）。多步运行
 *   是若干助手消息与 `toolResult` 消息交错。我们把一段最长的助手 +
 *   toolResult 消息串**合并**为单条助手 `ThreadMessageLike`，每轮一个
 *   `ThreadStep`，并用 `parentId` 把该轮的部分链接到它的 step
 *   （使思维链 + 工具工作可视分组）。
 * - `toolResult` 消息按 `toolCallId` 配对进其 `tool-call` 部分
 *   （并行工具完成顺序与来源顺序无关——配对按 id，不按位置）。
 * - 实时流式工具输出（`toolExecutions[id].partialResult`）填充工具调用的
 *   `result`，在工具仍在运行时标记 `isPreliminary`，直到最终 `toolResult`
 *   消息落地。
 * - 工具关联的 Host UI 请求投影到工具调用的 `approval`
 *   （`approvalForRequest`）。游离请求留在侧信道（不在此投影）。
 * - 其他所有 Pi 角色（`bashExecution`、`custom`、`branchSummary`、
 *   `compactionSummary`、未知）成为独立的 `DataMessagePart`。
 *
 * 浏览器安全，不导入任何 Pi SDK 包。
 */

import type {
  ThreadMessageLike,
  ToolCallMessagePart,
  ToolModelContentPart,
} from '@assistant-ui/react'
import { ExportedMessageRepository } from '@assistant-ui/react'
import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessBashExecutionMessage,
  HarnessBranchSummaryMessage,
  HarnessCompactionSummaryMessage,
  HarnessCustomMessage,
  HarnessHostUiRequest,
  HarnessToolResultContent,
  HarnessToolResultMessage,
  HarnessUserContent,
  HarnessUserMessage,
} from '@huan/protocol'
import { isParsableUrl, parseDataUrl } from '../vendor/anti-corruption.js'
import { approvalForRequest, splitHostUiRequests } from './host-ui.js'
import type { HarnessThreadState } from './thread-state.js'

type ContentPart = Exclude<ThreadMessageLike['content'], string>[number]
type ToolCallPart = Extract<ContentPart, { type: 'tool-call' }> &
  Pick<ToolCallMessagePart, 'modelContent'>
type Step = NonNullable<NonNullable<ThreadMessageLike['metadata']>['steps']>[number]

/** 投影输入：记录 + 实时运行态。 */
export interface HarnessProjectionInput {
  messages: readonly HarnessAgentMessage[]
  /** 与 messages 等长的来源 entryId；用于树定位，不从下标/时间戳猜测。 */
  messageEntryIds?: readonly (string | null)[]
  toolExecutions: HarnessThreadState['toolExecutions']
  runStatus: HarnessThreadState['runStatus']
  hostUiRequests: readonly HarnessHostUiRequest[]
}

/** 取某条权威消息的来源 entryId（缺失/空值返回 undefined）。 */
const sourceEntryIdOf = (input: HarnessProjectionInput, index: number): string | undefined =>
  input.messageEntryIds?.[index] ?? undefined

/** 投影消息的来源元数据（assistant-ui 自定义字段，供树定位复用）。 */
const sourceMetadata = (sourceEntryId: string | undefined) =>
  sourceEntryId ? { custom: { pi: { sourceEntryId } } } : undefined

const messageId = (index: number) => `pi-msg:${index}`
const stepId = (index: number) => `pi-step:${index}`

const toDataUrl = (data: string, mimeType: string) =>
  isParsableUrl(data) ? data : `data:${mimeType};base64,${data}`

const createdAtOf = (message: { timestamp?: number }): Date =>
  new Date(typeof message.timestamp === 'number' ? message.timestamp : 0)

const projectToolResult = (
  content: readonly HarnessToolResultContent[] | undefined,
): Pick<ToolCallPart, 'result' | 'modelContent'> => {
  if (!content) return {}
  const result = content
    .filter(
      (part): part is Extract<HarnessToolResultContent, { type: 'text' }> => part.type === 'text',
    )
    .map((part) => part.text)
    .join('')
  if (content.every((part) => part.type === 'text')) return { result }

  const modelContent = content.flatMap<ToolModelContentPart>((part) => {
    if (part.type === 'text') {
      return [{ type: 'text' as const, text: part.text }]
    }
    const parsed = parseDataUrl(part.data)
    return [
      {
        type: 'file' as const,
        data: parsed?.data ?? part.data,
        mediaType: parsed?.mimeType ?? part.mimeType,
      },
    ]
  })

  return { result, modelContent }
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

const projectUserContent = (content: HarnessUserMessage['content']): ContentPart[] => {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content.flatMap((part: HarnessUserContent): ContentPart[] => {
    if (part.type === 'image') {
      return [{ type: 'image', image: toDataUrl(part.data, part.mimeType) }]
    }
    if (part.type === 'text') return [{ type: 'text', text: part.text }]
    return []
  })
}

const dataPart = (name: string, data: Record<string, unknown>): ContentPart => ({
  type: 'data',
  name,
  data,
})

/** 跨整个记录构建 toolCallId → 结果的配对映射，使乱序的并行结果正确配对。 */
type ProjectedToolResult = Pick<ToolCallPart, 'result' | 'modelContent'> & {
  isError: boolean
  details: unknown
}

const projectToolResultMessage = (message: HarnessToolResultMessage): ProjectedToolResult => ({
  ...projectToolResult(readToolResultContent({ content: message.content })),
  isError: message.isError,
  details: message.details,
})

const buildToolResultMap = (messages: readonly HarnessAgentMessage[]) => {
  const map = new Map<string, ProjectedToolResult>()
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    const m = message as HarnessToolResultMessage
    map.set(m.toolCallId, projectToolResultMessage(m))
  }
  return map
}

type GroupAccumulator = {
  firstIndex: number
  parts: ContentPart[]
  steps: Step[]
  /** 组内最新的助手消息（决定最终状态）。 */
  lastAssistant: HarnessAssistantMessage
  hasPendingHostUi: boolean
  /** 组内最后一条权威消息的来源 entryId（用于树定位）。 */
  sourceEntryId?: string
}

const projectAssistantInto = (
  group: GroupAccumulator,
  message: HarnessAssistantMessage,
  index: number,
  input: HarnessProjectionInput,
  toolResults: ReturnType<typeof buildToolResultMap>,
  hostUiByToolCall: ReadonlyMap<string, HarnessHostUiRequest>,
) => {
  const parentId = stepId(index)
  group.lastAssistant = message
  group.sourceEntryId = sourceEntryIdOf(input, index) ?? group.sourceEntryId
  group.steps.push({
    messageId: parentId,
    usage: {
      inputTokens: message.usage?.input ?? 0,
      outputTokens: message.usage?.output ?? 0,
    },
  })

  for (const part of message.content) {
    if (part.type === 'text') {
      group.parts.push({ type: 'text', text: part.text, parentId })
    } else if (part.type === 'thinking') {
      const text = part.thinking || (part.redacted ? '[reasoning redacted]' : '')
      group.parts.push({ type: 'reasoning', text, parentId })
    } else if (part.type === 'toolCall') {
      const paired = toolResults.get(part.id)
      const live = input.toolExecutions[part.id]
      const output = paired ?? projectToolResult(readToolResultContent(live?.partialResult))
      const isError = paired?.isError ?? live?.status === 'error'

      const hostUi = hostUiByToolCall.get(part.id)
      const approval = hostUi && approvalForRequest(hostUi)

      const toolCall: ToolCallPart = {
        type: 'tool-call',
        toolCallId: part.id,
        toolName: part.name,
        args: (part.arguments ?? {}) as unknown as NonNullable<ToolCallPart['args']>,
        argsText: JSON.stringify(part.arguments ?? {}),
        parentId,
        ...(output.result !== undefined ? { result: output.result } : {}),
        ...(output.modelContent !== undefined ? { modelContent: output.modelContent } : {}),
        ...(isError ? { isError: true } : {}),
        ...(paired === undefined && output.result !== undefined && live?.status === 'running'
          ? { isPreliminary: true }
          : {}),
        ...(approval ? { approval } : {}),
      }

      if (approval) group.hasPendingHostUi = true
      group.parts.push(toolCall)
    }
    // 未知的助手内容部分被丢弃（开放联合的前向兼容：记录仍是权威，
    // 快照会自愈）。
  }
}

const buildAssistantMessage = (
  group: GroupAccumulator,
  input: HarnessProjectionInput,
  isLastMessageInTranscript: boolean,
): ThreadMessageLike => {
  const last = group.lastAssistant
  const status = assistantStatus(group, input, isLastMessageInTranscript)

  return {
    id: messageId(group.firstIndex),
    role: 'assistant',
    createdAt: createdAtOf(last),
    content: group.parts,
    ...(status ? { status } : {}),
    metadata: {
      steps: group.steps,
      custom: {
        pi: {
          provider: last.provider,
          model: last.model,
          api: last.api,
          usage: last.usage,
          stopReason: last.stopReason,
          ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}),
          ...(group.sourceEntryId ? { sourceEntryId: group.sourceEntryId } : {}),
        },
      },
    },
  }
}

const assistantStatus = (
  group: GroupAccumulator,
  input: HarnessProjectionInput,
  isLastMessageInTranscript: boolean,
): ThreadMessageLike['status'] => {
  if (group.hasPendingHostUi) {
    return { type: 'requires-action', reason: 'interrupt' }
  }
  const last = group.lastAssistant
  if (
    input.runStatus === 'running' &&
    isLastMessageInTranscript &&
    last.stopReason !== 'error' &&
    last.stopReason !== 'aborted'
  ) {
    return { type: 'running' }
  }
  if (last.stopReason === 'error') {
    return {
      type: 'incomplete',
      reason: 'error',
      ...(last.errorMessage ? { error: last.errorMessage } : {}),
    }
  }
  if (last.stopReason === 'aborted') {
    return { type: 'incomplete', reason: 'cancelled' }
  }
  if (last.stopReason === 'length') {
    return { type: 'incomplete', reason: 'length' }
  }
  return { type: 'complete', reason: 'stop' }
}

const projectHarnessThreadMessagesFrom = (
  input: HarnessProjectionInput,
  startIndex: number,
  toolResults: ReturnType<typeof buildToolResultMap>,
): ThreadMessageLike[] => {
  const { messages } = input
  const hostUiByToolCall = splitHostUiRequests(input.hostUiRequests).toolAssociated
  const out: ThreadMessageLike[] = []
  let group: GroupAccumulator | null = null

  const flush = (isLast: boolean) => {
    if (!group) return
    out.push(buildAssistantMessage(group, input, isLast))
    group = null
  }

  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index]
    if (message === undefined) continue
    const isLast = index === messages.length - 1
    switch (message.role) {
      case 'assistant': {
        if (!group) {
          group = {
            firstIndex: index,
            parts: [],
            steps: [],
            lastAssistant: message as HarnessAssistantMessage,
            hasPendingHostUi: false,
          }
        }
        projectAssistantInto(
          group,
          message as HarnessAssistantMessage,
          index,
          input,
          toolResults,
          hostUiByToolCall,
        )
        // 若这是记录的末条消息，组状态要反映实时运行；flush 使它传播出去。
        if (isLast) flush(true)
        break
      }

      case 'toolResult':
        // 按 id 配对进 tool-call 部分；从不单独发出。
        // 保持助手组打开，使后续助手轮次合并进来。
        break

      case 'user':
        flush(false)
        out.push({
          id: messageId(index),
          role: 'user',
          createdAt: createdAtOf(message as HarnessUserMessage),
          content: projectUserContent((message as HarnessUserMessage).content),
          ...(sourceMetadata(sourceEntryIdOf(input, index))
            ? { metadata: sourceMetadata(sourceEntryIdOf(input, index)) }
            : {}),
        })
        break

      case 'bashExecution': {
        flush(false)
        const m = message as HarnessBashExecutionMessage
        out.push(
          standaloneData(
            index,
            m,
            'pi-bash-execution',
            {
              command: m.command,
              output: m.output,
              exitCode: m.exitCode,
              cancelled: m.cancelled,
              truncated: m.truncated,
              fullOutputPath: m.fullOutputPath,
              // `!!` 的历史卡片需要标明「不进入模型上下文」。
              excludeFromContext: m.excludeFromContext === true,
            },
            sourceEntryIdOf(input, index),
          ),
        )
        break
      }

      case 'custom': {
        flush(false)
        const m = message as HarnessCustomMessage
        if (!m.display) break // 对 UI 隐藏，仍在 LLM 上下文中
        out.push({
          id: messageId(index),
          role: 'assistant',
          createdAt: createdAtOf(m),
          content: [
            dataPart('pi-custom-message', {
              customType: m.customType,
              details: m.details,
            }),
            ...projectUserContent(m.content),
          ],
          ...(sourceMetadata(sourceEntryIdOf(input, index))
            ? { metadata: sourceMetadata(sourceEntryIdOf(input, index)) }
            : {}),
        })
        break
      }

      case 'branchSummary': {
        flush(false)
        const m = message as HarnessBranchSummaryMessage
        out.push(
          standaloneData(
            index,
            m,
            'pi-branch-summary',
            {
              summary: m.summary,
              fromId: m.fromId,
            },
            sourceEntryIdOf(input, index),
          ),
        )
        break
      }

      case 'compactionSummary': {
        flush(false)
        const m = message as HarnessCompactionSummaryMessage
        out.push(
          standaloneData(
            index,
            m,
            'pi-compaction-summary',
            {
              summary: m.summary,
              tokensBefore: m.tokensBefore,
            },
            sourceEntryIdOf(input, index),
          ),
        )
        break
      }

      default:
        flush(false)
        out.push(
          standaloneData(
            index,
            message,
            'pi-unsupported-message',
            {
              role: message.role,
              message,
            },
            sourceEntryIdOf(input, index),
          ),
        )
        break
    }
  }

  // 记录以 `toolResult` 结尾会让助手组保持打开；标记为 last
  // 使实时运行状态（"running"）传播出去。
  flush(true)
  return out
}

/** 投影整段记录为 assistant-ui 消息数组。 */
export const projectHarnessThreadMessages = (input: HarnessProjectionInput): ThreadMessageLike[] =>
  projectHarnessThreadMessagesFrom(input, 0, buildToolResultMap(input.messages))

const standaloneData = (
  index: number,
  message: { timestamp?: number },
  name: string,
  data: Record<string, unknown>,
  sourceEntryId?: string,
): ThreadMessageLike => ({
  id: messageId(index),
  role: 'assistant',
  createdAt: createdAtOf(message),
  content: [dataPart(name, data)],
  ...(sourceMetadata(sourceEntryId) ? { metadata: sourceMetadata(sourceEntryId) } : {}),
})

const isDateEqual = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : undefined

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true

  const dateEqual = isDateEqual(a, b)
  if (dateEqual !== undefined) return dateEqual

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

const sameThreadMessageLike = (a: ThreadMessageLike, b: ThreadMessageLike): boolean =>
  a.id === b.id &&
  a.role === b.role &&
  deepEqual(a.createdAt, b.createdAt) &&
  deepEqual(a.content, b.content) &&
  deepEqual(a.status, b.status) &&
  deepEqual(a.metadata, b.metadata)

/**
 * 与上一轮投影共享引用：内容未变的消息复用旧对象，
 * 使 `useSyncExternalStore` 的引用比较不产生无谓重渲染。
 */
export const shareProjectedThreadMessages = (
  next: readonly ThreadMessageLike[],
  previous: readonly ThreadMessageLike[],
): readonly ThreadMessageLike[] => {
  let changed = next.length !== previous.length
  const shared = next.map((message, index) => {
    const prev = previous[index]
    if (prev && sameThreadMessageLike(message, prev)) return prev
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

const updateToolResults = (
  toolResults: Map<string, ProjectedToolResult>,
  previous: readonly HarnessAgentMessage[],
  next: readonly HarnessAgentMessage[],
  startIndex: number,
) => {
  const removedIds = new Set<string>()
  for (let index = startIndex; index < previous.length; index++) {
    const message = previous[index]
    if (message === undefined || message.role !== 'toolResult') continue
    const id = (message as HarnessToolResultMessage).toolCallId
    removedIds.add(id)
    toolResults.delete(id)
  }
  for (let index = startIndex; index < next.length; index++) {
    const message = next[index]
    if (message === undefined || message.role !== 'toolResult') continue
    const result = message as HarnessToolResultMessage
    removedIds.delete(result.toolCallId)
    toolResults.set(result.toolCallId, projectToolResultMessage(result))
  }
  for (const id of removedIds) {
    for (let index = Math.min(startIndex, next.length) - 1; index >= 0; index--) {
      const message = next[index]
      if (message === undefined) continue
      if (
        message.role === 'toolResult' &&
        (message as HarnessToolResultMessage).toolCallId === id
      ) {
        toolResults.set(id, projectToolResultMessage(message as HarnessToolResultMessage))
        break
      }
    }
  }
}

const updateToolCallIndices = (
  indices: Map<string, number>,
  previous: readonly HarnessAgentMessage[],
  next: readonly HarnessAgentMessage[],
  startIndex: number,
) => {
  for (let index = startIndex; index < previous.length; index++) {
    const message = previous[index]
    if (message === undefined || message.role !== 'assistant') continue
    for (const part of (message as HarnessAssistantMessage).content) {
      if (part.type === 'toolCall' && (indices.get(part.id) ?? -1) >= startIndex) {
        indices.delete(part.id)
      }
    }
  }
  for (let index = startIndex; index < next.length; index++) {
    const message = next[index]
    if (message === undefined || message.role !== 'assistant') continue
    for (const part of (message as HarnessAssistantMessage).content) {
      if (part.type === 'toolCall' && !indices.has(part.id)) {
        indices.set(part.id, index)
      }
    }
  }
}

const buildToolCallIndices = (messages: readonly HarnessAgentMessage[]) => {
  const indices = new Map<string, number>()
  updateToolCallIndices(indices, [], messages, 0)
  return indices
}

const changedToolExecutionIds = (
  previous: HarnessProjectionInput['toolExecutions'],
  next: HarnessProjectionInput['toolExecutions'],
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

const changedHostUiToolCallIds = (
  previous: readonly HarnessHostUiRequest[],
  next: readonly HarnessHostUiRequest[],
): Set<string> => {
  const ids = new Set<string>()
  if (previous === next) return ids
  if (
    previous.length === next.length &&
    previous.every((request, index) => request === next[index])
  ) {
    return ids
  }
  for (const request of previous) {
    if (request.toolCallId) ids.add(request.toolCallId)
  }
  for (const request of next) {
    if (request.toolCallId) ids.add(request.toolCallId)
  }
  return ids
}

const isAssistantGroupMessage = (message: HarnessAgentMessage | undefined) => {
  const role = message?.role
  return role === 'assistant' || role === 'toolResult'
}

const assistantGroupStart = (messages: readonly HarnessAgentMessage[], index: number) => {
  if (index >= messages.length || !isAssistantGroupMessage(messages[index])) {
    return index
  }
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

const projectedSourceIndex = (message: ThreadMessageLike) => {
  if (typeof message.id !== 'string' || !message.id.startsWith('pi-msg:')) {
    return undefined
  }
  const index = Number(message.id.slice('pi-msg:'.length))
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined
}

const validatedProjectedSourceIndices = (
  messages: readonly ThreadMessageLike[],
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

const firstProjectedIndexAtOrAfter = (indices: readonly number[], sourceIndex: number): number => {
  let low = 0
  let high = indices.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const projectedIndex = indices[middle]
    if (projectedIndex !== undefined && projectedIndex >= sourceIndex) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low
}

/**
 * 增量投影器：缓存上一次输入与投影结果，只重投影变更的后缀。
 *
 * 这是流式性能的关键——每帧只重算受影响的部分，
 * 并通过 `shareProjectedThreadMessages` 复用未变消息的引用。
 */
export class HarnessThreadMessageProjector {
  private previousInput: HarnessProjectionInput | undefined
  private projectedMessages: readonly ThreadMessageLike[] = []
  private projectedSourceIndices: number[] | undefined = []
  private changedProjectedIndex: number | undefined
  private toolResults = new Map<string, ProjectedToolResult>()
  private toolCallIndices = new Map<string, number>()

  /** 本次投影中首个发生变化的下标（供订阅者判断是否需要通知）。 */
  public getChangedProjectedIndex() {
    return this.changedProjectedIndex
  }

  public project(input: HarnessProjectionInput): readonly ThreadMessageLike[] {
    const previousInput = this.previousInput
    if (!previousInput) {
      const previousProjectedMessages = this.projectedMessages
      this.toolResults = buildToolResultMap(input.messages)
      this.toolCallIndices = buildToolCallIndices(input.messages)
      this.projectedMessages = shareProjectedThreadMessages(
        projectHarnessThreadMessagesFrom(input, 0, this.toolResults),
        this.projectedMessages,
      )
      this.projectedSourceIndices = validatedProjectedSourceIndices(this.projectedMessages)
      this.changedProjectedIndex =
        this.projectedMessages === previousProjectedMessages ? undefined : 0
      this.previousInput = input
      return this.projectedMessages
    }

    const messageChangeIndex = firstChangedMessageIndex(previousInput.messages, input.messages)
    const affectedToolCallIds = changedToolExecutionIds(
      previousInput.toolExecutions,
      input.toolExecutions,
    )
    for (const id of changedHostUiToolCallIds(previousInput.hostUiRequests, input.hostUiRequests)) {
      affectedToolCallIds.add(id)
    }

    let dirtyIndex = messageChangeIndex
    if (messageChangeIndex !== undefined) {
      dirtyIndex = Math.min(
        messageChangeIndex,
        ...[
          trailingAssistantMessageIndex(previousInput.messages),
          trailingAssistantMessageIndex(input.messages),
        ].filter((index) => index !== undefined),
      )
      collectToolResultIds(previousInput.messages, messageChangeIndex, affectedToolCallIds)
      collectToolResultIds(input.messages, messageChangeIndex, affectedToolCallIds)
    }

    for (const id of affectedToolCallIds) {
      const index = this.toolCallIndices.get(id)
      if (index !== undefined) {
        dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
      }
    }

    if (messageChangeIndex !== undefined) {
      updateToolResults(
        this.toolResults,
        previousInput.messages,
        input.messages,
        messageChangeIndex,
      )
      updateToolCallIndices(
        this.toolCallIndices,
        previousInput.messages,
        input.messages,
        messageChangeIndex,
      )
      for (const id of affectedToolCallIds) {
        const index = this.toolCallIndices.get(id)
        if (index !== undefined) {
          dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
        }
      }
    }

    if (previousInput.runStatus !== input.runStatus) {
      const index = trailingAssistantMessageIndex(input.messages)
      if (index !== undefined) {
        dirtyIndex = dirtyIndex === undefined ? index : Math.min(dirtyIndex, index)
      }
    }

    if (dirtyIndex === undefined) {
      this.changedProjectedIndex = undefined
      this.previousInput = input
      return this.projectedMessages
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
    const previousSuffix = this.projectedMessages.slice(projectedStartIndex)
    const nextSuffix = shareProjectedThreadMessages(
      projectHarnessThreadMessagesFrom(input, projectionStartIndex, this.toolResults),
      previousSuffix,
    )

    if (
      nextSuffix.length === previousSuffix.length &&
      nextSuffix.every(
        (message, index) => message === this.projectedMessages[projectedStartIndex + index],
      )
    ) {
      if (this.projectedSourceIndices === undefined) {
        this.projectedSourceIndices = validatedProjectedSourceIndices(this.projectedMessages)
      }
      this.changedProjectedIndex = undefined
      this.previousInput = input
      return this.projectedMessages
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
        for (const index of suffixSourceIndices) {
          this.projectedSourceIndices.push(index)
        }
      } else {
        this.projectedSourceIndices = undefined
      }
    } else {
      this.projectedSourceIndices = validatedProjectedSourceIndices(nextSuffix)
    }
    this.projectedMessages = [
      ...this.projectedMessages.slice(0, projectedStartIndex),
      ...nextSuffix,
    ]
    this.changedProjectedIndex = projectedStartIndex
    this.previousInput = input
    return this.projectedMessages
  }
}

/** 投影整段记录为 assistant-ui 的消息仓库。 */
export const projectHarnessThreadRepository = (input: HarnessProjectionInput) =>
  ExportedMessageRepository.fromArray(projectHarnessThreadMessages(input))

// 仅为测试 / 高级消费者再导出
export type { ContentPart as HarnessProjectedContentPart, HarnessToolResultContent }
