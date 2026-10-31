import type {
  HarnessAssistantMessage,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessThreadSnapshot,
  HarnessUserMessage,
} from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  createHarnessThreadState,
  type HarnessThreadState,
  reduceHarnessThreadState,
} from './thread-state.js'

let seq = 0
const ev = (body: HarnessClientEventBody, threadId = 't1'): HarnessClientEvent =>
  ({ ...body, threadId, seq: ++seq }) as HarnessClientEvent

const assistant = (
  content: HarnessAssistantMessage['content'],
  overrides: Partial<HarnessAssistantMessage> = {},
): HarnessAssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 1,
  ...overrides,
})

const user = (text: string): HarnessUserMessage => ({
  role: 'user',
  content: text,
  timestamp: 0,
})

const apply = (state: HarnessThreadState, ...events: HarnessClientEvent[]) =>
  events.reduce(reduceHarnessThreadState, state)

describe('threadState（线程状态 reducer）', () => {
  it('初始为空且处于 pending', () => {
    const s = createHarnessThreadState('t1')
    expect(s.messages).toEqual([])
    expect(s.loadState).toBe('pending')
    expect(s.runStatus).toBe('idle')
  })

  it('整体应用快照并标记为 loaded', () => {
    const snapshot: HarnessThreadSnapshot = {
      metadata: { id: 't1', title: 'Hi', status: 'idle' },
      messages: [user('hello'), assistant([{ type: 'text', text: 'hi' }])],
    }
    const s = apply(createHarnessThreadState('t1'), ev({ type: 'snapshot', snapshot }))
    expect(s.messages).toHaveLength(2)
    expect(s.metadata.title).toBe('Hi')
    expect(s.loadState).toBe('loaded')
  })

  it('流式助手消息：start → update → end（原地替换）', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'agent_start' }),
      ev({ type: 'message_start', message: assistant([]) }),
    )
    expect(s.runStatus).toBe('running')
    expect(s.streamingMessageIndex).toBe(0)

    const partial = assistant([{ type: 'text', text: 'hel' }])
    s = apply(
      s,
      ev({
        type: 'message_update',
        message: partial,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'hel',
          partial,
        },
      }),
    )
    // replaced in place, not appended
    expect(s.messages).toHaveLength(1)
    expect((s.messages[0] as HarnessAssistantMessage).content).toEqual([
      { type: 'text', text: 'hel' },
    ])

    const final = assistant([{ type: 'text', text: 'hello' }])
    s = apply(s, ev({ type: 'message_end', message: final }))
    expect(s.messages).toHaveLength(1)
    expect(s.streamingMessageIndex).toBeUndefined()
    expect((s.messages[0] as HarnessAssistantMessage).content).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })

  it('运行中快照后直接收到完成消息时仍保留助手回复', () => {
    const previous = assistant([{ type: 'text', text: 'previous' }])
    const final = assistant([{ type: 'text', text: 'done' }], { timestamp: 2 })
    const s = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'running' },
          messages: [user('hello'), previous],
        },
      }),
      ev({ type: 'message_end', message: final }),
    )
    expect(s.messages).toEqual([user('hello'), previous, final])
    expect(s.streamingMessageIndex).toBeUndefined()
  })

  it('快照已含完成回复时，后续完成事件不会重复追加', () => {
    const final = assistant([{ type: 'text', text: 'done' }])
    const s = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'running' },
          messages: [user('hello'), final],
        },
      }),
      ev({ type: 'message_end', message: final }),
    )
    expect(s.messages).toEqual([user('hello'), final])
  })

  it('非助手完成事件不替换仍在流式中的助手消息', () => {
    const partial = assistant([{ type: 'text', text: 'partial' }])
    const s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'message_start', message: partial }),
      ev({ type: 'message_end', message: user('other') }),
    )
    expect(s.messages).toEqual([partial])
    expect(s.streamingMessageIndex).toBe(0)
  })

  it('追加非助手消息且不占用流式指针', () => {
    const s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'message_start', message: user('hello') }),
    )
    expect(s.messages).toHaveLength(1)
    expect(s.streamingMessageIndex).toBeUndefined()
  })

  it('按 toolCallId 跟踪工具执行生命周期', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    )
    expect(s.toolExecutions.tc1).toMatchObject({
      toolName: 'bash',
      status: 'running',
    })

    s = apply(
      s,
      ev({
        type: 'tool_execution_update',
        toolCallId: 'tc1',
        partialResult: { content: [{ type: 'text', text: 'file1\n' }] },
      }),
    )
    expect(s.toolExecutions.tc1?.partialResult).toEqual({
      content: [{ type: 'text', text: 'file1\n' }],
    })

    s = apply(
      s,
      ev({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        result: { content: [{ type: 'text', text: 'file1\nfile2\n' }] },
        isError: false,
      }),
    )
    expect(s.toolExecutions.tc1?.status).toBe('complete')
  })

  it('并行工具执行各自独立跟踪', () => {
    const s = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'a',
        toolName: 'bash',
        args: {},
      }),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'b',
        toolName: 'read',
        args: {},
      }),
      ev({
        type: 'tool_execution_end',
        toolCallId: 'b',
        result: {},
        isError: false,
      }),
    )
    expect(s.toolExecutions.a?.status).toBe('running')
    expect(s.toolExecutions.b?.status).toBe('complete')
  })

  it('快照省略 queuedMessages 时清空队列', () => {
    // Snapshots omit the field when nothing is queued, so missing ≠ "keep" —
    // otherwise a queue drained while disconnected would survive reconnect.
    let s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'queue_update', steering: ['s1'], followUp: ['f1'] }),
    )
    expect(s.queue).toEqual({ steering: ['s1'], followUp: ['f1'] })
    s = apply(s, {
      type: 'snapshot',
      snapshot: { metadata: { id: 't1', status: 'idle' }, messages: [] },
      threadId: 't1',
      seq: 0,
    } as HarnessClientEvent)
    expect(s.queue).toEqual({ steering: [], followUp: [] })
  })

  it('由 queue_update 更新队列', () => {
    const s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'queue_update', steering: ['s1'], followUp: ['f1', 'f2'] }),
    )
    expect(s.queue).toEqual({ steering: ['s1'], followUp: ['f1', 'f2'] })
  })

  it('跟踪压缩与重试标志', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'compaction_start', reason: 'threshold' }),
    )
    expect(s.compaction).toEqual({ active: true, reason: 'threshold' })
    s = apply(s, ev({ type: 'compaction_end', aborted: false, willRetry: false }))
    expect(s.compaction.active).toBe(false)

    s = apply(s, ev({ type: 'auto_retry_start', attempt: 2, delayMs: 500 }))
    expect(s.retry).toEqual({ active: true, attempt: 2 })
    s = apply(s, ev({ type: 'auto_retry_end', success: true }))
    expect(s.retry.active).toBe(false)
  })

  it.each([
    { status: 'idle', metadata: {}, clear: true },
    { status: 'failed', metadata: {}, clear: true },
    {
      status: 'running',
      metadata: { compactionActive: false, retryActive: false },
      clear: true,
    },
    { status: 'running', metadata: {}, clear: false },
  ] as const)(
    'reconciles compaction and retry flags with a $status snapshot',
    ({ status, metadata, clear }) => {
      const before = apply(
        createHarnessThreadState('t1'),
        ev({ type: 'compaction_start', reason: 'threshold' }),
        ev({ type: 'auto_retry_start', attempt: 2, delayMs: 500 }),
      )
      const after = apply(
        before,
        ev({
          type: 'snapshot',
          snapshot: {
            metadata: { id: 't1', status, ...metadata },
            messages: [],
          },
        }),
      )
      expect(after.compaction).toEqual(clear ? { active: false } : before.compaction)
      expect(after.retry).toEqual(clear ? { active: false, attempt: 0 } : before.retry)
    },
  )

  it('元数据活动标志与实时事件保持一致', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: {
            id: 't1',
            status: 'running',
            compactionActive: true,
            retryActive: true,
            retryAttempt: 2,
          },
          messages: [],
        },
      }),
    )
    expect(s.metadata).toMatchObject({
      compactionActive: true,
      retryActive: true,
      retryAttempt: 2,
    })

    s = apply(
      s,
      ev({ type: 'compaction_end', aborted: false, willRetry: false }),
      ev({ type: 'auto_retry_end', success: true }),
    )
    expect(s.metadata).toMatchObject({
      compactionActive: false,
      retryActive: false,
      retryAttempt: 0,
    })
    expect(s.compaction.active).toBe(false)
    expect(s.retry).toEqual({ active: false, attempt: 0 })
  })

  it('流快照重置序号时重设实时状态基线', () => {
    const before = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'compaction_start', reason: 'threshold' }),
      ev({ type: 'auto_retry_start', attempt: 2, delayMs: 500 }),
    )
    const after = reduceHarnessThreadState(before, {
      type: 'snapshot',
      threadId: 't1',
      seq: before.lastSeq - 1,
      snapshot: {
        metadata: {
          id: 't1',
          status: 'running',
          compactionActive: false,
          retryActive: false,
        },
        seq: before.lastSeq - 1,
        messages: [],
      },
    } as HarnessClientEvent)
    expect(after.compaction).toEqual({ active: false })
    expect(after.retry).toEqual({ active: false, attempt: 0 })
    expect(after.lastSeq).toBe(before.lastSeq - 1)
  })

  it('把水位推进到当前快照序号', () => {
    const before = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'message_start',
        message: assistant([{ type: 'text', text: 'live' }]),
      }),
    )
    const after = apply(
      { ...before, loadState: 'loading' },
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'idle' },
          messages: [user('snapshot')],
          seq: before.lastSeq + 3,
        },
      }),
    )

    expect(after.messages).toEqual([user('snapshot')])
    expect(after.runStatus).toBe('idle')
    expect(after.loadState).toBe('loaded')
    expect(after.lastSeq).toBe(before.lastSeq + 3)
  })

  it('快照落后一个事件时保留原水位', () => {
    const before = apply(createHarnessThreadState('t1'), ev({ type: 'agent_start' }))
    const event = {
      type: 'snapshot',
      threadId: 't1',
      seq: before.lastSeq + 1,
      snapshot: {
        metadata: { id: 't1', status: 'idle' },
        messages: [user('snapshot')],
        seq: before.lastSeq,
      },
    } as HarnessClientEvent

    const after = reduceHarnessThreadState(before, event)

    expect(after.messages).toEqual([user('snapshot')])
    expect(after.lastSeq).toBe(event.seq)
  })

  it('从当前快照恢复重试次数', () => {
    const before = apply(createHarnessThreadState('t1'), ev({ type: 'agent_start' }))
    const after = apply(
      before,
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: {
            id: 't1',
            status: 'running',
            compactionActive: false,
            retryActive: true,
            retryAttempt: 3,
          },
          seq: before.lastSeq + 1,
          messages: [],
        },
      }),
    )
    expect(after.retry).toEqual({ active: true, attempt: 3 })
  })

  it('agent_end 携带 willRetry 时保持 running', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'agent_start' }),
      ev({ type: 'agent_end', willRetry: true }),
    )
    expect(s.runStatus).toBe('running')
    s = apply(s, ev({ type: 'agent_end', willRetry: false }))
    expect(s.runStatus).toBe('idle')
  })

  it('记录错误并标记 failed', () => {
    const s = apply(createHarnessThreadState('t1'), ev({ type: 'error', error: 'boom' }))
    expect(s.lastError).toBe('boom')
    expect(s.runStatus).toBe('failed')
    expect(s.metadata.status).toBe('failed')
  })

  it('由 thinking_level_changed 更新元数据配置', () => {
    const s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'thinking_level_changed', level: 'high' }),
    )
    expect(s.metadata.config?.thinkingLevel).toBe('high')
  })

  it('添加与解决 Host UI 请求', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({
        type: 'extension_ui_request',
        request: { id: 'r1', kind: 'confirm', title: 'Run?', message: 'ok?' },
      }),
    )
    expect(s.hostUiRequests).toHaveLength(1)
    // duplicate id is ignored
    s = apply(
      s,
      ev({
        type: 'extension_ui_request',
        request: { id: 'r1', kind: 'confirm', title: 'Run?', message: 'ok?' },
      }),
    )
    expect(s.hostUiRequests).toHaveLength(1)
    s = apply(s, ev({ type: 'extension_ui_resolved', requestId: 'r1' }))
    expect(s.hostUiRequests).toHaveLength(0)
  })

  it('按 seq 忽略过期的非快照事件，但始终应用快照', () => {
    const base = createHarnessThreadState('t1')
    const e1 = ev({ type: 'agent_start' }) // seq N
    let s = reduceHarnessThreadState(base, e1)
    const stale: HarnessClientEvent = {
      ...e1,
      type: 'queue_update',
      steering: ['old'],
      followUp: [],
    } as HarnessClientEvent
    // stale.seq === e1.seq <= lastSeq → ignored
    s = reduceHarnessThreadState(s, stale)
    expect(s.queue.steering).toHaveLength(0)

    // a snapshot with a low seq still applies
    const snapshot: HarnessThreadSnapshot = {
      metadata: { id: 't1', status: 'idle' },
      messages: [user('x')],
    }
    s = reduceHarnessThreadState(s, {
      type: 'snapshot',
      snapshot,
      threadId: 't1',
      seq: 0,
    })
    expect(s.messages).toHaveLength(1)
  })

  it('低于当前 seq 的错误事件仍被应用（带外错误）', () => {
    // A failed `subscribe` is reported at seq 0 — below any live seq. It must
    // still surface instead of being dropped by the dedup guard.
    let s = apply(createHarnessThreadState('t1'), ev({ type: 'agent_start' }))
    const lastSeq = s.lastSeq
    s = reduceHarnessThreadState(s, {
      type: 'error',
      error: 'unknown thread',
      threadId: 't1',
      seq: 0,
    })
    expect(s.lastError).toBe('unknown thread')
    expect(s.runStatus).toBe('failed')
    expect(s.lastSeq).toBe(lastSeq)
  })

  it('容忍未知事件类型', () => {
    const before = apply(createHarnessThreadState('t1'), ev({ type: 'agent_start' }))
    const after = reduceHarnessThreadState(before, {
      type: 'totally_new_event',
      threadId: 't1',
      seq: ++seq,
      payload: 42,
    } as unknown as HarnessClientEvent)
    expect(after.runStatus).toBe(before.runStatus)
    expect(after.lastSeq).toBeGreaterThan(before.lastSeq)
  })

  it('吸收 settled 与 appended 事件并推进序号', () => {
    const before = createHarnessThreadState('t1')
    const after = apply(
      before,
      ev({ type: 'agent_settled' }),
      ev({
        type: 'entry_appended',
        entry: {
          type: 'custom',
          id: 'entry-1',
          parentId: null,
          timestamp: '2026-07-18T00:00:00.000Z',
          customType: 'extension-state',
          data: { enabled: true },
        },
      }),
    )

    expect(after.lastSeq).toBeGreaterThan(before.lastSeq)
    expect(after.messages).toEqual(before.messages)
    expect(after.metadata).toEqual(before.metadata)
  })

  it('重连快照清空流式指针与工具缓冲', () => {
    let s = apply(
      createHarnessThreadState('t1'),
      ev({ type: 'message_start', message: assistant([]) }),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: {},
      }),
    )
    expect(s.streamingMessageIndex).toBe(0)
    expect(Object.keys(s.toolExecutions)).toHaveLength(1)

    const snapshot: HarnessThreadSnapshot = {
      metadata: { id: 't1', status: 'running' },
      messages: [assistant([{ type: 'text', text: 'done' }])],
    }
    s = apply(s, ev({ type: 'snapshot', snapshot }))
    expect(s.streamingMessageIndex).toBeUndefined()
    expect(Object.keys(s.toolExecutions)).toHaveLength(0)
    expect(s.runStatus).toBe('running')
  })
})
