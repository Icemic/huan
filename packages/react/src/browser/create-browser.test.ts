import type {
  HarnessClient,
  HarnessClientEvent,
  HarnessHostInfo,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarnessBrowser } from './create-browser.js'
import type { HarnessFrameScheduler } from './resources.js'

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
    provider: 'provider',
    modelId: 'model',
    providerSource: 'env',
    modelIdSource: 'env',
    readiness: {
      state: 'ready',
      selection: { provider: 'provider', modelId: 'model' },
      source: 'env',
    },
  },
  diagnostics: [],
}

const snapshot = (seq: number): HarnessThreadSnapshot => ({
  metadata: { id: 't1', status: 'idle' },
  messages: [],
  seq,
})

const createFakeClient = () => {
  const threadListeners = new Map<string, Set<(event: HarnessClientEvent) => void>>()
  const providerAuthListeners = new Set<(event: unknown) => void>()
  const hostInteractionListeners = new Set<(event: unknown) => void>()
  const subscribe = vi.fn((threadId: string, listener: (event: HarnessClientEvent) => void) => {
    let listeners = threadListeners.get(threadId)
    if (!listeners) {
      listeners = new Set()
      threadListeners.set(threadId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
    }
  })
  const emit = (event: HarnessClientEvent) => {
    for (const listener of threadListeners.get(event.threadId) ?? []) listener(event)
  }
  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    listThreads: vi.fn(async () => []),
    getThread: vi.fn(async () => snapshot(0)),
    getProviderAuth: vi.fn(async () => ({
      seq: 1,
      authRevision: 1,
      providers: [],
      operations: [],
    })),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    subscribe: subscribe as unknown as HarnessClient['subscribe'],
    subscribeProviderAuth: vi.fn((listener: (event: unknown) => void) => {
      providerAuthListeners.add(listener)
      return () => {
        providerAuthListeners.delete(listener)
      }
    }),
    subscribeHostInteractions: vi.fn((listener: (event: unknown) => void) => {
      hostInteractionListeners.add(listener)
      return () => {
        hostInteractionListeners.delete(listener)
      }
    }),
  } as unknown as HarnessClient
  return {
    client,
    emit,
    subscribe,
    providerAuthListeners,
    hostInteractionListeners,
  }
}

const createBrowser = (client: HarnessClient, scheduleFrame?: HarnessFrameScheduler) =>
  createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
    ...(scheduleFrame ? { scheduleFrame } : {}),
  })

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const threadEvent = (
  body: Record<string, unknown>,
  seq: number,
  threadId = 't1',
): HarnessClientEvent => ({ ...body, threadId, seq }) as unknown as HarnessClientEvent

describe('createHarnessBrowser：根订阅与 provider 认证', () => {
  it('多次根挂载只建立一套订阅；StrictMode 同轮重挂不断开', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const releaseA = browser.acquireRoot()
    const releaseB = browser.acquireRoot()
    expect(fake.providerAuthListeners.size).toBe(1)
    expect(fake.hostInteractionListeners.size).toBe(1)
    expect(fake.client.getHostInfo).toHaveBeenCalledTimes(1)

    releaseA()
    releaseB()
    const releaseC = browser.acquireRoot()
    await flushMicrotasks()
    expect(fake.providerAuthListeners.size).toBe(1)

    releaseC()
    await flushMicrotasks()
    expect(fake.providerAuthListeners.size).toBe(0)
    expect(fake.hostInteractionListeners.size).toBe(0)
    browser.dispose()
  })

  it('根订阅把宿主信息作用域同步到窗口存储', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireRoot()
    await flushMicrotasks()
    expect(browser.windowStore.getState().storageScope).toBe('test|/agent|/sessions')
    release()
    browser.dispose()
  })

  it('provider 认证序号回退视为宿主重启；相同序号不重复写入', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireRoot()
    const listener = (): unknown => undefined
    // 通过真实的订阅列表触发：测试客户端把监听器注册在这里。
    const authListener = [...fake.providerAuthListeners][0] as unknown as (event: {
      snapshot: { seq: number; authRevision: number; providers: []; operations: [] }
    }) => void
    expect(authListener).toBeDefined()
    void listener

    const apply = (seq: number) =>
      authListener({ snapshot: { seq, authRevision: seq, providers: [], operations: [] } })
    apply(5)
    const first = browser.serviceStore.getState().providerAuth
    apply(5)
    expect(browser.serviceStore.getState().providerAuth).toBe(first)
    apply(2)
    expect(browser.serviceStore.getState().providerAuth?.seq).toBe(2)
    release()
    browser.dispose()
  })
})

describe('createHarnessBrowser：会话 lease 与缓存', () => {
  it('lease 归零在微任务确认；同轮重挂复用连接与缓存', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireThreadLease('t1')
    expect(fake.subscribe).toHaveBeenCalledTimes(1)
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    expect(browser.serviceStore.getState().sessionDataById.t1?.loadState).toBe('loaded')

    release()
    const releaseAgain = browser.acquireThreadLease('t1')
    await flushMicrotasks()
    expect(fake.subscribe).toHaveBeenCalledTimes(1)
    expect(browser.serviceStore.getState().sessionDataById.t1).toBeDefined()

    releaseAgain()
    await flushMicrotasks()
    expect(fake.subscribe).toHaveBeenCalledTimes(1)
    expect(browser.serviceStore.getState().sessionDataById.t1).toBeUndefined()
    expect(browser.serviceStore.getState().threadsById.t1).toBeDefined()
    browser.dispose()
  })

  it('多个 lease 共享同一订阅；释放其中一个不驱逐缓存', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const releaseA = browser.acquireThreadLease('t1')
    const releaseB = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    expect(fake.subscribe).toHaveBeenCalledTimes(1)

    releaseA()
    await flushMicrotasks()
    expect(browser.serviceStore.getState().sessionDataById.t1).toBeDefined()

    releaseB()
    await flushMicrotasks()
    expect(browser.serviceStore.getState().sessionDataById.t1).toBeUndefined()
    browser.dispose()
  })

  it('归零释放保留窗口草稿与提交内容', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const target = { kind: 'thread' as const, threadId: 't1' }
    browser.windowStore.getState().selectTarget(target)
    const draftId = Object.keys(browser.windowStore.getState().draftsById)[0]!
    browser.windowStore.getState().editDraftText(draftId, '保留我')

    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    release()
    await flushMicrotasks()

    expect(browser.serviceStore.getState().sessionDataById.t1).toBeUndefined()
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('保留我')
    browser.dispose()
  })

  it('dispose 永久失效、拒绝再取 lease 并忽略迟到事件', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))

    browser.dispose()
    expect(browser.disposed).toBe(true)
    expect(() => browser.acquireThreadLease('t1')).toThrow('disposed')
    expect(() => browser.acquireRoot()).toThrow('disposed')

    fake.emit(threadEvent({ type: 'agent_start' }, 2))
    expect(browser.serviceStore.getState().threadsById).toEqual({})
    release()
    await flushMicrotasks()
  })
})

describe('createHarnessBrowser：流式帧批处理', () => {
  const schedule = () => {
    const frames: Array<() => void> = []
    const scheduler: HarnessFrameScheduler = (flush) => {
      frames.push(flush)
      return () => {
        const index = frames.indexOf(flush)
        if (index !== -1) frames.splice(index, 1)
      }
    }
    const run = () => {
      const pending = frames.splice(0)
      for (const flush of pending) flush()
    }
    return { scheduler, run, frames }
  }

  it('流式更新按帧合并；终结事件立即刷新缓冲并应用', () => {
    const fake = createFakeClient()
    const { scheduler, run, frames } = schedule()
    const browser = createBrowser(fake.client, scheduler)
    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    fake.emit(
      threadEvent(
        { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
        2,
      ),
    )
    const update = (text: string, seq: number) =>
      threadEvent(
        {
          type: 'message_update',
          message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
        },
        seq,
      )
    fake.emit(update('a', 3))
    fake.emit(update('ab', 4))
    expect(frames).toHaveLength(1)
    const messages = () => browser.serviceStore.getState().sessionDataById.t1?.messages ?? []
    expect((messages()[0] as { content: unknown[] } | undefined)?.content).toEqual([])

    run()
    expect((messages()[0] as { content: [{ text: string }] } | undefined)?.content[0]?.text).toBe(
      'ab',
    )

    fake.emit(update('abc', 5))
    fake.emit(
      threadEvent(
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'abc' }], timestamp: 1 },
        },
        6,
      ),
    )
    // 终结事件立即应用缓冲，不等待帧调度。
    expect((messages()[0] as { content: [{ text: string }] } | undefined)?.content[0]?.text).toBe(
      'abc',
    )
    expect(browser.serviceStore.getState().sessionDataById.t1?.lastSeq).toBe(6)
    release()
    browser.dispose()
  })

  it('交互与错误事件同样立即刷新缓冲', () => {
    const fake = createFakeClient()
    const { scheduler, frames } = schedule()
    const browser = createBrowser(fake.client, scheduler)
    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    fake.emit(threadEvent({ type: 'agent_start' }, 2))
    fake.emit(
      threadEvent(
        {
          type: 'message_update',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: 1 },
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' },
        },
        3,
      ),
    )
    fake.emit(
      threadEvent(
        {
          type: 'extension_ui_request',
          request: { id: 'r1', kind: 'confirm', title: 'Run?', message: 'ok?' },
        },
        4,
      ),
    )
    expect(frames).toHaveLength(0)
    expect(browser.serviceStore.getState().sessionDataById.t1?.messages).toHaveLength(1)
    expect(browser.serviceStore.getState().sessionDataById.t1?.hostUiRequests).toHaveLength(1)

    fake.emit(threadEvent({ type: 'agent_end' }, 5))
    // agent_end 不提前空闲。
    expect(browser.serviceStore.getState().threadsById.t1?.status).toBe('running')
    fake.emit(threadEvent({ type: 'agent_settled' }, 6))
    expect(browser.serviceStore.getState().threadsById.t1?.status).toBe('idle')
    release()
    browser.dispose()
  })

  it('忽略发往其他会话的事件', () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    fake.emit(threadEvent({ type: 'agent_start' }, 2, 't2'))
    expect(browser.serviceStore.getState().threadsById.t1?.status).toBe('idle')
    expect(browser.serviceStore.getState().threadsById.t2).toBeUndefined()
    release()
    browser.dispose()
  })

  it('未知事件触发权威快照补读；custom 追加条目不补读', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))

    fake.emit(
      threadEvent(
        {
          type: 'entry_appended',
          entry: {
            type: 'custom',
            id: 'entry-1',
            parentId: null,
            timestamp: '2026-07-18T00:00:00.000Z',
            customType: 'extension-state',
            data: {},
          },
        },
        2,
      ),
    )
    await flushMicrotasks()
    expect(fake.client.getThread).not.toHaveBeenCalled()

    fake.emit(threadEvent({ type: 'future_event' }, 3))
    await flushMicrotasks()
    expect(fake.client.getThread).toHaveBeenCalledTimes(1)
    release()
    browser.dispose()
  })

  it('dispose 逐项回收：一个订阅取消失败不阻止其他清理', () => {
    const fake = createFakeClient()
    const t2Unsubscribe = vi.fn()
    vi.mocked(fake.client.subscribe).mockImplementation((threadId) => {
      if (threadId === 't1') {
        return () => {
          throw new Error('unsubscribe failed')
        }
      }
      return t2Unsubscribe
    })
    const browser = createBrowser(fake.client)
    browser.acquireThreadLease('t1')
    browser.acquireThreadLease('t2')

    expect(() => browser.dispose()).toThrow('unsubscribe failed')
    expect(t2Unsubscribe).toHaveBeenCalledTimes(1)
    expect(browser.disposed).toBe(true)
    expect(browser.serviceStore.getState().disposed).toBe(true)
  })

  it('终结性流错误写入状态并关闭订阅；迟到事件被 epoch 拒绝', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireThreadLease('t1')
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(1) }, 1))
    fake.emit(threadEvent({ type: 'error', error: '断流', terminal: true }, 2))
    expect(browser.serviceStore.getState().sessionDataById.t1?.lastError).toBe('断流')

    // 测试客户端仍保留监听器引用，模拟传输层晚到回调。
    fake.emit(threadEvent({ type: 'agent_start' }, 3))
    expect(browser.serviceStore.getState().threadsById.t1?.status).not.toBe('running')
    browser.reconnectThread('t1')
    expect(fake.client.subscribe).toHaveBeenCalledTimes(2)
    fake.emit(threadEvent({ type: 'snapshot', snapshot: snapshot(4) }, 4))
    expect(browser.serviceStore.getState().sessionDataById.t1?.lastError).toBeUndefined()
    release()
    await flushMicrotasks()
    browser.dispose()
  })
})

describe('createHarnessBrowser：MCP 认证轮询节奏', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('面板打开立即读取；空闲 2s、活动操作 1s，关闭且无活动操作后停止', async () => {
    vi.useFakeTimers()
    const fake = createFakeClient()
    const idle = { seq: 1, authRevision: 1, operations: [] }
    const active = {
      seq: 2,
      authRevision: 1,
      operations: [
        {
          id: 'op1',
          server: 'srv',
          identity: 'id',
          kind: 'login' as const,
          phase: 'waiting' as const,
          target: { kind: 'session' as const, workspacePath: '/workspace', threadId: 't1' },
          runtimeId: 'rt1',
          startedAt: '2026-11-02T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        },
      ],
    }
    vi.mocked(fake.client.getMcpAuth).mockResolvedValue(idle)
    const browser = createBrowser(fake.client)

    browser.acquireRoot()
    browser.setMcpAuthPanelOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(2)

    vi.mocked(fake.client.getMcpAuth).mockResolvedValue(active)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(3)
    expect(browser.serviceStore.getState().mcpAuth?.operations).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(4)

    // 面板关闭但仍有活动操作：继续轮询。
    browser.setMcpAuthPanelOpen(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(5)

    vi.mocked(fake.client.getMcpAuth).mockResolvedValue({ ...idle, seq: 3 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.client.getMcpAuth).toHaveBeenCalledTimes(6)
    browser.dispose()
  })
})
