import { type AppendMessage, isMessageNotSentError } from '@assistant-ui/react'
import type {
  HarnessAgentMessage,
  HarnessAssistantMessage,
  HarnessClient,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessHostUiRequest,
  HarnessSendMessageInput,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createHarnessHttpClient } from '../client/http-client.js'
import { HarnessThreadController } from './thread-controller.js'
import type { HarnessThreadState } from './thread-state.js'

const THREAD = 't1'

const snapshot = (over: Partial<HarnessThreadSnapshot> = {}): HarnessThreadSnapshot => ({
  metadata: { id: THREAD, status: 'idle' },
  messages: [],
  ...over,
})

type FakeClient = HarnessClient & {
  emit: (event: HarnessClientEvent) => void
  listeners: Set<(e: HarnessClientEvent) => void>
  subscribed: number
  subscribeOptions: Array<{ includeSnapshot?: boolean } | undefined>
  unsubscribed: number
  sent: Array<{ threadId: string; input: HarnessSendMessageInput }>
  cancelled: string[]
  queueCleared: string[]
  clearQueueResult: { steering: string[]; followUp: string[] }
  modelChanges: Array<{ threadId: string; provider: string; modelId: string }>
  thinkingChanges: Array<{ threadId: string; level: string }>
  hostUiResponses: Array<{ threadId: string; response: unknown }>
  getThreadSnapshot: HarnessThreadSnapshot
  /** 模拟真实宿主：带快照的订阅在首帧投递当前线程快照。默认关闭，避免影响
   * 不关心订阅首帧的既有用例。 */
  snapshotOnSubscribe: boolean
}

const createFakeClient = (initial: HarnessThreadSnapshot = snapshot()): FakeClient => {
  const listeners = new Set<(e: HarnessClientEvent) => void>()
  const client: FakeClient = {
    listeners,
    subscribed: 0,
    subscribeOptions: [],
    unsubscribed: 0,
    sent: [],
    cancelled: [],
    queueCleared: [],
    clearQueueResult: { steering: [], followUp: [] },
    modelChanges: [],
    thinkingChanges: [],
    hostUiResponses: [],
    getThreadSnapshot: initial,
    snapshotOnSubscribe: false,
    emit(event) {
      for (const l of listeners) l(event)
    },
    async getHostInfo() {
      throw new Error('Controller 不查询宿主信息')
    },
    async listWorkspaces() {
      return { workspaces: [], state: 'ok' as const }
    },
    async createWorkspace() {
      throw new Error('Controller 不创建工作区')
    },
    async updateWorkspace() {
      throw new Error('Controller 不修改工作区')
    },
    async assignThreadWorkspace() {
      throw new Error('Controller 不修改会话归属')
    },
    async listThreads() {
      return []
    },
    async createThread() {
      return snapshot()
    },
    async getThread() {
      return client.getThreadSnapshot
    },
    async getThreadDetails(threadId) {
      return {
        metadata: { ...client.getThreadSnapshot.metadata, id: threadId },
        stats: {
          userMessages: 0,
          assistantMessages: 0,
          toolResults: 0,
          toolCalls: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        },
        branchEntryCount: 0,
      }
    },
    async sendMessage(threadId, input) {
      client.sent.push({ threadId, input })
    },
    async cancelRun(threadId) {
      client.cancelled.push(threadId)
    },
    async clearQueue(threadId) {
      client.queueCleared.push(threadId)
      return client.clearQueueResult
    },
    async checkProjectPath() {
      return { input: '', path: '', exists: false, isDirectory: false }
    },
    async getProject() {
      throw new Error('Controller 不查询项目')
    },
    async inspectProjectTrust() {
      throw new Error('Controller 不查询项目信任摘要')
    },
    async decideProjectTrust() {
      throw new Error('Controller 不修改信任')
    },
    async listRecentProjects() {
      return []
    },
    async getAvailableModels() {
      return []
    },
    async setModel(threadId, input) {
      client.modelChanges.push({ threadId, ...input })
    },
    async setThinkingLevel(threadId, level) {
      client.thinkingChanges.push({ threadId, level })
    },
    async renameThread() {},
    async archiveThread() {},
    async unarchiveThread() {},
    async deleteThread() {},
    async respondToHostUiRequest(threadId, response) {
      client.hostUiResponses.push({ threadId, response })
    },
    subscribe(threadId, listener, options) {
      client.subscribed += 1
      client.subscribeOptions.push(options)
      listeners.add(listener)
      if (client.snapshotOnSubscribe && options?.includeSnapshot !== false) {
        // 与真实宿主一致：快照来自订阅建立时刻的服务端状态，异步投递。
        const current = client.getThreadSnapshot
        queueMicrotask(() => {
          if (!listeners.has(listener)) return
          client.emit({
            type: 'snapshot',
            threadId,
            seq: current.seq ?? 0,
            snapshot: current,
          } as HarnessClientEvent)
        })
      }
      return () => {
        listeners.delete(listener)
        client.unsubscribed += 1
      }
    },
  }
  return client
}

const assistantMessage = (text: string, timestamp = 1): HarnessAssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp,
})

const userMessage = (text: string, over: Partial<AppendMessage> = {}): AppendMessage =>
  ({
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: [],
    parentId: null,
    sourceId: null,
    runConfig: {},
    ...over,
  }) as AppendMessage

const userMessageWithImage = (text: string, image: string) =>
  userMessage(text, {
    content: [
      { type: 'text', text },
      { type: 'image', image },
    ],
  } as Partial<AppendMessage>)

const ev = (body: HarnessClientEventBody, seq: number): HarnessClientEvent =>
  ({ ...body, threadId: THREAD, seq }) as HarnessClientEvent

/** 等待假客户端把订阅首帧快照等微任务投递完（兼容假定时器）。 */
const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('HarnessThreadController', () => {
  it('seeds state from a snapshot on load and flips loadState', async () => {
    const client = createFakeClient(
      snapshot({
        metadata: { id: THREAD, status: 'running', title: 'Hi' },
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      }),
    )
    const controller = new HarnessThreadController(client, THREAD)
    expect(controller.getState().loadState).toBe('pending')

    await controller.load()

    const state = controller.getState()
    expect(state.loadState).toBe('loaded')
    expect(state.runStatus).toBe('running')
    expect(state.metadata.title).toBe('Hi')
    expect(state.messages).toHaveLength(1)
  })

  it('records the error and stays loaded when getThread rejects', async () => {
    const client = createFakeClient()
    client.getThread = async () => {
      throw new Error('boom')
    }
    const controller = new HarnessThreadController(client, THREAD)

    await expect(controller.load()).rejects.toThrow('boom')
    expect(controller.getState().lastError).toBe('boom')
    expect(controller.getState().loadState).toBe('loaded')
  })

  it('applies subscribed events and notifies listeners', () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const notify = vi.fn()
    controller.subscribe(notify)
    controller.connect()

    client.emit(ev({ type: 'agent_start' }, 1))
    expect(controller.getState().runStatus).toBe('running')
    expect(notify).toHaveBeenCalledTimes(1)

    client.emit(
      ev(
        {
          type: 'message_start',
          message: { role: 'user', content: 'hi', timestamp: 1 },
        },
        2,
      ),
    )
    expect(controller.getState().messages).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('ignores events addressed to a different thread', () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit({ type: 'agent_start', threadId: 'other', seq: 1 })
    expect(controller.getState().runStatus).toBe('idle')
  })

  it('sends an idle message with no streamingBehavior', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    await controller.sendMessage(userMessage('go'))
    expect(client.sent[0]!.input).toEqual({ content: 'go' })
  })

  it('derives followUp while running and honors a steer runConfig', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))

    await controller.sendMessage(userMessage('queued'))
    expect(client.sent[0]!.input.streamingBehavior).toBe('followUp')

    await controller.sendMessage(
      userMessage('now', {
        runConfig: { custom: { streamingBehavior: 'steer' } },
      }),
    )
    expect(client.sent[1]!.input.streamingBehavior).toBe('steer')
  })

  it('treats a locally accepted send as running before Pi emits agent_start', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.subscribe(() => {})

    await controller.sendMessage(userMessage('first'))
    await controller.sendMessage(userMessage('second'))

    expect(client.sent).toHaveLength(2)
    expect(client.sent[0]!.input).toEqual({ content: 'first' })
    expect(client.sent[1]!.input).toEqual({
      content: 'second',
      streamingBehavior: 'followUp',
    })
  })

  it('isolates subscriber errors while sending messages', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const listenerError = new Error('listener failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => consoleError.mockRestore())
    const laterListener = vi.fn()

    controller.subscribe(() => {
      throw listenerError
    })
    controller.subscribe(laterListener)

    await expect(controller.sendMessage(userMessage('hello'))).resolves.toBeUndefined()

    expect(client.sent).toHaveLength(1)
    expect(laterListener).toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith('[huan-react] Listener threw an error', listenerError)
  })

  it('maps image attachments to Pi image content', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    await controller.sendMessage(userMessageWithImage('look', 'data:image/png;base64,AAAA'))
    expect(client.sent[0]!.input.attachments).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ])
  })

  it('maps uppercase-scheme data URLs to Pi image content with a lowercase mime', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    await controller.sendMessage(userMessageWithImage('look', 'DATA:IMAGE/PNG;base64,AAAA'))
    expect(client.sent[0]!.input.attachments).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ])
  })

  it('maps parameterized base64 data URLs without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await controller.sendMessage(
      userMessageWithImage('look', 'data:image/png;charset=utf-8;base64,iVBORw=='),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(client.sent[0]!.input.attachments).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'iVBORw==' },
    ])
  })

  it('encodes URL image attachments before sending them to Pi', async () => {
    const image = 'https://cdn.example.com/image.png'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { 'content-type': 'image/png' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await controller.sendMessage(userMessageWithImage('look', image))

    expect(fetchMock).toHaveBeenCalledWith(image, {
      signal: expect.any(AbortSignal),
    })
    expect(client.sent[0]!.input.attachments).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAEC' },
    ])
  })

  it('preserves the declared type of percent-encoded data URLs', async () => {
    const image = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new TextEncoder().encode('<svg></svg>'), {
        headers: { 'content-type': 'image/svg+xml' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await controller.sendMessage(userMessageWithImage('look', image))

    expect(client.sent[0]!.input.attachments).toEqual([
      {
        type: 'image',
        mimeType: 'image/svg+xml',
        data: 'PHN2Zz48L3N2Zz4=',
      },
    ])
  })

  it('detects image bytes returned with a generic content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await controller.sendMessage(userMessageWithImage('look', 'https://cdn.example.com/image'))

    expect(client.sent[0]!.input.attachments?.[0]?.mimeType).toBe('image/png')
  })

  it('rejects non-image bytes returned with a generic content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0, 1, 2]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await expect(
      controller.sendMessage(userMessageWithImage('look', 'https://cdn.example.com/not-an-image')),
    ).rejects.toThrow('response does not contain image bytes')

    expect(client.sent).toHaveLength(0)
  })

  it.each([
    ['data:text/plain;base64,SGVsbG8=', 'unsupported content type: text/plain'],
    ['data:image/png;base64,A==', 'Invalid Pi image attachment source'],
    ['A==', 'Invalid Pi image attachment source'],
    ['file:///tmp/image.png', 'Unsupported Pi image attachment URL scheme'],
    ['/uploads/image.png', 'Invalid Pi image attachment source'],
  ])('rejects invalid image sources: %s', async (image, error) => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await expect(controller.sendMessage(userMessageWithImage('look', image))).rejects.toThrow(error)

    expect(client.sent).toHaveLength(0)
    expect(controller.getState()).toMatchObject({
      runStatus: 'failed',
      lastError: expect.stringContaining(error),
    })
    expect(controller.getProjectedMessages()).toHaveLength(0)
  })

  it('cancels the run via the client', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    await controller.cancel()
    expect(client.cancelled).toEqual([THREAD])
  })

  it('keeps a new run started during queue clearing out of a captured Stop', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))

    await controller.captureCancel()()
    expect(client.cancelled).toEqual([THREAD])
    client.cancelled.length = 0

    const clear = Promise.withResolvers<{
      steering: string[]
      followUp: string[]
    }>()
    client.clearQueue = vi.fn(() => clear.promise)
    const cancel = controller.captureCancel()
    const clearing = controller.clearQueue()

    client.emit(ev({ type: 'agent_end' }, 2))
    await controller.sendMessage(userMessage('new'))
    expect(controller.getState().runStatus).toBe('running')
    clear.resolve({ steering: [], followUp: [] })
    await clearing
    await cancel()

    expect(client.sent.map(({ input }) => input.content)).toEqual(['new'])
    expect(client.cancelled).toEqual([])
    expect(controller.getState().runStatus).toBe('running')
  })

  it('sets model and thinking level via the client', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await controller.setModel({ provider: 'anthropic', modelId: 'claude' })
    await controller.setThinkingLevel('high')

    expect(client.modelChanges).toEqual([
      { threadId: THREAD, provider: 'anthropic', modelId: 'claude' },
    ])
    expect(client.thinkingChanges).toEqual([{ threadId: THREAD, level: 'high' }])
  })

  it('answers a tool approval and optimistically clears the request', async () => {
    const request: HarnessHostUiRequest = {
      id: 'r1',
      kind: 'confirm',
      title: 'Run?',
      message: 'ok?',
      toolCallId: 'tc1',
    }
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'extension_ui_request', request }, 1))
    expect(controller.getState().hostUiRequests).toHaveLength(1)

    await controller.respondToToolApproval('r1', true)
    expect(client.hostUiResponses[0]!.response).toEqual({
      requestId: 'r1',
      confirmed: true,
    })
    expect(controller.getState().hostUiRequests).toHaveLength(0)
  })

  it('answers a select approval from a decision alone only by dismissing it', async () => {
    const request: HarnessHostUiRequest = {
      id: 'r4',
      kind: 'select',
      title: 'Deploy where?',
      options: ['staging', 'production'],
      toolCallId: 'tc1',
    }
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'extension_ui_request', request }, 1))

    await expect(controller.respondToToolApproval('r4', true)).rejects.toThrow(
      'Pi select request "r4" was not answered with one of its options',
    )
    expect(client.hostUiResponses).toEqual([])
    expect(controller.getState().hostUiRequests).toHaveLength(1)

    await controller.respondToToolApproval('r4', false)
    expect(client.hostUiResponses[0]!.response).toEqual({
      requestId: 'r4',
      dismissed: true,
    })
    expect(controller.getState().hostUiRequests).toHaveLength(0)
  })

  it('resumes a tool-call interrupt by toolCallId', async () => {
    const request: HarnessHostUiRequest = {
      id: 'r2',
      kind: 'input',
      title: 'Name?',
      toolCallId: 'tc9',
    }
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'extension_ui_request', request }, 1))

    await controller.resumeToolCall('tc9', 'Ada')
    expect(client.hostUiResponses[0]!.response).toEqual({
      requestId: 'r2',
      value: 'Ada',
    })
    expect(controller.getState().hostUiRequests).toHaveLength(0)
  })

  it('throws when resuming an unknown tool call', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    await expect(controller.resumeToolCall('nope', 'x')).rejects.toThrow(
      /No pending host-UI request/,
    )
  })

  it('defers disconnecting when the last listener unsubscribes (disconnect ≠ abort)', () => {
    vi.useFakeTimers()
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const unsub = controller.subscribe(() => {})
    unsub()
    expect(client.subscribed).toBe(0)
    expect(client.unsubscribed).toBe(0)

    vi.advanceTimersByTime(30_000)
    expect(client.unsubscribed).toBe(0)
    expect(client.cancelled).toEqual([])

    vi.useRealTimers()
  })

  it('keeps the event subscription while the active runtime retains it', () => {
    vi.useFakeTimers()
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const release = controller.connect()
    const unsub = controller.subscribe(() => {})

    unsub()
    vi.advanceTimersByTime(30_000)
    expect(client.unsubscribed).toBe(0)

    release()
    vi.advanceTimersByTime(30_000)
    expect(client.unsubscribed).toBe(1)

    vi.useRealTimers()
  })

  it('finishes local cleanup when the event unsubscribe throws', () => {
    const cleanupError = new Error('unsubscribe failed')
    const client = createFakeClient()
    const eventListeners: Array<(event: HarnessClientEvent) => void> = []
    client.subscribe = (_threadId, listener) => {
      const failsCleanup = eventListeners.length === 0
      eventListeners.push(listener)
      client.listeners.add(listener)
      return () => {
        if (failsCleanup) throw cleanupError
        client.listeners.delete(listener)
      }
    }
    const controller = new HarnessThreadController(client, THREAD)
    const notify = vi.fn()
    controller.subscribe(notify)
    controller.connect()

    expect(() => controller.dispose()).toThrow(cleanupError)

    controller.subscribe(notify)
    controller.connect()

    eventListeners[0]!(ev({ type: 'agent_start' }, 1))
    expect(notify).not.toHaveBeenCalled()
    expect(controller.getState().runStatus).toBe('idle')

    eventListeners[1]!(ev({ type: 'agent_start' }, 1))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(controller.getState().runStatus).toBe('running')
    expect(() => controller.dispose()).not.toThrow()
  })

  it('keeps thread switching on the read-only getThread path', async () => {
    const client = createFakeClient(
      snapshot({ messages: [{ role: 'user', content: 'one', timestamp: 1 }] }),
    )
    const first = new HarnessThreadController(client, 'thread-one')
    const second = new HarnessThreadController(client, 'thread-two')
    first.subscribe(() => {})
    second.subscribe(() => {})

    await first.load()
    client.getThreadSnapshot = snapshot({
      metadata: { id: 'thread-two', status: 'idle' },
      messages: [{ role: 'user', content: 'two', timestamp: 2 }],
    })
    await second.load()

    expect(client.subscribed).toBe(0)
    expect(first.getState().messages[0]).toMatchObject({ content: 'one' })
    expect(second.getState().messages[0]).toMatchObject({ content: 'two' })
  })

  it('full-refreshes from a snapshot on an unrecognized event type', async () => {
    const client = createFakeClient(
      snapshot({ messages: [{ role: 'user', content: 'x', timestamp: 1 }] }),
    )
    const getThread = vi.spyOn(client, 'getThread')
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    client.emit({
      type: 'some_future_event',
      threadId: THREAD,
      seq: 1,
    } as unknown as HarnessClientEvent)

    // refreshInBackground → getThread; await the microtask queue to settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(getThread).toHaveBeenCalled()
    expect(controller.getState().messages).toHaveLength(1)
  })

  it('ignores an HTTP snapshot that predates live events', async () => {
    const client = createFakeClient()
    let resolveSnapshot!: (snapshot: HarnessThreadSnapshot) => void
    client.getThread = () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    const load = controller.load()
    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('live', 1),
        },
        2,
      ),
    )
    resolveSnapshot(
      snapshot({
        seq: 1,
        messages: [],
      }),
    )
    await load

    expect(controller.getState()).toMatchObject({
      loadState: 'loaded',
      lastSeq: 2,
      messages: [assistantMessage('live', 1)],
    })
  })

  it('preserves live state and history when a cold HTTP snapshot has no sequence', async () => {
    const client = createFakeClient()
    let resolveSnapshot!: (snapshot: HarnessThreadSnapshot) => void
    client.getThread = () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
    const controller = new HarnessThreadController(client, THREAD)

    const load = controller.load()
    const send = controller.sendMessage(userMessage('instant'))
    expect(client.subscribeOptions[0]).toEqual({ includeSnapshot: true })

    const history = { role: 'user' as const, content: 'history', timestamp: 1 }
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({ seq: 0, messages: [history] }),
        },
        0,
      ),
    )
    client.emit(ev({ type: 'agent_start' }, 1))
    client.emit(ev({ type: 'message_start', message: assistantMessage('live', 2) }, 2))
    resolveSnapshot(snapshot({ messages: [history] }))

    await Promise.all([load, send])

    expect(controller.getState()).toMatchObject({
      loadState: 'loaded',
      lastSeq: 2,
      runStatus: 'running',
      messages: [history, assistantMessage('live', 2)],
    })
  })

  it('advances the event watermark from a current HTTP snapshot', async () => {
    const client = createFakeClient(
      snapshot({
        seq: 3,
        messages: [{ role: 'user', content: 'snapshot', timestamp: 1 }],
      }),
    )
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    await controller.load()
    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('stale', 2),
        },
        2,
      ),
    )

    expect(controller.getState()).toMatchObject({
      lastSeq: 3,
      messages: [{ role: 'user', content: 'snapshot', timestamp: 1 }],
    })
  })

  it('rebases from an HTTP snapshot after the supervisor sequence resets', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('old generation', 1),
        },
        5,
      ),
    )
    client.getThreadSnapshot = snapshot({
      seq: 0,
      messages: [{ role: 'user', content: 'new generation', timestamp: 2 }],
    })

    await controller.load()
    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('first live event', 3),
        },
        1,
      ),
    )

    expect(controller.getState()).toMatchObject({
      lastSeq: 1,
      messages: [
        { role: 'user', content: 'new generation', timestamp: 2 },
        assistantMessage('first live event', 3),
      ],
    })
  })

  it('ignores an HTTP response from before a stream sequence reset', async () => {
    const client = createFakeClient()
    let resolveSnapshot!: (snapshot: HarnessThreadSnapshot) => void
    client.getThread = () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('old generation', 1),
        },
        5,
      ),
    )

    const load = controller.load()
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({
            seq: 0,
            messages: [{ role: 'user', content: 'new generation', timestamp: 2 }],
          }),
        },
        0,
      ),
    )
    resolveSnapshot(
      snapshot({
        seq: 5,
        messages: [{ role: 'user', content: 'stale response', timestamp: 1 }],
      }),
    )
    await load

    expect(controller.getState()).toMatchObject({
      loadState: 'loaded',
      lastSeq: 0,
      messages: [{ role: 'user', content: 'new generation', timestamp: 2 }],
    })
  })

  it('does not refresh snapshots for settled or custom entry events', async () => {
    const client = createFakeClient()
    const getThread = vi.spyOn(client, 'getThread')
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    client.emit(ev({ type: 'agent_settled' }, 1))
    client.emit(
      ev(
        {
          type: 'entry_appended',
          entry: {
            type: 'custom',
            id: 'entry-1',
            parentId: null,
            timestamp: '2026-07-18T00:00:00.000Z',
            customType: 'extension-state',
            data: { enabled: true },
          },
        },
        2,
      ),
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(getThread).not.toHaveBeenCalled()
    expect(controller.getState().lastSeq).toBe(2)
  })

  it('refreshes snapshots for appended entry variants without companion events', async () => {
    const client = createFakeClient()
    const getThread = vi.spyOn(client, 'getThread')
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    client.emit(
      ev(
        {
          type: 'entry_appended',
          entry: {
            type: 'model_change',
            id: 'entry-1',
            parentId: null,
            timestamp: '2026-07-18T00:00:00.000Z',
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-5',
          },
        },
        1,
      ),
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(getThread).toHaveBeenCalledOnce()
  })

  it('refreshes when an older server omits the appended entry payload', async () => {
    const client = createFakeClient()
    const getThread = vi.spyOn(client, 'getThread')
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    client.emit({
      type: 'entry_appended',
      threadId: THREAD,
      seq: 1,
    } as unknown as HarnessClientEvent)

    await Promise.resolve()
    await Promise.resolve()
    expect(getThread).toHaveBeenCalledOnce()
  })

  it('shows an optimistic user message before send resolves', async () => {
    const client = createFakeClient()
    let resolveSend!: () => void
    client.sendMessage = async (threadId, input) => {
      client.sent.push({ threadId, input })
      await new Promise<void>((resolve) => {
        resolveSend = resolve
      })
    }
    const controller = new HarnessThreadController(client, THREAD)
    const notify = vi.fn()
    controller.subscribe(notify)

    const send = controller.sendMessage(userMessage('instant'))

    expect(controller.getProjectedMessages()).toHaveLength(1)
    expect(controller.getProjectedMessages()[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'instant' }],
    })
    expect(controller.getVersion()).toBeGreaterThan(0)
    expect(notify).toHaveBeenCalled()
    expect(client.subscribed).toBe(1)
    expect(client.subscribeOptions[0]).toEqual({ includeSnapshot: true })

    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    resolveSend()
    await send
  })

  it('shows URL image messages while their bytes are loading', async () => {
    let resolveResponse!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const image = 'https://cdn.example.com/image.png'

    const send = controller.sendMessage(userMessageWithImage('look', image))

    expect(controller.getState().runStatus).toBe('running')
    expect(controller.getProjectedMessages()[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', image },
      ],
    })
    expect(client.sent).toHaveLength(0)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    resolveResponse(
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { 'content-type': 'image/png' },
      }),
    )
    await send
  })

  it('preserves send order while URL image bytes are loading', async () => {
    let resolveResponse!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.sendMessage(
      userMessageWithImage('first', 'https://cdn.example.com/image.png'),
    )
    const second = controller.sendMessage(userMessage('second'))

    expect(controller.getState().queue.followUp).toEqual(['second'])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(client.sent).toHaveLength(0)

    resolveResponse(
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { 'content-type': 'image/png' },
      }),
    )
    await Promise.all([first, second])

    expect(client.sent.map(({ input }) => input.content)).toEqual(['first', 'second'])
    expect(client.sent[0]!.input.streamingBehavior).toBeUndefined()
    expect(client.sent[1]!.input.streamingBehavior).toBe('followUp')
  })

  it('aborts every send that has not reached Pi', async () => {
    let fetchSignal: AbortSignal | undefined
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined
          fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.sendMessage(
      userMessageWithImage('first', 'https://cdn.example.com/image.png'),
    )
    const firstResult = first.catch((error: unknown) => error)
    const second = controller.sendMessage(userMessage('second'))
    const secondResult = second.catch((error: unknown) => error)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await controller.cancel()
    const [firstError, secondError] = await Promise.all([firstResult, secondResult])

    expect(isMessageNotSentError(firstError)).toBe(true)
    expect(isMessageNotSentError(secondError)).toBe(true)
    expect(fetchSignal?.aborted).toBe(true)
    expect(client.sent).toHaveLength(0)
    expect(controller.getProjectedMessages()).toEqual([])
    expect(controller.getState()).toMatchObject({
      runStatus: 'idle',
      metadata: { status: 'idle' },
      queue: { steering: [], followUp: [] },
      lastError: undefined,
    })
  })

  it('cancels the first send that has not reached Pi', async () => {
    const accepted = Promise.withResolvers<void>()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    client.sendMessage = vi.fn(async (threadId, input) => {
      client.sent.push({ threadId, input })
      if (input.content === 'first') await accepted.promise
    })
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.sendMessage(userMessage('first'))
    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    const second = controller.sendMessage(
      userMessageWithImage('second', 'https://cdn.example.com/image.png'),
    )
    const secondResult = second.catch((error: unknown) => error)

    await controller.cancel()
    accepted.resolve()
    await first
    const secondError = await secondResult

    expect(isMessageNotSentError(secondError)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(client.sent.map(({ input }) => input.content)).toEqual(['first'])
  })

  it('contains image preparation abandoned by disposal', async () => {
    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined
            fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), {
              once: true,
            })
          }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const controller = new HarnessThreadController(createFakeClient(), THREAD)

    const send = controller.sendMessage(
      userMessageWithImage('look', 'https://cdn.example.com/image.png'),
    )
    await vi.waitFor(() => expect(fetchSignal).toBeDefined())
    controller.dispose()

    await expect(send).resolves.toBeUndefined()
    expect(fetchSignal?.aborted).toBe(true)
  })

  it('preserves failures from sends accepted before disposal', async () => {
    const accepted = Promise.withResolvers<void>()
    const sendError = new Error('send failed')
    const client = createFakeClient()
    client.sendMessage = vi.fn(async (threadId, input) => {
      client.sent.push({ threadId, input })
      await accepted.promise
      throw sendError
    })
    const controller = new HarnessThreadController(client, THREAD)
    const send = controller.sendMessage(userMessage('hello'))
    const sendResult = send.catch((error: unknown) => error)
    await vi.waitFor(() => expect(client.sent).toHaveLength(1))

    controller.dispose()
    accepted.resolve()

    expect(await sendResult).toBe(sendError)
  })

  it('reports foreign abort errors as send failures', async () => {
    const abortError = new DOMException('network interrupted', 'AbortError')
    const client = createFakeClient()
    client.sendMessage = vi.fn(async () => {
      throw abortError
    })
    const controller = new HarnessThreadController(client, THREAD)

    await expect(controller.sendMessage(userMessage('hello'))).rejects.toBe(abortError)
    expect(controller.getState()).toMatchObject({
      runStatus: 'failed',
      metadata: { status: 'failed' },
      lastError: 'network interrupted',
    })
    expect(controller.getProjectedMessages()).toEqual([])
  })

  it('keeps newer Pi state when an image send is cancelled', async () => {
    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined
            fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), {
              once: true,
            })
          }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const send = controller.sendMessage(
      userMessageWithImage('look', 'https://cdn.example.com/image.png'),
    )
    const sendResult = send.catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetchSignal).toBeDefined())

    client.emit(ev({ type: 'agent_start' }, 1))
    await controller.cancel()
    expect(isMessageNotSentError(await sendResult)).toBe(true)

    expect(controller.getState()).toMatchObject({
      runStatus: 'running',
      metadata: { status: 'running' },
      lastError: undefined,
    })
  })

  it('sends queued messages after failed image preparation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('missing', { status: 404, statusText: 'Not Found' })),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.sendMessage(
      userMessageWithImage('first', 'https://cdn.example.com/missing.png'),
    )
    const second = controller.sendMessage(userMessage('second'))
    const firstRejection = expect(first).rejects.toThrow(
      'Failed to load Pi image attachment: 404 Not Found',
    )

    await firstRejection
    await second

    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]!.input).toEqual({
      content: 'second',
      streamingBehavior: 'followUp',
    })
    expect(controller.getState().queue).toEqual({
      steering: [],
      followUp: [],
    })
    expect(controller.getState()).toMatchObject({
      runStatus: 'running',
      lastError: undefined,
      metadata: { status: 'running' },
    })
    expect(controller.getProjectedMessages()).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ])
  })

  it('restores a previous failure when image preparation is cancelled', async () => {
    const client = createFakeClient()
    client.sendMessage = vi.fn().mockRejectedValueOnce(new Error('previous send failed'))
    const controller = new HarnessThreadController(client, THREAD)

    await expect(controller.sendMessage(userMessage('first'))).rejects.toThrow(
      'previous send failed',
    )

    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined
            fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), {
              once: true,
            })
          }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })

    const send = controller.sendMessage(
      userMessageWithImage('second', 'https://cdn.example.com/image.png'),
    )
    const sendResult = send.catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetchSignal).toBeDefined())

    await controller.cancel()
    expect(isMessageNotSentError(await sendResult)).toBe(true)

    expect(controller.getState()).toMatchObject({
      runStatus: 'failed',
      lastError: 'previous send failed',
      metadata: { status: 'failed' },
    })
  })

  it('contains late image failures when another source is invalid', async () => {
    let rejectFetch!: (error: Error) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    onTestFinished(() => {
      process.off('unhandledRejection', onUnhandledRejection)
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const message = userMessage('look', {
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', image: 'https://cdn.example.com/image.png' },
        { type: 'image', image: 'file:///tmp/image.png' },
      ],
    } as Partial<AppendMessage>)

    const send = controller.sendMessage(message)
    const sendRejection = expect(send).rejects.toThrow(
      'Unsupported Pi image attachment URL scheme: file',
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await sendRejection

    rejectFetch(new Error('late fetch failure'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unhandledRejections).toEqual([])
  })

  it('rolls back URL image messages when loading fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('missing', { status: 404, statusText: 'Not Found' })),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await expect(
      controller.sendMessage(userMessageWithImage('look', 'https://cdn.example.com/missing.png')),
    ).rejects.toThrow('Failed to load Pi image attachment: 404 Not Found')

    expect(client.sent).toHaveLength(0)
    expect(controller.getProjectedMessages()).toHaveLength(0)
    expect(controller.getState()).toMatchObject({
      runStatus: 'failed',
      lastError: 'Failed to load Pi image attachment: 404 Not Found',
    })
  })

  it('reports image failures after unrelated Pi events', async () => {
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve
          }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const send = controller.sendMessage(
      userMessageWithImage('look', 'https://cdn.example.com/missing.png'),
    )
    const rejected = expect(send).rejects.toThrow(
      'Failed to load Pi image attachment: 404 Not Found',
    )
    await vi.waitFor(() => expect(resolveResponse).toBeDefined())
    client.emit(ev({ type: 'queue_update', steering: [], followUp: [] }, 1))
    resolveResponse(new Response('missing', { status: 404, statusText: 'Not Found' }))
    await rejected

    expect(controller.getState()).toMatchObject({
      runStatus: 'failed',
      metadata: { status: 'failed' },
      lastError: 'Failed to load Pi image attachment: 404 Not Found',
    })
  })

  it('preserves authoritative run status while reporting image failures', async () => {
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve
          }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const send = controller.sendMessage(
      userMessageWithImage('look', 'https://cdn.example.com/missing.png'),
    )
    const rejected = expect(send).rejects.toThrow(
      'Failed to load Pi image attachment: 404 Not Found',
    )
    await vi.waitFor(() => expect(resolveResponse).toBeDefined())
    client.emit(ev({ type: 'agent_start' }, 1))
    resolveResponse(new Response('missing', { status: 404, statusText: 'Not Found' }))
    await rejected

    expect(controller.getState()).toMatchObject({
      runStatus: 'running',
      metadata: { status: 'running' },
      lastError: 'Failed to load Pi image attachment: 404 Not Found',
    })
  })

  it.each([
    [
      'a non-image content type',
      new Response('not an image', {
        headers: { 'content-type': 'text/plain' },
      }),
      'unsupported content type: text/plain',
    ],
    [
      'no content type or recognized image bytes',
      new Response(new Uint8Array([0, 1, 2])),
      'response does not contain image bytes',
    ],
  ])('rejects URL image responses with %s', async (_, response, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await expect(
      controller.sendMessage(userMessageWithImage('look', 'https://cdn.example.com/not-an-image')),
    ).rejects.toThrow(error)

    expect(client.sent).toHaveLength(0)
    expect(controller.getState().lastError).toContain(error)
  })

  it('resubscribes on the next send after a decoder limit ends the stream', async () => {
    const sse = (body: string, keepOpen: boolean) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body))
            if (!keepOpen) controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`
    let eventStreams = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.endsWith('/events')) return new Response(null, { status: 204 })
      eventStreams += 1
      return eventStreams === 1
        ? sse(
            frame({
              ...ev({ type: 'agent_start' }, 1),
              padding: 'x'.repeat(2048),
            }),
            false,
          )
        : sse(
            frame(
              ev(
                {
                  type: 'message_start',
                  message: { role: 'user', content: 'again', timestamp: 2 },
                },
                2,
              ),
            ),
            true,
          )
    }) as unknown as typeof fetch
    const controller = new HarnessThreadController(
      createHarnessHttpClient({
        fetchImpl,
        maxStreamLineLength: 1024,
      }),
      THREAD,
    )
    onTestFinished(() => controller.dispose())
    controller.connect()
    await vi.waitFor(() => expect(controller.getState().runStatus).toBe('failed'))

    await controller.sendMessage(userMessage('again'))

    await vi.waitFor(() =>
      expect(controller.getState().messages).toEqual([
        { role: 'user', content: 'again', timestamp: 2 },
      ]),
    )
    expect(eventStreams).toBe(2)
  })

  it('requests the subscription snapshot even after a thread has loaded', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    await controller.load()
    await controller.sendMessage(userMessage('instant'))

    expect(client.subscribeOptions[0]).toEqual({ includeSnapshot: true })
  })

  it('reuses the open subscription on repeated connect', () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.connect()
    const second = controller.connect()

    expect(client.subscribed).toBe(1)
    expect(client.subscribeOptions).toEqual([{ includeSnapshot: true }])

    first()
    vi.advanceTimersByTime(30_000)
    expect(client.unsubscribed).toBe(0)

    second()
    vi.advanceTimersByTime(30_000)
    expect(client.unsubscribed).toBe(1)
  })

  it('refills events missed while disconnected from the new subscription snapshot', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const before = { role: 'user' as const, content: 'before', timestamp: 1 }
    const offline = { role: 'user' as const, content: 'offline', timestamp: 2 }
    const client = createFakeClient(snapshot({ seq: 1, messages: [before] }))
    client.snapshotOnSubscribe = true
    const controller = new HarnessThreadController(client, THREAD)

    await controller.load()
    const release = controller.connect()
    await flushMicrotasks()
    expect(controller.getState().messages).toEqual([before])

    release()
    vi.advanceTimersByTime(30_000)
    expect(client.unsubscribed).toBe(1)

    // 宽限期结束后确实断开了；离线期间服务端有新增消息。
    client.getThreadSnapshot = snapshot({ seq: 3, messages: [before, offline] })
    controller.connect()
    await flushMicrotasks()

    expect(client.subscribed).toBe(2)
    expect(client.subscribeOptions[1]).toEqual({ includeSnapshot: true })
    expect(controller.getState()).toMatchObject({
      lastSeq: 3,
      messages: [before, offline],
    })
  })

  it('keeps one optimistic message when the send opens a snapshot subscription', async () => {
    const client = createFakeClient()
    client.snapshotOnSubscribe = true
    let releaseSend!: () => void
    client.sendMessage = async (threadId, input) => {
      client.sent.push({ threadId, input })
      await new Promise<void>((resolve) => {
        releaseSend = resolve
      })
    }
    const controller = new HarnessThreadController(client, THREAD)
    await controller.load()

    const send = controller.sendMessage(userMessage('hello'))
    await flushMicrotasks()

    // 订阅首帧快照不含刚发出的消息，乐观消息只能显示一次。
    expect(client.subscribeOptions[0]).toEqual({ includeSnapshot: true })
    expect(controller.getProjectedMessages()).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])

    client.emit(
      ev(
        {
          type: 'message_start',
          message: { role: 'user', content: 'hello', timestamp: 2 },
        },
        2,
      ),
    )
    expect(
      controller.getProjectedMessages().filter((message) => message.role === 'user'),
    ).toHaveLength(1)

    releaseSend()
    await send
  })

  it('keeps an in-flight queued send when the new subscription snapshot omits it', async () => {
    const client = createFakeClient()
    let releaseSend!: () => void
    client.sendMessage = async (threadId, input) => {
      client.sent.push({ threadId, input })
      await new Promise<void>((resolve) => {
        releaseSend = resolve
      })
    }
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    // 关掉订阅，模拟发送时重建订阅（此时 runStatus 仍为 running）。
    controller.dispose()

    client.snapshotOnSubscribe = true
    client.getThreadSnapshot = snapshot({ seq: 2, metadata: { id: THREAD, status: 'running' } })
    const send = controller.sendMessage(userMessage('queued'))
    await flushMicrotasks()

    expect(client.subscribeOptions[1]).toEqual({ includeSnapshot: true })
    expect(controller.getState().queue.followUp).toEqual(['queued'])

    // 服务端确认后仍只有一条，不重复。
    client.emit(ev({ type: 'queue_update', steering: [], followUp: ['queued'] }, 3))
    expect(controller.getState().queue.followUp).toEqual(['queued'])

    releaseSend()
    await send
  })

  it('rolls back a queued send that a subscription snapshot had re-mirrored', async () => {
    const client = createFakeClient()
    let rejectSend!: (error: Error) => void
    client.sendMessage = () =>
      new Promise<void>((_, reject) => {
        rejectSend = reject
      })
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    controller.dispose()

    client.snapshotOnSubscribe = true
    client.getThreadSnapshot = snapshot({ seq: 2, metadata: { id: THREAD, status: 'running' } })
    const send = controller.sendMessage(userMessage('queued'))
    await flushMicrotasks()
    expect(controller.getState().queue.followUp).toEqual(['queued'])

    rejectSend(new Error('nope'))
    await expect(send).rejects.toThrow('nope')
    expect(controller.getState().queue.followUp).toEqual([])
  })

  it('does not revive a consumed queued send while its HTTP response is pending', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    onTestFinished(() => controller.dispose())
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    let release!: () => void
    client.sendMessage = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const send = controller.sendMessage(userMessage('consumed'))
    await vi.waitFor(() => expect(release).toBeDefined())

    client.emit(ev({ type: 'queue_update', steering: [], followUp: ['consumed'] }, 2))
    client.emit(ev({ type: 'queue_update', steering: [], followUp: [] }, 3))
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({
            metadata: { id: THREAD, status: 'running' },
            messages: [{ role: 'user', content: 'consumed', timestamp: 2 }],
          }),
        },
        4,
      ),
    )
    release()
    await send
    expect(controller.getState().queue.followUp).toEqual([])
  })

  it('does not revive a pending send after a snapshot has already confirmed it', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    onTestFinished(() => controller.dispose())
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    let release!: () => void
    client.sendMessage = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const send = controller.sendMessage(userMessage('confirmed'))
    await vi.waitFor(() => expect(release).toBeDefined())
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({
            metadata: {
              id: THREAD,
              status: 'running',
              queuedMessages: [{ id: 'q', mode: 'followUp', content: 'confirmed' }],
            },
          }),
        },
        2,
      ),
    )
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({
            metadata: {
              id: THREAD,
              status: 'running',
            },
          }),
        },
        3,
      ),
    )
    release()
    await send
    expect(controller.getState().queue.followUp).toEqual([])
  })

  it('does not restore an accepted queue entry after clearQueue or cancel', async () => {
    for (const action of ['clearQueue', 'cancel'] as const) {
      const client = createFakeClient()
      const controller = new HarnessThreadController(client, THREAD)
      onTestFinished(() => controller.dispose())
      controller.connect()
      client.emit(ev({ type: 'agent_start' }, 1))
      let release!: () => void
      client.sendMessage = () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
      const send = controller.sendMessage(userMessage('cleared'))
      await vi.waitFor(() => expect(release).toBeDefined())
      await controller[action]()
      client.emit(
        ev(
          {
            type: 'snapshot',
            snapshot: snapshot({
              metadata: {
                id: THREAD,
                status: 'running',
              },
            }),
          },
          2,
        ),
      )
      release()
      await send
      expect(controller.getState().queue.followUp).toEqual([])
    }
  })

  it('does not restore a queued send after it has been promoted to a normal message', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    onTestFinished(() => controller.dispose())
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    const send = controller.sendMessage(userMessage('promoted'))
    client.emit(ev({ type: 'agent_end' }, 2))
    let release!: () => void
    client.sendMessage = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    await vi.waitFor(() => expect(release).toBeDefined())
    client.emit(ev({ type: 'snapshot', snapshot: snapshot() }, 3))
    release()
    await send
    expect(controller.getState().queue.followUp).toEqual([])
    expect(controller.getProjectedMessages()).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'promoted' }] },
    ])
  })

  it('removes both local queue entries when serialized sends fail after a snapshot', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    onTestFinished(() => controller.dispose())
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    let rejectFirst!: (reason: Error) => void
    let calls = 0
    client.sendMessage = () => {
      calls += 1
      if (calls === 1)
        return new Promise<void>((_, reject) => {
          rejectFirst = reject
        })
      return Promise.reject(new Error('second rejected'))
    }
    const first = controller.sendMessage(userMessage('same')).catch((error: unknown) => error)
    const second = controller.sendMessage(userMessage('same')).catch((error: unknown) => error)
    await vi.waitFor(() => expect(rejectFirst).toBeDefined())
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({
            metadata: {
              id: THREAD,
              status: 'running',
            },
          }),
        },
        2,
      ),
    )
    expect(controller.getState().queue.followUp).toEqual(['same', 'same'])
    rejectFirst(new Error('first rejected'))
    expect(await first).toBeInstanceOf(Error)
    expect(await second).toBeInstanceOf(Error)
    expect(controller.getState().queue.followUp).toEqual([])
  })

  it('does not let a late HTTP load overwrite subscription snapshot events', async () => {
    const history = { role: 'user' as const, content: 'history', timestamp: 1 }
    const client = createFakeClient(snapshot({ seq: 2, messages: [history] }))
    client.snapshotOnSubscribe = true
    let resolveLoad!: (snapshot: HarnessThreadSnapshot) => void
    client.getThread = () =>
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    await flushMicrotasks()
    expect(controller.getState().lastSeq).toBe(2)

    const load = controller.load()
    client.emit(ev({ type: 'message_start', message: assistantMessage('live', 2) }, 3))
    resolveLoad(snapshot({ seq: 2, messages: [history] }))
    await load

    expect(controller.getState()).toMatchObject({
      loadState: 'loaded',
      lastSeq: 3,
      messages: [history, assistantMessage('live', 2)],
    })
  })

  it('does not dispatch an idle send cancelled by its optimistic notification', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    let cancelled = false
    const unsubscribe = controller.subscribe(() => {
      if (cancelled || controller.getState().runStatus !== 'running') return
      cancelled = true
      void controller.cancel()
    })

    const error = await controller
      .sendMessage(userMessage('cancelled'))
      .catch((reason: unknown) => reason)

    unsubscribe()
    expect(cancelled).toBe(true)
    expect(isMessageNotSentError(error)).toBe(true)
    expect(client.sent).toHaveLength(0)
  })

  it('removes a cold-cancelled optimistic message before the next send', async () => {
    const client = createFakeClient()
    let resolveFirstSend!: () => void
    client.sendMessage = async (threadId, input) => {
      client.sent.push({ threadId, input })
      if (client.sent.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstSend = resolve
        })
      }
    }
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.sendMessage(userMessage('cancelled'))
    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    client.emit(ev({ type: 'agent_end', cancelledBeforeStart: true }, 1))
    resolveFirstSend()
    await first

    expect(controller.getState()).toMatchObject({
      runStatus: 'idle',
      lastError: undefined,
    })
    expect(controller.getProjectedMessages()).toHaveLength(0)

    await controller.sendMessage(userMessage('next'))
    client.emit(
      ev(
        {
          type: 'message_start',
          message: { role: 'user', content: 'next', timestamp: 1 },
        },
        2,
      ),
    )
    client.emit(ev({ type: 'message_start', message: assistantMessage('reply') }, 3))
    client.emit(ev({ type: 'agent_end' }, 4))

    expect(controller.getProjectedMessages()).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ])
  })

  it('rolls back the optimistic running mark when a send rejects', async () => {
    const client = createFakeClient()
    client.sendMessage = async () => {
      throw new Error('nope')
    }
    const controller = new HarnessThreadController(client, THREAD)

    await expect(controller.sendMessage(userMessage('hi'))).rejects.toThrow('nope')

    const state = controller.getState()
    expect(state.runStatus).toBe('failed')
    expect(state.metadata.status).toBe('failed')
    expect(state.lastError).toBe('nope')
    expect(controller.getProjectedMessages()).toHaveLength(0)
  })

  it('mirrors a mid-run send into the queue instead of the transcript', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))

    await controller.sendMessage(userMessage('queued'))
    expect(controller.getProjectedMessages()).toHaveLength(0)
    expect(controller.getState().queue.followUp).toEqual(['queued'])

    await controller.sendMessage(
      userMessage('now', {
        runConfig: { custom: { streamingBehavior: 'steer' } },
      }),
    )
    expect(controller.getState().queue.steering).toEqual(['now'])

    // Pi's authoritative queue_update replaces the optimistic mirror wholesale.
    client.emit(ev({ type: 'queue_update', steering: ['now'], followUp: ['queued'] }, 2))
    expect(controller.getState().queue).toEqual({
      steering: ['now'],
      followUp: ['queued'],
    })
  })

  it('rolls back the optimistic queue entry when a mid-run send rejects', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    client.sendMessage = async () => {
      throw new Error('nope')
    }

    await expect(controller.sendMessage(userMessage('hi'))).rejects.toThrow('nope')

    const state = controller.getState()
    expect(state.queue.followUp).toEqual([])
    expect(state.lastError).toBe('nope')
    // The run itself is unaffected by a failed enqueue.
    expect(state.runStatus).toBe('running')
  })

  it('does not remove a surviving identical message when an earlier send fails', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))

    let failFirst!: () => void
    const firstFailed = new Promise<void>((_, reject) => {
      failFirst = () => reject(new Error('first failed'))
    })
    const sendMessage = vi.fn(async () => {
      await firstFailed
    })
    client.sendMessage = sendMessage
    const first = controller.sendMessage(userMessage('hello'))

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())

    // Another client has queued the same text while this request is pending.
    client.emit(ev({ type: 'queue_update', steering: [], followUp: ['hello'] }, 2))
    expect(controller.getState().queue.followUp).toEqual(['hello'])

    failFirst()
    await expect(first).rejects.toThrow('first failed')

    expect(controller.getState().queue.followUp).toEqual(['hello'])
  })

  it('does not remove a surviving identical message reconciled by a snapshot', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))

    let failFirst!: () => void
    const firstFailed = new Promise<void>((_, reject) => {
      failFirst = () => reject(new Error('first failed'))
    })
    const sendMessage = vi.fn(async () => {
      await firstFailed
    })
    client.sendMessage = sendMessage
    const first = controller.sendMessage(userMessage('hello'))

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())

    // A snapshot on (re)connect/refresh also reconciles the queue wholesale —
    // down to the one genuinely-queued "hello" — without a queue_update.
    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: snapshot({
            metadata: {
              id: THREAD,
              status: 'running',
              queuedMessages: [{ id: 'q1', mode: 'followUp', content: 'hello' }],
            },
          }),
        },
        2,
      ),
    )
    expect(controller.getState().queue.followUp).toEqual(['hello'])

    failFirst()
    await expect(first).rejects.toThrow('first failed')

    expect(controller.getState().queue.followUp).toEqual(['hello'])
  })

  it('does not dispatch a queued send cancelled during optimistic promotion', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    const sending = controller.sendMessage(userMessage('queued'))
    const result = sending.catch((error: unknown) => error)
    client.emit(ev({ type: 'agent_end' }, 2))
    let cancelled = false
    const unsubscribe = controller.subscribe(() => {
      if (cancelled || controller.getState().runStatus !== 'running') return
      cancelled = true
      void controller.cancel()
    })
    const error = await result
    unsubscribe()
    expect(cancelled).toBe(true)
    expect(isMessageNotSentError(error)).toBe(true)
    expect(client.sent).toHaveLength(0)
  })

  it('does not dispatch a queued send cleared by its optimistic notification', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    let clearing: ReturnType<HarnessThreadController['clearQueue']> | undefined
    const unsubscribe = controller.subscribe(() => {
      if (clearing || !controller.getState().queue.followUp.includes('queued')) {
        return
      }
      clearing = controller.clearQueue()
    })

    await expect(controller.sendMessage(userMessage('queued'))).resolves.toBeUndefined()
    expect(clearing).toBeDefined()
    await expect(clearing).resolves.toEqual({
      steering: [],
      followUp: ['queued'],
    })

    unsubscribe()
    expect(client.sent).toHaveLength(0)
    expect(controller.getState().queue.followUp).toEqual([])
  })

  it('clears the queue via the client and returns the cleared text', async () => {
    const client = createFakeClient()
    client.clearQueueResult = { steering: ['a'], followUp: ['b', 'c'] }
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    await controller.sendMessage(userMessage('b'))

    const cleared = await controller.clearQueue()

    expect(client.queueCleared).toEqual([THREAD])
    expect(cleared).toEqual({ steering: ['a'], followUp: ['b', 'c'] })
    expect(controller.getState().queue).toEqual({
      steering: [],
      followUp: [],
    })
  })

  it('clears a queued send parked behind image preparation', async () => {
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve
          }),
      ),
    )
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)

    const first = controller.sendMessage(
      userMessageWithImage('first', 'https://cdn.example.com/image.png'),
    )
    const second = controller.sendMessage(userMessage('second'))
    await vi.waitFor(() => expect(controller.getState().queue.followUp).toEqual(['second']))

    await expect(controller.clearQueue()).resolves.toEqual({
      steering: [],
      followUp: ['second'],
    })
    expect(controller.getState().queue).toEqual({
      steering: [],
      followUp: [],
    })

    resolveResponse(
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { 'content-type': 'image/png' },
      }),
    )
    await first
    await expect(second).resolves.toBeUndefined()
    expect(client.sent.map(({ input }) => input.content)).toEqual(['first'])
  })

  it('does not empty a queue that a newer message repopulated before the clear response', async () => {
    const client = createFakeClient()
    let resolveClear!: () => void
    client.clearQueue = async (threadId) => {
      client.queueCleared.push(threadId)
      await new Promise<void>((resolve) => {
        resolveClear = resolve
      })
      return client.clearQueueResult
    }
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    await controller.sendMessage(userMessage('old'))

    const clearing = controller.clearQueue()

    // The server clears, then a newer message is queued and confirmed while the
    // clear response is still in flight.
    client.emit(ev({ type: 'queue_update', steering: [], followUp: [] }, 2))
    client.emit(ev({ type: 'queue_update', steering: [], followUp: ['new'] }, 3))
    expect(controller.getState().queue.followUp).toEqual(['new'])

    resolveClear()
    await clearing

    // The stale clear response must not wipe the newer message.
    expect(controller.getState().queue.followUp).toEqual(['new'])
  })

  it('does not empty a queue an optimistic sendQueued repopulated before the clear response', async () => {
    const client = createFakeClient()
    let resolveClear!: () => void
    client.clearQueue = async (threadId) => {
      client.queueCleared.push(threadId)
      await new Promise<void>((resolve) => {
        resolveClear = resolve
      })
      return client.clearQueueResult
    }
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()
    client.emit(ev({ type: 'agent_start' }, 1))
    await controller.sendMessage(userMessage('old'))

    const clearing = controller.clearQueue()

    // A new mid-run send optimistically repopulates the queue while the clear
    // response is still in flight (no server queue_update involved).
    await controller.sendMessage(userMessage('new'))
    expect(controller.getState().queue.followUp).toEqual(['old', 'new'])

    resolveClear()
    await clearing

    // The stale clear response must not wipe the optimistic entry.
    expect(controller.getState().queue.followUp).toEqual(['old', 'new'])
  })

  it('reconciles an optimistic message against an enriched echo', async () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    controller.connect()

    await controller.sendMessage(userMessage('look'))
    expect(controller.getProjectedMessages()).toHaveLength(1)

    // The echoed transcript message carries array content with extra fields —
    // structurally different from the optimistic string content, same text.
    client.emit(
      ev(
        {
          type: 'message_start',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
            timestamp: 2,
          },
        },
        1,
      ),
    )

    const projected = controller.getProjectedMessages()
    expect(projected.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('coalesces high-frequency stream notifications', () => {
    const client = createFakeClient()
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    const notify = vi.fn()
    controller.subscribe(notify)
    controller.connect()

    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('', 1),
        },
        1,
      ),
    )
    notify.mockClear()

    for (let i = 0; i < 1000; i++) {
      client.emit(
        ev(
          {
            type: 'message_update',
            message: assistantMessage(`token-${i}`, 1),
            assistantMessageEvent: {
              type: 'text_delta',
              contentIndex: 0,
              delta: `token-${i}`,
              partial: assistantMessage(`token-${i}`, 1),
            },
          },
          i + 2,
        ),
      )
    }

    expect(scheduled).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()

    scheduled[0]!()

    expect(notify).toHaveBeenCalledTimes(1)
    expect(controller.getProjectedMessages()[0]!.content).toMatchObject([
      { type: 'text', text: 'token-999' },
    ])
  })

  it('preserves unchanged projected message identities across a stream delta', () => {
    const client = createFakeClient(
      snapshot({
        messages: [{ role: 'user', content: 'stable', timestamp: 1 }],
      }),
    )
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    controller.connect()

    client.emit(
      ev(
        {
          type: 'snapshot',
          snapshot: client.getThreadSnapshot,
        },
        1,
      ),
    )
    client.emit(
      ev(
        {
          type: 'message_start',
          message: assistantMessage('a', 2),
        },
        2,
      ),
    )

    const before = controller.getProjectedMessages()
    const stableUser = before[0]!
    const stableRepositoryItem = controller.getMessageRepository().messages[0]

    client.emit(
      ev(
        {
          type: 'message_update',
          message: assistantMessage('ab', 2),
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'b',
            partial: assistantMessage('ab', 2),
          },
        },
        3,
      ),
    )
    scheduled[0]!()

    const after = controller.getProjectedMessages()
    expect(after[0]).toBe(stableUser)
    expect(after[1]).not.toBe(before[1])
    expect(after[1]!.content).toMatchObject([{ type: 'text', text: 'ab' }])
    expect(controller.getMessageRepository().messages[0]).toBe(stableRepositoryItem)
    expect(controller.getMessageRepository().messages[1]!.parentId).toBe(
      stableRepositoryItem!.message.id,
    )
  })

  it('does not revisit the unchanged transcript prefix for a stream delta', () => {
    let prefixRoleReads = 0
    const stableMessages = Array.from({ length: 500 }, (_, index) => {
      const message = {
        content: `message-${index}`,
        timestamp: index,
      }
      Object.defineProperty(message, 'role', {
        enumerable: true,
        get: () => {
          prefixRoleReads += 1
          return 'user'
        },
      })
      return message as HarnessAgentMessage
    })
    const client = createFakeClient(snapshot({ messages: stableMessages }))
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    controller.connect()

    client.emit(ev({ type: 'snapshot', snapshot: client.getThreadSnapshot }, 1))
    client.emit(ev({ type: 'message_start', message: assistantMessage('a', 501) }, 2))
    prefixRoleReads = 0

    client.emit(
      ev(
        {
          type: 'message_update',
          message: assistantMessage('ab', 501),
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'b',
            partial: assistantMessage('ab', 501),
          },
        },
        3,
      ),
    )
    scheduled.at(-1)!()

    expect(prefixRoleReads).toBe(2)
  })
})

describe('HarnessThreadController state snapshot', () => {
  it('holds the snapshot steady while a coalesced message frame is pending', () => {
    const client = createFakeClient()
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    const notify = vi.fn()
    controller.subscribe(notify)
    controller.connect()

    client.emit(ev({ type: 'message_start', message: assistantMessage('', 1) }, 1))
    const settled = controller.getStateSnapshot()
    expect(settled).toBe(controller.getState())
    notify.mockClear()

    client.emit(
      ev(
        {
          type: 'message_update',
          message: assistantMessage('a', 1),
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'a',
            partial: assistantMessage('a', 1),
          },
        },
        2,
      ),
    )

    expect(controller.getState()).not.toBe(settled)
    expect(controller.getStateSnapshot()).toBe(settled)
    expect(notify).not.toHaveBeenCalled()

    scheduled.at(-1)!()

    expect(controller.getStateSnapshot()).toBe(controller.getState())
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('advances the snapshot to live state on every notification', () => {
    const client = createFakeClient()
    const controller = new HarnessThreadController(client, THREAD)
    const seen: HarnessThreadState[] = []
    controller.subscribe(() => seen.push(controller.getStateSnapshot()))
    controller.connect()

    client.emit(ev({ type: 'queue_update', steering: ['now'], followUp: [] }, 1))
    client.emit(
      ev(
        {
          type: 'message_start',
          message: { role: 'user', content: 'hi', timestamp: 1 },
        },
        2,
      ),
    )

    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(seen[1]).toBe(controller.getState())
  })

  it('publishes state when a message event leaves the projection unchanged', () => {
    const client = createFakeClient()
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    const notify = vi.fn()
    const notifyMetadata = vi.fn()
    controller.subscribe(notify)
    controller.subscribeMetadata(notifyMetadata)
    controller.connect()

    client.emit(ev({ type: 'message_start', message: assistantMessage('', 1) }, 1))
    client.emit(
      ev(
        {
          type: 'message_update',
          message: assistantMessage('a', 1),
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'a',
            partial: assistantMessage('a', 1),
          },
        },
        2,
      ),
    )
    scheduled.at(-1)!()
    const projection = controller.getMessageRepository()
    notify.mockClear()
    notifyMetadata.mockClear()

    client.emit(ev({ type: 'message_end', message: assistantMessage('a', 1) }, 3))

    expect(controller.getMessageRepository()).toBe(projection)
    expect(controller.getState().streamingMessageIndex).toBeUndefined()
    expect(controller.getStateSnapshot()).toBe(controller.getState())
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notifyMetadata).not.toHaveBeenCalled()
  })

  it('does not notify when neither the projection nor state moved', () => {
    const client = createFakeClient()
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    const notify = vi.fn()
    controller.subscribe(notify)
    controller.connect()

    client.emit(ev({ type: 'message_start', message: assistantMessage('', 1) }, 1))
    notify.mockClear()

    // A stale-seq event the reducer drops entirely.
    client.emit(ev({ type: 'message_start', message: assistantMessage('', 1) }, 0))

    expect(notify).not.toHaveBeenCalled()
    expect(controller.getStateSnapshot()).toBe(controller.getState())
  })

  it('starts the snapshot at the initial state', () => {
    const controller = new HarnessThreadController(createFakeClient(), THREAD)
    expect(controller.getStateSnapshot()).toBe(controller.getState())
  })

  // A metadata notification publishes whatever the reducer has already applied,
  // including a message frame whose projection has not been flushed yet, so
  // state leads the repository until the frame lands.
  it('publishes live state on a metadata notification mid-frame', () => {
    const client = createFakeClient()
    const scheduled: Array<() => void> = []
    const controller = new HarnessThreadController(client, THREAD, {
      scheduleNotify: (flush) => scheduled.push(flush),
    })
    controller.subscribe(() => {})
    controller.connect()

    client.emit(ev({ type: 'message_start', message: assistantMessage('', 1) }, 1))
    const repositoryBeforeFrame = controller.getMessageRepository()

    client.emit(
      ev(
        {
          type: 'message_update',
          message: assistantMessage('a', 1),
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'a',
            partial: assistantMessage('a', 1),
          },
        },
        2,
      ),
    )
    client.emit(ev({ type: 'queue_update', steering: ['now'], followUp: [] }, 3))

    expect(controller.getStateSnapshot()).toBe(controller.getState())
    expect(controller.getMessageRepository()).toBe(repositoryBeforeFrame)

    scheduled.at(-1)!()

    expect(controller.getMessageRepository()).not.toBe(repositoryBeforeFrame)
    expect(controller.getStateSnapshot()).toBe(controller.getState())
  })
})
