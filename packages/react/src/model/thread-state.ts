/**
 * 每线程的纯增量归约。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/runtime/threadState.ts`
 * （MIT 许可，见包内 THIRD-PARTY-NOTICES.md）。类型改用 `@huan/protocol`，
 * 命名 `Pi*` → `Harness*`，并按整体整改规范拆分元数据与运行数据。
 *
 * 设计：
 * - 元数据（`threadsById`）与运行数据（`sessionDataById`）各保存一份：
 *   status、队列、contextUsage、压缩/重试活动标志、模型配置等只在元数据；
 *   消息、工具执行、Host UI 请求、Shell、readiness、加载状态只在运行数据。
 * - 权威记录是 `HarnessAgentMessage[]`。`snapshot` 事件整体替换它，并且是
 *   **权威的**——因此 reducer 不依赖脆弱的事件顺序，任何分歧都会在下次快照
 *   处自愈。
 * - 完整快照覆盖所属字段：缺省数组为空，缺省可选值为未知/不存在，不用旧值
 *   填补；这与 R2 的完整快照语义一致。
 * - `agent_end` 只表示一段执行结束，后续仍可能重试、压缩或继续；界面保持
 *   运行到 `agent_settled`（或权威快照）才结算。未启动取消只结束对应提交，
 *   不改变共享运行状态。
 *
 * 浏览器安全，不导入任何 Pi SDK 包。
 */

import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessBashRun,
  HarnessClientEvent,
  HarnessContextUsage,
  HarnessHostUiRequest,
  HarnessQueuedMessage,
  HarnessRuntimeReadiness,
  HarnessThreadHostUi,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { harnessQueueItemId } from '@huan/protocol'

/** 运行状态（由元数据 status 派生，不单独存储）。 */
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

/** 单线程的运行数据（不含元数据字段）。 */
export interface HarnessThreadSession {
  /** 权威记录——投影的真相来源。 */
  messages: readonly HarnessAgentMessage[]
  /** 与 `messages` 等长的来源 entryId；未落盘/未知为 null。 */
  messageEntryIds: readonly (string | null)[]
  /** 当前流式的助手消息在 `messages` 中的下标；未流式时为 undefined。 */
  streamingMessageIndex: number | undefined
  /** 实时流式工具输出，按 `toolCallId` 索引。 */
  toolExecutions: Readonly<Record<string, HarnessToolExecutionState>>
  /** 最近一次压缩失败原因；成功/取消后清除。活动标志在元数据。 */
  compactionError: string | undefined
  /** 用户 Shell 的实时/刚完成状态；持久化为历史消息后由快照清除。 */
  bash: HarnessBashRun | undefined
  /** 待处理的阻断式 Host UI 请求。 */
  hostUiRequests: readonly HarnessHostUiRequest[]
  /** 扩展报告的状态/通知/widget/标题/编辑器指令（快照权威）。 */
  hostUi: HarnessThreadHostUi | undefined
  readiness: HarnessRuntimeReadiness | undefined
  lastError: string | undefined
  loadState: HarnessLoadState
  /** 排序/去重的水位号。权威快照可以将其下调（宿主开启新序列时）。 */
  lastSeq: number
}

/** 一次归约的完整结果：元数据实体 + 运行数据实体。 */
export interface HarnessThreadReduction {
  metadata: HarnessThreadMetadata
  session: HarnessThreadSession
}

/** 创建空运行数据。 */
export const createHarnessThreadSession = (): HarnessThreadSession => ({
  messages: [],
  messageEntryIds: [],
  streamingMessageIndex: undefined,
  toolExecutions: {},
  compactionError: undefined,
  bash: undefined,
  hostUiRequests: [],
  hostUi: undefined,
  readiness: undefined,
  lastError: undefined,
  loadState: 'pending',
  lastSeq: 0,
})

/** 创建目录条目缺失时的最小元数据。 */
export const createHarnessThreadMetadata = (threadId: string): HarnessThreadMetadata => ({
  id: threadId,
  status: 'idle',
})

/** 创建空线程归约结果。 */
export const createHarnessThreadReduction = (threadId: string): HarnessThreadReduction => ({
  metadata: createHarnessThreadMetadata(threadId),
  session: createHarnessThreadSession(),
})

const isAssistantMessage = (
  message: HarnessAgentMessage | undefined,
): message is HarnessAssistantMessage => message?.role === 'assistant'

/** 由元数据 status 派生运行状态；不读取第二份状态。 */
export const selectThreadRunStatus = (metadata: HarnessThreadMetadata): HarnessRunStatus =>
  metadata.status === 'running' ? 'running' : metadata.status === 'failed' ? 'failed' : 'idle'

/** 复合运行展示：运行中、压缩中或自动重试中都视为忙。 */
export const selectThreadIsRunning = (metadata: HarnessThreadMetadata): boolean =>
  metadata.status === 'running' ||
  metadata.compactionActive === true ||
  metadata.retryActive === true

/** 从元数据派生队列视图；队列只在元数据保存一份。 */
export const selectThreadQueue = (
  metadata: HarnessThreadMetadata,
): { steering: readonly string[]; followUp: readonly string[] } => {
  const queued = metadata.queuedMessages ?? []
  return {
    steering: queued
      .filter((message) => message.mode === 'steer')
      .map((message) => message.content),
    followUp: queued
      .filter((message) => message.mode === 'followUp')
      .map((message) => message.content),
  }
}

/** 由 queue_update 事件生成元数据队列镜像（与协议事件同序）。 */
const queueMessagesOf = (
  steering: readonly string[],
  followUp: readonly string[],
): HarnessQueuedMessage[] => [
  ...steering.map((content, index) => ({
    id: harnessQueueItemId('steer', index),
    mode: 'steer' as const,
    content,
  })),
  ...followUp.map((content, index) => ({
    id: harnessQueueItemId('followUp', index),
    mode: 'followUp' as const,
    content,
  })),
]

const applySnapshot = (
  state: HarnessThreadReduction,
  snapshot: HarnessThreadSnapshot,
): HarnessThreadReduction => ({
  // 快照元数据整体替换：目录/运行字段都以其为权威，缺省可选值即不存在。
  metadata: snapshot.metadata,
  session: {
    ...state.session,
    messages: snapshot.messages,
    // 来源 entryId 随权威快照整体替换，不从下标/时间戳推导。
    messageEntryIds: snapshot.messageEntryIds ?? snapshot.messages.map(() => null),
    // 快照权威：丢弃瞬态流式指针/缓冲，使任何分歧自愈。
    streamingMessageIndex: undefined,
    // 完整快照携带当前活动工具；缺省表示没有活动工具，不用旧值填充。
    toolExecutions: Object.fromEntries(
      (snapshot.toolExecutions ?? []).map((execution) => [execution.toolCallId, execution]),
    ),
    compactionError: snapshot.compaction?.error,
    bash: snapshot.bash,
    hostUiRequests: snapshot.hostUiRequests ?? [],
    hostUi: snapshot.hostUi,
    readiness: snapshot.readiness,
    lastError: snapshot.lastError,
    loadState: 'loaded',
  },
})

const replaceAt = <T>(arr: readonly T[], index: number, value: T): T[] => {
  const next = arr.slice()
  next[index] = value
  return next
}

const upsertToolExecution = (
  session: HarnessThreadSession,
  toolCallId: string,
  patch: Partial<HarnessToolExecutionState>,
): HarnessThreadSession => ({
  ...session,
  toolExecutions: {
    ...session.toolExecutions,
    [toolCallId]: {
      toolCallId,
      status: 'running',
      ...session.toolExecutions[toolCallId],
      ...patch,
    },
  },
})

/** 从运行数据中移除一条 Host UI 请求（已有应答时使用）。 */
export const removeHostUiRequest = (
  session: HarnessThreadSession,
  requestId: string,
): HarnessThreadSession => {
  if (!session.hostUiRequests.some((request) => request.id === requestId)) return session
  return {
    ...session,
    hostUiRequests: session.hostUiRequests.filter((request) => request.id !== requestId),
  }
}

const withMetadata = (
  state: HarnessThreadReduction,
  metadata: HarnessThreadMetadata,
): HarnessThreadReduction => (metadata === state.metadata ? state : { ...state, metadata })

const withSession = (
  state: HarnessThreadReduction,
  session: HarnessThreadSession,
): HarnessThreadReduction => (session === state.session ? state : { ...state, session })

const stampSession = (session: HarnessThreadSession, seq: number): HarnessThreadSession =>
  seq <= session.lastSeq ? session : { ...session, lastSeq: seq }

const setMetadataStatus = (
  metadata: HarnessThreadMetadata,
  status: HarnessThreadMetadata['status'],
): HarnessThreadMetadata => (metadata.status === status ? metadata : { ...metadata, status })

/**
 * 应用单个客户端事件。纯函数：无变化时返回原引用。
 * 早于 `lastSeq` 的非快照事件被忽略；当前快照按权威状态应用。
 */
export const reduceHarnessThreadState = (
  state: HarnessThreadReduction,
  event: HarnessClientEvent,
): HarnessThreadReduction => {
  // 错误与快照一起绕过去重守卫：错误可能带外发出（例如失败的 subscribe
  // 在 seq 0 上报，低于任何实时序号），重复应用无副作用。
  if (event.type !== 'snapshot' && event.type !== 'error' && event.seq <= state.session.lastSeq) {
    return state
  }

  switch (event.type) {
    case 'snapshot': {
      const next = applySnapshot(state, event.snapshot)
      const sequenceReset = event.seq < state.session.lastSeq
      return {
        ...next,
        session: {
          ...next.session,
          lastSeq: sequenceReset
            ? Math.max(event.seq, event.snapshot.seq ?? 0)
            : Math.max(state.session.lastSeq, event.seq, event.snapshot.seq ?? 0),
        },
      }
    }

    case 'agent_start':
      return withSession(
        withMetadata(state, {
          ...setMetadataStatus(state.metadata, 'running'),
        }),
        stampSession({ ...state.session, lastError: undefined }, event.seq),
      )

    case 'agent_end': {
      // 等待准入的另一提交也会收到未启动取消，不能改动当前运行或流式指针。
      if (event.cancelledBeforeStart) {
        return withSession(state, stampSession(state.session, event.seq))
      }
      return withSession(
        state,
        stampSession({ ...state.session, streamingMessageIndex: undefined }, event.seq),
      )
    }

    case 'agent_settled': {
      const metadata = setMetadataStatus(
        state.metadata,
        state.metadata.status === 'failed' ? 'failed' : 'idle',
      )
      return withMetadata(
        withSession(
          state,
          stampSession({ ...state.session, streamingMessageIndex: undefined }, event.seq),
        ),
        metadata,
      )
    }

    case 'message_start': {
      const messages = [...state.session.messages, event.message]
      const messageEntryIds = [...state.session.messageEntryIds, null]
      return withSession(
        state,
        stampSession(
          {
            ...state.session,
            messages,
            messageEntryIds,
            streamingMessageIndex: isAssistantMessage(event.message)
              ? messages.length - 1
              : state.session.streamingMessageIndex,
          },
          event.seq,
        ),
      )
    }

    case 'message_update': {
      // 事件携带完整的当前助手消息；原地替换流式尾部。若尚无流式指针
      //（例如 start 之前就来了 update），则追加。
      if (
        state.session.streamingMessageIndex !== undefined &&
        state.session.streamingMessageIndex < state.session.messages.length
      ) {
        return withSession(
          state,
          stampSession(
            {
              ...state.session,
              messages: replaceAt(
                state.session.messages,
                state.session.streamingMessageIndex,
                event.message,
              ),
            },
            event.seq,
          ),
        )
      }
      const messages = [...state.session.messages, event.message]
      return withSession(
        state,
        stampSession(
          {
            ...state.session,
            messages,
            messageEntryIds: [...state.session.messageEntryIds, null],
            streamingMessageIndex: messages.length - 1,
          },
          event.seq,
        ),
      )
    }

    case 'message_end': {
      if (!isAssistantMessage(event.message)) {
        return withSession(state, stampSession(state.session, event.seq))
      }
      let index = state.session.streamingMessageIndex
      // 重连快照只包含已提交消息，可能错过 start 和全部 update，下一条就是 end。
      // 同一终态若已随快照到达则替换尾部，否则追加；不能猜测 stopReason 是流式标记。
      if (index === undefined) {
        const last = state.session.messages.at(-1)
        if (
          isAssistantMessage(last) &&
          last.timestamp === event.message.timestamp &&
          last.provider === event.message.provider &&
          last.model === event.message.model
        ) {
          index = state.session.messages.length - 1
        }
      }
      const replaceIndex =
        index !== undefined && index < state.session.messages.length ? index : undefined
      return withSession(
        state,
        stampSession(
          {
            ...state.session,
            messages:
              replaceIndex !== undefined
                ? replaceAt(state.session.messages, replaceIndex, event.message)
                : [...state.session.messages, event.message],
            messageEntryIds:
              replaceIndex !== undefined
                ? state.session.messageEntryIds
                : [...state.session.messageEntryIds, null],
            streamingMessageIndex: undefined,
          },
          event.seq,
        ),
      )
    }

    case 'tool_execution_start':
      return withSession(
        state,
        stampSession(
          upsertToolExecution(state.session, event.toolCallId, {
            toolName: event.toolName,
            args: event.args,
            status: 'running',
            ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          }),
          event.seq,
        ),
      )

    case 'tool_execution_update':
      return withSession(
        state,
        stampSession(
          upsertToolExecution(state.session, event.toolCallId, {
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            partialResult: event.partialResult,
            status: 'running',
            ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          }),
          event.seq,
        ),
      )

    case 'tool_execution_end':
      return withSession(
        state,
        stampSession(
          upsertToolExecution(state.session, event.toolCallId, {
            partialResult: event.result,
            status: event.isError ? 'error' : 'complete',
            ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          }),
          event.seq,
        ),
      )

    case 'queue_update':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          queuedMessages: queueMessagesOf(event.steering, event.followUp),
        }),
        stampSession(state.session, event.seq),
      )

    case 'compaction_start':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          compactionActive: true,
          compactionReason: event.reason,
        }),
        stampSession({ ...state.session, compactionError: undefined }, event.seq),
      )

    case 'compaction_end': {
      const metadata: HarnessThreadMetadata = { ...state.metadata, compactionActive: false }
      delete metadata.compactionReason
      // 失败保留 errorMessage；取消不算失败（不保留错误）。
      return withSession(
        withMetadata(state, metadata),
        stampSession(
          {
            ...state.session,
            compactionError: event.aborted || !event.errorMessage ? undefined : event.errorMessage,
          },
          event.seq,
        ),
      )
    }

    case 'bash_start':
    case 'bash_end':
      return withSession(state, stampSession({ ...state.session, bash: event.run }, event.seq))

    case 'bash_output': {
      const current = state.session.bash
      if (!current || current.id !== event.id) {
        return withSession(state, stampSession(state.session, event.seq))
      }
      let output = current.output + event.delta
      if (event.dropped > 0) output = output.slice(event.dropped)
      return withSession(
        state,
        stampSession(
          {
            ...state.session,
            bash: {
              ...current,
              output,
              outputTruncated: current.outputTruncated || event.dropped > 0,
            },
          },
          event.seq,
        ),
      )
    }

    case 'auto_retry_start':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          retryActive: true,
          retryAttempt: event.attempt,
        }),
        stampSession(state.session, event.seq),
      )

    case 'auto_retry_end':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          retryActive: false,
          retryAttempt: 0,
        }),
        stampSession(state.session, event.seq),
      )

    case 'context_usage':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          contextUsage: event.contextUsage,
        }),
        stampSession(state.session, event.seq),
      )

    case 'reload_start':
      // 资源重载由宿主广播；快照是权威，这里先让元数据反映“重载中”。
      return withSession(
        withMetadata(state, { ...state.metadata, reload: event.operation }),
        stampSession(state.session, event.seq),
      )

    case 'reload_end':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          reload: event.operation,
          resourceRevision: event.resourceRevision,
        }),
        stampSession(state.session, event.seq),
      )

    case 'session_info_changed': {
      const metadata: HarnessThreadMetadata = { ...state.metadata }
      if (event.name?.trim()) {
        metadata.name = event.name.trim()
        metadata.title = metadata.name
      } else {
        delete metadata.name
        if (metadata.firstMessageText) {
          metadata.title = metadata.firstMessageText.slice(0, 60).trim()
        } else {
          delete metadata.title
        }
      }
      return withSession(withMetadata(state, metadata), stampSession(state.session, event.seq))
    }

    case 'thinking_level_changed':
      return withSession(
        withMetadata(state, {
          ...state.metadata,
          config: { ...state.metadata.config, thinkingLevel: event.level },
        }),
        stampSession(state.session, event.seq),
      )

    case 'extension_ui_request': {
      if (state.session.hostUiRequests.some((request) => request.id === event.request.id)) {
        return withSession(state, stampSession(state.session, event.seq))
      }
      return withSession(
        state,
        stampSession(
          {
            ...state.session,
            hostUiRequests: [...state.session.hostUiRequests, event.request],
          },
          event.seq,
        ),
      )
    }

    case 'host_ui_update':
      return withSession(state, stampSession({ ...state.session, hostUi: event.hostUi }, event.seq))

    case 'extension_ui_resolved':
      return withSession(
        state,
        stampSession(removeHostUiRequest(state.session, event.requestId), event.seq),
      )

    case 'error':
      return withSession(
        withMetadata(state, setMetadataStatus(state.metadata, 'failed')),
        stampSession({ ...state.session, lastError: event.error }, event.seq),
      )

    case 'entry_appended':
    case 'turn_start':
    case 'turn_end':
      return withSession(state, stampSession(state.session, event.seq))

    default: {
      // 前向兼容：未知事件类型被容忍（只推进 seq），是否整刷由连接层决定。
      const unknownEvent = event as { seq: number }
      return withSession(state, stampSession(state.session, unknownEvent.seq))
    }
  }
}

/**
 * HTTP 冷读快照是否已落后于并发实时状态。
 *
 * - 请求期间序号回退：订阅快照重建了序列，旧 HTTP 响应对新序列无意义。
 * - 请求期间已有更新的事件，且响应没有可比较的更新序号：不能覆盖实时状态。
 */
export const isStaleHttpSnapshot = (
  session: HarnessThreadSession,
  snapshot: HarnessThreadSnapshot,
  sequenceAtStart: number,
): boolean => {
  const currentSequence = session.lastSeq
  const sequenceResetWhileLoading = currentSequence < sequenceAtStart
  const responseWasOvertaken =
    currentSequence > sequenceAtStart &&
    (snapshot.seq === undefined || snapshot.seq < currentSequence)
  return sequenceResetWhileLoading || responseWasOvertaken
}

/** 应用权威快照（调用方已通过 epoch/水位检查）。 */
export const applyHarnessThreadSnapshot = (
  state: HarnessThreadReduction,
  snapshot: HarnessThreadSnapshot,
  eventSeq: number,
): HarnessThreadReduction =>
  reduceHarnessThreadState(state, {
    type: 'snapshot',
    snapshot,
    threadId: snapshot.metadata.id,
    seq: eventSeq,
  } as HarnessClientEvent)

/** 快照中 contextUsage 的便捷读取（只在元数据保存）。 */
export const selectThreadContextUsage = (
  metadata: HarnessThreadMetadata,
): HarnessContextUsage | undefined => metadata.contextUsage
