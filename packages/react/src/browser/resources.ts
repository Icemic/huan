/**
 * 浏览器实例的资源所有者：SSE 租约、根订阅、帧调度与 MCP 轮询计时器。
 *
 * 设计（见 R1 §6）：
 * - live 视图通过简单引用计数持有会话订阅；空闲会话也保持实时同步。
 *   lease 归零后在**微任务**中确认，StrictMode 同轮重挂不会断开/驱逐。
 * - 归零释放关闭 SSE、驱逐完整会话缓存，但保留目录元数据、窗口草稿与提交。
 * - 每个订阅带本地 epoch：释放、重连或 dispose 后，旧回调不得再写状态。
 * - 流式 `message_update`/`tool_execution_update` 按帧合并；终结、交互、错误
 *   事件立即刷新缓冲，不把高频帧逐条写进 Zustand。
 * - provider 认证与宿主交互由根订阅唯一持有；MCP 认证轮询沿用现有节奏
 *   （活动操作 1s、否则 2s，面板关闭且无活动操作时停止），不重写 broker。
 * - dispose 永久失效，逐项回收并汇总错误。
 */

import type { HarnessClient, HarnessClientEvent, HarnessMcpAuthSnapshot } from '@huan/protocol'
import type { StoreApi } from 'zustand/vanilla'
import { isKnownHarnessClientEventType } from '../model/event-types.js'
import type { HarnessServiceState } from './service-store.js'

/** 帧调度器：返回取消函数；测试可注入确定性实现。 */
export type HarnessFrameScheduler = (flush: () => void) => () => void

export interface CreateHarnessResourcesOptions {
  client: HarnessClient
  serviceStore: StoreApi<HarnessServiceState>
  scheduleFrame?: HarnessFrameScheduler
}

/** 浏览器实例资源接口。 */
export interface HarnessBrowserResources {
  /** 取得根订阅引用；最后一次释放在微任务确认后停止。 */
  acquireRoot(): () => void
  /** 取得会话 live 订阅引用；归零后微任务确认释放完整缓存。 */
  acquireThreadLease(threadId: string): () => void
  /** 仅重建现有消费者持有且已终止的连接，不重新发送业务请求。 */
  reconnectThread(threadId: string): void
  /** 面板打开/关闭 MCP 认证轮询；关闭且无活动操作时停止。 */
  setMcpAuthPanelOpen(open: boolean): void
  /** 主动重读 MCP 认证快照（失败保留上一次成功值）。 */
  refreshMcpAuth(): Promise<void>
  dispose(): void
  readonly disposed: boolean
}

interface LiveThreadState {
  threadId: string
  count: number
  epoch: number
  closed: boolean
  unsubscribe: (() => void) | undefined
  buffer: HarnessClientEvent[]
  cancelFrame: (() => void) | undefined
}

/** 可按帧合并的流式事件：每条都携带当前完整增量，合并后仍保持最终状态。 */
const COALESCED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message_update',
  'tool_execution_update',
])

const MCP_AUTH_ERROR_TEXT = '无法读取 MCP 认证状态，请检查宿主连接。'

const defaultScheduleFrame: HarnessFrameScheduler = (flush) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const id = globalThis.requestAnimationFrame(() => flush())
    return () => globalThis.cancelAnimationFrame(id)
  }
  const timer = setTimeout(flush, 16)
  return () => clearTimeout(timer)
}

const hasActiveMcpOperations = (snapshot: HarnessMcpAuthSnapshot | undefined): boolean =>
  snapshot?.operations.some(
    (operation) =>
      operation.phase !== 'succeeded' &&
      operation.phase !== 'failed' &&
      operation.phase !== 'cancelled',
  ) ?? false

const runCleanup = (cleanups: readonly (() => void)[], errors: unknown[]): void => {
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
}

const logCleanupErrors = (errors: readonly unknown[]): void => {
  for (const error of errors) console.error('[huan-react] 资源释放失败', error)
}

const throwCleanupErrors = (errors: readonly unknown[]): void => {
  if (errors.length === 0) return
  logCleanupErrors(errors.slice(1))
  throw errors[0]
}

export const createHarnessResources = (
  options: CreateHarnessResourcesOptions,
): HarnessBrowserResources => {
  const { client, serviceStore } = options
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame
  const liveThreads = new Map<string, LiveThreadState>()

  let disposed = false
  let rootEpoch = 0
  let rootCount = 0
  let rootStopPending = false
  let rootStop: (() => void) | undefined

  let mcpPanelOpen = false
  let mcpTimer: ReturnType<typeof setTimeout> | undefined
  let mcpInFlight = false

  const closeLiveThread = (entry: LiveThreadState) => {
    entry.closed = true
    entry.epoch += 1
    if (entry.cancelFrame) {
      entry.cancelFrame()
      entry.cancelFrame = undefined
    }
    entry.buffer.length = 0
    const unsubscribe = entry.unsubscribe
    entry.unsubscribe = undefined
    unsubscribe?.()
  }

  const applyEvents = (entry: LiveThreadState, events: readonly HarnessClientEvent[]) => {
    if (events.length === 0) return
    serviceStore.getState().applyThreadEvents(entry.threadId, events)
  }

  const flushBuffered = (entry: LiveThreadState) => {
    if (entry.buffer.length === 0) return
    const events = entry.buffer.slice()
    entry.buffer.length = 0
    applyEvents(entry, events)
  }

  const scheduleBufferedFlush = (entry: LiveThreadState) => {
    if (entry.cancelFrame) return
    entry.cancelFrame = scheduleFrame(() => {
      entry.cancelFrame = undefined
      if (disposed || entry.closed) return
      flushBuffered(entry)
    })
  }

  /** 未知事件与非 custom 的追加条目沿用旧兜底：后台冷读权威快照。 */
  const maybeRefreshFromSnapshot = (entry: LiveThreadState, event: HarnessClientEvent) => {
    const needsRefresh =
      !isKnownHarnessClientEventType(event.type) ||
      (event.type === 'entry_appended' && event.entry?.type !== 'custom')
    if (!needsRefresh) return
    void serviceStore
      .getState()
      .loadThread(entry.threadId)
      .catch(() => {
        // loadThread 已把错误写入会话状态。
      })
  }

  const handleLiveEvent = (entry: LiveThreadState, event: HarnessClientEvent) => {
    if (COALESCED_EVENT_TYPES.has(event.type)) {
      entry.buffer.push(event)
      scheduleBufferedFlush(entry)
      return
    }
    // 终结、交互、取消与错误事件先刷新缓冲，并与当前事件一起原子应用。
    const events = entry.buffer.length > 0 ? [...entry.buffer, event] : [event]
    entry.buffer.length = 0
    if (entry.cancelFrame) {
      entry.cancelFrame()
      entry.cancelFrame = undefined
    }
    applyEvents(entry, events)
    maybeRefreshFromSnapshot(entry, event)
    if (event.type === 'error' && event.terminal === true) closeLiveThread(entry)
  }

  const startLiveThread = (entry: LiveThreadState) => {
    const epoch = entry.epoch
    entry.closed = false
    const unsubscribe = client.subscribe(
      entry.threadId,
      (event: HarnessClientEvent) => {
        if (disposed || entry.closed || entry.epoch !== epoch) return
        if (event.threadId !== entry.threadId) return
        handleLiveEvent(entry, event)
      },
      { includeSnapshot: true },
    )
    // 部分传输可能同步交付终止错误，不能把已关闭的订阅重新登记。
    if (entry.closed) unsubscribe()
    else entry.unsubscribe = unsubscribe
  }

  const reconnectThread = (threadId: string) => {
    if (disposed) return
    const entry = liveThreads.get(threadId)
    if (entry && entry.count > 0 && entry.closed) startLiveThread(entry)
  }

  const acquireThreadLease = (threadId: string): (() => void) => {
    if (disposed) throw new Error('Harness browser instance has been disposed')
    let entry = liveThreads.get(threadId)
    if (!entry) {
      entry = {
        threadId,
        count: 0,
        epoch: 0,
        closed: false,
        unsubscribe: undefined,
        buffer: [],
        cancelFrame: undefined,
      }
      liveThreads.set(threadId, entry)
    }
    entry.count += 1
    if (!entry.unsubscribe) startLiveThread(entry)

    let released = false
    return () => {
      if (released) return
      released = true
      const current = liveThreads.get(threadId)
      if (!current) return
      current.count = Math.max(0, current.count - 1)
      if (current.count > 0) return
      queueMicrotask(() => {
        if (disposed || current.count > 0 || liveThreads.get(threadId) !== current) return
        try {
          closeLiveThread(current)
        } catch (error) {
          console.error('[huan-react] 会话订阅释放失败', error)
        }
        liveThreads.delete(threadId)
        // 只驱逐完整会话缓存；目录元数据与窗口草稿保留。
        serviceStore.getState().evictThreadSession(threadId)
      })
    }
  }

  const stopRoot = (): unknown[] => {
    const stop = rootStop
    rootStop = undefined
    rootEpoch += 1
    if (!stop) return []
    const errors: unknown[] = []
    runCleanup([stop], errors)
    return errors
  }

  const startRoot = () => {
    const epoch = ++rootEpoch
    const cleanups: Array<() => void> = []
    try {
      cleanups.push(
        client.subscribeProviderAuth((event) => {
          if (disposed || epoch !== rootEpoch) return
          serviceStore.getState().applyProviderAuth(event.snapshot)
        }),
      )
      cleanups.push(
        client.subscribeHostInteractions((event) => {
          if (disposed || epoch !== rootEpoch) return
          serviceStore.getState().applyHostInteractions(event)
        }),
      )
    } catch (error) {
      const cleanupErrors: unknown[] = []
      runCleanup(cleanups, cleanupErrors)
      logCleanupErrors(cleanupErrors)
      throw error
    }
    // 宿主信息只用于存储作用域与状态展示；失败记录在 serviceStore。
    void serviceStore
      .getState()
      .loadHostInfo()
      .catch(() => {})
    void refreshMcpAuth()
    rootStop = () => {
      const errors: unknown[] = []
      runCleanup(cleanups, errors)
      throwCleanupErrors(errors)
    }
  }

  const acquireRoot = (): (() => void) => {
    if (disposed) throw new Error('Harness browser instance has been disposed')
    rootCount += 1
    if (rootCount === 1 && !rootStop) {
      try {
        startRoot()
      } catch (error) {
        rootCount = Math.max(0, rootCount - 1)
        throw error
      }
    }

    let released = false
    return () => {
      if (released) return
      released = true
      rootCount = Math.max(0, rootCount - 1)
      if (rootCount > 0 || rootStopPending) return
      rootStopPending = true
      queueMicrotask(() => {
        rootStopPending = false
        if (disposed || rootCount > 0) return
        logCleanupErrors(stopRoot())
        clearMcpTimer()
      })
    }
  }

  const clearMcpTimer = () => {
    if (mcpTimer === undefined) return
    clearTimeout(mcpTimer)
    mcpTimer = undefined
  }

  const scheduleMcpPoll = () => {
    clearMcpTimer()
    if (disposed || rootCount === 0) return
    const active = hasActiveMcpOperations(serviceStore.getState().mcpAuth)
    if (!mcpPanelOpen && !active) return
    mcpTimer = setTimeout(
      () => {
        mcpTimer = undefined
        void pollMcpAuth()
      },
      active ? 1_000 : 2_000,
    )
  }

  const pollMcpAuth = async () => {
    if (mcpInFlight || disposed) return
    mcpInFlight = true
    try {
      const snapshot = await client.getMcpAuth()
      if (disposed) return
      serviceStore.getState().applyMcpAuth(snapshot)
    } catch {
      if (!disposed) serviceStore.getState().setMcpAuthError(MCP_AUTH_ERROR_TEXT)
    } finally {
      mcpInFlight = false
      scheduleMcpPoll()
    }
  }

  const refreshMcpAuth = async () => {
    await pollMcpAuth()
  }

  const setMcpAuthPanelOpen = (open: boolean) => {
    if (disposed) return
    if (mcpPanelOpen === open) {
      if (open) void pollMcpAuth()
      return
    }
    mcpPanelOpen = open
    if (open) {
      void pollMcpAuth()
      return
    }
    if (!hasActiveMcpOperations(serviceStore.getState().mcpAuth)) clearMcpTimer()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    const errors: unknown[] = []
    rootEpoch += 1
    rootCount = 0
    rootStopPending = false
    const stop = rootStop
    rootStop = undefined
    if (stop) runCleanup([stop], errors)
    clearMcpTimer()
    for (const entry of liveThreads.values()) {
      runCleanup([() => closeLiveThread(entry)], errors)
    }
    liveThreads.clear()
    runCleanup([() => serviceStore.getState().dispose()], errors)
    throwCleanupErrors(errors)
  }

  return {
    acquireRoot,
    acquireThreadLease,
    reconnectThread,
    setMcpAuthPanelOpen,
    refreshMcpAuth: pollMcpAuth,
    dispose,
    get disposed() {
      return disposed
    },
  }
}
