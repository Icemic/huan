import type {
  HarnessClient,
  HarnessCommandCatalog,
  HarnessHostInfo,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createComposerFeatureStore } from './composer-store'
import { createSessionsFeatureStore } from './sessions-store'
import { createWorkspaceFeatureStore } from './workspace-store'

const hostInfo: HarnessHostInfo = {
  workspacePath: '/workspace',
  agentDir: '/agent',
  agentDirSource: 'settings',
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
      providers: [],
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
} => {
  const browser = createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })
  const workspaceStore = createWorkspaceFeatureStore({ browser, storage: null })
  const sessions = createSessionsFeatureStore({ browser })
  const composer = createComposerFeatureStore({
    browser,
    workspaceStore,
    sessionsStore: sessions,
  })
  return { browser, composer, sessions }
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
