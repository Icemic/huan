/**
 * `@huan/react/client`：纯 transport 子入口。
 *
 * 只包含 HTTP/SSE 客户端、解码与载荷校验，不导入 React、Zustand 业务状态、
 * 应用或 Node。浏览器实例通过显式注入的 client 使用它。
 */

export type { HarnessEventStreamOptions, SseFrame } from './event-source.js'
export {
  createHarnessEventStreamConnection,
  createHarnessSseDecoder,
  openHarnessEventStream,
} from './event-source.js'
export type { HarnessHttpClientOptions } from './http-client.js'
export { createHarnessHttpClient, HarnessHttpError } from './http-client.js'
