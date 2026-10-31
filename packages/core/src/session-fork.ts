/**
 * 独立分支（fork / clone）的纯规则与文件创建。
 *
 * 只使用 Pi SDK 公开接口：
 * - 目标解析使用 `SessionManager.getEntry/getLeafId`；
 * - 子文件由**独立的** SessionManager 句柄调用 `createBranchedSession`，
 *   不触碰 live 父 manager（该方法会把自身切到新文件）；
 * - 空目标（首条用户消息之前/空会话 clone）使用 `SessionManager.create` +
 *   `{ parentSession }`，与 CLI 的 fork 行为一致。
 *
 * 不在此处发扩展事件或打开子会话：宿主负责 `session_before_fork`、资源装配、
 * 归属保存与失败清理。
 */
import { existsSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { HarnessThreadForkPosition } from '@huan/protocol'
import { extractMessageText } from './metadata.js'

/** 目标解析失败分类（宿主转成 fork 结果或 busy/conflict）。 */
export type ForkTargetFailure =
  | { ok: false; code: 'entry-missing'; message: string }
  | { ok: false; code: 'not-user-message'; message: string }

/** 解析后的分叉目标。 */
export type ForkTarget =
  | {
      ok: true
      /** 传给 `session_before_fork` 的目标节点；空会话 clone 时缺失（不发事件）。 */
      entryId?: string
      /** 子文件应复制的节点；null 表示根之前或分支尚无对话（空上下文）。 */
      targetLeafId: string | null
      /** fork before 的用户消息原文。 */
      selectedText?: string
    }
  | ForkTargetFailure

/** 分支是否包含真实的用户/助手对话（与 SDK `_hasConversation` 同口径）。 */
function branchHasConversation(sessionManager: SessionManager, leafId: string | null): boolean {
  let cursor = leafId
  const visited = new Set<string>()
  while (cursor) {
    if (visited.has(cursor)) return false
    visited.add(cursor)
    const entry = sessionManager.getEntry(cursor)
    if (!entry) return false
    if (
      entry.type === 'message' &&
      (entry.message.role === 'user' || entry.message.role === 'assistant')
    ) {
      return true
    }
    cursor = entry.parentId
  }
  return false
}

/**
 * 计算分叉目标。
 *
 * - `before`：必须指向用户消息，复制其父节点之前的路径并返回原文；
 *   `entryId` 缺失直接失败（无从判断回到哪条消息之前）。
 * - `at`：复制目标节点自身路径；`entryId` 缺失取当前 leaf，空会话得到 null。
 *
 * 另外：目标路径没有用户/助手对话（首条用户消息之前、或仅有模型/Thinking
 * 设置条目的新会话）时返回 `targetLeafId: null`，由调用方创建空子会话 +
 * parentSession，而不是复制一份只有设置条目的“空文件”。
 */
export function resolveForkTarget(
  sessionManager: SessionManager,
  position: HarnessThreadForkPosition,
  entryId?: string,
): ForkTarget {
  if (position === 'at') {
    const targetId = entryId ?? sessionManager.getLeafId()
    if (targetId === null) return { ok: true, targetLeafId: null }
    const entry = sessionManager.getEntry(targetId)
    if (!entry) {
      return { ok: false, code: 'entry-missing', message: '目标节点不存在，请刷新会话树后重试' }
    }
    return {
      ok: true,
      entryId: entry.id,
      targetLeafId: branchHasConversation(sessionManager, entry.id) ? entry.id : null,
    }
  }

  if (!entryId) {
    return { ok: false, code: 'entry-missing', message: '请选择要分叉的用户消息' }
  }
  const entry = sessionManager.getEntry(entryId)
  if (!entry) {
    return { ok: false, code: 'entry-missing', message: '目标节点不存在，请刷新会话树后重试' }
  }
  if (entry.type !== 'message' || entry.message.role !== 'user') {
    return { ok: false, code: 'not-user-message', message: '只能从用户消息处分叉' }
  }
  const selectedText = extractMessageText(entry.message)
  return {
    ok: true,
    entryId: entry.id,
    targetLeafId: branchHasConversation(sessionManager, entry.parentId) ? entry.parentId : null,
    ...(selectedText ? { selectedText } : {}),
  }
}

/** 创建子会话文件/管理器的输入。 */
export type CreateForkSessionInput = {
  sourceFile: string | undefined
  cwd: string
  sessionDir: string
  targetLeafId: string | null
}

/** 子会话文件创建失败（宿主转成 failed，不留下半成品）。 */
export class ForkSessionCreateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForkSessionCreateError'
  }
}

/**
 * 创建只包含「根 → 目标」路径的子会话管理器。
 *
 * 返回的管理器已经指向新文件（或尚未落盘的空会话）；调用方负责打开子会话。
 * 已存在的源文件缺失、目标节点不存在或持久化未启用时报错，不降级为整文件复制。
 */
export function createForkSessionManager(input: CreateForkSessionInput): {
  sessionManager: SessionManager
  sessionFile?: string
} {
  const { sourceFile, cwd, sessionDir, targetLeafId } = input
  if (targetLeafId === null) {
    // 首条用户消息之前 fork、或空会话 clone：新建空会话并记录血缘。
    const sessionManager = SessionManager.create(cwd, sessionDir, {
      ...(sourceFile ? { parentSession: sourceFile } : {}),
    })
    return { sessionManager }
  }
  if (!sourceFile) {
    throw new ForkSessionCreateError('源会话尚未落盘，无法分叉；请先发送一条消息')
  }
  if (!existsSync(sourceFile)) {
    throw new ForkSessionCreateError('源会话文件不存在，无法分叉')
  }
  // 独立句柄：createBranchedSession 会把它自身切到新文件，绝不能用于 live 父 manager。
  const branchManager = SessionManager.open(sourceFile, sessionDir, cwd)
  try {
    const file = branchManager.createBranchedSession(targetLeafId)
    if (!file) throw new ForkSessionCreateError('创建分叉会话文件失败')
    return { sessionManager: branchManager, sessionFile: file }
  } catch (error) {
    if (error instanceof ForkSessionCreateError) throw error
    throw new ForkSessionCreateError(
      error instanceof Error ? error.message : '创建分叉会话文件失败',
    )
  }
}
