/**
 * 运行管理 feature Zustand 状态：用户 Shell、上下文压缩、模型目录/范围与自动压缩开关。
 *
 * 业务边界（见 R1 §5.2、R2 §7）：
 * - 面板打开时固定会话 target 与 panelEpoch；关闭后迟到结果只更新原对象事实，
 *   不写新面板，也不撤销已经发出的远端动作；
 * - Shell/压缩的运行结果始终来自服务端事件与权威快照，本 store 只保存表单、忙状态
 *   和受控提示；取消不伪装成成功；
 * - 模型范围以 patterns 原文为编辑源：读取时优先保留 `savedPatterns` 的 Thinking
 *   后缀，用户未编辑就不重写原文；解析后的 models 只用于展示与选择匹配；
 * - 模型目录统一从公共 serviceStore 按 target/resource/auth 版本读取，不在组件或
 *   feature store 复制一份 models 缓存。
 */

import type {
  HarnessBashStartResult,
  HarnessCompactionOutcome,
  HarnessModelScope,
  HarnessModelScopeUpdateResult,
} from '@huan/protocol'
import type { HarnessBrowser } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 运行面板分段；命令可指定打开位置。 */
export type RuntimeSection = 'shell' | 'compact' | 'scope'

/** 运行管理固定 target：已有会话或空白页起始目录。 */
export interface RuntimeTarget {
  threadId?: string
  workspacePath: string
}

/** 打开选项；target 省略时按当前窗口选择解析。 */
export interface RuntimeOpenOptions {
  target?: RuntimeTarget
  section?: RuntimeSection
  /** `/compact <instructions>` 带入的指令草稿。 */
  instructions?: string
}

/** 运行管理 feature 状态。 */
export interface RuntimeFeatureState {
  open: boolean
  /** 面板代次；打开/关闭/换目标推进，旧响应不得写回。 */
  targetEpoch: number
  target: RuntimeTarget | undefined
  targetKey: string
  section: RuntimeSection

  shellCommand: string
  shellExcludeFromContext: boolean
  compactInstructions: string

  /** 会话模型范围；只保存服务端返回的权威结构。 */
  scope: HarnessModelScope | undefined
  /** patterns 原文编辑源；Thinking 后缀按用户原文保留。 */
  patternsText: string
  /** 当前已保存的 patterns 原文基线。 */
  basePatternsText: string
  patternRevision: number
  scopeLoading: boolean
  saveAsDefault: boolean

  busy: string | undefined
  notice: string | undefined
  error: string | undefined
  scopeError: string | undefined
  disposed: boolean

  openPanel: (options?: RuntimeOpenOptions) => Promise<void>
  close: () => void
  setSection: (section: RuntimeSection) => void
  setShellCommand: (command: string) => void
  setShellExcludeFromContext: (exclude: boolean) => void
  setCompactInstructions: (instructions: string) => void
  setSaveAsDefault: (value: boolean) => void

  /** 从 serviceStore 读取当前目标的模型目录（不本地缓存）。 */
  loadCatalog: () => Promise<void>
  /** 显式刷新共享模型目录，不重建会话、不发起模型请求。 */
  refreshCatalog: () => Promise<void>
  /** 读取会话模型范围；保留 savedPatterns 原文。 */
  loadScope: () => Promise<void>
  updatePatternsText: (text: string) => void
  resetPatternsDraft: () => void
  /** 勾选/取消模型；只改命中该模型的那几行，保留其他 Thinking 后缀。 */
  toggleScopeModel: (
    model: { provider: string; modelId: string },
    allModels: readonly { provider: string; modelId: string }[],
  ) => void
  saveScope: () => Promise<void>

  runShell: () => Promise<void>
  abortShell: () => Promise<void>
  compact: () => Promise<void>
  abortCompaction: () => Promise<void>
  toggleAutoCompaction: () => Promise<void>
  clearNotice: () => void
  clearError: () => void
  dispose: () => void
}

export interface CreateRuntimeFeatureStoreOptions {
  browser: HarnessBrowser
  /** 空白页没有窗口选择时的起始目录来源；由组合根提供。 */
  fallbackWorkspacePath?: () => string | undefined
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 去掉模型模式的 Thinking 后缀；只用于匹配，不用于回写用户原文。 */
export const stripThinkingSuffix = (pattern: string): string => pattern.replace(THINKING_SUFFIX, '')

/** 单个 patterns 行是否匹配 `provider/modelId`；支持简单 `*` 通配。 */
export const patternMatchesModel = (pattern: string, modelKey: string): boolean => {
  const base = stripThinkingSuffix(pattern.trim())
  if (!base) return false
  if (base === modelKey) return true
  if (!base.includes('*')) return false
  return new RegExp(`^${base.split('*').map(escapeRegExp).join('.*')}$`).test(modelKey)
}

/** 读取范围时选择编辑原文：只在 savedPatterns 与当前会话范围精确对应时使用原始行。 */
export const scopePatternsTextOf = (scope: HarnessModelScope): string => scope.patterns.join('\n')

/** 按 patterns 原文推导目录中被选中的模型键；空 patterns 表示全部。 */
export const scopeModelKeysForPatterns = (
  patternsText: string,
  models: readonly { provider: string; modelId: string }[],
): string[] => {
  const patterns = patternsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (patterns.length === 0) return models.map((model) => `${model.provider}/${model.modelId}`)
  return models
    .filter((model) => {
      const key = `${model.provider}/${model.modelId}`
      return patterns.some((pattern) => patternMatchesModel(pattern, key))
    })
    .map((model) => `${model.provider}/${model.modelId}`)
}

const runtimeTargetKey = (target: RuntimeTarget | undefined): string => {
  if (!target) return 'none'
  if (target.threadId) return `t:${target.threadId}`
  return `w:${target.workspacePath}`
}

const compactionNoticeText = (outcome: HarnessCompactionOutcome): string => {
  switch (outcome.status) {
    case 'compacted':
      return `压缩完成（${outcome.tokensBefore ?? '?'} → ${outcome.estimatedTokensAfter ?? '?'} tokens）`
    case 'cancelled':
      return outcome.message ?? '压缩已取消，原始消息树保持不变。'
    case 'busy':
    case 'failed':
      return outcome.message
  }
}

const persistenceNotice = (result: HarnessModelScopeUpdateResult): string => {
  if (result.persistence === 'failed') {
    return result.message ?? '会话范围已生效，但用户默认保存失败。'
  }
  if (result.persistence === 'saved') return '会话范围已应用并保存为用户默认。'
  return '会话范围已应用到当前会话。'
}

export const createRuntimeFeatureStore = (
  options: CreateRuntimeFeatureStoreOptions,
): StoreApi<RuntimeFeatureState> => {
  const { browser } = options
  let panelEpoch = 0
  let catalogRequest = 0
  let scopeRequest = 0
  let actionRequest = 0

  const workspacePathForThread = (threadId: string): string =>
    browser.serviceStore.getState().threadsById[threadId]?.workspacePath ??
    browser.serviceStore.getState().host?.workspacePath ??
    ''

  const resolveTarget = (): RuntimeTarget | undefined => {
    const selection = browser.windowStore.getState().selection
    if (selection?.kind === 'thread') {
      return {
        threadId: selection.threadId,
        workspacePath: workspacePathForThread(selection.threadId),
      }
    }
    if (selection?.kind === 'new') return { workspacePath: selection.startProjectPath }
    const workspacePath =
      options.fallbackWorkspacePath?.() ?? browser.serviceStore.getState().host?.workspacePath
    return workspacePath ? { workspacePath } : undefined
  }

  return createStore<RuntimeFeatureState>()((set, get) => {
    const samePanel = (panel: number, targetKey: string): boolean => {
      const current = get()
      return current.open && current.targetEpoch === panel && current.targetKey === targetKey
    }

    const catalogQueryOf = (
      target: RuntimeTarget,
    ): { workspacePath: string; threadId?: string } => ({
      workspacePath: target.workspacePath,
      ...(target.threadId ? { threadId: target.threadId } : {}),
    })

    return {
      open: false,
      targetEpoch: 0,
      target: undefined,
      targetKey: 'none',
      section: 'shell',
      shellCommand: '',
      shellExcludeFromContext: false,
      compactInstructions: '',
      scope: undefined,
      patternsText: '',
      basePatternsText: '',
      patternRevision: 0,
      scopeLoading: false,
      saveAsDefault: false,
      busy: undefined,
      notice: undefined,
      error: undefined,
      scopeError: undefined,
      disposed: false,

      openPanel: async (openOptions) => {
        if (get().disposed) return
        const target = openOptions?.target ?? resolveTarget()
        const epoch = ++panelEpoch
        catalogRequest += 1
        scopeRequest += 1
        actionRequest += 1
        set({
          open: true,
          targetEpoch: epoch,
          target,
          targetKey: runtimeTargetKey(target),
          section: openOptions?.section ?? 'shell',
          shellCommand: '',
          shellExcludeFromContext: false,
          compactInstructions: openOptions?.instructions ?? '',
          scope: undefined,
          patternsText: '',
          basePatternsText: '',
          patternRevision: 0,
          scopeLoading: false,
          saveAsDefault: false,
          busy: undefined,
          notice: undefined,
          error: undefined,
          scopeError: undefined,
        })
        if (!target) {
          set({ notice: '当前没有可用的会话或起始目录；请先选择工作区/项目。' })
          return
        }
        await Promise.all([get().loadCatalog(), target.threadId ? get().loadScope() : undefined])
        if (!get().open || get().targetEpoch !== epoch) return
      },

      close: () => {
        if (get().disposed) return
        panelEpoch += 1
        catalogRequest += 1
        scopeRequest += 1
        actionRequest += 1
        // 关闭只失效本地请求/表单；远端 Shell、压缩与范围保存不被撤销。
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: 'none',
          shellCommand: '',
          shellExcludeFromContext: false,
          compactInstructions: '',
          scope: undefined,
          patternsText: '',
          basePatternsText: '',
          patternRevision: 0,
          scopeLoading: false,
          saveAsDefault: false,
          busy: undefined,
          notice: undefined,
          error: undefined,
          scopeError: undefined,
        })
      },

      setSection: (section) => {
        if (get().disposed) return
        set({ section })
      },

      setShellCommand: (shellCommand) => {
        if (get().disposed) return
        set({ shellCommand, notice: undefined, error: undefined })
      },

      setShellExcludeFromContext: (shellExcludeFromContext) => {
        if (get().disposed) return
        set({ shellExcludeFromContext })
      },

      setCompactInstructions: (compactInstructions) => {
        if (get().disposed) return
        set({ compactInstructions, notice: undefined, error: undefined })
      },

      setSaveAsDefault: (saveAsDefault) => {
        if (get().disposed) return
        set({ saveAsDefault })
      },

      loadCatalog: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target) return
        const request = ++catalogRequest
        try {
          await browser.serviceStore.getState().loadModelCatalog(catalogQueryOf(target))
        } catch (error) {
          const current = get()
          if (current.disposed || request !== catalogRequest) return
          if (current.targetKey === runtimeTargetKey(target)) set({ error: errorText(error) })
        }
      },

      refreshCatalog: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target || state.busy) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++actionRequest
        set({ busy: 'refresh', notice: undefined, error: undefined })
        try {
          const result = await browser.client.refreshModels(
            target.threadId
              ? { threadId: target.threadId }
              : { workspacePath: target.workspacePath },
          )
          // 共享目录刷新结果与动作回执分开；即使面板已关闭也更新 serviceStore 查询。
          await browser.serviceStore.getState().loadModelCatalog(catalogQueryOf(target))
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (!samePanel(panel, targetKey)) return
          set({
            notice:
              result.failedProviders.length === 0
                ? '模型目录已刷新。'
                : result.failedProviders.includes('*')
                  ? '模型目录刷新未完成（超时或异常），仍显示缓存目录。'
                  : `部分 provider 目录刷新失败：${result.failedProviders.join('、')}（仍显示缓存目录）。`,
            error: undefined,
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      loadScope: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++scopeRequest
        set({ scopeLoading: true, scopeError: undefined })
        try {
          const scope = await browser.client.getThreadModelScope(target.threadId)
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            request !== scopeRequest
          ) {
            return
          }
          const text = scopePatternsTextOf(scope)
          set({
            scope,
            patternsText: text,
            basePatternsText: text,
            patternRevision: 0,
            scopeLoading: false,
            scopeError: undefined,
          })
        } catch (error) {
          const current = get()
          if (
            current.disposed ||
            !current.open ||
            current.targetEpoch !== panel ||
            current.targetKey !== targetKey ||
            request !== scopeRequest
          ) {
            return
          }
          set({ scopeLoading: false, scopeError: errorText(error) })
        }
      },

      updatePatternsText: (patternsText) => {
        const state = get()
        if (state.disposed) return
        if (state.patternsText === patternsText) return
        set({
          patternsText,
          patternRevision: state.patternRevision + 1,
          notice: undefined,
          error: undefined,
        })
      },

      resetPatternsDraft: () => {
        const state = get()
        if (state.disposed) return
        if (state.patternsText === state.basePatternsText) return
        set({
          patternsText: state.basePatternsText,
          patternRevision: state.patternRevision + 1,
          notice: undefined,
          error: undefined,
        })
      },

      toggleScopeModel: (model, allModels) => {
        const state = get()
        if (state.disposed) return
        const key = `${model.provider}/${model.modelId}`
        const lines = state.patternsText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        if (lines.length === 0) {
          // 空 patterns 表示全部：取消一个模型要写出其余模型的明确列表，
          // 否则“从全部里移除一项”会被当成通配语法错误而静默失败。
          const rest = allModels
            .filter((item) => `${item.provider}/${item.modelId}` !== key)
            .map((item) => `${item.provider}/${item.modelId}`)
          set({
            patternsText: rest.join('\n'),
            patternRevision: state.patternRevision + 1,
            notice: undefined,
            error: undefined,
          })
          return
        }
        const selected = lines.some((pattern) => patternMatchesModel(pattern, key))
        if (selected) {
          // 只移除明确写出该模型的行；通配模式匹配到的模型必须在原文里调整。
          const exact = (pattern: string): boolean => stripThinkingSuffix(pattern) === key
          const next = lines.filter((pattern) => !exact(pattern))
          if (
            next.length === lines.length ||
            next.some((pattern) => patternMatchesModel(pattern, key))
          ) {
            set({
              notice: `模型 ${key} 由通配模式匹配；请在 patterns 原文中调整，不使用模型单选替换范围。`,
            })
            return
          }
          set({
            patternsText: next.join('\n'),
            patternRevision: state.patternRevision + 1,
            notice: undefined,
            error: undefined,
          })
          return
        }
        set({
          patternsText: [...lines, key].join('\n'),
          patternRevision: state.patternRevision + 1,
          notice: undefined,
          error: undefined,
        })
      },

      saveScope: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId || state.busy) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const submitted = {
          text: state.patternsText,
          revision: state.patternRevision,
          saveAsDefault: state.saveAsDefault,
        }
        const patterns = submitted.text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const request = ++actionRequest
        set({ busy: 'scope', notice: undefined, error: undefined })
        try {
          const result = await browser.client.setThreadModelScope(target.threadId, {
            patterns,
            ...(submitted.saveAsDefault ? { saveAsDefault: true } : {}),
          })
          // 范围属于会话权威；即使面板已关闭也同步目录元数据（scopedModelKeys）。
          // 目录扫描直接读取 live 元数据，比冷快照更能覆盖“无新事件”的范围修改。
          void browser.serviceStore
            .getState()
            .refreshThreads()
            .catch(() => undefined)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (!samePanel(panel, targetKey)) return
          const noMatch = patterns.length > 0 && result.models.length === 0
          if (noMatch) {
            // 无匹配时宿主保持原范围；恢复已保存原文，避免把未生效输入当成结果。
            set({
              scope: result,
              patternsText: current.basePatternsText,
              notice: result.message ?? '没有匹配的模型，会话范围未修改。',
              error: undefined,
            })
            return
          }
          const editedLater = current.patternRevision !== submitted.revision
          set({
            scope: result,
            basePatternsText: submitted.text,
            patternsText: editedLater ? current.patternsText : submitted.text,
            notice:
              result.persistence === 'failed'
                ? persistenceNotice(result)
                : (result.message ?? persistenceNotice(result)),
            error: undefined,
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      runShell: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId || state.busy) return
        const command = state.shellCommand.trim()
        if (!command) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++actionRequest
        set({ busy: 'shell', notice: undefined, error: undefined })
        try {
          const result: HarnessBashStartResult = await browser.client.runThreadBash(
            target.threadId,
            {
              command,
              ...(state.shellExcludeFromContext ? { excludeFromContext: true } : {}),
            },
          )
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (!samePanel(panel, targetKey)) return
          if (result.status === 'started') {
            // 只清空本次已接受的命令，保留用户后来编辑的新文本。
            if (current.shellCommand.trim() === command) set({ shellCommand: '', error: undefined })
            return
          }
          if (result.status === 'busy') set({ notice: result.message })
          else set({ error: result.message })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      abortShell: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId || (state.busy && state.busy !== 'shell')) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++actionRequest
        set({ busy: 'shell-abort', notice: undefined, error: undefined })
        try {
          await browser.client.abortThreadBash(target.threadId)
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      compact: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId || state.busy) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const instructions = state.compactInstructions.trim()
        const request = ++actionRequest
        set({ busy: 'compact', notice: undefined, error: undefined })
        try {
          const outcome = await browser.client.compactThread(target.threadId, {
            ...(instructions ? { customInstructions: instructions } : {}),
          })
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (!samePanel(panel, targetKey)) return
          set({
            ...(outcome.status === 'failed'
              ? { error: compactionNoticeText(outcome) }
              : { notice: compactionNoticeText(outcome) }),
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      abortCompaction: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId || (state.busy && state.busy !== 'compact')) return
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        // 不推进 action 代次：在途压缩的「已取消」结果仍要写回面板提示。
        const request = actionRequest
        set({ busy: 'compact-abort', notice: undefined, error: undefined })
        try {
          const result = await browser.client.abortThreadCompaction(target.threadId)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey) && result.status === 'idle') {
            set({ notice: '当前没有进行中的压缩。' })
          }
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      toggleAutoCompaction: async () => {
        const state = get()
        const target = state.target
        if (state.disposed || !target?.threadId || state.busy) return
        const metadata = browser.serviceStore.getState().threadsById[target.threadId]
        const currentValue = metadata?.autoCompactionEnabled
        if (currentValue === undefined) {
          set({ error: '会话尚未就绪，暂时无法修改自动压缩设置。' })
          return
        }
        const panel = state.targetEpoch
        const targetKey = state.targetKey
        const request = ++actionRequest
        set({ busy: 'auto', notice: undefined, error: undefined })
        try {
          const result = await browser.client.setAutoCompaction(target.threadId, !currentValue)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (!samePanel(panel, targetKey)) return
          if (result.status === 'failed') {
            set({ error: result.message })
            return
          }
          set({
            notice:
              result.message ??
              `自动压缩已${result.enabled ? '开启' : '关闭'}（已保存到当前用户设置）${
                result.overridden ? '。' : ''
              }`,
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      clearNotice: () => {
        if (get().disposed) return
        set({ notice: undefined })
      },

      clearError: () => {
        if (get().disposed) return
        set({ error: undefined, scopeError: undefined })
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
        catalogRequest += 1
        scopeRequest += 1
        actionRequest += 1
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: 'none',
          section: 'shell',
          shellCommand: '',
          shellExcludeFromContext: false,
          compactInstructions: '',
          scope: undefined,
          patternsText: '',
          basePatternsText: '',
          patternRevision: 0,
          scopeLoading: false,
          saveAsDefault: false,
          busy: undefined,
          notice: undefined,
          error: undefined,
          scopeError: undefined,
          disposed: true,
        })
      },
    }
  })
}
