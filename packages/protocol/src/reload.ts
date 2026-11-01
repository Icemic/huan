/**
 * 资源重载契约（G1.4b）。
 *
 * 纯 TS、JSON-safe：会话目标保持同一 Pi 会话（消息、活动分支与订阅不替换），
 * 只刷新设置、指令、扩展与命令目录；空白页目标只刷新该 cwd 的待消费装配，
 * 不创建会话、不停止同 cwd 的其他会话。
 *
 * 语义约定（迭代设计）：
 * - 重载与模型运行、发送、用户 Shell、结构操作互斥，busy 如实报告；
 * - 失败不清空消息/草稿，也不伪报成功（`status` 为唯一权威）；
 * - 每次重载有独立操作身份，`resourceRevision` 供命令目录/设置面板失效旧结果；
 * - 项目资源需要信任时不允许借重载绕过：未取得明确授权时返回 `trust` 失败。
 */

import type { HarnessSettingsTargetInput } from './settings.js'
import type {
  HarnessReloadOperation,
  HarnessReloadTrigger,
  HarnessThreadSnapshot,
} from './thread.js'

/** 重载目标：会话或空白页固定起始目录二选一（与设置/资源查询同形）。 */
export type HarnessReloadTargetInput = HarnessSettingsTargetInput & {
  /** 触发来源；缺省按 api 处理（扩展命令走 ctx.reload）。 */
  trigger?: HarnessReloadTrigger
}

/** 重载失败类别（受控值，用于页面给出可操作提示）。 */
export type HarnessReloadFailureReason =
  /** 新出现需要信任的项目资源，且没有保存/显式/默认的明确授权。 */
  | 'trust'
  /** 资源装配或 SDK 重载抛错；旧扩展可能已被关闭，可重试。 */
  | 'assembly'
  /** 宿主已销毁或会话正在关闭。 */
  | 'disposed'

/** 资源重载结果。 */
export type HarnessReloadResult =
  | {
      status: 'reloaded'
      /** 会话目标（同一会话保活）或空白页目标（仅待消费装配）。 */
      kind: 'session' | 'workspace'
      workspacePath: string
      threadId?: string
      operation: HarnessReloadOperation
      resourceRevision: number
      /** 会话目标的权威快照；空白页目标不创建会话，故缺失。 */
      snapshot?: HarnessThreadSnapshot
    }
  | {
      status: 'busy'
      /** busy 的受控说明（运行/发送/Shell/结构操作互斥）。 */
      message: string
      workspacePath: string
      threadId?: string
    }
  | {
      status: 'failed'
      reason: HarnessReloadFailureReason
      message: string
      operation: HarnessReloadOperation
    }
  | {
      status: 'cancelled'
      message: string
      operation: HarnessReloadOperation
    }
