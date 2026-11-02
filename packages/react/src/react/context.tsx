/**
 * 浏览器实例的 React Context。
 *
 * Context 只传递实例与依赖，不复制业务状态；组件通过 selector hooks 直接
 * 订阅 Zustand。Provider 在根 effect 中取得 lease，StrictMode 同轮重挂由
 * 资源层的微任务确认处理。
 */

import { createContext, type ReactNode, useContext, useEffect } from 'react'
import type { HarnessBrowser } from '../browser/create-browser.js'

export const HarnessBrowserContext = createContext<HarnessBrowser | null>(null)

export interface HarnessBrowserProviderProps {
  browser: HarnessBrowser
  children?: ReactNode
}

export const HarnessBrowserProvider = ({ browser, children }: HarnessBrowserProviderProps) => {
  useEffect(() => browser.acquireRoot(), [browser])
  return <HarnessBrowserContext.Provider value={browser}>{children}</HarnessBrowserContext.Provider>
}

/** 读取当前浏览器实例；未包裹 Provider 时明确抛错。 */
export const useHarnessBrowser = (): HarnessBrowser => {
  const browser = useContext(HarnessBrowserContext)
  if (!browser) {
    throw new Error('useHarnessBrowser 必须在 <HarnessBrowserProvider> 内使用')
  }
  return browser
}
