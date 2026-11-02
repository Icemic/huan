/**
 * 宿主 MCP 装配与生命周期集成测试（G1.4d2b）。
 *
 * 真实 Pi SDK + 隔离临时用户空间 + 官方 stdio fixture 子进程 + 确定性合成模型：
 * 不读取个人 Pi 配置/凭据，不访问付费模型，也不启动真实外部 MCP 服务。
 *
 * 覆盖：direct/codemode/tool_search 真调用、嵌套 parentToolCallId、权限拒绝无
 * 副作用、项目信任与 no-resources 后新增配置、查询只装配不连接、同 cwd 多会话
 * 独立连接、reload 回收旧进程并保留历史、删除/dispose 回收、builtin 禁用/替换
 * 与无服务器装配。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessReloadResult } from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

// 只读取 mcp 包内的测试 fixture 文件；不从 core 私有导入该包源码。
const fixturePath = fileURLToPath(
  new URL('../../mcp/src/test-fixtures/stdio-server.mjs', import.meta.url),
)

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

let env: IsolatedPiEnv
let host: HarnessHost
let fetchStub: TestFetchStub
let savedEnv: Map<string, string | undefined>

const createHost = (overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {}) =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...overrides,
  })

const writeTree = async (files: Record<string, string>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

const readLines = async (path: string): Promise<string[]> => {
  try {
    const text = await readFile(path, 'utf8')
    return text.split('\n').filter((line) => line.length > 0)
  } catch {
    return []
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async <T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(20)
  }
  throw new Error('等待条件超时')
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const readPid = async (path: string): Promise<number | undefined> => {
  try {
    const text = (await readFile(path, 'utf8')).trim()
    const pid = Number(text)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

const waitForPid = (path: string, timeoutMs = 10_000): Promise<number> =>
  waitFor(async () => {
    const pid = await readPid(path)
    return pid === undefined ? undefined : pid
  }, timeoutMs)

const waitForPidChange = async (
  path: string,
  previous: number,
  timeoutMs = 10_000,
): Promise<number> => {
  return waitFor(async () => {
    const pid = await readPid(path)
    return pid !== undefined && pid !== previous ? pid : undefined
  }, timeoutMs)
}

const waitForPidGone = async (pid: number, timeoutMs = 10_000): Promise<void> => {
  await waitFor(() => (isAlive(pid) ? undefined : true), timeoutMs)
}

const waitIdle = async (threadId: string): Promise<void> => {
  await waitFor(async () => {
    const snapshot = await host.getThread(threadId)
    return snapshot.metadata.status === 'running' ? undefined : true
  })
}

const sendAndWait = async (threadId: string, content: string): Promise<void> => {
  await host.sendMessage(threadId, { content })
  await waitIdle(threadId)
}

/** 隔离项目目录；项目资源（含 `.pi/mcp.json`）仍由用例显式决定信任。 */
const projectDir = async (name: string): Promise<string> => {
  const path = join(env.root, 'projects', name)
  await mkdir(path, { recursive: true })
  return path
}

const createWorkspaceFor = async (project: string): Promise<string> => {
  const workspace = await host.createWorkspace({
    name: `工作区-${project.split(/[\\/]/).at(-1) ?? project}`,
    projects: [{ alias: 'p', path: project }],
  })
  if (!workspace.ok) throw new Error('工作区创建失败')
  return workspace.workspace.id
}

const writeUserMcp = async (servers: Record<string, unknown>): Promise<void> => {
  await writeFile(join(env.agentDir, 'mcp.json'), `${JSON.stringify({ mcpServers: servers })}\n`)
}

const writeProjectMcp = async (
  project: string,
  servers: Record<string, unknown>,
): Promise<void> => {
  await mkdir(join(project, '.pi'), { recursive: true })
  await writeFile(join(project, '.pi', 'mcp.json'), `${JSON.stringify({ mcpServers: servers })}\n`)
}

/** 复制核心测试的内置设置，只覆盖指定字段。 */
const writeUserSettings = async (patch: Record<string, unknown>): Promise<void> => {
  const path = join(env.agentDir, 'settings.json')
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`)
}

interface StdioFixtureOptions {
  pidFile: string
  sideEffectFile?: string
  extraEnv?: Record<string, string>
  exposure?: string
}

/** 生成指向真实 stdio fixture 的服务器配置（不访问任何外部服务）。 */
const stdioServer = (options: StdioFixtureOptions) => ({
  command: process.execPath,
  args: [fixturePath],
  exposure: options.exposure ?? 'direct',
  env: {
    FIXTURE_PID_FILE: options.pidFile,
    ...(options.sideEffectFile ? { FIXTURE_SIDE_EFFECT_FILE: options.sideEffectFile } : {}),
    ...(options.extraEnv ?? {}),
  },
})

/**
 * 脚本化合成模型：按顺序返回工具调用或文本，之后回退为文本。
 *
 * 与 host-reload.test.ts 的确定性模型同形；只应答合成 provider 端点。
 */
function installScriptedModel(
  turns: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }>,
): { calls: () => number; restore: () => void } {
  const previous = globalThis.fetch
  let index = 0
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('http://127.0.0.1:9/')) {
      throw new Error(`测试禁止非预期网络请求：${url}`)
    }
    const turn = turns[index] ?? { text: '完成' }
    index += 1
    const base = {
      id: `chatcmpl-huan-mcp-${index}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'huan-test',
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
                    id: `call_huan_mcp_${index}`,
                    type: 'function',
                    function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
          chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
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
    calls: () => index,
    restore: () => {
      globalThis.fetch = previous
    },
  }
}

/** 断言重载失败为信任门控（而不是装配/销毁）。 */
const expectTrustFailure = (result: HarnessReloadResult): void => {
  if (result.status !== 'failed') throw new Error(`预期重载失败，实际：${result.status}`)
  expect(result.reason).toBe('trust')
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-host-mcp-test-')
  fetchStub = installTestFetch('MCP 测试回复')
  host = await createHost()
})

afterEach(async () => {
  await host.dispose().catch(() => {})
  fetchStub.restore()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('真实 SDK：MCP 工具调用', () => {
  it('direct 工具经真实 stdio 服务执行', async () => {
    const pidFile = join(env.root, 'direct.pid')
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'direct' }) })
    const created = await host.createThread()
    const threadId = created.metadata.id
    const pid = await waitForPid(pidFile)

    const scripted = installScriptedModel([
      { tool: { name: 'mcp__demo__echo', args: { text: 'direct' } } },
      { text: '完成' },
    ])
    try {
      await sendAndWait(threadId, '调用 direct 工具')
    } finally {
      scripted.restore()
    }
    const text = JSON.stringify((await host.getThread(threadId)).messages)
    expect(text).toContain('echo:direct')
    expect(isAlive(pid)).toBe(true)
  }, 30_000)

  it('codemode 脚本调用 MCP 工具并保留嵌套 parentToolCallId', async () => {
    const pidFile = join(env.root, 'codemode.pid')
    const marker = join(env.root, 'tool-events.jsonl')
    await writeTree({
      [join(env.agentDir, 'extensions', 'mcp-tool-probe.js')]:
        `import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('tool_execution_start', (event) => {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      name: event.toolName,
      id: event.toolCallId,
      parent: event.parentToolCallId,
    }) + '\\n')
  })
}
`,
    })
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'codemode' }) })
    await host.dispose()
    host = await createHost()
    const created = await host.createThread()
    const threadId = created.metadata.id
    await waitForPid(pidFile)

    const scripted = installScriptedModel([
      {
        tool: {
          name: 'codemode',
          args: { code: "return await tools.mcp__demo__echo({ text: 'via codemode' })" },
        },
      },
      { text: '完成' },
    ])
    try {
      await sendAndWait(threadId, '用 codemode 调用')
    } finally {
      scripted.restore()
    }
    const text = JSON.stringify((await host.getThread(threadId)).messages)
    expect(text).toContain('echo:via codemode')

    const events = (await readLines(marker)).map(
      (line) => JSON.parse(line) as { name: string; id: string; parent?: string },
    )
    const codemode = events.find((event) => event.name === 'codemode')
    const nested = events.find((event) => event.name === 'mcp__demo__echo')
    expect(codemode).toBeTruthy()
    expect(nested).toBeTruthy()
    expect(nested?.parent).toBe(codemode?.id)
  }, 30_000)

  it('deferred 工具经 tool_search 发现后可直接调用', async () => {
    const pidFile = join(env.root, 'search.pid')
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'deferred' }) })
    const created = await host.createThread()
    const threadId = created.metadata.id
    await waitForPid(pidFile)

    const scripted = installScriptedModel([
      { tool: { name: 'tool_search', args: { query: 'echo' } } },
      { tool: { name: 'mcp__demo__echo', args: { text: 'via search' } } },
      { text: '完成' },
    ])
    try {
      await sendAndWait(threadId, '用 tool_search 找工具')
    } finally {
      scripted.restore()
    }
    const text = JSON.stringify((await host.getThread(threadId)).messages)
    expect(text).toContain('echo:via search')
  }, 30_000)

  it('tool_call 权限拒绝时 MCP 工具不执行服务器副作用', async () => {
    const pidFile = join(env.root, 'denied.pid')
    const sideEffectFile = join(env.root, 'denied-side-effects.txt')
    await writeTree({
      [join(env.agentDir, 'extensions', 'deny-mcp.js')]: `export default function (pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName === 'mcp__demo__side_effect') {
      return { block: true, reason: '测试拒绝 MCP 工具' }
    }
    return undefined
  })
}
`,
    })
    await writeUserMcp({
      demo: stdioServer({ pidFile, sideEffectFile, exposure: 'direct' }),
    })
    await host.dispose()
    host = await createHost()
    const created = await host.createThread()
    const threadId = created.metadata.id
    await waitForPid(pidFile)

    const scripted = installScriptedModel([
      { tool: { name: 'mcp__demo__side_effect', args: {} } },
      { text: '完成' },
    ])
    try {
      await sendAndWait(threadId, '尝试被拒绝的工具')
    } finally {
      scripted.restore()
    }
    expect(existsSync(sideEffectFile)).toBe(false)
    const text = JSON.stringify((await host.getThread(threadId)).messages)
    expect(text).toContain('测试拒绝 MCP 工具')
  }, 30_000)
})

describe('项目信任与查询装配', () => {
  it('拒绝项目信任时不读取项目 MCP 配置，也不启动项目进程', async () => {
    const project = await projectDir('denied-project')
    const pidFile = join(env.root, 'project-denied.pid')
    await writeProjectMcp(project, {
      project: stdioServer({ pidFile, exposure: 'direct' }),
    })
    const workspaceId = await createWorkspaceFor(project)
    await host.decideProjectTrust({ path: project, trusted: false })
    const thread = await host.createThread({ workspaceId, startProjectPath: project })

    // createThread 已等待 session_start 完成；拒绝结论下项目配置不应进入 loader。
    await sleep(300)
    expect(existsSync(pidFile)).toBe(false)
    expect((await host.getThread(thread.metadata.id)).metadata.id).toBe(thread.metadata.id)
  }, 30_000)

  it('no-resources 后新增项目 MCP 配置：先拒绝重载，明确信任后才启动', async () => {
    const project = await projectDir('late-project')
    const workspaceId = await createWorkspaceFor(project)
    const thread = await host.createThread({ workspaceId, startProjectPath: project })
    const threadId = thread.metadata.id
    const pidFile = join(env.root, 'project-late.pid')

    // 初装配没有受保护项目资源，来源是 no-resources。
    await writeProjectMcp(project, {
      project: stdioServer({ pidFile, exposure: 'direct' }),
    })
    const refused = await host.reloadResources({ threadId, trigger: 'command' })
    expectTrustFailure(refused)
    await sleep(300)
    expect(existsSync(pidFile)).toBe(false)

    await host.decideProjectTrust({ path: project, trusted: true })
    const reloaded = await host.reloadResources({ threadId, trigger: 'command' })
    expect(reloaded.status).toBe('reloaded')
    await waitForPid(pidFile)
    expect((await host.getThread(threadId)).metadata.id).toBe(threadId)
  }, 40_000)

  it('装配无资源后session_start新增项目配置不会沿用no-resources授权', async () => {
    const project = await projectDir('startup-late-mcp')
    const pidFile = join(env.root, 'startup-late.pid')
    const config = { mcpServers: { late: stdioServer({ pidFile }) } }
    await writeTree({
      [join(env.agentDir, 'extensions', 'late-project-mcp.js')]:
        `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.cwd !== ${JSON.stringify(project)}) return
    mkdirSync(join(ctx.cwd, '.pi'), { recursive: true })
    writeFileSync(join(ctx.cwd, '.pi', 'mcp.json'), ${JSON.stringify(JSON.stringify(config))})
  })
}
`,
    })
    await host.dispose()
    host = await createHost()
    const workspaceId = await createWorkspaceFor(project)
    await host.createThread({ workspaceId, startProjectPath: project })
    await sleep(150)
    expect(existsSync(join(project, '.pi', 'mcp.json'))).toBe(true)
    expect(existsSync(pidFile)).toBe(false)
  }, 30_000)

  it('目录/命令查询只装配工厂，不启动 MCP 连接', async () => {
    const pidFile = join(env.root, 'query.pid')
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'direct' }) })
    // 重启宿主，确保目录查询走的是“已看到服务器配置”的装配。
    await host.dispose()
    host = await createHost()
    const catalog = await host.listCommands({ workspacePath: env.workspace })
    expect(catalog.commands.length).toBeGreaterThan(0)
    await sleep(300)
    expect(existsSync(pidFile)).toBe(false)
  }, 30_000)
})

describe('多会话与生命周期回收', () => {
  it('同 cwd 两个会话使用独立进程；删除一个不关闭另一个', async () => {
    const pidFile = join(env.root, 'shared.pid')
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'direct' }) })
    const first = await host.createThread()
    const firstPid = await waitForPid(pidFile)
    await host.createThread()
    const secondPid = await waitForPidChange(pidFile, firstPid)

    expect(secondPid).not.toBe(firstPid)
    expect(isAlive(firstPid)).toBe(true)
    expect(isAlive(secondPid)).toBe(true)

    // 第二个会话创建后第一个仍可真实调用（没有把同 cwd 的切换当成关闭理由）。
    const scripted = installScriptedModel([
      { tool: { name: 'mcp__demo__echo', args: { text: 'first-session' } } },
      { text: '完成' },
    ])
    try {
      await sendAndWait(first.metadata.id, '第一个会话调用')
    } finally {
      scripted.restore()
    }
    expect(JSON.stringify((await host.getThread(first.metadata.id)).messages)).toContain(
      'echo:first-session',
    )

    // 删除第一个会话只回收自己的连接；第二个进程仍在运行。
    await host.deleteThread(first.metadata.id)
    await waitForPidGone(firstPid)
    expect(isAlive(secondPid)).toBe(true)
  }, 40_000)

  it('reload 在其他 shutdown handler 阻塞时即回收旧 PID，并保留会话历史', async () => {
    const pidFile = join(env.root, 'reload.pid')
    const entered = join(env.root, 'shutdown-entered')
    const release = join(env.root, 'shutdown-release')
    await writeTree({
      [join(env.agentDir, 'extensions', 'blocking-shutdown.js')]:
        `import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_shutdown', async (event) => {
    if (event.reason !== 'reload') return
    writeFileSync(${JSON.stringify(entered)}, 'entered')
    while (!existsSync(${JSON.stringify(release)})) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
}
`,
    })
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'direct' }) })
    await host.dispose()
    host = await createHost()
    const created = await host.createThread()
    const threadId = created.metadata.id
    await sendAndWait(threadId, '重载前的历史')
    const before = await host.getThread(threadId)
    const oldPid = await waitForPid(pidFile)

    const reloading = host.reloadResources({ threadId, trigger: 'command' })
    // 等扩展明确进入 shutdown handler；核心应在它阻塞前已关闭 MCP 旧代次。
    await waitFor(() => (existsSync(entered) ? true : undefined))
    await waitForPidGone(oldPid)
    await writeFile(release, 'go')

    const result = await reloading
    expect(result.status).toBe('reloaded')
    const newPid = await waitForPidChange(pidFile, oldPid)
    expect(isAlive(newPid)).toBe(true)
    const after = await host.getThread(threadId)
    expect(after.metadata.id).toBe(threadId)
    expect(after.messages).toEqual(before.messages)
  }, 40_000)

  it('宿主 dispose 回收慢初始化的 MCP 进程', async () => {
    const pidFile = join(env.root, 'slow-dispose.pid')
    await writeUserMcp({
      demo: stdioServer({
        pidFile,
        exposure: 'direct',
        extraEnv: { FIXTURE_SLOW_INIT_MS: '8000' },
      }),
    })
    await host.dispose()
    host = await createHost()
    await host.createThread()
    const pid = await waitForPid(pidFile)

    await host.dispose()
    await waitForPidGone(pid)
  }, 40_000)

  it('session_start 永久阻塞时 dispose 阻止晚启动 MCP', async () => {
    const pidFile = join(env.root, 'late-start.pid')
    const entered = join(env.root, 'start-entered')
    const release = join(env.root, 'start-release')
    await writeTree({
      [join(env.agentDir, 'extensions', 'blocking-start.js')]:
        `import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', async () => {
    writeFileSync(${JSON.stringify(entered)}, 'entered')
    while (!existsSync(${JSON.stringify(release)})) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
}
`,
    })
    await writeUserMcp({ demo: stdioServer({ pidFile, exposure: 'direct' }) })
    await host.dispose()
    host = await createHost()

    const creating = host.createThread().catch((error: unknown) => ({ error }))
    await waitFor(() => (existsSync(entered) ? true : undefined))
    // 用户 handler 先于内置 MCP 执行；dispose 后放行，晚到的 session_start
    // 不能重新启动连接。
    await host.dispose()
    await writeFile(release, 'go')
    const outcome = (await creating) as { error?: unknown }
    expect(outcome.error).toBeTruthy()
    await sleep(300)
    expect(existsSync(pidFile)).toBe(false)
  }, 40_000)
})

describe('builtin 启停与无服务器', () => {
  it('extensions 设置可禁用 builtin:mcp', async () => {
    const pidFile = join(env.root, 'disabled.pid')
    await writeUserSettings({ extensions: ['-builtin:mcp'] })
    await writeUserMcp({ demo: stdioServer({ pidFile }) })
    await host.dispose()
    host = await createHost()
    const created = await host.createThread()
    const resources = await host.getResources({ threadId: created.metadata.id })
    const paths = resources.extensions.map((extension) => extension.path)
    expect(paths).not.toContain('builtin:mcp')
    await sleep(300)
    expect(existsSync(pidFile)).toBe(false)
  }, 30_000)

  it('第三方注册 /mcp 命令时替换 builtin:mcp，而不是并行装配', async () => {
    await writeTree({
      [join(env.agentDir, 'extensions', 'replace-mcp.js')]: `export default function (pi) {
  pi.registerCommand('mcp', { description: '第三方 MCP 命令', handler: async () => {} })
}
`,
    })
    await host.dispose()
    host = await createHost()
    const created = await host.createThread()
    const resources = await host.getResources({ threadId: created.metadata.id })
    const paths = resources.extensions.map((extension) => extension.path)
    expect(paths).not.toContain('builtin:mcp')
    expect(paths.some((path) => path.endsWith('replace-mcp.js'))).toBe(true)
  }, 30_000)

  it('没有服务器配置时正常装配，不启动任何进程', async () => {
    const pidFile = join(env.root, 'none.pid')
    await writeUserMcp({})
    const created = await host.createThread()
    const threadId = created.metadata.id
    const scripted = installScriptedModel([{ text: '无 MCP 也能对话' }])
    try {
      await sendAndWait(threadId, '普通对话')
    } finally {
      scripted.restore()
    }
    expect(JSON.stringify((await host.getThread(threadId)).messages)).toContain('无 MCP 也能对话')
    await sleep(300)
    expect(existsSync(pidFile)).toBe(false)
  }, 30_000)
})
