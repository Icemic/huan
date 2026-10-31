import type {
  HarnessAnyClientEvent,
  HarnessClientEvent,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createHarnessHttpClient } from './http-client.js'

type Call = { url: string; method: string; body: unknown }

/** A fake `fetch` that records calls and returns whatever `responder` yields. */
const fakeFetch = (responder: (url: string) => Response) => {
  const calls: Call[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body as string) : undefined,
    })
    return responder(url)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const _sseResponse = (
  event: HarnessAnyClientEvent,
  { keepOpen = false }: { keepOpen?: boolean } = {},
): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        if (!keepOpen) controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

const snapshot: HarnessThreadSnapshot = {
  metadata: { id: 't1', status: 'idle' },
  messages: [],
}

const _openSharedSse = () => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller)
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
  ) as unknown as typeof fetch
  const client = createHarnessHttpClient({
    fetchImpl,
    reconnectDelay: () => Promise.resolve(),
  })
  const send = (index: number, event: HarnessAnyClientEvent) => {
    controllers[index]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
  }
  const close = (index: number) => {
    controllers[index]!.close()
  }
  return { client, fetchImpl, send, close }
}

const snapshotAt = (
  seq: number,
  status: 'idle' | 'running' = 'idle',
  messages: HarnessThreadSnapshot['messages'] = [],
) =>
  ({
    type: 'snapshot',
    threadId: 't1',
    seq,
    snapshot: {
      metadata: { id: 't1', status, messageCount: messages.length },
      messages,
    },
  }) satisfies HarnessAnyClientEvent

describe('createHarnessHttpClient', () => {
  it('lists threads with workspace + archived query params', async () => {
    const threads: HarnessThreadMetadata[] = [{ id: 't1', status: 'idle' }]
    const { fn, calls } = fakeFetch(() => json(threads))
    const client = createHarnessHttpClient({ fetchImpl: fn })

    const result = await client.listThreads({
      workspaceId: 'ws_1',
      includeArchived: true,
    })

    expect(result).toEqual(threads)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe('/api/pi/threads?workspaceId=ws_1&includeArchived=true')
  })

  it('omits empty query params when listing', async () => {
    const { fn, calls } = fakeFetch(() => json([]))
    await createHarnessHttpClient({ fetchImpl: fn }).listThreads()
    expect(calls[0]!.url).toBe('/api/pi/threads')
  })

  it('creates a thread by POSTing the input and parses the snapshot', async () => {
    const { fn, calls } = fakeFetch(() => json(snapshot))
    const client = createHarnessHttpClient({ fetchImpl: fn })

    const result = await client.createThread({ workspaceId: 'ws_1', startProjectPath: '/ws' })

    expect(result).toEqual(snapshot)
    expect(calls[0]).toMatchObject({
      url: '/api/pi/threads',
      method: 'POST',
      body: { workspaceId: 'ws_1', startProjectPath: '/ws' },
    })
  })

  it('fetches a thread snapshot by id', async () => {
    const { fn, calls } = fakeFetch(() => json(snapshot))
    await createHarnessHttpClient({ fetchImpl: fn }).getThread('a/b')
    expect(calls[0]!.method).toBe('GET')
    // The id is URL-encoded into the path.
    expect(calls[0]!.url).toBe('/api/pi/threads/a%2Fb')
  })

  it('accepts activity flags on thread snapshots', async () => {
    const snapshotWithActivity = {
      ...snapshot,
      metadata: {
        ...snapshot.metadata,
        status: 'running' as const,
        compactionActive: true,
        retryActive: true,
        retryAttempt: 2,
      },
      seq: 7,
    }
    const { fn } = fakeFetch(() => json(snapshotWithActivity))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).resolves.toEqual(
      snapshotWithActivity,
    )
  })

  it('sends a message wrapped as { input }', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    await createHarnessHttpClient({ fetchImpl: fn }).sendMessage('t1', {
      content: 'hi',
      streamingBehavior: 'steer',
    })
    expect(calls[0]).toMatchObject({
      url: '/api/pi/threads/t1/messages',
      method: 'POST',
      body: { input: { content: 'hi', streamingBehavior: 'steer' } },
    })
  })

  it('cancels and renames a thread', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    const client = createHarnessHttpClient({ fetchImpl: fn })

    await client.cancelRun('t1')
    await client.renameThread('t1', 'New title')

    expect(calls[0]).toMatchObject({
      url: '/api/pi/threads/t1/cancel',
      method: 'POST',
    })
    expect(calls[1]).toMatchObject({
      url: '/api/pi/threads/t1',
      method: 'PATCH',
      body: { title: 'New title' },
    })
  })

  it('clears the queue and parses the cleared text', async () => {
    const { fn, calls } = fakeFetch(() => json({ steering: ['a'], followUp: ['b'] }))
    const client = createHarnessHttpClient({ fetchImpl: fn })

    const cleared = await client.clearQueue('t1')

    expect(calls[0]).toMatchObject({
      url: '/api/pi/threads/t1/queue/clear',
      method: 'POST',
    })
    expect(cleared).toEqual({ steering: ['a'], followUp: ['b'] })
  })

  it('gets models and sets model/thinking through routes', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.startsWith('/api/pi/models')
        ? json([{ provider: 'anthropic', modelId: 'claude' }])
        : new Response(null, { status: 204 }),
    )
    const client = createHarnessHttpClient({ fetchImpl: fn })

    await expect(client.getAvailableModels({ workspacePath: '/ws' })).resolves.toEqual([
      { provider: 'anthropic', modelId: 'claude' },
    ])
    await client.setModel('t1', { provider: 'anthropic', modelId: 'claude' })
    await client.setThinkingLevel('t1', 'high')

    expect(calls[0]).toMatchObject({
      url: '/api/pi/models?workspacePath=%2Fws',
      method: 'GET',
    })
    expect(calls[1]).toMatchObject({
      url: '/api/pi/threads/t1/model',
      method: 'POST',
      body: { provider: 'anthropic', modelId: 'claude' },
    })
    expect(calls[2]).toMatchObject({
      url: '/api/pi/threads/t1/thinking',
      method: 'POST',
      body: { level: 'high' },
    })
  })

  it('archives, unarchives, and deletes threads', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    const client = createHarnessHttpClient({ fetchImpl: fn })

    await client.archiveThread('t1')
    await client.unarchiveThread('t1')
    await client.deleteThread('t1')

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/pi/threads/t1/archive'],
      ['POST', '/api/pi/threads/t1/unarchive'],
      ['DELETE', '/api/pi/threads/t1'],
    ])
  })

  it('treats deleting a thread the server no longer has as done', async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 404 }))

    await expect(
      createHarnessHttpClient({ fetchImpl: fn }).deleteThread('gone'),
    ).resolves.toBeUndefined()
  })

  it('posts a host-ui response wrapped as { response }', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    await createHarnessHttpClient({ fetchImpl: fn }).respondToHostUiRequest('t1', {
      requestId: 'r1',
      confirmed: true,
    })
    expect(calls[0]).toMatchObject({
      url: '/api/pi/threads/t1/host-ui',
      method: 'POST',
      body: { response: { requestId: 'r1', confirmed: true } },
    })
  })

  it('throws with the response body on a non-2xx status', async () => {
    const { fn } = fakeFetch(() => new Response('session not found', { status: 404 }))
    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('missing')).rejects.toThrow(
      /404.*session not found/s,
    )
  })

  it('rejects a malformed thread list response', async () => {
    const { fn } = fakeFetch(() => json({}))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).listThreads()).rejects.toThrow(
      'Invalid Pi HTTP response while listing threads: expected an array of threads.',
    )
  })

  it('identifies malformed thread metadata by index', async () => {
    const { fn } = fakeFetch(() => json([{ id: 't1' }]))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).listThreads()).rejects.toThrow(
      'Invalid Pi HTTP response while listing threads: thread at index 0 must have a non-empty string "id", a string "status", and correctly typed known fields.',
    )
  })

  it('rejects malformed known thread metadata fields', async () => {
    const { fn } = fakeFetch(() => json([{ id: 't1', status: 'idle', archived: 'yes' }]))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).listThreads()).rejects.toThrow(
      'Invalid Pi HTTP response while listing threads: thread at index 0 must have a non-empty string "id", a string "status", and correctly typed known fields.',
    )
  })

  it('accepts unknown enum values from newer Pi servers', async () => {
    const thread = {
      id: 't1',
      status: 'paused',
      queuedMessages: [{ id: 'q1', mode: 'priority', content: 'later' }],
    }
    const listFetch = fakeFetch(() => json([thread])).fn
    const snapshotWithUnknownValues = {
      metadata: thread,
      messages: [{ role: 'futureRole' }],
      hostUiRequests: [{ id: 'r1', kind: 'form' }],
    }
    const snapshotFetch = fakeFetch(() => json(snapshotWithUnknownValues)).fn

    await expect(createHarnessHttpClient({ fetchImpl: listFetch }).listThreads()).resolves.toEqual([
      thread,
    ])
    await expect(
      createHarnessHttpClient({ fetchImpl: snapshotFetch }).getThread('t1'),
    ).resolves.toEqual(snapshotWithUnknownValues)
  })

  it('rejects malformed thread snapshots', async () => {
    const { fn } = fakeFetch(() => json({ metadata: snapshot.metadata }))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).rejects.toThrow(
      'Invalid Pi HTTP response while fetching a thread: expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  })

  it('rejects malformed known transcript messages', async () => {
    const { fn } = fakeFetch(() =>
      json({
        ...snapshot,
        messages: [{ role: 'assistant' }],
      }),
    )

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).rejects.toThrow(
      'Invalid Pi HTTP response while fetching a thread: expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  })

  it('accepts renderable messages with missing or null scalar metadata', async () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      responseModel: null,
      errorMessage: null,
    }
    const response = { ...snapshot, messages: [message] }
    const { fn } = fakeFetch(() => json(response))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).resolves.toEqual(
      response,
    )
  })

  it('accepts tool calls with null arguments', async () => {
    const response = {
      ...snapshot,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'search', arguments: null }],
        },
      ],
    }
    const { fn } = fakeFetch(() => json(response))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).resolves.toEqual(
      response,
    )
  })

  it('rejects bash executions without a command', async () => {
    const { fn } = fakeFetch(() =>
      json({
        ...snapshot,
        messages: [{ role: 'bashExecution', output: 'x' }],
      }),
    )

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).rejects.toThrow(
      'Invalid Pi HTTP response while fetching a thread: expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  })

  it('accepts renderable bash executions without scalar metadata', async () => {
    const response = {
      ...snapshot,
      messages: [{ role: 'bashExecution', command: 'ls', output: 'x' }],
    }
    const { fn } = fakeFetch(() => json(response))

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).resolves.toEqual(
      response,
    )
  })

  it('rejects tool results without a tool call id', async () => {
    const { fn } = fakeFetch(() =>
      json({
        ...snapshot,
        messages: [{ role: 'toolResult', content: [] }],
      }),
    )

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).rejects.toThrow(
      'Invalid Pi HTTP response while fetching a thread: expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  })

  it('rejects malformed known host UI request shapes', async () => {
    const { fn } = fakeFetch(() =>
      json({
        ...snapshot,
        hostUiRequests: [{ id: 'r1', kind: 'select', title: 'Choose' }],
      }),
    )

    await expect(createHarnessHttpClient({ fetchImpl: fn }).getThread('t1')).rejects.toThrow(
      'Invalid Pi HTTP response while fetching a thread: expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  })

  it('rejects malformed queue and model responses', async () => {
    const queueFetch = fakeFetch(() => json({ steering: [1], followUp: [] })).fn
    const modelFetch = fakeFetch(() => json([{ provider: 'anthropic' }])).fn

    await expect(
      createHarnessHttpClient({ fetchImpl: queueFetch }).clearQueue('t1'),
    ).rejects.toThrow(
      'Invalid Pi HTTP response while clearing a thread queue: expected an object with string arrays "steering" and "followUp".',
    )
    await expect(
      createHarnessHttpClient({ fetchImpl: modelFetch }).getAvailableModels(),
    ).rejects.toThrow(
      'Invalid Pi HTTP response while listing models: model at index 0 must have non-empty string "provider" and "modelId" fields.',
    )
  })

  it('delivers a terminal error event when the decoder limit is exceeded', async () => {
    const oversizedSnapshot = `data: ${JSON.stringify({ ...snapshotAt(1), padding: 'x'.repeat(2048) })}\n\n`
    const fetchImpl = vi.fn(
      async () =>
        new Response(oversizedSnapshot, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch
    const reconnectDelay = vi.fn(() => Promise.resolve())
    const client = createHarnessHttpClient({
      fetchImpl,
      reconnectDelay,
      maxStreamLineLength: 1024,
    })
    const events: HarnessAnyClientEvent[] = []
    const unsubscribe = client.subscribe('t1', (event) => events.push(event))

    try {
      await vi.waitFor(() =>
        expect(events).toEqual([
          expect.objectContaining({
            type: 'error',
            threadId: 't1',
            seq: 0,
            error: expect.stringContaining('SSE line exceeds maxLineLength'),
            terminal: true,
          }),
        ]),
      )
      // 终止性错误不再重连：解码器限制无法靠重连恢复
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(reconnectDelay).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('adds operation context to invalid JSON errors', async () => {
    const { fn } = fakeFetch(
      () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    )

    await expect(createHarnessHttpClient({ fetchImpl: fn }).listThreads()).rejects.toThrow(
      'Invalid Pi HTTP response while listing threads: expected valid JSON.',
    )
  })

  it('honors a custom baseUrl', async () => {
    const { fn, calls } = fakeFetch(() => json([]))
    await createHarnessHttpClient({
      fetchImpl: fn,
      baseUrl: 'https://host.example/pi/',
    }).listThreads()
    expect(calls[0]!.url).toBe('https://host.example/pi/threads')
  })

  it('can subscribe to live events without an initial snapshot', async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    const client = createHarnessHttpClient({
      fetchImpl: fn,
    })

    const unsubscribe = client.subscribe('t1', () => {}, {
      includeSnapshot: false,
    })
    unsubscribe()

    expect(calls[0]!.url).toBe('/api/pi/threads/t1/events?snapshot=false')
  })

  it('delivers parsed SSE events to the subscriber', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller)
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    ) as unknown as typeof fetch

    const client = createHarnessHttpClient({
      fetchImpl,
      reconnectDelay: () => Promise.resolve(),
    })
    const received: HarnessClientEvent[] = []
    const unsubscribe = client.subscribe('t1', (event) => {
      received.push(event)
    })

    try {
      await vi.waitFor(() => expect(controllers.length).toBe(1))
      const event = snapshotAt(1)
      controllers[0]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toMatchObject({ type: 'snapshot', threadId: 't1', seq: 1 })
    } finally {
      unsubscribe()
    }
  })

  it('gives each subscriber its own connection (no cross-component sharing)', async () => {
    const opened: number[] = []
    let opens = 0
    const fetchImpl = vi.fn(async () => {
      opened.push(++opens)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            void controller
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    const client = createHarnessHttpClient({
      fetchImpl,
      reconnectDelay: () => Promise.resolve(),
    })
    const unsubscribeA = client.subscribe('t1', () => {})
    const unsubscribeB = client.subscribe('t1', () => {})

    try {
      // 每个订阅独立建连（决策点 5：不做跨组件共享）
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    } finally {
      unsubscribeA()
      unsubscribeB()
    }
  })

  it('isolates listener errors so delivery continues', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller)
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    ) as unknown as typeof fetch
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const client = createHarnessHttpClient({
      fetchImpl,
      reconnectDelay: () => Promise.resolve(),
    })
    const delivered: string[] = []
    const unsubscribe = client.subscribe('t1', (event) => {
      delivered.push(event.type)
      throw new Error('listener exploded')
    })

    try {
      await vi.waitFor(() => expect(controllers.length).toBe(1))
      const encode = (event: HarnessAnyClientEvent) =>
        new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
      controllers[0]!.enqueue(encode(snapshotAt(1)))
      controllers[0]!.enqueue(
        encode({ type: 'agent_start', threadId: 't1', seq: 2 } satisfies HarnessAnyClientEvent),
      )
      await vi.waitFor(() => expect(delivered.length).toBe(2))
      expect(consoleError).toHaveBeenCalled()
    } finally {
      unsubscribe()
      consoleError.mockRestore()
    }
  })

  it('closes the underlying connection on unsubscribe', async () => {
    let aborted = false
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            void controller
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    const client = createHarnessHttpClient({
      fetchImpl,
      reconnectDelay: () => Promise.resolve(),
    })
    const unsubscribe = client.subscribe('t1', () => {})
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    unsubscribe()
    await vi.waitFor(() => expect(aborted).toBe(true))
  })
})
