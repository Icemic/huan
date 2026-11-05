import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentSession,
  type AgentToolResult,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionContext,
  type ExtensionToolContext,
  type InlineExtension,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_A,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'
import { pathKey, type WorkspaceRoot, type WorkspaceSnapshot } from './workspace-path.js'
import { createWorkspaceToolsExtension } from './workspace-tools.js'

// 子进程环境隔离：避免把运行本测试的 Pi 会话变量带入 bash 用例。
const TESTED_ENV_KEYS = [
  'NO_COLOR',
  'FORCE_COLOR',
  'TERM',
  'COLORTERM',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_MODEL_ID',
  'PI_REASONING_LEVEL',
  'PI_SESSION_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

type Probe = {
  context: ExtensionContext | undefined
  prompts: string[]
}

type SessionHarness = {
  session: AgentSession
  sessionCwd: string
  probe: Probe
}

let env: IsolatedPiEnv
let fetchStub: TestFetchStub
let sessions: AgentSession[]
let savedEnv: Map<string, string | undefined>

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of TESTED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-workspace-tools-')
  fetchStub = installTestFetch()
  sessions = []
})

afterEach(async () => {
  for (const session of sessions) session.dispose()
  sessions = []
  const unexpected = fetchStub.unexpected()
  fetchStub.restore()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await env.cleanup()
  expect(unexpected).toEqual([])
})

function makeWorkspace(revision: number, roots: WorkspaceRoot[]): WorkspaceSnapshot {
  return { workspaceId: 'ws_test', name: '测试工作区', revision, roots }
}

function makeProbe(): { probe: Probe; extension: InlineExtension } {
  const probe: Probe = { context: undefined, prompts: [] }
  return {
    probe,
    extension: {
      name: 'huan-test-probe',
      hidden: true,
      factory: (pi) => {
        pi.on('session_start', (_event, ctx) => {
          probe.context = ctx
        })
        pi.on('before_agent_start', (event) => {
          probe.prompts.push(event.systemPrompt)
        })
      },
    },
  }
}

async function makeDir(name: string): Promise<string> {
  const dir = join(env.root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

async function openSession(options: {
  cwd: string
  workspace: WorkspaceSnapshot | (() => WorkspaceSnapshot | null)
  /** 允许 SDK 加载 cwd 的 AGENTS.md，用于核对锚点指令不重复。 */
  loadContextFiles?: boolean
  /** 记录运行边界实际应用的工作区快照。 */
  onWorkspaceApplied?: (workspace: WorkspaceSnapshot | null) => void
}): Promise<SessionHarness> {
  const getWorkspace =
    typeof options.workspace === 'function'
      ? options.workspace
      : () => options.workspace as WorkspaceSnapshot
  const { probe, extension: probeExtension } = makeProbe()
  let loadedInstructionPaths: string[] = []
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: env.agentDir,
    resourceLoaderOptions: {
      ...TEST_RESOURCE_ISOLATION,
      ...(options.loadContextFiles ? { noContextFiles: false } : {}),
      extensionFactories: [
        createWorkspaceToolsExtension({
          getWorkspace,
          sessionCwd: options.cwd,
          getLoadedInstructionPaths: () => loadedInstructionPaths,
          ...(options.onWorkspaceApplied ? { onWorkspaceApplied: options.onWorkspaceApplied } : {}),
        }),
        probeExtension,
      ],
    },
  })
  loadedInstructionPaths = services.resourceLoader
    .getAgentsFiles()
    .agentsFiles.map((file) => file.path)
  const sessionManager = SessionManager.create(options.cwd, env.defaultSessionDir(options.cwd))
  const { session } = await createAgentSessionFromServices({ services, sessionManager })
  // 与宿主一致，建立扩展绑定后触发 session_start；否则扩展拿不到会话上下文。
  await session.bindExtensions({})
  sessions.push(session)
  return { session, sessionCwd: options.cwd, probe }
}

async function callTool(
  harness: SessionHarness,
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const context = harness.probe.context
  if (!context) throw new Error('session_start context was not captured')
  const definition = harness.session.getToolDefinition(name)
  if (!definition) throw new Error(`tool not found: ${name}`)
  return definition.execute(
    `test-${name}`,
    params,
    undefined,
    undefined,
    context as ExtensionToolContext,
  )
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
}

const NODE_ENV_SCRIPT =
  "node -e 'process.stdout.write(JSON.stringify({cwd:process.cwd(),provider:process.env.PI_PROVIDER,model:process.env.PI_MODEL,session:process.env.PI_SESSION_ID}))'"

type OpenAiTool = {
  function?: {
    name?: string
    description?: string
    parameters?: { properties?: Record<string, unknown> }
  }
}

type OpenAiRequest = { tools?: OpenAiTool[] }

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 合成模型返回一次工具调用；后续请求回退到测试 fetch 的文本响应。 */
function toolCallSse(name: string, args: Record<string, unknown>): Response {
  const base = {
    id: 'chatcmpl-huan-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'huan-test',
  }
  const call = {
    ...base,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_huan_test',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }
  const finish = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }
  return new Response(`${sseChunk(call)}${sseChunk(finish)}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('工作区文件工具与 bash cwd', () => {
  it('bash工具默认提供颜色环境并原样保留ANSI', async () => {
    const harness = await openSession({cwd:env.workspace,workspace:makeWorkspace(1,[])})
    const result = await callTool(harness,'bash',{command:"node -e 'process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,term:process.env.TERM,color:process.env.COLORTERM}) + \"\\u001b[31mred\\u001b[0m\")'"})
    expect(resultText(result)).toContain('"force":"1"')
    expect(resultText(result)).toContain('"term":"xterm-256color"')
    expect(resultText(result)).toContain('"color":"truecolor"')
    expect(resultText(result)).toContain('\u001b[31mred\u001b[0m')
  })

  it('@别名 跨成员读写、编辑与搜索，裸路径锚定会话 cwd', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    await writeFile(join(sessionCwd, 'local.txt'), 'local anchor\n')
    await writeFile(join(beta, 'notes.txt'), 'hello beta\nline two\n')
    await writeFile(join(beta, 'other.txt'), 'other content\n')
    const harness = await openSession({
      cwd: sessionCwd,
      workspace: makeWorkspace(1, [
        { alias: 'alpha', path: alpha },
        { alias: 'beta', path: beta },
      ]),
    })

    expect(resultText(await callTool(harness, 'read', { path: '@beta/notes.txt' }))).toContain(
      'hello beta',
    )
    expect(resultText(await callTool(harness, 'read', { path: 'local.txt' }))).toContain(
      'local anchor',
    )

    await callTool(harness, 'write', {
      path: '@beta/generated.txt',
      content: 'written from session cwd\n',
    })
    expect(await readFile(join(beta, 'generated.txt'), 'utf8')).toContain(
      'written from session cwd',
    )

    await callTool(harness, 'edit', {
      path: '@beta/notes.txt',
      edits: [{ oldText: 'line two', newText: 'line 2' }],
    })
    expect(await readFile(join(beta, 'notes.txt'), 'utf8')).toContain('line 2')

    expect(
      resultText(await callTool(harness, 'grep', { pattern: 'hello', path: '@beta' })),
    ).toContain('notes.txt')
    // 省略 path 的搜索工具默认扫描固定会话 cwd，而不是进程或成员目录。
    expect(resultText(await callTool(harness, 'grep', { pattern: 'local anchor' }))).toContain(
      'local.txt',
    )
    expect(
      resultText(await callTool(harness, 'find', { pattern: '*.txt', path: '@beta' })),
    ).toContain('generated.txt')
    expect(resultText(await callTool(harness, 'ls', { path: '@beta' }))).toContain('notes.txt')

    await expect(
      callTool(harness, 'write', { path: '@beta/../escape.txt', content: 'escape' }),
    ).rejects.toThrow(/escapes workspace project/)
    expect(existsSync(join(env.root, 'escape.txt'))).toBe(false)
    await expect(callTool(harness, 'read', { path: '@missing/file.txt' })).rejects.toThrow(
      /Unknown workspace project/,
    )
  })

  it('模型工具调用经工作区覆盖执行并暴露别名与新 cwd 参数', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    const harness = await openSession({
      cwd: sessionCwd,
      workspace: makeWorkspace(1, [
        { alias: 'alpha', path: alpha },
        { alias: 'beta', path: beta },
      ]),
    })

    // 在测试 fetch 外层记录首个模型请求，并让首个响应中的模型调用 write。
    const requests: OpenAiRequest[] = []
    const fallbackFetch = globalThis.fetch
    let firstRequest = true
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof init?.body === 'string') requests.push(JSON.parse(init.body) as OpenAiRequest)
      if (firstRequest) {
        firstRequest = false
        return toolCallSse('write', {
          path: '@beta/from-model.txt',
          content: 'model wrote via workspace alias\n',
        })
      }
      return fallbackFetch(input, init)
    }) as typeof fetch

    await harness.session.prompt('write the file')

    expect(await readFile(join(beta, 'from-model.txt'), 'utf8')).toContain(
      'model wrote via workspace alias',
    )
    const tools = requests[0]?.tools ?? []
    const readTool = tools.find((tool) => tool.function?.name === 'read')
    const bashTool = tools.find((tool) => tool.function?.name === 'bash')
    expect(readTool?.function?.description).toContain('@alias/')
    expect(bashTool?.function?.parameters?.properties?.cwd).toBeDefined()
  })

  it('显式 bash cwd 切换目录且保留 PI_* 会话环境变量', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    const harness = await openSession({
      cwd: sessionCwd,
      workspace: makeWorkspace(1, [
        { alias: 'alpha', path: alpha },
        { alias: 'beta', path: beta },
      ]),
    })

    const explicit = JSON.parse(
      resultText(
        await callTool(harness, 'bash', { command: NODE_ENV_SCRIPT, cwd: '@beta' }),
      ).trim(),
    )
    expect(pathKey(explicit.cwd)).toBe(pathKey(beta))
    expect(explicit.provider).toBe(TEST_PROVIDER)
    expect(explicit.model).toBe(TEST_MODEL_A)
    expect(explicit.session).toBe(harness.session.sessionId)

    const anchored = JSON.parse(
      resultText(await callTool(harness, 'bash', { command: NODE_ENV_SCRIPT })).trim(),
    )
    expect(pathKey(anchored.cwd)).toBe(pathKey(sessionCwd))
    expect(anchored.provider).toBe(TEST_PROVIDER)
    expect(anchored.model).toBe(TEST_MODEL_A)
    expect(anchored.session).toBe(harness.session.sessionId)
  })
})

describe('项目指令与运行快照', () => {
  it('运行开始前注入成员指令，锚点成员由 SDK 加载且不重复', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    await writeFile(join(alpha, 'AGENTS.md'), 'ANCHOR_RULES_MARKER\n')
    await writeFile(join(beta, 'AGENTS.md'), 'MEMBER_B_RULES_MARKER\n')
    const harness = await openSession({
      cwd: sessionCwd,
      loadContextFiles: true,
      workspace: makeWorkspace(1, [
        { alias: 'alpha', path: alpha },
        { alias: 'beta', path: beta },
      ]),
    })

    await harness.session.prompt('hello')

    expect(harness.probe.prompts).toHaveLength(1)
    const prompt = harness.probe.prompts[0] ?? ''
    expect(prompt).toContain('## Workspace')
    expect(prompt).toContain('@beta')
    expect(prompt).toContain(beta)
    expect(prompt).toMatch(/Instructions for @beta \(apply only to paths under /)
    expect(prompt).toContain('MEMBER_B_RULES_MARKER')
    // SDK 已从会话起始目录的祖先链加载 AGENTS.md；工作区段不得重复同一锚点指令。
    expect(prompt.match(/ANCHOR_RULES_MARKER/g)).toHaveLength(1)
    expect(prompt).not.toContain('Instructions for @alpha')

    const readDefinition = harness.session.getToolDefinition('read')
    expect(readDefinition?.description).toContain('@alias/')
    const bashDefinition = harness.session.getToolDefinition('bash')
    expect(bashDefinition?.description).toContain("'cwd'")
  })

  it('同一运行固定成员快照，下一轮读取新 revision', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    await writeFile(join(beta, 'notes.txt'), 'beta before revision\n')
    let current = makeWorkspace(1, [
      { alias: 'alpha', path: alpha },
      { alias: 'beta', path: beta },
    ])
    const applied: number[] = []
    const harness = await openSession({
      cwd: sessionCwd,
      workspace: () => current,
      onWorkspaceApplied: (workspace) => {
        if (workspace) applied.push(workspace.revision)
      },
    })

    await harness.session.prompt('first run')
    expect(harness.probe.prompts[0]).toContain('@beta')
    expect(applied).toEqual([1])
    expect(resultText(await callTool(harness, 'read', { path: '@beta/notes.txt' }))).toContain(
      'beta before revision',
    )

    // 宿主在运行之间更新成员；下一轮开始前，当前会话仍使用上一轮快照。
    current = makeWorkspace(2, [{ alias: 'alpha', path: alpha }])
    expect(resultText(await callTool(harness, 'read', { path: '@beta/notes.txt' }))).toContain(
      'beta before revision',
    )

    await harness.session.prompt('second run')
    expect(harness.probe.prompts[1]).not.toContain('@beta')
    expect(applied).toEqual([1, 2])
    await expect(callTool(harness, 'read', { path: '@beta/notes.txt' })).rejects.toThrow(
      /Unknown workspace project/,
    )
  })

  it('运行中的排队 follow-up 保持本轮快照，不重新注入系统提示', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    let current = makeWorkspace(1, [
      { alias: 'alpha', path: alpha },
      { alias: 'beta', path: beta },
    ])
    const harness = await openSession({ cwd: sessionCwd, workspace: () => current })

    let queued = false
    const unsubscribe = harness.session.subscribe((event) => {
      if (event.type !== 'agent_start' || queued) return
      queued = true
      // 模拟运行中提交的 follow-up：SDK 在同一 _startRun 循环内消费，
      // 不会再触发 before_agent_start。
      current = makeWorkspace(2, [{ alias: 'alpha', path: alpha }])
      void harness.session.prompt('queued follow-up', { streamingBehavior: 'followUp' })
    })
    try {
      await harness.session.prompt('first run')
    } finally {
      unsubscribe()
    }

    expect(harness.probe.prompts).toHaveLength(1)
    expect(harness.probe.prompts[0]).toContain('@beta')
  })

  it('结算期收到的延迟动作作为下一次运行读取新快照', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const beta = await makeDir('beta')
    let current = makeWorkspace(1, [
      { alias: 'alpha', path: alpha },
      { alias: 'beta', path: beta },
    ])
    const harness = await openSession({ cwd: sessionCwd, workspace: () => current })

    // 模拟宿主的订阅回调在 agent_settled 结算窗口内提交下一轮输入：SDK 1.4.0
    // 会把它放入 _deferredSettledActions，等 run.settled 之后作为新运行执行。
    let deferredRequested = false
    const unsubscribe = harness.session.subscribe((event) => {
      if (event.type !== 'agent_settled' || deferredRequested) return
      deferredRequested = true
      current = makeWorkspace(2, [{ alias: 'alpha', path: alpha }])
      void harness.session.prompt('deferred run')
    })
    try {
      await harness.session.prompt('first run')
    } finally {
      unsubscribe()
    }

    expect(harness.probe.prompts).toHaveLength(2)
    expect(harness.probe.prompts[0]).toContain('@beta')
    // 延迟动作触发新的 before_agent_start，因此读取结算后提交的新 revision。
    expect(harness.probe.prompts[1]).not.toContain('@beta')
  })
})

describe('扩展实例隔离', () => {
  it('两个会话的相同别名分别解析到各自快照', async () => {
    const alpha = await makeDir('alpha')
    const sessionCwd = join(alpha, 'app')
    await mkdir(sessionCwd, { recursive: true })
    const other = await makeDir('other')
    await writeFile(join(alpha, 'value.txt'), 'from alpha\n')
    await writeFile(join(other, 'value.txt'), 'from other\n')

    const first = await openSession({
      cwd: sessionCwd,
      workspace: makeWorkspace(1, [{ alias: 'shared', path: alpha }]),
    })
    const second = await openSession({
      cwd: sessionCwd,
      workspace: makeWorkspace(1, [{ alias: 'shared', path: other }]),
    })

    expect(resultText(await callTool(first, 'read', { path: '@shared/value.txt' }))).toContain(
      'from alpha',
    )
    expect(resultText(await callTool(second, 'read', { path: '@shared/value.txt' }))).toContain(
      'from other',
    )
  })
})
