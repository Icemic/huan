/**
 * 应用 bootstrap：显式创建 HTTP client、浏览器实例、应用 feature store 与 DOM 资源。
 *
 * 这是浏览器侧唯一组合根。React Context 只传这里创建的实例；不同标签页各自
 * 创建，通过 Node 权威数据同步。重载/嵌入根销毁时由调用方 dispose。
 */

import { createHarnessBrowser, type HarnessBrowser, type HarnessBrowserStorage } from '@huan/react'
import { createHarnessHttpClient } from '@huan/react/client'
import type { StoreApi } from 'zustand/vanilla'
import { applyThemeToDocument, type ThemeStorage } from './lib/theme'
import { createThemeStore, type ThemeStoreState } from './state/theme-store'
import { createWorkspaceFeatureStore, type WorkspaceFeatureState } from './state/workspace-store'

/** bootstrap 返回的应用实例组合；Context 只传这个对象。 */
export interface HarnessApp {
  browser: HarnessBrowser
  workspaceStore: StoreApi<WorkspaceFeatureState>
  themeStore: StoreApi<ThemeStoreState>
  dispose(): void
}

const WINDOW_ID_KEY = 'huan.window-id'

const browserStorage = (): HarnessBrowserStorage | null => {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage
  } catch {
    return null
  }
}

const themeStorage = (): ThemeStorage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

/** 当前浏览器窗口的稳定标识（同一标签页刷新后保持）。 */
const createWindowId = (storage: HarnessBrowserStorage | null): string => {
  if (typeof window === 'undefined') return 'host'
  try {
    const existing = storage?.getItem(WINDOW_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    storage?.setItem(WINDOW_ID_KEY, id)
    return id
  } catch {
    // 隐私模式等无法持久化时退回进程内随机值。
    return crypto.randomUUID()
  }
}

const connectionKeyOf = (): string => {
  if (typeof location === 'undefined') return 'huan'
  return `${location.origin}/api/pi`
}

/** 创建应用唯一实例；调用方负责在根销毁/HMR 时 dispose。 */
export const createHarnessApp = (): HarnessApp => {
  const storage = browserStorage()
  const windowId = createWindowId(storage)
  const token = typeof __HUAN_TOKEN__ === 'string' ? __HUAN_TOKEN__ : ''
  const client = createHarnessHttpClient({
    callerId: windowId,
    ...(token ? { headers: { 'x-huan-token': token } } : {}),
  })
  const browser = createHarnessBrowser({
    client,
    connectionKey: connectionKeyOf(),
    windowId,
    ...(storage ? { storage } : { storage: null }),
  })

  const workspaceStore = createWorkspaceFeatureStore({
    browser,
    ...(storage ? { storage } : { storage: null }),
  })

  // 主题业务状态在 Zustand；matchMedia 与文档 class 写入由 bootstrap 持有。
  const media =
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? undefined
      : window.matchMedia('(prefers-color-scheme: dark)')
  const themeStore = createThemeStore({
    storage: themeStorage(),
    prefersDark: () => media?.matches ?? false,
    apply: (resolved) => {
      if (typeof document === 'undefined') return
      applyThemeToDocument(resolved, document)
    },
  })
  // 首次渲染前应用已保存主题，避免暗色页面闪白；DOM 写入留在 bootstrap。
  if (typeof document !== 'undefined') {
    applyThemeToDocument(themeStore.getState().resolved, document)
  }
  const onSystemThemeChange = () => themeStore.getState().syncSystem()
  media?.addEventListener('change', onSystemThemeChange)

  // 窗口存储作用域与显式选择的变化同步到应用 feature；不复制选择值。
  let previousScope = browser.windowStore.getState().storageScope
  let previousSelection = browser.windowStore.getState().selection
  const unsubscribeWindow = browser.windowStore.subscribe((state) => {
    if (state.storageScope !== previousScope) {
      previousScope = state.storageScope
      workspaceStore.getState().setStorageScope(state.storageScope)
    }
    if (state.selection !== previousSelection) {
      previousSelection = state.selection
      workspaceStore.getState().syncSelection()
    }
  })

  // 窗口聚焦/恢复时显式重扫作用域，外部 Pi 与跨窗口改动可见。
  const onFocus = () => {
    void workspaceStore.getState().refresh({ rescan: true })
  }
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onFocus()
  }
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  let disposed = false
  return {
    browser,
    workspaceStore,
    themeStore,
    dispose: () => {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      media?.removeEventListener('change', onSystemThemeChange)
      try {
        unsubscribeWindow()
      } catch (error) {
        errors.push(error)
      }
      try {
        workspaceStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        browser.dispose()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        for (const error of errors.slice(1)) console.error('[huan-app] 实例释放失败', error)
        throw errors[0]
      }
    },
  }
}
