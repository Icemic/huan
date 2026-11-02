/**
 * provider 认证 feature Zustand 状态：面板视图、短期回填与操作忙状态。
 *
 * 安全边界（见 R1 §3.2/§5.4）：
 * - 认证权威快照只在公共 serviceStore；本 store 不保存凭据或快照副本；
 * - 回填值只按 operationId+promptId 保存在内存，提交时先清空再请求，
 *   关闭面板、提示切换、操作结束都会清空；不持久化、不写日志；
 * - 关闭面板不取消远端登录；只有显式“取消认证”才发送取消；
 * - 授权链接由用户点击打开，不自动拉起浏览器；退出只移除本地已存凭据。
 */

import type {
  HarnessProviderAuthCancelResult,
  HarnessProviderAuthMethod,
  HarnessProviderAuthPrompt,
  HarnessProviderAuthSnapshot,
  HarnessProviderAuthStartResult,
} from '@huan/protocol'
import type { HarnessBrowser } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 认证面板打开方式；由 `/login`、`/logout` 与手动入口共用。 */
export type AuthPanelMode = 'login' | 'logout'

export interface AuthOpenOptions {
  providerId?: string
  mode?: AuthPanelMode
}

/** provider 认证 feature 状态。 */
export interface AuthFeatureState {
  open: boolean
  /** 打开时聚焦的 provider；仅展示用，不构成权限。 */
  focusedProvider: string | undefined
  mode: AuthPanelMode | undefined
  notice: string | undefined
  /** 按 `${operationId}|${promptId}` 保存的短期回填；提交即清空。 */
  answers: Readonly<Record<string, string>>
  /** 正在提交的提示键；同一时间只允许一个回填请求。 */
  submitting: string | undefined
  /** 按 providerId 记录本地正在启动的登录/退出，服务端状态仍以快照为准。 */
  providerBusy: Readonly<Record<string, 'login' | 'logout'>>
  /** 正在请求取消的操作；服务端结算前保持可见。 */
  cancelling: Readonly<Record<string, boolean>>
  disposed: boolean

  openPanel: (options?: AuthOpenOptions) => Promise<void>
  closePanel: () => void
  refresh: () => Promise<void>
  startLogin: (providerId: string, method: HarnessProviderAuthMethod) => Promise<void>
  logout: (providerId: string) => Promise<void>
  cancel: (operationId: string) => Promise<void>
  setAnswer: (operationId: string, promptId: string, value: string) => void
  /** 提交当前提示；值先清空再进入请求。 */
  submitPrompt: (operationId: string, prompt: HarnessProviderAuthPrompt) => Promise<void>
  /** 本窗口受控提示（如复制设备码结果）；不保存凭据。 */
  setNotice: (message: string | undefined) => void
  clearNotice: () => void
  dispose: () => void
}

export interface CreateAuthFeatureStoreOptions {
  browser: HarnessBrowser
}

const answerKey = (operationId: string, promptId: string): string => `${operationId}|${promptId}`

const startResultNotice = (
  result: HarnessProviderAuthStartResult,
  action: 'login' | 'logout',
  providerName: string,
): string => {
  switch (result.status) {
    case 'started':
      return action === 'login'
        ? `已开始 ${providerName} 的登录流程。关闭面板不会终止登录。`
        : `已开始 ${providerName} 的退出流程。`
    case 'busy':
      return '该 provider 已有进行中的认证操作，请先完成或取消。'
    case 'invalid':
      return result.message
  }
}

/** 活跃操作集合：终态操作不再需要保留回填/取消忙状态。 */
const activeOperationIds = (snapshot: HarnessProviderAuthSnapshot | undefined): Set<string> => {
  const ids = new Set<string>()
  for (const operation of snapshot?.operations ?? []) {
    if (
      operation.phase !== 'succeeded' &&
      operation.phase !== 'failed' &&
      operation.phase !== 'cancelled'
    ) {
      ids.add(operation.id)
    }
  }
  return ids
}

/** 当前仍可回答的提示键；用于清理过期回填。 */
const activePromptKeys = (snapshot: HarnessProviderAuthSnapshot | undefined): Set<string> => {
  const keys = new Set<string>()
  for (const operation of snapshot?.operations ?? []) {
    if (!operation.prompt) continue
    if (
      operation.phase !== 'succeeded' &&
      operation.phase !== 'failed' &&
      operation.phase !== 'cancelled'
    ) {
      keys.add(answerKey(operation.id, operation.prompt.promptId))
    }
  }
  return keys
}

const cancelResultNotice = (result: HarnessProviderAuthCancelResult): string => {
  switch (result.status) {
    case 'cancelling':
      return '正在取消认证操作…'
    case 'finished':
      return '该认证操作已经结束，取消未生效。'
    case 'not-found':
      return '该认证操作已不存在。'
  }
}

export const createAuthFeatureStore = (
  options: CreateAuthFeatureStoreOptions,
): StoreApi<AuthFeatureState> => {
  const { browser } = options
  let unsubscribe: (() => void) | undefined

  const store = createStore<AuthFeatureState>()((set, get) => {
    const currentSnapshot = (): HarnessProviderAuthSnapshot | undefined =>
      browser.serviceStore.getState().providerAuth

    return {
      open: false,
      focusedProvider: undefined,
      mode: undefined,
      notice: undefined,
      answers: {},
      submitting: undefined,
      providerBusy: {},
      cancelling: {},
      disposed: false,

      openPanel: async (openOptions) => {
        if (get().disposed) return
        const mode = openOptions?.mode
        set({
          open: true,
          focusedProvider: openOptions?.providerId,
          mode,
          notice:
            mode === 'logout'
              ? '请在该 provider 行内选择“退出登录”。'
              : mode === 'login'
                ? '请选择该 provider 的登录方式。'
                : undefined,
          // 重新打开不接受上次关闭前残留的回填；进行中的提示由用户重新输入。
          answers: {},
          submitting: undefined,
        })
        await get().refresh()
      },

      closePanel: () => {
        if (get().disposed) return
        // 关闭不取消远端操作；只清空本窗口短期输入与提示。
        set({
          open: false,
          focusedProvider: undefined,
          mode: undefined,
          notice: undefined,
          answers: {},
          submitting: undefined,
        })
      },

      refresh: async () => {
        if (get().disposed) return
        try {
          await browser.serviceStore.getState().refreshProviderAuth()
        } catch {
          set({ notice: '无法读取认证状态，请检查宿主连接。' })
        }
      },

      startLogin: async (providerId, method) => {
        const state = get()
        if (state.disposed || state.providerBusy[providerId]) return
        const provider = currentSnapshot()?.providers.find((item) => item.providerId === providerId)
        const providerName = provider?.name ?? providerId
        set({
          providerBusy: { ...state.providerBusy, [providerId]: 'login' },
          notice: undefined,
        })
        try {
          const result = await browser.client.startProviderLogin({ providerId, method })
          if (get().disposed) return
          set({ notice: startResultNotice(result, 'login', providerName) })
          await get().refresh()
        } catch {
          if (!get().disposed) set({ notice: '操作失败，请检查宿主连接后重试。' })
        } finally {
          const current = get()
          if (!current.disposed) {
            const providerBusy = { ...current.providerBusy }
            delete providerBusy[providerId]
            set({ providerBusy })
          }
        }
      },

      logout: async (providerId) => {
        const state = get()
        if (state.disposed || state.providerBusy[providerId]) return
        const provider = currentSnapshot()?.providers.find((item) => item.providerId === providerId)
        const providerName = provider?.name ?? providerId
        set({
          providerBusy: { ...state.providerBusy, [providerId]: 'logout' },
          notice: undefined,
        })
        try {
          const result = await browser.client.logoutProvider(providerId)
          if (get().disposed) return
          set({ notice: startResultNotice(result, 'logout', providerName) })
          await get().refresh()
        } catch {
          if (!get().disposed) set({ notice: '操作失败，请检查宿主连接后重试。' })
        } finally {
          const current = get()
          if (!current.disposed) {
            const providerBusy = { ...current.providerBusy }
            delete providerBusy[providerId]
            set({ providerBusy })
          }
        }
      },

      cancel: async (operationId) => {
        const state = get()
        if (state.disposed || state.cancelling[operationId]) return
        set({
          cancelling: { ...state.cancelling, [operationId]: true },
          notice: undefined,
        })
        try {
          const result = await browser.client.cancelProviderAuth(operationId)
          if (get().disposed) return
          set({ notice: cancelResultNotice(result) })
          await get().refresh()
        } catch {
          if (!get().disposed) set({ notice: '取消认证失败，请检查宿主连接。' })
        } finally {
          const current = get()
          if (!current.disposed) {
            const cancelling = { ...current.cancelling }
            delete cancelling[operationId]
            set({ cancelling })
          }
        }
      },

      setAnswer: (operationId, promptId, value) => {
        const state = get()
        if (state.disposed) return
        const key = answerKey(operationId, promptId)
        set({ answers: { ...state.answers, [key]: value }, notice: undefined })
      },

      submitPrompt: async (operationId, prompt) => {
        const state = get()
        if (state.disposed || state.submitting) return
        const key = answerKey(operationId, prompt.promptId)
        const value = state.answers[key] ?? ''
        // 先清空本地回填，再发起请求；任何错误文案都不回显提交值。
        const answers = { ...state.answers }
        delete answers[key]
        set({ answers, submitting: key, notice: undefined })
        try {
          const result = await browser.client.respondProviderAuthPrompt({
            operationId,
            promptId: prompt.promptId,
            value,
          })
          if (get().disposed) return
          if (result.status === 'stale') {
            set({ notice: '该认证提示已失效，请查看最新状态后重新操作。' })
          } else if (result.status === 'invalid') {
            set({ notice: result.message })
          }
          await get().refresh()
        } catch {
          if (!get().disposed) set({ notice: '提交认证输入失败，请检查宿主连接后重试。' })
        } finally {
          if (!get().disposed) set({ submitting: undefined })
        }
      },

      setNotice: (message) => {
        if (get().disposed) return
        set({ notice: message })
      },

      clearNotice: () => {
        if (get().disposed) return
        set({ notice: undefined })
      },

      dispose: () => {
        if (get().disposed) return
        unsubscribe?.()
        unsubscribe = undefined
        set({
          open: false,
          focusedProvider: undefined,
          mode: undefined,
          notice: undefined,
          answers: {},
          submitting: undefined,
          providerBusy: {},
          cancelling: {},
          disposed: true,
        })
      },
    }
  })

  // 只监听公共 serviceStore 的安全快照变化，用于清理过期短期回填；
  // 不复制快照、不发起第二套轮询。
  pruneSnapshot(store, browser.serviceStore.getState().providerAuth)
  unsubscribe = browser.serviceStore.subscribe((state, previous) => {
    if (state.providerAuth === previous.providerAuth) return
    pruneSnapshot(store, state.providerAuth)
  })

  return store
}

/** 从 serviceStore 快照清理本 store 的短期状态（供创建时与订阅共用）。 */
const pruneSnapshot = (
  store: StoreApi<AuthFeatureState>,
  snapshot: HarnessProviderAuthSnapshot | undefined,
): void => {
  const state = store.getState()
  if (state.disposed) return
  const prompts = activePromptKeys(snapshot)
  const active = activeOperationIds(snapshot)
  const answers = Object.fromEntries(
    Object.entries(state.answers).filter(([key]) => prompts.has(key)),
  )
  const cancelling = Object.fromEntries(
    Object.entries(state.cancelling).filter(([operationId]) => active.has(operationId)),
  )
  const submitting =
    state.submitting !== undefined && prompts.has(state.submitting) ? state.submitting : undefined
  // providerBusy 是本地启动请求的生命周期，由操作 finally 清理；不被快照提前清掉。
  store.setState({ answers, cancelling, submitting })
}
