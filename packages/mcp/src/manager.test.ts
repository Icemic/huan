/**
 * 连接管理器测试（G1.4d2a），使用官方 testing 内存 transport 做确定性定序。
 *
 * 覆盖构造无 I/O、输入克隆/namespace 碰撞、快照与目录副本、动态 tools 合并、
 * opening 单飞、断线重连、临时启停/exposure、取消等待连接、超时、失败撤下目录
 * 与秘密不进入快照/错误。真实 stdio/HTTP 在 stdio.test.ts 与 http.test.ts。
 */

import type { McpTransport } from '@earendil-works/pi-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMcpConnectionManager,
  type McpConnectionManager,
  McpManagerInputError,
  type McpServerConfig,
  type McpServerEntry,
  type McpTransportFactory,
  type McpTransportFactoryContext,
} from './index.js'
import {
  createMemoryMcpServer,
  type MemoryMcpServer,
  type MemoryMcpServerOptions,
  MemoryRpcError,
} from './test-fixtures/memory-server.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function makeEntry(
  name: string,
  config: McpServerConfig,
  extra: Partial<McpServerEntry> = {},
): McpServerEntry {
  return {
    name,
    config,
    source: '/tmp/mcp.json',
    scope: 'user',
    ...extra,
  }
}

function createMemoryManager(
  entries: McpServerEntry[],
  serverOptions?: (
    context: McpTransportFactoryContext,
    index: number,
  ) => MemoryMcpServerOptions | Promise<MemoryMcpServerOptions>,
  wrapTransport?: (transport: McpTransport, index: number) => McpTransport,
): {
  manager: McpConnectionManager
  servers: MemoryMcpServer[]
  contexts: McpTransportFactoryContext[]
} {
  const servers: MemoryMcpServer[] = []
  const contexts: McpTransportFactoryContext[] = []
  const factory: McpTransportFactory = async (context) => {
    contexts.push(context)
    const options = serverOptions ? await serverOptions(context, servers.length) : {}
    const server = await createMemoryMcpServer(options)
    servers.push(server)
    return wrapTransport
      ? wrapTransport(server.clientTransport, servers.length - 1)
      : server.clientTransport
  }
  const manager = createMcpConnectionManager({
    cwd: process.cwd(),
    servers: entries,
    createTransport: factory,
    env: {},
  })
  cleanups.push(async () => {
    await manager.close()
    await Promise.allSettled(servers.map((server) => server.close()))
  })
  return { manager, servers, contexts }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function firstServer(servers: MemoryMcpServer[]): MemoryMcpServer {
  const server = servers[0]
  if (!server) throw new Error('missing memory server')
  return server
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const echoTool = {
  name: 'echo',
  description: 'Echo text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}

const secretTool = {
  name: 'secret_tool',
  description: 'Hidden tool',
  inputSchema: { type: 'object', properties: {} },
}

describe('构造与输入', () => {
  it('构造不调用 transport、值解析或命令', async () => {
    let factoryCalled = false
    let commandCalled = false
    createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [
        makeEntry('demo', {
          command: 'fixture',
          env: { TOKEN: '!never-run' },
          args: ['original'],
        }),
      ],
      createTransport: () => {
        factoryCalled = true
        throw new Error('must not be called')
      },
      runCommand: async () => {
        commandCalled = true
        return 'x'
      },
    })
    await Promise.resolve()
    expect(factoryCalled).toBe(false)
    expect(commandCalled).toBe(false)
  })

  it('克隆输入，后续修改调用方条目不影响连接', async () => {
    const input = makeEntry('demo', {
      command: 'fixture',
      args: ['original'],
      env: { TOKEN: 'literal' },
    })
    const { manager, contexts } = createMemoryManager([input])
    input.name = 'mutated'
    const config = input.config as { args?: string[]; env?: Record<string, string> }
    if (!config.args || !config.env) throw new Error('missing config fields')
    config.args[0] = 'changed'
    config.env.TOKEN = 'changed'
    await manager.start()
    const context = contexts[0]
    expect(context?.entry.name).toBe('demo')
    if (!context) throw new Error('missing transport context')
    expect((context.entry.config as { args?: string[] }).args).toEqual(['original'])
    expect((context.entry.config as { env?: Record<string, string> }).env).toEqual({
      TOKEN: 'literal',
    })
  })

  it('拒绝 namespace 碰撞与无效条目', () => {
    try {
      createMcpConnectionManager({
        cwd: process.cwd(),
        servers: [
          makeEntry('a-b', { command: 'fixture' }),
          makeEntry('a_b', { command: 'fixture' }),
        ],
      })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(McpManagerInputError)
      expect((error as McpManagerInputError).code).toBe('namespace-collision')
    }

    expect(() =>
      createMcpConnectionManager({
        cwd: process.cwd(),
        servers: [makeEntry('bad name', { command: 'fixture' })],
      }),
    ).toThrowError(McpManagerInputError)
  })
})

describe('启动、快照与目录', () => {
  it('显式 start 后发布连接状态，目录/版本为独立副本', async () => {
    const { manager } = createMemoryManager(
      [
        makeEntry('demo', {
          command: 'fixture',
          exposure: 'direct',
          toolExposure: { secret_tool: 'hidden' },
        }),
      ],
      () => ({ tools: [echoTool, secretTool], instructions: 'Do useful things.' }),
    )
    expect(manager.snapshot()).toMatchObject({ started: false, closed: false })
    await manager.start()
    const snapshot = manager.snapshot()
    expect(snapshot.servers[0]).toMatchObject({
      name: 'demo',
      scope: 'user',
      source: '/tmp/mcp.json',
      enabled: true,
      exposure: 'direct',
      state: 'connected',
      toolCount: 2,
      hasResources: true,
      toolRevision: 1,
    })
    expect(JSON.stringify(snapshot)).not.toContain('fixture')

    const catalog = manager.getToolCatalog('demo')
    expect(catalog.revision).toBe(1)
    expect(catalog.instructions).toBe('Do useful things.')
    expect(catalog.tools.map((tool) => [tool.name, tool.exposure])).toEqual([
      ['echo', 'direct'],
      ['secret_tool', 'hidden'],
    ])
    ;(catalog.tools[0] as { name: string }).name = 'mutated'
    ;(catalog.tools as unknown as unknown[]).push({})
    expect(manager.getToolCatalog('demo').tools[0]?.name).toBe('echo')
    expect(manager.getToolCatalogRevision('demo')).toBe(1)

    const firstSnapshot = manager.snapshot()
    ;(firstSnapshot.servers[0] as { name: string }).name = 'mutated'
    expect(manager.snapshot().servers[0]?.name).toBe('demo')
    expect(firstSnapshot.revision).toBe(manager.snapshot().revision)
  })

  it('监听者异常隔离，快照不可原地修改', async () => {
    const { manager } = createMemoryManager([makeEntry('demo', { command: 'fixture' })])
    let calls = 0
    manager.subscribe(() => {
      throw new Error('listener failure')
    })
    manager.subscribe((snapshot) => {
      calls += 1
      expect(snapshot.servers[0]?.name).toBe('demo')
    })
    await manager.start()
    expect(calls).toBeGreaterThan(0)
  })

  it('资源查询遵循 server exposure 与 resources 能力', async () => {
    const { manager } = createMemoryManager([makeEntry('demo', { command: 'fixture' })], () => ({
      capabilities: { tools: { listChanged: true } },
    }))
    await manager.start()
    expect(manager.listResourceServers()).toEqual([])
    await expect(manager.listResources('demo')).rejects.toMatchObject({
      code: 'resources-unavailable',
    })
    manager.setExposure('demo', 'hidden')
    await expect(manager.listResources('demo')).rejects.toMatchObject({ code: 'server-hidden' })
  })

  it('值解析失败只投影受控错误码，不回显变量名或值', async () => {
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [
        makeEntry('demo', {
          command: 'fixture',
          env: { TOKEN: '$HUAN_MISSING_SECRET' },
        }),
      ],
      env: {},
    })
    cleanups.push(async () => {
      await manager.close()
    })
    await manager.start()
    const snapshot = manager.snapshot()
    expect(snapshot.servers[0]).toMatchObject({
      state: 'failed',
      error: { code: 'value-resolution-failed' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('HUAN_MISSING_SECRET')
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({
      code: 'connect-failed',
    })
  })

  it('连接失败互相隔离，快照只有受控错误码', async () => {
    const secret = 'HUAN-SECRET-VALUE'
    const entries = [
      makeEntry('bad', {
        url: `http://127.0.0.1:9/mcp?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}` },
      }),
      makeEntry('good', { command: 'fixture' }),
    ]
    const servers: MemoryMcpServer[] = []
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: entries,
      createTransport: async (context) => {
        if (context.entry.name === 'bad') throw new Error(`raw failure ${secret}`)
        const server = await createMemoryMcpServer({})
        servers.push(server)
        return server.clientTransport
      },
    })
    cleanups.push(async () => {
      await manager.close()
      await Promise.allSettled(servers.map((server) => server.close()))
    })
    await manager.start()
    const snapshot = manager.snapshot()
    const bad = snapshot.servers.find((server) => server.name === 'bad')
    const good = snapshot.servers.find((server) => server.name === 'good')
    expect(bad).toMatchObject({ state: 'failed', error: { code: 'connect-failed' } })
    expect(good).toMatchObject({ state: 'connected' })
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    await expect(manager.callTool('bad', 'echo')).rejects.toMatchObject({ code: 'connect-failed' })
    try {
      await manager.callTool('bad', 'echo')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})

describe('动态 tools', () => {
  it('初始 tools/list 期间的通知会在连接确认后补刷新', async () => {
    const initial = deferred<{ tools: (typeof echoTool)[] }>()
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        listToolsHandler: (count) =>
          count === 1 ? initial.promise : { tools: [{ ...echoTool, name: 'new' }] },
      }),
    )
    const starting = manager.start()
    await waitFor(() => servers.length === 1 && firstServer(servers).toolListCount === 1)
    await firstServer(servers).notify('notifications/tools/list_changed')
    initial.resolve({ tools: [echoTool] })
    await starting
    await waitFor(() => manager.getToolCatalog('demo').tools[0]?.name === 'new')
  })

  it('list_changed 刷新目录并更新版本', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        tools: [echoTool],
      }),
    )
    await manager.start()
    const server = firstServer(servers)
    server.tools = [
      echoTool,
      {
        name: 'dynamic_tool',
        description: 'Added later',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    await server.notify('notifications/tools/list_changed')
    await waitFor(() => manager.snapshot().servers[0]?.toolCount === 2)
    expect(manager.getToolCatalog('demo').revision).toBe(2)
    expect(manager.getToolCatalog('demo').tools.map((tool) => tool.name)).toContain('dynamic_tool')
  })

  it('并发通知串行合并，旧结果不覆盖新结果', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        tools: [echoTool],
      }),
    )
    await manager.start()
    const server = firstServer(servers)
    const first = deferred<{ tools: (typeof echoTool)[] }>()
    const second = deferred<{ tools: (typeof echoTool)[] }>()
    let refreshCalls = 0
    server.listToolsHandler = async () => {
      refreshCalls += 1
      if (refreshCalls === 1) return first.promise
      if (refreshCalls === 2) return second.promise
      return { tools: [echoTool] }
    }
    await server.notify('notifications/tools/list_changed')
    await server.notify('notifications/tools/list_changed')
    await waitFor(() => refreshCalls === 1)
    // 第二次通知在第一次刷新结束前被合并，不会并行发第二个 tools/list。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refreshCalls).toBe(1)
    first.resolve({
      tools: [echoTool, { ...echoTool, name: 'stale_tool' }],
    })
    await waitFor(() => refreshCalls === 2)
    second.resolve({
      tools: [echoTool, { ...echoTool, name: 'fresh_tool' }],
    })
    await waitFor(() =>
      manager.getToolCatalog('demo').tools.some((tool) => tool.name === 'fresh_tool'),
    )
    expect(manager.getToolCatalog('demo').tools.map((tool) => tool.name)).not.toContain(
      'stale_tool',
    )
  })

  it('重连期间旧 tools/list 结果不能覆盖新目录', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        tools: [echoTool],
      }),
    )
    await manager.start()
    const stale = deferred<{ tools: (typeof echoTool)[] }>()
    firstServer(servers).listToolsHandler = () => stale.promise
    await firstServer(servers).notify('notifications/tools/list_changed')
    await waitFor(() => firstServer(servers).toolListCount === 2)
    const reconnecting = manager.reconnect('demo')
    await waitFor(
      () => servers.length === 2 && manager.snapshot().servers[0]?.state === 'connected',
    )
    stale.resolve({ tools: [{ ...echoTool, name: 'stale_tool' }] })
    await reconnecting
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(manager.getToolCatalog('demo').tools.map((tool) => tool.name)).not.toContain(
      'stale_tool',
    )
  })

  it('刷新失败撤下无法确认的目录，恢复后重新出现', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        tools: [echoTool],
      }),
    )
    await manager.start()
    const server = firstServer(servers)
    server.listToolsHandler = async () => {
      throw new MemoryRpcError(-32603, 'refresh failed')
    }
    await server.notify('notifications/tools/list_changed')
    await waitFor(() => manager.getToolCatalogRevision('demo') === 2)
    expect(manager.getToolCatalog('demo').tools).toEqual([])
    expect(manager.snapshot().servers[0]?.error?.code).toBe('tools-refresh-failed')
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({
      code: 'tool-unavailable',
    })
    expect(server.toolCalls).toHaveLength(0)

    server.listToolsHandler = undefined
    await server.notify('notifications/tools/list_changed')
    await waitFor(() => manager.getToolCatalog('demo').tools.length === 1)
    expect(manager.snapshot().servers[0]?.error).toBeUndefined()
    await expect(manager.callTool('demo', 'echo', { text: 'ok' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'echo:ok' }],
    })
  })
})

describe('生命周期与竞态', () => {
  it('opening 单飞：并发 start/调用只初始化一次', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        initializeDelayMs: 30,
      }),
    )
    const starting = manager.start()
    const calls = Promise.all([
      manager.callTool('demo', 'echo', { text: 'a' }),
      manager.callTool('demo', 'echo', { text: 'b' }),
    ])
    await expect(calls).resolves.toHaveLength(2)
    await starting
    expect(servers).toHaveLength(1)
    expect(firstServer(servers).initializeCount).toBe(1)
  })

  it('断线后下一次调用懒重连', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({ tools: [echoTool] }),
    )
    await manager.start()
    await firstServer(servers).close()
    await waitFor(() => manager.snapshot().servers[0]?.state === 'disconnected')
    await expect(manager.callTool('demo', 'echo', { text: 'again' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'echo:again' }],
    })
    expect(servers).toHaveLength(2)
  })

  it('启动时禁用的服务器不会被普通调用重新连接', async () => {
    let factoryCalls = 0
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [makeEntry('demo', { command: 'fixture', enabled: false })],
      createTransport: () => {
        factoryCalls += 1
        throw new Error('must not connect')
      },
    })
    cleanups.push(async () => {
      await manager.close()
    })
    await manager.start()
    expect(factoryCalls).toBe(0)
    expect(manager.snapshot().servers[0]).toMatchObject({ enabled: false, state: 'disabled' })
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({
      code: 'server-disabled',
    })
    expect(factoryCalls).toBe(0)
  })

  it('禁用/隐藏不会通过普通调用复活；单工具 hidden 拒绝调用', async () => {
    const { manager, servers } = createMemoryManager(
      [
        makeEntry('demo', {
          command: 'fixture',
          toolExposure: { secret_tool: 'hidden' },
        }),
      ],
      () => ({ tools: [echoTool, secretTool] }),
    )
    await manager.start()
    const server = firstServer(servers)
    await expect(manager.callTool('demo', 'secret_tool')).rejects.toMatchObject({
      code: 'tool-hidden',
    })
    expect(server.toolCalls).toHaveLength(0)
    await expect(manager.callTool('demo', 'echo', { text: 'ok' })).resolves.toBeDefined()

    manager.setExposure('demo', 'hidden')
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({ code: 'tool-hidden' })
    expect(manager.listResourceServers()).toEqual([])
    manager.setExposure('demo', 'direct')
    await expect(manager.callTool('demo', 'echo', { text: 'back' })).resolves.toBeDefined()

    await manager.setEnabled('demo', false)
    expect(manager.snapshot().servers[0]).toMatchObject({
      enabled: false,
      state: 'disabled',
      toolCount: 0,
    })
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({
      code: 'server-disabled',
    })
    await expect(server.notify('notifications/tools/list_changed')).rejects.toThrow()

    await manager.setEnabled('demo', true)
    await waitFor(() => manager.snapshot().servers[0]?.state === 'connected')
    expect(servers).toHaveLength(2)
    await expect(manager.callTool('demo', 'echo', { text: 'enabled' })).resolves.toBeDefined()
  })

  it('禁用会中止慢初始化，晚到结果不能重开', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      (_context, index) => (index === 0 ? { initializeDelayMs: 1_000 } : {}),
    )
    const starting = manager.start()
    await waitFor(() => servers.length === 1 && firstServer(servers).initializeCount === 1)
    expect(manager.snapshot().servers[0]?.state).toBe('connecting')
    await manager.setEnabled('demo', false)
    await starting
    expect(manager.snapshot().servers[0]?.state).toBe('disabled')
    await expect(firstServer(servers).notify('notifications/tools/list_changed')).rejects.toThrow()

    await manager.setEnabled('demo', true)
    await waitFor(() => manager.snapshot().servers[0]?.state === 'connected')
    expect(servers).toHaveLength(2)
  })

  it('重复 close 等待同一个完整 transport close promise', async () => {
    const server = await createMemoryMcpServer({})
    let closeCalls = 0
    let closeFinished = false
    let closing = false
    const originalClose = server.clientTransport.close.bind(server.clientTransport)
    server.clientTransport.close = async () => {
      // 对端 close 会回调本方 close；只让第一次走延迟路径。
      if (closing) return originalClose()
      closing = true
      closeCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 100))
      await originalClose()
      closeFinished = true
    }
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [makeEntry('demo', { command: 'fixture' })],
      createTransport: () => server.clientTransport,
    })
    cleanups.push(async () => {
      await manager.close()
      await server.close()
    })
    await manager.start()
    const started = Date.now()
    const first = manager.close()
    const second = manager.close()
    await Promise.all([first, second])
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
    expect(closeCalls).toBe(1)
    expect(closeFinished).toBe(true)
  })

  it('close 是终态，等待连接中的 opening 收尾', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        initializeDelayMs: 1_000,
      }),
    )
    const starting = manager.start()
    await waitFor(() => servers.length === 1 && firstServer(servers).initializeCount === 1)
    const firstClose = manager.close()
    const secondClose = manager.close()
    await Promise.all([firstClose, secondClose, starting])
    const snapshot = manager.snapshot()
    expect(snapshot.closed).toBe(true)
    expect(snapshot.servers[0]?.state).toBe('closed')
    await expect(manager.start()).rejects.toMatchObject({ code: 'manager-closed' })
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({ code: 'manager-closed' })
  })

  it('关闭订阅中重复 close 不重入', async () => {
    const { manager } = createMemoryManager([makeEntry('demo', { command: 'fixture' })])
    await manager.start()
    let notifications = 0
    manager.subscribe((snapshot) => {
      if (!snapshot.closed) return
      notifications += 1
      void manager.close()
    })
    await manager.close()
    expect(notifications).toBeLessThan(10)
    expect(manager.snapshot().closed).toBe(true)
  })

  it('禁用/启用与普通调用竞态时等待旧 transport 关闭，只建一套新连接', async () => {
    const servers: MemoryMcpServer[] = []
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [makeEntry('demo', { command: 'fixture' })],
      createTransport: async () => {
        const server = await createMemoryMcpServer({})
        servers.push(server)
        if (servers.length === 1) {
          let closing = false
          const originalClose = server.clientTransport.close.bind(server.clientTransport)
          server.clientTransport.close = async () => {
            if (closing) return originalClose()
            closing = true
            await new Promise((resolve) => setTimeout(resolve, 100))
            await originalClose()
          }
        }
        return server.clientTransport
      },
    })
    cleanups.push(async () => {
      await manager.close()
      await Promise.allSettled(servers.map((server) => server.close()))
    })
    await manager.start()
    const disabling = manager.setEnabled('demo', false)
    const enabling = manager.setEnabled('demo', true)
    const call = manager.callTool('demo', 'echo', { text: 'race' })
    await expect(call).resolves.toMatchObject({
      content: [{ type: 'text', text: 'echo:race' }],
    })
    await Promise.all([disabling, enabling])
    await waitFor(() => manager.snapshot().servers[0]?.state === 'connected')
    expect(servers).toHaveLength(2)
  })

  it('取消等待连接后不再发送请求', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        initializeHandler: () => new Promise(() => undefined),
      }),
    )
    const starting = manager.start()
    await waitFor(() => servers.length === 1 && firstServer(servers).methods.includes('initialize'))
    const controller = new AbortController()
    const pending = manager.callTool(
      'demo',
      'echo',
      { text: 'never' },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(firstServer(servers).methods).not.toContain('tools/call')
    await manager.close()
    await starting
  })

  it('exposure 与连接重建使目录版本单调失效', async () => {
    const { manager } = createMemoryManager([makeEntry('demo', { command: 'fixture' })])
    await manager.start()
    const first = manager.getToolCatalogRevision('demo')
    manager.setExposure('demo', 'direct')
    const exposed = manager.getToolCatalogRevision('demo')
    expect(exposed).toBeGreaterThan(first)
    await manager.reconnect('demo')
    const reconnected = manager.getToolCatalogRevision('demo')
    expect(reconnected).toBeGreaterThan(exposed)
    await manager.setEnabled('demo', false)
    expect(manager.getToolCatalogRevision('demo')).toBeGreaterThan(reconnected)
  })

  it('等待初始化期间隐藏工具，请求发送前重新检查', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({ initializeDelayMs: 60 }),
    )
    const starting = manager.start()
    const pending = manager.callTool('demo', 'echo')
    manager.setExposure('demo', 'hidden')
    await expect(pending).rejects.toMatchObject({ code: 'tool-hidden' })
    await starting
    expect(firstServer(servers).toolCalls).toHaveLength(0)
  })

  it('连续重连不会让旧启动结果关闭新连接', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({ initializeDelayMs: 30 }),
    )
    const starting = manager.start()
    await waitFor(() => servers.length === 1)
    const reconnecting = manager.reconnect('demo')
    await Promise.all([starting, reconnecting])
    expect(manager.snapshot().servers[0]?.state).toBe('connected')
    await expect(manager.callTool('demo', 'echo', { text: 'new' })).resolves.toBeDefined()
    expect(servers).toHaveLength(2)
  })

  it('失败的显式重连返回失败而不伪报成功', async () => {
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [makeEntry('demo', { command: 'fixture' })],
      createTransport: () => {
        throw new Error('synthetic secret')
      },
    })
    cleanups.push(() => manager.close())
    await manager.start()
    await expect(manager.reconnect('demo')).rejects.toMatchObject({ code: 'connect-failed' })
  })

  it('请求超时使用条目秒数并投影为受控错误', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture', timeout: 0.05 })],
      () => ({
        callToolHandler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200))
          return { content: [{ type: 'text', text: 'late' }] }
        },
      }),
    )
    await manager.start()
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({ code: 'timeout' })
    expect(firstServer(servers).toolCalls).toHaveLength(1)
  })

  it('工具调用不因失败自动重试（不重复副作用）', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('demo', { command: 'fixture' })],
      () => ({
        callToolHandler: () => {
          throw new MemoryRpcError(-32000, 'tool failed after side effect')
        },
      }),
    )
    await manager.start()
    await expect(manager.callTool('demo', 'echo')).rejects.toMatchObject({ code: 'request-failed' })
    expect(firstServer(servers).toolCalls).toHaveLength(1)
  })
})

describe('条目对账与就绪等待（d2b）', () => {
  it('无关对账保留临时禁用/exposure且不重连', async () => {
    const entry = makeEntry('alpha', { command: 'fixture', exposure: 'direct' })
    const { manager, servers } = createMemoryManager([entry])
    await manager.start()
    manager.setExposure('alpha', 'hidden')
    await manager.setServers([entry, makeEntry('beta', { command: 'fixture' })])
    expect(manager.snapshot().servers[0]?.exposure).toBe('hidden')
    expect(servers).toHaveLength(2)
    await manager.setEnabled('alpha', false)
    await manager.setServers([entry, makeEntry('beta', { command: 'fixture' })])
    expect(manager.snapshot().servers[0]?.enabled).toBe(false)
    expect(servers).toHaveLength(2)
  })

  it('普通调用在条目替换时等待旧transport关闭屏障', async () => {
    const release = deferred<void>()
    const closing = deferred<void>()
    const entry = makeEntry('alpha', { command: 'fixture' })
    const { manager, servers } = createMemoryManager(
      [entry],
      () => ({}),
      (transport, index) => {
        if (index !== 0) return transport
        const close = transport.close.bind(transport)
        transport.close = async () => {
          closing.resolve()
          await release.promise
          await close()
        }
        return transport
      },
    )
    await manager.start()
    const replacing = manager.setServers([makeEntry('alpha', { command: 'other' })])
    await closing.promise
    const call = manager.callTool('alpha', 'echo', { text: 'replacement' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(servers).toHaveLength(1)
    release.resolve()
    await replacing
    await expect(call).resolves.toMatchObject({
      content: [{ type: 'text', text: 'echo:replacement' }],
    })
    expect(servers).toHaveLength(2)
  })

  it('setServers 保留未变条目的连接，只替换变化项', async () => {
    const { manager, servers } = createMemoryManager([
      makeEntry('alpha', { command: 'fixture' }),
      makeEntry('beta', { command: 'fixture' }),
    ])
    await manager.start()
    await manager.waitForServers(['alpha', 'beta'])
    const alphaServer = firstServer(servers)
    expect(alphaServer.initializeCount).toBe(1)
    const betaServer = servers[1]
    expect(betaServer?.initializeCount).toBe(1)

    await manager.setServers([
      makeEntry('alpha', { command: 'fixture' }),
      makeEntry('beta', { command: 'fixture', timeout: 99 }),
    ])
    // alpha 未变：没有新建 transport，仍使用原连接。
    expect(alphaServer.initializeCount).toBe(1)
    expect(servers).toHaveLength(3)
    expect(servers[2]?.initializeCount).toBe(1)
    await manager.waitForServers(['beta'])
    const snapshot = manager.snapshot()
    expect(snapshot.servers.map((server) => server.name)).toEqual(['alpha', 'beta'])
    expect(snapshot.servers.find((server) => server.name === 'beta')?.state).toBe('connected')
  })

  it('移除条目立即撤下目录并等待旧连接关闭，未变项不受影响', async () => {
    const { manager, servers } = createMemoryManager([
      makeEntry('alpha', { command: 'fixture' }),
      makeEntry('beta', { command: 'fixture' }),
    ])
    await manager.start()
    await manager.waitForServers(['alpha', 'beta'])
    const alphaServer = firstServer(servers)
    await manager.setServers([makeEntry('alpha', { command: 'fixture' })])
    expect(manager.snapshot().servers.map((server) => server.name)).toEqual(['alpha'])
    expect(() => manager.getToolCatalog('beta')).toThrow()
    expect(alphaServer.initializeCount).toBe(1)
  })

  it('waitForServers 等待当前尝试，并在移除时被唤醒', async () => {
    const { manager } = createMemoryManager([makeEntry('slow', { command: 'fixture' })], () => ({
      initializeDelayMs: 500,
    }))
    void manager.start()
    const started = Date.now()
    const waiting = manager.waitForServers(['slow'])
    await manager.setServers([])
    await waiting
    expect(Date.now() - started).toBeLessThan(500)
    expect(manager.snapshot().servers).toEqual([])
  })

  it('waitForServers 可取消，不建立额外连接', async () => {
    const { manager, servers } = createMemoryManager(
      [makeEntry('slow', { command: 'fixture' })],
      () => ({
        initializeDelayMs: 500,
      }),
    )
    void manager.start()
    const controller = new AbortController()
    const waiting = manager.waitForServers(['slow'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await waiting
    expect(servers).toHaveLength(1)
    expect(manager.snapshot().servers[0]?.state).toBe('connecting')
  })

  it('接受 extension 运行时 scope，并拒绝非原子的碰撞更新', async () => {
    const { manager } = createMemoryManager([
      makeEntry('alpha', { command: 'fixture' }, { scope: 'extension' }),
    ])
    await manager.start()
    await manager.waitForServers(['alpha'])
    expect(manager.snapshot().servers[0]?.scope).toBe('extension')
    await expect(
      manager.setServers([
        makeEntry('a-b', { command: 'fixture' }),
        makeEntry('a_b', { command: 'fixture' }),
      ]),
    ).rejects.toBeInstanceOf(McpManagerInputError)
    expect(manager.snapshot().servers.map((server) => server.name)).toEqual(['alpha'])
  })

  it('启动前 setServers 的条目随后由 start 连接', async () => {
    const { manager } = createMemoryManager([makeEntry('alpha', { command: 'fixture' })])
    await manager.setServers([
      makeEntry('alpha', { command: 'fixture' }),
      makeEntry('beta', { command: 'fixture' }),
    ])
    await manager.start()
    await manager.waitForServers(['alpha', 'beta'])
    expect(manager.snapshot().servers.every((server) => server.state === 'connected')).toBe(true)
  })
})
