import { harnessQueueItemId } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  deriveReadiness,
  extractMessageText,
  mapColdMetadata,
  mapQueuedMessages,
  mapSessionInfo,
  projectSessionRecord,
} from './metadata.js'

const baseInfo = {
  path: 'C:/sessions/2026-10-17T00-00-00-000Z_abc.jsonl',
  id: 'abc',
  cwd: 'C:/workspace',
  created: new Date('2026-10-17T00:00:00.000Z'),
  modified: new Date('2026-10-17T01:00:00.000Z'),
  messageCount: 3,
  firstMessage: '第一条消息内容',
}

describe('mapSessionInfo', () => {
  it('有名字时优先使用名字作为标题', () => {
    const metadata = mapSessionInfo({ ...baseInfo, name: '  我的会话  ' })
    expect(metadata.title).toBe('我的会话')
  })

  it('无名时用首条消息（截断 60 字符）', () => {
    const metadata = mapSessionInfo(baseInfo)
    expect(metadata.title).toBe('第一条消息内容')
  })

  it('无名且无首条消息时回退文件名', () => {
    const metadata = mapSessionInfo({ ...baseInfo, firstMessage: '' })
    expect(metadata.title).toBe('2026-10-17T00-00-00-000Z_abc.jsonl')
  })

  it('无 cwd 的旧会话不写入 workspacePath', () => {
    const metadata = mapSessionInfo({ ...baseInfo, cwd: '' })
    expect(metadata.workspacePath).toBeUndefined()
  })

  it('时间以 ISO 字符串输出（JSON-safe）', () => {
    const metadata = mapSessionInfo(baseInfo)
    expect(metadata.createdAt).toBe('2026-10-17T00:00:00.000Z')
    expect(metadata.updatedAt).toBe('2026-10-17T01:00:00.000Z')
  })

  it('live 状态覆盖目录默认值', () => {
    expect(mapSessionInfo(baseInfo).status).toBe('idle')
    expect(mapSessionInfo(baseInfo, { liveStatus: 'running' }).status).toBe('running')
  })
})

describe('deriveReadiness', () => {
  it('无模型时报告 missing-model', () => {
    const readiness = deriveReadiness({ model: undefined })
    expect(readiness.state).toBe('missing-model')
  })

  it('有模型时报告 ready 并附选择来源', () => {
    const readiness = deriveReadiness({
      model: { provider: 'my-provider', id: 'deepseek-v4.1-flash' },
      source: 'session',
    })
    expect(readiness).toEqual({
      state: 'ready',
      selection: { provider: 'my-provider', modelId: 'deepseek-v4.1-flash' },
      source: 'session',
    })
  })
})

describe('mapQueuedMessages', () => {
  it('产出 steer 与 follow-up 两类条目，ID 采用 "<mode>:<index>" 方案', () => {
    const queued = mapQueuedMessages(['转向'], ['追加1', '追加2'])
    expect(queued).toEqual([
      { id: harnessQueueItemId('steer', 0), mode: 'steer', content: '转向' },
      { id: harnessQueueItemId('followUp', 0), mode: 'followUp', content: '追加1' },
      { id: harnessQueueItemId('followUp', 1), mode: 'followUp', content: '追加2' },
    ])
  })

  it('空队列返回空数组', () => {
    expect(mapQueuedMessages([], [])).toEqual([])
  })
})

describe('extractMessageText（与 Pi extractTextContent 同口径）', () => {
  it('字符串内容原样返回（不 trim）', () => {
    expect(extractMessageText({ content: '  你好  ' })).toBe('  你好  ')
  })

  it('内容块数组只取 text 块，用空格拼接（不 trim、不过滤空白块）', () => {
    expect(
      extractMessageText({
        content: [
          { type: 'text', text: '甲 ' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
          { type: 'text', text: ' 乙' },
        ],
      }),
    ).toBe('甲   乙')
  })

  it('无非文本块或空数组返回 undefined', () => {
    expect(
      extractMessageText({ content: [{ type: 'image', data: 'x', mimeType: 'p' }] }),
    ).toBeUndefined()
    expect(extractMessageText({ content: [] })).toBeUndefined()
    expect(extractMessageText({})).toBeUndefined()
  })

  it('空字符串内容返回 undefined（交调用方回退）', () => {
    expect(extractMessageText({ content: '' })).toBeUndefined()
  })
})

describe('mapSessionInfo 标题占位值处理', () => {
  it('Pi 的 "(no messages)" 占位值不使用，回退文件名', () => {
    const metadata = mapSessionInfo({ ...baseInfo, firstMessage: '(no messages)' })
    expect(metadata.title).toBe('2026-10-17T00-00-00-000Z_abc.jsonl')
  })

  it('纯空白首条消息回退文件名', () => {
    const metadata = mapSessionInfo({ ...baseInfo, firstMessage: '   ' })
    expect(metadata.title).toBe('2026-10-17T00-00-00-000Z_abc.jsonl')
  })
})

describe('projectSessionRecord（Pi SessionInfo 时间语义）', () => {
  const header = {
    timestamp: '2026-10-17T00:00:00.000Z',
    parentSession: 'C:/sessions/parent.jsonl',
  }
  const message = (role: string, timestamp?: number) => ({
    role,
    content: [{ type: 'text', text: `${role} 内容` }],
    ...(timestamp !== undefined ? { timestamp } : {}),
  })
  const messageEntry = (timestamp: string, value: unknown) => ({
    type: 'message',
    timestamp,
    message: value,
  })

  it('创建时间取 header；活动时间取全文件 user/assistant 最大值（顺序无关）', () => {
    const projection = projectSessionRecord({
      header,
      entries: [
        messageEntry('2026-10-17T00:00:01.000Z', message('user', 1_600_000_000_100)),
        {
          type: 'session_info',
          timestamp: '2026-10-17T00:00:09.000Z',
        },
        messageEntry('2026-10-17T00:00:08.000Z', message('user', 1_600_000_000_900)),
        messageEntry('2026-10-17T00:00:03.000Z', message('assistant', 1_600_000_000_300)),
        messageEntry('2026-10-17T00:00:07.000Z', message('toolResult', 1_600_000_000_800)),
      ],
    })
    expect(projection).toEqual({
      firstUserMessageText: 'user 内容',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: new Date(1_600_000_000_900).toISOString(),
      parentSessionPath: 'C:/sessions/parent.jsonl',
    })
  })

  it('message.timestamp 优先；缺失时回退 entry.timestamp', () => {
    const withMessageTime = projectSessionRecord({
      header,
      entries: [messageEntry('2026-10-17T00:00:09.000Z', message('user', 1_600_000_000_500))],
    })
    expect(withMessageTime.updatedAt).toBe(new Date(1_600_000_000_500).toISOString())

    const withEntryTime = projectSessionRecord({
      header,
      entries: [
        messageEntry('2026-10-17T00:00:07.000Z', message('assistant')),
        messageEntry('2026-10-17T00:00:08.000Z', message('user')),
      ],
    })
    expect(withEntryTime.updatedAt).toBe('2026-10-17T00:00:08.000Z')
  })

  it('无有效活动时间时回退 header.timestamp', () => {
    const projection = projectSessionRecord({
      header,
      entries: [
        messageEntry('2026-10-17T00:00:09.000Z', message('toolResult', 1_600_000_000_900)),
        messageEntry('2026-10-17T00:00:08.000Z', message('user', 0)),
        messageEntry('2026-10-17T00:00:07.000Z', message('assistant', -1)),
      ],
    })
    expect(projection.createdAt).toBe('2026-10-17T00:00:00.000Z')
    expect(projection.updatedAt).toBe('2026-10-17T00:00:00.000Z')
  })

  it('NaN 活动时间与 Pi 一样使最终结果回退 header（不保留此前有效值）', () => {
    const projection = projectSessionRecord({
      header,
      entries: [
        messageEntry('2026-10-17T00:00:08.000Z', message('user', 1_600_000_000_900)),
        messageEntry('2026-10-17T00:00:09.000Z', message('assistant', Number.NaN)),
      ],
    })
    expect(projection.updatedAt).toBe('2026-10-17T00:00:00.000Z')
  })

  it('无 header 时不伪造创建时间，活动时间仍按消息投影', () => {
    const projection = projectSessionRecord({
      header: null,
      entries: [messageEntry('2026-10-17T00:00:08.000Z', message('assistant', 1_600_000_000_900))],
    })
    expect(projection.createdAt).toBeUndefined()
    expect(projection.updatedAt).toBe(new Date(1_600_000_000_900).toISOString())
    expect(projection.parentSessionPath).toBeUndefined()
  })

  it('无 header 且无有效活动时间时省略时间', () => {
    const projection = projectSessionRecord({ header: null, entries: [] })
    expect(projection.createdAt).toBeUndefined()
    expect(projection.updatedAt).toBeUndefined()
  })
})

describe('mapColdMetadata 标题来源', () => {
  const context = {
    messages: [{ role: 'user', content: '内容' }],
    thinkingLevel: 'medium',
    model: { provider: 'my-provider', modelId: 'gpt-5.6-luna' },
  }

  it('直接沿用 SessionInfo 的标题（不做分支名称推导）', () => {
    const metadata = mapColdMetadata(baseInfo, context, { archived: false })
    expect(metadata.title).toBe('第一条消息内容')
  })

  it('SessionInfo.name 为空时不产生空标题（回退消息标题）', () => {
    const metadata = mapColdMetadata({ ...baseInfo, name: '' }, context, { archived: false })
    expect(metadata.title).toBe('第一条消息内容')
  })
})
