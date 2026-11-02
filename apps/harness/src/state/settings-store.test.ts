import type {
  HarnessClient,
  HarnessResourceSnapshot,
  HarnessSettingsFile,
  HarnessSettingsSnapshot,
  HarnessSettingsTarget,
  HarnessSettingsTargetInput,
} from '@huan/protocol'
import { createHarnessBrowser, type HarnessBrowser, HarnessHttpError } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createSettingsFeatureStore, settingsScopedDraftKey } from './settings-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settingsFile = (
  scope: 'user' | 'project',
  content: string,
  revision: string | null = 'r1',
): HarnessSettingsFile => ({
  scope,
  path: scope === 'user' ? '/agent/settings.json' : '/workspace/.pi/settings.json',
  exists: revision !== null,
  content,
  revision,
  bytes: content.length,
  readable: true,
  tooLarge: false,
  issues: [],
})

const resolvedTarget = (target: HarnessSettingsTargetInput): HarnessSettingsTarget =>
  target.threadId
    ? { kind: 'session', threadId: target.threadId, workspacePath: '/workspace' }
    : { kind: 'workspace', workspacePath: target.workspacePath ?? '/workspace' }

const snapshotOf = (
  targetInput: HarnessSettingsTargetInput,
  content = '{\n  "defaultModel": "m1",\n  "unknownField": 1\n}\n',
  projectContent = '{\n  "defaultProvider": "p1"\n}\n',
): HarnessSettingsSnapshot => ({
  target: resolvedTarget(targetInput),
  agentDir: '/agent',
  projectTrusted: true,
  trust: { decision: 'trusted', requiresTrust: true, origin: 'explicit' },
  files: {
    user: settingsFile('user', content),
    project: settingsFile('project', projectContent),
  },
  effective: {
    source: 'disk',
    values: { defaultModel: 'm1' },
    origins: { defaultModel: 'user' },
  },
})

const resourcesOf = (
  targetInput: HarnessSettingsTargetInput,
  withText = false,
): HarnessResourceSnapshot => ({
  target: resolvedTarget(targetInput),
  agentDir: '/agent',
  trust: { decision: 'trusted', requiresTrust: true, origin: 'explicit' },
  loadedFrom: 'session',
  projectResourcesLoaded: true,
  instructions: [
    {
      path: '/workspace/AGENTS.md',
      bytes: 12,
      ...(withText ? { text: 'instruction' } : {}),
    },
  ],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  packages: [],
  loaded: [],
  diagnostics: [],
})

const createFakeClient = () => {
  const target: HarnessSettingsTargetInput = { threadId: 't1' }
  const otherTarget: HarnessSettingsTargetInput = { threadId: 't2' }
  const client = {
    getSettings: vi.fn(async (input: HarnessSettingsTargetInput) =>
      input.threadId === 't2' ? snapshotOf(otherTarget, '{}\n', '{}\n') : snapshotOf(target),
    ),
    saveSettings: vi.fn(),
    getResources: vi.fn(async (input: HarnessSettingsTargetInput & { includeText?: boolean }) =>
      resourcesOf(input, input.includeText === true),
    ),
    reloadResources: vi.fn(),
  } as unknown as HarnessClient
  return client
}

const createBrowser = (client: HarnessClient): HarnessBrowser =>
  createHarnessBrowser({
    client,
    connectionKey: 'test',
    windowId: 'window-a',
    storage: null,
  })

const createStore = (client: HarnessClient, onReloaded?: () => void) => {
  const browser = createBrowser(client)
  return {
    browser,
    store: createSettingsFeatureStore({
      browser,
      ...(onReloaded ? { onResourceReloaded: onReloaded } : {}),
    }),
  }
}

const draftOf = (
  store: ReturnType<typeof createStore>['store'],
  targetKey: string,
  scope: 'user' | 'project',
) => store.getState().drafts[settingsScopedDraftKey(targetKey, scope)]

describe('settings feature：原文、dirty 与目标保护', () => {
  it('打开读取用户/项目原文与资源，关闭重开仍保留 dirty 草稿', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)

    await store.getState().openPanel({ threadId: 't1' })
    expect(store.getState().open).toBe(true)
    expect(store.getState().snapshot?.target.kind).toBe('session')
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('unknownField')
    expect(draftOf(store, 't:t1', 'project')?.content).toContain('defaultProvider')
    expect(store.getState().resources?.instructions[0]?.text).toBeUndefined()

    store.getState().updateDraft('{\n  "edited": true\n}\n')
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('edited')
    store.getState().close()
    expect(store.getState().open).toBe(false)
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('edited')

    await store.getState().openPanel({ threadId: 't1' })
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('edited')
    // 未 dirty 的项目作用域按磁盘权威重读；dirty 用户草稿不被覆盖。
    expect(draftOf(store, 't:t1', 'project')?.content).toContain('defaultProvider')
  })

  it('换目标后旧读取结果不覆盖新目标', async () => {
    const client = createFakeClient()
    const first = deferred<HarnessSettingsSnapshot>()
    vi.mocked(client.getSettings).mockImplementationOnce(async () => first.promise)
    const { store } = createStore(client)

    const openingOld = store.getState().openPanel({ threadId: 't1' })
    await store.getState().openPanel({ threadId: 't2' })
    expect(store.getState().targetKey).toBe('t:t2')
    first.resolve(snapshotOf({ threadId: 't1' }))
    await openingOld
    expect(store.getState().snapshot?.target.threadId).toBe('t2')
  })

  it('保存只写磁盘，成功后更新基线与 revision；不自动重载', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    const target = snapshotOf({ threadId: 't1' })
    vi.mocked(client.saveSettings).mockResolvedValue({
      status: 'saved',
      scope: 'user',
      path: '/agent/settings.json',
      revision: 'r2',
      bytes: 10,
      snapshot: target,
      apply: { persisted: true, reloadRequired: true, restartRequiredKeys: [], message: '已保存' },
    })

    store.getState().updateDraft('{\n  "saved": true\n}\n')
    await store.getState().save()

    expect(client.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { threadId: 't1' },
        scope: 'user',
        expectedRevision: 'r1',
      }),
    )
    expect(draftOf(store, 't:t1', 'user')).toMatchObject({
      content: '{\n  "saved": true\n}\n',
      baseContent: '{\n  "saved": true\n}\n',
      revision: 'r2',
    })
    expect(store.getState().notice).toContain('已保存')
    expect(client.reloadResources).not.toHaveBeenCalled()
  })

  it('保存迟到回执不覆盖之后的新编辑', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    const gate = deferred<Awaited<ReturnType<HarnessClient['saveSettings']>>>()
    vi.mocked(client.saveSettings).mockReturnValueOnce(gate.promise)

    store.getState().updateDraft('{\n  "first": 1\n}\n')
    const saving = store.getState().save()
    store.getState().updateDraft('{\n  "second": 2\n}\n')
    gate.resolve({
      status: 'saved',
      scope: 'user',
      path: '/agent/settings.json',
      revision: 'r2',
      bytes: 10,
      snapshot: snapshotOf({ threadId: 't1' }),
      apply: { persisted: true, reloadRequired: false, restartRequiredKeys: [], message: '已保存' },
    })
    await saving

    const draft = draftOf(store, 't:t1', 'user')
    expect(draft?.content).toContain('second')
    expect(draft?.baseContent).toContain('first')
    expect(draft?.revision).toBe('r2')
    expect(draft?.content).not.toBe(draft?.baseContent)
  })

  it('冲突/校验失败保留草稿与受控错误', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    store.getState().updateDraft('{\n  "conflict": true\n}\n')
    vi.mocked(client.saveSettings).mockRejectedValueOnce(
      new HarnessHttpError('conflict', 409, 'settings-conflict'),
    )
    await store.getState().save()
    expect(store.getState().error).toContain('保存冲突')
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('conflict')

    vi.mocked(client.saveSettings).mockResolvedValueOnce({
      status: 'invalid',
      scope: 'user',
      path: '/agent/settings.json',
      issues: [{ kind: 'schema', path: '/defaultModel', message: '类型错误' }],
      message: '设置无效',
    })
    await store.getState().save()
    expect(store.getState().error).toBe('设置无效')
    expect(draftOf(store, 't:t1', 'user')?.issues).toEqual([
      { kind: 'schema', path: '/defaultModel', message: '类型错误' },
    ])
  })
})

describe('settings feature：资源读取与重载', () => {
  it('正文按需读取，隐藏即清正文；资源重载不重置 dirty 草稿', async () => {
    const client = createFakeClient()
    const onReloaded = vi.fn()
    const { store } = createStore(client, onReloaded)
    await store.getState().openPanel({ threadId: 't1' })
    await store.getState().loadResources(true)
    expect(store.getState().showText).toBe(true)
    expect(store.getState().resources?.instructions[0]?.text).toBe('instruction')

    store.getState().updateDraft('{\n  "dirty": true\n}\n')
    vi.mocked(client.reloadResources).mockResolvedValueOnce({
      status: 'reloaded',
      kind: 'session',
      workspacePath: '/workspace',
      threadId: 't1',
      operation: {
        id: 'op1',
        trigger: 'settings',
        status: 'succeeded',
        workspacePath: '/workspace',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        fromResourceRevision: 2,
        resourceRevision: 3,
      },
      resourceRevision: 3,
    })
    await store.getState().applyResourceReload()
    expect(client.reloadResources).toHaveBeenCalledWith({
      threadId: 't1',
      trigger: 'settings',
    })
    expect(onReloaded).toHaveBeenCalled()
    expect(store.getState().notice).toContain('资源版本 3')
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('dirty')

    await store.getState().loadResources(false)
    expect(store.getState().showText).toBe(false)
    expect(store.getState().resources?.instructions[0]?.text).toBeUndefined()
  })

  it('资源重载失败如实提示且不关闭面板', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    vi.mocked(client.reloadResources).mockResolvedValueOnce({
      status: 'failed',
      reason: 'trust',
      message: '需要信任',
      operation: {
        id: 'op1',
        trigger: 'settings',
        status: 'failed',
        workspacePath: '/workspace',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        fromResourceRevision: 2,
        resourceRevision: 2,
      },
    })
    await store.getState().applyResourceReload()
    expect(store.getState().open).toBe(true)
    expect(store.getState().notice).toContain('信任')
  })
})
