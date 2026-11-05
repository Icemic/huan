/**
 * 会话事件与快照投影：seq/快照、Host UI、活动工具与运行事件归约。
 *
 * record 持有数据；本模块只经固定输入更新/投影，不另存记录、重放日志或第二
 * 份 currentRun。运行归属/结算状态由 operation-coordinator 唯一写入。
 */

import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type {
  HarnessAgentMessage,
  HarnessBashRun,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessCompactionPhase,
  HarnessHostUiCommandTarget,
  HarnessHostUiNotification,
  HarnessHostUiRequest,
  HarnessHostUiWidgetPlacement,
  HarnessThreadHostUi,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTreeOperation,
} from '@huan/protocol'
import { mapSessionEvent } from '../event-mapping.js'
import type { HostInteractions } from '../host-interactions.js'
import type { HostUiBridge } from '../host-ui.js'
import { createHostUiBridge } from '../host-ui.js'
import { mapQueuedMessages, normalizeTitle, projectSessionRecord } from '../metadata.js'
import { getModelReadiness } from '../model-catalog.js'
import {
  latestRunMetricsFromBranch,
  persistRunMetrics,
  type RunMetricsFinalStatus,
} from '../run-metrics.js'
import { sessionTreeRevision } from '../session-tree.js'
import type { WorkspaceStore } from '../workspace-store.js'
import { jsonSafeEventBody, jsonSafeSnapshot } from './json-safe.js'
import type { SharedModelRuntime } from './model-service.js'
import type { OperationCoordinator } from './operation-coordinator.js'
import { callerContext, type ThreadRecord, type UserBashRun } from './shared.js'

type SessionEvent = Parameters<Parameters<AgentSession['subscribe']>[0]>[0]

export type SessionEventsDeps = {
  modelRuntime: SharedModelRuntime
  /** 共享模型目录代数（元数据失效键）。 */
  modelCatalogRevision: () => number
  workspaceStore: WorkspaceStore
  storeId: string
  /** 目录缓存失效（首条消息/改名的可发现性）。 */
  invalidateCatalog: (cwd: string) => void
  coordinator: OperationCoordinator
  interactions: HostInteractions
}

/** 每会话扩展 UI 空状态。 */
export const createHostUiState = (): ThreadRecord['hostUi'] => ({
  statuses: new Map(),
  widgets: new Map(),
  notifications: [],
  notificationCounter: 0,
  unsupportedReported: new Set(),
  title: undefined,
  workingMessage: undefined,
  workingVisible: undefined,
  hiddenThinkingLabel: undefined,
  editorDirective: undefined,
  commandTarget: undefined,
})

const isolateMessages = (messages: readonly unknown[]): HarnessAgentMessage[] =>
  messages.map((message) => ({ ...(message as object) })) as HarnessAgentMessage[]

/**
 * 把权威消息映射到来源 entryId。
 *
 * 只使用公开 `buildSessionProjection()` 的 sourceEntry 对应关系，再按对象
 * 身份对齐实时 `session.messages`；转换型消息按 SDK 投影顺序回退。两者都
 * 来自 sourceEntry，不使用时间戳或 transcript 下标；尚未落盘的尾消息为 null。
 */
export const messageEntryIds = (
  sessionManager: ThreadRecord['sessionManager'],
  messages: readonly unknown[],
): (string | null)[] => {
  const projection = sessionManager.buildSessionProjection()
  const byMessage = new Map<unknown, string>()
  const projected: string[] = []
  for (const entry of projection.entries) {
    for (const message of entry.messages) {
      byMessage.set(message, entry.sourceEntry.id)
      projected.push(entry.sourceEntry.id)
    }
  }
  // 身份匹配优先；转换型条目（custom_message/摘要等）每次投影会生成新对象，
  // 因此按 SDK 投影顺序回退（sourceEntry 顺序，不是 transcript 下标）。
  return messages.map((message, index) => byMessage.get(message) ?? projected[index] ?? null)
}

/** 把宿主内部的 Shell 运行态投影为 JSON-safe 协议形状（不含 done/执行器）。 */
export const bashViewOf = (run: UserBashRun): HarnessBashRun => ({
  id: run.id,
  command: run.command,
  excludeFromContext: run.excludeFromContext,
  cwd: run.cwd,
  status: run.status,
  output: run.output,
  outputTruncated: run.outputTruncated,
  startedAt: run.startedAt,
  ...(run.result ? { result: run.result } : {}),
})

const compactionPhaseOf = (
  record: ThreadRecord,
  messageEntryIds: readonly (string | null)[],
): HarnessCompactionPhase => {
  const persisted = coldCompactionPhaseOf(
    record.sessionManager,
    record.session.messages.length,
    messageEntryIds,
  )
  const candidate = record.lastCompaction
  const leafId = record.sessionManager.getLeafId()
  const latest =
    candidate &&
    (candidate.status === 'running' ||
      (candidate.entryId
        ? persisted?.entryId === candidate.entryId
        : candidate.leafId === leafId ||
          record.sessionManager.getBranch().some((entry) => entry.id === candidate.leafId)))
      ? candidate
      : undefined
  if (record.session.isCompacting) {
    return {
      active: true,
      ...(record.compactionReason ? { reason: record.compactionReason } : {}),
      ...(latest?.operationId ? { operationId: latest.operationId } : {}),
      ...(latest ? { messageIndex: latest.messageIndex } : {}),
      ...(persisted?.summary ? { summary: persisted.summary } : {}),
    }
  }
  if (latest) {
    if (latest.status === 'compacted') {
      return {
        active: false,
        operationId: latest.operationId,
        reason: latest.reason,
        status: 'compacted',
        ...(persisted?.summary ? { summary: persisted.summary } : {}),
        ...(latest.entryId ? { entryId: latest.entryId } : {}),
        ...(latest.entryId
          ? { messageIndex: compactionMessageIndex(record, latest.entryId, messageEntryIds) }
          : {}),
        ...(latest.tokensBefore !== undefined ? { tokensBefore: latest.tokensBefore } : {}),
        ...(latest.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: latest.estimatedTokensAfter }
          : {}),
      }
    }
    return {
      active: false,
      operationId: latest.operationId,
      reason: latest.reason,
      status: latest.status === 'cancelled' ? 'cancelled' : 'failed',
      ...(persisted?.summary ? { summary: persisted.summary } : {}),
      ...(latest.messageIndex !== undefined ? { messageIndex: latest.messageIndex } : {}),
      ...(latest.tokensBefore !== undefined ? { tokensBefore: latest.tokensBefore } : {}),
      ...(latest.estimatedTokensAfter !== undefined
        ? { estimatedTokensAfter: latest.estimatedTokensAfter }
        : {}),
      ...(latest.error ? { error: latest.error } : {}),
    }
  }
  // 成功是唯一持久事实：冷打开/重启后从当前分支的最新 compaction entry 重建。
  if (persisted) return persisted
  return {
    active: false,
    ...(record.lastCompactionError ? { error: record.lastCompactionError } : {}),
  }
}

/** 当前活动分支最后一条压缩 entry；用于冷历史重建成功状态。 */
const latestCompactionEntryFrom = (sessionManager: ThreadRecord['sessionManager']) => {
  const branch = sessionManager.getBranch()
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (entry?.type === 'compaction') return entry
  }
  return undefined
}

const latestCompactionEntry = (record: ThreadRecord) =>
  latestCompactionEntryFrom(record.sessionManager)

/**
 * 结果行在消息中的锚点：压缩 entry 之后的消息才是后续回复。
 * 模型投影把摘要放到开头，不能用投影下标；按 branch 顺序找出第一条未来消息。
 */
const compactionMessageIndexFrom = (
  sessionManager: ThreadRecord['sessionManager'],
  messageCount: number,
  entryId: string,
  messageEntryIds: readonly (string | null)[],
): number => {
  const branch = sessionManager.getBranch()
  const entryIndex = branch.findIndex((entry) => entry.id === entryId)
  if (entryIndex < 0) return messageCount
  const futureIds = new Set(branch.slice(entryIndex + 1).map((entry) => entry.id))
  const index = messageEntryIds.findIndex(
    (id) => id === null || (id !== undefined && futureIds.has(id)),
  )
  return index >= 0 ? index : messageCount
}

const compactionMessageIndex = (
  record: ThreadRecord,
  entryId: string,
  messageEntryIds: readonly (string | null)[],
): number =>
  compactionMessageIndexFrom(
    record.sessionManager,
    record.session.messages.length,
    entryId,
    messageEntryIds,
  )

/** 冷读快照的成功状态：只从 Pi 投影 entry 重建，不伪造失败/取消记录。 */
export const coldCompactionPhaseOf = (
  sessionManager: ThreadRecord['sessionManager'],
  messageCount: number,
  messageEntryIds: readonly (string | null)[],
): HarnessCompactionPhase | undefined => {
  const entry = latestCompactionEntryFrom(sessionManager)
  if (!entry) return undefined
  return {
    active: false,
    operationId: `compaction:entry:${entry.id}`,
    status: 'compacted',
    entryId: entry.id,
    summary: {
      entryId: entry.id,
      messageIndex: compactionMessageIndexFrom(
        sessionManager,
        messageCount,
        entry.id,
        messageEntryIds,
      ),
    },
    messageIndex: compactionMessageIndexFrom(
      sessionManager,
      messageCount,
      entry.id,
      messageEntryIds,
    ),
    ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
  }
}

const compactionOperationIdOf = (record: ThreadRecord): string => `compaction:${record.seq + 1}`

export class SessionEvents {
  /** key = `<threadId>\0<callerId>`；仅驻留内存，不进入会话记录。 */
  private readonly editorMirrors = new Map<string, string>()

  constructor(private readonly deps: SessionEventsDeps) {}

  private editorMirrorKey(threadId: string, callerId: string): string {
    return `${threadId}\u0000${callerId}`
  }

  forgetEditorMirrors(threadId: string): void {
    const prefix = `${threadId}\u0000`
    for (const key of [...this.editorMirrors.keys()]) {
      if (key.startsWith(prefix)) this.editorMirrors.delete(key)
    }
  }

  clearEditorMirrors(): void {
    this.editorMirrors.clear()
  }

  callerDraftOf(threadId: string): string {
    const callerId = callerContext.getStore()
    if (!callerId) return ''
    return this.editorMirrors.get(this.editorMirrorKey(threadId, callerId)) ?? ''
  }

  rememberCallerDraft(threadId: string, callerId: string, text: string): void {
    this.editorMirrors.set(this.editorMirrorKey(threadId, callerId), text)
  }

  // ---- 状态推导（热/冷共用口径） ----

  workspaceFields(
    workspaceId: string | undefined,
    appliedRevision?: number,
  ): Pick<HarnessThreadMetadata, 'workspaceId' | 'workspaceRevision' | 'workspaceAppliedRevision'> {
    if (!workspaceId) return {}
    const workspace = this.deps.workspaceStore.workspace(workspaceId)
    if (!workspace) return {}
    return {
      workspaceId,
      workspaceRevision: workspace.revision,
      ...(appliedRevision !== undefined ? { workspaceAppliedRevision: appliedRevision } : {}),
    }
  }

  sessionWorkspaceFields(
    threadId: string,
    appliedRevision?: number,
  ): ReturnType<SessionEvents['workspaceFields']> {
    return this.workspaceFields(
      this.deps.workspaceStore.sessionWorkspace(this.deps.storeId, threadId),
      appliedRevision,
    )
  }

  metadataOf(record: ThreadRecord): HarnessThreadMetadata {
    const session = record.session
    const model = session.model
    const usage = session.getContextUsage()
    const queued = mapQueuedMessages(session.getSteeringMessages(), session.getFollowUpMessages())
    // 一次全文件投影同时供标题、时间与血缘使用；逐 token 事件不经过本方法。
    const projection = projectSessionRecord({
      header: record.sessionManager.getHeader(),
      entries: record.sessionManager.getEntries(),
    })
    const explicitName = session.sessionName?.trim()
    const firstMessageText = projection.firstUserMessageText
    const title = normalizeTitle({
      explicitName,
      firstMessageText,
      sessionFilePath: session.sessionFile,
    })
    const treeOperation = this.treeOperationView(record)
    const activeRunMetrics = record.runMetrics.current()
    const runMetrics =
      activeRunMetrics?.status === 'running'
        ? activeRunMetrics
        : latestRunMetricsFromBranch(record.sessionManager)
    return {
      id: record.threadId,
      status: this.deps.coordinator.runStatus(record),
      compactionActive: session.isCompacting,
      ...(session.isCompacting && record.compactionReason
        ? { compactionReason: record.compactionReason }
        : {}),
      autoCompactionEnabled: record.settingsManager.getCompactionEnabled(),
      modelCatalogRevision: this.deps.modelCatalogRevision(),
      ...(model?.input ? { modelInput: [...model.input] } : {}),
      retryActive: session.isRetrying,
      retryAttempt: session.retryAttempt,
      workspacePath: record.workspacePath,
      // 与冷读目录同一口径；列表不得再用旧扫描结果覆盖。
      ...(projection.createdAt ? { createdAt: projection.createdAt } : {}),
      ...(projection.updatedAt ? { updatedAt: projection.updatedAt } : {}),
      ...(projection.parentSessionPath ? { parentSessionPath: projection.parentSessionPath } : {}),
      ...this.workspaceFields(record.workspaceId, record.workspaceAppliedRevision),
      messageCount: session.messages.length,
      leafId: record.sessionManager.getLeafId(),
      treeRevision: sessionTreeRevision(record.sessionManager),
      ...(treeOperation ? { treeOperation } : {}),
      // 标题口径与冷读路径一致：显式会话名 > 首条用户消息（截断）> 会话文件名。
      // 注意：仅「显式命名」会持久化；未命名会话重启后由冷路径推导同一标题。
      ...(title ? { title } : {}),
      // 命名状态与首条消息独立暴露：与冷读路径同为全文件口径。
      ...(explicitName ? { name: explicitName } : {}),
      ...(firstMessageText ? { firstMessageText } : {}),
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      ...(model
        ? {
            config: {
              provider: model.provider,
              modelId: model.id,
              thinkingLevel: session.thinkingLevel,
            },
          }
        : { config: { thinkingLevel: session.thinkingLevel } }),
      ...(usage ? { contextUsage: usage } : {}),
      ...(runMetrics ? { runMetrics } : {}),
      ...(this.deps.workspaceStore.sessionArchived(this.deps.storeId, record.threadId)
        ? { archived: true }
        : {}),
      ...(queued.length ? { queuedMessages: queued } : {}),
      ...(record.modelFallback ? { modelFallback: record.modelFallback } : {}),
      resourceRevision: record.resourceRevision,
      ...(record.reload ? { reload: { ...record.reload } } : {}),
    }
  }

  /** 结构操作在快照中的可见部分（仅导航/标签需要跨窗提示）。 */
  treeOperationView(record: ThreadRecord): HarnessThreadTreeOperation | undefined {
    const operation = record.structure
    if (!operation) return undefined
    if (operation.kind !== 'navigate' && operation.kind !== 'label') return undefined
    return {
      kind: operation.kind,
      status: operation.status,
      ...(operation.targetId ? { targetId: operation.targetId } : {}),
      startedAt: operation.startedAt,
    }
  }

  /**
   * Shell 完成且已持久化为 bashExecution 消息后，释放运行态。
   *
   * `recordBashResult` 在运行中会把消息缓冲到运行结算后才落盘，因此完成卡
   * 需要保留到消息真正出现，然后由快照取代，避免重复展示或空洞。
   */
  private releasePersistedBash(record: ThreadRecord): void {
    const run = record.bash
    if (run?.status === 'complete' && run.recorded && !record.session.hasPendingBashMessages) {
      record.bash = undefined
    }
  }

  // ---- Host UI ----

  /** 每次状态变化广播权威快照；断开重连即以快照补齐。 */
  emitHostUiSnapshot(record: ThreadRecord): void {
    if (record.retired) return
    this.emit(record, { type: 'host_ui_update', hostUi: this.hostUiViewOf(record) })
  }

  notifyHostUi(
    record: ThreadRecord,
    message: string,
    type: HarnessHostUiNotification['type'],
  ): void {
    record.hostUi.notificationCounter += 1
    record.hostUi.notifications = [
      ...record.hostUi.notifications,
      {
        id: `${record.threadId}:notify:${record.hostUi.notificationCounter}`,
        message,
        type,
        createdAt: Date.now(),
      },
    ].slice(-20)
    this.emitHostUiSnapshot(record)
  }

  setHostUiStatus(record: ThreadRecord, key: string, text: string | undefined): void {
    const current = record.hostUi.statuses.get(key)
    if (text === undefined) {
      if (current === undefined) return
      record.hostUi.statuses.delete(key)
    } else {
      if (current === text) return
      record.hostUi.statuses.set(key, text)
    }
    this.emitHostUiSnapshot(record)
  }

  setHostUiWidget(
    record: ThreadRecord,
    key: string,
    lines: string[] | undefined,
    placement: HarnessHostUiWidgetPlacement,
  ): void {
    const current = record.hostUi.widgets.get(key)
    if (lines === undefined) {
      if (!current) return
      record.hostUi.widgets.delete(key)
    } else {
      if (
        current &&
        current.placement === placement &&
        current.lines.length === lines.length &&
        current.lines.every((line, index) => line === lines[index])
      ) {
        return
      }
      record.hostUi.widgets.set(key, { lines: [...lines], placement })
    }
    this.emitHostUiSnapshot(record)
  }

  setHostUiTitle(record: ThreadRecord, title: string): void {
    if (record.hostUi.title === title) return
    // 扩展标题只作为提示，不改 Pi 会话名称，也不改 document.title。
    record.hostUi.title = title
    this.emitHostUiSnapshot(record)
  }

  setHostUiWorkingMessage(record: ThreadRecord, message: string | undefined): void {
    if (record.hostUi.workingMessage === message) return
    record.hostUi.workingMessage = message
    this.emitHostUiSnapshot(record)
  }

  setHostUiWorkingVisible(record: ThreadRecord, visible: boolean): void {
    if (record.hostUi.workingVisible === visible) return
    record.hostUi.workingVisible = visible
    this.emitHostUiSnapshot(record)
  }

  setHostUiHiddenThinkingLabel(record: ThreadRecord, label: string | undefined): void {
    if (record.hostUi.hiddenThinkingLabel === label) return
    record.hostUi.hiddenThinkingLabel = label
    this.emitHostUiSnapshot(record)
  }

  /** 终端专属能力：记录可见的不支持说明，不执行扩展传入的工厂。 */
  reportUnsupportedHostUi(record: ThreadRecord, method: string): void {
    if (record.hostUi.unsupportedReported.has(method)) return
    record.hostUi.unsupportedReported.add(method)
    this.notifyHostUi(record, `扩展 UI 能力 ${method} 在 GUI 宿主中不支持，已跳过。`, 'warning')
  }

  /**
   * 扩展写输入框。
   *
   * 有调用方窗口时标记定向；无调用方（后台扩展）时保留 callerId 缺失，
   * 由任一窗口主动接受。同时更新调用方镜像，供同一命令链的 getEditorText。
   */
  writeHostUiEditor(record: ThreadRecord, text: string, mode: 'set' | 'paste'): void {
    const callerId = callerContext.getStore()
    if (callerId) {
      const key = this.editorMirrorKey(record.threadId, callerId)
      const current = this.editorMirrors.get(key) ?? ''
      // paste 没有光标位置信息；镜像按末尾追加以保持同步可读。
      this.editorMirrors.set(key, mode === 'paste' ? `${current}${text}` : text)
    }
    const previous = record.hostUi.editorDirective
    const mergePaste = mode === 'paste' && previous !== undefined && previous.callerId === callerId
    record.hostUi.notificationCounter += 1
    record.hostUi.editorDirective = {
      id: `${record.threadId}:editor:${record.hostUi.notificationCounter}`,
      text: mergePaste ? `${previous.text}${text}` : text,
      mode: mergePaste ? previous.mode : mode,
      ...(callerId ? { callerId } : {}),
      createdAt: Date.now(),
    }
    this.emitHostUiSnapshot(record)
  }

  setHostUiCommandTarget(
    record: ThreadRecord,
    action: HarnessHostUiCommandTarget['action'],
    threadId: string,
    message: string,
    title?: string,
    editorText?: string,
  ): void {
    const callerId = callerContext.getStore()
    record.hostUi.notificationCounter += 1
    record.hostUi.commandTarget = {
      id: `${record.threadId}:target:${record.hostUi.notificationCounter}`,
      action,
      threadId,
      ...(title ? { title } : {}),
      ...(callerId ? { callerId } : {}),
      ...(editorText !== undefined ? { editorText } : {}),
      message,
      createdAt: Date.now(),
    }
    this.emitHostUiSnapshot(record)
  }

  /** 投影为协议形状；全空时返回 undefined，避免每个快照携带空对象。 */
  hostUiViewOf(record: ThreadRecord): HarnessThreadHostUi | undefined {
    const ui = record.hostUi
    const statuses = [...ui.statuses.entries()].map(([key, text]) => ({ key, text }))
    const widgets = [...ui.widgets.entries()].map(([key, value]) => ({ key, ...value }))
    if (
      statuses.length === 0 &&
      widgets.length === 0 &&
      ui.notifications.length === 0 &&
      ui.title === undefined &&
      ui.workingMessage === undefined &&
      ui.workingVisible === undefined &&
      ui.hiddenThinkingLabel === undefined &&
      !ui.editorDirective &&
      !ui.commandTarget
    ) {
      return undefined
    }
    return structuredClone({
      statuses,
      widgets,
      notifications: ui.notifications,
      ...(ui.title !== undefined ? { title: ui.title } : {}),
      ...(ui.workingMessage !== undefined ? { workingMessage: ui.workingMessage } : {}),
      ...(ui.workingVisible !== undefined ? { workingVisible: ui.workingVisible } : {}),
      ...(ui.hiddenThinkingLabel !== undefined
        ? { hiddenThinkingLabel: ui.hiddenThinkingLabel }
        : {}),
      ...(ui.editorDirective ? { editorDirective: ui.editorDirective } : {}),
      ...(ui.commandTarget ? { commandTarget: ui.commandTarget } : {}),
    })
  }

  snapshotOf(record: ThreadRecord): HarnessThreadSnapshot {
    // 已持久化的 Shell 结果不再以运行态重复出现。
    this.releasePersistedBash(record)
    const pending = record.uiBridge.pending()
    const hostUi = this.hostUiViewOf(record)
    const activeTools = [...record.activeTools.values()]
    const messages = isolateMessages(record.session.messages)
    const entryIds = messageEntryIds(record.sessionManager, record.session.messages)
    return jsonSafeSnapshot({
      metadata: this.metadataOf(record),
      messages,
      messageEntryIds: entryIds,
      ...(activeTools.length ? { toolExecutions: activeTools } : {}),
      ...(record.bash ? { bash: bashViewOf(record.bash) } : {}),
      compaction: compactionPhaseOf(record, entryIds),
      readiness: getModelReadiness(
        this.deps.modelRuntime,
        record.session.model
          ? {
              provider: record.session.model.provider,
              modelId: record.session.model.id,
            }
          : undefined,
        'session',
      ),
      seq: record.seq,
      ...(pending.length ? { hostUiRequests: pending } : {}),
      ...(hostUi ? { hostUi } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
    })
  }

  // ---- 事件投递 ----

  emit(record: ThreadRecord, body: HarnessClientEventBody): void {
    record.seq += 1
    const event = {
      ...jsonSafeEventBody(body),
      threadId: record.threadId,
      seq: record.seq,
    } as HarnessClientEvent
    for (const listener of [...record.listeners]) {
      try {
        listener(event)
      } catch {
        // 单个订阅者抛错不影响其他订阅者。
      }
    }
  }

  emitSnapshot(record: ThreadRecord): void {
    if (record.retired) return
    this.emit(record, { type: 'snapshot', snapshot: this.snapshotOf(record) })
  }

  emitContextUsage(record: ThreadRecord): void {
    const usage = record.session.getContextUsage()
    if (usage) this.emit(record, { type: 'context_usage', contextUsage: usage })
  }

  /** 会话事件入口：活动工具、压缩、运行归属、协议映射与结算快照。 */
  onSessionEvent(record: ThreadRecord, event: SessionEvent): void {
    const runBeforeSettle = event.type === 'agent_settled' ? record.currentRun : undefined
    if (event.type === 'agent_start') {
      // 新一轮重置统计；agent_end 之后的自动重试仍属于同一轮。
      const runMetrics = record.runMetrics.begin()
      this.emit(record, { type: 'run_metrics', runMetrics })
      record.runMetrics.publish((metrics) =>
        this.emit(record, { type: 'run_metrics', runMetrics: metrics }),
      )
    }
    if (event.type === 'message_update') {
      record.runMetrics.observeDelta(event.assistantMessageEvent)
      record.runMetrics.observePartial(event.message)
    }
    if (event.type === 'message_end') {
      record.runMetrics.observeMessage(event.message)
    }
    if (event.type === 'turn_start') record.turnIndex += 1
    // 压缩运行态：开始建立操作标识，结束更新同一标识的结局；成功关联 Pi entry。
    if (event.type === 'compaction_start') {
      record.compactionReason = event.reason
      record.lastCompactionAborted = false
      record.lastCompactionError = undefined
      record.lastCompaction = {
        operationId: compactionOperationIdOf(record),
        status: 'running',
        reason: event.reason,
        messageIndex: record.session.messages.length,
        leafId: record.sessionManager.getLeafId(),
      }
    }
    if (event.type === 'compaction_end') {
      const previous = record.lastCompaction
      const entry =
        !event.aborted && !event.errorMessage ? latestCompactionEntry(record) : undefined
      record.lastCompactionAborted = event.aborted
      // 取消不算失败；成功会自然清空为 undefined。
      record.lastCompactionError = event.aborted ? undefined : event.errorMessage
      record.lastCompaction = {
        operationId:
          previous?.status === 'running' ? previous.operationId : compactionOperationIdOf(record),
        status: event.aborted ? 'cancelled' : event.errorMessage ? 'failed' : 'compacted',
        reason: event.reason,
        leafId: previous?.leafId ?? record.sessionManager.getLeafId(),
        messageIndex:
          previous?.status === 'running' ? previous.messageIndex : record.session.messages.length,
        ...(entry ? { entryId: entry.id } : {}),
        ...(event.result?.tokensBefore !== undefined
          ? { tokensBefore: event.result.tokensBefore }
          : {}),
        ...(event.result?.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: event.result.estimatedTokensAfter }
          : {}),
        ...(event.errorMessage ? { error: event.errorMessage } : {}),
      }
      record.compactionReason = undefined
    }
    if (event.type === 'session_info_changed') this.deps.invalidateCatalog(record.workspacePath)
    // 新会话的 JSONL 直到首条用户消息才真正落盘；空会话创建后列表缓存可能
    // 仍是旧结果。首条用户消息开始时清一次目录缓存，让后续列表看到文件与标题。
    if (event.type === 'message_start' && event.message.role === 'user') {
      this.deps.invalidateCatalog(record.workspacePath)
    }

    // 活动工具仅保留运行中的瞬态状态；结束后立即移除，避免形成第二份日志。
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

    const settledError = this.deps.coordinator.handleRunEvent(record, event)
    if (event.type === 'agent_settled') {
      // 只在本轮真正结算时冻结耗时；取消/失败保留已报告用量。
      const status: RunMetricsFinalStatus =
        runBeforeSettle?.cancelled || event.aborted
          ? 'cancelled'
          : runBeforeSettle?.pendingError !== undefined
            ? 'failed'
            : 'completed'
      const runMetrics = record.runMetrics.settle(status)
      if (runMetrics) {
        // 独立统计文件关联当前节点，不改变Pi压缩边界。
        persistRunMetrics(record.sessionManager, runMetrics)
        this.emit(record, { type: 'run_metrics', runMetrics })
      }
    }
    // 结算后不存在活动工具；防止取消路径缺少 tool_execution_end 时残留。
    if (event.type === 'agent_settled') record.activeTools.clear()

    const mapped = mapSessionEvent(event, {
      turnIndex: record.turnIndex,
      ...(record.lastCompaction?.operationId
        ? { compactionOperationId: record.lastCompaction.operationId }
        : {}),
    })
    if (mapped.kind === 'mapped') this.emit(record, mapped.event)
    if (settledError !== undefined) this.emit(record, { type: 'error', error: settledError })
    // 运行结算/压缩完成时补权威来源映射与树版本，不在每个 token 聚合整树。
    if (event.type === 'agent_settled' || event.type === 'compaction_end') {
      this.emitSnapshot(record)
    }

    if (
      event.type === 'turn_end' ||
      event.type === 'agent_end' ||
      event.type === 'compaction_end'
    ) {
      this.emitContextUsage(record)
    }
  }

  /**
   * 清空旧运行时的扩展 UI 状态与定向指令。
   *
   * 旧 ExtensionRunner 在 reload 中会被 invalidate，status/widget/标题/编辑器
   * 指令都不再有人负责清理；留着会让页面展示已失效扩展的残留状态，甚至把
   * 旧指令应用到新运行时的输入框。通知是历史信息，保留。
   */
  resetHostUiForReload(record: ThreadRecord): void {
    const ui = record.hostUi
    ui.statuses.clear()
    ui.widgets.clear()
    ui.title = undefined
    ui.workingMessage = undefined
    ui.workingVisible = undefined
    ui.hiddenThinkingLabel = undefined
    ui.editorDirective = undefined
    ui.commandTarget = undefined
    this.emitHostUiSnapshot(record)
  }

  /**
   * 创建会话的 Host UI bridge：定向编辑器、通知与启动期交互。
   *
   * bridge 只借用 record 与宿主交互通道；不拥有 record 或会话。
   */
  createUiBridge(
    record: ThreadRecord,
    startupScope: import('@huan/protocol').HarnessHostInteractionScope,
    signal: AbortSignal | undefined,
  ): HostUiBridge {
    return createHostUiBridge({
      nextRequestId: () =>
        `${record.threadId}:ui:${record.seq}:${Math.random().toString(36).slice(2, 8)}`,
      currentToolCallId: () => {
        const pending = record.session.state.pendingToolCalls
        return pending.size === 1 ? [...pending][0] : undefined
      },
      emitRequest: (request: HarnessHostUiRequest) => {
        this.emit(record, { type: 'extension_ui_request', request })
      },
      emitResolved: (requestId: string) => {
        this.emit(record, { type: 'extension_ui_resolved', requestId })
      },
      onNotify: (message, type) => {
        this.notifyHostUi(
          record,
          message,
          type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info',
        )
      },
      onStatus: (key, text) => this.setHostUiStatus(record, key, text),
      onWidget: (key, lines, placement) => this.setHostUiWidget(record, key, lines, placement),
      onTitle: (title) => this.setHostUiTitle(record, title),
      onWorkingMessage: (message) => this.setHostUiWorkingMessage(record, message),
      onWorkingVisible: (visible) => this.setHostUiWorkingVisible(record, visible),
      onHiddenThinkingLabel: (label) => this.setHostUiHiddenThinkingLabel(record, label),
      getEditorText: () => this.callerDraftOf(record.threadId),
      onEditorWrite: (text, mode) => this.writeHostUiEditor(record, text, mode),
      onUnsupported: (method) => this.reportUnsupportedHostUi(record, method),
      startup: {
        ask: (request, options) =>
          this.deps.interactions.ask(request, startupScope, {
            ...options,
            signal:
              signal && options?.signal
                ? AbortSignal.any([signal, options.signal])
                : (signal ?? options?.signal),
          }),
        dismissAll: () => this.deps.interactions.cancelScope(startupScope),
        notify: (message, type) =>
          this.deps.interactions.notify(
            startupScope,
            message,
            type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info',
          ),
      },
    })
  }
}
