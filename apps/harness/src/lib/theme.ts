/** 应用主题：仅保存在浏览器 localStorage，不写入 Pi 配置或工作区元数据。 */
export type AppTheme = 'system' | 'light' | 'dark' | 'one-dark' | 'solarized-light'

const STORAGE_KEY = 'huan.theme'
const DARK_CLASS = 'dark'
const THEME_CLASSES = ['dark', 'one-dark', 'solarized-light'] as const

const listeners = new Set<() => void>()
let current: AppTheme | undefined
let initialized = false

const isAppTheme = (value: string): value is AppTheme =>
  value === 'system' ||
  value === 'light' ||
  value === 'dark' ||
  value === 'one-dark' ||
  value === 'solarized-light'

const readStoredTheme = (): AppTheme => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value && isAppTheme(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

/** 解析实际生效的明暗主题；one-dark 同时需要 dark 类以启用暗色变体。 */
export function resolveTheme(theme: AppTheme, prefersDark: boolean): Exclude<AppTheme, 'system'> {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

const applyTheme = (theme: AppTheme) => {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(
    theme,
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const classes = new Set<string>()
  if (resolved === 'dark' || resolved === 'one-dark') classes.add(DARK_CLASS)
  if (resolved === 'one-dark') classes.add('one-dark')
  if (resolved === 'solarized-light') classes.add('solarized-light')
  for (const className of THEME_CLASSES) {
    document.documentElement.classList.toggle(className, classes.has(className))
  }
}

const notify = () => {
  for (const listener of [...listeners]) listener()
}

/** 读取当前主题（同步；供 useSyncExternalStore 与启动初始化使用）。 */
export const getTheme = (): AppTheme => {
  current ??= readStoredTheme()
  return current
}

/** 切换并持久化主题；主题变化只影响当前浏览器。 */
export const setTheme = (theme: AppTheme): void => {
  current = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 存储不可用时仍应用本次主题，只是无法跨刷新恢复。
  }
  applyTheme(theme)
  notify()
}

/** 订阅主题变化（React 组件用）。 */
export const subscribeTheme = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 在首次渲染前应用主题，避免暗色页面闪白。 */
export const initTheme = (): void => {
  if (initialized) return
  initialized = true
  const theme = getTheme()
  applyTheme(theme)
  if (typeof window === 'undefined') return
  // 跟随系统时，操作系统主题变化要即时重算，但不必改写用户选择。
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme('system')
  })
}
