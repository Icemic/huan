import { describe, expect, it } from 'vitest'
import { type ComposerKeyInput, resolveComposerKey } from './composer-keydown'

const key = (overrides: Partial<ComposerKeyInput>): ComposerKeyInput => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  now: 1000,
  completionOpen: false,
  caretStart: 0,
  caretEnd: 0,
  valueLength: 0,
  ...overrides,
})

describe('composer 按键决策', () => {
  it('IME 组合中输入 Enter 不发送；compositionend 后的短暂 Enter 也不发送', () => {
    expect(resolveComposerKey(key({ isComposing: true }))).toEqual({ type: 'ignore' })
    expect(resolveComposerKey(key({ compositionEndedAt: 980, now: 1000 }))).toEqual({
      type: 'ignore',
    })
    expect(resolveComposerKey(key({ compositionEndedAt: 900, now: 1000 }))).toEqual({
      type: 'send',
      steer: false,
    })
  })

  it('Enter 发送、Shift+Enter 换行、Ctrl/Meta+Enter 转向发送', () => {
    expect(resolveComposerKey(key({ valueLength: 3, caretStart: 3, caretEnd: 3 }))).toEqual({
      type: 'send',
      steer: false,
    })
    expect(resolveComposerKey(key({ shiftKey: true }))).toEqual({ type: 'newline' })
    expect(resolveComposerKey(key({ ctrlKey: true }))).toEqual({ type: 'send', steer: true })
    expect(resolveComposerKey(key({ metaKey: true }))).toEqual({ type: 'send', steer: true })
  })

  it('补全打开时方向键移动、Enter/Tab 接受、Escape 关闭', () => {
    expect(resolveComposerKey(key({ completionOpen: true, key: 'ArrowDown' }))).toEqual({
      type: 'completion',
      delta: 1,
    })
    expect(resolveComposerKey(key({ completionOpen: true, key: 'ArrowUp' }))).toEqual({
      type: 'completion',
      delta: -1,
    })
    expect(resolveComposerKey(key({ completionOpen: true }))).toEqual({
      type: 'completion-accept',
    })
    expect(resolveComposerKey(key({ completionOpen: true, key: 'Tab' }))).toEqual({
      type: 'completion-accept',
    })
    expect(resolveComposerKey(key({ completionOpen: true, key: 'Escape' }))).toEqual({
      type: 'dismiss',
    })
  })

  it('已输入完整条目时 Enter 直接执行，未完整时先接受补全', () => {
    expect(resolveComposerKey(key({ completionOpen: true, completionExact: true }))).toEqual({
      type: 'send',
      steer: false,
    })
    expect(resolveComposerKey(key({ completionOpen: true, completionExact: false }))).toEqual({
      type: 'completion-accept',
    })
  })

  it('仅在文本边界浏览历史，普通方向键不抢占光标', () => {
    expect(
      resolveComposerKey(key({ key: 'ArrowUp', valueLength: 5, caretStart: 0, caretEnd: 0 })),
    ).toEqual({ type: 'history', direction: 'up' })
    expect(
      resolveComposerKey(key({ key: 'ArrowUp', valueLength: 5, caretStart: 2, caretEnd: 2 })),
    ).toEqual({ type: 'ignore' })
    expect(
      resolveComposerKey(key({ key: 'ArrowDown', valueLength: 5, caretStart: 5, caretEnd: 5 })),
    ).toEqual({ type: 'history', direction: 'down' })
    expect(
      resolveComposerKey(key({ key: 'ArrowDown', valueLength: 5, caretStart: 1, caretEnd: 1 })),
    ).toEqual({ type: 'ignore' })
  })
})
