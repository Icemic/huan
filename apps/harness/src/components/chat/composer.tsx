/**
 * 最终输入区：官方 InputGroup + Attachment 组合，单一 textarea 与单一发送入口。
 *
 * 文字/附件/模型/提交全部走 windowStore、composer/model feature store；组件
 * 只保留拖拽高亮与组合输入时间等瞬时 UI 状态。IME、Shift/Ctrl
 * Enter、历史、补全、粘贴/拖入和长输入都在这里收口。
 */

import type { HarnessSubmission } from '@huan/react'
import {
  draftIdOf,
  selectThreadIsRunning,
  selectThreadQueue,
  useServiceStore,
  useWindowStore,
} from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { ImagePlusIcon, PlusIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ComposerCompletionMenu,
  ComposerExpandButton,
  ComposerNotice,
  ComposerQueue,
  ComposerQueueMode,
  ComposerSendButton,
  ComposerStopButton,
  focusTextareaAt,
  PiComposerDialogs,
} from '@/components/pi-composer-tools'
import { PiModelSelector } from '@/components/pi-model-selector'
import { PiComposerHostUi, PiComposerWidgets } from '@/components/pi-thread-host-ui'
import { Button } from '@/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import {
  useChatStore,
  useComposerStore,
  useHarnessApp,
  useWorkspaceStore,
} from '@/state/app-context'
import { ComposerAttachments } from './composer-attachments'
import { resolveComposerKey } from './composer-keydown'

const EMPTY_QUEUE = { steering: [] as string[], followUp: [] as string[] }

const statusLabel = (submission: HarnessSubmission): string => {
  if (submission.status === 'unknown') return '结果未知'
  if (submission.status === 'failed') return '发送失败'
  if (submission.status === 'cancelled') return '已取消'
  if (!submission.dispatched) return '准备中'
  return '等待服务端结果'
}

const canRestore = (submission: HarnessSubmission): boolean =>
  submission.content.trim().length > 0 &&
  submission.status !== 'accepted' &&
  submission.status !== 'handled'

function LocalPendingList({ submissions }: { submissions: readonly HarnessSubmission[] }) {
  const restore = useComposerStore((state) => state.restoreSubmissionContent)
  const dismiss = useComposerStore((state) => state.dismissSubmission)
  const requestFocus = useChatStore((state) => state.requestComposerFocus)
  if (submissions.length === 0) return null
  return (
    <div data-slot="huan-composer-pending" className="mb-1 flex flex-col gap-1">
      {submissions.map((submission) => (
        <div
          key={submission.id}
          data-slot="huan-local-submission"
          data-status={submission.status}
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-1.5 text-sm',
            submission.status === 'failed' || submission.status === 'unknown'
              ? 'border-destructive/25 bg-destructive/5'
              : 'border-foreground/10',
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block whitespace-pre-wrap">{submission.content}</span>
            <span
              className={cn(
                'mt-0.5 block text-[11px]',
                submission.status === 'failed' || submission.status === 'unknown'
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {statusLabel(submission)}
              {submission.message ? `：${submission.message}` : ''}
            </span>
          </span>
          {canRestore(submission) ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                if (restore(submission.id)) requestFocus()
              }}
            >
              <RotateCcwIcon aria-hidden className="size-3" />
              <Trans>放回输入</Trans>
            </Button>
          ) : null}
          {submission.status === 'failed' ||
          submission.status === 'cancelled' ||
          submission.status === 'unknown' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="忽略这条提交提示"
              onClick={() => dismiss(submission.id)}
            >
              <XIcon aria-hidden />
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function RecoveredQueueBanner() {
  const recovered = useComposerStore((state) => state.recoveredQueue)
  const restore = useComposerStore((state) => state.restoreRecoveredQueue)
  const dismiss = useComposerStore((state) => state.dismissRecoveredQueue)
  const requestFocus = useChatStore((state) => state.requestComposerFocus)
  if (!recovered) return null
  const items = [...recovered.steering, ...recovered.followUp]
  return (
    <div
      data-slot="huan-recovered-queue"
      className="border-primary/25 bg-primary/5 mb-1 rounded-md border px-3 py-2 text-sm"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">
          <Trans>已取回队列，但输入框已有新内容</Trans>
        </span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              if (restore()) requestFocus()
            }}
          >
            <Trans>追加到输入</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="忽略取回内容"
            onClick={dismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      </div>
      <div className="text-muted-foreground space-y-1 text-xs whitespace-pre-wrap">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 取回文本没有独立 ID
          <p key={index}>{item}</p>
        ))}
        {recovered.message ? <p className="text-destructive">{recovered.message}</p> : null}
      </div>
    </div>
  )
}

const isImageFile = (file: File): boolean => file.type.startsWith('image/')

/** 输入区主体。 */
export function ChatComposer() {
  const { browser } = useHarnessApp()
  const selection = useWindowStore((state) => state.selection)
  const draftId = selection ? draftIdOf(selection) : undefined
  const draft = useWindowStore((state) => (draftId ? state.draftsById[draftId] : undefined))
  const attachmentsById = useWindowStore((state) => state.attachmentsById)
  const submissionsById = useWindowStore((state) => state.submissionsById)
  const metadata = useServiceStore(
    useCallback(
      (state) => (selection?.kind === 'thread' ? state.threadsById[selection.threadId] : undefined),
      [selection],
    ),
  )
  const workspaceIds = useServiceStore((state) => state.workspaceIds)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const hostWorkspacePath = useServiceStore((state) => state.host?.workspacePath)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)

  const ensureTarget = useComposerStore((state) => state.ensureTarget)
  const submit = useComposerStore((state) => state.submit)
  const stop = useComposerStore((state) => state.stop)
  const setNotice = useComposerStore((state) => state.setNotice)
  const busy = useComposerStore((state) => state.busy)
  const queueMode = useComposerStore((state) => state.queueMode)
  const setQueueMode = useComposerStore((state) => state.setQueueMode)
  const completion = useComposerStore((state) => state.completion)
  const setCompletionIndex = useComposerStore((state) => state.setCompletionIndex)
  const chooseCompletion = useComposerStore((state) => state.chooseCompletion)
  const clearCompletion = useComposerStore((state) => state.clearCompletion)
  const onInputChange = useComposerStore((state) => state.onInputChange)
  const onInputSelect = useComposerStore((state) => state.onInputSelect)
  const historyUp = useComposerStore((state) => state.historyUp)
  const historyDown = useComposerStore((state) => state.historyDown)
  const openLongInput = useComposerStore((state) => state.openLongInput)
  const closeLongInput = useComposerStore((state) => state.closeLongInput)
  const retrieveQueue = useComposerStore((state) => state.retrieveQueue)

  const focusToken = useChatStore((state) => state.composerFocusToken)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const compositionRef = useRef(false)
  const compositionEndedAt = useRef<number | undefined>(undefined)
  const lastSelectionKey = useRef<string | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined
  const running = metadata ? selectThreadIsRunning(metadata) : false
  const queue = metadata ? selectThreadQueue(metadata) : EMPTY_QUEUE
  const text = draft?.text ?? ''
  const attachmentIds = draft?.attachmentIds ?? []
  const hasFailedAttachment = attachmentIds.some((id) => attachmentsById[id]?.status === 'failed')
  const readOnly = workspaceState !== undefined && workspaceState !== 'ok'
  const canSend =
    (text.trim().length > 0 || attachmentIds.length > 0) && !hasFailedAttachment && !readOnly
  const selectionKey = useMemo(() => {
    if (!selection) return ''
    return selection.kind === 'thread'
      ? `t:${selection.threadId}`
      : `n:${selection.workspaceId ?? ''}:${selection.startProjectPath}`
  }, [selection])

  const localPending = useMemo(() => {
    const values = Object.values(submissionsById).filter(
      (submission) => submission.status !== 'accepted' && submission.status !== 'handled',
    )
    return values
      .filter(
        (submission) =>
          submission.draft.draftId === draftId ||
          (threadId !== undefined && submission.threadId === threadId),
      )
      .sort((left, right) => left.createdAt - right.createdAt)
  }, [draftId, submissionsById, threadId])

  const maybeFocusComposer = useCallback(() => {
    if (typeof document !== 'undefined' && document.hasFocus && !document.hasFocus()) return
    const active = document.activeElement as HTMLElement | null
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.closest('[role="dialog"]'))
    ) {
      return
    }
    textareaRef.current?.focus()
  }, [])

  // 无选择时明确落到当前工作区起始目录，允许直接输入首条消息。
  useEffect(() => {
    if (selection || readOnly) return
    // 工作区目录到达后才固定目标，让目标带上工作区身份（见 ensureTarget）。
    if (workspaceState === undefined && activeWorkspaceId === undefined) return
    if (activeWorkspaceId === undefined && workspaceIds.length === 0 && !hostWorkspacePath) return
    ensureTarget()
  }, [
    activeWorkspaceId,
    ensureTarget,
    hostWorkspacePath,
    readOnly,
    selection,
    workspaceIds.length,
    workspaceState,
  ])

  // 本窗切换目标后才移动焦点；其他窗口与弹层内输入不受影响。
  useEffect(() => {
    const previous = lastSelectionKey.current
    lastSelectionKey.current = selectionKey
    if (previous !== undefined && previous !== selectionKey) maybeFocusComposer()
  }, [maybeFocusComposer, selectionKey])

  useEffect(() => {
    if (focusToken > 0) maybeFocusComposer()
  }, [focusToken, maybeFocusComposer])

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return
      if (readOnly) {
        setNotice('当前工作区不可用，历史会话为只读查看。')
        return
      }
      if (!browser.windowStore.getState().selection) {
        if (!ensureTarget()) return
      }
      const target = browser.windowStore.getState().selection
      if (!target) return
      const targetDraftId = draftIdOf(target)
      for (const file of files) {
        if (!isImageFile(file)) {
          setNotice(`仅支持图片附件：${file.name}`)
          continue
        }
        const id = browser.windowStore.getState().addAttachment(targetDraftId, {
          fileName: file.name || '图片',
          mimeType: file.type || 'image/png',
          blob: file,
        })
        if (id) browser.windowStore.getState().setAttachmentStatus(id, 'ready')
      }
      textareaRef.current?.focus()
    },
    [browser, ensureTarget, readOnly, setNotice],
  )

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(isImageFile)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget
    const action = resolveComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: compositionRef.current || event.nativeEvent.isComposing,
      ...(compositionEndedAt.current !== undefined
        ? { compositionEndedAt: compositionEndedAt.current }
        : {}),
      now: Date.now(),
      completionOpen: completion !== undefined && completion.items.length > 0,
      completionExact:
        completion !== undefined &&
        completion.items.length > 0 &&
        (completion.items[completion.index]?.insertText.trim() ?? '') === element.value.trim(),
      caretStart: element.selectionStart,
      caretEnd: element.selectionEnd,
      valueLength: element.value.length,
    })
    if (action.type === 'ignore' || action.type === 'newline') return
    if (action.type === 'history') {
      const caret = action.direction === 'up' ? historyUp(element.value) : historyDown()
      // 没有可浏览历史时保留默认光标移动，不吞掉方向键。
      if (caret === undefined) return
      event.preventDefault()
      focusTextareaAt(textareaRef, caret)
      return
    }
    event.preventDefault()
    switch (action.type) {
      case 'send': {
        if (busy || !canSend) return
        void submit(action.steer ? { steer: true } : undefined)
        break
      }
      case 'completion': {
        if (completion) setCompletionIndex(completion.index + action.delta)
        break
      }
      case 'completion-accept': {
        const caret = chooseCompletion()
        if (caret !== undefined) focusTextareaAt(textareaRef, caret)
        break
      }
      case 'dismiss': {
        clearCompletion()
        closeLongInput()
        break
      }
    }
  }

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !canSend) return
    void submit()
  }

  return (
    <div data-slot="huan-composer-column" className="flex w-full flex-col gap-1">
      <PiComposerWidgets placement="aboveEditor" />
      <RecoveredQueueBanner />
      <ComposerQueue queue={queue} onRetrieve={retrieveQueue} />
      <LocalPendingList submissions={localPending} />
      <ComposerCompletionMenu inputRef={textareaRef} />
      <form
        onSubmit={onFormSubmit}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          setDragging(false)
        }}
        onDrop={onDrop}
        data-dragging={dragging || undefined}
        data-slot="huan-composer"
        className="w-full"
      >
        <InputGroup
          className={cn(
            'h-auto flex-col items-stretch gap-0 rounded-md bg-background',
            // 仅聊天输入区去掉焦点粗 ring，保留 input-group 的聚焦 border 加深；
            // 按钮、其他表单与下方拖入高亮不受影响。
            'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
            dragging && 'ring-2 ring-primary/50',
          )}
        >
          {attachmentIds.length > 0 ? (
            <InputGroupAddon align="block-start" className="border-b">
              <ComposerAttachments draftId={draftId} />
            </InputGroupAddon>
          ) : null}
          <InputGroupTextarea
            ref={textareaRef}
            data-slot="input-group-control"
            aria-label="消息输入"
            placeholder={draft ? '输入消息，/ 命令，@ 文件，! Shell' : '正在准备起始工作区…'}
            rows={1}
            value={text}
            disabled={!draft}
            className="max-h-64 min-h-16 px-3 py-2 text-sm field-sizing-content"
            onChange={(event) => {
              const value = event.target.value
              onInputChange(value, event.target.selectionStart ?? value.length)
            }}
            onSelect={(event) => {
              const value = event.currentTarget.value
              onInputSelect(value, event.currentTarget.selectionStart ?? value.length)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={() => {
              compositionRef.current = true
            }}
            onCompositionEnd={() => {
              compositionRef.current = false
              compositionEndedAt.current = Date.now()
            }}
            onFocus={() => {
              if (!readOnly && !browser.windowStore.getState().selection) ensureTarget()
            }}
          />
          <InputGroupAddon align="block-end" className="flex-wrap gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={onFileInput}
            />
            <Menu>
              <MenuTrigger
                disabled={!draft || readOnly}
                render={<InputGroupButton size="icon-xs" aria-label="添加内容" />}
              >
                <PlusIcon aria-hidden />
              </MenuTrigger>
              {/* 菜单关闭后焦点交回 Base UI 默认行为；图片选择后由 addFiles 回到输入框。 */}
              <MenuContent align="start" side="top">
                <MenuItem onClick={() => fileInputRef.current?.click()}>
                  <ImagePlusIcon aria-hidden />
                  <Trans>添加图片</Trans>
                </MenuItem>
              </MenuContent>
            </Menu>
            <ComposerQueueMode
              isRunning={running}
              queueMode={queueMode}
              onQueueModeChange={setQueueMode}
            />
            <ComposerExpandButton onExpand={openLongInput} />
            <div className="ms-auto flex min-w-0 items-center gap-1">
              <PiModelSelector />
              <ComposerSendButton
                isRunning={running}
                queueMode={queueMode}
                busy={busy !== undefined}
                canSend={canSend}
                onSubmit={() => submit()}
              />
              {running && threadId ? (
                <ComposerStopButton busy={busy !== undefined} onStop={stop} />
              ) : null}
            </div>
          </InputGroupAddon>
        </InputGroup>
        <ComposerNotice />
        <PiComposerHostUi inputRef={textareaRef} />
        <PiComposerWidgets placement="belowEditor" />
      </form>
      <PiComposerDialogs inputRef={textareaRef} />
    </div>
  )
}
