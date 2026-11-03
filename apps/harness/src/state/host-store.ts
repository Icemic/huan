/**
 * 宿主业务 Zustand 状态：启动期 Host 交互、会话级待答请求与宿主信息刷新。
 *
 * 数据来源（见 R1 §3）：
 * - Host 级交互安全快照只在公共 serviceStore；
 * - 会话级 Host UI 请求与状态来自 `sessionDataById[threadId]`；
 * - 本 store 只保存按 requestId 的短期答案、忙/错误与忽略的通知；
 * - 原始请求类型保持 confirm/select/input/editor，不转换成 approval；
 * - 关闭面板不终止宿主请求，重新挂载以权威快照恢复。
 */

import type {
  HarnessHostInteractionRequest,
  HarnessHostInteractionSnapshot,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
} from '@huan/protocol'
import type { HarnessBrowser } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** Host 级请求答案草稿。 */
export interface HostInteractionDraft {
  text: string
  busy: boolean
  error: string | undefined
}

/** 会话级请求答案草稿。 */
export interface ThreadRequestDraft {
  threadId: string
  text: string
  busy: boolean
  error: string | undefined
}

/** Host feature 状态。 */
export interface HostFeatureState {
  /** 按 requestId 索引的 Host 级答案；editor 初值来自 prefill。 */
  interactionDrafts: Readonly<Record<string, HostInteractionDraft>>
  /** 已忽略的 Host 级通知 ID；快照变化时按当前通知列表收敛。 */
  dismissedNotifications: ReadonlySet<string>
  /** 按 `${threadId}:${requestId}` 索引的会话级答案。 */
  threadAnswers: Readonly<Record<string, ThreadRequestDraft>>
  refreshing: boolean
  disposed: boolean

  /** 重新读取宿主信息；协议不匹配由 serviceStore 记录受控错误。 */
  refreshHostInfo: () => Promise<void>
  setInteractionAnswer: (requestId: string, text: string) => void
  /** 应答 Host 级请求；respond 省略时使用当前草稿（input/editor）。 */
  respondInteraction: (requestId: string, respond?: HarnessHostUiResponse) => Promise<boolean>
  dismissNotification: (id: string) => void
  /** 根据当前会话的待答请求初始化/清理草稿；保留同 requestId 已有答案。 */
  syncThreadRequests: (threadId: string, requests: readonly HarnessHostUiRequest[]) => void
  setThreadAnswer: (threadId: string, requestId: string, text: string) => void
  /** 应答会话级请求；工具关联请求同样可在此应答。 */
  respondThreadRequest: (
    threadId: string,
    requestId: string,
    respond?: HarnessHostUiResponse,
  ) => Promise<boolean>
  dispose: () => void
}

export interface CreateHostFeatureStoreOptions {
  browser: HarnessBrowser
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 会话级答案键；导出供展示层保持同一规则。 */
export const threadAnswerKey = (threadId: string, requestId: string): string =>
  `${threadId}:${requestId}`

const interactionDraftOf = (request: HarnessHostInteractionRequest): HostInteractionDraft => ({
  text: request.kind === 'editor' ? (request.prefill ?? '') : '',
  busy: false,
  error: undefined,
})

const threadRequestDraftOf = (
  threadId: string,
  request: HarnessHostUiRequest,
): ThreadRequestDraft => ({
  threadId,
  text: request.kind === 'editor' ? (request.prefill ?? '') : '',
  busy: false,
  error: undefined,
})

/** 从 Host 级快照收敛答案与忽略集合；已有请求保留用户输入。 */
const syncInteractionState = (
  state: HostFeatureState,
  snapshot: HarnessHostInteractionSnapshot | undefined,
): Pick<HostFeatureState, 'interactionDrafts' | 'dismissedNotifications'> => {
  const drafts: Record<string, HostInteractionDraft> = {}
  for (const request of snapshot?.requests ?? []) {
    drafts[request.id] = state.interactionDrafts[request.id] ?? interactionDraftOf(request)
  }
  const notificationIds = new Set((snapshot?.notifications ?? []).map((item) => item.id))
  const dismissedNotifications = new Set(
    [...state.dismissedNotifications].filter((id) => notificationIds.has(id)),
  )
  return { interactionDrafts: drafts, dismissedNotifications }
}

export const createHostFeatureStore = (
  options: CreateHostFeatureStoreOptions,
): StoreApi<HostFeatureState> => {
  const { browser } = options
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let lastAuthRevision = browser.serviceStore.getState().providerAuth?.authRevision

  const store = createStore<HostFeatureState>()((set, get) => ({
    interactionDrafts: {},
    dismissedNotifications: new Set(),
    threadAnswers: {},
    refreshing: false,
    disposed: false,

    refreshHostInfo: async () => {
      const state = get()
      if (state.disposed || state.refreshing) return
      set({ refreshing: true })
      try {
        // 手动重新查询必须绕过在途/缓存结果，拿到宿主当前值。
        await browser.serviceStore.getState().loadHostInfo({ force: true })
      } finally {
        if (!get().disposed) set({ refreshing: false })
      }
    },

    setInteractionAnswer: (requestId, text) => {
      const state = get()
      if (state.disposed) return
      const draft = state.interactionDrafts[requestId]
      if (!draft) return
      set({
        interactionDrafts: {
          ...state.interactionDrafts,
          [requestId]: { ...draft, text, error: undefined },
        },
      })
    },

    respondInteraction: async (requestId, respond) => {
      const state = get()
      if (state.disposed) return false
      const request = browser.serviceStore
        .getState()
        .hostInteractions?.requests.find((item) => item.id === requestId)
      const draft = state.interactionDrafts[requestId]
      if (!request || !draft || draft.busy) return false
      if (!respond && (request.kind === 'confirm' || request.kind === 'select')) return false
      const response: HarnessHostUiResponse = respond ?? { requestId, value: draft.text }
      set({
        interactionDrafts: {
          ...state.interactionDrafts,
          [requestId]: { ...draft, busy: true, error: undefined },
        },
      })
      try {
        const result = await browser.client.respondToHostInteraction(response)
        if (get().disposed) return result.accepted
        if (!result.accepted) {
          set({
            interactionDrafts: {
              ...get().interactionDrafts,
              [requestId]: {
                ...(get().interactionDrafts[requestId] ?? draft),
                busy: false,
                error: '该请求已结束或应答无效。',
              },
            },
          })
          return false
        }
        // 服务端快照会移除请求；先清空已提交的正文，避免短期值残留。
        set({
          interactionDrafts: {
            ...get().interactionDrafts,
            [requestId]: {
              ...(get().interactionDrafts[requestId] ?? draft),
              text: '',
              busy: false,
              error: undefined,
            },
          },
        })
        return true
      } catch (error) {
        if (!get().disposed) {
          set({
            interactionDrafts: {
              ...get().interactionDrafts,
              [requestId]: {
                ...(get().interactionDrafts[requestId] ?? draft),
                busy: false,
                error: errorText(error),
              },
            },
          })
        }
        return false
      }
    },

    dismissNotification: (id) => {
      const state = get()
      if (state.disposed) return
      const dismissedNotifications = new Set(state.dismissedNotifications)
      dismissedNotifications.add(id)
      set({ dismissedNotifications })
    },

    syncThreadRequests: (threadId, requests) => {
      const state = get()
      if (state.disposed) return
      const keys = new Set(requests.map((request) => threadAnswerKey(threadId, request.id)))
      const threadAnswers: Record<string, ThreadRequestDraft> = {}
      for (const [key, draft] of Object.entries(state.threadAnswers)) {
        // 切走会话时丢弃其短期答案；同会话保留仍存在的请求输入。
        if (draft.threadId !== threadId) continue
        if (keys.has(key)) {
          threadAnswers[key] = draft
        }
      }
      for (const request of requests) {
        const key = threadAnswerKey(threadId, request.id)
        threadAnswers[key] = state.threadAnswers[key] ?? threadRequestDraftOf(threadId, request)
      }
      set({ threadAnswers })
    },

    setThreadAnswer: (threadId, requestId, text) => {
      const state = get()
      if (state.disposed) return
      const key = threadAnswerKey(threadId, requestId)
      const draft = state.threadAnswers[key]
      if (!draft) return
      set({
        threadAnswers: {
          ...state.threadAnswers,
          [key]: { ...draft, text, error: undefined },
        },
      })
    },

    respondThreadRequest: async (threadId, requestId, respond) => {
      const state = get()
      if (state.disposed) return false
      const key = threadAnswerKey(threadId, requestId)
      const draft = state.threadAnswers[key]
      if (!draft || draft.busy) return false
      const request = browser.serviceStore
        .getState()
        .sessionDataById[threadId]?.hostUiRequests.find((item) => item.id === requestId)
      if (!respond && (!request || request.kind === 'confirm' || request.kind === 'select')) {
        return false
      }
      const response: HarnessHostUiResponse = respond ?? { requestId, value: draft.text }
      set({
        threadAnswers: {
          ...state.threadAnswers,
          [key]: { ...draft, busy: true, error: undefined },
        },
      })
      try {
        await browser.client.respondToHostUiRequest(threadId, response)
        if (get().disposed) return true
        set({
          threadAnswers: {
            ...get().threadAnswers,
            [key]: {
              ...(get().threadAnswers[key] ?? draft),
              text: '',
              busy: false,
              error: undefined,
            },
          },
        })
        return true
      } catch (error) {
        if (!get().disposed) {
          set({
            threadAnswers: {
              ...get().threadAnswers,
              [key]: {
                ...(get().threadAnswers[key] ?? draft),
                busy: false,
                error: errorText(error),
              },
            },
          })
        }
        return false
      }
    },

    dispose: () => {
      if (get().disposed) return
      disposed = true
      unsubscribe?.()
      unsubscribe = undefined
      set({
        interactionDrafts: {},
        dismissedNotifications: new Set(),
        threadAnswers: {},
        refreshing: false,
        disposed: true,
      })
    },
  }))

  // 首次创建按当前权威快照补齐答案草稿；之后只处理快照变化。
  store.setState((state) => ({
    ...state,
    ...syncInteractionState(state, browser.serviceStore.getState().hostInteractions),
  }))

  unsubscribe = browser.serviceStore.subscribe((state, previous) => {
    if (disposed) return
    if (state.hostInteractions !== previous.hostInteractions) {
      store.setState((current) => ({
        ...current,
        ...syncInteractionState(current, state.hostInteractions),
      }))
    }
    const revision = state.providerAuth?.authRevision
    if (revision !== lastAuthRevision) {
      lastAuthRevision = revision
      // 登录/退出后重新读取宿主 readiness 与默认模型；模型目录由 serviceStore
      // 的 authRevision 键在下次查询时更新。
      void store.getState().refreshHostInfo()
    }
  })

  return store
}
