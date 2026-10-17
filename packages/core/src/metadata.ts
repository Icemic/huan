/**
 * 会话目录与快照的元数据映射。
 *
 * 冷读路径（无 live 会话）从 SessionInfo + 分支记录推导；热路径由宿主从
 * live record 合成。两者共享「标题/就绪度」等推导规则，保证口径一致。
 */
import type {
  HarnessAnySessionEntry,
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
  const title = info.name?.trim() || info.firstMessage.slice(0, 60).trim() || baseName(info.path)
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

/** 从分支记录取最新会话名（最新的 session_info 记录胜出）。 */
export function latestSessionName(branch: readonly HarnessAnySessionEntry[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry && entry.type === 'session_info') {
      const name = (entry as { name?: unknown }).name
      return typeof name === 'string' ? name : undefined
    }
  }
  return undefined
}

/** 冷会话的元数据（从会话文件读出）。 */
export function mapColdMetadata(
  info: SessionCatalogInfo,
  branch: readonly HarnessAnySessionEntry[],
  context: {
    messages: readonly unknown[]
    thinkingLevel: string
    model: { provider: string; modelId: string } | null
  },
  opts: { archived: boolean; contextUsage?: HarnessContextUsage },
): HarnessThreadMetadata {
  const sessionName = latestSessionName(branch)
  return {
    ...mapSessionInfo(info, { liveStatus: 'idle' }),
    ...(sessionName !== undefined ? { title: sessionName } : {}),
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
