import { ProjectTrustRequiredError, ThreadStructureBusyError } from '@huan/core'
import type {
  HarnessClient,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessRecentProject,
  HarnessThreadDetails,
  HarnessThreadMetadata,
  HarnessWorkspace,
} from '@huan/protocol'
import { createHarnessHttpClient } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { ServerConfig } from './config.js'

const config: ServerConfig = {
  workspacePath: '/workspace',
  agentDir: '/private/agent',
  port: 8788,
  allowedHosts: ['localhost:8788'],
  allowedOrigins: ['http://localhost:8799'],
  token: 'test-token',
}

const headers = {
  host: 'localhost:8788',
  origin: 'http://localhost:8799',
  'x-huan-token': 'test-token',
}

const project: HarnessProjectInfo = {
  path: '/projects/app',
  name: 'app',
  status: 'needs-trust',
  trust: {
    decision: 'unknown',
    origin: 'ask',
    requiresTrust: true,
    defaultPolicy: 'ask',
    extensionErrorCount: 0,
  },
}

const pathCheck: HarnessProjectPathCheck = {
  input: '/projects/app',
  path: '/projects/app',
  exists: true,
  isDirectory: true,
}

const recent: HarnessRecentProject[] = [{ path: '/projects/app', name: 'app' }]

const workspace: HarnessWorkspace = {
  id: 'ws_1',
  name: '幻开发',
  revision: 2,
  projects: [
    { alias: 'harness', path: '/projects/app', available: true },
    { alias: 'editor', path: '/projects/editor', available: false },
  ],
}

const thread: HarnessThreadMetadata = {
  id: 't1',
  status: 'idle',
  workspaceId: 'ws_1',
  workspacePath: '/projects/app',
  workspaceRevision: 2,
  workspaceAppliedRevision: 2,
}

function setup(overrides: Partial<HarnessClient> = {}) {
  const client = {
    getHostInfo: vi.fn(),
    getHostInteractions: vi.fn(async () => ({ seq: 0, requests: [], notifications: [] })),
    subscribeHostInteractions: vi.fn(() => () => {}),
    respondToHostInteraction: vi.fn(async () => ({ accepted: true })),
    consumeHostUiDirective: vi.fn(async () => true),
    listWorkspaces: vi.fn(async () => ({ workspaces: [], state: 'ok' as const })),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    assignThreadWorkspace: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    getThread: vi.fn(),
    getThreadDetails: vi.fn(),
    listCommands: vi.fn(async () => ({
      commands: [],
      skillCommandsEnabled: true,
      diagnostics: [],
    })),
    getCommandArgumentCompletions: vi.fn(async () => []),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    getResources: vi.fn(),
    reloadResources: vi.fn(),
    getProviderAuth: vi.fn(async () => ({
      seq: 0,
      authRevision: 0,
      providers: [],
      operations: [],
    })),
    subscribeProviderAuth: vi.fn(() => () => {}),
    startProviderLogin: vi.fn(),
    respondProviderAuthPrompt: vi.fn(),
    cancelProviderAuth: vi.fn(),
    logoutProvider: vi.fn(),
    getMcp: vi.fn(),
    getMcpDetails: vi.fn(),
    getMcpConfig: vi.fn(),
    saveMcpConfig: vi.fn(),
    manageMcp: vi.fn(),
    getMcpAuth: vi.fn(async () => ({ seq: 0, authRevision: 0, operations: [] })),
    startMcpLogin: vi.fn(),
    respondMcpAuth: vi.fn(),
    cancelMcpAuth: vi.fn(),
    logoutMcp: vi.fn(),
    searchFiles: vi.fn(async () => ({ files: [], truncated: false })),
    getThreadTree: vi.fn(),
    navigateThreadTree: vi.fn(),
    setThreadEntryLabel: vi.fn(),
    cancelThreadTreeNavigation: vi.fn(),
    forkThread: vi.fn(),
    previewThreadImport: vi.fn(),
    importThread: vi.fn(),
    sendMessage: vi.fn(async () => ({ disposition: 'started' as const })),
    cancelRun: vi.fn(),
    clearQueue: vi.fn(),
    checkProjectPath: vi.fn(async () => pathCheck),
    getProject: vi.fn(async () => project),
    inspectProjectTrust: vi.fn(async () => project),
    decideProjectTrust: vi.fn(async () => ({ ...project, status: 'ready' as const })),
    listRecentProjects: vi.fn(async () => recent),
    getAvailableModels: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    runThreadBash: vi.fn(),
    abortThreadBash: vi.fn(),
    compactThread: vi.fn(),
    abortThreadCompaction: vi.fn(),
    setAutoCompaction: vi.fn(),
    getThreadModelScope: vi.fn(),
    setThreadModelScope: vi.fn(),
    refreshModels: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn(),
    unarchiveThread: vi.fn(),
    deleteThread: vi.fn(),
    respondToHostUiRequest: vi.fn(),
    subscribe: vi.fn(),
    ...overrides,
  } satisfies HarnessClient
  return { app: createApp(client, config), client }
}

describe('项目入口路由与真实 HTTP 客户端', () => {
  it('路径校验、查询、信任决定与最近项目都经统一鉴权路由', async () => {
    const { app, client } = setup()
    const pathResponse = await app.request('/api/pi/projects/check', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/projects/app' }),
    })
    expect(await pathResponse.json()).toEqual(pathCheck)
    expect(client.checkProjectPath).toHaveBeenCalledWith('/projects/app')

    const infoResponse = await app.request('/api/pi/projects/info?path=%2Fprojects%2Fapp', {
      headers,
    })
    expect(await infoResponse.json()).toEqual(project)
    expect(client.getProject).toHaveBeenCalledWith({ path: '/projects/app' })

    const trustResponse = await app.request('/api/pi/projects/trust', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/projects/app', trusted: true, remember: true }),
    })
    expect(await trustResponse.json()).toMatchObject({ status: 'ready' })
    expect(client.decideProjectTrust).toHaveBeenCalledWith({
      path: '/projects/app',
      trusted: true,
      remember: true,
    })

    expect(await (await app.request('/api/pi/projects', { headers })).json()).toEqual(recent)
  })

  it('未信任创建返回可识别的 409，而不是通用 500', async () => {
    const { app } = setup({
      createThread: vi.fn(async () => {
        throw new ProjectTrustRequiredError(project)
      }),
    })
    const response = await app.request('/api/pi/threads', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws_1', startProjectPath: '/projects/app' }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'project-needs-trust', project })
  })

  it('客户端解析项目响应并拒绝畸形载荷', async () => {
    const { app } = setup()
    const client = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })
    expect(await client.checkProjectPath('/projects/app')).toEqual(pathCheck)
    expect(await client.getProject({ path: '/projects/app' })).toEqual(project)
    expect(await client.inspectProjectTrust({ path: '/projects/app' })).toEqual(project)
    expect(
      await client.decideProjectTrust({ path: '/projects/app', trusted: true, remember: true }),
    ).toMatchObject({ status: 'ready' })
    expect(await client.listRecentProjects()).toEqual(recent)

    const invalid = createHarnessHttpClient({
      fetchImpl: (async () => Response.json({ path: '/x' })) as typeof fetch,
    })
    await expect(invalid.getProject({ path: '/x' })).rejects.toThrow('Invalid Pi HTTP response')
    await expect(invalid.listRecentProjects()).rejects.toThrow('Invalid Pi HTTP response')
  })
})

describe('工作区路由与真实 HTTP 客户端', () => {
  it('列出/创建/修改工作区、归属会话与按 workspaceId 过滤会话', async () => {
    const { app, client } = setup({
      listThreads: vi.fn(async () => [thread]),
      createWorkspace: vi.fn(async () => ({ ok: true as const, workspace })),
      updateWorkspace: vi.fn(async () => ({
        ok: false as const,
        error: 'conflict' as const,
        workspace,
      })),
      assignThreadWorkspace: vi.fn(async () => ({ ok: true as const, thread })),
    })
    const http = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })

    expect(await http.listWorkspaces()).toEqual({
      workspaces: [],
      state: 'ok',
    })
    expect(
      await http.createWorkspace({
        name: '幻开发',
        projects: [{ alias: 'harness', path: '/projects/app' }],
      }),
    ).toEqual({ ok: true, workspace })
    expect(client.createWorkspace).toHaveBeenCalledWith({
      name: '幻开发',
      projects: [{ alias: 'harness', path: '/projects/app' }],
    })

    expect(
      await http.updateWorkspace({
        workspaceId: 'ws_1',
        expectedRevision: 1,
        name: '新名字',
        projects: [{ alias: 'harness', path: '/projects/app' }],
      }),
    ).toEqual({ ok: false, error: 'conflict', workspace })
    expect(client.updateWorkspace).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      expectedRevision: 1,
      name: '新名字',
      projects: [{ alias: 'harness', path: '/projects/app' }],
    })

    expect(await http.assignThreadWorkspace({ threadId: 't1', workspaceId: 'ws_1' })).toEqual({
      ok: true,
      thread,
    })
    expect(client.assignThreadWorkspace).toHaveBeenCalledWith({
      threadId: 't1',
      workspaceId: 'ws_1',
    })

    expect(await http.listThreads({ workspaceId: 'ws_1', unassigned: true })).toEqual([thread])
    expect(client.listThreads).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      unassigned: true,
      includeArchived: false,
    })
  })

  it('拒绝畸形工作区响应并要求刷新/重试', async () => {
    const invalid = createHarnessHttpClient({
      fetchImpl: (async () =>
        Response.json({ workspaces: [{ id: 1 }], state: 'ok' })) as typeof fetch,
    })
    await expect(invalid.listWorkspaces()).rejects.toThrow('Invalid Pi HTTP response')
  })
})

describe('会话列表刷新与只读详情路由', () => {
  const details: HarnessThreadDetails = {
    metadata: thread,
    stats: {
      userMessages: 1,
      assistantMessages: 2,
      toolResults: 3,
      toolCalls: 4,
      totalMessages: 6,
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
      cost: 0.0123,
    },
    contextUsage: { tokens: 500, contextWindow: 32_768, percent: 1.53 },
    branchEntryCount: 7,
  }

  it('传递显式刷新参数并往返只读详情，均经受保护路由', async () => {
    const { app, client } = setup({
      listThreads: vi.fn(async () => [thread]),
      getThreadDetails: vi.fn(async () => details),
    })
    const http = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })

    expect(await http.listThreads({ includeArchived: true, refresh: true })).toEqual([thread])
    expect(client.listThreads).toHaveBeenCalledWith({ includeArchived: true, refresh: true })

    expect(await http.getThreadDetails('t1')).toEqual(details)
    expect(client.getThreadDetails).toHaveBeenCalledWith('t1')

    // 无凭证/无来源的请求被安全中间件拒绝，不会读到会话文件。
    const denied = await app.request('/api/pi/threads/t1/details', {
      headers: { host: 'localhost:8788' },
    })
    expect(denied.status).toBe(401)
  })

  it('详情失败传播为宿主错误响应，畸形载荷被客户端拒绝', async () => {
    const failing = setup({
      getThreadDetails: vi.fn(async () => {
        throw new Error('detail failure')
      }),
    })
    const failed = await failing.app.request('/api/pi/threads/t1/details', { headers })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'internal-error' })

    const invalid = createHarnessHttpClient({
      fetchImpl: (async () =>
        Response.json({ metadata: thread, stats: {}, branchEntryCount: 0 })) as typeof fetch,
    })
    await expect(invalid.getThreadDetails('t1')).rejects.toThrow('Invalid Pi HTTP response')
  })
})

describe('会话树路由与真实 HTTP 客户端', () => {
  const tree = {
    threadId: 't1',
    leafId: 'e2',
    revision: 'v1:2:e2',
    branchSummarySkipPrompt: false,
    nodes: [
      {
        entryId: 'e1',
        parentId: null,
        depth: 0,
        kind: 'user' as const,
        entryType: 'message',
        role: 'user',
        summary: '第一问',
        timestamp: '2026-10-31T00:00:00.000Z',
        active: true,
        isLeaf: false,
        childCount: 1,
      },
      {
        entryId: 'e2',
        parentId: 'e1',
        depth: 1,
        kind: 'assistant' as const,
        entryType: 'message',
        role: 'assistant',
        summary: '第一答',
        active: true,
        isLeaf: true,
        childCount: 0,
        hasToolCalls: true,
      },
    ],
  }
  const navigateResult = {
    status: 'applied' as const,
    leafId: 'e1',
    treeRevision: 'v1:2:e1',
    editorText: '第一问',
    persistence: 'saved' as const,
    recoveredQueue: { steering: ['引导'], followUp: ['后续'] },
  }
  const labelResult = {
    status: 'applied' as const,
    label: '起点',
    treeRevision: 'v1:3:e2',
    persistence: 'saved' as const,
  }

  it('读取、导航、标签与取消经鉴权路由并回传 JSON 结果', async () => {
    const { app, client } = setup({
      getThreadTree: vi.fn(async () => tree),
      navigateThreadTree: vi.fn(async () => navigateResult),
      setThreadEntryLabel: vi.fn(async () => labelResult),
      cancelThreadTreeNavigation: vi.fn(async () => ({ status: 'cancelled' as const })),
    })
    const http = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })

    expect(await http.getThreadTree('t1')).toEqual(tree)
    expect(client.getThreadTree).toHaveBeenCalledWith('t1')

    expect(
      await http.navigateThreadTree('t1', {
        targetId: 'e1',
        expectedRevision: 'v1:2:e2',
        summarize: true,
        customInstructions: '保留决策',
        stopRunning: true,
      }),
    ).toEqual(navigateResult)
    expect(client.navigateThreadTree).toHaveBeenCalledWith('t1', {
      targetId: 'e1',
      expectedRevision: 'v1:2:e2',
      summarize: true,
      customInstructions: '保留决策',
      stopRunning: true,
    })

    expect(
      await http.setThreadEntryLabel('t1', {
        entryId: 'e1',
        label: '起点',
        expectedRevision: 'v1:2:e2',
      }),
    ).toEqual(labelResult)
    expect(client.setThreadEntryLabel).toHaveBeenCalledWith('t1', {
      entryId: 'e1',
      label: '起点',
      expectedRevision: 'v1:2:e2',
    })

    expect(await http.cancelThreadTreeNavigation('t1')).toEqual({ status: 'cancelled' })
    expect(client.cancelThreadTreeNavigation).toHaveBeenCalledWith('t1')
  })

  it('缺少 targetId/expectedRevision 返回 400，busy 返回可识别 409', async () => {
    const { app } = setup()
    const invalid = await app.request('/api/pi/threads/t1/tree/navigate', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'e1' }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid-tree-input' })

    const busy = setup({
      navigateThreadTree: vi.fn(async () => {
        throw new ThreadStructureBusyError()
      }),
    })
    const response = await busy.app.request('/api/pi/threads/t1/tree/navigate', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'e1', expectedRevision: 'v1:2:e2' }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'thread-structure-busy' })
  })

  it('畸形树载荷被客户端拒绝', async () => {
    const invalid = createHarnessHttpClient({
      fetchImpl: (async () => Response.json({ threadId: 't1' })) as typeof fetch,
    })
    await expect(invalid.getThreadTree('t1')).rejects.toThrow('Invalid Pi HTTP response')
  })
})

describe('独立分支与 JSONL 导入路由', () => {
  const forkResult = {
    status: 'created' as const,
    threadId: 'child',
    parentThreadId: 't1',
    selectedText: '第一问',
    snapshot: { metadata: { ...thread, id: 'child' }, messages: [] },
  }
  const importPreview = {
    status: 'ok' as const,
    source: { kind: 'path' as const, id: 'imported', cwd: '/projects/app', entries: 2, version: 3 },
    workspaceId: 'ws_1',
    cwd: '/projects/app',
    sourceCwd: { path: '/projects/app', available: true, workspaceMember: true },
    sessionDir: '/sessions/app',
    conflict: 'none' as const,
    warnings: ['请确认没有敏感信息'],
  }
  const importResult = { status: 'imported' as const, threadId: 'imported', preview: importPreview }

  it('fork 路由校验输入并经客户端往返结果', async () => {
    const { app, client } = setup({ forkThread: vi.fn(async () => forkResult) })
    const http = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })

    expect(
      await http.forkThread('t1', {
        entryId: 'e1',
        position: 'before',
        expectedRevision: 'v1:2:e1',
      }),
    ).toEqual(forkResult)
    expect(client.forkThread).toHaveBeenCalledWith('t1', {
      entryId: 'e1',
      position: 'before',
      expectedRevision: 'v1:2:e1',
    })

    const invalidPosition = await app.request('/api/pi/threads/t1/fork', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ entryId: 'e1', position: 'middle' }),
    })
    expect(invalidPosition.status).toBe(400)
    expect(await invalidPosition.json()).toEqual({ error: 'invalid-fork-input' })

    const invalidEntry = await app.request('/api/pi/threads/t1/fork', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ entryId: 1 }),
    })
    expect(invalidEntry.status).toBe(400)
  })

  it('导入预览/确认路由传递路径与上传源，并拒绝超大或缺失输入', async () => {
    const { app, client } = setup({
      previewThreadImport: vi.fn(async () => importPreview),
      importThread: vi.fn(async () => importResult),
    })
    const http = createHarnessHttpClient({
      baseUrl: 'http://localhost:8788/api/pi',
      headers,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    })

    expect(
      await http.previewThreadImport({
        source: { kind: 'path', path: '/tmp/source.jsonl' },
        workspaceId: 'ws_1',
      }),
    ).toEqual(importPreview)
    expect(client.previewThreadImport).toHaveBeenCalledWith({
      source: { kind: 'path', path: '/tmp/source.jsonl' },
      workspaceId: 'ws_1',
    })

    expect(
      await http.importThread({
        source: { kind: 'upload', filename: 'source.jsonl', content: '{}\n' },
        workspaceId: 'ws_1',
        asCopy: true,
        expectedSourceId: 'imported',
        expectedSourceFingerprint: 'fingerprint-v1',
      }),
    ).toEqual(importResult)
    expect(client.importThread).toHaveBeenCalledWith({
      source: { kind: 'upload', filename: 'source.jsonl', content: '{}\n' },
      workspaceId: 'ws_1',
      asCopy: true,
      expectedSourceId: 'imported',
      expectedSourceFingerprint: 'fingerprint-v1',
    })

    // 无效源与缺少工作区在读取正文前被路由拒绝。
    const invalidSource = await app.request('/api/pi/threads/import/preview', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'other' } }),
    })
    expect(invalidSource.status).toBe(400)
    expect(await invalidSource.json()).toEqual({ error: 'invalid-import-input' })

    const missingWorkspace = await app.request('/api/pi/threads/import', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'path', path: '/tmp/a.jsonl' } }),
    })
    expect(missingWorkspace.status).toBe(400)

    // Content-Length 超限时直接 413，不读取正文。
    const tooLarge = await app.request('/api/pi/threads/import/preview', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': String(30 * 1024 * 1024),
      },
      body: '{}',
    })
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({ error: 'import-too-large' })

    // 不带 Content-Length 的流也逐块计数，超限不能进入客户端实现。
    const chunk = new Uint8Array(1024 * 1024).fill(32)
    let chunks = 0
    const streamed = new Request('http://localhost:8788/api/pi/threads/import/preview', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: new ReadableStream({
        pull(controller) {
          if (chunks++ < 25) controller.enqueue(chunk)
          else controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)
    const oversizedStream = await app.fetch(streamed)
    expect(oversizedStream.status).toBe(413)
    expect(client.previewThreadImport).toHaveBeenCalledTimes(1)
  })

  it('畸形 fork/导入载荷被客户端拒绝', async () => {
    const invalid = createHarnessHttpClient({
      fetchImpl: (async () => Response.json({ status: 'created', threadId: 1 })) as typeof fetch,
    })
    await expect(invalid.forkThread('t1', { position: 'at' })).rejects.toThrow(
      'Invalid Pi HTTP response',
    )
    await expect(
      invalid.previewThreadImport({ source: { kind: 'path', path: '/x' } }),
    ).rejects.toThrow('Invalid Pi HTTP response')
    await expect(
      invalid.importThread({ source: { kind: 'path', path: '/x' }, workspaceId: 'ws_1' }),
    ).rejects.toThrow('Invalid Pi HTTP response')
  })
})

describe('运行操作路由', () => {
  it('Shell 启动/取消与压缩/自动压缩按受控载荷转发', async () => {
    const bashRun = {
      id: 'bash:1',
      command: 'echo hi',
      excludeFromContext: true,
      cwd: '/projects/app',
      status: 'running' as const,
      output: '',
      outputTruncated: false,
      startedAt: '2026-08-18T00:00:00.000Z',
    }
    const { app, client } = setup({
      runThreadBash: vi.fn(async () => ({ status: 'started' as const, run: bashRun })),
      abortThreadBash: vi.fn(async () => ({ status: 'requested' as const })),
      compactThread: vi.fn(async () => ({ status: 'compacted' as const, tokensBefore: 10 })),
      abortThreadCompaction: vi.fn(async () => ({ status: 'idle' as const })),
      setAutoCompaction: vi.fn(async (_id, enabled) => ({
        status: 'saved' as const,
        enabled,
        scope: 'global' as const,
      })),
    })

    const bash = await app.request('/api/pi/threads/t1/bash', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi', excludeFromContext: true }),
    })
    expect(bash.status).toBe(200)
    expect(await bash.json()).toMatchObject({ status: 'started' })
    expect(client.runThreadBash).toHaveBeenCalledWith('t1', {
      command: 'echo hi',
      excludeFromContext: true,
    })

    const abort = await app.request('/api/pi/threads/t1/bash/abort', {
      method: 'POST',
      headers,
    })
    expect(await abort.json()).toEqual({ status: 'requested' })

    const compact = await app.request('/api/pi/threads/t1/compact', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ customInstructions: '保留决策' }),
    })
    expect(await compact.json()).toEqual({ status: 'compacted', tokensBefore: 10 })
    expect(client.compactThread).toHaveBeenCalledWith('t1', { customInstructions: '保留决策' })

    const cancelCompact = await app.request('/api/pi/threads/t1/compact/abort', {
      method: 'POST',
      headers,
    })
    expect(await cancelCompact.json()).toEqual({ status: 'idle' })

    const auto = await app.request('/api/pi/threads/t1/auto-compaction', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(await auto.json()).toMatchObject({ status: 'saved', enabled: false })
    expect(client.setAutoCompaction).toHaveBeenCalledWith('t1', false)
  })

  it('非法运行输入返回 400，不触达宿主', async () => {
    const { app, client } = setup()
    const cases: Array<{ path: string; body: unknown }> = [
      { path: '/api/pi/threads/t1/bash', body: { command: 1 } },
      { path: '/api/pi/threads/t1/compact', body: { customInstructions: 1 } },
      { path: '/api/pi/threads/t1/auto-compaction', body: { enabled: 'yes' } },
      { path: '/api/pi/threads/t1/model-scope', body: { patterns: 'a/b' } },
    ]
    for (const item of cases) {
      const response = await app.request(item.path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(item.body),
      })
      expect(response.status).toBe(400)
    }
    expect(client.runThreadBash).not.toHaveBeenCalled()
    expect(client.compactThread).not.toHaveBeenCalled()
    expect(client.setAutoCompaction).not.toHaveBeenCalled()
    expect(client.setThreadModelScope).not.toHaveBeenCalled()
  })

  it('模型范围读取与刷新按显式会话/固定目录转发', async () => {
    const scope = {
      patterns: ['huan-test/test-model-a'],
      models: [{ provider: 'huan-test', modelId: 'test-model-a' }],
      diagnostics: [],
    }
    const { app, client } = setup({
      getThreadModelScope: vi.fn(async () => scope),
      setThreadModelScope: vi.fn(async (_id, input) => ({
        ...scope,
        patterns: input.patterns,
        persistence: 'saved' as const,
      })),
      refreshModels: vi.fn(async () => ({ models: [], failedProviders: [] })),
    })

    expect(await (await app.request('/api/pi/threads/t1/model-scope', { headers })).json()).toEqual(
      scope,
    )

    const updated = await app.request('/api/pi/threads/t1/model-scope', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ patterns: ['a/b'], saveAsDefault: true }),
    })
    expect(await updated.json()).toMatchObject({ patterns: ['a/b'], persistence: 'saved' })
    expect(client.setThreadModelScope).toHaveBeenCalledWith('t1', {
      patterns: ['a/b'],
      saveAsDefault: true,
    })

    const refresh = await app.request('/api/pi/models/refresh', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/ws' }),
    })
    expect(await refresh.json()).toEqual({ models: [], failedProviders: [] })
    expect(client.refreshModels).toHaveBeenCalledWith({ workspacePath: '/ws' })
  })

  it('宿主交互查询/应答与消息调用方窗口走同一鉴权路由', async () => {
    const snapshot = { seq: 2, requests: [], notifications: [] }
    const { app, client } = setup({
      getHostInteractions: vi.fn(async () => snapshot),
      respondToHostInteraction: vi.fn(async () => ({ accepted: true })),
    })

    expect(await (await app.request('/api/pi/interactions', { headers })).json()).toEqual(snapshot)
    const answered = await app.request('/api/pi/interactions/respond', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ response: { requestId: 'r1', confirmed: true } }),
    })
    expect(await answered.json()).toEqual({ accepted: true })
    expect(client.respondToHostInteraction).toHaveBeenCalledWith({
      requestId: 'r1',
      confirmed: true,
    })

    const sent = await app.request('/api/pi/threads/t1/messages', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-huan-caller': 'window-a',
      },
      body: JSON.stringify({ input: { content: 'hello' } }),
    })
    expect(sent.status).toBe(200)
    expect(client.sendMessage).toHaveBeenCalledWith(
      't1',
      { content: 'hello' },
      { callerId: 'window-a' },
    )

    const consumed = await app.request('/api/pi/threads/t1/host-ui/consume', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'd1' }),
    })
    expect(consumed.status).toBe(200)
    expect(client.consumeHostUiDirective).toHaveBeenCalledWith('t1', 'd1', { callerId: undefined })
  })
})
