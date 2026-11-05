import type {
  HarnessAssistantMessage,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessThreadSnapshot,
  HarnessUserMessage,
} from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  createHarnessThreadReduction,
  type HarnessThreadReduction,
  isStaleHttpSnapshot,
  reduceHarnessThreadState,
  selectThreadQueue,
  selectThreadRunStatus,
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

const apply = (state: HarnessThreadReduction, ...events: HarnessClientEvent[]) =>
  events.reduce(reduceHarnessThreadState, state)

describe('thread-state（元数据与运行数据分离的纯归约）', () => {
  it('初始为空且处于 pending；运行数据不复制元数据字段', () => {
    const state = createHarnessThreadReduction('t1')
    expect(state.session.messages).toEqual([])
    expect(state.session.loadState).toBe('pending')
    expect(state.metadata.status).toBe('idle')
    expect(selectThreadRunStatus(state.metadata)).toBe('idle')
    expect(state.session).not.toHaveProperty('status')
    expect(state.session).not.toHaveProperty('queue')
    expect(state.session).not.toHaveProperty('contextUsage')
    expect(state.session).not.toHaveProperty('retry')
    expect(state.session.compaction).toBeUndefined()
  })

  it('整体应用快照并标记为 loaded', () => {
    const snapshot: HarnessThreadSnapshot = {
      metadata: { id: 't1', title: 'Hi', status: 'idle' },
      messages: [user('hello'), assistant([{ type: 'text', text: 'hi' }])],
    }
    const state = apply(createHarnessThreadReduction('t1'), ev({ type: 'snapshot', snapshot }))
    expect(state.session.messages).toHaveLength(2)
    expect(state.metadata.title).toBe('Hi')
    expect(state.session.loadState).toBe('loaded')
  })

  it('运行统计事件更新元数据，并以快照替换旧值', () => {
    const started = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'run_metrics', runMetrics: { status: 'running', outputTokens: 0 } }),
      ev({
        type: 'run_metrics',
        runMetrics: { status: 'completed', outputTokens: 42, durationMs: 1000 },
      }),
    )
    expect(started.metadata.runMetrics).toEqual({
      status: 'completed',
      outputTokens: 42,
      durationMs: 1000,
    })

    const replaced = apply(
      started,
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: {
            id: 't1',
            status: 'idle',
            runMetrics: { status: 'failed', outputTokens: 3, durationMs: 500, firstResponseMs: 80 },
          },
          messages: [],
        },
      }),
    )
    expect(replaced.metadata.runMetrics).toEqual({
      status: 'failed',
      outputTokens: 3,
      durationMs: 500,
      firstResponseMs: 80,
    })
  })

  it('快照携带扩展 UI 状态；缺失时清空', () => {
    const hostUi = {
      statuses: [{ key: 's', text: '值' }],
      widgets: [{ key: 'w', lines: ['行'], placement: 'belowEditor' as const }],
      notifications: [{ id: 'n1', message: '通知', type: 'info' as const, createdAt: 1 }],
      title: '扩展标题',
      editorDirective: {
        id: 'd1',
        text: '文本',
        mode: 'set' as const,
        callerId: 'window-a',
        createdAt: 1,
      },
    }
    const withState = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: { metadata: { id: 't1', status: 'idle' }, messages: [], hostUi },
      }),
    )
    expect(withState.session.hostUi).toEqual(hostUi)
    const cleared = apply(
      withState,
      ev({ type: 'snapshot', snapshot: { metadata: { id: 't1', status: 'idle' }, messages: [] } }),
    )
    expect(cleared.session.hostUi).toBeUndefined()
  })

  it('扩展状态增量不清空流式消息与工具运行态', () => {
    const message = assistant([{ type: 'text', text: '正在生成' }])
    const initial = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'agent_start' }),
      ev({ type: 'message_start', message }),
    )
    const next = apply(
      initial,
      ev({
        type: 'host_ui_update',
        hostUi: { statuses: [{ key: 's', text: '进行中' }], widgets: [], notifications: [] },
      }),
    )
    expect(next.session.messages).toBe(initial.session.messages)
    expect(next.session.streamingMessageIndex).toBe(initial.session.streamingMessageIndex)
    expect(next.session.toolExecutions).toBe(initial.session.toolExecutions)
    expect(selectThreadRunStatus(next.metadata)).toBe('running')
    expect(next.session.hostUi?.statuses[0]?.text).toBe('进行中')
  })

  it('改名事件同步显式名称，清空后回到首条消息标题', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'idle', title: '首条消息', firstMessageText: '首条消息' },
          messages: [],
        },
      }),
    )
    state = apply(state, ev({ type: 'session_info_changed', name: '已命名' }))
    expect(state.metadata.name).toBe('已命名')
    expect(state.metadata.title).toBe('已命名')
    state = apply(state, ev({ type: 'session_info_changed' }))
    expect(state.metadata.name).toBeUndefined()
    expect(state.metadata.title).toBe('首条消息')
  })

  it('流式助手消息：start → update → end（原地替换）', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'agent_start' }),
      ev({ type: 'message_start', message: assistant([]) }),
    )
    expect(selectThreadRunStatus(state.metadata)).toBe('running')
    expect(state.session.streamingMessageIndex).toBe(0)

    const partial = assistant([{ type: 'text', text: 'hel' }])
    state = apply(
      state,
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
    expect(state.session.messages).toHaveLength(1)
    expect((state.session.messages[0] as HarnessAssistantMessage).content).toEqual([
      { type: 'text', text: 'hel' },
    ])

    const final = assistant([{ type: 'text', text: 'hello' }])
    state = apply(state, ev({ type: 'message_end', message: final }))
    expect(state.session.messages).toHaveLength(1)
    expect(state.session.streamingMessageIndex).toBeUndefined()
    expect((state.session.messages[0] as HarnessAssistantMessage).content).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })

  it('运行中快照后直接收到完成消息时仍保留助手回复', () => {
    const previous = assistant([{ type: 'text', text: 'previous' }])
    const final = assistant([{ type: 'text', text: 'done' }], { timestamp: 2 })
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'running' },
          messages: [user('hello'), previous],
        },
      }),
      ev({ type: 'message_end', message: final }),
    )
    expect(state.session.messages).toEqual([user('hello'), previous, final])
    expect(state.session.streamingMessageIndex).toBeUndefined()
  })

  it('快照已含完成回复时，后续完成事件不会重复追加', () => {
    const final = assistant([{ type: 'text', text: 'done' }])
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'running' },
          messages: [user('hello'), final],
        },
      }),
      ev({ type: 'message_end', message: final }),
    )
    expect(state.session.messages).toEqual([user('hello'), final])
  })

  it('非助手完成事件不替换仍在流式中的助手消息', () => {
    const partial = assistant([{ type: 'text', text: 'partial' }])
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'message_start', message: partial }),
      ev({ type: 'message_end', message: user('other') }),
    )
    expect(state.session.messages).toEqual([partial])
    expect(state.session.streamingMessageIndex).toBe(0)
  })

  it('追加非助手消息且不占用流式指针', () => {
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'message_start', message: user('hello') }),
    )
    expect(state.session.messages).toHaveLength(1)
    expect(state.session.streamingMessageIndex).toBeUndefined()
  })

  it('按 toolCallId 跟踪工具执行生命周期', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    )
    expect(state.session.toolExecutions.tc1).toMatchObject({
      toolName: 'bash',
      status: 'running',
    })

    state = apply(
      state,
      ev({
        type: 'tool_execution_update',
        toolCallId: 'tc1',
        partialResult: { content: [{ type: 'text', text: 'file1\n' }] },
      }),
    )
    expect(state.session.toolExecutions.tc1?.partialResult).toEqual({
      content: [{ type: 'text', text: 'file1\n' }],
    })

    state = apply(
      state,
      ev({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        result: { content: [{ type: 'text', text: 'file1\nfile2\n' }] },
        isError: false,
      }),
    )
    expect(state.session.toolExecutions.tc1?.status).toBe('complete')
  })

  it('并行工具执行各自独立跟踪', () => {
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {} }),
      ev({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: {} }),
      ev({ type: 'tool_execution_end', toolCallId: 'b', result: {}, isError: false }),
    )
    expect(state.session.toolExecutions.a?.status).toBe('running')
    expect(state.session.toolExecutions.b?.status).toBe('complete')
  })

  it('快照省略 queuedMessages 时清空队列', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'queue_update', steering: ['s1'], followUp: ['f1'] }),
    )
    expect(selectThreadQueue(state.metadata)).toEqual({ steering: ['s1'], followUp: ['f1'] })
    state = apply(state, {
      type: 'snapshot',
      snapshot: { metadata: { id: 't1', status: 'idle' }, messages: [] },
      threadId: 't1',
      seq: 0,
    } as HarnessClientEvent)
    expect(selectThreadQueue(state.metadata)).toEqual({ steering: [], followUp: [] })
  })

  it('queue_update 只写元数据队列镜像并保留协议条目 ID', () => {
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'queue_update', steering: ['s1'], followUp: ['f1', 'f2'] }),
    )
    expect(state.metadata.queuedMessages).toEqual([
      { id: 'steer:0', mode: 'steer', content: 's1' },
      { id: 'followUp:0', mode: 'followUp', content: 'f1' },
      { id: 'followUp:1', mode: 'followUp', content: 'f2' },
    ])
    expect(selectThreadQueue(state.metadata)).toEqual({
      steering: ['s1'],
      followUp: ['f1', 'f2'],
    })
  })

  it('跟踪压缩与重试标志（只存元数据）', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'compaction_start', reason: 'threshold', operationId: 'op-1' }),
    )
    expect(state.metadata.compactionActive).toBe(true)
    expect(state.metadata.compactionReason).toBe('threshold')
    expect(state.session.compaction).toMatchObject({
      active: true,
      operationId: 'op-1',
      messageIndex: 0,
    })
    state = apply(
      state,
      ev({
        type: 'compaction_end',
        reason: 'threshold',
        aborted: false,
        willRetry: false,
        operationId: 'op-1',
      }),
    )
    expect(state.metadata.compactionActive).toBe(false)
    expect(state.metadata.compactionReason).toBeUndefined()
    expect(state.session.compaction).toMatchObject({
      active: false,
      operationId: 'op-1',
      status: 'compacted',
    })

    state = apply(state, ev({ type: 'auto_retry_start', attempt: 2, delayMs: 500 }))
    expect(state.metadata.retryActive).toBe(true)
    expect(state.metadata.retryAttempt).toBe(2)
    state = apply(state, ev({ type: 'auto_retry_end', success: true }))
    expect(state.metadata.retryActive).toBe(false)
    expect(state.metadata.retryAttempt).toBe(0)
  })

  it('完整快照清除省略的可选值与活动标志', () => {
    const before = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: {
            id: 't1',
            status: 'running',
            compactionActive: true,
            compactionReason: 'threshold',
            retryActive: true,
            retryAttempt: 2,
            contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
            queuedMessages: [{ id: 'steer:0', mode: 'steer', content: 's1' }],
          },
          messages: [],
          readiness: { state: 'missing-model', message: 'missing' },
          hostUi: { statuses: [], widgets: [], notifications: [], title: 'old' },
          bash: {
            id: 'bash:1',
            command: 'echo',
            excludeFromContext: false,
            cwd: '/workspace',
            status: 'running',
            output: '',
            outputTruncated: false,
            startedAt: '2026-08-18T00:00:00.000Z',
          },
          lastError: 'old error',
        },
      }),
    )
    const after = apply(
      before,
      ev({
        type: 'snapshot',
        snapshot: { metadata: { id: 't1', status: 'running' }, messages: [] },
      }),
    )
    expect(after.metadata.compactionActive).toBeUndefined()
    expect(after.metadata.compactionReason).toBeUndefined()
    expect(after.metadata.retryActive).toBeUndefined()
    expect(after.metadata.retryAttempt).toBeUndefined()
    expect(after.metadata.contextUsage).toBeUndefined()
    expect(after.metadata.queuedMessages).toBeUndefined()
    expect(after.session.readiness).toBeUndefined()
    expect(after.session.hostUi).toBeUndefined()
    expect(after.session.bash).toBeUndefined()
    expect(after.session.lastError).toBeUndefined()
    expect(selectThreadQueue(after.metadata)).toEqual({ steering: [], followUp: [] })
  })

  it('完整快照恢复活动工具；下一次无工具快照清除旧活动状态', () => {
    const running = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'running' },
          messages: [],
          toolExecutions: [
            {
              toolCallId: 'child',
              toolName: 'read',
              args: { path: 'a' },
              partialResult: { content: [{ type: 'text', text: 'partial' }] },
              status: 'running',
              parentToolCallId: 'parent',
            },
          ],
        },
      }),
    )
    expect(running.session.toolExecutions.child).toMatchObject({
      toolName: 'read',
      status: 'running',
      parentToolCallId: 'parent',
    })
    const settled = apply(
      running,
      ev({
        type: 'snapshot',
        snapshot: { metadata: { id: 't1', status: 'idle' }, messages: [] },
      }),
    )
    expect(settled.session.toolExecutions).toEqual({})
  })

  it('流快照重置序号时重设实时状态基线', () => {
    const before = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'compaction_start', reason: 'threshold' }),
      ev({ type: 'auto_retry_start', attempt: 2, delayMs: 500 }),
    )
    const after = reduceHarnessThreadState(before, {
      type: 'snapshot',
      threadId: 't1',
      seq: before.session.lastSeq - 1,
      snapshot: {
        metadata: {
          id: 't1',
          status: 'running',
          compactionActive: false,
          retryActive: false,
        },
        seq: before.session.lastSeq - 1,
        messages: [],
      },
    } as HarnessClientEvent)
    expect(after.metadata.compactionActive).toBe(false)
    expect(after.metadata.retryActive).toBe(false)
    expect(after.session.lastSeq).toBe(before.session.lastSeq - 1)
  })

  it('把水位推进到当前快照序号', () => {
    const before = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'message_start', message: assistant([{ type: 'text', text: 'live' }]) }),
    )
    const after = apply(
      { ...before, session: { ...before.session, loadState: 'loading' } },
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'idle' },
          messages: [user('snapshot')],
          seq: before.session.lastSeq + 3,
        },
      }),
    )
    expect(after.session.messages).toEqual([user('snapshot')])
    expect(selectThreadRunStatus(after.metadata)).toBe('idle')
    expect(after.session.loadState).toBe('loaded')
    expect(after.session.lastSeq).toBe(before.session.lastSeq + 3)
  })

  it('快照落后一个事件时保留原水位', () => {
    const before = apply(createHarnessThreadReduction('t1'), ev({ type: 'agent_start' }))
    const event = {
      type: 'snapshot',
      threadId: 't1',
      seq: before.session.lastSeq + 1,
      snapshot: {
        metadata: { id: 't1', status: 'idle' },
        messages: [user('snapshot')],
        seq: before.session.lastSeq,
      },
    } as HarnessClientEvent
    const after = reduceHarnessThreadState(before, event)
    expect(after.session.messages).toEqual([user('snapshot')])
    expect(after.session.lastSeq).toBe(event.seq)
  })

  it('从当前快照恢复重试次数', () => {
    const before = apply(createHarnessThreadReduction('t1'), ev({ type: 'agent_start' }))
    const after = apply(
      before,
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'running', retryActive: true, retryAttempt: 3 },
          seq: before.session.lastSeq + 1,
          messages: [],
        },
      }),
    )
    expect(after.metadata.retryActive).toBe(true)
    expect(after.metadata.retryAttempt).toBe(3)
  })

  it('agent_end 不提前空闲；agent_settled 才结算', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'agent_start' }),
      ev({ type: 'agent_end', willRetry: false }),
    )
    // agent_end 后仍可能重试、压缩或继续，界面保持运行。
    expect(selectThreadRunStatus(state.metadata)).toBe('running')
    state = apply(state, ev({ type: 'agent_settled' }))
    expect(selectThreadRunStatus(state.metadata)).toBe('idle')
  })

  it('另一提交未启动即取消时保留当前运行', () => {
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'agent_start' }),
      ev({ type: 'agent_end', cancelledBeforeStart: true }),
    )
    expect(selectThreadRunStatus(state.metadata)).toBe('running')
  })

  it('记录错误并标记 failed；settled 不把失败改回空闲', () => {
    let state = apply(createHarnessThreadReduction('t1'), ev({ type: 'error', error: 'boom' }))
    expect(state.session.lastError).toBe('boom')
    expect(selectThreadRunStatus(state.metadata)).toBe('failed')
    state = apply(state, ev({ type: 'agent_settled' }))
    expect(selectThreadRunStatus(state.metadata)).toBe('failed')
  })

  it('由 thinking_level_changed 更新元数据配置', () => {
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'thinking_level_changed', level: 'high' }),
    )
    expect(state.metadata.config?.thinkingLevel).toBe('high')
  })

  it('添加与解决 Host UI 请求；editor 保留 prefill', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'extension_ui_request',
        request: {
          id: 'r1',
          kind: 'editor',
          title: '编辑',
          prefill: '原始文本',
          toolCallId: 'tc1',
        },
      }),
    )
    expect(state.session.hostUiRequests).toHaveLength(1)
    expect(state.session.hostUiRequests[0]).toMatchObject({
      id: 'r1',
      kind: 'editor',
      prefill: '原始文本',
      toolCallId: 'tc1',
    })
    // duplicate id is ignored
    state = apply(
      state,
      ev({
        type: 'extension_ui_request',
        request: { id: 'r1', kind: 'confirm', title: 'Run?', message: 'ok?' },
      }),
    )
    expect(state.session.hostUiRequests).toHaveLength(1)
    state = apply(state, ev({ type: 'extension_ui_resolved', requestId: 'r1' }))
    expect(state.session.hostUiRequests).toHaveLength(0)
  })

  it('按 seq 忽略过期的非快照事件，但始终应用快照', () => {
    const base = createHarnessThreadReduction('t1')
    const first = ev({ type: 'agent_start' })
    let state = reduceHarnessThreadState(base, first)
    const stale: HarnessClientEvent = {
      ...first,
      type: 'queue_update',
      steering: ['old'],
      followUp: [],
    } as HarnessClientEvent
    state = reduceHarnessThreadState(state, stale)
    expect(selectThreadQueue(state.metadata).steering).toHaveLength(0)

    const snapshot: HarnessThreadSnapshot = {
      metadata: { id: 't1', status: 'idle' },
      messages: [user('x')],
    }
    state = reduceHarnessThreadState(state, {
      type: 'snapshot',
      snapshot,
      threadId: 't1',
      seq: 0,
    })
    expect(state.session.messages).toHaveLength(1)
  })

  it('低于当前 seq 的错误事件仍被应用（带外错误）', () => {
    let state = apply(createHarnessThreadReduction('t1'), ev({ type: 'agent_start' }))
    const lastSeq = state.session.lastSeq
    state = reduceHarnessThreadState(state, {
      type: 'error',
      error: 'unknown thread',
      threadId: 't1',
      seq: 0,
    })
    expect(state.session.lastError).toBe('unknown thread')
    expect(selectThreadRunStatus(state.metadata)).toBe('failed')
    expect(state.session.lastSeq).toBe(lastSeq)
  })

  it('容忍未知事件类型', () => {
    const before = apply(createHarnessThreadReduction('t1'), ev({ type: 'agent_start' }))
    const after = reduceHarnessThreadState(before, {
      type: 'totally_new_event',
      threadId: 't1',
      seq: ++seq,
      payload: 42,
    } as unknown as HarnessClientEvent)
    expect(after.metadata).toBe(before.metadata)
    expect(after.session.lastSeq).toBeGreaterThan(before.session.lastSeq)
  })

  it('吸收 settled 与 appended 事件并推进序号', () => {
    const before = createHarnessThreadReduction('t1')
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
    expect(after.session.lastSeq).toBeGreaterThan(before.session.lastSeq)
    expect(after.session.messages).toEqual(before.session.messages)
  })

  it('重连快照清空流式指针与工具缓冲', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'message_start', message: assistant([]) }),
      ev({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: {} }),
    )
    expect(state.session.streamingMessageIndex).toBe(0)
    expect(Object.keys(state.session.toolExecutions)).toHaveLength(1)

    const snapshot: HarnessThreadSnapshot = {
      metadata: { id: 't1', status: 'running' },
      messages: [assistant([{ type: 'text', text: 'done' }])],
    }
    state = apply(state, ev({ type: 'snapshot', snapshot }))
    expect(state.session.streamingMessageIndex).toBeUndefined()
    expect(Object.keys(state.session.toolExecutions)).toHaveLength(0)
    expect(selectThreadRunStatus(state.metadata)).toBe('running')
  })
})

describe('用户 Shell 与压缩运行态', () => {
  const bashRun = {
    id: 'bash:1',
    command: 'echo hi',
    excludeFromContext: false,
    cwd: '/workspace',
    status: 'running' as const,
    output: '',
    outputTruncated: false,
    startedAt: '2026-08-18T00:00:00.000Z',
  }

  it('bash 事件追加、截断前缀与应用完成态', () => {
    let state = apply(createHarnessThreadReduction('t1'), ev({ type: 'bash_start', run: bashRun }))
    expect(state.session.bash).toEqual(bashRun)

    state = apply(state, ev({ type: 'bash_output', id: 'bash:1', delta: 'hello ', dropped: 0 }))
    state = apply(state, ev({ type: 'bash_output', id: 'bash:1', delta: 'world', dropped: 2 }))
    expect(state.session.bash?.output).toBe('llo world')
    expect(state.session.bash?.outputTruncated).toBe(true)

    state = apply(state, ev({ type: 'bash_output', id: 'bash:2', delta: 'x', dropped: 0 }))
    expect(state.session.bash?.output).toBe('llo world')

    const complete = {
      ...bashRun,
      status: 'complete' as const,
      output: 'llo world\n',
      result: {
        exitCode: 0,
        cancelled: false,
        truncated: false,
        endedAt: '2026-08-18T00:00:01.000Z',
      },
    }
    state = apply(state, ev({ type: 'bash_end', run: complete }))
    expect(state.session.bash).toEqual(complete)

    // 权威快照缺少 bash 即清除（持久化后不再重复展示）。
    state = apply(
      state,
      ev({ type: 'snapshot', snapshot: { metadata: { id: 't1', status: 'idle' }, messages: [] } }),
    )
    expect(state.session.bash).toBeUndefined()
  })

  it('快照携带的 Shell 运行态与压缩错误可见', () => {
    const state = apply(
      createHarnessThreadReduction('t1'),
      ev({
        type: 'snapshot',
        snapshot: {
          metadata: { id: 't1', status: 'idle', autoCompactionEnabled: false },
          messages: [],
          bash: bashRun,
          compaction: { active: false, error: 'Compaction failed: x' },
        },
      }),
    )
    expect(state.session.bash).toEqual(bashRun)
    expect(state.session.compaction).toEqual({ active: false, error: 'Compaction failed: x' })
    expect(state.metadata.autoCompactionEnabled).toBe(false)
  })

  it('压缩结束保留失败原因；取消与成功清除错误', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'compaction_start', reason: 'manual' }),
    )
    state = apply(
      state,
      ev({
        type: 'compaction_end',
        reason: 'manual',
        aborted: false,
        willRetry: false,
        errorMessage: 'Compaction failed: 合成失败',
      }),
    )
    expect(state.session.compaction).toMatchObject({
      active: false,
      status: 'failed',
      error: 'Compaction failed: 合成失败',
    })

    state = apply(state, ev({ type: 'compaction_start', reason: 'manual' }))
    state = apply(
      state,
      ev({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false }),
    )
    expect(state.session.compaction).toMatchObject({ active: false, status: 'cancelled' })

    state = apply(state, ev({ type: 'compaction_start', reason: 'manual' }))
    state = apply(
      state,
      ev({
        type: 'compaction_end',
        reason: 'manual',
        aborted: false,
        willRetry: false,
        tokensBefore: 100,
        estimatedTokensAfter: 20,
      }),
    )
    expect(state.session.compaction).toMatchObject({
      active: false,
      status: 'compacted',
      tokensBefore: 100,
      estimatedTokensAfter: 20,
    })
  })
})

describe('资源重载、嵌套工具与 HTTP 快照水位', () => {
  const operation = {
    id: 't1:reload:1',
    trigger: 'settings' as const,
    status: 'running' as const,
    threadId: 't1',
    workspacePath: '/workspace',
    startedAt: '2026-11-01T00:00:00.000Z',
    fromResourceRevision: 0,
    resourceRevision: 0,
  }

  it('reload_start/reload_end 更新元数据与资源版本', () => {
    let state = apply(createHarnessThreadReduction('t1'), ev({ type: 'reload_start', operation }))
    expect(state.metadata.reload).toEqual(operation)
    expect(state.metadata.resourceRevision).toBeUndefined()

    const finished = {
      ...operation,
      status: 'succeeded' as const,
      finishedAt: '2026-11-01T00:00:01.000Z',
      resourceRevision: 1,
    }
    state = apply(state, ev({ type: 'reload_end', operation: finished, resourceRevision: 1 }))
    expect(state.metadata.reload).toEqual(finished)
    expect(state.metadata.resourceRevision).toBe(1)

    state = apply(
      state,
      ev({
        type: 'reload_end',
        operation: { ...finished, status: 'failed', message: '信任被拒绝' },
        resourceRevision: 1,
      }),
    )
    expect(state.metadata.reload?.status).toBe('failed')
    expect(state.metadata.reload?.message).toBe('信任被拒绝')
  })

  it('嵌套工具调用记录 parentToolCallId，普通调用不写该字段', () => {
    let state = apply(
      createHarnessThreadReduction('t1'),
      ev({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'codemode', args: {} }),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'call-1/1',
        toolName: 'read',
        args: { path: '/workspace/a.txt' },
        parentToolCallId: 'call-1',
      }),
    )
    expect(state.session.toolExecutions['call-1']?.parentToolCallId).toBeUndefined()
    expect(state.session.toolExecutions['call-1/1']?.parentToolCallId).toBe('call-1')

    state = apply(
      state,
      ev({
        type: 'tool_execution_end',
        toolCallId: 'call-1/1',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
        parentToolCallId: 'call-1',
      }),
    )
    expect(state.session.toolExecutions['call-1/1']?.status).toBe('complete')
    expect(state.session.toolExecutions['call-1/1']?.parentToolCallId).toBe('call-1')
  })

  it('HTTP 冷读快照落后于实时事件时判定为过期', () => {
    const session = {
      ...createHarnessThreadReduction('t1').session,
      lastSeq: 5,
    }
    expect(
      isStaleHttpSnapshot(
        session,
        { metadata: { id: 't1', status: 'idle' }, messages: [], seq: 4 },
        5,
      ),
    ).toBe(false)
    expect(
      isStaleHttpSnapshot(
        session,
        { metadata: { id: 't1', status: 'idle' }, messages: [], seq: 4 },
        3,
      ),
    ).toBe(true)
    expect(
      isStaleHttpSnapshot(
        session,
        { metadata: { id: 't1', status: 'idle' }, messages: [], seq: 5 },
        3,
      ),
    ).toBe(false)
    expect(
      isStaleHttpSnapshot(session, { metadata: { id: 't1', status: 'idle' }, messages: [] }, 3),
    ).toBe(true)
    expect(
      isStaleHttpSnapshot(
        { ...session, lastSeq: 2 },
        { metadata: { id: 't1', status: 'idle' }, messages: [], seq: 5 },
        5,
      ),
    ).toBe(true)
  })
})
