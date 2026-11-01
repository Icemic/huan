import { createHarnessHttpClient } from '@huan/react'
import { getDraftModel } from './pi-model-draft'

/**
 * 浏览器端共享的 Harness HTTP 客户端（模块级单例）。
 *
 * - 运行时（PiRuntimeProvider）与模型选择器共用同一实例：client 无连接状态，
 *   SSE 仅在 subscribe 时开启，因此单例不会互相干扰；
 * - 宿主启用凭证时，所有请求（含 SSE）携带 x-huan-token 头；
 * - **包装 createThread**：把「新会话模型草稿」注入创建请求，使首条消息就用
 *   用户选定的模型。这是必要的：空白会话用 NOOP controller，setModel 会被
 *   丢弃；而创建发生在首条消息发送时，client 是我们传入的，因此 await
 *   createThread 是唯一可靠的前置注入点。
 */
/**
 * 当前浏览器窗口的稳定标识（同一标签页刷新后保持）。
 *
 * 扩展写输入框时据此定向；不进入 Pi 会话记录，也不作为安全边界。
 */
const WINDOW_ID_KEY = 'huan.window-id'
const createWindowId = (): string => {
  if (typeof window === 'undefined') return 'host'
  try {
    const existing = window.sessionStorage.getItem(WINDOW_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    window.sessionStorage.setItem(WINDOW_ID_KEY, id)
    return id
  } catch {
    // 隐私模式等无法持久化时退回进程内随机值。
    return crypto.randomUUID()
  }
}

export const harnessWindowId = createWindowId()

const baseClient = createHarnessHttpClient({
  callerId: harnessWindowId,
  ...(__HUAN_TOKEN__ ? { headers: { 'x-huan-token': __HUAN_TOKEN__ } } : {}),
})

const notifyThreadsChanged = (event: 'created' | 'updated') => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(`huan:thread-${event}`))
}

export const harnessHttpClient: typeof baseClient = {
  ...baseClient,
  async createThread(input) {
    const draft = getDraftModel()
    const result = draft
      ? // 草稿存在：随创建请求携带显式模型（宿主在创建 session 时即应用）。
        await baseClient.createThread({
          ...input,
          model: { provider: draft.provider, modelId: draft.modelId },
          ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        })
      : await baseClient.createThread(input)
    // 侧栏分组来自宿主列表；创建成功立刻重查，避免要刷新页面才出现新会话。
    notifyThreadsChanged('created')
    return result
  },
  async sendMessage(threadId, input) {
    const result = await baseClient.sendMessage(threadId, input)
    // 首条消息写入后标题才可读；接受消息后补一次列表重查。
    notifyThreadsChanged('updated')
    return result
  },
  subscribe(threadId, listener, options) {
    return baseClient.subscribe(
      threadId,
      (event) => {
        listener(event)
        // 快照/结算说明会话文件与标题已经落盘（空会话文件可能尚未创建）；
        // 通知侧栏重查，避免新会话只在刷新页面后出现。
        if (
          event.type === 'snapshot' ||
          event.type === 'agent_settled' ||
          event.type === 'session_info_changed'
        ) {
          notifyThreadsChanged('updated')
        }
      },
      options,
    )
  },
}
