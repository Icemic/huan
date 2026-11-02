import type {
  HarnessBashRun,
  HarnessClient,
  HarnessModelScope,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeFeatureStore, scopeModelKeysForPatterns } from './runtime-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const model = (provider: string, modelId: string) => ({
  provider,
  modelId,
  name: modelId,
  supportsThinking: true,
  availableThinkingLevels: ['off', 'low', 'high', 'max'] as const,
  input: ['text', 'image'] as const,
})

const scopeOf = (overrides: Partial<HarnessModelScope> = {}): HarnessModelScope => ({
  patterns: ['provider/model:high'],
  models: [{ provider: 'provider', modelId: 'model', thinkingLevel: 'high' }],
  diagnostics: [],
  savedPatterns: ['provider/model:high'],
  ...overrides,
})

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
    getAvailableModels: vi.fn(async () => [model('provider', 'model'), model('provider', 'other')]),
    getThreadModelScope: vi.fn(async () => scopeOf()),
    setThreadModelScope: vi.fn(async (_threadId: string, input: { patterns: string[] }) => ({
      ...scopeOf(),
      patterns: input.patterns,
      persistence: 'skipped' as const,
    })),
    runThreadBash: vi.fn(async (_threadId: string, input: { command: string }) => ({
      status: 'started' as const,
      run: bashRunOf(input.command),
    })),
    abortThreadBash: vi.fn(async () => ({ status: 'requested' as const })),
    compactThread: vi.fn(async () => ({ status: 'compacted' as const, tokensBefore: 10 })),
    abortThreadCompaction: vi.fn(async () => ({ status: 'requested' as const })),
    setAutoCompaction: vi.fn(async () => ({
      status: 'saved' as const,
      enabled: true,
      scope: 'global' as const,
    })),
    refreshModels: vi.fn(async () => ({
      models: [model('provider', 'model')],
      failedProviders: [],
    })),
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

describe('runtime feature：模型范围原文与保存', () => {
  it('读取会话patterns原文与Thinking后缀，未编辑保存不改写', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })
    expect(store.getState().scope?.savedPatterns).toEqual(['provider/model:high'])
    expect(store.getState().patternsText).toBe('provider/model:high')
    expect(store.getState().basePatternsText).toBe('provider/model:high')

    await store.getState().saveScope()
    expect(client.setThreadModelScope).toHaveBeenCalledWith('t1', {
      patterns: ['provider/model:high'],
    })
    expect(store.getState().patternsText).toBe('provider/model:high')
    expect(store.getState().basePatternsText).toBe('provider/model:high')
    expect(store.getState().notice).toContain('会话范围已应用')
  })

  it('清除范围不回填旧默认；会话通配原文独立保留', async () => {
    const { client, store } = createStore()
    vi.mocked(client.getThreadModelScope).mockResolvedValue({
      patterns: [],
      models: [],
      diagnostics: [],
      savedPatterns: ['provider/model:high'],
    })
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })
    expect(store.getState().patternsText).toBe('')

    vi.mocked(client.getThreadModelScope).mockResolvedValue({
      patterns: ['provider/*:high'],
      models: [{ provider: 'provider', modelId: 'model', thinkingLevel: 'high' }],
      diagnostics: [],
      savedPatterns: ['other/model:high'],
    })
    await store.getState().loadScope()
    expect(store.getState().patternsText).toBe('provider/*:high')
  })

  it('显式保存用户默认使用原始 patterns；无匹配时恢复已保存原文', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })
    store.getState().setSaveAsDefault(true)
    vi.mocked(client.setThreadModelScope).mockResolvedValueOnce({
      ...scopeOf(),
      patterns: ['provider/model:high'],
      persistence: 'saved',
    })
    await store.getState().saveScope()
    expect(client.setThreadModelScope).toHaveBeenCalledWith('t1', {
      patterns: ['provider/model:high'],
      saveAsDefault: true,
    })
    expect(store.getState().notice).toContain('保存为用户默认')

    store.getState().updatePatternsText('nope/missing')
    vi.mocked(client.setThreadModelScope).mockResolvedValueOnce({
      ...scopeOf(),
      patterns: [],
      models: [],
      diagnostics: [{ code: 'no-match', message: '没有匹配', pattern: 'nope/missing' }],
      persistence: 'skipped',
      message: '没有匹配的模型，会话范围未修改。',
    })
    await store.getState().saveScope()
    expect(store.getState().patternsText).toBe('provider/model:high')
    expect(store.getState().notice).toContain('没有匹配')
  })

  it('按目录勾选模型不破坏其他 Thinking 后缀；通配模式不冒充精确行', async () => {
    const { store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1', workspacePath: '/workspace' } })
    const catalog = [
      { provider: 'provider', modelId: 'model' },
      { provider: 'provider', modelId: 'other' },
    ]
    const other = catalog[1]
    const first = catalog[0]
    if (!other || !first) throw new Error('测试缺少模型目录')
    store.getState().toggleScopeModel(other, catalog)
    expect(store.getState().patternsText).toBe('provider/model:high\nprovider/other')

    store.getState().updatePatternsText('provider/*')
    store.getState().toggleScopeModel(first, catalog)
    expect(store.getState().notice).toContain('通配模式')
    expect(store.getState().patternsText).toBe('provider/*')

    expect(scopeModelKeysForPatterns('provider/*', catalog)).toEqual([
      'provider/model',
      'provider/other',
    ])
  })
})

describe('runtime feature：Shell、压缩与自动开关', () => {
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

  it('压缩失败/取消和自动压缩项目覆盖均如实显示', async () => {
    const { browser, client, store } = createStore()
    browser.serviceStore.getState().applyThreadSnapshot('t1', {
      ...threadSnapshotOf('t1'),
      metadata: {
        id: 't1',
        status: 'idle',
        workspacePath: '/workspace',
        autoCompactionEnabled: false,
      },
    })
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

    vi.mocked(client.setAutoCompaction).mockResolvedValueOnce({
      status: 'saved',
      enabled: true,
      scope: 'global',
      overridden: true,
      message: '用户默认已保存，但项目设置覆盖了当前会话',
    })
    await store.getState().toggleAutoCompaction()
    expect(client.setAutoCompaction).toHaveBeenCalledWith('t1', true)
    expect(store.getState().notice).toContain('项目设置覆盖')
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
