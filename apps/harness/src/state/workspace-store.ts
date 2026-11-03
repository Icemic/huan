/**
 * 工作区 feature Zustand 状态：列表控制、窗口选择入口、工作区表单与提示。
 *
 * 数据来源（R1 §3）：
 * - 工作区定义、会话目录、宿主信息只在公共 serviceStore；
 * - 当前会话/新会话目标只在公共 windowStore；
 * - 本 store 只保存应用侧列表控制、展开、表单草稿与操作提示，不复制目录数据。
 */

import type {
  HarnessProjectInfo,
  HarnessWorkspace,
  HarnessWorkspaceProjectInput,
} from '@huan/protocol'
import type { HarnessBrowser, HarnessBrowserStorage } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 页面级工作区错误分类。 */
export type WorkspaceFeatureError = 'load-failed' | 'state-unavailable'

/** 会话列表排序模式。 */
export type WorkspaceThreadSort = 'recent' | 'created' | 'name'

/** 会话列表范围：全部工作区（含未归属）或当前工作区。 */
export type WorkspaceThreadScope = 'all' | 'workspace'

/** 工作区表单成员草稿；健康与信任只来自宿主查询，不做浏览器推断。 */
export interface WorkspaceMemberDraft {
  key: string
  alias: string
  path: string
  checking?: boolean
  available?: boolean
  trust?: HarnessProjectInfo
  trustFailed?: boolean
}

/** 工作区创建/编辑表单。 */
export interface WorkspaceFormState {
  open: boolean
  mode: 'create' | 'edit'
  workspaceId?: string
  name: string
  revision?: number
  members: readonly WorkspaceMemberDraft[]
  busy: boolean
  message?: string
}

/** 新建会话目标选择与预检状态。 */
export interface NewSessionState {
  workspaceId?: string
  selectedPath: string
  /** 每次打开推进；信任回来的迟到结果只应用到同一表单代次。 */
  epoch: number
  checking: boolean
  message?: string
}

/** 信任决定表单来源；新会话预检完成后直接开始。 */
export type WorkspaceTrustIntent =
  | {
      kind: 'new-session'
      workspaceId: string
      startProjectPath: string
      newSessionEpoch: number
    }
  | { kind: 'standalone' }
  | undefined

/** 信任决定面板状态。 */
export interface WorkspaceTrustState {
  open: boolean
  path: string
  epoch: number
  loading: boolean
  info: HarnessProjectInfo | undefined
  remember: boolean
  busy: boolean
  error: boolean
  intent: WorkspaceTrustIntent
}

/** 工作区 feature 状态。 */
export interface WorkspaceFeatureState {
  storageScope: string
  activeWorkspaceId: string | undefined
  expandedWorkspaceIds: ReadonlySet<string>
  startProjectByWorkspace: Readonly<Record<string, string>>
  search: string
  scope: WorkspaceThreadScope
  sort: WorkspaceThreadSort
  namedOnly: boolean
  showArchived: boolean
  busy: boolean
  error: WorkspaceFeatureError | undefined
  notice: string | undefined
  form: WorkspaceFormState
  newSession: NewSessionState
  trust: WorkspaceTrustState
  disposed: boolean

  /** 首次挂载读取宿主工作区与会话目录；重复调用复用首个结果。 */
  initialize: () => Promise<void>
  /** 重读工作区与会话目录；`rescan` 让宿主重新扫描会话文件。 */
  refresh: (options?: { rescan?: boolean }) => Promise<void>
  /** 宿主存储作用域到达后恢复本窗口的展开、活动工作区与起始项目偏好。 */
  setStorageScope: (scope: string) => void
  /** 从 windowStore 当前选择同步活动工作区；不改用户选择。 */
  syncSelection: () => void
  selectWorkspace: (workspaceId: string) => void
  toggleWorkspace: (workspaceId: string) => void
  /** 选择已有会话：windowStore 保存唯一选择，本 store 只同步活动工作区。 */
  selectThread: (threadId: string) => void
  /** 读取工作区当前起始项目偏好（无效/缺失时回退首个项目）。 */
  startProjectFor: (workspaceId: string) => string | undefined
  /** 记录新会话目标并立即写入 windowStore 选择。 */
  beginNewSession: (workspaceId: string, startProjectPath: string) => void
  openNewSession: (workspaceId: string) => void
  closeNewSession: () => void
  setNewSessionPath: (path: string) => void
  /** 路径与信任预检；需要信任时打开信任面板，完成后继续。 */
  startNewSession: () => Promise<void>
  openWorkspaceForm: (workspaceId?: string) => void
  closeWorkspaceForm: () => void
  setWorkspaceFormName: (name: string) => void
  setWorkspaceMember: (key: string, patch: Partial<Omit<WorkspaceMemberDraft, 'key'>>) => void
  addWorkspaceMember: () => void
  removeWorkspaceMember: (key: string) => void
  /** 查询成员路径可用性与只读信任摘要；迟到结果按成员路径保护。 */
  inspectWorkspaceMember: (key: string) => Promise<void>
  openTrust: (path: string, intent?: WorkspaceTrustIntent) => Promise<void>
  closeTrust: () => void
  setTrustRemember: (remember: boolean) => void
  /** 保存本次信任决定；返回权威项目摘要供调用方继续。 */
  decideTrust: (trusted: boolean) => Promise<HarnessProjectInfo | undefined>
  saveWorkspaceForm: () => Promise<void>
  setSearch: (search: string) => void
  setScope: (scope: WorkspaceThreadScope) => void
  setSort: (sort: WorkspaceThreadSort) => void
  setNamedOnly: (namedOnly: boolean) => void
  setShowArchived: (showArchived: boolean) => void
  showNotice: (message: string) => void
  clearError: () => void
  clearNotice: () => void
  /** 应用实例销毁；之后动作不再生效。 */
  dispose: () => void
}

export interface CreateWorkspaceFeatureStoreOptions {
  browser: HarnessBrowser
  /** 会话存储；默认全局 sessionStorage，测试可注入。 */
  storage?: HarnessBrowserStorage | null
}

const storageKeys = (scope: string) => ({
  active: `huan.activeWorkspace:${scope}`,
  expanded: `huan.expandedWorkspaces:${scope}`,
  start: `huan.workspaceStartProject:${scope}`,
})

const defaultStorage = (): HarnessBrowserStorage | null => {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage
  } catch {
    return null
  }
}

const readString = (storage: HarnessBrowserStorage | null, key: string): string | undefined => {
  try {
    return storage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

const writeString = (
  storage: HarnessBrowserStorage | null,
  key: string,
  value: string | undefined,
): void => {
  try {
    if (value === undefined) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch {
    // 存储不可用只影响窗口恢复，不影响宿主数据。
  }
}

const readExpanded = (storage: HarnessBrowserStorage | null, key: string): Set<string> => {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? '[]')
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

const readStartPreferences = (
  storage: HarnessBrowserStorage | null,
  key: string,
): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([workspaceId, path]) =>
        typeof path === 'string' ? [[workspaceId, path] as const] : [],
      ),
    )
  } catch {
    return {}
  }
}

const emptyForm = (): WorkspaceFormState => ({
  open: false,
  mode: 'create',
  name: '',
  members: [],
  busy: false,
})

const emptyNewSession = (): NewSessionState => ({
  selectedPath: '',
  epoch: 0,
  checking: false,
})

const emptyTrust = (): WorkspaceTrustState => ({
  open: false,
  path: '',
  epoch: 0,
  loading: false,
  info: undefined,
  remember: false,
  busy: false,
  error: false,
  intent: undefined,
})

const mutationErrorText = (
  error: Exclude<Awaited<ReturnType<HarnessBrowser['client']['createWorkspace']>>, { ok: true }>,
): string => {
  switch (error.error) {
    case 'conflict':
      return '工作区已在其他窗口更新，已重新读取权威定义；请确认后再次保存。'
    case 'state-unavailable':
      return '工作区元数据不可用；冷历史仍可查看，但修改已禁用。'
    case 'not-found':
      return '工作区已不存在，请刷新列表。'
    case 'invalid':
      return `工作区输入无效：${error.reason ?? '未知原因'}`
  }
}

export const createWorkspaceFeatureStore = (
  options: CreateWorkspaceFeatureStoreOptions,
): StoreApi<WorkspaceFeatureState> => {
  const { browser } = options
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  let initialized = false
  let refreshEpoch = 0
  let memberSeed = 0
  let newSessionEpoch = 0
  let trustEpoch = 0
  let formEpoch = 0
  const memberEpochs = new Map<string, number>()
  const nextMemberKey = () => {
    memberSeed += 1
    return `member-${memberSeed}`
  }

  const persistLocked = (
    scope: string,
    activeWorkspaceId: string | undefined,
    expanded: ReadonlySet<string>,
    startProjectByWorkspace: Readonly<Record<string, string>>,
  ) => {
    const keys = storageKeys(scope)
    writeString(storage, keys.active, activeWorkspaceId)
    writeString(storage, keys.expanded, JSON.stringify([...expanded]))
    writeString(storage, keys.start, JSON.stringify(startProjectByWorkspace))
  }

  const workspaceIdOfSelection = (
    selection: ReturnType<HarnessBrowser['windowStore']['getState']>['selection'],
  ): string | undefined => {
    if (!selection) return undefined
    if (selection.kind === 'new') return selection.workspaceId
    return browser.serviceStore.getState().threadsById[selection.threadId]?.workspaceId
  }

  const chooseActive = (
    current: string | undefined,
    startup: string | undefined,
    workspaceIds: readonly string[],
  ): string | undefined => {
    if (current && workspaceIds.includes(current)) return current
    if (startup && workspaceIds.includes(startup)) return startup
    return workspaceIds[0]
  }

  const cleanExpanded = (
    current: ReadonlySet<string>,
    workspaceIds: readonly string[],
    active: string | undefined,
  ): Set<string> => {
    const ids = new Set(workspaceIds)
    const next = new Set([...current].filter((id) => ids.has(id)))
    if (active) next.add(active)
    return next
  }

  const formFromWorkspace = (workspace: HarnessWorkspace): WorkspaceFormState => ({
    open: true,
    mode: 'edit',
    workspaceId: workspace.id,
    name: workspace.name,
    revision: workspace.revision,
    members: workspace.projects.map((project) => ({
      key: nextMemberKey(),
      alias: project.alias,
      path: project.path,
      available: project.available,
    })),
    busy: false,
  })

  return createStore<WorkspaceFeatureState>()((set, get) => {
    /** 信任决定后若新会话表单仍属于同一来源，则完成预检并开始新会话。 */
    const finalizeNewSession = (
      intent: Extract<WorkspaceTrustIntent, { kind: 'new-session' }>,
    ): boolean => {
      const state = get()
      const panel = state.newSession
      if (
        panel.workspaceId !== intent.workspaceId ||
        panel.selectedPath !== intent.startProjectPath ||
        panel.epoch !== intent.newSessionEpoch
      ) {
        return false
      }
      get().beginNewSession(intent.workspaceId, intent.startProjectPath)
      set({ newSession: emptyNewSession() })
      get().showNotice(`新会话将以 ${intent.startProjectPath} 作为固定起始目录。`)
      return true
    }

    const applyExpanded = (workspaceId: string) => {
      const state = get()
      if (state.disposed) return
      const expanded = new Set(state.expandedWorkspaceIds)
      expanded.add(workspaceId)
      persistLocked(state.storageScope, workspaceId, expanded, state.startProjectByWorkspace)
      set({ activeWorkspaceId: workspaceId, expandedWorkspaceIds: expanded })
    }

    return {
      storageScope: browser.windowStore.getState().storageScope,
      activeWorkspaceId: undefined,
      expandedWorkspaceIds: new Set(),
      startProjectByWorkspace: {},
      search: '',
      scope: 'all',
      sort: 'recent',
      namedOnly: false,
      showArchived: false,
      busy: false,
      error: undefined,
      notice: undefined,
      form: emptyForm(),
      newSession: emptyNewSession(),
      trust: emptyTrust(),
      disposed: false,

      initialize: async () => {
        if (get().disposed || initialized) return
        initialized = true
        await get().refresh()
      },

      refresh: async (refreshOptions) => {
        if (get().disposed) return
        const epoch = ++refreshEpoch
        set({ busy: true, error: undefined })
        try {
          const service = browser.serviceStore.getState()
          if (!service.host) {
            const host = await service.loadHostInfo()
            if (!host) throw new Error('host unavailable')
          }
          if (get().disposed || epoch !== refreshEpoch) return
          await Promise.all([
            browser.serviceStore.getState().refreshWorkspaces(),
            browser.serviceStore.getState().refreshThreads({
              includeArchived: true,
              ...(refreshOptions?.rescan ? { refresh: true } : {}),
            }),
          ])
          if (get().disposed || epoch !== refreshEpoch) return

          const serviceState = browser.serviceStore.getState()
          const state = get()
          // 存储恢复的可能只有会话选择；活动工作区缺失时从选择补齐。
          const selectedWorkspaceId =
            state.activeWorkspaceId ??
            workspaceIdOfSelection(browser.windowStore.getState().selection)
          const active = chooseActive(
            selectedWorkspaceId,
            serviceState.startupWorkspaceId,
            serviceState.workspaceIds,
          )
          const expanded = cleanExpanded(
            state.expandedWorkspaceIds,
            serviceState.workspaceIds,
            active,
          )
          persistLocked(state.storageScope, active, expanded, state.startProjectByWorkspace)
          set({
            busy: false,
            activeWorkspaceId: active,
            expandedWorkspaceIds: expanded,
            error:
              serviceState.workspaceState !== undefined && serviceState.workspaceState !== 'ok'
                ? 'state-unavailable'
                : undefined,
          })
        } catch {
          if (get().disposed || epoch !== refreshEpoch) return
          set({ busy: false, error: 'load-failed' })
        }
      },

      setStorageScope: (scope) => {
        const state = get()
        if (state.disposed || scope === state.storageScope) return
        const keys = storageKeys(scope)
        const expanded = readExpanded(storage, keys.expanded)
        const startProjectByWorkspace = readStartPreferences(storage, keys.start)
        const storedActive = readString(storage, keys.active)
        const active =
          workspaceIdOfSelection(browser.windowStore.getState().selection) ?? storedActive
        if (active) expanded.add(active)
        set({
          storageScope: scope,
          activeWorkspaceId: active,
          expandedWorkspaceIds: expanded,
          startProjectByWorkspace,
        })
        persistLocked(scope, active, expanded, startProjectByWorkspace)
      },

      syncSelection: () => {
        const state = get()
        if (state.disposed) return
        const workspaceId = workspaceIdOfSelection(browser.windowStore.getState().selection)
        if (!workspaceId || workspaceId === state.activeWorkspaceId) return
        if (!browser.serviceStore.getState().workspacesById[workspaceId]) return
        applyExpanded(workspaceId)
      },

      selectWorkspace: (workspaceId) => {
        if (get().disposed) return
        if (!browser.serviceStore.getState().workspacesById[workspaceId]) return
        applyExpanded(workspaceId)
        // 明确点了工作区：空白新会话目标跟着换到该工作区的起始项目；
        // 已打开会话的窗口不被切换。
        const selection = browser.windowStore.getState().selection
        if (selection && selection.kind !== 'new') return
        const startProjectPath = get().startProjectFor(workspaceId)
        if (startProjectPath) get().beginNewSession(workspaceId, startProjectPath)
      },

      toggleWorkspace: (workspaceId) => {
        const state = get()
        if (state.disposed) return
        if (!browser.serviceStore.getState().workspacesById[workspaceId]) return
        const expanded = new Set(state.expandedWorkspaceIds)
        if (expanded.has(workspaceId)) expanded.delete(workspaceId)
        else expanded.add(workspaceId)
        persistLocked(
          state.storageScope,
          state.activeWorkspaceId,
          expanded,
          state.startProjectByWorkspace,
        )
        set({ expandedWorkspaceIds: expanded })
      },

      selectThread: (threadId) => {
        const state = get()
        if (state.disposed) return
        const metadata = browser.serviceStore.getState().threadsById[threadId]
        if (!metadata) return
        browser.windowStore.getState().selectTarget({ kind: 'thread', threadId })
        const workspaceId = metadata.workspaceId
        if (!workspaceId || !browser.serviceStore.getState().workspacesById[workspaceId]) return
        applyExpanded(workspaceId)
      },

      startProjectFor: (workspaceId) => {
        const state = get()
        const workspace = browser.serviceStore.getState().workspacesById[workspaceId]
        if (!workspace) return undefined
        const preferred = state.startProjectByWorkspace[workspaceId]
        if (preferred && workspace.projects.some((project) => project.path === preferred)) {
          return preferred
        }
        return workspace.projects[0]?.path
      },

      beginNewSession: (workspaceId, startProjectPath) => {
        const state = get()
        if (state.disposed) return
        const workspace = browser.serviceStore.getState().workspacesById[workspaceId]
        if (!workspace) return
        if (!workspace.projects.some((project) => project.path === startProjectPath)) return
        const startProjectByWorkspace = {
          ...state.startProjectByWorkspace,
          [workspaceId]: startProjectPath,
        }
        const expanded = new Set(state.expandedWorkspaceIds)
        expanded.add(workspaceId)
        persistLocked(state.storageScope, workspaceId, expanded, startProjectByWorkspace)
        set({
          activeWorkspaceId: workspaceId,
          expandedWorkspaceIds: expanded,
          startProjectByWorkspace,
        })
        browser.windowStore.getState().selectTarget({
          kind: 'new',
          workspaceId,
          startProjectPath,
        })
      },

      openNewSession: (workspaceId) => {
        const state = get()
        if (state.disposed) return
        const workspace = browser.serviceStore.getState().workspacesById[workspaceId]
        if (!workspace) return
        applyExpanded(workspaceId)
        newSessionEpoch += 1
        const workspaceState = browser.serviceStore.getState().workspaceState
        set({
          newSession: {
            ...emptyNewSession(),
            epoch: newSessionEpoch,
            workspaceId,
            selectedPath: get().startProjectFor(workspaceId) ?? '',
            ...(workspaceState !== undefined && workspaceState !== 'ok'
              ? { message: '工作区元数据不可用；修复 state.json 后才能新建会话。' }
              : {}),
          },
        })
      },

      closeNewSession: () => {
        if (get().disposed) return
        newSessionEpoch += 1
        set({ newSession: emptyNewSession() })
      },

      setNewSessionPath: (path) => {
        const state = get()
        if (state.disposed || !state.newSession.workspaceId) return
        // 更换起始项目即新预检来源；旧的检查状态不沿用。
        newSessionEpoch += 1
        set({
          newSession: {
            ...state.newSession,
            epoch: newSessionEpoch,
            selectedPath: path,
            checking: false,
            message: undefined,
          },
        })
      },

      startNewSession: async () => {
        const state = get()
        if (state.disposed) return
        const panel = state.newSession
        const workspaceId = panel.workspaceId
        const selectedPath = panel.selectedPath
        if (!workspaceId || !selectedPath || panel.checking) return
        const workspaceState = browser.serviceStore.getState().workspaceState
        if (workspaceState !== undefined && workspaceState !== 'ok') {
          set({
            newSession: {
              ...panel,
              checking: false,
              message: '工作区元数据不可用；修复 state.json 后才能新建会话。',
            },
          })
          return
        }
        const epoch = panel.epoch
        const currentPanel = () => {
          const current = get().newSession
          return current.epoch === epoch && current.workspaceId === workspaceId
            ? current
            : undefined
        }
        set({ newSession: { ...panel, checking: true, message: undefined } })
        try {
          // 预检只检查路径、项目状态与信任；不在浏览器推断可用性。
          const check = await browser.client.checkProjectPath(selectedPath)
          if (get().disposed || !currentPanel()) return
          if (check.error || !check.exists || !check.isDirectory) {
            set({
              newSession: {
                ...get().newSession,
                checking: false,
                message: '起始项目路径不存在或不是目录，请选择其他成员。',
              },
            })
            return
          }
          const project = await browser.client.getProject({ path: check.path })
          if (get().disposed || !currentPanel()) return
          if (project.status === 'failed') {
            set({
              newSession: {
                ...get().newSession,
                checking: false,
                message: '起始项目装配失败，请检查路径与宿主诊断。',
              },
            })
            return
          }
          if (project.status === 'needs-trust') {
            set({ newSession: { ...get().newSession, checking: false } })
            await get().openTrust(check.path, {
              kind: 'new-session',
              workspaceId,
              startProjectPath: selectedPath,
              newSessionEpoch: epoch,
            })
            return
          }
          get().beginNewSession(workspaceId, selectedPath)
          set({ newSession: emptyNewSession() })
          get().showNotice(`新会话将以 ${selectedPath} 作为固定起始目录。`)
        } catch {
          if (get().disposed || !currentPanel()) return
          set({
            newSession: {
              ...get().newSession,
              checking: false,
              message: '无法检查起始项目，请查看宿主连接后重试。',
            },
          })
        }
      },

      openWorkspaceForm: (workspaceId) => {
        formEpoch += 1
        const state = get()
        if (state.disposed) return
        if (workspaceId) {
          const workspace = browser.serviceStore.getState().workspacesById[workspaceId]
          if (!workspace) return
          set({ form: formFromWorkspace(workspace) })
          // 打开既有工作区时重新检查成员路径与只读信任摘要。
          const form = get().form
          for (const member of form.members) void get().inspectWorkspaceMember(member.key)
          return
        }
        set({
          form: {
            open: true,
            mode: 'create',
            name: '',
            members: [{ key: nextMemberKey(), alias: '', path: '' }],
            busy: false,
          },
        })
      },

      inspectWorkspaceMember: async (key) => {
        const state = get()
        if (state.disposed || !state.form.open) return
        const member = state.form.members.find((item) => item.key === key)
        if (!member) return
        const path = member.path.trim()
        const epoch = (memberEpochs.get(key) ?? 0) + 1
        memberEpochs.set(key, epoch)
        if (!path) {
          set({
            form: {
              ...state.form,
              members: state.form.members.map((item) =>
                item.key === key
                  ? {
                      ...item,
                      checking: false,
                      available: undefined,
                      trust: undefined,
                      trustFailed: false,
                    }
                  : item,
              ),
            },
          })
          return
        }
        const currentMember = (): WorkspaceMemberDraft | undefined =>
          get().form.members.find((item) => item.key === key)
        set({
          form: {
            ...state.form,
            members: state.form.members.map((item) =>
              item.key === key ? { ...item, checking: true } : item,
            ),
          },
        })
        try {
          const check = await browser.client.checkProjectPath(path)
          const current = get()
          const target = currentMember()
          if (
            current.disposed ||
            epoch !== memberEpochs.get(key) ||
            !target ||
            target.path.trim() !== path
          ) {
            return
          }
          const available = !check.error && check.exists && check.isDirectory
          if (!available) {
            set({
              form: {
                ...current.form,
                members: current.form.members.map((item) =>
                  item.key === key
                    ? {
                        ...item,
                        checking: false,
                        available: false,
                        trust: undefined,
                        trustFailed: false,
                      }
                    : item,
                ),
              },
            })
            return
          }
          let trust: HarnessProjectInfo | undefined
          let trustFailed = false
          try {
            trust = await browser.client.inspectProjectTrust({ path: check.path })
          } catch {
            trustFailed = true
          }
          const latest = get()
          const latestMember = latest.form.members.find((item) => item.key === key)
          if (
            latest.disposed ||
            epoch !== memberEpochs.get(key) ||
            !latestMember ||
            latestMember.path.trim() !== path
          ) {
            return
          }
          set({
            form: {
              ...latest.form,
              members: latest.form.members.map((item) =>
                item.key === key
                  ? {
                      ...item,
                      checking: false,
                      available: true,
                      trust,
                      trustFailed,
                    }
                  : item,
              ),
            },
          })
        } catch {
          const latest = get()
          const latestMember = latest.form.members.find((item) => item.key === key)
          if (
            latest.disposed ||
            epoch !== memberEpochs.get(key) ||
            !latestMember ||
            latestMember.path.trim() !== path
          ) {
            return
          }
          set({
            form: {
              ...latest.form,
              members: latest.form.members.map((item) =>
                item.key === key
                  ? {
                      ...item,
                      checking: false,
                      available: false,
                      trust: undefined,
                      trustFailed: false,
                    }
                  : item,
              ),
            },
          })
        }
      },

      openTrust: async (path, intent) => {
        const state = get()
        if (state.disposed) return
        const epoch = ++trustEpoch
        set({
          trust: {
            open: true,
            path,
            epoch,
            loading: true,
            info: undefined,
            remember: false,
            busy: false,
            error: false,
            intent,
          },
        })
        try {
          const info = await browser.client.inspectProjectTrust({ path })
          const current = get()
          if (current.disposed || !current.trust.open || current.trust.epoch !== epoch) return
          set({ trust: { ...current.trust, loading: false, info } })
        } catch {
          const current = get()
          if (current.disposed || !current.trust.open || current.trust.epoch !== epoch) return
          set({ trust: { ...current.trust, loading: false, error: true } })
        }
      },

      closeTrust: () => {
        const state = get()
        if (state.disposed) return
        trustEpoch += 1
        set({ trust: emptyTrust() })
      },

      setTrustRemember: (remember) => {
        const state = get()
        if (state.disposed || !state.trust.open || state.trust.busy) return
        set({ trust: { ...state.trust, remember } })
      },

      decideTrust: async (trusted) => {
        const state = get()
        if (state.disposed || !state.trust.open || state.trust.busy) return undefined
        const panel = state.trust
        const path = panel.path
        const epoch = panel.epoch
        set({ trust: { ...panel, busy: true, error: false } })
        try {
          const info = await browser.client.decideProjectTrust({
            path,
            trusted,
            ...(panel.remember ? { remember: true } : {}),
          })
          const current = get()
          if (current.disposed || !current.trust.open || current.trust.epoch !== epoch) {
            return undefined
          }
          if (info.status === 'failed') {
            set({ trust: { ...current.trust, info, busy: false, error: true } })
            return info
          }
          // 只在表单仍打开时更新同路径成员；迟到结果不影响后来重新打开的表单。
          if (current.form.open) {
            set({
              form: {
                ...current.form,
                members: current.form.members.map((member) =>
                  member.path.trim() === path
                    ? {
                        ...member,
                        available: info.status !== 'failed',
                        trust: info,
                        trustFailed: false,
                      }
                    : member,
                ),
              },
            })
          }
          set({ trust: emptyTrust() })
          get().showNotice(
            trusted
              ? '已允许该项目加载项目资源；决定只影响当前用户空间。'
              : '已拒绝项目资源；仍可使用用户级资源，项目扩展不会加载。',
          )
          if (panel.intent?.kind === 'new-session') finalizeNewSession(panel.intent)
          return info
        } catch {
          const current = get()
          if (current.disposed || !current.trust.open || current.trust.epoch !== epoch) {
            return undefined
          }
          set({ trust: { ...current.trust, busy: false, error: true } })
          return undefined
        }
      },

      closeWorkspaceForm: () => {
        if (get().disposed) return
        formEpoch += 1
        set({ form: emptyForm() })
      },

      setWorkspaceFormName: (name) => {
        const state = get()
        if (state.disposed) return
        set({ form: { ...state.form, name } })
      },

      setWorkspaceMember: (key, patch) => {
        const state = get()
        if (state.disposed) return
        // 路径变化使旧健康/信任结果立即失效；由失焦或显式刷新重新检查。
        const pathChanged = patch.path !== undefined
        if (pathChanged) memberEpochs.set(key, (memberEpochs.get(key) ?? 0) + 1)
        set({
          form: {
            ...state.form,
            members: state.form.members.map((member) =>
              member.key === key
                ? {
                    ...member,
                    ...patch,
                    ...(pathChanged
                      ? {
                          checking: false,
                          available: undefined,
                          trust: undefined,
                          trustFailed: false,
                        }
                      : {}),
                  }
                : member,
            ),
          },
        })
      },

      addWorkspaceMember: () => {
        const state = get()
        if (state.disposed) return
        set({
          form: {
            ...state.form,
            members: [...state.form.members, { key: nextMemberKey(), alias: '', path: '' }],
          },
        })
      },

      removeWorkspaceMember: (key) => {
        const state = get()
        if (state.disposed || state.form.members.length <= 1) return
        set({
          form: {
            ...state.form,
            members: state.form.members.filter((member) => member.key !== key),
          },
        })
      },

      saveWorkspaceForm: async () => {
        const state = get()
        if (state.disposed || state.form.busy || !state.form.open) return
        const workspaceState = browser.serviceStore.getState().workspaceState
        if (workspaceState !== undefined && workspaceState !== 'ok') {
          set({
            form: {
              ...state.form,
              message: '工作区元数据不可用；修复 state.json 后才能保存。',
            },
          })
          return
        }
        const form = state.form
        const name = form.name.trim()
        const projects: HarnessWorkspaceProjectInput[] = form.members
          .filter((member) => member.alias.trim() || member.path.trim())
          .map((member) => ({ alias: member.alias.trim(), path: member.path.trim() }))
        if (!name || projects.length === 0) {
          set({ form: { ...form, message: '请填写工作区名称与至少一个项目成员。' } })
          return
        }
        set({ form: { ...form, busy: true, message: undefined } })
        const submittedEpoch = formEpoch
        // 保存期间成员检查可能刷新路径状态；只有用户改过的草稿才阻止自动关闭。
        const submittedDraft = JSON.stringify({
          mode: form.mode,
          workspaceId: form.workspaceId ?? null,
          name,
          projects,
        })
        try {
          const result =
            form.mode === 'edit' && form.workspaceId
              ? await browser.client.updateWorkspace({
                  workspaceId: form.workspaceId,
                  expectedRevision: form.revision ?? 0,
                  name,
                  projects,
                })
              : await browser.client.createWorkspace({ name, projects })
          if (get().disposed) return
          if (!result.ok) {
            if (result.workspace) browser.serviceStore.getState().applyWorkspace(result.workspace)
            if (formEpoch === submittedEpoch) {
              // 冲突仍保留提交原文，用户自行重读处理，不能用服务端值盖掉草稿。
              set({ form: { ...get().form, busy: false, message: mutationErrorText(result) } })
            }
            return
          }
          browser.serviceStore.getState().applyWorkspace(result.workspace)
          // 首个工作区创建后立即成为活动工作区，避免列表可见但未展开。
          const afterSave = get()
          if (
            !afterSave.activeWorkspaceId ||
            !browser.serviceStore.getState().workspacesById[afterSave.activeWorkspaceId]
          ) {
            const expanded = new Set(afterSave.expandedWorkspaceIds)
            expanded.add(result.workspace.id)
            persistLocked(
              afterSave.storageScope,
              result.workspace.id,
              expanded,
              afterSave.startProjectByWorkspace,
            )
            set({
              activeWorkspaceId: result.workspace.id,
              expandedWorkspaceIds: expanded,
            })
          }
          try {
            await browser.serviceStore.getState().refreshThreads({ includeArchived: true })
          } catch {
            // 工作区保存已成功；会话目录刷新失败只影响列表，下一次显式刷新恢复。
          }
          if (get().disposed || formEpoch !== submittedEpoch) return
          const currentForm = get().form
          const currentDraft = JSON.stringify({
            mode: currentForm.mode,
            workspaceId: currentForm.workspaceId ?? null,
            name: currentForm.name.trim(),
            projects: currentForm.members
              .filter((member) => member.alias.trim() || member.path.trim())
              .map((member) => ({ alias: member.alias.trim(), path: member.path.trim() })),
          })
          if (currentDraft === submittedDraft) set({ form: emptyForm() })
          else set({ form: { ...currentForm, busy: false } })
          get().showNotice(form.mode === 'edit' ? '工作区已更新。' : '工作区已创建。')
        } catch {
          if (get().disposed || formEpoch !== submittedEpoch) return
          set({
            form: {
              ...get().form,
              busy: false,
              message: '保存失败，请检查宿主连接后重试。',
            },
          })
        }
      },

      setSearch: (search) => {
        if (get().disposed) return
        set({ search })
      },

      setScope: (scope) => {
        if (get().disposed) return
        set({ scope })
      },

      setSort: (sort) => {
        if (get().disposed) return
        set({ sort })
      },

      setNamedOnly: (namedOnly) => {
        if (get().disposed) return
        set({ namedOnly })
      },

      setShowArchived: (showArchived) => {
        if (get().disposed) return
        set({ showArchived })
      },

      showNotice: (message) => {
        if (get().disposed) return
        set({ notice: message, error: undefined })
      },

      clearError: () => {
        if (get().disposed) return
        set({ error: undefined })
      },

      clearNotice: () => {
        if (get().disposed) return
        set({ notice: undefined })
      },

      dispose: () => {
        if (get().disposed) return
        initialized = true
        refreshEpoch += 1
        set({
          disposed: true,
          activeWorkspaceId: undefined,
          expandedWorkspaceIds: new Set(),
          startProjectByWorkspace: {},
          form: emptyForm(),
          newSession: emptyNewSession(),
          trust: emptyTrust(),
          busy: false,
          error: undefined,
          notice: undefined,
        })
      },
    }
  })
}
