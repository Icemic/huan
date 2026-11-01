import { describe, expect, it } from 'vitest'
import { mapSessionEvent } from './event-mapping.js'

/**
 * 事件映射测试（迭代③设计 §4-8 的「穷尽 + fixture」两层）。
 *
 * - 穷尽性由编译期保证（mapSessionEvent 的 never 兜底）：SDK 新增已知事件而未
 *   映射会导致 typecheck 失败；
 * - 此处用 fixture 固化每条已知事件的载荷字段（防止映射悄悄丢字段）。
 *
 * 注：SDK 的 AgentSessionEvent 类型在类型层面无法被本测试完整构造（消息形状极复杂），
 * 因此 fixture 以最小必要载荷断言「映射不丢字段」。
 */
describe('mapSessionEvent', () => {
  const ctx = { turnIndex: 2 }

  it('agent_start / agent_settled 映射为无载荷事件', () => {
    expect(mapSessionEvent({ type: 'agent_start' } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'agent_start' },
    })
    expect(mapSessionEvent({ type: 'agent_settled', aborted: false } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'agent_settled' },
    })
  })

  it('agent_end 保留 willRetry（重试语义字段）', () => {
    expect(
      mapSessionEvent({ type: 'agent_end', messages: [], willRetry: true } as never, ctx),
    ).toEqual({ kind: 'mapped', event: { type: 'agent_end', willRetry: true } })
  })

  it('turn_start / turn_end 附带宿主推导的 turnIndex', () => {
    expect(mapSessionEvent({ type: 'turn_start' } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'turn_start', turnIndex: 2 },
    })
    expect(
      mapSessionEvent({ type: 'turn_end', message: {}, toolResults: [] } as never, ctx),
    ).toEqual({ kind: 'mapped', event: { type: 'turn_end', turnIndex: 2 } })
  })

  it('message_start / message_update / message_end 传递消息与流式增量', () => {
    const message = { role: 'assistant', content: [] } as never
    const delta = { type: 'text_delta', contentIndex: 0, delta: 'hi' } as never

    expect(mapSessionEvent({ type: 'message_start', message } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'message_start', message },
    })
    expect(
      mapSessionEvent(
        { type: 'message_update', message, assistantMessageEvent: delta } as never,
        ctx,
      ),
    ).toEqual({
      kind: 'mapped',
      event: { type: 'message_update', message, assistantMessageEvent: delta },
    })
    expect(mapSessionEvent({ type: 'message_end', message } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'message_end', message },
    })
  })

  it('tool_execution_* 保留 toolCallId / 参数 / 结果 / 错误标记', () => {
    expect(
      mapSessionEvent(
        {
          type: 'tool_execution_start',
          toolCallId: 'c1',
          toolName: 'read',
          args: { path: 'a' },
        } as never,
        ctx,
      ),
    ).toEqual({
      kind: 'mapped',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: 'a' },
      },
    })

    expect(
      mapSessionEvent(
        {
          type: 'tool_execution_update',
          toolCallId: 'c1',
          toolName: 'read',
          args: {},
          partialResult: { content: 'partial' },
        } as never,
        ctx,
      ),
    ).toEqual({
      kind: 'mapped',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'c1',
        toolName: 'read',
        partialResult: { content: 'partial' },
      },
    })

    expect(
      mapSessionEvent(
        {
          type: 'tool_execution_end',
          toolCallId: 'c1',
          toolName: 'read',
          result: { content: 'done' },
          isError: false,
        } as never,
        ctx,
      ),
    ).toEqual({
      kind: 'mapped',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        result: { content: 'done' },
        isError: false,
      },
    })
  })

  it('queue_update 保留两队列表', () => {
    expect(
      mapSessionEvent(
        { type: 'queue_update', steering: ['s1'], followUp: ['f1', 'f2'] } as never,
        ctx,
      ),
    ).toEqual({
      kind: 'mapped',
      event: { type: 'queue_update', steering: ['s1'], followUp: ['f1', 'f2'] },
    })
  })

  it('compaction_* 保留原因与重试标记', () => {
    expect(
      mapSessionEvent({ type: 'compaction_start', reason: 'threshold' } as never, ctx),
    ).toEqual({
      kind: 'mapped',
      event: { type: 'compaction_start', reason: 'threshold' },
    })
    expect(
      mapSessionEvent(
        { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true } as never,
        ctx,
      ),
    ).toEqual({
      kind: 'mapped',
      event: { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true },
    })
  })

  it('entry_appended 透传会话记录（浏览器端依赖它触发刷新）', () => {
    const entry = {
      id: 'e1',
      parentId: null,
      timestamp: 't',
      type: 'custom',
      customType: 'x',
    } as never
    expect(mapSessionEvent({ type: 'entry_appended', entry } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'entry_appended', entry },
    })
  })

  it('session_info_changed 在无名时省略 name 字段', () => {
    expect(
      mapSessionEvent({ type: 'session_info_changed', name: undefined } as never, ctx),
    ).toEqual({
      kind: 'mapped',
      event: { type: 'session_info_changed' },
    })
    expect(mapSessionEvent({ type: 'session_info_changed', name: '标题' } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'session_info_changed', name: '标题' },
    })
  })

  it('thinking_level_changed 保留级别', () => {
    expect(
      mapSessionEvent({ type: 'thinking_level_changed', level: 'high' } as never, ctx),
    ).toEqual({
      kind: 'mapped',
      event: { type: 'thinking_level_changed', level: 'high' },
    })
  })

  it('auto_retry_start / auto_retry_end 保留尝试次数与结果', () => {
    expect(
      mapSessionEvent({ type: 'auto_retry_start', attempt: 2, delayMs: 1500 } as never, ctx),
    ).toEqual({ kind: 'mapped', event: { type: 'auto_retry_start', attempt: 2, delayMs: 1500 } })
    expect(mapSessionEvent({ type: 'auto_retry_end', success: true } as never, ctx)).toEqual({
      kind: 'mapped',
      event: { type: 'auto_retry_end', success: true },
    })
  })

  it('SDK 内部事件（摘要重试 / bash 流式）显式忽略，不视为遗漏', () => {
    expect(mapSessionEvent({ type: 'summarization_retry_scheduled' } as never, ctx)).toEqual({
      kind: 'ignored',
    })
    expect(mapSessionEvent({ type: 'summarization_retry_attempt_start' } as never, ctx)).toEqual({
      kind: 'ignored',
    })
    expect(mapSessionEvent({ type: 'summarization_retry_finished' } as never, ctx)).toEqual({
      kind: 'ignored',
    })
    expect(mapSessionEvent({ type: 'bash_execution_update' } as never, ctx)).toEqual({
      kind: 'ignored',
    })
  })
})
