/**
 * JSONL 会话导入契约（宿主路径与浏览器上传两种来源）。
 *
 * 预览只解析/校验/检查目录与冲突，不装配项目、不执行项目代码；确认时宿主
 * 重新读取源并再次校验，预览不是授权 token。导入默认保留源 session ID 与
 * 完整树；同 ID 内容不同时必须由用户明确选择「作为独立副本导入」。
 */

/** 导入源：宿主绝对路径或浏览器上传的文本。 */
export type HarnessThreadImportSource =
  | { kind: 'path'; path: string }
  | {
      kind: 'upload'
      /** 仅供提示与错误信息；不用于拼接目标文件路径。 */
      filename: string
      /** JSONL 文本（宿主侧有大小上限）。 */
      content: string
    }

/** 解析出的源摘要（预览与结果共用）。 */
export type HarnessThreadImportSourceInfo = {
  kind: 'path' | 'upload'
  /** 会话 ID（header.id）。 */
  id?: string
  /** header.cwd（可能为空字符串或不存在于本机）。 */
  cwd?: string
  /** 显式会话名称（session_info 最后一条），缺失表示未命名。 */
  name?: string
  /** 会话条目数（不含 header）。 */
  entries?: number
  /** header.version（旧版会按 1/2 显示，导入后迁移到当前版本）。 */
  version?: number
  fingerprint?: string
  /** 源文本 UTF-8 字节数。 */
  size?: number
}

/** 导入错误分类（GUI 按类别给出可操作提示）。 */
export type HarnessThreadImportErrorCode =
  | 'invalid-input'
  | 'source-unreadable'
  | 'source-too-large'
  | 'invalid-json'
  | 'invalid-header'
  | 'unsupported-version'
  | 'invalid-entry'
  | 'duplicate-entry'
  | 'broken-chain'
  | 'cycle'
  | 'cwd-required'
  | 'cwd-unavailable'
  | 'cwd-not-member'
  | 'scope-invalid'
  | 'source-changed'
  | 'state-unavailable'
  | 'write-failed'
  | 'metadata-failed'

/** 同 ID 冲突状态。 */
export type HarnessThreadImportConflict = 'none' | 'already-exists' | 'conflict'

/** 预览输入。 */
export type HarnessThreadImportPreviewInput = {
  source: HarnessThreadImportSource
  /** 目标工作区；缺省使用宿主启动工作区（GUI 始终显式传入）。 */
  workspaceId?: string
  /** 显式选择的替代起始目录（必须是目标工作区成员）。 */
  cwdOverride?: string
}

/** 预览结果：只描述文件、目录与冲突，不表示导入已授权。 */
export type HarnessThreadImportPreview = {
  status: 'ok' | 'invalid' | 'failed'
  source?: HarnessThreadImportSourceInfo
  /** 目标工作区 ID。 */
  workspaceId?: string
  /** 实际使用的起始目录（替代目录或源 cwd）。 */
  cwd?: string
  /**
   * 源 cwd 是否为可用目录且属于目标工作区。
   * 缺失表示尚未解析出 cwd（如源无效）。
   */
  sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
  /** 目标存储目录（按有效起始目录解析）。 */
  sessionDir?: string
  /** 同 ID 冲突状态；`none` 表示可正常导入。 */
  conflict?: HarnessThreadImportConflict
  /** already-exists/conflict 时定位到的既有会话。 */
  existingThreadId?: string
  /** 冲突时是否可作为独立副本导入。 */
  canCopy?: boolean
  /** 需要用户注意的提示（敏感内容、版本迁移、替代 cwd 等）。 */
  warnings?: readonly string[]
  error?: HarnessThreadImportErrorCode
  message?: string
}

/** 确认导入输入。 */
export type HarnessThreadImportInput = {
  source: HarnessThreadImportSource
  workspaceId: string
  /** 显式选择的替代起始目录（必须是目标工作区成员）。 */
  cwdOverride?: string
  /** 同 ID 内容不同时作为独立副本导入（新 ID、保留完整树）。 */
  asCopy?: boolean
  /** 预览看到的源 ID；确认时源已变化则返回 source-changed。 */
  expectedSourceId?: string
  /** 预览的完整源文本指纹；同 ID 内容变化也拒绝。 */
  expectedSourceFingerprint?: string
}

/** 确认导入结果状态。 */
export type HarnessThreadImportStatus =
  | 'imported'
  | 'already-exists'
  | 'conflict'
  | 'invalid'
  | 'metadata-failed'
  | 'failed'

/** 确认导入结果。 */
export type HarnessThreadImportResult = {
  status: HarnessThreadImportStatus
  /** 导入成功（或元数据失败仍需定位）时的会话 ID。 */
  threadId?: string
  /** already-exists 定位到的既有会话。 */
  existingThreadId?: string
  /** 失败时的最新预览（源变化/目录/冲突），供 GUI 刷新后重试。 */
  preview?: HarnessThreadImportPreview
  error?: HarnessThreadImportErrorCode
  message?: string
}
