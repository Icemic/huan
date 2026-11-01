/**
 * 运行操作契约：直接 Shell、上下文压缩与模型范围。
 *
 * 本模块只描述宿主 ↔ UI 的可序列化形状，不依赖 Pi SDK 与 Node。
 * 语义约定（G1.3a 设计）：
 * - Shell 与模型运行可并存；同一会话同时至多一条用户 Shell；
 * - 取消 Shell 与取消模型运行互相独立；
 * - 压缩要求会话空闲，失败保留原始消息树，原始错误只经受控文案暴露；
 * - 模型范围默认只作用于当前会话，保存用户默认是独立的显式操作。
 */

import type { HarnessModelInfo, HarnessThinkingLevel } from './thread.js'

/** 压缩触发原因（与 Pi 事件一致）。 */
export type HarnessCompactionReason = 'manual' | 'threshold' | 'overflow'

/**
 * 会话的压缩运行态（快照与事件共用）。
 *
 * `error` 是最近一次失败原因；成功后清除。取消不算失败，不写该字段。
 */
export type HarnessCompactionPhase = {
  active: boolean
  reason?: HarnessCompactionReason
  error?: string
}

/** 手动压缩结果。失败/取消都会保留原始消息树，由宿主如实报告。 */
export type HarnessCompactionOutcome =
  | {
      status: 'compacted'
      tokensBefore?: number
      estimatedTokensAfter?: number
    }
  | { status: 'cancelled'; message?: string }
  | { status: 'busy'; message: string }
  | { status: 'failed'; message: string }

/** 取消压缩的结果：requested 表示已发出中止信号，idle 表示当前没有压缩。 */
export type HarnessCompactionAbortResult = { status: 'requested' } | { status: 'idle' }

/**
 * 用户 Shell 的执行结果摘要（`!` / `!!`）。
 *
 * 与 Pi 持久化的 bashExecution 消息区分：这里是运行态摘要，
 * `outputTruncated` 只描述实时缓冲是否丢过前缀，不代表 SDK 持久结果的截断。
 */
export type HarnessBashResult = {
  /** 退出码；被取消时缺失。 */
  exitCode?: number
  cancelled: boolean
  /** SDK 持久结果的截断标记（与 fullOutputPath 配套）。 */
  truncated: boolean
  fullOutputPath?: string
  endedAt: string
  /** 启动/执行失败原因；此时不会写入历史消息。 */
  error?: string
}

/** 一条用户 Shell 的实时状态（快照与事件共用）。 */
export type HarnessBashRun = {
  id: string
  command: string
  /** true（`!!`）：结果保留在历史，但不进入模型上下文。 */
  excludeFromContext: boolean
  /** 宿主固定起始目录；命令在此目录直接执行，不提供沙箱。 */
  cwd: string
  status: 'running' | 'complete'
  /** 有界输出（宿主上限内，见 outputTruncated）。 */
  output: string
  /** 实时缓冲已丢弃过前缀（不是 SDK 持久结果的 truncated）。 */
  outputTruncated: boolean
  startedAt: string
  result?: HarnessBashResult
}

/** 启动用户 Shell 的结果。 */
export type HarnessBashStartResult =
  | { status: 'started'; run: HarnessBashRun }
  /** 会话已有用户 Shell 或结构操作进行中。 */
  | { status: 'busy'; message: string }
  /** 扩展拦截失败等启动期错误；不会回退为本地执行。 */
  | { status: 'failed'; message: string }

/** 取消用户 Shell 的结果。 */
export type HarnessBashAbortResult = { status: 'requested' } | { status: 'idle' }

/** 模型范围中的一项（与 Pi ScopedModel 对应）。 */
export type HarnessModelScopeModel = {
  provider: string
  modelId: string
  thinkingLevel?: HarnessThinkingLevel
}

/** 范围解析诊断（与 Pi ModelScopeDiagnostic 的 code 对应）。 */
export type HarnessModelScopeDiagnostic = {
  code: 'no-match' | 'invalid-thinking-level' | 'ambiguous'
  message: string
  pattern: string
}

/** 会话模型范围。 */
export type HarnessModelScope = {
  /** 当前会话的范围模式；空数组表示不限制（全部可用模型）。 */
  patterns: readonly string[]
  /** 解析后的会话范围模型；空数组表示全部。 */
  models: readonly HarnessModelScopeModel[]
  diagnostics: readonly HarnessModelScopeDiagnostic[]
  /** 已保存的用户默认范围（当前 agentDir 设置）；缺失表示未设置。 */
  savedPatterns?: readonly string[]
}

/** 更新会话模型范围的输入。 */
export type HarnessModelScopeUpdateInput = {
  patterns: readonly string[]
  /** 显式保存为用户默认（写入当前 agentDir 设置）；只影响未来会话。 */
  saveAsDefault?: boolean
}

/** 更新会话模型范围的结果。 */
export type HarnessModelScopeUpdateResult = HarnessModelScope & {
  /**
   * 用户默认的写盘结果；未请求保存时为 skipped。
   * failed 表示会话范围已生效但用户默认未保存（绝不伪报成功）。
   */
  persistence: 'saved' | 'failed' | 'skipped'
  /** persistence 为 failed 时的可读说明。 */
  message?: string
}

/** 模型目录刷新输入：必须显式指定会话或固定起始目录。 */
export type HarnessModelRefreshInput = {
  /** 会话 ID：使用该会话固定的 live cwd。 */
  threadId?: string
  /** 空白页的固定起始目录（绝对路径）。 */
  workspacePath?: string
}

/** 模型目录刷新结果。 */
export type HarnessModelRefreshResult = {
  models: readonly HarnessModelInfo[]
  /** 刷新失败或被网络刷新跳过的 provider；不返回原始错误文案。 */
  failedProviders: readonly string[]
}

/** 自动压缩开关的保存结果。 */
export type HarnessAutoCompactionUpdateResult =
  | {
      status: 'saved'
      /** 当前会话实际生效的开关（项目设置可能覆盖用户默认）。 */
      enabled: boolean
      /** 保存范围：始终是当前 agentDir 的用户设置。 */
      scope: 'global'
      /** true 表示项目设置覆盖了刚保存的用户默认值。 */
      overridden?: boolean
      message?: string
    }
  | {
      status: 'failed'
      /** 失败时磁盘值未变，已回滚内存设置。 */
      message: string
    }
