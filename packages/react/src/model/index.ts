/**
 * `@huan/react/model`：纯事件归约、展示投影与 Host UI 语义子入口。
 *
 * 不导入 React、Zustand 业务状态、应用或 Node；供 Node 侧测试与服务端
 * 共用纯语义，也避免服务端为了 reducer 拉入浏览器依赖。
 */

export { isKnownHarnessClientEventType } from './event-types.js'
export type { HarnessInterruptAnswer, SplitHostUiRequests } from './host-ui.js'
export {
  responseForApproval,
  responseForInterrupt,
  responseForRequest,
  splitHostUiRequests,
} from './host-ui.js'
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
} from './message-view.js'
export {
  HarnessMessageViewProjector,
  projectHarnessMessages,
  shareHarnessMessageViews,
} from './message-view.js'
export type {
  HarnessLoadState,
  HarnessRunStatus,
  HarnessThreadReduction,
  HarnessThreadSession,
  HarnessToolExecutionState,
} from './thread-state.js'
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
} from './thread-state.js'
