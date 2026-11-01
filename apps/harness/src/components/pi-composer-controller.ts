/**
 * 会话输入控制器：命令路由、补全、草稿、历史、长输入与队列操作。
 *
 * 应用特有内置动作留在这一层；资源目录/参数补全/文件引用经公共 HTTP RPC
 * 查询宿主。普通输入仍交给 assistant-ui 的 composer，不另建第二套发送权威。
 */
import { useAui, useAuiState } from '@assistant-ui/react'
import type {
  HarnessCommandCatalog,
  HarnessFileReference,
  HarnessModelInfo,
  HarnessThinkingLevel,
} from '@huan/protocol'
import { parseLeadingSlashCommand } from '@huan/protocol'
import {
  useHarnessActions,
  useHarnessController,
  useHarnessSession,
  useHarnessThreadState,
} from '@huan/react'
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  type AppCommand,
  commandSourceLabel,
  commandStageLabel,
  findAppCommand,
  mergeCommandCatalog,
} from '@/components/pi-builtin-commands'
import { requestPiIntent } from '@/components/pi-command-intents'
import { takeComposerDraftOverride } from '@/components/pi-composer-draft-override'
import { harnessHttpClient } from '@/components/pi-http-client'
import {
  findCachedModel,
  getModelCatalogCache,
  setModelCatalogCache,
} from '@/components/pi-model-catalog'
import { getDraftModel, setDraftModel } from '@/components/pi-model-draft'
import { requestForkThread } from '@/components/session-fork-bridge'
import { useWorkspace } from '@/components/workspace-context'

const PENDING_THREAD_ID = '__pending__'
const MAX_HISTORY = 50

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 本窗口已提交的用户输入（跨会话，上限 50）。 */
const submissionHistory: string[] = []

const rememberSubmission = (text: string): void => {
  const normalized = text.trim()
  if (!normalized) return
  if (submissionHistory[0] === normalized) return
  submissionHistory.unshift(normalized)
  if (submissionHistory.length > MAX_HISTORY) submissionHistory.length = MAX_HISTORY
}

/** 测试/窗口重载可清理本窗口历史。 */
export const clearSubmissionHistory = (): void => {
  submissionHistory.length = 0
}

/** 从 assistant-ui 消息中取纯文本（用于历史与 /copy）。 */
function threadMessageText(message: { content?: unknown; role?: string }): string {
  if (typeof message.content === 'string') return message.content.trim()
  if (!Array.isArray(message.content)) return ''
  const chunks: string[] = []
  for (const part of message.content) {
    if (part !== null && typeof part === 'object') {
      const candidate = part as { type?: unknown; text?: unknown }
      if (candidate.type === 'text' && typeof candidate.text === 'string') {
        chunks.push(candidate.text)
      }
    }
  }
  return chunks.join('\n\n').trim()
}

const DRAFT_PREFIX = 'huan.composer-draft:'

const draftStorageKey = (scope: string, target: string): string =>
  `${DRAFT_PREFIX}${scope}:${target}`

const readDraft = (key: string): string => {
  try {
    return sessionStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

const writeDraft = (key: string, value: string): void => {
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch {
    // 存储不可用时只影响窗口恢复，不影响发送。
  }
}

const isPendingDraftKey = (key: string | undefined): boolean => key?.includes(':pending:') === true

/** 同一宿主作用域下的 pending→thread 迁移判定。 */
const canMigrateDraft = (previous: string | undefined, next: string): boolean => {
  if (!previous || !isPendingDraftKey(previous) || !next.includes(':thread:')) return false
  return (
    previous.slice(0, previous.indexOf(':pending:')) === next.slice(0, next.indexOf(':thread:'))
  )
}

export type ComposerCompletionKind = 'command' | 'argument' | 'file'

export type ComposerCompletionItem = {
  key: string
  label: string
  description?: string
  meta?: string
  insertText: string
  replaceStart: number
  replaceEnd: number
  command?: AppCommand
  file?: HarnessFileReference
}

export type ComposerCompletionState = {
  kind: ComposerCompletionKind
  items: readonly ComposerCompletionItem[]
  index: number
}

export type PiComposerController = {
  text: string
  isRunning: boolean
  queueMode: 'followUp' | 'steer'
  setQueueMode: (mode: 'followUp' | 'steer') => void
  queue: { steering: readonly string[]; followUp: readonly string[] }
  retrieveQueue: () => Promise<void>
  catalog: readonly AppCommand[]
  catalogDiagnostics: readonly string[]
  notice: string | undefined
  clearNotice: () => void
  busy: string | undefined
  completion: ComposerCompletionState | undefined
  setCompletionIndex: (index: number) => void
  chooseCompletion: (item?: ComposerCompletionItem) => void
  closeCompletion: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onInputSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  submit: (options?: { steer?: boolean }) => Promise<void>
  openPalette: () => void
  insertMention: () => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  insertCommandFromPalette: (command: AppCommand) => void
  longInputOpen: boolean
  setLongInputOpen: (open: boolean) => void
  /** 打开长输入编辑；打开瞬间读取输入框当前文字（不订阅 text）。 */
  openLongInput: () => void
  longInputText: string
  setLongInputText: (text: string) => void
  applyLongInput: () => void
}

const commandMatches = (command: AppCommand, prefix: string): boolean => {
  const needle = prefix.trim().toLowerCase()
  if (!needle) return true
  return (
    command.name.toLowerCase().includes(needle) ||
    (command.description ?? '').toLowerCase().includes(needle)
  )
}

const commandItems = (
  commands: readonly AppCommand[],
  prefix: string,
  replaceStart: number,
  replaceEnd: number,
): ComposerCompletionItem[] =>
  commands
    .filter((command) => commandMatches(command, prefix))
    .sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    .slice(0, 40)
    .map((command) => ({
      key: `command:${command.source}:${command.name}`,
      label: `/${command.name}`,
      ...(command.description ? { description: command.description } : {}),
      meta: [commandSourceLabel(command.source), commandStageLabel(command.stage)]
        .filter(Boolean)
        .join(' · '),
      insertText: `/${command.name} `,
      replaceStart,
      replaceEnd,
      command,
    }))

/** 找到光标前的 @ 提及起点；要求 @ 在开头或前面是空白。 */
function mentionToken(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return undefined
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return undefined
  const query = before.slice(at + 1)
  if (query.includes('\n')) return undefined
  return { start: at, query }
}

const THINKING_LEVELS: readonly HarnessThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export function usePiComposer(): PiComposerController {
  const aui = useAui()
  const actions = useHarnessActions()
  const controller = useHarnessController()
  const session = useHarnessSession()
  const metadata = useHarnessThreadState((state) => state.metadata)
  const runStatus = useHarnessThreadState((state) => state.runStatus)
  const loadState = useHarnessThreadState((state) => state.loadState)
  const compaction = useHarnessThreadState((state) => state.compaction)
  const queue = useHarnessThreadState((state) => state.queue)
  const text = useAuiState((state) => state.composer.text)
  // 只订阅最后一条用户消息：assistant 流式输出不会改变它，因此输入历史维护
  // 不必在每段输出时扫描整份消息表。
  const lastUserMessage = useHarnessThreadState((state) => {
    const threadMessages = state.messages
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const message = threadMessages[index]
      if (message?.role === 'user') return message
    }
    return undefined
  })
  const { hostInfo, workspaces, activeWorkspaceId, startProjectFor, refresh } = useWorkspace()

  const isPending = !session?.id || session.id === PENDING_THREAD_ID
  const threadId = isPending ? undefined : metadata.id
  const threadWorkspace = metadata.workspaceId
    ? workspaces.find((workspace) => workspace.id === metadata.workspaceId)
    : undefined
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const workspace = threadWorkspace ?? activeWorkspace
  const cwd =
    metadata.workspacePath ??
    (workspace ? startProjectFor(workspace) : hostInfo?.workspacePath) ??
    hostInfo?.workspacePath
  const workspaceId = metadata.workspaceId ?? activeWorkspaceId
  const isRunning = runStatus === 'running'

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [catalog, setCatalog] = useState<readonly AppCommand[]>(() =>
    mergeCommandCatalog(undefined),
  )
  const [catalogDiagnostics, setCatalogDiagnostics] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [completion, setCompletion] = useState<ComposerCompletionState>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [longInputOpen, setLongInputOpen] = useState(false)
  const [longInputText, setLongInputText] = useState('')
  const [queueMode, setQueueMode] = useState<'followUp' | 'steer'>('followUp')

  const completionRef = useRef<ComposerCompletionState | undefined>(undefined)
  completionRef.current = completion
  const catalogRef = useRef<readonly AppCommand[]>(catalog)
  catalogRef.current = catalog
  const asyncGeneration = useRef(0)
  const contextRef = useRef(`${threadId ?? ''}:${cwd ?? ''}`)
  contextRef.current = `${threadId ?? ''}:${cwd ?? ''}`
  const fileAbort = useRef<AbortController | undefined>(undefined)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const hostScope = hostInfo
    ? `${hostInfo.agentDir}|${hostInfo.sessionStorage.root}`
    : 'pending-host'
  const draftKey = isPending
    ? draftStorageKey(
        hostScope,
        `pending:${encodeURIComponent(workspaceId ?? '')}:${encodeURIComponent(cwd ?? '')}`,
      )
    : draftStorageKey(hostScope, `thread:${encodeURIComponent(metadata.id)}`)
  const draftKeyRef = useRef<string | undefined>(undefined)
  const loadedDraftKeyRef = useRef<string | undefined>(undefined)

  // 草稿：切换会话先保存旧键，再恢复新键；pending→thread 迁移同一份草稿，
  // 但附件（base64）不进入 sessionStorage，刷新后只恢复文字。
  useLayoutEffect(() => {
    const previous = draftKeyRef.current
    if (previous === draftKey) return
    const currentText = aui.composer.getState().text
    if (previous && previous === loadedDraftKeyRef.current) writeDraft(previous, currentText)
    const migrate = canMigrateDraft(previous, draftKey)
    const override = isPending ? undefined : takeComposerDraftOverride(metadata.id)
    const next = override ?? (migrate && currentText.trim() ? currentText : readDraft(draftKey))
    draftKeyRef.current = draftKey
    loadedDraftKeyRef.current = draftKey
    aui.composer.setText(next)
    if (!migrate) void aui.composer.clearAttachments()
  }, [aui, draftKey, isPending, metadata.id])

  // 文本变化（用户输入、发送后清空、历史/长输入写回）都同步到当前草稿键。
  // 切换会话时 layout effect 已先保存旧键；本次渲染的 text 仍是旧值，
  // 但依赖未变不会重复执行，因此不会把旧文本写到新键。
  useEffect(() => {
    const key = loadedDraftKeyRef.current
    if (key) writeDraft(key, text)
  }, [text])

  // 资源目录：空白页用固定起始目录，不创建后端会话；失败时仍保留内置索引。
  useEffect(() => {
    let active = true
    const input = threadId ? { threadId } : cwd ? { workspacePath: cwd } : undefined
    if (!input) {
      setCatalog(mergeCommandCatalog(undefined))
      setCatalogDiagnostics([])
      return
    }
    void harnessHttpClient
      .listCommands(input)
      .then((result: HarnessCommandCatalog) => {
        if (!active) return
        setCatalog(mergeCommandCatalog(result))
        setCatalogDiagnostics(result.diagnostics)
      })
      .catch(() => {
        if (!active) return
        setCatalog(mergeCommandCatalog(undefined))
        setCatalogDiagnostics([])
      })
    return () => {
      active = false
    }
  }, [cwd, threadId])

  // 本窗口历史：只记录 thread 加载完成后新出现的用户消息；加载前已有消息作为基线。
  const seenUserMessages = useRef(0)
  const historyThread = useRef<string | undefined>(undefined)
  const historyLoaded = useRef(false)
  // 首条提交从占位 Controller 切到真实 Controller，属于本窗口新输入。
  const pendingHistorySubmission = useRef(false)
  useEffect(() => {
    if (!lastUserMessage) {
      seenUserMessages.current = 0
      historyThread.current = metadata.id
      historyLoaded.current = loadState === 'loaded'
      return
    }
    const userMessages = controller.getState().messages.filter((message) => message.role === 'user')
    if (
      pendingHistorySubmission.current &&
      metadata.id !== PENDING_THREAD_ID &&
      loadState === 'loaded'
    ) {
      pendingHistorySubmission.current = false
      seenUserMessages.current = 0
      historyThread.current = metadata.id
      historyLoaded.current = true
    }
    if (historyThread.current !== metadata.id || loadState !== 'loaded' || !historyLoaded.current) {
      historyThread.current = metadata.id
      historyLoaded.current = loadState === 'loaded'
      seenUserMessages.current = userMessages.length
      return
    }
    for (const message of userMessages.slice(seenUserMessages.current)) {
      const value = threadMessageText(message)
      if (value) rememberSubmission(value)
    }
    seenUserMessages.current = userMessages.length
  }, [controller, lastUserMessage, loadState, metadata.id])

  const historyBrowse = useRef<{
    cursor: number
    draft: string
    last: string
  } | null>(null)

  const clearCompletion = useCallback(() => {
    asyncGeneration.current += 1
    fileAbort.current?.abort()
    fileAbort.current = undefined
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = undefined
    setCompletion(undefined)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 草稿身份变化必须撤销旧补全与动作状态
  useEffect(() => {
    clearCompletion()
    setBusy(undefined)
    setNotice(undefined)
    historyBrowse.current = null
    return () => clearCompletion()
  }, [clearCompletion, draftKey])

  const setCursor = useCallback((position: number) => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(position, position)
    })
  }, [])

  const ensureModelCatalog = useCallback(async (): Promise<readonly HarnessModelInfo[]> => {
    const cached = getModelCatalogCache()
    if (cached.length > 0 || !cwd) return cached
    const models = await harnessHttpClient.getAvailableModels({ workspacePath: cwd })
    setModelCatalogCache(models)
    return models
  }, [cwd])

  const buildLocalArgumentItems = useCallback(
    async (
      command: AppCommand,
      prefix: string,
      replaceStart: number,
      replaceEnd: number,
    ): Promise<ComposerCompletionItem[]> => {
      if (command.source !== 'builtin') return []
      if (command.name === 'model') {
        const models = await ensureModelCatalog()
        return models
          .filter((model) => {
            const key = `${model.provider}/${model.modelId}`
            return !prefix || key.toLowerCase().includes(prefix.toLowerCase())
          })
          .slice(0, 40)
          .map((model) => ({
            key: `model:${model.provider}/${model.modelId}`,
            label: `${model.provider}/${model.modelId}`,
            ...(model.name ? { description: model.name } : {}),
            insertText: `${model.provider}/${model.modelId}`,
            replaceStart,
            replaceEnd,
          }))
      }
      if (command.name === 'thinking') {
        const draft = getDraftModel()
        const current = findCachedModel(
          metadata.config?.provider ?? draft?.provider,
          metadata.config?.modelId ?? draft?.modelId,
        )
        const levels =
          current?.availableThinkingLevels && current.availableThinkingLevels.length > 0
            ? current.availableThinkingLevels
            : THINKING_LEVELS
        return levels
          .filter((level) => level.startsWith(prefix))
          .map((level) => ({
            key: `thinking:${level}`,
            label: level,
            insertText: level,
            replaceStart,
            replaceEnd,
          }))
      }
      return []
    },
    [ensureModelCatalog, metadata.config?.modelId, metadata.config?.provider],
  )

  const refreshCompletion = useCallback(
    async (value: string, caret: number) => {
      if (!value || caret < 0) {
        clearCompletion()
        return
      }
      // slash 命令首词
      if (value.startsWith('/')) {
        const firstBreak = value.search(/\s/)
        if (firstBreak === -1 || caret <= firstBreak) {
          clearCompletion()
          const prefix = value.slice(1, caret)
          const items = commandItems(
            catalogRef.current,
            prefix,
            0,
            firstBreak === -1 ? value.length : firstBreak,
          )
          if (items.length > 0) setCompletion({ kind: 'command', items, index: 0 })
          return
        }
        const commandName = value.slice(1, firstBreak)
        const command = findAppCommand(catalogRef.current, commandName)
        if (command?.supportsArguments) {
          const argument = value.slice(firstBreak + 1, caret)
          if (argument.includes('\n')) {
            clearCompletion()
            return
          }
          clearCompletion()
          const generation = asyncGeneration.current
          const local = await buildLocalArgumentItems(command, argument, firstBreak + 1, caret)
          if (generation !== asyncGeneration.current) return
          if (local.length > 0) {
            setCompletion({ kind: 'argument', items: local, index: 0 })
            return
          }
          const result = await harnessHttpClient
            .getCommandArgumentCompletions({
              ...(threadId ? { threadId } : {}),
              ...(!threadId && cwd ? { workspacePath: cwd } : {}),
              name: commandName,
              prefix: argument,
            })
            .catch(() => [])
          if (generation !== asyncGeneration.current) return
          const items: ComposerCompletionItem[] = result.slice(0, 40).map((item) => ({
            key: `argument:${commandName}:${item.value}`,
            label: item.label,
            ...(item.description ? { description: item.description } : {}),
            insertText: item.value,
            replaceStart: firstBreak + 1,
            replaceEnd: caret,
          }))
          if (items.length > 0) setCompletion({ kind: 'argument', items, index: 0 })
          return
        }
      }

      // @ 文件提及
      const token = mentionToken(value, caret)
      if (token) {
        clearCompletion()
        const generation = asyncGeneration.current
        const controller = new AbortController()
        fileAbort.current?.abort()
        fileAbort.current = controller
        const result = await harnessHttpClient
          .searchFiles(
            {
              ...(threadId ? { threadId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              ...(cwd ? { workspacePath: cwd } : {}),
              query: token.query,
              limit: 30,
            },
            { signal: controller.signal },
          )
          .catch(() => undefined)
        if (generation !== asyncGeneration.current) return
        if (!result) return
        const items: ComposerCompletionItem[] = result.files.map((file) => ({
          key: `file:${file.path}`,
          label: file.reference,
          description: file.kind === 'directory' ? '目录' : file.relativePath,
          meta: file.alias ? `@${file.alias}` : (file.workspaceName ?? ''),
          insertText: `${
            /\s/.test(file.reference)
              ? `@${JSON.stringify(file.reference.replace(/^@/, ''))}`
              : file.reference.startsWith('@')
                ? file.reference
                : `@${file.reference}`
          } `,
          replaceStart: token.start,
          replaceEnd: caret,
          file,
        }))
        if (items.length > 0) setCompletion({ kind: 'file', items, index: 0 })
        return
      }
      clearCompletion()
    },
    [buildLocalArgumentItems, clearCompletion, cwd, threadId, workspaceId],
  )

  const scheduleCompletion = useCallback(
    (value: string, caret: number, kind: ComposerCompletionKind) => {
      asyncGeneration.current += 1
      fileAbort.current?.abort()
      setCompletion(undefined)
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      const delay = kind === 'command' ? 0 : 120
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = undefined
        void refreshCompletion(value, caret)
      }, delay)
    },
    [refreshCompletion],
  )

  const onInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setNotice(undefined)
      const value = event.target.value
      const caret = event.target.selectionStart ?? value.length
      const commandLine =
        value.startsWith('/') &&
        caret <= (value.search(/\s/) === -1 ? value.length : value.search(/\s/))
      scheduleCompletion(value, caret, commandLine ? 'command' : 'argument')
    },
    [scheduleCompletion],
  )

  const onInputSelect = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget
      scheduleCompletion(target.value, target.selectionStart ?? target.value.length, 'argument')
    },
    [scheduleCompletion],
  )

  const chooseCompletion = useCallback(
    (item?: ComposerCompletionItem) => {
      const state = completionRef.current
      const chosen = item ?? state?.items[state.index]
      if (!chosen) return
      const current = aui.composer.getState().text
      const next =
        current.slice(0, chosen.replaceStart) + chosen.insertText + current.slice(chosen.replaceEnd)
      aui.composer.setText(next)
      clearCompletion()
      setCursor(chosen.replaceStart + chosen.insertText.length)
    },
    [aui, clearCompletion, setCursor],
  )

  const setCompletionIndex = useCallback((index: number) => {
    setCompletion((current) => (current ? { ...current, index } : current))
  }, [])

  const openPalette = useCallback(() => {
    clearCompletion()
    setPaletteOpen(true)
  }, [clearCompletion])

  const insertMention = useCallback(() => {
    const input = inputRef.current
    const current = aui.composer.getState().text
    const caret = input?.selectionStart ?? current.length
    const next = `${current.slice(0, caret)}@${current.slice(caret)}`
    aui.composer.setText(next)
    setCursor(caret + 1)
    scheduleCompletion(next, caret + 1, 'file')
  }, [aui, scheduleCompletion, setCursor])

  const insertCommandFromPalette = useCallback(
    (command: AppCommand) => {
      const input = inputRef.current
      const current = aui.composer.getState().text
      const caret = input?.selectionStart ?? current.length
      const firstBreak = current.search(/\s/)
      const canReplace = current.startsWith('/') && (firstBreak === -1 || caret <= firstBreak)
      const insert = `/${command.name} `
      const next = canReplace
        ? insert + current.slice(firstBreak === -1 ? current.length : firstBreak).trimStart()
        : `${current.slice(0, caret)}${insert}${current.slice(caret)}`
      aui.composer.setText(next)
      setPaletteOpen(false)
      setCursor(canReplace ? insert.length : caret + insert.length)
    },
    [aui, setCursor],
  )

  const openLongInput = useCallback(() => {
    setLongInputText(aui.composer.getState().text)
    setLongInputOpen(true)
  }, [aui])

  const applyLongInput = useCallback(() => {
    aui.composer.setText(longInputText)
    setLongInputOpen(false)
    setCursor(longInputText.length)
  }, [aui, longInputText, setCursor])

  const retrieveQueue = useCallback(async () => {
    try {
      const cleared = await actions.clearQueue()
      const parts = [...cleared.steering, ...cleared.followUp].filter((item) => item.trim())
      if (parts.length === 0) return
      const current = aui.composer.getState().text.trim()
      const next = [current, ...parts].filter(Boolean).join('\n\n')
      aui.composer.setText(next)
      setCursor(next.length)
    } catch (error) {
      const recovered = (error as { recoveredQueue?: { steering: string[]; followUp: string[] } })
        ?.recoveredQueue
      if (recovered) {
        const current = aui.composer.getState().text
        aui.composer.setText(
          [current, ...recovered.steering, ...recovered.followUp].filter(Boolean).join('\n\n'),
        )
      }
      setNotice(errorText(error))
    }
  }, [aui, actions, setCursor])

  const rejectImages = useCallback(async (): Promise<string | undefined> => {
    const state = aui.composer.getState()
    const images = state.attachments.filter((attachment) => attachment.type === 'image')
    if (images.length === 0) return undefined
    const draft = getDraftModel()
    const config = isPending
      ? draft
      : metadata.config?.provider && metadata.config.modelId
        ? { provider: metadata.config.provider, modelId: metadata.config.modelId }
        : undefined
    await ensureModelCatalog().catch(() => [])
    const info = findCachedModel(config?.provider, config?.modelId)
    const input = isPending ? info?.input : (metadata.modelInput ?? info?.input)
    if (input && !input.includes('image')) {
      return `${config?.provider ?? ''}/${config?.modelId ?? ''} 未声明图像输入能力，请移除图片或切换支持图像的模型。`
    }
    return undefined
  }, [aui, ensureModelCatalog, isPending, metadata.config, metadata.modelInput])

  const runNameCommand = useCallback(
    async (args: string) => {
      if (isPending) {
        setNotice('当前还没有后端会话；发送一条普通消息或先新建会话后再命名。')
        return false
      }
      if (!args) {
        setNotice(
          `当前会话名称：${metadata.name ?? metadata.title ?? '未命名'}。用法：/name <名称>`,
        )
        return false
      }
      try {
        await harnessHttpClient.renameThread(metadata.id, args)
        await refresh({ threads: true })
        setNotice(`会话已命名为“${args}”。`)
        return true
      } catch (error) {
        setNotice(errorText(error))
        return false
      }
    },
    [isPending, metadata.id, metadata.name, metadata.title, refresh],
  )

  const runModelCommand = useCallback(
    async (args: string) => {
      if (!args) {
        requestPiIntent('model')
        return true
      }
      const models = await ensureModelCatalog()
      const needle = args.toLowerCase()
      const exact = models.find(
        (model) => `${model.provider}/${model.modelId}`.toLowerCase() === needle,
      )
      const matches =
        exact !== undefined
          ? [exact]
          : models.filter(
              (model) =>
                model.modelId.toLowerCase() === needle ||
                model.name?.toLowerCase() === needle ||
                model.modelId.toLowerCase().includes(needle) ||
                model.name?.toLowerCase().includes(needle),
            )
      if (matches.length !== 1) {
        setNotice(
          matches.length === 0
            ? `没有匹配的模型：${args}`
            : `匹配到多个模型，请使用 provider/modelId：${matches
                .map((model) => `${model.provider}/${model.modelId}`)
                .join('、')}`,
        )
        return false
      }
      const target = matches[0]
      if (!target) return false
      if (isPending) {
        const draft = getDraftModel()
        setDraftModel({
          provider: target.provider,
          modelId: target.modelId,
          ...(draft?.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        })
        setNotice(`新会话将使用 ${target.provider}/${target.modelId}。`)
        return true
      }
      try {
        await actions.setModel({ provider: target.provider, modelId: target.modelId })
        setNotice(`已切换模型：${target.provider}/${target.modelId}。`)
        return true
      } catch (error) {
        setNotice(errorText(error))
        return false
      }
    },
    [ensureModelCatalog, actions, isPending],
  )

  const runThinkingCommand = useCallback(
    async (args: string) => {
      if (!args) {
        requestPiIntent('model')
        return true
      }
      const level = args.trim() as HarnessThinkingLevel
      if (!THINKING_LEVELS.includes(level)) {
        setNotice(`未知 Thinking 级别：${args}。可用级别：${THINKING_LEVELS.join('、')}`)
        return false
      }
      if (isPending) {
        const draft = getDraftModel()
        if (!draft) {
          setNotice('请先在模型选择器选择模型，再设置 Thinking 级别。')
          return false
        }
        setDraftModel({ ...draft, thinkingLevel: level })
        setNotice(`新会话 Thinking 级别：${level}。`)
        return true
      }
      try {
        await actions.setThinkingLevel(level)
        setNotice(`Thinking 级别已设置为 ${level}。`)
        return true
      } catch (error) {
        setNotice(errorText(error))
        return false
      }
    },
    [actions, isPending],
  )

  const copyLastReply = useCallback(async () => {
    const threadMessages = aui.thread.getState().messages
    const lastAssistant = [...threadMessages]
      .reverse()
      .find((message) => message.role === 'assistant')
    const value = lastAssistant ? threadMessageText(lastAssistant) : ''
    if (!value) {
      setNotice('没有可复制的助手回复。')
      return false
    }
    try {
      await navigator.clipboard.writeText(value)
      setNotice('已复制最后一条助手回复。')
      return true
    } catch (error) {
      setNotice(`复制失败：${errorText(error)}`)
      return false
    }
  }, [aui])

  /** 执行一个内置命令；返回 true 表示输入已处理（可清空输入框）。 */
  const runBuiltinCommand = useCallback(
    async (command: AppCommand, args: string): Promise<boolean> => {
      if (!command.available) {
        setNotice(command.availability ?? `/${command.name} 尚无 GUI 入口。`)
        return true
      }
      switch (command.name) {
        case 'model':
          return runModelCommand(args)
        case 'thinking':
          return runThinkingCommand(args)
        case 'scoped-models':
          requestPiIntent('runtime-operations')
          return true
        case 'compact':
          if (isPending) {
            setNotice('先建立或打开会话，才能压缩上下文。')
            return false
          }
          if (!args) {
            requestPiIntent('runtime-operations')
            return true
          }
          try {
            const outcome = await actions.compact({ customInstructions: args })
            setNotice(
              outcome.status === 'compacted'
                ? `压缩完成（${outcome.tokensBefore ?? '?'} → ${outcome.estimatedTokensAfter ?? '?'} tokens）。`
                : (outcome.message ??
                    (outcome.status === 'cancelled' ? '压缩已取消。' : '压缩失败。')),
            )
            return outcome.status === 'compacted' || outcome.status === 'cancelled'
          } catch (error) {
            setNotice(errorText(error))
            return false
          }
        case 'new':
          requestPiIntent('new-session', {
            ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
          })
          return true
        case 'resume':
          setNotice('请从左侧会话列表选择要恢复的会话；切换只影响当前窗口，不停止其他窗口的任务。')
          return true
        case 'name':
          return runNameCommand(args)
        case 'session':
          if (isPending) {
            setNotice('当前还没有后端会话。')
            return false
          }
          requestPiIntent('session-details')
          return true
        case 'tree':
          if (isPending) {
            setNotice('先建立会话后才能打开会话树。')
            return false
          }
          requestPiIntent('session-tree')
          return true
        case 'fork':
          if (isPending) {
            setNotice('先建立会话后才能从历史消息分叉。')
            return false
          }
          requestPiIntent('session-tree')
          return true
        case 'clone':
          if (isPending) {
            setNotice('先建立会话后才能克隆。')
            return false
          }
          requestForkThread({ position: 'at' })
          return true
        case 'import':
          requestPiIntent('import', args ? { path: args } : undefined)
          return true
        case 'trust':
          if (!cwd) {
            setNotice('当前没有可管理的项目目录。')
            return false
          }
          requestPiIntent('trust', { path: cwd })
          return true
        case 'copy':
          return copyLastReply()
        default:
          setNotice(command.availability ?? `/${command.name} 尚无 GUI 入口。`)
          return true
      }
    },
    [
      activeWorkspaceId,
      copyLastReply,
      cwd,
      actions,
      isPending,
      runModelCommand,
      runNameCommand,
      runThinkingCommand,
    ],
  )

  const runShell = useCallback(
    async (command: string, excludeFromContext: boolean): Promise<boolean> => {
      if (isPending) {
        setNotice('Shell 需要会话历史；请先发送普通消息或新建会话后再执行 !/!!。')
        return false
      }
      try {
        const result = await actions.runBash({ command, excludeFromContext })
        if (result.status === 'started') {
          rememberSubmission(`${excludeFromContext ? '!!' : '!'}${command}`)
          return true
        }
        setNotice(result.message)
        return false
      } catch (error) {
        setNotice(errorText(error))
        return false
      }
    },
    [actions, isPending],
  )

  const submitNormal = useCallback(
    async (steer: boolean | undefined) => {
      const context = contextRef.current
      const rejection = await rejectImages()
      if (context !== contextRef.current) return
      if (rejection) {
        setNotice(rejection)
        return
      }
      if (isPending) pendingHistorySubmission.current = true
      aui.composer.send(steer === undefined ? undefined : { steer })
    },
    [aui, isPending, rejectImages],
  )

  const submit = useCallback(
    async (options?: { steer?: boolean }) => {
      if (busy) return
      const submittedContext = contextRef.current
      const isCurrent = () => submittedContext === contextRef.current
      const state = aui.composer.getState()
      const raw = state.text
      const trimmed = raw.trim()
      const hasAttachments = state.attachments.length > 0
      if (!trimmed && !hasAttachments) return
      setNotice(undefined)

      // 内置动作与 Shell 不接受附件混入。
      const leadingCommand =
        trimmed.startsWith('/') &&
        findAppCommand(catalogRef.current, parseLeadingSlashCommand(trimmed)?.name ?? '')
          ?.source === 'builtin'
      const leadingShell = trimmed.startsWith('!')
      if ((leadingCommand || leadingShell) && hasAttachments) {
        setNotice('命令与 Shell 不能附带图片附件；请移除附件后重试。')
        return
      }

      if (leadingShell) {
        const exclude = trimmed.startsWith('!!')
        const command = trimmed.slice(exclude ? 2 : 1).trim()
        if (!command) {
          setNotice('Shell 命令不能为空。')
          return
        }
        setBusy('shell')
        try {
          if ((await runShell(command, exclude)) && isCurrent()) aui.composer.setText('')
        } finally {
          if (isCurrent()) setBusy(undefined)
        }
        return
      }

      if (trimmed.startsWith('/')) {
        const parsed = parseLeadingSlashCommand(trimmed)
        const command = parsed ? findAppCommand(catalogRef.current, parsed.name) : undefined
        if (parsed && command && command.source === 'builtin') {
          setBusy(`command:${command.name}`)
          try {
            if ((await runBuiltinCommand(command, parsed.args)) && isCurrent()) {
              aui.composer.setText('')
            }
          } finally {
            if (isCurrent()) setBusy(undefined)
          }
          return
        }
      }

      if (compaction.active) {
        setNotice('上下文压缩进行中，输入已保留；完成后可再次发送。')
        return
      }
      const steer = isRunning ? (options?.steer ?? queueMode === 'steer') : undefined
      await submitNormal(steer)
    },
    [aui, busy, compaction.active, isRunning, queueMode, runBuiltinCommand, runShell, submitNormal],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      const activeCompletion = completionRef.current
      if (activeCompletion && activeCompletion.items.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setCompletionIndex((activeCompletion.index + 1) % activeCompletion.items.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setCompletionIndex(
            (activeCompletion.index - 1 + activeCompletion.items.length) %
              activeCompletion.items.length,
          )
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          chooseCompletion()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          clearCompletion()
          return
        }
      }

      // 本窗口输入历史：空框（或正在浏览时）在首/尾行上下切换。
      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const target = event.currentTarget
        const value = target.value
        const caret = target.selectionStart
        if (target.selectionStart === target.selectionEnd) {
          const browse = historyBrowse.current
          if (browse && value !== browse.last) historyBrowse.current = null
          const state = historyBrowse.current
          const onFirstLine = !value.slice(0, caret).includes('\n')
          const onLastLine = !value.slice(caret).includes('\n')

          if (event.key === 'ArrowUp' && (state ? onFirstLine : value.trim() === '')) {
            if (submissionHistory.length === 0) return
            event.preventDefault()
            const next = state ? state.cursor + 1 : 0
            const entry = submissionHistory[next]
            if (entry === undefined) return
            historyBrowse.current = {
              cursor: next,
              draft: state?.draft ?? value,
              last: entry,
            }
            aui.composer.setText(entry)
            clearCompletion()
            setCursor(entry.length)
            return
          }
          if (event.key === 'ArrowDown' && state && onLastLine) {
            event.preventDefault()
            const next = state.cursor - 1
            if (next < 0) {
              historyBrowse.current = null
              aui.composer.setText(state.draft)
              clearCompletion()
              setCursor(state.draft.length)
              return
            }
            const entry = submissionHistory[next]
            if (entry === undefined) return
            historyBrowse.current = { ...state, cursor: next, last: entry }
            aui.composer.setText(entry)
            clearCompletion()
            setCursor(entry.length)
            return
          }
        }
      }

      if (event.key !== 'Enter') return
      if (event.shiftKey) return
      event.preventDefault()
      const steer = event.ctrlKey || event.metaKey || queueMode === 'steer'
      historyBrowse.current = null
      void submit({ steer })
    },
    [aui, chooseCompletion, clearCompletion, queueMode, setCompletionIndex, setCursor, submit],
  )

  // 文本被程序性清空/替换后关闭旧补全，避免选中过期条目。
  const lastText = useRef(text)
  useEffect(() => {
    if (lastText.current !== text && !text) clearCompletion()
    lastText.current = text
  }, [clearCompletion, text])

  return {
    text,
    isRunning,
    queueMode,
    setQueueMode,
    queue,
    retrieveQueue,
    catalog,
    catalogDiagnostics,
    notice,
    clearNotice: () => setNotice(undefined),
    busy,
    completion,
    setCompletionIndex,
    chooseCompletion,
    closeCompletion: clearCompletion,
    inputRef,
    onInputChange,
    onInputSelect,
    onKeyDown,
    submit,
    openPalette,
    insertMention,
    paletteOpen,
    setPaletteOpen,
    insertCommandFromPalette,
    longInputOpen,
    setLongInputOpen,
    openLongInput,
    longInputText,
    setLongInputText,
    applyLongInput,
  }
}
