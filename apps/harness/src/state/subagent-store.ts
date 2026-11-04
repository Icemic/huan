/**
 * 子任务查看面板 feature Zustand 状态。
 *
 * 边界：
 * - 实例由 bootstrap 创建，只依赖注入的 client；不读取父会话缓存、不通过
 *   serviceStore 加载子记录，也不把子任务加入普通会话列表；
 * - 每次打开固定 parentId/taskId 与面板代次，关闭或切换后迟到响应不写回；
 * - 视图只在面板打开时按需读取；轮询由展示层在任务非终态期间驱动；
 * - 答案草稿只保存在当前面板内存，请求结算后清空，不持久化。
 */

import type {
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessSubagentClient,
  HarnessSubagentTaskView,
} from '@huan/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 单条子任务交互请求的答案草稿。 */
export interface SubagentAnswerDraft {
  text: string
  busy: boolean
  error: string | undefined
}

/** 子任务查看面板状态。 */
export interface SubagentFeatureState {
  open: boolean
  taskId: string | undefined
  parentId: string | undefined
  view: HarnessSubagentTaskView | undefined
  loading: boolean
  error: string | undefined
  /** 取消任务等面板级操作进行中。 */
  busy: boolean
  answers: Readonly<Record<string, SubagentAnswerDraft>>
  disposed: boolean

  /** 打开并读取指定子任务；重复打开会替换当前面板与代次。 */
  openTask: (parentId: string, taskId: string) => Promise<void>
  close: () => void
  /** 官方 Dialog 退出动画结束后清理只读视图，重开时不清理新任务。 */
  completeClose: () => void
  /** 重新读取当前任务；不改动父会话运行数据。 */
  refresh: () => Promise<void>
  /** 取消当前任务；成功后刷新一次，请求由服务端一并解除。 */
  cancelTask: () => Promise<void>
  /** 应答当前任务的 Host UI 请求；省略 response 时使用草稿文本。 */
  respond: (requestId: string, response?: HarnessHostUiResponse) => Promise<boolean>
  setAnswer: (requestId: string, text: string) => void
  dispose: () => void
}

export interface CreateSubagentFeatureStoreOptions {
  client: HarnessSubagentClient
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const answerDraftOf = (request: HarnessHostUiRequest): SubagentAnswerDraft => ({
  text: request.kind === 'editor' ? (request.prefill ?? '') : '',
  busy: false,
  error: undefined,
})

/** 按当前待答请求收敛草稿：保留同一请求已有输入，移除已结算请求。 */
const syncAnswers = (
  answers: Readonly<Record<string, SubagentAnswerDraft>>,
  requests: readonly HarnessHostUiRequest[],
): Readonly<Record<string, SubagentAnswerDraft>> => {
  const next: Record<string, SubagentAnswerDraft> = {}
  for (const request of requests) {
    next[request.id] = answers[request.id] ?? answerDraftOf(request)
  }
  return next
}

export const createSubagentFeatureStore = (
  options: CreateSubagentFeatureStoreOptions,
): StoreApi<SubagentFeatureState> => {
  // 面板代次与读取序号只在闭包中持有；关闭/换任务后旧结果不能覆盖新面板。
  let panelEpoch = 0
  let refreshRequest = 0

  return createStore<SubagentFeatureState>()((set, get) => {
    const isPanel = (epoch: number, parentId: string, taskId: string): boolean => {
      const state = get()
      return (
        !state.disposed &&
        state.open &&
        panelEpoch === epoch &&
        state.parentId === parentId &&
        state.taskId === taskId
      )
    }

    const readTask = async (
      epoch: number,
      parentId: string,
      taskId: string,
      request: number,
      initial: boolean,
    ): Promise<void> => {
      if (initial) set({ loading: true, error: undefined })
      try {
        const view = await options.client.getSubagentTask(parentId, taskId)
        if (refreshRequest !== request || !isPanel(epoch, parentId, taskId)) {
          return
        }
        set((state) => ({
          view,
          loading: false,
          error: undefined,
          answers: syncAnswers(state.answers, view.requests),
        }))
      } catch (error) {
        if (refreshRequest !== request || !isPanel(epoch, parentId, taskId)) {
          return
        }
        set({ loading: false, error: errorText(error) })
      }
    }

    return {
      open: false,
      taskId: undefined,
      parentId: undefined,
      view: undefined,
      loading: false,
      error: undefined,
      busy: false,
      answers: {},
      disposed: false,

      openTask: async (parentId, taskId) => {
        if (get().disposed) return
        const epoch = ++panelEpoch
        const request = ++refreshRequest
        set({
          open: true,
          parentId,
          taskId,
          view: undefined,
          loading: true,
          error: undefined,
          busy: false,
          answers: {},
        })
        await readTask(epoch, parentId, taskId, request, false)
      },

      close: () => {
        if (get().disposed) return
        panelEpoch += 1
        refreshRequest += 1
        // 保留正文供 Dialog 退出动画使用；下一次打开重置，答案立即清理。
        set({
          open: false,
          loading: false,
          error: undefined,
          busy: false,
          answers: {},
        })
      },

      completeClose: () => {
        if (!get().open) set({ parentId: undefined, taskId: undefined, view: undefined })
      },

      refresh: async () => {
        const state = get()
        if (state.disposed || !state.open || !state.parentId || !state.taskId) return
        const epoch = panelEpoch
        const parentId = state.parentId
        const taskId = state.taskId
        const request = ++refreshRequest
        // 已有视图时后台刷新不触发加载骨架，避免轮询打断阅读。
        await readTask(epoch, parentId, taskId, request, state.view === undefined)
      },

      cancelTask: async () => {
        const state = get()
        if (state.disposed || !state.open || !state.parentId || !state.taskId) return
        if (state.busy) return
        const epoch = panelEpoch
        const parentId = state.parentId
        const taskId = state.taskId
        set({ busy: true, error: undefined })
        try {
          await options.client.cancelSubagentTask(parentId, taskId)
          if (!isPanel(epoch, parentId, taskId)) return
          set({ busy: false })
          // 取消已受理；刷新让任务终态与服务端已解除的请求反映到面板。
          await get().refresh()
        } catch (error) {
          if (!isPanel(epoch, parentId, taskId)) return
          set({ busy: false, error: errorText(error) })
        }
      },

      respond: async (requestId, response) => {
        const state = get()
        if (state.disposed || !state.open || !state.parentId || !state.taskId || !state.view) {
          return false
        }
        const request = state.view.requests.find((item) => item.id === requestId)
        const draft = state.answers[requestId]
        if (!request || !draft || draft.busy) return false
        if (!response && (request.kind === 'confirm' || request.kind === 'select')) return false
        const parentId = state.parentId
        const taskId = state.taskId
        const epoch = panelEpoch
        const payload: HarnessHostUiResponse = response ?? { requestId, value: draft.text }
        set({
          answers: {
            ...state.answers,
            [requestId]: { ...draft, busy: true, error: undefined },
          },
        })
        try {
          await options.client.respondSubagentTask(parentId, taskId, payload)
          if (!isPanel(epoch, parentId, taskId)) return true
          set((current) => {
            const pending = current.answers[requestId]
            if (!pending) return {}
            return {
              answers: {
                ...current.answers,
                [requestId]: { ...pending, text: '', busy: false, error: undefined },
              },
            }
          })
          // 服务端随即移除请求；刷新确认最新状态，失败时保留已结算草稿。
          await get().refresh()
          return true
        } catch (error) {
          if (isPanel(epoch, parentId, taskId)) {
            set((current) => {
              const pending = current.answers[requestId]
              if (!pending) return {}
              return {
                answers: {
                  ...current.answers,
                  [requestId]: { ...pending, busy: false, error: errorText(error) },
                },
              }
            })
          }
          return false
        }
      },

      setAnswer: (requestId, text) => {
        const state = get()
        if (state.disposed) return
        const draft = state.answers[requestId]
        if (!draft || draft.busy) return
        set({
          answers: {
            ...state.answers,
            [requestId]: { ...draft, text, error: undefined },
          },
        })
      },

      dispose: () => {
        if (get().disposed) return
        panelEpoch += 1
        refreshRequest += 1
        set({
          open: false,
          taskId: undefined,
          parentId: undefined,
          view: undefined,
          loading: false,
          error: undefined,
          busy: false,
          answers: {},
          disposed: true,
        })
      },
    }
  })
}
