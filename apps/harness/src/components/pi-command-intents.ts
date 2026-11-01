/**
 * 应用内置动作的轻量意图桥。
 *
 * 命令路由位于输入组件，而模型选择器、运行操作面板、会话树、导入与信任
 * 弹层挂在其他常驻组件。用模块级 intent + `useSyncExternalStore` 打开既有
 * 面板，不在路由里复制第二套对话框。
 */
import { useSyncExternalStore } from 'react'

export type PiIntentKind =
  | 'model'
  | 'runtime-operations'
  | 'session-tree'
  | 'session-details'
  | 'import'
  | 'trust'
  | 'settings'
  | 'provider-auth'
  | 'new-session'

export type PiIntent = {
  id: number
  kind: PiIntentKind
  payload?: Record<string, string>
}

let current: PiIntent | undefined
let nextId = 1
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of [...listeners]) listener()
}

export function requestPiIntent(kind: PiIntentKind, payload?: Record<string, string>): void {
  current = { id: nextId++, kind, ...(payload ? { payload } : {}) }
  emit()
}

export function clearPiIntent(id: number): void {
  if (current?.id !== id) return
  current = undefined
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => current

/** 读取当前意图（任意种类）；组件按 kind 过滤。 */
export function usePiIntent(): PiIntent | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
