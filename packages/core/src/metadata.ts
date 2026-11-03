/**
 * 会话目录与快照的元数据映射。
 *
 * 冷读路径（无 live 会话）从 SessionInfo + 分支记录推导；热路径由宿主从
 * live record 合成。两者共享「标题/就绪度」等推导规则，保证口径一致。
 */
import type {
  HarnessContextUsage,
  HarnessRuntimeReadiness,
  HarnessThreadMetadata,
} from '@huan/protocol'
import { harnessQueueItemId } from '@huan/protocol'

/** 取路径最后一段（跨平台，不引入 node:path）。 */
export function baseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/)
  return segments[segments.length - 1] ?? filePath
}

/**
 * 从用户消息中提取纯文本（与 Pi `extractTextContent` 同口径，**不做 trim**）。
 *
 * 内容可能是字符串或内容块数组；只取文本块并用空格拼接。
 * 空内容或无非文本块返回 undefined，交由调用方回退。
 */
export function extractMessageText(message: unknown): string | undefined {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.length > 0 ? content : undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const block = part as { type?: string; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** Pi 对「无可用文本消息」的占位值（SessionInfo.firstMessage 的兜底）。 */
export const NO_MESSAGES_PLACEHOLDER = '(no messages)'

/** 会话记录投影所需的最小输入形状（SessionHeader/SessionEntry 的结构子集）。 */
export type SessionRecordProjectionInput = {
  header: { timestamp?: unknown; parentSession?: unknown } | null
  entries: readonly { type?: unknown; timestamp?: unknown; message?: unknown }[]
}

/** 全文件记录投影（与 Pi SessionInfo 的标题/时间/血缘口径一致）。 */
export type SessionRecordProjection = {
  firstUserMessageText?: string
  createdAt?: string
  updatedAt?: string
  parentSessionPath?: string
}

/**
 * 一次遍历会话记录，投影首条用户消息、创建/最近活动时间与父会话路径。
 *
 * 时间语义对齐 Pi `SessionInfo`：created 取 header.timestamp；updatedAt 取全文件
 * user/assistant 消息的最大活动时间（message.timestamp 优先，缺失时回退
 * entry.timestamp）；无有效（> 0）活动时间时回退 header 时间。列表、快照与
 * 热详情共用该投影，避免打开会话后时间丢失。不读取文件 mtime。
 */
export function projectSessionRecord(input: SessionRecordProjectionInput): SessionRecordProjection {
  const header = input.header
  const headerTime =
    typeof header?.timestamp === 'string' ? new Date(header.timestamp).getTime() : Number.NaN
  let firstUserMessageText: string | undefined
  let lastActivityTime: number | undefined
  for (const entry of input.entries) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message === null || typeof message !== 'object') continue
    const record = message as { role?: unknown; content?: unknown; timestamp?: unknown }
    // 与 Pi 相同：只统计带 content 的 user/assistant 消息，工具结果/设置条目不推进。
    if (typeof record.role !== 'string' || !('content' in record)) continue
    if (record.role !== 'user' && record.role !== 'assistant') continue
    let activityTime: number | undefined
    if (typeof record.timestamp === 'number') activityTime = record.timestamp
    else if (typeof entry.timestamp === 'string') {
      const parsed = Date.parse(entry.timestamp)
      if (!Number.isNaN(parsed)) activityTime = parsed
    }
    if (activityTime !== undefined) {
      lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime)
    }
    // 标题只取全文件顺序的首条有文本用户消息；继续遍历以计算活动时间。
    if (record.role !== 'user' || firstUserMessageText !== undefined) continue
    const text = extractMessageText(record)
    if (text) firstUserMessageText = text
  }
  const createdTime = Number.isNaN(headerTime) ? undefined : headerTime
  const modifiedTime =
    typeof lastActivityTime === 'number' && lastActivityTime > 0 ? lastActivityTime : createdTime
  const parentSessionPath =
    typeof header?.parentSession === 'string' && header.parentSession
      ? header.parentSession
      : undefined
  return {
    ...(firstUserMessageText ? { firstUserMessageText } : {}),
    ...(createdTime !== undefined ? { createdAt: new Date(createdTime).toISOString() } : {}),
    ...(modifiedTime !== undefined ? { updatedAt: new Date(modifiedTime).toISOString() } : {}),
    ...(parentSessionPath ? { parentSessionPath } : {}),
  }
}

/**
 * 统一标题归一化（热/冷路径共用）。
 *
 * 显式会话名（非空）> 首条用户消息文本（截断 60 字符）> 会话文件名。
 * 为了让两条路径完全同口径，输入统一取自「会话记录」语义：
 * - `explicitName`：冷路径取自 `SessionInfo.name`（Pi 已按全文件最新值处理，含显式清空），
 *   热路径取自 `session.sessionName`；
 * - `firstMessageText`：冷路径取自 `SessionInfo.firstMessage`，热路径从全文件记录推导。
 */
export function normalizeTitle(input: {
  explicitName?: string | undefined
  firstMessageText?: string | undefined
  sessionFilePath?: string | undefined
}): string | undefined {
  const explicit = input.explicitName?.trim()
  if (explicit) return explicit
  const raw = input.firstMessageText
  // Pi 的占位值不得当作标题（否则纯图片会话会显示 "(no messages)"）。
  if (raw && raw !== NO_MESSAGES_PLACEHOLDER) {
    const trimmed = raw.slice(0, 60).trim()
    if (trimmed) return trimmed
  }
  return input.sessionFilePath ? baseName(input.sessionFilePath) : undefined
}

/** SessionManager 目录条目（结构取自 Pi SessionInfo）。 */
export type SessionCatalogInfo = {
  path: string
  id: string
  cwd: string
  name?: string
  parentSessionPath?: string
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
}

/** 从目录条目映射基础元数据；liveStatus 由宿主覆盖（热会话的状态更权威）。 */
export function mapSessionInfo(
  info: SessionCatalogInfo,
  opts?: { liveStatus?: HarnessThreadMetadata['status'] },
): HarnessThreadMetadata {
  const explicitName = info.name?.trim()
  // 占位值不是首条消息，既不能当标题也不能作为搜索命中。
  const firstMessageText =
    info.firstMessage && info.firstMessage !== NO_MESSAGES_PLACEHOLDER
      ? info.firstMessage
      : undefined
  const title = normalizeTitle({
    explicitName,
    firstMessageText: info.firstMessage,
    sessionFilePath: info.path,
  })
  return {
    id: info.id,
    status: opts?.liveStatus ?? 'idle',
    sessionFile: info.path,
    messageCount: info.messageCount,
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    ...(title ? { title } : {}),
    // 命名状态与首条消息独立暴露：回退标题不表示会话已命名，搜索只看这两个字段。
    ...(explicitName ? { name: explicitName } : {}),
    ...(firstMessageText ? { firstMessageText } : {}),
    ...(info.cwd ? { workspacePath: info.cwd } : {}),
    ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
  }
}

/**
 * 就绪度推导：只暴露可廉价得知的两态（已选模型 / 未选）。
 * 缺凭据与模型不可用会在发送失败时经 lastError 暴露，不主动探测 provider。
 */
export function deriveReadiness(input: {
  model: { provider: string; id: string } | undefined
  source?: 'env' | 'session' | 'pi-default'
}): HarnessRuntimeReadiness {
  if (!input.model) {
    return {
      state: 'missing-model',
      message:
        'No model selected. Set PI_PROVIDER + PI_MODEL_ID (or configure a Pi default) and restart the host.',
    }
  }
  return {
    state: 'ready',
    selection: { provider: input.model.provider, modelId: input.model.id },
    source: input.source ?? 'session',
  }
}

/**
 * 冷会话的元数据（从会话文件读出）。
 *
 * 标题直接沿用 `mapSessionInfo`：Pi 的 `SessionInfo.name/firstMessage` 已按
 * **全文件**最新值处理（含显式清空），再用分支名称推导会造成不同口径。
 */
export function mapColdMetadata(
  info: SessionCatalogInfo,
  context: {
    messages: readonly unknown[]
    thinkingLevel: string
    model: { provider: string; modelId: string } | null
  },
  opts: { archived: boolean; contextUsage?: HarnessContextUsage },
): HarnessThreadMetadata {
  return {
    ...mapSessionInfo(info, { liveStatus: 'idle' }),
    ...(context.model
      ? {
          config: {
            provider: context.model.provider,
            modelId: context.model.modelId,
            thinkingLevel: context.thinkingLevel,
          },
        }
      : { config: { thinkingLevel: context.thinkingLevel } }),
    messageCount: context.messages.length,
    ...(opts.contextUsage ? { contextUsage: opts.contextUsage } : {}),
    ...(opts.archived ? { archived: true } : {}),
  }
}

/** 冷会话就绪度（从持久化的模型选择推导）。 */
export function readinessFromSessionContext(context: {
  model: { provider: string; modelId: string } | null
}): HarnessRuntimeReadiness {
  return deriveReadiness({
    model: context.model
      ? { provider: context.model.provider, id: context.model.modelId }
      : undefined,
    source: 'session',
  })
}

/** 队列镜像（顺序：先 steer 后 follow-up，索引各自从 0 起）。 */
export function mapQueuedMessages(steering: readonly string[], followUp: readonly string[]) {
  return [
    ...steering.map((content, index) => ({
      id: harnessQueueItemId('steer', index),
      mode: 'steer' as const,
      content,
    })),
    ...followUp.map((content, index) => ({
      id: harnessQueueItemId('followUp', index),
      mode: 'followUp' as const,
      content,
    })),
  ]
}
