/**
 * 每线程 Controller：把 Harness 客户端事件桥接为快照权威的
 * `HarnessThreadState`，并暴露运行时 hook 接进 `useExternalStoreRuntime` 的
 * 命令式动作。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的
 * `src/runtime/ThreadController.ts`（MIT 许可，见包内 THIRD-PARTY-NOTICES.md）。
 * 改动：类型改用 `@huan/protocol`，命名 `Pi*` → `Harness*`，上游内部工具改从
 * `../vendor/anti-corruption.js` 引入，注释译为中文。逻辑与上游逐行等价。
 *
 * `HarnessClient` 就是传输边界（HTTP/SSE、RPC 子进程、IPC），因此这里没有
 * 单独的事件源类。React store 订阅保持在本地；Controller 只在显式 `connect()`
 * 或需要实时运行的操作时打开事件流。`load()` 是冷读路径，由 `getThread` 播种。
 *
 * 每次新建传输订阅（显式 connect、发送触发订阅、dispose 后重连）都要求首帧快照：
 * 断开期间可能错过增量事件，靠 `loadState` 判断会漏掉重连时的历史补齐。
 *
 * 浏览器安全，不导入任何 Pi SDK 包。
 */

import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import { ExportedMessageRepository, MessageNotSentError } from '@assistant-ui/react'
import type {
  HarnessAgentMessage,
  HarnessAutoCompactionUpdateResult,
  HarnessBashAbortResult,
  HarnessBashStartResult,
  HarnessClient,
  HarnessClientEvent,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessHostUiResponse,
  HarnessImageContent,
  HarnessModelRefreshResult,
  HarnessModelScope,
  HarnessModelScopeUpdateInput,
  HarnessModelScopeUpdateResult,
  HarnessSendMessageInput,
  HarnessSendMessageResult,
  HarnessThinkingLevel,
  HarnessThreadForkInput,
  HarnessThreadForkResult,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessTreeCancelResult,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
} from '@huan/protocol'
import { errorText } from '../error-text.js'
import { isKnownHarnessClientEventType } from '../event-types.js'
import {
  bytesToBase64,
  detectImageMediaType,
  parseDataUrl,
  RunLeases,
  resolveImageMediaType,
} from '../vendor/anti-corruption.js'
import {
  type HarnessInterruptAnswer,
  responseForApproval,
  responseForInterrupt,
  responseForToolApproval,
} from './host-ui.js'
import { HarnessThreadMessageProjector } from './message-projection.js'
import {
  createHarnessThreadState,
  type HarnessThreadState,
  reduceHarnessThreadState,
  removeHostUiRequest,
} from './thread-state.js'

export type HarnessSendOptions = {
  /** 覆盖推导出的行为。线程运行时，Pi 要求必须提供此选项
   *（否则 `prompt()` 会抛错）；省略时，Controller 会根据运行状态
   * 推导出 `"followUp"` 默认值。 */
  streamingBehavior?: 'followUp' | 'steer'
}

export type HarnessNotificationScheduler = (flush: () => void) => void

/** `getStateSnapshot`（若不存在则为 `getState`）和
 * `getMessageRepository` 会被作为 `useSyncExternalStore` 快照读取，因此
 * 实现必须只在订阅的 channel 通知时才返回不同引用；每次调用都重新构造值会导致 React 循环渲染。 */
export interface HarnessThreadControllerLike {
  getState(): HarnessThreadState
  /** 截至上次 listener 通知时的 state。合并后的消息帧待处理期间，`getState()`
   * 可能领先于此状态，因此只有此方法返回值才是有效的 `useSyncExternalStore` 快照。
   * 为向后兼容而设为可选；调用方会回退到 `getState()`。 */
  getStateSnapshot?(): HarnessThreadState
  getProjectedMessages(): readonly ThreadMessageLike[]
  getMessageRepository(): ExportedMessageRepository
  getVersion(): number
  connect(): () => void
  subscribe(listener: () => void): () => void
  subscribeMetadata(listener: () => void): () => void
  subscribeMessages(listener: () => void): () => void
  load(force?: boolean): Promise<void>
  refresh(): Promise<void>
  sendMessage(message: AppendMessage, options?: HarnessSendOptions): Promise<void>
  cancel(): Promise<void>
  /** 清除 Pi 服务端的 queue；返回被清除的文本，以便 UI 将其恢复到输入框。 */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>
  /** 按需读取会话树（真实 entryId、标签与结构 revision）。 */
  getThreadTree(): Promise<HarnessThreadTree>
  /**
   * 导航会话树；运行中需显式 stopRunning。返回的 recoveredQueue 合并
   * 本地未派发队列，`editorText` 仅供发起窗口恢复草稿。
   */
  navigateThreadTree(input: HarnessTreeNavigateInput): Promise<HarnessTreeNavigateResult>
  /** 设置/清除节点标签；快照到达前不自行猜测标签生效。 */
  setThreadEntryLabel(input: HarnessTreeLabelInput): Promise<HarnessTreeLabelResult>
  /** 取消进行中的分支摘要导航。 */
  cancelThreadTreeNavigation(): Promise<HarnessTreeCancelResult>
  /**
   * fork/clone：创建独立子会话；本 Controller 属于父会话，不应用子快照，
   * 只把失败原因记入本地状态。调用窗口据 `threadId` 自行切换。
   */
  forkThread(input: HarnessThreadForkInput): Promise<HarnessThreadForkResult>
  setModel(input: { provider: string; modelId: string }): Promise<void>
  setThinkingLevel(level: HarnessThinkingLevel): Promise<void>
  /** 直接执行用户 Shell（`!` 纳入上下文，`!!` 排除）；输出经事件同步。 */
  runBash(input: { command: string; excludeFromContext?: boolean }): Promise<HarnessBashStartResult>
  /** 取消当前用户 Shell；不中止模型运行。 */
  abortBash(): Promise<HarnessBashAbortResult>
  /** 手动压缩上下文（可附指令）；失败保留原始消息树。 */
  compact(input?: { customInstructions?: string }): Promise<HarnessCompactionOutcome>
  /** 取消进行中的压缩。 */
  abortCompaction(): Promise<HarnessCompactionAbortResult>
  /** 保存自动压缩开关（用户全局设置）。 */
  setAutoCompaction(enabled: boolean): Promise<HarnessAutoCompactionUpdateResult>
  /** 读取会话模型范围与已保存的用户默认。 */
  getModelScope(): Promise<HarnessModelScope>
  /** 更新会话模型范围；saveAsDefault 才写入用户设置。 */
  setModelScope(input: HarnessModelScopeUpdateInput): Promise<HarnessModelScopeUpdateResult>
  /** 刷新模型目录；空白页需显式传固定起始目录。 */
  refreshModels(input?: { workspacePath?: string }): Promise<HarnessModelRefreshResult>
  /** 仅通过决定来答复指定 id 的请求：`confirm` 会原样接受；拒绝会关闭其他类型的请求；
   * 若接受请求时未提供其选项或文本，则会被拒绝。 */
  respondToToolApproval(approvalId: string, approved: boolean): Promise<void>
  /** 通过 `toolCallId` 答复工具调用期间发起的 host-UI 请求。 */
  resumeToolCall(toolCallId: string, payload: unknown): Promise<void>
  /** 直接答复一个通过 side-channel（独立方式）发起的 host-UI 请求。 */
  respondToHostUiRequest(response: HarnessHostUiResponse): Promise<void>
  /** 消费会话级 Host UI 指令（编辑器文本/命令目标）；成功后从快照移除。 */
  consumeHostUiDirective(directiveId: string): Promise<boolean>
  dispose(): void
}

const defaultScheduleNotify: HarnessNotificationScheduler = (flush) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => flush())
    return
  }
  setTimeout(flush, 16)
}

const notifyListeners = (listeners: Iterable<() => void>) => {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[huan-react] Listener threw an error', error)
    }
  }
}

const updateMessageRepository = (
  previous: ReturnType<typeof ExportedMessageRepository.fromArray>,
  messages: readonly ThreadMessageLike[],
  changedIndex: number,
) => {
  const prefix = previous.messages.slice(0, changedIndex)
  const suffix = ExportedMessageRepository.fromArray(messages.slice(changedIndex)).messages
  const first = suffix[0]
  if (first) {
    first.parentId = prefix.at(-1)?.message.id ?? null
  }
  return { messages: [...prefix, ...suffix] }
}

/** reducer 会处理的事件类型。其他事件都会触发快照刷新
 *（为 Pi 开放且可由模块扩展的事件联合类型保留前向兼容性）。 */
const MESSAGE_DIRTY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'snapshot',
  'agent_start',
  'agent_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_update',
  'tool_execution_end',
  'extension_ui_request',
  'extension_ui_resolved',
])

const MESSAGE_FRAME_COALESCED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message_update',
  'tool_execution_update',
])

// `bash_*` 只改变 extras/线程状态中的 Shell 运行态，不改消息或元数据；
// 归入此集合以通知 allListeners（选择器引用稳定，不会引起多余重渲染）。
const METADATA_DIRTY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'snapshot',
  'agent_start',
  'agent_end',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'bash_start',
  'bash_output',
  'bash_end',
  'host_ui_update',
  'auto_retry_start',
  'auto_retry_end',
  'session_info_changed',
  'thinking_level_changed',
  'context_usage',
  'extension_ui_request',
  'extension_ui_resolved',
  'error',
])

const RUN_STATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'snapshot',
  'agent_start',
  'agent_end',
  'error',
])

const loadImageContent = async (
  image: string,
  signal?: AbortSignal,
): Promise<HarnessImageContent> => {
  const response = await fetch(image, signal ? { signal } : undefined)
  if (!response.ok) {
    throw new Error(`Failed to load Pi image attachment: ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (
    contentType &&
    !contentType.startsWith('image/') &&
    contentType !== 'application/octet-stream' &&
    contentType !== 'binary/octet-stream'
  ) {
    throw new Error(`Pi image attachment returned unsupported content type: ${contentType}`)
  }

  const data = bytesToBase64(new Uint8Array(await response.arrayBuffer()))
  if (
    (!contentType ||
      contentType === 'application/octet-stream' ||
      contentType === 'binary/octet-stream') &&
    !detectImageMediaType(data)
  ) {
    throw new Error('Pi image attachment response does not contain image bytes')
  }
  return {
    type: 'image',
    mimeType: resolveImageMediaType(data, contentType),
    data,
  }
}

const isBase64Payload = (value: string) => {
  const compact = value.replaceAll(/\s/g, '')
  const match = /^([a-z\d+/]*)(={0,2})$/i.exec(compact)
  if (!match) return false

  // 正则的两个捕获组必然存在；默认值只为满足 noUncheckedIndexedAccess
  const [, body = '', padding = ''] = match
  return (
    compact.length > 0 &&
    body.length % 4 !== 1 &&
    (padding.length === 0 || compact.length % 4 === 0)
  )
}

const sendCancelledError = new MessageNotSentError(
  'Pi send was dropped because the run was cancelled.',
)
const sendAbandonedError = new Error('Pi send was dropped because the runtime was disposed.')
const sendQueueClearedError = new Error('Pi send was removed before reaching the queue.')

const isSendInterruption = (error: unknown) =>
  error === sendCancelledError || error === sendAbandonedError || error === sendQueueClearedError

const toImageContent = (
  image: string,
  signal?: AbortSignal,
): HarnessImageContent | Promise<HarnessImageContent> => {
  const parsed = parseDataUrl(image)
  if (parsed) {
    if (!parsed.mimeType.startsWith('image/')) {
      throw new Error(`Pi image attachment returned unsupported content type: ${parsed.mimeType}`)
    }
    if (!isBase64Payload(parsed.data)) {
      throw new Error('Invalid Pi image attachment source')
    }
    return {
      type: 'image',
      mimeType: parsed.mimeType,
      data: parsed.data,
    }
  }

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(image)?.[1]?.toLowerCase()
  if (scheme === 'data' || scheme === 'http' || scheme === 'https' || scheme === 'blob') {
    return loadImageContent(image, signal)
  }

  if (scheme) {
    throw new Error(`Unsupported Pi image attachment URL scheme: ${scheme}`)
  }

  if (!isBase64Payload(image)) {
    throw new Error('Invalid Pi image attachment source')
  }

  return {
    type: 'image',
    mimeType: resolveImageMediaType(image),
    data: image,
  }
}

/** 返回 append message 的所有内容部分，并将附件部分展开合并。 */
export const appendMessageParts = (message: AppendMessage) => [
  ...message.content,
  ...(message.attachments?.flatMap((a) => a.content ?? []) ?? []),
]

const readPiSendParts = (message: AppendMessage) => {
  const textChunks: string[] = []
  const images: string[] = []
  for (const part of appendMessageParts(message)) {
    if (part.type === 'text') textChunks.push(part.text)
    else if (part.type === 'image') images.push(part.image)
  }
  return { content: textChunks.join('\n\n'), images }
}

export const buildHarnessSendInput = (
  message: AppendMessage,
  streamingBehavior: 'followUp' | 'steer' | undefined,
  signal?: AbortSignal,
): HarnessSendMessageInput | Promise<HarnessSendMessageInput> => {
  const { content, images } = readPiSendParts(message)

  const createInput = (resolvedAttachments: HarnessImageContent[]) => ({
    content,
    ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  })

  if (images.length === 0) return createInput([])

  return Promise.all(
    images.map((image) => Promise.resolve().then(() => toImageContent(image, signal))),
  ).then(createInput)
}

const buildOptimisticPiSendInput = (
  message: AppendMessage,
  streamingBehavior: 'followUp' | 'steer' | undefined,
): HarnessSendMessageInput => {
  const { content, images } = readPiSendParts(message)
  return {
    content,
    ...(images.length > 0
      ? {
          attachments: images.map((image) => {
            const parsed = parseDataUrl(image)
            return {
              type: 'image' as const,
              mimeType: resolveImageMediaType(image),
              data: parsed?.data ?? image,
            }
          }),
        }
      : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  }
}

const readSteeringIntent = (message: AppendMessage): 'followUp' | 'steer' | undefined => {
  const intent = message.runConfig?.custom?.streamingBehavior
  return intent === 'followUp' || intent === 'steer' ? intent : undefined
}

const optimisticUserMessageFromInput = (input: HarnessSendMessageInput): HarnessAgentMessage => ({
  role: 'user',
  content:
    input.attachments && input.attachments.length > 0
      ? [{ type: 'text', text: input.content }, ...input.attachments]
      : input.content,
  timestamp: Date.now(),
})

const countQueuedContents = (contents: readonly string[]) => {
  const counts = new Map<string, number>()
  for (const content of contents) counts.set(content, (counts.get(content) ?? 0) + 1)
  return counts
}

/** 仅基于文本的 reconcile key：回显的 transcript message 可能带有额外字段
 *（例如增强后的图片内容），因此结构相等判断过于严格；稳定部分是 prompt 文本。 */
const userContentKey = (message: HarnessAgentMessage): string | null => {
  if (message.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return (content as readonly { type: string; text?: string }[])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

type OptimisticUserMessage = {
  message: HarnessAgentMessage
  baseMessageCount: number
}

type OptimisticSend = {
  message: HarnessAgentMessage
  runStateRevision: number
  previousRunStatus: HarnessThreadState['runStatus']
  previousMetadataStatus: HarnessThreadState['metadata']['status']
  previousLastError: string | undefined
}

type PendingQueueEntry = {
  mode: 'steering' | 'followUp'
  content: string
}

type PendingSend = {
  controller: AbortController
  accepted: boolean
  queueEntry?: PendingQueueEntry
  /** 条目仍由本地乐观队列拥有时，指向当前队列对象；权威更新、提升、取消或
   * 清空后永久解除拥有权。HTTP 是否返回不能判断服务端是否已经消费了条目。 */
  queueMirror?: HarnessThreadState['queue']
}

const markStateRunning = (state: HarnessThreadState): HarnessThreadState => {
  if (state.runStatus === 'running' && state.metadata.status === 'running') {
    return state
  }
  return {
    ...state,
    runStatus: 'running',
    lastError: undefined,
    metadata:
      state.metadata.status === 'running'
        ? state.metadata
        : { ...state.metadata, status: 'running' },
  }
}

export class HarnessThreadController implements HarnessThreadControllerLike {
  private state: HarnessThreadState
  private stateSnapshot: HarnessThreadState
  private projectedMessages: readonly ThreadMessageLike[]
  private readonly messageProjector: HarnessThreadMessageProjector
  private messageRepository = ExportedMessageRepository.fromArray([])
  private version = 0
  private readonly allListeners = new Set<() => void>()
  private readonly metadataListeners = new Set<() => void>()
  private readonly messageListeners = new Set<() => void>()
  private connectionRetainers = 0
  private readonly optimisticUserMessages: OptimisticUserMessage[] = []
  private unsubscribeFromEvents: (() => void) | null = null
  private eventSubscriptionGeneration = 0
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private loadPromise: Promise<void> | null = null
  private sendDispatchTail: Promise<unknown> = Promise.resolve()
  private readonly pendingSends = new Set<PendingSend>()
  private runStateRevision = 0
  private readonly runLeases = new RunLeases()
  private messageFlushScheduled = false
  /** 当快照没有 supervisor 提供的序号时使用的备用序号。 */
  private readonly localSnapshotSeq = 0

  private readonly client: HarnessClient
  private readonly threadId: string
  private readonly options: {
    scheduleNotify?: HarnessNotificationScheduler
  }

  constructor(
    client: HarnessClient,
    threadId: string,
    options: {
      scheduleNotify?: HarnessNotificationScheduler
    } = {},
  ) {
    this.client = client
    this.threadId = threadId
    this.options = options
    this.state = createHarnessThreadState(threadId)
    this.stateSnapshot = this.state
    this.messageProjector = new HarnessThreadMessageProjector()
    this.projectedMessages = this.messageProjector.project({
      messages: this.state.messages,
      toolExecutions: this.state.toolExecutions,
      runStatus: this.state.runStatus,
      hostUiRequests: this.state.hostUiRequests,
    })
  }

  public getState() {
    return this.state
  }

  public getStateSnapshot() {
    return this.stateSnapshot
  }

  public getProjectedMessages() {
    return this.projectedMessages
  }

  public getMessageRepository() {
    return this.messageRepository
  }

  public getVersion() {
    return this.version
  }

  public connect() {
    this.connectionRetainers += 1
    this.ensureEventSubscription()
    return () => {
      this.connectionRetainers = Math.max(0, this.connectionRetainers - 1)
      this.maybeDisconnectFromEvents()
    }
  }

  public subscribe(listener: () => void) {
    this.allListeners.add(listener)
    return () => {
      this.allListeners.delete(listener)
      this.maybeDisconnectFromEvents()
    }
  }

  public subscribeMetadata(listener: () => void) {
    this.metadataListeners.add(listener)
    return () => {
      this.metadataListeners.delete(listener)
      this.maybeDisconnectFromEvents()
    }
  }

  public subscribeMessages(listener: () => void) {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
      this.maybeDisconnectFromEvents()
    }
  }

  public dispose() {
    // React StrictMode 可能先解除订阅，随后再订阅同一个 Controller。
    this.clearDisconnectTimer()
    this.allListeners.clear()
    this.metadataListeners.clear()
    this.messageListeners.clear()
    this.abortPendingSends()
    this.disconnectFromEvents()
  }

  /** 新建订阅的唯一入口。已有订阅直接复用（重复 connect 不重建连接）；新建时
   * 一律请求首帧快照，不按 `loadState` 决定——断开期间的新事件只能靠快照补齐。 */
  private ensureEventSubscription() {
    this.clearDisconnectTimer()
    if (this.unsubscribeFromEvents) return
    const generation = ++this.eventSubscriptionGeneration
    this.unsubscribeFromEvents = this.client.subscribe(
      this.threadId,
      (event: HarnessClientEvent) => {
        if (generation !== this.eventSubscriptionGeneration) return
        if (event.threadId !== this.threadId) return
        if (event.type === 'error' && event.terminal) {
          this.disconnectFromEvents()
        }
        this.dispatch(event)
      },
      { includeSnapshot: true },
    )
  }

  private disconnectFromEvents() {
    const unsubscribe = this.unsubscribeFromEvents
    if (!unsubscribe) return
    this.unsubscribeFromEvents = null
    this.eventSubscriptionGeneration += 1
    unsubscribe()
  }

  private hasConsumers(): boolean {
    return (
      this.connectionRetainers > 0 ||
      this.allListeners.size > 0 ||
      this.metadataListeners.size > 0 ||
      this.messageListeners.size > 0
    )
  }

  private maybeDisconnectFromEvents() {
    if (this.hasConsumers()) return
    if (this.disconnectTimer) return
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null
      if (this.hasConsumers()) return
      this.disconnectFromEvents()
    }, 30_000)
  }

  private clearDisconnectTimer() {
    if (!this.disconnectTimer) return
    clearTimeout(this.disconnectTimer)
    this.disconnectTimer = null
  }

  public async load(force = false) {
    if (this.loadPromise && !force) return this.loadPromise

    this.setState({ ...this.state, loadState: 'loading' })
    const sequenceAtStart = this.state.lastSeq

    const request = this.client
      .getThread(this.threadId)
      .then((snapshot: HarnessThreadSnapshot) => {
        if (this.loadPromise !== request) return
        this.applySnapshot(snapshot, sequenceAtStart)
      })
      .catch((error: unknown) => {
        if (this.loadPromise !== request) throw error
        this.setState({
          ...this.state,
          loadState: 'loaded',
          lastError: errorText(error),
        })
        throw error
      })
      .finally(() => {
        if (this.loadPromise === request) this.loadPromise = null
      })

    this.loadPromise = request
    return request
  }

  public refresh() {
    return this.load(true)
  }

  private refreshInBackground() {
    if (this.loadPromise) return // 已有 load 正在进行；避免请求风暴
    void this.refresh().catch(() => {
      // load() 已经将错误记录到 state。
    })
  }

  public async sendMessage(message: AppendMessage, options?: HarnessSendOptions) {
    if (message.role !== 'user') {
      throw new Error('Pi only supports sending user messages')
    }

    const isQueuedSend = this.state.runStatus === 'running'
    const behavior =
      options?.streamingBehavior ??
      readSteeringIntent(message) ??
      (isQueuedSend ? 'followUp' : undefined)

    return this.sendPreparedMessage(
      message,
      buildOptimisticPiSendInput(message, behavior),
      isQueuedSend,
      behavior,
    )
  }

  private beginOptimisticSend(input: HarnessSendMessageInput): OptimisticSend {
    const send = {
      message: optimisticUserMessageFromInput(input),
      runStateRevision: this.runStateRevision,
      previousRunStatus: this.state.runStatus,
      previousMetadataStatus: this.state.metadata.status,
      previousLastError: this.state.lastError,
    }
    this.optimisticUserMessages.push({
      message: send.message,
      baseMessageCount: this.state.messages.length,
    })
    this.setState(markStateRunning(this.state))
    this.recomputeProjectedMessagesAndNotify()
    return send
  }

  private discardOptimisticSend(send: OptimisticSend) {
    const index = this.optimisticUserMessages.findIndex((entry) => entry.message === send.message)
    if (index !== -1) this.optimisticUserMessages.splice(index, 1)
    this.recomputeProjectedMessagesAndNotify()

    // 期间没有新运行结算时才恢复发送前的运行状态；已开始的运行不能被旧状态覆盖。
    if (this.runStateRevision !== send.runStateRevision) return
    this.setState({
      ...this.state,
      runStatus: send.previousRunStatus,
      metadata: { ...this.state.metadata, status: send.previousMetadataStatus },
    })
  }

  private rollbackOptimisticSend(send: OptimisticSend, error: unknown) {
    const index = this.optimisticUserMessages.findIndex((entry) => entry.message === send.message)
    if (index !== -1) this.optimisticUserMessages.splice(index, 1)
    this.recomputeProjectedMessagesAndNotify()

    const runStateChanged = this.runStateRevision !== send.runStateRevision

    if (isSendInterruption(error)) {
      if (runStateChanged) return
      this.setState({
        ...this.state,
        lastError: send.previousLastError,
        runStatus: send.previousRunStatus,
        metadata: {
          ...this.state.metadata,
          status: send.previousMetadataStatus,
        },
      })
      return
    }

    this.setState({
      ...this.state,
      lastError: errorText(error),
      ...(runStateChanged
        ? {}
        : {
            runStatus: 'failed',
            metadata: { ...this.state.metadata, status: 'failed' },
          }),
    })
  }

  private async sendPreparedMessage(
    message: AppendMessage,
    optimisticInput: HarnessSendMessageInput,
    isQueuedSend: boolean,
    behavior: 'followUp' | 'steer' | undefined,
  ) {
    this.ensureEventSubscription()

    if (isQueuedSend) {
      return this.sendQueued(message, optimisticInput.content, behavior ?? 'followUp')
    }

    const pending = this.registerPendingSend()
    const optimisticSend = this.beginOptimisticSend(optimisticInput)

    try {
      const result = await this.dispatchMessage(message, behavior, pending)
      // handled/cancelled 不会产生对应的真实消息；撤销乐观输入并恢复运行状态，
      // 不等待永远不会到来的 message/agent 事件。
      if (result?.disposition === 'handled' || result?.disposition === 'cancelled') {
        this.discardOptimisticSend(optimisticSend)
      }
    } catch (error) {
      this.rollbackOptimisticSend(optimisticSend, error)
      if (error === sendAbandonedError) return
      throw error
    }
  }

  /** 运行期间发送的内容会进入 Pi 的 queue，而不是 transcript（Pi 仅在 queue 刷新时
   * 才追加 user message），因此乐观镜像写入 `state.queue`：thread 保持干净，queue UI
   * 可立即显示内容。下一次真实的 `queue_update` 会整体替换数组并自动修复状态。 */
  private async sendQueued(
    message: AppendMessage,
    content: string,
    behavior: 'followUp' | 'steer',
  ) {
    const mode = behavior === 'steer' ? 'steering' : 'followUp'
    let promoted: OptimisticSend | undefined
    const optimisticQueue = {
      ...this.state.queue,
      [mode]: [...this.state.queue[mode], content],
    }
    const pending = this.registerPendingSend({ mode, content })
    pending.queueMirror = optimisticQueue
    this.setState({ ...this.state, queue: optimisticQueue })

    try {
      const result = await this.dispatchMessage(message, behavior, pending, {
        onRunStateResolved: (runIsActive) => {
          if (runIsActive) return

          const ownsEntry = pending.queueMirror === this.state.queue
          pending.queueEntry = undefined
          pending.queueMirror = undefined
          const entries = this.state.queue[mode]
          const index = ownsEntry ? entries.lastIndexOf(content) : -1
          if (index !== -1) {
            this.setState({
              ...this.state,
              queue: {
                ...this.state.queue,
                [mode]: entries.filter((_, i) => i !== index),
              },
            })
          }
          promoted = this.beginOptimisticSend(buildOptimisticPiSendInput(message, undefined))
        },
      })
      if (result?.disposition === 'handled' || result?.disposition === 'cancelled') {
        if (promoted) {
          this.discardOptimisticSend(promoted)
        } else {
          const ownsEntry = pending.queueMirror === this.state.queue
          pending.queueEntry = undefined
          pending.queueMirror = undefined
          if (ownsEntry) {
            const entries = this.state.queue[mode]
            const index = entries.lastIndexOf(content)
            if (index !== -1) {
              this.setState({
                ...this.state,
                queue: {
                  ...this.state.queue,
                  [mode]: entries.filter((_, i) => i !== index),
                },
              })
            }
          }
        }
      }
    } catch (error) {
      const promotedSend = promoted
      if (promotedSend) {
        this.rollbackOptimisticSend(promotedSend, error)
        if (error === sendAbandonedError || error === sendQueueClearedError) {
          return
        }
        throw error
      }

      if (error === sendQueueClearedError) return

      // 只删除仍归本地拥有的乐观条目。权威更新可能包含其他窗口发出的同名文本，
      // 一旦服务端接管，就不能再按文本删除；本地队列变更则会转交其余条目的拥有权。
      const entries = this.state.queue[mode]
      const index = pending.queueMirror === this.state.queue ? entries.lastIndexOf(content) : -1
      this.setState({
        ...this.state,
        ...(!isSendInterruption(error) ? { lastError: errorText(error) } : undefined),
        ...(index !== -1
          ? {
              queue: {
                ...this.state.queue,
                [mode]: entries.filter((_, i) => i !== index),
              },
            }
          : {}),
      })
      if (error === sendAbandonedError) return
      throw error
    }
  }

  private registerPendingSend(queueEntry?: PendingQueueEntry): PendingSend {
    const pending: PendingSend = {
      controller: new AbortController(),
      accepted: false,
      ...(queueEntry ? { queueEntry } : {}),
    }
    this.pendingSends.add(pending)
    return pending
  }

  private dispatchMessage(
    message: AppendMessage,
    behavior: 'followUp' | 'steer' | undefined,
    pending: PendingSend,
    options?: {
      onRunStateResolved: (runIsActive: boolean) => void
    },
  ): Promise<HarnessSendMessageResult> {
    const abortController = pending.controller
    const previousRequest = this.sendDispatchTail
    const request = (async () => {
      try {
        await previousRequest.catch(() => {})
        abortController.signal.throwIfAborted()
        const input = await buildHarnessSendInput(message, behavior, abortController.signal)
        abortController.signal.throwIfAborted()
        // pi-coding-agent >=0.80.8 仅在 session 正在 streaming 时读取 streamingBehavior。
        // 保留该选项可覆盖本地镜像已结束、但服务端仍在 streaming 的情况；空闲 session 会忽略它。
        options?.onRunStateResolved(this.state.runStatus === 'running')
        abortController.signal.throwIfAborted()
        pending.accepted = true
        return await this.client.sendMessage(this.threadId, input)
      } catch (error) {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason
        }
        throw error
      } finally {
        this.pendingSends.delete(pending)
      }
    })()
    this.sendDispatchTail = request
    void request.catch(() => {
      if (this.sendDispatchTail === request) {
        this.sendDispatchTail = Promise.resolve()
      }
    })
    return request
  }

  public async clearQueue() {
    const locallyCleared = this.abortPendingQueuedSendsBeforeDispatch()
    // 记录即将清除的 queue 快照。每次 queue 写入都会分配新对象——包括 sendQueued、
    // `queue_update` reducer，以及重新连接/refresh 时的快照（即使内容未变，applySnapshot
    // 也会如此）——因此引用变化表示请求进行期间发生了写入，这可能是 refresh，而非新消息。
    // 引用变化时优先跳过本地清空：残留的过期条目会由下一次 `queue_update` 自动修复，
    // 而清空操作可能会丢弃服务端仍保留的消息。
    const queueBefore = this.state.queue
    let cleared: { steering: string[]; followUp: string[] }
    try {
      cleared = await this.client.clearQueue(this.threadId)
    } catch (error) {
      // 本地未派出发送已取消：即使服务端清空失败，也必须把这部分文本交还窗口。
      throw Object.assign(new Error(errorText(error)), { recoveredQueue: locallyCleared })
    }
    // 乐观地清空本地镜像；Pi 自己发出的 `queue_update`（由 `session.clearQueue` 触发）会确认此操作。
    if (
      this.state.queue === queueBefore &&
      (queueBefore.steering.length > 0 || queueBefore.followUp.length > 0)
    ) {
      this.setState({
        ...this.state,
        queue: { steering: [], followUp: [] },
      })
    }
    return {
      steering: [...cleared.steering, ...locallyCleared.steering],
      followUp: [...cleared.followUp, ...locallyCleared.followUp],
    }
  }

  public async cancel() {
    this.abortPendingSendsBeforeDispatch()
    try {
      await this.client.cancelRun(this.threadId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async getThreadTree() {
    try {
      return await this.client.getThreadTree(this.threadId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async navigateThreadTree(
    input: HarnessTreeNavigateInput,
  ): Promise<HarnessTreeNavigateResult> {
    // 运行中「停止并跳转」与服务端停止语义一致：先取消本地未派发发送，
    // 已进入服务端队列的部分由服务端取回；两者合并返回给发起窗口。
    const locallyCleared = input.stopRunning
      ? this.recoverPendingQueuedSends()
      : { steering: [], followUp: [] }
    if (input.stopRunning) this.abortPendingSendsBeforeDispatch()
    let result: HarnessTreeNavigateResult
    try {
      result = await this.client.navigateThreadTree(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      // 本地发送已取消时，即使 HTTP 失败也必须把文本交还发起窗口。
      return {
        status: 'failed',
        message: errorText(error),
        recoveredQueue: locallyCleared,
      }
    }
    // 发起窗口直接应用权威快照；其他窗口由广播获得同一状态。
    if (result.snapshot) {
      this.dispatch({
        type: 'snapshot',
        snapshot: result.snapshot,
        threadId: this.threadId,
        seq: result.snapshot.seq ?? this.state.lastSeq,
      })
    }
    if (locallyCleared.steering.length > 0 || locallyCleared.followUp.length > 0) {
      result = {
        ...result,
        recoveredQueue: this.mergeRecoveredQueue(result.recoveredQueue, locallyCleared),
      }
    }
    if (result.status === 'failed' || result.status === 'persistence-failed') {
      this.setState({ ...this.state, lastError: result.message ?? '会话树导航失败' })
    }
    return result
  }

  public async setThreadEntryLabel(input: HarnessTreeLabelInput) {
    let result: HarnessTreeLabelResult
    try {
      result = await this.client.setThreadEntryLabel(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
    if (result.snapshot) {
      this.dispatch({
        type: 'snapshot',
        snapshot: result.snapshot,
        threadId: this.threadId,
        seq: result.snapshot.seq ?? this.state.lastSeq,
      })
    }
    if (result.status === 'failed') {
      this.setState({ ...this.state, lastError: result.message ?? '设置标签失败' })
    }
    return result
  }

  public async cancelThreadTreeNavigation() {
    try {
      return await this.client.cancelThreadTreeNavigation(this.threadId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async forkThread(input: HarnessThreadForkInput): Promise<HarnessThreadForkResult> {
    let result: HarnessThreadForkResult
    try {
      result = await this.client.forkThread(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
    // 子会话有自己的快照与订阅；父 Controller 不应用它，只在失败时记录原因。
    if (result.status === 'failed') {
      this.setState({ ...this.state, lastError: result.message ?? '分叉会话失败' })
    }
    return result
  }

  /** @internal */
  public captureCancel(): () => Promise<void> {
    const lease = this.runLeases.current()
    return () => (lease.isCurrent() ? this.cancel() : Promise.resolve())
  }

  private abortPendingSendsBeforeDispatch() {
    for (const pending of this.pendingSends) {
      if (pending.accepted) pending.queueMirror = undefined
      else pending.controller.abort(sendCancelledError)
    }
  }

  private abortPendingQueuedSendsBeforeDispatch() {
    const cleared: { steering: string[]; followUp: string[] } = {
      steering: [],
      followUp: [],
    }
    for (const pending of this.pendingSends) {
      pending.queueMirror = undefined
      if (pending.accepted || !pending.queueEntry) continue
      cleared[pending.queueEntry.mode].push(pending.queueEntry.content)
      pending.controller.abort(sendQueueClearedError)
    }
    return cleared
  }

  /**
   * 运行中「停止并跳转」前回收本地排队的全部文本。
   *
   * 与 clearQueue 不同：这里不能依赖 HTTP 是否已经派出，因为停止会取消
   * 服务端预检；已派出但尚未被服务端入队的条目也没有权威回执。服务端返回
   * 的队列与本地记录按文本多重集去重，避免重复或静默丢失。
   */
  private recoverPendingQueuedSends(): { steering: string[]; followUp: string[] } {
    const recovered: { steering: string[]; followUp: string[] } = {
      steering: [],
      followUp: [],
    }
    for (const pending of this.pendingSends) {
      pending.queueMirror = undefined
      if (!pending.queueEntry) continue
      recovered[pending.queueEntry.mode].push(pending.queueEntry.content)
      pending.controller.abort(sendQueueClearedError)
    }
    return recovered
  }

  /** 合并服务端取回队列与本地未确认队列（按文本多重集去重）。 */
  private mergeRecoveredQueue(
    server: { steering: string[]; followUp: string[] } | undefined,
    local: { steering: string[]; followUp: string[] },
  ): { steering: string[]; followUp: string[] } {
    const result = {
      steering: [...(server?.steering ?? [])],
      followUp: [...(server?.followUp ?? [])],
    }
    for (const mode of ['steering', 'followUp'] as const) {
      const counts = new Map<string, number>()
      for (const content of result[mode]) counts.set(content, (counts.get(content) ?? 0) + 1)
      for (const content of local[mode]) {
        const remaining = counts.get(content) ?? 0
        if (remaining > 0) counts.set(content, remaining - 1)
        else result[mode].push(content)
      }
    }
    return result
  }

  private abortPendingSends() {
    for (const pending of this.pendingSends) {
      if (pending.accepted) pending.queueMirror = undefined
      else pending.controller.abort(sendAbandonedError)
    }
  }

  public async setModel(input: { provider: string; modelId: string }) {
    try {
      await this.client.setModel(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
    await this.refresh()
  }

  public async setThinkingLevel(level: HarnessThinkingLevel) {
    try {
      await this.client.setThinkingLevel(this.threadId, level)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
    await this.refresh()
  }

  public async runBash(input: { command: string; excludeFromContext?: boolean }) {
    try {
      return await this.client.runThreadBash(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async abortBash() {
    try {
      return await this.client.abortThreadBash(this.threadId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async compact(input?: { customInstructions?: string }) {
    let outcome: HarnessCompactionOutcome
    try {
      outcome = await this.client.compactThread(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
    await this.refresh()
    // 失败原因在权威快照之后落地，避免被快照的 lastError 覆盖；不伪造成功状态。
    if (outcome.status === 'failed') {
      this.setState({ ...this.state, lastError: outcome.message })
    }
    return outcome
  }

  public async abortCompaction() {
    try {
      return await this.client.abortThreadCompaction(this.threadId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async setAutoCompaction(enabled: boolean) {
    try {
      const result = await this.client.setAutoCompaction(this.threadId, enabled)
      if (result.status === 'failed') {
        this.setState({ ...this.state, lastError: result.message })
      }
      return result
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async getModelScope() {
    try {
      return await this.client.getThreadModelScope(this.threadId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async setModelScope(input: HarnessModelScopeUpdateInput) {
    try {
      return await this.client.setThreadModelScope(this.threadId, input)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async refreshModels(input?: { workspacePath?: string }) {
    try {
      // 有 live 会话 id 时优先用会话自身的固定 cwd；空白页必须显式给固定目录。
      return await this.client.refreshModels(
        input?.workspacePath ? { workspacePath: input.workspacePath } : { threadId: this.threadId },
      )
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  public async respondToToolApproval(approvalId: string, approved: boolean) {
    const request = this.state.hostUiRequests.find((r) => r.id === approvalId)
    await this.respond(
      request
        ? responseForToolApproval(request, { approvalId, approved })
        : responseForApproval(approvalId, approved),
    )
  }

  public async resumeToolCall(toolCallId: string, payload: unknown) {
    const request = this.state.hostUiRequests.find((r) => r.toolCallId === toolCallId)
    if (!request) {
      throw new Error(`No pending host-UI request for tool call "${toolCallId}"`)
    }
    if (request.kind === 'confirm') {
      await this.respond(responseForApproval(request.id, payload === true))
    } else {
      await this.respond(responseForInterrupt(request.id, payload as HarnessInterruptAnswer))
    }
  }

  public async respondToHostUiRequest(response: HarnessHostUiResponse) {
    await this.respond(response)
  }

  public async consumeHostUiDirective(directiveId: string) {
    try {
      return await this.client.consumeHostUiDirective(this.threadId, directiveId)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
  }

  private async respond(response: HarnessHostUiResponse) {
    try {
      await this.client.respondToHostUiRequest(this.threadId, response)
    } catch (error) {
      this.setState({ ...this.state, lastError: errorText(error) })
      throw error
    }
    // 乐观地清除已处理的请求，使 gate 立即关闭。
    // 直接处理（而非通过 reducer），因为当前 seq 上的合成事件会被去重保护丢弃；
    // supervisor 实际发出的 `extension_ui_resolved` 对此移除操作是幂等的。
    const next = removeHostUiRequest(this.state, response.requestId)
    if (next !== this.state) {
      this.setState(next)
      this.recomputeProjectedMessagesAndNotify()
    }
  }

  private applySnapshot(snapshot: HarnessThreadSnapshot, sequenceAtStart: number) {
    const currentSequence = this.state.lastSeq
    // 实时记录会在处理时为快照标记序号，因此若没有并发更新，落后于请求启动水位的快照
    // 就属于重建后的记录。
    const sequenceResetWhileLoading = currentSequence < sequenceAtStart
    const responseWasOvertaken =
      currentSequence > sequenceAtStart &&
      (snapshot.seq === undefined || snapshot.seq < currentSequence)

    if (sequenceResetWhileLoading || responseWasOvertaken) {
      if (this.state.loadState !== 'loaded') {
        this.setState({ ...this.state, loadState: 'loaded' })
      }
      return
    }

    this.dispatch({
      type: 'snapshot',
      snapshot,
      threadId: this.threadId,
      seq: snapshot.seq ?? this.localSnapshotSeq,
    })
  }

  private dispatch(event: HarnessClientEvent) {
    const reduced = reduceHarnessThreadState(this.state, event)
    // 只有已接受的权威更新才解除本地拥有权；迟到事件不得改变在途条目的状态。
    if (reduced !== this.state && event.type === 'queue_update') {
      for (const pending of this.pendingSends) pending.queueMirror = undefined
    }
    const next =
      reduced !== this.state && event.type === 'snapshot'
        ? this.restorePendingQueueEntries(reduced)
        : reduced
    const changed = next !== this.state
    if (changed) {
      if (this.state.runStatus !== 'running' && next.runStatus === 'running') {
        this.runLeases.begin()
      }
      this.state = next
      if (RUN_STATE_EVENT_TYPES.has(event.type)) {
        this.runStateRevision += 1
      }
    }

    if (event.type === 'agent_end' && event.cancelledBeforeStart === true) {
      this.optimisticUserMessages.length = 0
    }
    this.reconcileOptimisticUserMessages()

    if (changed && METADATA_DIRTY_EVENT_TYPES.has(event.type)) {
      this.notifyMetadataListeners()
    }

    if (changed && MESSAGE_DIRTY_EVENT_TYPES.has(event.type)) {
      if (MESSAGE_FRAME_COALESCED_EVENT_TYPES.has(event.type)) {
        this.scheduleProjectedMessageFlush()
      } else {
        this.recomputeProjectedMessagesAndNotify()
      }
    }

    // Pi 0.80.7 仅会为自定义扩展条目发出 entry_appended。若 Pi 扩展该事件的其他变体，
    // 仍需为这些变体保留快照协调。
    const needsSnapshotRefresh =
      !isKnownHarnessClientEventType(event.type) ||
      (event.type === 'entry_appended' && event.entry?.type !== 'custom')
    if (needsSnapshotRefresh) this.refreshInBackground()
  }

  /** 快照是权威状态，但不包含仍在飞行中、尚未到达 Pi 的排队消息。新订阅、重连或
   * 迟到的 HTTP load 都可能投递这种快照，因此把仍在发送中的乐观条目重新挂回快照
   * 队列，避免撤销用户刚输入的内容；快照已含相同文本时按数量认领，不重复添加。 */
  private restorePendingQueueEntries(state: HarnessThreadState): HarnessThreadState {
    const pending: Array<{ send: PendingSend; entry: PendingQueueEntry }> = []
    for (const send of this.pendingSends) {
      if (send.queueEntry && send.queueMirror && !send.controller.signal.aborted) {
        pending.push({ send, entry: send.queueEntry })
      }
    }
    if (pending.length === 0) return state

    const unclaimed = {
      steering: countQueuedContents(state.queue.steering),
      followUp: countQueuedContents(state.queue.followUp),
    }
    const restored: Array<{ send: PendingSend; entry: PendingQueueEntry }> = []
    for (const item of pending) {
      const counts = unclaimed[item.entry.mode]
      const available = counts.get(item.entry.content) ?? 0
      if (available > 0 && item.send.accepted) {
        // 服务端已排队：永久解除本地拥有权，后续快照为空时也不能复活它。
        counts.set(item.entry.content, available - 1)
        item.send.queueMirror = undefined
        continue
      }
      restored.push(item)
    }
    if (restored.length === 0) return state

    const queue = {
      steering: [...state.queue.steering],
      followUp: [...state.queue.followUp],
    }
    for (const item of restored) queue[item.entry.mode].push(item.entry.content)
    for (const item of restored) item.send.queueMirror = queue
    return { ...state, queue }
  }

  private setState(next: HarnessThreadState) {
    if (next === this.state) return
    // 本地新增、提升和失败回滚都不应让其他乐观条目失去拥有权。
    // 权威更新走 dispatch，拥有权在接管时单独解除，不经过此处转交。
    if (next.queue !== this.state.queue) {
      for (const pending of this.pendingSends) {
        if (pending.queueMirror === this.state.queue) pending.queueMirror = next.queue
      }
    }
    if (this.state.runStatus !== 'running' && next.runStatus === 'running') {
      this.runLeases.begin()
    }
    this.state = next
    this.notifyMetadataListeners()
  }

  private projectedInputMessages() {
    return [...this.state.messages, ...this.optimisticUserMessages.map((entry) => entry.message)]
  }

  private reconcileOptimisticUserMessages() {
    if (this.optimisticUserMessages.length === 0) return

    const remaining: OptimisticUserMessage[] = []
    for (const entry of this.optimisticUserMessages) {
      const key = userContentKey(entry.message)
      const confirmed = this.state.messages
        .slice(entry.baseMessageCount)
        .some((message) => userContentKey(message) === key)
      if (!confirmed) remaining.push(entry)
    }

    if (remaining.length === this.optimisticUserMessages.length) return
    this.optimisticUserMessages.length = 0
    this.optimisticUserMessages.push(...remaining)
  }

  private projectMessages() {
    return this.messageProjector.project({
      messages: this.projectedInputMessages(),
      messageEntryIds: [
        ...this.state.messageEntryIds,
        ...this.optimisticUserMessages.map(() => null),
      ],
      toolExecutions: this.state.toolExecutions,
      runStatus: this.state.runStatus,
      hostUiRequests: this.state.hostUiRequests,
    })
  }

  private recomputeProjectedMessagesAndNotify() {
    const next = this.projectMessages()
    if (next === this.projectedMessages) {
      if (this.state !== this.stateSnapshot) this.publishState()
      return
    }
    this.projectedMessages = next
    this.messageRepository = updateMessageRepository(
      this.messageRepository,
      next,
      this.messageProjector.getChangedProjectedIndex() ?? 0,
    )
    this.notifyMessageListeners()
  }

  private scheduleProjectedMessageFlush() {
    if (this.messageFlushScheduled) return
    this.messageFlushScheduled = true
    const scheduleNotify = this.options.scheduleNotify ?? defaultScheduleNotify
    scheduleNotify(() => {
      this.messageFlushScheduled = false
      this.recomputeProjectedMessagesAndNotify()
    })
  }

  private bumpVersion() {
    this.version += 1
  }

  /** message_end 会推进 state，但不改变 projection，因此 metadata 和 message channel
   * 都无法体现此项变化。仅向 `all` 发布即可通知所有 state 订阅者，且不会改变
   * `subscribeMetadata` 的触发语义。 */
  private publishState() {
    this.stateSnapshot = this.state
    this.bumpVersion()
    notifyListeners(this.allListeners)
  }

  private notifyMetadataListeners() {
    this.stateSnapshot = this.state
    this.bumpVersion()
    notifyListeners(this.metadataListeners)
    notifyListeners(this.allListeners)
  }

  private notifyMessageListeners() {
    this.stateSnapshot = this.state
    this.bumpVersion()
    notifyListeners(this.messageListeners)
    notifyListeners(this.allListeners)
  }
}
