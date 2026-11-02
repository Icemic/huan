import type {
  HarnessClient,
  HarnessHostInfo,
  HarnessHostInteractionSnapshot,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createHostFeatureStore } from './host-store'

const hostInfo: HarnessHostInfo = {
  workspacePath: '/workspace',
  agentDir: '/agent',
  agentDirSource: 'settings',
  protocolVersion: HARNESS_PROTOCOL_VERSION,
  sessionStorage: {
    mode: 'grouped',
    root: '/sessions',
    directory: '/sessions',
    source: 'settings',
  },
  defaultModel: {
    providerSource: 'env',
    modelIdSource: 'env',
    readiness: { state: 'missing-model', message: 'none' },
  },
  diagnostics: [],
}

const snapshotOf = (): HarnessHostInteractionSnapshot => ({
  seq: 1,
  requests: [
    {
      id: 'confirm-1',
      scope: { kind: 'project', cwd: '/workspace' },
      kind: 'confirm',
      title: '允许？',
      message: '执行项目扩展',
      createdAt: 1,
    },
    {
      id: 'select-1',
      scope: { kind: 'project', cwd: '/workspace' },
      kind: 'select',
      title: '选择',
      options: ['a', 'b'],
      createdAt: 2,
    },
    {
      id: 'input-1',
      scope: { kind: 'project', cwd: '/workspace' },
      kind: 'input',
      title: '输入',
      placeholder: '值',
      createdAt: 3,
    },
    {
      id: 'editor-1',
      scope: { kind: 'project', cwd: '/workspace' },
      kind: 'editor',
      title: '编辑',
      prefill: '第一行\n第二行',
      createdAt: 4,
    },
  ],
  notifications: [
    {
      id: 'n1',
      scope: { kind: 'project', cwd: '/workspace' },
      message: '提示',
      type: 'info',
      createdAt: 5,
    },
  ],
})

const threadSnapshot = (): HarnessThreadSnapshot => ({
  metadata: { id: 't1', status: 'running', workspacePath: '/workspace' },
  messages: [],
  messageEntryIds: [],
  seq: 1,
  hostUiRequests: [
    {
      id: 'tool-request',
      kind: 'editor',
      title: '工具交互',
      prefill: '工具预填\n多行',
      toolCallId: 'tool-1',
    },
    { id: 'free-request', kind: 'input', title: '游离输入' },
  ],
})

const createFakeClient = () => {
  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    getProviderAuth: vi.fn(async () => ({
      seq: 1,
      authRevision: 1,
      providers: [],
      operations: [],
    })),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    respondToHostInteraction: vi.fn(async () => ({ accepted: true })),
    respondToHostUiRequest: vi.fn(async () => {}),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
  } as unknown as HarnessClient
  return client
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({ client, connectionKey: 'test', windowId: 'window-a', storage: null })

describe('host feature：Host 级请求答案与通知', () => {
  it('editor 预填多行；每个请求独立答案，提交一个不清除另一个', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createHostFeatureStore({ browser })
    browser.serviceStore.getState().applyHostInteractions({
      type: 'snapshot',
      seq: 1,
      snapshot: snapshotOf(),
    })

    expect(store.getState().interactionDrafts['editor-1']?.text).toBe('第一行\n第二行')
    expect(store.getState().interactionDrafts['input-1']?.text).toBe('')

    store.getState().setInteractionAnswer('input-1', '输入值')
    store.getState().setInteractionAnswer('editor-1', '编辑后的多行\n继续')
    await store.getState().respondInteraction('input-1')

    expect(client.respondToHostInteraction).toHaveBeenCalledWith({
      requestId: 'input-1',
      value: '输入值',
    })
    expect(store.getState().interactionDrafts['input-1']?.text).toBe('')
    expect(store.getState().interactionDrafts['editor-1']?.text).toBe('编辑后的多行\n继续')
  })

  it('confirm/select 保持原始应答形状，不转换为 approval', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createHostFeatureStore({ browser })
    browser.serviceStore.getState().applyHostInteractions({
      type: 'snapshot',
      seq: 1,
      snapshot: snapshotOf(),
    })

    await store.getState().respondInteraction('confirm-1', {
      requestId: 'confirm-1',
      confirmed: false,
    })
    await store.getState().respondInteraction('select-1', {
      requestId: 'select-1',
      value: 'b',
    })
    expect(client.respondToHostInteraction).toHaveBeenNthCalledWith(1, {
      requestId: 'confirm-1',
      confirmed: false,
    })
    expect(client.respondToHostInteraction).toHaveBeenNthCalledWith(2, {
      requestId: 'select-1',
      value: 'b',
    })
  })

  it('忽略通知只影响本窗口，快照收敛后清理', () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createHostFeatureStore({ browser })
    browser.serviceStore.getState().applyHostInteractions({
      type: 'snapshot',
      seq: 1,
      snapshot: snapshotOf(),
    })
    store.getState().dismissNotification('n1')
    expect(store.getState().dismissedNotifications.has('n1')).toBe(true)

    browser.serviceStore.getState().applyHostInteractions({
      type: 'snapshot',
      seq: 2,
      snapshot: { seq: 2, requests: [], notifications: [] },
    })
    expect(store.getState().dismissedNotifications.size).toBe(0)
  })
})

describe('host feature：会话级请求与宿主刷新', () => {
  it('工具关联请求无可见工具也保留待答入口与 prefill', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createHostFeatureStore({ browser })
    browser.serviceStore.getState().applyThreadSnapshot('t1', threadSnapshot())
    const requests = browser.serviceStore.getState().sessionDataById.t1?.hostUiRequests ?? []
    store.getState().syncThreadRequests('t1', requests)

    expect(store.getState().threadAnswers['t1:tool-request']?.text).toBe('工具预填\n多行')

    store.getState().setThreadAnswer('t1', 'tool-request', '提交工具答案')
    expect(store.getState().threadAnswers['t1:tool-request']?.text).toBe('提交工具答案')
    await store.getState().respondThreadRequest('t1', 'tool-request')
    expect(client.respondToHostUiRequest).toHaveBeenCalledWith('t1', {
      requestId: 'tool-request',
      value: '提交工具答案',
    })
    // 另一个游离请求的答案草稿仍存在。
    expect(store.getState().threadAnswers['t1:free-request']).toMatchObject({
      threadId: 't1',
      text: '',
    })
  })

  it('认证 revision 变化后重新读取宿主信息', async () => {
    const client = createFakeClient()
    const browser = createBrowser(client)
    const store = createHostFeatureStore({ browser })
    await store.getState().refreshHostInfo()
    expect(client.getHostInfo).toHaveBeenCalledTimes(1)

    browser.serviceStore.getState().applyProviderAuth({
      seq: 2,
      authRevision: 2,
      providers: [],
      operations: [],
    })
    await vi.waitFor(() => expect(client.getHostInfo).toHaveBeenCalledTimes(2))
  })
})
