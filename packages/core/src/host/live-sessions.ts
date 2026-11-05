/**
 * live 会话服务：唯一持有 records/byFile、pending opens/deletes、starting tokens、
 * MCP runtime 映射与会话关闭顺序。
 *
 * 装配 loader 在 `openSession` 发布 record 时从项目装配服务原子移交；失败未发布
 * 则仍由装配服务关闭。删除/创建失败/全局 dispose 复用同一 `retire` 流程：
 * 先同步失效资格，再 await 收尾。
 */

import { unlink } from 'node:fs/promises'
import {
  type AgentSession,
  type AgentSessionServices,
  createAgentSessionFromServices,
  type ExtensionCommandContextActions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
  type SessionStartEvent,
} from '@earendil-works/pi-coding-agent'
import type { McpConnectionManager } from '@huan/mcp'
import type { HarnessClientEvent } from '@huan/protocol'
import type { McpHostLiveBinding } from '../mcp-host.js'
import {
  globalModelPatterns,
  type ResolvedModelScope,
  resolveDefaultModel,
  resolveModelScopePatterns,
} from '../model-catalog.js'
import { WorkspaceStateUnavailableError, type WorkspaceStore } from '../workspace-store.js'
import type { SharedModelRuntime } from './model-service.js'
import type { OperationCoordinator } from './operation-coordinator.js'
import type { ProjectAssembly } from './project-assembly.js'
import type { SessionCatalog } from './session-catalog.js'
import { createHostUiState, type SessionEvents } from './session-events.js'
import {
  abortForRetire,
  discardDeferredRuns,
  type HarnessDefaultModel,
  type PreparedProject,
  type ProjectRuntime,
  RETIRE_ABORT_TIMEOUT_MS,
  type StartingSend,
  type ThreadRecord,
  ThreadStructureBusyError,
  UnsupportedHostCommandActionError,
  withTimeout,
} from './shared.js'

export type LiveSessionsDeps = {
  agentDir: string
  workspacePath: string
  model?: HarnessDefaultModel
  modelRuntime: SharedModelRuntime
  workspaceStore: WorkspaceStore
  storeId: string
  assembly: Pick<ProjectAssembly, 'acquire' | 'closeBinding' | 'transferBinding'>
  catalog: Pick<
    SessionCatalog,
    | 'assertSessionFileInScope'
    | 'findSessionInfo'
    | 'getThread'
    | 'invalidateCatalog'
    | 'openScopedSessionManager'
    | 'scopeOf'
  >
  events: Pick<
    SessionEvents,
    | 'clearEditorMirrors'
    | 'createUiBridge'
    | 'emit'
    | 'emitHostUiSnapshot'
    | 'forgetEditorMirrors'
    | 'onSessionEvent'
    | 'snapshotOf'
  >
  coordinator: Pick<
    OperationCoordinator,
    | 'beginStructure'
    | 'cancelAndDrainStructure'
    | 'drainInFlight'
    | 'mcpRuntimeBusy'
    | 'releaseStructure'
    | 'wakeAdmissionWaiters'
  >
  /** 扩展命令上下文动作（由会话操作服务提供）。 */
  commandActionsFor: (record: ThreadRecord) => ExtensionCommandContextActions
  diagnose: (message: string) => void
  addSafeDiagnostic: (
    code: 'assembly-warning' | 'catalog-refresh-failed' | 'model-fallback',
  ) => void
  assertActive: () => void
  isDisposed: () => boolean
  /** 资源配置服务的当前资源版本（新装配继承）。 */
  resourceRevision: () => number
  generation: () => number
  /** MCP runtime 失效通知（broker 由组合根注入）。 */
  invalidateMcpRuntime: (runtimeId: string) => void
}

export type OpenSessionOptions = {
  isNew: boolean
  signal?: AbortSignal
  model?: HarnessDefaultModel
  thinkingLevel?: Parameters<AgentSession['setThinkingLevel']>[0]
  project?: { runtime: ProjectRuntime; prepared: PreparedProject }
  workspaceId?: string
  sessionStartEvent?: SessionStartEvent
  workspaceAppliedRevision?: number
}

export class LiveSessions {
  private readonly records = new Map<string, ThreadRecord>()
  private readonly recordsBySessionFile = new Map<string, ThreadRecord>()
  private readonly pendingOpens = new Map<
    string,
    { promise: Promise<ThreadRecord>; controller: AbortController }
  >()
  private readonly startingSends = new Map<string, Set<StartingSend>>()
  private readonly pendingDeletes = new Map<string, Promise<void>>()
  /** 尚未 live 的会话结构操作（重命名），与打开/发送互斥。 */
  readonly coldStructure = new Set<string>()
  /** live MCP runtime 的弱映射：record → 当前 manager 与唯一 runtimeId。 */
  private readonly mcpRuntimes = new WeakMap<
    ThreadRecord,
    { runtimeId: string; manager: McpConnectionManager }
  >()
  private mcpRuntimeCounter = 0
  private readonly retiring = new WeakMap<ThreadRecord, Promise<void>>()

  constructor(private readonly deps: LiveSessionsDeps) {}

  get(threadId: string): ThreadRecord | undefined {
    return this.records.get(threadId)
  }

  all(): IterableIterator<ThreadRecord> {
    return this.records.values()
  }

  findBySessionFile(file: string): ThreadRecord | undefined {
    return this.recordsBySessionFile.get(file)
  }

  hasPendingOpen(threadId: string): boolean {
    return this.pendingOpens.has(threadId)
  }

  beginStartingSend(threadId: string): StartingSend {
    const token: StartingSend = { cancelled: false }
    let tokens = this.startingSends.get(threadId)
    if (!tokens) {
      tokens = new Set()
      this.startingSends.set(threadId, tokens)
    }
    tokens.add(token)
    return token
  }

  endStartingSend(threadId: string, token: StartingSend): void {
    const tokens = this.startingSends.get(threadId)
    if (!tokens) return
    tokens.delete(token)
    if (tokens.size === 0) this.startingSends.delete(threadId)
  }

  cancelStartingSends(threadId: string): void {
    const tokens = this.startingSends.get(threadId)
    if (tokens) for (const token of tokens) token.cancelled = true
  }

  private openWasCancelled(signal: AbortSignal | undefined, openedGeneration: number): boolean {
    return signal?.aborted === true || openedGeneration !== this.deps.generation()
  }

  private throwIfOpenCancelled(
    signal: AbortSignal | undefined,
    openedGeneration = this.deps.generation(),
  ): void {
    if (this.openWasCancelled(signal, openedGeneration)) {
      throw new Error('Harness session open was cancelled')
    }
  }

  private throwOpenCancelled(): never {
    throw new Error('Harness session open was cancelled')
  }

  async ensureOpen(threadId: string): Promise<ThreadRecord> {
    this.deps.assertActive()
    if (!this.deps.workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        this.deps.workspaceStore.integrity === 'ok'
          ? 'unreadable'
          : this.deps.workspaceStore.integrity,
        this.deps.workspaceStore.stateFile,
      )
    }
    if (this.pendingDeletes.has(threadId)) this.throwOpenCancelled()
    if (this.coldStructure.has(threadId)) throw new ThreadStructureBusyError()
    const existing = this.records.get(threadId)
    if (existing) return existing
    const pending = this.pendingOpens.get(threadId)
    if (pending) return pending.promise

    const controller = new AbortController()
    const open = this.openCold(threadId, controller.signal).finally(() => {
      if (this.pendingOpens.get(threadId)?.promise === open) this.pendingOpens.delete(threadId)
    })
    this.pendingOpens.set(threadId, { promise: open, controller })
    return open
  }

  private async openCold(threadId: string, signal: AbortSignal): Promise<ThreadRecord> {
    const info = await this.deps.catalog.findSessionInfo(threadId)
    this.throwIfOpenCancelled(signal)
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    const existingBySessionFile = this.recordsBySessionFile.get(info.path)
    if (existingBySessionFile) {
      this.records.set(threadId, existingBySessionFile)
      return existingBySessionFile
    }
    // 打开也使用同一存储规则（含符号链接真实路径）与统一树落点规则。
    const sessionManager = this.deps.catalog.openScopedSessionManager(info)
    // 归属只在 huan 元数据中查找；没有记录的旧会话保持未归属，不按 cwd 猜测。
    const workspaceId = this.deps.workspaceStore.sessionWorkspace(this.deps.storeId, info.id)
    return this.openSession(sessionManager, info.cwd || this.deps.workspacePath, {
      isNew: false,
      signal,
      ...(workspaceId ? { workspaceId } : {}),
    })
  }

  /** 两层模型范围：工作区自定义优先，否则用户全局 enabledModels。 */
  private async modelScopeOf(
    workspaceId: string | undefined,
    settingsManager: import('@earendil-works/pi-coding-agent').SettingsManager,
  ): Promise<ResolvedModelScope> {
    const workspace = workspaceId ? this.deps.workspaceStore.workspace(workspaceId) : undefined
    const patterns = workspace?.modelPatterns ?? globalModelPatterns(settingsManager)
    return resolveModelScopePatterns(this.deps.modelRuntime, patterns, {
      diagnose: this.deps.diagnose,
    })
  }

  /** 从既有 SessionManager 打开/创建 record；供新建、fork、命令切换复用。 */
  async openSession(
    sessionManager: SessionManager,
    cwd: string,
    opts: OpenSessionOptions,
  ): Promise<ThreadRecord> {
    const openedGeneration = this.deps.generation()
    this.throwIfOpenCancelled(opts.signal, openedGeneration)

    // 同一份 loader 直接交给会话：不再经 createHostServices 重装扩展，
    // 避免扩展工厂在一次会话装配中执行两次（第二次也没有信任回调）。
    // 输入守卫在项目装配中已作为合成扩展追加。
    const project = opts.project ?? (await this.deps.assembly.acquire(cwd, this.deps.isDisposed()))
    const prepared = project.prepared
    let published = false
    try {
      const projectCwd = project.runtime.cwd
      // loader 只能服务一个 live session；这里写入本次会话的工作区归属。
      prepared.workspaceBinding.workspaceId = opts.workspaceId
      const services: AgentSessionServices = {
        cwd: projectCwd,
        agentDir: this.deps.agentDir,
        modelRuntime: this.deps.modelRuntime,
        settingsManager: prepared.trust.settingsManager,
        resourceLoader: prepared.trust.resourceLoader,
        diagnostics: [],
      }
      this.throwIfOpenCancelled(opts.signal, openedGeneration)

      // 查询时缓存的 loader 可能早于用户设置保存；消费前重读设置，资源不重复装配。
      await prepared.trust.settingsManager.reload()
      // 新会话：显式模型 > 目标项目默认模型；冷打开不传，由 SDK 从会话记录恢复。
      const currentDefault = resolveDefaultModel({
        modelRuntime: this.deps.modelRuntime,
        cwd: projectCwd,
        agentDir: this.deps.agentDir,
        ...(this.deps.model ? { model: this.deps.model } : {}),
        settingsManager: prepared.trust.settingsManager,
      })
      // 新会话/冷打开都读取两层范围：工作区覆盖完整替换用户全局范围。
      // 范围是会话内存状态，不写入 Pi 会话记录；影响模型循环与选择器候选。
      const scope = await this.modelScopeOf(opts.workspaceId, prepared.trust.settingsManager)
      for (const diagnostic of scope.diagnostics) {
        this.deps.diagnose(`模型范围（${projectCwd}）：${diagnostic.message}`)
      }
      let newSessionModel = opts.model ?? currentDefault.model
      if (opts.isNew && scope.patterns.length > 0) {
        // 非空范围但无匹配：新建明确报错，不默认退全部。
        if (scope.scopedModels.length === 0) {
          throw new Error(
            '没有可用模型：当前模型范围没有匹配的可用模型，请调整模型范围或先刷新模型目录。',
          )
        }
        if (opts.model && !scopeContains(scope, opts.model)) {
          throw new Error(
            `所选模型 ${opts.model.provider}/${opts.model.id} 不在当前模型范围内，请选择其他模型。`,
          )
        }
        // 默认模型在范围外（或无法解析）时选第一个候选；旧会话不进入此分支。
        if (!opts.model && (!newSessionModel || !scopeContains(scope, newSessionModel))) {
          newSessionModel = scope.scopedModels[0]?.model
        }
      }
      if (opts.isNew && scope.patterns.length === 0 && !opts.model && !newSessionModel) {
        throw new Error('默认模型不在注册表中，请先选择有效模型，或修正配置后重启宿主。')
      }
      const savedModel = sessionManager.buildSessionContext().model
      const { session, modelFallbackMessage } = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(opts.isNew && newSessionModel ? { model: newSessionModel } : {}),
        ...(scope.scopedModels.length ? { scopedModels: scope.scopedModels } : {}),
        ...(opts.sessionStartEvent ? { sessionStartEvent: opts.sessionStartEvent } : {}),
      })
      // SDK 在恢复失败时会回退到其他模型；该原因必须可见（不静默）。
      const modelFallback = modelFallbackOf(
        savedModel ?? undefined,
        session.model,
        modelFallbackMessage,
      )
      if (modelFallback) {
        this.deps.diagnose(`模型回退（${projectCwd}）：${modelFallback.message}`)
        this.deps.addSafeDiagnostic('model-fallback')
      }

      if (this.openWasCancelled(opts.signal, openedGeneration)) {
        session.dispose()
        this.throwOpenCancelled()
      }

      // Thinking 级别在模型应用之后设置（SDK 的 setModel 自身会调整级别）。
      if (opts.isNew && opts.thinkingLevel) {
        try {
          await session.setThinkingLevel(opts.thinkingLevel)
        } catch (error) {
          this.deps.diagnose(`Thinking 级别设置（${projectCwd}）：${String(error)}`)
        }
        this.throwIfOpenCancelled(opts.signal, openedGeneration)
      }

      const threadId = session.sessionId
      const record: ThreadRecord = {
        threadId,
        session,
        sessionManager,
        settingsManager: prepared.trust.settingsManager,
        uiBridge: undefined as unknown as ThreadRecord['uiBridge'],
        hostUi: createHostUiState(),
        unsubscribe: () => {},
        listeners: new Set(),
        seq: 0,
        turnIndex: -1,
        workspacePath: projectCwd,
        workspaceId: opts.workspaceId,
        workspaceAppliedRevision:
          opts.workspaceAppliedRevision ??
          (opts.workspaceId
            ? this.deps.workspaceStore.workspace(opts.workspaceId)?.revision
            : undefined),
        workspaceBinding: prepared.workspaceBinding,
        lastError: undefined,
        modelFallback,
        activeTools: new Map(),
        resourceLoader: prepared.trust.resourceLoader,
        trustBinding: prepared.trustBinding,
        mcp: prepared.mcp,
        inFlight: new Set(),
        currentRun: undefined,
        bash: undefined,
        lastCompaction: undefined,
        compactionReason: undefined,
        lastCompactionError: undefined,
        lastCompactionAborted: false,
        admission: undefined,
        admissionWaiters: new Set(),
        startingSend: undefined,
        retired: false,
        sweepUnattendedRun: false,
        structure: undefined,
        // 新装配即当前资源版本；成功重载后再递增。
        resourceRevision: this.deps.resourceRevision(),
        reload: undefined,
      }

      /** 装配期请求的宿主作用域：record 发布前也允许另一窗口发现/应答。 */
      const startupScope: import('@huan/protocol').HarnessHostInteractionScope = {
        kind: 'session',
        sessionId: threadId,
        cwd: projectCwd,
      }
      const uiBridge = this.deps.events.createUiBridge(record, startupScope, opts.signal)
      record.uiBridge = uiBridge
      // 运行边界回调：before_agent_start 固定本轮 revision，供页面显示实际生效版本。
      prepared.workspaceBinding.onApplied = (workspace) => {
        if (record.workspaceAppliedRevision === workspace?.revision) return
        record.workspaceAppliedRevision = workspace?.revision
        this.deps.events.emit(record, {
          type: 'snapshot',
          snapshot: this.deps.events.snapshotOf(record),
        })
      }

      // 装配期：session_start handler 的阻断请求进入宿主交互域（另一通道可应答）。
      uiBridge.setStartup(true)

      const onOpenAbort = () => {
        // 冷打开/创建被取消：立即解除启动期 UI，并永久关闭本装配的 MCP
        // binding；即使 session_start handler 永不返回，也不能让晚到回调
        // 在取消后启动连接。
        uiBridge.dismissAll()
        void this.deps.assembly.closeBinding(prepared.mcp)
      }
      opts.signal?.addEventListener('abort', onOpenAbort, { once: true })

      try {
        await session.bindExtensions({
          uiContext: uiBridge.ui,
          // 与 CLI RPC 一致：扩展据此判断非终端环境，不尝试 TUI 专属界面。
          mode: 'rpc',
          commandContextActions: this.deps.commandActionsFor(record),
          shutdownHandler: () => {
            throw new UnsupportedHostCommandActionError('shutdown')
          },
          onError: (error) => {
            record.lastError = error.error
            this.deps.events.emit(record, { type: 'error', error: error.error })
          },
        })
      } catch (error) {
        uiBridge.dismissAll()
        session.dispose()
        throw error
      } finally {
        opts.signal?.removeEventListener('abort', onOpenAbort)
      }

      if (this.openWasCancelled(opts.signal, openedGeneration)) {
        uiBridge.dismissAll()
        session.dispose()
        this.throwOpenCancelled()
      }

      try {
        record.unsubscribe = session.subscribe((event) =>
          this.deps.events.onSessionEvent(record, event),
        )
        // agent 级兜底订阅（直连 `session.agent`，**刻意不提供退订**）：
        // 它不受 `session.dispose()` 清理影响（那只断开 agent→session 的转发）。
        // 必要性：SDK 在 `_emitAgentSettled()` 里先 `splice(0)` 把延迟动作取入
        // **局部数组**再逐个 `await`；若退休发生在「第一个动作运行中」，后续
        // 动作就留在这个局部数组里，成员数组清空够不到——只有本订阅能在它们
        // 启动（`agent_start`）时中止（探针实证：不保留则多发出 1 次请求）。
        // 局部批次链的结束没有可靠信号，故永久保留；record 最终成为只被该
        // 闭包引用的孤立环，随会话一起被 GC 回收。
        session.agent.subscribe((event) => {
          if (event.type !== 'agent_start') return
          if (record.retired) {
            // 退休后仍启动的运行：立即中止（不 await，避免与 agent 的监听等待互锁）。
            session.agent.abort()
            return
          }
          // 取消后由延迟动作启动的无归属运行：按清扫标记中止。
          const run = record.currentRun
          if (run && run.owner === undefined && record.sweepUnattendedRun) {
            run.cancelled = true
            record.sweepUnattendedRun = false
            session.agent.abort()
          }
        })
      } catch (error) {
        try {
          uiBridge.dismissAll()
        } catch {
          // 清理失败不掩盖原始错误。
        }
        try {
          session.dispose()
        } catch {
          // 同上。
        }
        throw error
      }

      this.records.set(threadId, record)
      if (session.sessionFile) this.recordsBySessionFile.set(session.sessionFile, record)
      // record 已发布：binding 所有权从装配服务移交给 live record。
      this.deps.assembly.transferBinding(prepared.mcp)
      prepared.guard.record = record
      published = true
      // 离开装配期：清掉 handler 未 await 的遗留请求，避免线程通道出现重复。
      uiBridge.setStartup(false)
      return record
    } catch (error) {
      // 任一打开/绑定/发布失败都意味着本装配不会被会话消费：主动关闭 MCP
      // binding，防止阻塞在 session_start 的晚回调在失败后重新启动连接。
      if (!published) await this.deps.assembly.closeBinding(prepared.mcp)
      throw error
    }
  }

  /**
   * 统一收尾：先同步使资格失效，再 await 同一 promise。
   * 删除/创建归属失败/全局 dispose 共用；文件删除与 sidecar 清理由调用方处理。
   */
  retire(record: ThreadRecord): Promise<void> {
    const existing = this.retiring.get(record)
    if (existing) return existing
    const promise = this.retireNow(record)
    this.retiring.set(record, promise)
    return promise
  }

  private async retireNow(record: ThreadRecord): Promise<void> {
    // 0) 进入收尾：不再接受新运行，并唤醒等待闸门的发送使其退出。
    record.retired = true
    this.invalidateMcpRuntime(record)
    this.deps.coordinator.wakeAdmissionWaiters(record)
    // 0.4) 取消并等待用户 Shell 结束（外部副作用不可撤销，但必须释放清理）。
    await this.abortUserBashForRetire(record)
    // 0.5) 取消并排空结构操作（导航摘要可中止），不能在退休 record 上继续提交。
    await this.deps.coordinator.cancelAndDrainStructure(record)
    // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
    discardDeferredRuns(record.session, this.deps.diagnose)
    // 1) 使在途发送（含预检）失效，避免删除后仍启动运行。
    for (const pending of record.inFlight) pending.cancelled = true
    // 2) 先解除阻断式 UI 等待，否则 abort 可能等一个永不应答的对话（工具在等 UI）。
    record.uiBridge.dismissAll()
    // 3) 中止运行并等待收尾（此时工具/UI 已不再阻断；等待有上限）。
    await abortForRetire(record.session)
    // 4) 等待在途发送的预检退出（它们不再启动运行）。
    await this.deps.coordinator.drainInFlight(record)
    // MCP 回收必须在其他扩展 shutdown 之前：即使某个 handler 永久阻塞或报错，
    // 连接也不能依赖它清理（binding.close 同步禁止晚结果）。
    await this.deps.assembly.closeBinding(record.mcp)
    // 5) 收尾：先补发 shutdown（扩展可能在 handler 里再次提交延迟动作），
    //    随后**同步链内**再次清空延迟数组并 dispose，中间不插 await，
    //    否则放行的扩展 hook 会在清空与 dispose 之间启动延迟运行。
    //    注：清空够不到 SDK 已 `splice(0)` 取走的局部批次，那部分由
    //    agent 级兜底订阅在 agent_start 时中止（见 record 字段注释）。
    await this.emitShutdown(record, 'quit')
    discardDeferredRuns(record.session, this.deps.diagnose)
    record.session.dispose()
    record.unsubscribe()
    // 保留 agent 级兜底订阅：局部批次可能在收尾后才启动（见字段注释）。
    this.records.delete(record.threadId)
    if (record.session.sessionFile) {
      this.recordsBySessionFile.delete(record.session.sessionFile)
    }
    this.deps.events.forgetEditorMirrors(record.threadId)
  }

  /** 收尾一个刚创建但归属保存失败的会话：保留 Pi 文件供「未归属」发现。 */
  async abandon(record: ThreadRecord): Promise<void> {
    await this.retire(record)
  }

  async deleteThread(threadId: string): Promise<void> {
    // 冷重命名等尚未 live 的结构操作先拒绝删除，避免边写边删。
    if (this.coldStructure.has(threadId)) throw new ThreadStructureBusyError()
    this.pendingOpens.get(threadId)?.controller.abort()
    const record = this.records.get(threadId)
    const info = record ? undefined : await this.deps.catalog.findSessionInfo(threadId)
    if (!record && !info) {
      // 上次可能已删除文件但侧车清理失败；重试仍须完成清理。
      await this.deps.workspaceStore.removeSessionMetadata({
        storeId: this.deps.storeId,
        sessionId: threadId,
      })
      return
    }
    // 已知侧车不可写时在删除文件前拒绝，避免可预知的部分删除。
    if (!this.deps.workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        this.deps.workspaceStore.integrity === 'ok'
          ? 'unreadable'
          : this.deps.workspaceStore.integrity,
        this.deps.workspaceStore.stateFile,
      )
    }
    const sessionFile = record?.session.sessionFile ?? info?.path
    const cwd = record?.workspacePath ?? info?.cwd
    if (!sessionFile) throw new Error(`Unknown thread: ${threadId}`)
    // 在中止或移除 live record 之前拒绝越界路径，失败不得先破坏当前会话。
    this.deps.catalog.assertSessionFileInScope(sessionFile, cwd)

    if (record) await this.retire(record)
    // 删除同样限于当前存储作用域（防止作用域外路径被作用到）。
    this.deps.catalog.assertSessionFileInScope(sessionFile, cwd)
    await unlink(sessionFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (cwd) this.deps.catalog.invalidateCatalog(cwd)
    // 文件删除成功后才清理归属与归档元数据。文件与 sidecar 没有跨文件事务，
    // 清理失败必须报告（由调用方呈现），不伪造成功。
    await this.deps.workspaceStore.removeSessionMetadata({
      storeId: this.deps.storeId,
      sessionId: threadId,
    })
  }

  /** 删除串行化：同一线程的并发删除共享同一 promise。 */
  deleteOnce(threadId: string): Promise<void> {
    const pending = this.pendingDeletes.get(threadId)
    if (pending) return pending
    const deletion = this.deleteThread(threadId).finally(() => {
      if (this.pendingDeletes.get(threadId) === deletion) this.pendingDeletes.delete(threadId)
    })
    this.pendingDeletes.set(threadId, deletion)
    return deletion
  }

  /**
   * 补发 `session_shutdown`。
   *
   * SDK 的 `AgentSession.dispose()` 只做 abort 与内部清理，不发 shutdown 事件；
   * 官方 runtime 在销毁前显式发它（`agent-session-runtime.js`）。扩展若在
   * `session_start` 建连接/定时器并在 `session_shutdown` 释放，缺这一步会泄漏。
   */
  async emitShutdown(
    record: ThreadRecord,
    reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork',
  ): Promise<void> {
    try {
      const extensionsResult = record.resourceLoader.getExtensions()
      const sessionDir = this.deps.catalog.scopeOf(record.workspacePath).dir
      const runner = new ExtensionRunner(
        extensionsResult.extensions,
        extensionsResult.runtime,
        record.workspacePath,
        SessionManager.open(record.session.sessionFile ?? '', sessionDir),
        new ModelRegistry(this.deps.modelRuntime),
      )
      await runner.emit({ type: 'session_shutdown', reason })
    } catch (error) {
      this.deps.diagnose(`session_shutdown（${record.workspacePath}）：${String(error)}`)
    }
  }

  /** 收尾：取消并等待正在运行的 Shell（有上限，不阻塞删除/销毁）。 */
  private async abortUserBashForRetire(record: ThreadRecord): Promise<void> {
    // 扩展直接调用 executeBash 启动的 Shell 也按会话级状态兜底中止。
    if (record.session.isBashRunning) record.session.abortBash()
    const run = record.bash
    if (run?.status !== 'running') return
    run.cancelRequested = true
    run.controller.abort()
    record.uiBridge.dismissAll()
    await withTimeout(run.done, RETIRE_ABORT_TIMEOUT_MS, 'Shell 命令').catch(() => {})
  }

  /** 返回 record 当前 live manager 与唯一 runtimeId。 */
  liveMcpBindingOf(value: unknown): McpHostLiveBinding | undefined {
    const record = value as ThreadRecord | undefined
    if (!record || this.deps.isDisposed() || record.retired) return undefined
    const manager = record.mcp.getManager()
    if (!manager) return undefined
    const previous = this.mcpRuntimes.get(record)
    if (previous && previous.manager !== manager) {
      this.mcpRuntimes.delete(record)
      this.deps.invalidateMcpRuntime(previous.runtimeId)
    }
    const current = this.mcpRuntimes.get(record)
    if (current) {
      return {
        runtimeId: current.runtimeId,
        manager: current.manager,
        busy: this.deps.coordinator.mcpRuntimeBusy(record),
        acquireIdle: () => {
          if (record.retired || this.deps.isDisposed()) return undefined
          try {
            const operation = this.deps.coordinator.beginStructure(record, 'mcp')
            return { release: () => this.deps.coordinator.releaseStructure(record, operation) }
          } catch {
            return undefined
          }
        },
      }
    }
    const runtimeId = `mcp-runtime:${++this.mcpRuntimeCounter}`
    this.mcpRuntimes.set(record, { runtimeId, manager })
    return {
      runtimeId,
      manager,
      busy: this.deps.coordinator.mcpRuntimeBusy(record),
      acquireIdle: () => {
        if (record.retired || this.deps.isDisposed()) return undefined
        try {
          const operation = this.deps.coordinator.beginStructure(record, 'mcp')
          return { release: () => this.deps.coordinator.releaseStructure(record, operation) }
        } catch {
          return undefined
        }
      },
    }
  }

  /** 目标重载/删除/dispose 前同步失效旧认证操作与 needsRefresh 标记。 */
  invalidateMcpRuntime(record: ThreadRecord): void {
    const entry = this.mcpRuntimes.get(record)
    if (!entry) return
    this.mcpRuntimes.delete(record)
    this.deps.invalidateMcpRuntime(entry.runtimeId)
  }

  /**
   * 订阅线程事件。首帧为权威快照；损坏元数据仅允许冷读，订阅也不隐式装配。
   */
  subscribe(
    threadId: string,
    listener: (event: HarnessClientEvent) => void,
    options?: { includeSnapshot?: boolean },
  ): () => void {
    if (!this.deps.workspaceStore.healthy) {
      let active = true
      void Promise.resolve(this.deps.catalog.getThread(threadId))
        .then((snapshot) => {
          if (active && options?.includeSnapshot !== false) {
            listener({ type: 'snapshot', snapshot, threadId, seq: 0 })
          }
        })
        .catch(() => {})
      return () => {
        active = false
      }
    }
    let active = true
    let record: ThreadRecord | undefined
    this.ensureOpen(threadId)
      .then((opened) => {
        if (!active) return
        record = opened
        opened.listeners.add(listener)
        if (options?.includeSnapshot !== false) {
          try {
            listener({
              type: 'snapshot',
              snapshot: this.deps.events.snapshotOf(opened),
              threadId,
              seq: opened.seq,
            })
          } catch {
            // 订阅者抛错不影响其他订阅者。
          }
        }
      })
      .catch((error: unknown) => {
        if (active) {
          try {
            listener({
              type: 'error',
              error: error instanceof Error ? error.message : String(error),
              threadId,
              seq: 0,
            })
          } catch {
            // 同上。
          }
        }
      })
    return () => {
      active = false
      record?.listeners.delete(listener)
    }
  }

  respondToHostUiRequest(
    threadId: string,
    response: import('@huan/protocol').HarnessHostUiResponse,
  ): void {
    this.records.get(threadId)?.uiBridge.resolve(response)
  }

  consumeHostUiDirective(
    threadId: string,
    directiveId: string,
    options?: { callerId?: string },
  ): boolean {
    const record = this.records.get(threadId)
    if (!record) return false
    let changed = false
    const directive = record.hostUi.editorDirective
    if (directive?.id === directiveId) {
      if (directive.callerId && directive.callerId !== options?.callerId) return false
      record.hostUi.editorDirective = undefined
      changed = true
    }
    if (record.hostUi.commandTarget?.id === directiveId) {
      const callerId = record.hostUi.commandTarget.callerId
      if (callerId && callerId !== options?.callerId) return false
      record.hostUi.commandTarget = undefined
      changed = true
    }
    if (changed) this.deps.events.emitHostUiSnapshot(record)
    return changed
  }

  /** 全局销毁：先失效打开任务，再逐 record 执行同一收尾；单项失败不跳后续。 */
  async disposeAll(): Promise<void> {
    for (const pending of this.pendingOpens.values()) pending.controller.abort()
    this.pendingOpens.clear()
    const errors: unknown[] = []
    for (const record of [...this.records.values()]) {
      try {
        await this.retire(record)
      } catch (error) {
        errors.push(error)
      }
    }
    this.records.clear()
    this.recordsBySessionFile.clear()
    this.deps.events.clearEditorMirrors()
    if (errors.length > 0) throw errors[0]
  }
}

/** 模型是否在当前两层范围的候选中（按 provider + id 比较）。 */
function scopeContains(
  scope: ResolvedModelScope,
  model: { provider: string; id: string },
): boolean {
  return scope.scopedModels.some(
    (item) => item.model.provider === model.provider && item.model.id === model.id,
  )
}

/** 把 SDK 回退信息投影为可诊断的受控字段；不携带任意路径/凭据。 */
function modelFallbackOf(
  requested: { provider: string; modelId: string } | undefined,
  active: { provider: string; id: string } | undefined,
  message: string | undefined,
): import('@huan/protocol').HarnessModelFallback | undefined {
  if (!message) return undefined
  const reason = message.startsWith('Could not restore model')
    ? ('restore-failed' as const)
    : message.includes('No models') || message.includes('no models')
      ? ('no-model' as const)
      : ('unknown' as const)
  const requestedName = requested ? `${requested.provider}/${requested.modelId}` : '原模型'
  const activeName = active ? `${active.provider}/${active.id}` : undefined
  // 不直接转发 SDK 文案：只投影受控原因与原/有效模型，避免未来字段变化携带任意信息。
  const safeMessage =
    reason === 'restore-failed'
      ? `${requestedName} 不可用${activeName ? `，已使用 ${activeName}` : ''}`
      : reason === 'no-model'
        ? '没有可用模型，会话未取得有效模型'
        : '模型选择发生回退，请检查模型目录与认证配置'
  return {
    reason,
    ...(requested
      ? { requested: { provider: requested.provider, modelId: requested.modelId } }
      : {}),
    ...(active ? { active: { provider: active.provider, modelId: active.id } } : {}),
    message: safeMessage,
  }
}
