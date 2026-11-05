import { describe, expect, it } from 'vitest'
import type { HarnessProviderAuthSnapshot } from './index.js'
import {
  isProviderAuthCancelResult,
  isProviderAuthRespondResult,
  isProviderAuthSnapshot,
  isProviderAuthStartResult,
} from './wire-validation.js'

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
    const phase = unknownPhase.operations[0]
    if (!phase) throw new Error('fixture missing')
    phase.phase = 'hacking' as never
    expect(isProviderAuthSnapshot(unknownPhase)).toBe(false)

    const unknownPrompt = structuredClone(snapshot)
    const prompt = unknownPrompt.operations[0]?.prompt
    if (!prompt) throw new Error('fixture missing')
    prompt.kind = 'password' as never
    expect(isProviderAuthSnapshot(unknownPrompt)).toBe(false)

    const badEvent = structuredClone(snapshot)
    const operation = badEvent.operations[0]
    if (!operation) throw new Error('fixture missing')
    operation.events = [{ type: 'progress' }, {}] as never
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

describe('R5 wire 形状守卫', () => {
  it('完整快照接受受控模型回退与活动工具；缺省/未知形状被拒绝', async () => {
    const { isThreadSnapshot } = await import('./wire-validation.js')
    const snapshot = {
      metadata: {
        id: 't1',
        status: 'running',
        modelFallback: {
          reason: 'restore-failed',
          requested: { provider: 'old', modelId: 'gone' },
          active: { provider: 'new', modelId: 'ok' },
          message: 'Could not restore model old/gone. Using new/ok',
        },
      },
      messages: [],
      toolExecutions: [
        {
          toolCallId: 'c1',
          toolName: 'read',
          args: { path: 'a' },
          partialResult: { content: [{ type: 'text', text: '...' }] },
          status: 'running',
          parentToolCallId: 'parent',
        },
      ],
    }
    expect(isThreadSnapshot(snapshot)).toBe(true)
    expect(
      isThreadSnapshot({
        ...snapshot,
        metadata: { id: 't1', status: 'running', modelFallback: { reason: 'hacked' } },
      }),
    ).toBe(false)
    expect(
      isThreadSnapshot({
        ...snapshot,
        toolExecutions: [{ toolCallId: 'c1', status: 'unknown' }],
      }),
    ).toBe(false)
  })

  it('运行统计接受运行中/结算形状，并随元数据校验', async () => {
    const { isRunMetrics, isThreadMetadata } = await import('./wire-validation.js')
    expect(isRunMetrics({ status: 'running', outputTokens: 0 })).toBe(true)
    expect(
      isRunMetrics({
        status: 'completed',
        outputTokens: 120,
        durationMs: 2000,
        firstResponseMs: 300,
      }),
    ).toBe(true)
    expect(isRunMetrics({ status: 'unknown', outputTokens: 1 })).toBe(false)
    expect(isRunMetrics({ status: 'completed' })).toBe(false)
    expect(
      isThreadMetadata({
        id: 't1',
        status: 'idle',
        runMetrics: { status: 'cancelled', outputTokens: 4, durationMs: 500 },
      }),
    ).toBe(true)
    expect(isThreadMetadata({ id: 't1', status: 'idle', runMetrics: { status: 'running' } })).toBe(
      false,
    )
  })

  it('历史工具结果保留有界 nestedCalls 摘要', async () => {
    const { isCompleteTranscriptMessage } = await import('./wire-validation.js')
    expect(
      isCompleteTranscriptMessage({
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'codemode',
        content: [],
        isError: false,
        timestamp: 1,
        nestedCalls: {
          calls: [
            {
              id: 'c1/1',
              name: 'read',
              status: 'ok',
              durationMs: 3,
            },
          ],
          complete: true,
        },
      }),
    ).toBe(true)
  })
})
