/**
 * 上下文用量推导（冷读路径）。
 *
 * 冷会话（无 live record）需要不构造 AgentSession 也能报告用量。SDK 未导出
 * 复合函数（getContextUsage 是会话方法），因此这里复用 SDK 导出的估算原语
 * （estimateTokens / calculateContextTokens / getLatestCompactionEntry）重算：
 * 信任最近一条助手 usage（真实 API token 计数），仅估算其后的消息；
 * 压缩边界之后尚无可信 usage 时返回 tokens: null。
 */
import {
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry,
} from '@earendil-works/pi-coding-agent'
import type { HarnessContextUsage } from '@huan/protocol'

type UsageBearingMessage = {
  role?: string
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
  }
  stopReason?: string
}

/** 取助手消息的有效 usage（跳过 aborted/error 轮次）。 */
function assistantUsage(message: unknown): UsageBearingMessage['usage'] | undefined {
  const candidate = message as UsageBearingMessage
  if (
    candidate.role === 'assistant' &&
    candidate.usage &&
    candidate.stopReason !== 'aborted' &&
    candidate.stopReason !== 'error'
  ) {
    return candidate.usage
  }
  return undefined
}

/** messages 的 token 估算：信任最后一条助手 usage，估算其后的尾段。 */
function estimateContextTokens(messages: readonly unknown[]): number {
  let lastUsageIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (assistantUsage(messages[i])) {
      lastUsageIndex = i
      break
    }
  }
  if (lastUsageIndex < 0) {
    let estimated = 0
    for (const message of messages) estimated += estimateTokens(message as never)
    return estimated
  }
  const usage = assistantUsage(messages[lastUsageIndex])
  let tokens = calculateContextTokens(usage as never)
  for (let i = lastUsageIndex + 1; i < messages.length; i += 1) {
    tokens += estimateTokens(messages[i] as never)
  }
  return tokens
}

/** 压缩边界之后没有可信助手 usage 时为 true（用量未知，直到下一次 LLM 响应）。 */
function compactionInvalidatesUsage(branch: readonly unknown[]): boolean {
  const latest = getLatestCompactionEntry(branch as never)
  if (!latest) return false
  const compactionIndex = branch.lastIndexOf(latest)
  for (let i = branch.length - 1; i > compactionIndex; i -= 1) {
    const entry = branch[i] as { type?: string; message?: UsageBearingMessage }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message?.role !== 'assistant') continue
    if (message.stopReason === 'aborted' || message.stopReason === 'error') continue
    const usage = assistantUsage(message)
    return !usage || calculateContextTokens(usage as never) <= 0
  }
  return true
}

/**
 * 从持久化数据推导用量；contextWindow 不可知（<= 0）时返回 undefined。
 */
export function deriveContextUsage(
  contextWindow: number,
  branch: readonly unknown[],
  messages: readonly unknown[],
): HarnessContextUsage | undefined {
  if (contextWindow <= 0) return undefined
  if (compactionInvalidatesUsage(branch)) {
    return { tokens: null, contextWindow, percent: null }
  }
  const tokens = estimateContextTokens(messages)
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
}
