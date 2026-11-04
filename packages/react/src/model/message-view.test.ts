import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessToolResultMessage,
  HarnessUserMessage,
} from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  type HarnessMessageProjectionInput,
  HarnessMessageViewProjector,
  projectHarnessMessages,
  shareHarnessMessageViews,
} from './message-view.js'
import type { HarnessToolExecutionState } from './thread-state.js'

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
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 1,
  ...overrides,
})

const user = (content: HarnessUserMessage['content']): HarnessUserMessage => ({
  role: 'user',
  content,
  timestamp: 0,
})

const toolResult = (
  toolCallId: string,
  content: HarnessToolResultMessage['content'],
  overrides: Partial<HarnessToolResultMessage> = {},
): HarnessToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content,
  isError: false,
  timestamp: 2,
  ...overrides,
})

const execution = (
  toolCallId: string,
  overrides: Partial<HarnessToolExecutionState> = {},
): HarnessToolExecutionState => ({
  toolCallId,
  status: 'running',
  ...overrides,
})

const input = (
  messages: HarnessAgentMessage[],
  overrides: Partial<HarnessMessageProjectionInput> = {},
): HarnessMessageProjectionInput => ({
  messages,
  toolExecutions: {},
  runStatus: 'idle',
  ...overrides,
})

describe('message-view（独立展示投影）', () => {
  it('用户文本与图片保留来源 entryId', () => {
    const views = projectHarnessMessages(
      input(
        [
          user([
            { type: 'text', text: '看图' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ]),
        ],
        {
          messageEntryIds: ['e1'],
        },
      ),
    )
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      id: 'pi-msg:0',
      role: 'user',
      sourceEntryId: 'e1',
      status: { type: 'complete', reason: 'stop' },
    })
    expect(views[0]?.parts).toEqual([
      { type: 'text', text: '看图', sourceEntryId: 'e1' },
      {
        type: 'image',
        data: 'data:image/png;base64,AAAA',
        mimeType: 'image/png',
        sourceEntryId: 'e1',
      },
    ])
  })

  it('助手 text/thinking 保留来源与模型元数据', () => {
    const views = projectHarnessMessages(
      input(
        [
          assistant(
            [
              { type: 'thinking', thinking: '推理' },
              { type: 'thinking', thinking: '', redacted: true },
              { type: 'text', text: '回答' },
            ],
            { stopReason: 'length' },
          ),
        ],
        { messageEntryIds: ['e2'] },
      ),
    )
    const view = views[0]
    expect(view).toMatchObject({
      role: 'assistant',
      sourceEntryId: 'e2',
      status: { type: 'incomplete', reason: 'length' },
      metadata: { provider: 'anthropic', model: 'claude', stopReason: 'length' },
    })
    expect(view?.parts).toEqual([
      { type: 'thinking', text: '推理', sourceEntryId: 'e2' },
      { type: 'thinking', text: '[reasoning redacted]', redacted: true, sourceEntryId: 'e2' },
      { type: 'text', text: '回答', sourceEntryId: 'e2' },
    ])
  })

  it('工具结果按 toolCallId 配对；运行时显示实时部分输出', () => {
    const call = {
      type: 'toolCall' as const,
      id: 'tc1',
      name: 'read',
      arguments: { path: '/workspace/a.txt' },
    }
    const live = projectHarnessMessages(
      input([assistant([call])], {
        messageEntryIds: ['e1'],
        runStatus: 'running',
        toolExecutions: {
          tc1: execution('tc1', {
            toolName: 'read',
            args: { path: '/workspace/a.txt' },
            partialResult: { content: [{ type: 'text', text: 'partial' }] },
          }),
        },
      }),
    )
    expect(live[0]?.parts[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'tc1',
      toolName: 'read',
      arguments: { path: '/workspace/a.txt' },
      status: 'running',
      output: 'partial',
      isPreliminary: true,
      sourceEntryId: 'e1',
    })

    const completed = projectHarnessMessages(
      input([assistant([call]), toolResult('tc1', [{ type: 'text', text: '完整结果' }])], {
        messageEntryIds: ['e1', 'e2'],
      }),
    )
    expect(completed[0]?.parts[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'tc1',
      status: 'complete',
      output: '完整结果',
      sourceEntryId: 'e1',
    })
    expect(completed[0]?.parts[0]).not.toHaveProperty('isPreliminary')
  })

  it('实时工具 details 透传；最终结果缺省时清除实时 details', () => {
    const call = {
      type: 'toolCall' as const,
      id: 'tc1',
      name: 'subagent',
      arguments: { agent: 'reviewer', task: '审查改动' },
    }
    const liveDetails = {
      kind: 'huan-subagent',
      mode: 'single',
      tasks: [{ taskId: 'task-1', status: 'running' }],
    }
    const live = projectHarnessMessages(
      input([assistant([call])], {
        runStatus: 'running',
        toolExecutions: {
          tc1: execution('tc1', {
            toolName: 'subagent',
            args: { agent: 'reviewer', task: '审查改动' },
            partialResult: {
              content: [{ type: 'text', text: 'subagent: 1 running' }],
              details: liveDetails,
            },
          }),
        },
      }),
    )
    expect(live[0]?.parts[0]).toMatchObject({
      type: 'tool',
      toolName: 'subagent',
      status: 'running',
      details: liveDetails,
    })

    // 最终 toolResult 缺省 details 时以最终结果为准，清除临时任务状态。
    const completed = projectHarnessMessages(
      input(
        [
          assistant([call]),
          toolResult('tc1', [{ type: 'text', text: '完成' }], { toolName: 'subagent' }),
        ],
        {
          toolExecutions: {
            tc1: execution('tc1', {
              toolName: 'subagent',
              partialResult: {
                content: [{ type: 'text', text: '完成' }],
                details: liveDetails,
              },
              status: 'complete',
            }),
          },
        },
      ),
    )
    expect(completed[0]?.parts[0]).toMatchObject({
      type: 'tool',
      status: 'complete',
      output: '完成',
    })
    expect(completed[0]?.parts[0]).not.toHaveProperty('details')
  })

  it('最终 details 覆盖实时值；非记录形状的 partialResult 不读取字段', () => {
    const call = { type: 'toolCall' as const, id: 'tc1', name: 'subagent', arguments: {} }
    const finalDetails = { kind: 'huan-subagent', mode: 'single', tasks: [] }
    const views = projectHarnessMessages(
      input(
        [
          assistant([call]),
          toolResult('tc1', [{ type: 'text', text: 'done' }], {
            toolName: 'subagent',
            details: finalDetails,
          }),
        ],
        {
          toolExecutions: {
            tc1: execution('tc1', {
              toolName: 'subagent',
              partialResult: { content: [], details: { stale: true } },
              status: 'complete',
            }),
          },
        },
      ),
    )
    expect(views[0]?.parts[0]).toMatchObject({ details: finalDetails })

    const primitive = projectHarnessMessages(
      input([assistant([call])], {
        toolExecutions: { tc1: execution('tc1', { toolName: 'subagent', partialResult: 'text' }) },
      }),
    )
    expect(primitive[0]?.parts[0]).not.toHaveProperty('details')
  })

  it('其他工具的实时 details 同样进入展示模型', () => {
    const views = projectHarnessMessages(
      input([assistant([{ type: 'toolCall', id: 'tc1', name: 'custom', arguments: {} }])], {
        toolExecutions: {
          tc1: execution('tc1', {
            toolName: 'custom',
            partialResult: { content: [], details: { progress: 1 } },
          }),
        },
      }),
    )
    expect(views[0]?.parts[0]).toMatchObject({ details: { progress: 1 } })
  })

  it('工具错误结果与图片输出按内容呈现', () => {
    const views = projectHarnessMessages(
      input(
        [
          assistant([{ type: 'toolCall', id: 'tc1', name: 'screenshot', arguments: {} }]),
          toolResult(
            'tc1',
            [
              { type: 'text', text: '失败前截图' },
              { type: 'image', data: 'iVBORw0KGgo', mimeType: 'image/png' },
            ],
            { isError: true, details: { code: 'tool-failed' } },
          ),
        ],
        { messageEntryIds: ['e1', 'e2'] },
      ),
    )
    expect(views[0]?.parts[0]).toMatchObject({
      type: 'tool',
      status: 'error',
      output: '失败前截图',
      details: { code: 'tool-failed' },
      outputImages: [
        {
          type: 'image',
          data: 'data:image/png;base64,iVBORw0KGgo',
          mimeType: 'image/png',
          sourceEntryId: 'e2',
        },
      ],
    })
  })

  it('嵌套工具保留 parentToolCallId；缺父项仍可读', () => {
    const views = projectHarnessMessages(
      input([assistant([{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: {} }])], {
        toolExecutions: {
          parent: execution('parent', { toolName: 'codemode', status: 'complete' }),
          child: execution('child', {
            toolName: 'read',
            parentToolCallId: 'parent',
            partialResult: { content: [{ type: 'text', text: '嵌套结果' }] },
            status: 'complete',
          }),
          orphan: execution('orphan', {
            toolName: 'bash',
            parentToolCallId: 'missing-parent',
            partialResult: { content: [{ type: 'text', text: '孤儿结果' }] },
            status: 'complete',
          }),
        },
      }),
    )
    const parts = views[0]?.parts ?? []
    expect(parts.find((part) => part.type === 'tool' && part.toolCallId === 'child')).toMatchObject(
      {
        parentToolCallId: 'parent',
        output: '嵌套结果',
      },
    )
    expect(
      parts.find((part) => part.type === 'tool' && part.toolCallId === 'orphan'),
    ).toMatchObject({
      toolName: 'bash',
      parentToolCallId: 'missing-parent',
      output: '孤儿结果',
    })
  })

  it('历史工具结果保留有界 nestedCalls 摘要', () => {
    const views = projectHarnessMessages(
      input([
        assistant([{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: {} }]),
        {
          role: 'toolResult',
          toolCallId: 'parent',
          toolName: 'codemode',
          content: [{ type: 'text', text: 'done' }],
          isError: false,
          timestamp: 2,
          nestedCalls: {
            calls: [{ id: 'parent/1', name: 'read', status: 'ok', durationMs: 4 }],
            complete: true,
          },
        },
      ]),
    )
    expect(
      views[0]?.parts.find((part) => part.type === 'tool' && part.toolCallId === 'parent'),
    ).toMatchObject({
      output: 'done',
      nestedCalls: {
        calls: [{ id: 'parent/1', name: 'read', status: 'ok', durationMs: 4 }],
        complete: true,
      },
    })
  })

  it('data 回退保留来源：bash、隐藏 custom、未知角色', () => {
    const bash = projectHarnessMessages(
      input(
        [
          {
            role: 'bashExecution',
            command: 'echo hi',
            output: 'hi\n',
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 3,
          },
        ],
        { messageEntryIds: ['e1'] },
      ),
    )
    expect(bash[0]).toMatchObject({
      sourceEntryId: 'e1',
      parts: [{ type: 'data', name: 'pi-bash-execution', sourceEntryId: 'e1' }],
    })

    const hidden = projectHarnessMessages(
      input(
        [
          {
            role: 'custom',
            customType: 'extension-state',
            content: 'hidden',
            display: false,
            timestamp: 4,
          },
        ],
        { messageEntryIds: ['e2'] },
      ),
    )
    expect(hidden).toEqual([])

    const system = projectHarnessMessages(
      input([{ role: 'system', content: '', sections: {}, timestamp: 6 }], {
        messageEntryIds: ['e-system'],
      }),
    )
    expect(system).toEqual([])

    const unknown = projectHarnessMessages(
      input([{ role: 'future-role', timestamp: 5, payload: 1 }], { messageEntryIds: ['e3'] }),
    )
    expect(unknown[0]?.parts[0]).toMatchObject({
      type: 'data',
      name: 'pi-unsupported-message',
      sourceEntryId: 'e3',
      data: { role: 'future-role' },
    })
  })

  it('历史 toolResult 缺少助手调用时仍按工具结果展示', () => {
    const views = projectHarnessMessages(
      input(
        [
          user('早先的问题'),
          toolResult(
            'orphan-result',
            [
              { type: 'text', text: '独立结果' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
            {
              toolName: 'screenshot',
              isError: true,
              nestedCalls: {
                calls: [{ id: 'n1', name: 'read', status: 'error', error: '失败' }],
                complete: false,
              },
            },
          ),
          user('之后的问题'),
        ],
        { messageEntryIds: ['e1', 'e2', 'e3'] },
      ),
    )
    expect(views.map((view) => view.role)).toEqual(['user', 'assistant', 'user'])
    expect(views[1]?.sourceEntryId).toBe('e2')
    expect(views[1]?.parts[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'orphan-result',
      toolName: 'screenshot',
      status: 'error',
      output: '独立结果',
      outputImages: [{ data: 'data:image/png;base64,AAAA' }],
      nestedCalls: { complete: false },
      sourceEntryId: 'e2',
    })
  })

  it('完全缺父项的多级子执行按根子树保序展示', () => {
    const views = projectHarnessMessages(
      input([assistant([{ type: 'text', text: '正文' }])], {
        toolExecutions: {
          root: execution('root', {
            toolName: 'codemode',
            parentToolCallId: 'missing',
            status: 'complete',
          }),
          child: execution('child', {
            toolName: 'read',
            parentToolCallId: 'root',
            status: 'complete',
          }),
          grandchild: execution('grandchild', {
            toolName: 'grep',
            parentToolCallId: 'child',
            status: 'error',
            partialResult: { content: [{ type: 'text', text: '未找到' }] },
          }),
        },
      }),
    )
    const tools = (views[0]?.parts ?? []).filter((part) => part.type === 'tool')
    expect(tools.map((part) => part.toolCallId)).toEqual(['root', 'child', 'grandchild'])
    expect(tools.map((part) => part.parentToolCallId)).toEqual(['missing', 'root', 'child'])
    expect(tools[2]).toMatchObject({ status: 'error', output: '未找到' })
  })

  it('增量投影不把前缀历史工具重复附到后缀末尾', () => {
    const projector = new HarnessMessageViewProjector()
    const oldCall = assistant([{ type: 'toolCall', id: 'old', name: 'read', arguments: {} }])
    const first = projector.project(
      input([oldCall, user('继续'), assistant([{ type: 'text', text: '第一段' }])], {
        toolExecutions: {
          old: execution('old', {
            toolName: 'read',
            status: 'complete',
            partialResult: { content: [{ type: 'text', text: '旧输出' }] },
          }),
        },
      }),
    )
    expect(
      first
        .flatMap((view) => view.parts)
        .filter((part) => part.type === 'tool' && part.toolCallId === 'old'),
    ).toHaveLength(1)

    const next = projector.project(
      input([oldCall, user('继续'), assistant([{ type: 'text', text: '第一段第二段' }])], {
        toolExecutions: {
          old: execution('old', {
            toolName: 'read',
            status: 'complete',
            partialResult: { content: [{ type: 'text', text: '旧输出' }] },
          }),
        },
      }),
    )
    const oldTools = next
      .flatMap((view) => view.parts)
      .filter((part) => part.type === 'tool' && part.toolCallId === 'old')
    expect(oldTools).toHaveLength(1)
    expect(oldTools[0]).toMatchObject({ output: '旧输出', status: 'complete' })
  })

  it('实时工具的部分输出同时保留文本、图片与运行标记', () => {
    const views = projectHarnessMessages(
      input([assistant([{ type: 'toolCall', id: 'tc1', name: 'screenshot', arguments: {} }])], {
        runStatus: 'running',
        toolExecutions: {
          tc1: execution('tc1', {
            toolName: 'screenshot',
            partialResult: {
              content: [
                { type: 'text', text: '正在生成' },
                { type: 'image', data: 'AAAA', mimeType: 'image/png' },
              ],
            },
          }),
        },
      }),
    )
    expect(views[0]?.parts[0]).toMatchObject({
      type: 'tool',
      status: 'running',
      output: '正在生成',
      isPreliminary: true,
      outputImages: [{ data: 'data:image/png;base64,AAAA' }],
    })
  })

  it('运行状态只影响尾部助手消息', () => {
    const messages = [user('hi'), assistant([{ type: 'text', text: 'working' }])]
    const running = projectHarnessMessages(input(messages, { runStatus: 'running' }))
    expect(running[1]?.status).toEqual({ type: 'running' })
    const idle = projectHarnessMessages(input(messages, { runStatus: 'idle' }))
    expect(idle[1]?.status).toEqual({ type: 'complete', reason: 'stop' })
  })
})

describe('HarnessMessageViewProjector（增量与引用共享）', () => {
  it('流式增量只重算尾部并复用未变消息引用', () => {
    const projector = new HarnessMessageViewProjector()
    const hello = user('hello')
    const first = projector.project(
      input([hello, assistant([{ type: 'text', text: 'hel' }])], { runStatus: 'running' }),
    )
    expect(first).toHaveLength(2)

    const updated = assistant([{ type: 'text', text: 'hello' }])
    const next = projector.project(input([hello, updated], { runStatus: 'running' }))
    expect(next[0]).toBe(first[0])
    expect(next[1]).not.toBe(first[1])
    expect(projector.getChangedViewIndex()).toBe(1)
    expect((next[1]?.parts[0] as { text: string } | undefined)?.text).toBe('hello')
  })

  it('仅entryId变化也更新来源，不能复用旧树定位', () => {
    const projector = new HarnessMessageViewProjector()
    const messages = [user('hello')]
    projector.project(input(messages, { messageEntryIds: [null] }))
    const next = projector.project(input(messages, { messageEntryIds: ['saved'] }))
    expect(next[0]?.sourceEntryId).toBe('saved')
    expect(next[0]?.parts[0]?.sourceEntryId).toBe('saved')
  })

  it('无变化时返回同一数组且不报告变更', () => {
    const projector = new HarnessMessageViewProjector()
    const value = input([user('hello')])
    const first = projector.project(value)
    const second = projector.project(value)
    expect(second).toBe(first)
    expect(projector.getChangedViewIndex()).toBeUndefined()
  })

  it('工具结果到达后在原工具部分补全输出', () => {
    const projector = new HarnessMessageViewProjector()
    const call = assistant([{ type: 'toolCall', id: 'tc1', name: 'read', arguments: {} }])
    const first = projector.project(input([call]))
    expect(first[0]?.parts[0]).toMatchObject({ type: 'tool', status: 'running' })

    const second = projector.project(
      input([call, toolResult('tc1', [{ type: 'text', text: 'done' }])]),
    )
    expect(second[0]?.parts[0]).toMatchObject({
      type: 'tool',
      status: 'complete',
      output: 'done',
    })
    expect(projector.getChangedViewIndex()).toBe(0)
  })

  it('共享函数在内容相同且长度一致时返回旧数组', () => {
    const projector = new HarnessMessageViewProjector()
    const views = projector.project(input([user('hello')]))
    expect(shareHarnessMessageViews(views, views)).toBe(views)
  })
})
