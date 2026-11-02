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
  HarnessThreadForkPosition,
  HarnessThreadForkResult,
  HarnessThreadImportPreview,
  HarnessThreadImportResult,
  HarnessThreadImportSource,
  HarnessThreadTree,
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

/** 导入面板状态；预览固定源与 panelEpoch。 */
export interface SessionImportPanelState {
  panelId: string
  epoch: number
  open: boolean
  workspaceId: string | undefined
  source: HarnessThreadImportSource | undefined
  cwdOverride: string | undefined
  preview: HarnessThreadImportPreview | undefined
  busy: boolean
  error: string | undefined
  notice: string | undefined
  /** 需要用户先决定信任的项目路径；信任表单归 R6。 */
  trustPath: string | undefined
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
  importPanel: SessionImportPanelState
  editorRecovery: SessionEditorRecovery | undefined
  pendingEditorDirective: SessionPendingEditorDirective | undefined
  pendingCommandTarget: SessionPendingCommandTarget | undefined
  disposed: boolean

  openTree: (threadId: string) => void
  closeTree: () => void
  refreshTree: () => Promise<void>
  setTreeFilter: (filter: SessionTreeFilter) => void
  setTreeSearch: (search: string) => void
  selectTreeEntry: (entryId: string | undefined) => void
  navigateTree: (input: SessionTreeNavigateInput) => Promise<HarnessTreeNavigateResult>
  setTreeLabel: (input: SessionTreeLabelInput) => Promise<HarnessTreeLabelResult | undefined>
  cancelTreeNavigation: () => Promise<void>
  dismissRecoveredQueue: () => void

  openImport: (input?: { path?: string; workspaceId?: string }) => void
  closeImport: () => void
  configureImport: (input: SessionImportConfigInput) => void
  previewImport: () => Promise<HarnessThreadImportPreview | undefined>
  confirmImport: (options?: { asCopy?: boolean }) => Promise<HarnessThreadImportResult | undefined>

  forkThread: (input: SessionForkInput) => Promise<HarnessThreadForkResult>
  consumeEditorDirective: (threadId: string, cursor?: number) => Promise<boolean>
  applyPendingEditorDirective: () => boolean
  restoreEditorPrevious: () => boolean
  consumeCommandTarget: (threadId: string) => Promise<boolean>
  applyPendingCommandTarget: () => boolean

  dispose: () => void
}

export interface CreateSessionsFeatureStoreOptions {
  browser: HarnessBrowser
}

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
  source: undefined,
  cwdOverride: undefined,
  preview: undefined,
  busy: false,
  error: undefined,
  notice: undefined,
  trustPath: undefined,
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
  let treePanelCounter = 0
  let treeRequest = 0
  let importPanelCounter = 0

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
      importPanel: emptyImportPanel('import-0'),
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
        set({ tree: panel })
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
        })
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
                  ? { notice: '标签已保存。' }
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

      openImport: (input) => {
        const state = get()
        if (state.disposed) return
        importPanelCounter += 1
        set({
          importPanel: {
            ...emptyImportPanel(`import-${importPanelCounter}`),
            epoch: state.importPanel.epoch + 1,
            open: true,
            ...(input?.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input?.path ? { source: { kind: 'path', path: input.path } } : {}),
          },
        })
      },

      closeImport: () => {
        const state = get()
        if (state.disposed) return
        set({
          importPanel: {
            ...state.importPanel,
            epoch: state.importPanel.epoch + 1,
            open: false,
            busy: false,
            error: undefined,
          },
        })
      },

      configureImport: (input) => {
        const state = get()
        if (state.disposed) return
        const panel = state.importPanel
        // 任何来源/目标变化都推进 epoch，旧预览与在途结果失效。
        set({
          importPanel: {
            ...panel,
            epoch: panel.epoch + 1,
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.cwdOverride !== undefined ? { cwdOverride: input.cwdOverride } : {}),
            preview: undefined,
            busy: false,
            error: undefined,
            notice: undefined,
            trustPath: undefined,
          },
        })
      },

      previewImport: async () => {
        const state = get()
        if (state.disposed) return undefined
        const panel = state.importPanel
        if (!panel.open || !panel.source || !panel.workspaceId || panel.busy) return undefined
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
        const epoch = panel.epoch
        const sourceId = preview.source?.id
        const fingerprint = preview.source?.fingerprint
        set({
          importPanel: { ...get().importPanel, busy: true, error: undefined, notice: undefined },
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
            ...(preview.conflict === 'conflict' || confirmOptions?.asCopy ? { asCopy: true } : {}),
            ...(sourceId ? { expectedSourceId: sourceId } : {}),
            ...(fingerprint ? { expectedSourceFingerprint: fingerprint } : {}),
          })
          const current = get()
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
                ...(result.preview ? { preview: result.preview } : {}),
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
          windowNow.selectionRevision === originSelectionRevision && selectionIs(sourceTarget)
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

      dispose: () => {
        const state = get()
        if (state.disposed) return
        set({
          tree: emptyTreePanel(state.tree.panelId),
          importPanel: emptyImportPanel(state.importPanel.panelId),
          editorRecovery: undefined,
          pendingEditorDirective: undefined,
          pendingCommandTarget: undefined,
          disposed: true,
        })
      },
    }
  })
}
