import type {
  HarnessClient,
  HarnessMcpAuthSnapshot,
  HarnessMcpConfigFile,
  HarnessMcpConfigSnapshot,
  HarnessMcpDetails,
  HarnessMcpServerSummary,
  HarnessMcpSnapshot,
  HarnessMcpTargetInput,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser, HarnessHttpError } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { mcpDraftKey } from './mcp-config'
import { createMcpFeatureStore, type McpTargetInput, selectMcpServerRows } from './mcp-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const isGlobalTarget = (input: HarnessMcpTargetInput): boolean => input.global === true

const resolvedTarget = (input: HarnessMcpTargetInput): HarnessMcpSnapshot['target'] =>
  isGlobalTarget(input)
    ? { kind: 'global', workspacePath: '' }
    : input.threadId
      ? { kind: 'session', threadId: input.threadId, workspacePath: '/workspace' }
      : { kind: 'workspace', workspacePath: input.workspacePath ?? '/workspace' }

const configFile = (scope: 'user' | 'project', content: string): HarnessMcpConfigFile => ({
  scope,
  path: scope === 'user' ? '/agent/mcp.json' : '/workspace/.pi/mcp.json',
  readable: true,
  exists: true,
  content,
  revision: `rev-${scope}`,
  bytes: content.length,
  tooLarge: false,
  issues: [],
})

const configSnapshotOf = (
  input: HarnessMcpTargetInput,
  options?: { user?: string; project?: string; projectTrusted?: boolean },
): HarnessMcpConfigSnapshot => {
  const projectTrusted = options?.projectTrusted ?? true
  const global = isGlobalTarget(input)
  return {
    target: resolvedTarget(input),
    projectTrusted,
    trust: {
      decision: projectTrusted ? 'trusted' : 'untrusted',
      requiresTrust: true,
      origin: 'explicit',
    },
    files: {
      user: configFile(
        'user',
        options?.user ??
          '{\n  "mcpServers": {\n    "demo": { "command": "node" }\n  },\n  "unknown": 1\n}\n',
      ),
      project: global
        ? {
            ...configFile('project', ''),
            readable: false,
            exists: false,
            revision: null,
            bytes: 0,
          }
        : configFile('project', options?.project ?? '{\n  "mcpServers": {}\n}\n'),
    },
    effective: {
      servers: [],
      issues: [],
    },
  }
}

const serverOf = (
  name = 'demo',
  overrides: Partial<HarnessMcpServerSummary> = {},
): HarnessMcpServerSummary => ({
  name,
  identity: `identity-${name}`,
  scope: 'user',
  override: false,
  enabled: true,
  exposure: 'codemode',
  state: 'connected',
  toolCount: 2,
  hasResources: true,
  toolRevision: 3,
  auth: {
    kind: 'oauth',
    loginable: true,
    hasCredentials: true,
    needsRefresh: false,
  },
  ...overrides,
})

const liveSnapshotOf = (
  input: HarnessMcpTargetInput,
  servers: readonly HarnessMcpServerSummary[] = [serverOf()],
): HarnessMcpSnapshot => ({
  target: resolvedTarget(input),
  live: true,
  runtime: { runtimeId: 'runtime-1', revision: 1, started: true, closed: false },
  projectTrusted: true,
  trust: { decision: 'trusted', requiresTrust: true, origin: 'explicit' },
  servers,
})

const authSnapshotOf = (
  operations: HarnessMcpAuthSnapshot['operations'] = [],
): HarnessMcpAuthSnapshot => ({ seq: 1, authRevision: 1, operations })

const detailsOf = (input: {
  target: HarnessMcpDetails['target']
  server: string
  runtimeId: string
}): HarnessMcpDetails => ({
  target: input.target,
  runtimeId: input.runtimeId,
  server: {
    name: input.server,
    identity: `identity-${input.server}`,
    state: 'connected',
    exposure: 'codemode',
    toolRevision: 3,
  },
  tools: [],
  resources: [],
  resourceTemplates: [],
})

const createStore = () => {
  const client = {
    getMcp: vi.fn(async (input: McpTargetInput) => liveSnapshotOf(input)),
    getMcpConfig: vi.fn(async (input: McpTargetInput) => configSnapshotOf(input)),
    saveMcpConfig: vi.fn(),
    getMcpDetails: vi.fn(
      async (input: { target: McpTargetInput; server: string }) =>
        ({
          status: 'ok',
          details: detailsOf({
            target: resolvedTarget(input.target),
            server: input.server,
            runtimeId: 'runtime-1',
          }),
        }) as const,
    ),
    manageMcp: vi.fn(),
    getMcpAuth: vi.fn(async () => authSnapshotOf()),
    startMcpLogin: vi.fn(),
    logoutMcp: vi.fn(),
    respondMcpAuth: vi.fn(async () => ({ status: 'accepted' as const })),
    cancelMcpAuth: vi.fn(),
    reloadResources: vi.fn(),
    getThread: vi.fn(),
  } as unknown as HarnessClient
  const browser: HarnessBrowser = createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })
  // 认证轮询由浏览器资源单独测试；本文件只验证业务动作与快照消费。
  vi.spyOn(browser, 'setMcpAuthPanelOpen').mockImplementation(() => {})
  vi.spyOn(browser, 'refreshMcpAuth').mockResolvedValue(undefined)
  const store = createMcpFeatureStore({ browser })
  return { client, browser, store }
}

const draftOf = (
  store: ReturnType<typeof createStore>['store'],
  target: string,
  scope: 'user' | 'project',
) => store.getState().drafts[mcpDraftKey(target, scope)]

describe('MCP feature：配置草稿、dirty 与目标保护', () => {
  it('关闭重开保留 dirty 草稿与秘密，不覆盖用户的未保存原文', async () => {
    const { browser, store } = createStore()
    browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: 't1' })
    await store.getState().openPanel()
    await store.getState().loadConfig()
    const key = 't:t1'
    expect(draftOf(store, key, 'user')?.content).toContain('"unknown": 1')

    const edited = '{\n  "mcpServers": { "demo": { "env": { "TOKEN": "secret-token" } } }\n}\n'
    store.getState().updateDraft(edited)
    store.getState().close()
    expect(store.getState().drafts[mcpDraftKey(key, 'user')]?.content).toContain('secret-token')

    await store.getState().openPanel()
    await store.getState().loadConfig()
    expect(draftOf(store, key, 'user')?.content).toContain('secret-token')
    expect(store.getState().notice).toBeUndefined()
    expect(store.getState().error).toBeUndefined()
  })

  it('换目标后旧配置/快照响应不覆盖新目标', async () => {
    const { client, store } = createStore()
    const oldSnapshot = deferred<HarnessMcpSnapshot>()
    vi.mocked(client.getMcp).mockImplementationOnce(async () => oldSnapshot.promise)
    const openingOld = store.getState().openPanel({ target: { threadId: 't1' } })
    await store.getState().openPanel({ target: { threadId: 't2' } })
    expect(store.getState().targetKey).toBe('t:t2')
    oldSnapshot.resolve(liveSnapshotOf({ threadId: 't1' }))
    await openingOld
    expect(store.getState().snapshot?.target.threadId).toBe('t2')
    expect(store.getState().targetKey).toBe('t:t2')
  })

  it('保存只写磁盘，更新所属草稿基线与 revision；随后编辑不被迟到回执覆盖', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1' } })
    await store.getState().loadConfig()
    const key = 't:t1'
    const savedContent = '{\n  "mcpServers": { "demo": { "command": "node" } }\n}\n'
    const gate = deferred<Awaited<ReturnType<HarnessClient['saveMcpConfig']>>>()
    vi.mocked(client.saveMcpConfig).mockReturnValueOnce(gate.promise)

    store.getState().updateDraft('{\n  "first": true\n}\n')
    const saving = store.getState().saveConfig()
    expect(client.saveMcpConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { threadId: 't1' },
        scope: 'user',
        expectedRevision: 'rev-user',
      }),
    )
    store.getState().updateDraft(savedContent)
    gate.resolve({
      status: 'saved',
      scope: 'user',
      path: '/agent/mcp.json',
      revision: 'rev-2',
      bytes: savedContent.length,
      snapshot: configSnapshotOf({ threadId: 't1' }, { user: savedContent }),
      apply: { persisted: true, reloadRequired: true, message: '已保存 MCP 配置' },
    })
    await saving

    const draft = draftOf(store, key, 'user')
    expect(draft?.content).toContain('"command": "node"')
    expect(draft?.baseContent).toContain('"first": true')
    expect(draft?.revision).toBe('rev-2')
    expect(draft?.content).not.toBe(draft?.baseContent)
    expect(store.getState().notice).toContain('已保存，可应用到当前会话')
    expect(client.reloadResources).not.toHaveBeenCalled()
  })

  it('冲突保留草稿，受控错误不回显配置秘密', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1' } })
    await store.getState().loadConfig()
    store
      .getState()
      .updateDraft('{\n  "mcpServers": { "demo": { "env": { "TOKEN": "secret-token" } } }\n}\n')
    vi.mocked(client.saveMcpConfig).mockRejectedValueOnce(
      new HarnessHttpError('conflict', 409, 'mcp-config-conflict'),
    )
    await store.getState().saveConfig()
    expect(store.getState().error).toContain('保存冲突')
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('secret-token')
    expect(
      JSON.stringify({ error: store.getState().error, notice: store.getState().notice }),
    ).not.toContain('secret-token')
  })

  it('关闭完成后才清理 raw 快照与详情；详情迟到结果不附着新面板', async () => {
    const { client, store } = createStore()
    const oldDetails = deferred<Awaited<ReturnType<HarnessClient['getMcpDetails']>>>()
    vi.mocked(client.getMcpDetails).mockReturnValueOnce(oldDetails.promise)
    await store.getState().openPanel({ target: { threadId: 't1' } })
    await store.getState().loadConfig()
    store.getState().updateDraft('{\n  "dirty": true\n}\n')
    const selecting = store.getState().selectServer('demo')
    expect(store.getState().detailsLoading).toBe(true)
    store.getState().close()
    // 关闭请求后快照仍保留，供对话框退出动画期间渲染；完成后才清理。
    expect(store.getState().snapshot).toBeDefined()
    expect(store.getState().configSnapshot).toBeDefined()
    expect(store.getState().detailsLoading).toBe(true)
    store.getState().finishClose()
    expect(store.getState().snapshot).toBeUndefined()
    expect(store.getState().configSnapshot).toBeUndefined()
    expect(store.getState().details).toBeUndefined()
    expect(store.getState().detailsLoading).toBe(false)
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('dirty')

    oldDetails.resolve({
      status: 'ok',
      details: detailsOf({
        target: { kind: 'session', threadId: 't1', workspacePath: '/workspace' },
        server: 'demo',
        runtimeId: 'runtime-1',
      }),
    })
    await selecting
    expect(store.getState().details).toBeUndefined()
    expect(store.getState().detailsError).toBeUndefined()
  })

  it('保存不应用；显式资源重载才刷新当前会话', async () => {
    const { client, store } = createStore()
    vi.mocked(client.reloadResources).mockResolvedValueOnce({
      status: 'reloaded',
      kind: 'session',
      threadId: 't1',
      workspacePath: '/workspace',
      operation: {
        id: 'reload-1',
        trigger: 'api',
        status: 'succeeded',
        threadId: 't1',
        workspacePath: '/workspace',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        fromResourceRevision: 1,
        resourceRevision: 2,
      },
      resourceRevision: 2,
      snapshot: {
        metadata: { id: 't1', status: 'idle', workspacePath: '/workspace' },
        messages: [],
      },
    })
    await store.getState().openPanel({ target: { threadId: 't1' } })
    expect(client.getMcpConfig).not.toHaveBeenCalled()
    await store.getState().applyReload()
    expect(client.reloadResources).toHaveBeenCalledWith({ threadId: 't1', trigger: 'api' })
    expect(store.getState().notice).toBe('已应用到当前会话')
  })

  it('空白页保存与应用使用项目资源文案', async () => {
    const { client, store } = createStore()
    const content = '{\n  "mcpServers": {}\n}\n'
    vi.mocked(client.saveMcpConfig).mockResolvedValueOnce({
      status: 'saved',
      scope: 'user',
      path: '/agent/mcp.json',
      revision: 'rev-2',
      bytes: content.length,
      snapshot: configSnapshotOf({ workspacePath: '/workspace' }, { user: content }),
      apply: { persisted: true, reloadRequired: true, message: '已保存 MCP 配置' },
    })
    vi.mocked(client.reloadResources).mockResolvedValueOnce({
      status: 'reloaded',
      kind: 'workspace',
      workspacePath: '/workspace',
      operation: {
        id: 'reload-1',
        trigger: 'api',
        status: 'succeeded',
        workspacePath: '/workspace',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        fromResourceRevision: 1,
        resourceRevision: 2,
      },
      resourceRevision: 2,
    })
    await store.getState().openPanel({ target: { workspacePath: '/workspace' } })
    await store.getState().loadConfig()
    store.getState().updateDraft(content)
    await store.getState().saveConfig()
    expect(store.getState().notice).toBe('已保存，可刷新项目资源')
    await store.getState().applyReload()
    expect(store.getState().notice).toBe('已刷新项目资源')
  })

  it('草稿与临时操作只提示动作结果', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1' } })
    await store.getState().loadConfig()
    store.getState().openEditServer('demo')
    store.getState().applyServerEditor()
    expect(store.getState().notice).toBe('草稿已更新')

    store.getState().requestDeleteServer('demo')
    store.getState().confirmDeleteServer()
    expect(store.getState().notice).toBe('已从草稿删除 demo')

    const row = selectMcpServerRows(store.getState())[0]
    if (!row) throw new Error('测试缺少 MCP 服务器行')
    vi.mocked(client.manageMcp).mockResolvedValueOnce({
      status: 'applied',
      snapshot: liveSnapshotOf({ threadId: 't1' }),
    })
    await store.getState().manage(row, { type: 'reconnect' })
    expect(store.getState().notice).toBe('已更新 demo')
  })

  it('管理操作 stale/busy 只刷新快照，不自动重试写操作', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { threadId: 't1' } })
    const row = selectMcpServerRows(store.getState())[0]
    if (!row) throw new Error('测试缺少 MCP 服务器行')
    expect(row.identity).toBe('identity-demo')
    vi.mocked(client.manageMcp).mockResolvedValueOnce({
      status: 'stale',
      message: 'runtime 已变化',
    })
    const before = vi.mocked(client.getMcp).mock.calls.length
    await store.getState().manage(row, { type: 'reconnect' })
    expect(client.manageMcp).toHaveBeenCalledTimes(1)
    expect(store.getState().notice).toContain('runtime 已变化')
    expect(vi.mocked(client.getMcp).mock.calls.length).toBeGreaterThan(before)
  })
})

describe('MCP feature：全局用户配置', () => {
  it('全局目标只读取用户配置，不查询 live、不探测路径', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { global: true }, tab: 'servers' })

    expect(client.getMcp).not.toHaveBeenCalled()
    expect(client.getMcpConfig).toHaveBeenCalledWith({ global: true })
    expect(store.getState().targetKey).toBe('global')
    expect(store.getState().tab).toBe('config')
    expect(store.getState().scope).toBe('user')
    expect(store.getState().snapshot).toBeUndefined()
    expect(draftOf(store, 'global', 'user')?.content).toContain('"unknown": 1')
    expect(draftOf(store, 'global', 'project')).toBeUndefined()

    await store.getState().refreshLive()
    await store.getState().applyReload()
    expect(client.getMcp).not.toHaveBeenCalled()
    expect(client.reloadResources).not.toHaveBeenCalled()
  })

  it('全局保存只写 user 作用域并报告已保存，不提示应用', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { global: true } })
    const content = '{\n  "mcpServers": { "demo": { "command": "node" } }\n}\n'
    store.getState().updateDraft(content)
    vi.mocked(client.saveMcpConfig).mockResolvedValueOnce({
      status: 'saved',
      scope: 'user',
      path: '/agent/mcp.json',
      revision: 'rev-global-2',
      bytes: content.length,
      snapshot: configSnapshotOf({ global: true }, { user: content }),
      apply: { persisted: true, reloadRequired: true, message: '已保存 MCP 配置' },
    })

    await store.getState().saveConfig()

    expect(client.saveMcpConfig).toHaveBeenCalledWith(
      expect.objectContaining({ target: { global: true }, scope: 'user' }),
    )
    expect(store.getState().notice).toBe('已保存')
    expect(store.getState().error).toBeUndefined()
    expect(client.reloadResources).not.toHaveBeenCalled()
  })

  it('全局配置冲突保留草稿且不回显秘密', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({ target: { global: true } })
    store
      .getState()
      .updateDraft('{\n  "mcpServers": { "demo": { "env": { "TOKEN": "secret-token" } } }\n}\n')
    vi.mocked(client.saveMcpConfig).mockRejectedValueOnce(
      new HarnessHttpError('conflict', 409, 'mcp-config-conflict'),
    )

    await store.getState().saveConfig()

    expect(store.getState().error).toContain('保存冲突')
    expect(draftOf(store, 'global', 'user')?.content).toContain('secret-token')
    expect(
      JSON.stringify({ error: store.getState().error, notice: store.getState().notice }),
    ).not.toContain('secret-token')
  })

  it('项目目标固定 project 作用域，不混入用户配置', async () => {
    const { client, store } = createStore()
    await store.getState().openPanel({
      target: { workspacePath: '/workspace' },
      tab: 'config',
      scope: 'user',
    })

    expect(store.getState().scope).toBe('project')
    expect(store.getState().tab).toBe('config')
    expect(client.getMcpConfig).toHaveBeenCalledWith({ workspacePath: '/workspace' })
    store.getState().setScope('user')
    expect(store.getState().scope).toBe('project')
  })
})

describe('MCP feature：认证短期回填与身份隔离', () => {
  it('回填先清空再提交；关闭面板不取消远端操作', async () => {
    const { browser, client, store } = createStore()
    const operation = {
      id: 'op-1',
      server: 'demo',
      identity: 'identity-demo',
      kind: 'login' as const,
      phase: 'prompt' as const,
      target: { kind: 'session' as const, threadId: 't1', workspacePath: '/workspace' },
      runtimeId: 'runtime-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      authUrl: 'https://example.test/authorize',
      prompt: { promptId: 'p1', kind: 'redirect_url' as const, message: '回调 URL' },
    }
    browser.serviceStore.getState().applyMcpAuth(authSnapshotOf([operation]))
    await store.getState().openPanel({ target: { threadId: 't1' } })
    store.getState().setAnswer('op-1', 'p1', 'https://callback.test/?code=secret-code')
    vi.mocked(client.respondMcpAuth).mockImplementationOnce(async () => {
      expect(store.getState().answers['op-1|p1']).toBeUndefined()
      return { status: 'accepted' }
    })
    await store.getState().submitPrompt(operation, operation.prompt)
    expect(client.respondMcpAuth).toHaveBeenCalledWith({
      operationId: 'op-1',
      promptId: 'p1',
      value: 'https://callback.test/?code=secret-code',
    })
    store.getState().close()
    expect(store.getState().answers).toEqual({})
    expect(client.cancelMcpAuth).not.toHaveBeenCalled()
  })

  it('取消认证发送取消请求并保留服务端终态', async () => {
    const { browser, client, store } = createStore()
    browser.serviceStore.getState().applyMcpAuth(authSnapshotOf())
    await store.getState().openPanel({ target: { threadId: 't1' } })
    vi.mocked(client.cancelMcpAuth).mockResolvedValueOnce({ status: 'not-found' })
    await store.getState().cancelAuth('op-missing')
    expect(client.cancelMcpAuth).toHaveBeenCalledWith('op-missing')
    expect(store.getState().notice).toContain('已不存在')
    expect(store.getState().cancelling).toEqual({})
  })

  it('/mcp login <server> 在快照就绪后启动登录，使用 runtime/identity', async () => {
    const { client, store } = createStore()
    vi.mocked(client.startMcpLogin).mockResolvedValueOnce({
      status: 'started',
      operation: {
        id: 'op-1',
        server: 'demo',
        identity: 'identity-demo',
        kind: 'login',
        phase: 'starting',
        target: { kind: 'session', threadId: 't1', workspacePath: '/workspace' },
        runtimeId: 'runtime-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    })
    await store.getState().openPanel({
      target: { threadId: 't1' },
      mode: 'login',
      server: 'demo',
    })
    expect(client.startMcpLogin).toHaveBeenCalledWith({
      target: { threadId: 't1' },
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: 'identity-demo',
    })
    expect(store.getState().tab).toBe('auth')
    expect(store.getState().notice).toBe('已开始 MCP 登录。')
  })
})
