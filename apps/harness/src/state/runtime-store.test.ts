import type { HarnessBashRun, HarnessClient, HarnessThreadSnapshot } from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeFeatureStore } from './runtime-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const bashRunOf = (command: string): HarnessBashRun => ({
  id: 'bash-1',
  command,
  excludeFromContext: false,
  cwd: '/workspace',
  status: 'running',
  output: '',
  outputTruncated: false,
  startedAt: '2026-01-01T00:00:00.000Z',
})

const threadSnapshotOf = (threadId: string): HarnessThreadSnapshot => ({
  metadata: { id: threadId, status: 'idle', workspacePath: '/workspace' },
  messages: [],
})

const createStore = () => {
  const client = {
    runThreadBash: vi.fn(async (_threadId: string, input: { command: string }) => ({
      status: 'started' as const,
      run: bashRunOf(input.command),
    })),
    abortThreadBash: vi.fn(async () => ({ status: 'requested' as const })),
    compactThread: vi.fn(async () => ({ status: 'compacted' as const, tokensBefore: 10 })),
    abortThreadCompaction: vi.fn(async () => ({ status: 'requested' as const })),
    getThread: vi.fn(async (threadId: string) => threadSnapshotOf(threadId)),
    reloadResources: vi.fn(),
  } as unknown as HarnessClient
  const browser: HarnessBrowser = createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })
  const store = createRuntimeFeatureStore({ browser })
  return { client, browser, store }
}

describe('runtime feature：Shell 与压缩', () => {
  it('Shell 成功后只清空本次命令；busy/失败如实提示', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })
    store.getState().setShellCommand('echo hi')
    store.getState().setShellExcludeFromContext(true)
    await store.getState().runShell()
    expect(client.runThreadBash).toHaveBeenCalledWith('t1', {
      command: 'echo hi',
      excludeFromContext: true,
    })
    expect(store.getState().shellCommand).toBe('')
    expect(store.getState().busy).toBeUndefined()

    store.getState().setShellCommand('echo busy')
    vi.mocked(client.runThreadBash).mockResolvedValueOnce({
      status: 'busy',
      message: '已有 Shell',
    })
    await store.getState().runShell()
    expect(store.getState().notice).toBe('已有 Shell')
  })

  it('压缩失败与取消均如实显示', async () => {
    const { browser, client, store } = createStore()
    browser.serviceStore.getState().applyThreadSnapshot('t1', threadSnapshotOf('t1'))
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })

    vi.mocked(client.compactThread).mockResolvedValueOnce({
      status: 'failed',
      message: '压缩失败',
    })
    await store.getState().compact()
    expect(store.getState().error).toBe('压缩失败')

    vi.mocked(client.abortThreadCompaction).mockResolvedValueOnce({ status: 'idle' })
    await store.getState().abortCompaction()
    expect(store.getState().notice).toContain('没有进行中的压缩')
  })

  it('关闭或换目标后迟到压缩结果不写新面板', async () => {
    const { client, store } = createStore()
    const gate = deferred<Awaited<ReturnType<HarnessClient['compactThread']>>>()
    vi.mocked(client.compactThread).mockReturnValueOnce(gate.promise)
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })
    const compacting = store.getState().compact()
    await store.getState().openPanel({ target: { threadId: 't2', workspacePath: '/workspace' } })
    gate.resolve({ status: 'failed', message: '旧目标失败' })
    await compacting
    expect(store.getState().targetKey).toBe('t:t2')
    expect(store.getState().error).toBeUndefined()
    expect(store.getState().notice).toBeUndefined()
  })
})
