// @vitest-environment jsdom

import type { AssistantRuntime } from '@assistant-ui/react'
import { AssistantRuntimeProvider, ExportedMessageRepository } from '@assistant-ui/react'
import type { HarnessClient, HarnessThreadSnapshot } from '@huan/protocol'
import { act, createElement, StrictMode, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown[],
  sendMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@assistant-ui/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@assistant-ui/react')>()
  return {
    ...original,
    useExternalStoreRuntime: (adapter: Parameters<typeof original.useExternalStoreRuntime>[0]) => {
      mocks.adapters.push(adapter)
      return original.useExternalStoreRuntime(adapter)
    },
  }
})

vi.mock('./thread-controller.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./thread-controller.js')>()

  class HarnessThreadController {
    state = createHarnessThreadState('t-new')
    repository = ExportedMessageRepository.fromArray([])
    getState = () => this.state
    getProjectedMessages = () => []
    getMessageRepository = () => this.repository
    getVersion = () => 0
    subscribe = () => () => {}
    subscribeMetadata = () => () => {}
    subscribeMessages = () => () => {}
    connect = () => () => {}
    load = vi.fn().mockResolvedValue(undefined)
    refresh = vi.fn().mockResolvedValue(undefined)
    sendMessage = mocks.sendMessage
    cancel = vi.fn().mockResolvedValue(undefined)
    clearQueue = vi.fn().mockResolvedValue({ steering: [], followUp: [] })
    setModel = vi.fn().mockResolvedValue(undefined)
    setThinkingLevel = vi.fn().mockResolvedValue(undefined)
    respondToToolApproval = vi.fn().mockResolvedValue(undefined)
    resumeToolCall = vi.fn().mockResolvedValue(undefined)
    respondToHostUiRequest = vi.fn().mockResolvedValue(undefined)
    dispose = vi.fn()
  }

  return { ...original, HarnessThreadController }
})

import { createHarnessThreadState } from './thread-state.js'
import { useHarnessRuntime } from './use-harness-runtime.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const snapshot: HarnessThreadSnapshot = {
  metadata: { id: 'srv-1', status: 'idle' },
  messages: [],
} as unknown as HarnessThreadSnapshot

const createClient = (
  createThreadImpl: (options?: {
    initialMessage?: unknown
  }) => Promise<HarnessThreadSnapshot> = () => Promise.resolve(snapshot),
) => {
  const createThread = vi.fn(createThreadImpl)
  const client = {
    listThreads: vi.fn().mockResolvedValue([]),
    createThread,
    getThread: vi.fn().mockResolvedValue(snapshot),
    subscribe: vi.fn().mockReturnValue(() => {}),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as HarnessClient
  return { client, createThread }
}

const sentTexts = () =>
  mocks.sendMessage.mock.calls.map((call) => {
    const content = (call[0] as { content: readonly { text?: string }[] }).content
    return content.map((part) => part.text).join('')
  })

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  mocks.adapters.length = 0
})

describe('useHarnessRuntime new-thread first message', () => {
  it('delivers the first message of a brand-new thread', async () => {
    const { client, createThread } = createClient()
    let runtime!: AssistantRuntime

    const Harness = () => {
      runtime = useHarnessRuntime({ client })
      return createElement(AssistantRuntimeProvider, { runtime }, null)
    }

    root = createRoot(document.createElement('div'))
    await act(async () => {
      root!.render(createElement(Harness))
    })
    await act(async () => {})

    await act(async () => {
      await runtime.thread.append('hello pi')
    })
    await act(async () => {})
    await act(async () => {})

    expect(createThread).toHaveBeenCalledTimes(1)
    // The core initializes before onNew runs, so the atomic path cannot see
    // the message; delivery must happen exactly once via the live thread.
    expect(createThread.mock.calls[0]?.[0]?.initialMessage).toBeUndefined()
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(sentTexts()).toEqual(['hello pi'])
  })

  it('delivers both messages when a second send lands during initialization', async () => {
    let resolveCreate!: (value: HarnessThreadSnapshot) => void
    const { client, createThread } = createClient(
      () =>
        new Promise<HarnessThreadSnapshot>((resolve) => {
          resolveCreate = resolve
        }),
    )
    let runtime!: AssistantRuntime

    const Harness = () => {
      runtime = useHarnessRuntime({ client })
      return createElement(AssistantRuntimeProvider, { runtime }, null)
    }

    root = createRoot(document.createElement('div'))
    await act(async () => {
      root!.render(createElement(Harness))
    })
    await act(async () => {})

    let first!: Promise<void> | void
    let second!: Promise<void> | void
    await act(async () => {
      first = runtime.thread.append('message A')
      second = runtime.thread.append('message B')
    })

    await act(async () => {
      resolveCreate(snapshot)
      await Promise.all([first, second])
    })
    await act(async () => {})

    expect(createThread).toHaveBeenCalledTimes(1)
    expect(createThread.mock.calls[0]?.[0]?.initialMessage).toBeUndefined()
    expect(sentTexts()).toEqual(['message A', 'message B'])
  })

  it('drops a pending new-thread send after runtime teardown', async () => {
    const sessionCreate = Promise.withResolvers<HarnessThreadSnapshot>()
    const { client, createThread } = createClient(() => sessionCreate.promise)
    let runtime!: AssistantRuntime

    const Harness = () => {
      runtime = useHarnessRuntime({ client })
      return createElement(AssistantRuntimeProvider, { runtime }, null)
    }

    root = createRoot(document.createElement('div'))
    await act(async () => {
      root!.render(createElement(Harness))
    })
    await act(async () => {})

    await act(async () => {
      runtime.thread.append('late message')
    })
    await vi.waitFor(() => expect(createThread).toHaveBeenCalledOnce())

    act(() => root!.unmount())
    root = undefined
    sessionCreate.resolve(snapshot)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps a pending new-thread send across StrictMode effect replay', async () => {
    const sessionCreate = Promise.withResolvers<HarnessThreadSnapshot>()
    const { client, createThread } = createClient(() => sessionCreate.promise)
    let sendPromise: Promise<void> | void

    const Harness = () => {
      const runtime = useHarnessRuntime({ client })
      const sentRef = useRef(false)
      useEffect(() => {
        if (sentRef.current) return
        sentRef.current = true
        const adapter = mocks.adapters.at(-1) as {
          onNew: (message: {
            role: 'user'
            content: [{ type: 'text'; text: string }]
          }) => Promise<void>
        }
        sendPromise = adapter.onNew({
          role: 'user',
          content: [{ type: 'text', text: 'strict mode message' }],
        })
      }, [])
      return createElement(AssistantRuntimeProvider, { runtime }, null)
    }

    root = createRoot(document.createElement('div'))
    await act(async () => {
      root!.render(createElement(StrictMode, null, createElement(Harness)))
    })
    await vi.waitFor(() => expect(createThread).toHaveBeenCalledOnce())

    await act(async () => {
      sessionCreate.resolve(snapshot)
      await sendPromise
    })

    expect(mocks.sendMessage).toHaveBeenCalledOnce()
    expect(sentTexts()).toEqual(['strict mode message'])
  })
})
