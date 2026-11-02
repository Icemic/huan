/**
 * SSE 传输链路验证（roadmap §2.2 退出标准 #4）。
 *
 * 覆盖：**宿主编码 → HTTP/SSE → 客户端解码 → reducer → 权威状态**。
 * 此前 `event-replay.test.ts` 只做 `JSON.stringify → JSON.parse → reducer`，
 * 绕过了 HTTP 层与 SSE 帧编码；本文件补上这一段。
 *
 * 用 Hono 应用直接处理 `Request`（`app.fetch`），避免起真实端口；
 * 客户端是全真实的 `createHarnessHttpClient`（含 SSE 解码与重连），
 * 消费方是真实的纯 reducer 归约（`@huan/react/model`）。
 *
 * 断言的两条关键语义：
 * 1. 快照优先：接上先投递快照，之后的事件按 seq 递增投递；
 * 2. live-only 断流恢复：`?snapshot=false` 的订阅在断流重连后切回带快照的
 *    URL，因此离线期间的状态变化能被补上（这条正是自研 subscribe 相对
 *    上游共享缓存实现最需要验证的差异点）。
 */

import type {
  HarnessAnyClientEvent,
  HarnessClient,
  HarnessHostInteractionEvent,
} from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react/client'
import {
  createHarnessThreadReduction,
  reduceHarnessThreadState,
  selectThreadRunStatus,
} from '@huan/react/model'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createEventsRoute, createHostInteractionEventsRoute } from './sse.js'

const THREAD_ID = 't-e2e'

/** 一个可手动推送事件的假宿主客户端（只实现 subscribe）。 */
function createFakeHostClient() {
  const listeners = new Map<string, Set<(event: HarnessAnyClientEvent) => void>>()

  const client: Pick<HarnessClient, 'subscribe'> = {
    subscribe(threadId, listener, options) {
      const key = `${threadId}:${options?.includeSnapshot === false ? 'live' : 'snapshot'}`
      const set = listeners.get(key) ?? new Set<(event: HarnessAnyClientEvent) => void>()
      const broadcast = listener as (event: HarnessAnyClientEvent) => void
      set.add(broadcast)
      listeners.set(key, set)
      return () => {
        set.delete(broadcast)
      }
    },
  }

  /** 向指定订阅模式的监听者广播事件；返回实际送达的监听者数。 */
  const emit = (event: HarnessAnyClientEvent, mode: 'snapshot' | 'live' = 'snapshot'): number => {
    const set = listeners.get(`${THREAD_ID}:${mode}`)
    if (!set) return 0
    for (const listener of set) listener(event)
    return set.size
  }

  const counts = () => ({
    snapshot: listeners.get(`${THREAD_ID}:snapshot`)?.size ?? 0,
    live: listeners.get(`${THREAD_ID}:live`)?.size ?? 0,
  })

  return { client, emit, counts }
}

const snapshot = (seq: number, messageCount: number): HarnessAnyClientEvent => ({
  type: 'snapshot',
  threadId: THREAD_ID,
  seq,
  snapshot: {
    metadata: { id: THREAD_ID, status: 'idle', messageCount },
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: 'user' as const,
      content: `m${index}`,
      timestamp: index + 1,
    })),
    seq,
  },
})

/** 组装一个只含事件流路由的 Hono 应用。 */
function createApp(client: Pick<HarnessClient, 'subscribe'>) {
  const app = new Hono()
  app.get('/api/pi/threads/:id/events', createEventsRoute(client))
  return app
}

/**
 * 让 SSE 帧的写入与读取错开：服务端按写入顺序编码，客户端读流是异步的，
 * 因此需要等待直到条件满足（而非固定 sleep）。
 */
const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor 超时')
}

/**
 * 把收到的（可能是未知类型的）事件送回 reducer。
 *
 * 类型桥接：协议侧允许未知事件兜底（`HarnessAnyClientEvent` 开放变体），
 * 而 reducer 入参是窄联合；reducer 的 default 分支对未知类型只记 seq 并忽略，
 * 这正是两侧约定的前向兼容行为。
 */
const applyEvent = (
  state: ReturnType<typeof createHarnessThreadReduction>,
  event: HarnessAnyClientEvent,
) => reduceHarnessThreadState(state, event as Parameters<typeof reduceHarnessThreadState>[1])

describe('SSE 传输链路（宿主 → HTTP/SSE → 客户端 → reducer）', () => {
  it('快照优先：先投递快照，其后事件按序进入 reducer', async () => {
    const host = createFakeHostClient()
    const app = createApp(host.client)

    const observed: HarnessAnyClientEvent[] = []
    const client = createHarnessHttpClient({
      baseUrl: '/api/pi',
      fetchImpl: async (input, init) =>
        app.fetch(new Request(new URL(String(input), 'http://localhost'), init)),
      reconnectDelay: () => Promise.resolve(),
    })
    const unsubscribe = client.subscribe(THREAD_ID, (event) => {
      observed.push(event)
    })

    try {
      await waitFor(() => host.counts().snapshot === 1)

      // 宿主先发快照，再发运行事件
      host.emit(snapshot(5, 2))
      host.emit({ type: 'agent_start', threadId: THREAD_ID, seq: 6 })
      host.emit({
        type: 'message_start',
        threadId: THREAD_ID,
        seq: 7,
        message: { role: 'user', content: 'hello', timestamp: 9 },
      } satisfies HarnessAnyClientEvent)

      await waitFor(() => observed.length === 3)

      // reducer 侧：权威状态正确
      let state = createHarnessThreadReduction(THREAD_ID)
      for (const event of observed) state = applyEvent(state, event)

      expect(state.session.loadState).toBe('loaded')
      expect(selectThreadRunStatus(state.metadata)).toBe('running')
      expect(state.session.lastSeq).toBe(7)
      expect(state.session.messages.map((m) => m.role)).toEqual(['user', 'user', 'user'])
    } finally {
      unsubscribe()
    }
  })

  it('live-only 订阅在断流重连后切回带快照的 URL 并补齐离线状态', async () => {
    const host = createFakeHostClient()
    const app = createApp(host.client)

    const requestedUrls: string[] = []
    /** 第一次连接直接断流，后续连接保持打开。 */
    let connections = 0
    const client = createHarnessHttpClient({
      baseUrl: '/api/pi',
      fetchImpl: async (input, init) => {
        requestedUrls.push(String(input))
        connections++
        if (connections === 1) {
          // 立刻结束响应体：模拟服务端断流
          return new Response(null, { status: 200 })
        }
        return app.fetch(new Request(new URL(String(input), 'http://localhost'), init))
      },
      reconnectDelay: () => Promise.resolve(),
    })

    const observed: HarnessAnyClientEvent[] = []
    const unsubscribe = client.subscribe(
      THREAD_ID,
      (event) => {
        observed.push(event)
      },
      { includeSnapshot: false },
    )

    try {
      // 首连使用 snapshot=false
      await waitFor(() => requestedUrls.length >= 1)
      expect(requestedUrls[0]).toBe('/api/pi/threads/t-e2e/events?snapshot=false')

      // 断流后重连：应切回带快照的 URL（否则离线期间的变化永远补不上）
      await waitFor(() => requestedUrls.length >= 2)
      expect(requestedUrls[1]).toBe('/api/pi/threads/t-e2e/events')

      // 恢复连接订阅的是「带快照」模式，宿主据此补发快照
      await waitFor(() => host.counts().snapshot === 1)

      host.emit(snapshot(20, 3))
      await waitFor(() => observed.length >= 1)

      let state = createHarnessThreadReduction(THREAD_ID)
      for (const event of observed) state = applyEvent(state, event)
      // 离线期间的 3 条消息被补齐
      expect(state.session.messages).toHaveLength(3)
      expect(state.session.lastSeq).toBe(20)
    } finally {
      unsubscribe()
    }
  })

  it('服务端序号重置后新事件仍被应用（快照下调水位）', async () => {
    const host = createFakeHostClient()
    const app = createApp(host.client)

    const observed: HarnessAnyClientEvent[] = []
    const client = createHarnessHttpClient({
      baseUrl: '/api/pi',
      fetchImpl: async (input, init) =>
        app.fetch(new Request(new URL(String(input), 'http://localhost'), init)),
      reconnectDelay: () => Promise.resolve(),
    })
    const unsubscribe = client.subscribe(THREAD_ID, (event) => {
      observed.push(event)
    })

    try {
      await waitFor(() => host.counts().snapshot === 1)
      host.emit(snapshot(100, 1))
      host.emit({ type: 'agent_start', threadId: THREAD_ID, seq: 101 })
      await waitFor(() => observed.length === 2)

      let state = createHarnessThreadReduction(THREAD_ID)
      for (const event of observed) state = applyEvent(state, event)
      expect(state.session.lastSeq).toBe(101)

      // 宿主重启：序号回到 0，后续事件 seq 从 1 开始
      host.emit(snapshot(0, 2))
      host.emit({
        type: 'message_start',
        threadId: THREAD_ID,
        seq: 1,
        message: { role: 'user', content: 'after-reset', timestamp: 50 },
      } satisfies HarnessAnyClientEvent)
      await waitFor(() => observed.length === 4)

      for (const event of observed.slice(2)) state = applyEvent(state, event)
      // 水位被快照下调，seq=1 的事件没有被当作过期丢弃
      expect(state.session.lastSeq).toBe(1)
      expect(state.session.messages).toHaveLength(3)
      expect(state.session.messages.at(-1)).toMatchObject({
        role: 'user',
        content: 'after-reset',
      })
    } finally {
      unsubscribe()
    }
  })

  it('同一批次内的快照与增量都被正确应用', async () => {
    const host = createFakeHostClient()
    const app = createApp(host.client)

    const observed: HarnessAnyClientEvent[] = []
    const client = createHarnessHttpClient({
      baseUrl: '/api/pi',
      fetchImpl: async (input, init) =>
        app.fetch(new Request(new URL(String(input), 'http://localhost'), init)),
      reconnectDelay: () => Promise.resolve(),
    })
    const unsubscribe = client.subscribe(THREAD_ID, (event) => {
      observed.push(event)
    })

    try {
      await waitFor(() => host.counts().snapshot === 1)
      // 连续同步推送：写入顺序即投递顺序
      host.emit(snapshot(2, 1))
      host.emit({ type: 'agent_start', threadId: THREAD_ID, seq: 3 })
      host.emit({
        type: 'message_start',
        threadId: THREAD_ID,
        seq: 4,
        message: { role: 'user', content: 'x', timestamp: 7 },
      } satisfies HarnessAnyClientEvent)
      await waitFor(() => observed.length === 3)

      expect(observed.map((event) => event.seq)).toEqual([2, 3, 4])

      let state = createHarnessThreadReduction(THREAD_ID)
      for (const event of observed) state = applyEvent(state, event)
      expect(state.session.messages).toHaveLength(2)
      expect(selectThreadRunStatus(state.metadata)).toBe('running')
    } finally {
      unsubscribe()
    }
  })

  it('畸形事件触发断流重连，并靠恢复快照复原状态', async () => {
    const host = createFakeHostClient()
    const app = createApp(host.client)

    const onStreamError = vi.fn()
    const observed: HarnessAnyClientEvent[] = []
    let connections = 0
    const client = createHarnessHttpClient({
      baseUrl: '/api/pi',
      fetchImpl: async (input, init) => {
        connections++
        return app.fetch(new Request(new URL(String(input), 'http://localhost'), init))
      },
      reconnectDelay: () => Promise.resolve(),
      onStreamError,
    })
    const unsubscribe = client.subscribe(THREAD_ID, (event) => {
      observed.push(event)
    })

    try {
      await waitFor(() => host.counts().snapshot === 1)
      host.emit(snapshot(1, 0))
      await waitFor(() => observed.length >= 1)

      // 已知事件类型但载荷非法：流完整性不可信，当前连接被放弃
      //（同 chunk 内后续帧一并丢弃——上游同为该语义），随后重连恢复。
      host.emit({
        type: 'message_start',
        threadId: THREAD_ID,
        seq: 2,
      } as unknown as HarnessAnyClientEvent)

      // 重连后宿主补发状态快照
      await waitFor(() => host.counts().snapshot === 1 && connections >= 2)
      await waitFor(() => host.counts().snapshot === 1 && observed.length >= 1)
      host.emit(snapshot(9, 2))
      await waitFor(() => observed.some((event) => event.type === 'snapshot' && event.seq === 9))

      let state = createHarnessThreadReduction(THREAD_ID)
      for (const event of observed) state = applyEvent(state, event)
      // 恢复快照是权威的：状态被替换为宿主当前真实状态
      expect(state.session.messages).toHaveLength(2)
      expect(state.session.lastSeq).toBe(9)
    } finally {
      unsubscribe()
    }
  })
})

describe('宿主级交互 SSE（启动期请求）', () => {
  it('订阅首帧与后续快照都能到达客户端', async () => {
    const listeners = new Set<(event: HarnessHostInteractionEvent) => void>()
    const client: Pick<HarnessClient, 'subscribeHostInteractions'> = {
      subscribeHostInteractions(listener) {
        listener({
          type: 'snapshot',
          seq: 0,
          snapshot: { seq: 0, requests: [], notifications: [] },
        })
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const app = new Hono()
    app.get('/api/pi/interactions/events', createHostInteractionEventsRoute(client))
    const http = createHarnessHttpClient({
      baseUrl: '/api/pi',
      fetchImpl: async (input, init) =>
        app.fetch(new Request(new URL(String(input), 'http://localhost'), init)),
      reconnectDelay: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      },
    })
    const events: Array<{ seq: number; count: number }> = []
    const release = http.subscribeHostInteractions((event) => {
      events.push({ seq: event.snapshot.seq, count: event.snapshot.requests.length })
    })
    await waitFor(() => events.length === 1)
    for (const listener of [...listeners]) {
      listener({
        type: 'snapshot',
        seq: 1,
        snapshot: {
          seq: 1,
          requests: [
            {
              id: 'r1',
              scope: { kind: 'project', cwd: '/project' },
              kind: 'confirm',
              title: '确认',
              message: '允许？',
              createdAt: 1,
            },
          ],
          notifications: [],
        },
      })
    }
    await waitFor(() => events.length === 2)
    release()
    expect(events).toEqual([
      { seq: 0, count: 0 },
      { seq: 1, count: 1 },
    ])
  })
})
