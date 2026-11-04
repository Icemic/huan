/** SDK 子任务的持久摘要与按需只读查看契约。 */
import type {
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessThreadSnapshot,
} from './thread.js'

export type HarnessSubagentTaskStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled'

export type HarnessSubagentUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export type HarnessSubagentTask = {
  taskId: string
  parentThreadId: string
  agent: string
  task: string
  status: HarnessSubagentTaskStatus
  model?: string
  output?: string
  error?: string
  /** 子任务正在等待的用户答复数，便于父工具直接提示。 */
  pendingRequestCount?: number
  usage: HarnessSubagentUsage
}

/** 父工具内容仅保存任务摘要，完整子消息按需读取。 */
export type HarnessSubagentDetails = {
  kind: 'huan-subagent'
  mode: 'single' | 'parallel' | 'chain'
  tasks: readonly HarnessSubagentTask[]
}

export type HarnessSubagentTaskView = {
  task: HarnessSubagentTask
  snapshot?: HarnessThreadSnapshot
  requests: readonly HarnessHostUiRequest[]
}

export interface HarnessSubagentClient {
  getSubagentTask(parentThreadId: string, taskId: string): Promise<HarnessSubagentTaskView>
  cancelSubagentTask(parentThreadId: string, taskId: string): Promise<void>
  respondSubagentTask(
    parentThreadId: string,
    taskId: string,
    response: HarnessHostUiResponse,
  ): Promise<void>
}
