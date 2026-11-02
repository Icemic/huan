import type { HarnessHostUiRequest } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  responseForApproval,
  responseForInterrupt,
  responseForRequest,
  splitHostUiRequests,
} from './host-ui.js'

describe('host-ui', () => {
  it('按 toolCallId 分流工具关联与游离请求；保留 editor prefill', () => {
    const requests: HarnessHostUiRequest[] = [
      { id: 'r1', kind: 'confirm', title: 'Run?', message: 'ok?', toolCallId: 'tc1' },
      { id: 'r2', kind: 'editor', title: '编辑', prefill: '原始文本' },
      { id: 'r3', kind: 'editor', title: '工具编辑', prefill: '工具原文', toolCallId: 'tc1' },
    ]
    const split = splitHostUiRequests(requests)
    expect([...split.toolAssociated.keys()]).toEqual(['tc1'])
    expect(split.freeStanding.map((request) => request.id)).toEqual(['r2', 'r3'])
    expect(split.freeStanding[0]).toMatchObject({ kind: 'editor', prefill: '原始文本' })
    expect(split.toolAssociated.get('tc1')).toMatchObject({
      kind: 'confirm',
      message: 'ok?',
    })
  })

  it('confirm 映射为布尔；其余答案映射为文本或 dismiss', () => {
    expect(responseForApproval('r1', false)).toEqual({ requestId: 'r1', confirmed: false })
    expect(responseForInterrupt('r2', 'value')).toEqual({ requestId: 'r2', value: 'value' })
    expect(responseForInterrupt('r2', { value: 'value' })).toEqual({
      requestId: 'r2',
      value: 'value',
    })
    expect(responseForInterrupt('r2', { dismissed: true })).toEqual({
      requestId: 'r2',
      dismissed: true,
    })
    expect(responseForInterrupt('r2', undefined)).toEqual({ requestId: 'r2', dismissed: true })
  })

  it('通用应答按请求 kind 分派', () => {
    const confirm: HarnessHostUiRequest = {
      id: 'r1',
      kind: 'confirm',
      title: 'Run?',
      message: 'ok?',
    }
    const input: HarnessHostUiRequest = { id: 'r2', kind: 'input', title: '名称' }
    expect(responseForRequest(confirm, true)).toEqual({ requestId: 'r1', confirmed: true })
    expect(responseForRequest(confirm, 'yes')).toEqual({ requestId: 'r1', confirmed: false })
    expect(responseForRequest(input, { value: '答案' })).toEqual({
      requestId: 'r2',
      value: '答案',
    })
  })
})
