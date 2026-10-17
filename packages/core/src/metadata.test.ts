import { harnessQueueItemId } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  deriveReadiness,
  latestSessionName,
  mapQueuedMessages,
  mapSessionInfo,
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

describe('latestSessionName', () => {
  it('取最新的 session_info 记录', () => {
    const branch = [
      { id: '1', parentId: null, timestamp: 't', type: 'session_info', name: '旧名' },
      { id: '2', parentId: '1', timestamp: 't', type: 'message', message: {} },
      { id: '3', parentId: '2', timestamp: 't', type: 'session_info', name: '新名' },
    ]
    expect(latestSessionName(branch as never)).toBe('新名')
  })

  it('无 session_info 时返回 undefined', () => {
    expect(latestSessionName([] as never)).toBeUndefined()
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
