/**
 * 主题的纯解析与 DOM 应用。
 *
 * 业务选择与订阅在应用主题 Zustand store；这里只保留可测试的解析规则和
 * 文档 class 写入，不持有模块级监听器或当前主题。
 */

/** 应用主题：仅保存在浏览器 localStorage，不写入 Pi 配置或工作区元数据。 */
export type AppTheme = 'system' | 'light' | 'dark' | 'one-dark' | 'solarized-light'

/** 实际生效的明暗/配色主题。 */
export type ResolvedAppTheme = Exclude<AppTheme, 'system'>

const DARK_CLASS = 'dark'
const THEME_CLASSES = ['dark', 'one-dark', 'solarized-light'] as const

/** 存储接口只暴露主题需要的读取与写入。 */
export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 文档 class 写入接口；bootstrap 传真实 document，测试可注入替身。 */
export interface ThemeDocument {
  documentElement: {
    classList: {
      toggle(name: string, force?: boolean): unknown
    }
  }
}

export const THEME_STORAGE_KEY = 'huan.theme'

const isAppTheme = (value: string): value is AppTheme =>
  value === 'system' ||
  value === 'light' ||
  value === 'dark' ||
  value === 'one-dark' ||
  value === 'solarized-light'

/** 从存储读取主题；缺失、损坏或存储不可用时回退 system。 */
export const readStoredTheme = (storage: ThemeStorage | null | undefined): AppTheme => {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY)
    return value && isAppTheme(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

/** 写入主题选择；存储不可用只影响跨刷新恢复。 */
export const writeStoredTheme = (
  storage: ThemeStorage | null | undefined,
  theme: AppTheme,
): void => {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 存储不可用时仍应用本次主题。
  }
}

/** 解析实际生效的主题；one-dark 同时需要 dark 类以启用暗色变体。 */
export const resolveTheme = (theme: AppTheme, prefersDark: boolean): ResolvedAppTheme => {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

/** 把生效主题写到文档根节点；只处理 class，不保存业务选择。 */
export const applyThemeToDocument = (
  theme: ResolvedAppTheme,
  doc: ThemeDocument | undefined,
): void => {
  if (!doc) return
  const classes = new Set<string>()
  if (theme === 'dark' || theme === 'one-dark') classes.add(DARK_CLASS)
  if (theme === 'one-dark') classes.add('one-dark')
  if (theme === 'solarized-light') classes.add('solarized-light')
  for (const className of THEME_CLASSES) {
    doc.documentElement.classList.toggle(className, classes.has(className))
  }
}
