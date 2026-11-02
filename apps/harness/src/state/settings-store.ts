/**
 * 设置与资源 feature Zustand 状态：目标捕获、作用域草稿、保存冲突、资源读取
 * 与同会话重载。
 *
 * 业务边界（见 R1 §5.4）：
 * - 目标在打开面板时固定（会话或空白页起始目录），迟到读取/保存不串到新目标；
 * - 用户/项目作用域各保留一份原文草稿；关闭面板不丢 dirty 草稿，显式“重新加载”
 *   才丢弃当前作用域；保存失败/冲突保留草稿，保存回执不覆盖后来的编辑；
 * - 保存只写磁盘，不自动应用到 live 会话；“应用资源重载”是独立动作，
 *   未保存草稿不受影响；
 * - 资源正文只在显式请求时读取，隐藏即清除正文，不持久化。
 */

import type {
  HarnessReloadResult,
  HarnessResourceSnapshot,
  HarnessSettingsFile,
  HarnessSettingsIssue,
  HarnessSettingsSaveResult,
  HarnessSettingsScope,
  HarnessSettingsSnapshot,
} from '@huan/protocol'
import { type HarnessBrowser, HarnessHttpError } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 设置目标：会话或空白页固定起始目录二选一。 */
export interface SettingsTarget {
  threadId?: string
  workspacePath?: string
}

/** 设置视图标签页。 */
export type SettingsTab = 'common' | 'json' | 'resources'

/** 单个作用域的编辑草稿。 */
export interface SettingsDraftState {
  content: string
  /** 最近一次已保存/已读取的原文，用于 dirty 判断。 */
  baseContent: string
  /** 草稿基线对应的磁盘 revision；保存时作为 expectedRevision。 */
  revision: string | null
  /** 每次内容变化推进；保存回执据此判断是否已有新编辑。 */
  draftRevision: number
  /** 宿主最近一次保存校验问题。 */
  issues: readonly HarnessSettingsIssue[]
}

/** 面板状态。 */
export interface SettingsFeatureState {
  open: boolean
  /** 面板代次；打开/关闭/换目标推进，旧读取结果不得写回。 */
  targetEpoch: number
  target: SettingsTarget | undefined
  targetKey: string
  tab: SettingsTab
  scope: HarnessSettingsScope
  snapshot: HarnessSettingsSnapshot | undefined
  resources: HarnessResourceSnapshot | undefined
  /** 资源正文是否已显式加载。 */
  showText: boolean
  loading: boolean
  resourceLoading: boolean
  saving: boolean
  reloading: boolean
  notice: string | undefined
  error: string | undefined
  resourceError: string | undefined
  drafts: Readonly<Record<string, SettingsDraftState>>
  /** 目标会话最近确认的资源版本；变化时只重读，不重置草稿。 */
  observedResourceRevision: number | undefined
  disposed: boolean

  /** 打开面板并固定目标；保留既有草稿。 */
  openPanel: (target?: SettingsTarget) => Promise<void>
  /** 关闭面板；使在途读取失效，但保留 dirty 草稿。 */
  close: () => void
  setTab: (tab: SettingsTab) => void
  setScope: (scope: HarnessSettingsScope) => void
  /** 读取设置原文与资源清单。 */
  loadSettings: (options?: { resetScope?: HarnessSettingsScope }) => Promise<void>
  /** 读取资源清单；`withText` 显式请求正文。 */
  loadResources: (withText: boolean) => Promise<void>
  /** 重新读取磁盘设置（丢弃当前作用域未保存草稿）并刷新资源。 */
  reloadFromDisk: () => Promise<void>
  updateDraft: (content: string) => void
  /** 常用项表单写入：只改指定键，重新序列化完整原文。 */
  updateObject: (next: Record<string, unknown>) => void
  /** 恢复当前草稿到读取/保存基线。 */
  resetDraft: () => void
  /** 保存当前作用域原文；冲突/失败保留草稿。 */
  save: () => Promise<void>
  /** 应用资源重载到固定目标；成功后只刷新读取结果，不重置草稿。 */
  applyResourceReload: () => Promise<void>
  /** 直接重载指定目标（供 `/reload` 命令）；不打开面板。 */
  reloadTarget: (target: SettingsTarget) => Promise<SettingsReloadOutcome>
  /** 目标会话资源版本变化：只重读，不覆盖未保存草稿。 */
  syncResourceRevision: (revision: number | undefined) => void
  clearNotice: () => void
  dispose: () => void
}

/** `/reload` 命令使用的受控结果。 */
export type SettingsReloadOutcome =
  | { status: 'reloaded'; resourceRevision: number; message: string }
  | { status: 'failed'; message: string }
  | { status: 'ignored'; message: string }

export interface CreateSettingsFeatureStoreOptions {
  browser: HarnessBrowser
  /** 空白页没有窗口选择时的起始目录来源；由组合根提供。 */
  fallbackWorkspacePath?: () => string | undefined
  /** 资源重载成功后通知命令目录刷新（工作区目标没有会话快照）。 */
  onResourceReloaded?: () => void
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 目标键：会话优先；同一目标内作用域草稿再分键。 */
export const settingsTargetKey = (target: SettingsTarget | undefined): string => {
  if (!target) return 'none'
  if (target.threadId) return `t:${target.threadId}`
  return `w:${target.workspacePath ?? ''}`
}

const emptyFileContent = (): string => `${JSON.stringify({}, null, 2)}\n`

const draftFromFile = (file: HarnessSettingsFile): SettingsDraftState => {
  const content = file.exists ? file.content : emptyFileContent()
  return {
    content,
    baseContent: content,
    revision: file.revision,
    draftRevision: 0,
    issues: [],
  }
}

const draftIsDirty = (draft: SettingsDraftState | undefined): boolean =>
  draft !== undefined && draft.content !== draft.baseContent

const draftKeyOf = (targetKey: string, scope: HarnessSettingsScope): string =>
  `${targetKey}|${scope}`

const targetInputOf = (target: SettingsTarget): SettingsTarget => ({
  ...(target.threadId ? { threadId: target.threadId } : {}),
  ...(target.threadId ? {} : { workspacePath: target.workspacePath }),
})

/** 读取宿主快照中的目标路径（用于展示/资源重载结果）。 */
const targetPathOf = (snapshot: HarnessSettingsSnapshot | undefined): string | undefined =>
  snapshot?.target.workspacePath

const httpCodeOf = (error: unknown): string | undefined =>
  error instanceof HarnessHttpError ? error.code : undefined

const saveErrorText = (error: unknown): string => {
  const code = httpCodeOf(error)
  if (code === 'settings-conflict') {
    return '保存冲突：设置文件已在其他窗口或进程被修改。请先“重新加载”再合并改动。'
  }
  if (code === 'settings-untrusted') return '项目未信任，不能保存项目设置。'
  if (code === 'settings-too-large') return '设置文件超过大小上限，无法保存。'
  if (code === 'settings-write-failed') return '写入设置文件失败，请检查宿主诊断后重试。'
  return errorText(error)
}

const saveResultMessage = (result: HarnessSettingsSaveResult): string => {
  switch (result.status) {
    case 'saved':
      return `${result.apply.message}${
        result.apply.reloadRequired
          ? '（已保存，待重载；点“应用资源重载”即可让当前会话使用新设置）'
          : ''
      }`
    case 'invalid':
      return result.message
    case 'conflict':
    case 'untrusted':
    case 'too-large':
    case 'failed':
      return result.message
  }
}

const reloadFailureText = (result: Extract<HarnessReloadResult, { status: 'failed' }>): string => {
  switch (result.reason) {
    case 'trust':
      return '目标项目需要信任决定，资源重载未执行。请先完成信任决定。'
    case 'assembly':
      return '资源装配或重载失败；旧扩展可能已关闭，请核对诊断后重试。'
    case 'disposed':
      return '宿主或会话正在关闭，资源重载未执行。'
  }
}

export const createSettingsFeatureStore = (
  options: CreateSettingsFeatureStoreOptions,
): StoreApi<SettingsFeatureState> => {
  const { browser } = options
  let panelEpoch = 0
  let loadRequest = 0
  let resourceRequest = 0
  let saveRequest = 0
  let reloadRequest = 0

  return createStore<SettingsFeatureState>()((set, get) => {
    const keyNow = (): string => draftKeyOf(get().targetKey, get().scope)

    const draftFileOf = (
      snapshot: HarnessSettingsSnapshot,
      scope: HarnessSettingsScope,
    ): HarnessSettingsFile => (scope === 'user' ? snapshot.files.user : snapshot.files.project)

    const withDraftsFromSnapshot = (
      snapshot: HarnessSettingsSnapshot,
      resetScope: HarnessSettingsScope | undefined,
    ): Record<string, SettingsDraftState> => {
      const state = get()
      const drafts: Record<string, SettingsDraftState> = { ...state.drafts }
      for (const scope of ['user', 'project'] as const) {
        const key = draftKeyOf(state.targetKey, scope)
        const file = draftFileOf(snapshot, scope)
        if (resetScope === scope) delete drafts[key]
        if (!file.readable || file.tooLarge || file.readError) {
          if (resetScope === scope) delete drafts[key]
          continue
        }
        const existing = drafts[key]
        if (!existing) {
          drafts[key] = draftFromFile(file)
          continue
        }
        // dirty 草稿保留自己的基线与 revision，避免外部改动被当成可覆盖基线。
        if (!draftIsDirty(existing)) drafts[key] = draftFromFile(file)
      }
      return drafts
    }

    const reload = async (target: SettingsTarget): Promise<SettingsReloadOutcome> => {
      try {
        const result = await browser.client.reloadResources({
          ...targetInputOf(target),
          trigger: 'settings',
        })
        if (result.status !== 'reloaded') {
          return {
            status: result.status === 'busy' ? 'ignored' : 'failed',
            message:
              result.status === 'failed'
                ? reloadFailureText(result)
                : result.status === 'busy'
                  ? result.message
                  : result.message,
          }
        }
        if (result.snapshot) {
          browser.serviceStore
            .getState()
            .applyThreadSnapshot(result.snapshot.metadata.id, result.snapshot)
        }
        options.onResourceReloaded?.()
        return {
          status: 'reloaded',
          resourceRevision: result.resourceRevision,
          message:
            result.kind === 'session'
              ? `已重载并应用到当前会话（资源版本 ${result.resourceRevision}）；消息、分支与未保存草稿保持不变。`
              : `已重载该起始目录的待消费装配（资源版本 ${result.resourceRevision}）；不会创建会话，也不影响其他会话。`,
        }
      } catch (error) {
        return { status: 'failed', message: errorText(error) }
      }
    }

    return {
      open: false,
      targetEpoch: 0,
      target: undefined,
      targetKey: 'none',
      tab: 'common',
      scope: 'user',
      snapshot: undefined,
      resources: undefined,
      showText: false,
      loading: false,
      resourceLoading: false,
      saving: false,
      reloading: false,
      notice: undefined,
      error: undefined,
      resourceError: undefined,
      drafts: {},
      observedResourceRevision: undefined,
      disposed: false,

      openPanel: async (targetInput) => {
        if (get().disposed) return
        const fallbackTarget: SettingsTarget | undefined = options.fallbackWorkspacePath
          ? (() => {
              const workspacePath = options.fallbackWorkspacePath?.()
              return workspacePath ? { workspacePath } : undefined
            })()
          : undefined
        const target = targetInput ?? fallbackTarget
        const epoch = ++panelEpoch
        set({
          open: true,
          targetEpoch: epoch,
          target,
          targetKey: settingsTargetKey(target),
          snapshot: undefined,
          resources: undefined,
          showText: false,
          loading: false,
          resourceLoading: false,
          saving: false,
          reloading: false,
          notice: undefined,
          error: target ? undefined : '当前没有可用的会话或起始目录；请先选择工作区/项目。',
          resourceError: undefined,
          observedResourceRevision:
            target?.threadId !== undefined
              ? browser.serviceStore.getState().threadsById[target.threadId]?.resourceRevision
              : undefined,
        })
        if (!target) return
        await Promise.all([get().loadSettings(), get().loadResources(false)])
      },

      close: () => {
        if (get().disposed) return
        // 关闭只失效在途读取与面板视图；dirty 草稿继续留在内存供重开。
        panelEpoch += 1
        loadRequest += 1
        resourceRequest += 1
        set({
          open: false,
          targetEpoch: panelEpoch,
          resources: undefined,
          showText: false,
          loading: false,
          resourceLoading: false,
          saving: false,
          reloading: false,
          notice: undefined,
          error: undefined,
          resourceError: undefined,
        })
      },

      setTab: (tab) => {
        if (get().disposed) return
        set({ tab })
      },

      setScope: (scope) => {
        const state = get()
        if (state.disposed || state.scope === scope) return
        if (scope === 'project' && state.snapshot && !state.snapshot.projectTrusted) return
        set({ scope, notice: undefined, error: undefined })
      },

      loadSettings: async (loadOptions) => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target) return
        const epoch = ++loadRequest
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        set({ loading: true, error: undefined })
        try {
          const snapshot = await browser.client.getSettings(targetInputOf(target))
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== loadRequest
          ) {
            return
          }
          const drafts = withDraftsFromSnapshot(snapshot, loadOptions?.resetScope)
          const nextScope =
            current.scope === 'project' && !snapshot.projectTrusted ? 'user' : current.scope
          set({
            snapshot,
            drafts,
            scope: nextScope,
            loading: false,
            error: undefined,
          })
        } catch (error) {
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== loadRequest
          ) {
            return
          }
          set({ loading: false, error: errorText(error) })
        }
      },

      loadResources: async (withText) => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target) return
        const epoch = ++resourceRequest
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        set({ resourceLoading: true, resourceError: undefined })
        try {
          const resources = await browser.client.getResources({
            ...targetInputOf(target),
            ...(withText ? { includeText: true } : {}),
          })
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== resourceRequest
          ) {
            return
          }
          set({
            resources,
            showText: withText,
            resourceLoading: false,
            resourceError: undefined,
          })
        } catch (error) {
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== resourceRequest
          ) {
            return
          }
          set({ resourceLoading: false, resourceError: errorText(error) })
        }
      },

      reloadFromDisk: async () => {
        const state = get()
        if (state.disposed || !state.open || !state.target) return
        await get().loadSettings({ resetScope: state.scope })
        await get().loadResources(state.showText)
      },

      updateDraft: (content) => {
        const state = get()
        if (state.disposed) return
        const key = keyNow()
        const existing = state.drafts[key]
        if (!existing || existing.content === content) return
        set({
          drafts: {
            ...state.drafts,
            [key]: {
              ...existing,
              content,
              draftRevision: existing.draftRevision + 1,
              issues: [],
            },
          },
          error: undefined,
          notice: undefined,
        })
      },

      updateObject: (next) => {
        get().updateDraft(`${JSON.stringify(next, null, 2)}\n`)
      },

      resetDraft: () => {
        const state = get()
        if (state.disposed) return
        const key = keyNow()
        const existing = state.drafts[key]
        if (!existing) return
        set({
          drafts: {
            ...state.drafts,
            [key]: {
              ...existing,
              content: existing.baseContent,
              draftRevision: existing.draftRevision + 1,
              issues: [],
            },
          },
          notice: undefined,
          error: undefined,
        })
      },

      save: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target || state.saving) return
        const key = keyNow()
        const draft = state.drafts[key]
        if (!draft) return
        const scope = state.scope
        const targetKey = state.targetKey
        const submitted = {
          content: draft.content,
          revision: draft.revision,
          draftRevision: draft.draftRevision,
        }
        const panel = state.targetEpoch
        const request = ++saveRequest
        set({ saving: true, notice: undefined, error: undefined })
        try {
          const result = await browser.client.saveSettings({
            target: targetInputOf(target),
            scope,
            content: submitted.content,
            expectedRevision: submitted.revision,
          })
          const current = get()
          if (current.disposed || request !== saveRequest) return
          const currentDraft = current.drafts[key]
          if (!currentDraft) return
          if (result.status === 'saved') {
            const editedLater = currentDraft.draftRevision !== submitted.draftRevision
            const drafts = {
              ...current.drafts,
              [key]: {
                content: editedLater ? currentDraft.content : submitted.content,
                baseContent: submitted.content,
                revision: result.revision,
                draftRevision: currentDraft.draftRevision,
                issues: [],
              },
            }
            const samePanel = current.targetKey === targetKey && current.targetEpoch === panel
            set({
              ...(samePanel ? { snapshot: result.snapshot } : {}),
              drafts,
              ...(samePanel ? { notice: saveResultMessage(result) } : {}),
            })
            return
          }
          if (result.status === 'invalid') {
            set({
              drafts: {
                ...current.drafts,
                [key]: { ...currentDraft, issues: result.issues },
              },
              ...(current.targetKey === targetKey ? { error: result.message } : {}),
            })
            return
          }
          // fake client/进程内实现可能直接返回冲突等状态；与 HTTP 错误保持同一处理。
          set({
            ...(current.targetKey === targetKey ? { error: result.message } : {}),
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== saveRequest) return
          // 冲突/失败不清草稿；错误只在当前目标显示，迟到结果不污染新目标。
          if (current.targetKey === targetKey) set({ error: saveErrorText(error) })
        } finally {
          if (!get().disposed && request === saveRequest) set({ saving: false })
        }
      },

      applyResourceReload: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target || state.reloading) return
        const targetKey = state.targetKey
        const panel = state.targetEpoch
        const request = ++reloadRequest
        set({ reloading: true, notice: undefined, error: undefined })
        const outcome = await reload(target)
        const current = get()
        if (current.disposed || request !== reloadRequest) return
        const samePanel =
          current.open && current.targetEpoch === panel && current.targetKey === targetKey
        if (outcome.status !== 'reloaded') {
          if (samePanel) set({ notice: outcome.message, reloading: false })
          else set({ reloading: false })
          return
        }
        if (!samePanel) {
          set({ reloading: false })
          return
        }
        set({
          observedResourceRevision:
            target.threadId !== undefined
              ? outcome.resourceRevision
              : current.observedResourceRevision,
        })
        // 重载后只重读，不重置草稿。
        await get().loadSettings()
        if (get().targetEpoch !== panel || get().targetKey !== targetKey || !get().open) return
        await get().loadResources(get().showText)
        if (get().disposed || get().targetEpoch !== panel || get().targetKey !== targetKey) return
        set({ reloading: false, notice: outcome.message })
      },

      reloadTarget: async (target) => {
        if (get().disposed) return { status: 'ignored', message: '实例已销毁。' }
        const outcome = await reload(target)
        if (outcome.status === 'reloaded') {
          // 会话目标的快照更新由宿主事件广播；这里只推进面板观察版本。
          if (get().targetKey === settingsTargetKey(target)) {
            set({ observedResourceRevision: outcome.resourceRevision })
          }
        }
        return outcome
      },

      syncResourceRevision: (revision) => {
        const state = get()
        if (state.disposed || !state.open || state.target?.threadId === undefined) {
          if (!state.open && state.observedResourceRevision !== undefined) {
            set({ observedResourceRevision: undefined })
          }
          return
        }
        if (revision === undefined) return
        if (state.observedResourceRevision === undefined) {
          set({ observedResourceRevision: revision })
          return
        }
        if (state.observedResourceRevision === revision) return
        set({ observedResourceRevision: revision })
        void get().loadSettings()
        void get().loadResources(state.showText)
      },

      clearNotice: () => {
        if (get().disposed) return
        set({ notice: undefined, error: undefined, resourceError: undefined })
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
        loadRequest += 1
        resourceRequest += 1
        saveRequest += 1
        reloadRequest += 1
        set({
          open: false,
          target: undefined,
          targetKey: 'none',
          targetEpoch: panelEpoch,
          snapshot: undefined,
          resources: undefined,
          showText: false,
          drafts: {},
          loading: false,
          resourceLoading: false,
          saving: false,
          reloading: false,
          notice: undefined,
          error: undefined,
          resourceError: undefined,
          observedResourceRevision: undefined,
          disposed: true,
        })
      },
    }
  })
}

/** 供 UI 展示目标路径；快照缺失时退回目标本身。 */
export const settingsTargetPath = (
  target: SettingsTarget | undefined,
  snapshot: HarnessSettingsSnapshot | undefined,
): string | undefined => targetPathOf(snapshot) ?? target?.workspacePath

/** 组合键：目标 + 作用域；UI 读取草稿时使用同一规则。 */
export const settingsScopedDraftKey = (targetKey: string, scope: HarnessSettingsScope): string =>
  `${targetKey}|${scope}`
