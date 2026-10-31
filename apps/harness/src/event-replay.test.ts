import { createHarnessHost, type HarnessHost, mapSessionEvent } from '@huan/core'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from '@huan/core/testing'
import type { HarnessAnyClientEvent, HarnessClientEventBody } from '@huan/protocol'
import {
  createHarnessThreadState,
  type HarnessThreadState,
  reduceHarnessThreadState,
} from '@huan/react'
import { describe, expect, it } from 'vitest'

/**
 * 事件回放验证（迭代③设计 §4-8 的第三层，接在「穷尽 + fixture」之后）。
 *
 * 目标：映射结果经 **JSON 往返**（模拟 SSE 传输）后送入**真实消费方 reducer**
 * （自研的 `reduceHarnessThreadState`，apps/harness 当前实际使用的实现），
 * 断言最终状态与权威口径一致（消息、队列、运行状态、错误）。
 *
 * 与 fixture 层的分工：
 * - `@huan/core` 的 `event-mapping.test.ts` 断言「单条事件的映射不丢字段」；
 * - 本文件断言「一串事件经传输后，消费方能还原出正确状态」。
 *
 * 事件源分两类（fixture 据此构造）：
 * - **映射层**：SDK 会话事件经 `mapSessionEvent` 产出（`mapped(...)`）；
 * - **宿主直发**：宿主自行 emit 的事件/状态（快照、error、Host UI、取消标记），
 *   不经映射层（直接构造，与宿主 `emit()` 的形状一致）。
 *
 * 为什么用自研 reducer：它当前是 apps/harness 的真实消费路径
 * （`PiRuntimeProvider` → `useHarnessRuntime`）；本文件因此同时覆盖了
 * 协议 → 传输 → 消费方的完整链路。
 *
 * 注：reducer 依赖事件信封（`threadId` + `seq`）做去重与排序，因此下面统一用
 * `envelope()` 补齐；`seq <= lastSeq` 的事件会被丢弃（这是刻意的幂等设计）。
 */
const THREAD_ID = 'thread-replay'

/** 给事件体补上传输信封（threadId + 递增 seq），并可指定显式 seq。 */
function envelope(body: HarnessClientEventBody, seq: number): HarnessAnyClientEvent {
  return { ...body, threadId: THREAD_ID, seq } as HarnessAnyClientEvent
}

/**
 * 把事件序列经 JSON 往返（模拟真实传输）后送入 reducer。
 *
 * 类型桥接：协议侧允许「未知事件兜底」（`HarnessAnyClientEvent` 的开放变体），
 * 而 reducer 的入参是窄联合（`HarnessClientEvent`）。reducer 的 default 分支会对
 * 未知类型只记 seq 并忽略——这正是两侧约定的前向兼容行为，因此此处断言安全。
 */
function replay(events: readonly HarnessAnyClientEvent[]): HarnessThreadState {
  const transported = JSON.parse(JSON.stringify(events)) as HarnessAnyClientEvent[]
  let state = createHarnessThreadState(THREAD_ID)
  for (const event of transported) {
    state = reduceHarnessThreadState(state, event as Parameters<typeof reduceHarnessThreadState>[1])
  }
  return state
}

/** 把 SDK 会话事件映射为协议事件体（经映射层，覆盖真实链路）。 */
function mapped(event: unknown, turnIndex = 0): HarnessClientEventBody {
  const result = mapSessionEvent(event as never, { turnIndex })
  if (result.kind !== 'mapped') throw new Error(`事件未映射：${String(event)}`)
  return result.event
}

/** 构造最小助手消息（回放只关心角色与内容，字段按协议必填项补齐）。 */
function assistantMessage(text: string, stopReason = 'stop') {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1_700_000_000_000,
  }
}

/** 构造最小用户消息。 */
function userMessage(text: string) {
  return {
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    timestamp: 1_700_000_000_000,
  }
}

/** 构造最小快照（metadata 只需 reducer 消费的字段）。 */
function snapshot(messages: readonly unknown[], metadata: Record<string, unknown> = {}) {
  return {
    metadata: { id: THREAD_ID, status: 'idle', ...metadata },
    messages: [...messages],
  } as never
}

describe('事件回放（映射 → JSON 往返 → 真实 reducer）', () => {
  it('快照基线 + 一轮完整运行 → 状态与权威口径一致', () => {
    // 事件序列模拟真实一轮：快照（含历史）→ 运行 → 用户/助手消息流 → 结束。
    const events = [
      envelope({ type: 'snapshot', snapshot: snapshot([userMessage('历史消息')]) }, 0),
      envelope(mapped({ type: 'agent_start' }), 1),
      envelope(mapped({ type: 'turn_start' }), 2),
      envelope(mapped({ type: 'message_start', message: userMessage('你好') }), 3),
      envelope(mapped({ type: 'message_end', message: userMessage('你好') }), 4),
      envelope(mapped({ type: 'message_start', message: assistantMessage('') }, 0), 5),
      // 流式增量：partial 逐次替换流式中的助手消息。
      envelope(
        mapped(
          { type: 'message_update', message: assistantMessage('你'), assistantMessageEvent: {} },
          0,
        ),
        6,
      ),
      envelope(
        mapped(
          { type: 'message_update', message: assistantMessage('你好'), assistantMessageEvent: {} },
          0,
        ),
        7,
      ),
      envelope(mapped({ type: 'message_end', message: assistantMessage('你好') }), 8),
      envelope(mapped({ type: 'turn_end' }), 9),
      envelope(mapped({ type: 'agent_end', messages: [], willRetry: false }), 10),
      envelope(mapped({ type: 'agent_settled', aborted: false }), 11),
    ]

    const state = replay(events)

    // 消息：历史 + 本轮用户 + 助手（顺序与条数）。
    expect(state.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
    expect(state.runStatus).toBe('idle')
    expect(state.metadata.status).toBe('idle')
    // 流式索引在 message_end 后清空。
    expect(state.streamingMessageIndex).toBeUndefined()
    // seq 水位线推进到最后一条事件。
    expect(state.lastSeq).toBe(11)
  })

  it('无快照的冷启动：事件流单独也能还原状态（SSE 重连缺失快照的兜底口径）', () => {
    // 真实场景：客户端错过首帧快照后重连，只收到增量事件。
    // 契约：reducer 不依赖事件顺序完整性（快照是权威，但缺席时增量仍应生效）。
    const events = [
      envelope(mapped({ type: 'agent_start' }), 1),
      envelope(mapped({ type: 'message_start', message: userMessage('只有增量') }), 2),
      envelope(mapped({ type: 'message_end', message: userMessage('只有增量') }), 3),
      envelope(mapped({ type: 'agent_end', messages: [], willRetry: false }), 4),
    ]

    const state = replay(events)
    expect(state.messages.map((message) => message.role)).toEqual(['user'])
    expect(state.runStatus).toBe('idle')
  })

  it('运行中状态：agent_start 置 running，agent_end 回落 idle', () => {
    const running = replay([envelope(mapped({ type: 'agent_start' }), 1)])
    expect(running.runStatus).toBe('running')
    expect(running.metadata.status).toBe('running')

    const settled = replay([
      envelope(mapped({ type: 'agent_start' }), 1),
      envelope(mapped({ type: 'agent_end', messages: [], willRetry: false }), 2),
    ])
    expect(settled.runStatus).toBe('idle')
  })

  it('agent_end(willRetry=true) 保持 running（重试语义不得误判为结束）', () => {
    // willRetry 是映射层刻意保留的字段；若丢失，UI 会在重试间隙闪烁为 idle。
    const state = replay([
      envelope(mapped({ type: 'agent_start' }), 1),
      envelope(mapped({ type: 'agent_end', messages: [], willRetry: true }), 2),
    ])
    expect(state.runStatus).toBe('running')
  })

  it('queue_update 还原队列文本（steer 与 followUp 分流）', () => {
    const state = replay([
      envelope(
        mapped({ type: 'queue_update', steering: ['插队'], followUp: ['排队一', '排队二'] }),
        1,
      ),
    ])
    expect(state.queue.steering).toEqual(['插队'])
    expect(state.queue.followUp).toEqual(['排队一', '排队二'])
  })

  it('压缩与重试的活动标记可还原（compaction / auto_retry）', () => {
    const compacting = replay([
      envelope(mapped({ type: 'compaction_start', reason: 'threshold' }), 1),
    ])
    expect(compacting.compaction).toEqual({ active: true, reason: 'threshold' })
    expect(compacting.metadata.compactionActive).toBe(true)

    const retrying = replay([
      envelope(mapped({ type: 'auto_retry_start', attempt: 2, delayMs: 1000 }), 1),
    ])
    expect(retrying.retry).toEqual({ active: true, attempt: 2 })
    expect(retrying.metadata.retryActive).toBe(true)
    expect(retrying.metadata.retryAttempt).toBe(2)
  })

  it('上下文用量与思考级别可还原', () => {
    const state = replay([
      // context_usage 由宿主经 deriveContextUsage 直发（不在映射层）。
      envelope(
        {
          type: 'context_usage',
          contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
        },
        1,
      ),
      envelope(mapped({ type: 'thinking_level_changed', level: 'high' }), 2),
    ])
    expect(state.contextUsage).toEqual({ tokens: 100, contextWindow: 1000, percent: 10 })
    expect(state.metadata.config?.thinkingLevel).toBe('high')
  })

  it('会话重命名可还原（含清空标题）', () => {
    const renamed = replay([
      envelope({ type: 'snapshot', snapshot: snapshot([], { status: 'idle' }) }, 0),
      envelope(mapped({ type: 'session_info_changed', name: '新标题' }), 1),
    ])
    expect(renamed.metadata.title).toBe('新标题')

    const cleared = replay([
      envelope(
        { type: 'snapshot', snapshot: snapshot([], { status: 'idle', title: '旧标题' }) },
        0,
      ),
      envelope(mapped({ type: 'session_info_changed' }), 1),
    ])
    expect(cleared.metadata.title).toBeUndefined()
  })

  it('error 事件置失败状态与错误文本（宿主直发）', () => {
    const state = replay([envelope({ type: 'error', error: '模型不可用' }, 1)])
    expect(state.lastError).toBe('模型不可用')
    expect(state.runStatus).toBe('failed')
    expect(state.metadata.status).toBe('failed')
  })

  it('error(terminal) 的传输字段不破坏回放（订阅终止标记）', () => {
    // terminal 由传输层置位（客户端主动结束流），reducer 只消费 error 文本。
    const state = replay([
      envelope({ type: 'error', error: '连接中断' }, 1),
      envelope({ type: 'error', error: '连接中断', terminal: true }, 2),
    ])
    expect(state.lastError).toBe('连接中断')
    expect(state.runStatus).toBe('failed')
  })

  it('agent_start 清除此前错误（新运行的失败状态不残留）', () => {
    const state = replay([
      envelope({ type: 'error', error: '上一轮失败' }, 1),
      envelope(mapped({ type: 'agent_start' }), 2),
    ])
    expect(state.lastError).toBeUndefined()
    expect(state.runStatus).toBe('running')
  })

  it('entry_appended 不改变可视化状态但推进 seq（行为字段不丢）', () => {
    const state = replay([
      envelope({ type: 'snapshot', snapshot: snapshot([]) }, 0),
      envelope(
        mapped({
          type: 'entry_appended',
          entry: { type: 'session_info', id: 'e1', name: 'x' },
        }),
        1,
      ),
    ])
    expect(state.lastSeq).toBe(1)
    expect(state.messages).toEqual([])
  })

  it('cancelledBeforeStart 不引入额外状态变化（取消不产生失败）', () => {
    // 宿主在「未启动即取消」时直发此事件；消费方不得因此进入 failed。
    const state = replay([
      envelope({ type: 'agent_start' }, 1),
      envelope({ type: 'agent_end', cancelledBeforeStart: true }, 2),
    ])
    expect(state.runStatus).toBe('idle')
    expect(state.lastError).toBeUndefined()
  })

  it('未知事件类型被忽略但推进 seq（前向兼容）', () => {
    const state = replay([
      envelope({ type: 'snapshot', snapshot: snapshot([]) }, 0),
      envelope({ type: 'future_event_kind', payload: { anything: true } } as never, 1),
    ])
    expect(state.lastSeq).toBe(1)
    expect(state.messages).toEqual([])
  })

  it('seq 水位线：旧事件被丢弃（去重与乱序防护）', () => {
    const state = replay([
      envelope({ type: 'snapshot', snapshot: snapshot([]) }, 5),
      // seq 落后的事件不得生效（重连重复投递的真实场景）。
      envelope(mapped({ type: 'message_start', message: userMessage('重复') }), 3),
      envelope(mapped({ type: 'message_start', message: userMessage('有效') }), 6),
    ])
    expect(state.messages.map((message) => message.role)).toEqual(['user'])
    expect(state.lastSeq).toBe(6)
  })

  it('快照可降低 seq（宿主重启后的序号重置，权威性优先）', () => {
    const state = replay([
      envelope(mapped({ type: 'message_start', message: userMessage('上一代') }), 10),
      // 宿主重启：新序列从 0 开始，快照必须被接受（否则状态永久错乱）。
      envelope({ type: 'snapshot', snapshot: snapshot([], { status: 'idle' }) }, 0),
      envelope(mapped({ type: 'message_start', message: userMessage('新序列') }), 1),
    ])
    expect(state.messages.map((message) => message.role)).toEqual(['user'])
    expect(state.lastSeq).toBe(1)
  })

  it('Host UI 请求可订阅与结算（宿主直发，approval 面）', () => {
    const request = {
      id: 'ui-1',
      kind: 'confirm' as const,
      title: '允许？',
      message: '需要确认',
    }
    const pending = replay([envelope({ type: 'extension_ui_request', request }, 1)])
    expect(pending.hostUiRequests).toHaveLength(1)
    expect(pending.hostUiRequests[0]?.id).toBe('ui-1')

    const resolved = replay([
      envelope({ type: 'extension_ui_request', request }, 1),
      envelope({ type: 'extension_ui_resolved', requestId: 'ui-1' }, 2),
    ])
    expect(resolved.hostUiRequests).toHaveLength(0)
  })

  it('快照携带 lastError 与 readiness（重连恢复口径）', () => {
    const state = replay([
      envelope(
        {
          type: 'snapshot',
          snapshot: {
            metadata: { id: THREAD_ID, status: 'failed' },
            messages: [],
            lastError: '上一轮崩溃',
            readiness: {
              state: 'ready',
              selection: { provider: 'test', modelId: 'test-model' },
              source: 'session',
            },
          } as never,
        },
        0,
      ),
    ])
    expect(state.lastError).toBe('上一轮崩溃')
    expect(state.runStatus).toBe('failed')
    expect(state.readiness?.state).toBe('ready')
  })
})

describe('事件回放（真实宿主事件流 vs 权威快照）', () => {
  /**
   * 集成层：用真实宿主跑一轮运行，把**真实事件流**（JSON 往返）送入 reducer，
   * 断言回放终态与宿主 `getThread()` 的权威快照一致。
   *
   * 这覆盖了 fixture 层无法保证的东西：映射层 + 宿主 emit 的真实组合顺序
   * （快照 → 运行 → 消息流 → 结算）确实能被消费方还原。
   *
   * 环境要求：隔离的临时用户空间（合成 provider + 临时会话目录），
   * 不读写个人 Pi 配置；fetch 使用确定性桩。
   */
  it('一轮真实运行：回放终态与权威快照一致（消息/状态/seq）', async () => {
    // 清除继承的 Pi 环境变量：它们会让合成空间解析出无关的默认模型/目录。
    const testedKeys = [
      'PI_PROVIDER',
      'PI_MODEL_ID',
      'PI_CODING_AGENT_DIR',
      'PI_CODING_AGENT_SESSION_DIR',
    ] as const
    const savedEnv = new Map<string, string | undefined>()
    let env: IsolatedPiEnv | undefined
    let isolated: HarnessHost | undefined
    let fetchStub: TestFetchStub | undefined

    try {
      for (const key of testedKeys) {
        savedEnv.set(key, process.env[key])
        delete process.env[key]
      }
      env = await createIsolatedPiEnv('huan-replay-test-')
      isolated = await createHarnessHost({
        workspacePath: env.workspace,
        agentDir: env.agentDir,
        refreshCatalogOnStart: false,
        resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
      })
      // 只应答合成 provider 端点：确定性单轮回复，其它地址一律记为意外请求。
      fetchStub = installTestFetch('你好')

      const created = await isolated.createThread()
      const id = created.metadata.id

      // 订阅读取真实事件流（含首帧快照）。
      const events: HarnessAnyClientEvent[] = []
      isolated.subscribe(id, (event) => events.push(event as HarnessAnyClientEvent))

      await isolated.sendMessage(id, { content: '你好' })

      // 等待条件明确：本轮必须真正跑完（有助手文本、状态回 idle）。
      // 超时直接失败——否则「扩展把输入 handled 掉」之类的情况会让两边
      // 都保持空状态而假通过。
      const deadline = Date.now() + 30_000
      let authoritative = await isolated.getThread(id)
      let completed = false
      while (Date.now() < deadline) {
        authoritative = await isolated.getThread(id)
        const hasAssistant = authoritative.messages.some((message) => message.role === 'assistant')
        if (hasAssistant && authoritative.metadata.status === 'idle') {
          completed = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(completed, '本轮运行未在超时内完成（无助手消息或状态未回 idle）').toBe(true)
      // 运行不得以失败收场（mock 成功响应下出现 error 说明链路有缺陷）。
      expect(authoritative.lastError).toBeUndefined()
      // 真实走了一次合成 provider，且没有任何非预期请求被吞掉。
      expect(fetchStub.calls()).toBeGreaterThan(0)
      expect(fetchStub.unexpected()).toEqual([])

      // 等结算事件落地（agent_settled 在 agent_end 之后，属同一轮的后继）。
      const settledDeadline = Date.now() + 5_000
      while (Date.now() < settledDeadline) {
        if (events.some((event) => event.type === 'agent_settled')) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(events.some((event) => event.type === 'agent_settled')).toBe(true)

      const replayed = replay(events)

      // 消息口径：角色序列与条数一致（system 由 SDK 注入，属预期）。
      expect(replayed.messages.map((message) => message.role)).toEqual(
        authoritative.messages.map((message) => message.role),
      )
      // 内容口径：JSON 归一化后完全一致（不只比角色——文本映射错误必须暴露）。
      expect(JSON.parse(JSON.stringify(replayed.messages))).toEqual(
        JSON.parse(JSON.stringify(authoritative.messages)),
      )
      // 本轮助手回复的文本确实被还原。
      const replayedAssistant = replayed.messages.find((message) => message.role === 'assistant')
      expect(JSON.stringify(replayedAssistant)).toContain('你好')
      // 运行状态一致。
      expect(replayed.runStatus).toBe('idle')
      expect(replayed.metadata.status).toBe(authoritative.metadata.status)
      // 模型配置与队列口径一致。
      expect(replayed.metadata.config).toEqual(authoritative.metadata.config)
      expect(replayed.queue).toEqual({ steering: [], followUp: [] })
      // seq 水位线：回放终态 == 最后一条事件的 seq == 权威快照的 seq。
      const lastSeq = events[events.length - 1]?.seq
      expect(replayed.lastSeq).toBe(lastSeq)
      expect(lastSeq).toBe(authoritative.seq)
      // 首帧快照必须是「订阅时点」的状态（不得被后续运行污染）。
      const firstEvent = events[0] as { type: string; snapshot?: unknown } | undefined
      expect(firstEvent?.type).toBe('snapshot')
      const snapshotMessages = (
        firstEvent?.snapshot as { messages?: ReadonlyArray<{ role: string }> } | undefined
      )?.messages
      // 明确断言字段存在（不用 ?? [] 把缺字段伪装成正确结果）。
      expect(Array.isArray(snapshotMessages)).toBe(true)
      // 订阅发生在发送之前：快照不应包含本轮的助手消息。
      expect((snapshotMessages ?? []).some((message) => message.role === 'assistant')).toBe(false)
    } finally {
      await isolated?.dispose()
      const unexpected = fetchStub?.unexpected() ?? []
      fetchStub?.restore()
      await env?.cleanup()
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      expect(unexpected, '测试发生非预期网络请求').toEqual([])
    }
  }, 60_000)

  it('流式中间态可还原（message_update 生效，不被 message_end 掩盖）', () => {
    // 只断言终态会掩盖流式回归：这里在 message_end 之前插入断言视图。
    const streamEvents = [
      envelope(mapped({ type: 'agent_start' }), 1),
      envelope(mapped({ type: 'message_start', message: assistantMessage('') }), 2),
      envelope(
        mapped({
          type: 'message_update',
          message: assistantMessage('第一段'),
          assistantMessageEvent: {},
        }),
        3,
      ),
      envelope(
        mapped({
          type: 'message_update',
          message: assistantMessage('第一段第二段'),
          assistantMessageEvent: {},
        }),
        4,
      ),
    ]

    // 中间态（尚未 message_end）：流式索引指向助手消息，内容为最后一次增量。
    const mid = replay(streamEvents)
    expect(mid.streamingMessageIndex).toBe(0)
    expect(JSON.stringify(mid.messages[0])).toContain('第一段第二段')

    // 终态：message_end 收敛，流式索引清空，内容为最终文本。
    const final = replay([
      ...streamEvents,
      envelope(mapped({ type: 'message_end', message: assistantMessage('第一段第二段') }), 5),
    ])
    expect(final.streamingMessageIndex).toBeUndefined()
    expect(JSON.stringify(final.messages[0])).toContain('第一段第二段')
  })

  it('工具执行生命周期可还原（start → update → end，含错误标记）', () => {
    const running = replay([
      envelope(
        mapped({
          type: 'tool_execution_start',
          toolCallId: 'c1',
          toolName: 'read',
          args: { path: 'a' },
        }),
        1,
      ),
    ])
    expect(running.toolExecutions.c1).toMatchObject({
      toolName: 'read',
      status: 'running',
    })

    const streaming = replay([
      envelope(
        mapped({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }),
        1,
      ),
      envelope(
        mapped({
          type: 'tool_execution_update',
          toolCallId: 'c1',
          partialResult: { content: '部分' },
        }),
        2,
      ),
    ])
    expect(streaming.toolExecutions.c1?.partialResult).toEqual({ content: '部分' })

    const failed = replay([
      envelope(
        mapped({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }),
        1,
      ),
      envelope(
        mapped({
          type: 'tool_execution_end',
          toolCallId: 'c1',
          result: { content: '错误输出' },
          isError: true,
        }),
        2,
      ),
    ])
    expect(failed.toolExecutions.c1).toMatchObject({ status: 'error' })

    const ok = replay([
      envelope(
        mapped({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'edit', args: {} }),
        1,
      ),
      envelope(
        mapped({
          type: 'tool_execution_end',
          toolCallId: 'c2',
          result: { content: '完成' },
          isError: false,
        }),
        2,
      ),
    ])
    expect(ok.toolExecutions.c2).toMatchObject({ status: 'complete' })
  })

  it('压缩与重试的结束分支清除活动标记', () => {
    const compactionDone = replay([
      envelope(mapped({ type: 'compaction_start', reason: 'overflow' }), 1),
      envelope(mapped({ type: 'compaction_end', aborted: false, willRetry: false }), 2),
    ])
    expect(compactionDone.compaction.active).toBe(false)
    expect(compactionDone.metadata.compactionActive).toBe(false)

    const retryDone = replay([
      envelope(mapped({ type: 'auto_retry_start', attempt: 1, delayMs: 100 }), 1),
      envelope(mapped({ type: 'auto_retry_end', success: true }), 2),
    ])
    expect(retryDone.retry).toEqual({ active: false, attempt: 0 })
    expect(retryDone.metadata.retryActive).toBe(false)
  })

  it('重连快照清空旧队列（队列恢复的权威口径）', () => {
    // 先进入排队状态，再收到权威快照（队列已空）——旧队列必须被清除。
    const state = replay([
      envelope(mapped({ type: 'queue_update', steering: ['旧排队'], followUp: [] }), 1),
      envelope({ type: 'snapshot', snapshot: snapshot([], { status: 'idle' }) }, 2),
    ])
    expect(state.queue).toEqual({ steering: [], followUp: [] })
  })
})
