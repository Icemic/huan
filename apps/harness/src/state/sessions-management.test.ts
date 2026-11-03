import type {
  HarnessClient,
  HarnessThreadDetails,
  HarnessThreadForkResult,
  HarnessThreadImportPreview,
  HarnessThreadImportResult,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTree,
  HarnessTreeNavigateResult,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createSessionsFeatureStore } from './sessions-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const thread = (id: string, extra: Partial<HarnessThreadMetadata> = {}): HarnessThreadMetadata => ({
  id,
  title: `会话 ${id}`,
  status: 'idle',
  workspacePath: '/workspace',
  workspaceId: 'w1',
  sessionFile: `/sessions/${id}.jsonl`,
  treeRevision: `v1:0:${id}`,
  ...extra,
})

const snapshotOf = (metadata: HarnessThreadMetadata): HarnessThreadSnapshot => ({
  metadata,
  messages: [],
  messageEntryIds: [],
  seq: 1,
})

const treeOf = (threadId: string): HarnessThreadTree => ({
  threadId,
  leafId: 'e1',
  revision: `v1:1:${threadId}`,
  branchSummarySkipPrompt: false,
  nodes: [
    {
      entryId: 'e1',
      parentId: null,
      depth: 0,
      kind: 'user',
      entryType: 'message',
      summary: '第一条',
      active: true,
      isLeaf: true,
      childCount: 0,
      label: '起点',
    },
    {
      entryId: 'e2',
      parentId: 'e1',
      depth: 1,
      kind: 'assistant',
      entryType: 'message',
      summary: '回答',
      active: false,
      isLeaf: false,
      childCount: 0,
      hasToolCalls: true,
    },
  ],
})

const detailsOf = (metadata: HarnessThreadMetadata): HarnessThreadDetails => ({
  metadata,
  stats: {
    userMessages: 1,
    assistantMessages: 1,
    toolResults: 0,
    toolCalls: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0.0001,
  },
  branchEntryCount: 2,
})

const createFakeClient = () => {
  const threads = new Map<string, HarnessThreadMetadata>([
    ['t1', thread('t1')],
    ['t2', thread('t2')],
  ])
  const tree = vi.fn(async (threadId: string) => treeOf(threadId))
  const navigate = vi.fn(
    async (): Promise<HarnessTreeNavigateResult> => ({
      status: 'applied',
      leafId: 'e1',
      treeRevision: 'v1:1:e1',
    }),
  )
  const label = vi.fn(async () => ({ status: 'applied' as const }))
  const fork = vi.fn(async (): Promise<HarnessThreadForkResult> => ({ status: 'cancelled' }))
  const preview = vi.fn(async (): Promise<HarnessThreadImportPreview> => ({ status: 'invalid' }))
  const importThread = vi.fn(async (): Promise<HarnessThreadImportResult> => ({ status: 'failed' }))
  const details = vi.fn(async (threadId: string) =>
    detailsOf(threads.get(threadId) ?? thread(threadId)),
  )

  const client = {
    listThreads: vi.fn(async () => [...threads.values()]),
    getThread: vi.fn(async (threadId: string) =>
      snapshotOf(threads.get(threadId) ?? thread(threadId)),
    ),
    getThreadTree: tree,
    navigateThreadTree: navigate,
    setThreadEntryLabel: label,
    cancelThreadTreeNavigation: vi.fn(async () => ({ status: 'idle' as const })),
    forkThread: fork,
    previewThreadImport: preview,
    importThread,
    getProject: vi.fn(async () => ({
      path: '/workspace',
      name: 'workspace',
      status: 'ready' as const,
      trust: {
        decision: 'trusted' as const,
        origin: 'explicit' as const,
        requiresTrust: false,
        defaultPolicy: 'ask' as const,
        extensionErrorCount: 0,
      },
    })),
    getThreadDetails: details,
    renameThread: vi.fn(async (threadId: string, title: string) => {
      const existing = threads.get(threadId)
      if (existing) threads.set(threadId, { ...existing, name: title, title })
    }),
    archiveThread: vi.fn(async (threadId: string) => {
      const existing = threads.get(threadId)
      if (existing) threads.set(threadId, { ...existing, archived: true })
    }),
    unarchiveThread: vi.fn(async (threadId: string) => {
      const existing = threads.get(threadId)
      if (existing) threads.set(threadId, { ...existing, archived: false })
    }),
    deleteThread: vi.fn(async (threadId: string) => {
      threads.delete(threadId)
    }),
    assignThreadWorkspace: vi.fn(async (input: { threadId: string; workspaceId: string }) => {
      const existing = threads.get(input.threadId)
      if (!existing) return { ok: false as const, error: 'not-found' as const }
      const next = { ...existing, workspaceId: input.workspaceId }
      threads.set(input.threadId, next)
      return { ok: true as const, thread: next }
    }),
    consumeHostUiDirective: vi.fn(async () => true),
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
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
  } as unknown as HarnessClient
  return { client, threads, tree, navigate, label, fork, preview, importThread, details }
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({ client, connectionKey: 'test', windowId: 'window-a', storage: null })

const createStore = (client: HarnessClient) => {
  const browser = createBrowser(client)
  return { browser, store: createSessionsFeatureStore({ browser }) }
}

describe('sessions feature：详情与管理动作', () => {
  it('详情按需读取；切换会话后旧结果不覆盖新详情', async () => {
    const fake = createFakeClient()
    const old = deferred<HarnessThreadDetails>()
    fake.details.mockImplementationOnce(async () => old.promise)
    const { store } = createStore(fake.client)

    const openingOld = store.getState().openDetails('t1')
    await store.getState().openDetails('t2')
    old.resolve(detailsOf(thread('t1')))
    await openingOld

    expect(store.getState().details.threadId).toBe('t2')
    expect(store.getState().details.details?.metadata.id).toBe('t2')
    expect(fake.client.getThreadDetails).toHaveBeenCalledTimes(2)
  })

  it('命名成功刷新目录；迟到回执不覆盖后来输入', async () => {
    const fake = createFakeClient()
    const gate = deferred<void>()
    vi.mocked(fake.client.renameThread).mockReturnValueOnce(gate.promise)
    const { store } = createStore(fake.client)
    await store.getState().openDetails('t1')
    store.getState().setRenameValue('新名称')
    const renaming = store.getState().renameCurrentThread()
    store.getState().setRenameValue('后来输入')
    gate.resolve()
    await renaming

    expect(fake.client.renameThread).toHaveBeenCalledWith('t1', '新名称')
    expect(store.getState().details.renameValue).toBe('后来输入')
  })

  it('归档/删除确认/未归属加入使用权威目录并清理选择', async () => {
    const fake = createFakeClient()
    const { browser, store } = createStore(fake.client)
    await browser.serviceStore.getState().refreshThreads()
    await store.getState().openDetails('t1')

    await store.getState().toggleArchiveCurrent()
    expect(fake.client.archiveThread).toHaveBeenCalledWith('t1')
    expect(browser.serviceStore.getState().threadsById.t1?.archived).toBe(true)
    await store.getState().toggleArchiveCurrent()
    expect(fake.client.unarchiveThread).toHaveBeenCalledWith('t1')

    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    store.getState().openDelete('t1')
    await store.getState().confirmDelete()
    expect(fake.client.deleteThread).toHaveBeenCalledWith('t1')
    expect(browser.windowStore.getState().selection).toBeUndefined()

    browser.serviceStore.getState().applyWorkspace({
      id: 'w1',
      name: '工作区',
      revision: 1,
      projects: [{ alias: 'main', path: '/workspace', available: true }],
    })
    store.getState().openAssign('t2')
    store.getState().setAssignWorkspace('w1')
    await store.getState().confirmAssign()
    expect(fake.client.assignThreadWorkspace).toHaveBeenCalledWith({
      threadId: 't2',
      workspaceId: 'w1',
    })
  })
})

describe('sessions feature：树表单、标签与 fork 确认', () => {
  it('导航确认表单捕获摘要/替换草稿选项并按树 revision 提交', async () => {
    const fake = createFakeClient()
    const { browser, store } = createStore(fake.client)
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    browser.windowStore.getState().editDraftText('thread:t1', '已有草稿')
    store.getState().openTree('t1')
    await vi.waitFor(() => expect(store.getState().tree.tree).toBeDefined())

    const node = store.getState().tree.tree?.nodes[1]
    if (!node) throw new Error('缺少节点')
    store.getState().beginTreeNavigation(node)
    expect(store.getState().treeNavigation).toMatchObject({
      mode: 'none',
      draftNonEmpty: true,
      replaceDraft: true,
    })
    store.getState().setTreeNavigationMode('custom')
    store.getState().setTreeNavigationInstructions('保留文件改动')
    store.getState().setTreeNavigationReplaceInstructions(true)
    store.getState().setTreeNavigationReplaceDraft(false)
    await store.getState().confirmTreeNavigation()

    expect(fake.navigate).toHaveBeenCalledWith('t1', {
      targetId: 'e2',
      expectedRevision: 'v1:1:t1',
      summarize: true,
      customInstructions: '保留文件改动',
      replaceInstructions: true,
    })
    expect(store.getState().treeNavigation).toBeUndefined()
  })

  it('标签表单使用树 revision 保存并清除编辑态', async () => {
    const fake = createFakeClient()
    const { browser, store } = createStore(fake.client)
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    store.getState().openTree('t1')
    await vi.waitFor(() => expect(store.getState().tree.tree).toBeDefined())

    store.getState().beginTreeLabel('e2')
    store.getState().setTreeLabelValue('新标签')
    const result = await store.getState().saveTreeLabel()
    expect(result?.status).toBe('applied')
    expect(fake.label).toHaveBeenCalledWith('t1', {
      entryId: 'e2',
      label: '新标签',
      expectedRevision: 'v1:1:t1',
    })
    expect(store.getState().treeLabel).toBeUndefined()
  })

  it('fork 确认在打开时捕获结构 revision，之后目录变化不改提交来源', async () => {
    const fake = createFakeClient()
    const { browser, store } = createStore(fake.client)
    await browser.serviceStore.getState().refreshThreads()
    store.getState().openFork({ threadId: 't1', position: 'before', entryId: 'e1' })
    fake.fork.mockResolvedValueOnce({ status: 'cancelled', message: '扩展取消了本次分叉' })
    browser.serviceStore
      .getState()
      .applyThreadSnapshot('t1', snapshotOf(thread('t1', { treeRevision: 'v2:1:t1' })))
    await store.getState().confirmFork()

    expect(fake.fork).toHaveBeenCalledWith('t1', {
      entryId: 'e1',
      position: 'before',
      expectedRevision: 'v1:0:t1',
    })
    expect(store.getState().forkPanel.error).toContain('取消')
  })
})

describe('sessions feature：导入文件读取与源重验', () => {
  const fileOf = (
    name: string,
    content: string,
    size = content.length,
    text?: () => Promise<string>,
  ) =>
    ({
      name,
      size,
      text: text ?? (async () => content),
    }) as unknown as File

  it('上传文件按代次读取；后选文件不会被旧读取覆盖', async () => {
    const fake = createFakeClient()
    const { store } = createStore(fake.client)
    store.getState().openImport({ workspaceId: 'w1' })
    const oldRead = deferred<string>()
    const readingOld = store
      .getState()
      .readImportFile(fileOf('old.jsonl', 'old', 3, async () => oldRead.promise))
    await store.getState().readImportFile(fileOf('new.jsonl', 'new'))
    oldRead.resolve('old')
    await readingOld
    expect(store.getState().importPanel.source).toEqual({
      kind: 'upload',
      filename: 'new.jsonl',
      content: 'new',
    })
  })

  it('超过上限的文件不读取正文；冲突必须显式确认副本并发送源指纹', async () => {
    const fake = createFakeClient()
    const { store } = createStore(fake.client)
    store.getState().openImport({ workspaceId: 'w1' })
    const text = vi.fn(async () => 'x')
    await store.getState().readImportFile(fileOf('large.jsonl', 'x', 20 * 1024 * 1024 + 1, text))
    expect(text).not.toHaveBeenCalled()
    expect(store.getState().importPanel.fileError).toContain('20MiB')

    fake.preview.mockResolvedValueOnce({
      status: 'ok',
      source: { kind: 'path', id: 'src', fingerprint: 'fp' },
      workspaceId: 'w1',
      cwd: '/workspace',
      conflict: 'conflict',
    })
    store.getState().setImportPath('/tmp/session.jsonl')
    await store.getState().previewImport()
    expect(await store.getState().confirmImport()).toBeUndefined()
    expect(store.getState().importPanel.error).toContain('作为新会话导入')
    expect(fake.importThread).not.toHaveBeenCalled()

    fake.importThread.mockResolvedValueOnce({ status: 'imported', threadId: 'imported' })
    store.getState().setImportCopyConfirmed(true)
    await store.getState().confirmImport()
    expect(fake.importThread).toHaveBeenCalledWith(
      expect.objectContaining({
        asCopy: true,
        expectedSourceId: 'src',
        expectedSourceFingerprint: 'fp',
      }),
    )
    expect(store.getState().importPanel.importedThreadId).toBe('imported')
  })
})
