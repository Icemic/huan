/**
 * SDK 子任务服务：持有子会话装配、持久摘要、逐任务取消与 Host UI 转发。
 *
 * 边界：
 * - 子会话不进入普通会话目录，也不调用 `LiveSessions.openSession` 发布 record；
 *   任务摘要写入 `<agentDir>/huan/subagents/<parent>/<task>/task.json`，子会话
 *   写入同目录的 `session.jsonl`，重启后按需只读投影；
 * - 每个任务独立装配 loader/MCP binding 与 `SessionManager`，父会话只提供
 *   创建任务时捕获的模型、Thinking、工具、MCP 选择与工作区归属；
 * - 运行期子事件只维护该子 record 的瞬态状态，不进入父 record/coordinator，
 *   `getTask` 以轮询快照与待答请求返回，不新增子事件总线。
 */
import { randomUUID } from 'node:crypto'
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  type ProjectTrustContext,
  resolveCliModel,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { McpServerOverrides } from '@huan/mcp'
import type {
  HarnessAgentMessage,
  HarnessHostUiResponse,
  HarnessSubagentDetails,
  HarnessSubagentTask,
  HarnessSubagentTaskStatus,
  HarnessSubagentTaskView,
  HarnessSubagentUsage,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessToolExecutionSnapshot,
} from '@huan/protocol'
import { isRunMetrics } from '@huan/protocol'
import type { HostUiBridge } from '../host-ui.js'
import { createHostUiBridge } from '../host-ui.js'
import { projectSessionRecord } from '../metadata.js'
import {
  getModelReadiness,
  globalModelPatterns,
  resolveModelScopePatterns,
} from '../model-catalog.js'
import { type RunMetricsFinalStatus, RunMetricsRecorder } from '../run-metrics.js'
import { aggregateSessionStats } from '../session-stats.js'
import type { SubagentAgentDefinition } from '../subagent-definitions.js'
import type {
  SubagentTaskContext,
  SubagentTaskExecution,
  SubagentTaskRunner,
} from '../subagent-tool.js'
import type { WorkspaceStore } from '../workspace-store.js'
import { jsonSafeSnapshot } from './json-safe.js'
import type { SharedModelRuntime } from './model-service.js'
import type { ProjectAssembly } from './project-assembly.js'
import { createHostUiState, type SessionEvents } from './session-events.js'
import {
  discardDeferredRuns,
  type PreparedProject,
  sendContext,
  type ThreadRecord,
  UnsupportedHostCommandActionError,
  withTimeout,
} from './shared.js'

/** 子会话固定文件名；目录按 taskId 隔离，客户端不能提供路径。 */
const SUBAGENT_SESSION_FILE = 'session.jsonl'
const SUBAGENT_TASK_FILE = 'task.json'
/** 运行期取消等待上限（超时仍返回，不阻塞 UI）。 */
const SUBAGENT_CANCEL_TIMEOUT_MS = 5_000
/** 任务 ID/父会话 ID 只允许安全字符，避免路径穿越。 */
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

type ThinkingLevel = Parameters<AgentSession['setThinkingLevel']>[0]
type SubagentModel = NonNullable<AgentSession['model']>

/**
 * 子会话专用的项目装配选项。
 *
 * `subagent` 用于让装配区分隐藏子会话（如注入拒绝嵌套的 `subagent` 工具）；
 * `appendSystemPrompt` 只追加定义正文，不替换父系统提示；`mcpOverrides`
 * 只在目标 cwd 与父 cwd 相同时继承父连接管理器的启停/exposure 选择。
 */
export type SubagentPrepareOptions = {
  subagent?: boolean
  appendSystemPrompt?: string[]
  mcpOverrides?: Record<string, McpServerOverrides>
  /** 装配期信任扩展的询问也归该子任务，由其取消流程解除。 */
  projectTrustContext?: ProjectTrustContext
}

/** 服务借用的项目装配能力。 */
export type SubagentSessionsAssembly = {
  prepare: (
    cwd: string,
    override?: boolean,
    disposed?: boolean,
    options?: SubagentPrepareOptions,
  ) => Promise<PreparedProject>
  closeBinding: ProjectAssembly['closeBinding']
  transferBinding: ProjectAssembly['transferBinding']
}

export type SubagentSessionsDeps = {
  agentDir: string
  modelRuntime: SharedModelRuntime
  workspaceStore: Pick<WorkspaceStore, 'workspace'>
  assembly: SubagentSessionsAssembly
  /** 热任务快照投影；子 record 不发布到 live/catalog，也不调用父事件归约。 */
  events: Pick<SessionEvents, 'snapshotOf'>
}

/** 持久摘要的内部字段；返回协议任务时会剥离这些字段。 */
type StoredSubagentTask = HarnessSubagentTask & {
  toolCallId: string
  cwd: string
  workspaceId?: string
  modelProvider?: string
  modelId?: string
  thinkingLevel?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * createTask 时固定的父会话选择。
 *
 * 等待中的任务不能等到真正执行时才读取父 current，否则并行队列会继承
 * 已经变化的模型、Thinking、工具、MCP 启停或工作区归属。父 record 仍保留，
 * 但只用于装配所需的信任绑定与工作区资源。
 */
type ParentCapture = {
  workspacePath: string
  workspaceId?: string
  workspaceAppliedRevision?: number
  resourceRevision?: number
  modelProvider?: string
  modelId?: string
  thinkingLevel?: string
  tools: string[]
  mcpOverrides?: Record<string, McpServerOverrides>
}

type TaskState = {
  task: StoredSubagentTask
  parent: ThreadRecord
  agent: SubagentAgentDefinition
  capture: ParentCapture
  /** 逐任务取消也覆盖装配期和扩展后续产生的询问。 */
  controller: AbortController
  cancelReason?: string
  started: boolean
  finished: boolean
  progress?: (task: HarnessSubagentTask) => void
  /** 子任务最近一轮运行统计；与主会话共用采集器但实例独立。 */
  runMetrics: RunMetricsRecorder
  session?: AgentSession
  sessionManager?: SessionManager
  record?: ThreadRecord
  bridge?: HostUiBridge
  unsubscribe?: () => void
  abortSignal?: AbortSignal
  abortListener?: () => void
  closeBinding?: () => Promise<void>
  done?: Promise<void>
  resolveDone?: () => void
}

/**
 * 子任务服务。
 *
 * 同时实现 `SubagentTaskRunner` 与按需读取/取消/应答接口；父工具通过
 * `createTask`/`runTask` 编排，协议层通过 `getTask`/`cancelTask`/`respondTask`
 * 读取和操作单个任务。
 */
export class SubagentSessions implements SubagentTaskRunner {
  private readonly root: string
  private readonly states = new Map<string, TaskState>()

  constructor(private readonly deps: SubagentSessionsDeps) {
    this.root = join(resolve(deps.agentDir), 'huan', 'subagents')
  }

  /** 同步创建 waiting 摘要并落盘；同时固定父会话的模型/工具/MCP/工作区选择。 */
  createTask(context: SubagentTaskContext): HarnessSubagentTask {
    const parent = context.parent
    if (!parent) throw new Error('子任务缺少父会话记录。')
    this.assertId(parent.threadId, '父会话 ID')
    const taskId = randomUUID()
    const parentModel = parent.session.model
    const mcpOverrides = mcpOverridesOf(parent)
    const capture: ParentCapture = {
      workspacePath: parent.workspacePath,
      ...(parent.workspaceId ? { workspaceId: parent.workspaceId } : {}),
      ...(parent.workspaceAppliedRevision !== undefined
        ? { workspaceAppliedRevision: parent.workspaceAppliedRevision }
        : {}),
      ...(parent.resourceRevision !== undefined
        ? { resourceRevision: parent.resourceRevision }
        : {}),
      ...(parentModel
        ? {
            modelProvider: parentModel.provider,
            modelId: parentModel.id,
            thinkingLevel: parent.session.thinkingLevel,
          }
        : {}),
      tools: [...parent.session.getActiveToolNames()],
      ...(mcpOverrides ? { mcpOverrides } : {}),
    }
    const task: StoredSubagentTask = {
      taskId,
      parentThreadId: parent.threadId,
      agent: context.agent.name,
      task: context.task,
      status: 'waiting',
      usage: zeroUsage(),
      toolCallId: context.toolCallId,
      cwd: resolve(context.cwd),
      ...(capture.workspaceId ? { workspaceId: capture.workspaceId } : {}),
      ...(parentModel
        ? {
            modelProvider: parentModel.provider,
            modelId: parentModel.id,
            model: `${parentModel.provider}/${parentModel.id}`,
            thinkingLevel: parent.session.thinkingLevel,
          }
        : {}),
      createdAt: new Date().toISOString(),
    }
    mkdirSync(this.taskDir(parent.threadId, taskId), { recursive: true })
    this.writeStored(task)

    const state: TaskState = {
      task,
      parent,
      agent: context.agent,
      capture,
      controller: new AbortController(),
      progress: context.onProgress,
      started: false,
      finished: false,
      runMetrics: new RunMetricsRecorder(),
    }
    this.states.set(taskId, state)
    if (context.signal) this.attachSignal(state, context.signal)
    return publicTask(task)
  }

  /** 执行已创建任务；运行失败返回 failed/cancelled 摘要。 */
  async runTask(input: SubagentTaskExecution): Promise<HarnessSubagentTask> {
    // 父发送的 sendContext 不能泄漏到子会话 input hook；caller 上下文保留，
    // 但子 bridge 不允许写主输入框。
    return sendContext.run(undefined, () => this.executeTask(input, input.signal))
  }

  /** 读取任务摘要与按需快照；热任务用 record 投影，冷任务重开 JSONL。 */
  async getTask(parentThreadId: string, taskId: string): Promise<HarnessSubagentTaskView> {
    this.assertId(parentThreadId, '父会话 ID')
    this.assertId(taskId, '任务 ID')
    const state = this.states.get(taskId)
    if (state) {
      if (state.task.parentThreadId !== parentThreadId) throw unknownTask()
      const snapshot = state.record ? this.deps.events.snapshotOf(state.record) : undefined
      if (snapshot) {
        snapshot.metadata.status = threadStatusOf(state.task.status)
        if (state.task.runMetrics) snapshot.metadata.runMetrics = { ...state.task.runMetrics }
      }
      return {
        task: publicTask(state.task),
        snapshot,
        requests: state.bridge ? state.bridge.pending() : [],
      }
    }
    const stored = this.readStored(parentThreadId, taskId)
    const view = recoveredTask(stored)
    return {
      task: publicTask(view),
      snapshot: this.coldSnapshot(view),
      requests: [],
    }
  }

  /**
   * 按父会话当前分支投影恢复缺少最终结果的 subagent 工具执行。
   *
   * 只读取该父会话自己的任务目录一次，并只用持久 `toolCallId` 与当前消息里
   * 尚无 toolResult 的调用精确关联；旧分支、已有最终结果和没有任务摘要的
   * 调用都不会产生恢复项。已完成/失败的摘要保持原样，running/waiting 按
   * 服务不再持有投影为 cancelled，并清掉待答计数。本方法只读，不写回
   * task.json；调用方负责让真实活动工具优先于恢复项。
   */
  recoverToolExecutions(
    parentThreadId: string,
    messages: readonly HarnessAgentMessage[],
  ): HarnessToolExecutionSnapshot[] {
    this.assertId(parentThreadId, '父会话 ID')
    const calls = missingSubagentCalls(messages)
    // 当前服务仍持有的任务由实时进度负责，不读取或恢复为停止状态。
    for (const state of this.states.values()) {
      if (state.task.parentThreadId === parentThreadId && !state.finished) {
        calls.delete(state.task.toolCallId)
      }
    }
    if (calls.size === 0) return []
    const tasksByCall = this.readRecoverableTasks(parentThreadId)
    const recovered: HarnessToolExecutionSnapshot[] = []
    for (const [toolCallId, args] of calls) {
      const tasks = tasksByCall.get(toolCallId)
      if (!tasks || tasks.length === 0) continue
      const details: HarnessSubagentDetails = {
        kind: 'huan-subagent',
        mode: subagentModeOfArguments(args),
        tasks: tasks.map((task) => publicTask(recoveredTask(task))),
      }
      recovered.push({
        toolCallId,
        toolName: 'subagent',
        args,
        // 父调用没有最终结果，表示执行被中断；子卡仍保留各任务自己的结局。
        partialResult: {
          content: [{ type: 'text', text: '工具执行已中断（服务不再持有）。' }],
          details,
        },
        status: 'error',
      })
    }
    return recovered
  }

  /** 取消单个任务；等待项直接标 cancelled，运行项中止子会话并等待清理。 */
  async cancelTask(parentThreadId: string, taskId: string): Promise<void> {
    this.assertId(parentThreadId, '父会话 ID')
    this.assertId(taskId, '任务 ID')
    const state = this.states.get(taskId)
    if (!state) {
      const stored = this.readStored(parentThreadId, taskId)
      if (isTerminal(stored.status)) return
      stored.status = 'cancelled'
      stored.error = '任务已取消。'
      this.writeStored(stored)
      return
    }
    if (state.task.parentThreadId !== parentThreadId) throw unknownTask()
    this.cancelNow(state, '任务已取消。')
    if (state.done) {
      await withTimeout(state.done, SUBAGENT_CANCEL_TIMEOUT_MS, '子任务取消').catch(() => {})
    }
  }

  /** 应答子任务当前待答的 Host UI 请求；冷任务/未知请求明确拒绝。 */
  async respondTask(
    parentThreadId: string,
    taskId: string,
    response: HarnessHostUiResponse,
  ): Promise<void> {
    this.assertId(parentThreadId, '父会话 ID')
    this.assertId(taskId, '任务 ID')
    const state = this.states.get(taskId)
    if (!state || state.task.parentThreadId !== parentThreadId || !state.bridge) {
      throw new Error('子任务当前没有待答请求。')
    }
    if (!state.bridge.resolve(response)) {
      throw new Error('子任务请求不存在、已结算或应答不合法。')
    }
  }

  /** 服务关闭：中止运行中的子会话并取消等待任务；清理信号监听。 */
  async dispose(): Promise<void> {
    const states = [...this.states.values()]
    for (const state of states) this.cancelNow(state, '服务已关闭。')
    await Promise.all(
      states.map((state) =>
        state.done
          ? withTimeout(state.done, SUBAGENT_CANCEL_TIMEOUT_MS, '子任务取消').catch(() => {})
          : Promise.resolve(),
      ),
    )
  }

  private async executeTask(
    input: SubagentTaskExecution,
    signal: AbortSignal,
  ): Promise<HarnessSubagentTask> {
    const taskId = input.summary.taskId
    const parentThreadId = input.summary.parentThreadId
    this.assertId(parentThreadId, '父会话 ID')
    this.assertId(taskId, '任务 ID')

    // waiting 任务必须由本服务 createTask 创建；禁止从 task.json 恢复执行。
    const state = this.states.get(taskId)
    if (!state) {
      const stored = this.readStored(parentThreadId, taskId)
      if (isTerminal(stored.status)) return publicTask(stored)
      throw unknownTask()
    }
    if (state.task.parentThreadId !== parentThreadId) throw unknownTask()
    if (isTerminal(state.task.status) || state.started) return publicTask(state.task)

    state.progress = input.onProgress
    this.attachSignal(state, signal)
    if (this.isCancelled(state, signal)) {
      this.cancelNow(state, state.cancelReason ?? '父工具调用已取消。')
      return publicTask(state.task)
    }

    state.started = true
    state.done = new Promise<void>((resolveDone) => {
      state.resolveDone = resolveDone
    })
    this.setRunning(state)
    let prepared: PreparedProject | undefined

    try {
      const hostUi = createHostUiState()
      hostUi.title = subagentTitle(state.task)
      const bridge = this.createChildBridge(state, hostUi)
      state.bridge = bridge
      const capture = state.capture
      const sameCwd = samePath(state.task.cwd, capture.workspacePath)
      const parentTrust = state.parent.trustBinding?.state?.()
      // 同 cwd 可沿用父会话已作出的信任；但父会话仅因「无项目资源」而
      // trusted 时不能沿用，目标出现新资源必须重新检查。
      const parentTrusted =
        sameCwd && parentTrust?.status === 'trusted' && parentTrust.source !== 'no-resources'

      const trustOverride =
        sameCwd && parentTrust?.status === 'untrusted' ? false : parentTrusted ? true : undefined
      prepared = await this.deps.assembly.prepare(
        state.task.cwd,
        trustOverride,
        false,
        this.prepareOptions(state, sameCwd, bridge),
      )
      const mcp = prepared.mcp
      let closePromise: Promise<void> | undefined
      state.closeBinding = () => {
        closePromise ??= this.deps.assembly.closeBinding(mcp).catch((error: unknown) => {
          console.error('[huan-core] 子任务 MCP binding 关闭失败：', error)
        })
        return closePromise
      }
      this.deps.assembly.transferBinding(mcp)
      if (this.isCancelled(state, signal)) return this.finishCancelled(state)

      state.task.cwd = prepared.trust.state.cwd
      if (prepared.trust.state.status === 'needs-trust') {
        throw new Error('子任务目标项目尚未获得信任，已拒绝运行。')
      }

      const resolved = await this.resolveModel(state, prepared)
      if (this.isCancelled(state, signal)) return this.finishCancelled(state)
      state.task.model = `${resolved.model.provider}/${resolved.model.id}`
      state.task.modelProvider = resolved.model.provider
      state.task.modelId = resolved.model.id
      if (resolved.thinkingLevel) state.task.thinkingLevel = resolved.thinkingLevel
      this.writeStored(state.task)

      const taskDir = this.taskDir(state.task.parentThreadId, state.task.taskId)
      const sessionManager = SessionManager.create(prepared.trust.state.cwd, taskDir)
      const sessionFile = join(taskDir, SUBAGENT_SESSION_FILE)
      sessionManager.setSessionFile(sessionFile)
      if (resolve(sessionManager.getSessionFile() ?? '') !== resolve(sessionFile)) {
        throw new Error('子任务会话文件初始化失败。')
      }
      state.sessionManager = sessionManager

      const tools = state.agent.tools !== undefined ? [...state.agent.tools] : [...capture.tools]
      const { session } = await createAgentSessionFromServices({
        services: {
          cwd: prepared.trust.state.cwd,
          agentDir: this.deps.agentDir,
          modelRuntime: this.deps.modelRuntime,
          settingsManager: prepared.trust.settingsManager,
          resourceLoader: prepared.trust.resourceLoader,
          diagnostics: [],
        },
        sessionManager,
        model: resolved.model,
        ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
        tools,
        excludeTools: ['subagent'],
      })
      state.session = session
      if (
        !session.model ||
        session.model.provider !== resolved.model.provider ||
        session.model.id !== resolved.model.id
      ) {
        throw new Error('子任务模型在会话创建时发生了回退，已停止运行。')
      }
      if (resolved.thinkingLevel) await session.setThinkingLevel(resolved.thinkingLevel)
      state.task.thinkingLevel = session.thinkingLevel
      this.writeStored(state.task)

      const record = this.createChildRecord(
        state,
        prepared,
        session,
        sessionManager,
        bridge,
        hostUi,
      )
      state.bridge = bridge
      state.record = record
      prepared.guard.record = record

      // 与 live 会话相同：agent 级兜底不随 session.dispose() 解除。SDK 延迟动作
      // 可能在收尾后启动，retired 或已取消时必须立即中止，不能再发出模型请求。
      session.agent.subscribe((event) => {
        if (event.type !== 'agent_start') return
        if (state.record?.retired || state.task.status === 'cancelled') session.agent.abort()
      })

      if (this.isCancelled(state, signal)) return this.finishCancelled(state)

      await session.bindExtensions({
        uiContext: bridge.ui,
        mode: 'rpc',
        commandContextActions: childCommandActions(session),
        shutdownHandler: () => {
          throw new UnsupportedHostCommandActionError('shutdown')
        },
        onError: (error) => {
          record.lastError = error.error
          console.error('[huan-core] 子任务扩展错误：', error.error)
        },
      })
      if (this.isCancelled(state, signal)) return this.finishCancelled(state)

      session.setSessionName(subagentTitle(state.task))
      state.unsubscribe = session.subscribe((event) => this.onChildEvent(state, event))
      if (this.isCancelled(state, signal)) return this.finishCancelled(state)

      await session.prompt(state.task.task, { expandPromptTemplates: false })
      if (this.isCancelled(state, signal)) return this.finishCancelled(state)
      const outcome = terminalOutcome(session)
      if (outcome.status !== 'completed') {
        return this.finish(state, outcome.status, {
          ...(outcome.error ? { error: outcome.error } : {}),
        })
      }
      return this.finish(state, 'completed')
    } catch (error) {
      if (this.isCancelled(state, signal)) return this.finishCancelled(state)
      return this.finish(state, 'failed', { error: errorMessage(error) })
    } finally {
      try {
        if (state.record) state.record.retired = true
        state.progress = undefined
        state.controller.abort()
        state.bridge?.dismissAll()
        if (state.session) {
          discardDeferredRuns(state.session)
          if (!state.session.isIdle) {
            await withTimeout(
              state.session.abort(),
              SUBAGENT_CANCEL_TIMEOUT_MS,
              '子任务中止',
            ).catch((error: unknown) => {
              console.error('[huan-core] 子任务中止失败：', error)
            })
          }
        }
        await state.closeBinding?.()
        if (state.session) {
          try {
            await state.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
          } catch (error) {
            console.error('[huan-core] 子任务 session_shutdown 失败：', error)
          }
          discardDeferredRuns(state.session)
          this.persistSessionIfMissing(state)
          state.session.dispose()
        }
        state.runMetrics.dispose()
        state.unsubscribe?.()
        if (prepared) prepared.guard.record = undefined
      } finally {
        this.detachSignal(state)
        this.states.delete(state.task.taskId)
        state.resolveDone?.()
      }
    }
  }

  private setRunning(state: TaskState): void {
    state.task.status = 'running'
    state.task.usage = zeroUsage()
    delete state.task.error
    this.writeStored(state.task)
    this.emitProgress(state)
  }

  private finish(
    state: TaskState,
    status: 'completed' | 'failed' | 'cancelled',
    patch: { error?: string; output?: string } = {},
  ): HarnessSubagentTask {
    if (state.finished) return publicTask(state.task)
    state.finished = true
    // 正常路径已在 agent_settled 结算；缺少结算事件时按任务终态兜底一次。
    if (state.runMetrics.current()?.status === 'running') {
      const metrics = state.runMetrics.settle(status)
      if (metrics) state.task.runMetrics = metrics
    }
    this.harvestSession(state)
    state.task.status = status
    if (patch.output !== undefined) state.task.output = patch.output
    if (patch.error !== undefined) state.task.error = patch.error
    else if (status === 'completed') delete state.task.error
    this.writeStored(state.task)
    this.emitProgress(state)
    return publicTask(state.task)
  }

  private finishCancelled(state: TaskState): HarnessSubagentTask {
    return this.finish(state, 'cancelled', {
      error: state.cancelReason ?? '任务已取消。',
    })
  }

  private isCancelled(state: TaskState, signal: AbortSignal): boolean {
    return state.task.status === 'cancelled' || signal.aborted
  }

  private markCancelled(state: TaskState, reason: string): void {
    if (isTerminal(state.task.status)) return
    state.cancelReason ??= reason
    state.task.status = 'cancelled'
    state.task.error = state.cancelReason
    this.writeStored(state.task)
    this.emitProgress(state)
  }

  /**
   * 立即取消：UI 与 MCP binding 不等待正在进行的装配；session 存在时同时
   * 中止运行并丢弃 SDK 缓冲的延迟动作，避免取消后仍发出模型请求。
   */
  private cancelNow(state: TaskState, reason: string): void {
    if (isTerminal(state.task.status)) return
    this.markCancelled(state, reason)
    state.controller.abort()
    state.bridge?.dismissAll()
    if (state.session) {
      discardDeferredRuns(state.session)
      if (!state.session.isIdle) {
        void state.session.abort().catch((error: unknown) => {
          console.error('[huan-core] 子任务取消中止失败：', error)
        })
      }
    }
    void state.closeBinding?.()
    if (!state.started) {
      this.detachSignal(state)
      this.states.delete(state.task.taskId)
    }
  }

  /** createTask 时登记父 signal；runTask 使用同一 signal，不重复监听。 */
  private attachSignal(state: TaskState, signal: AbortSignal): void {
    if (state.abortSignal === signal) return
    this.detachSignal(state)
    state.abortSignal = signal
    state.abortListener = () => this.cancelNow(state, '父工具调用已取消。')
    if (signal.aborted) state.abortListener()
    else signal.addEventListener('abort', state.abortListener, { once: true })
  }

  private detachSignal(state: TaskState): void {
    if (state.abortSignal && state.abortListener) {
      state.abortSignal.removeEventListener('abort', state.abortListener)
    }
    state.abortSignal = undefined
    state.abortListener = undefined
  }

  /** 只读取一次终态用量与输出，避免每个 message_end 扫描整份会话。 */
  private harvestSession(state: TaskState): void {
    const session = state.session
    if (!session) return
    if (state.sessionManager) {
      const stats = aggregateSessionStats(state.sessionManager.getEntries())
      state.task.usage = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        cost: stats.cost,
      }
    }
    const output = session.getLastAssistantText()
    if (output !== undefined) state.task.output = output
    if (session.thinkingLevel) state.task.thinkingLevel = session.thinkingLevel
  }

  private prepareOptions(
    state: TaskState,
    sameCwd: boolean,
    bridge: HostUiBridge,
  ): SubagentPrepareOptions {
    const body = state.agent.body.trim()
    const mcpOverrides = sameCwd ? state.capture.mcpOverrides : undefined
    return {
      subagent: true,
      projectTrustContext: {
        cwd: state.task.cwd,
        mode: 'rpc',
        hasUI: true,
        ui: bridge.ui,
      },
      ...(body ? { appendSystemPrompt: [body] } : {}),
      ...(mcpOverrides ? { mcpOverrides } : {}),
    }
  }

  private async resolveModel(
    state: TaskState,
    prepared: PreparedProject,
  ): Promise<{ model: SubagentModel; thinkingLevel?: ThinkingLevel }> {
    const capture = state.capture
    const inheritedThinking = capture.thinkingLevel as ThinkingLevel | undefined
    const explicit = state.agent.model?.trim()

    let model: SubagentModel
    let thinkingLevel: ThinkingLevel | undefined
    if (explicit) {
      // SDK 根入口未导出 resolveModelReference；resolveCliModel 使用同一个
      // 公开解析器，支持 provider/id 与 :thinking 后缀。warning 表示 custom
      // model id 回退，子任务必须拒绝而不是静默换成别的模型。
      const result = resolveCliModel({
        cliModel: explicit,
        modelRuntime: this.deps.modelRuntime,
      })
      if (result.error || result.warning || !result.model) {
        throw new Error(`子任务模型无法解析：${explicit}`)
      }
      model = result.model
      thinkingLevel = result.thinkingLevel ?? inheritedThinking
    } else {
      if (!capture.modelProvider || !capture.modelId) {
        throw new Error('父会话没有可用模型，无法创建子任务。')
      }
      const found = this.deps.modelRuntime.getModel(capture.modelProvider, capture.modelId)
      if (!found) throw new Error('父会话模型已不可用，无法创建子任务。')
      model = found
      thinkingLevel = inheritedThinking
    }

    // 先把缺凭据与范围外区分开：模型范围解析只包含有凭据的候选，
    // 若先查范围，缺凭据会被误报为范围外。checkAuth 返回 AuthCheck | undefined。
    const hasAuth =
      this.deps.modelRuntime.hasConfiguredAuth(model.provider) ||
      (await this.deps.modelRuntime.checkAuth(model.provider)) !== undefined
    if (!hasAuth) {
      throw new Error(`子任务模型缺少凭据：${model.provider}/${model.id}`)
    }
    if (explicit) await this.assertExplicitModelInScope(state, prepared, model)
    return { model, ...(thinkingLevel ? { thinkingLevel } : {}) }
  }

  private async assertExplicitModelInScope(
    state: TaskState,
    prepared: PreparedProject,
    model: SubagentModel,
  ): Promise<void> {
    const workspaceId = state.capture.workspaceId
    const workspace = workspaceId ? this.deps.workspaceStore.workspace(workspaceId) : undefined
    const patterns = workspace?.modelPatterns ?? globalModelPatterns(prepared.trust.settingsManager)
    if (patterns.length === 0) return
    const scope = await resolveModelScopePatterns(this.deps.modelRuntime, patterns)
    const inScope = scope.scopedModels.some(
      (item) => item.model.provider === model.provider && item.model.id === model.id,
    )
    if (!inScope) {
      throw new Error(`子任务模型不在当前模型范围内：${model.provider}/${model.id}`)
    }
  }

  private createChildBridge(state: TaskState, hostUi: ThreadRecord['hostUi']): HostUiBridge {
    let requestCounter = 0
    const notify = (message: string, type: 'info' | 'warning' | 'error') => {
      hostUi.notificationCounter += 1
      hostUi.notifications = [
        ...hostUi.notifications,
        {
          id: `${state.task.taskId}:notify:${hostUi.notificationCounter}`,
          message,
          type,
          createdAt: Date.now(),
        },
      ].slice(-20)
    }
    const bridge = createHostUiBridge({
      nextRequestId: () => `${state.task.taskId}:ui:${++requestCounter}`,
      currentToolCallId: () => state.task.toolCallId,
      emitRequest: (request) => {
        request.title = `[${subagentTitle(state.task)}] ${request.title}`
        state.task.pendingRequestCount = state.bridge?.pending().length ?? 1
        this.emitProgress(state)
      },
      emitResolved: () => {
        state.task.pendingRequestCount = state.bridge?.pending().length ?? 0
        this.emitProgress(state)
      },
      onNotify: (message, type) => {
        notify(message, type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info')
      },
      onStatus: (key, text) => {
        if (text === undefined) hostUi.statuses.delete(key)
        else hostUi.statuses.set(key, text)
      },
      onWidget: (key, lines, placement) => {
        if (lines === undefined) hostUi.widgets.delete(key)
        else hostUi.widgets.set(key, { lines: [...lines], placement })
      },
      onTitle: (title) => {
        hostUi.title = `${subagentTitle(state.task)} · ${title}`
      },
      onWorkingMessage: (message) => {
        hostUi.workingMessage = message
      },
      onWorkingVisible: (visible) => {
        hostUi.workingVisible = visible
      },
      onHiddenThinkingLabel: (label) => {
        hostUi.hiddenThinkingLabel = label
      },
      getEditorText: () => '',
      onEditorWrite: () => {
        throw new Error('子任务不能写入主会话输入框。')
      },
      onUnsupported: (method) => {
        notify(`子任务不支持扩展 UI 能力 ${method}，已跳过。`, 'warning')
      },
    })
    // 子任务从第一个请求起就走本地 pending，由 getTask/respondTask 转发；
    // 不复用父会话启动期交互域。取消时 cancelNow/dismissAll 会解除等待。
    bridge.setStartup(false)
    const ui = bridge.ui
    const taskSignal = (signal?: AbortSignal) =>
      signal ? AbortSignal.any([state.controller.signal, signal]) : state.controller.signal
    // 关闭后即使扩展继续询问，也立即按取消返回，不能重新建立不可答等待。
    return {
      ...bridge,
      ui: {
        ...ui,
        confirm: (title, message, opts) =>
          ui.confirm(title, message, { ...opts, signal: taskSignal(opts?.signal) }),
        select: (title, options, opts) =>
          ui.select(title, options, { ...opts, signal: taskSignal(opts?.signal) }),
        input: (title, placeholder, opts) =>
          ui.input(title, placeholder, { ...opts, signal: taskSignal(opts?.signal) }),
        editor: (title, prefill) =>
          state.controller.signal.aborted ? Promise.resolve(undefined) : ui.editor(title, prefill),
      },
    }
  }

  private createChildRecord(
    state: TaskState,
    prepared: PreparedProject,
    session: AgentSession,
    sessionManager: SessionManager,
    bridge: HostUiBridge,
    hostUi: ThreadRecord['hostUi'],
  ): ThreadRecord {
    const capture = state.capture
    prepared.workspaceBinding.workspaceId = capture.workspaceId
    return {
      threadId: state.task.taskId,
      session,
      sessionManager,
      settingsManager: prepared.trust.settingsManager,
      uiBridge: bridge,
      hostUi,
      unsubscribe: () => {},
      listeners: new Set(),
      seq: 0,
      turnIndex: -1,
      workspacePath: prepared.trust.state.cwd,
      workspaceId: capture.workspaceId,
      workspaceAppliedRevision: capture.workspaceAppliedRevision,
      workspaceBinding: prepared.workspaceBinding,
      lastError: undefined,
      modelFallback: undefined,
      activeTools: new Map(),
      resourceLoader: prepared.trust.resourceLoader,
      trustBinding: prepared.trustBinding,
      mcp: prepared.mcp,
      inFlight: new Set(),
      currentRun: undefined,
      runMetrics: state.runMetrics,
      bash: undefined,
      compactionReason: undefined,
      lastCompactionError: undefined,
      lastCompactionAborted: false,
      admission: undefined,
      admissionWaiters: new Set(),
      startingSend: undefined,
      retired: false,
      sweepUnattendedRun: false,
      structure: undefined,
      resourceRevision: capture.resourceRevision,
      reload: undefined,
    } as ThreadRecord
  }

  /** 子事件只维护子 record 的瞬态状态；不写 task.json、不扫描整份会话。 */
  private onChildEvent(state: TaskState, event: AgentSessionEvent): void {
    const record = state.record
    if (!record) return
    record.seq += 1
    if (event.type === 'turn_start') record.turnIndex += 1
    if (event.type === 'agent_start') {
      // 新一轮开始：重置统计并让父工具立即看到“统计中”。
      state.task.runMetrics = state.runMetrics.begin()
      state.runMetrics.publish((metrics) => {
        state.task.runMetrics = metrics
        this.emitProgress(state)
      })
      this.writeStored(state.task)
      this.emitProgress(state)
    }
    if (event.type === 'message_update') {
      state.runMetrics.observeDelta(event.assistantMessageEvent)
      state.runMetrics.observePartial(event.message)
    }
    if (event.type === 'message_end') {
      state.runMetrics.observeMessage(event.message)
    }
    if (event.type === 'compaction_start') {
      record.compactionReason = event.reason
      record.lastCompactionAborted = false
    }
    if (event.type === 'compaction_end') {
      record.lastCompactionAborted = event.aborted
      record.lastCompactionError = event.aborted ? undefined : event.errorMessage
      record.compactionReason = undefined
    }
    if (event.type === 'tool_execution_start') {
      record.activeTools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: 'running',
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      })
    } else if (event.type === 'tool_execution_update') {
      const current = record.activeTools.get(event.toolCallId)
      record.activeTools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName ?? current?.toolName,
        args: current?.args,
        partialResult: event.partialResult,
        status: 'running',
        ...(event.parentToolCallId
          ? { parentToolCallId: event.parentToolCallId }
          : current?.parentToolCallId
            ? { parentToolCallId: current.parentToolCallId }
            : {}),
      })
    } else if (event.type === 'tool_execution_end') {
      record.activeTools.delete(event.toolCallId)
    }
    if (event.type === 'agent_settled') {
      // agent_end 可能重试/继续，只有 settled 才结算本轮耗时与结局。
      const outcome: RunMetricsFinalStatus = event.aborted
        ? 'cancelled'
        : state.session
          ? terminalOutcome(state.session).status
          : state.task.status === 'failed'
            ? 'failed'
            : 'completed'
      const metrics = state.runMetrics.settle(outcome)
      if (metrics) state.task.runMetrics = metrics
      record.activeTools.clear()
      this.writeStored(state.task)
      this.emitProgress(state)
    }
  }

  private emitProgress(state: TaskState): void {
    try {
      state.progress?.(publicTask(state.task))
    } catch {
      // 进度回调属于父工具展示；其异常不能改变子任务真实结局。
    }
  }

  /**
   * 冷读只使用 SDK 公开会话投影；文件存在但损坏时直接抛出，不吞成空聊天。
   * 没有 session.jsonl 表示任务在创建会话前结束，返回 undefined 而不是伪造空快照；
   * completed 任务缺少记录则明确抛错。
   */
  private coldSnapshot(task: StoredSubagentTask): HarnessThreadSnapshot | undefined {
    const taskDir = this.taskDir(task.parentThreadId, task.taskId)
    const sessionFile = join(taskDir, SUBAGENT_SESSION_FILE)
    if (!existsSync(sessionFile)) {
      // completed 必然经过 prompt，不应缺少记录；其余终态可能在创建会话前失败。
      if (task.status === 'completed') throw new Error('子任务会话记录缺失。')
      return undefined
    }
    const sessionManager = SessionManager.open(sessionFile, taskDir)
    const projection = sessionManager.buildSessionProjection()
    const messages: HarnessAgentMessage[] = []
    const entryIds: (string | null)[] = []
    for (const entry of projection.entries) {
      for (const message of entry.messages) {
        // 系统提示只在模型请求中出现，不进入会话快照（与 live session.messages 同口径）。
        if ((message as { role?: string }).role === 'system') continue
        messages.push(message as HarnessAgentMessage)
        entryIds.push(entry.sourceEntry.id)
      }
    }
    const projected = projectSessionRecord({
      header: sessionManager.getHeader(),
      entries: sessionManager.getEntries(),
    })
    const model = projection.model
      ? { provider: projection.model.provider, modelId: projection.model.modelId }
      : task.modelProvider && task.modelId
        ? { provider: task.modelProvider, modelId: task.modelId }
        : undefined
    const thinkingLevel = projection.thinkingLevel ?? task.thinkingLevel
    const metadata: HarnessThreadMetadata = {
      id: task.taskId,
      title: subagentTitle(task),
      status: threadStatusOf(task.status),
      ...(task.runMetrics ? { runMetrics: { ...task.runMetrics } } : {}),
      workspacePath: task.cwd || sessionManager.getCwd(),
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      ...(model
        ? {
            config: {
              provider: model.provider,
              modelId: model.modelId,
              ...(thinkingLevel ? { thinkingLevel } : {}),
            },
          }
        : thinkingLevel
          ? { config: { thinkingLevel } }
          : {}),
      messageCount: messages.length,
      ...((projected.createdAt ?? task.createdAt)
        ? { createdAt: projected.createdAt ?? task.createdAt }
        : {}),
      ...((projected.updatedAt ?? task.updatedAt)
        ? { updatedAt: projected.updatedAt ?? task.updatedAt }
        : {}),
      leafId: sessionManager.getLeafId(),
      sessionFile,
    }
    return jsonSafeSnapshot({
      metadata,
      messages,
      messageEntryIds: entryIds,
      readiness: getModelReadiness(this.deps.modelRuntime, model, 'session'),
    })
  }

  /**
   * SDK 在首条 user/assistant 消息时才真正 flush；这里在收尾时用公开
   * getHeader/getEntries 兜底，确保取消发生在首个 assistant 之前时，
   * 子目录仍保留已发生的 user/tool 记录。
   */
  private persistSessionIfMissing(state: TaskState): void {
    const sessionManager = state.sessionManager
    if (!sessionManager) return
    const taskDir = this.taskDir(state.task.parentThreadId, state.task.taskId)
    const sessionFile = join(taskDir, SUBAGENT_SESSION_FILE)
    if (existsSync(sessionFile)) return
    const header = sessionManager.getHeader()
    const entries = sessionManager.getEntries()
    if (!header || !entries.some((entry) => entry.type === 'message')) return
    mkdirSync(taskDir, { recursive: true })
    const lines = [header, ...entries].map((entry) => JSON.stringify(entry))
    writeFileSync(sessionFile, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
  }

  private taskDir(parentThreadId: string, taskId: string): string {
    this.assertId(parentThreadId, '父会话 ID')
    this.assertId(taskId, '任务 ID')
    return join(this.root, parentThreadId, taskId)
  }

  private taskPath(parentThreadId: string, taskId: string): string {
    return join(this.taskDir(parentThreadId, taskId), SUBAGENT_TASK_FILE)
  }

  private assertId(value: string, label: string): void {
    if (!SAFE_ID.test(value)) throw new Error(`${label} 无效。`)
  }

  private writeStored(task: StoredSubagentTask): void {
    task.updatedAt = new Date().toISOString()
    const file = this.taskPath(task.parentThreadId, task.taskId)
    mkdirSync(this.taskDir(task.parentThreadId, task.taskId), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  }

  /** 只校验自有摘要的最小结构；不在读取时复制/规范化每个可选字段。 */
  private readStored(parentThreadId: string, taskId: string): StoredSubagentTask {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.taskPath(parentThreadId, taskId), 'utf8'))
    } catch {
      throw unknownTask()
    }
    if (
      !isRecord(parsed) ||
      parsed.taskId !== taskId ||
      parsed.parentThreadId !== parentThreadId ||
      !isTaskStatus(parsed.status)
    ) {
      throw unknownTask()
    }
    return normalizeStoredTask(parsed as unknown as StoredSubagentTask)
  }

  /**
   * 扫描单个父会话的任务目录并按持久 toolCallId 分组。
   *
   * 缺 task.json 的目录可能是尚未写完/已清理的残留，直接跳过；存在但无法
   * 解析或字段不完整的摘要明确报错，不静默当作没有任务。
   */
  private readRecoverableTasks(parentThreadId: string): Map<string, StoredSubagentTask[]> {
    const parentDir = join(this.root, parentThreadId)
    let entries: Dirent[]
    try {
      entries = readdirSync(parentDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw new Error(
        `子任务目录不可用（${parentDir}）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const groups = new Map<string, StoredSubagentTask[]>()
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue
      const file = this.taskPath(parentThreadId, entry.name)
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        // 任务目录可能先于 task.json 创建；缺摘要的目录不参与恢复。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error(
          `子任务摘要不可读（${file}）：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(
          `子任务摘要损坏（${file}）：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      if (
        !isRecord(parsed) ||
        parsed.taskId !== entry.name ||
        parsed.parentThreadId !== parentThreadId ||
        !isTaskStatus(parsed.status) ||
        typeof parsed.toolCallId !== 'string' ||
        parsed.toolCallId.length === 0
      ) {
        throw new Error(`子任务摘要损坏（${file}）：字段不完整或与父会话不匹配。`)
      }
      const task = normalizeStoredTask(parsed as unknown as StoredSubagentTask)
      const group = groups.get(task.toolCallId)
      if (group) group.push(task)
      else groups.set(task.toolCallId, [task])
    }
    return groups
  }
}

/** 子任务命令上下文：只允许 public waitForIdle，其余结构/会话动作全部拒绝。 */
function childCommandActions(session: AgentSession) {
  const reject = (action: string) => async (): Promise<never> => {
    throw new UnsupportedHostCommandActionError(action)
  }
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: reject('newSession'),
    fork: reject('fork'),
    navigateTree: reject('navigateTree'),
    switchSession: reject('switchSession'),
    reload: reject('reload'),
  }
}

function mcpOverridesOf(parent: ThreadRecord): Record<string, McpServerOverrides> | undefined {
  try {
    const manager = parent.mcp.getManager()
    if (!manager) return undefined
    const overrides: Record<string, McpServerOverrides> = {}
    for (const server of manager.snapshot().servers) {
      const config = manager.getServerEntry(server.name).config
      const value: McpServerOverrides = {
        ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
        ...(config.exposure !== undefined ? { exposure: config.exposure } : {}),
        ...(config.toolExposure !== undefined ? { toolExposure: { ...config.toolExposure } } : {}),
      }
      if (Object.keys(value).length > 0) overrides[server.name] = value
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined
  } catch {
    return undefined
  }
}

function publicTask(task: StoredSubagentTask): HarnessSubagentTask {
  return {
    taskId: task.taskId,
    parentThreadId: task.parentThreadId,
    agent: task.agent,
    task: task.task,
    status: task.status,
    ...(task.model !== undefined ? { model: task.model } : {}),
    ...(task.output !== undefined ? { output: task.output } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.pendingRequestCount ? { pendingRequestCount: task.pendingRequestCount } : {}),
    ...(task.runMetrics ? { runMetrics: { ...task.runMetrics } } : {}),
    usage: { ...task.usage },
  }
}

function zeroUsage(): HarnessSubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

function terminalOutcome(
  session: AgentSession,
): { status: 'completed' } | { status: 'failed' | 'cancelled'; error?: string } {
  const last = [...session.messages].reverse().find((message) => message.role === 'assistant')
  if (!last) return { status: 'completed' }
  const message = last as { stopReason?: string; errorMessage?: string }
  if (message.stopReason === 'aborted') {
    return { status: 'cancelled', error: '子任务运行已中止。' }
  }
  if (message.stopReason === 'error') {
    return { status: 'failed', error: message.errorMessage || '子任务运行失败。' }
  }
  // length 表示输出被截断，不能当作成功结果交给父工具。
  if (message.stopReason === 'length') {
    return { status: 'failed', error: '子任务输出达到长度上限，结果不完整。' }
  }
  return { status: 'completed' }
}

function isTaskStatus(value: unknown): value is HarnessSubagentTaskStatus {
  return (
    value === 'waiting' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
}

function isTerminal(status: HarnessSubagentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** 冷读发现非终态摘要说明服务不再持有该任务；仅覆盖视图，不写回恢复。 */
function endedWithoutService(task: StoredSubagentTask): StoredSubagentTask {
  const view = withoutPendingRequests(task)
  view.status = 'cancelled'
  if (view.runMetrics?.status === 'running') {
    view.runMetrics = { ...view.runMetrics, status: 'cancelled' }
  }
  view.error = '任务已结束（服务不再持有）。'
  return view
}

/** 恢复卡中的终态保留结果；非终态统一按服务不再持有投影。 */
function recoveredTask(task: StoredSubagentTask): StoredSubagentTask {
  return isTerminal(task.status) ? withoutPendingRequests(task) : endedWithoutService(task)
}

/** 待答请求属于存活服务；冷读/恢复视图不能继续显示可应答计数。 */
function withoutPendingRequests(task: StoredSubagentTask): StoredSubagentTask {
  const view = { ...task }
  delete view.pendingRequestCount
  return view
}

function normalizeStoredTask(task: StoredSubagentTask): StoredSubagentTask {
  if (!isRecord(task.usage)) task.usage = zeroUsage()
  if (task.runMetrics !== undefined && !isRunMetrics(task.runMetrics)) delete task.runMetrics
  return task
}

/** 当前消息投影中尚无 toolResult 的 subagent 调用；旧分支不会进入本列表。 */
function missingSubagentCalls(
  messages: readonly HarnessAgentMessage[],
): Map<string, Record<string, unknown>> {
  const results = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId
    if (typeof toolCallId === 'string') results.add(toolCallId)
  }
  const calls = new Map<string, Record<string, unknown>>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isRecord(part) || part.type !== 'toolCall' || part.name !== 'subagent') continue
      const id = part.id
      if (typeof id !== 'string' || id.length === 0 || results.has(id) || calls.has(id)) continue
      calls.set(id, isRecord(part.arguments) ? part.arguments : {})
    }
  }
  return calls
}

/** 与工具入口同一口径：空占位不算模式，无法判断时用 single。 */
function subagentModeOfArguments(args: Record<string, unknown>): HarnessSubagentDetails['mode'] {
  if (Array.isArray(args.tasks) && args.tasks.length > 0) return 'parallel'
  if (Array.isArray(args.chain) && args.chain.length > 0) return 'chain'
  return 'single'
}

function threadStatusOf(status: HarnessSubagentTaskStatus): HarnessThreadMetadata['status'] {
  if (status === 'running') return 'running'
  if (status === 'failed') return 'failed'
  return 'idle'
}

function subagentTitle(task: StoredSubagentTask): string {
  const firstLine = task.task.split('\n', 1)[0]?.trim() ?? ''
  const text = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
  return text ? `${task.agent}: ${text}` : task.agent
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right)
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function unknownTask(): Error {
  return new Error('子任务不存在或已过期。')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
