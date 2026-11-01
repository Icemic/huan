// @vitest-environment jsdom

import type { AppendMessage, ExternalStoreAdapter } from '@assistant-ui/react'
import type { HarnessClient, HarnessHostUiRequest } from '@huan/protocol'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adapters: [] as ExternalStoreAdapter[],
  repository: undefined as unknown,
  state: undefined as unknown,
  liveState: undefined as unknown,
  threadListItem: {
    id: 't1',
    remoteId: 't1' as string | undefined,
    externalId: 't1' as string | undefined,
    status: 'regular' as 'new' | 'regular' | 'archived',
  },
  mainThreadId: 't1',
  allListeners: new Set<() => void>(),
  messageListeners: new Set<() => void>(),
  activeRun: undefined as string | undefined,
  cancelledRuns: [] as string[],
  controller: {
    load: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    clearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
    respondToHostUiRequest: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@assistant-ui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useAui: () => ({
    threadListItem: {
      ...mocks.threadListItem,
      initialize: vi.fn().mockResolvedValue(undefined),
    },
  }),
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      threadListItem: mocks.threadListItem,
      threads: { mainThreadId: mocks.mainThreadId },
    }),
  useExternalStoreRuntime: (adapter: ExternalStoreAdapter) => {
    mocks.adapters.push(adapter)
    return {}
  },
  useRemoteThreadListRuntime: (options: { runtimeHook: () => unknown }) => options.runtimeHook(),
}))

vi.mock('./thread-controller.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./thread-controller.js')>()

  class HarnessThreadController {
    getState = () => mocks.liveState ?? mocks.state
    getStateSnapshot = () => mocks.state
    getProjectedMessages = () => []
    getMessageRepository = () => mocks.repository
    getVersion = () => 0
    subscribe = (listener: () => void) => {
      mocks.allListeners.add(listener)
      return () => mocks.allListeners.delete(listener)
    }
    subscribeMetadata = () => () => {}
    subscribeMessages = (listener: () => void) => {
      mocks.messageListeners.add(listener)
      return () => mocks.messageListeners.delete(listener)
    }
    connect = () => () => {}
    load = mocks.controller.load
    refresh = vi.fn().mockResolvedValue(undefined)
    sendMessage = mocks.controller.sendMessage
    cancel = vi.fn(async () => {
      if (mocks.activeRun) mocks.cancelledRuns.push(mocks.activeRun)
    })
    captureCancel = () => {
      const run = mocks.activeRun
      return async () => {
        if (mocks.activeRun === run) await this.cancel()
      }
    }
    clearQueue = mocks.controller.clearQueue
    setModel = vi.fn().mockResolvedValue(undefined)
    setThinkingLevel = vi.fn().mockResolvedValue(undefined)
    respondToToolApproval = vi.fn().mockResolvedValue(undefined)
    resumeToolCall = vi.fn().mockResolvedValue(undefined)
    respondToHostUiRequest = mocks.controller.respondToHostUiRequest
    dispose = vi.fn()
  }

  return { ...original, HarnessThreadController }
})

import { ExportedMessageRepository, MessageNotSentError } from '@assistant-ui/react'
import { HarnessHttpError } from '../client/http-client.js'
import type { HarnessRuntimeExtrasInternal } from './runtime-types.js'
import type { HarnessThreadControllerLike } from './thread-controller.js'
import { createHarnessThreadState, type HarnessThreadState } from './thread-state.js'
import {
  NOOP_CONTROLLER,
  useHarnessControllerStateSelector,
  useHarnessRuntime,
} from './use-harness-runtime.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  mocks.adapters.length = 0
  mocks.threadListItem = {
    id: 't1',
    remoteId: 't1',
    externalId: 't1',
    status: 'regular',
  }
  mocks.mainThreadId = 't1'
  mocks.liveState = undefined
  mocks.allListeners.clear()
  mocks.messageListeners.clear()
  mocks.activeRun = undefined
  mocks.cancelledRuns.length = 0
  vi.restoreAllMocks()
})

describe('useHarnessRuntime Stop', () => {
  it('cancels the run active when Stop was pressed without cancelling a replacement', async () => {
    mocks.state = { ...createHarnessThreadState('t1'), runStatus: 'running' }
    mocks.repository = ExportedMessageRepository.fromArray([])
    mocks.activeRun = 'original'
    const client = {} as HarnessClient
    const App = () => {
      useHarnessRuntime({ client, initialThreadId: 't1' })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const adapter = mocks.adapters.at(-1)!
    const firstStop = adapter.onCancel!()
    await firstStop
    expect(mocks.cancelledRuns).toEqual(['original'])

    const clear = Promise.withResolvers<{
      steering: string[]
      followUp: string[]
    }>()
    mocks.controller.clearQueue.mockReturnValueOnce(clear.promise)
    const stop = adapter.onCancel!()
    const message: AppendMessage = {
      role: 'user',
      createdAt: new Date(0),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: 'new' }],
    }
    mocks.controller.sendMessage.mockImplementationOnce(async () => {
      mocks.activeRun = 'replacement'
    })
    await adapter.onNew(message)
    clear.resolve({ steering: [], followUp: [] })
    await stop

    expect(mocks.cancelledRuns).toEqual(['original'])
  })
})

describe('useHarnessRuntime error callbacks', () => {
  it('reports a pending load failure to the latest callback without reloading', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])
    const client = {} as HarnessClient
    let rejectLoad!: (error: unknown) => void
    mocks.controller.load.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectLoad = reject
      }),
    )
    const first = vi.fn()
    const latest = vi.fn()
    const App = ({ onError }: { onError: (error: unknown) => void }) => {
      useHarnessRuntime({ client, onError, initialThreadId: 't1' })
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App, { onError: first })))
    await act(async () => root!.render(createElement(App, { onError: latest })))
    expect(mocks.controller.load).toHaveBeenCalledOnce()

    const loadError = new Error('load failed')
    await act(async () => rejectLoad(loadError))
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith(loadError)
  })

  it('does not report sends that never reached Pi', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])
    const notSent = new MessageNotSentError()
    mocks.controller.sendMessage.mockRejectedValueOnce(notSent)
    const onError = vi.fn()

    const App = () => {
      useHarnessRuntime({
        client: {} as HarnessClient,
        onError,
        initialThreadId: 't1',
      })
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const adapter = mocks.adapters.at(-1)!
    await expect(
      adapter.onNew({
        role: 'user',
        createdAt: new Date(0),
        metadata: { custom: {} },
        parentId: null,
        sourceId: null,
        runConfig: undefined,
        content: [{ type: 'text', text: 'hello' }],
      }),
    ).rejects.toBe(notSent)
    expect(onError).not.toHaveBeenCalled()
  })

  it('turns rejected 4xx sends into MessageNotSentError and still reports the reason', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])
    const rejected = new HarnessHttpError(
      '内置命令 /model 必须经 GUI 入口执行',
      409,
      'reserved-builtin-command',
      'model',
    )
    mocks.controller.sendMessage.mockRejectedValueOnce(rejected)
    const onError = vi.fn()

    const App = () => {
      useHarnessRuntime({
        client: {} as HarnessClient,
        onError,
        initialThreadId: 't1',
      })
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const adapter = mocks.adapters.at(-1)!
    const result = adapter.onNew({
      role: 'user',
      createdAt: new Date(0),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: '/model' }],
    })
    await expect(result).rejects.toBeInstanceOf(MessageNotSentError)
    expect(onError).toHaveBeenCalledWith(rejected)
  })

  it('does not report cancelled queue sends', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])
    mocks.controller.sendMessage
      .mockRejectedValueOnce(new MessageNotSentError())
      .mockRejectedValueOnce(new MessageNotSentError())
    const onError = vi.fn()

    const App = () => {
      useHarnessRuntime({
        client: {} as HarnessClient,
        onError,
        initialThreadId: 't1',
      })
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const queue = mocks.adapters.at(-1)!.queue!
    const message: AppendMessage = {
      role: 'user',
      createdAt: new Date(0),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
      content: [{ type: 'text', text: 'hello' }],
    }
    queue.enqueue(message)
    queue.steer(message)
    await vi.waitFor(() => expect(mocks.controller.sendMessage).toHaveBeenCalledTimes(2))
    await act(async () => Promise.resolve())

    expect(onError).not.toHaveBeenCalled()
  })

  for (const failureMode of ['throws', 'rejects'] as const) {
    it(`preserves the controller error when onError ${failureMode}`, async () => {
      mocks.state = createHarnessThreadState('t1')
      mocks.repository = ExportedMessageRepository.fromArray([])
      const controllerError = new Error('send failed')
      const callbackError = new Error('telemetry failed')
      mocks.controller.sendMessage.mockRejectedValueOnce(controllerError)
      const onError = vi.fn(
        failureMode === 'throws'
          ? () => {
              throw callbackError
            }
          : async () => {
              throw callbackError
            },
      )
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      const App = () => {
        useHarnessRuntime({
          client: {} as HarnessClient,
          onError,
          initialThreadId: 't1',
        })
        return null
      }

      root = createRoot(document.createElement('div'))
      await act(async () => root!.render(createElement(App)))

      const adapter = mocks.adapters.at(-1)!
      const message: AppendMessage = {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: new Date(),
        metadata: { custom: {} },
        attachments: [],
        parentId: null,
        sourceId: null,
        runConfig: undefined,
      }

      await expect(adapter.onNew(message)).rejects.toBe(controllerError)
      expect(onError).toHaveBeenCalledWith(controllerError)
      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          '[huan-react] onError callback threw an error',
          callbackError,
        ),
      )
    })
  }
})

describe('useHarnessRuntime tool approvals', () => {
  const renderRuntime = async (onError?: (error: unknown) => void) => {
    const App = () => {
      useHarnessRuntime({
        client: {} as HarnessClient,
        initialThreadId: 't1',
        ...(onError ? { onError } : {}),
      })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))
    return mocks.adapters.at(-1)!
  }

  it('answers the pending request the approval was projected from', async () => {
    mocks.state = {
      ...createHarnessThreadState('t1'),
      hostUiRequests: [
        {
          id: 'r1',
          kind: 'select',
          title: 'Deploy where?',
          options: ['staging', 'production'],
          toolCallId: 'tc1',
        },
      ],
    } satisfies HarnessThreadState
    mocks.repository = ExportedMessageRepository.fromArray([])

    const adapter = await renderRuntime()
    await adapter.onRespondToToolApproval!({
      approvalId: 'r1',
      approved: true,
      optionId: '1',
    })

    expect(mocks.controller.respondToHostUiRequest).toHaveBeenCalledExactlyOnceWith({
      requestId: 'r1',
      value: 'production',
    })
  })

  it('rejects an answer once its request is no longer pending', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])
    const onError = vi.fn()

    const adapter = await renderRuntime(onError)
    await expect(
      adapter.onRespondToToolApproval!({ approvalId: 'r1', approved: true }),
    ).rejects.toThrow('No pending host-UI request "r1"')

    expect(onError).toHaveBeenCalledOnce()
    expect(mocks.controller.respondToHostUiRequest).not.toHaveBeenCalled()
  })
})

describe('useHarnessRuntime stable extras fields', () => {
  it('keeps actions and free-standing Host UI requests across state updates', async () => {
    const requests: readonly HarnessHostUiRequest[] = [
      { id: 'r1', kind: 'confirm', title: 'Continue?', message: 'Proceed with the run.' },
    ]
    const initialState: HarnessThreadState = {
      ...createHarnessThreadState('t1'),
      hostUiRequests: requests,
    }
    mocks.state = initialState
    mocks.repository = ExportedMessageRepository.fromArray([])

    const client = {} as HarnessClient
    const App = () => {
      useHarnessRuntime({ client, initialThreadId: 't1' })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const before = mocks.adapters.at(-1)!.extras as HarnessRuntimeExtrasInternal
    expect(before.hostUiRequests).toEqual(requests)

    await act(async () => {
      mocks.state = { ...initialState, runStatus: 'running' }
      for (const listener of [...mocks.allListeners]) listener()
    })

    const after = mocks.adapters.at(-1)!.extras as HarnessRuntimeExtrasInternal
    expect(after).not.toBe(before)
    // 状态更新只替换数据字段；动作与未变化的请求数组保持引用。
    expect(after.actions).toBe(before.actions)
    expect(after.hostUiRequests).toBe(before.hostUiRequests)
    expect(after.allHostUiRequests).toBe(before.allHostUiRequests)
  })

  it('rebinds actions to the new Controller when the main thread changes', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])
    let rerender!: () => void
    const client = {} as HarnessClient
    const App = () => {
      const [, setTick] = useState(0)
      rerender = () => setTick((tick) => tick + 1)
      useHarnessRuntime({ client, initialThreadId: 't1' })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const before = mocks.adapters.at(-1)!.extras as HarnessRuntimeExtrasInternal
    const firstController = before.controller
    expect(firstController).not.toBe(NOOP_CONTROLLER)

    mocks.threadListItem = { id: 't2', remoteId: 't2', externalId: 't2', status: 'regular' }
    mocks.mainThreadId = 't2'
    mocks.state = createHarnessThreadState('t2')
    await act(async () => rerender())

    const after = mocks.adapters.at(-1)!.extras as HarnessRuntimeExtrasInternal
    expect(after.controller).not.toBe(firstController)
    expect(after.actions).not.toBe(before.actions)

    await after.actions.setModel({ provider: 'test', modelId: 'model-b' })
    expect(vi.mocked(after.controller.setModel)).toHaveBeenCalledWith({
      provider: 'test',
      modelId: 'model-b',
    })
    expect(vi.mocked(firstController.setModel)).not.toHaveBeenCalled()
  })
})

describe('useHarnessRuntime new-thread store', () => {
  it('keeps the composer enabled while initialization has no remote ids', async () => {
    mocks.threadListItem = {
      id: '__LOCALID_new',
      remoteId: undefined,
      externalId: undefined,
      status: 'regular',
    }
    mocks.mainThreadId = '__LOCALID_new'

    const client = {} as HarnessClient
    const App = () => {
      useHarnessRuntime({ client })
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))

    const adapter = mocks.adapters.at(-1)!
    expect(adapter.isDisabled).toBe(false)
    expect(adapter.isLoading).toBe(false)
  })
})

describe('useHarnessRuntime controller subscriptions', () => {
  const renderRuntime = async () => {
    let renders = 0
    const client = {} as HarnessClient
    const App = () => {
      renders += 1
      useHarnessRuntime({ client, initialThreadId: 't1' })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(App)))
    return { renderCount: () => renders }
  }

  // A metadata-only change (queue_update, agent_start, …) notifies the
  // metadata and all channels but never the message channel, so the store must
  // read state from the all channel, which fires with every notification.
  it('republishes state on a metadata-only notification', async () => {
    const initialState = createHarnessThreadState('t1')
    mocks.state = initialState
    mocks.repository = ExportedMessageRepository.fromArray([])

    const { renderCount } = await renderRuntime()
    const rendersAfterMount = renderCount()

    const before = mocks.adapters.at(-1)!
    expect(before.isRunning).toBe(false)
    expect(before.extras).toMatchObject({ state: initialState })

    const runningState = { ...initialState, runStatus: 'running' as const }
    await act(async () => {
      mocks.state = runningState
      for (const listener of [...mocks.allListeners]) listener()
    })

    const after = mocks.adapters.at(-1)!
    expect(after.isRunning).toBe(true)
    expect(after.extras).toMatchObject({ state: runningState })
    expect(renderCount()).toBe(rendersAfterMount + 1)
  })

  it('publishes the snapshot, not the state running ahead of it', async () => {
    const settled = createHarnessThreadState('t1')
    mocks.state = settled
    mocks.repository = ExportedMessageRepository.fromArray([])

    await renderRuntime()
    expect(mocks.adapters.at(-1)!.extras).toMatchObject({ state: settled })

    // a coalesced message frame has reduced but not yet notified
    mocks.liveState = { ...settled, runStatus: 'running' as const }
    await act(async () => {
      for (const listener of [...mocks.allListeners]) listener()
    })

    expect(mocks.adapters.at(-1)!.isRunning).toBe(false)
    expect(mocks.adapters.at(-1)!.extras).toMatchObject({ state: settled })
  })

  it('republishes the repository on a message notification', async () => {
    const initialRepository = ExportedMessageRepository.fromArray([])
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = initialRepository

    await renderRuntime()
    expect(mocks.adapters.at(-1)!.messageRepository).toBe(initialRepository)

    const nextRepository = ExportedMessageRepository.fromArray([])
    await act(async () => {
      mocks.repository = nextRepository
      for (const listener of [...mocks.messageListeners, ...mocks.allListeners]) listener()
    })

    expect(mocks.adapters.at(-1)!.messageRepository).toBe(nextRepository)
  })

  it('leaves the store untouched when nothing on the controller changed', async () => {
    mocks.state = createHarnessThreadState('t1')
    mocks.repository = ExportedMessageRepository.fromArray([])

    await renderRuntime()
    const before = mocks.adapters.at(-1)!

    await act(async () => {
      for (const listener of [...mocks.messageListeners, ...mocks.allListeners]) listener()
    })

    expect(mocks.adapters.at(-1)!).toBe(before)
  })
})

const publishableController = () => {
  let state = createHarnessThreadState('t1')
  const listeners = new Set<() => void>()
  return {
    controller: {
      ...NOOP_CONTROLLER,
      getState: () => state,
      getStateSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as HarnessThreadControllerLike,
    publish: (patch: Partial<HarnessThreadState> = {}) => {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('useHarnessControllerStateSelector', () => {
  it('re-renders only when the selected slice changes', async () => {
    const { controller, publish } = publishableController()
    const container = document.createElement('div')
    let renders = 0
    const App = () => {
      const status = useHarnessControllerStateSelector(controller, (state) => state.runStatus)
      renders++
      return createElement('div', null, status)
    }

    root = createRoot(container)
    await act(async () => root!.render(createElement(App)))
    expect(renders).toBe(1)

    await act(async () => publish())
    await act(async () => publish())
    expect(renders).toBe(1)

    await act(async () => publish({ runStatus: 'running' }))
    expect(renders).toBe(2)
    expect(container.textContent).toBe('running')
  })

  it('re-runs a selector whose closure changed without a publish', async () => {
    const { controller } = publishableController()
    const container = document.createElement('div')
    let setLabel: ((label: string) => void) | undefined
    const App = () => {
      const [label, set] = useState('a')
      setLabel = set
      const text = useHarnessControllerStateSelector(
        controller,
        (state) => `${state.runStatus}:${label}`,
      )
      return createElement('div', null, text)
    }

    root = createRoot(container)
    await act(async () => root!.render(createElement(App)))
    expect(container.textContent).toBe('idle:a')

    await act(async () => setLabel!('b'))
    expect(container.textContent).toBe('idle:b')
  })

  it('supports selectors that allocate objects and arrays', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    const App = () => {
      const view = useHarnessControllerStateSelector(NOOP_CONTROLLER, (state) => ({
        status: state.runStatus,
        queued: state.queue.followUp.length,
      }))
      const requests = useHarnessControllerStateSelector(NOOP_CONTROLLER, (state) =>
        state.hostUiRequests.filter(() => true),
      )
      return createElement('div', null, `${view.status}:${view.queued}:${requests.length}`)
    }

    root = createRoot(container)
    await act(async () => root!.render(createElement(App)))

    expect(container.textContent).toBe('idle:0:0')
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('getSnapshot should be cached')
  })
})
