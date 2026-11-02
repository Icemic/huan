import { describe, expect, it } from 'vitest'
import { createHarnessWindowStore, draftIdOf, type HarnessBrowserStorage } from './window-store.js'

const memoryStorage = (): HarnessBrowserStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

const threadTarget = { kind: 'thread' as const, threadId: 't1' }
const newTarget = { kind: 'new' as const, workspaceId: 'w1', startProjectPath: '/workspace' }

const createStore = () =>
  createHarnessWindowStore({
    windowId: 'window-a',
    storageScope: 'connection',
    storage: memoryStorage(),
  })

describe('window-store：选择与草稿版本', () => {
  it('显式选择推进 selectionRevision 并创建稳定草稿 ID', () => {
    const store = createStore()
    store.getState().selectTarget(threadTarget)
    expect(store.getState().selection).toEqual(threadTarget)
    expect(store.getState().selectionRevision).toBe(1)
    expect(store.getState().draftsById[draftIdOf(threadTarget)]).toMatchObject({
      target: threadTarget,
      text: '',
      revision: 0,
      attachmentIds: [],
    })

    store.getState().selectTarget(threadTarget)
    expect(store.getState().selectionRevision).toBe(2)
    expect(Object.keys(store.getState().draftsById)).toHaveLength(1)

    // 删除当前会话等显式清理选择时推进 revision，草稿仍保留供恢复。
    store.getState().clearSelection()
    expect(store.getState().selection).toBeUndefined()
    expect(store.getState().selectionRevision).toBe(3)
    expect(store.getState().draftsById[draftIdOf(threadTarget)]).toBeDefined()
  })

  it('文字/模型变化推进 draftRevision 并持久化文字', () => {
    const store = createStore()
    const id = draftIdOf(newTarget)
    store.getState().selectTarget(newTarget)
    store.getState().editDraftText(id, 'hello')
    expect(store.getState().draftsById[id]).toMatchObject({ text: 'hello', revision: 1 })
    store.getState().editDraftText(id, 'hello')
    expect(store.getState().draftsById[id]?.revision).toBe(1)

    store.getState().setDraftModel(id, { provider: 'p', modelId: 'm' })
    store.getState().setDraftThinkingLevel(id, 'high')
    expect(store.getState().draftsById[id]).toMatchObject({
      revision: 3,
      model: { provider: 'p', modelId: 'm' },
      thinkingLevel: 'high',
    })
  })

  it('存储作用域切换保留已输入文字并恢复新作用域文字与选择', () => {
    const storage = memoryStorage()
    const store = createHarnessWindowStore({
      windowId: 'window-a',
      storageScope: 'old',
      storage,
    })
    const id = draftIdOf(threadTarget)
    store.getState().selectTarget(threadTarget)
    store.getState().editDraftText(id, '旧作用域输入')

    storage.setItem(`${'new'}|draft:${id}`, '新作用域草稿')
    storage.setItem(`${'new'}|selection`, JSON.stringify(newTarget))
    store.getState().setStorageScope('new')

    // 非空草稿保留用户输入并迁移到新作用域。
    expect(store.getState().draftsById[id]?.text).toBe('旧作用域输入')
    expect(storage.values.get(`new|draft:${id}`)).toBe('旧作用域输入')

    const emptyStorage = memoryStorage()
    emptyStorage.setItem(`${'new'}|selection`, JSON.stringify(newTarget))
    const emptyStore = createHarnessWindowStore({
      windowId: 'window-b',
      storageScope: 'old',
      storage: emptyStorage,
    })
    emptyStore.getState().setStorageScope('new')
    // 新作用域没有草稿文字，持久化选择被恢复。
    expect(emptyStore.getState().selection).toEqual(newTarget)
    expect(emptyStore.getState().selectionRevision).toBe(1)
  })
})

describe('window-store：附件、提交与本窗历史', () => {
  it('附件加入推进草稿版本；移除时仍被提交引用则保留内容', () => {
    const store = createStore()
    const draftId = draftIdOf(threadTarget)
    store.getState().selectTarget(threadTarget)
    const attachmentId = store.getState().addAttachment(draftId, {
      fileName: 'a.png',
      mimeType: 'image/png',
      blob: new Blob(['image']),
    })
    expect(attachmentId).toBeDefined()
    expect(store.getState().draftsById[draftId]).toMatchObject({
      attachmentIds: [attachmentId],
      revision: 1,
    })

    const submission = store.getState().captureSubmission({ mode: 'prompt' })
    expect(submission?.attachmentIds).toEqual([attachmentId])

    store.getState().removeAttachment(draftId, attachmentId!)
    expect(store.getState().draftsById[draftId]?.attachmentIds).toEqual([])
    // 提交仍持有附件内容。
    expect(store.getState().attachmentsById[attachmentId!]?.blob).toBeDefined()

    // 移除附件也是新编辑，失败恢复不能撤销用户的移除决定。
    store.getState().setSubmissionStatus(submission!.id, 'failed')
    expect(store.getState().restoreSubmission(submission!.id)).toBe(false)
    expect(store.getState().draftsById[draftId]?.attachmentIds).toEqual([])

    store.getState().removeSubmission(submission!.id)
    expect(store.getState().attachmentsById[attachmentId!]).toBeUndefined()
  })

  it('同步捕获目标、草稿版本、来源、模型与模式', () => {
    const store = createStore()
    store.getState().selectTarget(newTarget)
    const draftId = draftIdOf(newTarget)
    store.getState().editDraftText(draftId, 'hello')
    store.getState().setDraftModel(draftId, { provider: 'p', modelId: 'm' })
    const capture = store.getState().captureSubmission({ mode: 'steer' })

    expect(capture).toMatchObject({
      target: newTarget,
      content: 'hello',
      attachmentIds: [],
      model: { provider: 'p', modelId: 'm' },
      mode: 'steer',
      status: 'pending',
      draft: { draftId, revision: 2 },
      origin: { selectionRevision: 1 },
    })

    store.getState().editDraftText(draftId, '')
    expect(store.getState().captureSubmission({ mode: 'prompt' })).toBeUndefined()
  })

  it('恢复提交只在草稿版本未变时生效，不覆盖后来编辑', () => {
    const store = createStore()
    store.getState().selectTarget(threadTarget)
    const draftId = draftIdOf(threadTarget)
    store.getState().editDraftText(draftId, '原始输入')
    const capture = store.getState().captureSubmission({ mode: 'prompt' })!

    store.getState().setSubmissionStatus(capture.id, 'unknown')
    expect(store.getState().restoreSubmission(capture.id)).toBe(true)
    expect(store.getState().draftsById[draftId]?.text).toBe('原始输入')

    store.getState().editDraftText(draftId, '新的输入')
    const second = store.getState().captureSubmission({ mode: 'prompt' })!
    store.getState().setSubmissionStatus(second.id, 'failed')
    store.getState().editDraftText(draftId, '更新的输入')
    expect(store.getState().restoreSubmission(second.id)).toBe(false)
    expect(store.getState().draftsById[draftId]?.text).toBe('更新的输入')
    store.getState().editDraftText(draftId, '')
    expect(store.getState().restoreSubmission(second.id)).toBe(false)
    expect(store.getState().draftsById[draftId]?.text).toBe('')
  })

  it('输入历史去重、忽略空值并限制 50 项', () => {
    const store = createStore()
    store.getState().recordInputHistory(' first ')
    store.getState().recordInputHistory('first')
    store.getState().recordInputHistory('   ')
    store.getState().recordInputHistory('second')
    expect(store.getState().inputHistory).toEqual(['second', 'first'])

    for (let index = 0; index < 60; index++) {
      store.getState().recordInputHistory(`item-${index}`)
    }
    expect(store.getState().inputHistory).toHaveLength(50)
    expect(store.getState().inputHistory[0]).toBe('item-59')
  })

  it('dispose 清空内存状态并阻止后续动作', () => {
    const store = createStore()
    store.getState().selectTarget(threadTarget)
    store.getState().dispose()
    expect(store.getState().disposed).toBe(true)
    expect(store.getState().selection).toBeUndefined()
    expect(store.getState().draftsById).toEqual({})
    store.getState().selectTarget(newTarget)
    expect(store.getState().selection).toBeUndefined()
  })
})
