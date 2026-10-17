/**
 * 上下文用量推导（冷读路径）。
 *
 * 冷会话（无 live record）需要不构造 AgentSession 也能报告用量。SDK 的
 * `getContextUsage()` 是会话方法，但导出 `buildSessionProjection` 与
 * `estimateProjectedContextTokens` 的输入（projection + branch）。为确保与热
 * 路径口径一致，这里**复用 SDK 的 projection**，并按其规则判定压缩后用量是否
 * 可信：
 * - 只用「压缩边界之后、且有有效 usage（calculateContextTokens > 0）的助手消息」
 *   是否存在，决定 tokens 是数值还是 null；
 * - 估算交给 SDK 的 `estimateTokens` / `calculateContextTokens` 原语按同一序列
 *   计算（信任最后一条有效助手 usage，估算其后的消息）。
 */
import {
  buildSessionProjection,
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry,
} from '@earendil-works/pi-coding-agent'
import type { HarnessContextUsage } from '@huan/protocol'

type MessageLike = {
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

/** 有效助手 usage：角色为 assistant、有 usage、且非 aborted/error，且 token 数 > 0。 */
function validAssistantUsage(message: unknown): MessageLike['usage'] | undefined {
  const candidate = message as MessageLike
  if (candidate.role !== 'assistant' || !candidate.usage) return undefined
  if (candidate.stopReason === 'aborted' || candidate.stopReason === 'error') return undefined
  if (calculateContextTokens(candidate.usage as never) <= 0) return undefined
  return candidate.usage
}

/** messages 的 token 估算：信任最后一条有效助手 usage，估算其后的尾段。 */
function estimateContextTokens(messages: readonly unknown[]): number {
  let lastUsageIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (validAssistantUsage(messages[i])) {
      lastUsageIndex = i
      break
    }
  }
  if (lastUsageIndex < 0) {
    let estimated = 0
    for (const message of messages) estimated += estimateTokens(message as never)
    return estimated
  }
  let tokens = calculateContextTokens(validAssistantUsage(messages[lastUsageIndex]) as never)
  for (let i = lastUsageIndex + 1; i < messages.length; i += 1) {
    tokens += estimateTokens(messages[i] as never)
  }
  return tokens
}

/**
 * 从持久化数据推导用量；contextWindow 不可知（<= 0）时返回 undefined。
 * 压缩之后若无「带有效 usage 的助手响应」，tokens 为 null（直到下一次 LLM 响应）。
 */
export function deriveContextUsage(
  contextWindow: number,
  branch: readonly unknown[],
  _messages: readonly unknown[],
): HarnessContextUsage | undefined {
  if (contextWindow <= 0) return undefined

  const projection = buildSessionProjection(branch as never)
  const latestCompaction = getLatestCompactionEntry(branch as never)
  if (latestCompaction) {
    // 以 projection 中「含有效助手 usage 的来源记录」为准（与 SDK 热路径同规则）。
    const projectedAssistants = new Set(
      projection.entries.flatMap((entry) =>
        entry.messages.some((message) => validAssistantUsage(message))
          ? [entry.sourceEntry.id]
          : [],
      ),
    )
    const compactionIndex = branch.findIndex(
      (entry) => (entry as { id?: string }).id === latestCompaction.id,
    )
    const hasPostCompactionUsage = branch
      .slice(compactionIndex + 1)
      .some((entry) => projectedAssistants.has((entry as { id?: string }).id ?? ''))
    if (!hasPostCompactionUsage) {
      return { tokens: null, contextWindow, percent: null }
    }
  }

  // 与热路径一致：估算当前投影的消息序列。
  const messages = projection.entries.flatMap((entry) => entry.messages)
  const tokens = estimateContextTokens(messages)
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
}
