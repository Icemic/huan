/**
 * Pi MCP 集成真实 SDK 测试（G1.4d2b）。
 *
 * 使用隔离临时用户空间、官方内存 MCP transport 与脚本化合成模型，不访问个人
 * 配置/凭据或付费模型。覆盖 direct、codemode、tool_search、tool_call 拒绝、
 * 嵌套进度 parentToolCallId、动态扩展注册、配置优先、项目信任与最终释放。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentSession,
  type AgentToolResult,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  SessionManager,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
  type ToolResultEvent,
} from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMcpIntegration,
  type McpIntegration,
  type McpIntegrationOptions,
  type McpServerListing,
  renderMcpServersSection,
} from './index.js'
import {
  createMemoryMcpServer,
  type MemoryMcpServer,
  type MemoryMcpServerOptions,
} from './test-fixtures/memory-server.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

const TEST_PROVIDER = 'huan-test'
const TEST_MODEL = 'test-model-a'
const TEST_BASE_URL = 'http://127.0.0.1:9/v1'

interface Probe {
  pi?: ExtensionAPI
  ctx?: ExtensionContext
  sections: (string | undefined)[]
  starts: ToolExecutionStartEvent[]
  updates: ToolExecutionUpdateEvent[]
  results: ToolResultEvent[]
  extension: InlineExtension
}

function makeProbe(): Probe {
  const probe: Probe = {
    sections: [],
    starts: [],
    updates: [],
    results: [],
    extension: {
      name: 'huan-test-mcp-probe',
      hidden: true,
      factory: (pi) => {
        probe.pi = pi
        pi.on('session_start', (_event, ctx) => {
          probe.ctx = ctx
        })
        pi.on('before_agent_start', (event) => {
          probe.sections.push(event.systemPromptOptions.sections.mcp_servers)
        })
        pi.on('tool_execution_start', (event) => {
          probe.starts.push(event)
        })
        pi.on('tool_execution_update', (event) => {
          probe.updates.push(event)
        })
        pi.on('tool_result', (event) => {
          probe.results.push(event)
        })
      },
    },
  }
  return probe
}

interface Harness {
  root: string
  agentDir: string
  cwd: string
  integration: McpIntegration
  session: AgentSession
  probe: Probe
  memories: Map<string, MemoryMcpServer>
  transports: { name: string; scope: string }[]
}

async function writeMinimalUserSpace(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          [TEST_PROVIDER]: {
            baseUrl: TEST_BASE_URL,
            api: 'openai-completions',
            apiKey: 'huan-test-key-not-real',
            models: [
              {
                id: TEST_MODEL,
                name: 'Test Model A',
                input: ['text'],
                contextWindow: 32_768,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    `${JSON.stringify({ defaultProvider: TEST_PROVIDER, defaultModel: TEST_MODEL }, null, 2)}\n`,
  )
}

interface OpenHarnessOptions {
  userConfig?: unknown
  projectConfig?: unknown
  trusted?: boolean
  memories: Record<string, MemoryMcpServerOptions>
  extraExtensions?: InlineExtension[]
  startupWaitMs?: number
  onLog?: McpIntegrationOptions['onLog']
}

async function openHarness(options: OpenHarnessOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'huan-mcp-integration-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'workspace')
  const memories = new Map<string, MemoryMcpServer>()
  const transports: { name: string; scope: string }[] = []
  try {
    await writeMinimalUserSpace(agentDir)
    await mkdir(cwd, { recursive: true })
    if (options.userConfig !== undefined) {
      await writeFile(join(agentDir, 'mcp.json'), `${JSON.stringify(options.userConfig)}\n`)
    }
    if (options.projectConfig !== undefined) {
      await mkdir(join(cwd, '.pi'), { recursive: true })
      await writeFile(join(cwd, '.pi', 'mcp.json'), `${JSON.stringify(options.projectConfig)}\n`)
    }
    for (const [name, memoryOptions] of Object.entries(options.memories)) {
      memories.set(name, await createMemoryMcpServer(memoryOptions))
    }
    const probe = makeProbe()
    const integration = createMcpIntegration({
      agentDir,
      getProjectTrusted: () => options.trusted === true,
      startupWaitMs: options.startupWaitMs,
      env: {},
      ...(options.onLog ? { onLog: options.onLog } : {}),
      createTransport: (context) => {
        transports.push({ name: context.entry.name, scope: context.entry.scope })
        const server = memories.get(context.entry.name)
        if (!server) throw new Error(`missing memory server: ${context.entry.name}`)
        return server.clientTransport
      },
    })
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          integration.extension,
          ...(options.extraExtensions ?? []),
          probe.extension,
        ],
      },
    })
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
    })
    await session.bindExtensions({})
    const harness: Harness = {
      root,
      agentDir,
      cwd,
      integration,
      session,
      probe,
      memories,
      transports,
    }
    cleanups.push(async () => {
      session.dispose()
      await integration.close()
      await Promise.allSettled([...memories.values()].map((server) => server.close()))
      await rm(root, { recursive: true, force: true })
    })
    return harness
  } catch (error) {
    await Promise.allSettled([...memories.values()].map((server) => server.close()))
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface ScriptedTurn {
  tool?: { name: string; args: Record<string, unknown> }
  text?: string
}

interface RequestBody {
  tools?: { function?: { name?: string } }[]
  messages?: { role?: string; content?: unknown }[]
}

/** 脚本化合成模型；捕获请求体，只应答测试 baseUrl。 */
function installScriptedModel(turns: ScriptedTurn[]): {
  bodies: RequestBody[]
  calls: () => number
  restore: () => void
} {
  const previous = globalThis.fetch
  const bodies: RequestBody[] = []
  let index = 0
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(TEST_BASE_URL)) {
      throw new Error(`测试禁止非预期网络请求：${url}`)
    }
    if (typeof init?.body === 'string') {
      try {
        bodies.push(JSON.parse(init.body) as RequestBody)
      } catch {
        bodies.push({})
      }
    } else {
      bodies.push({})
    }
    const turn = turns[index] ?? { text: '完成' }
    index += 1
    const base = {
      id: `chatcmpl-huan-mcp-${index}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: TEST_MODEL,
    }
    if (turn.tool) {
      return new Response(
        chunk({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call_huan_${index}`,
                    type: 'function',
                    function: {
                      name: turn.tool.name,
                      arguments: JSON.stringify(turn.tool.args),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }) +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return new Response(
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: turn.text ?? '完成' },
            finish_reason: null,
          },
        ],
      }) +
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  return {
    bodies,
    calls: () => index,
    restore: () => {
      globalThis.fetch = previous
    },
  }
}

async function promptScripted(harness: Harness, turns: ScriptedTurn[]): Promise<RequestBody[]> {
  const scripted = installScriptedModel(turns)
  try {
    await harness.session.prompt('调用 MCP 工具')
    return scripted.bodies
  } finally {
    scripted.restore()
  }
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
}

function toolResultMessages(session: AgentSession): { content: unknown }[] {
  return session.messages.filter(
    (message): message is typeof message & { content: unknown } => message.role === 'toolResult',
  )
}

describe('真实 SDK：direct 与权限 hook', () => {
  it('direct 工具在首轮声明并可经 SDK 执行，快照不泄露命令秘密', async () => {
    const harness = await openHarness({
      userConfig: {
        mcpServers: {
          mem: {
            command: 'fixture --token secret-value',
            exposure: 'direct',
            description: '内存测试服务',
          },
        },
      },
      memories: { mem: {} },
    })
    await waitFor(() => harness.session.getToolDefinition('mcp__mem__echo') !== undefined)
    expect(harness.integration.getManager()).toBeDefined()
    expect(JSON.stringify(harness.integration.getManager()?.snapshot())).not.toContain(
      'secret-value',
    )
    const bodies = await promptScripted(harness, [
      { tool: { name: 'mcp__mem__echo', args: { text: 'hello' } } },
      { text: '完成' },
    ])
    expect(bodies[0]?.tools?.some((tool) => tool.function?.name === 'mcp__mem__echo')).toBe(true)
    expect(harness.memories.get('mem')?.toolCalls).toEqual([
      { name: 'echo', args: { text: 'hello' } },
    ])
    const results = toolResultMessages(harness.session)
    expect(JSON.stringify(results)).toContain('echo:hello')
    // direct 服务器不进入 mcp_servers 系统段。
    expect(harness.probe.sections[0]).toBeUndefined()
  }, 20_000)

  it('首轮direct等待慢初始化后声明工具；等待超时不阻断普通对话', async () => {
    const ready = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'direct' } } },
      memories: { mem: { initializeDelayMs: 80 } },
    })
    const bodies = await promptScripted(ready, [
      { tool: { name: 'mcp__mem__echo', args: { text: 'first' } } },
      { text: '完成' },
    ])
    expect(bodies[0]?.tools?.some((tool) => tool.function?.name === 'mcp__mem__echo')).toBe(true)
    expect(ready.memories.get('mem')?.toolCalls).toHaveLength(1)
    const slow = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'direct' } } },
      memories: { mem: { initializeDelayMs: 500 } },
      startupWaitMs: 5,
    })
    const slowBodies = await promptScripted(slow, [{ text: '不等待慢服务' }])
    expect(slowBodies[0]?.tools?.some((tool) => tool.function?.name === 'mcp__mem__echo')).toBe(
      false,
    )
    expect(slow.integration.getManager()?.snapshot().servers[0]?.state).toBe('connecting')
  }, 20_000)

  it('资源工具通过真实SDK分页、模板与读取', async () => {
    const harness = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'direct' } } },
      memories: { mem: {} },
    })
    await promptScripted(harness, [
      { tool: { name: 'list_mcp_resources', args: { server: 'mem' } } },
      { tool: { name: 'list_mcp_resource_templates', args: { server: 'mem' } } },
      { tool: { name: 'read_mcp_resource', args: { server: 'mem', uri: 'test://one' } } },
      { text: '完成' },
    ])
    const methods = harness.memories.get('mem')?.methods
    expect(methods).toContain('resources/list')
    expect(methods).toContain('resources/templates/list')
    expect(methods).toContain('resources/read')
    expect(harness.session.getToolDefinition('read_mcp_resource')?.annotations?.readOnlyHint).toBe(
      true,
    )
  }, 20_000)

  it('tool_call 权限 hook 拒绝后不执行服务器副作用', async () => {
    const block: InlineExtension = {
      name: 'huan-test-mcp-block',
      hidden: true,
      factory: (pi) => {
        pi.on('tool_call', (event) =>
          event.toolName.startsWith('mcp__')
            ? { block: true, reason: 'blocked by test' }
            : undefined,
        )
      },
    }
    const harness = await openHarness({
      userConfig: {
        mcpServers: { mem: { command: 'fixture', exposure: 'direct' } },
      },
      memories: { mem: {} },
      extraExtensions: [block, createCodemodeExtension()],
    })
    await waitFor(() => harness.session.getToolDefinition('mcp__mem__echo') !== undefined)
    await promptScripted(harness, [
      { tool: { name: 'mcp__mem__echo', args: { text: 'must-not-run' } } },
      { text: '完成' },
    ])
    expect(harness.memories.get('mem')?.toolCalls).toEqual([])
    expect(JSON.stringify(toolResultMessages(harness.session))).toContain('blocked by test')
    harness.probe.pi?.setActiveTools([...harness.session.getActiveToolNames(), 'codemode'])
    await promptScripted(harness, [
      {
        tool: {
          name: 'codemode',
          args: { code: "return await tools.mcp__mem__echo({ text: 'nested-denied' })" },
        },
      },
      { text: '完成' },
    ])
    expect(harness.memories.get('mem')?.toolCalls).toEqual([])
    const parent = harness.probe.starts.find((event) => event.toolName === 'codemode')
    const nested = harness.probe.starts.find(
      (event) => event.parentToolCallId === parent?.toolCallId,
    )
    expect(parent).toBeDefined()
    expect(nested?.toolName).toBe('mcp__mem__echo')
  }, 20_000)

  it('嵌套工具调用与进度携带 parentToolCallId', async () => {
    const nested: InlineExtension = {
      name: 'huan-test-mcp-nested',
      hidden: true,
      factory: (pi) => {
        pi.on('tool_result', (event) =>
          event.toolName === 'mcp__mem__echo'
            ? { content: [{ type: 'text', text: 'redacted MCP result' }], details: undefined }
            : undefined,
        )
        pi.registerTool({
          name: 'nested_mcp_call',
          label: 'nested_mcp_call',
          description: 'Call the MCP echo tool through the SDK nested tool pipeline',
          parameters: { type: 'object', properties: {} },
          async execute(_id, _params, _signal, onUpdate, ctx) {
            const outcome = await ctx.executeTool(
              'mcp__mem__echo',
              { text: 'nested' },
              { onUpdate },
            )
            return {
              content: [{ type: 'text', text: resultText(outcome.result) }],
              details: { isError: outcome.isError },
            }
          },
        })
      },
    }
    const harness = await openHarness({
      userConfig: {
        mcpServers: { mem: { command: 'fixture', exposure: 'direct' } },
      },
      memories: {
        mem: {
          callToolHandler: async (_name, _args, request, server) => {
            const token = (request.params as { _meta?: { progressToken?: string | number } })._meta
              ?.progressToken
            if (token !== undefined) {
              await server.notify('notifications/progress', {
                progressToken: token,
                progress: 1,
                total: 2,
                message: 'half',
              })
            }
            return { content: [{ type: 'text', text: 'nested-ok' }] }
          },
        },
      },
      extraExtensions: [nested],
    })
    await waitFor(
      () =>
        harness.session.getToolDefinition('nested_mcp_call') !== undefined &&
        harness.session.getToolDefinition('mcp__mem__echo') !== undefined,
    )
    await promptScripted(harness, [
      { tool: { name: 'nested_mcp_call', args: {} } },
      { text: '完成' },
    ])
    const nestedStart = harness.probe.starts.find((event) => event.toolName === 'nested_mcp_call')
    const mcpStart = harness.probe.starts.find((event) => event.toolName === 'mcp__mem__echo')
    expect(nestedStart).toBeTruthy()
    expect(mcpStart?.parentToolCallId).toBe(nestedStart?.toolCallId)
    const mcpUpdate = harness.probe.updates.find((event) => event.toolName === 'mcp__mem__echo')
    expect(mcpUpdate?.parentToolCallId).toBe(nestedStart?.toolCallId)
    expect(JSON.stringify(toolResultMessages(harness.session))).toContain('redacted MCP result')
  }, 20_000)
})

describe('真实 SDK：codemode 与 tool_search', () => {
  it('运行时exposure/禁用同步资源、发现激活与系统段', async () => {
    const harness = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'direct' } } },
      memories: {
        mem: { resourcesHandler: () => ({ resources: [{ uri: 'test://one', name: 'one' }] }) },
      },
      extraExtensions: [createCodemodeExtension()],
    })
    const manager = harness.integration.getManager()
    if (!manager) throw new Error('missing manager')
    await manager.waitForServers(['mem'])
    expect(harness.session.getToolDefinition('list_mcp_resources')?.exposure).toBe('direct')
    manager.setExposure('mem', 'codemode')
    expect(harness.session.getToolDefinition('list_mcp_resources')?.exposure).toBe('deferred')
    expect(harness.session.getActiveToolNames()).toContain('codemode')
    expect(harness.session.getActiveToolNames()).not.toContain('mcp__mem__echo')
    await promptScripted(harness, [{ text: '完成' }])
    expect(harness.probe.sections.at(-1)).toContain('mcp__mem')
    await manager.setEnabled('mem', false)
    await promptScripted(harness, [{ text: '完成' }])
    expect(harness.probe.sections.at(-1)).toBeUndefined()
    expect(harness.session.getToolDefinition('list_mcp_resources')?.exposure).toBe('hidden')
  }, 20_000)

  it('单工具临时暴露更新发现激活和系统段', async () => {
    const harness = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'hidden' } } },
      memories: { mem: {} },
      extraExtensions: [createToolSearchExtension()],
    })
    const manager = harness.integration.getManager()
    if (!manager) throw new Error('missing manager')
    await manager.waitForServers(['mem'])
    expect(harness.session.getActiveToolNames()).not.toContain('tool_search')
    manager.setToolExposure('mem', 'echo', 'deferred')
    expect(harness.session.getActiveToolNames()).toContain('tool_search')
    await promptScripted(harness, [{ text: '完成' }])
    expect(harness.probe.sections.at(-1)).toContain('mcp__mem')
  }, 20_000)

  it('tool_search激活的工具在无关目录更新后保持声明', async () => {
    const harness = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'deferred' } } },
      memories: { mem: {} },
      extraExtensions: [createToolSearchExtension()],
    })
    await promptScripted(harness, [
      { tool: { name: 'tool_search', args: { query: 'echo' } } },
      { text: '完成' },
    ])
    expect(harness.session.getActiveToolNames()).toContain('mcp__mem__echo')
    const server = harness.memories.get('mem')
    if (!server) throw new Error('missing server')
    const revision = harness.integration.getManager()?.getToolCatalogRevision('mem')
    await server.notify('notifications/tools/list_changed')
    await waitFor(
      () => harness.integration.getManager()?.getToolCatalogRevision('mem') !== revision,
    )
    expect(harness.session.getActiveToolNames()).toContain('mcp__mem__echo')
  }, 20_000)

  it('默认激活 codemode，脚本经 reachesTools 等待连接并调用 MCP 工具', async () => {
    const harness = await openHarness({
      userConfig: {
        mcpServers: {
          mem: {
            command: 'fixture',
            exposure: 'codemode',
            description: '内存测试服务',
          },
        },
      },
      memories: { mem: { initializeDelayMs: 120 } },
      extraExtensions: [createCodemodeExtension()],
    })
    expect(harness.session.getActiveToolNames()).toContain('codemode')
    await promptScripted(harness, [
      {
        tool: {
          name: 'codemode',
          args: { code: "return await tools.mcp__mem__echo({ text: 'via codemode' })" },
        },
      },
      { text: '完成' },
    ])
    expect(harness.memories.get('mem')?.toolCalls).toEqual([
      { name: 'echo', args: { text: 'via codemode' } },
    ])
    const section = harness.probe.sections[0]
    expect(section).toContain('mcp__mem')
    expect(section).toContain('内存测试服务')
  }, 20_000)

  it('deferred 工具经 tool_search 加载后可直接调用', async () => {
    const harness = await openHarness({
      userConfig: {
        mcpServers: { mem: { command: 'fixture', exposure: 'deferred' } },
      },
      memories: { mem: {} },
      extraExtensions: [createToolSearchExtension()],
    })
    expect(harness.session.getActiveToolNames()).toContain('tool_search')
    await promptScripted(harness, [
      { tool: { name: 'tool_search', args: { query: 'echo' } } },
      { tool: { name: 'mcp__mem__echo', args: { text: 'via search' } } },
      { text: '完成' },
    ])
    expect(harness.memories.get('mem')?.toolCalls).toEqual([
      { name: 'echo', args: { text: 'via search' } },
    ])
  }, 20_000)
})

describe('真实 SDK：动态注册与配置优先级', () => {
  it('同名服务器移除再注册仍恢复工具，不复用旧目录同步标记', async () => {
    const harness = await openHarness({ memories: { runtime: {} } })
    const pi = harness.probe.pi
    if (!pi) throw new Error('missing ExtensionAPI')
    pi.registerMcpServer('runtime', { command: 'fixture', exposure: 'direct' })
    await waitFor(
      () => harness.session.getToolDefinition('mcp__runtime__echo')?.exposure === 'direct',
    )
    pi.unregisterMcpServer('runtime')
    await waitFor(
      () => harness.session.getToolDefinition('mcp__runtime__echo')?.exposure === 'hidden',
    )
    const replacement = await createMemoryMcpServer({})
    const old = harness.memories.get('runtime')
    if (old) await old.close()
    harness.memories.set('runtime', replacement)
    pi.registerMcpServer('runtime', { command: 'fixture', exposure: 'direct' })
    await waitFor(
      () => harness.session.getToolDefinition('mcp__runtime__echo')?.exposure === 'direct',
    )
    await promptScripted(harness, [
      { tool: { name: 'mcp__runtime__echo', args: { text: 'restored' } } },
      { text: '完成' },
    ])
    expect(replacement.toolCalls).toEqual([{ name: 'echo', args: { text: 'restored' } }])
  }, 20_000)

  it('加载期扩展注册的服务器在 session_start 接入', async () => {
    const initial: InlineExtension = {
      name: 'huan-test-mcp-initial',
      hidden: true,
      factory: (pi) => {
        pi.registerMcpServer('initial', { command: 'fixture', exposure: 'direct' })
      },
    }
    const harness = await openHarness({
      memories: { initial: {} },
      extraExtensions: [initial],
    })
    await waitFor(() => harness.session.getToolDefinition('mcp__initial__echo') !== undefined)
    expect(harness.transports).toEqual([{ name: 'initial', scope: 'extension' }])
    expect(
      harness.integration
        .getManager()
        ?.snapshot()
        .servers.find((server) => server.name === 'initial')?.scope,
    ).toBe('extension')
  }, 20_000)

  it('运行时注册/移除服务器，配置同名 namespace 优先', async () => {
    const harness = await openHarness({
      userConfig: {
        mcpServers: { shared: { command: 'fixture', exposure: 'direct' } },
      },
      memories: { shared: {}, runtime: {} },
    })
    await waitFor(() => harness.session.getToolDefinition('mcp__shared__echo') !== undefined)
    expect(harness.transports).toEqual([{ name: 'shared', scope: 'user' }])
    const pi = harness.probe.pi
    if (!pi) throw new Error('missing ExtensionAPI')

    pi.registerMcpServer('runtime', { command: 'fixture', exposure: 'direct' })
    await waitFor(
      () =>
        harness.integration
          .getManager()
          ?.snapshot()
          .servers.some((server) => server.name === 'runtime' && server.state === 'connected') ===
        true,
    )
    await waitFor(() => harness.session.getToolDefinition('mcp__runtime__echo') !== undefined)

    // 与配置同名：配置优先，不建立第二个连接。
    pi.registerMcpServer('shared', { command: 'fixture', exposure: 'deferred' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sharedTransports = harness.transports.filter((entry) => entry.name === 'shared')
    expect(sharedTransports).toEqual([{ name: 'shared', scope: 'user' }])
    expect(
      harness.integration
        .getManager()
        ?.snapshot()
        .servers.find((server) => server.name === 'shared')?.scope,
    ).toBe('user')

    pi.unregisterMcpServer('runtime')
    await waitFor(
      () =>
        harness.integration
          .getManager()
          ?.snapshot()
          .servers.some((server) => server.name === 'runtime') !== true,
    )
    await waitFor(
      () => harness.session.getToolDefinition('mcp__runtime__echo')?.exposure === 'hidden',
    )
  }, 20_000)
})

describe('真实 SDK：项目信任与释放', () => {
  it('未信任项目不触碰项目 MCP 配置；信任后加载', async () => {
    const projectConfig = {
      mcpServers: { project: { command: 'fixture', exposure: 'direct' } },
    }
    const untrusted = await openHarness({
      projectConfig,
      trusted: false,
      memories: { project: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(untrusted.integration.getManager()?.snapshot().servers).toEqual([])
    expect(untrusted.transports).toEqual([])

    const trusted = await openHarness({
      projectConfig,
      trusted: true,
      memories: { project: {} },
    })
    await waitFor(
      () =>
        trusted.integration.getManager()?.listResourceServers !== undefined &&
        trusted.session.getToolDefinition('mcp__project__echo') !== undefined,
    )
    expect(trusted.transports).toEqual([{ name: 'project', scope: 'project' }])
  }, 20_000)

  it('close 同步撤销当前 manager 并可重复调用', async () => {
    const harness = await openHarness({
      userConfig: { mcpServers: { mem: { command: 'fixture', exposure: 'direct' } } },
      memories: { mem: {} },
    })
    await waitFor(() => harness.integration.getManager() !== undefined)
    const manager = harness.integration.getManager()
    expect(manager).toBeDefined()
    await harness.integration.close()
    expect(harness.integration.getManager()).toBeUndefined()
    expect(manager?.snapshot().closed).toBe(true)
    await harness.integration.close()
  })

  it('mcp_servers 系统段按描述与数量有界且保持线性', () => {
    const listings: McpServerListing[] = Array.from({ length: 40 }, (_, index) => ({
      entry: {
        name: `server-${index}`,
        config: {
          command: 'fixture',
          exposure: 'codemode',
          description: `描述 ${index} ${'x'.repeat(300)}`,
        },
        source: '/tmp/mcp.json',
        scope: 'user',
      },
    }))
    const section = renderMcpServersSection(listings)
    expect(section).toBeDefined()
    if (section === undefined) throw new Error('missing section')
    expect(section.length).toBeLessThanOrEqual(4096)
    const lines = section.split('\n')
    const descriptions = lines.filter((line) => line.includes(': 描述'))
    expect(descriptions.length).toBeGreaterThan(0)
    expect(Math.max(...descriptions.map((line) => line.length))).toBeLessThanOrEqual(260)
  })
})

describe('集成绑定生命周期（无 SDK 事件驱动）', () => {
  interface FakePi {
    api: ExtensionAPI
    emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void>
    tools: Map<string, { name: string; exposure?: string }>
    commands: Set<string>
  }

  function makeFakePi(): FakePi {
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>()
    const tools = new Map<string, { name: string; exposure?: string }>()
    const commands = new Set<string>()
    let active: string[] = []
    const api = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {
          const current = handlers.get(event) ?? []
          handlers.set(
            event,
            current.filter((item) => item !== handler),
          )
        }
      },
      registerTool(definition: { name: string; exposure?: string }) {
        tools.set(definition.name, definition)
      },
      registerCommand(name: string) {
        commands.add(name)
      },
      getAllTools: () =>
        [...tools.values()].map((tool) => ({
          ...tool,
          description: '',
          parameters: { type: 'object' },
          exposure: tool.exposure ?? 'direct',
          sourceInfo: {},
        })),
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active = [...names]
      },
      getMcpServers: () => [],
    } as unknown as ExtensionAPI
    return {
      api,
      tools,
      commands,
      async emit(event, payload, ctx) {
        for (const handler of handlers.get(event) ?? []) {
          await handler(payload, ctx)
        }
      },
    }
  }

  function fakeContext(cwd: string): ExtensionContext {
    return {
      cwd,
      signal: undefined,
      modelRegistry: { getApiKeyForProvider: async () => undefined },
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext
  }

  it('session_shutdown 只关闭当次运行，后续 session_start 仍可建立新 manager', async () => {
    const memory = await createMemoryMcpServer({})
    cleanups.push(() => memory.close())
    const entry = {
      name: 'mem',
      config: { command: 'fixture', exposure: 'direct' as const },
      source: '/tmp/mcp.json',
      scope: 'user' as const,
    }
    const binding = createMcpIntegration({
      agentDir: '/tmp/huan-mcp-test-agent',
      getProjectTrusted: () => true,
      loadConfig: () => ({ servers: [entry], issues: [] }),
      env: {},
      createTransport: () => memory.clientTransport,
    })
    cleanups.push(() => binding.close())
    const fake = makeFakePi()
    await binding.extension(fake.api)
    const ctx = fakeContext('/tmp/huan-mcp-workspace')

    await fake.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx)
    await waitFor(() => binding.getManager() !== undefined)
    const first = binding.getManager()
    await first?.waitForServers(['mem'])
    expect(first?.snapshot().servers[0]?.state).toBe('connected')

    await fake.emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' }, ctx)
    expect(binding.getManager()).toBeUndefined()
    expect(first?.snapshot().closed).toBe(true)

    await fake.emit('session_start', { type: 'session_start', reason: 'reload' }, ctx)
    await waitFor(() => binding.getManager() !== undefined && binding.getManager() !== first)
    const second = binding.getManager()
    await second?.waitForServers(['mem'])
    expect(second?.snapshot().closed).toBe(false)
  }, 20_000)

  it('close 后晚到的配置加载结果不得创建 manager 或 transport', async () => {
    let resolveLoad!: (value: {
      servers: {
        name: string
        config: { command: string; exposure: 'direct' }
        source: string
        scope: 'user'
      }[]
      issues: []
    }) => void
    let transports = 0
    const binding = createMcpIntegration({
      agentDir: '/tmp/huan-mcp-test-agent',
      getProjectTrusted: () => true,
      loadConfig: () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      createTransport: () => {
        transports += 1
        throw new Error('must not create transport after close')
      },
    })
    const fake = makeFakePi()
    await binding.extension(fake.api)
    const starting = fake.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      fakeContext('/tmp/huan-mcp-workspace'),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await binding.close()
    resolveLoad({
      servers: [
        {
          name: 'mem',
          config: { command: 'fixture', exposure: 'direct' },
          source: '/tmp/mcp.json',
          scope: 'user',
        },
      ],
      issues: [],
    })
    await starting
    expect(binding.getManager()).toBeUndefined()
    expect(transports).toBe(0)

    // 已释放的 binding 不再接受新的 session_start。
    await fake.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      fakeContext('/tmp/huan-mcp-workspace'),
    )
    expect(binding.getManager()).toBeUndefined()
  })

  it('集成把 notifications/message 交给 onLog，不进入状态摘要', async () => {
    const logs: { server: string; params: unknown }[] = []
    const harness = await openHarness({
      userConfig: { mcpServers: { demo: { command: 'fixture' } } },
      memories: { demo: {} },
      onLog: (server, params) => logs.push({ server, params }),
    })
    const manager = harness.integration.getManager()
    if (!manager) throw new Error('missing manager')
    await waitFor(() => manager.snapshot().servers[0]?.state === 'connected')
    const memory = harness.memories.get('demo')
    if (!memory) throw new Error('missing memory server')
    await memory.notify('notifications/message', { level: 'info', data: 'integration-log' })
    await waitFor(() => logs.length === 1)
    expect(logs[0]?.server).toBe('demo')
    expect(logs[0]?.params).toMatchObject({ level: 'info', data: 'integration-log' })
    expect(JSON.stringify(manager.snapshot())).not.toContain('integration-log')
  })

  it('工厂注册 /mcp 替换标识命令与资源工具 hidden 预注册', async () => {
    const binding = createMcpIntegration({
      agentDir: '/tmp/huan-mcp-test-agent',
      getProjectTrusted: () => true,
      loadConfig: () => ({ servers: [], issues: [] }),
    })
    cleanups.push(() => binding.close())
    const fake = makeFakePi()
    await binding.extension(fake.api)
    await fake.emit(
      'session_start',
      { type: 'session_start', reason: 'startup' },
      fakeContext('/tmp/huan-mcp-workspace'),
    )
    expect(fake.commands.has('mcp')).toBe(true)
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect(fake.tools.get(name)?.exposure).toBe('hidden')
    }
  })
})
