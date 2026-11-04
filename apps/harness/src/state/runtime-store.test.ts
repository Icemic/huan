import type {
  HarnessBashRun,
  HarnessClient,
  HarnessCompactionOutcome,
  HarnessThreadDetails,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadStats,
} from '@huan/protocol'
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

const threadSnapshotOf = (
  threadId: string,
  metadata: Partial<HarnessThreadMetadata> = {},
  seq = 1,
): HarnessThreadSnapshot => ({
  metadata: { id: threadId, status: 'idle', workspacePath: '/workspace', ...metadata },
  messages: [],
  seq,
})

const statsOf = (input: number): HarnessThreadStats => ({
  userMessages: 1,
  assistantMessages: 1,
  toolResults: 0,
  toolCalls: 0,
  totalMessages: 2,
  tokens: { input, output: 2, cacheRead: 3, cacheWrite: 4, total: input + 9 },
  cost: 0,
})

const detailsOf = (threadId: string, input: number): HarnessThreadDetails => ({
  metadata: { id: threadId, status: 'idle', workspacePath: '/workspace' },
  stats: statsOf(input),
  branchEntryCount: 1,
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
    getThreadDetails: vi.fn(async (threadId: string) => detailsOf(threadId, 0)),
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

  it('压缩结果不在面板重复提示；取消空闲仍明确提示', async () => {
    const { browser, client, store } = createStore()
    browser.serviceStore.getState().applyThreadSnapshot('t1', threadSnapshotOf('t1'))
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })

    store.getState().setCompactInstructions('保留关键决策')
    vi.mocked(client.compactThread).mockImplementationOnce(async () => {
      browser.serviceStore.getState().applyThreadEvent('t1', {
        type: 'compaction_end',
        threadId: 't1',
        seq: 2,
        reason: 'manual',
        operationId: 'op-1',
        aborted: false,
        willRetry: false,
        errorMessage: '压缩失败',
      })
      return { status: 'failed', message: '压缩失败' }
    })
    await store.getState().compact()
    expect(client.compactThread).toHaveBeenCalledWith('t1', {
      customInstructions: '保留关键决策',
    })
    // 事件/消息状态行是压缩结果的唯一展示位置。
    expect(store.getState().error).toBeUndefined()
    expect(store.getState().notice).toBeUndefined()

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

  it('浮窗只在打开时读取累计统计，并按元数据失效键重读', async () => {
    const { browser, client, store } = createStore()
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    browser.serviceStore.getState().applyThreadSnapshot('t1', threadSnapshotOf('t1'))
    vi.mocked(client.getThreadDetails)
      .mockResolvedValueOnce(detailsOf('t1', 11))
      .mockResolvedValueOnce(detailsOf('t1', 22))

    expect(client.getThreadDetails).not.toHaveBeenCalled()
    store.getState().openContextUsage()
    await vi.waitFor(() => expect(store.getState().contextUsage.stats?.tokens.input).toBe(11))
    expect(client.getThreadDetails).toHaveBeenCalledTimes(1)

    // 纯 context_usage 事件只更新实时 metadata，不触发累计统计重读。
    browser.serviceStore.getState().applyThreadEvent('t1', {
      type: 'context_usage',
      threadId: 't1',
      contextUsage: { tokens: 90, contextWindow: 100, percent: 90 },
      seq: 2,
    })
    await Promise.resolve()
    expect(client.getThreadDetails).toHaveBeenCalledTimes(1)
    expect(browser.serviceStore.getState().threadsById.t1?.contextUsage?.percent).toBe(90)
    expect(store.getState().contextUsage.stats?.tokens.input).toBe(11)

    // 运行结束等元数据推进后重读累计统计。
    browser.serviceStore
      .getState()
      .applyThreadSnapshot(
        't1',
        threadSnapshotOf('t1', { updatedAt: '2026-01-01T00:00:01.000Z' }, 3),
      )
    await vi.waitFor(() => expect(store.getState().contextUsage.stats?.tokens.input).toBe(22))
    expect(client.getThreadDetails).toHaveBeenCalledTimes(2)
  })

  it('浮窗关闭立即停止读取，退出完成清理正文且不清理已重开面板', async () => {
    const { browser, store } = createStore()
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    browser.serviceStore.getState().applyThreadSnapshot('t1', threadSnapshotOf('t1'))
    store.getState().openContextUsage()
    await vi.waitFor(() => expect(store.getState().contextUsage.stats).toBeDefined())
    const stats = store.getState().contextUsage.stats
    store.getState().closeContextUsage()
    expect(store.getState().contextUsage.stats).toBe(stats)
    store.getState().completeContextUsageClose()
    expect(store.getState().contextUsage.stats).toBeUndefined()
    store.getState().openContextUsage()
    store.getState().completeContextUsageClose()
    expect(store.getState().contextUsage.open).toBe(true)
    store.getState().dispose()
  })

  it('切换目标后旧详情不写回，当前上下文仍取实时 metadata', async () => {
    const { browser, client, store } = createStore()
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    const liveUsage = { tokens: 70, contextWindow: 100, percent: 70 }
    browser.serviceStore
      .getState()
      .applyThreadSnapshot('t1', threadSnapshotOf('t1', { contextUsage: liveUsage }))
    const gate = deferred<HarnessThreadDetails>()
    vi.mocked(client.getThreadDetails).mockReturnValueOnce(gate.promise)

    store.getState().openContextUsage()
    expect(store.getState().contextUsage.threadId).toBe('t1')
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't2' })
    expect(store.getState().contextUsage.open).toBe(false)

    browser.serviceStore.getState().applyThreadSnapshot('t2', threadSnapshotOf('t2', {}, 2))
    vi.mocked(client.getThreadDetails).mockResolvedValueOnce(detailsOf('t2', 20))
    store.getState().openContextUsage()
    await vi.waitFor(() => expect(store.getState().contextUsage.stats?.tokens.input).toBe(20))

    gate.resolve(detailsOf('t1', 10))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().contextUsage.stats?.tokens.input).toBe(20)
    expect(browser.serviceStore.getState().threadsById.t1?.contextUsage).toEqual(liveUsage)
  })

  it('浮窗立即压缩无提示词、防重复，并保留输入草稿', async () => {
    const { browser, client, store } = createStore()
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    browser.serviceStore.getState().applyThreadSnapshot('t1', threadSnapshotOf('t1'))
    browser.windowStore.getState().editDraftText('thread:t1', '保留的草稿')
    store.getState().openContextUsage()
    await vi.waitFor(() => expect(client.getThreadDetails).toHaveBeenCalledTimes(1))

    const gate = deferred<HarnessCompactionOutcome>()
    vi.mocked(client.compactThread).mockReturnValueOnce(gate.promise)
    const first = store.getState().compactContextUsage()
    const second = store.getState().compactContextUsage()
    expect(client.compactThread).toHaveBeenCalledTimes(1)
    expect(client.compactThread).toHaveBeenCalledWith('t1', {})

    gate.resolve({ status: 'compacted', tokensBefore: 10, estimatedTokensAfter: 4 })
    await Promise.all([first, second])
    // 成功结果由会话消息状态行承载，浮窗不重复提示。
    expect(store.getState().contextUsage.compactError).toBeUndefined()
    expect(browser.windowStore.getState().draftsById['thread:t1']?.text).toBe('保留的草稿')
  })

  it('运行中只提示未开始，失败结果不重复写入浮窗', async () => {
    const { browser, client, store } = createStore()
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    browser.serviceStore
      .getState()
      .applyThreadSnapshot('t1', threadSnapshotOf('t1', { status: 'running' }))
    store.getState().openContextUsage()
    await store.getState().compactContextUsage()
    expect(client.compactThread).not.toHaveBeenCalled()
    expect(store.getState().contextUsage.compactError).toContain('模型正在运行')

    browser.serviceStore
      .getState()
      .applyThreadSnapshot(
        't1',
        threadSnapshotOf('t1', { updatedAt: '2026-01-01T00:00:01.000Z' }, 2),
      )
    vi.mocked(client.compactThread).mockResolvedValueOnce({
      status: 'failed',
      message: '压缩失败',
    })
    browser.serviceStore.getState().applyThreadEvent('t1', {
      type: 'compaction_end',
      threadId: 't1',
      seq: 3,
      reason: 'manual',
      operationId: 'op-2',
      aborted: false,
      willRetry: false,
      errorMessage: '压缩失败',
    })
    await store.getState().compactContextUsage()
    expect(store.getState().contextUsage.compactError).toBeUndefined()
  })
})
