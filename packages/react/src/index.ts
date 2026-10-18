/**
 * @huan/react：浏览器侧 Harness 运行时（自研 Controller + 公共 hook）。
 *
 * 本包是 `@huan/core` 的浏览器对偶：core 拥有宿主侧（Pi SDK 与会话生命周期），
 * 本包拥有浏览器侧（reducer、消息投影、传输客户端、Controller 与 React 接线）。
 *
 * **来源与许可**：运行时实现移植自 `@assistant-ui/react-pi@0.0.29`（MIT 许可），
 * 按技术架构 §4「以 PiClient 形态为参照，不重新发明」的原则保留其分层与语义。
 * 相对上游的改动：
 * - 类型统一从 `@huan/protocol` 引入（`Pi*` → `Harness*`）；
 * - 上游经 `@assistant-ui/core/internal` / `@assistant-ui/store/internal` 引用的
 *   内部工具改为本包 `src/vendor/` 下的本地副本（见该目录文件头说明）；
 * - 移除 Assistant Cloud 分支与跨组件连接共享（迭代文档决策点 5）；
 * - 注释全部译为中文。
 *
 * **依赖边界**：本包依赖 React 与 `@assistant-ui/react`（peer），不依赖 Node、
 * 不依赖 Pi SDK。
 */

export const HARNESS_REACT_VERSION = 1 as const

export type { HarnessEventStreamOptions, SseFrame } from './client/event-source.js'
export {
  createHarnessEventStreamConnection,
  createHarnessSseDecoder,
  openHarnessEventStream,
} from './client/event-source.js'
export type { HarnessHttpClientOptions } from './client/http-client.js'
// HTTP/SSE 客户端
export { createHarnessHttpClient } from './client/http-client.js'
// 载荷校验（供宿主侧测试与自定义传输实现复用）
export {
  isAssistantMessage,
  isAssistantMessageDelta,
  isCompleteTranscriptMessage,
  isContextUsage,
  isHostUiRequest,
  isThreadMetadata,
  isThreadSnapshot,
} from './client/validation.js'
// 事件类型判据
export { isKnownHarnessClientEventType } from './event-types.js'
export type { HarnessQueueMode } from './queue-ids.js'
// 队列条目 ID 方案
export { harnessQueueItemId, isHarnessSteerQueueItemId } from './queue-ids.js'
export {
  useHarnessExtras,
  useHarnessHostUiRequests,
  useHarnessSession,
  useHarnessThreadState,
} from './runtime/hooks.js'
export type { HarnessInterruptAnswer, SplitHostUiRequests } from './runtime/host-ui.js'
// Host UI 辅助
export {
  approvalForRequest,
  responseForApproval,
  responseForInterrupt,
  responseForRequest,
  responseForToolApproval,
  splitHostUiRequests,
} from './runtime/host-ui.js'
export type {
  HarnessProjectedContentPart,
  HarnessProjectionInput,
} from './runtime/message-projection.js'
// 消息投影
export {
  HarnessThreadMessageProjector,
  projectHarnessThreadMessages,
  projectHarnessThreadRepository,
  shareProjectedThreadMessages,
} from './runtime/message-projection.js'
export type { HarnessRuntimeExtras, HarnessRuntimeOptions } from './runtime/runtime-types.js'
export type {
  HarnessNotificationScheduler,
  HarnessSendOptions,
  HarnessThreadControllerLike,
} from './runtime/thread-controller.js'
// Controller
export { buildHarnessSendInput, HarnessThreadController } from './runtime/thread-controller.js'
export type {
  HarnessLoadState,
  HarnessRunStatus,
  HarnessThreadState,
  HarnessToolExecutionState,
} from './runtime/thread-state.js'
// 线程状态 reducer
export {
  createHarnessThreadState,
  reduceHarnessThreadState,
  removeHostUiRequest,
} from './runtime/thread-state.js'
// React 接线与 hook
export { useHarnessRuntime } from './runtime/use-harness-runtime.js'
