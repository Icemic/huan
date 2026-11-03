/**
 * 模型选择 feature Zustand 状态：面板目标、目录加载与新建草稿/已有会话的选择动作。
 *
 * 业务边界（见 R1 §5.1、R2 §7）：
 * - 面板打开时固定 target 与 panelEpoch；迟到结果只更新原目标，不盖新面板或新草稿；
 * - 目录统一从公共 serviceStore 按 target/工作区/resource/auth/modelCatalog 版本读取；
 * - 新会话选择写入窗口草稿（随创建请求生效），已有会话走公共 sessionActions.setModel /
 *   setThinkingLevel，真实改变服务端会话；
 * - Thinking 级别完全来自模型目录能力（含 max），不在此处截断。
 */

import type { HarnessThinkingLevel } from '@huan/protocol'
import type { HarnessBrowser } from '@huan/react'
import { draftIdOf } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 模型选择固定目标；threadId 缺失表示新会话草稿。 */
export interface ModelTarget {
  workspacePath: string
  threadId?: string
  /** 新会话草稿的工作区归属；与服务端会话 ID 分开。 */
  workspaceId?: string
}

/** 打开焦点：`/model` 与 `/thinking` 共用同一选择器。 */
export type ModelFocus = 'model' | 'thinking'

/** 打开选项；target 省略时按当前窗口选择解析。 */
export interface ModelOpenOptions {
  target?: ModelTarget
  focus?: ModelFocus
  /** 触发面板的选择器实例；同一时刻只有一个实例渲染弹层。 */
  owner?: string
}

/** 默认面板持有者：输入区选择器；命令打开也归到它。 */
export const DEFAULT_MODEL_PANEL_OWNER = 'composer'

/** 模型选择 feature 状态。 */
export interface ModelFeatureState {
  open: boolean
  /** 面板代次；打开/关闭/换目标推进，旧异步结果不得写回。 */
  targetEpoch: number
  target: ModelTarget | undefined
  targetKey: string
  focus: ModelFocus | undefined
  /** 当前面板由哪个选择器实例持有；其他实例不渲染弹层。 */
  panelOwner: string
  busy: string | undefined
  notice: string | undefined
  error: string | undefined
  disposed: boolean

  /** 打开选择器；没有可用目标时返回 false，由命令层给出提示。 */
  openPanel: (options?: ModelOpenOptions) => Promise<boolean>
  close: () => void
  /** 按目标版本从 serviceStore 读取/刷新目录；不复制 models。 */
  loadCatalog: (target?: ModelTarget) => Promise<void>
  /** 新会话写草稿，已有会话真实 setModel。 */
  chooseModel: (model: { provider: string; modelId: string }) => Promise<void>
  /** 新会话写草稿 Thinking，已有会话真实 setThinkingLevel。 */
  chooseThinking: (level: HarnessThinkingLevel) => Promise<void>
  dispose: () => void
}

export interface CreateModelFeatureStoreOptions {
  browser: HarnessBrowser
  /** 空白页没有窗口选择时的起始目录来源；由组合根提供。 */
  fallbackWorkspacePath?: () => string | undefined
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 目标键：会话 ID 或新会话起始目录。 */
export const modelTargetKey = (target: ModelTarget | undefined): string => {
  if (!target) return 'none'
  if (target.threadId) return `t:${target.threadId}`
  return `w:${target.workspaceId ?? ''}:${target.workspacePath}`
}

const workspacePathForThread = (browser: HarnessBrowser, threadId: string): string =>
  browser.serviceStore.getState().threadsById[threadId]?.workspacePath ??
  browser.serviceStore.getState().host?.workspacePath ??
  ''

export const createModelFeatureStore = (
  options: CreateModelFeatureStoreOptions,
): StoreApi<ModelFeatureState> => {
  const { browser } = options
  let panelEpoch = 0
  let catalogRequest = 0
  let actionRequest = 0

  const resolveTarget = (): ModelTarget | undefined => {
    const selection = browser.windowStore.getState().selection
    if (selection?.kind === 'thread') {
      return {
        threadId: selection.threadId,
        workspacePath: workspacePathForThread(browser, selection.threadId),
      }
    }
    if (selection?.kind === 'new') {
      return {
        workspacePath: selection.startProjectPath,
        ...(selection.workspaceId ? { workspaceId: selection.workspaceId } : {}),
      }
    }
    return undefined
  }

  return createStore<ModelFeatureState>()((set, get) => {
    const samePanel = (panel: number): boolean => get().open && get().targetEpoch === panel

    return {
      open: false,
      targetEpoch: 0,
      target: undefined,
      targetKey: 'none',
      focus: undefined,
      panelOwner: DEFAULT_MODEL_PANEL_OWNER,
      busy: undefined,
      notice: undefined,
      error: undefined,
      disposed: false,

      openPanel: async (openOptions) => {
        if (get().disposed) return false
        const target = openOptions?.target ?? resolveTarget()
        if (!target?.workspacePath) return false
        const epoch = ++panelEpoch
        catalogRequest += 1
        actionRequest += 1
        set({
          open: true,
          targetEpoch: epoch,
          target,
          targetKey: modelTargetKey(target),
          focus: openOptions?.focus,
          panelOwner: openOptions?.owner ?? DEFAULT_MODEL_PANEL_OWNER,
          busy: undefined,
          notice: undefined,
          error: undefined,
        })
        await get().loadCatalog(target)
        return true
      },

      close: () => {
        if (get().disposed) return
        panelEpoch += 1
        catalogRequest += 1
        actionRequest += 1
        // 关闭只失效本地视图；已经发出的 setModel/setThinkingLevel 不回滚。
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: 'none',
          focus: undefined,
          panelOwner: DEFAULT_MODEL_PANEL_OWNER,
          busy: undefined,
          notice: undefined,
          error: undefined,
        })
      },

      loadCatalog: async (targetInput) => {
        const state = get()
        const target = targetInput ?? state.target
        if (state.disposed || !target?.workspacePath) return
        const request = ++catalogRequest
        try {
          await browser.serviceStore.getState().loadModelCatalog({
            workspacePath: target.workspacePath,
            ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
            ...(target.threadId ? { threadId: target.threadId } : {}),
          })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== catalogRequest) return
          if (current.targetKey === modelTargetKey(target)) set({ error: errorText(error) })
        }
      },

      chooseModel: async (model) => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target || state.busy) return
        const epoch = state.targetEpoch
        const label = `${model.provider}/${model.modelId}`
        if (!target.threadId) {
          const draftId = draftIdOf({
            kind: 'new',
            ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
            startProjectPath: target.workspacePath,
          })
          const draft = browser.windowStore.getState().draftsById[draftId]
          if (!draft) {
            set({ error: '新会话草稿尚未建立，请重新选择目标。' })
            return
          }
          browser.windowStore.getState().setDraftModel(draftId, model)
          if (samePanel(epoch)) set({ notice: `新会话将使用 ${label}。`, error: undefined })
          return
        }
        const threadId = target.threadId
        const request = ++actionRequest
        set({ busy: 'model', notice: undefined, error: undefined })
        try {
          await browser.sessionActions.setModel(threadId, model)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(epoch)) set({ notice: `已切换模型：${label}。`, error: undefined })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(epoch)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      chooseThinking: async (level) => {
        const state = get()
        const target = state.target
        if (state.disposed || !state.open || !target || state.busy) return
        const epoch = state.targetEpoch
        if (!target.threadId) {
          const draftId = draftIdOf({
            kind: 'new',
            ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
            startProjectPath: target.workspacePath,
          })
          const draft = browser.windowStore.getState().draftsById[draftId]
          if (!draft) {
            set({ error: '新会话草稿尚未建立，请重新选择目标。' })
            return
          }
          if (!draft.model) {
            set({ error: '请先选择模型，再设置 Thinking 级别。' })
            return
          }
          browser.windowStore.getState().setDraftThinkingLevel(draftId, level)
          if (samePanel(epoch))
            set({ notice: `新会话 Thinking 级别：${level}。`, error: undefined })
          return
        }
        const threadId = target.threadId
        const request = ++actionRequest
        set({ busy: 'thinking', notice: undefined, error: undefined })
        try {
          await browser.sessionActions.setThinkingLevel(threadId, level)
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(epoch))
            set({ notice: `Thinking 级别已设置为 ${level}。`, error: undefined })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== actionRequest) return
          if (samePanel(epoch)) set({ error: errorText(error) })
        } finally {
          const current = get()
          if (!current.disposed && request === actionRequest) set({ busy: undefined })
        }
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
        catalogRequest += 1
        actionRequest += 1
        set({
          open: false,
          targetEpoch: panelEpoch,
          target: undefined,
          targetKey: 'none',
          focus: undefined,
          busy: undefined,
          notice: undefined,
          error: undefined,
          disposed: true,
        })
      },
    }
  })
}
