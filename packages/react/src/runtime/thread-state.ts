/**
 * 每线程的纯增量 reducer。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/runtime/threadState.ts`
 * （MIT 许可）。改动：类型改用 `@huan/protocol`，命名 `Pi*` → `Harness*`，
 * 注释译为中文。逻辑与上游保持逐行等价。
 *
 * 设计：
 * - 权威记录是 `HarnessAgentMessage[]`。`snapshot` 事件整体替换它，并且是
 *   **权威的**——因此 reducer 不依赖脆弱的事件顺序，任何分歧都会在下次快照
 *   处自愈。
 * - 快照之间，流式事件只补丁变更的尾部：`message_start` 追加，
 *   `message_update` 原地替换流式助手消息（Pi 保证 partial 更新之前先发
 *   start），`tool_execution_update` 按 `toolCallId` 缓冲实时部分输出。
 * - 未知事件类型被容忍：只推进 `lastSeq`，其余忽略（controller 在其上叠加
 *   整刷兜底）。
 *
 * 本模块浏览器安全，不导入任何 Pi SDK 包。
 */

import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessBashRun,
  HarnessClientEvent,
  HarnessCompactionReason,
  HarnessContextUsage,
  HarnessHostUiRequest,
  HarnessRuntimeReadiness,
  HarnessThreadHostUi,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from '@huan/protocol'

/** 运行状态。 */
export type HarnessRunStatus = 'idle' | 'running' | 'failed'

/** 加载状态。 */
export type HarnessLoadState = 'pending' | 'loading' | 'loaded'

/** 单次工具执行的活动状态。 */
export interface HarnessToolExecutionState {
  toolCallId: string
  toolName?: string
  args?: unknown
  /**
   * 最新的流式部分结果（与最终工具结果同形：
   * `{ content: [{ type: "text", text }], details? }`）。
   * 一旦 `toolResult` 消息落入记录即被取代。
   */
  partialResult?: unknown
  status: 'running' | 'complete' | 'error'
  /** 由另一个工具（如 codemode 脚本）发起时，指向父工具调用。 */
  parentToolCallId?: string
}

/** 单线程的完整 UI 状态。 */
export interface HarnessThreadState {
  threadId: string
  metadata: HarnessThreadMetadata
  /** 权威记录——投影的真相来源。 */
  messages: readonly HarnessAgentMessage[]
  /** 与 `messages` 等长的来源 entryId；未落盘/未知为 null。 */
  messageEntryIds: readonly (string | null)[]
  /** 当前流式的助手消息在 `messages` 中的下标；未流式时为 undefined。 */
  streamingMessageIndex: number | undefined
  /** 实时流式工具输出，按 `toolCallId` 索引。 */
  toolExecutions: Readonly<Record<string, HarnessToolExecutionState>>
  runStatus: HarnessRunStatus
  queue: { steering: readonly string[]; followUp: readonly string[] }
  contextUsage: HarnessContextUsage | undefined
  compaction: { active: boolean; reason?: HarnessCompactionReason; error?: string }
  /** 用户 Shell 的实时/刚完成状态；持久化为历史消息后由快照清除。 */
  bash: HarnessBashRun | undefined
  retry: { active: boolean; attempt: number }
  /** 待处理的阻断式 Host UI 请求（Pi 的审批界面）。 */
  hostUiRequests: readonly HarnessHostUiRequest[]
  /** 扩展报告的状态/通知/widget/标题/编辑器指令（快照权威）。 */
  hostUi: HarnessThreadHostUi | undefined
  readiness: HarnessRuntimeReadiness | undefined
  lastError: string | undefined
  loadState: HarnessLoadState
  /**
   * 排序/去重的水位号。权威快照可以将其下调（supervisor 开启新序列时）。
   */
  lastSeq: number
}

const EMPTY_METADATA = (threadId: string): HarnessThreadMetadata => ({
  id: threadId,
  status: 'idle',
})

/** 创建一个空线程状态。 */
export const createHarnessThreadState = (threadId: string): HarnessThreadState => ({
  threadId,
  metadata: EMPTY_METADATA(threadId),
  messages: [],
  messageEntryIds: [],
  streamingMessageIndex: undefined,
  toolExecutions: {},
  runStatus: 'idle',
  queue: { steering: [], followUp: [] },
  contextUsage: undefined,
  compaction: { active: false },
  bash: undefined,
  retry: { active: false, attempt: 0 },
  hostUiRequests: [],
  hostUi: undefined,
  readiness: undefined,
  lastError: undefined,
  loadState: 'pending',
  lastSeq: 0,
})

const isAssistantMessage = (
  message: HarnessAgentMessage | undefined,
): message is HarnessAssistantMessage => message?.role === 'assistant'

const withMetadataStatus = (
  metadata: HarnessThreadMetadata,
  status: HarnessThreadState['metadata']['status'],
): HarnessThreadMetadata => (metadata.status === status ? metadata : { ...metadata, status })

const withMetadataActivity = (
  metadata: HarnessThreadMetadata,
  compaction: HarnessThreadState['compaction'],
  retry: HarnessThreadState['retry'],
): HarnessThreadMetadata =>
  metadata.compactionActive === compaction.active &&
  metadata.retryActive === retry.active &&
  metadata.retryAttempt === retry.attempt
    ? metadata
    : {
        ...metadata,
        compactionActive: compaction.active,
        retryActive: retry.active,
        retryAttempt: retry.attempt,
      }

const applySnapshot = (
  state: HarnessThreadState,
  snapshot: HarnessThreadSnapshot,
): HarnessThreadState => {
  const runStatus: HarnessRunStatus =
    snapshot.metadata.status === 'running'
      ? 'running'
      : snapshot.metadata.status === 'failed'
        ? 'failed'
        : 'idle'
  // 旧版宿主省略活动标志，因此已结束状态是「两项操作都不在飞行中」的唯一信号。
  const settled = runStatus !== 'running'
  const compactionActive =
    snapshot.compaction?.active ??
    snapshot.metadata.compactionActive ??
    (settled ? false : state.compaction.active)
  const retryActive = snapshot.metadata.retryActive ?? (settled ? false : state.retry.active)

  // 快照携带压缩运行态（含最近失败原因）时以其为权威；否则按活动标志兼容投影。
  const compaction =
    snapshot.compaction !== undefined
      ? { ...snapshot.compaction }
      : compactionActive
        ? { ...state.compaction, active: true }
        : { active: false }
  const retry = retryActive
    ? { active: true, attempt: snapshot.metadata.retryAttempt ?? state.retry.attempt }
    : { active: false, attempt: 0 }

  return {
    ...state,
    metadata: withMetadataActivity(snapshot.metadata, compaction, retry),
    messages: snapshot.messages,
    // 来源 entryId 随权威快照整体替换，不从下标/时间戳推导。
    messageEntryIds: snapshot.messageEntryIds ?? snapshot.messages.map(() => null),
    // 快照权威：丢弃瞬态流式指针/缓冲，使任何分歧自愈。
    streamingMessageIndex: undefined,
    toolExecutions: {},
    runStatus,
    compaction,
    bash: snapshot.bash,
    retry,
    // 缺失 `queuedMessages` 表示空队列（无排队内容时快照省略该字段，冷线程
    // 更是完全没有队列）——此处保留旧队列会让「事件流断开期间被清空的条目」
    // 在重连快照后永久存活。
    queue: {
      steering: (snapshot.metadata.queuedMessages ?? [])
        .filter((m) => m.mode === 'steer')
        .map((m) => m.content),
      followUp: (snapshot.metadata.queuedMessages ?? [])
        .filter((m) => m.mode === 'followUp')
        .map((m) => m.content),
    },
    contextUsage: snapshot.metadata.contextUsage ?? state.contextUsage,
    hostUiRequests: snapshot.hostUiRequests ?? [],
    hostUi: snapshot.hostUi,
    readiness: snapshot.readiness ?? state.readiness,
    lastError: snapshot.lastError,
    loadState: 'loaded',
  }
}

const replaceAt = <T>(arr: readonly T[], index: number, value: T): T[] => {
  const next = arr.slice()
  next[index] = value
  return next
}

const upsertToolExecution = (
  state: HarnessThreadState,
  toolCallId: string,
  patch: Partial<HarnessToolExecutionState>,
): HarnessThreadState => ({
  ...state,
  toolExecutions: {
    ...state.toolExecutions,
    [toolCallId]: {
      toolCallId,
      status: 'running',
      ...state.toolExecutions[toolCallId],
      ...patch,
    },
  },
})

/** 从状态中移除一条 Host UI 请求（已有应答时使用）。 */
export const removeHostUiRequest = (
  state: HarnessThreadState,
  requestId: string,
): HarnessThreadState => {
  if (!state.hostUiRequests.some((r) => r.id === requestId)) return state
  return {
    ...state,
    hostUiRequests: state.hostUiRequests.filter((r) => r.id !== requestId),
  }
}

/**
 * 应用单个客户端事件。纯函数：返回新状态（无变化时返回原引用）。
 * 早于 `lastSeq` 的非快照事件被忽略；当前快照按权威状态应用。
 */
export const reduceHarnessThreadState = (
  state: HarnessThreadState,
  event: HarnessClientEvent,
): HarnessThreadState => {
  // 错误与快照一起绕过去重守卫：错误可能带外发出（例如失败的 subscribe
  // 在 seq 0 上报，低于任何实时序号），重复应用无副作用。
  if (event.type !== 'snapshot' && event.type !== 'error' && event.seq <= state.lastSeq) {
    return state
  }

  const stamped = (next: HarnessThreadState): HarnessThreadState =>
    next === state && event.seq <= state.lastSeq
      ? next
      : { ...next, lastSeq: Math.max(state.lastSeq, event.seq) }

  switch (event.type) {
    case 'snapshot': {
      const next = applySnapshot(state, event.snapshot)
      const sequenceReset = event.seq < state.lastSeq
      return {
        ...next,
        lastSeq: sequenceReset
          ? Math.max(event.seq, event.snapshot.seq ?? 0)
          : Math.max(state.lastSeq, event.seq, event.snapshot.seq ?? 0),
      }
    }

    case 'agent_start':
      return stamped({
        ...state,
        runStatus: 'running',
        lastError: undefined,
        metadata: withMetadataStatus(state.metadata, 'running'),
      })

    case 'agent_end': {
      const running = event.willRetry === true
      return stamped({
        ...state,
        runStatus: running ? 'running' : 'idle',
        streamingMessageIndex: undefined,
        metadata: withMetadataStatus(state.metadata, running ? 'running' : 'idle'),
      })
    }

    case 'message_start': {
      const messages = [...state.messages, event.message]
      const messageEntryIds = [...state.messageEntryIds, null]
      return stamped({
        ...state,
        messages,
        messageEntryIds,
        streamingMessageIndex: isAssistantMessage(event.message)
          ? messages.length - 1
          : state.streamingMessageIndex,
      })
    }

    case 'message_update': {
      // 事件携带完整的当前助手消息；原地替换流式尾部。若尚无流式指针
      //（例如 start 之前就来了 update），则追加。
      if (
        state.streamingMessageIndex !== undefined &&
        state.streamingMessageIndex < state.messages.length
      ) {
        return stamped({
          ...state,
          messages: replaceAt(state.messages, state.streamingMessageIndex, event.message),
        })
      }
      const messages = [...state.messages, event.message]
      return stamped({
        ...state,
        messages,
        messageEntryIds: [...state.messageEntryIds, null],
        streamingMessageIndex: messages.length - 1,
      })
    }

    case 'message_end': {
      if (!isAssistantMessage(event.message)) return stamped(state)
      let index = state.streamingMessageIndex
      // 重连快照只包含已提交消息，可能错过 start 和全部 update，下一条就是 end。
      // 同一终态若已随快照到达则替换尾部，否则追加；不能猜测 stopReason 是流式标记。
      if (index === undefined) {
        const last = state.messages.at(-1)
        if (
          isAssistantMessage(last) &&
          last.timestamp === event.message.timestamp &&
          last.provider === event.message.provider &&
          last.model === event.message.model
        )
          index = state.messages.length - 1
      }
      return stamped({
        ...state,
        messages:
          index !== undefined && index < state.messages.length
            ? replaceAt(state.messages, index, event.message)
            : [...state.messages, event.message],
        messageEntryIds:
          index !== undefined && index < state.messages.length
            ? state.messageEntryIds
            : [...state.messageEntryIds, null],
        streamingMessageIndex: undefined,
      })
    }

    case 'tool_execution_start':
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          status: 'running',
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        }),
      )

    case 'tool_execution_update':
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          partialResult: event.partialResult,
          status: 'running',
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        }),
      )

    case 'tool_execution_end':
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          partialResult: event.result,
          status: event.isError ? 'error' : 'complete',
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        }),
      )

    case 'queue_update':
      return stamped({
        ...state,
        queue: { steering: event.steering, followUp: event.followUp },
      })

    case 'compaction_start': {
      const compaction = { active: true, reason: event.reason }
      return stamped({
        ...state,
        compaction,
        metadata: withMetadataActivity(state.metadata, compaction, state.retry),
      })
    }

    case 'compaction_end': {
      // 失败保留 errorMessage；取消不算失败（不保留错误）。
      const compaction = event.aborted
        ? { active: false }
        : {
            active: false,
            ...(event.errorMessage ? { error: event.errorMessage } : {}),
          }
      return stamped({
        ...state,
        compaction,
        metadata: withMetadataActivity(state.metadata, compaction, state.retry),
      })
    }

    case 'bash_start':
    case 'bash_end':
      return stamped({ ...state, bash: event.run })

    case 'bash_output': {
      const current = state.bash
      if (!current || current.id !== event.id) return stamped(state)
      let output = current.output + event.delta
      if (event.dropped > 0) output = output.slice(event.dropped)
      return stamped({
        ...state,
        bash: {
          ...current,
          output,
          outputTruncated: current.outputTruncated || event.dropped > 0,
        },
      })
    }

    case 'auto_retry_start': {
      const retry = { active: true, attempt: event.attempt }
      return stamped({
        ...state,
        retry,
        metadata: withMetadataActivity(state.metadata, state.compaction, retry),
      })
    }

    case 'auto_retry_end': {
      const retry = { active: false, attempt: 0 }
      return stamped({
        ...state,
        retry,
        metadata: withMetadataActivity(state.metadata, state.compaction, retry),
      })
    }

    case 'context_usage':
      return stamped({ ...state, contextUsage: event.contextUsage })

    case 'reload_start':
      // 资源重载由宿主广播；快照是权威，这里先让元数据反映“重载中”。
      return stamped({
        ...state,
        metadata: { ...state.metadata, reload: event.operation },
      })

    case 'reload_end':
      return stamped({
        ...state,
        metadata: {
          ...state.metadata,
          reload: event.operation,
          resourceRevision: event.resourceRevision,
        },
      })

    case 'session_info_changed': {
      const metadata = { ...state.metadata }
      if (event.name?.trim()) {
        metadata.name = event.name.trim()
        metadata.title = metadata.name
      } else {
        delete metadata.name
        if (metadata.firstMessageText) {
          metadata.title = metadata.firstMessageText.slice(0, 60).trim()
        } else delete metadata.title
      }
      return stamped({ ...state, metadata })
    }

    case 'thinking_level_changed':
      return stamped({
        ...state,
        metadata: {
          ...state.metadata,
          config: { ...state.metadata.config, thinkingLevel: event.level },
        },
      })

    case 'extension_ui_request': {
      const exists = state.hostUiRequests.some((r) => r.id === event.request.id)
      if (exists) return stamped(state)
      return stamped({
        ...state,
        hostUiRequests: [...state.hostUiRequests, event.request],
      })
    }

    case 'host_ui_update':
      return stamped({ ...state, hostUi: event.hostUi })

    case 'extension_ui_resolved':
      return stamped(removeHostUiRequest(state, event.requestId))

    case 'error':
      return stamped({
        ...state,
        lastError: event.error,
        runStatus: 'failed',
        metadata: withMetadataStatus(state.metadata, 'failed'),
      })

    case 'agent_settled':
    case 'entry_appended':
    case 'turn_start':
    case 'turn_end':
      return stamped(state)

    default:
      // 前向兼容：未知事件类型被容忍（经 `stamped` 推进 seq），
      // 是否整刷由 controller 决定。
      return stamped(state)
  }
}
