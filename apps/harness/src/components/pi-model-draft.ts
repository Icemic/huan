import type { HarnessThinkingLevel } from '@huan/protocol'

/**
 * 新会话（尚未创建后端会话）的模型草稿。
 *
 * 背景：react-pi 在空白会话状态下使用 NOOP controller，`setModel` 是空操作；
 * 真正的会话创建发生在首条消息发送时（client.createThread）。因此「先选模型
 * 再发第一条消息」需要把选择暂存在这里，由包装客户端在创建请求中携带。
 *
 * 用模块级 store（同步可读）而非 React state：包装客户端在任意时刻读取草稿，
 * 不依赖渲染时机；这也保证 client 引用稳定（usePiRuntime 会因 client 变化重建）。
 */
type ModelSelection = {
  provider: string
  modelId: string
  thinkingLevel?: HarnessThinkingLevel
}

let draft: ModelSelection | undefined
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of [...listeners]) listener()
}

/** 读取当前草稿（同步；包装客户端用）。 */
export const getDraftModel = (): ModelSelection | undefined => draft

/** 设置草稿（模型选择器用）。传 undefined 清除。 */
export const setDraftModel = (selection: ModelSelection | undefined): void => {
  draft = selection
  notify()
}

/** 订阅草稿变化（React 组件用；返回取消订阅函数）。 */
export const subscribeDraftModel = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
