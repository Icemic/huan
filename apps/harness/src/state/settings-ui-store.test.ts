import { describe, expect, it, vi } from 'vitest'
import { createSettingsUiStore } from './settings-ui-store'

describe('settings UI：统一设置导航', () => {
  it('默认关闭并打开指定页；同页命令保留一次性定位', () => {
    const onChange = vi.fn()
    const store = createSettingsUiStore({ onChange })
    expect(store.getState().open).toBe(false)
    expect(store.getState().page).toBe('appearance')

    store.getState().openPage('models', { providerId: 'provider-a', mode: 'login' })
    expect(store.getState().open).toBe(true)
    expect(store.getState().page).toBe('models')
    expect(onChange).toHaveBeenLastCalledWith('models', 'appearance', {
      wasOpen: false,
      focus: { providerId: 'provider-a', mode: 'login' },
    })

    store.getState().openPage('models')
    expect(onChange).toHaveBeenLastCalledWith('models', 'models', {
      wasOpen: true,
      focus: undefined,
    })
  })

  it('关闭只通知一次并保留最后页签；重复关闭不触发清理', () => {
    const onClose = vi.fn()
    const store = createSettingsUiStore({ onClose })
    store.getState().openPage('mcp')
    store.getState().close()
    expect(store.getState().open).toBe(false)
    expect(store.getState().page).toBe('mcp')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('mcp')

    store.getState().close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
