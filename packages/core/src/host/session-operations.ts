/**
 * 会话业务操作：发送/停止、树导航/标签、fork、Shell、压缩、模型/Thinking/命名
 * 与扩展命令上下文动作。
 *
 * 所有结构操作先经 operation-coordinator 同步占窗；本模块不直接写闸门字段。
 */

import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type AgentSession,
  type ExtensionCommandContextActions,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessBashAbortResult,
  HarnessBashResult,
  HarnessBashStartResult,
  HarnessCompactionAbortResult,
  HarnessCompactionOutcome,
  HarnessHostUiCommandTarget,
  HarnessSendMessageInput,
  HarnessSendMessageOptions,
  HarnessSendMessageResult,
  HarnessThinkingLevel,
  HarnessThreadForkInput,
  HarnessThreadForkResult,
  HarnessTreeCancelResult,
  HarnessTreeLabelInput,
  HarnessTreeLabelResult,
  HarnessTreeNavigateInput,
  HarnessTreeNavigateResult,
  HarnessTreeQueueRecovery,
} from '@huan/protocol'
import { builtinCommandNameOf } from '@huan/protocol'
import type { ResolvedModelScope } from '../model-catalog.js'
import {
  createForkSessionManager,
  ForkSessionCreateError,
  resolveForkTarget,
} from '../session-fork.js'
import { sessionTreeRevision } from '../session-tree.js'
import { executeColoredBash } from '../shell.js'
import type { WorkspaceStore } from '../workspace-store.js'
import type { LiveSessions } from './live-sessions.js'
import type { OperationCoordinator } from './operation-coordinator.js'
import type { ProjectAssembly } from './project-assembly.js'
import type { SessionCatalog } from './session-catalog.js'
import type { SessionEvents } from './session-events.js'
import {
  BASH_OUTPUT_MAX_CHARS,
  type CommandNewSessionOptions,
  callerContext,
  discardDeferredRuns,
  hasOtherInFlight,
  ImageInputUnsupportedError,
  type InFlightSend,
  type PreparedProject,
  type ReplacedSessionContext,
  ReservedBuiltinCommandError,
  type StructureOperation,
  sendContext,
  type ThreadRecord,
  ThreadStructureBusyError,
  type UserBashRun,
} from './shared.js'

export type SessionOperationsDeps = {
  live: Pick<
    LiveSessions,
    | 'abandon'
    | 'beginStartingSend'
    | 'cancelStartingSends'
    | 'coldStructure'
    | 'endStartingSend'
    | 'ensureOpen'
    | 'get'
    | 'hasPendingOpen'
    | 'openSession'
  >
  catalog: Pick<
    SessionCatalog,
    | 'assertSessionFileInScope'
    | 'findSessionInfo'
    | 'invalidateCatalog'
    | 'openScopedSessionManager'
    | 'scopeOf'
  >
  events: Pick<
    SessionEvents,
    | 'emit'
    | 'emitSnapshot'
    | 'metadataOf'
    | 'rememberCallerDraft'
    | 'setHostUiCommandTarget'
    | 'snapshotOf'
  >
  coordinator: Pick<
    OperationCoordinator,
    | 'acquireAdmission'
    | 'beginStructure'
    | 'markStructureSummarizing'
    | 'releaseStructure'
    | 'stop'
    | 'stopForNavigation'
  >
  assembly: Pick<ProjectAssembly, 'acquire' | 'closeBinding'>
  workspaceStore: WorkspaceStore
  storeId: string
  workspacePath: string
  /** 由资源配置服务提供的重载入口（扩展 ctx.reload）。 */
  reloadThread: (
    record: ThreadRecord,
    trigger: 'extension',
  ) => Promise<import('@huan/protocol').HarnessReloadResult>
  /** 解析会话所属工作区的当前两层模型范围（用于主动切换校验）。 */
  resolveModelScope: (workspaceId?: string) => Promise<ResolvedModelScope>
  diagnose: (message: string) => void
  assertActive: () => void
  isDisposed: () => boolean
  modelRuntime: import('./model-service.js').SharedModelRuntime
}

export class SessionOperations {
  constructor(private readonly deps: SessionOperationsDeps) {}

  private get live(): SessionOperationsDeps['live'] {
    return this.deps.live
  }

  private get events(): SessionOperationsDeps['events'] {
    return this.deps.events
  }

  private get coordinator(): SessionOperationsDeps['coordinator'] {
    return this.deps.coordinator
  }

  private assertActive(): void {
    this.deps.assertActive()
  }

  /**
   * 把新/已打开的 record 包装成 SDK 期望的替换会话上下文。
   *
   * 基础上下文由新会话自己的 ExtensionRunner 生成（绑定到该会话的
   * commandContextActions），再补上 RPC 模式提供的发送方法。
   */
  private replacedContextOf(target: ThreadRecord): ReplacedSessionContext {
    const base = target.session.extensionRunner.createCommandContext()
    const context = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base)) as Record<
      string,
      unknown
    >
    context.sendMessage = (
      message: Parameters<AgentSession['sendCustomMessage']>[0],
      options?: Parameters<AgentSession['sendCustomMessage']>[1],
    ) => target.session.sendCustomMessage(message, options)
    context.sendUserMessage = (
      content: Parameters<AgentSession['sendUserMessage']>[0],
      options?: Parameters<AgentSession['sendUserMessage']>[1],
    ) => target.session.sendUserMessage(content, options)
    return context as unknown as ReplacedSessionContext
  }

  /** 会话目标提示：只写入发起会话的快照，父 live record 不替换。 */
  private announceCommandTarget(
    source: ThreadRecord,
    action: HarnessHostUiCommandTarget['action'],
    target: ThreadRecord,
    message: string,
    editorText?: string,
  ): void {
    this.events.setHostUiCommandTarget(
      source,
      action,
      target.threadId,
      message,
      this.events.metadataOf(target).title,
      editorText,
    )
  }

  /** `ctx.newSession()`：设置初始化内容与血缘后绑定独立会话，保留父 record。 */
  private async commandNewSession(
    source: ThreadRecord,
    options?: CommandNewSessionOptions,
  ): Promise<{ cancelled: boolean }> {
    const before = await source.session.extensionRunner.emit({
      type: 'session_before_switch',
      reason: 'new',
    })
    if (before?.cancel || source.retired) return { cancelled: true }
    const dir = this.deps.catalog.scopeOf(source.workspacePath).dir
    this.deps.catalog.assertSessionFileInScope(join(dir, '.huan-scope-check'), source.workspacePath)
    const manager = (await import('@earendil-works/pi-coding-agent')).SessionManager.create(
      source.workspacePath,
      dir,
      {
        ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
      },
    )
    await options?.setup?.(manager)
    if (source.retired) return { cancelled: true }
    const target = await this.live.openSession(manager, source.workspacePath, {
      isNew: true,
      ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
      ...(source.session.model ? { model: source.session.model } : {}),
      thinkingLevel: source.session.thinkingLevel,
      sessionStartEvent: {
        type: 'session_start',
        reason: 'new',
        ...(source.session.sessionFile ? { previousSessionFile: source.session.sessionFile } : {}),
      },
    })
    try {
      if (source.retired) {
        await this.live.abandon(target)
        return { cancelled: true }
      }
      if (source.workspaceId) {
        await this.deps.workspaceStore.assignSession({
          storeId: this.deps.storeId,
          sessionId: target.threadId,
          workspaceId: source.workspaceId,
        })
      }
    } catch (error) {
      await this.live.abandon(target)
      throw error
    }
    this.announceCommandTarget(source, 'newSession', target, '扩展已新建独立会话')
    if (options?.withSession) await options.withSession(this.replacedContextOf(target))
    return { cancelled: false }
  }

  /** `ctx.fork()`：复用独立 fork 语义；父会话与历史不变。 */
  private async commandFork(
    source: ThreadRecord,
    entryId: string,
    options?: Parameters<ExtensionCommandContextActions['fork']>[1],
  ): Promise<{ cancelled: boolean }> {
    const result = await this.forkThread(source.threadId, {
      entryId,
      position: options?.position ?? 'before',
    })
    if (result.status === 'cancelled') return { cancelled: true }
    if (result.status !== 'created' || !result.threadId) {
      throw new Error(result.message ?? `分叉失败：${result.status}`)
    }
    const target = this.live.get(result.threadId)
    if (!target) throw new Error('分叉会话已创建但未取得运行记录')
    this.announceCommandTarget(
      source,
      'fork',
      target,
      '扩展已创建独立分叉会话',
      result.selectedText,
    )
    if (options?.withSession) await options.withSession(this.replacedContextOf(target))
    return { cancelled: false }
  }

  /** `ctx.navigateTree()`：走宿主既有结构闸门/摘要语义，不绕过队列恢复。 */
  private async commandNavigateTree(
    source: ThreadRecord,
    targetId: string,
    options?: Parameters<ExtensionCommandContextActions['navigateTree']>[1],
  ): Promise<{ cancelled: boolean }> {
    const result = await this.navigateThreadTree(source.threadId, {
      targetId,
      expectedRevision: sessionTreeRevision(source.sessionManager),
      ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
      ...(options?.customInstructions !== undefined
        ? { customInstructions: options.customInstructions }
        : {}),
      ...(options?.replaceInstructions !== undefined
        ? { replaceInstructions: options.replaceInstructions }
        : {}),
    })
    if (result.status === 'cancelled') return { cancelled: true }
    if (result.status !== 'applied') {
      throw new Error(result.message ?? `会话树导航失败：${result.status}`)
    }
    this.announceCommandTarget(
      source,
      'navigateTree',
      source,
      '扩展已切换会话树落点',
      result.editorText,
    )
    return { cancelled: false }
  }

  /** `ctx.switchSession()`：把目标文件作为独立会话打开，不替换当前 record。 */
  private async commandSwitchSession(
    source: ThreadRecord,
    sessionPath: string,
    options?: Parameters<ExtensionCommandContextActions['switchSession']>[1],
  ): Promise<{ cancelled: boolean }> {
    const file = resolve(sessionPath)
    const before = await source.session.extensionRunner.emit({
      type: 'session_before_switch',
      reason: 'resume',
      targetSessionFile: file,
    })
    if (before?.cancel) return { cancelled: true }
    const scope = this.deps.catalog.assertSessionFileInScope(file, source.workspacePath)
    // 先只读打开获取 sessionId（不传 cwdOverride，否则 SDK 会跳过 header 并新建 ID）。
    const manager = SessionManager.open(file, scope.dir)
    const targetId = manager.getSessionId()
    this.deps.catalog.invalidateCatalog(source.workspacePath)
    const target = await this.live.ensureOpen(targetId)
    if (target.threadId !== source.threadId) {
      this.announceCommandTarget(source, 'switchSession', target, '扩展已切换到另一个独立会话')
      if (options?.withSession) await options.withSession(this.replacedContextOf(target))
    }
    return { cancelled: false }
  }

  /** 扩展命令上下文动作（与 SDK RPC 模式同形）。 */
  commandActionsFor(record: ThreadRecord): ExtensionCommandContextActions {
    return {
      waitForIdle: () => record.session.waitForIdle(),
      newSession: (options) => this.commandNewSession(record, options),
      fork: (entryId, options) => this.commandFork(record, entryId, options),
      navigateTree: (targetId, options) => this.commandNavigateTree(record, targetId, options),
      switchSession: (sessionPath, options) =>
        this.commandSwitchSession(record, sessionPath, options),
      // 扩展命令的 ctx.reload：与 GUI /reload、设置面板按钮走同一条受控路径。
      // 命令本身运行在在途发送内，闸门只等待其他发送/运行，因此不会自等死锁。
      reload: async () => {
        const result = await this.deps.reloadThread(record, 'extension')
        if (result.status === 'busy') throw new ThreadStructureBusyError(result.message)
        if (result.status === 'cancelled') throw new Error(result.message)
        if (result.status === 'failed') throw new Error(result.message)
      },
    }
  }

  async sendMessage(
    threadId: string,
    input: HarnessSendMessageInput,
    options?: HarnessSendMessageOptions,
  ): Promise<HarnessSendMessageResult> {
    this.assertActive()
    // 调用方窗口上下文沿 prompt/工具异步链传播；命令处理与工具可据此定向。
    return callerContext.run(options?.callerId, async () => {
      const token = this.live.beginStartingSend(threadId)
      try {
        const record = await this.live.ensureOpen(threadId)
        if (token.cancelled) {
          this.events.emit(record, { type: 'agent_end', cancelledBeforeStart: true })
          return { disposition: 'cancelled' }
        }
        // 取消判断合并两个来源：冷打开窗口的 token 与 record 上的在途取消标记。
        return await this.send(record, input, () => token.cancelled)
      } finally {
        this.live.endStartingSend(threadId, token)
      }
    })
  }

  /** 提交前守卫：已知内置 slash 不能作为普通 prompt 进入模型。 */
  private assertNotReservedCommand(content: string): void {
    const command = builtinCommandNameOf(content)
    if (command) throw new ReservedBuiltinCommandError(command)
  }

  /**
   * 提交前图片能力校验。
   *
   * 以当前 live session 的模型元数据为准；模型缺失或未声明 image 都拒绝。
   * 拒绝发生在预检之前，不产生模型请求，也不写会话历史。
   */
  private assertImagesSupported(record: ThreadRecord, input: HarnessSendMessageInput): void {
    if (!input.attachments?.some((attachment) => attachment.type === 'image')) return
    const model = record.session.model
    if (model?.input?.includes('image')) return
    throw new ImageInputUnsupportedError(model?.provider, model?.id)
  }

  /**
   * 发送一次 prompt，返回「输入已被接受」的承诺（不等待运行结束）。
   *
   * 预检取消兜底：SDK 的 `abort()` 只在 `_isAgentRunActive` 为真时记录中止意图，
   * 而预检（input hook / 认证检查 / before_agent_start）期间该标志尚未置位，
   * 且 `_runAgentPrompt()` 启动时会重置中止标志——预检期间的取消直接落空。
   * 因此取消意图先随发送登记（`startingSend`），运行激活（`agent_start`）时
   * 取用为当前运行归属并立即中止，阻止模型请求真正发出。
   */
  async send(
    record: ThreadRecord,
    input: HarnessSendMessageInput,
    isCancelled: () => boolean,
  ): Promise<HarnessSendMessageResult> {
    this.assertActive()
    // 提交前同步调用方窗口的草稿镜像（扩展 getEditorText 的同步来源）。
    const callerId = callerContext.getStore()
    if (callerId) this.events.rememberCallerDraft(record.threadId, callerId, input.content)
    // 内置命令与图片能力都在登记发送前同步拒绝，避免进入 SDK 预检。
    this.assertNotReservedCommand(input.content)
    this.assertImagesSupported(record, input)
    // 与结构操作互斥：在登记任何在途发送之前同步检查，结构操作占窗后
    // 这里明确报 busy，不会在 await 后潜入预检。
    if (record.structure) throw new ThreadStructureBusyError()
    if (record.retired) throw new Error('Harness session is retired')

    let resolveFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const inFlight: InFlightSend = {
      accepted: false,
      cancelled: false,
      finished,
      markFinished: () => resolveFinished(),
    }
    record.inFlight.add(inFlight)

    // 准入闸门：串行化每会话的「预检 → 运行确认」段，防止后到者提前结算前者运行。
    const admission = await this.coordinator.acquireAdmission(record, inFlight, isCancelled)
    if (admission === undefined) {
      if (record.retired || isCancelled() || inFlight.cancelled) {
        // 等待期间被取消 / 会话进入收尾：不进入预检，按「未启动即取消」上报。
        this.events.emit(record, { type: 'agent_end', cancelledBeforeStart: true })
        record.inFlight.delete(inFlight)
        inFlight.markFinished()
        return { disposition: 'cancelled' }
      }
      if (record.structure) {
        // 结构操作（如运行中重命名）在等待期间占窗：明确拒绝，不进入预检。
        record.inFlight.delete(inFlight)
        inFlight.markFinished()
        throw new ThreadStructureBusyError()
      }
    }

    // 占窗返回后再次同步确认结构闸门（防御未来新增的等待路径）。
    if (admission && record.structure) {
      admission.release()
      record.inFlight.delete(inFlight)
      inFlight.markFinished()
      throw new ThreadStructureBusyError()
    }

    try {
      // 预检承诺：接受（含入队）或被拒绝时结算一次。
      let settlePreflight: (error?: unknown) => void = () => {}
      let preflightSettled = false
      const accepted = new Promise<HarnessSendMessageResult>((resolve, reject) => {
        settlePreflight = (error) => {
          if (preflightSettled) return
          preflightSettled = true
          if (error) reject(error)
          else resolve({ disposition: disposition ?? 'handled' })
        }
      })

      // 运行中 Pi 要求显式声明排队语义；默认 followUp。
      const streamingBehavior =
        input.streamingBehavior ?? (record.session.isStreaming ? 'followUp' : undefined)
      // 提交点处置：'handled' 不会产生运行事件，需要补一次权威快照，
      // 否则客户端的乐观输入和侧栏标题会一直停留在未确认状态。
      let disposition: 'started' | 'queued' | 'handled' | undefined

      // 用 AsyncLocalStorage 绑定本次发送：输入守卫据此精确认领（不用文本匹配）。
      // `prompting` 在后台继续（接受语义：不等待运行结束）；其失败已在 catch 内处理。
      void sendContext.run(inFlight, () =>
        record.session
          .prompt(input.content, {
            ...(input.attachments?.length ? { images: input.attachments } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            preflightResult: (dispositionArg) => {
              // 提交点拒绝（已退休 / 已取消）：此刻放行会让 SDK 继续进入
              // `_runAgentPrompt()` 启动运行。
              // - 退休：宿主已退订，无 agent_start 可兜底；
              // - 取消：本发送在闸门等待期间被标记，或以延迟动作身份
              //   在结算窗口后恢复（`_deferredSettledActions`）。
              // 抛错使 prompt 以拒绝收尾（SDK 不捕获此回调异常）。
              if (record.retired) throw new Error('Harness session is retired')
              if (isCancelled() || inFlight.cancelled) throw new Error('Harness send was cancelled')
              inFlight.accepted = true
              disposition = dispositionArg
              settlePreflight()
              // 取消意图统一记入发送级标记。
              if (isCancelled()) inFlight.cancelled = true
              // 仅 'started' 会启动运行；'handled'/'queued' 无独立运行可归属。
              if (disposition !== 'started') return
              record.startingSend = inFlight
              // 运行确认后释放准入闸门：后续发送可以开始它们的预检
              // （SDK 会因运行中而走 queued 分支，不再建立新运行）。
              admission?.release()
            },
          })
          .then(() => {
            settlePreflight()
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            // 已取消 / 已退休的发送被拒（含提交点拒绝与 SDK「Agent is already processing」）：
            // 属取消的预期结果，不记为失败，也不向订阅者抛错误。
            if (inFlight.cancelled || isCancelled() || record.retired) {
              settlePreflight()
              return
            }
            record.lastError = message
            if (preflightSettled) {
              this.events.emit(record, { type: 'error', error: message })
            } else {
              settlePreflight(error)
            }
          })
          .finally(() => {
            record.inFlight.delete(inFlight)
            // 运行从未启动（如被拒）时不要留下占用的归属槽。
            if (record.startingSend === inFlight) record.startingSend = undefined
            admission?.release()
            inFlight.markFinished()
          }),
      )

      try {
        const result = await accepted
        if (result.disposition === 'handled') this.events.emitSnapshot(record)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        record.lastError = message
        this.events.emit(record, { type: 'error', error: message })
        throw error
      }
    } finally {
      // 任一路径退出发送（接受 / 预检异常 / 早起退出）都要释放闸门，
      // 否则后续发送会永久等待（release 幂等）。
      admission?.release()
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    this.live.cancelStartingSends(threadId)
    const record = this.live.get(threadId)
    if (!record) return
    await this.coordinator.stop(record)
  }

  clearQueue(threadId: string): { steering: string[]; followUp: string[] } {
    const record = this.live.get(threadId)
    if (!record) return { steering: [], followUp: [] }
    return record.session.clearQueue()
  }

  // ---- 会话树与结构导航 ----

  /** 落点 sidecar 保存（导航/标签边界唯一写入点）。 */
  private async saveSessionLeaf(
    record: ThreadRecord,
    leafId: string | null,
  ): Promise<'saved' | 'failed'> {
    if (!this.deps.workspaceStore.healthy) return 'failed'
    try {
      await this.deps.workspaceStore.setSessionLeaf({
        storeId: this.deps.storeId,
        sessionId: record.threadId,
        leaf: { leafId, entryCount: record.sessionManager.getEntryCount() },
      })
      return 'saved'
    } catch (error) {
      this.deps.diagnose(`会话树落点（${record.threadId}）：${String(error)}`)
      return 'failed'
    }
  }

  /**
   * 持久化失败后恢复可恢复的原落点/上下文。
   *
   * 使用公开 branch/resetLeaf + refreshContext 恢复精确落点，包含用户节点和
   * null；回滚不再次触发扩展导航钩子。已追加摘要无法撤销，另行如实报告。
   */
  private async restoreNavigationPosition(
    record: ThreadRecord,
    previousLeafId: string | null,
  ): Promise<boolean> {
    if (!record.retired) {
      if (previousLeafId === null) record.sessionManager.resetLeaf()
      else if (record.sessionManager.getEntry(previousLeafId)) {
        record.sessionManager.branch(previousLeafId)
      } else return false
      record.session.refreshContext()
      return record.sessionManager.getLeafId() === previousLeafId
    }
    return false
  }

  async navigateThreadTree(
    threadId: string,
    input: HarnessTreeNavigateInput,
  ): Promise<HarnessTreeNavigateResult> {
    this.assertActive()
    const record = await this.live.ensureOpen(threadId)
    let operation: StructureOperation
    try {
      operation = this.coordinator.beginStructure(record, 'navigate', {
        targetId: input.targetId,
        allowRunning: input.stopRunning === true,
      })
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return {
        status: 'busy',
        leafId: record.sessionManager.getLeafId(),
        treeRevision: sessionTreeRevision(record.sessionManager),
        message: error.message,
      }
    }

    /** 释放结构闸门后再生成快照，避免返回帧携带已结束的操作状态。 */
    const finalize = (result: HarnessTreeNavigateResult): HarnessTreeNavigateResult => {
      this.coordinator.releaseStructure(record, operation)
      return {
        ...result,
        leafId: record.sessionManager.getLeafId(),
        treeRevision: sessionTreeRevision(record.sessionManager),
        ...(record.retired ? {} : { snapshot: this.events.snapshotOf(record) }),
      }
    }

    let recovered: HarnessTreeQueueRecovery | undefined
    try {
      const revisionAtStart = sessionTreeRevision(record.sessionManager)
      if (input.expectedRevision !== revisionAtStart) {
        return finalize({ status: 'conflict', message: '会话树已变化，请刷新后重试' })
      }
      if (!record.sessionManager.getEntry(input.targetId)) {
        return finalize({ status: 'failed', message: '目标节点不存在，请刷新会话树' })
      }
      if (record.sessionManager.getLeafId() === input.targetId) {
        return finalize({ status: 'applied', persistence: 'skipped' })
      }

      if (
        record.session.isStreaming ||
        record.currentRun !== undefined ||
        hasOtherInFlight(record)
      ) {
        if (input.stopRunning !== true) {
          return finalize({
            status: 'busy',
            message: '会话正在运行，请使用“停止并跳转”',
          })
        }
        this.live.cancelStartingSends(record.threadId)
        recovered = await this.coordinator.stopForNavigation(record)
        if (record.retired) {
          return finalize({
            status: 'cancelled',
            recoveredQueue: recovered,
            message: '会话已关闭，导航未执行',
          })
        }
        if (record.session.isStreaming || record.session.isCompacting) {
          return finalize({
            status: 'busy',
            recoveredQueue: recovered,
            message: '运行未能在限定时间内停止；队列已取回，请稍后重试',
          })
        }
      }

      const previousLeafId = record.sessionManager.getLeafId()
      const previousTools = record.session.getActiveToolNames()
      if (input.summarize === true) this.coordinator.markStructureSummarizing(record, operation)

      let outcome: Awaited<ReturnType<AgentSession['navigateTree']>>
      try {
        outcome = await record.session.navigateTree(input.targetId, {
          summarize: input.summarize === true,
          ...(input.customInstructions?.trim()
            ? { customInstructions: input.customInstructions.trim() }
            : {}),
          ...(input.replaceInstructions === true ? { replaceInstructions: true } : {}),
        })
      } catch (error) {
        operation.summaryActive = false
        return finalize({
          status: 'failed',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          message: error instanceof Error ? error.message : String(error),
        })
      }
      operation.summaryActive = false
      if (operation.status === 'summarizing') {
        // 摘要已完成，后续只剩落点持久化；不再对外宣称可取消摘要。
        operation.status = 'running'
        this.events.emitSnapshot(record)
      }

      if (outcome.cancelled) {
        return finalize({
          status: outcome.aborted ? 'aborted' : 'cancelled',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          ...(outcome.summaryEntry ? { summaryCommitted: true } : {}),
          message: outcome.aborted ? '分支摘要已取消，活动落点未改变' : '导航已取消',
        })
      }

      const summaryCommitted = outcome.summaryEntry !== undefined
      if (record.retired) {
        // 退休后的导航只在即将销毁的内存会话中生效，不写 sidecar。
        return finalize({
          status: 'cancelled',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          ...(summaryCommitted ? { summaryCommitted: true } : {}),
          persistence: 'skipped',
          message: '会话已关闭，导航落点未持久化',
        })
      }
      const persistence = await this.saveSessionLeaf(record, record.sessionManager.getLeafId())
      if (persistence === 'failed') {
        const restored = await this.restoreNavigationPosition(record, previousLeafId)
        if (restored) record.session.setActiveToolsByName(previousTools)
        return finalize({
          status: 'persistence-failed',
          ...(recovered ? { recoveredQueue: recovered } : {}),
          persistence: 'failed',
          recovered: restored,
          ...(summaryCommitted ? { summaryCommitted: true } : {}),
          message: restored
            ? summaryCommitted
              ? '导航落点保存失败，已恢复原上下文；分支摘要已写入 Pi 文件，无法撤销。'
              : '导航落点保存失败，已恢复原上下文。'
            : '导航落点保存失败，原上下文未能完全恢复；请检查宿主元数据状态。',
        })
      }

      return finalize({
        status: 'applied',
        ...(outcome.editorText !== undefined ? { editorText: outcome.editorText } : {}),
        ...(recovered ? { recoveredQueue: recovered } : {}),
        persistence: 'saved',
        ...(summaryCommitted ? { summaryCommitted: true } : {}),
      })
    } finally {
      // finalize 已释放；此处的幂等调用覆盖异常路径。
      this.coordinator.releaseStructure(record, operation)
    }
  }

  async setThreadEntryLabel(
    threadId: string,
    input: HarnessTreeLabelInput,
  ): Promise<HarnessTreeLabelResult> {
    this.assertActive()
    const record = await this.live.ensureOpen(threadId)
    let operation: StructureOperation
    try {
      operation = this.coordinator.beginStructure(record, 'label', { targetId: input.entryId })
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return {
        status: 'busy',
        treeRevision: sessionTreeRevision(record.sessionManager),
        message: error.message,
      }
    }

    const finalize = (result: HarnessTreeLabelResult): HarnessTreeLabelResult => {
      this.coordinator.releaseStructure(record, operation)
      return {
        ...result,
        treeRevision: sessionTreeRevision(record.sessionManager),
        ...(record.retired ? {} : { snapshot: this.events.snapshotOf(record) }),
      }
    }

    try {
      const revision = sessionTreeRevision(record.sessionManager)
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
        return finalize({ status: 'conflict', message: '会话树已变化，请刷新后重试' })
      }
      if (!record.sessionManager.getEntry(input.entryId)) {
        return finalize({ status: 'failed', message: '目标节点不存在，请刷新会话树' })
      }
      const beforeLeaf = record.sessionManager.getLeafId()
      const beforeCount = record.sessionManager.getEntryCount()
      const stored = this.deps.workspaceStore.healthy
        ? this.deps.workspaceStore.sessionLeaf(this.deps.storeId, record.threadId)
        : undefined
      const label = input.label?.trim() || undefined
      try {
        record.sessionManager.appendLabelChange(input.entryId, label)
      } catch (error) {
        return finalize({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      // 标签是书签而不是导航：恢复操作前的活动落点，避免后续发送挂到 label entry 下。
      if (record.sessionManager.getLeafId() !== beforeLeaf) {
        if (beforeLeaf === null) record.sessionManager.resetLeaf()
        else record.sessionManager.branch(beforeLeaf)
      }
      // 既有落点仍然有效时只刷新水位，使标签追加的条目不会让落点被误判为过期。
      let persistence: 'saved' | 'failed' | 'skipped' = 'skipped'
      if (
        !record.retired &&
        stored &&
        stored.leafId === beforeLeaf &&
        stored.entryCount === beforeCount
      ) {
        persistence = await this.saveSessionLeaf(record, beforeLeaf)
      }
      return finalize({
        status: 'applied',
        ...(label ? { label } : {}),
        persistence,
        ...(persistence === 'failed'
          ? { message: '标签已写入 Pi 文件，但落点水位更新失败；重启后可能不恢复该落点。' }
          : {}),
      })
    } finally {
      this.coordinator.releaseStructure(record, operation)
    }
  }

  cancelThreadTreeNavigation(threadId: string): HarnessTreeCancelResult {
    const record = this.live.get(threadId)
    const operation = record?.structure
    // 只取消仍在进行的摘要模型请求；摘要已返回、正在保存落点时不可取消。
    if (operation?.kind !== 'navigate' || !operation.summaryActive) {
      return { status: 'idle' }
    }
    operation.cancel()
    return { status: 'cancelled' }
  }

  // ---- 独立分支（fork / clone） ----

  async forkThread(
    threadId: string,
    input: HarnessThreadForkInput,
  ): Promise<HarnessThreadForkResult> {
    this.assertActive()
    /**
     * 冷打开前先记录文件中的 revision。
     *
     * SDK 在首次打开无 Thinking 记录的旧会话时会补写一条规范化条目，冷树读取
     * 得到的 revision 与随后 live record 不再相同。只用文件版 revision 兼容这个
     * 可预期的差异；若外部/其他窗口在树读取后真的追加了条目，两份 revision
     * 都会不同，仍返回 conflict。
     */
    let preOpenRevision: string | undefined
    if (!this.live.get(threadId) && input.expectedRevision !== undefined) {
      try {
        const info = await this.deps.catalog.findSessionInfo(threadId)
        if (info)
          preOpenRevision = sessionTreeRevision(this.deps.catalog.openScopedSessionManager(info))
      } catch {
        // 定位失败交给 ensureOpen 报告可读错误。
      }
    }
    const record = await this.live.ensureOpen(threadId)
    const position = input.position ?? 'before'
    let operation: StructureOperation
    try {
      operation = this.coordinator.beginStructure(
        record,
        'fork',
        input.entryId ? { targetId: input.entryId } : {},
      )
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return { status: 'busy', message: error.message }
    }

    const finalize = (result: HarnessThreadForkResult): HarnessThreadForkResult => {
      this.coordinator.releaseStructure(record, operation)
      return result
    }

    try {
      if (input.expectedRevision !== undefined) {
        const revision = sessionTreeRevision(record.sessionManager)
        if (input.expectedRevision !== revision && input.expectedRevision !== preOpenRevision) {
          return finalize({ status: 'conflict', message: '会话树已变化，请刷新后重试' })
        }
      }
      // 源会话必须空闲：运行中不静默中止父会话，交由 GUI 显式停止。
      if (
        record.session.isStreaming ||
        record.session.isCompacting ||
        record.currentRun !== undefined ||
        hasOtherInFlight(record)
      ) {
        return finalize({ status: 'busy', message: '会话正在运行，请先停止后再分叉' })
      }

      const target = resolveForkTarget(record.sessionManager, position, input.entryId)
      if (!target.ok) return finalize({ status: 'failed', message: target.message })

      // 扩展取消：只在存在可 fork 节点时发事件（空会话 clone 没有节点）。
      // 事件可能在父会话上触发延迟动作；fork 不得改变父历史，统一丢弃。
      if (target.entryId) {
        const runner = record.session.extensionRunner
        if (runner.hasHandlers('session_before_fork')) {
          try {
            const result = await runner.emit({
              type: 'session_before_fork',
              entryId: target.entryId,
              position,
            })
            if (result?.cancel === true) {
              return finalize({ status: 'cancelled', message: '扩展取消了本次分叉' })
            }
          } catch (error) {
            return finalize({ status: 'failed', message: errorText(error) })
          } finally {
            discardDeferredRuns(record.session, this.deps.diagnose)
          }
          if (record.retired) {
            return finalize({ status: 'cancelled', message: '会话已关闭，未创建分叉' })
          }
        }
      }

      const cwd = record.workspacePath
      const sessionDir = this.deps.catalog.scopeOf(cwd).dir
      // 尚未生成子文件名，先用探针路径挡住越界/符号链接。
      try {
        this.deps.catalog.assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
      } catch (error) {
        return finalize({ status: 'failed', message: errorText(error) })
      }

      let child: ReturnType<typeof createForkSessionManager>
      try {
        child = createForkSessionManager({
          sourceFile: record.session.sessionFile,
          cwd,
          sessionDir,
          targetLeafId: target.targetLeafId,
        })
      } catch (error) {
        return finalize({
          status: 'failed',
          message: error instanceof ForkSessionCreateError ? error.message : errorText(error),
        })
      }

      let childRecord: ThreadRecord | undefined
      // 已取得但尚未交给 openSession 的项目装配；用于取消/异常时收尾 MCP。
      let acquired: PreparedProject | undefined
      try {
        const project = await this.deps.assembly.acquire(cwd, this.deps.isDisposed())
        acquired = project.prepared
        // 删除/关闭可能在本操作 await 期间开始；已退役时不得再创建子文件。
        if (record.retired) throw new ForkSessionCreateError('会话已关闭，未创建分叉')
        const parentModel = record.session.model
        const empty = target.targetLeafId === null
        childRecord = await this.live.openSession(child.sessionManager, cwd, {
          // 空子会话没有历史可恢复：显式继承父会话当前模型/Thinking；
          // 非空子会话交 SDK 从分支条目恢复（不拿父当前状态覆盖分支历史）。
          isNew: empty,
          project,
          ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
          ...(empty && parentModel ? { model: parentModel } : {}),
          ...(empty ? { thinkingLevel: record.session.thinkingLevel } : {}),
          ...(record.workspaceAppliedRevision !== undefined
            ? { workspaceAppliedRevision: record.workspaceAppliedRevision }
            : {}),
          sessionStartEvent: {
            type: 'session_start',
            reason: 'fork',
            ...(record.session.sessionFile
              ? { previousSessionFile: record.session.sessionFile }
              : {}),
          },
        })
        // openSession 成功即移交 binding 所有权给子 record。
        acquired = undefined
        if (record.retired) throw new ForkSessionCreateError('会话已关闭，未创建分叉')
        // 子会话继承显式工作区归属；新 ID 没有归档标记，不继承归档。
        if (record.workspaceId) {
          await this.deps.workspaceStore.assignSession({
            storeId: this.deps.storeId,
            sessionId: childRecord.threadId,
            workspaceId: record.workspaceId,
          })
        }
      } catch (error) {
        const createdFile = childRecord?.session.sessionFile ?? child.sessionFile
        if (childRecord) await this.live.abandon(childRecord).catch(() => {})
        else if (acquired) await this.deps.assembly.closeBinding(acquired.mcp)
        if (createdFile) await unlink(createdFile).catch(() => {})
        this.deps.catalog.invalidateCatalog(cwd)
        return finalize(
          record.retired
            ? { status: 'cancelled', message: '会话已关闭，未创建分叉' }
            : { status: 'failed', message: errorText(error) },
        )
      }

      this.deps.catalog.invalidateCatalog(cwd)
      return finalize({
        status: 'created',
        threadId: childRecord.threadId,
        parentThreadId: record.threadId,
        ...(target.selectedText !== undefined ? { selectedText: target.selectedText } : {}),
        snapshot: this.events.snapshotOf(childRecord),
      })
    } catch (error) {
      return finalize({ status: 'failed', message: errorText(error) })
    } finally {
      // finalize 已释放；此处的幂等调用覆盖异常路径。
      this.coordinator.releaseStructure(record, operation)
    }
  }

  // ---- 用户 Shell / 压缩 ----

  /** 把 Pi 的 BashResult 投影为协议结果摘要。 */
  private bashResultOf(result: {
    exitCode: number | undefined
    cancelled: boolean
    truncated: boolean
    fullOutputPath?: string
  }): HarnessBashResult {
    return {
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      cancelled: result.cancelled,
      truncated: result.truncated,
      ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
      endedAt: new Date().toISOString(),
    }
  }

  /** 截断有界输出并返回被丢弃的字符数。 */
  private boundBashOutput(run: UserBashRun): number {
    if (run.output.length <= BASH_OUTPUT_MAX_CHARS) return 0
    const dropped = run.output.length - BASH_OUTPUT_MAX_CHARS
    run.output = run.output.slice(dropped)
    run.outputTruncated = true
    return dropped
  }

  /**
   * 直接执行用户 Shell（`!` / `!!`）。
   *
   * 与 CLI 同口径：先发 `user_bash` 扩展事件；扩展给出完整结果时按
   * `recordBashResult` 语义入历史，否则本地执行；扩展报错时不回退执行。
   */
  async runThreadBash(
    threadId: string,
    input: { command: string; excludeFromContext?: boolean },
  ): Promise<HarnessBashStartResult> {
    this.assertActive()
    const command = input.command
    if (!command.trim()) return { status: 'failed', message: '命令不能为空' }
    const record = await this.live.ensureOpen(threadId)
    const busy = (): HarnessBashStartResult | undefined => {
      if (record.retired) return { status: 'failed', message: '会话正在关闭，无法执行 Shell' }
      if (record.bash?.status === 'running' || record.session.isBashRunning) {
        return { status: 'busy', message: '当前会话已有一条用户 Shell 在执行，请先取消或等待完成' }
      }
      if (record.structure || record.session.isCompacting) {
        return { status: 'busy', message: '会话结构操作或压缩进行中，请稍后再执行 Shell' }
      }
      return undefined
    }
    const blocked = busy()
    if (blocked) return blocked

    const excludeFromContext = input.excludeFromContext === true
    let markDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      markDone = resolve
    })
    const run: UserBashRun = {
      id: `bash:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      command,
      excludeFromContext,
      cwd: record.workspacePath,
      status: 'running',
      output: '',
      outputTruncated: false,
      startedAt: new Date().toISOString(),
      cancelRequested: false,
      controller: new AbortController(),
      recorded: false,
      done,
    }
    record.bash = run
    this.events.emit(record, { type: 'bash_start', run: bashViewOf(run) })

    const onChunk = (chunk: string): void => {
      if (record.bash !== run) return
      run.output += chunk
      const dropped = this.boundBashOutput(run)
      this.events.emit(record, { type: 'bash_output', id: run.id, delta: chunk, dropped })
    }

    // 后台执行：RPC 返回 started 即「已登记」，不等待命令结束。
    void (async () => {
      let result: HarnessBashResult
      try {
        // 先发布运行态再等待扩展：启动 HTTP 不阻塞于交互，取消可覆盖钩子窗口。
        const extensionResult = await record.session.extensionRunner.emitUserBash({
          type: 'user_bash',
          command,
          excludeFromContext,
          cwd: record.workspacePath,
        })
        if (run.cancelRequested || record.retired || this.deps.isDisposed()) {
          result = {
            cancelled: true,
            truncated: false,
            endedAt: new Date().toISOString(),
          }
        } else if (extensionResult?.result) {
          const custom = extensionResult.result
          record.session.recordBashResult(command, custom, { excludeFromContext })
          run.recorded = true
          result = this.bashResultOf(custom)
          run.output = custom.output
          run.outputTruncated = false
        } else {
          const sdkResult = await executeColoredBash(command, record.workspacePath, {
            signal: run.controller.signal,
            onChunk,
            shellPath: record.settingsManager.getShellPath(),
            commandPrefix: record.settingsManager.getShellCommandPrefix(),
            ...(extensionResult?.operations ? { operations: extensionResult.operations } : {}),
          })
          record.session.recordBashResult(command, sdkResult, { excludeFromContext })
          run.recorded = true
          result = this.bashResultOf(sdkResult)
          // 完成态以SDK累积器的截断后输出为准，同时消除实时缓冲差异。
          run.output = sdkResult.output
          run.outputTruncated = false
        }
      } catch (error) {
        result = {
          cancelled: false,
          truncated: false,
          endedAt: new Date().toISOString(),
          error: errorText(error),
        }
      }
      this.boundBashOutput(run)
      run.status = 'complete'
      run.result = result
      if (record.bash === run) {
        this.events.emit(record, { type: 'bash_end', run: bashViewOf(run) })
        // 历史消息在运行中会被 SDK 缓冲到结算后落盘；快照保留完成卡直到那时。
        this.events.emitSnapshot(record)
      }
      markDone()
    })()

    return { status: 'started', run: bashViewOf(run) }
  }

  /** 取消当前用户 Shell（不影响模型运行）。 */
  abortThreadBash(threadId: string): HarnessBashAbortResult {
    const record = this.live.get(threadId)
    if (record?.bash?.status !== 'running') return { status: 'idle' }
    record.bash.cancelRequested = true
    record.bash.controller.abort()
    record.session.abortBash()
    record.uiBridge.dismissAll()
    return { status: 'requested' }
  }

  /**
   * 手动压缩。必须在任何 await 之前占用结构闸门：压缩期间发送/导航/分叉
   * 一律明确 busy，不越过正在改写的上下文。
   */
  async compactThread(
    threadId: string,
    input?: { customInstructions?: string },
  ): Promise<HarnessCompactionOutcome> {
    this.assertActive()
    const record = await this.live.ensureOpen(threadId)
    let operation: StructureOperation
    try {
      operation = this.coordinator.beginStructure(record, 'compact')
    } catch (error) {
      if (error instanceof ThreadStructureBusyError) {
        return { status: 'busy', message: error.message }
      }
      throw error
    }
    try {
      const customInstructions = input?.customInstructions?.trim()
      const result = await record.session.compact(
        customInstructions ? customInstructions : undefined,
      )
      return {
        status: 'compacted',
        ...(result.tokensBefore !== undefined ? { tokensBefore: result.tokensBefore } : {}),
        ...(result.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: result.estimatedTokensAfter }
          : {}),
      }
    } catch (error) {
      if (record.lastCompactionAborted) {
        return { status: 'cancelled', message: '压缩已取消，原始消息树保持不变' }
      }
      // 优先使用 SDK compaction_end 的错误文案（含 "Compaction failed" 前缀），
      // 其次是 compact() 抛出的原始错误。
      return { status: 'failed', message: record.lastCompactionError ?? errorText(error) }
    } finally {
      this.coordinator.releaseStructure(record, operation)
    }
  }

  abortThreadCompaction(threadId: string): HarnessCompactionAbortResult {
    const record = this.live.get(threadId)
    if (!record?.session.isCompacting) return { status: 'idle' }
    record.session.abortCompaction()
    return { status: 'requested' }
  }

  // ---- 模型 / Thinking / 命名 ----

  async setModel(threadId: string, input: { provider: string; modelId: string }): Promise<void> {
    const record = await this.live.ensureOpen(threadId)
    const model = this.deps.modelRuntime.getModel(input.provider, input.modelId)
    if (!model) throw new Error(`${input.provider}/${input.modelId} is not in Pi's model registry`)
    // 显式主动切换按当前候选校验；旧会话读取与发送不经过这里。
    const scope = await this.deps.resolveModelScope(record.workspaceId)
    if (scope.patterns.length > 0) {
      if (scope.scopedModels.length === 0) {
        throw new Error('当前模型范围没有可用模型，请调整模型范围或先刷新模型目录。')
      }
      if (
        !scope.scopedModels.some(
          (item) => item.model.provider === input.provider && item.model.id === input.modelId,
        )
      ) {
        throw new Error(`${input.provider}/${input.modelId} 不在当前模型范围内，请选择其他模型。`)
      }
    }
    const operation = this.coordinator.beginStructure(record, 'model')
    try {
      await record.session.setModel(model)
      record.lastError = undefined
    } finally {
      this.coordinator.releaseStructure(record, operation)
    }
  }

  async setThinkingLevel(threadId: string, level: HarnessThinkingLevel): Promise<void> {
    const record = await this.live.ensureOpen(threadId)
    const operation = this.coordinator.beginStructure(record, 'thinking')
    try {
      await record.session.setThinkingLevel(level)
    } finally {
      this.coordinator.releaseStructure(record, operation)
    }
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const record = this.live.get(threadId)
    if (record) {
      // 重命名只追加 session_info（不改变上下文），允许在运行中执行；
      // 仍占用结构闸门，与导航/标签/模型切换互斥。
      const operation = this.coordinator.beginStructure(record, 'rename', { allowRunning: true })
      try {
        record.session.setSessionName(title)
        this.deps.catalog.invalidateCatalog(record.workspacePath)
      } finally {
        this.coordinator.releaseStructure(record, operation)
      }
      return
    }
    // 冷会话重命名不装配项目扩展；用进程内标记与打开/导航互斥，
    // 并在发现已出现 live record 时拒绝，避免两个管理器同时改同一文件。
    if (this.live.coldStructure.has(threadId) || this.live.hasPendingOpen(threadId)) {
      throw new ThreadStructureBusyError()
    }
    this.live.coldStructure.add(threadId)
    try {
      const live = this.live.get(threadId)
      if (live) {
        const operation = this.coordinator.beginStructure(live, 'rename', { allowRunning: true })
        try {
          live.session.setSessionName(title)
          this.deps.catalog.invalidateCatalog(live.workspacePath)
        } finally {
          this.coordinator.releaseStructure(live, operation)
        }
        return
      }
      const info = await this.deps.catalog.findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      const scope = this.deps.catalog.assertSessionFileInScope(info.path, info.cwd)
      SessionManager.open(info.path, scope.dir).appendSessionInfo(title)
      this.deps.catalog.invalidateCatalog(info.cwd || this.deps.workspacePath)
    } finally {
      this.live.coldStructure.delete(threadId)
    }
  }
}

function bashViewOf(run: UserBashRun): import('@huan/protocol').HarnessBashRun {
  return {
    id: run.id,
    command: run.command,
    excludeFromContext: run.excludeFromContext,
    cwd: run.cwd,
    status: run.status,
    output: run.output,
    outputTruncated: run.outputTruncated,
    startedAt: run.startedAt,
    ...(run.result ? { result: run.result } : {}),
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)
