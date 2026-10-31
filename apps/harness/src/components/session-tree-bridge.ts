/**
 * 历史消息 → 会话树定位的轻量桥。
 *
 * 消息动作按钮位于 assistant-ui 的消息树内，而会话树对话框挂在上下文栏；
 * 用模块级 intent + `useSyncExternalStore` 避免跨越消息组件传递 props。
 */
import { useSyncExternalStore } from 'react'

let pendingEntryId: string | undefined
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of [...listeners]) listener()
}

/** 请求打开会话树并定位到指定 entryId。 */
export function openSessionTreeAt(entryId: string): void {
  pendingEntryId = entryId
  emit()
}

/** 消费一次定位请求（对话框打开后调用）。 */
export function consumeSessionTreeTarget(): void {
  if (pendingEntryId === undefined) return
  pendingEntryId = undefined
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => pendingEntryId

/** 订阅待处理的定位目标；无请求时为 undefined。 */
export function useSessionTreeTarget(): string | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
