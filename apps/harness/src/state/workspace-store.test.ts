import type {
  HarnessClient,
  HarnessHostInfo,
  HarnessThreadMetadata,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowserStorage } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceFeatureStore } from './workspace-store'

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

const workspace = (
  id: string,
  name: string,
  path: string,
  modelPatterns?: string[],
): HarnessWorkspace => ({
  id,
  name,
  revision: 1,
  projects: [{ alias: 'main', path, available: true }],
  ...(modelPatterns ? { modelPatterns } : {}),
})

const catalog = (workspaces: readonly HarnessWorkspace[]): HarnessWorkspaceCatalog => ({
  state: 'ok',
  startupWorkspaceId: workspaces[0]?.id,
  workspaces: [...workspaces],
})

const threads: readonly HarnessThreadMetadata[] = [
  { id: 't1', title: '会话一', workspaceId: 'w1', workspacePath: '/a', status: 'idle' },
  { id: 't2', title: '会话二', workspaceId: 'w2', workspacePath: '/b', status: 'idle' },
]

const memoryStorage = (): HarnessBrowserStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

const createClient = () => {
  let workspaceCatalog = catalog([
    workspace('w1', '工作区一', '/a'),
    workspace('w2', '工作区二', '/b'),
  ])
  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    listThreads: vi.fn(async () => [...threads]),
    listWorkspaces: vi.fn(async () => workspaceCatalog),
    getThread: vi.fn(async () => ({ metadata: threads[0], messages: [] })),
    getProviderAuth: vi.fn(async () => ({
      seq: 1,
      authRevision: 1,
      providers: [],
      operations: [],
    })),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    getAvailableModels: vi.fn(async () => []),
    refreshModels: vi.fn(async () => ({ models: [], failedProviders: [] })),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
    createWorkspace: vi.fn(
      async (input: { name: string; projects: { alias: string; path: string }[] }) => ({
        ok: true as const,
        workspace: {
          id: 'w3',
          name: input.name,
          revision: 1,
          projects: input.projects.map((project) => ({ ...project, available: true })),
        },
      }),
    ),
    updateWorkspace: vi.fn(),
  } as unknown as HarnessClient
  return {
    client,
    setWorkspaceCatalog: (next: HarnessWorkspaceCatalog) => {
      workspaceCatalog = next
    },
  }
}

const createBrowser = (client: HarnessClient) =>
  createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })

const createStore = (
  browser: ReturnType<typeof createBrowser>,
  storage: HarnessBrowserStorage | null,
) => createWorkspaceFeatureStore({ browser, storage })

describe('workspace-store：目录唯一来源与选择', () => {
  it('刷新后工作区与会话只读取 serviceStore，feature 不复制目录', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())

    await store.getState().refresh()

    expect(browser.serviceStore.getState().workspaceIds).toEqual(['w1', 'w2'])
    expect(browser.serviceStore.getState().catalog.ids).toEqual(['t1', 't2'])
    expect(store.getState().activeWorkspaceId).toBe('w1')
    // 唯一业务数据仍在公共 serviceStore；feature 不保存目录副本。
    expect('threads' in store.getState()).toBe(false)
    expect('workspaces' in store.getState()).toBe(false)
  })

  it('选择已有会话写入 windowStore，并把活动工作区同步到其归属', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().selectThread('t2')

    expect(browser.windowStore.getState().selection).toEqual({ kind: 'thread', threadId: 't2' })
    expect(store.getState().activeWorkspaceId).toBe('w2')
    expect(store.getState().expandedWorkspaceIds.has('w2')).toBe(true)
  })

  it('新建会话目标写入 windowStore，并记录工作区起始项目偏好', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().beginNewSession('w2', '/b')
    store.getState().beginNewSession('w2', '/b')

    expect(browser.windowStore.getState().selection).toEqual({
      kind: 'new',
      workspaceId: 'w2',
      startProjectPath: '/b',
    })
    expect(store.getState().activeWorkspaceId).toBe('w2')
    expect(store.getState().startProjectByWorkspace.w2).toBe('/b')
    expect(browser.windowStore.getState().selectionRevision).toBe(2)
  })

  it('新建会话关闭请求保留面板到退出完成，重开期间不清理', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().openNewSession('w2')
    expect(store.getState().newSession.open).toBe(true)
    store.getState().closeNewSession()
    expect(store.getState().newSession.open).toBe(false)
    expect(store.getState().newSession.workspaceId).toBe('w2')

    // 退出动画期间重新打开：旧关闭的完成回调不得清空新面板。
    store.getState().openNewSession('w2')
    store.getState().finishCloseNewSession()
    expect(store.getState().newSession.workspaceId).toBe('w2')

    store.getState().closeNewSession()
    store.getState().finishCloseNewSession()
    expect(store.getState().newSession.workspaceId).toBeUndefined()
  })
})

describe('workspace-store：存储作用域隔离', () => {
  it('同作用域恢复活动工作区、展开与起始偏好，其他作用域为空', async () => {
    const { client } = createClient()
    const storage = memoryStorage()
    const first = createStore(createBrowser(client), storage)
    first.getState().setStorageScope('agent|sessions')
    await first.getState().refresh()
    first.getState().beginNewSession('w2', '/b')
    first.getState().toggleWorkspace('w1')

    const restored = createStore(createBrowser(client), storage)
    restored.getState().setStorageScope('agent|sessions')
    expect(restored.getState().activeWorkspaceId).toBe('w2')
    expect(restored.getState().expandedWorkspaceIds.has('w2')).toBe(true)
    expect(restored.getState().expandedWorkspaceIds.has('w1')).toBe(false)
    expect(restored.getState().startProjectByWorkspace.w2).toBe('/b')

    const other = createStore(createBrowser(client), storage)
    other.getState().setStorageScope('other-agent|sessions')
    expect(other.getState().activeWorkspaceId).toBeUndefined()
    expect(other.getState().expandedWorkspaceIds.size).toBe(0)
    expect(other.getState().startProjectByWorkspace).toEqual({})
  })

  it('未归属分组展开独立保存，按作用域恢复且刷新不重置', async () => {
    const { client } = createClient()
    const storage = memoryStorage()
    const first = createStore(createBrowser(client), storage)
    first.getState().setStorageScope('agent|sessions')
    expect(first.getState().unassignedExpanded).toBe(true)

    first.getState().toggleUnassigned()
    expect(first.getState().unassignedExpanded).toBe(false)
    // 独立状态不进入工作区 ID 集合，也不写入工作区展开键。
    expect(first.getState().expandedWorkspaceIds.size).toBe(0)
    expect(storage.values.get('huan.expandedWorkspaces:agent|sessions')).toBe('[]')

    await first.getState().refresh()
    expect(first.getState().unassignedExpanded).toBe(false)

    const restored = createStore(createBrowser(client), storage)
    restored.getState().setStorageScope('agent|sessions')
    expect(restored.getState().unassignedExpanded).toBe(false)

    const other = createStore(createBrowser(client), storage)
    other.getState().setStorageScope('other-agent|sessions')
    expect(other.getState().unassignedExpanded).toBe(true)
  })

  it('dispose 清理未归属展开，之后切换不再生效', () => {
    const { client } = createClient()
    const store = createStore(createBrowser(client), memoryStorage())
    store.getState().toggleUnassigned()
    expect(store.getState().unassignedExpanded).toBe(false)

    store.getState().dispose()
    expect(store.getState().disposed).toBe(true)
    expect(store.getState().unassignedExpanded).toBe(true)

    store.getState().toggleUnassigned()
    expect(store.getState().unassignedExpanded).toBe(true)
  })
})

describe('workspace-store：目录变化与工作区表单', () => {
  it('工作区移除后清理展开并回退到启动工作区', async () => {
    const { client, setWorkspaceCatalog } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()
    store.getState().selectThread('t2')
    expect(store.getState().activeWorkspaceId).toBe('w2')

    setWorkspaceCatalog(catalog([workspace('w1', '工作区一', '/a')]))
    await store.getState().refresh()

    expect(store.getState().activeWorkspaceId).toBe('w1')
    expect(store.getState().expandedWorkspaceIds.has('w2')).toBe(false)
  })

  it('保存响应不关闭重开后的表单，冲突也保留原输入', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()
    store.getState().openWorkspaceForm('w1')
    store.getState().setWorkspaceFormName('保留输入')
    let finish!: (value: Awaited<ReturnType<HarnessClient['updateWorkspace']>>) => void
    vi.mocked(client.updateWorkspace).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const save = store.getState().saveWorkspaceForm()
    store.getState().closeWorkspaceForm()
    store.getState().openWorkspaceForm('w2')
    finish({ ok: true, workspace: workspace('w1', '已保存', '/a') })
    await save
    expect(store.getState().form.workspaceId).toBe('w2')
    expect(store.getState().form.open).toBe(true)

    store.getState().openWorkspaceForm('w1')
    store.getState().setWorkspaceFormName('保留冲突草稿')
    vi.mocked(client.updateWorkspace).mockResolvedValue({
      ok: false,
      error: 'conflict',
      workspace: workspace('w1', '其他窗口', '/a'),
    })
    await store.getState().saveWorkspaceForm()
    expect(store.getState().form.name).toBe('保留冲突草稿')
    expect(browser.serviceStore.getState().workspacesById.w1?.name).toBe('其他窗口')
  })

  it('同内容表单关闭重开也不被旧保存结果关闭', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()
    store.getState().openWorkspaceForm('w1')
    let finish!: (value: Awaited<ReturnType<HarnessClient['updateWorkspace']>>) => void
    vi.mocked(client.updateWorkspace).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const save = store.getState().saveWorkspaceForm()
    store.getState().closeWorkspaceForm()
    store.getState().openWorkspaceForm('w1')
    finish({ ok: true, workspace: workspace('w1', '旧保存', '/a') })
    await save
    expect(store.getState().form.open).toBe(true)
    expect(store.getState().form.workspaceId).toBe('w1')
  })

  it('工作区表单关闭请求保留内容到退出完成，重开期间不清理', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().openWorkspaceForm('w1')
    store.getState().setWorkspaceFormName('未保存的草稿')
    store.getState().closeWorkspaceForm()
    expect(store.getState().form.open).toBe(false)
    expect(store.getState().form.name).toBe('未保存的草稿')

    // 退出动画期间重新打开：旧关闭的完成回调不得清空新表单。
    store.getState().openWorkspaceForm('w2')
    store.getState().finishCloseWorkspaceForm()
    expect(store.getState().form.workspaceId).toBe('w2')

    store.getState().closeWorkspaceForm()
    store.getState().finishCloseWorkspaceForm()
    expect(store.getState().form.workspaceId).toBeUndefined()
    expect(store.getState().form.open).toBe(false)
  })

  it('继承打开不读目录，切到自定义才读取并生成初选', async () => {
    const { client } = createClient()
    vi.mocked(client.getAvailableModels).mockResolvedValue([
      { provider: 'provider', modelId: 'model' },
      { provider: 'other', modelId: 'second' },
    ])
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()
    store.getState().openWorkspaceForm('w1')
    expect(store.getState().form.modelScopeMode).toBe('inherit')
    await store.getState().loadWorkspaceModels()
    expect(client.getAvailableModels).not.toHaveBeenCalled()

    store.getState().setWorkspaceFormName('改名')
    const member = store.getState().form.members[0]
    if (!member) throw new Error('缺少成员')
    store.getState().setWorkspaceMember(member.key, { alias: 'renamed' })
    expect(client.getAvailableModels).not.toHaveBeenCalled()

    store.getState().setWorkspaceModelScopeMode('custom')
    await vi.waitFor(() =>
      expect(store.getState().form.modelPatterns).toEqual(['provider/model', 'other/second']),
    )
    expect(client.getAvailableModels).toHaveBeenCalledTimes(1)
    expect(client.getAvailableModels).toHaveBeenCalledWith({
      workspacePath: '/a',
      workspaceId: 'w1',
      all: true,
    })
    store.getState().setWorkspaceFormModelPatterns(['provider/model'])
    expect(client.getAvailableModels).toHaveBeenCalledTimes(1)

    await store.getState().refreshWorkspaceModels()
    expect(client.refreshModels).toHaveBeenCalledWith({ workspacePath: '/a' })
    expect(client.getAvailableModels).toHaveBeenCalledTimes(2)
    expect(store.getState().form.modelRefreshing).toBe(false)
  })

  it('打开既有自定义工作区保留 patterns，目录按需读取', async () => {
    const { client, setWorkspaceCatalog } = createClient()
    setWorkspaceCatalog(
      catalog([
        workspace('w1', '工作区一', '/a', ['provider/model']),
        workspace('w2', '工作区二', '/b'),
      ]),
    )
    vi.mocked(client.getAvailableModels).mockResolvedValue([
      { provider: 'provider', modelId: 'model' },
      { provider: 'other', modelId: 'second' },
    ])
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().openWorkspaceForm('w1')
    expect(store.getState().form.modelScopeMode).toBe('custom')
    expect(store.getState().form.modelPatterns).toEqual(['provider/model'])
    expect(client.getAvailableModels).not.toHaveBeenCalled()

    // 表单按当前自定义范围读取完整目录；已有 patterns 不被全量初选覆盖。
    await store.getState().loadWorkspaceModels()
    expect(client.getAvailableModels).toHaveBeenCalledWith({
      workspacePath: '/a',
      workspaceId: 'w1',
      all: true,
    })
    expect(store.getState().form.modelPatterns).toEqual(['provider/model'])
  })

  it('编辑自定义范围保存 patterns，跟随全局传 null 清除覆盖', async () => {
    const { client, setWorkspaceCatalog } = createClient()
    setWorkspaceCatalog(
      catalog([
        workspace('w1', '工作区一', '/a', ['provider/model']),
        workspace('w2', '工作区二', '/b'),
      ]),
    )
    vi.mocked(client.updateWorkspace).mockImplementation(async (input) => ({
      ok: true,
      workspace: {
        ...workspace('w1', '工作区一', '/a'),
        revision: 2,
        ...(input.modelPatterns ? { modelPatterns: input.modelPatterns } : {}),
      },
    }))
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().openWorkspaceForm('w1')
    expect(store.getState().form.modelScopeMode).toBe('custom')
    store.getState().setWorkspaceFormModelPatterns(['provider/*:high', 'other/model'])
    await store.getState().saveWorkspaceForm()
    expect(client.updateWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        modelPatterns: ['provider/*:high', 'other/model'],
      }),
    )

    store.getState().openWorkspaceForm('w1')
    store.getState().setWorkspaceModelScopeMode('inherit')
    await store.getState().saveWorkspaceForm()
    expect(client.updateWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: 'w1', modelPatterns: null }),
    )
  })

  it('创建时自定义范围至少一项，跟随全局省略 patterns', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().openWorkspaceForm()
    store.getState().setWorkspaceFormName('自定义工作区')
    const member = store.getState().form.members[0]
    if (!member) throw new Error('缺少默认成员')
    store.getState().setWorkspaceMember(member.key, { alias: 'main', path: '/c' })
    store.getState().setWorkspaceModelScopeMode('custom')
    await store.getState().saveWorkspaceForm()
    expect(client.createWorkspace).not.toHaveBeenCalled()
    expect(store.getState().form.message).toContain('至少需要选择一个模型')

    store.getState().setWorkspaceFormModelPatterns(['provider/model:max'])
    await store.getState().saveWorkspaceForm()
    expect(client.createWorkspace).toHaveBeenCalledWith({
      name: '自定义工作区',
      projects: [{ alias: 'main', path: '/c' }],
      modelPatterns: ['provider/model:max'],
    })

    store.getState().openWorkspaceForm()
    store.getState().setWorkspaceFormName('继承工作区')
    const inherited = store.getState().form.members[0]
    if (!inherited) throw new Error('缺少默认成员')
    store.getState().setWorkspaceMember(inherited.key, { alias: 'main', path: '/d' })
    await store.getState().saveWorkspaceForm()
    expect(client.createWorkspace).toHaveBeenLastCalledWith({
      name: '继承工作区',
      projects: [{ alias: 'main', path: '/d' }],
    })
  })

  it('创建表单保存后更新唯一工作区实体、关闭表单并给出提示', async () => {
    const { client } = createClient()
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()

    store.getState().openWorkspaceForm()
    store.getState().setWorkspaceFormName('工作区三')
    const member = store.getState().form.members[0]
    expect(member).toBeDefined()
    if (!member) throw new Error('缺少默认成员')
    store.getState().setWorkspaceMember(member.key, { alias: 'main', path: '/c' })
    const noticeRevision = store.getState().noticeRevision
    await store.getState().saveWorkspaceForm()

    expect(browser.serviceStore.getState().workspacesById.w3).toMatchObject({
      name: '工作区三',
      projects: [{ alias: 'main', path: '/c', available: true }],
    })
    expect(browser.serviceStore.getState().workspaceIds).toEqual(['w1', 'w2', 'w3'])
    expect(store.getState().form.open).toBe(false)
    expect(store.getState().notice).toBe('工作区已创建。')
    // 同一文本再次提示也必须推进代次，toast 才能重置自动消失计时。
    expect(store.getState().noticeRevision).toBe(noticeRevision + 1)
    store.getState().showNotice('工作区已创建。')
    expect(store.getState().noticeRevision).toBe(noticeRevision + 2)
  })
})

describe('workspace-store：首个工作区创建', () => {
  it('创建成功后成为活动工作区并展开', async () => {
    const { client, setWorkspaceCatalog } = createClient()
    setWorkspaceCatalog({ state: 'ok', workspaces: [] })
    const browser = createBrowser(client)
    const store = createStore(browser, memoryStorage())
    await store.getState().refresh()
    expect(store.getState().activeWorkspaceId).toBeUndefined()

    store.getState().openWorkspaceForm()
    store.getState().setWorkspaceFormName('首个工作区')
    const member = store.getState().form.members[0]
    if (!member) throw new Error('缺少默认成员')
    store.getState().setWorkspaceMember(member.key, { alias: 'main', path: '/first' })
    await store.getState().saveWorkspaceForm()

    expect(store.getState().activeWorkspaceId).toBe('w3')
    expect(store.getState().expandedWorkspaceIds.has('w3')).toBe(true)
  })
})
