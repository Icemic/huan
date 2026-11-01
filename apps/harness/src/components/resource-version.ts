/**
 * 本窗口的资源版本信号（G1.4b）。
 *
 * 资源重载成功后，命令目录等按需查询的派生数据需要重新读取：会话目标可由
 * 元数据 `resourceRevision` 驱动；空白页（没有会话）没有元数据，因此用这个
 * 模块级信号补一次失效通知。它只是**刷新通知**，不是资源权威，也不跨窗口。
 */
import { useSyncExternalStore } from 'react'

let version = 0
const listeners = new Set<() => void>()

/** 资源可能已变化：让本窗口所有按需查询重新读取。 */
export function bumpResourceVersion(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => version

/** 订阅本窗口资源版本（返回值变化即表示需要重读派生数据）。 */
export function useResourceVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
