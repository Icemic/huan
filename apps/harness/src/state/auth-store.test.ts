import type {
  HarnessClient,
  HarnessProviderAuthOperation,
  HarnessProviderAuthPrompt,
  HarnessProviderAuthSnapshot,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createAuthFeatureStore } from './auth-store'

const prompt = (
  promptId: string,
  kind: HarnessProviderAuthPrompt['kind'],
): HarnessProviderAuthPrompt => ({
  promptId,
  kind,
  message: `提示 ${promptId}`,
  ...(kind === 'secret' ? { placeholder: 'sk-...' } : {}),
})

const operation = (
  id: string,
  promptValue: HarnessProviderAuthPrompt | undefined,
): HarnessProviderAuthOperation => ({
  id,
  providerId: 'provider-a',
  providerName: 'Provider A',
  kind: 'login',
  method: 'api_key',
  phase: promptValue ? 'prompt' : 'waiting',
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  events: [],
  ...(promptValue ? { prompt: promptValue } : {}),
})

const snapshotOf = (
  operations: readonly HarnessProviderAuthOperation[] = [],
): HarnessProviderAuthSnapshot => ({
  seq: 1,
  authRevision: 1,
  providers: [
    {
      providerId: 'provider-a',
      name: 'Provider A',
      configured: false,
      methods: [{ type: 'api_key', label: 'API key', loginable: true }],
      ambientOnly: false,
    },
  ],
  operations,
})

const createFakeClient = () => {
  const client = {
    getProviderAuth: vi.fn(async () => snapshotOf()),
    startProviderLogin: vi.fn(async () => ({
      status: 'started' as const,
      operation: operation('op-a', undefined),
    })),
    respondProviderAuthPrompt: vi.fn(async () => ({ status: 'accepted' as const })),
    cancelProviderAuth: vi.fn(async () => ({
      status: 'cancelling' as const,
      operation: operation('op-a', undefined),
    })),
    logoutProvider: vi.fn(async () => ({
      status: 'started' as const,
      operation: {
        ...operation('op-logout', undefined),
        kind: 'logout' as const,
        phase: 'starting' as const,
      },
    })),
  } as unknown as HarnessClient
  return client
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })

describe('auth feature：登录/退出与面板关闭', () => {
  it('打开读取权威快照；启动登录只标记本地忙，关闭面板不取消远端操作', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createAuthFeatureStore({ browser })

    await store.getState().openPanel()
    expect(store.getState().open).toBe(true)
    expect(browser.serviceStore.getState().providerAuth?.providers).toHaveLength(1)

    await store.getState().startLogin('provider-a', 'api_key')
    expect(client.startProviderLogin).toHaveBeenCalledWith({
      providerId: 'provider-a',
      method: 'api_key',
    })
    expect(store.getState().notice).toContain('已开始')
    // 关闭面板规则只在活跃操作卡片显示，不常驻在提示里。
    expect(store.getState().notice).not.toContain('关闭面板')
    expect(store.getState().providerBusy).toEqual({})

    store.getState().setAnswer('op-a', 'p1', 'secret-value')
    store.getState().closePanel()
    expect(store.getState().open).toBe(false)
    expect(store.getState().answers).toEqual({})
    expect(client.cancelProviderAuth).not.toHaveBeenCalled()
  })

  it('退出登录调用 logoutProvider 并刷新快照', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createAuthFeatureStore({ browser })
    await store.getState().openPanel()
    await store.getState().logout('provider-a')
    expect(client.logoutProvider).toHaveBeenCalledWith('provider-a')
    expect(store.getState().notice).toContain('退出流程')
  })
})

describe('auth feature：短期回填与密钥清理', () => {
  it('每个提示独立答案；提交先清空秘密，其余提示输入保留', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createAuthFeatureStore({ browser })
    browser.serviceStore
      .getState()
      .applyProviderAuth(
        snapshotOf([
          operation('op-1', prompt('p1', 'secret')),
          operation('op-2', prompt('p2', 'text')),
        ]),
      )
    await store.getState().openPanel()

    store.getState().setAnswer('op-1', 'p1', 'secret-value')
    store.getState().setAnswer('op-2', 'p2', 'other-answer')
    expect(store.getState().answers).toEqual({
      'op-1|p1': 'secret-value',
      'op-2|p2': 'other-answer',
    })

    const submitting = store.getState().submitPrompt('op-1', prompt('p1', 'secret'))
    // 请求发出前本地秘密已清空；其他提示不受影响。
    expect(store.getState().answers['op-1|p1']).toBeUndefined()
    expect(store.getState().answers['op-2|p2']).toBe('other-answer')
    await submitting
    expect(client.respondProviderAuthPrompt).toHaveBeenCalledWith({
      operationId: 'op-1',
      promptId: 'p1',
      value: 'secret-value',
    })
  })

  it('提示失效后清理旧回填；取消操作发送取消请求', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createAuthFeatureStore({ browser })
    browser.serviceStore
      .getState()
      .applyProviderAuth(snapshotOf([operation('op-1', prompt('p1', 'text'))]))
    await store.getState().openPanel()
    store.getState().setAnswer('op-1', 'p1', 'old')

    browser.serviceStore
      .getState()
      .applyProviderAuth({ ...snapshotOf([]), seq: 2, authRevision: 2 })
    expect(store.getState().answers).toEqual({})

    await store.getState().cancel('op-1')
    expect(client.cancelProviderAuth).toHaveBeenCalledWith('op-1')
    expect(store.getState().notice).toContain('取消')
  })
})
