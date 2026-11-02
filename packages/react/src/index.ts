/**
 * @huan/react：浏览器侧 Harness 公共包。
 *
 * 本包由三层组成：
 * - `client/`：纯 HTTP/SSE transport（同时通过 `@huan/react/client` 子入口导出）；
 * - `model/`：纯事件归约、消息展示投影与 Host UI 语义，不导入 React；
 * - `browser/` 与 `react/`：显式注入 client 的 Zustand 实例、资源所有者与
 *   selector 绑定。Context 只传实例，不复制业务状态。
 *
 * **来源与许可**：部分移植自 `@assistant-ui/react-pi@0.0.29`（MIT 许可），
 * 来源与本地改动见各文件头及包内 THIRD-PARTY-NOTICES.md。
 *
 * **依赖边界**：本包依赖 React 与 Zustand（浏览器状态），不依赖 Node、
 * 不依赖 Pi SDK；transport 子入口不依赖 React。
 */

export const HARNESS_REACT_VERSION = 2 as const

// 浏览器实例与状态类型。
export type {
  CreateHarnessBrowserOptions,
  HarnessBrowser,
} from './browser/create-browser.js'
export { createHarnessBrowser } from './browser/create-browser.js'
export type {
  HarnessBrowserResources,
  HarnessFrameScheduler,
} from './browser/resources.js'
export type {
  HarnessCatalogState,
  HarnessModelCatalogEntry,
  HarnessModelCatalogQuery,
  HarnessModelCatalogTarget,
  HarnessModelCatalogVersions,
  HarnessServiceState,
  HarnessThreadQuery,
} from './browser/service-store.js'
export { modelCatalogKeyOf, selectHarnessModelCatalog } from './browser/service-store.js'
export type {
  HarnessLocalQueueRecovery,
  HarnessSessionActions,
  HarnessSessionQueueRecovery,
  HarnessSessionStopOutcome,
  HarnessSessionSubmitInput,
  HarnessSessionSubmitOutcome,
} from './browser/session-actions.js'
export type {
  HarnessAttachment,
  HarnessAttachmentStatus,
  HarnessBrowserStorage,
  HarnessDraft,
  HarnessDraftRef,
  HarnessDraftTarget,
  HarnessSubmission,
  HarnessSubmissionMode,
  HarnessSubmissionStatus,
  HarnessViewOrigin,
  HarnessWindowState,
} from './browser/window-store.js'
export { draftIdOf } from './browser/window-store.js'
// 纯 transport（与 `@huan/react/client` 同一实现）。
export * from './client/index.js'
export { errorText } from './error-text.js'
export { isKnownHarnessClientEventType } from './model/event-types.js'
// 纯归约/投影与 Host UI 语义。
export type { HarnessInterruptAnswer, SplitHostUiRequests } from './model/host-ui.js'
export {
  responseForApproval,
  responseForInterrupt,
  responseForRequest,
  splitHostUiRequests,
} from './model/host-ui.js'
export type {
  HarnessDataViewPart,
  HarnessImageViewPart,
  HarnessMessageProjectionInput,
  HarnessMessageView,
  HarnessMessageViewPart,
  HarnessMessageViewStatus,
  HarnessTextViewPart,
  HarnessThinkingViewPart,
  HarnessToolViewPart,
} from './model/message-view.js'
export {
  HarnessMessageViewProjector,
  projectHarnessMessages,
  shareHarnessMessageViews,
} from './model/message-view.js'
export type {
  HarnessLoadState,
  HarnessRunStatus,
  HarnessThreadReduction,
  HarnessThreadSession,
  HarnessToolExecutionState,
} from './model/thread-state.js'
export {
  applyHarnessThreadSnapshot,
  createHarnessThreadMetadata,
  createHarnessThreadReduction,
  createHarnessThreadSession,
  isStaleHttpSnapshot,
  reduceHarnessThreadState,
  removeHostUiRequest,
  selectThreadContextUsage,
  selectThreadIsRunning,
  selectThreadQueue,
  selectThreadRunStatus,
} from './model/thread-state.js'

// React 接线：Provider 只传实例，组件直接选择 Zustand 状态。
export {
  HarnessBrowserContext,
  HarnessBrowserProvider,
  useHarnessBrowser,
} from './react/context.js'
export {
  useServiceStore,
  useThreadLease,
  useThreadMetadata,
  useThreadSession,
  useWindowStore,
} from './react/hooks.js'
