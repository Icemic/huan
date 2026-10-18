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
  HarnessClientEvent,
  HarnessContextUsage,
  HarnessHostUiRequest,
  HarnessRuntimeReadiness,
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
}

/** 单线程的完整 UI 状态。 */
export interface HarnessThreadState {
  threadId: string
  metadata: HarnessThreadMetadata
  /** 权威记录——投影的真相来源。 */
  messages: readonly HarnessAgentMessage[]
  /** 当前流式的助手消息在 `messages` 中的下标；未流式时为 undefined。 */
  streamingMessageIndex: number | undefined
  /** 实时流式工具输出，按 `toolCallId` 索引。 */
  toolExecutions: Readonly<Record<string, HarnessToolExecutionState>>
  runStatus: HarnessRunStatus
  queue: { steering: readonly string[]; followUp: readonly string[] }
  contextUsage: HarnessContextUsage | undefined
  compaction: { active: boolean; reason?: 'manual' | 'threshold' | 'overflow' }
  retry: { active: boolean; attempt: number }
  /** 待处理的阻断式 Host UI 请求（Pi 的审批界面）。 */
  hostUiRequests: readonly HarnessHostUiRequest[]
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
  streamingMessageIndex: undefined,
  toolExecutions: {},
  runStatus: 'idle',
  queue: { steering: [], followUp: [] },
  contextUsage: undefined,
  compaction: { active: false },
  retry: { active: false, attempt: 0 },
  hostUiRequests: [],
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
    snapshot.metadata.compactionActive ?? (settled ? false : state.compaction.active)
  const retryActive = snapshot.metadata.retryActive ?? (settled ? false : state.retry.active)

  const compaction = compactionActive ? { ...state.compaction, active: true } : { active: false }
  const retry = retryActive
    ? { active: true, attempt: snapshot.metadata.retryAttempt ?? state.retry.attempt }
    : { active: false, attempt: 0 }

  return {
    ...state,
    metadata: withMetadataActivity(snapshot.metadata, compaction, retry),
    messages: snapshot.messages,
    // 快照权威：丢弃瞬态流式指针/缓冲，使任何分歧自愈。
    streamingMessageIndex: undefined,
    toolExecutions: {},
    runStatus,
    compaction,
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
      return stamped({
        ...state,
        messages,
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
        streamingMessageIndex: messages.length - 1,
      })
    }

    case 'message_end': {
      if (
        state.streamingMessageIndex !== undefined &&
        state.streamingMessageIndex < state.messages.length
      ) {
        return stamped({
          ...state,
          messages: replaceAt(state.messages, state.streamingMessageIndex, event.message),
          streamingMessageIndex: undefined,
        })
      }
      return stamped({ ...state, streamingMessageIndex: undefined })
    }

    case 'tool_execution_start':
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          status: 'running',
        }),
      )

    case 'tool_execution_update':
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          partialResult: event.partialResult,
          status: 'running',
        }),
      )

    case 'tool_execution_end':
      return stamped(
        upsertToolExecution(state, event.toolCallId, {
          partialResult: event.result,
          status: event.isError ? 'error' : 'complete',
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
      const compaction = { active: false }
      return stamped({
        ...state,
        compaction,
        metadata: withMetadataActivity(state.metadata, compaction, state.retry),
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

    case 'session_info_changed': {
      const metadata = { ...state.metadata }
      if (event.name !== undefined) metadata.title = event.name
      else delete metadata.title
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
