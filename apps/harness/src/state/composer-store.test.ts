import type {
  HarnessClient,
  HarnessCommandCatalog,
  HarnessHostInfo,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthFeatureStore } from './auth-store'
import { createComposerFeatureStore } from './composer-store'
import { createMcpFeatureStore } from './mcp-store'
import { createModelFeatureStore } from './model-store'
import { createRuntimeFeatureStore } from './runtime-store'
import { createSessionsFeatureStore } from './sessions-store'
import { createSettingsFeatureStore } from './settings-store'
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

const snapshotOf = (threadId: string): HarnessThreadSnapshot => ({
  metadata: {
    id: threadId,
    status: 'idle',
    workspacePath: '/workspace',
    config: { provider: 'provider', modelId: 'model', thinkingLevel: 'medium' },
  },
  messages: [],
  messageEntryIds: [],
  seq: 1,
})

const catalog: HarnessCommandCatalog = {
  commands: [
    {
      name: 'plan',
      description: '模板命令',
      source: 'prompt',
      sourceInfo: {
        path: '/tmp/plan.md',
        source: 'local',
        scope: 'user',
        origin: 'top-level',
      },
      supportsArguments: true,
    },
  ],
  skillCommandsEnabled: true,
  diagnostics: [],
}

const createFakeClient = () => {
  const sent: { threadId: string; content: string; streamingBehavior?: string }[] = []
  const bash: { threadId: string; command: string; exclude: boolean }[] = []
  const searches: { query?: string }[] = []
  const renamed: { threadId: string; title: string }[] = []
  const client = {
    getHostInfo: vi.fn(async () => hostInfo),
    getProviderAuth: vi.fn(async () => ({
      seq: 1,
      authRevision: 1,
      providers: [
        {
          providerId: 'provider-a',
          name: 'Provider A',
          configured: false,
          methods: [{ type: 'api_key', label: 'API key', loginable: true }],
          ambientOnly: false,
        },
      ],
      operations: [],
    })),
    getMcpAuth: vi.fn(async () => ({ seq: 1, authRevision: 1, operations: [] })),
    listThreads: vi.fn(async () => []),
    getThread: vi.fn(async (threadId: string) => snapshotOf(threadId)),
    getThreadTree: vi.fn(async (threadId: string) => ({
      threadId,
      leafId: null,
      revision: `v1:0:${threadId}`,
      nodes: [],
      branchSummarySkipPrompt: true,
    })),
    listCommands: vi.fn(async () => catalog),
    getAvailableModels: vi.fn(async () => [
      {
        provider: 'provider',
        modelId: 'model',
        input: ['text', 'image'],
        availableThinkingLevels: ['off', 'high'],
      },
    ]),
    getSettings: vi.fn(async (input: { threadId?: string; workspacePath?: string }) => ({
      target: input.threadId
        ? { kind: 'session' as const, threadId: input.threadId, workspacePath: '/workspace' }
        : { kind: 'workspace' as const, workspacePath: input.workspacePath ?? '/workspace' },
      agentDir: '/agent',
      projectTrusted: true,
      trust: { decision: 'trusted' as const, requiresTrust: false, origin: 'explicit' },
      files: {
        user: {
          scope: 'user' as const,
          path: '/agent/settings.json',
          exists: false,
          content: '{}\n',
          revision: null,
          bytes: 3,
          readable: true,
          tooLarge: false,
          issues: [],
        },
        project: {
          scope: 'project' as const,
          path: '/workspace/.pi/settings.json',
          exists: false,
          content: '{}\n',
          revision: null,
          bytes: 3,
          readable: true,
          tooLarge: false,
          issues: [],
        },
      },
      effective: { source: 'disk' as const, values: {}, origins: {} },
    })),
    getResources: vi.fn(async (input: { threadId?: string; workspacePath?: string }) => ({
      target: input.threadId
        ? { kind: 'session' as const, threadId: input.threadId, workspacePath: '/workspace' }
        : { kind: 'workspace' as const, workspacePath: input.workspacePath ?? '/workspace' },
      agentDir: '/agent',
      trust: { decision: 'trusted' as const, requiresTrust: false, origin: 'explicit' },
      loadedFrom: 'session' as const,
      projectResourcesLoaded: true,
      instructions: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      packages: [],
      loaded: [],
      diagnostics: [],
    })),
    reloadResources: vi.fn(async (input: { threadId?: string; workspacePath?: string }) => ({
      status: 'reloaded' as const,
      kind: input.threadId ? ('session' as const) : ('workspace' as const),
      workspacePath: '/workspace',
      ...(input.threadId ? { threadId: input.threadId } : {}),
      operation: {
        id: 'reload-1',
        trigger: 'settings' as const,
        status: 'succeeded' as const,
        workspacePath: '/workspace',
        startedAt: '2026-01-01T00:00:00.000Z',
        fromResourceRevision: 0,
        resourceRevision: 1,
      },
      resourceRevision: 1,
    })),
    getThreadDetails: vi.fn(async (threadId: string) => ({
      metadata: { id: threadId, status: 'idle' as const, workspacePath: '/workspace' },
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
    })),
    inspectProjectTrust: vi.fn(async ({ path }: { path: string }) => ({
      path,
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
    getProject: vi.fn(async ({ path }: { path: string }) => ({
      path,
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
    getCommandArgumentCompletions: vi.fn(async () => []),
    searchFiles: vi.fn(async (input: { query?: string }) => {
      searches.push(input)
      return {
        files: [
          {
            path: '/workspace/src/file.ts',
            reference: 'src/file.ts',
            relativePath: 'src/file.ts',
            kind: 'file' as const,
          },
        ],
        truncated: false,
      }
    }),
    sendMessage: vi.fn(
      async (threadId: string, input: { content: string; streamingBehavior?: string }) => {
        sent.push({
          threadId,
          content: input.content,
          ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
        })
        return { disposition: 'started' as const }
      },
    ),
    runThreadBash: vi.fn(
      async (threadId: string, input: { command: string; excludeFromContext?: boolean }) => {
        bash.push({
          threadId,
          command: input.command,
          exclude: input.excludeFromContext === true,
        })
        return {
          status: 'started' as const,
          run: {
            id: 'bash',
            command: input.command,
            excludeFromContext: input.excludeFromContext === true,
            cwd: '/workspace',
            status: 'running' as const,
            output: '',
            outputTruncated: false,
            startedAt: new Date().toISOString(),
          },
        }
      },
    ),
    renameThread: vi.fn(async (threadId: string, title: string) => {
      renamed.push({ threadId, title })
    }),
    cancelRun: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    subscribeProviderAuth: vi.fn(() => () => {}),
    subscribeHostInteractions: vi.fn(() => () => {}),
  } as unknown as HarnessClient
  return { client, sent, bash, searches, renamed }
}

const createApp = (
  client: HarnessClient,
): {
  browser: HarnessBrowser
  composer: ReturnType<typeof createComposerFeatureStore>
  sessions: ReturnType<typeof createSessionsFeatureStore>
  settings: ReturnType<typeof createSettingsFeatureStore>
  auth: ReturnType<typeof createAuthFeatureStore>
  mcp: ReturnType<typeof createMcpFeatureStore>
  runtime: ReturnType<typeof createRuntimeFeatureStore>
  model: ReturnType<typeof createModelFeatureStore>
} => {
  const browser = createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })
  const workspaceStore = createWorkspaceFeatureStore({ browser, storage: null })
  const sessions = createSessionsFeatureStore({ browser })
  const settingsStore = createSettingsFeatureStore({ browser })
  const authStore = createAuthFeatureStore({ browser })
  const mcp = createMcpFeatureStore({ browser })
  const runtime = createRuntimeFeatureStore({ browser })
  const model = createModelFeatureStore({ browser })
  const composer = createComposerFeatureStore({
    browser,
    workspaceStore,
    sessionsStore: sessions,
    settingsStore,
    authStore,
    mcpStore: mcp,
    runtimeStore: runtime,
    modelStore: model,
  })
  return {
    browser,
    composer,
    sessions,
    settings: settingsStore,
    auth: authStore,
    mcp,
    runtime,
    model,
  }
}

const selectThread = (browser: HarnessBrowser, threadId = 't1') => {
  browser.windowStore.getState().selectTarget({ kind: 'thread', threadId })
  return `thread:${threadId}`
}

const selectNew = (browser: HarnessBrowser) => {
  browser.windowStore.getState().selectTarget({
    kind: 'new',
    workspaceId: 'w1',
    startProjectPath: '/workspace',
  })
  return 'new:w1:%2Fworkspace'
}

describe('composer feature：内置命令、Shell 与普通提交', () => {
  it('/tree 进入会话 feature 并在处理成功后清理捕获草稿', async () => {
    const fake = createFakeClient()
    const { browser, composer, sessions } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/tree')

    await composer.getState().submit()
    expect(sessions.getState().tree.open).toBe(true)
    expect(sessions.getState().tree.threadId).toBe('t1')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('扩展 slash 命令仍作为普通消息提交；Shell 走会话动作', async () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    await composer.getState().refreshCatalog()
    browser.windowStore.getState().editDraftText(draftId, '/plan alpha')
    await composer.getState().submit()
    expect(fake.sent.map(({ content }) => content)).toEqual(['/plan alpha'])

    browser.windowStore.getState().editDraftText(draftId, '!!pwd')
    await composer.getState().submit()
    expect(fake.bash).toEqual([{ threadId: 't1', command: 'pwd', exclude: true }])
    expect(browser.windowStore.getState().inputHistory).toEqual(['!!pwd', '/plan alpha'])
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('运行中按队列模式发送 steer/followUp', async () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.serviceStore.getState().applyThreadEvent('t1', {
      type: 'agent_start',
      threadId: 't1',
      seq: 1,
    })

    browser.windowStore.getState().editDraftText(draftId, 'follow')
    await composer.getState().submit()
    composer.getState().setQueueMode('steer')
    browser.windowStore.getState().editDraftText(draftId, 'steer')
    await composer.getState().submit()

    expect(fake.sent).toEqual([
      { threadId: 't1', content: 'follow', streamingBehavior: 'followUp' },
      { threadId: 't1', content: 'steer', streamingBehavior: 'steer' },
    ])
  })

  it('异步model命令不裁剪后来输入的同前缀文本，重复选相同模型仍可消费命令', async () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectNew(browser)
    await composer.getState().refreshCatalog()
    const command = '/model provider/model'
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const models = await fake.client.getAvailableModels()
    vi.mocked(fake.client.getAvailableModels).mockImplementationOnce(async () => {
      await gate
      return models
    })
    browser.windowStore.getState().editDraftText(draftId, command)
    const submit = composer.getState().submit()
    browser.windowStore.getState().editDraftText(draftId, `${command} 这是新编辑`)
    release()
    await submit
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe(`${command} 这是新编辑`)
    browser.windowStore.getState().editDraftText(draftId, command)
    await composer.getState().submit()
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/model 在新会话目标写草稿模型预选', async () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectNew(browser)
    await composer.getState().refreshCatalog()
    browser.windowStore.getState().editDraftText(draftId, '/model provider/model')
    await composer.getState().submit()
    expect(browser.windowStore.getState().draftsById[draftId]?.model).toEqual({
      provider: 'provider',
      modelId: 'model',
    })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
    expect(fake.sent).toEqual([])
  })
})

describe('composer feature：补全、长输入、历史与取回', () => {
  it('命令补全与 @ 文件补全写回同一个草稿', async () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    await composer.getState().refreshCatalog()

    await composer.getState().refreshCompletion('/mo', 3)
    expect(composer.getState().completion).toMatchObject({ kind: 'command' })
    const commandCursor = composer.getState().chooseCompletion()
    expect(commandCursor).toBe('/model '.length)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('/model ')

    browser.windowStore.getState().editDraftText(draftId, 'see @src')
    await composer.getState().refreshCompletion('see @src', 8)
    expect(composer.getState().completion?.items[0]?.label).toBe('src/file.ts')
    composer.getState().chooseCompletion()
    expect(fake.searches[0]?.query).toBe('src')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('see @src/file.ts ')
  })

  it('长输入固定打开时版本，冲突时不覆盖新草稿', () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'one')
    composer.getState().openLongInput()
    browser.windowStore.getState().editDraftText(draftId, 'two')
    composer.getState().setLongInputText('long')
    expect(composer.getState().applyLongInput()).toBe(false)
    expect(composer.getState().longInput?.conflict).toBeDefined()
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('two')
  })

  it('历史来自本窗输入历史并可恢复到浏览前草稿', () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().recordInputHistory('first')
    browser.windowStore.getState().recordInputHistory('second')

    expect(composer.getState().historyUp('')).toBe('second'.length)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('second')
    expect(composer.getState().historyUp('second')).toBe('first'.length)
    expect(composer.getState().historyDown()).toBe('second'.length)
    expect(composer.getState().historyDown()).toBe(0)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('整体取回在草稿未变时写回；已变化则保留入口且不覆盖', async () => {
    const fake = createFakeClient()
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, 'draft')
    const recover = vi.spyOn(browser.sessionActions, 'recoverQueue').mockResolvedValueOnce({
      threadId: 't1',
      status: 'cleared',
      steering: ['a'],
      followUp: ['b'],
    })
    await composer.getState().retrieveQueue()
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('draft\n\na\n\nb')

    recover.mockImplementationOnce(async () => {
      // 模拟取回响应前用户又编辑了草稿。
      browser.windowStore.getState().editDraftText(draftId, 'newer')
      return {
        threadId: 't1',
        status: 'cleared',
        steering: ['c'],
        followUp: [],
      }
    })
    await composer.getState().retrieveQueue()
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('newer')
    expect(composer.getState().recoveredQueue).toMatchObject({ threadId: 't1' })
    expect(composer.getState().restoreRecoveredQueue()).toBe(false)
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('newer')
  })
})

const assistantSnapshot = (threadId: string, text: string): HarnessThreadSnapshot => ({
  metadata: { id: threadId, status: 'idle', workspacePath: '/workspace' },
  messages: [
    {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'test',
      provider: 'provider',
      model: 'model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
    },
  ],
  messageEntryIds: ['e1'],
  seq: 1,
})

describe('composer feature：管理命令路由到 feature 动作', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('/settings 打开设置面板并清空命令文本', async () => {
    const fake = createFakeClient()
    const { browser, composer, settings } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/settings')

    await composer.getState().submit()
    expect(settings.getState().open).toBe(true)
    expect(settings.getState().target).toEqual({ threadId: 't1' })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/login 验证 provider 后打开认证面板；未知 provider 保留输入', async () => {
    const fake = createFakeClient()
    const { browser, composer, auth } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/login provider-a')
    await composer.getState().submit()
    expect(auth.getState().open).toBe(true)
    expect(auth.getState().focusedProvider).toBe('provider-a')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')

    auth.getState().closePanel()
    browser.windowStore.getState().editDraftText(draftId, '/login unknown-provider')
    await composer.getState().submit()
    expect(auth.getState().open).toBe(false)
    expect(composer.getState().notice).toContain('找不到此服务商')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('/login unknown-provider')
  })

  it('/compact 打开运行面板 compact 分段并预填指令', async () => {
    const fake = createFakeClient()
    const { browser, composer, runtime } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/compact 保留决策与风险')
    await composer.getState().submit()
    expect(runtime.getState().open).toBe(true)
    expect(runtime.getState().section).toBe('compact')
    expect(runtime.getState().compactInstructions).toBe('保留决策与风险')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/scoped-models 打开设置面板模型页并固定用户作用域', async () => {
    const fake = createFakeClient()
    const { browser, composer, settings } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/scoped-models')
    await composer.getState().submit()
    expect(settings.getState().open).toBe(true)
    expect(settings.getState().tab).toBe('models')
    expect(settings.getState().scope).toBe('user')
    expect(settings.getState().target).toEqual({ threadId: 't1' })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/clone 只打开 fork 确认，不在命令处理器里直接创建', async () => {
    const fake = createFakeClient()
    const { browser, composer, sessions } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/clone')
    await composer.getState().submit()
    expect(sessions.getState().forkPanel).toMatchObject({
      open: true,
      sourceThreadId: 't1',
      position: 'at',
    })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/import 打开导入面板并保留参数路径', async () => {
    const fake = createFakeClient()
    const { browser, composer, sessions } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/import /tmp/session.jsonl')
    await composer.getState().submit()
    expect(sessions.getState().importPanel.open).toBe(true)
    expect(sessions.getState().importPanel.path).toBe('/tmp/session.jsonl')
    expect(sessions.getState().importPanel.source).toEqual({
      kind: 'path',
      path: '/tmp/session.jsonl',
    })
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/session、/trust 与 /reload 使用当前目标动作', async () => {
    const fake = createFakeClient()
    const { browser, composer, sessions } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.serviceStore.getState().applyThreadSnapshot('t1', snapshotOf('t1'))

    browser.windowStore.getState().editDraftText(draftId, '/session')
    await composer.getState().submit()
    expect(sessions.getState().details.open).toBe(true)
    expect(sessions.getState().details.threadId).toBe('t1')
    sessions.getState().closeDetails()

    browser.windowStore.getState().editDraftText(draftId, '/trust')
    await composer.getState().submit()
    expect(fake.client.inspectProjectTrust).toHaveBeenCalledWith({ path: '/workspace' })

    browser.windowStore.getState().editDraftText(draftId, '/reload')
    await composer.getState().submit()
    expect(fake.client.reloadResources).toHaveBeenCalledWith({
      threadId: 't1',
      trigger: 'settings',
    })
    expect(composer.getState().notice).toContain('已应用到当前会话')
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })

  it('/copy 复制最后一条助手文本，不发送新消息', async () => {
    const fake = createFakeClient()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.mocked(fake.client.getThread).mockResolvedValueOnce(assistantSnapshot('t1', '最后一条回复'))
    const { browser, composer } = createApp(fake.client)
    const draftId = selectThread(browser)
    browser.windowStore.getState().editDraftText(draftId, '/copy')

    await composer.getState().submit()
    expect(writeText).toHaveBeenCalledWith('最后一条回复')
    expect(fake.sent).toEqual([])
    expect(browser.windowStore.getState().draftsById[draftId]?.text).toBe('')
  })
})
