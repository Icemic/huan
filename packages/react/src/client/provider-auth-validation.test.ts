import type { HarnessProviderAuthSnapshot } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  isProviderAuthCancelResult,
  isProviderAuthRespondResult,
  isProviderAuthSnapshot,
  isProviderAuthStartResult,
} from './validation.js'

const snapshot: HarnessProviderAuthSnapshot = {
  seq: 4,
  authRevision: 1,
  providers: [
    {
      providerId: 'synthetic',
      name: '合成',
      configured: false,
      methods: [{ type: 'api_key', label: 'API key', loginable: true }],
      ambientOnly: false,
    },
  ],
  operations: [
    {
      id: 'auth:1',
      providerId: 'synthetic',
      providerName: '合成',
      kind: 'login',
      method: 'api_key',
      phase: 'prompt',
      startedAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:01.000Z',
      events: [
        { eventId: 'event:1', type: 'auth_url', url: 'https://example.invalid/oauth' },
        {
          eventId: 'event:2',
          type: 'device_code',
          userCode: 'CODE',
          verificationUri: 'http://example.invalid/device',
          intervalSeconds: 5,
        },
      ],
      prompt: {
        promptId: 'prompt:1',
        kind: 'secret',
        message: '输入密钥',
        placeholder: 'sk-...',
      },
    },
  ],
}

describe('认证协议运行时守卫', () => {
  it('接受带提示/事件/可选占位符的权威快照', () => {
    expect(isProviderAuthSnapshot(snapshot)).toBe(true)
    expect(isProviderAuthSnapshot({ ...snapshot, operations: [] })).toBe(true)
  })

  it('拒绝未知阶段、未知提示类型与畸形事件', () => {
    const unknownPhase = structuredClone(snapshot)
    unknownPhase.operations[0]!.phase = 'hacking' as never
    expect(isProviderAuthSnapshot(unknownPhase)).toBe(false)

    const unknownPrompt = structuredClone(snapshot)
    unknownPrompt.operations[0]!.prompt!.kind = 'password' as never
    expect(isProviderAuthSnapshot(unknownPrompt)).toBe(false)

    const badEvent = structuredClone(snapshot)
    badEvent.operations[0]!.events = [{ type: 'progress' }, {}] as never
    expect(isProviderAuthSnapshot(badEvent)).toBe(false)
  })

  it('启动/回填/取消结果只接受受控状态', () => {
    expect(
      isProviderAuthStartResult({ status: 'started', operation: snapshot.operations[0] }),
    ).toBe(true)
    expect(isProviderAuthStartResult({ status: 'busy', operation: snapshot.operations[0] })).toBe(
      true,
    )
    expect(isProviderAuthStartResult({ status: 'invalid', message: '未知 provider' })).toBe(true)
    expect(isProviderAuthStartResult({ status: 'queued' })).toBe(false)

    expect(isProviderAuthRespondResult({ status: 'accepted' })).toBe(true)
    expect(isProviderAuthRespondResult({ status: 'stale' })).toBe(true)
    expect(isProviderAuthRespondResult({ status: 'invalid', message: '无效' })).toBe(true)
    expect(isProviderAuthRespondResult({ status: 'invalid' })).toBe(false)

    expect(isProviderAuthCancelResult({ status: 'not-found' })).toBe(true)
    expect(
      isProviderAuthCancelResult({ status: 'cancelling', operation: snapshot.operations[0] }),
    ).toBe(true)
  })
})
