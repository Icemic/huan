import type {
  HarnessClient,
  HarnessClientEvent,
  HarnessCreateThreadInput,
  HarnessHostInfo,
  HarnessSendMessageInput,
  HarnessSendMessageResult,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarnessBrowser, type HarnessBrowser } from './create-browser.js'
import type { HarnessDraftTarget } from './window-store.js'

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

const snapshotOf = (
  threadId: string,
  metadata: Partial<HarnessThreadSnapshot['metadata']> = {},
): HarnessThreadSnapshot => ({
  metadata: {
    id: threadId,
    status: 'idle',
    workspacePath: '/workspace',
    config: { provider: 'provider', modelId: 'model', thinkingLevel: 'medium' },
    ...metadata,
  },
  messages: [],
  messageEntryIds: [],
  seq: 1,
})

const models = [
  {
    provider: 'provider',
    modelId: 'model',
    input: ['text', 'image'] as const,
    availableThinkingLevels: ['off', 'medium', 'high'] as const,
  },
]

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const pngBytes = (): ArrayBuffer =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer

const imageBlob = (): Blob => new Blob([pngBytes()], { type: 'image/png' })

/** 让图片准备停在 arrayBuffer 上，用于串行/取消断言。 */
const controlledImageBlob = () => {
  const gate = deferred<void>()
  const blob = {
    arrayBuffer: async () => {
      await gate.promise
      return pngBytes()
    },
  } as unknown as Blob
  return { blob, release: () => gate.resolve() }
}

const createFakeClient = (overrides: Partial<HarnessClient> = {}) => {
  const created: HarnessCreateThreadInput[] = []
  const sent: { threadId: string; input: HarnessSendMessageInput }[] = []
  const canceled: string[] = []
  const queueCleared: string[] = []
  const modelChanges: { threadId: string; provider: string; modelId: string }[] = []
  const thinkingChanges: { threadId: string; level: string }[] = []
  const listeners = new Map<string, Set<(event: HarnessClientEvent) => void>>()
  let subscribeCount = 0
  let sendResult: HarnessSendMessageResult = { disposition: 'started' }
  let sendError: unknown
  let sendBarrier: Promise<void> | undefined

  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    getProviderAuth: vi.fn(async () => ({
      seq: 1,
      authRevision: 1,
      providers: [],
      operations: [],
    })),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    listThreads: vi.fn(async () => []),
    getThread: vi.fn(async (threadId: string) => snapshotOf(threadId)),
    getThreadTree: vi.fn(async (threadId: string) => ({
      threadId,
      leafId: null,
      revision: 'v1:0:null',
      nodes: [],
      branchSummarySkipPrompt: true,
    })),
    getAvailableModels: vi.fn(async () => models),
    createThread: vi.fn(async (input: HarnessCreateThreadInput = {}) => {
      created.push(input)
      return snapshotOf('created-1', {
        workspaceId: input.workspaceId,
        workspacePath: input.startProjectPath,
        config: {
          provider: input.model?.provider ?? 'provider',
          modelId: input.model?.modelId ?? 'model',
          thinkingLevel: input.thinkingLevel ?? 'medium',
        },
      })
    }),
    sendMessage: vi.fn(async (threadId: string, input: HarnessSendMessageInput) => {
      sent.push({ threadId, input })
      if (sendBarrier) await sendBarrier
      if (sendError) throw sendError
      return sendResult
    }),
    runThreadBash: vi.fn(async () => ({
      status: 'started' as const,
      run: {
        id: 'bash-1',
        command: 'pwd',
        excludeFromContext: false,
        cwd: '/workspace',
        status: 'running' as const,
        output: '',
        outputTruncated: false,
        startedAt: new Date().toISOString(),
      },
    })),
    cancelRun: vi.fn(async (threadId: string) => {
      canceled.push(threadId)
    }),
    clearQueue: vi.fn(async (threadId: string) => {
      queueCleared.push(threadId)
      return { steering: ['server-steer'], followUp: ['server-follow'] }
    }),
    setModel: vi.fn(async (threadId: string, input: { provider: string; modelId: string }) => {
      modelChanges.push({ threadId, ...input })
    }),
    setThinkingLevel: vi.fn(async (threadId: string, level: string) => {
      thinkingChanges.push({ threadId, level })
    }),
    subscribe: vi.fn((threadId: string, listener: (event: HarnessClientEvent) => void) => {
      subscribeCount += 1
      let set = listeners.get(threadId)
      if (!set) {
        set = new Set()
        listeners.set(threadId, set)
      }
      set.add(listener)
      return () => set?.delete(listener)
    }),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as HarnessClient

  return {
    client,
    created,
    sent,
    canceled,
    queueCleared,
    modelChanges,
    thinkingChanges,
    emit(event: HarnessClientEvent) {
      for (const listener of listeners.get(event.threadId) ?? []) listener(event)
    },
    get subscribeCount() {
      return subscribeCount
    },
    setSendResult(result: HarnessSendMessageResult) {
      sendResult = result
    },
    setSendError(error: unknown) {
      sendError = error
    },
    setSendBarrier(barrier: Promise<void>) {
      sendBarrier = barrier
    },
  }
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })

const newTarget: HarnessDraftTarget = {
  kind: 'new',
  workspaceId: 'workspace-1',
  startProjectPath: '/workspace',
}

const select = (browser: HarnessBrowser, target: HarnessDraftTarget) => {
  browser.windowStore.getState().selectTarget(target)
  return target.kind === 'thread'
    ? `thread:${target.threadId}`
    : `new:${encodeURIComponent(target.workspaceId ?? '')}:${encodeURIComponent(target.startProjectPath)}`
}

const selectThread = (browser: HarnessBrowser, threadId = 't1') => {
  select(browser, { kind: 'thread', threadId })
  return `thread:${threadId}`
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('session-actions：创建与发送', () => {
  it('固定捕获并走创建→threadId→发送，显式传模型/Thinking/附件', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = select(browser, newTarget)
    browser.windowStore.getState().editDraftText(draftId, 'hello')
    browser.windowStore
      .getState()
      .setDraftModel(draftId, { provider: 'provider', modelId: 'model' })
    browser.windowStore.getState().setDraftThinkingLevel(draftId, 'high')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'pixel.png',
      mimeType: 'image/png',
      blob: imageBlob(),
    })

    const outcome = await browser.sessionActions.submit({ mode: 'prompt' })

    expect(outcome).toMatchObject({
      status: 'accepted',
      disposition: 'started',
      threadId: 'created-1',
    })
    expect(fake.created).toEqual([
      {
        workspaceId: 'workspace-1',
        startProjectPath: '/workspace',
        model: { provider: 'provider', modelId: 'model' },
        thinkingLevel: 'high',
      },
    ])
    expect(fake.created[0]).not.toHaveProperty('initialMessage')
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]).toMatchObject({
      threadId: 'created-1',
      input: { content: 'hello' },
    })
    expect(fake.sent[0]?.input.attachments?.[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    })
    expect(browser.windowStore.getState().selection).toEqual({
      kind: 'thread',
      threadId: 'created-1',
    })
    expect(browser.windowStore.getState().draftsById['thread:created-1']?.text).toBe('')
    expect(browser.windowStore.getState().inputHistory).toEqual(['hello'])
    expect(browser.windowStore.getState().submissionsById).toEqual({})
    // 模型已在创建输入中固定，不额外 HTTP 读草稿或补设。
    expect(fake.modelChanges).toEqual([])
    expect(fake.thinkingChanges).toEqual([])
  })

  it('同步双击相同未变草稿复用同一在途提交', async () => {
    const gate = deferred<void>()
    const fake = createFakeClient()
    fake.setSendBarrier(gate.promise)
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'hello')

    const first = browser.sessionActions.submit({ mode: 'prompt' })
    const second = browser.sessionActions.submit({ mode: 'prompt' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    gate.resolve()
    await Promise.all([first, second])
    expect(fake.sent).toHaveLength(1)
    expect(browser.windowStore.getState().inputHistory).toEqual(['hello'])
  })

  it('图片准备期间后续提交停在尾链，按捕获顺序派发', async () => {
    const controlled = controlledImageBlob()
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'first')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: controlled.blob,
    })
    const first = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()
    browser.windowStore.getState().editDraftText(draftId, 'second')
    const second = browser.sessionActions.submit({ mode: 'followUp' })
    await flushMicrotasks()
    expect(fake.sent).toHaveLength(0)

    controlled.release()
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])
    expect(firstOutcome).toMatchObject({ status: 'accepted' })
    expect(secondOutcome).toMatchObject({ status: 'accepted' })
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['first', 'second'])
    expect(fake.sent[0]?.input.attachments).toHaveLength(1)
  })

  it('同窗发送按尾链保序，图片准备失败不阻断后续提交', async () => {
    const broken = deferred<void>()
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'first')
    const brokenAttachment = browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'broken.png',
      mimeType: 'image/png',
      blob: {
        arrayBuffer: async () => {
          await broken.promise
          throw new Error('decode failed')
        },
      } as unknown as Blob,
    })

    const firstOutcome = browser.sessionActions.submit({ mode: 'prompt' })
    // 等第一个提交进入图片准备后再捕获第二个，确保它停在尾链里。
    await flushMicrotasks()
    browser.windowStore.getState().removeAttachment(draftId, brokenAttachment!)
    browser.windowStore.getState().editDraftText(draftId, 'second')
    const secondOutcome = browser.sessionActions.submit({ mode: 'followUp' })
    await flushMicrotasks()

    expect(fake.sent).toHaveLength(0)
    broken.resolve()
    const [first, second] = await Promise.all([firstOutcome, secondOutcome])
    expect(first).toMatchObject({ status: 'failed' })
    expect(second).toMatchObject({ status: 'accepted' })
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['second'])
    expect(fake.sent[0]?.input.streamingBehavior).toBe('followUp')
  })

  it('创建期间用户已切换选择时不夺回窗口，仍把固定提交送到已创建会话', async () => {
    const gate = deferred<void>()
    const fake = createFakeClient()
    const createStarted = deferred<void>()
    fake.client.createThread = vi.fn(async (input: HarnessCreateThreadInput = {}) => {
      fake.created.push(input)
      createStarted.resolve()
      await gate.promise
      return snapshotOf('created-1', {
        workspaceId: input.workspaceId,
        workspacePath: input.startProjectPath,
      })
    }) as unknown as HarnessClient['createThread']
    const browser = createBrowser(fake.client)
    const draftId = select(browser, newTarget)
    browser.windowStore.getState().editDraftText(draftId, 'hello')

    const submitting = browser.sessionActions.submit({ mode: 'prompt' })
    await createStarted.promise
    selectThread(browser, 'other')

    gate.resolve()
    await submitting
    expect(browser.windowStore.getState().selection).toEqual({ kind: 'thread', threadId: 'other' })
    expect(fake.sent.map(({ threadId }) => threadId)).toEqual(['created-1'])
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['hello'])
    expect(browser.serviceStore.getState().threadsById['created-1']).toBeDefined()
  })

  it('已有会话发送前应用捕获的模型与 Thinking', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'hello')
    browser.windowStore
      .getState()
      .setDraftModel(draftId, { provider: 'provider', modelId: 'next-model' })
    browser.windowStore.getState().setDraftThinkingLevel(draftId, 'high')

    await browser.sessionActions.submit({ mode: 'prompt' })
    expect(fake.modelChanges).toEqual([
      { threadId: 't1', provider: 'provider', modelId: 'next-model' },
    ])
    expect(fake.thinkingChanges).toEqual([{ threadId: 't1', level: 'high' }])
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['hello'])
  })

  it('Shell 走会话动作并在 started 后清理捕获草稿、登记命令历史', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '!!pwd')

    const outcome = await browser.sessionActions.submit({
      mode: 'bashExcluded',
      content: 'pwd',
    })
    expect(outcome).toMatchObject({ status: 'accepted', disposition: 'started', threadId: 't1' })
    expect(fake.client.runThreadBash).toHaveBeenCalledWith('t1', {
      command: 'pwd',
      excludeFromContext: true,
    })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
    expect(browser.windowStore.getState().inputHistory).toEqual(['!!pwd'])
  })

  it('图片附件目标模型未声明图像能力时在创建前失败，输入保留', async () => {
    const fake = createFakeClient({
      getAvailableModels: vi.fn(async () => [
        {
          provider: 'provider',
          modelId: 'model',
          input: ['text'],
        },
      ]),
    } as Partial<HarnessClient>)
    const browser = createBrowser(fake.client)
    const draftId = select(browser, newTarget)
    browser.windowStore.getState().editDraftText(draftId, 'look')
    browser.windowStore
      .getState()
      .setDraftModel(draftId, { provider: 'provider', modelId: 'model' })
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'pixel.png',
      mimeType: 'image/png',
      blob: imageBlob(),
    })

    const outcome = await browser.sessionActions.submit({ mode: 'prompt' })
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(outcome?.message).toContain('未声明图像输入能力')
    expect(fake.client.getAvailableModels).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      workspaceId: 'workspace-1',
    })
    expect(fake.created).toHaveLength(0)
    expect(fake.sent).toHaveLength(0)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('look')
    expect(Object.values(browser.windowStore.getState().submissionsById)[0]?.status).toBe('failed')
  })
})

describe('session-actions：disposition、错误与草稿版本', () => {
  it.each([
    ['started', 'accepted'],
    ['queued', 'accepted'],
    ['handled', 'handled'],
  ] as const)('disposition %s 接受后只清理捕获版本并登记历史一次', async (disposition, status) => {
    const fake = createFakeClient()
    fake.setSendResult({ disposition })
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'hello')

    const outcome = await browser.sessionActions.submit({ mode: 'prompt' })
    expect(outcome).toMatchObject({ status, disposition })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
    expect(browser.windowStore.getState().inputHistory).toEqual(['hello'])
    expect(browser.windowStore.getState().submissionsById).toEqual({})
  })

  it('cancelled 不冒充接受，不登记历史且保留输入', async () => {
    const fake = createFakeClient()
    fake.setSendResult({ disposition: 'cancelled' })
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'hello')

    const outcome = await browser.sessionActions.submit({ mode: 'prompt' })
    expect(outcome).toMatchObject({ status: 'cancelled', disposition: 'cancelled' })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('hello')
    expect(browser.windowStore.getState().inputHistory).toEqual([])
  })

  it('未知错误只同步服务端一次，不自动重投；再次提交才是新动作', async () => {
    const fake = createFakeClient()
    fake.setSendError(new Error('offline'))
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'hello')

    const first = await browser.sessionActions.submit({ mode: 'prompt' })
    expect(first).toMatchObject({ status: 'unknown' })
    expect(fake.sent).toHaveLength(1)
    expect(fake.client.getThread).toHaveBeenCalled()
    expect(fake.client.listThreads).toHaveBeenCalled()
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('hello')
    expect(browser.windowStore.getState().inputHistory).toEqual([])

    const second = await browser.sessionActions.submit({ mode: 'prompt' })
    expect(second).toMatchObject({ status: 'unknown' })
    expect(fake.sent).toHaveLength(2)
  })

  it('发送中用户清空/改草稿属于新编辑，接受结果不覆盖', async () => {
    const gate = deferred<void>()
    const fake = createFakeClient()
    fake.setSendBarrier(gate.promise)
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'original')

    const sending = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()
    browser.windowStore.getState().editDraftText(draftId, '')
    gate.resolve()
    await sending

    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
    // 已接受动作仍登记本窗历史，但清理只针对捕获版本。
    expect(browser.windowStore.getState().inputHistory).toEqual(['original'])
  })

  it('发送中改模型也视为新编辑，不清理草稿', async () => {
    const gate = deferred<void>()
    const fake = createFakeClient()
    fake.setSendBarrier(gate.promise)
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'original')

    const sending = browser.sessionActions.submit({ mode: 'prompt' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    browser.windowStore
      .getState()
      .setDraftModel(draftId, { provider: 'provider', modelId: 'other' })
    gate.resolve()
    await sending

    expect(browser.windowStore.getState().draftsById[draftId]).toMatchObject({
      text: 'original',
      model: { provider: 'provider', modelId: 'other' },
    })
  })

  it('停止取消未派发图片准备并保留后来提交能力', async () => {
    const controlled = controlledImageBlob()
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'with image')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: controlled.blob,
    })

    const sending = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()
    const stopped = await browser.sessionActions.stop('t1')
    expect(stopped.status).toBe('stopped')
    expect(fake.canceled).toEqual(['t1'])

    controlled.release()
    const outcome = await sending
    expect(outcome).toMatchObject({ status: 'cancelled' })
    expect(fake.sent).toHaveLength(0)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('with image')

    browser.windowStore.getState().editDraftText(draftId, 'later')
    const later = await browser.sessionActions.submit({ mode: 'prompt' })
    expect(later).toMatchObject({ status: 'accepted' })
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['later'])
  })

  it('停止在途时不吞掉随后开始的独立提交', async () => {
    const cancelGate = deferred<void>()
    const fake = createFakeClient()
    fake.client.cancelRun = vi.fn(async (threadId: string) => {
      fake.canceled.push(threadId)
      await cancelGate.promise
    }) as unknown as HarnessClient['cancelRun']
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    const stopping = browser.sessionActions.stop('t1')
    browser.windowStore.getState().editDraftText(draftId, 'after stop')
    const sending = browser.sessionActions.submit({ mode: 'prompt' })

    cancelGate.resolve()
    await stopping
    const outcome = await sending
    expect(outcome).toMatchObject({ status: 'accepted' })
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['after stop'])
  })

  it('根释放由实际组合根取消尚未派发的准备', async () => {
    const controlled = controlledImageBlob()
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const releaseRoot = browser.acquireRoot()
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'with image')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: controlled.blob,
    })

    const sending = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()
    releaseRoot()
    await flushMicrotasks()
    controlled.release()
    const outcome = await sending
    expect(outcome).toMatchObject({ status: 'cancelled' })
    expect(fake.sent).toHaveLength(0)
  })
})

describe('session-actions：队列与停止', () => {
  it('整体取回并列返回服务端与本地未派发文本，不直接清服务端新队列', async () => {
    const controlled = controlledImageBlob()
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'first')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: controlled.blob,
    })
    const first = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()

    browser.windowStore.getState().editDraftText(draftId, 'local')
    const second = browser.sessionActions.submit({ mode: 'followUp' })
    await flushMicrotasks()

    browser.serviceStore
      .getState()
      .applyThreadEvents('t1', [
        { type: 'queue_update', steering: [], followUp: ['new'], threadId: 't1', seq: 2 },
      ])
    const recovered = await browser.sessionActions.recoverQueue('t1')
    expect(fake.queueCleared).toEqual(['t1'])
    expect(recovered).toMatchObject({
      status: 'cleared',
      steering: ['server-steer'],
      followUp: ['server-follow', 'local'],
    })
    // 队列仍以服务端最新事件为准，迟到取回响应不清空。
    expect(
      browser.serviceStore.getState().threadsById.t1?.queuedMessages?.map((item) => item.content),
    ).toEqual(['new'])

    controlled.release()
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])
    expect(firstOutcome).toMatchObject({ status: 'accepted' })
    expect(secondOutcome).toMatchObject({ status: 'cancelled' })
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['first'])
  })

  it('已派发但结果未知的队列内容不被取回冒认', async () => {
    const gate = deferred<void>()
    const fake = createFakeClient()
    fake.setSendBarrier(gate.promise)
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'in-flight')
    const sending = browser.sessionActions.submit({ mode: 'followUp' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))

    const recovered = await browser.sessionActions.recoverQueue('t1')
    expect(recovered.steering).toEqual(['server-steer'])
    expect(recovered.followUp).toEqual(['server-follow'])
    gate.resolve()
    await sending
  })

  it('服务端取回失败仍交还未派发本地文本并同步', async () => {
    const controlled = controlledImageBlob()
    const fake = createFakeClient()
    fake.client.clearQueue = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as HarnessClient['clearQueue']
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'first')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: controlled.blob,
    })
    const first = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()
    browser.windowStore.getState().editDraftText(draftId, 'local')
    const second = browser.sessionActions.submit({ mode: 'followUp' })
    await flushMicrotasks()

    const recovered = await browser.sessionActions.recoverQueue('t1')
    expect(recovered).toMatchObject({
      status: 'failed',
      steering: [],
      followUp: ['local'],
      message: 'offline',
    })
    expect(fake.client.getThread).toHaveBeenCalled()

    controlled.release()
    await Promise.all([first, second])
  })

  it('实例销毁后旧图片准备不再派发消息', async () => {
    const controlled = controlledImageBlob()
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'with image')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: controlled.blob,
    })

    const sending = browser.sessionActions.submit({ mode: 'prompt' })
    await flushMicrotasks()
    browser.dispose()
    controlled.release()
    const outcome = await sending
    expect(outcome).toMatchObject({ status: 'cancelled' })
    expect(fake.sent).toHaveLength(0)
  })

  it('断流后发送会重建观察订阅，不重发旧任务', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const release = browser.acquireThreadLease('t1')
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'hello')
    expect(fake.subscribeCount).toBe(1)

    fake.emit({
      type: 'error',
      error: 'decoder limit',
      terminal: true,
      threadId: 't1',
      seq: 1,
    })
    await browser.sessionActions.submit({ mode: 'prompt' })
    expect(fake.subscribeCount).toBe(2)
    expect(fake.sent.map(({ input }) => input.content)).toEqual(['hello'])
    release()
  })
})
