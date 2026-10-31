/**
 * 冷会话累计统计（不构造 AgentSession）。
 *
 * 规则对照 Pi SDK 1.4.0 `AgentSession.getSessionStats()`：**累计统计覆盖
 * `SessionManager.getEntries()` 的全部条目**（含已压缩掉的历史与其他分支）：
 * - `usage` 条目按其 usage 累加（如 cache_warm 等独立计费）；
 * - `compaction` / `branch_summary` 条目自带 usage（生成摘要的调用）时也累加；
 * - `message` 条目计入消息数：`user`、`toolResult`、`assistant` 分别计数，
 *   `assistant` 的 `toolCall` 内容块计入工具调用数；
 * - `assistant` 与 `toolResult` 消息自带 usage 时一并累加。
 *
 * 「当前上下文」不使用全文件，而是按活动分支交给 `deriveContextUsage`，
 * 因此累计统计与上下文估计必须分开呈现。
 *
 * 字段读取做了缺省容错（非数字按 0、缺 usage 则跳过）：SDK 假设记录完整，
 * 这里不因单条旧格式/异常条目让整个详情失败；对完整记录的结果与 SDK 相同。
 */
import type { HarnessThreadStats } from '@huan/protocol'

type UsageLike = {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  cost?: { total?: unknown }
}

type EntryLike = {
  type?: unknown
  usage?: unknown
  message?: {
    role?: unknown
    content?: unknown
    usage?: unknown
  }
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

function emptyStats(): HarnessThreadStats {
  return {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  }
}

function addUsage(stats: HarnessThreadStats, usage: unknown): void {
  if (usage === null || typeof usage !== 'object') return
  const value = usage as UsageLike
  stats.tokens.input += count(value.input)
  stats.tokens.output += count(value.output)
  stats.tokens.cacheRead += count(value.cacheRead)
  stats.tokens.cacheWrite += count(value.cacheWrite)
  stats.cost += count(value.cost?.total)
}

/** 按 SDK 全条目口径聚合累计统计。 */
export function aggregateSessionStats(entries: readonly unknown[]): HarnessThreadStats {
  const stats = emptyStats()
  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as EntryLike
    if (entry.type === 'usage') {
      addUsage(stats, entry.usage)
    } else if (entry.type === 'branch_summary' || entry.type === 'compaction') {
      if (entry.usage) addUsage(stats, entry.usage)
    }
    if (entry.type !== 'message') continue
    stats.totalMessages += 1
    const message = entry.message
    if (!message) continue
    if (message.role === 'user') {
      stats.userMessages += 1
    } else if (message.role === 'toolResult') {
      stats.toolResults += 1
      if (message.usage) addUsage(stats, message.usage)
    } else if (message.role === 'assistant') {
      stats.assistantMessages += 1
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part !== null && typeof part === 'object') {
            if ((part as { type?: unknown }).type === 'toolCall') stats.toolCalls += 1
          }
        }
      }
      if (message.usage) addUsage(stats, message.usage)
    }
  }
  stats.tokens.total =
    stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite
  return stats
}
