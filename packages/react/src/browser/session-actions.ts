/**
 * 公共会话动作：创建/发送、图片准备、停止、整体取回与固定模型选择。
 *
 * 设计（见 R1 §4/§5、R2 §3/§4）：
 * - 提交在第一个 await 前从窗口状态同步捕获目标、草稿版本、选择版本、模型、
 *   Thinking 与附件；之后不再读取“当前会话”补齐参数。
 * - 新建只有一条路径：createThread → threadId → sendMessage。创建输入显式传
 *   workspaceId/startProjectPath/model/thinkingLevel，不通过 HTTP 层偷读草稿。
 * - 同窗发送共用一条尾链，保持派发顺序；图片准备在尾链内完成，可被停止/卸载
 *   取消。未派发内容才可被停止或队列取回认领，已派发但结果未知的内容保留。
 * - 服务端 disposition 决定草稿清理与本窗历史；只在捕获的 draftRevision 仍
 *   未变化时清空，用户改空、改模型或换附件都视为新编辑。
 * - 队列展示只来自服务端；这里不维护第二份可写队列，也不按文本次数认领条目。
 * - 错误后先同步服务端（目录/会话/队列），保留输入，绝不自动重投。
 *
 * 这不是新的 Controller：状态在 Zustand，动作是稳定函数；内部只保留
 * AbortController、尾链 promise 与提交 promise 等异步资源句柄。
 */

import type {
  HarnessBashStartResult,
  HarnessClient,
  HarnessImageContent,
  HarnessModelInfo,
  HarnessSendMessageDisposition,
  HarnessSendMessageResult,
  HarnessThinkingLevel,
} from '@huan/protocol'
import type { StoreApi } from 'zustand/vanilla'
import { prepareImageContent } from '../model/image-input.js'
import type { HarnessServiceState } from './service-store.js'
import type {
  HarnessDraftTarget,
  HarnessSubmission,
  HarnessSubmissionMode,
  HarnessSubmissionStatus,
  HarnessWindowState,
} from './window-store.js'
import { draftIdOf } from './window-store.js'

/** 提交输入：模式由应用 composer 解析，其他字段只用于明确的覆盖。 */
export interface HarnessSessionSubmitInput {
  mode: HarnessSubmissionMode
  draftId?: string
  target?: HarnessDraftTarget
  /** Shell 命令文本等显式覆盖；普通发送省略时读取捕获草稿文字。 */
  content?: string
  panelId?: string
  panelEpoch?: number
}

/** 一次提交的完成提示；不含服务端不存在的本地队列身份。 */
export interface HarnessSessionSubmitOutcome {
  submissionId: string
  status: HarnessSubmissionStatus
  threadId?: string
  disposition?: HarnessSendMessageDisposition
  message?: string
}

/** 停止结果；本地未派发准备已取消，服务端取消失败如实返回。 */
export interface HarnessSessionStopOutcome {
  threadId: string
  status: 'stopped' | 'failed'
  message?: string
}

/** 整体取回结果：服务端文本与本地未派发文本并列返回，不按文字去重。 */
export interface HarnessSessionQueueRecovery {
  threadId: string
  status: 'cleared' | 'failed'
  steering: string[]
  followUp: string[]
  message?: string
}

/** 本地未派发队列文本；用于树导航这类由服务端整体取回的流程。 */
export interface HarnessLocalQueueRecovery {
  steering: string[]
  followUp: string[]
}

/** 浏览器实例公开的会话动作。 */
export interface HarnessSessionActions {
  /** 同步捕获并提交；同草稿相同在途提交复用同一 promise（双击去重）。 */
  submit: (input: HarnessSessionSubmitInput) => Promise<HarnessSessionSubmitOutcome | undefined>
  /** 取消本窗未派发准备，并请求服务端停止当前运行与未交付队列。 */
  stop: (threadId: string) => Promise<HarnessSessionStopOutcome>
  /** 整体取回服务端队列，同时取消并交还未派发的本地队列文本。 */
  recoverQueue: (threadId: string) => Promise<HarnessSessionQueueRecovery>
  /** 只取消并交还未派发的本地队列文本，不调用服务端。 */
  cancelPendingQueue: (threadId: string) => HarnessLocalQueueRecovery
  /** 固定会话模型；用于 composer 模型命令。 */
  setModel: (threadId: string, model: { provider: string; modelId: string }) => Promise<void>
  /** 固定会话 Thinking 级别；用于 composer Thinking 命令。 */
  setThinkingLevel: (threadId: string, level: HarnessThinkingLevel) => Promise<void>
  /** 根挂载释放：失效尚未派发的准备/提交，已派发输入保留至动作结束。 */
  cancelUnmounted: () => void
  dispose: () => void
}

export interface CreateHarnessSessionActionsOptions {
  client: HarnessClient
  serviceStore: StoreApi<HarnessServiceState>
  windowStore: StoreApi<HarnessWindowState>
  /** 重建已终止的 live 观察；只恢复订阅，不重发业务任务。 */
  reconnectThread?: (threadId: string) => void
}

interface SubmissionRuntime {
  controller: AbortController
  promise: Promise<HarnessSessionSubmitOutcome | undefined>
}

const CANCELLED_MESSAGE = '提交已取消。'
const UNMOUNTED_MESSAGE = '窗口已卸载，未派发的提交已取消。'
const ABANDONED_MESSAGE = '实例已销毁，未派发的提交已取消。'

const cancelledError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'HarnessSessionCancelled'
  return error
}

const isCancellation = (error: unknown): boolean =>
  error instanceof Error && error.name === 'HarnessSessionCancelled'

const preparationError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'HarnessPreparationError'
  return error
}

const isPreparationError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'HarnessPreparationError'

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const isQueueMode = (mode: HarnessSubmissionMode): mode is 'steer' | 'followUp' =>
  mode === 'steer' || mode === 'followUp'

const sameTarget = (left: HarnessDraftTarget | undefined, right: HarnessDraftTarget): boolean => {
  if (!left || left.kind !== right.kind) return false
  if (left.kind === 'thread' && right.kind === 'thread') return left.threadId === right.threadId
  if (left.kind === 'new' && right.kind === 'new') {
    return (
      left.startProjectPath === right.startProjectPath && left.workspaceId === right.workspaceId
    )
  }
  return false
}

const threadIdOfTarget = (target: HarnessDraftTarget): string | undefined =>
  target.kind === 'thread' ? target.threadId : undefined

const submissionThreadId = (submission: HarnessSubmission): string | undefined =>
  submission.threadId ?? threadIdOfTarget(submission.target)

const historyTextOf = (submission: HarnessSubmission): string => {
  if (submission.mode === 'bash') return `!${submission.content}`
  if (submission.mode === 'bashExcluded') return `!!${submission.content}`
  return submission.content
}

const mergeQueue = (
  server: { steering: string[]; followUp: string[] } | undefined,
  local: HarnessLocalQueueRecovery,
): { steering: string[]; followUp: string[] } => ({
  // 不按文字去重：服务端取回与本窗未派发内容分别交还。
  steering: [...(server?.steering ?? []), ...local.steering],
  followUp: [...(server?.followUp ?? []), ...local.followUp],
})

const findModel = (
  models: readonly HarnessModelInfo[] | undefined,
  provider: string,
  modelId: string,
): HarnessModelInfo | undefined =>
  models?.find((model) => model.provider === provider && model.modelId === modelId)

export const createHarnessSessionActions = (
  options: CreateHarnessSessionActionsOptions,
): HarnessSessionActions => {
  const { client, serviceStore, windowStore } = options
  const runtimes = new Map<string, SubmissionRuntime>()
  let disposed = false
  let sendTail: Promise<unknown> = Promise.resolve()

  const windowState = (): HarnessWindowState => windowStore.getState()
  const serviceState = (): HarnessServiceState => serviceStore.getState()

  const setSubmissionStatus = (
    submissionId: string,
    status: HarnessSubmissionStatus,
    message?: string,
  ) => {
    windowState().setSubmissionStatus(submissionId, status, message)
  }

  const syncAfterFailure = async (threadId: string | undefined): Promise<void> => {
    const tasks: Promise<unknown>[] = [
      serviceStore
        .getState()
        .refreshThreads({ refresh: true })
        .catch(() => undefined),
    ]
    if (threadId) {
      tasks.push(
        serviceStore
          .getState()
          .loadThread(threadId, { force: true })
          .catch(() => undefined),
      )
    }
    await Promise.all(tasks)
  }

  /** 取消满足条件的未派发提交；返回被取消的记录，不冒充服务端队列。 */
  const cancelUnsent = (
    match: (submission: HarnessSubmission) => boolean,
    reason: Error,
  ): HarnessSubmission[] => {
    const canceled: HarnessSubmission[] = []
    for (const submission of Object.values(windowState().submissionsById)) {
      if (submission.status !== 'pending' || submission.dispatched) continue
      if (!match(submission)) continue
      const runtime = runtimes.get(submission.id)
      runtime?.controller.abort(reason)
      setSubmissionStatus(submission.id, 'cancelled', reason.message)
      canceled.push(submission)
    }
    return canceled
  }

  const modelConfigOf = (
    submission: HarnessSubmission,
    threadId: string | undefined,
  ): { provider: string; modelId: string } | undefined => {
    if (submission.model) return submission.model
    const metadata = threadId ? serviceState().threadsById[threadId] : undefined
    const configured = metadata?.config
    if (configured?.provider && configured.modelId) {
      return { provider: configured.provider, modelId: configured.modelId }
    }
    const fallback = serviceState().host?.defaultModel
    if (fallback?.provider && fallback.modelId) {
      return { provider: fallback.provider, modelId: fallback.modelId }
    }
    return undefined
  }

  /**
   * 图片能力预检：模型声明不支持图片时在创建/发送前失败。
   * 目录读取失败不阻断发送，由服务端发送前继续校验。
   */
  const checkImageCapability = async (
    submission: HarnessSubmission,
    existingThreadId: string | undefined,
  ): Promise<string | undefined> => {
    if (submission.attachmentIds.length === 0) return undefined
    const metadata = existingThreadId ? serviceState().threadsById[existingThreadId] : undefined
    const config = modelConfigOf(submission, existingThreadId)
    if (!config) return undefined

    const sameAsMetadataConfig =
      metadata?.config?.provider === config.provider && metadata?.config?.modelId === config.modelId
    if (sameAsMetadataConfig && metadata.modelInput) {
      return metadata.modelInput.includes('image')
        ? undefined
        : `${config.provider}/${config.modelId} 未声明图像输入能力，请移除图片或切换支持图像的模型。`
    }

    const workspacePath =
      submission.target.kind === 'new'
        ? submission.target.startProjectPath
        : (metadata?.workspacePath ?? serviceState().host?.workspacePath)
    if (!workspacePath) return undefined
    const models = await serviceStore
      .getState()
      .loadModelCatalog({
        workspacePath,
        ...(existingThreadId ? { threadId: existingThreadId } : {}),
      })
      .catch(() => undefined)
    const input = findModel(models, config.provider, config.modelId)?.input
    if (!input || input.includes('image')) return undefined
    return `${config.provider}/${config.modelId} 未声明图像输入能力，请移除图片或切换支持图像的模型。`
  }

  const prepareAttachments = async (
    submission: HarnessSubmission,
    signal: AbortSignal,
  ): Promise<HarnessImageContent[]> => {
    if (submission.attachmentIds.length === 0) return []
    const attachments = windowState().attachmentsById
    const prepared: HarnessImageContent[] = []
    for (const attachmentId of submission.attachmentIds) {
      const attachment = attachments[attachmentId]
      if (!attachment) throw preparationError('提交引用的附件已不存在，请重新添加附件。')
      windowState().setAttachmentStatus(attachmentId, 'preparing')
      try {
        const content = await prepareImageContent(
          { blob: attachment.blob, mimeType: attachment.mimeType },
          signal,
        )
        if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
        windowState().setAttachmentStatus(attachmentId, 'ready')
        prepared.push(content)
      } catch (error) {
        if (isCancellation(error)) throw error
        const message = errorText(error)
        windowState().setAttachmentStatus(attachmentId, 'failed', message)
        throw preparationError(message)
      }
    }
    return prepared
  }

  const applyCapturedModel = async (
    submission: HarnessSubmission,
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const metadata = serviceState().threadsById[threadId]
    const captured = submission.model
    if (captured) {
      const same =
        metadata?.config?.provider === captured.provider &&
        metadata?.config?.modelId === captured.modelId
      if (!same) {
        await client.setModel(threadId, captured)
        if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
      }
    }
    const thinking = submission.thinkingLevel
    if (thinking && metadata?.config?.thinkingLevel !== thinking) {
      await client.setThinkingLevel(threadId, thinking)
      if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
    }
  }

  const openCreatedThread = (submission: HarnessSubmission, threadId: string): boolean => {
    const state = windowState()
    // 用户后来切换选择时不夺回窗口；输入仍留在原草稿/提交中。
    if (state.selectionRevision !== submission.origin.selectionRevision) return false
    if (!sameTarget(state.selection, submission.target)) return false
    windowState().selectTarget({ kind: 'thread', threadId })
    windowState().transferSubmissionDraft(submission.id, threadId)
    options.reconnectThread?.(threadId)
    return true
  }

  const acceptSubmission = (
    submission: HarnessSubmission,
    status: 'accepted' | 'handled',
    disposition: HarnessSendMessageDisposition,
    threadId: string,
  ): HarnessSessionSubmitOutcome => {
    // 仅清理仍等于捕获版本的草稿；用户后来的编辑保持原样。
    windowState().clearSubmissionDraft(submission.id)
    windowState().recordInputHistory(historyTextOf(submission))
    windowState().removeSubmission(submission.id)
    runtimes.delete(submission.id)
    return {
      submissionId: submission.id,
      status,
      threadId,
      disposition,
    }
  }

  const executeSubmission = async (
    submission: HarnessSubmission,
    runtime: SubmissionRuntime,
  ): Promise<HarnessSessionSubmitOutcome> => {
    const { controller } = runtime
    const { signal } = controller
    try {
      if (disposed) throw cancelledError(ABANDONED_MESSAGE)
      if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)

      const existingThreadId = threadIdOfTarget(submission.target)
      const rejection = await checkImageCapability(submission, existingThreadId)
      if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
      if (rejection) {
        setSubmissionStatus(submission.id, 'failed', rejection)
        return { submissionId: submission.id, status: 'failed', message: rejection }
      }

      const attachments = await prepareAttachments(submission, signal)
      if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)

      let threadId = existingThreadId
      let created = false
      if (submission.target.kind === 'new') {
        const snapshot = await client.createThread({
          ...(submission.target.workspaceId ? { workspaceId: submission.target.workspaceId } : {}),
          startProjectPath: submission.target.startProjectPath,
          ...(submission.model ? { model: submission.model } : {}),
          ...(submission.thinkingLevel ? { thinkingLevel: submission.thinkingLevel } : {}),
        })
        if (disposed) throw cancelledError(ABANDONED_MESSAGE)
        threadId = snapshot.metadata.id
        created = true
        serviceStore.getState().applyThreadSnapshot(threadId, snapshot)
        windowState().setSubmissionThread(submission.id, threadId)
        // 唯一目录立即包含新会话；列表失败不阻断发送，下次显式刷新恢复。
        await serviceStore
          .getState()
          .refreshThreads()
          .catch(() => undefined)
        if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
        const opened = openCreatedThread(submission, threadId)
        // 未打开的新会话只保留目录实体，避免无租约的完整缓存常驻。
        if (!opened) serviceStore.getState().evictThreadSession(threadId)
        if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
      }
      if (!threadId) throw new Error('提交缺少会话目标。')

      if (submission.mode === 'bash' || submission.mode === 'bashExcluded') {
        if (disposed) throw cancelledError(ABANDONED_MESSAGE)
        windowState().markSubmissionDispatched(submission.id)
        const result: HarnessBashStartResult = await client.runThreadBash(threadId, {
          command: submission.content,
          ...(submission.mode === 'bashExcluded' ? { excludeFromContext: true } : {}),
        })
        if (result.status === 'started') {
          return acceptSubmission(submission, 'accepted', 'started', threadId)
        }
        const message = result.message
        setSubmissionStatus(submission.id, 'failed', message)
        return { submissionId: submission.id, status: 'failed', threadId, message }
      }

      if (!created) await applyCapturedModel(submission, threadId, signal)
      // 无模型改动的提交也可能在尾链等待期间被停止，派发前再检查取消资格。
      if (signal.aborted) throw signal.reason ?? cancelledError(CANCELLED_MESSAGE)
      if (disposed) throw cancelledError(ABANDONED_MESSAGE)
      options.reconnectThread?.(threadId)
      windowState().markSubmissionDispatched(submission.id)
      const result: HarnessSendMessageResult = await client.sendMessage(threadId, {
        content: submission.content,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(submission.mode === 'steer' ? { streamingBehavior: 'steer' as const } : {}),
        ...(submission.mode === 'followUp' ? { streamingBehavior: 'followUp' as const } : {}),
      })

      switch (result.disposition) {
        case 'started':
        case 'queued':
          return acceptSubmission(submission, 'accepted', result.disposition, threadId)
        case 'handled':
          return acceptSubmission(submission, 'handled', 'handled', threadId)
        case 'cancelled': {
          setSubmissionStatus(submission.id, 'cancelled', CANCELLED_MESSAGE)
          return {
            submissionId: submission.id,
            status: 'cancelled',
            threadId,
            disposition: 'cancelled',
            message: CANCELLED_MESSAGE,
          }
        }
      }
    } catch (error) {
      const currentSubmission = windowState().submissionsById[submission.id] ?? submission
      if (isCancellation(error)) {
        const message = errorText(error)
        setSubmissionStatus(submission.id, 'cancelled', message)
        return {
          submissionId: submission.id,
          status: 'cancelled',
          ...(submissionThreadId(currentSubmission)
            ? { threadId: submissionThreadId(currentSubmission) }
            : {}),
          message,
        }
      }
      const threadId = submissionThreadId(currentSubmission)
      if (disposed) {
        return {
          submissionId: submission.id,
          status: 'cancelled',
          ...(threadId ? { threadId } : {}),
          message: ABANDONED_MESSAGE,
        }
      }
      if (isPreparationError(error)) {
        const message = errorText(error)
        setSubmissionStatus(submission.id, 'failed', message)
        return {
          submissionId: submission.id,
          status: 'failed',
          ...(threadId ? { threadId } : {}),
          message,
        }
      }
      // HTTP状态无法证明扩展未执行副作用，只有明确业务结果可证明拒绝。
      const status = 'unknown'
      const message = errorText(error)
      setSubmissionStatus(submission.id, status, message)
      await syncAfterFailure(threadId)
      return {
        submissionId: submission.id,
        status,
        ...(threadId ? { threadId } : {}),
        message,
      }
    } finally {
      runtimes.delete(submission.id)
    }
  }

  const schedule = (
    run: () => Promise<HarnessSessionSubmitOutcome>,
  ): Promise<HarnessSessionSubmitOutcome> => {
    const previous = sendTail
    const attempt = (async () => {
      await previous.catch(() => undefined)
      return run()
    })()
    sendTail = attempt.catch(() => undefined)
    return attempt
  }

  const findPendingDuplicate = (
    input: HarnessSessionSubmitInput,
    draftId: string,
    revision: number,
    content: string,
  ): HarnessSubmission | undefined =>
    Object.values(windowState().submissionsById).find(
      (submission) =>
        submission.status === 'pending' &&
        submission.draft.draftId === draftId &&
        submission.draft.revision === revision &&
        submission.mode === input.mode &&
        submission.content === content,
    )

  return {
    submit: (input) => {
      if (disposed) return Promise.resolve(undefined)
      if (input.mode === 'command') {
        // 内置命令由应用 composer 执行，公共动作不把命令当消息发送。
        return Promise.resolve(undefined)
      }
      const state = windowState()
      if (state.disposed) return Promise.resolve(undefined)
      const target =
        input.target ?? (input.draftId ? state.draftsById[input.draftId]?.target : state.selection)
      if (!target) return Promise.resolve(undefined)
      const draftId = input.draftId ?? draftIdOf(target)
      if (!draftId) return Promise.resolve(undefined)
      const draft = state.draftsById[draftId]
      if (!draft) return Promise.resolve(undefined)
      const content = input.content ?? draft.text
      const hasAttachments = draft.attachmentIds.length > 0
      if (content.trim() === '' && !hasAttachments) return Promise.resolve(undefined)
      if ((input.mode === 'bash' || input.mode === 'bashExcluded') && hasAttachments) {
        return Promise.resolve({
          submissionId: '',
          status: 'failed',
          message: '命令与 Shell 不能附带图片附件；请移除附件后重试。',
        })
      }

      const duplicate = findPendingDuplicate(input, draftId, draft.revision, content)
      if (duplicate) {
        return (
          runtimes.get(duplicate.id)?.promise ??
          Promise.resolve({ submissionId: duplicate.id, status: duplicate.status })
        )
      }

      const submission = windowState().captureSubmission({
        mode: input.mode,
        draftId,
        target,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.panelId ? { panelId: input.panelId } : {}),
        ...(input.panelEpoch !== undefined ? { panelEpoch: input.panelEpoch } : {}),
      })
      if (!submission) return Promise.resolve(undefined)

      const controller = new AbortController()
      const runtime: SubmissionRuntime = {
        controller,
        promise: Promise.resolve(undefined) as SubmissionRuntime['promise'],
      }
      runtime.promise = schedule(() => executeSubmission(submission, runtime))
      runtimes.set(submission.id, runtime)
      return runtime.promise
    },

    stop: async (threadId) => {
      if (disposed) return { threadId, status: 'failed', message: ABANDONED_MESSAGE }
      cancelUnsent(
        (submission) => submissionThreadId(submission) === threadId,
        cancelledError(CANCELLED_MESSAGE),
      )
      try {
        await client.cancelRun(threadId)
        return { threadId, status: 'stopped' }
      } catch (error) {
        await syncAfterFailure(threadId)
        return { threadId, status: 'failed', message: errorText(error) }
      }
    },

    recoverQueue: async (threadId) => {
      if (disposed) {
        return {
          threadId,
          status: 'failed',
          steering: [],
          followUp: [],
          message: ABANDONED_MESSAGE,
        }
      }
      const local = { steering: [] as string[], followUp: [] as string[] }
      for (const submission of cancelUnsent(
        (candidate) => submissionThreadId(candidate) === threadId && isQueueMode(candidate.mode),
        cancelledError('提交已从队列取回。'),
      )) {
        if (submission.mode === 'steer') local.steering.push(submission.content)
        else if (submission.mode === 'followUp') local.followUp.push(submission.content)
      }
      try {
        const cleared = await client.clearQueue(threadId)
        // 不直接清空本地队列：后续 queue_update/快照才是权威；这里只交还文本。
        return {
          threadId,
          status: 'cleared',
          ...mergeQueue(cleared, local),
        }
      } catch (error) {
        await syncAfterFailure(threadId)
        return {
          threadId,
          status: 'failed',
          ...mergeQueue(undefined, local),
          message: errorText(error),
        }
      }
    },

    cancelPendingQueue: (threadId) => {
      const local = { steering: [] as string[], followUp: [] as string[] }
      if (disposed) return local
      for (const submission of cancelUnsent(
        (candidate) => submissionThreadId(candidate) === threadId && isQueueMode(candidate.mode),
        cancelledError('提交已从队列取回。'),
      )) {
        if (submission.mode === 'steer') local.steering.push(submission.content)
        else if (submission.mode === 'followUp') local.followUp.push(submission.content)
      }
      return local
    },

    setModel: async (threadId, model) => {
      if (disposed) throw new Error(ABANDONED_MESSAGE)
      await client.setModel(threadId, model)
      await serviceStore
        .getState()
        .loadThread(threadId, { force: true })
        .catch(() => undefined)
    },

    setThinkingLevel: async (threadId, level) => {
      if (disposed) throw new Error(ABANDONED_MESSAGE)
      await client.setThinkingLevel(threadId, level)
      await serviceStore
        .getState()
        .loadThread(threadId, { force: true })
        .catch(() => undefined)
    },

    cancelUnmounted: () => {
      if (disposed) return
      cancelUnsent(() => true, cancelledError(UNMOUNTED_MESSAGE))
    },

    dispose: () => {
      if (disposed) return
      disposed = true
      for (const runtime of runtimes.values()) {
        runtime.controller.abort(cancelledError(ABANDONED_MESSAGE))
      }
      runtimes.clear()
    },
  }
}
