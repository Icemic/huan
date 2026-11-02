import type {
  HarnessClient,
  HarnessHostInfo,
  HarnessModelInfo,
  HarnessProviderAuthSnapshot,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessWorkspaceCatalog,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessServiceStore,
  modelCatalogKeyOf,
  selectHarnessModelCatalog,
} from './service-store.js'

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

const metadata = (overrides: Partial<HarnessThreadMetadata> = {}): HarnessThreadMetadata => ({
  id: 't1',
  status: 'idle',
  ...overrides,
})

const snapshot = (overrides: Partial<HarnessThreadSnapshot> = {}): HarnessThreadSnapshot => ({
  metadata: metadata(),
  messages: [],
  ...overrides,
})

const providerAuth = (seq: number): HarnessProviderAuthSnapshot => ({
  seq,
  authRevision: seq,
  providers: [],
  operations: [],
})

const workspaceCatalog = (): HarnessWorkspaceCatalog => ({
  state: 'ok',
  startupWorkspaceId: 'w1',
  workspaces: [
    {
      id: 'w1',
      name: '工作区一',
      revision: 2,
      projects: [{ alias: 'main', path: '/workspace', available: true }],
    },
    {
      id: 'w2',
      name: '工作区二',
      revision: 1,
      projects: [{ alias: 'other', path: '/other', available: true }],
    },
  ],
})

const model = (provider: string, modelId: string): HarnessModelInfo => ({ provider, modelId })

const createClient = (overrides: Partial<HarnessClient> = {}): HarnessClient =>
  ({
    getHostInfo: vi.fn(async () => hostInfo),
    listThreads: vi.fn(async () => []),
    getThread: vi.fn(async () => snapshot()),
    listWorkspaces: vi.fn(async () => workspaceCatalog()),
    getAvailableModels: vi.fn(async () => [model('provider', 'model')]),
    getProviderAuth: vi.fn(async () => providerAuth(1)),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
    ...overrides,
  }) as unknown as HarnessClient

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('service-store：唯一元数据与运行数据', () => {
  it('宿主信息写入并回调存储作用域', async () => {
    const onHostInfo = vi.fn()
    const store = createHarnessServiceStore({ client: createClient(), onHostInfo })
    const host = await store.getState().loadHostInfo()
    expect(host).toEqual(hostInfo)
    expect(store.getState().host).toEqual(hostInfo)
    expect(store.getState().hostLoading).toBe(false)
    expect(onHostInfo).toHaveBeenCalledWith(hostInfo)
  })

  it('宿主协议版本不匹配时停止初始化并记录错误', async () => {
    const onHostInfo = vi.fn()
    const store = createHarnessServiceStore({
      client: createClient({
        getHostInfo: vi.fn(async () => ({ ...hostInfo, protocolVersion: 99 })),
      }),
      onHostInfo,
    })
    const host = await store.getState().loadHostInfo()
    expect(host).toBeUndefined()
    expect(store.getState().host).toBeUndefined()
    expect(store.getState().hostError).toContain('协议版本不匹配')
    expect(onHostInfo).not.toHaveBeenCalled()
  })

  it('目录扫描更新唯一实体，保留运行中字段并只保存结果 ID', async () => {
    const client = createClient()
    const store = createHarnessServiceStore({ client })
    store.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 1,
    } as never)
    vi.mocked(client.listThreads).mockResolvedValue([
      metadata({ title: '标题', workspaceId: 'w1', status: 'idle' }),
      metadata({ id: 't2', title: '另一个' }),
    ])

    await store.getState().refreshThreads({ workspaceId: 'w1' })

    expect(store.getState().threadsById.t1).toMatchObject({
      id: 't1',
      title: '标题',
      workspaceId: 'w1',
      // 列表不覆盖运行中的状态。
      status: 'running',
    })
    expect(store.getState().threadsById.t2?.title).toBe('另一个')
    expect(store.getState().catalog.ids).toEqual(['t1', 't2'])
    expect(store.getState().sessionDataById.t1).toBeDefined()
  })

  it('驱逐完整缓存后目录刷新采用新的运行状态', async () => {
    const client = createClient()
    const store = createHarnessServiceStore({ client })
    store
      .getState()
      .applyThreadEvent('t1', { type: 'agent_start', threadId: 't1', seq: 1 } as never)
    store.getState().evictThreadSession('t1')
    vi.mocked(client.listThreads).mockResolvedValue([metadata({ status: 'idle' })])
    await store.getState().refreshThreads()
    expect(store.getState().threadsById.t1?.status).toBe('idle')
  })

  it('认证读取迟到时不覆盖较新的订阅快照', async () => {
    const client = createClient()
    const pending = deferred<HarnessProviderAuthSnapshot>()
    vi.mocked(client.getProviderAuth).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })
    store.getState().applyProviderAuth(providerAuth(1))
    const request = store.getState().refreshProviderAuth()
    store.getState().applyProviderAuth(providerAuth(3))
    pending.resolve(providerAuth(2))
    await request
    expect(store.getState().providerAuth?.seq).toBe(3)
  })

  it('扫描期间被事件更新的实体不被旧列表覆盖', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadMetadata[]>()
    vi.mocked(client.listThreads).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })

    const refresh = store.getState().refreshThreads()
    store.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 1,
    } as never)
    pending.resolve([metadata({ title: '旧扫描', status: 'idle' })])
    await refresh

    expect(store.getState().threadsById.t1?.status).toBe('running')
    // 旧扫描整体跳过该实体，目录字段等下一次扫描更新。
    expect(store.getState().threadsById.t1?.title).toBeUndefined()
  })

  it('旧扫描代次不覆盖新扫描结果', async () => {
    const client = createClient()
    const first = deferred<HarnessThreadMetadata[]>()
    const second = deferred<HarnessThreadMetadata[]>()
    vi.mocked(client.listThreads)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = createHarnessServiceStore({ client })

    const refreshA = store.getState().refreshThreads({ workspaceId: 'a' })
    const refreshB = store.getState().refreshThreads({ workspaceId: 'b' })
    second.resolve([metadata({ id: 'b1' })])
    await refreshB
    first.resolve([metadata({ id: 'a1' })])
    await refreshA

    expect(store.getState().catalog.ids).toEqual(['b1'])
    expect(store.getState().threadsById.a1).toBeUndefined()
  })

  it('冷读快照写入运行数据；迟到的 HTTP 响应不覆盖实时事件', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadSnapshot>()
    vi.mocked(client.getThread).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })

    const load = store.getState().loadThread('t1')
    store.getState().applyThreadEvent('t1', {
      type: 'message_start',
      message: { role: 'user', content: 'live', timestamp: 1 },
      threadId: 't1',
      seq: 2,
    } as never)
    pending.resolve(snapshot({ seq: 1 }))
    await load

    expect(store.getState().sessionDataById.t1?.messages).toEqual([
      { role: 'user', content: 'live', timestamp: 1 },
    ])
    expect(store.getState().sessionDataById.t1?.lastSeq).toBe(2)
    expect(store.getState().sessionDataById.t1?.loadState).toBe('loaded')
  })

  it('同一会话并发冷读复用在途请求', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadSnapshot>()
    vi.mocked(client.getThread).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })
    const first = store.getState().loadThread('t1')
    const second = store.getState().loadThread('t1')
    pending.resolve(snapshot({ seq: 1 }))
    await Promise.all([first, second])
    expect(client.getThread).toHaveBeenCalledTimes(1)
  })

  it('冷读快照在无并发更新时应用并推进加载状态', async () => {
    const client = createClient()
    vi.mocked(client.getThread).mockResolvedValue(
      snapshot({
        seq: 4,
        metadata: metadata({ title: '历史' }),
        messages: [{ role: 'user', content: '历史消息', timestamp: 1 }],
      }),
    )
    const store = createHarnessServiceStore({ client })
    await store.getState().loadThread('t1')
    expect(store.getState().threadsById.t1?.title).toBe('历史')
    expect(store.getState().sessionDataById.t1).toMatchObject({
      loadState: 'loaded',
      lastSeq: 4,
    })
    expect(store.getState().sessionDataById.t1?.messages).toHaveLength(1)
  })

  it('无序号冷读快照不覆盖并发实时状态', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadSnapshot>()
    vi.mocked(client.getThread).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })
    const load = store.getState().loadThread('t1')
    store.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 2,
    } as never)
    pending.resolve(snapshot({ messages: [{ role: 'user', content: '旧历史', timestamp: 1 }] }))
    await load
    expect(store.getState().sessionDataById.t1?.messages).toEqual([])
    expect(store.getState().threadsById.t1?.status).toBe('running')
    expect(store.getState().sessionDataById.t1?.loadState).toBe('loaded')
  })

  it('请求期间序列重置后丢弃旧 HTTP 响应', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadSnapshot>()
    vi.mocked(client.getThread).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })
    store.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 5,
    } as never)
    const load = store.getState().loadThread('t1')
    // 订阅快照把序列重置到 0，此时旧 HTTP 响应（seq 5）来自旧序列。
    store
      .getState()
      .applyThreadSnapshot('t1', snapshot({ seq: 0, metadata: metadata({ status: 'idle' }) }))
    pending.resolve(
      snapshot({ seq: 5, messages: [{ role: 'user', content: '过期', timestamp: 1 }] }),
    )
    await load
    expect(store.getState().sessionDataById.t1?.messages).toEqual([])
    expect(store.getState().sessionDataById.t1?.lastSeq).toBe(0)
  })

  it('冷读失败记录错误并向上抛出', async () => {
    const client = createClient()
    vi.mocked(client.getThread).mockRejectedValue(new Error('boom'))
    const store = createHarnessServiceStore({ client })
    await expect(store.getState().loadThread('t1')).rejects.toThrow('boom')
    expect(store.getState().sessionDataById.t1).toMatchObject({
      loadState: 'loaded',
      lastError: 'boom',
    })
  })

  it('驱逐完整缓存保留目录元数据；迟到冷读不再写入', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadSnapshot>()
    vi.mocked(client.getThread).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })
    store.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 1,
    } as never)

    const load = store.getState().loadThread('t1')
    store.getState().evictThreadSession('t1')
    pending.resolve(
      snapshot({ seq: 5, messages: [{ role: 'user', content: 'late', timestamp: 1 }] }),
    )
    await load

    expect(store.getState().threadsById.t1?.status).toBe('running')
    expect(store.getState().sessionDataById.t1).toBeUndefined()
  })

  it('同一事件更新元数据与运行数据，不产生重复队列字段', () => {
    const store = createHarnessServiceStore({ client: createClient() })
    store.getState().applyThreadEvents('t1', [
      { type: 'agent_start', threadId: 't1', seq: 1 },
      { type: 'queue_update', threadId: 't1', seq: 2, steering: ['s'], followUp: ['f'] },
    ] as never)

    expect(store.getState().threadsById.t1?.status).toBe('running')
    expect(store.getState().threadsById.t1?.queuedMessages).toEqual([
      { id: 'steer:0', mode: 'steer', content: 's' },
      { id: 'followUp:0', mode: 'followUp', content: 'f' },
    ])
    expect(store.getState().sessionDataById.t1).not.toHaveProperty('queue')
    expect(store.getState().sessionDataById.t1).not.toHaveProperty('contextUsage')
    expect(store.getState().threadRevisions.t1).toBeGreaterThan(0)
  })

  it('业务动作返回的权威快照替换运行数据与元数据', () => {
    const store = createHarnessServiceStore({ client: createClient() })
    store.getState().applyThreadSnapshot(
      't1',
      snapshot({
        seq: 3,
        metadata: metadata({ status: 'running', title: '服务端标题' }),
        messages: [{ role: 'user', content: 'x', timestamp: 1 }],
      }),
    )
    expect(store.getState().threadsById.t1).toMatchObject({
      status: 'running',
      title: '服务端标题',
    })
    expect(store.getState().sessionDataById.t1?.lastSeq).toBe(3)
    expect(store.getState().sessionDataById.t1?.messages).toHaveLength(1)
  })

  it('provider 认证序号回退视为宿主重启，相同序号不重复写入', () => {
    const store = createHarnessServiceStore({ client: createClient() })
    store.getState().applyProviderAuth(providerAuth(5))
    const first = store.getState().providerAuth
    store.getState().applyProviderAuth(providerAuth(5))
    expect(store.getState().providerAuth).toBe(first)
    store.getState().applyProviderAuth(providerAuth(2))
    expect(store.getState().providerAuth?.seq).toBe(2)
  })

  it('宿主交互快照同样处理序号回退', () => {
    const store = createHarnessServiceStore({ client: createClient() })
    store.getState().applyHostInteractions({
      type: 'snapshot',
      seq: 4,
      snapshot: { seq: 4, requests: [], notifications: [] },
    })
    store.getState().applyHostInteractions({
      type: 'snapshot',
      seq: 1,
      snapshot: { seq: 1, requests: [], notifications: [] },
    })
    expect(store.getState().hostInteractions?.seq).toBe(1)
  })

  it('MCP 认证快照写入并清除错误；相同序号不重复写入', () => {
    const store = createHarnessServiceStore({ client: createClient() })
    store.getState().setMcpAuthError('读取失败')
    store.getState().applyMcpAuth({ seq: 2, authRevision: 1, operations: [] })
    expect(store.getState().mcpAuth?.seq).toBe(2)
    expect(store.getState().mcpAuthError).toBeUndefined()
    const first = store.getState().mcpAuth
    store.getState().applyMcpAuth({ seq: 2, authRevision: 1, operations: [] })
    expect(store.getState().mcpAuth).toBe(first)
  })

  it('dispose 清空状态、阻止动作与迟到响应', async () => {
    const client = createClient()
    const pending = deferred<HarnessThreadSnapshot>()
    vi.mocked(client.getThread).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })
    const load = store.getState().loadThread('t1')
    store.getState().dispose()
    pending.resolve(snapshot({ seq: 3 }))
    await load

    expect(store.getState().disposed).toBe(true)
    expect(store.getState().threadsById).toEqual({})
    expect(store.getState().sessionDataById).toEqual({})
    store.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 1,
    } as never)
    expect(store.getState().threadsById).toEqual({})
  })

  it('目录查询失败记录受控错误并向上抛出', async () => {
    const client = createClient()
    vi.mocked(client.listThreads).mockRejectedValue(new Error('catalog failed'))
    const store = createHarnessServiceStore({ client })
    await expect(store.getState().refreshThreads()).rejects.toThrow('catalog failed')
    expect(store.getState().catalog).toMatchObject({
      loading: false,
      error: 'catalog failed',
    })
  })
})

describe('service-store：工作区目录唯一来源', () => {
  it('刷新替换工作区实体与顺序，并以权威健康状态覆盖', async () => {
    const client = createClient()
    const store = createHarnessServiceStore({ client })
    await store.getState().refreshWorkspaces()

    expect(store.getState().workspaceIds).toEqual(['w1', 'w2'])
    expect(store.getState().workspacesById.w1).toMatchObject({
      name: '工作区一',
      revision: 2,
    })
    expect(store.getState().workspaceState).toBe('ok')
    expect(store.getState().startupWorkspaceId).toBe('w1')

    vi.mocked(client.listWorkspaces).mockResolvedValue({
      state: 'corrupted',
      workspaces: [
        {
          id: 'w2',
          name: '工作区二（新）',
          revision: 3,
          projects: [],
        },
      ],
    })
    await store.getState().refreshWorkspaces()

    expect(store.getState().workspaceIds).toEqual(['w2'])
    expect(store.getState().workspacesById.w1).toBeUndefined()
    expect(store.getState().workspacesById.w2?.revision).toBe(3)
    expect(store.getState().workspaceState).toBe('corrupted')
    expect(store.getState().startupWorkspaceId).toBeUndefined()
  })

  it('业务动作返回的权威定义更新同一实体且不重复 ID', async () => {
    const store = createHarnessServiceStore({ client: createClient() })
    await store.getState().refreshWorkspaces()
    store.getState().applyWorkspace({
      id: 'w1',
      name: '已更新',
      revision: 4,
      projects: [],
    })
    store.getState().applyWorkspace({
      id: 'w3',
      name: '新工作区',
      revision: 1,
      projects: [],
    })

    expect(store.getState().workspaceIds).toEqual(['w1', 'w2', 'w3'])
    expect(store.getState().workspacesById.w1).toMatchObject({ name: '已更新', revision: 4 })
  })

  it('刷新失败保留上一次成功定义并记录受控错误', async () => {
    const client = createClient()
    vi.mocked(client.listWorkspaces).mockRejectedValue(new Error('workspace failed'))
    const store = createHarnessServiceStore({ client })
    await expect(store.getState().refreshWorkspaces()).rejects.toThrow('workspace failed')

    expect(store.getState().workspaceIds).toEqual([])
    expect(store.getState().workspaceLoading).toBe(false)
    expect(store.getState().workspaceError).toBe('workspace failed')
  })
})

describe('service-store：模型目录按目标与版本唯一', () => {
  it('换目标立即使用新目标空目录，前目标结果不参与', async () => {
    const client = createClient()
    const pending = deferred<HarnessModelInfo[]>()
    vi.mocked(client.getAvailableModels).mockImplementation(async ({ workspacePath } = {}) => {
      if (workspacePath === '/beta') return pending.promise
      return [model('alpha', 'm1')]
    })
    const store = createHarnessServiceStore({ client })
    store.getState().applyProviderAuth(providerAuth(2))

    await store.getState().loadModelCatalog({ workspacePath: '/alpha' })
    const alpha = selectHarnessModelCatalog(store.getState(), { workspacePath: '/alpha' })
    expect(alpha?.models).toEqual([model('alpha', 'm1')])

    const betaLoad = store.getState().loadModelCatalog({ workspacePath: '/beta' })
    const betaLoading = selectHarnessModelCatalog(store.getState(), { workspacePath: '/beta' })
    expect(betaLoading).toMatchObject({ loading: true, models: [] })
    // 前目标结果仍只属于前目标，不被新目标读取。
    expect(
      selectHarnessModelCatalog(store.getState(), { workspacePath: '/alpha' })?.models,
    ).toEqual([model('alpha', 'm1')])

    pending.resolve([model('beta', 'm2')])
    await betaLoad
    expect(selectHarnessModelCatalog(store.getState(), { workspacePath: '/beta' })?.models).toEqual(
      [model('beta', 'm2')],
    )
  })

  it('查询失败记录错误并保持空目录，不回退前目标模型', async () => {
    const client = createClient()
    vi.mocked(client.getAvailableModels).mockImplementation(async ({ workspacePath } = {}) => {
      if (workspacePath === '/beta') throw new Error('models failed')
      return [model('alpha', 'm1')]
    })
    const store = createHarnessServiceStore({ client })
    await store.getState().loadModelCatalog({ workspacePath: '/alpha' })
    await store.getState().loadModelCatalog({ workspacePath: '/beta' })

    expect(selectHarnessModelCatalog(store.getState(), { workspacePath: '/beta' })).toMatchObject({
      loading: false,
      error: 'models failed',
      models: [],
    })
  })

  it('同目标版本推进后只保留当前版本，旧结果不再被选择', async () => {
    const client = createClient()
    vi.mocked(client.getAvailableModels)
      .mockResolvedValueOnce([model('provider', 'old')])
      .mockResolvedValueOnce([model('provider', 'new')])
    const store = createHarnessServiceStore({ client })
    store.getState().applyProviderAuth(providerAuth(1))

    await store.getState().loadModelCatalog({
      workspacePath: '/alpha',
      resourceRevision: 1,
    })
    const oldKey = modelCatalogKeyOf({
      workspacePath: '/alpha',
      resourceRevision: 1,
      authRevision: 1,
    })
    expect(store.getState().modelCatalogByKey[oldKey]).toBeDefined()

    await store.getState().loadModelCatalog({
      workspacePath: '/alpha',
      resourceRevision: 2,
    })

    const current = selectHarnessModelCatalog(store.getState(), {
      workspacePath: '/alpha',
      resourceRevision: 2,
    })
    expect(current?.resourceRevision).toBe(2)
    expect(current?.models).toEqual([model('provider', 'new')])
    expect(store.getState().modelCatalogByKey[oldKey]).toBeUndefined()
  })

  it('会话目标由当前元数据补齐 resource/modelCatalog 版本并随认证版本失效', async () => {
    const client = createClient()
    const store = createHarnessServiceStore({ client })
    store.getState().applyThreadEvent('t1', {
      type: 'snapshot',
      threadId: 't1',
      seq: 1,
      snapshot: snapshot({
        metadata: metadata({
          id: 't1',
          resourceRevision: 3,
          modelCatalogRevision: 5,
        }),
      }),
    } as never)
    store.getState().applyProviderAuth(providerAuth(7))

    await store.getState().loadModelCatalog({ workspacePath: '/alpha', threadId: 't1' })
    expect(
      selectHarnessModelCatalog(store.getState(), { workspacePath: '/alpha', threadId: 't1' }),
    ).toMatchObject({
      threadId: 't1',
      resourceRevision: 3,
      authRevision: 7,
      modelCatalogRevision: 5,
    })

    const previous = selectHarnessModelCatalog(store.getState(), {
      workspacePath: '/alpha',
      threadId: 't1',
    })
    store.getState().applyProviderAuth(providerAuth(8))
    const next = selectHarnessModelCatalog(store.getState(), {
      workspacePath: '/alpha',
      threadId: 't1',
    })
    expect(next).toBeUndefined()
    expect(previous).toBeDefined()
  })

  it('同键并发查询复用在途请求', async () => {
    const client = createClient()
    const pending = deferred<HarnessModelInfo[]>()
    vi.mocked(client.getAvailableModels).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })

    const first = store.getState().loadModelCatalog({ workspacePath: '/alpha' })
    const second = store.getState().loadModelCatalog({ workspacePath: '/alpha' })
    pending.resolve([model('provider', 'model')])
    await Promise.all([first, second])
    expect(client.getAvailableModels).toHaveBeenCalledTimes(1)
  })
})

describe('service-store：工作区扫描代次', () => {
  it('旧扫描不覆盖新扫描结果', async () => {
    const client = createClient()
    const first = deferred<HarnessWorkspaceCatalog>()
    const second = deferred<HarnessWorkspaceCatalog>()
    vi.mocked(client.listWorkspaces)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = createHarnessServiceStore({ client })

    const scanA = store.getState().refreshWorkspaces()
    const scanB = store.getState().refreshWorkspaces()
    second.resolve({
      state: 'ok',
      startupWorkspaceId: 'w2',
      workspaces: [{ ...workspaceCatalog().workspaces[1]!, name: '新扫描' }],
    })
    await scanB
    first.resolve(workspaceCatalog())
    await scanA

    expect(store.getState().workspaceIds).toEqual(['w2'])
    expect(store.getState().workspacesById.w2?.name).toBe('新扫描')
    expect(store.getState().workspacesById.w1).toBeUndefined()
  })

  it('业务修改使在途扫描失效且不保留加载态', async () => {
    const client = createClient()
    const pending = deferred<HarnessWorkspaceCatalog>()
    vi.mocked(client.listWorkspaces).mockReturnValue(pending.promise)
    const store = createHarnessServiceStore({ client })

    const scan = store.getState().refreshWorkspaces()
    store.getState().applyWorkspace({
      id: 'w9',
      name: '新定义',
      revision: 1,
      projects: [],
    })
    pending.resolve(workspaceCatalog())
    await scan

    expect(store.getState().workspaceIds).toEqual(['w9'])
    expect(store.getState().workspacesById.w9?.name).toBe('新定义')
    expect(store.getState().workspaceLoading).toBe(false)
  })
})

describe('service-store：模型目录迟到响应', () => {
  it('版本推进后旧请求完成不重新写回被释放的条目', async () => {
    const client = createClient()
    const old = deferred<HarnessModelInfo[]>()
    vi.mocked(client.getAvailableModels)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([model('provider', 'new')])
    const store = createHarnessServiceStore({ client })

    const oldLoad = store.getState().loadModelCatalog({
      workspacePath: '/alpha',
      resourceRevision: 1,
    })
    await store.getState().loadModelCatalog({
      workspacePath: '/alpha',
      resourceRevision: 2,
    })
    old.resolve([model('provider', 'old')])
    await oldLoad

    const current = selectHarnessModelCatalog(store.getState(), {
      workspacePath: '/alpha',
      resourceRevision: 2,
    })
    expect(current?.models).toEqual([model('provider', 'new')])
    expect(
      Object.values(store.getState().modelCatalogByKey).filter(
        (entry) => entry.workspacePath === '/alpha',
      ),
    ).toHaveLength(1)
  })
})
