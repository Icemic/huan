/**
 * HTTP 传输层的 Server-Sent-Events 解码。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/client/eventSource.ts`
 * （MIT 许可）。改动：类型改用 `@huan/protocol`，命名 `Pi*` → `Harness*`，
 * 上游内部工具改从 `../vendor/anti-corruption.js` 引入，
 * `isKnownPiClientEventType` 改从 `../event-types.js` 引入，注释译为中文。
 * 逻辑与上游逐行等价。
 *
 * SSE 属于客户端层，**不属于** controller：`HarnessThreadController` 只会
 * 通过 `HarnessClient.subscribe` 看到已解码的 `HarnessClientEvent`。
 * 线格式与重连都在这里。
 *
 * 两部分：
 * - `createHarnessSseDecoder()`——增量 SSE 帧解析器，包装 assistant-stream
 *   的 `SSEEventDecoder`。喂入文本块（可能从帧中间断开），返回目前完整的帧。
 * - `openHarnessEventStream()`——`fetch` + `ReadableStream` 循环，喂给解码器
 *   并产出解析后的 `HarnessAnyClientEvent`。快照优先的重连：服务端在每次
 *   （重）连接时重发 `snapshot`，因此断流靠替换本地状态恢复，绝不靠重放。
 *   返回的函数中止在途 fetch 并停止重连循环。
 *
 * 浏览器安全：不导入任何 Pi SDK 包。
 */

import type { HarnessAnyClientEvent, HarnessClientEvent } from '@huan/protocol'
import { SSEEventDecoder, SSEEventDecoderError } from 'assistant-stream/utils'
import { isKnownHarnessClientEventType } from '../event-types.js'
import { invokeUserCallback, isRecord } from '../vendor/anti-corruption.js'
import {
  isAssistantMessageDelta,
  isBashRun,
  isCompleteTranscriptMessage,
  isContextUsage,
  isHostUiRequest,
  isReloadOperation,
  isThreadHostUi,
  isThreadSnapshot,
} from './validation.js'

/**
 * 一个解码后的 SSE 帧。
 * `data` 是帧内所有 `data:` 行的拼接（按 SSE 规范以 `\n` 连接）；
 * `event`/`id` 是最后出现的字段值，帧未携带时省略。
 */
export interface SseFrame {
  event?: string
  data: string
  id?: string
}

/**
 * 增量 SSE 帧解析器。
 * `push(chunk)` 返回该块完成的所有帧；末尾不完整的数据由共享解码器缓冲，
 * 直到其终止空行到达。
 */
export const createHarnessSseDecoder = (options?: {
  maxLineLength?: number | undefined
  maxEventLength?: number | undefined
}) => {
  const decoder = new SSEEventDecoder(options)
  return {
    push(chunk: string): SseFrame[] {
      return decoder.push(chunk).map(({ data, event, id }) => ({
        ...(event === undefined ? {} : { event }),
        data,
        ...(id === undefined ? {} : { id }),
      }))
    },
  }
}

/** 事件流选项。 */
export interface HarnessEventStreamOptions {
  /** SSE 端点的绝对或相对 URL。 */
  url: string
  /** 每解码出一个 `HarnessClientEvent` 时调用。 */
  onEvent: (event: HarnessAnyClientEvent) => void
  /** 每次成功打开 SSE 响应后、事件之前调用。 */
  onConnect?: () => void
  /**
   * 流错误，供记录。
   * 传输故障会重连；解码器配置与大小限制故障会终止连接。
   */
  onError?: (error: unknown) => void
  /** 注入的 `fetch`（默认全局）。 */
  fetchImpl?: typeof fetch
  /** 额外请求头（如鉴权）。 */
  headers?: Record<string, string>
  /** 每个事件信封中期望的线程 ID。 */
  expectedThreadId?: string
  /** 流断开后用于恢复的「启用快照」URL。 */
  snapshotRecoveryUrl?: string
  /**
   * 断流与下次尝试之间的重连退避。
   * 拒绝会经 `onError` 上报，随后走默认的约 1 秒退避。
   */
  reconnectDelay?: () => Promise<void>
  /** 单条 SSE 行接受的最大 UTF-16 码元数。默认 16 MiB。 */
  maxStreamLineLength?: number | undefined
  /** 单个 SSE 事件累计保留的最大 UTF-16 码元数。默认 16 MiB。 */
  maxStreamEventLength?: number | undefined
}

const defaultReconnectDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 1000))

const validateEventStreamContentType = (response: Response): void => {
  const contentType = response.headers.get('Content-Type')
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'text/event-stream') {
    const received = contentType ? `"${contentType}"` : 'no Content-Type header'
    void response.body?.cancel().catch(() => undefined)
    throw new Error(
      `Expected Pi event stream Content-Type "text/event-stream", received ${received}`,
    )
  }
}

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean'

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || typeof value === 'number'

const isKnownEventPayload = (event: Record<string, unknown>): boolean => {
  switch (event.type) {
    case 'snapshot':
      return isThreadSnapshot(event.snapshot)
    case 'agent_start':
    case 'agent_settled':
      return true
    case 'agent_end':
      return isOptionalBoolean(event.willRetry) && isOptionalBoolean(event.cancelledBeforeStart)
    case 'turn_start':
    case 'turn_end':
      return typeof event.turnIndex === 'number'
    case 'message_start':
    case 'message_end':
      return isCompleteTranscriptMessage(event.message)
    case 'message_update':
      return (
        isCompleteTranscriptMessage(event.message) &&
        isAssistantMessageDelta(event.assistantMessageEvent)
      )
    case 'tool_execution_start':
      return (
        typeof event.toolCallId === 'string' &&
        typeof event.toolName === 'string' &&
        hasOwn(event, 'args') &&
        isOptionalString(event.parentToolCallId)
      )
    case 'tool_execution_update':
      return (
        typeof event.toolCallId === 'string' &&
        isOptionalString(event.toolName) &&
        hasOwn(event, 'partialResult') &&
        isOptionalString(event.parentToolCallId)
      )
    case 'tool_execution_end':
      return (
        typeof event.toolCallId === 'string' &&
        typeof event.isError === 'boolean' &&
        hasOwn(event, 'result') &&
        isOptionalString(event.parentToolCallId)
      )
    case 'queue_update':
      return isStringArray(event.steering) && isStringArray(event.followUp)
    case 'compaction_start':
      return typeof event.reason === 'string'
    case 'compaction_end':
      return (
        typeof event.reason === 'string' &&
        typeof event.aborted === 'boolean' &&
        typeof event.willRetry === 'boolean' &&
        isOptionalString(event.errorMessage) &&
        isOptionalNumber(event.tokensBefore) &&
        isOptionalNumber(event.estimatedTokensAfter)
      )
    case 'bash_start':
    case 'bash_end':
      return isBashRun(event.run)
    case 'bash_output':
      return (
        typeof event.id === 'string' &&
        typeof event.delta === 'string' &&
        typeof event.dropped === 'number'
      )
    case 'entry_appended':
      return (
        isRecord(event.entry) &&
        typeof event.entry.id === 'string' &&
        (event.entry.parentId === null || typeof event.entry.parentId === 'string') &&
        typeof event.entry.timestamp === 'string' &&
        typeof event.entry.type === 'string'
      )
    case 'auto_retry_start':
      return typeof event.attempt === 'number' && typeof event.delayMs === 'number'
    case 'auto_retry_end':
      return typeof event.success === 'boolean'
    case 'session_info_changed':
      return isOptionalString(event.name)
    case 'thinking_level_changed':
      return typeof event.level === 'string'
    case 'context_usage':
      return isContextUsage(event.contextUsage)
    case 'extension_ui_request':
      return isHostUiRequest(event.request)
    case 'reload_start':
      return isReloadOperation(event.operation)
    case 'reload_end':
      return isReloadOperation(event.operation) && typeof event.resourceRevision === 'number'
    case 'host_ui_update':
      return event.hostUi === undefined || isThreadHostUi(event.hostUi)
    case 'extension_ui_resolved':
      return typeof event.requestId === 'string'
    case 'error':
      return typeof event.error === 'string'
    default:
      return true
  }
}

class InvalidKnownEventStreamPayloadError extends Error {}

const parseEventStreamPayload = (
  data: string,
  expectedThreadId?: string,
): HarnessAnyClientEvent => {
  const event: unknown = JSON.parse(data)
  if (!isRecord(event)) {
    throw new Error('Invalid Pi event stream payload: expected an object')
  }
  if (typeof event.type !== 'string' || event.type.length === 0) {
    throw new Error('Invalid Pi event stream payload: expected a non-empty string "type"')
  }
  const PayloadError = isKnownHarnessClientEventType(event.type)
    ? InvalidKnownEventStreamPayloadError
    : Error
  if (typeof event.threadId !== 'string' || event.threadId.length === 0) {
    throw new PayloadError(
      'Invalid Pi event stream payload: expected a non-empty string "threadId"',
    )
  }
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0) {
    throw new PayloadError(
      'Invalid Pi event stream payload: expected a non-negative safe integer "seq"',
    )
  }
  if (expectedThreadId !== undefined && event.threadId !== expectedThreadId) {
    throw new InvalidKnownEventStreamPayloadError(
      `Invalid Pi event stream payload: expected thread "${expectedThreadId}", received "${event.threadId}"`,
    )
  }
  if (isKnownHarnessClientEventType(event.type) && !isKnownEventPayload(event)) {
    throw new InvalidKnownEventStreamPayloadError(
      `Invalid Pi event stream payload: event "${event.type}" has an invalid payload`,
    )
  }
  return event as HarnessAnyClientEvent
}

/** 一个可主动关闭/重连的事件流连接。 */
export type HarnessEventStreamConnection = {
  close: () => void
  reconnect: () => boolean
  finished: Promise<void>
}

/**
 * 打开一个可重连的 SSE 流。
 * 返回同步的取消订阅函数，中止在途请求并停止重连。
 * 名为 `ping` 的帧与空帧被当作心跳丢弃；其余帧的 `data` 会被 JSON 解析为
 * `HarnessAnyClientEvent`。
 */
export const openHarnessEventStream = (options: HarnessEventStreamOptions): (() => void) =>
  createHarnessEventStreamConnection(options).close

/** 创建事件流连接（需要主动重连控制时使用）。 */
export const createHarnessEventStreamConnection = (
  options: HarnessEventStreamOptions,
): HarnessEventStreamConnection => {
  const {
    url,
    onEvent,
    onConnect,
    onError,
    fetchImpl = fetch,
    headers,
    expectedThreadId,
    snapshotRecoveryUrl,
    reconnectDelay = defaultReconnectDelay,
    maxStreamLineLength,
    maxStreamEventLength,
  } = options

  let closed = false
  let needsSnapshotRecovery = false
  let cancelActiveReader: (() => void) | undefined
  let interruptReconnectWait: (() => void) | undefined
  let reconnectPending = false
  let reconnectRequested = false
  const abort = new AbortController()
  const reportError = (error: unknown) => {
    void invokeUserCallback('huan-react', 'onError', onError, error)
  }
  const emitEvent = (event: HarnessAnyClientEvent) => {
    void invokeUserCallback('huan-react', 'onEvent', onEvent, event)
  }
  const emitConnect = () => {
    void invokeUserCallback('huan-react', 'onConnect', onConnect)
  }

  const waitForReconnect = () => {
    if (reconnectRequested) {
      reconnectRequested = false
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      let pending = true
      const finish = () => {
        if (!pending) return
        pending = false
        if (interruptReconnectWait === finish) {
          interruptReconnectWait = undefined
        }
        resolve()
      }
      interruptReconnectWait = finish

      void Promise.resolve()
        .then(reconnectDelay)
        .then(finish, (error: unknown) => {
          if (!pending || closed) return
          reportError(error)
          void defaultReconnectDelay().then(finish)
        })
    })
  }

  const run = async () => {
    while (!closed) {
      try {
        const sseDecoder = createHarnessSseDecoder({
          maxLineLength: maxStreamLineLength,
          maxEventLength: maxStreamEventLength,
        })
        const requestUrl = needsSnapshotRecovery && snapshotRecoveryUrl ? snapshotRecoveryUrl : url
        const response = await fetchImpl(requestUrl, {
          method: 'GET',
          signal: abort.signal,
          headers: { Accept: 'text/event-stream', ...headers },
        })
        if (!response.ok || !response.body) {
          void response.body?.cancel().catch(() => undefined)
          throw new Error(`Pi event stream failed: HTTP ${response.status}`)
        }
        validateEventStreamContentType(response)
        emitConnect()

        const reader = response.body.getReader()
        const textDecoder = new TextDecoder()
        const handleFrame = (frame: { event?: string; data: string }) => {
          if (frame.event === 'ping' || frame.data === '') return
          let parsed: HarnessAnyClientEvent
          try {
            parsed = parseEventStreamPayload(frame.data, expectedThreadId)
          } catch (error) {
            if (error instanceof InvalidKnownEventStreamPayloadError) {
              throw error
            }
            reportError(error)
            return
          }
          if (!closed) emitEvent(parsed)
        }

        let shouldCancel = true
        let cancelPromise: Promise<void> | undefined
        const cancelReader = () => {
          cancelPromise ??= reader.cancel().catch(() => undefined)
          return cancelPromise
        }
        const requestCancel = () => {
          void cancelReader()
        }
        cancelActiveReader = requestCancel

        try {
          while (!closed) {
            let result: ReadableStreamReadResult<Uint8Array>
            try {
              result = await reader.read()
            } catch (error) {
              shouldCancel = false
              throw error
            }

            const { value, done } = result
            if (done) {
              shouldCancel = false
              break
            }
            const chunk = textDecoder.decode(value, { stream: true })
            for (const frame of sseDecoder.push(chunk)) {
              handleFrame(frame)
            }
          }
        } finally {
          if (cancelActiveReader === requestCancel) cancelActiveReader = undefined
          if (!closed) reconnectPending = true
          try {
            if (shouldCancel || cancelPromise) await cancelReader()
          } finally {
            reader.releaseLock()
          }
        }
      } catch (error) {
        if (closed || abort.signal.aborted) break
        const terminal = error instanceof SSEEventDecoderError
        reconnectPending = !terminal
        reportError(error)
        if (terminal) break
      }
      if (closed) break
      needsSnapshotRecovery = true
      reconnectPending = true
      // 快照优先：下次连接会替换本地状态，因此不重放也不丢东西。
      // 退避后重试。
      await waitForReconnect()
      reconnectPending = false
      reconnectRequested = false
    }
  }

  const finished = run()

  return {
    close: () => {
      closed = true
      abort.abort()
      cancelActiveReader?.()
      interruptReconnectWait?.()
    },
    reconnect: () => {
      if (closed || !reconnectPending) return false
      reconnectRequested = true
      interruptReconnectWait?.()
      return true
    },
    finished,
  }
}

/** 终止性流错误的判据（解码器大小/配置限制）。 */
export const isTerminalStreamError = (error: unknown): boolean =>
  error instanceof SSEEventDecoderError

/** 误判用的类型占位，确保 `HarnessClientEvent` 在类型层被引用。 */
export type { HarnessClientEvent }
