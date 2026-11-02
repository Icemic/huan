/**
 * 应用实例 Context：只在组件树传递 bootstrap 创建的实例。
 *
 * 浏览器业务状态仍由公共 service/window Zustand store 持有；这里只暴露
 * 应用 feature store（工作区、主题）与浏览器实例，不复制其状态值。
 */

import { createContext, type ReactNode, useContext } from 'react'
import { useStore } from 'zustand'
import type { HarnessApp } from '../bootstrap'
import type { ThemeStoreState } from './theme-store'
import type { WorkspaceFeatureState } from './workspace-store'

/** 应用 bootstrap 创建的实例组合。 */
export type HarnessAppInstance = HarnessApp

const HarnessAppContext = createContext<HarnessAppInstance | null>(null)

export const HarnessAppContextProvider = ({
  app,
  children,
}: {
  app: HarnessAppInstance
  children: ReactNode
}) => <HarnessAppContext.Provider value={app}>{children}</HarnessAppContext.Provider>

/** 读取应用实例；未包裹时明确抛错。 */
export const useHarnessApp = (): HarnessAppInstance => {
  const app = useContext(HarnessAppContext)
  if (!app) throw new Error('useHarnessApp 必须在 HarnessAppContextProvider 内使用')
  return app
}

/** 订阅工作区 feature 状态。 */
export const useWorkspaceStore = <T,>(selector: (state: WorkspaceFeatureState) => T): T =>
  useStore(useHarnessApp().workspaceStore, selector)

/** 订阅主题状态。 */
export const useThemeStore = <T,>(selector: (state: ThemeStoreState) => T): T =>
  useStore(useHarnessApp().themeStore, selector)
