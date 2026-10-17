import { createPiHttpClient } from '@assistant-ui/react-pi'

/**
 * 浏览器端共享的 Pi HTTP 客户端（模块级单例）。
 *
 * - 运行时（PiRuntimeProvider）与模型选择器共用同一实例：client 无连接状态，
 *   SSE 仅在 subscribe 时开启，因此单例不会互相干扰；
 * - 宿主启用凭证时，所有请求（含 SSE）携带 x-huan-token 头。
 */
export const piHttpClient = createPiHttpClient(
  __HUAN_TOKEN__ ? { headers: { 'x-huan-token': __HUAN_TOKEN__ } } : undefined,
)
