/**
 * 聊天展示 feature 状态：只保存折叠、应答回执与输入焦点等 UI 业务标志。
 *
 * 消息、工具执行与队列仍是 service/window store 的权威数据；本 store 不
 * 复制任何消息内容，也不能成为第二份投影。折叠键包含线程与消息来源，
 * 避免切换会话后同名下标互相影响。
 */

import { createStore, type StoreApi } from 'zustand/vanilla'

/** 聊天展示状态；动作稳定，供组件直接订阅。 */
export interface ChatFeatureState {
  /** 显式折叠状态；缺失表示使用该部分的默认值。 */
  collapsedParts: Readonly<Record<string, boolean>>
  /** 最近一次已应答的 Host UI 请求，用于焦点回执与可访问提示。 */
  lastAnsweredRequestId: string | undefined
  /** 每次递增表示请求把焦点交还输入框。 */
  composerFocusToken: number
  disposed: boolean

  /** 显式设置折叠状态；同一 key 后续保持不变。 */
  setPartOpen: (key: string, open: boolean) => void
  /** 在默认值与当前值之间切换。 */
  togglePart: (key: string, defaultOpen: boolean) => void
  /** 记录应答完成，并请求把焦点交还输入框。 */
  markRequestAnswered: (requestId: string) => void
  /** 仅请求焦点，不写入其他业务状态。 */
  requestComposerFocus: () => void
  dispose: () => void
}

/** 从状态读取某个部分的折叠值；没有显式值时使用调用方默认值。 */
export const partOpenOf = (
  state: Pick<ChatFeatureState, 'collapsedParts'>,
  key: string,
  defaultOpen: boolean,
): boolean => state.collapsedParts[key] ?? defaultOpen

export const createChatFeatureStore = (): StoreApi<ChatFeatureState> =>
  createStore<ChatFeatureState>()((set, get) => ({
    collapsedParts: {},
    lastAnsweredRequestId: undefined,
    composerFocusToken: 0,
    disposed: false,

    setPartOpen: (key, open) => {
      const state = get()
      if (state.disposed || state.collapsedParts[key] === open) return
      set({ collapsedParts: { ...state.collapsedParts, [key]: open } })
    },

    togglePart: (key, defaultOpen) => {
      const state = get()
      if (state.disposed) return
      set({
        collapsedParts: {
          ...state.collapsedParts,
          [key]: !partOpenOf(state, key, defaultOpen),
        },
      })
    },

    markRequestAnswered: (requestId) => {
      const state = get()
      if (state.disposed) return
      set({
        lastAnsweredRequestId: requestId,
        composerFocusToken: state.composerFocusToken + 1,
      })
    },

    requestComposerFocus: () => {
      const state = get()
      if (state.disposed) return
      set({ composerFocusToken: state.composerFocusToken + 1 })
    },

    dispose: () => {
      if (get().disposed) return
      set({
        collapsedParts: {},
        lastAnsweredRequestId: undefined,
        composerFocusToken: 0,
        disposed: true,
      })
    },
  }))
