/**
 * 认证快照的共享浏览器缓存。
 *
 * 认证面板、模型选择器与宿主状态都需要在登录/退出后更新；用模块级单例
 * 避免每个组件各建一条订阅。快照只含安全投影，不包含回填值。
 */
import type { HarnessProviderAuthSnapshot } from '@huan/protocol'
import { useSyncExternalStore } from 'react'
import { harnessHttpClient } from './pi-http-client'

let snapshot: HarnessProviderAuthSnapshot | undefined
let stop: (() => void) | undefined
let latestSeq = -1
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of [...listeners]) listener()
}

const apply = (next: HarnessProviderAuthSnapshot): void => {
  if (next.seq <= latestSeq) return
  latestSeq = next.seq
  snapshot = next
  notify()
}

const start = (): void => {
  if (stop) return
  stop = harnessHttpClient.subscribeProviderAuth((event) => {
    // 轮询链串行，序号回退表示宿主重启；显式并发查询仍走 apply 的旧序号守卫。
    if (event.snapshot.seq < latestSeq) latestSeq = -1
    apply(event.snapshot)
  })
}

/** 主动重读权威快照；失败时保留上一次成功结果。 */
export async function refreshProviderAuthSnapshot(): Promise<void> {
  try {
    apply(await harnessHttpClient.getProviderAuth())
  } catch {
    // 面板会按操作错误提示；这里不把原始网络错误写入共享状态。
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stop?.()
      stop = undefined
    }
  }
}

const getSnapshot = (): HarnessProviderAuthSnapshot | undefined => snapshot

/** 订阅认证快照；首次调用会自动建立一次共享订阅。 */
export function useProviderAuthSnapshot(): HarnessProviderAuthSnapshot | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const getRevision = () => snapshot?.authRevision

/** 只需可用性失效信号的组件不随授权提示或进度重新渲染。 */
export function useProviderAuthRevision(): number | undefined {
  return useSyncExternalStore(subscribe, getRevision, getRevision)
}
