/**
 * 会话 feature Zustand 状态：树查询/导航/标签、fork/clone、JSONL 导入与
 * 扩展定向编辑器。
 *
 * 业务边界（见 R1 §5.3）：
 * - 每次异步操作固定 threadId、panelEpoch、treeRevision、selectionRevision 与
 *   草稿版本；迟到结果只能更新原会话事实，不能抢后来选择或覆盖新草稿。
 * - 成功返回只刷新唯一服务目录与原会话；fork 子会话不替换父会话。
 * - 取回文本留在原树面板/草稿，不建设通用 recoverableResults 表。
 * - 定向指令先经服务端原子 consume，再做一次本地来源检查；已领取未应用的结果
 *   只保留在当前 feature 的待应用槽位，不重新领取。
 */

import type {
  HarnessClient,
  HarnessThreadDetails,
  HarnessThreadForkPosition,
  HarnessThreadForkResult,
  HarnessThreadImportPreview,
  HarnessThreadImportResult,
  HarnessThreadImportSource,
  HarnessThreadTree,
  HarnessThreadTreeNode,
  HarnessTreeLabelResult,
  HarnessTreeNavigateResult,
  HarnessTreeQueueRecovery,
} from '@huan/protocol'
import { draftIdOf, type HarnessBrowser, type HarnessDraftTarget } from '@huan/react'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** 树过滤模式。 */
export type SessionTreeFilter = 'conversation' | 'tools' | 'all' | 'labeled'

/** 树面板状态；只保存查询/选择/提示与当前面板取回文本。 */
export interface SessionTreePanelState {
  panelId: string
  epoch: number
  open: boolean
  threadId: string | undefined
  tree: HarnessThreadTree | undefined
  loading: boolean
  busy: boolean
  error: string | undefined
  notice: string | undefined
  selectedEntryId: string | undefined
  filter: SessionTreeFilter
  search: string
  /** 本面板的停止/导航取回文本；不自动发送。 */
  recoveredQueue: HarnessTreeQueueRecovery | undefined
}

/** 导入来源输入模式。 */
export type SessionImportMode = 'path' | 'upload'

/** 浏览器上传读取结果；文本只留内存，不持久化。 */
export interface SessionImportUpload {
  filename: string
  content: string
}

/** 导入面板状态；预览固定源与 panelEpoch。 */
export interface SessionImportPanelState {
  panelId: string
  epoch: number
  open: boolean
  workspaceId: string | undefined
  mode: SessionImportMode
  /** 宿主机器上的 JSONL 路径（不是浏览器本地文件）。 */
  path: string
  upload: SessionImportUpload | undefined
  source: HarnessThreadImportSource | undefined
  cwdOverride: string | undefined
  preview: HarnessThreadImportPreview | undefined
  /** 同 ID 冲突时用户是否确认作为独立副本导入。 */
  copyConfirmed: boolean
  /** 文件读取代次状态；换文件/换来源时旧读取结果作废。 */
  fileReading: boolean
  fileError: string | undefined
  busy: boolean
  error: string | undefined
  notice: string | undefined
  /** 需要用户先决定信任的项目路径；信任表单由工作区 feature 提供。 */
  trustPath: string | undefined
  /** 成功后由用户显式打开的会话 ID；不隐式切换。 */
  importedThreadId: string | undefined
}

/** 树导航确认表单；摘要模式与替换草稿均由用户确认。 */
export interface SessionTreeNavigationForm {
  node: HarnessThreadTreeNode
  mode: 'none' | 'summarize' | 'custom'
  instructions: string
  replaceInstructions: boolean
  replaceDraft: boolean
  /** 打开确认时草稿是否非空；执行时仍以当时草稿版本保护。 */
  draftNonEmpty: boolean
}

/** 树节点标签编辑表单。 */
export interface SessionTreeLabelForm {
  entryId: string
  value: string
}

/** fork/clone 确认面板。 */
export interface SessionForkPanelState {
  open: boolean
  sourceThreadId: string | undefined
  position: HarnessThreadForkPosition
  entryId: string | undefined
  /** 打开确认时捕获的结构 revision；确认时只按该来源创建。 */
  expectedRevision: string | undefined
  busy: boolean
  stopping: boolean
  error: string | undefined
}

/** 会话详情与管理表单；字段名与动作对应，不复制目录数据。 */
export interface SessionDetailsPanelState {
  open: boolean
  threadId: string | undefined
  epoch: number
  loading: boolean
  details: HarnessThreadDetails | undefined
  error: string | undefined
  renameValue: string
  renameBusy: boolean
  renameError: string | undefined
  actionBusy: boolean
  actionError: string | undefined
  notice: string | undefined
}

/** 删除确认。 */
export interface SessionDeletePanelState {
  open: boolean
  threadId: string | undefined
  busy: boolean
  error: string | undefined
}

/** 未归属会话加入工作区表单。 */
export interface SessionAssignPanelState {
  open: boolean
  threadId: string | undefined
  workspaceId: string
  busy: boolean
  error: string | undefined
}

/** 已应用编辑器指令的原文恢复入口。 */
export interface SessionEditorRecovery {
  threadId: string
  draftId: string
  previousText: string
  appliedRevision: number
}

/** 已 consume、但当前来源已失效的待应用编辑器文本。 */
export interface SessionPendingEditorDirective {
  threadId: string
  text: string
  mode: 'set' | 'paste'
  cursor: number
  draftRevision: number
}

/** 已 consume、但当前窗口已切换的待应用命令目标。 */
export interface SessionPendingCommandTarget {
  threadId: string
  editorText: string | undefined
}

/** 树导航输入；来源版本与面板由 store 捕获。 */
export interface SessionTreeNavigateInput {
  targetId: string
  expectedRevision: string
  summarize?: boolean
  customInstructions?: string
  replaceInstructions?: boolean
  replaceDraft?: boolean
  stopRunning?: boolean
}

/** 树标签输入。 */
export interface SessionTreeLabelInput {
  entryId: string
  label?: string
  expectedRevision?: string
}

/** fork/clone 输入；来源会话显式给出。 */
export interface SessionForkInput {
  threadId: string
  position: HarnessThreadForkPosition
  entryId?: string
  expectedRevision?: string
}

/** 导入配置输入；任何来源变化都使旧预览失效。 */
export interface SessionImportConfigInput {
  workspaceId?: string
  source?: HarnessThreadImportSource
  cwdOverride?: string
}

/** 会话 feature 状态。 */
export interface SessionsFeatureState {
  tree: SessionTreePanelState
  treeNavigation: SessionTreeNavigationForm | undefined
  treeLabel: SessionTreeLabelForm | undefined
  importPanel: SessionImportPanelState
  forkPanel: SessionForkPanelState
  details: SessionDetailsPanelState
  deleteConfirm: SessionDeletePanelState
  assign: SessionAssignPanelState
  /** 会话栏归档操作的目标；用于按钮忙状态。 */
  archiveBusy: string | undefined
  editorRecovery: SessionEditorRecovery | undefined
  pendingEditorDirective: SessionPendingEditorDirective | undefined
  pendingCommandTarget: SessionPendingCommandTarget | undefined
  disposed: boolean

  openTree: (threadId: string) => void
  closeTree: () => void
  refreshTree: () => Promise<void>
  /** 其他窗口推进 treeRevision 后，面板打开时只重读树。 */
  syncTreeRevision: (revision: string | undefined) => void
  setTreeFilter: (filter: SessionTreeFilter) => void
  setTreeSearch: (search: string) => void
  selectTreeEntry: (entryId: string | undefined) => void
  navigateTree: (input: SessionTreeNavigateInput) => Promise<HarnessTreeNavigateResult>
  /** 打开导航确认表单；捕获当前目标与草稿是否非空。 */
  beginTreeNavigation: (node: HarnessThreadTreeNode) => void
  setTreeNavigationMode: (mode: SessionTreeNavigationForm['mode']) => void
  setTreeNavigationInstructions: (instructions: string) => void
  setTreeNavigationReplaceInstructions: (replace: boolean) => void
  setTreeNavigationReplaceDraft: (replace: boolean) => void
  cancelTreeNavigationForm: () => void
  /** 按确认表单执行导航；成功/冲突后关闭表单。 */
  confirmTreeNavigation: () => Promise<HarnessTreeNavigateResult | undefined>
  beginTreeLabel: (entryId: string) => void
  setTreeLabelValue: (value: string) => void
  cancelTreeLabel: () => void
  saveTreeLabel: () => Promise<HarnessTreeLabelResult | undefined>
  setTreeLabel: (input: SessionTreeLabelInput) => Promise<HarnessTreeLabelResult | undefined>
  cancelTreeNavigation: () => Promise<void>
  dismissRecoveredQueue: () => void
  /** 把取回队列文本追加到当前树会话草稿；不自动发送。 */
  restoreRecoveredQueueItem: (text: string) => boolean

  openImport: (input?: { path?: string; workspaceId?: string }) => void
  closeImport: () => void
  configureImport: (input: SessionImportConfigInput) => void
  setImportMode: (mode: SessionImportMode) => void
  setImportPath: (path: string) => void
  /** 浏览器读取上传文件；代次保护，换来源/关闭面板后旧结果失效。 */
  readImportFile: (file: File | undefined) => Promise<void>
  setImportCopyConfirmed: (confirmed: boolean) => void
  /** 打开预览中已存在的会话；不隐式替换。 */
  openExistingImport: () => boolean
  /** 打开成功导入的会话；由用户显式触发。 */
  openImportedThread: () => boolean
  previewImport: () => Promise<HarnessThreadImportPreview | undefined>
  confirmImport: (options?: { asCopy?: boolean }) => Promise<HarnessThreadImportResult | undefined>

  openFork: (input: SessionForkInput) => void
  closeFork: () => void
  /** 停止 fork 来源会话的运行；不静默中止，也不关闭确认面板。 */
  stopForkSource: () => Promise<void>
  confirmFork: () => Promise<HarnessThreadForkResult | undefined>
  forkThread: (input: SessionForkInput) => Promise<HarnessThreadForkResult>

  openDetails: (threadId: string) => Promise<void>
  refreshDetails: () => Promise<void>
  closeDetails: () => void
  setRenameValue: (value: string) => void
  renameCurrentThread: () => Promise<void>
  toggleArchiveCurrent: () => Promise<void>
  /** 会话栏/详情共用的归档动作；不依赖详情面板打开。 */
  setThreadArchived: (threadId: string, archived: boolean) => Promise<void>
  openDelete: (threadId: string) => void
  closeDelete: () => void
  confirmDelete: () => Promise<void>
  openAssign: (threadId: string) => void
  setAssignWorkspace: (workspaceId: string) => void
  closeAssign: () => void
  confirmAssign: () => Promise<void>
  consumeEditorDirective: (threadId: string, cursor?: number) => Promise<boolean>
  /** 忽略编辑器指令：只消费，不改动草稿。 */
  discardEditorDirective: (threadId: string) => Promise<boolean>
  applyPendingEditorDirective: () => boolean
  restoreEditorPrevious: () => boolean
  consumeCommandTarget: (threadId: string) => Promise<boolean>
  /** 关闭命令目标提示：消费但不切换会话。 */
  dismissCommandTarget: (threadId: string) => Promise<boolean>
  applyPendingCommandTarget: () => boolean

  dispose: () => void
}

export interface CreateSessionsFeatureStoreOptions {
  browser: HarnessBrowser
  /** 可见操作完成提示；由组合根接到工作区提示条。 */
  onNotice?: (message: string) => void
}

/** 浏览器上传 JSONL 文本上限（与宿主一致，20MiB）。 */
const IMPORT_UPLOAD_LIMIT = 20 * 1024 * 1024

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const emptyTreePanel = (panelId: string): SessionTreePanelState => ({
  panelId,
  epoch: 0,
  open: false,
  threadId: undefined,
  tree: undefined,
  loading: false,
  busy: false,
  error: undefined,
  notice: undefined,
  selectedEntryId: undefined,
  filter: 'conversation',
  search: '',
  recoveredQueue: undefined,
})

const emptyImportPanel = (panelId: string): SessionImportPanelState => ({
  panelId,
  epoch: 0,
  open: false,
  workspaceId: undefined,
  mode: 'path',
  path: '',
  upload: undefined,
  source: undefined,
  cwdOverride: undefined,
  preview: undefined,
  copyConfirmed: false,
  fileReading: false,
  fileError: undefined,
  busy: false,
  error: undefined,
  notice: undefined,
  trustPath: undefined,
  importedThreadId: undefined,
})

const emptyForkPanel = (): SessionForkPanelState => ({
  open: false,
  sourceThreadId: undefined,
  position: 'before',
  entryId: undefined,
  expectedRevision: undefined,
  busy: false,
  stopping: false,
  error: undefined,
})

const emptyDetailsPanel = (): SessionDetailsPanelState => ({
  open: false,
  threadId: undefined,
  epoch: 0,
  loading: false,
  details: undefined,
  error: undefined,
  renameValue: '',
  renameBusy: false,
  renameError: undefined,
  actionBusy: false,
  actionError: undefined,
  notice: undefined,
})

const emptyDeletePanel = (): SessionDeletePanelState => ({
  open: false,
  threadId: undefined,
  busy: false,
  error: undefined,
})

const emptyAssignPanel = (): SessionAssignPanelState => ({
  open: false,
  threadId: undefined,
  workspaceId: '',
  busy: false,
  error: undefined,
})

const mergeRecoveredQueue = (
  left: HarnessTreeQueueRecovery | undefined,
  right: HarnessTreeQueueRecovery | undefined,
): HarnessTreeQueueRecovery | undefined => {
  if (!left) return right
  if (!right) return left
  // 不按文字去重：服务端取回与本窗未派发文本分别交还。
  return {
    steering: [...left.steering, ...right.steering],
    followUp: [...left.followUp, ...right.followUp],
  }
}

/** 导入预览的源指纹键；换文件/换路径/换目标工作区都视为新来源。 */
/** 按当前输入模式得到导入源；空路径/未上传文件时为 undefined。 */
const importSourceOf = (
  mode: SessionImportMode,
  path: string,
  upload: SessionImportUpload | undefined,
): HarnessThreadImportSource | undefined => {
  if (mode === 'path') {
    const trimmed = path.trim()
    return trimmed ? { kind: 'path', path: trimmed } : undefined
  }
  return upload ? { kind: 'upload', filename: upload.filename, content: upload.content } : undefined
}

const importSourceKey = (
  source: HarnessThreadImportSource | undefined,
  workspaceId: string | undefined,
  cwdOverride: string | undefined,
): string =>
  JSON.stringify([
    workspaceId ?? null,
    cwdOverride ?? null,
    source?.kind ?? null,
    source?.kind === 'path' ? source.path : null,
    source?.kind === 'upload' ? source.filename : null,
    source?.kind === 'upload' ? source.content : null,
  ])

export const createSessionsFeatureStore = (
  options: CreateSessionsFeatureStoreOptions,
): StoreApi<SessionsFeatureState> => {
  const { browser } = options
  const client: HarnessClient = browser.client
  const notify = (message: string) => options.onNotice?.(message)
  let treePanelCounter = 0
  let treeRequest = 0
  let treeSyncRevision: string | undefined
  let treeSyncBusy = false
  let importPanelCounter = 0
  let importFileRead = 0
  let detailsRequest = 0

  const currentDraft = (target: HarnessDraftTarget) => {
    const state = browser.windowStore.getState()
    const draftId = draftIdOf(target)
    return { draftId, draft: state.draftsById[draftId] }
  }

  const selectionIs = (target: HarnessDraftTarget): boolean => {
    const state = browser.windowStore.getState()
    if (!state.selection || state.selection.kind !== target.kind) return false
    if (state.selection.kind === 'thread' && target.kind === 'thread') {
      return state.selection.threadId === target.threadId
    }
    if (state.selection.kind === 'new' && target.kind === 'new') {
      return (
        state.selection.startProjectPath === target.startProjectPath &&
        state.selection.workspaceId === target.workspaceId
      )
    }
    return false
  }

  const refreshDirectory = async () => {
    await browser.serviceStore
      .getState()
      .refreshThreads({ includeArchived: true })
      .catch(() => undefined)
  }

  return createStore<SessionsFeatureState>()((set, get) => {
    return {
      tree: emptyTreePanel('tree-0'),
      treeNavigation: undefined,
      treeLabel: undefined,
      importPanel: emptyImportPanel('import-0'),
      forkPanel: emptyForkPanel(),
      details: emptyDetailsPanel(),
      deleteConfirm: emptyDeletePanel(),
      assign: emptyAssignPanel(),
      archiveBusy: undefined,
      editorRecovery: undefined,
      pendingEditorDirective: undefined,
      pendingCommandTarget: undefined,
      disposed: false,

      openTree: (threadId) => {
        const state = get()
        if (state.disposed) return
        treePanelCounter += 1
        const panel: SessionTreePanelState = {
          ...emptyTreePanel(`tree-${treePanelCounter}`),
          epoch: state.tree.epoch + 1,
          open: true,
          threadId,
          filter: state.tree.filter,
          search: state.tree.search,
          // 同会话重开保留尚未处理的取回文本；换会话则丢弃旧面板内容。
          recoveredQueue: state.tree.threadId === threadId ? state.tree.recoveredQueue : undefined,
        }
        set({ tree: panel, treeNavigation: undefined, treeLabel: undefined })
        treeSyncRevision = undefined
        void get().refreshTree()
      },

      closeTree: () => {
        const state = get()
        if (state.disposed) return
        set({
          tree: {
            ...state.tree,
            epoch: state.tree.epoch + 1,
            open: false,
            loading: false,
            busy: false,
            error: undefined,
          },
          treeNavigation: undefined,
          treeLabel: undefined,
        })
        treeSyncRevision = undefined
        treeSyncBusy = false
      },

      refreshTree: async () => {
        const state = get()
        if (state.disposed) return
        const panel = state.tree
        const threadId = panel.threadId
        if (!threadId) return
        const request = ++treeRequest
        const epoch = panel.epoch
        set({ tree: { ...get().tree, loading: true, error: undefined } })
        try {
          // 先刷新权威快照以取得最新 messageEntryIds；不执行项目扩展。
          await browser.serviceStore
            .getState()
            .loadThread(threadId, { force: true })
            .catch(() => undefined)
          const tree = await client.getThreadTree(threadId)
          const current = get()
          if (current.disposed || request !== treeRequest) return
          if (current.tree.epoch !== epoch || current.tree.threadId !== threadId) return
          set({ tree: { ...current.tree, tree, loading: false, error: undefined } })
        } catch (error) {
          const current = get()
          if (current.disposed || request !== treeRequest) return
          if (current.tree.epoch !== epoch || current.tree.threadId !== threadId) return
          set({ tree: { ...current.tree, loading: false, error: errorText(error) } })
        }
      },

      syncTreeRevision: (revision) => {
        const state = get()
        if (state.disposed || !state.tree.open || !state.tree.tree || !revision) return
        if (state.tree.tree.revision === revision) {
          treeSyncRevision = revision
          return
        }
        if (treeSyncRevision === revision && treeSyncBusy) return
        treeSyncRevision = revision
        treeSyncBusy = true
        // 树查询自身带面板 epoch；完成/失败后允许同一 revision 的下一次显式同步。
        void get()
          .refreshTree()
          .finally(() => {
            treeSyncBusy = false
          })
      },

      setTreeFilter: (filter) => {
        const state = get()
        if (state.disposed) return
        set({ tree: { ...state.tree, filter } })
      },

      setTreeSearch: (search) => {
        const state = get()
        if (state.disposed) return
        set({ tree: { ...state.tree, search } })
      },

      selectTreeEntry: (entryId) => {
        const state = get()
        if (state.disposed) return
        set({ tree: { ...state.tree, selectedEntryId: entryId } })
      },

      beginTreeNavigation: (node) => {
        const state = get()
        const threadId = state.tree.threadId
        if (state.disposed || !threadId) return
        const draft = currentDraft({ kind: 'thread', threadId }).draft
        const draftNonEmpty = (draft?.text.trim().length ?? 0) > 0
        set({
          tree: {
            ...state.tree,
            selectedEntryId: node.entryId,
            error: undefined,
            notice: undefined,
          },
          treeNavigation: {
            node,
            mode: 'none',
            instructions: '',
            replaceInstructions: false,
            replaceDraft: draftNonEmpty,
            draftNonEmpty,
          },
        })
      },

      setTreeNavigationMode: (mode) => {
        const state = get()
        if (state.disposed || !state.treeNavigation) return
        set({ treeNavigation: { ...state.treeNavigation, mode } })
      },

      setTreeNavigationInstructions: (instructions) => {
        const state = get()
        if (state.disposed || !state.treeNavigation) return
        set({ treeNavigation: { ...state.treeNavigation, instructions } })
      },

      setTreeNavigationReplaceInstructions: (replaceInstructions) => {
        const state = get()
        if (state.disposed || !state.treeNavigation) return
        set({ treeNavigation: { ...state.treeNavigation, replaceInstructions } })
      },

      setTreeNavigationReplaceDraft: (replaceDraft) => {
        const state = get()
        if (state.disposed || !state.treeNavigation) return
        set({ treeNavigation: { ...state.treeNavigation, replaceDraft } })
      },

      cancelTreeNavigationForm: () => {
        if (get().disposed) return
        set({ treeNavigation: undefined })
      },

      confirmTreeNavigation: async () => {
        const state = get()
        const form = state.treeNavigation
        const tree = state.tree.tree
        if (state.disposed || !form || !tree) return undefined
        const result = await get().navigateTree({
          targetId: form.node.entryId,
          expectedRevision: tree.revision,
          ...(form.mode !== 'none' ? { summarize: true } : {}),
          ...(form.mode !== 'none' && form.instructions.trim()
            ? { customInstructions: form.instructions.trim() }
            : {}),
          ...(form.mode === 'custom' && form.replaceInstructions
            ? { replaceInstructions: true }
            : {}),
          ...(form.replaceDraft ? { replaceDraft: true } : {}),
        })
        const current = get()
        if (current.disposed) return result
        if (result.status === 'applied' || result.status === 'conflict') {
          set({ treeNavigation: undefined })
        }
        return result
      },

      navigateTree: async (input) => {
        const state = get()
        if (state.disposed) return { status: 'failed', message: '实例已销毁。' }
        const panel = state.tree
        const threadId = panel.threadId
        if (!threadId) return { status: 'failed', message: '没有打开会话树。' }
        if (panel.busy) return { status: 'busy', message: '会话树操作正在进行中。' }

        const windowBefore = browser.windowStore.getState()
        const originSelectionRevision = windowBefore.selectionRevision
        const sourceTarget: HarnessDraftTarget = { kind: 'thread', threadId }
        const { draftId, draft } = currentDraft(sourceTarget)
        const draftRevision = draft?.revision ?? 0
        const draftText = draft?.text ?? ''
        const metadata = browser.serviceStore.getState().threadsById[threadId]
        const running =
          input.stopRunning ??
          (metadata?.status === 'running' ||
            metadata?.compactionActive === true ||
            metadata?.retryActive === true)
        const localRecovered = running
          ? browser.sessionActions.cancelPendingQueue(threadId)
          : { steering: [], followUp: [] }
        const hasLocal = localRecovered.steering.length > 0 || localRecovered.followUp.length > 0

        set({ tree: { ...get().tree, busy: true, error: undefined, notice: undefined } })
        let result: HarnessTreeNavigateResult
        try {
          result = await client.navigateThreadTree(threadId, {
            targetId: input.targetId,
            expectedRevision: input.expectedRevision,
            ...(input.summarize ? { summarize: true } : {}),
            ...(input.summarize && input.customInstructions?.trim()
              ? { customInstructions: input.customInstructions.trim() }
              : {}),
            ...(input.replaceInstructions ? { replaceInstructions: true } : {}),
            ...(running ? { stopRunning: true } : {}),
          })
        } catch (error) {
          const message = errorText(error)
          const current = get()
          if (!current.disposed && current.tree.epoch === panel.epoch) {
            set({ tree: { ...current.tree, busy: false, error: message } })
          }
          return {
            status: 'failed',
            message,
            ...(hasLocal ? { recoveredQueue: localRecovered } : {}),
          }
        }

        if (result.snapshot) {
          browser.serviceStore.getState().applyThreadSnapshot(threadId, result.snapshot)
        }
        const recoveredQueue = mergeRecoveredQueue(
          result.recoveredQueue,
          hasLocal ? localRecovered : undefined,
        )
        if (recoveredQueue) result = { ...result, recoveredQueue }

        const current = get()
        const panelCurrent =
          !current.disposed && current.tree.epoch === panel.epoch && current.tree.open
        if (panelCurrent) {
          set({
            tree: {
              ...current.tree,
              busy: false,
              ...(result.status === 'applied'
                ? {
                    notice: result.summaryCommitted
                      ? '已跳转，并已写入分支摘要。'
                      : '已跳转到所选节点。',
                  }
                : result.status === 'conflict'
                  ? { error: '会话树已变化，已刷新，请重新选择。' }
                  : result.status === 'aborted'
                    ? { notice: '分支摘要已取消，活动落点未改变。' }
                    : { error: result.message ?? '导航未完成。' }),
              ...(recoveredQueue ? { recoveredQueue } : {}),
            },
          })
        }

        if (result.status === 'applied') {
          const windowNow = browser.windowStore.getState()
          const draftNow = windowNow.draftsById[draftId]
          const originValid =
            windowNow.selectionRevision === originSelectionRevision &&
            selectionIs(sourceTarget) &&
            panelCurrent &&
            draftNow?.revision === draftRevision
          if (originValid) {
            const desired =
              result.editorText === undefined
                ? input.replaceDraft
                  ? ''
                  : draftText
                : input.replaceDraft || draftText.trim() === ''
                  ? result.editorText
                  : draftText
            if (desired !== draftText) {
              browser.windowStore.getState().setDraftTextIfRevision(draftId, draftRevision, desired)
            }
          }
        }

        if (panelCurrent) void get().refreshTree()
        return result
      },

      beginTreeLabel: (entryId) => {
        const state = get()
        if (state.disposed) return
        const node = state.tree.tree?.nodes.find((item) => item.entryId === entryId)
        set({
          tree: { ...state.tree, selectedEntryId: entryId, error: undefined },
          treeLabel: { entryId, value: node?.label ?? '' },
        })
      },

      setTreeLabelValue: (value) => {
        const state = get()
        if (state.disposed || !state.treeLabel) return
        set({ treeLabel: { ...state.treeLabel, value } })
      },

      cancelTreeLabel: () => {
        if (get().disposed) return
        set({ treeLabel: undefined })
      },

      saveTreeLabel: async () => {
        const state = get()
        const form = state.treeLabel
        const tree = state.tree.tree
        if (state.disposed || !form || !tree) return undefined
        const result = await get().setTreeLabel({
          entryId: form.entryId,
          ...(form.value.trim() ? { label: form.value.trim() } : {}),
          expectedRevision: tree.revision,
        })
        if (!get().disposed && result?.status === 'applied') set({ treeLabel: undefined })
        return result
      },

      setTreeLabel: async (input) => {
        const state = get()
        if (state.disposed) return undefined
        const panel = state.tree
        const threadId = panel.threadId
        if (!threadId || panel.busy) return undefined
        set({ tree: { ...get().tree, busy: true, error: undefined, notice: undefined } })
        try {
          const result = await client.setThreadEntryLabel(threadId, input)
          if (result.snapshot) {
            browser.serviceStore.getState().applyThreadSnapshot(threadId, result.snapshot)
          }
          const current = get()
          if (!current.disposed && current.tree.epoch === panel.epoch) {
            set({
              tree: {
                ...current.tree,
                busy: false,
                ...(result.status === 'applied'
                  ? result.persistence === 'failed'
                    ? { error: result.message ?? '标签已写入，但落点水位更新失败。' }
                    : { notice: '标签已保存。' }
                  : { error: result.message ?? '保存标签失败。' }),
              },
            })
            void get().refreshTree()
          }
          return result
        } catch (error) {
          const current = get()
          if (!current.disposed && current.tree.epoch === panel.epoch) {
            set({ tree: { ...current.tree, busy: false, error: errorText(error) } })
          }
          return undefined
        }
      },

      cancelTreeNavigation: async () => {
        const state = get()
        if (state.disposed) return
        const threadId = state.tree.threadId
        if (!threadId) return
        try {
          const result = await client.cancelThreadTreeNavigation(threadId)
          const current = get()
          if (!current.disposed && current.tree.threadId === threadId) {
            set({
              tree: {
                ...current.tree,
                notice:
                  result.status === 'cancelled'
                    ? '正在取消分支摘要…'
                    : '当前没有可取消的分支摘要。',
              },
            })
          }
        } catch (error) {
          const current = get()
          if (!current.disposed) {
            set({ tree: { ...current.tree, error: errorText(error) } })
          }
        }
      },

      dismissRecoveredQueue: () => {
        const state = get()
        if (state.disposed) return
        set({ tree: { ...state.tree, recoveredQueue: undefined } })
      },

      restoreRecoveredQueueItem: (text) => {
        const state = get()
        const threadId = state.tree.threadId
        if (state.disposed || !threadId || !text) return false
        const { draftId, draft } = currentDraft({ kind: 'thread', threadId })
        if (!draft) return false
        const next = draft.text.trim() ? `${draft.text}\n\n${text}` : text
        const applied = browser.windowStore
          .getState()
          .setDraftTextIfRevision(draftId, draft.revision, next)
        if (!applied) {
          set({ tree: { ...state.tree, error: '输入框内容已变化，取回文本未覆盖；请重试。' } })
        }
        return applied
      },

      openImport: (input) => {
        const state = get()
        if (state.disposed) return
        importPanelCounter += 1
        importFileRead += 1
        const path = input?.path ?? ''
        const source = importSourceOf('path', path, undefined)
        set({
          importPanel: {
            ...emptyImportPanel(`import-${importPanelCounter}`),
            epoch: state.importPanel.epoch + 1,
            open: true,
            path,
            source,
            ...(input?.workspaceId ? { workspaceId: input.workspaceId } : {}),
          },
        })
      },

      closeImport: () => {
        const state = get()
        if (state.disposed) return
        importFileRead += 1
        set({
          importPanel: {
            ...state.importPanel,
            epoch: state.importPanel.epoch + 1,
            open: false,
            busy: false,
            fileReading: false,
            fileError: undefined,
            error: undefined,
            trustPath: undefined,
          },
        })
      },

      configureImport: (input) => {
        const state = get()
        if (state.disposed) return
        const panel = state.importPanel
        // 任何来源/目标变化都推进 epoch，旧预览与在途结果失效。
        const mode = input.source?.kind === 'upload' ? 'upload' : panel.mode
        const path = input.source?.kind === 'path' ? input.source.path : panel.path
        const upload =
          input.source?.kind === 'upload'
            ? { filename: input.source.filename, content: input.source.content }
            : panel.upload
        const source = input.source !== undefined ? input.source : panel.source
        importFileRead += 1
        set({
          importPanel: {
            ...panel,
            epoch: panel.epoch + 1,
            mode,
            path,
            upload,
            source,
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
            ...(input.cwdOverride !== undefined ? { cwdOverride: input.cwdOverride } : {}),
            preview: undefined,
            copyConfirmed: false,
            fileReading: false,
            fileError: undefined,
            busy: false,
            error: undefined,
            notice: undefined,
            trustPath: undefined,
            importedThreadId: undefined,
          },
        })
      },

      setImportMode: (mode) => {
        const state = get()
        if (state.disposed) return
        const panel = state.importPanel
        if (panel.mode === mode) return
        const source = importSourceOf(mode, panel.path, panel.upload)
        importFileRead += 1
        set({
          importPanel: {
            ...panel,
            epoch: panel.epoch + 1,
            mode,
            source,
            preview: undefined,
            copyConfirmed: false,
            fileReading: false,
            fileError: undefined,
            busy: false,
            error: undefined,
            notice: undefined,
            trustPath: undefined,
            importedThreadId: undefined,
          },
        })
      },

      setImportPath: (path) => {
        const state = get()
        if (state.disposed) return
        const panel = state.importPanel
        const source = importSourceOf('path', path, panel.upload)
        importFileRead += 1
        set({
          importPanel: {
            ...panel,
            epoch: panel.epoch + 1,
            mode: 'path',
            path,
            source,
            preview: undefined,
            copyConfirmed: false,
            fileReading: false,
            fileError: undefined,
            busy: false,
            error: undefined,
            notice: undefined,
            trustPath: undefined,
            importedThreadId: undefined,
          },
        })
      },

      readImportFile: async (file) => {
        const state = get()
        if (state.disposed || !state.importPanel.open) return
        const panel = state.importPanel
        const read = ++importFileRead
        const epoch = panel.epoch + 1
        // 读取本身即是新来源：先推进 epoch，旧预览/旧读取结果立即失效。
        set({
          importPanel: {
            ...panel,
            epoch,
            mode: 'upload',
            upload: undefined,
            source: undefined,
            preview: undefined,
            copyConfirmed: false,
            fileReading: Boolean(file),
            fileError: undefined,
            busy: false,
            error: undefined,
            notice: undefined,
            trustPath: undefined,
            importedThreadId: undefined,
          },
        })
        if (!file) return
        if (file.size > IMPORT_UPLOAD_LIMIT) {
          if (read !== importFileRead || get().disposed) return
          set({
            importPanel: {
              ...get().importPanel,
              fileReading: false,
              fileError: '文件超过 20MiB 上限，无法导入。',
            },
          })
          return
        }
        try {
          const content = await file.text()
          const current = get()
          if (
            current.disposed ||
            read !== importFileRead ||
            !current.importPanel.open ||
            current.importPanel.epoch !== epoch
          ) {
            return
          }
          if (content.length > IMPORT_UPLOAD_LIMIT) {
            set({
              importPanel: {
                ...current.importPanel,
                fileReading: false,
                fileError: '文件超过 20MiB 上限，无法导入。',
              },
            })
            return
          }
          const upload = { filename: file.name, content }
          set({
            importPanel: {
              ...current.importPanel,
              fileReading: false,
              fileError: undefined,
              upload,
              source: { kind: 'upload', filename: upload.filename, content: upload.content },
              preview: undefined,
              copyConfirmed: false,
              error: undefined,
              notice: undefined,
            },
          })
        } catch (error) {
          const current = get()
          if (current.disposed || read !== importFileRead || current.importPanel.epoch !== epoch) {
            return
          }
          set({
            importPanel: {
              ...current.importPanel,
              fileReading: false,
              fileError: errorText(error),
            },
          })
        }
      },

      setImportCopyConfirmed: (copyConfirmed) => {
        const state = get()
        if (state.disposed) return
        set({ importPanel: { ...state.importPanel, copyConfirmed } })
      },

      openExistingImport: () => {
        const state = get()
        const threadId = state.importPanel.preview?.existingThreadId
        if (state.disposed || !threadId) return false
        browser.windowStore.getState().selectTarget({ kind: 'thread', threadId })
        get().closeImport()
        return true
      },

      openImportedThread: () => {
        const state = get()
        const threadId = state.importPanel.importedThreadId
        if (state.disposed || !threadId) return false
        browser.windowStore.getState().selectTarget({ kind: 'thread', threadId })
        get().closeImport()
        return true
      },

      previewImport: async () => {
        const state = get()
        if (state.disposed) return undefined
        const panel = state.importPanel
        if (!panel.open || !panel.source || !panel.workspaceId || panel.busy || panel.fileReading) {
          return undefined
        }
        const epoch = panel.epoch
        const sourceKey = importSourceKey(panel.source, panel.workspaceId, panel.cwdOverride)
        set({
          importPanel: { ...get().importPanel, busy: true, error: undefined, notice: undefined },
        })
        try {
          const preview = await client.previewThreadImport({
            source: panel.source,
            workspaceId: panel.workspaceId,
            ...(panel.cwdOverride ? { cwdOverride: panel.cwdOverride } : {}),
          })
          const current = get()
          if (current.disposed) return undefined
          const currentPanel = current.importPanel
          if (
            currentPanel.epoch !== epoch ||
            importSourceKey(
              currentPanel.source,
              currentPanel.workspaceId,
              currentPanel.cwdOverride,
            ) !== sourceKey
          ) {
            return undefined
          }
          set({
            importPanel: {
              ...currentPanel,
              busy: false,
              preview,
              // 新预览需要重新确认冲突副本，不复用上一次勾选。
              copyConfirmed: false,
              ...(preview.status !== 'ok'
                ? { error: preview.message ?? '导入预览失败。' }
                : { error: undefined }),
            },
          })
          return preview
        } catch (error) {
          const current = get()
          if (!current.disposed && current.importPanel.epoch === epoch) {
            set({ importPanel: { ...current.importPanel, busy: false, error: errorText(error) } })
          }
          return undefined
        }
      },

      confirmImport: async (confirmOptions) => {
        const state = get()
        if (state.disposed) return undefined
        const panel = state.importPanel
        const { preview, source, workspaceId } = panel
        if (
          panel.busy ||
          !source ||
          !workspaceId ||
          !preview ||
          preview.status !== 'ok' ||
          !preview.cwd
        ) {
          return undefined
        }
        const asCopy = confirmOptions?.asCopy === true || panel.copyConfirmed
        if (preview.conflict === 'conflict' && !asCopy) {
          set({
            importPanel: {
              ...panel,
              error: '同 ID 会话内容不同；请先勾选“作为独立副本导入”。',
            },
          })
          return undefined
        }
        const epoch = panel.epoch
        const sourceId = preview.source?.id
        const fingerprint = preview.source?.fingerprint
        set({
          importPanel: {
            ...get().importPanel,
            busy: true,
            error: undefined,
            notice: undefined,
            trustPath: undefined,
            importedThreadId: undefined,
          },
        })

        try {
          // 与新建一致的信任入口：未信任时先交 R6 的信任决定，再重新确认导入。
          const project = await client.getProject({ path: preview.cwd })
          if (project.status === 'needs-trust') {
            const current = get()
            if (!current.disposed && current.importPanel.epoch === epoch) {
              set({
                importPanel: {
                  ...current.importPanel,
                  busy: false,
                  trustPath: preview.cwd,
                  error: '目标项目尚未信任；请先完成信任决定再导入。',
                },
              })
            }
            return undefined
          }
          if (project.status === 'failed') {
            const current = get()
            if (!current.disposed && current.importPanel.epoch === epoch) {
              set({
                importPanel: {
                  ...current.importPanel,
                  busy: false,
                  error: '目标项目装配失败，请检查路径与宿主诊断。',
                },
              })
            }
            return undefined
          }

          if (get().disposed || get().importPanel.epoch !== epoch) return undefined
          const result = await client.importThread({
            source,
            workspaceId,
            ...(panel.cwdOverride ? { cwdOverride: panel.cwdOverride } : {}),
            ...(asCopy ? { asCopy: true } : {}),
            ...(sourceId ? { expectedSourceId: sourceId } : {}),
            ...(fingerprint ? { expectedSourceFingerprint: fingerprint } : {}),
          })
          // 目录成功写入后立即可见；不隐式替换当前会话。
          if (
            result.threadId ||
            result.status === 'imported' ||
            result.status === 'metadata-failed'
          ) {
            await refreshDirectory()
          }
          const latest = get()
          if (!latest.disposed && latest.importPanel.epoch === epoch) {
            set({
              importPanel: {
                ...latest.importPanel,
                busy: false,
                ...(result.preview ? { preview: result.preview, copyConfirmed: false } : {}),
                ...(result.threadId ? { importedThreadId: result.threadId } : {}),
                ...(result.status === 'imported'
                  ? { notice: result.message ?? '会话已导入。' }
                  : { error: result.message ?? '导入未完成。' }),
              },
            })
          }
          return result
        } catch (error) {
          const current = get()
          if (!current.disposed && current.importPanel.epoch === epoch) {
            set({ importPanel: { ...current.importPanel, busy: false, error: errorText(error) } })
          }
          return undefined
        }
      },

      forkThread: async (input) => {
        const state = get()
        if (state.disposed) return { status: 'failed', message: '实例已销毁。' }
        const sourceTarget: HarnessDraftTarget = { kind: 'thread', threadId: input.threadId }
        const sourceRevision = currentDraft(sourceTarget).draft?.revision
        const originSelectionRevision = browser.windowStore.getState().selectionRevision
        let result: HarnessThreadForkResult
        try {
          result = await client.forkThread(input.threadId, {
            ...(input.entryId ? { entryId: input.entryId } : {}),
            position: input.position,
            ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
          })
        } catch (error) {
          return { status: 'failed', message: errorText(error) }
        }

        if (result.status !== 'created' || !result.threadId) return result
        const childId = result.threadId
        if (result.snapshot) {
          browser.serviceStore.getState().applyThreadSnapshot(childId, result.snapshot)
        }
        await refreshDirectory()

        if (get().disposed) return result
        const windowNow = browser.windowStore.getState()
        const sourceStillSelected =
          currentDraft(sourceTarget).draft?.revision === sourceRevision &&
          windowNow.selectionRevision === originSelectionRevision &&
          selectionIs(sourceTarget)
        if (!sourceStillSelected) return result

        browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: childId })
        if (input.position === 'before' && result.selectedText !== undefined) {
          const childDraftId = draftIdOf({ kind: 'thread', threadId: childId })
          const childDraft = browser.windowStore.getState().draftsById[childDraftId]
          // 只填充从未编辑过的子会话草稿；已有草稿不因迟到成功被覆盖。
          if (childDraft?.revision === 0 && childDraft.text === '') {
            browser.windowStore
              .getState()
              .setDraftTextIfRevision(childDraftId, 0, result.selectedText)
          }
        }
        return result
      },

      openFork: (input) => {
        const state = get()
        if (state.disposed) return
        set({
          forkPanel: {
            open: true,
            sourceThreadId: input.threadId,
            position: input.position,
            entryId: input.entryId,
            expectedRevision:
              browser.serviceStore.getState().threadsById[input.threadId]?.treeRevision,
            busy: false,
            stopping: false,
            error: undefined,
          },
        })
      },

      closeFork: () => {
        const state = get()
        if (state.disposed) return
        set({
          forkPanel: {
            ...state.forkPanel,
            open: false,
            sourceThreadId: undefined,
            entryId: undefined,
            expectedRevision: undefined,
            busy: false,
            stopping: false,
            error: undefined,
          },
        })
      },

      stopForkSource: async () => {
        const state = get()
        const threadId = state.forkPanel.sourceThreadId
        if (state.disposed || !threadId || state.forkPanel.stopping) return
        set({ forkPanel: { ...state.forkPanel, stopping: true, error: undefined } })
        const outcome = await browser.sessionActions.stop(threadId)
        const current = get()
        if (current.disposed || current.forkPanel.sourceThreadId !== threadId) return
        set({
          forkPanel: {
            ...current.forkPanel,
            stopping: false,
            ...(outcome.status === 'failed'
              ? { error: outcome.message ?? '停止运行失败，请重试。' }
              : {}),
          },
        })
      },

      confirmFork: async () => {
        const state = get()
        const panel = state.forkPanel
        if (state.disposed || !panel.open || !panel.sourceThreadId || panel.busy) {
          return undefined
        }
        const threadId = panel.sourceThreadId
        set({ forkPanel: { ...panel, busy: true, error: undefined } })
        const result = await get().forkThread({
          threadId,
          position: panel.position,
          ...(panel.entryId ? { entryId: panel.entryId } : {}),
          ...(panel.expectedRevision ? { expectedRevision: panel.expectedRevision } : {}),
        })
        const current = get()
        if (current.disposed || current.forkPanel.sourceThreadId !== threadId) return result
        if (result.status === 'created') {
          set({
            forkPanel: {
              ...current.forkPanel,
              open: false,
              sourceThreadId: undefined,
              entryId: undefined,
              expectedRevision: undefined,
              busy: false,
              stopping: false,
              error: undefined,
            },
          })
          if (panel.position === 'before') notify('已从所选用户消息创建独立分支。')
          else notify('已克隆为独立会话。')
          return result
        }
        set({
          forkPanel: {
            ...current.forkPanel,
            busy: false,
            error:
              result.status === 'conflict'
                ? '会话树已变化，请刷新会话树后重试。'
                : (result.message ?? '分叉失败，未创建子会话。'),
          },
        })
        return result
      },

      consumeEditorDirective: async (threadId, cursor) => {
        const state = get()
        if (state.disposed) return false
        const session = browser.serviceStore.getState().sessionDataById[threadId]
        const directive = session?.hostUi?.editorDirective
        if (!directive) return false
        if (directive.callerId && directive.callerId !== browser.windowId) return false

        const windowBefore = browser.windowStore.getState()
        const originSelectionRevision = windowBefore.selectionRevision
        const sourceTarget: HarnessDraftTarget = { kind: 'thread', threadId }
        const { draftId, draft } = currentDraft(sourceTarget)
        const draftRevision = draft?.revision ?? 0
        const currentText = draft?.text ?? ''
        const position = Math.min(Math.max(cursor ?? currentText.length, 0), currentText.length)
        const nextText =
          directive.mode === 'paste'
            ? `${currentText.slice(0, position)}${directive.text}${currentText.slice(position)}`
            : directive.text

        let accepted = false
        try {
          accepted = await client.consumeHostUiDirective(threadId, directive.id)
        } catch {
          return false
        }
        if (get().disposed || !accepted) return false

        const windowNow = browser.windowStore.getState()
        const draftNow = windowNow.draftsById[draftId]
        const originValid =
          windowNow.selectionRevision === originSelectionRevision &&
          selectionIs(sourceTarget) &&
          draftNow?.revision === draftRevision
        if (!originValid) {
          set({
            pendingEditorDirective: {
              threadId,
              text: directive.text,
              mode: directive.mode,
              cursor: position,
              draftRevision,
            },
          })
          return true
        }

        const applied = browser.windowStore
          .getState()
          .setDraftTextIfRevision(draftId, draftRevision, nextText)
        if (!applied) {
          set({
            pendingEditorDirective: {
              threadId,
              text: directive.text,
              mode: directive.mode,
              cursor: position,
              draftRevision,
            },
          })
          return true
        }
        set({
          editorRecovery: {
            threadId,
            draftId,
            previousText: currentText,
            appliedRevision:
              browser.windowStore.getState().draftsById[draftId]?.revision ?? draftRevision + 1,
          },
          pendingEditorDirective: undefined,
        })
        return true
      },

      discardEditorDirective: async (threadId) => {
        const state = get()
        if (state.disposed) return false
        const directive =
          browser.serviceStore.getState().sessionDataById[threadId]?.hostUi?.editorDirective
        if (!directive) return false
        if (directive.callerId && directive.callerId !== browser.windowId) return false
        try {
          return await client.consumeHostUiDirective(threadId, directive.id)
        } catch {
          return false
        }
      },

      applyPendingEditorDirective: () => {
        const state = get()
        if (state.disposed) return false
        const pending = state.pendingEditorDirective
        if (!pending) return false
        const sourceTarget: HarnessDraftTarget = { kind: 'thread', threadId: pending.threadId }
        if (!selectionIs(sourceTarget)) return false
        const { draftId, draft } = currentDraft(sourceTarget)
        if (!draft || draft.revision !== pending.draftRevision) return false
        const nextText =
          pending.mode === 'paste'
            ? `${draft.text.slice(0, pending.cursor)}${pending.text}${draft.text.slice(pending.cursor)}`
            : pending.text
        if (
          !browser.windowStore
            .getState()
            .setDraftTextIfRevision(draftId, pending.draftRevision, nextText)
        ) {
          return false
        }
        set({
          editorRecovery: {
            threadId: pending.threadId,
            draftId,
            previousText: draft.text,
            appliedRevision:
              browser.windowStore.getState().draftsById[draftId]?.revision ??
              pending.draftRevision + 1,
          },
          pendingEditorDirective: undefined,
        })
        return true
      },

      restoreEditorPrevious: () => {
        const state = get()
        if (state.disposed || !state.editorRecovery) return false
        const recovery = state.editorRecovery
        const draft = browser.windowStore.getState().draftsById[recovery.draftId]
        if (!draft || draft.revision !== recovery.appliedRevision) return false
        if (
          !browser.windowStore
            .getState()
            .setDraftTextIfRevision(
              recovery.draftId,
              recovery.appliedRevision,
              recovery.previousText,
            )
        ) {
          return false
        }
        set({ editorRecovery: undefined })
        return true
      },

      consumeCommandTarget: async (threadId) => {
        const state = get()
        if (state.disposed) return false
        const session = browser.serviceStore.getState().sessionDataById[threadId]
        const target = session?.hostUi?.commandTarget
        if (!target) return false
        if (target.callerId && target.callerId !== browser.windowId) return false

        const originSelectionRevision = browser.windowStore.getState().selectionRevision
        let accepted = false
        try {
          accepted = await client.consumeHostUiDirective(threadId, target.id)
        } catch {
          return false
        }
        if (get().disposed || !accepted) return false
        await refreshDirectory()
        if (get().disposed) return false

        const windowNow = browser.windowStore.getState()
        if (windowNow.selectionRevision !== originSelectionRevision) {
          set({
            pendingCommandTarget: {
              threadId: target.threadId,
              editorText: target.editorText,
            },
          })
          return true
        }

        browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: target.threadId })
        if (target.editorText !== undefined) {
          const targetDraftId = draftIdOf({ kind: 'thread', threadId: target.threadId })
          const targetDraft = browser.windowStore.getState().draftsById[targetDraftId]
          // 只填充从未编辑过的目标草稿；不覆盖用户后来输入。
          if (targetDraft?.revision === 0 && targetDraft.text === '') {
            browser.windowStore
              .getState()
              .setDraftTextIfRevision(targetDraftId, 0, target.editorText)
          }
        }
        set({ pendingCommandTarget: undefined })
        return true
      },

      dismissCommandTarget: async (threadId) => {
        const state = get()
        if (state.disposed) return false
        const target =
          browser.serviceStore.getState().sessionDataById[threadId]?.hostUi?.commandTarget
        if (!target) return false
        if (target.callerId && target.callerId !== browser.windowId) return false
        try {
          return await client.consumeHostUiDirective(threadId, target.id)
        } catch {
          return false
        }
      },

      applyPendingCommandTarget: () => {
        const state = get()
        if (state.disposed || !state.pendingCommandTarget) return false
        const pending = state.pendingCommandTarget
        browser.windowStore.getState().selectTarget({ kind: 'thread', threadId: pending.threadId })
        if (pending.editorText !== undefined) {
          const targetDraftId = draftIdOf({ kind: 'thread', threadId: pending.threadId })
          const targetDraft = browser.windowStore.getState().draftsById[targetDraftId]
          if (targetDraft?.revision === 0 && targetDraft.text === '') {
            browser.windowStore
              .getState()
              .setDraftTextIfRevision(targetDraftId, 0, pending.editorText)
          }
        }
        set({ pendingCommandTarget: undefined })
        return true
      },

      openDetails: async (threadId) => {
        const state = get()
        if (state.disposed) return
        const metadata = browser.serviceStore.getState().threadsById[threadId]
        const epoch = state.details.epoch + 1
        set({
          details: {
            ...emptyDetailsPanel(),
            open: true,
            threadId,
            epoch,
            loading: true,
            renameValue: metadata?.name ?? metadata?.title ?? '',
          },
        })
        await get().refreshDetails()
      },

      refreshDetails: async () => {
        const state = get()
        const threadId = state.details.threadId
        if (state.disposed || !state.details.open || !threadId) return
        const request = ++detailsRequest
        const epoch = state.details.epoch
        set({ details: { ...get().details, loading: true, error: undefined } })
        try {
          const details = await client.getThreadDetails(threadId)
          const current = get()
          if (
            current.disposed ||
            request !== detailsRequest ||
            !current.details.open ||
            current.details.threadId !== threadId ||
            current.details.epoch !== epoch
          ) {
            return
          }
          set({
            details: {
              ...current.details,
              loading: false,
              details,
              error: undefined,
              renameValue: current.details.renameValue
                ? current.details.renameValue
                : (details.metadata.name ?? details.metadata.title ?? ''),
            },
          })
        } catch (error) {
          const current = get()
          if (
            current.disposed ||
            request !== detailsRequest ||
            !current.details.open ||
            current.details.threadId !== threadId
          ) {
            return
          }
          set({ details: { ...current.details, loading: false, error: errorText(error) } })
        }
      },

      closeDetails: () => {
        const state = get()
        if (state.disposed) return
        detailsRequest += 1
        set({
          details: {
            ...emptyDetailsPanel(),
            epoch: state.details.epoch + 1,
          },
          deleteConfirm: emptyDeletePanel(),
          assign: emptyAssignPanel(),
        })
      },

      setRenameValue: (renameValue) => {
        const state = get()
        if (state.disposed || !state.details.open) return
        set({ details: { ...state.details, renameValue, renameError: undefined } })
      },

      renameCurrentThread: async () => {
        const state = get()
        const panel = state.details
        const threadId = panel.threadId
        if (state.disposed || !panel.open || !threadId || panel.renameBusy) return
        const value = panel.renameValue.trim()
        if (!value) {
          set({ details: { ...panel, renameError: '会话名称不能为空。' } })
          return
        }
        set({ details: { ...panel, renameBusy: true, renameError: undefined } })
        try {
          await client.renameThread(threadId, value)
          await refreshDirectory()
          const current = get()
          if (current.disposed || current.details.threadId !== threadId) return
          set({
            details: {
              ...current.details,
              renameBusy: false,
              renameValue:
                current.details.renameValue.trim() === value ? value : current.details.renameValue,
              notice: '会话已命名。',
            },
          })
          notify('会话已命名。')
        } catch (error) {
          const current = get()
          if (current.disposed || current.details.threadId !== threadId) return
          set({
            details: {
              ...current.details,
              renameBusy: false,
              renameError: errorText(error),
            },
          })
        }
      },

      toggleArchiveCurrent: async () => {
        const state = get()
        const panel = state.details
        const threadId = panel.threadId
        const metadata = threadId
          ? browser.serviceStore.getState().threadsById[threadId]
          : undefined
        if (state.disposed || !panel.open || !threadId || panel.actionBusy) return
        set({ details: { ...panel, actionBusy: true, actionError: undefined } })
        await get().setThreadArchived(threadId, metadata?.archived !== true)
        const current = get()
        if (current.disposed || current.details.threadId !== threadId) return
        const failed = current.details.actionError !== undefined
        set({
          details: {
            ...current.details,
            actionBusy: false,
            ...(failed ? {} : { notice: metadata?.archived ? '会话已取消归档。' : '会话已归档。' }),
          },
        })
      },

      setThreadArchived: async (threadId, archived) => {
        const state = get()
        if (state.disposed || state.archiveBusy === threadId) return
        set({ archiveBusy: threadId })
        try {
          if (archived) await client.archiveThread(threadId)
          else await client.unarchiveThread(threadId)
          await refreshDirectory()
          const current = get()
          if (current.disposed) return
          set({
            archiveBusy: undefined,
            ...(current.details.threadId === threadId
              ? { details: { ...current.details, actionError: undefined } }
              : {}),
          })
          if (current.details.open && current.details.threadId === threadId) {
            void get().refreshDetails()
          }
          notify(archived ? '会话已归档。' : '会话已取消归档。')
        } catch (error) {
          const current = get()
          if (current.disposed) return
          const message = errorText(error)
          set({
            archiveBusy: undefined,
            ...(current.details.threadId === threadId
              ? { details: { ...current.details, actionError: message } }
              : {}),
          })
          notify(`归档状态更新失败：${message}`)
        }
      },

      openDelete: (threadId) => {
        const state = get()
        if (state.disposed) return
        set({ deleteConfirm: { open: true, threadId, busy: false, error: undefined } })
      },

      closeDelete: () => {
        const state = get()
        if (state.disposed) return
        set({ deleteConfirm: emptyDeletePanel() })
      },

      confirmDelete: async () => {
        const state = get()
        const panel = state.deleteConfirm
        const threadId = panel.threadId
        if (state.disposed || !panel.open || !threadId || panel.busy) return
        set({ deleteConfirm: { ...panel, busy: true, error: undefined } })
        try {
          await client.deleteThread(threadId)
          const selection = browser.windowStore.getState().selection
          if (selection?.kind === 'thread' && selection.threadId === threadId) {
            browser.windowStore.getState().clearSelection()
          }
          await refreshDirectory()
          const current = get()
          if (current.disposed) return
          set({
            deleteConfirm: emptyDeletePanel(),
            details:
              current.details.threadId === threadId
                ? { ...emptyDetailsPanel(), epoch: current.details.epoch + 1 }
                : current.details,
          })
          notify('会话已删除。')
        } catch {
          const current = get()
          if (current.disposed || current.deleteConfirm.threadId !== threadId) return
          set({
            deleteConfirm: {
              ...current.deleteConfirm,
              busy: false,
              error: '删除失败：会话文件可能已删除，但元数据清理失败；请查看宿主诊断后重试。',
            },
          })
        }
      },

      openAssign: (threadId) => {
        const state = get()
        if (state.disposed) return
        const workspaceId = browser.serviceStore.getState().workspaceIds[0] ?? ''
        set({
          assign: { open: true, threadId, workspaceId, busy: false, error: undefined },
        })
      },

      setAssignWorkspace: (workspaceId) => {
        const state = get()
        if (state.disposed || !state.assign.open) return
        set({ assign: { ...state.assign, workspaceId, error: undefined } })
      },

      closeAssign: () => {
        const state = get()
        if (state.disposed) return
        set({ assign: emptyAssignPanel() })
      },

      confirmAssign: async () => {
        const state = get()
        const panel = state.assign
        if (state.disposed || !panel.open || !panel.threadId || panel.busy) return
        if (!panel.workspaceId) {
          set({ assign: { ...panel, error: '请选择目标工作区。' } })
          return
        }
        set({ assign: { ...panel, busy: true, error: undefined } })
        try {
          const result = await client.assignThreadWorkspace({
            threadId: panel.threadId,
            workspaceId: panel.workspaceId,
          })
          if (!result.ok) {
            const current = get()
            if (current.disposed || current.assign.threadId !== panel.threadId) return
            set({
              assign: {
                ...current.assign,
                busy: false,
                error:
                  result.error === 'state-unavailable'
                    ? '工作区元数据不可用，无法保存会话归属。'
                    : '工作区或会话已不存在，请刷新后重试。',
              },
            })
            return
          }
          await refreshDirectory()
          const current = get()
          if (current.disposed) return
          set({ assign: emptyAssignPanel() })
          notify('会话已加入工作区。')
        } catch (error) {
          const current = get()
          if (current.disposed || current.assign.threadId !== panel.threadId) return
          set({ assign: { ...current.assign, busy: false, error: errorText(error) } })
        }
      },

      dispose: () => {
        const state = get()
        if (state.disposed) return
        importFileRead += 1
        detailsRequest += 1
        set({
          tree: emptyTreePanel(state.tree.panelId),
          treeNavigation: undefined,
          treeLabel: undefined,
          importPanel: emptyImportPanel(state.importPanel.panelId),
          forkPanel: emptyForkPanel(),
          details: emptyDetailsPanel(),
          deleteConfirm: emptyDeletePanel(),
          assign: emptyAssignPanel(),
          archiveBusy: undefined,
          editorRecovery: undefined,
          pendingEditorDirective: undefined,
          pendingCommandTarget: undefined,
          disposed: true,
        })
      },
    }
  })
}
