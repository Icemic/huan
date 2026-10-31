/**
 * 消息动作 → fork 弹层的轻量桥。
 *
 * 历史消息动作按钮位于 assistant-ui 消息树内（会随 autohide 卸载），而
 * 弹层挂在常驻的上下文栏；用模块级 intent + `useSyncExternalStore` 避免
 * 把弹层状态放进可能被卸载的消息子树。
 */
import { useSyncExternalStore } from 'react'

export type ForkRequest = {
  position: 'before' | 'at'
  entryId?: string
}

let request: ForkRequest | undefined
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of [...listeners]) listener()
}

/** 请求打开 fork/clone 弹层。 */
export function requestForkThread(next: ForkRequest): void {
  request = next
  emit()
}

/** 关闭弹层时清除请求。 */
export function clearForkThreadRequest(): void {
  if (request === undefined) return
  request = undefined
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => request

/** 订阅当前 fork 请求；无请求时为 undefined。 */
export function useForkThreadRequest(): ForkRequest | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
