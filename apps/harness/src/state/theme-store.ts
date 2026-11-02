/**
 * 应用主题 Zustand 状态：选择、持久化与系统配色投影。
 *
 * DOM 资源（matchMedia 监听、文档 class 写入）由应用 bootstrap 持有；
 * store 只接收注入的存储、系统配色读取与写入回调，便于测试且不复制监听器。
 */

import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  type AppTheme,
  type ResolvedAppTheme,
  readStoredTheme,
  resolveTheme,
  type ThemeStorage,
  writeStoredTheme,
} from '../lib/theme'

export interface ThemeStoreState {
  theme: AppTheme
  /** 当前实际生效主题；由 theme 与系统配色共同决定。 */
  resolved: ResolvedAppTheme

  setTheme: (theme: AppTheme) => void
  /** 系统明暗变化时重算生效主题；不改变用户选择。 */
  syncSystem: () => void
}

export interface CreateThemeStoreOptions {
  storage?: ThemeStorage | null
  /** 系统是否偏好深色；默认读取浏览器 matchMedia。 */
  prefersDark?: () => boolean
  /** 生效主题写入；由 bootstrap 提供的 DOM 资源，测试可注入替身。 */
  apply: (theme: ResolvedAppTheme) => void
}

const defaultPrefersDark = (): boolean =>
  typeof globalThis.matchMedia === 'function' &&
  globalThis.matchMedia('(prefers-color-scheme: dark)').matches

export const createThemeStore = (options: CreateThemeStoreOptions): StoreApi<ThemeStoreState> => {
  const storage = options.storage ?? null
  const prefersDark = options.prefersDark ?? defaultPrefersDark
  const { apply } = options
  const initialTheme = readStoredTheme(storage)

  return createStore<ThemeStoreState>()((set, get) => ({
    theme: initialTheme,
    resolved: resolveTheme(initialTheme, prefersDark()),

    setTheme: (theme) => {
      if (get().theme === theme) return
      writeStoredTheme(storage, theme)
      const resolved = resolveTheme(theme, prefersDark())
      apply(resolved)
      set({ theme, resolved })
    },

    syncSystem: () => {
      const state = get()
      const resolved = resolveTheme(state.theme, prefersDark())
      // 仅在跟随系统时系统配色才会改变生效主题；显式主题保持原样。
      if (state.theme === 'system') apply(resolved)
      if (resolved !== state.resolved) set({ resolved })
    },
  }))
}
