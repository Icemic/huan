/**
 * 窗口作用域 Zustand 状态：显式选择、草稿、附件、本窗提交与输入历史。
 *
 * 设计（见 R1 §3.2）：
 * - 选择与草稿版本分开推进：`selectionRevision` 保护迟到的窗口效果，
 *   `draftRevision` 保护「同目标新输入」。
 * - 草稿文字按宿主存储作用域持久化到 sessionStorage（可注入存储用于测试）；
 *   附件（Blob/base64）与提交记录只留内存。
 * - 本窗输入历史只由本窗已接受动作登记；不从共享 user 消息重建。
 * - 附件从草稿移除时不提前释放仍被提交记录持有的内容。
 */

import type { HarnessThinkingLevel } from '@huan/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 会话草稿目标：新会话（固定起始项目）或已有会话。 */
export type HarnessDraftTarget =
  | { kind: 'new'; workspaceId?: string; startProjectPath: string }
  | { kind: 'thread'; threadId: string }

/** 草稿引用：提交只清理捕获的草稿版本，不触碰同目标新输入。 */
export interface HarnessDraftRef {
  draftId: string
  revision: number
}

/** 异步窗口效果来源；只用于本地完成处理，不是服务端权限依据。 */
export interface HarnessViewOrigin {
  selectionRevision: number
  panelId?: string
  panelEpoch?: number
}

/** 提交模式（命令由应用解析，公共包不读取应用命令目录）。 */
export type HarnessSubmissionMode =
  | 'prompt'
  | 'steer'
  | 'followUp'
  | 'bash'
  | 'bashExcluded'
  | 'command'

/** 本窗提交状态；不冒充服务端队列身份。 */
export type HarnessSubmissionStatus =
  | 'pending'
  | 'accepted'
  | 'handled'
  | 'unknown'
  | 'failed'
  | 'cancelled'

/** 一次提交的不可变捕获。 */
export interface HarnessSubmission {
  id: string
  target: HarnessDraftTarget
  draft: HarnessDraftRef
  origin: HarnessViewOrigin
  content: string
  attachmentIds: readonly string[]
  model?: { provider: string; modelId: string }
  thinkingLevel?: HarnessThinkingLevel
  mode: HarnessSubmissionMode
  status: HarnessSubmissionStatus
  /** 已调用服务端变更请求；未知派发的内容不能被队列取回冒认。 */
  dispatched: boolean
  /** 新建流程取得的会话 ID；创建成功后填写。 */
  threadId?: string
  /** 本窗提示（准备/发送失败的受控文案）。 */
  message?: string
  createdAt: number
}

/** 附件准备状态；图片准备动作由 R4 实现。 */
export type HarnessAttachmentStatus = 'preparing' | 'ready' | 'failed'

/** 图片/文件附件；Blob 只留内存，不持久化。 */
export interface HarnessAttachment {
  id: string
  fileName: string
  mimeType: string
  blob: Blob
  status: HarnessAttachmentStatus
  error?: string
  createdAt: number
}

/** 单份草稿。文字按存储作用域持久化；模型预选与附件只留内存。 */
export interface HarnessDraft {
  id: string
  target: HarnessDraftTarget
  text: string
  /** 每次文字/模型/附件引用变化推进；提交完成只处理捕获版本。 */
  revision: number
  model?: { provider: string; modelId: string }
  thinkingLevel?: HarnessThinkingLevel
  attachmentIds: readonly string[]
}

/** 可注入的会话存储（默认 `sessionStorage`；不可用时只留内存）。 */
export interface HarnessBrowserStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 窗口作用域 Zustand 状态。 */
export interface HarnessWindowState {
  readonly windowId: string
  /** 当前存储作用域（connectionKey + 宿主 agentDir/sessionStorage.root）。 */
  storageScope: string
  selection: HarnessDraftTarget | undefined
  selectionRevision: number
  draftsById: Readonly<Record<string, HarnessDraft>>
  attachmentsById: Readonly<Record<string, HarnessAttachment>>
  submissionsById: Readonly<Record<string, HarnessSubmission>>
  inputHistory: readonly string[]
  disposed: boolean

  /** 更新存储作用域；保留已输入文字并恢复新作用域下的文字/选择。 */
  setStorageScope: (scope: string) => void
  /** 显式选择目标；每次调用推进 selectionRevision。 */
  selectTarget: (target: HarnessDraftTarget) => void
  /** 修改草稿文字；推进 draftRevision 并持久化文字。 */
  editDraftText: (draftId: string, text: string) => void
  /** 仅当草稿仍是调用方读到的版本时替换文字；用于迟到结果保护。 */
  setDraftTextIfRevision: (draftId: string, revision: number, text: string) => boolean
  setDraftModel: (draftId: string, model: { provider: string; modelId: string } | undefined) => void
  setDraftThinkingLevel: (draftId: string, level: HarnessThinkingLevel | undefined) => void
  /** 添加附件引用并推进草稿版本；返回附件 ID。 */
  addAttachment: (
    draftId: string,
    input: { fileName: string; mimeType: string; blob: Blob },
  ) => string | undefined
  setAttachmentStatus: (
    attachmentId: string,
    status: HarnessAttachmentStatus,
    error?: string,
  ) => void
  /** 从草稿移除附件；提交记录仍持有时保留内容。 */
  removeAttachment: (draftId: string, attachmentId: string) => void
  /** 从当前状态同步捕获提交；无目标/空输入时返回 undefined。 */
  captureSubmission: (input: {
    mode: HarnessSubmissionMode
    draftId?: string
    target?: HarnessDraftTarget
    content?: string
    panelId?: string
    panelEpoch?: number
  }) => HarnessSubmission | undefined
  setSubmissionStatus: (
    submissionId: string,
    status: HarnessSubmissionStatus,
    message?: string,
  ) => void
  /** 标记已进入服务端变更请求；此后的内容不能按“未派发”取回。 */
  markSubmissionDispatched: (submissionId: string) => void
  /** 记录新建流程取得的会话 ID。 */
  setSubmissionThread: (submissionId: string, threadId: string) => void
  /**
   * 首条创建成功后把草稿迁移到会话目标：目标草稿未被编辑时才写入。
   * 来源版本未变时提交改指向目标草稿；来源已有新输入时只迁移最新内容，
   * 不把提交的清理范围扩大到新输入。
   */
  transferSubmissionDraft: (submissionId: string, threadId: string) => boolean
  /** 仅当草稿仍等于捕获版本时清空文字并移除本次提交的附件引用。 */
  clearSubmissionDraft: (submissionId: string) => boolean
  /** 移除提交记录，并释放不再被草稿/提交引用的附件。 */
  removeSubmission: (submissionId: string) => void
  /**
   * 恢复提交内容到所属草稿：只在草稿版本未变化时写入。
   * 用户后来清空、修改模型或替换附件也属于新编辑。
   */
  restoreSubmission: (submissionId: string) => boolean
  /** 登记本窗已接受动作的输入历史（去重、上限 50）。 */
  recordInputHistory: (text: string) => void
  /** 永久销毁实例内存状态；已持久化文字保留。 */
  dispose: () => void
}

export interface CreateHarnessWindowStoreOptions {
  windowId: string
  /** 初始作用域（connectionKey）；宿主信息到达后由组合根补充。 */
  storageScope: string
  storage?: HarnessBrowserStorage | undefined
}

const INPUT_HISTORY_LIMIT = 50

/** 生成目标的稳定草稿 ID；不把新会话目标伪装成服务端 threadId。 */
export const draftIdOf = (target: HarnessDraftTarget): string =>
  target.kind === 'thread'
    ? `thread:${target.threadId}`
    : `new:${encodeURIComponent(target.workspaceId ?? '')}:${encodeURIComponent(target.startProjectPath)}`

const selectionKey = (scope: string) => `${scope}|selection`
const draftKey = (scope: string, draftId: string) => `${scope}|draft:${draftId}`

const readStored = (storage: HarnessBrowserStorage | undefined, key: string): string => {
  try {
    return storage?.getItem(key) ?? ''
  } catch {
    return ''
  }
}

const writeStored = (
  storage: HarnessBrowserStorage | undefined,
  key: string,
  value: string,
): void => {
  try {
    if (value) storage?.setItem(key, value)
    else storage?.removeItem(key)
  } catch {
    // 存储不可用时只影响窗口恢复，不影响输入与发送。
  }
}

const parseStoredTarget = (raw: string): HarnessDraftTarget | undefined => {
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const target = value as { kind?: unknown; threadId?: unknown; startProjectPath?: unknown }
    if (target.kind === 'thread' && typeof target.threadId === 'string') {
      return { kind: 'thread', threadId: target.threadId }
    }
    if (target.kind === 'new' && typeof target.startProjectPath === 'string') {
      const workspaceId = (value as { workspaceId?: unknown }).workspaceId
      return {
        kind: 'new',
        startProjectPath: target.startProjectPath,
        ...(typeof workspaceId === 'string' && workspaceId ? { workspaceId } : {}),
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

const initialWindowState = (
  windowId: string,
  storageScope: string,
): Pick<
  HarnessWindowState,
  | 'windowId'
  | 'storageScope'
  | 'selection'
  | 'selectionRevision'
  | 'draftsById'
  | 'attachmentsById'
  | 'submissionsById'
  | 'inputHistory'
  | 'disposed'
> => ({
  windowId,
  storageScope,
  selection: undefined,
  selectionRevision: 0,
  draftsById: {},
  attachmentsById: {},
  submissionsById: {},
  inputHistory: [],
  disposed: false,
})

export const createHarnessWindowStore = (
  options: CreateHarnessWindowStoreOptions,
): StoreApi<HarnessWindowState> => {
  const { windowId, storage } = options
  let submissionCounter = 0
  let attachmentCounter = 0

  return createStore<HarnessWindowState>()((set, get) => {
    const nextSubmissionId = () => {
      submissionCounter += 1
      return `submission-${submissionCounter}`
    }
    const nextAttachmentId = () => {
      attachmentCounter += 1
      return `attachment-${attachmentCounter}`
    }

    const ensureDraft = (
      state: HarnessWindowState,
      target: HarnessDraftTarget,
    ): HarnessWindowState => {
      const id = draftIdOf(target)
      if (state.draftsById[id]) return state
      return {
        ...state,
        draftsById: {
          ...state.draftsById,
          [id]: {
            id,
            target,
            text: readStored(storage, draftKey(state.storageScope, id)),
            revision: 0,
            attachmentIds: [],
          },
        },
      }
    }

    const patchDraft = (
      state: HarnessWindowState,
      draftId: string,
      patch: (draft: HarnessDraft) => HarnessDraft,
    ): HarnessWindowState => {
      const draft = state.draftsById[draftId]
      if (!draft) return state
      return {
        ...state,
        draftsById: { ...state.draftsById, [draftId]: patch(draft) },
      }
    }

    const releaseUnreferencedAttachments = (state: HarnessWindowState): HarnessWindowState => {
      const referenced = new Set<string>()
      for (const draft of Object.values(state.draftsById)) {
        for (const id of draft.attachmentIds) referenced.add(id)
      }
      for (const submission of Object.values(state.submissionsById)) {
        for (const id of submission.attachmentIds) referenced.add(id)
      }
      let changed = false
      const attachmentsById = { ...state.attachmentsById }
      for (const id of Object.keys(attachmentsById)) {
        if (referenced.has(id)) continue
        delete attachmentsById[id]
        changed = true
      }
      return changed ? { ...state, attachmentsById } : state
    }

    const persistSelection = (state: HarnessWindowState) => {
      writeStored(
        storage,
        selectionKey(state.storageScope),
        state.selection ? JSON.stringify(state.selection) : '',
      )
    }

    return {
      ...initialWindowState(windowId, options.storageScope),

      setStorageScope: (scope) => {
        const state = get()
        if (state.disposed || scope === state.storageScope) return
        let next: HarnessWindowState = { ...state, storageScope: scope }
        // 已输入文字保留并写入新作用域；空草稿从新作用域恢复文字。
        for (const draft of Object.values(next.draftsById)) {
          if (draft.text) writeStored(storage, draftKey(scope, draft.id), draft.text)
          else {
            next = {
              ...next,
              draftsById: {
                ...next.draftsById,
                [draft.id]: {
                  ...draft,
                  text: readStored(storage, draftKey(scope, draft.id)),
                },
              },
            }
          }
        }
        if (!next.selection) {
          const stored = parseStoredTarget(readStored(storage, selectionKey(scope)))
          if (stored) {
            next = ensureDraft(next, stored)
            next = { ...next, selection: stored, selectionRevision: next.selectionRevision + 1 }
          }
        }
        set(next)
        persistSelection(next)
      },

      selectTarget: (target) => {
        const state = get()
        if (state.disposed) return
        const next = ensureDraft(state, target)
        const selected: HarnessWindowState = {
          ...next,
          selection: target,
          selectionRevision: next.selectionRevision + 1,
        }
        set(selected)
        persistSelection(selected)
      },

      editDraftText: (draftId, text) => {
        const state = get()
        if (state.disposed) return
        const draft = state.draftsById[draftId]
        if (!draft || draft.text === text) return
        set(
          patchDraft(state, draftId, (current) => ({
            ...current,
            text,
            revision: current.revision + 1,
          })),
        )
        writeStored(storage, draftKey(state.storageScope, draftId), text)
      },

      setDraftTextIfRevision: (draftId, revision, text) => {
        const state = get()
        if (state.disposed) return false
        const draft = state.draftsById[draftId]
        if (!draft || draft.revision !== revision) return false
        if (draft.text !== text) {
          const next = patchDraft(state, draftId, (current) => ({
            ...current,
            text,
            revision: current.revision + 1,
          }))
          set(next)
          writeStored(storage, draftKey(state.storageScope, draftId), text)
        }
        return true
      },

      setDraftModel: (draftId, model) => {
        const state = get()
        if (state.disposed) return
        const draft = state.draftsById[draftId]
        if (!draft) return
        if (draft.model?.provider === model?.provider && draft.model?.modelId === model?.modelId) {
          return
        }
        set(
          patchDraft(state, draftId, (current) => ({
            ...current,
            ...(model ? { model } : { model: undefined }),
            revision: current.revision + 1,
          })),
        )
      },

      setDraftThinkingLevel: (draftId, level) => {
        const state = get()
        if (state.disposed) return
        const draft = state.draftsById[draftId]
        if (!draft || draft.thinkingLevel === level) return
        set(
          patchDraft(state, draftId, (current) => ({
            ...current,
            ...(level ? { thinkingLevel: level } : { thinkingLevel: undefined }),
            revision: current.revision + 1,
          })),
        )
      },

      addAttachment: (draftId, input) => {
        const state = get()
        if (state.disposed) return undefined
        if (!state.draftsById[draftId]) return undefined
        const id = nextAttachmentId()
        const attachment: HarnessAttachment = {
          id,
          fileName: input.fileName,
          mimeType: input.mimeType,
          blob: input.blob,
          status: 'preparing',
          createdAt: Date.now(),
        }
        set(
          patchDraft(
            {
              ...state,
              attachmentsById: { ...state.attachmentsById, [id]: attachment },
            },
            draftId,
            (current) => ({
              ...current,
              attachmentIds: [...current.attachmentIds, id],
              revision: current.revision + 1,
            }),
          ),
        )
        return id
      },

      setAttachmentStatus: (attachmentId, status, error) => {
        const state = get()
        if (state.disposed) return
        const attachment = state.attachmentsById[attachmentId]
        if (!attachment || attachment.status === status) return
        set({
          attachmentsById: {
            ...state.attachmentsById,
            [attachmentId]: {
              ...attachment,
              status,
              ...(error ? { error } : { error: undefined }),
            },
          },
        })
      },

      removeAttachment: (draftId, attachmentId) => {
        const state = get()
        if (state.disposed) return
        const draft = state.draftsById[draftId]
        if (!draft?.attachmentIds.includes(attachmentId)) return
        const next = patchDraft(state, draftId, (current) => ({
          ...current,
          attachmentIds: current.attachmentIds.filter((id) => id !== attachmentId),
          revision: current.revision + 1,
        }))
        set(releaseUnreferencedAttachments(next))
      },

      captureSubmission: (input) => {
        const state = get()
        if (state.disposed) return undefined
        const target =
          input.target ??
          (input.draftId ? state.draftsById[input.draftId]?.target : state.selection)
        if (!target) return undefined
        const draftId = input.draftId ?? draftIdOf(target)
        const draft = state.draftsById[draftId]
        if (!draft) return undefined
        const content = input.content ?? draft.text
        if (content.trim() === '' && draft.attachmentIds.length === 0) return undefined
        const submission: HarnessSubmission = {
          id: nextSubmissionId(),
          target: draft.target,
          draft: { draftId, revision: draft.revision },
          origin: {
            selectionRevision: state.selectionRevision,
            ...(input.panelId ? { panelId: input.panelId } : {}),
            ...(input.panelEpoch !== undefined ? { panelEpoch: input.panelEpoch } : {}),
          },
          content,
          attachmentIds: [...draft.attachmentIds],
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
          mode: input.mode,
          status: 'pending',
          dispatched: false,
          createdAt: Date.now(),
        }
        set({
          submissionsById: { ...state.submissionsById, [submission.id]: submission },
        })
        return submission
      },

      setSubmissionStatus: (submissionId, status, message) => {
        const state = get()
        if (state.disposed) return
        const submission = state.submissionsById[submissionId]
        if (!submission) return
        if (submission.status === status && submission.message === message) return
        set({
          submissionsById: {
            ...state.submissionsById,
            [submissionId]: {
              ...submission,
              status,
              ...(message ? { message } : { message: undefined }),
            },
          },
        })
      },

      markSubmissionDispatched: (submissionId) => {
        const state = get()
        if (state.disposed) return
        const submission = state.submissionsById[submissionId]
        if (!submission || submission.dispatched) return
        set({
          submissionsById: {
            ...state.submissionsById,
            [submissionId]: { ...submission, dispatched: true },
          },
        })
      },

      setSubmissionThread: (submissionId, threadId) => {
        const state = get()
        if (state.disposed) return
        const submission = state.submissionsById[submissionId]
        if (!submission || submission.threadId === threadId) return
        set({
          submissionsById: {
            ...state.submissionsById,
            [submissionId]: { ...submission, threadId },
          },
        })
      },

      transferSubmissionDraft: (submissionId, threadId) => {
        const state = get()
        if (state.disposed) return false
        const submission = state.submissionsById[submissionId]
        if (!submission) return false
        const source = state.draftsById[submission.draft.draftId]
        if (!source) return false
        const destinationTarget: HarnessDraftTarget = { kind: 'thread', threadId }
        const destinationId = draftIdOf(destinationTarget)
        const destination = state.draftsById[destinationId]
        // 目标草稿已有内容/版本时视为用户后来的编辑，绝不覆盖。
        if (
          destination &&
          (destination.revision !== 0 ||
            destination.text !== '' ||
            destination.attachmentIds.length > 0)
        ) {
          return false
        }
        if (source.id === destinationId) return false

        const sourceUnchanged = source.revision === submission.draft.revision
        const migratedText = sourceUnchanged ? submission.content : source.text
        const migratedAttachments = sourceUnchanged
          ? submission.attachmentIds
          : source.attachmentIds
        const migratedModel = sourceUnchanged ? submission.model : source.model
        const migratedThinking = sourceUnchanged ? submission.thinkingLevel : source.thinkingLevel
        const destinationRevision = (destination?.revision ?? 0) + 1
        const moved: HarnessDraft = {
          id: destinationId,
          target: destinationTarget,
          text: migratedText,
          revision: destinationRevision,
          ...(migratedModel ? { model: migratedModel } : {}),
          ...(migratedThinking ? { thinkingLevel: migratedThinking } : {}),
          attachmentIds: [...migratedAttachments],
        }
        const clearedSource: HarnessDraft = {
          ...source,
          text: '',
          attachmentIds: [],
          revision: source.revision + 1,
        }
        const draftsById = {
          ...state.draftsById,
          [destinationId]: moved,
          [source.id]: clearedSource,
        }
        // 来源版本未变时，提交的清理目标是迁移后的草稿；否则保留原引用，
        // 让接受结果不会误清新输入。
        const nextSubmission = sourceUnchanged
          ? {
              ...submission,
              threadId,
              draft: { draftId: destinationId, revision: destinationRevision },
            }
          : { ...submission, threadId }
        set({
          ...state,
          draftsById,
          submissionsById: {
            ...state.submissionsById,
            [submissionId]: nextSubmission,
          },
        })
        writeStored(storage, draftKey(state.storageScope, source.id), '')
        writeStored(storage, draftKey(state.storageScope, destinationId), migratedText)
        return true
      },

      clearSubmissionDraft: (submissionId) => {
        const state = get()
        if (state.disposed) return false
        const submission = state.submissionsById[submissionId]
        if (!submission) return false
        const draft = state.draftsById[submission.draft.draftId]
        if (!draft || draft.revision !== submission.draft.revision) return false
        const submitted = new Set(submission.attachmentIds)
        const next = patchDraft(state, draft.id, (current) => ({
          ...current,
          text: '',
          attachmentIds: current.attachmentIds.filter((id) => !submitted.has(id)),
          revision: current.revision + 1,
        }))
        set(next)
        writeStored(storage, draftKey(state.storageScope, draft.id), '')
        return true
      },

      removeSubmission: (submissionId) => {
        const state = get()
        if (state.disposed) return
        if (!state.submissionsById[submissionId]) return
        const submissionsById = { ...state.submissionsById }
        delete submissionsById[submissionId]
        set(releaseUnreferencedAttachments({ ...state, submissionsById }))
      },

      restoreSubmission: (submissionId) => {
        const state = get()
        if (state.disposed) return false
        const submission = state.submissionsById[submissionId]
        if (!submission) return false
        if (
          submission.status === 'pending' ||
          submission.status === 'accepted' ||
          submission.status === 'handled'
        ) {
          return false
        }
        const draft = state.draftsById[submission.draft.draftId]
        if (!draft) return false
        // 仅恢复未变化的版本，空文字也可能是用户后来的明确编辑。
        if (draft.revision !== submission.draft.revision) return false
        // 附件内容仍保留在实例中时一并恢复引用；已释放的附件不伪造。
        const attachmentIds = [...draft.attachmentIds]
        for (const id of submission.attachmentIds) {
          if (state.attachmentsById[id] && !attachmentIds.includes(id)) attachmentIds.push(id)
        }
        set(
          patchDraft(state, draft.id, (current) => ({
            ...current,
            text: submission.content,
            attachmentIds,
            revision: current.revision + 1,
          })),
        )
        writeStored(storage, draftKey(state.storageScope, draft.id), submission.content)
        return true
      },

      recordInputHistory: (text) => {
        const state = get()
        if (state.disposed) return
        const normalized = text.trim()
        if (!normalized || state.inputHistory[0] === normalized) return
        set({
          inputHistory: [normalized, ...state.inputHistory].slice(0, INPUT_HISTORY_LIMIT),
        })
      },

      dispose: () => {
        if (get().disposed) return
        set({ ...initialWindowState(windowId, get().storageScope), disposed: true })
      },
    }
  })
}
