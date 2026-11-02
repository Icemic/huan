import type {
  HarnessClient,
  HarnessProjectInfo,
  HarnessThreadForkResult,
  HarnessThreadImportPreview,
  HarnessThreadImportResult,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessTreeNavigateResult,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createSessionsFeatureStore } from './sessions-store'

const snapshotOf = (
  threadId: string,
  extra: Partial<HarnessThreadSnapshot> = {},
): HarnessThreadSnapshot => ({
  metadata: { id: threadId, status: 'idle', workspacePath: '/workspace' },
  messages: [],
  messageEntryIds: [],
  seq: 1,
  ...extra,
})

const treeOf = (threadId: string, revision = `v1:0:${threadId}`): HarnessThreadTree => ({
  threadId,
  leafId: null,
  revision,
  nodes: [],
  branchSummarySkipPrompt: true,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const project: HarnessProjectInfo = {
  path: '/workspace',
  name: 'workspace',
  status: 'ready',
  trust: {
    decision: 'trusted',
    origin: 'explicit',
    requiresTrust: false,
    defaultPolicy: 'ask',
    extensionErrorCount: 0,
  },
}

const createFakeClient = () => {
  const consumed: { threadId: string; directiveId: string }[] = []
  const tree = vi.fn(async (threadId: string) => treeOf(threadId))
  const navigate = vi.fn(
    async (): Promise<HarnessTreeNavigateResult> => ({
      status: 'applied',
      leafId: 'e1',
      treeRevision: 'v1:1:e1',
    }),
  )
  const fork = vi.fn(
    async (): Promise<HarnessThreadForkResult> => ({
      status: 'cancelled',
    }),
  )
  const preview = vi.fn(
    async (): Promise<HarnessThreadImportPreview> => ({
      status: 'invalid',
    }),
  )
  const importThread = vi.fn(
    async (): Promise<HarnessThreadImportResult> => ({
      status: 'failed',
    }),
  )

  const client = {
    listThreads: vi.fn(async () => []),
    getThread: vi.fn(async (threadId: string) => snapshotOf(threadId)),
    getThreadTree: tree,
    navigateThreadTree: navigate,
    setThreadEntryLabel: vi.fn(async () => ({ status: 'applied' as const })),
    cancelThreadTreeNavigation: vi.fn(async () => ({ status: 'idle' as const })),
    forkThread: fork,
    previewThreadImport: preview,
    importThread,
    getProject: vi.fn(async () => project),
    consumeHostUiDirective: vi.fn(async (threadId: string, directiveId: string) => {
      consumed.push({ threadId, directiveId })
      return true
    }),
    sendMessage: vi.fn(async () => ({ disposition: 'started' as const })),
    createThread: vi.fn(async () => snapshotOf('created')),
    runThreadBash: vi.fn(async () => ({
      status: 'started' as const,
      run: {
        id: 'bash',
        command: 'pwd',
        excludeFromContext: false,
        cwd: '/workspace',
        status: 'running' as const,
        output: '',
        outputTruncated: false,
        startedAt: new Date().toISOString(),
      },
    })),
    cancelRun: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(async () => {}),
    getHostInfo: vi.fn(async () => ({
      workspacePath: '/workspace',
      agentDir: '/agent',
      agentDirSource: 'settings' as const,
      sessionStorage: {
        mode: 'grouped' as const,
        root: '/sessions',
        directory: '/sessions',
        source: 'settings' as const,
      },
      defaultModel: {
        providerSource: 'env' as const,
        modelIdSource: 'env' as const,
        readiness: { state: 'missing-model' as const, message: 'none' },
      },
      diagnostics: [],
    })),
    getProviderAuth: vi.fn(async () => ({
      seq: 1,
      authRevision: 1,
      providers: [],
      operations: [],
    })),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    getAvailableModels: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
  } as unknown as HarnessClient

  return { client, tree, navigate, fork, preview, importThread, consumed }
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })

const selectThread = (browser: HarnessBrowser, threadId: string) => {
  browser.windowStore.getState().selectTarget({ kind: 'thread', threadId })
  return `thread:${threadId}`
}

const waitForTree = async (store: ReturnType<typeof createSessionsFeatureStore>) => {
  await vi.waitFor(() => expect(store.getState().tree.tree).toBeDefined())
}

describe('sessions feature：树查询与导航来源保护', () => {
  it('换会话/面板后旧树查询结果不覆盖新面板', async () => {
    const fake = createFakeClient()
    const oldTree = deferred<HarnessThreadTree>()
    fake.tree.mockImplementationOnce(async () => oldTree.promise)
    fake.tree.mockImplementationOnce(async (threadId: string) => treeOf(threadId, 'new-tree'))
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })

    sessions.getState().openTree('t1')
    await vi.waitFor(() => expect(fake.tree).toHaveBeenCalledWith('t1'))
    sessions.getState().openTree('t2')
    await waitForTree(sessions)
    expect(sessions.getState().tree.threadId).toBe('t2')

    oldTree.resolve(treeOf('t1', 'old-tree'))
    await Promise.resolve()
    expect(sessions.getState().tree.threadId).toBe('t2')
    expect(sessions.getState().tree.tree?.revision).toBe('new-tree')
  })

  it('导航只在新草稿未变化时应用 editorText，并应用权威快照', async () => {
    const fake = createFakeClient()
    fake.navigate.mockResolvedValueOnce({
      status: 'applied',
      leafId: 'e1',
      treeRevision: 'v1:1:e1',
      editorText: '节点原文',
      snapshot: snapshotOf('t1', {
        metadata: { id: 't1', status: 'idle', leafId: 'e1', treeRevision: 'v1:1:e1' },
      }),
    })
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    const draftId = selectThread(browser, 't1')
    browser.windowStore.getState().editDraftText(draftId, '')

    sessions.getState().openTree('t1')
    await waitForTree(sessions)
    // 导航后的刷新读到的服务端快照应已包含新落点。
    fake.client.getThread = vi.fn(async (threadId: string) =>
      snapshotOf(threadId, {
        metadata: { id: threadId, status: 'idle', leafId: 'e1', treeRevision: 'v1:1:e1' },
      }),
    ) as unknown as HarnessClient['getThread']
    const result = await sessions.getState().navigateTree({
      targetId: 'e1',
      expectedRevision: sessions.getState().tree.tree?.revision ?? '',
    })
    expect(result.status).toBe('applied')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('节点原文')
    expect(browser.serviceStore.getState().threadsById.t1?.leafId).toBe('e1')

    fake.navigate.mockResolvedValueOnce({
      status: 'applied',
      editorText: '旧文本',
      snapshot: snapshotOf('t1'),
    })
    sessions.getState().openTree('t1')
    await waitForTree(sessions)
    const pending = sessions.getState().navigateTree({
      targetId: 'e1',
      expectedRevision: 'v1:1:e1',
    })
    browser.windowStore.getState().editDraftText(draftId, '后来输入')
    await pending
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('后来输入')
  })

  it('标签成功应用权威快照并刷新树；取消信令独立转发', async () => {
    const fake = createFakeClient()
    fake.client.setThreadEntryLabel = vi.fn(async () => ({
      status: 'applied' as const,
      label: '起点',
      snapshot: snapshotOf('t1', {
        metadata: { id: 't1', status: 'idle', leafId: 'e2', treeRevision: 'v1:1:e2' },
      }),
    })) as unknown as HarnessClient['setThreadEntryLabel']
    fake.client.cancelThreadTreeNavigation = vi.fn(async () => ({
      status: 'cancelled' as const,
    })) as unknown as HarnessClient['cancelThreadTreeNavigation']
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    selectThread(browser, 't1')
    sessions.getState().openTree('t1')
    await waitForTree(sessions)
    fake.client.getThread = vi.fn(async (threadId: string) =>
      snapshotOf(threadId, {
        metadata: { id: threadId, status: 'idle', leafId: 'e2', treeRevision: 'v1:1:e2' },
      }),
    ) as unknown as HarnessClient['getThread']

    const labelled = await sessions.getState().setTreeLabel({ entryId: 'e1', label: '起点' })
    expect(labelled?.status).toBe('applied')
    expect(browser.serviceStore.getState().threadsById.t1?.leafId).toBe('e2')
    await sessions.getState().cancelTreeNavigation()
    expect(sessions.getState().tree.notice).toContain('取消分支摘要')
  })

  it('导航 HTTP 失败仍交还本窗未派发队列文本', async () => {
    const fake = createFakeClient()
    fake.navigate.mockRejectedValueOnce(new Error('offline'))
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    const draftId = selectThread(browser, 't1')
    const gate = deferred<void>()
    browser.windowStore.getState().editDraftText(draftId, 'first')
    browser.windowStore.getState().addAttachment(draftId, {
      fileName: 'slow.png',
      mimeType: 'image/png',
      blob: {
        arrayBuffer: async () => {
          await gate.promise
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
        },
      } as unknown as Blob,
    })
    const first = browser.sessionActions.submit({ mode: 'prompt' })
    await Promise.resolve()
    browser.windowStore.getState().editDraftText(draftId, 'local')
    const second = browser.sessionActions.submit({ mode: 'followUp' })
    await vi.waitFor(() =>
      expect(
        Object.values(browser.windowStore.getState().submissionsById).some(
          (submission) => submission.content === 'local',
        ),
      ).toBe(true),
    )

    sessions.getState().openTree('t1')
    await waitForTree(sessions)
    const result = await sessions.getState().navigateTree({
      targetId: 'e1',
      expectedRevision: sessions.getState().tree.tree?.revision ?? '',
      stopRunning: true,
    })
    expect(result.status).toBe('failed')
    expect(result.recoveredQueue).toEqual({ steering: [], followUp: ['local'] })

    gate.resolve()
    await Promise.all([first, second])
  })
})

describe('sessions feature：fork/clone 与导入', () => {
  it('fork 成功刷新唯一目录；来源仍选中才切换并填充 child 草稿', async () => {
    const fake = createFakeClient()
    fake.fork.mockResolvedValueOnce({
      status: 'created',
      threadId: 'child',
      parentThreadId: 't1',
      selectedText: '原文',
      snapshot: snapshotOf('child'),
    })
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    selectThread(browser, 't1')

    const result = await sessions.getState().forkThread({
      threadId: 't1',
      position: 'before',
      entryId: 'e1',
    })
    expect(result.status).toBe('created')
    expect(fake.client.listThreads).toHaveBeenCalled()
    expect(browser.serviceStore.getState().threadsById.child).toBeDefined()
    expect(browser.windowStore.getState().selection).toEqual({ kind: 'thread', threadId: 'child' })
    expect(browser.windowStore.getState().draftsById['thread:child']?.text).toBe('原文')
  })

  it('fork 成功时用户已切换选择则不夺回，也不覆盖后来草稿', async () => {
    const gate = deferred<HarnessThreadForkResult>()
    const fake = createFakeClient()
    fake.fork.mockImplementationOnce(async () => gate.promise)
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    selectThread(browser, 't1')
    const forkPromise = sessions.getState().forkThread({ threadId: 't1', position: 'before' })

    const otherDraft = selectThread(browser, 'other')
    browser.windowStore.getState().editDraftText(otherDraft, 'other text')
    gate.resolve({
      status: 'created',
      threadId: 'child',
      selectedText: '原文',
      snapshot: snapshotOf('child'),
    })
    await forkPromise

    expect(browser.windowStore.getState().selection).toEqual({ kind: 'thread', threadId: 'other' })
    expect(browser.windowStore.getState().draftsById[otherDraft]?.text).toBe('other text')
    expect(browser.serviceStore.getState().threadsById.child).toBeDefined()
  })

  it('导入预览换来源后旧结果失效，成功只刷新目录不隐式切换', async () => {
    const gate = deferred<HarnessThreadImportPreview>()
    const fake = createFakeClient()
    fake.preview.mockImplementationOnce(async () => gate.promise)
    fake.importThread.mockResolvedValueOnce({ status: 'imported', threadId: 'imported' })
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    const selectionBefore = browser.windowStore.getState().selection
    sessions.getState().openImport({ workspaceId: 'w1' })
    sessions.getState().configureImport({ source: { kind: 'path', path: '/a.jsonl' } })
    const previewing = sessions.getState().previewImport()
    sessions.getState().configureImport({ source: { kind: 'path', path: '/b.jsonl' } })
    gate.resolve({
      status: 'ok',
      source: { kind: 'path', id: 'old', fingerprint: 'old' },
      workspaceId: 'w1',
      cwd: '/workspace',
      conflict: 'none',
    })
    await previewing
    expect(sessions.getState().importPanel.preview).toBeUndefined()

    fake.preview.mockResolvedValueOnce({
      status: 'ok',
      source: { kind: 'path', id: 'new', fingerprint: 'new' },
      workspaceId: 'w1',
      cwd: '/workspace',
      conflict: 'none',
    })
    await sessions.getState().previewImport()
    const result = await sessions.getState().confirmImport()
    expect(result).toMatchObject({ status: 'imported', threadId: 'imported' })
    expect(fake.client.listThreads).toHaveBeenCalled()
    expect(browser.windowStore.getState().selection).toEqual(selectionBefore)
    expect(fake.importThread).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'path', path: '/b.jsonl' },
        workspaceId: 'w1',
        expectedSourceId: 'new',
        expectedSourceFingerprint: 'new',
      }),
    )
  })
})

describe('sessions feature：定向 consume 来源保护', () => {
  it('编辑器指令 consume 后应用文本并保留原文恢复；不再重复领取', async () => {
    const fake = createFakeClient()
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    const draftId = selectThread(browser, 't1')
    browser.windowStore.getState().editDraftText(draftId, 'before')
    browser.serviceStore.getState().applyThreadSnapshot(
      't1',
      snapshotOf('t1', {
        hostUi: {
          statuses: [],
          widgets: [],
          notifications: [],
          editorDirective: { id: 'd1', text: 'after', mode: 'set', createdAt: 1 },
        },
      }),
    )

    const accepted = await sessions.getState().consumeEditorDirective('t1')
    expect(accepted).toBe(true)
    expect(fake.consumed).toEqual([{ threadId: 't1', directiveId: 'd1' }])
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('after')
    expect(sessions.getState().editorRecovery?.previousText).toBe('before')
    expect(sessions.getState().restoreEditorPrevious()).toBe(true)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('before')
  })

  it('consume 后窗口已切换则保留待应用文本，稍后应用不重新领取', async () => {
    const fake = createFakeClient()
    const consumeGate = deferred<boolean>()
    fake.client.consumeHostUiDirective = vi.fn(async (threadId: string, directiveId: string) => {
      fake.consumed.push({ threadId, directiveId })
      return consumeGate.promise
    }) as unknown as HarnessClient['consumeHostUiDirective']
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    const t1Draft = selectThread(browser, 't1')
    browser.windowStore.getState().editDraftText(t1Draft, 't1 text')
    browser.serviceStore.getState().applyThreadSnapshot(
      't1',
      snapshotOf('t1', {
        hostUi: {
          statuses: [],
          widgets: [],
          notifications: [],
          editorDirective: { id: 'd1', text: 'directive', mode: 'set', createdAt: 1 },
        },
      }),
    )

    const consuming = sessions.getState().consumeEditorDirective('t1')
    selectThread(browser, 't2')
    consumeGate.resolve(true)
    await consuming
    expect(sessions.getState().pendingEditorDirective).toMatchObject({ threadId: 't1' })

    selectThread(browser, 't1')
    expect(sessions.getState().applyPendingEditorDirective()).toBe(true)
    expect(browser.windowStore.getState().draftsById[t1Draft]?.text).toBe('directive')
    expect(fake.consumed).toHaveLength(1)
  })

  it('命令目标 consume 后窗口已切换则保留待应用，应用时只切到原目标', async () => {
    const fake = createFakeClient()
    const consumeGate = deferred<boolean>()
    fake.client.consumeHostUiDirective = vi.fn(
      async () => consumeGate.promise,
    ) as unknown as HarnessClient['consumeHostUiDirective']
    const browser = createBrowser(fake.client)
    const sessions = createSessionsFeatureStore({ browser })
    selectThread(browser, 't1')
    browser.serviceStore.getState().applyThreadSnapshot(
      't1',
      snapshotOf('t1', {
        hostUi: {
          statuses: [],
          widgets: [],
          notifications: [],
          commandTarget: {
            id: 'c1',
            action: 'switchSession',
            threadId: 'target',
            editorText: '目标文本',
            message: '切换会话',
            createdAt: 1,
          },
        },
      }),
    )

    const consuming = sessions.getState().consumeCommandTarget('t1')
    selectThread(browser, 'other')
    consumeGate.resolve(true)
    await consuming
    expect(sessions.getState().pendingCommandTarget).toMatchObject({ threadId: 'target' })
    expect(browser.windowStore.getState().selection).toEqual({ kind: 'thread', threadId: 'other' })

    expect(sessions.getState().applyPendingCommandTarget()).toBe(true)
    expect(browser.windowStore.getState().selection).toEqual({
      kind: 'thread',
      threadId: 'target',
    })
    expect(browser.windowStore.getState().draftsById['thread:target']?.text).toBe('目标文本')
  })
})
