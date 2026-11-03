/**
 * 输入框按键决策（纯函数）：IME、发送/转向、补全、历史与菜单关闭。
 *
 * 展示组件只负责把动作落到 DOM/store；这里不读取状态，便于覆盖中文输入法
 * 与多键组合的边界。组合输入结束后的短暂 Enter 也按 IME 处理，避免拼音
 * 上屏被误当成发送。
 */

/** 输入框按键上下文。 */
export interface ComposerKeyInput {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** 原生 isComposing 或组件维护的组合输入标志。 */
  isComposing: boolean
  /** 最近一次 compositionend 的时间；缺失表示没有刚结束的组合输入。 */
  compositionEndedAt?: number
  /** 当前时间（毫秒），由调用方传入以便测试。 */
  now: number
  completionOpen: boolean
  /** 当前高亮补全与已输入文本完全一致（例如整条命令名），Enter 直接执行。 */
  completionExact?: boolean
  caretStart: number
  caretEnd: number
  valueLength: number
}

/** 输入框动作；ignore 允许浏览器默认行为。 */
export type ComposerKeyAction =
  | { type: 'ignore' }
  | { type: 'newline' }
  | { type: 'send'; steer: boolean }
  | { type: 'completion'; delta: 1 | -1 }
  | { type: 'completion-accept' }
  | { type: 'history'; direction: 'up' | 'down' }
  | { type: 'dismiss' }

const IGNORE: ComposerKeyAction = { type: 'ignore' }
/** compositionend 后短窗口内的 Enter 不发送。 */
const COMPOSITION_ENTER_GUARD_MS = 50

export const resolveComposerKey = (input: ComposerKeyInput): ComposerKeyAction => {
  const combined = input.ctrlKey || input.metaKey
  const recentCompositionEnd =
    input.compositionEndedAt !== undefined &&
    input.now - input.compositionEndedAt < COMPOSITION_ENTER_GUARD_MS
  if (input.isComposing || (recentCompositionEnd && input.key === 'Enter')) return IGNORE

  if (input.key === 'Escape') return { type: 'dismiss' }

  if (combined && input.key === 'Enter') {
    return { type: 'send', steer: true }
  }

  if (input.completionOpen) {
    if (input.key === 'ArrowDown') return { type: 'completion', delta: 1 }
    if (input.key === 'ArrowUp') return { type: 'completion', delta: -1 }
    // 已经输入完整条目时 Enter 直接执行，不再要求先接受补全。
    if (input.key === 'Enter' && input.completionExact === true) {
      return { type: 'send', steer: false }
    }
    if (input.key === 'Enter' || input.key === 'Tab') return { type: 'completion-accept' }
    return IGNORE
  }

  if (input.key === 'Enter') {
    return input.shiftKey ? { type: 'newline' } : { type: 'send', steer: false }
  }

  if (input.key === 'ArrowUp' && !input.altKey && !input.shiftKey) {
    if (input.caretStart === 0 && input.caretEnd === 0) return { type: 'history', direction: 'up' }
  }
  if (input.key === 'ArrowDown' && !input.altKey && !input.shiftKey) {
    if (input.caretStart === input.valueLength && input.caretEnd === input.valueLength) {
      return { type: 'history', direction: 'down' }
    }
  }
  return IGNORE
}
