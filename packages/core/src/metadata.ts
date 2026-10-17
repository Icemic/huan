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
  const title = normalizeTitle({
    explicitName: info.name,
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
