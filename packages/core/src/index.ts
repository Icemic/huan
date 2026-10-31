/**
 * @huan/core：Pi SDK 集成与运行时生命周期（Node 侧）。
 *
 * 迭代③起提供自研宿主 `createHarnessHost`（替代 react-pi 的 Node supervisor）：
 * - 会话生命周期（新建、冷打开、删除、归档）与并发语义；
 * - 事件映射、快照投影、Host UI 桥；
 * - 模型目录（官方装配入口，扩展 provider 可见）与默认模型解析。
 *
 * 约束：Node 专用（依赖 Pi SDK）；不依赖 React；协议类型全部来自 @huan/protocol。
 */

export { deriveContextUsage } from './context-usage.js'
export type { MappedSessionEventResult, MapSessionEventContext } from './event-mapping.js'
export { mapSessionEvent } from './event-mapping.js'
export type { HarnessDefaultModel, HarnessHost, HarnessHostOptions } from './host.js'
export { createHarnessHost } from './host.js'
export type { HostUiBridge, HostUiBridgeDeps } from './host-ui.js'
export { HarnessUnsupportedHostUiError } from './host-ui.js'
export type { SessionCatalogInfo } from './metadata.js'

export {
  baseName,
  deriveReadiness,
  extractMessageText,
  mapColdMetadata,
  mapQueuedMessages,
  mapSessionInfo,
  normalizeTitle,
  readinessFromSessionContext,
} from './metadata.js'
export {
  createHostServices,
  createSharedModelRuntime,
  type HarnessResourceLoaderOptions,
  listModelCatalog,
  refreshModelCatalog,
  resolveDefaultModel,
} from './model-catalog.js'

// 测试辅助经子路径 `@huan/core/testing` 显式导入；生产入口不导出测试实现。
