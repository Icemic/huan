import type {
  HarnessClient,
  HarnessModelInfo,
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
  target.global === true
    ? { kind: 'global', workspacePath: '' }
    : target.threadId
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
    // 全局快照不提供项目文件原文。
    project:
      targetInput.global === true
        ? { ...settingsFile('project', '', null), readable: false }
        : settingsFile('project', projectContent),
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

const models: HarnessModelInfo[] = [
  { provider: 'provider', modelId: 'model-a', name: 'Model A' },
  { provider: 'provider', modelId: 'model-b', name: 'Model B' },
]

const createFakeClient = () => {
  const target: HarnessSettingsTargetInput = { threadId: 't1' }
  const otherTarget: HarnessSettingsTargetInput = { threadId: 't2' }
  const client = {
    getSettings: vi.fn(async (input: HarnessSettingsTargetInput) =>
      input.threadId === 't2'
        ? snapshotOf(otherTarget, '{}\n', '{}\n')
        : snapshotOf(input.global === true ? input : target),
    ),
    saveSettings: vi.fn(),
    getResources: vi.fn(async (input: HarnessSettingsTargetInput & { includeText?: boolean }) =>
      resourcesOf(input, input.includeText === true),
    ),
    reloadResources: vi.fn(),
    getAvailableModels: vi.fn(async () => models),
    refreshModels: vi.fn(async () => ({ models, failedProviders: [] })),
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

/** 保存成功结果：只关注结构化 apply 字段，宿主原始 message 不参与界面文案。 */
const savedResult = (
  snapshot: HarnessSettingsSnapshot,
  options: { reloadRequired?: boolean; restartRequiredKeys?: readonly string[] } = {},
) => ({
  status: 'saved' as const,
  scope: 'user' as const,
  path: '/agent/settings.json',
  revision: 'r2',
  bytes: 1,
  snapshot,
  apply: {
    persisted: true,
    reloadRequired: options.reloadRequired ?? true,
    restartRequiredKeys: options.restartRequiredKeys ?? [],
    message: '宿主原始说明',
  },
})

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
    expect(store.getState().notice).toContain('可应用到当前会话')
    expect(client.reloadResources).not.toHaveBeenCalled()
  })

  it('保存结果区分需应用与需重启，同次混合时保留应用提示', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    const snapshot = snapshotOf({ threadId: 't1' })

    // 同次既有普通字段也有重启字段：应用提示不能因重启字段被隐藏。
    vi.mocked(client.saveSettings).mockResolvedValueOnce(
      savedResult(snapshot, { restartRequiredKeys: ['sessionDir'] }),
    )
    store.getState().updateDraft('{\n  "defaultModel": "m2",\n  "sessionDir": "/tmp/sessions"\n}\n')
    await store.getState().save()
    expect(store.getState().notice).toContain('已保存，可应用到当前会话')
    expect(store.getState().notice).toContain('以下设置需重启服务：sessionDir')
    expect(store.getState().notice).not.toContain('宿主原始说明')

    // 只改重启字段：只提示重启，不提示可应用。
    vi.mocked(client.saveSettings).mockResolvedValueOnce(
      savedResult(snapshot, { restartRequiredKeys: ['sessionDir'] }),
    )
    store.getState().updateDraft('{\n  "defaultModel": "m2",\n  "sessionDir": "/tmp/other"\n}\n')
    await store.getState().save()
    expect(store.getState().notice).toContain('已保存')
    expect(store.getState().notice).not.toContain('可应用到当前会话')
    expect(store.getState().notice).toContain('以下设置需重启服务：sessionDir')
  })

  it('空白页目标保存后提示可刷新项目资源', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ workspacePath: '/workspace' })
    vi.mocked(client.saveSettings).mockResolvedValueOnce(
      savedResult(snapshotOf({ workspacePath: '/workspace' })),
    )
    store.getState().updateDraft('{\n  "defaultModel": "m2"\n}\n')
    await store.getState().save()
    expect(store.getState().notice).toBe('已保存，可刷新项目资源')
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
    expect(store.getState().notice).toBe('已保存')
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

describe('settings feature：全局设置目标', () => {
  it('全局目标不要求 cwd，只读取用户设置并保留用户草稿', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)

    await store.getState().openPanel({ global: true })
    expect(store.getState().open).toBe(true)
    expect(store.getState().target).toMatchObject({ global: true })
    expect(store.getState().targetKey).toBe('g')
    expect(store.getState().scope).toBe('user')
    expect(client.getSettings).toHaveBeenCalledWith({ global: true })
    expect(client.getResources).not.toHaveBeenCalled()
    expect(client.getSettings).toHaveBeenCalledTimes(1)
    expect(draftOf(store, 'g', 'user')?.content).toContain('unknownField')
    expect(draftOf(store, 'g', 'project')).toBeUndefined()

    store.getState().updateDraft('{\n  "draft": true\n}\n')
    store.getState().close()
    await store.getState().openPanel({ global: true })
    expect(draftOf(store, 'g', 'user')?.content).toContain('"draft": true')
    // 再次打开全局目标仍不读取项目/资源。
    expect(client.getResources).not.toHaveBeenCalled()
  })

  it('全局保存写用户文件，成功后提示新会话与资源页，不选择当前会话', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ global: true })
    vi.mocked(client.saveSettings).mockResolvedValueOnce(savedResult(snapshotOf({ global: true })))
    store.getState().updateDraft('{\n  "defaultModel": "m2"\n}\n')
    await store.getState().save()

    expect(client.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { global: true },
        scope: 'user',
      }),
    )
    expect(store.getState().notice).toBe('已保存，新会话将使用；已有会话可在资源页重新加载')
    expect(store.getState().notice).not.toContain('当前会话')
    expect(client.reloadResources).not.toHaveBeenCalled()
  })

  it('全局目标不加载资源、不应用资源重载；重新读取只刷新设置', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ global: true })
    await store.getState().loadResources(true)
    expect(client.getResources).not.toHaveBeenCalled()
    await store.getState().applyResourceReload()
    expect(client.reloadResources).not.toHaveBeenCalled()
    await store.getState().reloadFromDisk()
    expect(client.getSettings).toHaveBeenCalledTimes(2)
    expect(client.getResources).not.toHaveBeenCalled()
  })

  it('全局模型目录使用空路径完整目录，刷新使用 global 目标', async () => {
    const client = createFakeClient()
    const { browser, store } = createStore(client)
    const loadCatalog = vi
      .spyOn(browser.serviceStore.getState(), 'loadModelCatalog')
      .mockResolvedValue(models)
    await store.getState().openPanel({ global: true }, { tab: 'models' })
    await store.getState().loadModelCatalog()
    expect(loadCatalog).toHaveBeenLastCalledWith({ workspacePath: '', all: true })

    await store.getState().refreshModelCatalog()
    expect(client.refreshModels).toHaveBeenCalledWith({ global: true })
    expect(loadCatalog).toHaveBeenLastCalledWith({ workspacePath: '', all: true })
    expect(store.getState().modelRefreshing).toBe(false)
  })
})

describe('settings feature：全局模型范围', () => {
  it('模型页固定用户作用域；目录读取使用完整模式并支持仅有 cwd 的目标', async () => {
    const client = createFakeClient()
    const { browser, store } = createStore(client)
    const loadCatalog = vi
      .spyOn(browser.serviceStore.getState(), 'loadModelCatalog')
      .mockResolvedValue(models)

    await store.getState().openPanel({ threadId: 't1' }, { tab: 'models', scope: 'project' })
    expect(store.getState().tab).toBe('models')
    expect(store.getState().scope).toBe('user')
    await store.getState().loadModelCatalog()
    expect(loadCatalog).toHaveBeenCalledWith({ workspacePath: '/workspace', all: true })

    // 模型页不允许切到项目作用域；离开后恢复普通作用域切换。
    store.getState().setScope('project')
    expect(store.getState().scope).toBe('user')
    store.getState().setTab('common')
    store.getState().setScope('project')
    expect(store.getState().scope).toBe('project')
    store.getState().setTab('models')
    expect(store.getState().scope).toBe('user')

    // 无会话、仅有起始目录时同样使用该 cwd 读取完整目录。
    store.getState().close()
    vi.mocked(client.getSettings).mockResolvedValueOnce(snapshotOf({ workspacePath: '/cwd-only' }))
    await store.getState().openPanel({ workspacePath: '/cwd-only' }, { tab: 'models' })
    await store.getState().loadModelCatalog()
    expect(loadCatalog).toHaveBeenLastCalledWith({ workspacePath: '/cwd-only', all: true })
  })

  it('刷新目录调用共享刷新接口后重新读取完整目录', async () => {
    const client = createFakeClient()
    const { browser, store } = createStore(client)
    const loadCatalog = vi
      .spyOn(browser.serviceStore.getState(), 'loadModelCatalog')
      .mockResolvedValue(models)
    await store.getState().openPanel({ threadId: 't1' }, { tab: 'models' })
    await store.getState().loadModelCatalog()
    loadCatalog.mockClear()

    await store.getState().refreshModelCatalog()
    expect(client.refreshModels).toHaveBeenCalledWith({ workspacePath: '/workspace' })
    expect(loadCatalog).toHaveBeenCalledWith({ workspacePath: '/workspace', all: true })
    expect(store.getState().modelRefreshing).toBe(false)
    expect(store.getState().notice).toContain('模型目录已刷新')
  })

  it('保存用户 enabledModels 保留其他字段，不提示资源应用；混合其他设置仍按 apply 提示', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' }, { tab: 'models' })
    const snapshot = snapshotOf({ threadId: 't1' })

    store.getState().updateObject({
      defaultModel: 'm1',
      unknownField: 1,
      enabledModels: ['provider/model-b'],
    })
    vi.mocked(client.saveSettings).mockResolvedValueOnce(savedResult(snapshot))
    await store.getState().save()

    expect(client.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { threadId: 't1' },
        scope: 'user',
      }),
    )
    const calls = vi.mocked(client.saveSettings).mock.calls
    const first = calls[0]
    if (!first) throw new Error('缺少保存调用')
    const saved = JSON.parse((first[0] as { content: string }).content) as Record<string, unknown>
    expect(saved).toMatchObject({
      defaultModel: 'm1',
      unknownField: 1,
      enabledModels: ['provider/model-b'],
    })
    expect(store.getState().notice).toBe('已保存')

    // 与普通设置一起修改时仍按宿主 apply 字段提示应用。
    store.getState().updateObject({
      defaultModel: 'm2',
      unknownField: 1,
      enabledModels: ['provider/model-b'],
    })
    vi.mocked(client.saveSettings).mockResolvedValueOnce(savedResult(snapshot))
    await store.getState().save()
    expect(store.getState().notice).toContain('已保存，可应用到当前会话')
  })
})

describe('settings feature：资源读取与重载', () => {
  it('当前作用域有草稿时，重新读取先确认；编辑/切作用域/换目标/关闭取消确认', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    store.getState().updateDraft('{\n  "draft": 1\n}\n')
    const reads = vi.mocked(client.getSettings).mock.calls.length

    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(true)
    expect(store.getState().notice).toContain('重新读取将丢弃未保存的改动')
    expect(vi.mocked(client.getSettings)).toHaveBeenCalledTimes(reads)
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('draft')

    // 编辑取消确认。
    store.getState().updateDraft('{\n  "draft": 2\n}\n')
    expect(store.getState().reloadConfirm).toBe(false)
    expect(store.getState().notice).toBeUndefined()

    // 切换作用域取消确认，草稿仍在。
    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(true)
    store.getState().setScope('project')
    expect(store.getState().reloadConfirm).toBe(false)
    store.getState().setScope('user')
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('"draft": 2')

    // 换目标取消确认。
    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(true)
    await store.getState().openPanel({ threadId: 't2' })
    expect(store.getState().reloadConfirm).toBe(false)

    // 回到原目标，确认后读取并丢弃草稿。
    await store.getState().openPanel({ threadId: 't1' })
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('"draft": 2')
    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(true)
    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(false)
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('unknownField')
    expect(draftOf(store, 't:t1', 'user')?.content).not.toContain('draft')

    // 关闭取消确认。
    store.getState().updateDraft('{\n  "draft": 3\n}\n')
    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(true)
    store.getState().close()
    expect(store.getState().reloadConfirm).toBe(false)
  })

  it('确认重新读取期间的新编辑保留，迟到文件内容不覆盖新草稿', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    store.getState().updateDraft('{"draft":1}\n')
    await store.getState().reloadFromDisk()
    const gate = deferred<HarnessSettingsSnapshot>()
    vi.mocked(client.getSettings).mockReturnValueOnce(gate.promise)
    const reading = store.getState().reloadFromDisk()
    store.getState().updateDraft('{"draft":2}\n')
    gate.resolve(snapshotOf({ threadId: 't1' }, '{"disk":true}\n'))
    await reading
    expect(draftOf(store, 't:t1', 'user')?.content).toBe('{"draft":2}\n')
  })

  it('重新读取请求失败或文件读取错误时保留草稿', async () => {
    const client = createFakeClient()
    const { store } = createStore(client)
    await store.getState().openPanel({ threadId: 't1' })
    store.getState().updateDraft('{\n  "draft": 1\n}\n')

    await store.getState().reloadFromDisk()
    vi.mocked(client.getSettings).mockRejectedValueOnce(new Error('读取失败'))
    await store.getState().reloadFromDisk()
    expect(store.getState().error).toContain('读取失败')
    expect(store.getState().reloadConfirm).toBe(false)
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('draft')

    // 文件本身读取错误也保留草稿，不重置基线与内容。
    const source = snapshotOf({ threadId: 't1' })
    vi.mocked(client.getSettings).mockResolvedValueOnce({
      ...source,
      files: {
        user: {
          ...source.files.user,
          content: '',
          exists: false,
          revision: null,
          readable: false,
          readError: '读取失败',
          issues: [],
        },
        project: source.files.project,
      },
    })
    await store.getState().reloadFromDisk()
    await store.getState().reloadFromDisk()
    expect(store.getState().reloadConfirm).toBe(false)
    expect(draftOf(store, 't:t1', 'user')?.content).toContain('draft')
    expect(store.getState().snapshot?.files.user.readError).toBe('读取失败')
  })

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
    expect(store.getState().notice).toBe('已应用到当前会话')
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
