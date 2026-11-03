/**
 * React selector 绑定：直接读取浏览器实例的 Zustand 状态。
 *
 * 不经过已删除的 assistant-ui extras/Controller 或 Context 状态副本；组件只选择
 * 自己需要的字段，动作是 store 上的稳定函数。
 */

import type { HarnessThreadMetadata } from '@huan/protocol'
import { useCallback, useEffect } from 'react'
import { useStore } from 'zustand'
import type { HarnessServiceState } from '../browser/service-store.js'
import type { HarnessWindowState } from '../browser/window-store.js'
import type { HarnessThreadSession } from '../model/thread-state.js'
import { useHarnessBrowser } from './context.js'

/** 选择服务作用域状态字段。 */
export const useServiceStore = <T>(selector: (state: HarnessServiceState) => T): T => {
  const browser = useHarnessBrowser()
  return useStore(browser.serviceStore, selector)
}

/** 选择窗口作用域状态字段。 */
export const useWindowStore = <T>(selector: (state: HarnessWindowState) => T): T => {
  const browser = useHarnessBrowser()
  return useStore(browser.windowStore, selector)
}

/** 订阅单个会话的元数据实体；目录扫描与事件更新同一对象。 */
export const useThreadMetadata = (
  threadId: string | undefined,
): HarnessThreadMetadata | undefined =>
  useServiceStore(
    useCallback((state) => (threadId ? state.threadsById[threadId] : undefined), [threadId]),
  )

/** 订阅单个会话的完整运行数据；会话缓存被释放后返回 undefined。 */
export const useThreadSession = (threadId: string | undefined): HarnessThreadSession | undefined =>
  useServiceStore(
    useCallback((state) => (threadId ? state.sessionDataById[threadId] : undefined), [threadId]),
  )

/**
 * 会话 live 视图的 lease 绑定：挂载即取得，卸载释放。
 *
 * 偏移到微任务释放使 StrictMode 同轮重挂复用同一连接与缓存。
 */
export const useThreadLease = (threadId: string | undefined): void => {
  const browser = useHarnessBrowser()
  useEffect(() => {
    if (!threadId) return
    return browser.acquireThreadLease(threadId)
  }, [browser, threadId])
}
