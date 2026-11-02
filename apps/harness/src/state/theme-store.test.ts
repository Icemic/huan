import { describe, expect, it, vi } from 'vitest'
import {
  applyThemeToDocument,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeDocument,
} from '../lib/theme'
import { createThemeStore } from './theme-store'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('theme-store：选择、持久化与系统配色投影', () => {
  it('从存储恢复选择，切换时持久化并只应用一次', () => {
    const storage = memoryStorage()
    storage.setItem(THEME_STORAGE_KEY, 'one-dark')
    const applied: string[] = []
    const store = createThemeStore({
      storage,
      prefersDark: () => true,
      apply: (theme) => applied.push(theme),
    })

    expect(store.getState().theme).toBe('one-dark')
    expect(store.getState().resolved).toBe('one-dark')

    store.getState().setTheme('light')
    expect(store.getState().theme).toBe('light')
    expect(store.getState().resolved).toBe('light')
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(applied).toEqual(['light'])

    store.getState().setTheme('light')
    expect(applied).toEqual(['light'])
  })

  it('跟随系统时系统配色变化重算，不覆盖用户选择', () => {
    let prefersDark = true
    const applied: string[] = []
    const store = createThemeStore({
      storage: memoryStorage(),
      prefersDark: () => prefersDark,
      apply: (theme) => applied.push(theme),
    })

    expect(store.getState().theme).toBe('system')
    expect(store.getState().resolved).toBe('dark')

    prefersDark = false
    store.getState().syncSystem()
    expect(store.getState().theme).toBe('system')
    expect(store.getState().resolved).toBe('light')
    expect(applied).toEqual(['light'])

    store.getState().setTheme('dark')
    prefersDark = true
    store.getState().syncSystem()
    // 显式主题不因系统配色变化而改变。
    expect(store.getState().resolved).toBe('dark')
    expect(applied).toEqual(['light', 'dark'])
  })
})

describe('theme-dom：生效主题写入文档 class', () => {
  const createDocument = () => {
    const classes = new Map<string, boolean>()
    const doc: ThemeDocument = {
      documentElement: {
        classList: {
          toggle: (name, force) => {
            classes.set(name, Boolean(force))
            return Boolean(force)
          },
        },
      },
    }
    return { classes, doc }
  }

  it('dark 与 one-dark 启用 dark 类，solarized-light 使用独立类', () => {
    const { classes, doc } = createDocument()
    applyThemeToDocument('dark', doc)
    expect(Object.fromEntries(classes)).toMatchObject({
      dark: true,
      'one-dark': false,
      'solarized-light': false,
    })

    applyThemeToDocument('one-dark', doc)
    expect(classes.get('dark')).toBe(true)
    expect(classes.get('one-dark')).toBe(true)

    applyThemeToDocument('solarized-light', doc)
    expect(classes.get('dark')).toBe(false)
    expect(classes.get('one-dark')).toBe(false)
    expect(classes.get('solarized-light')).toBe(true)
  })

  it('解析主题只把 system 委托给系统配色', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('solarized-light', true)).toBe('solarized-light')
  })
})

describe('theme-store：损坏存储回退', () => {
  it('未知主题值回退 system，不抛错', () => {
    const storage = memoryStorage()
    storage.setItem(THEME_STORAGE_KEY, 'broken-theme')
    const apply = vi.fn()
    const store = createThemeStore({ storage, prefersDark: () => false, apply })
    expect(store.getState().theme).toBe('system')
    expect(store.getState().resolved).toBe('light')
    expect(apply).not.toHaveBeenCalled()
  })
})
