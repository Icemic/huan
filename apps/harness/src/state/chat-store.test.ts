import { describe, expect, it } from 'vitest'
import { createChatFeatureStore, partOpenOf } from './chat-store'

describe('chat feature store（展示折叠与焦点）', () => {
  it('默认值不被显式状态污染，切换后保留用户选择', () => {
    const store = createChatFeatureStore()
    const key = 't1:pi-msg:0:tool:tc1'
    expect(partOpenOf(store.getState(), key, false)).toBe(false)
    store.getState().togglePart(key, false)
    expect(partOpenOf(store.getState(), key, false)).toBe(true)
    store.getState().setPartOpen(key, false)
    expect(partOpenOf(store.getState(), key, true)).toBe(false)
  })

  it('应答与焦点只递增本窗口 token，不写入消息或请求内容', () => {
    const store = createChatFeatureStore()
    const before = store.getState().composerFocusToken
    store.getState().markRequestAnswered('req-1')
    expect(store.getState().lastAnsweredRequestId).toBe('req-1')
    expect(store.getState().composerFocusToken).toBe(before + 1)
    store.getState().requestComposerFocus()
    expect(store.getState().composerFocusToken).toBe(before + 2)
  })

  it('dispose 后动作不再生效', () => {
    const store = createChatFeatureStore()
    store.getState().dispose()
    store.getState().setPartOpen('k', true)
    store.getState().requestComposerFocus()
    expect(store.getState().collapsedParts).toEqual({})
    expect(store.getState().composerFocusToken).toBe(0)
    expect(store.getState().disposed).toBe(true)
  })
})
