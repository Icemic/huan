/**
 * Composer feature Zustand 状态：内置 slash/Shell 路由、补全、长输入、历史、
 * 队列取回入口与提交提示。
 *
 * 输入文字、附件与选择只来自公共 windowStore；本 store 不复制草稿，也不保存
 * 服务端队列。真正的创建/发送/停止/取回由 `browser.sessionActions` 完成，
 * 本层只做应用命令解析与输入交互状态。
 */

import type {
  HarnessCommandArgumentCompletion,
  HarnessCommandCatalog,
  HarnessFileReference,
  HarnessModelInfo,
  HarnessThinkingLevel,
} from '@huan/protocol'
import { parseLeadingSlashCommand } from '@huan/protocol'
import {
  draftIdOf,
  type HarnessBrowser,
  type HarnessDraftTarget,
  projectHarnessMessages,
  selectThreadIsRunning,
  selectThreadRunStatus,
} from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  type AppCommand,
  commandSourceLabel,
  commandStageLabel,
  findAppCommand,
  mergeCommandCatalog,
} from '../components/pi-builtin-commands'
import type { AuthFeatureState } from './auth-store'
import type { McpFeatureState } from './mcp-store'
import type { ModelFeatureState } from './model-store'
import type { RuntimeFeatureState } from './runtime-store'
import type { SessionsFeatureState } from './sessions-store'
import type { SettingsFeatureState, SettingsTarget } from './settings-store'
import type { WorkspaceFeatureState } from './workspace-store'

const THINKING_LEVELS: readonly HarnessThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** 补全种类：命令名、命令参数、文件引用。 */
export type ComposerCompletionKind = 'command' | 'argument' | 'file'

/** 一条补全项。 */
export interface ComposerCompletionItem {
  key: string
  label: string
  description?: string
  meta?: string
  insertText: string
  replaceStart: number
  replaceEnd: number
  command?: AppCommand
  file?: HarnessFileReference
}

/** 当前补全菜单。 */
export interface ComposerCompletionState {
  kind: ComposerCompletionKind
  items: readonly ComposerCompletionItem[]
  index: number
}

/** 长输入编辑状态；打开时固定草稿版本。 */
export interface ComposerLongInputState {
  text: string
  draftId: string
  draftRevision: number
  conflict: string | undefined
}

/** 历史浏览状态。 */
export interface ComposerHistoryBrowseState {
  cursor: number
  draft: string
  last: string
}

/** 草稿版本已变化时保留的取回队列入口。 */
export interface ComposerRecoveredQueueState {
  threadId: string
  draftId: string
  draftRevision: number
  steering: readonly string[]
  followUp: readonly string[]
  message: string | undefined
}

/** Composer feature 状态。 */
export interface ComposerFeatureState {
  catalog: readonly AppCommand[]
  catalogDiagnostics: readonly string[]
  catalogLoading: boolean
  catalogError: string | undefined
  notice: string | undefined
  busy: string | undefined
  completion: ComposerCompletionState | undefined
  paletteOpen: boolean
  queueMode: 'followUp' | 'steer'
  longInput: ComposerLongInputState | undefined
  historyBrowse: ComposerHistoryBrowseState | undefined
  recoveredQueue: ComposerRecoveredQueueState | undefined
  disposed: boolean

  refreshCatalog: () => Promise<void>
  onSelectionChanged: () => void
  setNotice: (notice: string | undefined) => void
  clearNotice: () => void
  setQueueMode: (mode: 'followUp' | 'steer') => void

  submit: (options?: { steer?: boolean }) => Promise<void>
  retrieveQueue: () => Promise<void>
  restoreRecoveredQueue: () => boolean
  dismissRecoveredQueue: () => void

  onInputChange: (value: string, caret: number) => void
  onInputSelect: (value: string, caret: number) => void
  refreshCompletion: (value: string, caret: number) => Promise<void>
  setCompletionIndex: (index: number) => void
  chooseCompletion: (item?: ComposerCompletionItem) => number | undefined
  clearCompletion: () => void
  openPalette: () => void
  closePalette: () => void
  insertCommandFromPalette: (command: AppCommand, caret?: number) => number | undefined
  insertMention: (caret?: number) => number | undefined

  openLongInput: () => void
  setLongInputText: (text: string) => void
  applyLongInput: () => boolean
  closeLongInput: () => void

  historyUp: (value: string) => number | undefined
  historyDown: () => number | undefined
  resetHistoryBrowse: () => void

  dispose: () => void
}

export interface CreateComposerFeatureStoreOptions {
  browser: HarnessBrowser
  workspaceStore: StoreApi<WorkspaceFeatureState>
  sessionsStore: StoreApi<SessionsFeatureState>
  settingsStore: StoreApi<SettingsFeatureState>
  authStore: StoreApi<AuthFeatureState>
  mcpStore: StoreApi<McpFeatureState>
  runtimeStore: StoreApi<RuntimeFeatureState>
  modelStore: StoreApi<ModelFeatureState>
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const commandMatches = (command: AppCommand, prefix: string): boolean => {
  const needle = prefix.trim().toLowerCase()
  if (!needle) return true
  return (
    command.name.toLowerCase().includes(needle) ||
    (command.description ?? '').toLowerCase().includes(needle)
  )
}

/** 名称匹配优先于描述匹配，避免短前缀被描述里的词抢先选中。 */
const commandMatchRank = (command: AppCommand, prefix: string): number => {
  const needle = prefix.trim().toLowerCase()
  const name = command.name.toLowerCase()
  if (!needle) return 0
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  return 3
}

const commandItems = (
  commands: readonly AppCommand[],
  prefix: string,
  replaceStart: number,
  replaceEnd: number,
): ComposerCompletionItem[] =>
  commands
    .filter((command) => commandMatches(command, prefix))
    .sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1
      const rank = commandMatchRank(left, prefix) - commandMatchRank(right, prefix)
      if (rank !== 0) return rank
      return left.name.localeCompare(right.name)
    })
    .slice(0, 40)
    .map((command) => ({
      key: `command:${command.source}:${command.name}`,
      label: `/${command.name}`,
      ...(command.description ? { description: command.description } : {}),
      meta: [commandSourceLabel(command.source), commandStageLabel(command.stage)]
        .filter(Boolean)
        .join(' · '),
      insertText: `/${command.name} `,
      replaceStart,
      replaceEnd,
      command,
    }))

/** 找到光标前的 @ 提及起点；要求 @ 在开头或前面是空白。 */
const mentionToken = (
  text: string,
  caret: number,
): { start: number; query: string } | undefined => {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return undefined
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return undefined
  const query = before.slice(at + 1)
  if (query.includes('\n')) return undefined
  return { start: at, query }
}

export const createComposerFeatureStore = (
  options: CreateComposerFeatureStoreOptions,
): StoreApi<ComposerFeatureState> => {
  const {
    browser,
    workspaceStore,
    sessionsStore,
    settingsStore,
    authStore,
    mcpStore,
    runtimeStore,
    modelStore,
  } = options
  const client = browser.client
  let catalogEpoch = 0
  let completionEpoch = 0
  let completionDraftId: string | undefined
  let completionTimer: ReturnType<typeof setTimeout> | undefined
  let fileAbort: AbortController | undefined

  const selectionTarget = (): HarnessDraftTarget | undefined =>
    browser.windowStore.getState().selection

  const targetKeyOf = (target: HarnessDraftTarget | undefined): string =>
    JSON.stringify(
      target === undefined
        ? null
        : target.kind === 'thread'
          ? ['thread', target.threadId]
          : ['new', target.workspaceId ?? null, target.startProjectPath],
    )

  const currentDraft = () => {
    const state = browser.windowStore.getState()
    const target = state.selection
    if (!target) return undefined
    const draftId = draftIdOf(target)
    return { target, draftId, draft: state.draftsById[draftId] }
  }

  const currentThreadId = (): string | undefined => {
    const target = selectionTarget()
    return target?.kind === 'thread' ? target.threadId : undefined
  }

  const currentWorkspacePath = (): string | undefined => {
    const target = selectionTarget()
    if (!target) return browser.serviceStore.getState().host?.workspacePath
    if (target.kind === 'new') return target.startProjectPath
    return (
      browser.serviceStore.getState().threadsById[target.threadId]?.workspacePath ??
      browser.serviceStore.getState().host?.workspacePath
    )
  }

  const currentWorkspaceId = (): string | undefined => {
    const target = selectionTarget()
    if (!target) return undefined
    if (target.kind === 'new') return target.workspaceId
    return browser.serviceStore.getState().threadsById[target.threadId]?.workspaceId
  }

  /** 设置/重载命令的固定目标：当前会话，或当前工作区起始项目。 */
  const settingsTargetNow = (): SettingsTarget | undefined => {
    const target = selectionTarget()
    if (target?.kind === 'thread') return { threadId: target.threadId }
    if (target?.kind === 'new') return { workspacePath: target.startProjectPath }
    const workspaceId = workspaceStore.getState().activeWorkspaceId
    const workspacePath = workspaceId
      ? workspaceStore.getState().startProjectFor(workspaceId)
      : browser.serviceStore.getState().host?.workspacePath
    return workspacePath ? { workspacePath } : undefined
  }

  /** 从权威消息投影取最后一条助手文本；只读，不启动新请求。 */
  const copyLastReply = async (): Promise<boolean> => {
    const threadId = currentThreadId()
    if (!threadId) {
      setIfAlive((current) => ({ ...current, notice: '当前还没有可复制的助手回复。' }))
      return false
    }
    const service = browser.serviceStore.getState()
    await service.loadThread(threadId).catch(() => undefined)
    const metadata = browser.serviceStore.getState().threadsById[threadId]
    const session = browser.serviceStore.getState().sessionDataById[threadId]
    if (!session) {
      setIfAlive((current) => ({ ...current, notice: '会话内容尚未加载；请稍后重试。' }))
      return false
    }
    const views = projectHarnessMessages({
      messages: session.messages,
      messageEntryIds: session.messageEntryIds,
      toolExecutions: session.toolExecutions,
      runStatus: selectThreadRunStatus(metadata ?? { id: threadId, status: 'idle' }),
    })
    const lastAssistant = [...views].reverse().find((view) => view.role === 'assistant')
    const text = (lastAssistant?.parts ?? [])
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n\n')
      .trim()
    if (!text) {
      setIfAlive((current) => ({ ...current, notice: '没有可复制的助手回复。' }))
      return false
    }
    try {
      await navigator.clipboard.writeText(text)
      setIfAlive((current) => ({ ...current, notice: '已复制最后一条助手回复。' }))
      return true
    } catch (error) {
      setIfAlive((current) => ({ ...current, notice: `复制失败：${errorText(error)}` }))
      return false
    }
  }

  /**
   * `/login` 与 `/logout` 打开同一认证面板；带参数时先按权威 provider 快照
   * 验证。未知 ID 只作提示，不发送给模型。
   */
  const runProviderAuthCommand = async (
    mode: 'login' | 'logout',
    args: string,
  ): Promise<boolean> => {
    const providerId = args.trim()
    if (providerId) {
      let snapshot = browser.serviceStore.getState().providerAuth
      if (!snapshot) {
        await browser.serviceStore
          .getState()
          .refreshProviderAuth()
          .catch(() => undefined)
        snapshot = browser.serviceStore.getState().providerAuth
      }
      if (snapshot && !snapshot.providers.some((item) => item.providerId === providerId)) {
        setIfAlive((current) => ({
          ...current,
          notice: `未知 provider：${providerId}。该 ID 不会发送给模型。`,
        }))
        return false
      }
    }
    await authStore.getState().openPanel({
      mode,
      ...(providerId ? { providerId } : {}),
    })
    return true
  }

  const runSettingsCommand = async (): Promise<boolean> => {
    await settingsStore.getState().openPanel(settingsTargetNow())
    return true
  }

  const runReloadCommand = async (): Promise<boolean> => {
    const target = settingsTargetNow()
    if (!target) {
      setIfAlive((current) => ({ ...current, notice: '当前没有可重载的会话或起始目录。' }))
      return false
    }
    const outcome = await settingsStore.getState().reloadTarget(target)
    setIfAlive((current) => ({ ...current, notice: outcome.message }))
    return outcome.status === 'reloaded'
  }

  const loadModels = async (): Promise<readonly HarnessModelInfo[] | undefined> => {
    const target = selectionTarget()
    if (!target) return undefined
    const workspacePath = currentWorkspacePath()
    if (!workspacePath) return undefined
    return browser.serviceStore
      .getState()
      .loadModelCatalog({
        workspacePath,
        ...(target.kind === 'thread' ? { threadId: target.threadId } : {}),
      })
      .catch(() => undefined)
  }

  const loadCatalog = async (): Promise<void> => {
    const target = selectionTarget()
    const targetKey = targetKeyOf(target)
    if (target === undefined) {
      catalogEpoch += 1
      setIfAlive((current) => ({
        ...current,
        catalog: mergeCommandCatalog(undefined),
        catalogDiagnostics: [],
        catalogLoading: false,
        catalogError: undefined,
      }))
      return
    }
    const threadId = target.kind === 'thread' ? target.threadId : undefined
    const workspacePath = target.kind === 'new' ? target.startProjectPath : currentWorkspacePath()
    const input = threadId ? { threadId } : workspacePath ? { workspacePath } : undefined
    const epoch = ++catalogEpoch
    if (!input) {
      setIfAlive((current) => ({
        ...current,
        catalog: mergeCommandCatalog(undefined),
        catalogDiagnostics: [],
        catalogLoading: false,
        catalogError: undefined,
      }))
      return
    }
    setIfAlive((current) => ({ ...current, catalogLoading: true, catalogError: undefined }))
    try {
      const catalog: HarnessCommandCatalog = await client.listCommands(input)
      if (epoch !== catalogEpoch || targetKeyOf(selectionTarget()) !== targetKey) return
      setIfAlive((current) => ({
        ...current,
        catalog: mergeCommandCatalog(catalog),
        catalogDiagnostics: catalog.diagnostics,
        catalogLoading: false,
        catalogError: undefined,
      }))
    } catch (error) {
      if (epoch !== catalogEpoch || targetKeyOf(selectionTarget()) !== targetKey) return
      // 失败保留内置索引；不使用前目标的资源目录。
      setIfAlive((current) => ({
        ...current,
        catalog: mergeCommandCatalog(undefined),
        catalogDiagnostics: [],
        catalogLoading: false,
        catalogError: errorText(error),
      }))
    }
  }

  let storeRef: StoreApi<ComposerFeatureState> | undefined

  const setIfAlive = (updater: (state: ComposerFeatureState) => ComposerFeatureState) => {
    const store = storeRef
    if (!store) return
    const state = store.getState()
    if (state.disposed) return
    store.setState(updater(state))
  }

  /** 命令参数的本地补全：模型目录与 Thinking 级别。 */
  const buildLocalArgumentItems = async (
    command: AppCommand,
    prefix: string,
    replaceStart: number,
    replaceEnd: number,
  ): Promise<ComposerCompletionItem[]> => {
    if (command.source !== 'builtin') return []
    if (command.name === 'model') {
      const models = await loadModels()
      return (models ?? [])
        .filter((model) => {
          const key = `${model.provider}/${model.modelId}`
          return !prefix || key.toLowerCase().includes(prefix.toLowerCase())
        })
        .slice(0, 40)
        .map((model) => ({
          key: `model:${model.provider}/${model.modelId}`,
          label: `${model.provider}/${model.modelId}`,
          ...(model.name ? { description: model.name } : {}),
          insertText: `${model.provider}/${model.modelId}`,
          replaceStart,
          replaceEnd,
        }))
    }
    if (command.name === 'thinking') {
      const threadId = currentThreadId()
      const metadata = threadId ? browser.serviceStore.getState().threadsById[threadId] : undefined
      const current = currentDraft()
      const provider = metadata?.config?.provider ?? current?.draft?.model?.provider
      const modelId = metadata?.config?.modelId ?? current?.draft?.model?.modelId
      const models = provider && modelId ? await loadModels() : undefined
      const info =
        provider && modelId
          ? models?.find((model) => model.provider === provider && model.modelId === modelId)
          : undefined
      const levels =
        info?.availableThinkingLevels && info.availableThinkingLevels.length > 0
          ? info.availableThinkingLevels
          : THINKING_LEVELS
      return levels
        .filter((level) => level.startsWith(prefix))
        .map((level) => ({
          key: `thinking:${level}`,
          label: level,
          insertText: level,
          replaceStart,
          replaceEnd,
        }))
    }
    return []
  }

  const showSubmitOutcome = (
    outcome: Awaited<ReturnType<HarnessBrowser['sessionActions']['submit']>>,
  ) => {
    if (!outcome) return
    if (outcome.status === 'accepted' || outcome.status === 'handled') {
      setIfAlive((current) => ({ ...current, notice: undefined }))
      return
    }
    const message =
      outcome.message ??
      (outcome.status === 'cancelled'
        ? '提交已取消，输入已保留。'
        : outcome.status === 'unknown'
          ? '提交结果未知，已重新同步服务端；请确认后再决定是否发送。'
          : '提交未完成，输入已保留。')
    setIfAlive((current) => ({ ...current, notice: message }))
  }

  const submitToSession = async (
    mode: 'prompt' | 'steer' | 'followUp' | 'bash' | 'bashExcluded',
    content?: string,
  ) => {
    const current = currentDraft()
    if (!current?.draft) return
    const outcome = await browser.sessionActions.submit({
      mode,
      draftId: current.draftId,
      ...(content !== undefined ? { content } : {}),
    })
    showSubmitOutcome(outcome)
  }

  const runNameCommand = async (args: string): Promise<boolean> => {
    const threadId = currentThreadId()
    if (!threadId) {
      setIfAlive((current) => ({
        ...current,
        notice: '当前还没有后端会话；先发送普通消息或新建会话后再命名。',
      }))
      return false
    }
    const name = args.trim()
    if (!name) {
      setIfAlive((current) => ({
        ...current,
        notice: '用法：/name <名称>',
      }))
      return false
    }
    try {
      await client.renameThread(threadId, name)
      await browser.serviceStore.getState().refreshThreads()
      setIfAlive((current) => ({ ...current, notice: `会话已命名为“${name}”。` }))
      return true
    } catch (error) {
      setIfAlive((current) => ({ ...current, notice: errorText(error) }))
      return false
    }
  }

  const runModelCommand = async (args: string): Promise<boolean> => {
    const models = await loadModels()
    const needle = args.trim().toLowerCase()
    if (!needle) {
      const opened = await modelStore.getState().openPanel({ focus: 'model' })
      if (!opened) {
        setIfAlive((current) => ({ ...current, notice: '当前没有可选择的会话或起始目录。' }))
        return false
      }
      return true
    }
    const exact = models?.find(
      (model) => `${model.provider}/${model.modelId}`.toLowerCase() === needle,
    )
    const matches =
      exact !== undefined
        ? [exact]
        : (models ?? []).filter(
            (model) =>
              model.modelId.toLowerCase() === needle ||
              model.name?.toLowerCase() === needle ||
              model.modelId.toLowerCase().includes(needle) ||
              model.name?.toLowerCase().includes(needle),
          )
    if (matches.length !== 1) {
      setIfAlive((current) => ({
        ...current,
        notice:
          matches.length === 0
            ? `没有匹配的模型：${args}`
            : `匹配到多个模型，请使用 provider/modelId：${matches
                .map((model) => `${model.provider}/${model.modelId}`)
                .join('、')}`,
      }))
      return false
    }
    const target = matches[0]
    if (!target) return false
    const current = currentDraft()
    if (!current?.draft) return false
    if (current.target.kind === 'new') {
      browser.windowStore
        .getState()
        .setDraftModel(current.draftId, { provider: target.provider, modelId: target.modelId })
      // 命令本身修改了草稿模型版本；这里同步消费命令文本，保留模型选择。
      browser.windowStore.getState().editDraftText(current.draftId, '')
      setIfAlive((store) => ({
        ...store,
        notice: `新会话将使用 ${target.provider}/${target.modelId}。`,
      }))
      return true
    }
    try {
      await browser.sessionActions.setModel(current.target.threadId, {
        provider: target.provider,
        modelId: target.modelId,
      })
      setIfAlive((store) => ({
        ...store,
        notice: `已切换模型：${target.provider}/${target.modelId}。`,
      }))
      return true
    } catch (error) {
      setIfAlive((store) => ({ ...store, notice: errorText(error) }))
      return false
    }
  }

  const runThinkingCommand = async (args: string): Promise<boolean> => {
    const raw = args.trim()
    if (!raw) {
      const opened = await modelStore.getState().openPanel({ focus: 'thinking' })
      if (!opened) {
        setIfAlive((current) => ({ ...current, notice: '当前没有可选择的会话或起始目录。' }))
        return false
      }
      return true
    }
    const level = raw as HarnessThinkingLevel
    if (!THINKING_LEVELS.includes(level)) {
      setIfAlive((current) => ({
        ...current,
        notice: `未知 Thinking 级别：${args}。可用级别：${THINKING_LEVELS.join('、')}`,
      }))
      return false
    }
    const current = currentDraft()
    if (!current?.draft) return false
    if (current.target.kind === 'new') {
      if (!current.draft.model) {
        setIfAlive((store) => ({
          ...store,
          notice: '请先选择模型，再设置 Thinking 级别。',
        }))
        return false
      }
      browser.windowStore.getState().setDraftThinkingLevel(current.draftId, level)
      browser.windowStore.getState().editDraftText(current.draftId, '')
      setIfAlive((store) => ({ ...store, notice: `新会话 Thinking 级别：${level}。` }))
      return true
    }
    try {
      await browser.sessionActions.setThinkingLevel(current.target.threadId, level)
      setIfAlive((store) => ({ ...store, notice: `Thinking 级别已设置为 ${level}。` }))
      return true
    } catch (error) {
      setIfAlive((store) => ({ ...store, notice: errorText(error) }))
      return false
    }
  }

  const runBuiltinCommand = async (command: AppCommand, args: string): Promise<boolean> => {
    if (!command.available) {
      setIfAlive((current) => ({
        ...current,
        notice: command.availability ?? `/${command.name} 尚无 GUI 入口。`,
      }))
      return false
    }
    switch (command.name) {
      case 'model':
        return runModelCommand(args)
      case 'thinking':
        return runThinkingCommand(args)
      case 'name':
        return runNameCommand(args)
      case 'new': {
        const workspaceId = workspaceStore.getState().activeWorkspaceId
        if (!workspaceId) {
          setIfAlive((current) => ({ ...current, notice: '当前没有可用的工作区。' }))
          return false
        }
        // 新会话先打开预检表单，不跳过路径/信任检查直接写入目标。
        workspaceStore.getState().openNewSession(workspaceId)
        return true
      }
      case 'session': {
        const threadId = currentThreadId()
        if (!threadId) {
          setIfAlive((current) => ({ ...current, notice: '当前还没有后端会话。' }))
          return false
        }
        await sessionsStore.getState().openDetails(threadId)
        return true
      }
      case 'tree':
      case 'fork': {
        const threadId = currentThreadId()
        if (!threadId) {
          setIfAlive((current) => ({
            ...current,
            notice: '先建立或打开会话后才能使用会话树。',
          }))
          return false
        }
        sessionsStore.getState().openTree(threadId)
        return true
      }
      case 'clone': {
        const threadId = currentThreadId()
        if (!threadId) {
          setIfAlive((current) => ({
            ...current,
            notice: '先建立会话后才能克隆。',
          }))
          return false
        }
        // clone 与 fork 共用确认表单；不在命令处理器里直接创建子会话。
        sessionsStore.getState().openFork({ threadId, position: 'at' })
        return true
      }
      case 'import': {
        const workspaceId = currentWorkspaceId() ?? workspaceStore.getState().activeWorkspaceId
        sessionsStore.getState().openImport({
          ...(args.trim() ? { path: args.trim() } : {}),
          ...(workspaceId ? { workspaceId } : {}),
        })
        return true
      }
      case 'settings':
        return runSettingsCommand()
      case 'login':
        return runProviderAuthCommand('login', args)
      case 'logout':
        return runProviderAuthCommand('logout', args)
      case 'reload':
        return runReloadCommand()
      case 'copy':
        return copyLastReply()
      case 'trust': {
        const path = currentWorkspacePath()
        if (!path) {
          setIfAlive((current) => ({
            ...current,
            notice: '当前没有可管理的项目目录。',
          }))
          return false
        }
        await workspaceStore.getState().openTrust(path, { kind: 'standalone' })
        return true
      }
      case 'resume':
        setIfAlive((current) => ({
          ...current,
          notice: '请从左侧会话列表选择要恢复的会话；切换只影响当前窗口。',
        }))
        return true
      case 'compact':
        await runtimeStore.getState().openPanel({
          section: 'compact',
          ...(args.trim() ? { instructions: args.trim() } : {}),
        })
        return true
      case 'scoped-models':
        await runtimeStore.getState().openPanel({ section: 'scope' })
        return true
      case 'mcp': {
        const tokens = args.trim().split(/\s+/).filter(Boolean)
        const first = tokens[0]
        const mode =
          first === 'login' || first === 'logout' || first === 'reconnect' ? first : undefined
        if (mode) tokens.shift()
        const server = tokens[0]
        await mcpStore.getState().openPanel({
          ...(mode ? { mode } : {}),
          ...(server ? { server } : {}),
        })
        return true
      }
      default:
        setIfAlive((current) => ({
          ...current,
          notice: command.availability ?? `/${command.name} 尚无 GUI 入口。`,
        }))
        return false
    }
  }

  storeRef = createStore<ComposerFeatureState>()((set, get) => ({
    catalog: mergeCommandCatalog(undefined),
    catalogDiagnostics: [],
    catalogLoading: false,
    catalogError: undefined,
    notice: undefined,
    busy: undefined,
    completion: undefined,
    paletteOpen: false,
    queueMode: 'followUp' as const,
    longInput: undefined,
    historyBrowse: undefined,
    recoveredQueue: undefined,
    disposed: false,

    refreshCatalog: loadCatalog,

    onSelectionChanged: () => {
      const current = get()
      if (current.disposed) return
      completionEpoch += 1
      if (completionTimer) {
        clearTimeout(completionTimer)
        completionTimer = undefined
      }
      fileAbort?.abort()
      fileAbort = undefined
      set({
        completion: undefined,
        busy: undefined,
        notice: undefined,
        longInput: undefined,
        historyBrowse: undefined,
        recoveredQueue: undefined,
      })
      void get().refreshCatalog()
    },

    setNotice: (notice) => {
      if (get().disposed) return
      set({ notice })
    },

    clearNotice: () => {
      if (get().disposed) return
      set({ notice: undefined })
    },

    setQueueMode: (queueMode) => {
      if (get().disposed) return
      set({ queueMode })
    },

    submit: async (submitOptions) => {
      const state = get()
      if (state.disposed) return
      const current = currentDraft()
      if (!current?.draft) return
      const trimmed = current.draft.text.trim()
      const hasAttachments = current.draft.attachmentIds.length > 0
      if (!trimmed && !hasAttachments) return
      set({ notice: undefined })
      get().resetHistoryBrowse()

      const parsed = trimmed.startsWith('/') ? parseLeadingSlashCommand(trimmed) : undefined
      const command = parsed ? findAppCommand(get().catalog, parsed.name) : undefined
      const leadingShell = trimmed.startsWith('!')
      const builtin = parsed && command?.source === 'builtin' ? command : undefined
      if ((leadingShell || builtin) && hasAttachments) {
        set({ notice: '命令与 Shell 不能附带图片附件；请移除附件后重试。' })
        return
      }

      if (leadingShell) {
        const exclude = trimmed.startsWith('!!')
        const shellCommand = trimmed.slice(exclude ? 2 : 1).trim()
        if (!shellCommand) {
          set({ notice: 'Shell 命令不能为空。' })
          return
        }
        if (!currentThreadId()) {
          set({ notice: 'Shell 需要会话历史；请先发送普通消息或新建会话后再执行 !/!!。' })
          return
        }
        await submitToSession(exclude ? 'bashExcluded' : 'bash', shellCommand)
        return
      }

      if (builtin && parsed) {
        if (get().busy) return
        set({ busy: `command:${builtin.name}` })
        const revision = current.draft.revision
        try {
          const handled = await runBuiltinCommand(builtin, parsed.args)
          if (handled) {
            browser.windowStore.getState().setDraftTextIfRevision(current.draftId, revision, '')
          }
        } finally {
          if (!get().disposed) set({ busy: undefined })
        }
        return
      }

      const threadId = currentThreadId()
      const metadata = threadId ? browser.serviceStore.getState().threadsById[threadId] : undefined
      if (metadata?.compactionActive) {
        set({ notice: '上下文压缩进行中，输入已保留；完成后可再次发送。' })
        return
      }
      const running = metadata ? selectThreadIsRunning(metadata) : false
      const steer = submitOptions?.steer ?? get().queueMode === 'steer'
      await submitToSession(running ? (steer ? 'steer' : 'followUp') : 'prompt')
    },

    retrieveQueue: async () => {
      const threadId = currentThreadId()
      if (!threadId) {
        set({ notice: '当前没有可整体取回的会话队列。' })
        return
      }
      const current = currentDraft()
      if (!current?.draft) return
      const revision = current.draft.revision
      const result = await browser.sessionActions.recoverQueue(threadId)
      const parts = [...result.steering, ...result.followUp].filter((item) => item.trim())
      if (parts.length > 0) {
        const draft = browser.windowStore.getState().draftsById[current.draftId]
        if (draft?.revision === revision) {
          const next = [draft.text.trim(), ...parts].filter(Boolean).join('\n\n')
          browser.windowStore.getState().setDraftTextIfRevision(current.draftId, revision, next)
        } else {
          set({
            recoveredQueue: {
              threadId,
              draftId: current.draftId,
              draftRevision: revision,
              steering: result.steering,
              followUp: result.followUp,
              message: result.message,
            },
          })
        }
      }
      if (result.status === 'failed') {
        set({ notice: result.message ?? '队列取回失败，已重新同步服务端。' })
      }
    },

    restoreRecoveredQueue: () => {
      const state = get()
      if (state.disposed || !state.recoveredQueue) return false
      const recovered = state.recoveredQueue
      const draft = browser.windowStore.getState().draftsById[recovered.draftId]
      if (!draft || draft.revision !== recovered.draftRevision) return false
      const parts = [...recovered.steering, ...recovered.followUp].filter((item) => item.trim())
      const next = [draft.text.trim(), ...parts].filter(Boolean).join('\n\n')
      const applied = browser.windowStore
        .getState()
        .setDraftTextIfRevision(recovered.draftId, recovered.draftRevision, next)
      if (applied) set({ recoveredQueue: undefined })
      return applied
    },

    dismissRecoveredQueue: () => {
      if (get().disposed) return
      set({ recoveredQueue: undefined })
    },

    onInputChange: (value, caret) => {
      const state = get()
      if (state.disposed) return
      set({ notice: undefined })
      completionEpoch += 1
      fileAbort?.abort()
      fileAbort = undefined
      if (completionTimer) clearTimeout(completionTimer)
      set({ completion: undefined })
      const commandLine =
        value.startsWith('/') &&
        caret <= (value.search(/\s/) === -1 ? value.length : value.search(/\s/))
      const delay = commandLine ? 0 : 120
      completionTimer = setTimeout(() => {
        completionTimer = undefined
        void get().refreshCompletion(value, caret)
      }, delay)
    },

    onInputSelect: (value, caret) => {
      if (get().disposed) return
      void get().refreshCompletion(value, caret)
    },

    refreshCompletion: async (value, caret) => {
      if (get().disposed) return
      const draftId = currentDraft()?.draftId
      if (!draftId) {
        set({ completion: undefined })
        return
      }
      const epoch = ++completionEpoch
      const isCurrent = () =>
        !get().disposed && epoch === completionEpoch && currentDraft()?.draftId === draftId
      if (!value || caret < 0) {
        set({ completion: undefined })
        return
      }

      if (value.startsWith('/')) {
        const firstBreak = value.search(/\s/)
        if (firstBreak === -1 || caret <= firstBreak) {
          set({ completion: undefined })
          const prefix = value.slice(1, caret)
          const items = commandItems(
            get().catalog,
            prefix,
            0,
            firstBreak === -1 ? value.length : firstBreak,
          )
          if (items.length > 0) {
            completionDraftId = draftId
            set({ completion: { kind: 'command', items, index: 0 } })
          }
          return
        }
        const commandName = value.slice(1, firstBreak)
        const command = findAppCommand(get().catalog, commandName)
        if (command?.supportsArguments) {
          const argument = value.slice(firstBreak + 1, caret)
          if (argument.includes('\n')) {
            set({ completion: undefined })
            return
          }
          set({ completion: undefined })
          const local = await buildLocalArgumentItems(command, argument, firstBreak + 1, caret)
          if (!isCurrent()) return
          if (local.length > 0) {
            completionDraftId = draftId
            set({ completion: { kind: 'argument', items: local, index: 0 } })
            return
          }
          const threadId = currentThreadId()
          const workspacePath = currentWorkspacePath()
          const result = await client
            .getCommandArgumentCompletions({
              ...(threadId ? { threadId } : workspacePath ? { workspacePath } : {}),
              name: commandName,
              prefix: argument,
            })
            .catch(() => [])
          if (!isCurrent()) return
          const items: ComposerCompletionItem[] = result
            .slice(0, 40)
            .map((item: HarnessCommandArgumentCompletion) => ({
              key: `argument:${commandName}:${item.value}`,
              label: item.label,
              ...(item.description ? { description: item.description } : {}),
              insertText: item.value,
              replaceStart: firstBreak + 1,
              replaceEnd: caret,
            }))
          if (items.length > 0) {
            completionDraftId = draftId
            set({ completion: { kind: 'argument', items, index: 0 } })
          }
          return
        }
      }

      const token = mentionToken(value, caret)
      if (token) {
        set({ completion: undefined })
        const controller = new AbortController()
        fileAbort?.abort()
        fileAbort = controller
        const threadId = currentThreadId()
        const workspaceId = currentWorkspaceId()
        const workspacePath = currentWorkspacePath()
        const result = await client
          .searchFiles(
            {
              ...(threadId ? { threadId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              ...(!threadId && workspacePath ? { workspacePath } : {}),
              query: token.query,
              limit: 30,
            },
            { signal: controller.signal },
          )
          .catch(() => undefined)
        if (!isCurrent() || !result) return
        const items: ComposerCompletionItem[] = result.files.map((file) => ({
          key: `file:${file.path}`,
          label: file.reference,
          description: file.kind === 'directory' ? '目录' : file.relativePath,
          meta: file.alias ? `@${file.alias}` : (file.workspaceName ?? ''),
          insertText: `${
            /\s/.test(file.reference)
              ? `@${JSON.stringify(file.reference.replace(/^@/, ''))}`
              : file.reference.startsWith('@')
                ? file.reference
                : `@${file.reference}`
          } `,
          replaceStart: token.start,
          replaceEnd: caret,
          file,
        }))
        if (items.length > 0) {
          completionDraftId = draftId
          set({ completion: { kind: 'file', items, index: 0 } })
        }
        return
      }

      set({ completion: undefined })
    },

    setCompletionIndex: (index) => {
      const state = get()
      if (state.disposed || !state.completion) return
      const length = state.completion.items.length
      if (length === 0) return
      const normalized = ((index % length) + length) % length
      set({ completion: { ...state.completion, index: normalized } })
    },

    chooseCompletion: (item) => {
      const state = get()
      if (state.disposed) return undefined
      const current = currentDraft()
      if (!current?.draft) return undefined
      if (completionDraftId !== current.draftId) {
        get().clearCompletion()
        return undefined
      }
      const chosen = item ?? state.completion?.items[state.completion.index]
      if (!chosen) return undefined
      const next =
        current.draft.text.slice(0, chosen.replaceStart) +
        chosen.insertText +
        current.draft.text.slice(chosen.replaceEnd)
      browser.windowStore.getState().editDraftText(current.draftId, next)
      get().clearCompletion()
      return chosen.replaceStart + chosen.insertText.length
    },

    clearCompletion: () => {
      if (get().disposed) return
      completionEpoch += 1
      completionDraftId = undefined
      fileAbort?.abort()
      fileAbort = undefined
      if (completionTimer) {
        clearTimeout(completionTimer)
        completionTimer = undefined
      }
      set({ completion: undefined })
    },

    openPalette: () => {
      if (get().disposed) return
      get().clearCompletion()
      set({ paletteOpen: true })
    },

    closePalette: () => {
      if (get().disposed) return
      set({ paletteOpen: false })
    },

    insertCommandFromPalette: (command, caret) => {
      const state = get()
      if (state.disposed) return undefined
      const current = currentDraft()
      if (!current?.draft) return undefined
      const position = caret ?? current.draft.text.length
      const firstBreak = current.draft.text.search(/\s/)
      const canReplace =
        current.draft.text.startsWith('/') && (firstBreak === -1 || position <= firstBreak)
      const insert = `/${command.name} `
      const next = canReplace
        ? insert +
          current.draft.text
            .slice(firstBreak === -1 ? current.draft.text.length : firstBreak)
            .trimStart()
        : `${current.draft.text.slice(0, position)}${insert}${current.draft.text.slice(position)}`
      browser.windowStore.getState().editDraftText(current.draftId, next)
      set({ paletteOpen: false })
      get().clearCompletion()
      return canReplace ? insert.length : position + insert.length
    },

    insertMention: (caret) => {
      if (get().disposed) return undefined
      const current = currentDraft()
      if (!current?.draft) return undefined
      const position = Math.min(
        Math.max(caret ?? current.draft.text.length, 0),
        current.draft.text.length,
      )
      const next = `${current.draft.text.slice(0, position)}@${current.draft.text.slice(position)}`
      browser.windowStore.getState().editDraftText(current.draftId, next)
      void get().refreshCompletion(next, position + 1)
      return position + 1
    },

    openLongInput: () => {
      const state = get()
      if (state.disposed) return
      const current = currentDraft()
      if (!current?.draft) return
      set({
        longInput: {
          text: current.draft.text,
          draftId: current.draftId,
          draftRevision: current.draft.revision,
          conflict: undefined,
        },
      })
    },

    setLongInputText: (text) => {
      const state = get()
      if (state.disposed || !state.longInput) return
      set({ longInput: { ...state.longInput, text, conflict: undefined } })
    },

    applyLongInput: () => {
      const state = get()
      if (state.disposed || !state.longInput) return false
      const { draftId, draftRevision, text } = state.longInput
      const draft = browser.windowStore.getState().draftsById[draftId]
      if (!draft || draft.revision !== draftRevision) {
        set({
          longInput: {
            ...state.longInput,
            conflict: '输入已发生变化，长输入内容未覆盖新草稿。请复制后重新编辑。',
          },
        })
        return false
      }
      browser.windowStore.getState().editDraftText(draftId, text)
      set({ longInput: undefined })
      return true
    },

    closeLongInput: () => {
      if (get().disposed) return
      set({ longInput: undefined })
    },

    historyUp: (value) => {
      const state = get()
      if (state.disposed) return undefined
      const current = currentDraft()
      if (!current?.draft) return undefined
      const history = browser.windowStore.getState().inputHistory
      if (history.length === 0) return undefined
      const browse = state.historyBrowse
      if (!browse && value.trim() !== '') return undefined
      const next = browse ? browse.cursor + 1 : 0
      const entry = history[next]
      if (entry === undefined) return undefined
      set({
        historyBrowse: {
          cursor: next,
          draft: browse?.draft ?? value,
          last: entry,
        },
      })
      browser.windowStore.getState().editDraftText(current.draftId, entry)
      get().clearCompletion()
      return entry.length
    },

    historyDown: () => {
      const state = get()
      if (state.disposed || !state.historyBrowse) return undefined
      const current = currentDraft()
      if (!current?.draft) return undefined
      const next = state.historyBrowse.cursor - 1
      if (next < 0) {
        const draft = state.historyBrowse.draft
        set({ historyBrowse: undefined })
        browser.windowStore.getState().editDraftText(current.draftId, draft)
        get().clearCompletion()
        return draft.length
      }
      const entry = browser.windowStore.getState().inputHistory[next]
      if (entry === undefined) return undefined
      set({ historyBrowse: { ...state.historyBrowse, cursor: next, last: entry } })
      browser.windowStore.getState().editDraftText(current.draftId, entry)
      get().clearCompletion()
      return entry.length
    },

    resetHistoryBrowse: () => {
      if (get().disposed) return
      set({ historyBrowse: undefined })
    },

    dispose: () => {
      if (get().disposed) return
      completionEpoch += 1
      catalogEpoch += 1
      fileAbort?.abort()
      fileAbort = undefined
      if (completionTimer) {
        clearTimeout(completionTimer)
        completionTimer = undefined
      }
      set({
        disposed: true,
        catalog: mergeCommandCatalog(undefined),
        catalogDiagnostics: [],
        catalogLoading: false,
        catalogError: undefined,
        notice: undefined,
        busy: undefined,
        completion: undefined,
        paletteOpen: false,
        longInput: undefined,
        historyBrowse: undefined,
        recoveredQueue: undefined,
      })
    },
  }))
  return storeRef
}
