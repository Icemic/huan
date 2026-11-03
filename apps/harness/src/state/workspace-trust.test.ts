import type {
  HarnessClient,
  HarnessHostInfo,
  HarnessProjectInfo,
  HarnessWorkspace,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceFeatureStore } from './workspace-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
    readiness: { state: 'ready', selection: { provider: 'p', modelId: 'm' }, source: 'env' },
  },
  diagnostics: [],
}

const workspace: HarnessWorkspace = {
  id: 'w1',
  name: '工作区',
  revision: 1,
  projects: [{ alias: 'main', path: '/workspace', available: true }],
}

const trustedProject = (path: string): HarnessProjectInfo => ({
  path,
  name: 'workspace',
  status: 'ready',
  trust: {
    decision: 'trusted',
    origin: 'explicit',
    requiresTrust: true,
    defaultPolicy: 'ask',
    extensionErrorCount: 0,
  },
})

const needsTrustProject = (path: string): HarnessProjectInfo => ({
  path,
  name: 'workspace',
  status: 'needs-trust',
  trust: {
    decision: 'unknown',
    origin: 'ask',
    requiresTrust: true,
    defaultPolicy: 'ask',
    extensionErrorCount: 0,
  },
})

const createFakeClient = () => {
  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    listThreads: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => ({
      state: 'ok' as const,
      startupWorkspaceId: 'w1',
      workspaces: [workspace],
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
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    checkProjectPath: vi.fn(async (path: string) => ({
      input: path,
      path,
      exists: true,
      isDirectory: true,
    })),
    inspectProjectTrust: vi.fn(async ({ path }: { path: string }) => needsTrustProject(path)),
    getProject: vi.fn(async ({ path }: { path: string }) => needsTrustProject(path)),
    decideProjectTrust: vi.fn(async ({ path }: { path: string; trusted: boolean }) =>
      trustedProject(path),
    ),
  } as unknown as HarnessClient
  return client
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({ client, connectionKey: 'test', windowId: 'window-a', storage: null })

const createStore = (client: HarnessClient) => {
  const browser = createBrowser(client)
  return { browser, store: createWorkspaceFeatureStore({ browser, storage: null }) }
}

describe('workspace feature：路径健康与信任', () => {
  it('检查成员路径与只读信任；换路径后旧结果不覆盖', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().refresh()
    store.getState().openWorkspaceForm('w1')
    const member = store.getState().form.members[0]
    if (!member) throw new Error('缺少成员')

    await store.getState().inspectWorkspaceMember(member.key)
    expect(client.checkProjectPath).toHaveBeenCalledWith('/workspace')
    expect(client.inspectProjectTrust).toHaveBeenCalledWith({ path: '/workspace' })
    expect(store.getState().form.members[0]).toMatchObject({
      available: true,
      trust: expect.objectContaining({ status: 'needs-trust' }),
    })

    const gate = deferred<Awaited<ReturnType<HarnessClient['inspectProjectTrust']>>>()
    vi.mocked(client.inspectProjectTrust).mockReturnValueOnce(gate.promise)
    const inspecting = store.getState().inspectWorkspaceMember(member.key)
    store.getState().setWorkspaceMember(member.key, { path: '/other' })
    gate.resolve(trustedProject('/workspace'))
    await inspecting
    expect(store.getState().form.members[0]?.available).toBeUndefined()
    expect(store.getState().form.members[0]?.trust).toBeUndefined()
  })

  it('信任决定带 remember 并更新同路径成员', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().refresh()
    store.getState().openWorkspaceForm('w1')
    await store.getState().openTrust('/workspace')
    expect(store.getState().trust.info?.status).toBe('needs-trust')

    store.getState().setTrustRemember(true)
    const info = await store.getState().decideTrust(true)
    expect(info?.status).toBe('ready')
    expect(client.decideProjectTrust).toHaveBeenCalledWith({
      path: '/workspace',
      trusted: true,
      remember: true,
    })
    expect(store.getState().trust.open).toBe(false)
    expect(store.getState().form.members[0]?.trust?.trust.decision).toBe('trusted')
  })

  it('独立信任弹层关闭保留面板到退出完成，内嵌面板立即清空', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().refresh()

    await store.getState().openTrust('/workspace', { kind: 'standalone' })
    store.getState().closeTrust()
    expect(store.getState().trust.open).toBe(false)
    expect(store.getState().trust.path).toBe('/workspace')
    expect(store.getState().trust.intent?.kind).toBe('standalone')

    // 退出动画期间重新打开：旧关闭的完成回调不得清空新面板。
    await store.getState().openTrust('/workspace', { kind: 'standalone' })
    store.getState().finishCloseTrust()
    expect(store.getState().trust.open).toBe(true)

    store.getState().closeTrust()
    store.getState().finishCloseTrust()
    expect(store.getState().trust.intent).toBeUndefined()

    // 内嵌面板（无独立弹层）关闭后立即清空，不保留退出视图。
    await store.getState().openTrust('/workspace')
    store.getState().closeTrust()
    expect(store.getState().trust.path).toBe('')
    expect(store.getState().trust.intent).toBeUndefined()
  })
})

describe('workspace feature：新建会话预检', () => {
  it('路径不可用时不读取项目状态', async () => {
    const client = createFakeClient()
    vi.mocked(client.checkProjectPath).mockResolvedValueOnce({
      input: '/workspace',
      path: '/workspace',
      exists: false,
      isDirectory: false,
      error: { code: 'not-found' },
    })
    const { store } = createStore(client)
    await store.getState().refresh()
    store.getState().openNewSession('w1')
    await store.getState().startNewSession()
    expect(client.getProject).not.toHaveBeenCalled()
    expect(store.getState().newSession.message).toContain('不存在')
    expect(store.getState().newSession.workspaceId).toBe('w1')
  })

  it('需要信任时先开户信任面板，允许后继续开始新会话', async () => {
    const client = createFakeClient()
    const { browser, store } = createStore(client)
    await store.getState().refresh()
    store.getState().openNewSession('w1')
    await store.getState().startNewSession()

    expect(store.getState().trust.open).toBe(true)
    expect(store.getState().trust.intent).toMatchObject({
      kind: 'new-session',
      workspaceId: 'w1',
      startProjectPath: '/workspace',
    })
    expect(store.getState().newSession.workspaceId).toBe('w1')

    await store.getState().decideTrust(true)
    // 新会话弹层以关闭状态保留内容供退出动画使用，完成后才清空。
    expect(store.getState().newSession.open).toBe(false)
    expect(store.getState().newSession.workspaceId).toBe('w1')
    store.getState().finishCloseNewSession()
    expect(store.getState().newSession.workspaceId).toBeUndefined()
    expect(browser.windowStore.getState().selection).toEqual({
      kind: 'new',
      workspaceId: 'w1',
      startProjectPath: '/workspace',
    })
  })

  it('工作区元数据损坏时拒绝新会话与保存', async () => {
    const client = createFakeClient()
    vi.mocked(client.listWorkspaces).mockResolvedValue({
      state: 'corrupted',
      workspaces: [],
    })
    const { store } = createStore(client)
    await store.getState().refresh()
    expect(store.getState().error).toBe('state-unavailable')

    store.getState().openWorkspaceForm()
    store.getState().setWorkspaceFormName('新工作区')
    await store.getState().saveWorkspaceForm()
    expect(client.createWorkspace).not.toHaveBeenCalled()
    expect(store.getState().form.message).toContain('不可用')
  })
})
