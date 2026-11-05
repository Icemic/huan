/**
 * 本轮运行统计：O(1) 事件采集、结算与分支持久记录读取。
 *
 * 统计范围为一次 `agent_start` 到 `agent_settled`；重试与工具等待都属于同一
 * 运行，`agent_end` 不结算。计时只在运行中使用单调时钟，不根据字符数推测。
 * 主会话与子任务共用同一采集器，各自独立持有实例。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { HarnessRunMetrics } from '@huan/protocol'
import { isRunMetrics } from '@huan/protocol'

/** 运行结算状态；`running` 不能作为持久记录。 */
export type RunMetricsFinalStatus = Exclude<HarnessRunMetrics['status'], 'running'>

/** 助手消息增量中与首响应相关的子集（保持浏览器/Node 形状无关）。 */
type FirstResponseDelta = {
  type: string
  delta?: string
}

/** 读取助手消息输出用量所需的最小结构。 */
type AssistantUsageMessage = {
  role?: string
  usage?: { output?: unknown }
}

/** 会话记录的只读分支入口（主会话与子任务共用）。 */
type BranchSource = {
  getBranch(): readonly { id: string }[]
  getSessionFile(): string | undefined
  getLeafId(): string | null
}

/**
 * 以事件增量维护单轮统计，不扫描消息或会话树。
 *
 * `begin()` 会重置上一轮数据；`settle()` 冻结耗时并给出最终状态。运行中
 * `current()` 返回单调时钟下的实时耗时，浏览器直接消费服务端快照。
 */
export class RunMetricsRecorder {
  private metrics: HarnessRunMetrics | undefined
  private startedAt: number | undefined
  private outputTokens = 0
  private firstResponseMs: number | undefined
  private partialOutputTokens = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** 开始新一轮；上一轮统计立即失效。 */
  begin(): HarnessRunMetrics {
    if (this.metrics?.status === 'running') return { ...this.metrics }
    this.startedAt = this.now()
    this.outputTokens = 0
    this.partialOutputTokens = 0
    this.firstResponseMs = undefined
    this.metrics = { status: 'running', outputTokens: 0 }
    return { ...this.metrics }
  }

  /** 每500ms发布权威耗时，工具等待期间也继续更新；不写磁盘。 */
  publish(update: (metrics: HarnessRunMetrics) => void): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const metrics = this.current()
      if (metrics?.status === 'running') update(metrics)
    }, 500)
    this.timer.unref()
  }

  /** 会话释放时清理更新器。 */
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 流式usage为当前模型响应的累计快照，不逐增量相加。 */
  observePartial(message: unknown): void {
    const candidate = message as AssistantUsageMessage
    const output = candidate.usage?.output
    if (
      candidate.role === 'assistant' &&
      typeof output === 'number' &&
      Number.isFinite(output) &&
      output >= 0
    ) {
      this.partialOutputTokens = output
    }
  }

  /** 首次非空思考/正文/工具调用增量记录首响应时间。 */
  observeDelta(delta: FirstResponseDelta): void {
    if (this.metrics?.status !== 'running' || this.firstResponseMs !== undefined) return
    if (
      delta.type !== 'text_delta' &&
      delta.type !== 'thinking_delta' &&
      delta.type !== 'toolcall_delta'
    ) {
      return
    }
    if (!delta.delta) return
    if (this.startedAt === undefined) return
    this.firstResponseMs = Math.max(0, this.now() - this.startedAt)
    this.metrics = { ...this.metrics, firstResponseMs: this.firstResponseMs }
  }

  /** 汇总一次助手消息结束时的服务商输出用量（重试轮次继续累加）。 */
  observeMessage(message: unknown): void {
    if (this.metrics?.status !== 'running') return
    const candidate = message as AssistantUsageMessage
    if (candidate.role !== 'assistant') return
    this.partialOutputTokens = 0
    const output = candidate.usage?.output
    if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0) return
    this.outputTokens += output
    this.metrics = { ...this.metrics, outputTokens: this.outputTokens }
  }

  /** 冻结本轮耗时与结局；重复结算保持首次结果。 */
  settle(status: RunMetricsFinalStatus): HarnessRunMetrics | undefined {
    if (!this.metrics) return undefined
    if (this.metrics.status !== 'running') return { ...this.metrics }
    const durationMs =
      this.startedAt === undefined ? undefined : Math.max(0, this.now() - this.startedAt)
    this.dispose()
    this.metrics = {
      status,
      outputTokens: this.outputTokens + this.partialOutputTokens,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(this.firstResponseMs !== undefined ? { firstResponseMs: this.firstResponseMs } : {}),
    }
    this.startedAt = undefined
    return { ...this.metrics }
  }

  /** 当前（运行中）或最近一次统计；未开始过时缺失。 */
  current(): HarnessRunMetrics | undefined {
    if (!this.metrics) return undefined
    return {
      ...this.metrics,
      ...(this.metrics.status === 'running' && this.startedAt !== undefined
        ? {
            outputTokens: this.outputTokens + this.partialOutputTokens,
            durationMs: Math.max(0, this.now() - this.startedAt),
          }
        : {}),
    }
  }
}

const recordsCache = new WeakMap<
  BranchSource,
  { file: string | undefined; records: Record<string, HarnessRunMetrics> }
>()

/** 附加统计独立于Pi JSONL，避免影响压缩切点和树节点。 */
function readMetrics(source: BranchSource): Record<string, HarnessRunMetrics> {
  const file = source.getSessionFile()
  const cached = recordsCache.get(source)
  if (cached && cached.file === file) return cached.records
  let records: Record<string, HarnessRunMetrics> = {}
  if (file && existsSync(`${file}.huan-metrics.json`)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(`${file}.huan-metrics.json`, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records = Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => isRunMetrics(value)),
        )
      }
    } catch (error) {
      console.error('[huan-core] 运行统计读取失败：', error)
    }
  }
  recordsCache.set(source, { file, records })
  return records
}

/** 按目标分支的节点倒序查找，旧分支的统计不会跨分支显示。 */
export function latestRunMetricsFromBranch(source: BranchSource): HarnessRunMetrics | undefined {
  const records = readMetrics(source)
  const branch = source.getBranch()
  for (let index = branch.length - 1; index >= 0; index--) {
    const id = branch[index]?.id
    if (id && isRunMetrics(records[id])) return { ...records[id] }
  }
  return undefined
}

/** 原子保存到会话旁的huan统计文件，不插入Pi条目。 */
export function persistRunMetrics(source: BranchSource, metrics: HarnessRunMetrics): void {
  const file = source.getSessionFile()
  const leaf = source.getLeafId()
  if (!file || !leaf || metrics.status === 'running') return
  try {
    const records = { ...readMetrics(source), [leaf]: { ...metrics } }
    recordsCache.set(source, { file, records })
    const target = `${file}.huan-metrics.json`
    const temporary = `${target}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(records))
    renameSync(temporary, target)
  } catch (error) {
    console.error('[huan-core] 运行统计保存失败：', error)
  }
}
