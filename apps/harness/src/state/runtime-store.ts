/**
 * 运行管理 feature Zustand 状态：用户 Shell、上下文压缩与输入区上下文用量浮窗。
 *
 * 业务边界（见 R1 §5.2、R2 §7）：
 * - 面板与浮窗各自固定 target/epoch；关闭或切换后迟到结果只更新原对象事实，
 *   不写新面板/浮窗，也不撤销已经发出的远端动作；
 * - 浮窗只保存全文件累计统计；当前上下文用量始终读取服务端 metadata，
 *   旧详情响应不得覆盖实时元数据；
 * - Shell/压缩的运行结果始终来自服务端事件与权威快照，本 store 只保存表单、忙状态
 *   和受控提示；取消不伪装成成功。
 */

import type {
  HarnessBashStartResult,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessThreadStats,
} from '@huan/protocol'
import type { HarnessBrowser } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 运行面板分段；调用方可指定初始打开位置。 */
export type RuntimeSection = 'shell' | 'compact'

/** 运行管理固定 target：已有会话或空白页起始目录。 */
export interface RuntimeTarget {
  threadId?: string
  workspacePath: string
}

/** 打开选项；target 省略时按当前窗口选择解析。 */
export interface RuntimeOpenOptions {
  target?: RuntimeTarget
  section?: RuntimeSection
}

/** 输入区上下文用量浮窗；与运行面板 target 分离，不抢占其表单状态。 */
export interface ContextUsagePopoverState {
  open: boolean
  /** 打开时固定的会话；空白页缺失。 */
  threadId: string | undefined
  /** 浮窗代次；关闭/换目标推进，旧统计响应不得写回。 */
  epoch: number
  /** 全文件累计统计；当前上下文用量不从这里读取。 */
  stats: HarnessThreadStats | undefined
  loading: boolean
  statsError: string | undefined
  /** 仅保存“压缩未开始”的预检错误；压缩结果由消息区状态行承载。 */
  compactError: string | undefined
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

  busy: string | undefined
  notice: string | undefined
  error: string | undefined
  /** 输入区上下文用量浮窗（独立于运行面板）。 */
  contextUsage: ContextUsagePopoverState
  disposed: boolean

  openPanel: (options?: RuntimeOpenOptions) => Promise<void>
  close: () => void
  setSection: (section: RuntimeSection) => void
  setShellCommand: (command: string) => void
  setShellExcludeFromContext: (exclude: boolean) => void
  setCompactInstructions: (instructions: string) => void

  /**
   * 共用压缩动作：固定发起会话；不绑定面板/浮窗，结果由调用方展示。
   * 同一会话已有压缩请求、模型运行或结构操作时只返回 busy。
   */
  runCompaction: (threadId: string, instructions?: string) => Promise<HarnessCompactionOutcome>
  /** 取消指定会话的压缩；消息状态行与输入停止共用，不受运行面板忙状态影响。 */
  abortThreadCompaction: (threadId: string) => Promise<HarnessCompactionAbortResult>
  runShell: () => Promise<void>
  abortShell: () => Promise<void>
  compact: () => Promise<void>
  abortCompaction: () => Promise<void>
  clearNotice: () => void
  clearError: () => void

  /** 打开浮窗并固定当前会话；累计统计按需读取。 */
  openContextUsage: () => void
  closeContextUsage: () => void
  completeContextUsageClose: () => void
  refreshContextUsage: () => Promise<void>
  compactContextUsage: () => Promise<void>

  dispose: () => void
}

export interface CreateRuntimeFeatureStoreOptions {
  browser: HarnessBrowser
  /** 空白页没有窗口选择时的起始目录来源；由组合根提供。 */
  fallbackWorkspacePath?: () => string | undefined
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const runtimeTargetKey = (target: RuntimeTarget | undefined): string => {
  if (!target) return 'none'
  if (target.threadId) return `t:${target.threadId}`
  return `w:${target.workspacePath}`
}

const emptyContextUsage = (): ContextUsagePopoverState => ({
  open: false,
  threadId: undefined,
  epoch: 0,
  stats: undefined,
  loading: false,
  statsError: undefined,
  compactError: undefined,
})

export const createRuntimeFeatureStore = (
  options: CreateRuntimeFeatureStoreOptions,
): StoreApi<RuntimeFeatureState> => {
  const { browser } = options
  let panelEpoch = 0
  let actionRequest = 0
  // 同一会话的压缩请求不重复发出；跨窗口/服务端闸门仍是最终权威。
  const compactingThreads = new Set<string>()
  // 浮窗自身的请求去重：不把本地“进行中”伪装成服务端运行状态。
  const contextCompactionThreads = new Set<string>()

  let contextUsageEpoch = 0
  let contextDetailsRequest = 0
  let contextDetailsInFlight: number | undefined
  let contextDetailsKey: string | undefined
  let contextDetailsPending = false
  let contextSelectionKey: string | undefined
  let unsubscribeContextSelection: (() => void) | undefined
  let unsubscribeContextDetails: (() => void) | undefined

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

  /** 浮窗只在同一窗口目标内保持打开；切换目标时关闭，避免展示旧会话统计。 */
  const currentSelectionKey = (): string => {
    const selection = browser.windowStore.getState().selection
    if (selection?.kind === 'thread') return `t:${selection.threadId}`
    if (selection?.kind === 'new') {
      return `n:${selection.workspaceId ?? ''}:${selection.startProjectPath}`
    }
    return 'none'
  }

  /**
   * 累计统计只在消息/压缩记录写入或分支切换后变化；用既有元数据做失效键。
   * 运行开始与逐 token 事件不改变这些字段，因此不会额外读详情。
   */
  const contextDetailsKeyOf = (threadId: string): string => {
    const metadata = browser.serviceStore.getState().threadsById[threadId]
    return JSON.stringify([
      metadata?.updatedAt ?? null,
      metadata?.messageCount ?? null,
      metadata?.treeRevision ?? null,
      metadata?.leafId ?? null,
    ])
  }

  return createStore<RuntimeFeatureState>()((set, get) => {
    const samePanel = (panel: number, targetKey: string): boolean => {
      const current = get()
      return current.open && current.targetEpoch === panel && current.targetKey === targetKey
    }

    const patchContextUsage = (
      epoch: number,
      threadId: string,
      patch: Partial<ContextUsagePopoverState>,
    ): void => {
      const current = get()
      if (
        current.disposed ||
        !current.contextUsage.open ||
        current.contextUsage.epoch !== epoch ||
        current.contextUsage.threadId !== threadId
      ) {
        return
      }
      set({ contextUsage: { ...current.contextUsage, ...patch } })
    }

    const syncContextDetails = async (force = false): Promise<void> => {
      const current = get()
      const { open, threadId, epoch } = current.contextUsage
      if (current.disposed || !open || !threadId) return
      const key = contextDetailsKeyOf(threadId)
      if (!force && key === contextDetailsKey) return
      if (contextDetailsInFlight !== undefined) {
        // 载入期间的元数据推进只记一次待重读；完成后按最新键再决定是否请求。
        contextDetailsPending = true
        return
      }
      contextDetailsKey = key
      const request = ++contextDetailsRequest
      contextDetailsInFlight = request
      patchContextUsage(epoch, threadId, { loading: true, statsError: undefined })
      try {
        const details = await browser.client.getThreadDetails(threadId)
        if (contextDetailsInFlight !== request) return
        // 只吸收累计统计；当前上下文始终以 serviceStore 的实时 metadata 为准。
        patchContextUsage(epoch, threadId, {
          stats: details.stats,
          loading: false,
          statsError: undefined,
        })
      } catch (error) {
        if (contextDetailsInFlight !== request) return
        patchContextUsage(epoch, threadId, { loading: false, statsError: errorText(error) })
      } finally {
        if (contextDetailsInFlight === request) {
          contextDetailsInFlight = undefined
          if (contextDetailsPending) {
            contextDetailsPending = false
            void syncContextDetails()
          }
        }
      }
    }

    const uninstallContextSubscriptions = (): void => {
      unsubscribeContextSelection?.()
      unsubscribeContextSelection = undefined
      unsubscribeContextDetails?.()
      unsubscribeContextDetails = undefined
    }

    const installContextSubscriptions = (): void => {
      uninstallContextSubscriptions()
      unsubscribeContextSelection = browser.windowStore.subscribe(() => {
        const current = get()
        if (!current.contextUsage.open) return
        if (currentSelectionKey() !== contextSelectionKey) get().closeContextUsage()
      })
      // 只在浮窗打开期间监听元数据；键未变化时同步函数直接返回，不逐 token 读详情。
      unsubscribeContextDetails = browser.serviceStore.subscribe(() => {
        const current = get()
        if (!current.contextUsage.open || !current.contextUsage.threadId) return
        void syncContextDetails()
      })
    }

    const runCompaction = async (
      threadId: string,
      instructions?: string,
    ): Promise<HarnessCompactionOutcome> => {
      if (get().disposed) throw new Error('运行管理已释放。')
      if (compactingThreads.has(threadId)) {
        return { status: 'busy', message: '已有压缩请求进行中，请稍候。' }
      }
      const metadata = browser.serviceStore.getState().threadsById[threadId]
      if (metadata?.compactionActive) {
        return { status: 'busy', message: '上下文压缩进行中，请稍候。' }
      }
      if (metadata?.status === 'running' || metadata?.retryActive) {
        return { status: 'busy', message: '模型正在运行，请先停止后再压缩。' }
      }
      if (metadata?.treeOperation) {
        return { status: 'busy', message: '会话结构操作进行中，请稍候再压缩。' }
      }
      compactingThreads.add(threadId)
      try {
        const customInstructions = instructions?.trim()
        return await browser.client.compactThread(threadId, {
          ...(customInstructions ? { customInstructions } : {}),
        })
      } finally {
        compactingThreads.delete(threadId)
      }
    }

    return {
      open: false,
      targetEpoch: 0,
      target: undefined,
      targetKey: 'none',
      section: 'shell',
      shellCommand: '',
      shellExcludeFromContext: false,
      compactInstructions: '',
      busy: undefined,
      notice: undefined,
      error: undefined,
      contextUsage: emptyContextUsage(),
      disposed: false,

      openPanel: async (openOptions) => {
        if (get().disposed) return
        const target = openOptions?.target ?? resolveTarget()
        const epoch = ++panelEpoch
        actionRequest += 1
        set({
          open: true,
          targetEpoch: epoch,
          target,
          targetKey: runtimeTargetKey(target),
          section: openOptions?.section ?? 'shell',
          shellCommand: '',
          shellExcludeFromContext: false,
          compactInstructions: '',
          busy: undefined,
          notice: undefined,
          error: undefined,
        })
        if (!target) {
          set({ notice: '当前没有可用的会话或起始目录；请先选择工作区/项目。' })
          return
        }
      },

      close: () => {
        if (get().disposed) return
        panelEpoch += 1
        actionRequest += 1
        // 关闭只失效本地请求/表单；远端 Shell 与压缩不被撤销。
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: 'none',
          shellCommand: '',
          shellExcludeFromContext: false,
          compactInstructions: '',
          busy: undefined,
          notice: undefined,
          error: undefined,
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

      runCompaction,

      abortThreadCompaction: async (threadId) => {
        if (get().disposed) return { status: 'idle' }
        return browser.client.abortThreadCompaction(threadId)
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
          const outcome = await get().runCompaction(target.threadId, instructions || undefined)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (!samePanel(panel, targetKey)) return
          // 压缩结果统一由消息区状态行承载；面板只提示尚未开始的预检 busy。
          if (outcome.status === 'busy') set({ notice: outcome.message })
          if (
            outcome.status === 'failed' &&
            browser.serviceStore.getState().sessionDataById[target.threadId]?.compaction?.status !==
              'failed'
          ) {
            set({ error: outcome.message })
          }
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: `压缩请求失败：${errorText(error)}` })
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
          const result = await get().abortThreadCompaction(target.threadId)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey) && result.status === 'idle') {
            set({ notice: '当前没有进行中的压缩。' })
          }
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(panel, targetKey)) set({ error: `取消压缩未发出：${errorText(error)}` })
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
        set({ error: undefined })
      },

      openContextUsage: () => {
        const state = get()
        if (state.disposed || state.contextUsage.open) return
        const selection = browser.windowStore.getState().selection
        const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
        contextUsageEpoch += 1
        contextDetailsRequest += 1
        contextDetailsInFlight = undefined
        contextDetailsKey = undefined
        contextDetailsPending = false
        contextSelectionKey = currentSelectionKey()
        set({
          contextUsage: {
            ...emptyContextUsage(),
            open: true,
            threadId,
            epoch: contextUsageEpoch,
            loading: threadId !== undefined,
          },
        })
        installContextSubscriptions()
        if (threadId) void syncContextDetails(true)
      },

      closeContextUsage: () => {
        if (get().disposed || !get().contextUsage.open) return
        contextUsageEpoch += 1
        contextDetailsRequest += 1
        contextDetailsInFlight = undefined
        contextDetailsKey = undefined
        contextDetailsPending = false
        contextSelectionKey = undefined
        uninstallContextSubscriptions()
        set({
          contextUsage: {
            ...get().contextUsage,
            open: false,
            epoch: contextUsageEpoch,
            loading: false,
          },
        })
      },

      completeContextUsageClose: () => {
        if (!get().contextUsage.open) {
          set({ contextUsage: { ...emptyContextUsage(), epoch: contextUsageEpoch } })
        }
      },

      refreshContextUsage: async () => {
        await syncContextDetails(true)
      },

      compactContextUsage: async () => {
        const state = get()
        const context = state.contextUsage
        if (state.disposed || !context.open || !context.threadId) return
        const threadId = context.threadId
        const epoch = context.epoch
        if (contextCompactionThreads.has(threadId)) return
        contextCompactionThreads.add(threadId)
        patchContextUsage(epoch, threadId, { compactError: undefined })
        try {
          const outcome = await get().runCompaction(threadId)
          // 结果由事件/消息状态行承载；浮窗只显示尚未开始的预检失败。
          if (
            outcome.status === 'busy' ||
            (outcome.status === 'failed' &&
              browser.serviceStore.getState().sessionDataById[threadId]?.compaction?.status !==
                'failed')
          ) {
            patchContextUsage(epoch, threadId, { compactError: `压缩未开始：${outcome.message}` })
          }
        } catch (error) {
          patchContextUsage(epoch, threadId, {
            compactError: `压缩请求失败：${errorText(error)}`,
          })
        } finally {
          contextCompactionThreads.delete(threadId)
        }
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
        actionRequest += 1
        uninstallContextSubscriptions()
        contextUsageEpoch += 1
        contextDetailsRequest += 1
        contextDetailsInFlight = undefined
        contextDetailsKey = undefined
        contextDetailsPending = false
        contextSelectionKey = undefined
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: 'none',
          section: 'shell',
          shellCommand: '',
          shellExcludeFromContext: false,
          compactInstructions: '',
          busy: undefined,
          notice: undefined,
          error: undefined,
          contextUsage: { ...emptyContextUsage(), epoch: contextUsageEpoch },
          disposed: true,
        })
      },
    }
  })
}
