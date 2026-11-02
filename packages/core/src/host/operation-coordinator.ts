/**
 * 操作协调器：唯一写会话准入、结构租约、当前运行归属与取消/结算。
 *
 * 业务模块只经本模块取得租约或停止会话；record 的 `structure`、`admission`、
 * `currentRun`、`startingSend` 等闸门字段不应由其他模块直接修改。
 */

import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { HarnessThreadMetadata } from '@huan/protocol'
import {
  abortForRetire,
  discardDeferredRuns,
  hasOtherInFlight,
  type InFlightSend,
  RETIRE_DRAIN_TIMEOUT_MS,
  type RunAdmission,
  STOP_FOR_NAVIGATION_TIMEOUT_MS,
  STRUCTURE_SETTLE_TIMEOUT_MS,
  type StructureKind,
  type StructureOperation,
  type ThreadRecord,
  ThreadStructureBusyError,
  withTimeout,
} from './shared.js'

type SessionEvent = Parameters<Parameters<AgentSession['subscribe']>[0]>[0]

export type OperationCoordinatorDeps = {
  assertActive: () => void
  /** 本地诊断；用于 SDK 补偿字段变化等受控提示。 */
  diagnose?: (message: string) => void
  /** 结构状态变化广播快照（只由本模块触发）。 */
  emitSnapshot: (record: ThreadRecord) => void
}

export class OperationCoordinator {
  constructor(private readonly deps: OperationCoordinatorDeps) {}

  /** 唤醒所有等待准入闸门的发送（取消/退休时调用），使其重新检查条件并退出。 */
  wakeAdmissionWaiters(record: ThreadRecord): void {
    for (const wake of [...record.admissionWaiters]) wake()
    record.admissionWaiters.clear()
  }

  /**
   * 等待在途发送退出（会话收尾用）。
   *
   * 有上限：SDK 层无法中断阻塞在输入 hook 里的预检；超时后继续收尾，
   * 此时该发送视为已放弃（不再有能力启动运行——退休标记先行阻止）。
   */
  async drainInFlight(record: ThreadRecord): Promise<void> {
    const waits = [...record.inFlight].map((pending) => pending.finished)
    if (waits.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RETIRE_DRAIN_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 获取启动窗口（准入闸门）。
   *
   * 保证同一会话同时至多一个发送处于「预检 → 运行确认」段（统一占窗，
   * 不在「运行中」时偷跑：否则运行可能先结束、预检后完成，导致两个发送
   * 都走「启动运行」路径而重叠结算）。
   *
   * 返回 undefined 表示放弃本次发送（已取消 / 会话退休）。
   */
  async acquireAdmission(
    record: ThreadRecord,
    inFlight: InFlightSend,
    isCancelled: () => boolean,
  ): Promise<RunAdmission | undefined> {
    // 取消来源有二：冷打开窗口的 token（isCancelled）与发送级标记（cancelRun）。
    const cancelled = () => isCancelled() || inFlight.cancelled
    while (true) {
      if (record.retired || cancelled()) return undefined
      // 结构操作可能以 allowRunning 占窗（停止并跳转/重命名）；等待者被唤醒后
      // 必须重新检查，不能越过闸门进入预检。
      if (record.structure) return undefined
      const run = record.currentRun
      if (run !== undefined && !record.session.isStreaming) {
        // 「结算窗口」：SDK 已置 `_isAgentRunActive = false`（故 isStreaming 为假）
        // 但仍在 await 扩展的 agent_settled hook；此时 `prompt()` 会被静默压入
        // `_deferredSettledActions` 并立即返回（agent-session.js:1517），宿主会
        // 误判「已接受」而移除跟踪。等它真正结算后再评估。
        let wakeRun: () => void = () => {}
        const wokenRun = new Promise<void>((resolve) => {
          wakeRun = resolve
        })
        record.admissionWaiters.add(wakeRun)
        try {
          await Promise.race([run.settled, wokenRun])
        } finally {
          record.admissionWaiters.delete(wakeRun)
        }
        continue
      }
      // 正常运行中（isStreaming 为真）：交给 SDK 的排队分支（steer/follow-up），
      // 不在此等待——否则排队消息会被推迟到整次运行结算后才送达。
      const current = record.admission
      if (current === undefined) break
      // 等待前一个占窗者的预检结算；期间可被取消/退休路径唤醒以尽快退出。
      let wake: () => void = () => {}
      const woken = new Promise<void>((resolve) => {
        wake = resolve
      })
      record.admissionWaiters.add(wake)
      try {
        await Promise.race([current.done, woken])
      } finally {
        record.admissionWaiters.delete(wake)
      }
    }
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let released = false
    const admission: RunAdmission = {
      done,
      release: () => {
        if (released) return
        released = true
        if (record.admission === admission) record.admission = undefined
        resolveDone()
      },
    }
    record.admission = admission
    return admission
  }

  /**
   * 同步占用结构闸门。
   *
   * 必须在任何 await 之前调用：占窗成功后，发送会在预检前看到它并拒绝，
   * 其他结构操作也会明确返回 busy，不存在「await 后请求从旧状态穿过」的窗口。
   */
  beginStructure(
    record: ThreadRecord,
    kind: StructureKind,
    options: { targetId?: string; allowRunning?: boolean } = {},
  ): StructureOperation {
    this.deps.assertActive()
    if (record.retired) throw new ThreadStructureBusyError('会话正在关闭，不能修改结构')
    if (record.structure) throw new ThreadStructureBusyError()
    if (record.session.isCompacting) throw new ThreadStructureBusyError('会话正在压缩，请稍后重试')
    // 用户 Shell 直接产生副作用；结构操作（含压缩/分叉/导航）不得越过它，
    // 否则可能在命令执行中切换上下文或分支。
    if (record.bash?.status === 'running' || record.session.isBashRunning) {
      throw new ThreadStructureBusyError('用户 Shell 正在执行，请先取消或等待完成')
    }
    if (
      !options.allowRunning &&
      (record.session.isStreaming || record.currentRun !== undefined || hasOtherInFlight(record))
    ) {
      throw new ThreadStructureBusyError('会话正在运行或发送中，请先停止后再修改结构')
    }
    let markSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    const operation: StructureOperation = {
      kind,
      ...(options.targetId ? { targetId: options.targetId } : {}),
      status: 'running',
      summaryActive: false,
      startedAt: new Date().toISOString(),
      settled,
      markSettled,
      cancel: () => {
        // 收尾可中断长操作：分支摘要与压缩；普通导航/标签是短操作，等待其结束。
        if (kind === 'navigate') record.session.abortBranchSummary()
        if (kind === 'compact') record.session.abortCompaction()
      },
    }
    record.structure = operation
    this.deps.emitSnapshot(record)
    return operation
  }

  markStructureSummarizing(record: ThreadRecord, operation: StructureOperation): void {
    if (record.structure !== operation || operation.status === 'summarizing') return
    operation.status = 'summarizing'
    operation.summaryActive = true
    this.deps.emitSnapshot(record)
  }

  releaseStructure(record: ThreadRecord, operation: StructureOperation): void {
    if (record.structure !== operation) return
    record.structure = undefined
    operation.markSettled()
    this.deps.emitSnapshot(record)
  }

  /** 删除/销毁前取消并排空结构操作（有上限，不阻塞收尾）。 */
  async cancelAndDrainStructure(record: ThreadRecord): Promise<void> {
    const operation = record.structure
    if (!operation) return
    operation.cancel()
    await withTimeout(operation.settled, STRUCTURE_SETTLE_TIMEOUT_MS, '会话结构操作').catch(
      () => {},
    )
  }

  /**
   * 停止语义：中止当前运行、丢弃未交付队列、覆盖预检窗口。
   *
   * 调用方负责先取消会话打开前的 starting token（若有）。
   * 返回停止时取回的队列（运行中导航使用；普通停止忽略返回值）。
   */
  async stop(record: ThreadRecord): Promise<{ steering: string[]; followUp: string[] }> {
    for (const pending of record.inFlight) {
      if (!pending.accepted) pending.cancelled = true
    }
    if (record.startingSend) record.startingSend.cancelled = true
    if (record.currentRun) record.currentRun.cancelled = true
    // 丢弃 SDK 缓冲的延迟动作（扩展的 triggerTurn 消息），并置位清扫标记：
    // 它可能在取消后由 SDK 直接启动一个无归属运行。
    discardDeferredRuns(record.session, this.deps.diagnose)
    record.sweepUnattendedRun = true
    const recovered = record.session.clearQueue()
    this.wakeAdmissionWaiters(record)
    record.uiBridge.dismissAll()
    await record.session.abort()
    return recovered
  }

  /** 运行中导航：停止并在上限内等待结算，排空后再次取回晚入队文本。 */
  async stopForNavigation(
    record: ThreadRecord,
  ): Promise<{ steering: string[]; followUp: string[] }> {
    for (const pending of record.inFlight) {
      if (!pending.accepted) pending.cancelled = true
    }
    if (record.startingSend) record.startingSend.cancelled = true
    if (record.currentRun) record.currentRun.cancelled = true
    discardDeferredRuns(record.session, this.deps.diagnose)
    record.sweepUnattendedRun = true
    const recovered = record.session.clearQueue()
    this.wakeAdmissionWaiters(record)
    record.uiBridge.dismissAll()
    await withTimeout(record.session.abort(), STOP_FOR_NAVIGATION_TIMEOUT_MS, '停止运行').catch(
      () => {},
    )
    const run = record.currentRun
    if (run) {
      await withTimeout(run.settled, STOP_FOR_NAVIGATION_TIMEOUT_MS, '等待运行结算').catch(() => {})
    }
    await this.drainInFlight(record)
    // 停止窗口内仍可能有已通过预检的发送把输入补入 SDK 队列；排空后再取一次，
    // 避免「先清空、后入队」的条目被随运行收尾静默丢弃。
    const late = record.session.clearQueue()
    return {
      steering: [...recovered.steering, ...late.steering],
      followUp: [...recovered.followUp, ...late.followUp],
    }
  }

  /**
   * 运行事件中的归属与取消状态转换。
   *
   * 返回 settledError 时由事件模块在状态落地后广播 error；本模块不发送事件。
   */
  handleRunEvent(record: ThreadRecord, event: SessionEvent): string | undefined {
    if (event.type === 'agent_start') {
      if (record.currentRun === undefined) {
        // 一个运行周期开始：消费归属槽。准入闸门保证「预检 → 运行确认」段
        // 每会话串行，因此槽内至多一个发送，且必然属于本次运行。
        const owner = record.startingSend
        record.startingSend = undefined
        let markSettled: () => void = () => {}
        const settled = new Promise<void>((resolve) => {
          markSettled = resolve
        })
        record.currentRun = {
          owner,
          cancelled: owner?.cancelled ?? false,
          pendingError: undefined,
          settled,
          markSettled,
        }
      }
      const run = record.currentRun
      // 中止条件：
      // 1) 归属发送已取消 / 运行自身已取消（常规取消路径）；
      // 2) 会话已退休（延迟动作可能在收尾后启动运行）；
      // 3) 无归属运行 + 清扫标记（SDK 延迟动作在取消后启动的运行）。
      const unattended = run.owner === undefined && !record.retired
      const sweep = unattended && record.sweepUnattendedRun
      if (run.owner?.cancelled || run.cancelled || record.retired || sweep) {
        run.cancelled = true
        record.sweepUnattendedRun = false
        // 仅清扫无归属/延迟动作运行（sweep）时只中止 agent，不调用
        // session.abort：后者会顺带中止正在进行的结构摘要，而摘要属于另一个
        // 已占窗的结构操作。其余取消/退休路径仍走完整 session 中止。
        if (sweep && !run.owner?.cancelled && !record.retired) {
          record.session.agent.abort()
        } else {
          // 同步发起中止（内部置标志并 abort controller），不 await：
          // agent 会等待监听器返回，await 会与 waitForIdle 互锁。
          record.session.abort().catch(() => {})
        }
      } else if (run.owner !== undefined) {
        // 新一轮用户发起的运行：上一次取消的影响到此为止。
        record.sweepUnattendedRun = false
      }
    }

    if (event.type === 'agent_end') {
      // 只记录候选错误，不在此时裁定：agent_end 后 SDK 仍可能重试/压缩/继续。
      // 无条件赋值：「重试成功」的轮次会把候选错误清回 undefined。
      const run = record.currentRun
      if (run) run.pendingError = record.session.state.errorMessage ?? undefined
    }

    if (event.type !== 'agent_settled') return undefined
    const run = record.currentRun
    let settledError: string | undefined
    if (run) {
      if (event.aborted) run.cancelled = true
      if (!run.cancelled) {
        if (run.pendingError !== undefined) {
          record.lastError = run.pendingError
          settledError = run.pendingError
        } else if (record.lastError !== undefined) {
          // 本轮成功结束：清除此前残留的失败状态（失败不在轮次间存留）。
          record.lastError = undefined
        }
      }
      // 取消：保持既有 lastError 不变（取消不消灭此前失败的记录）。
    }
    record.currentRun = undefined
    run?.markSettled()
    return settledError
  }

  /** 当前状态是否允许 MCP 管理/登录重连。 */
  mcpRuntimeBusy(record: ThreadRecord): boolean {
    return (
      record.retired ||
      record.structure !== undefined ||
      record.session.isStreaming ||
      record.session.isCompacting ||
      record.session.isRetrying ||
      record.currentRun !== undefined ||
      record.inFlight.size > 0 ||
      record.bash?.status === 'running' ||
      record.session.isBashRunning
    )
  }

  /** 受控收尾中止（删除/销毁路径共用）。 */
  async abortForRetire(record: ThreadRecord): Promise<void> {
    await abortForRetire(record.session)
  }

  /** 运行状态投影（热会话）。 */
  runStatus(record: ThreadRecord): HarnessThreadMetadata['status'] {
    const session = record.session
    if (session.isStreaming || session.isCompacting || session.isRetrying) return 'running'
    return record.lastError ? 'failed' : 'idle'
  }
}
