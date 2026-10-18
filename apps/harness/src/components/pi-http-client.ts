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
const baseClient = createHarnessHttpClient(
  __HUAN_TOKEN__ ? { headers: { 'x-huan-token': __HUAN_TOKEN__ } } : undefined,
)

export const harnessHttpClient: typeof baseClient = {
  ...baseClient,
  async createThread(input) {
    const draft = getDraftModel()
    if (!draft) return baseClient.createThread(input)
    // 草稿存在：随创建请求携带显式模型（宿主在创建 session 时即应用）。
    return baseClient.createThread({
      ...input,
      model: { provider: draft.provider, modelId: draft.modelId },
      ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    })
  },
}
