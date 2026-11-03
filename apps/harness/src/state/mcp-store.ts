/**
 * MCP 管理 feature Zustand 状态：配置原文/草稿、运行态查询、详情与 OAuth 短期回填。
 *
 * 业务边界（见 R1 §5.4、R2 §7）：
 * - 面板打开时固定 target 与 panelEpoch；迟到响应只更新原对象，不串到新目标；
 * - 普通快照只查询已有配置/manager，不启动连接、不创建第二份 manager；
 * - 配置原文只在用户进入配置视图时显式读取；常用表单与 JSON 原文编辑同一份草稿，
 *   保存带 revision，保存 ≠ 应用，冲突/失败保留草稿；
 * - 关闭面板丢弃 raw 快照与大结果，但保留 dirty 草稿供重开；不取消远端认证或写入；
 * - OAuth 回填值只留本 store 内存，提交前清空；认证权威快照始终在公共 serviceStore，
 *   本 store 不复制凭据、不写持久化、不记录动作载荷。
 */

import type {
  HarnessMcpAuthCancelResult,
  HarnessMcpAuthOperation,
  HarnessMcpAuthPrompt,
  HarnessMcpAuthSnapshot,
  HarnessMcpConfigFile,
  HarnessMcpConfigIssue,
  HarnessMcpConfigSaveResult,
  HarnessMcpConfigSnapshot,
  HarnessMcpDetails,
  HarnessMcpExposure,
  HarnessMcpManageAction,
  HarnessMcpServerAuth,
  HarnessMcpServerState,
  HarnessMcpSnapshot,
  HarnessMcpTargetInput,
  HarnessReloadResult,
} from '@huan/protocol'
import { type HarnessBrowser, HarnessHttpError } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  applyServerForm as applyServerFormToDraft,
  emptyServerForm,
  formatMcpDraft,
  formFromServer,
  listDraftServers,
  type McpConfigScope,
  type McpServerForm,
  type McpServerKind,
  mcpDraftKey,
  parseMcpDraft,
  removeDraftServer,
  serverKindOf,
} from './mcp-config'

/** MCP 面板视图。 */
export type McpTab = 'servers' | 'config' | 'auth'

/** 常用编辑 / JSON 原文。 */
export type McpConfigView = 'common' | 'json'

/** `/mcp` 命令的种子动作；由快照就绪后一次性消费。 */
export type McpCommandMode = 'login' | 'logout' | 'reconnect'

/** MCP 目标输入；`global` 由协议定义，只用于用户配置读取/保存。 */
export type McpTargetInput = HarnessMcpTargetInput

/** 打开面板选项；target 省略时按当前窗口选择解析。 */
export interface McpOpenOptions {
  target?: McpTargetInput
  tab?: McpTab
  /** 显式固定配置作用域；项目目标固定 project，全局目标固定 user。 */
  scope?: McpConfigScope
  mode?: McpCommandMode
  server?: string
}

/** 单个作用域的编辑草稿；原文与基线分开用于 dirty 判断。 */
export interface McpConfigDraftState {
  content: string
  baseContent: string
  /** 草稿基线对应的磁盘 revision；保存时作为 expectedRevision。 */
  revision: string | null
  /** 每次内容变化推进；保存回执据此判断是否已有新编辑。 */
  draftRevision: number
  issues: readonly HarnessMcpConfigIssue[]
}

/** 常用表单编辑器状态；只作用于当前 JSON 草稿。 */
export interface McpServerEditorState {
  originalName?: string
  form: McpServerForm
}

/** 服务器列表行：配置合并预览与 live manager 的唯一展示投影。 */
export interface McpServerRow {
  name: string
  identity: string
  scope: 'user' | 'project' | 'extension'
  override: boolean
  enabled: boolean
  exposure: HarnessMcpExposure
  state: HarnessMcpServerState
  toolCount: number
  hasResources: boolean
  auth?: HarnessMcpServerAuth
  error?: { code: string; message: string }
  live: boolean
  configPending: boolean
}

/** MCP feature 状态。 */
export interface McpFeatureState {
  open: boolean
  /** 面板代次；打开/关闭/换目标推进，旧请求不得写回。 */
  targetEpoch: number
  target: McpTargetInput | undefined
  targetKey: string | undefined
  tab: McpTab
  scope: McpConfigScope
  configView: McpConfigView

  /** 普通 MCP 快照（当前 target）；关闭或换目标后丢弃。 */
  snapshot: HarnessMcpSnapshot | undefined
  /** 显式配置编辑快照；可能含秘密，关闭即丢弃。 */
  configSnapshot: HarnessMcpConfigSnapshot | undefined
  drafts: Readonly<Record<string, McpConfigDraftState>>

  notice: string | undefined
  error: string | undefined
  targetError: string | undefined
  targetLoading: boolean
  configLoading: boolean
  busy: string | undefined

  selected: string | undefined
  details: HarnessMcpDetails | undefined
  detailsError: string | undefined
  detailsLoading: boolean

  /** 按 `${operationId}|${promptId}` 保存的短期回填；提交即清空。 */
  answers: Readonly<Record<string, string>>
  submitting: string | undefined
  cancelling: Readonly<Record<string, boolean>>

  editor: McpServerEditorState | undefined
  editorError: string | undefined
  deleteName: string | undefined
  rereadConfirm: boolean

  seed: { mode?: McpCommandMode; server?: string } | undefined
  disposed: boolean

  /** 打开面板并固定目标；保留同一目标未保存草稿。 */
  openPanel: (options?: McpOpenOptions) => Promise<void>
  /** 关闭面板：使在途请求失效并丢弃 raw 快照，但保留 dirty 草稿。 */
  close: () => void
  setTab: (tab: McpTab) => Promise<void>
  setScope: (scope: McpConfigScope) => void
  setConfigView: (view: McpConfigView) => void
  /** 查询当前 target 的普通快照；只读已有配置/manager。 */
  refreshLive: () => Promise<void>
  /** 显式读取配置原文；`resetScope` 用于“重新读取”确认。 */
  loadConfig: (options?: { resetScope?: McpConfigScope }) => Promise<void>
  updateDraft: (content: string) => void
  resetDraft: () => void
  saveConfig: () => Promise<void>
  /** 应用资源重载到固定 target；不重置草稿。 */
  applyReload: () => Promise<void>
  openAddServer: (kind: McpServerKind) => void
  openEditServer: (name: string) => void
  updateServerForm: (form: McpServerForm) => void
  cancelServerEditor: () => void
  applyServerEditor: () => void
  requestDeleteServer: (name: string) => void
  cancelDeleteServer: () => void
  confirmDeleteServer: () => void
  requestReread: () => Promise<void>
  selectServer: (name: string) => Promise<void>
  loadDetails: (name: string, toolsOnly?: boolean) => Promise<void>
  manage: (row: McpServerRow, action: HarnessMcpManageAction) => Promise<void>
  startAuth: (kind: 'login' | 'logout', row: McpServerRow) => Promise<void>
  setAnswer: (operationId: string, promptId: string, value: string) => void
  submitPrompt: (operation: HarnessMcpAuthOperation, prompt: HarnessMcpAuthPrompt) => Promise<void>
  cancelAuth: (operationId: string) => Promise<void>
  clearNotice: () => void
  dispose: () => void
}

export interface CreateMcpFeatureStoreOptions {
  browser: HarnessBrowser
  /** 空白页没有窗口选择时的起始目录来源；由组合根提供。 */
  fallbackWorkspacePath?: () => string | undefined
}

const httpCodeOf = (error: unknown): string | undefined =>
  error instanceof HarnessHttpError ? error.code : undefined

/** 全局用户配置的固定目标键；不与任何项目/会话草稿混用。 */
export const MCP_GLOBAL_TARGET_KEY = 'global'

/** 是否为统一设置中的全局用户配置目标。 */
export const isGlobalMcpTarget = (target: McpTargetInput | undefined): boolean =>
  target?.global === true

/** 固定作用域：全局用户配置只写 user，项目目标只写 project。 */
const fixedScopeOf = (target: McpTargetInput | undefined): McpConfigScope | undefined => {
  if (!target) return undefined
  if (isGlobalMcpTarget(target)) return 'user'
  if (target.threadId) return undefined
  return target.workspacePath ? 'project' : undefined
}

/** 目标键：会话优先；同一目标内作用域草稿再分键。 */
export const mcpTargetKey = (target: McpTargetInput | undefined): string | undefined => {
  if (!target) return undefined
  if (isGlobalMcpTarget(target)) return MCP_GLOBAL_TARGET_KEY
  if (target.threadId) return `t:${target.threadId}`
  return target.workspacePath ? `w:${target.workspacePath}` : undefined
}

const targetInputOf = (target: McpTargetInput): McpTargetInput => {
  if (isGlobalMcpTarget(target)) return { global: true }
  return {
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(target.threadId ? {} : { workspacePath: target.workspacePath }),
  }
}

const draftIsDirty = (draft: McpConfigDraftState | undefined): boolean =>
  draft !== undefined && draft.content !== draft.baseContent

const draftFromFile = (file: HarnessMcpConfigFile): McpConfigDraftState => {
  const content = file.exists ? file.content : '{}\n'
  return {
    content,
    baseContent: content,
    revision: file.revision,
    draftRevision: 0,
    issues: [],
  }
}

/** 配置保存/读取错误的受控文案；不回显服务端原始异常或响应正文。 */
const configFailureText = (error: unknown): string => {
  switch (httpCodeOf(error)) {
    case 'mcp-config-conflict':
      return '保存冲突：MCP 配置已在其他窗口或进程被修改。草稿已保留，请先“重新读取”再合并。'
    case 'mcp-config-untrusted':
      return '项目未信任，不能读取或写入项目 MCP 配置。'
    case 'mcp-config-too-large':
      return 'MCP 配置超过大小上限，未保存；草稿已保留。'
    case 'mcp-config-write-failed':
      return '写入 MCP 配置失败；草稿未丢失。'
    default:
      return 'MCP 配置操作失败；请检查宿主连接后重试。'
  }
}

const reloadFailureText = (result: Extract<HarnessReloadResult, { status: 'failed' }>): string => {
  switch (result.reason) {
    case 'trust':
      return '目标项目需要信任决定，MCP 资源重载未执行。请先完成信任决定。'
    case 'assembly':
      return 'MCP 资源装配或重载失败；旧连接可能已关闭，请核对诊断后重试。'
    case 'disposed':
      return '宿主或会话正在关闭，MCP 资源重载未执行。'
  }
}

const authPhaseLabel = (phase: HarnessMcpAuthOperation['phase']): string => {
  switch (phase) {
    case 'starting':
      return '正在开始'
    case 'waiting':
      return '等待授权'
    case 'prompt':
      return '等待回填'
    case 'verifying':
      return '正在验证'
    case 'cancelling':
      return '正在取消'
    case 'succeeded':
      return '成功'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
  }
}

export const mcpAuthPhaseLabel = authPhaseLabel

const activeAuthOperation = (operation: HarnessMcpAuthOperation): boolean =>
  operation.phase !== 'succeeded' && operation.phase !== 'failed' && operation.phase !== 'cancelled'

const answerKey = (operationId: string, promptId: string): string => `${operationId}|${promptId}`

const activePromptKeys = (snapshot: HarnessMcpAuthSnapshot | undefined): Set<string> => {
  const keys = new Set<string>()
  for (const operation of snapshot?.operations ?? []) {
    if (!operation.prompt || !activeAuthOperation(operation)) continue
    keys.add(answerKey(operation.id, operation.prompt.promptId))
  }
  return keys
}

const activeOperationIds = (snapshot: HarnessMcpAuthSnapshot | undefined): Set<string> => {
  const ids = new Set<string>()
  for (const operation of snapshot?.operations ?? []) {
    if (activeAuthOperation(operation)) ids.add(operation.id)
  }
  return ids
}

/** 从普通快照与配置预览合并出行；配置 pending 只比较已读取的磁盘值。 */
export const selectMcpServerRows = (
  state: Pick<McpFeatureState, 'snapshot' | 'configSnapshot'>,
): McpServerRow[] => {
  const map = new Map<string, McpServerRow>()
  const configured = new Map(
    (state.configSnapshot?.effective.servers ?? []).map((server) => [server.name, server]),
  )
  for (const server of state.configSnapshot?.effective.servers ?? []) {
    map.set(server.name, {
      name: server.name,
      identity: server.identity,
      scope: server.scope,
      override: server.override,
      enabled: server.enabled,
      exposure: server.exposure,
      state: server.enabled ? 'not-connected' : 'disabled',
      toolCount: 0,
      hasResources: false,
      live: false,
      configPending: false,
    })
  }
  const live =
    state.snapshot?.live === true &&
    state.snapshot.runtime !== undefined &&
    !state.snapshot.runtime.closed
  for (const server of state.snapshot?.servers ?? []) {
    const config = configured.get(server.name)
    map.set(server.name, {
      name: server.name,
      identity: server.identity,
      scope: server.scope,
      override: server.override,
      enabled: server.enabled,
      exposure: server.exposure,
      state: server.state,
      toolCount: server.toolCount,
      hasResources: server.hasResources,
      auth: server.auth,
      ...(server.error ? { error: server.error } : {}),
      live,
      configPending:
        config !== undefined &&
        (config.enabled !== server.enabled || config.exposure !== server.exposure),
    })
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export const createMcpFeatureStore = (
  options: CreateMcpFeatureStoreOptions,
): StoreApi<McpFeatureState> => {
  const { browser } = options
  let panelEpoch = 0
  let targetRequest = 0
  let configRequest = 0
  let saveRequest = 0
  let manageRequest = 0
  let detailsRequest = 0
  let authRequest = 0
  let lastRuntime: string | undefined

  const resolveTarget = (): McpTargetInput | undefined => {
    const selection = browser.windowStore.getState().selection
    if (selection?.kind === 'thread') return { threadId: selection.threadId }
    if (selection?.kind === 'new') return { workspacePath: selection.startProjectPath }
    const workspacePath =
      options.fallbackWorkspacePath?.() ?? browser.serviceStore.getState().host?.workspacePath
    return workspacePath ? { workspacePath } : undefined
  }

  const store = createStore<McpFeatureState>()((set, get) => {
    const keyNow = (): string | undefined => {
      const state = get()
      return state.targetKey ? mcpDraftKey(state.targetKey, state.scope) : undefined
    }

    const draftOf = (targetKey: string, scope: McpConfigScope): string =>
      mcpDraftKey(targetKey, scope)

    const withDraftsFromSnapshot = (
      snapshot: HarnessMcpConfigSnapshot,
      targetKey: string,
      resetScope: McpConfigScope | undefined,
      global: boolean,
    ): Record<string, McpConfigDraftState> => {
      const drafts: Record<string, McpConfigDraftState> = { ...get().drafts }
      // 全局目标只暴露用户配置；不能因为快照字段存在就生成项目草稿。
      const scopes = global ? (['user'] as const) : (['user', 'project'] as const)
      for (const scope of scopes) {
        const key = draftOf(targetKey, scope)
        const file = scope === 'user' ? snapshot.files.user : snapshot.files.project
        if (resetScope === scope) delete drafts[key]
        if (!file.readable || file.tooLarge || file.readError) {
          // 不可编辑的文件不保留旧基线；用户真正 dirty 的草稿仍保留。
          if (!draftIsDirty(drafts[key])) delete drafts[key]
          continue
        }
        const existing = drafts[key]
        if (!existing || !draftIsDirty(existing)) drafts[key] = draftFromFile(file)
      }
      return drafts
    }

    const applyLiveSnapshot = (snapshot: HarnessMcpSnapshot): void => {
      const current = get()
      const runtime = snapshot.runtime?.runtimeId
      const runtimeChanged = runtime !== lastRuntime
      lastRuntime = runtime
      if (!runtimeChanged) {
        set({ snapshot })
        return
      }
      // runtime 替换后旧 schema/instructions 不再权威；关闭详情大结果。
      detailsRequest += 1
      set({
        snapshot,
        details: undefined,
        detailsError: undefined,
        detailsLoading: false,
      })
      if (current.selected !== undefined && snapshot.servers.length === 0)
        set({ selected: undefined })
    }

    const applyDraftContent = (content: string, extra?: Partial<McpFeatureState>): void => {
      const key = keyNow()
      if (!key) return
      const current = get()
      const existing = current.drafts[key]
      if (!existing || existing.content === content) {
        if (extra) set(extra)
        return
      }
      set({
        drafts: {
          ...current.drafts,
          [key]: {
            ...existing,
            content,
            draftRevision: existing.draftRevision + 1,
            issues: [],
          },
        },
        notice: undefined,
        error: undefined,
        rereadConfirm: false,
        ...extra,
      })
    }

    const consumeSeed = async (): Promise<void> => {
      const state = get()
      const seed = state.seed
      if (!seed || !state.open || !state.snapshot) return
      set({ seed: undefined })
      const { mode, server } = seed
      if (!server) {
        if (mode) set({ notice: '请选择要操作的 MCP 服务器。' })
        return
      }
      const row = selectMcpServerRows(get()).find((item) => item.name === server)
      if (!row) {
        set({ notice: `找不到此服务器：${server}，请重新选择。` })
        return
      }
      if (!row.live) {
        set({ notice: `服务器 ${server} 尚未连接；请先应用配置。` })
        return
      }
      set({ selected: row.name })
      if (mode === 'login' || mode === 'logout') {
        await get().startAuth(mode, row)
        return
      }
      if (mode === 'reconnect') {
        await get().manage(row, { type: 'reconnect' })
        return
      }
      await get().loadDetails(row.name)
    }

    const runReload = async (target: McpTargetInput): Promise<HarnessReloadResult> =>
      browser.client.reloadResources({ ...targetInputOf(target), trigger: 'api' })

    return {
      open: false,
      targetEpoch: 0,
      target: undefined,
      targetKey: undefined,
      tab: 'servers',
      scope: 'user',
      configView: 'common',
      snapshot: undefined,
      configSnapshot: undefined,
      drafts: {},
      notice: undefined,
      error: undefined,
      targetError: undefined,
      targetLoading: false,
      configLoading: false,
      busy: undefined,
      selected: undefined,
      details: undefined,
      detailsError: undefined,
      detailsLoading: false,
      answers: {},
      submitting: undefined,
      cancelling: {},
      editor: undefined,
      editorError: undefined,
      deleteName: undefined,
      rereadConfirm: false,
      seed: undefined,
      disposed: false,

      openPanel: async (openOptions) => {
        if (get().disposed) return
        const target = openOptions?.target ? targetInputOf(openOptions.target) : resolveTarget()
        const targetKey = mcpTargetKey(target)
        const global = isGlobalMcpTarget(target)
        const fixedScope = fixedScopeOf(target)
        const epoch = ++panelEpoch
        targetRequest += 1
        configRequest += 1
        saveRequest += 1
        manageRequest += 1
        detailsRequest += 1
        authRequest += 1
        lastRuntime = undefined
        set({
          open: true,
          targetEpoch: epoch,
          target,
          targetKey,
          // 全局只展示用户配置；项目目标固定配置视图，不先请求运行快照。
          tab: global
            ? 'config'
            : (openOptions?.tab ?? (target?.workspacePath ? 'config' : 'servers')),
          scope: fixedScope ?? openOptions?.scope ?? get().scope,
          snapshot: undefined,
          configSnapshot: undefined,
          notice: undefined,
          error: undefined,
          targetError: undefined,
          targetLoading: false,
          configLoading: false,
          busy: undefined,
          selected: undefined,
          details: undefined,
          detailsError: undefined,
          detailsLoading: false,
          answers: {},
          submitting: undefined,
          cancelling: {},
          editor: undefined,
          editorError: undefined,
          deleteName: undefined,
          rereadConfirm: false,
          seed:
            openOptions?.mode || openOptions?.server
              ? {
                  ...(openOptions.mode ? { mode: openOptions.mode } : {}),
                  ...(openOptions.server ? { server: openOptions.server } : {}),
                }
              : undefined,
        })
        browser.setMcpAuthPanelOpen(true)
        if (!target) {
          set({ notice: '当前没有可用的会话或起始目录；请先选择工作区/项目。' })
          return
        }
        if (global) {
          // 全局目标只有配置原文；不查询 getMcp、不启动连接、不探测路径。
          await get().loadConfig()
          return
        }
        await get().refreshLive()
        const current = get()
        if (!current.open || current.targetEpoch !== epoch) return
        if (current.tab === 'config' && !current.configSnapshot) await current.loadConfig()
      },

      close: () => {
        if (get().disposed) return
        panelEpoch += 1
        targetRequest += 1
        configRequest += 1
        saveRequest += 1
        manageRequest += 1
        detailsRequest += 1
        authRequest += 1
        lastRuntime = undefined
        // 只失效本地请求与 raw 快照；dirty 草稿保留，远端认证/写入不撤销。
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: undefined,
          snapshot: undefined,
          configSnapshot: undefined,
          notice: undefined,
          error: undefined,
          targetError: undefined,
          targetLoading: false,
          configLoading: false,
          busy: undefined,
          selected: undefined,
          details: undefined,
          detailsError: undefined,
          detailsLoading: false,
          answers: {},
          submitting: undefined,
          cancelling: {},
          editor: undefined,
          editorError: undefined,
          deleteName: undefined,
          rereadConfirm: false,
          seed: undefined,
        })
        browser.setMcpAuthPanelOpen(false)
      },

      setTab: async (tab) => {
        const state = get()
        if (state.disposed) return
        // 全局页只有用户配置内容，不接受运行/认证视图切换。
        if (isGlobalMcpTarget(state.target)) {
          if (state.tab !== 'config') set({ tab: 'config' })
          return
        }
        if (tab !== 'servers') detailsRequest += 1
        set({
          tab,
          notice: undefined,
          ...(tab === 'servers'
            ? {}
            : {
                details: undefined,
                detailsError: undefined,
                detailsLoading: false,
              }),
        })
        if (tab === 'config' && get().open && get().target && !get().configSnapshot) {
          await get().loadConfig()
        }
      },

      setScope: (scope) => {
        const state = get()
        if (state.disposed || state.scope === scope) return
        // 全局固定 user、项目目标固定 project；不允许在同一上下文混入另一作用域。
        const fixed = fixedScopeOf(state.target)
        if (fixed !== undefined && scope !== fixed) return
        if (scope === 'project' && state.snapshot && !state.snapshot.projectTrusted) return
        set({
          scope,
          notice: undefined,
          error: undefined,
          editor: undefined,
          editorError: undefined,
          deleteName: undefined,
          rereadConfirm: false,
        })
      },

      setConfigView: (configView) => {
        if (get().disposed) return
        set({ configView })
      },

      refreshLive: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target) return
        // 全局目标禁止运行快照（宿主会拒绝 getMcp）；这里直接短路。
        if (isGlobalMcpTarget(target)) {
          set({ targetLoading: false })
          return
        }
        const epoch = ++targetRequest
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        set({ targetLoading: true })
        try {
          const snapshot = await browser.client.getMcp(target)
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== targetRequest
          ) {
            return
          }
          applyLiveSnapshot(snapshot)
          set({ targetLoading: false, targetError: undefined })
          await consumeSeed()
        } catch {
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== targetRequest
          ) {
            return
          }
          set({
            targetLoading: false,
            targetError: '无法刷新 MCP 服务器状态；将自动重试。',
          })
        }
      },

      loadConfig: async (loadOptions) => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target || !state.targetKey) return
        const epoch = ++configRequest
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        set({ configLoading: true, error: undefined })
        try {
          const snapshot = await browser.client.getMcpConfig(target)
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== configRequest
          ) {
            return
          }
          const fixed = fixedScopeOf(target)
          set({
            configSnapshot: snapshot,
            drafts: withDraftsFromSnapshot(
              snapshot,
              targetKey,
              loadOptions?.resetScope,
              isGlobalMcpTarget(target),
            ),
            configLoading: false,
            error: undefined,
            ...(fixed !== undefined
              ? { scope: fixed }
              : current.scope === 'project' && !snapshot.projectTrusted
                ? { scope: 'user' }
                : {}),
          })
        } catch (error) {
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== configRequest
          ) {
            return
          }
          set({ configLoading: false, error: configFailureText(error) })
        }
      },

      updateDraft: (content) => {
        if (get().disposed) return
        applyDraftContent(content)
      },

      resetDraft: () => {
        const state = get()
        if (state.disposed) return
        const key = keyNow()
        const draft = key ? state.drafts[key] : undefined
        if (!key || !draft) return
        set({
          drafts: {
            ...state.drafts,
            [key]: {
              ...draft,
              content: draft.baseContent,
              draftRevision: draft.draftRevision + 1,
              issues: [],
            },
          },
          notice: undefined,
          error: undefined,
          editor: undefined,
          editorError: undefined,
          deleteName: undefined,
          rereadConfirm: false,
        })
      },

      saveConfig: async () => {
        const state = get()
        const target = state.target
        const key = keyNow()
        const draft = key ? state.drafts[key] : undefined
        if (state.disposed || !state.open || !target || !key || !draft || state.busy) return
        const scope = state.scope
        const targetKey = state.targetKey
        const submitted = {
          content: draft.content,
          revision: draft.revision,
          draftRevision: draft.draftRevision,
        }
        const panel = state.targetEpoch
        const request = ++saveRequest
        set({ busy: 'save', notice: undefined, error: undefined })
        try {
          const result = await browser.client.saveMcpConfig({
            target,
            scope,
            content: submitted.content,
            expectedRevision: submitted.revision,
          })
          const current = get()
          if (current.disposed || request !== saveRequest) return
          const currentDraft = current.drafts[key]
          if (!currentDraft) return
          const samePanel =
            current.open && current.targetEpoch === panel && current.targetKey === targetKey
          if (result.status === 'saved') {
            const editedLater = currentDraft.draftRevision !== submitted.draftRevision
            // 全局页没有应用动作，成功提示只报告保存结果。
            const savedNotice = isGlobalMcpTarget(target)
              ? '已保存'
              : result.apply.reloadRequired
                ? target.threadId
                  ? '已保存，可应用到当前会话'
                  : '已保存，可刷新项目资源'
                : '已保存'
            set({
              // 保存响应只更新所属草稿基线；请求期间的新编辑保留。
              drafts: {
                ...current.drafts,
                [key]: {
                  content: editedLater ? currentDraft.content : submitted.content,
                  baseContent: submitted.content,
                  revision: result.revision,
                  draftRevision: currentDraft.draftRevision,
                  issues: [],
                },
              },
              ...(samePanel
                ? {
                    configSnapshot: result.snapshot,
                    notice: savedNotice,
                  }
                : {}),
            })
            return
          }
          if (result.status === 'invalid') {
            set({
              drafts: {
                ...current.drafts,
                [key]: { ...currentDraft, issues: result.issues },
              },
              ...(samePanel ? { error: result.message } : {}),
            })
            return
          }
          set({
            ...(samePanel ? { error: saveResultText(result) } : {}),
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== saveRequest) return
          if (current.targetKey === targetKey) set({ error: configFailureText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === saveRequest) set({ busy: undefined })
        }
      },

      applyReload: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target || state.busy) return
        // 全局目标不建立连接，也不探测路径；应用动作只能从会话/项目上下文发起。
        if (isGlobalMcpTarget(target)) {
          set({ notice: '全局 MCP 配置保存后不自动应用；请从会话或项目资源中应用。' })
          return
        }
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++saveRequest
        set({ busy: 'reload', notice: undefined, error: undefined })
        try {
          const result = await runReload(target)
          const current = get()
          if (current.disposed || request !== saveRequest) return
          const samePanel =
            current.open && current.targetEpoch === panel && current.targetKey === targetKey
          if (result.status !== 'reloaded') {
            if (samePanel) {
              set({
                notice:
                  result.status === 'failed'
                    ? reloadFailureText(result)
                    : result.status === 'busy'
                      ? result.message
                      : result.message,
              })
            }
            if (samePanel) await get().refreshLive()
            return
          }
          if (result.snapshot) {
            browser.serviceStore
              .getState()
              .applyThreadSnapshot(result.snapshot.metadata.id, result.snapshot)
          }
          if (!samePanel) return
          await get().refreshLive()
          if (get().targetEpoch !== panel || get().targetKey !== targetKey) return
          set({
            notice: result.kind === 'session' ? '已应用到当前会话' : '已刷新项目资源',
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== saveRequest) return
          if (current.targetKey === targetKey) set({ error: configFailureText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === saveRequest) set({ busy: undefined })
        }
      },

      openAddServer: (kind) => {
        if (get().disposed) return
        set({
          editor: { form: emptyServerForm(kind) },
          editorError: undefined,
          deleteName: undefined,
          configView: 'common',
        })
      },

      openEditServer: (name) => {
        const state = get()
        if (state.disposed) return
        const key = keyNow()
        const draft = key ? state.drafts[key] : undefined
        if (!draft) return
        const parsed = parseMcpDraft(draft.content)
        if (parsed.error !== undefined) {
          set({ editorError: parsed.error })
          return
        }
        const server = listDraftServers(parsed.value, state.scope).find(
          (item) => item.name === name,
        )
        if (!server) return
        set({
          editor: {
            originalName: name,
            form: formFromServer(
              name,
              server.raw,
              server.override ? 'override' : serverKindOf(server.raw),
            ),
          },
          editorError: undefined,
          deleteName: undefined,
          configView: 'common',
        })
      },

      updateServerForm: (form) => {
        const state = get()
        if (state.disposed || !state.editor) return
        set({ editor: { ...state.editor, form }, editorError: undefined })
      },

      cancelServerEditor: () => {
        if (get().disposed) return
        set({ editor: undefined, editorError: undefined })
      },

      applyServerEditor: () => {
        const state = get()
        if (state.disposed || !state.editor) return
        const key = keyNow()
        const draft = key ? state.drafts[key] : undefined
        if (!draft) return
        const parsed = parseMcpDraft(draft.content)
        if (parsed.error !== undefined) {
          set({ editorError: parsed.error })
          return
        }
        const result = applyServerFormToDraft(
          parsed.value,
          state.editor.originalName,
          state.editor.form,
        )
        if (result.error !== undefined) {
          set({ editorError: result.error })
          return
        }
        applyDraftContent(formatMcpDraft(result.root), {
          editor: undefined,
          editorError: undefined,
          notice: '草稿已更新',
        })
      },

      requestDeleteServer: (name) => {
        if (get().disposed) return
        set({ deleteName: name, editor: undefined, editorError: undefined })
      },

      cancelDeleteServer: () => {
        if (get().disposed) return
        set({ deleteName: undefined })
      },

      confirmDeleteServer: () => {
        const state = get()
        if (state.disposed || !state.deleteName) return
        const key = keyNow()
        const draft = key ? state.drafts[key] : undefined
        if (!draft) return
        const parsed = parseMcpDraft(draft.content)
        if (parsed.error !== undefined) {
          set({ editorError: parsed.error })
          return
        }
        const name = state.deleteName
        applyDraftContent(formatMcpDraft(removeDraftServer(parsed.value, name)), {
          deleteName: undefined,
          notice: `已从草稿删除 ${name}`,
        })
      },

      requestReread: async () => {
        const state = get()
        if (state.disposed) return
        const key = keyNow()
        const dirty = key ? draftIsDirty(state.drafts[key]) : false
        if (dirty && !state.rereadConfirm) {
          set({
            rereadConfirm: true,
            notice: '当前作用域有未保存改动；再次点击“确认重新读取文件”将丢弃该草稿。',
          })
          return
        }
        set({ rereadConfirm: false, notice: undefined })
        await get().loadConfig({ resetScope: state.scope })
      },

      selectServer: async (name) => {
        const state = get()
        if (state.disposed || !state.open) return
        detailsRequest += 1
        set({
          selected: name,
          details: undefined,
          detailsError: undefined,
          detailsLoading: false,
        })
        const row = selectMcpServerRows(get()).find((item) => item.name === name)
        if (row?.live) await get().loadDetails(name)
      },

      loadDetails: async (name, toolsOnly = false) => {
        const state = get()
        const target = state.target
        const snapshot = state.snapshot
        const runtimeId = snapshot?.runtime?.runtimeId
        if (state.disposed || !state.open || !target) return
        if (!runtimeId) {
          set({ detailsError: '连接建立后才能读取工具与资源目录。' })
          return
        }
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const epoch = ++detailsRequest
        const server = snapshot?.servers.find((item) => item.name === name)
        const include =
          !toolsOnly && server?.enabled && server.hasResources && server.exposure !== 'hidden'
            ? (['tools', 'resources', 'resource-templates'] as const)
            : (['tools'] as const)
        set({ detailsLoading: true, detailsError: undefined })
        try {
          const result = await browser.client.getMcpDetails({
            target,
            expectedRuntimeId: runtimeId,
            server: name,
            include,
          })
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            current.snapshot?.runtime?.runtimeId !== runtimeId ||
            epoch !== detailsRequest
          ) {
            return
          }
          if (result.status === 'ok') {
            set({ details: result.details, selected: name, detailsError: undefined })
            return
          }
          set({ details: undefined, detailsError: result.message })
          if (result.status === 'stale' || result.status === 'busy') void get().refreshLive()
        } catch {
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            epoch !== detailsRequest
          ) {
            return
          }
          set({ detailsError: '读取工具与资源目录失败；未显示服务器原始错误。' })
        } finally {
          const current = get()
          if (
            !current.disposed &&
            current.open &&
            current.targetEpoch === panel &&
            current.targetKey === targetKey &&
            epoch === detailsRequest
          ) {
            set({ detailsLoading: false })
          }
        }
      },

      manage: async (row, action) => {
        const state = get()
        const target = state.target
        const runtimeId = state.snapshot?.runtime?.runtimeId
        if (state.disposed || !state.open || !target || !runtimeId || !row.live || state.busy) {
          return
        }
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++manageRequest
        set({ busy: `manage:${row.name}:${action.type}`, notice: undefined, error: undefined })
        try {
          const result = await browser.client.manageMcp({
            target,
            expectedRuntimeId: runtimeId,
            server: row.name,
            expectedIdentity: row.identity,
            action,
          })
          const current = get()
          if (current.disposed || request !== manageRequest) return
          if (!current.open || current.targetEpoch !== panel || current.targetKey !== targetKey) {
            return
          }
          if (result.status === 'applied') {
            applyLiveSnapshot(result.snapshot)
            set({ notice: `已更新 ${row.name}` })
            if (get().selected === row.name) {
              await get().loadDetails(row.name, true)
            }
            return
          }
          set({ notice: result.message })
          // busy/stale 不自动重试原写操作；只刷新权威快照，保留配置草稿。
          if (result.status === 'busy' || result.status === 'stale') await get().refreshLive()
        } catch {
          const current = get()
          if (current.disposed || request !== manageRequest) return
          if (current.targetKey === targetKey) {
            set({ notice: 'MCP 管理操作失败；请检查宿主连接后重试。' })
          }
        } finally {
          const current = get()
          if (!current.disposed && request === manageRequest) set({ busy: undefined })
        }
      },

      startAuth: async (kind, row) => {
        const state = get()
        const target = state.target
        const runtimeId = state.snapshot?.runtime?.runtimeId
        if (state.disposed || !state.open || !target || !runtimeId || !row.live || state.busy) {
          return
        }
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++authRequest
        set({ busy: `${kind}:${row.name}`, notice: undefined, error: undefined })
        try {
          const input = {
            target,
            expectedRuntimeId: runtimeId,
            server: row.name,
            expectedIdentity: row.identity,
          }
          const result =
            kind === 'login'
              ? await browser.client.startMcpLogin(input)
              : await browser.client.logoutMcp(input)
          const current = get()
          if (current.disposed) return
          // 面板关闭后仍要发现后台操作；认证快照始终来自 serviceStore。
          void browser.refreshMcpAuth()
          if (request !== authRequest) return
          const samePanel =
            current.open && current.targetEpoch === panel && current.targetKey === targetKey
          if (!samePanel) return
          if (result.status === 'started') {
            set({
              tab: 'auth',
              notice: kind === 'login' ? '已开始 MCP 登录。' : '已开始 MCP 退出登录流程。',
            })
          } else if (result.status === 'busy') {
            set({ notice: result.message ?? 'MCP 认证操作正忙；请等待当前操作结束。' })
          } else if (result.status === 'stale') {
            set({ notice: result.message })
            await get().refreshLive()
          } else {
            set({ notice: result.message })
          }
        } catch {
          const current = get()
          if (current.disposed || request !== authRequest) return
          if (current.targetKey === targetKey) {
            set({ notice: '启动 MCP 认证操作失败；请检查宿主连接后重试。' })
          }
        } finally {
          const current = get()
          if (!current.disposed && request === authRequest) set({ busy: undefined })
        }
      },

      setAnswer: (operationId, promptId, value) => {
        const state = get()
        if (state.disposed) return
        set({
          answers: { ...state.answers, [answerKey(operationId, promptId)]: value },
          notice: undefined,
        })
      },

      submitPrompt: async (operation, prompt) => {
        const state = get()
        if (state.disposed || state.submitting) return
        const key = answerKey(operation.id, prompt.promptId)
        const value = state.answers[key] ?? ''
        const answers = { ...state.answers }
        delete answers[key]
        const panel = state.targetEpoch
        const request = ++authRequest
        // 先清空本地回填再请求；错误提示不回显提交值。
        set({ answers, submitting: key, notice: undefined })
        try {
          const result = await browser.client.respondMcpAuth({
            operationId: operation.id,
            promptId: prompt.promptId,
            value,
          })
          const current = get()
          if (current.disposed) return
          void browser.refreshMcpAuth()
          if (request !== authRequest) return
          if (current.open && current.targetEpoch === panel) {
            if (result.status === 'stale') {
              set({ notice: '该 MCP 认证提示已失效，请查看最新状态。' })
            } else if (result.status === 'invalid') {
              set({ notice: result.message })
            }
          }
        } catch {
          const current = get()
          if (current.disposed || request !== authRequest) return
          if (current.open && current.targetEpoch === panel) {
            set({ notice: '提交 MCP 认证输入失败；请检查宿主连接后重试。' })
          }
        } finally {
          const current = get()
          if (!current.disposed && request === authRequest) set({ submitting: undefined })
        }
      },

      cancelAuth: async (operationId) => {
        const state = get()
        if (state.disposed || state.cancelling[operationId]) return
        const panel = state.targetEpoch
        const request = ++authRequest
        set({
          cancelling: { ...state.cancelling, [operationId]: true },
          notice: undefined,
        })
        try {
          const result: HarnessMcpAuthCancelResult = await browser.client.cancelMcpAuth(operationId)
          const current = get()
          if (current.disposed) return
          void browser.refreshMcpAuth()
          if (request !== authRequest) return
          if (current.open && current.targetEpoch === panel) {
            set({
              notice:
                result.status === 'not-found'
                  ? '该 MCP 认证操作已不存在。'
                  : result.status === 'finished'
                    ? '该 MCP 认证操作已经结束，取消未生效。'
                    : '正在取消 MCP 认证操作…',
            })
          }
        } catch {
          const current = get()
          if (current.disposed || request !== authRequest) return
          if (current.open && current.targetEpoch === panel) {
            set({ notice: '取消 MCP 认证失败，请检查宿主连接。' })
          }
        } finally {
          const current = get()
          if (!current.disposed && request === authRequest) {
            const cancelling = { ...current.cancelling }
            delete cancelling[operationId]
            set({ cancelling })
          }
        }
      },

      clearNotice: () => {
        if (get().disposed) return
        set({ notice: undefined, error: undefined })
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
        targetRequest += 1
        configRequest += 1
        saveRequest += 1
        manageRequest += 1
        detailsRequest += 1
        authRequest += 1
        try {
          browser.setMcpAuthPanelOpen(false)
        } catch {
          // 实例已在释放中；这里只保证本 store 不再持有工作。
        }
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: undefined,
          snapshot: undefined,
          configSnapshot: undefined,
          drafts: {},
          notice: undefined,
          error: undefined,
          targetError: undefined,
          targetLoading: false,
          configLoading: false,
          busy: undefined,
          selected: undefined,
          details: undefined,
          detailsError: undefined,
          detailsLoading: false,
          answers: {},
          submitting: undefined,
          cancelling: {},
          editor: undefined,
          editorError: undefined,
          deleteName: undefined,
          rereadConfirm: false,
          seed: undefined,
          disposed: true,
        })
      },
    }
  })

  // 只监听公共 serviceStore 的安全认证快照，用于清理过期短期回填；
  // 不复制快照、不发起第二套轮询。
  const pruneAuthState = (snapshot: HarnessMcpAuthSnapshot | undefined): void => {
    const state = store.getState()
    if (state.disposed) return
    const prompts = activePromptKeys(snapshot)
    const active = activeOperationIds(snapshot)
    const answers = Object.fromEntries(
      Object.entries(state.answers).filter(([key]) => prompts.has(key)),
    )
    const cancelling = Object.fromEntries(
      Object.entries(state.cancelling).filter(([operationId]) => active.has(operationId)),
    )
    const submitting =
      state.submitting !== undefined && prompts.has(state.submitting) ? state.submitting : undefined
    store.setState({ answers, cancelling, submitting })
  }

  pruneAuthState(browser.serviceStore.getState().mcpAuth)
  const unsubscribe = browser.serviceStore.subscribe((state, previous) => {
    if (state.mcpAuth === previous.mcpAuth) return
    pruneAuthState(state.mcpAuth)
  })
  const originalDispose = store.getState().dispose
  store.setState({
    dispose: () => {
      unsubscribe()
      originalDispose()
    },
  })

  return store
}

/** 保存结果中非 saved/invalid 的可读文案；不携带配置原文。 */
const saveResultText = (
  result: Exclude<HarnessMcpConfigSaveResult, { status: 'saved' } | { status: 'invalid' }>,
): string => result.message
