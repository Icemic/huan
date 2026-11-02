/**
 * 浏览器 Harness 实例：组合显式注入的 client、服务/窗口 Zustand 状态与资源所有者。
 *
 * 应用 bootstrap 创建一个实例并交给 React Context；Context 只传实例，不复制
 * 其状态。不同窗口/嵌入根各自创建实例，通过宿主权威数据同步。
 */

import type { HarnessClient } from '@huan/protocol'
import type { StoreApi } from 'zustand/vanilla'
import { createHarnessResources, type HarnessFrameScheduler } from './resources.js'
import { createHarnessServiceStore, type HarnessServiceState } from './service-store.js'
import { createHarnessSessionActions, type HarnessSessionActions } from './session-actions.js'
import {
  createHarnessWindowStore,
  type HarnessBrowserStorage,
  type HarnessWindowState,
} from './window-store.js'

/** 浏览器实例选项。 */
export interface CreateHarnessBrowserOptions {
  /** 显式注入的传输客户端（HTTP/SSE、测试替身等）。 */
  client: HarnessClient
  /** 调用方配置的服务地址标识；组成持久化命名空间。 */
  connectionKey: string
  /** 当前 UI 窗口标识；用于定向交互，不作为权限依据。 */
  windowId: string
  /** 会话存储；传 `null` 禁用持久化，省略时使用全局 sessionStorage。 */
  storage?: HarnessBrowserStorage | null
  /** 帧调度器；测试注入确定性实现。 */
  scheduleFrame?: HarnessFrameScheduler
}

/** 浏览器 Harness 实例。 */
export interface HarnessBrowser {
  readonly client: HarnessClient
  readonly serviceStore: StoreApi<HarnessServiceState>
  readonly windowStore: StoreApi<HarnessWindowState>
  readonly connectionKey: string
  readonly windowId: string
  /** 公共会话动作：提交、停止、队列取回与固定模型选择。 */
  readonly sessionActions: HarnessSessionActions
  /** React 根挂载取得根订阅；StrictMode 同轮重挂不中断。 */
  acquireRoot(): () => void
  /** 打开会话 live 视图时取得租约；归零后释放完整缓存。 */
  acquireThreadLease(threadId: string): () => void
  /** 重建已终止的观察连接，不派发业务任务。 */
  reconnectThread(threadId: string): void
  /** 认证面板开关；驱动 MCP 认证轮询的生命周期。 */
  setMcpAuthPanelOpen(open: boolean): void
  refreshMcpAuth(): Promise<void>
  /** 永久销毁实例；之后 acquire 抛错且旧异步结果不得复活状态。 */
  dispose(): void
  readonly disposed: boolean
}

const defaultStorage = (): HarnessBrowserStorage | undefined => {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? undefined : globalThis.sessionStorage
  } catch {
    return undefined
  }
}

const storageScopeOf = (connectionKey: string, agentDir: string, sessionRoot: string): string =>
  `${connectionKey}|${agentDir}|${sessionRoot}`

export const createHarnessBrowser = (options: CreateHarnessBrowserOptions): HarnessBrowser => {
  const { client, connectionKey, windowId } = options
  const storage = options.storage === null ? undefined : (options.storage ?? defaultStorage())
  const windowStore = createHarnessWindowStore({
    windowId,
    storageScope: connectionKey,
    storage,
  })
  const serviceStore = createHarnessServiceStore({
    client,
    onHostInfo: (host) => {
      windowStore
        .getState()
        .setStorageScope(storageScopeOf(connectionKey, host.agentDir, host.sessionStorage.root))
    },
  })
  let sessionActions: HarnessSessionActions | undefined
  const resources = createHarnessResources({
    client,
    serviceStore,
    ...(options.scheduleFrame ? { scheduleFrame: options.scheduleFrame } : {}),
    onRootStopped: () => sessionActions?.cancelUnmounted(),
  })
  sessionActions = createHarnessSessionActions({
    client,
    serviceStore,
    windowStore,
    reconnectThread: (threadId) => resources.reconnectThread(threadId),
  })
  const actions = sessionActions

  let disposed = false

  return {
    client,
    serviceStore,
    windowStore,
    connectionKey,
    windowId,
    sessionActions: actions,
    acquireRoot: () => resources.acquireRoot(),
    acquireThreadLease: (threadId) => resources.acquireThreadLease(threadId),
    reconnectThread: (threadId) => resources.reconnectThread(threadId),
    setMcpAuthPanelOpen: (open) => resources.setMcpAuthPanelOpen(open),
    refreshMcpAuth: () => resources.refreshMcpAuth(),
    dispose: () => {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      try {
        // 先失效未派发动作，再释放连接与状态；已派发 HTTP 不在此撤销。
        actions.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        resources.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        windowStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        for (const error of errors.slice(1)) console.error('[huan-react] 实例释放失败', error)
        throw errors[0]
      }
    },
    get disposed() {
      return disposed
    },
  }
}
