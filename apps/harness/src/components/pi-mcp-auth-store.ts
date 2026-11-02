/**
 * MCP 认证快照的共享浏览器缓存（G1.4d4）。
 *
 * 只在需要时轮询：面板打开，或仍有未结算认证操作（即使面板已关闭）。
 * 一个页面只有一条串行轮询链，避免多窗口/多组件重复请求；不新增 SSE。
 * 快照只含宿主安全投影，回填值从不进入这里。
 */
import type { HarnessMcpAuthOperation, HarnessMcpAuthSnapshot } from '@huan/protocol'
import { useSyncExternalStore } from 'react'
import { harnessHttpClient } from './pi-http-client'

let snapshot: HarnessMcpAuthSnapshot | undefined
let error: string | undefined
let latestSeq = -1
let panelOpen = false
let inFlight = false
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of [...listeners]) listener()
}

const isActive = (operation: HarnessMcpAuthOperation): boolean =>
  operation.phase !== 'succeeded' && operation.phase !== 'failed' && operation.phase !== 'cancelled'

const hasActiveOperations = (): boolean => (snapshot?.operations ?? []).some(isActive)

const shouldPoll = (): boolean => !disposed && (panelOpen || hasActiveOperations())

const clearTimer = (): void => {
  if (timer === undefined) return
  clearTimeout(timer)
  timer = undefined
}

const schedule = (): void => {
  clearTimer()
  if (!shouldPoll()) return
  timer = setTimeout(
    () => {
      timer = undefined
      void poll()
    },
    hasActiveOperations() ? 1_000 : 2_000,
  )
}

const apply = (next: HarnessMcpAuthSnapshot): void => {
  if (next.seq < latestSeq) {
    // 序号回退说明宿主重启或缓存属于旧进程；接受新权威快照并清空旧值。
    latestSeq = -1
  }
  if (next.seq === latestSeq && snapshot !== undefined) {
    if (error !== undefined) {
      error = undefined
      notify()
    }
    return
  }
  latestSeq = next.seq
  snapshot = next
  error = undefined
  notify()
}

async function poll(): Promise<void> {
  if (inFlight || disposed) return
  inFlight = true
  try {
    apply(await harnessHttpClient.getMcpAuth())
  } catch {
    if (!disposed) {
      const message = '无法读取 MCP 认证状态，请检查宿主连接。'
      if (error !== message) {
        error = message
        notify()
      }
    }
  } finally {
    inFlight = false
    schedule()
  }
}

/** 主动重读权威快照；失败时保留上一次成功结果，供面板显示受控提示。 */
export async function refreshMcpAuthSnapshot(): Promise<void> {
  if (disposed) return
  await poll()
}

/** 面板打开/关闭：关闭且没有活动操作时停止轮询，认证流程本身不受影响。 */
export function setMcpAuthPanelOpen(open: boolean): void {
  if (panelOpen === open) {
    if (open) void poll()
    return
  }
  panelOpen = open
  if (open) {
    void poll()
    return
  }
  if (!hasActiveOperations()) clearTimer()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): HarnessMcpAuthSnapshot | undefined => snapshot
const getError = (): string | undefined => error

/** 订阅 MCP 认证快照；轮询由面板开关显式控制。 */
export function useMcpAuthSnapshot(): HarnessMcpAuthSnapshot | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 订阅认证轮询错误（不下发原始异常文本）。 */
export function useMcpAuthError(): string | undefined {
  return useSyncExternalStore(subscribe, getError, getError)
}

/** 测试与窗口卸载清理（生产正常关闭页面时由进程回收）。 */
export function disposeMcpAuthStore(): void {
  disposed = true
  clearTimer()
}
