/**
 * 统一设置导航状态：唯一保存对话框开关与当前页。
 *
 * 页面数据读取、草稿与认证/诊断等业务状态仍由各自 feature store 持有；
 * 这里只保存导航，并通过组合根注入的动作触发对应页面加载和关闭清理。
 */

import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AuthOpenOptions } from './auth-store'

/** 统一设置左侧垂直页签。 */
export type SettingsPage =
  | 'appearance'
  | 'models'
  | 'conversation'
  | 'tools'
  | 'mcp'
  | 'advanced'
  | 'service'

/** 打开页面时的一次性定位；不写入导航状态，由对应 feature 消费。 */
export type SettingsPageFocus = AuthOpenOptions

/** 页面切换回调上下文；`wasOpen` 区分首次打开与页签切换。 */
export interface SettingsPageChange {
  wasOpen: boolean
  focus: SettingsPageFocus | undefined
}

export interface SettingsUiState {
  open: boolean
  page: SettingsPage
  /** 打开设置或切换页签；同页命令可携带一次性定位。 */
  openPage: (page: SettingsPage, focus?: SettingsPageFocus) => void
  /** 关闭统一设置；立即失效在途读取，页面视图保留到退出动画完成。 */
  close: (afterClose?: () => void) => void
  /** 退出动画完成：通知组合根清理页面视图；重开期间不清理。 */
  finishClose: () => void
}

export interface CreateSettingsUiStoreOptions {
  /** 页面加载/定位由组合根统一编排，避免组件并行维护业务加载。 */
  onChange?: (page: SettingsPage, previous: SettingsPage, context: SettingsPageChange) => void
  /** 关闭请求时立即失效在途读取；不得取消进行中的远端操作。 */
  onClose?: (page: SettingsPage) => void
  /** 退出动画完成后清理页面视图；此时对话框已卸载，不会造成正文变空。 */
  onCloseComplete?: () => void
}

export const createSettingsUiStore = (
  options: CreateSettingsUiStoreOptions = {},
): StoreApi<SettingsUiState> => {
  // 仅保存关闭后跳转动作，避免两个独立模态在退出阶段同时打开。
  let afterClose: (() => void) | undefined
  return createStore<SettingsUiState>()((set, get) => ({
    open: false,
    page: 'appearance',

    openPage: (page, focus) => {
      afterClose = undefined
      const current = get()
      set({ open: true, page })
      options.onChange?.(page, current.page, { wasOpen: current.open, focus })
    },

    close: (nextAction) => {
      const current = get()
      if (!current.open) return
      afterClose = nextAction
      set({ open: false })
      options.onClose?.(current.page)
    },

    finishClose: () => {
      // 退出动画期间可能被重新打开；此时保留新打开的页面，不执行关闭清理。
      if (get().open) return
      options.onCloseComplete?.()
      const action = afterClose
      afterClose = undefined
      action?.()
    },
  }))
}
