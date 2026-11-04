import type {
  HarnessHostUiRequest,
  HarnessSubagentClient,
  HarnessSubagentTask,
  HarnessSubagentTaskStatus,
  HarnessSubagentTaskView,
} from '@huan/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createSubagentFeatureStore } from './subagent-store'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const taskOf = (status: HarnessSubagentTaskStatus = 'running'): HarnessSubagentTask => ({
  taskId: 'task-1',
  parentThreadId: 't1',
  agent: 'reviewer',
  task: '审查改动',
  status,
  model: 'anthropic/claude',
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  ...(status === 'completed' ? { output: '完成结果' } : {}),
})

const viewOf = (
  overrides: Partial<HarnessSubagentTaskView> = {},
  status: HarnessSubagentTaskStatus = 'running',
): HarnessSubagentTaskView => ({
  task: taskOf(status),
  snapshot: {
    metadata: { id: 'task-1', status: status === 'running' ? 'running' : 'idle' },
    messages: [],
  },
  requests: [],
  ...overrides,
})

const editorRequest: HarnessHostUiRequest = {
  id: 'r1',
  kind: 'editor',
  title: '补充说明',
  prefill: '预填',
}

const confirmRequest: HarnessHostUiRequest = {
  id: 'r2',
  kind: 'confirm',
  title: '继续？',
  message: '子任务等待确认。',
}

const createStore = () => {
  const client = {
    getSubagentTask: vi.fn(async () => viewOf()),
    cancelSubagentTask: vi.fn(async () => undefined),
    respondSubagentTask: vi.fn(async () => undefined),
  } as unknown as HarnessSubagentClient
  return { client, store: createSubagentFeatureStore({ client }) }
}

describe('subagent feature：只读查看与逐任务操作', () => {
  it('打开时固定父会话/任务、读取视图并初始化答案草稿', async () => {
    const { client, store } = createStore()
    const view = viewOf({ requests: [editorRequest] })
    vi.mocked(client.getSubagentTask).mockResolvedValueOnce(view)

    await store.getState().openTask('t1', 'task-1')

    expect(client.getSubagentTask).toHaveBeenCalledWith('t1', 'task-1')
    expect(store.getState()).toMatchObject({
      open: true,
      parentId: 't1',
      taskId: 'task-1',
      view,
      loading: false,
      error: undefined,
      busy: false,
    })
    expect(store.getState().answers.r1).toMatchObject({
      text: '预填',
      busy: false,
      error: undefined,
    })
  })

  it('关闭后迟到的读取结果不覆盖面板', async () => {
    const { client, store } = createStore()
    const gate = deferred<HarnessSubagentTaskView>()
    vi.mocked(client.getSubagentTask).mockReturnValueOnce(gate.promise)

    const opening = store.getState().openTask('t1', 'task-1')
    expect(store.getState().open).toBe(true)
    store.getState().close()
    gate.resolve(viewOf())
    await opening

    expect(store.getState()).toMatchObject({
      open: false,
      parentId: 't1',
      taskId: 'task-1',
      view: undefined,
      loading: false,
    })
  })

  it('关闭后保留正文供退出动画，动画完成清理且不清理重开的任务', async () => {
    const { store } = createStore()
    await store.getState().openTask('t1', 'task-1')
    const view = store.getState().view
    store.getState().close()
    expect(store.getState().view).toBe(view)
    store.getState().completeClose()
    expect(store.getState().view).toBeUndefined()
    await store.getState().openTask('t1', 'task-2')
    store.getState().completeClose()
    expect(store.getState().taskId).toBe('task-2')
    expect(store.getState().view).toBeDefined()
  })

  it('刷新保留同一请求的草稿，并移除已结算请求', async () => {
    const { client, store } = createStore()
    vi.mocked(client.getSubagentTask).mockResolvedValueOnce(
      viewOf({ requests: [editorRequest, confirmRequest] }),
    )
    await store.getState().openTask('t1', 'task-1')
    store.getState().setAnswer('r1', '用户输入')

    vi.mocked(client.getSubagentTask).mockResolvedValueOnce(viewOf({ requests: [editorRequest] }))
    await store.getState().refresh()

    expect(store.getState().answers.r1?.text).toBe('用户输入')
    expect(store.getState().answers.r2).toBeUndefined()
  })

  it('读取失败如实显示，不关闭面板也不伪造视图', async () => {
    const { client, store } = createStore()
    vi.mocked(client.getSubagentTask).mockRejectedValueOnce(new Error('读取失败'))

    await store.getState().openTask('t1', 'task-1')

    expect(store.getState()).toMatchObject({
      open: true,
      view: undefined,
      loading: false,
      error: '读取失败',
    })
  })

  it('取消任务后刷新终态并清空忙状态', async () => {
    const { client, store } = createStore()
    vi.mocked(client.getSubagentTask)
      .mockResolvedValueOnce(viewOf())
      .mockResolvedValueOnce(viewOf({}, 'cancelled'))
    await store.getState().openTask('t1', 'task-1')

    await store.getState().cancelTask()

    expect(client.cancelSubagentTask).toHaveBeenCalledWith('t1', 'task-1')
    expect(client.getSubagentTask).toHaveBeenCalledTimes(2)
    expect(store.getState().view?.task.status).toBe('cancelled')
    expect(store.getState().busy).toBe(false)
  })

  it('取消失败保留当前视图并显示错误', async () => {
    const { client, store } = createStore()
    await store.getState().openTask('t1', 'task-1')
    vi.mocked(client.cancelSubagentTask).mockRejectedValueOnce(new Error('取消失败'))

    await store.getState().cancelTask()

    expect(store.getState().view?.task.status).toBe('running')
    expect(store.getState().busy).toBe(false)
    expect(store.getState().error).toBe('取消失败')
  })

  it('input/editor 使用草稿应答，成功后刷新并清空文本', async () => {
    const { client, store } = createStore()
    vi.mocked(client.getSubagentTask).mockResolvedValue(viewOf({ requests: [editorRequest] }))
    await store.getState().openTask('t1', 'task-1')
    store.getState().setAnswer('r1', '实际答复')

    const accepted = await store.getState().respond('r1')

    expect(accepted).toBe(true)
    expect(client.respondSubagentTask).toHaveBeenCalledWith('t1', 'task-1', {
      requestId: 'r1',
      value: '实际答复',
    })
    expect(store.getState().answers.r1).toMatchObject({
      text: '',
      busy: false,
      error: undefined,
    })
  })

  it('confirm/select 必须显式应答；应答失败保留草稿与错误', async () => {
    const { client, store } = createStore()
    vi.mocked(client.getSubagentTask).mockResolvedValue(viewOf({ requests: [confirmRequest] }))
    await store.getState().openTask('t1', 'task-1')

    expect(await store.getState().respond('r2')).toBe(false)
    expect(client.respondSubagentTask).not.toHaveBeenCalled()

    vi.mocked(client.respondSubagentTask).mockRejectedValueOnce(new Error('应答无效'))
    const accepted = await store.getState().respond('r2', {
      requestId: 'r2',
      confirmed: true,
    })
    expect(accepted).toBe(false)
    expect(client.respondSubagentTask).toHaveBeenCalledWith('t1', 'task-1', {
      requestId: 'r2',
      confirmed: true,
    })
    expect(store.getState().answers.r2).toMatchObject({
      busy: false,
      error: '应答无效',
    })
  })

  it('dispose 后拒绝打开并清理面板', async () => {
    const { client, store } = createStore()
    store.getState().dispose()
    await store.getState().openTask('t1', 'task-1')

    expect(client.getSubagentTask).not.toHaveBeenCalled()
    expect(store.getState()).toMatchObject({
      open: false,
      view: undefined,
      answers: {},
      disposed: true,
    })
  })
})
