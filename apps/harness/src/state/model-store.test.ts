import type {
  HarnessClient,
  HarnessProviderAuthSnapshot,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import {
  createHarnessBrowser,
  draftIdOf,
  type HarnessBrowser,
  selectHarnessModelCatalog,
} from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createModelFeatureStore } from './model-store'

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
  availableThinkingLevels: ['off', 'low', 'high', 'xhigh', 'max'] as const,
  input: ['text', 'image'] as const,
})

const threadSnapshotOf = (threadId: string): HarnessThreadSnapshot => ({
  metadata: { id: threadId, status: 'idle', workspacePath: '/workspace' },
  messages: [],
})

const authSnapshotOf = (authRevision: number): HarnessProviderAuthSnapshot => ({
  seq: authRevision,
  authRevision,
  providers: [],
  operations: [],
})

const createStore = () => {
  const client = {
    getAvailableModels: vi.fn(async () => [model('provider', 'model'), model('provider', 'other')]),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(async () => {}),
    getThread: vi.fn(async (threadId: string) => threadSnapshotOf(threadId)),
    getProviderAuth: vi.fn(),
  } as unknown as HarnessClient
  const browser: HarnessBrowser = createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })
  const store = createModelFeatureStore({ browser })
  return { client, browser, store }
}

const entryOf = (browser: HarnessBrowser, threadId: string) =>
  selectHarnessModelCatalog(browser.serviceStore.getState(), {
    workspacePath: '/workspace',
    threadId,
  })

describe('model feature：目录版本与已有会话选择', () => {
  it('目录从 serviceStore 按目标/认证版本读取；已有会话真实 setModel/setThinking', async () => {
    const { client, browser, store } = createStore()
    await store.getState().openPanel({
      target: { threadId: 't1', workspacePath: '/workspace' },
    })
    expect(client.getAvailableModels).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      threadId: 't1',
    })
    expect(entryOf(browser, 't1')?.models.map((item) => item.modelId)).toEqual(['model', 'other'])

    await store.getState().chooseModel({ provider: 'provider', modelId: 'other' })
    expect(client.setModel).toHaveBeenCalledWith('t1', {
      provider: 'provider',
      modelId: 'other',
    })
    expect(store.getState().notice).toContain('已切换模型')

    await store.getState().chooseThinking('max')
    expect(client.setThinkingLevel).toHaveBeenCalledWith('t1', 'max')
    expect(store.getState().notice).toContain('max')

    // 认证版本变化会得到新的目录查询键；再次读取不复用旧目标/旧版本条目。
    browser.serviceStore.getState().applyProviderAuth(authSnapshotOf(2))
    await store.getState().loadCatalog()
    const entry = entryOf(browser, 't1')
    expect(entry?.authRevision).toBe(2)
    expect(client.getAvailableModels).toHaveBeenCalledTimes(2)
  })

  it('新会话选择写入窗口草稿与 Thinking，不调用服务端 setModel', async () => {
    const { client, browser, store } = createStore()
    browser.windowStore.getState().selectTarget({
      kind: 'new',
      workspaceId: 'w1',
      startProjectPath: '/workspace',
    })
    await store.getState().openPanel({
      target: { workspacePath: '/workspace', workspaceId: 'w1' },
    })
    expect(client.getAvailableModels).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      workspaceId: 'w1',
    })
    await store.getState().chooseModel({ provider: 'provider', modelId: 'other' })
    await store.getState().chooseThinking('xhigh')

    const draftId = draftIdOf({
      kind: 'new',
      workspaceId: 'w1',
      startProjectPath: '/workspace',
    })
    const draft = browser.windowStore.getState().draftsById[draftId]
    expect(draft?.model).toEqual({ provider: 'provider', modelId: 'other' })
    expect(draft?.thinkingLevel).toBe('xhigh')
    expect(client.setModel).not.toHaveBeenCalled()
    expect(client.setThinkingLevel).not.toHaveBeenCalled()
    expect(store.getState().notice).toContain('新会话')
  })

  it('关闭重开后迟到失败不写新面板', async () => {
    const { client, store } = createStore()
    const gate = deferred<void>()
    vi.mocked(client.setModel).mockReturnValueOnce(gate.promise)
    await store.getState().openPanel({
      target: { threadId: 't1', workspacePath: '/workspace' },
    })
    const choosing = store.getState().chooseModel({ provider: 'provider', modelId: 'other' })
    expect(store.getState().busy).toBe('model')
    store.getState().close()
    await store.getState().openPanel({
      target: { threadId: 't1', workspacePath: '/workspace' },
    })
    gate.reject(new Error('旧请求失败'))
    await choosing
    expect(store.getState().open).toBe(true)
    expect(store.getState().error).toBeUndefined()
    expect(store.getState().busy).toBeUndefined()
  })

  it('打开时固定目标；关闭后不再把选择写到原面板', async () => {
    const { store } = createStore()
    expect(await store.getState().openPanel()).toBe(false)
    await store.getState().openPanel({
      target: { threadId: 't1', workspacePath: '/workspace' },
    })
    expect(store.getState().targetKey).toBe('t:t1')
    store.getState().close()
    expect(store.getState().open).toBe(false)
    expect(store.getState().target).toBeUndefined()
  })
})
