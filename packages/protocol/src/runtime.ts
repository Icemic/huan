/**
 * 运行操作契约：直接 Shell、上下文压缩与模型目录刷新。
 *
 * 本模块只描述宿主 ↔ UI 的可序列化形状，不依赖 Pi SDK 与 Node。
 * 语义约定（G1.3a 设计）：
 * - Shell 与模型运行可并存；同一会话同时至多一条用户 Shell；
 * - 取消 Shell 与取消模型运行互相独立；
 * - 压缩要求会话空闲，失败保留原始消息树，原始错误只经受控文案暴露。
 */

import type { HarnessModelInfo } from './thread.js'

/**
 * 本轮运行统计。
 *
 * 统计范围为一次 `agent_start` 到 `agent_settled`（含重试、工具与等待）：
 * `outputTokens` 只汇总本轮助手消息的服务商用量；耗时用单调时钟，仅运行中
 * 采集，未计时或没有正输出时消费方显示占位。
 */
export type HarnessRunMetrics = {
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  outputTokens: number
  /** 本轮已运行耗时；运行中持续更新，结束后冻结。 */
  durationMs?: number
  /** 启动到首次非空思考/正文/工具调用内容的耗时。 */
  firstResponseMs?: number
}

/** 压缩触发原因（与 Pi 事件一致）。 */
export type HarnessCompactionReason = 'manual' | 'threshold' | 'overflow'

/**
 * 会话的压缩运行态（快照与事件共用）。
 *
 * `error` 是最近一次失败原因；成功后清除。取消不算失败，不写该字段。
 * 当前/最近一次操作的标识、结局与消息锚点也在这里投影；宿主以同一份
 * 记录同时响应事件与快照，浏览器不自行拼接第二套状态。
 */
export type HarnessCompactionPhase = {
  active: boolean
  reason?: HarnessCompactionReason
  /** 当前/最近一次操作的稳定标识；同一操作的 start/end/快照保持一致。 */
  operationId?: string
  /** 最近一次操作结局；进行中或冷读无记录时缺失。 */
  status?: 'compacted' | 'cancelled' | 'failed'
  /** 成功时对应的 Pi compaction entry；用于摘要展开与操作定位。 */
  entryId?: string
  /** 当前上下文中保留的持久摘要位置；新操作进行中或失败时仍展示它。 */
  summary?: { entryId: string; messageIndex: number }
  /** 结果行在会话消息中的插入位置；之后到达的消息显示在结果行后。 */
  messageIndex?: number
  tokensBefore?: number
  estimatedTokensAfter?: number
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

/** 模型目录刷新输入：显式指定会话、固定起始目录或已有共享注册表。 */
export type HarnessModelRefreshInput = {
  /** 会话 ID：使用该会话固定的 live cwd。 */
  threadId?: string
  /** 空白页的固定起始目录（绝对路径）。 */
  workspacePath?: string
  /** 只刷新已有共享模型注册表，不解析会话或目录。 */
  global?: boolean
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
