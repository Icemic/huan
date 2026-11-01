/**
 * 跨线程写入草稿的一次性意图。
 *
 * fork/clone 在切换子会话后要恢复原文；若只调用 composer.setText，输入组件的
 * 会话草稿恢复 effect 可能稍后到达并用空草稿覆盖。这里先登记目标会话的草稿，
 * 由输入控制器在 key 切换时优先消费，避免两个写入路径互相覆盖。
 */
const overrides = new Map<string, string>()

export function setComposerDraftOverride(threadId: string, text: string): void {
  overrides.set(threadId, text)
}

export function takeComposerDraftOverride(threadId: string): string | undefined {
  const value = overrides.get(threadId)
  overrides.delete(threadId)
  return value
}
