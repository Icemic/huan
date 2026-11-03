/**
 * 运行管理 feature Zustand 状态：用户 Shell 与上下文压缩。
 *
 * 业务边界（见 R1 §5.2、R2 §7）：
 * - 面板打开时固定会话 target 与 panelEpoch；关闭后迟到结果只更新原对象事实，
 *   不写新面板，也不撤销已经发出的远端动作；
 * - Shell/压缩的运行结果始终来自服务端事件与权威快照，本 store 只保存表单、忙状态
 *   和受控提示；取消不伪装成成功。
 */

import type { HarnessBashStartResult, HarnessCompactionOutcome } from '@huan/protocol'
import type { HarnessBrowser } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 运行面板分段；命令可指定打开位置。 */
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

  busy: string | undefined
  notice: string | undefined
  error: string | undefined
  disposed: boolean

  openPanel: (options?: RuntimeOpenOptions) => Promise<void>
  close: () => void
  setSection: (section: RuntimeSection) => void
  setShellCommand: (command: string) => void
  setShellExcludeFromContext: (exclude: boolean) => void
  setCompactInstructions: (instructions: string) => void

  runShell: () => Promise<void>
  abortShell: () => Promise<void>
  compact: () => Promise<void>
  abortCompaction: () => Promise<void>
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

export const createRuntimeFeatureStore = (
  options: CreateRuntimeFeatureStoreOptions,
): StoreApi<RuntimeFeatureState> => {
  const { browser } = options
  let panelEpoch = 0
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
          compactInstructions: openOptions?.instructions ?? '',
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

      clearNotice: () => {
        if (get().disposed) return
        set({ notice: undefined })
      },

      clearError: () => {
        if (get().disposed) return
        set({ error: undefined })
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
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
          busy: undefined,
          notice: undefined,
          error: undefined,
          disposed: true,
        })
      },
    }
  })
}
