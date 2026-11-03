/**
 * 资源重载与基础内置装配（G1.4b）宿主集成测试。
 *
 * 真实 Pi SDK + 隔离临时用户空间 + 合成 provider：不读取个人 Pi 配置，
 * 不允许非预期网络请求，不使用个人 MCP/auth。
 *
 * 覆盖：同会话 reload 生命周期（消息/分支/订阅不变、扩展 shutdown/start 各一次、
 * 新增模板与指令生效、设置合并）、互斥与启动期交互（busy、跨窗应答、旧交互取消）、
 * dispose 取消、信任门控（no-resources 后新增资源、显式允许后再重载、已拒绝项目
 * 仍可重载用户资源）、空白页目标、codemode/tool_search 真调用与嵌套 parentToolCallId。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HarnessClientEvent } from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_A,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

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

const waitFor = async <T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

const createHost = (overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {}) =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...overrides,
  })

/** 隔离项目目录（不自动信任：由用例决定装配与信任路径）。 */
const projectDir = async (name: string): Promise<string> => {
  const path = join(env.root, 'projects', name)
  await mkdir(path, { recursive: true })
  return path
}

/** 把项目加入独立工作区并创建会话，返回会话与项目路径。 */
const sessionInProject = async (project: string) => {
  const workspace = await host.createWorkspace({
    name: `工作区-${project.split(/[\\/]/).at(-1) ?? project}`,
    projects: [{ alias: 'p', path: project }],
  })
  if (!workspace.ok) throw new Error('工作区创建失败')
  const thread = await host.createThread({
    workspaceId: workspace.workspace.id,
    startProjectPath: project,
  })
  return { threadId: thread.metadata.id, workspaceId: workspace.workspace.id }
}

/** 收集某会话的事件（按顺序）。 */
function collectEvents(threadId: string): {
  events: HarnessClientEvent[]
  unsubscribe: () => void
} {
  const events: HarnessClientEvent[] = []
  const unsubscribe = host.subscribe(
    threadId,
    (event) => {
      events.push(event)
    },
    { includeSnapshot: false },
  )
  return { events, unsubscribe }
}

const waitIdle = async (threadId: string): Promise<void> => {
  await waitFor(async () => {
    const snapshot = await host.getThread(threadId)
    return snapshot.metadata.status === 'running' ? undefined : true
  })
}

/**
 * 受控合成模型：请求挂起直到测试释放。
 *
 * 用于制造真实的「运行中」窗口，验证 reload 的互斥与 dispose 行为；
 * 只应答合成 provider 端点，其余地址一律失败。
 */
class HeldModel {
  private previous = globalThis.fetch
  private pending: Array<() => void> = []
  private waiters: Array<() => void> = []

  install(): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('http://127.0.0.1:9/')) {
        throw new Error(`测试禁止非预期网络请求：${url}`)
      }
      const encoder = new TextEncoder()
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
        },
      })
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // 已中止/关闭时忽略。
        }
      }
      const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
      const release = () => {
        const index = this.pending.indexOf(release)
        if (index >= 0) this.pending.splice(index, 1)
        write(
          chunk({
            id: 'chatcmpl-huan-reload',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'huan-test',
            choices: [
              { index: 0, delta: { role: 'assistant', content: '受控回复' }, finish_reason: null },
            ],
          }),
        )
        write(
          chunk({
            id: 'chatcmpl-huan-reload',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'huan-test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }),
        )
        write('data: [DONE]\n\n')
        try {
          controller.close()
        } catch {
          // 已关闭时忽略。
        }
        this.wake()
      }
      this.pending.push(release)
      this.wake()
      const signal = init?.signal
      if (signal) {
        const abort = () => {
          const index = this.pending.indexOf(release)
          if (index >= 0) this.pending.splice(index, 1)
          try {
            controller.error(new Error('aborted'))
          } catch {
            // 已关闭时忽略。
          }
          this.wake()
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
  }

  private wake(): void {
    for (const resolve of [...this.waiters]) resolve()
    this.waiters.length = 0
  }

  async waitForPending(): Promise<void> {
    while (this.pending.length === 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  release(): void {
    const release = this.pending[0]
    if (!release) throw new Error('没有等待释放的模型请求')
    release()
  }

  restore(): void {
    globalThis.fetch = this.previous
  }
}

/**
 * 脚本化合成模型：按顺序返回工具调用或文本，之后回退为文本。
 *
 * 用于让真实 SDK 执行 codemode / tool_search 工具调用（含嵌套工具）。
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
      id: `chatcmpl-huan-script-${index}`,
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
                    id: `call_huan_${index}`,
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

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-reload-test-')
  fetchStub = installTestFetch('重载测试回复')
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

describe('同一会话资源重载', () => {
  it('保持会话/消息/分支/订阅，扩展 shutdown+start 各一次并应用新增命令', async () => {
    const marker = join(env.root, 'reload.marker')
    const extensionDir = join(env.agentDir, 'extensions')
    const extensionFile = join(extensionDir, 'reload-probe.js')
    const source = (commands: string[]) => `import { appendFileSync } from 'node:fs'
export default function (pi) {
  const log = (line) => appendFileSync(${JSON.stringify(marker)}, line + '\\n')
  log('factory')
  pi.on('session_start', (event) => log('start:' + event.reason))
  pi.on('session_shutdown', (event) => log('shutdown:' + event.reason))
${commands
  .map(
    (name) =>
      `  pi.registerCommand(${JSON.stringify(name)}, { description: '测试命令', handler: async () => {} })`,
  )
  .join('\n')}
}
`
    await writeTree({ [extensionFile]: source(['probe-first']) })
    // 扩展在宿主启动装配前落盘，首个会话才会真正执行它。
    await host.dispose()
    host = await createHost()
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '第一问' })
    await waitIdle(threadId)
    const before = await host.getThread(threadId)
    expect(before.messages.length).toBeGreaterThan(0)
    expect(before.metadata.leafId).toBeTruthy()
    expect(await readLines(marker)).toEqual(['factory', 'start:startup'])

    // 订阅在重载前后保持：重载完成后仍能收到该会话的运行事件。
    const collected = collectEvents(threadId)
    const commandsBefore = await host.listCommands({ threadId })
    expect(commandsBefore.commands.map((command) => command.name)).toContain('probe-first')

    // 修改扩展（新增命令）后重载：扩展工厂重新执行一次，shutdown/start 各一次。
    await writeTree({ [extensionFile]: source(['probe-second']) })
    const result = await host.reloadResources({ threadId, trigger: 'command' })
    expect(result.status).toBe('reloaded')
    if (result.status !== 'reloaded') throw new Error(result.message)
    expect(result.kind).toBe('session')
    expect(result.operation).toMatchObject({ trigger: 'command', status: 'succeeded' })
    expect(result.snapshot?.metadata.id).toBe(threadId)

    const after = await host.getThread(threadId)
    expect(after.metadata.id).toBe(before.metadata.id)
    expect(after.messages).toEqual(before.messages)
    expect(after.metadata.leafId).toBe(before.metadata.leafId)
    expect(after.metadata.treeRevision).toBe(before.metadata.treeRevision)
    expect(after.metadata.resourceRevision).toBeGreaterThan(before.metadata.resourceRevision ?? 0)
    const lines = await readLines(marker)
    expect(lines.filter((line) => line === 'shutdown:reload')).toHaveLength(1)
    expect(lines.filter((line) => line === 'start:reload')).toHaveLength(1)
    // 不重复执行扩展工厂或 session_start（初始 1 次 + 重载 1 次）。
    expect(lines.filter((line) => line === 'factory')).toHaveLength(2)
    expect(lines.filter((line) => line.startsWith('start:'))).toHaveLength(2)

    const commandsAfter = await host.listCommands({ threadId })
    const names = commandsAfter.commands.map((command) => command.name)
    expect(names).toContain('probe-second')
    expect(names).not.toContain('probe-first')

    // 订阅仍在：同一连接继续收到后续运行事件。
    await host.sendMessage(threadId, { content: '第二问' })
    await waitIdle(threadId)
    collected.unsubscribe()
    expect(collected.events.some((event) => event.type === 'reload_start')).toBe(true)
    expect(collected.events.some((event) => event.type === 'reload_end')).toBe(true)
    expect(
      collected.events.some(
        (event) => event.type === 'message_start' && event.message.role === 'user',
      ),
    ).toBe(true)
  })

  it('新增提示模板与修改 AGENTS.md 后重载生效；设置 flush 后合并', async () => {
    // 模板目录使用 additionalPromptTemplatePaths（即使 noPromptTemplates 也生效）。
    const promptDir = join(env.root, 'prompts')
    await mkdir(promptDir, { recursive: true })
    const agentsFile = join(env.workspace, 'AGENTS.md')
    await writeTree({
      [agentsFile]: '# 第一版指令\n',
      [join(promptDir, 'first.md')]: '---\ndescription: 第一版模板\n---\n内容一\n',
    })
    await host.dispose()
    host = await createHost({
      // 保留项目上下文文件（AGENTS.md），其余仍隔离个人资源。
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        additionalPromptTemplatePaths: [promptDir],
      },
    })
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '第一问' })
    await waitIdle(threadId)

    const beforeResources = await host.getResources({ threadId, includeText: true })
    expect(beforeResources.instructions.some((file) => file.text?.includes('第一版指令'))).toBe(
      true,
    )
    const beforeCommands = await host.listCommands({ threadId })
    expect(beforeCommands.commands.map((command) => command.name)).toContain('first')

    // 修改指令、新增模板，并通过保存设置改变自动压缩开关（测试合并语义）。
    await writeTree({
      [agentsFile]: '# 第二版指令\n',
      [join(promptDir, 'second.md')]: '---\ndescription: 第二版模板\n---\n内容二\n',
    })
    const snapshot = await host.getSettings({ threadId })
    const userFile = snapshot.files.user
    const parsed = JSON.parse(userFile.content) as Record<string, unknown>
    const saved = await host.saveSettings({
      target: { threadId },
      scope: 'user',
      content: `${JSON.stringify({ ...parsed, compaction: { enabled: false } }, null, 2)}\n`,
      expectedRevision: userFile.revision,
    })
    expect(saved.status).toBe('saved')

    const result = await host.reloadResources({ threadId, trigger: 'settings' })
    expect(result.status).toBe('reloaded')
    const afterResources = await host.getResources({ threadId, includeText: true })
    expect(afterResources.instructions.some((file) => file.text?.includes('第二版指令'))).toBe(true)
    expect(afterResources.instructions.some((file) => file.text?.includes('第一版指令'))).toBe(
      false,
    )
    const afterCommands = await host.listCommands({ threadId })
    expect(afterCommands.commands.map((command) => command.name)).toContain('second')
    const after = await host.getThread(threadId)
    expect(after.metadata.autoCompactionEnabled).toBe(false)

    // 删除模板后重载：命令目录同步移除（不保留旧资源引用）。
    await rm(join(promptDir, 'second.md'), { force: true })
    const removed = await host.reloadResources({ threadId, trigger: 'settings' })
    expect(removed.status).toBe('reloaded')
    const removedCommands = await host.listCommands({ threadId })
    expect(removedCommands.commands.map((command) => command.name)).not.toContain('second')
  })

  it('重载前取消旧交互，重载期 session_start 请求可从另一窗口应答，第二次重载 busy', async () => {
    const marker = join(env.root, 'startup.marker')
    await writeTree({
      [join(env.agentDir, 'extensions', 'startup-gate.js')]: `import { existsSync } from 'node:fs'
import { join } from 'node:path'
export default function (pi) {
  pi.registerCommand('pending-confirm', {
    handler: async (_args, ctx) => {
      // 不 await：命令立即结束，请求留在会话 pending 中，随后由重载取消。
      void ctx.ui.confirm('旧交互标题', '旧交互消息')
    },
  })
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'reload') return
    if (!existsSync(join(ctx.cwd, '.pi', 'ask-on-reload'))) return
    const ok = await ctx.ui.confirm('重载启动确认', '允许重载期间的启动交互？')
    appendFileSync(${JSON.stringify(join(env.root, 'startup.marker'))}, 'answer:' + ok + '\\n')
  })
}
import { appendFileSync } from 'node:fs'
`,
    })
    const project = await projectDir('reload-startup')
    await writeTree({ [join(project, '.pi', 'ask-on-reload')]: '' })
    await host.dispose()
    host = await createHost()
    const { threadId } = await sessionInProject(project)

    // 旧交互：不 await 的确认请求留在 pending，重载必须结算掉。
    await host.sendMessage(threadId, { content: '/pending-confirm' })
    const pending = await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.hostUiRequests?.find((request) => request.kind === 'confirm')
    })
    expect(pending.title).toBe('旧交互标题')

    const reloading = host.reloadResources({ threadId, trigger: 'settings' })
    // 重载期间的 session_start 请求进入宿主交互域（不依赖选中会话）。
    const startupRequest = await waitFor(async () => {
      const snapshot = await host.getHostInteractions()
      return snapshot.requests.find((request) => request.title === '重载启动确认')
    })
    expect(startupRequest.scope.kind).toBe('session')
    // 同一会话的第二次重载在结构闸门处被如实拒绝。
    const concurrent = await host.reloadResources({ threadId, trigger: 'command' })
    expect(concurrent.status).toBe('busy')
    // 从“另一个窗口”应答：宿主级交互 ID 与线程通道分离。
    const answered = await host.respondToHostInteraction({
      requestId: startupRequest.id,
      confirmed: true,
    })
    expect(answered.accepted).toBe(true)
    const result = await reloading
    expect(result.status).toBe('reloaded')
    expect(await readLines(marker)).toContain('answer:true')
    const after = await host.getThread(threadId)
    expect(after.hostUiRequests ?? []).toHaveLength(0)
  })

  it('运行/Shell 与重载互斥，busy 如实反馈且不打断运行', async () => {
    const held = new HeldModel()
    held.install()
    try {
      const threadId = (await host.createThread()).metadata.id
      const sending = host.sendMessage(threadId, { content: '受控运行' })
      await held.waitForPending()
      const busyRun = await host.reloadResources({ threadId, trigger: 'command' })
      expect(busyRun.status).toBe('busy')
      if (busyRun.status !== 'busy') throw new Error('运行中应返回 busy')
      expect(busyRun.message).toContain('运行')
      held.release()
      await sending
      await waitIdle(threadId)
      const idle = await host.reloadResources({ threadId, trigger: 'command' })
      expect(idle.status).toBe('reloaded')
    } finally {
      held.restore()
    }

    // Shell 运行中：结构操作（含重载）不得越过外部副作用。
    const threadId = (await host.createThread()).metadata.id
    const started = await host.runThreadBash(threadId, {
      command: 'node -e "setTimeout(() => {}, 2500)"',
    })
    expect(started.status).toBe('started')
    const busyShell = await host.reloadResources({ threadId, trigger: 'command' })
    expect(busyShell.status).toBe('busy')
    if (busyShell.status !== 'busy') throw new Error('Shell 中应返回 busy')
    expect(busyShell.message).toContain('Shell')
    expect(await host.abortThreadBash(threadId)).toEqual({ status: 'requested' })
    // 中止后等待 Shell 真正结算，避免把仍在退出中的进程留给临时目录清理。
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.bash?.status === 'running' ? undefined : true
    })
  })

  it('dispose 中重载被取消并排空，不泄漏阻断请求', async () => {
    await writeTree({
      [join(env.agentDir, 'extensions', 'slow-reload.js')]: `import { existsSync } from 'node:fs'
import { join } from 'node:path'
export default function (pi) {
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'reload') return
    if (!existsSync(join(ctx.cwd, '.pi', 'ask-slow'))) return
    await ctx.ui.confirm('重载慢确认', 'dispose 时应被取消')
  })
}
`,
    })
    const project = await projectDir('reload-dispose')
    await writeTree({ [join(project, '.pi', 'ask-slow')]: '' })
    await host.dispose()
    host = await createHost()
    const { threadId } = await sessionInProject(project)

    const reloading = host.reloadResources({ threadId, trigger: 'command' })
    await waitFor(async () => {
      const snapshot = await host.getHostInteractions()
      return snapshot.requests.find((request) => request.title === '重载慢确认') ? true : undefined
    })
    const begin = Date.now()
    await host.dispose()
    expect(Date.now() - begin).toBeLessThan(10_000)
    const result = await reloading
    expect(result.status).toBe('cancelled')
    // dispose 后宿主不再接受查询（阻断请求已随销毁结算）。
    await expect(host.getHostInteractions()).rejects.toThrow('disposed')
  })
})

describe('重载的信任门控', () => {
  it('no-resources 装配后新增项目资源被拒绝；显式允许后再重载生效', async () => {
    const marker = join(env.root, 'late.marker')
    const project = await projectDir('trust-late')
    const { threadId } = await sessionInProject(project)
    const before = await host.getResources({ threadId })
    expect(before.trust.decision).toBe('trusted')
    // 装配时没有项目资源：已按 no-resources 视为可信（项目资源加载标志为真）。
    expect(before.projectResourcesLoaded).toBe(true)

    // 新增需要信任的项目扩展（不在信任决定时存在）。
    await writeTree({
      [join(project, '.pi', 'extensions', 'late.js')]: `import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', (event) => {
    appendFileSync(${JSON.stringify(marker)}, 'late:' + event.reason + '\\n')
  })
}
`,
    })
    const refused = await host.reloadResources({ threadId, trigger: 'command' })
    expect(refused.status).toBe('failed')
    if (refused.status !== 'failed') throw new Error('应拒绝重载')
    expect(refused.reason).toBe('trust')
    expect(refused.message).toContain('信任')
    // 被拒绝时不得执行新增项目代码。
    expect(await readLines(marker)).toEqual([])
    // 页面读取的信任结论随 live loader 就地更新：不再显示旧的 trusted。
    const refusedSettings = await host.getSettings({ threadId })
    expect(refusedSettings.trust.decision).toBe('needs-trust')
    expect(refusedSettings.projectTrusted).toBe(false)

    // 完成显式信任后（未保存也生效），同一会话重载应真正加载新资源。
    await host.decideProjectTrust({ path: project, trusted: true })
    const allowed = await host.reloadResources({ threadId, trigger: 'command' })
    expect(allowed.status).toBe('reloaded')
    // 只有重载后的 session_start 触发一次（装配本身不伪造启动事件）。
    expect(await readLines(marker)).toEqual(['late:reload'])
    const allowedSettings = await host.getSettings({ threadId })
    expect(allowedSettings.trust.decision).toBe('trusted')
    expect(allowedSettings.files.project.readable).toBe(true)
    const again = await host.reloadResources({ threadId, trigger: 'command' })
    expect(again.status).toBe('reloaded')
    expect(await readLines(marker)).toEqual(['late:reload', 'late:reload'])
  })

  it('重载信任只执行新加载的用户处理器，不允许旧项目扩展自行授权', async () => {
    const project = await projectDir('trust-handler-authority')
    const marker = join(env.root, 'project-trust-handler.marker')
    const userFile = join(env.agentDir, 'extensions', 'trust-policy.js')
    await writeTree({
      [userFile]: `export default function(pi) { pi.on('project_trust', () => ({trusted:'yes'})) }`,
      [join(project, '.pi', 'extensions', 'self-trust.js')]:
        `import { appendFileSync } from 'node:fs'
export default function(pi) {
  pi.on('project_trust', () => {
    appendFileSync(${JSON.stringify(marker)}, 'should-not-run\\n')
    return {trusted:'yes'}
  })
}`,
    })
    await host.dispose()
    host = await createHost()
    const { threadId } = await sessionInProject(project)
    await writeFile(
      userFile,
      `export default function(pi) { pi.on('project_trust', () => ({trusted:'undecided'})) }`,
    )
    const result = await host.reloadResources({ threadId })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('trust')
    expect(await readLines(marker)).toEqual([])
  })

  it('已拒绝项目仍可重载用户级资源，但仍不加载/执行项目资源', async () => {
    const marker = join(env.root, 'rejected.marker')
    const projectMarker = join(env.root, 'project.marker')
    const project = await projectDir('trust-rejected')
    await writeTree({
      [join(project, '.pi', 'extensions', 'project-probe.js')]:
        `import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', (event) => {
    appendFileSync(${JSON.stringify(join(env.root, 'project.marker'))}, 'project:' + event.reason + '\\n')
  })
}
`,
      [join(env.agentDir, 'extensions', 'user-probe.js')]: `import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', (event) => {
    appendFileSync(${JSON.stringify(marker)}, 'start:' + event.reason + '\\n')
  })
}
`,
    })
    // 扩展在宿主启动装配前落盘；随后先明确拒绝再创建会话（否则会停在 needs-trust）。
    await host.dispose()
    host = await createHost()
    const decided = await host.decideProjectTrust({ path: project, trusted: false })
    expect(decided.trust.decision).toBe('untrusted')
    const { threadId } = await sessionInProject(project)
    expect(await readLines(projectMarker)).toEqual([])

    const result = await host.reloadResources({ threadId, trigger: 'command' })
    expect(result.status).toBe('reloaded')
    // 用户级扩展正常重载；项目资源仍被信任门控挡住。
    expect(await readLines(marker)).toEqual(['start:startup', 'start:reload'])
    expect(await readLines(projectMarker)).toEqual([])
    const resources = await host.getResources({ threadId })
    expect(resources.projectResourcesLoaded).toBe(false)
  })
})

describe('空白页目标重载', () => {
  it('live 会话消费缓存后，空白页重载仍重新检查新增受保护资源', async () => {
    const project = await projectDir('workspace-late-trust')
    const marker = join(env.root, 'workspace-late.marker')
    await sessionInProject(project)
    await writeTree({
      [join(project, '.pi', 'extensions', 'late.js')]: `import { appendFileSync } from 'node:fs'
export default function() { appendFileSync(${JSON.stringify(marker)}, 'executed') }`,
    })
    const result = await host.reloadResources({ workspacePath: project })
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.reason).toBe('trust')
    expect(await readLines(marker)).toEqual([])
  })

  it('只刷新该 cwd 的待消费装配，不创建会话、不影响同 cwd 会话', async () => {
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '已有会话' })
    await waitIdle(threadId)
    const before = await host.listThreads()
    const sessionBefore = await host.getThread(threadId)

    const extensionDir = join(env.agentDir, 'extensions')
    const writeCommandExtension = (file: string, command: string) =>
      writeTree({
        [join(extensionDir, file)]: `export default function (pi) {
  pi.registerCommand(${JSON.stringify(command)}, { description: '空白页重载探针', handler: async () => {} })
}
`,
      })

    // 1) 首次重载：无待消费装配，走正常受信装配路径（不创建会话）。
    await writeCommandExtension('workspace-target-a.js', 'workspace-target-a')
    const first = await host.reloadResources({ workspacePath: env.workspace, trigger: 'command' })
    expect(first.status).toBe('reloaded')
    if (first.status !== 'reloaded') throw new Error(first.message)
    expect(first.kind).toBe('workspace')
    expect(first.snapshot).toBeUndefined()
    const firstCommands = await host.listCommands({ workspacePath: env.workspace })
    expect(firstCommands.commands.map((command) => command.name)).toContain('workspace-target-a')

    // 2) 已有待消费装配：再次重载必须刷新它（新命令可见）。
    await writeCommandExtension('workspace-target-b.js', 'workspace-target-b')
    const stale = await host.listCommands({ workspacePath: env.workspace })
    expect(stale.commands.map((command) => command.name)).not.toContain('workspace-target-b')
    const second = await host.reloadResources({
      workspacePath: env.workspace,
      trigger: 'settings',
    })
    expect(second.status).toBe('reloaded')
    const fresh = await host.listCommands({ workspacePath: env.workspace })
    expect(fresh.commands.map((command) => command.name)).toContain('workspace-target-b')

    // 不创建会话、不停止/替换同 cwd 的 live 会话（其 loader 不被替换）。
    expect((await host.listThreads()).length).toBe(before.length)
    const sessionAfter = await host.getThread(threadId)
    expect(sessionAfter.metadata.id).toBe(sessionBefore.metadata.id)
    expect(sessionAfter.messages).toEqual(sessionBefore.messages)
    expect(sessionAfter.metadata.resourceRevision).toBe(sessionBefore.metadata.resourceRevision)
    const sessionCommands = await host.listCommands({ threadId })
    expect(sessionCommands.commands.map((command) => command.name)).not.toContain(
      'workspace-target-b',
    )
  })
})

describe('codemode / tool_search 内置装配', () => {
  it('按 named builtin 装配且默认不激活；codemode 脚本的嵌套工具带 parentToolCallId', async () => {
    const leafFile = join(env.workspace, 'codemode-leaf.txt')
    await writeTree({ [leafFile]: '嵌套工具读取成功\n' })
    await writeTree({
      [join(env.agentDir, 'settings.json')]: `${JSON.stringify(
        {
          defaultProvider: 'huan-test',
          defaultModel: TEST_MODEL_A,
          defaultTools: ['+codemode', '+tool_search'],
        },
        null,
        2,
      )}\n`,
      // 延迟暴露工具：只有 tool_search 能发现并声明它（不使用 SDK 辅助函数，
      // 扩展文件位于临时目录，无法解析宿主依赖）。
      [join(env.agentDir, 'extensions', 'deferred-probe.js')]: `export default function (pi) {
  pi.registerTool({
    name: 'deferred-probe',
    description: 'deferred probe tool for tool_search',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'deferred-ok' }] }),
    exposure: 'deferred',
    defaultActive: false,
  })
}
`,
    })
    // 重启宿主读取新设置（defaultTools 在会话创建时生效）。
    await host.dispose()
    host = await createHost()

    const scripted = installScriptedModel([
      { tool: { name: 'tool_search', args: { query: 'deferred probe' } } },
      {
        tool: {
          name: 'codemode',
          args: { code: `return await tools.read({ path: ${JSON.stringify(leafFile)} })` },
        },
      },
      { text: '全部完成' },
    ])
    try {
      const threadId = (await host.createThread()).metadata.id
      const resources = await host.getResources({ threadId })
      const extensionPaths = resources.extensions.map((extension) => extension.path)
      expect(extensionPaths).toContain('builtin:codemode')
      expect(extensionPaths).toContain('builtin:tool-search')
      const collected = collectEvents(threadId)
      await host.sendMessage(threadId, { content: '调用工具' })
      await waitIdle(threadId)
      collected.unsubscribe()

      const starts = collected.events.flatMap((event) =>
        event.type === 'tool_execution_start' ? [event] : [],
      )
      const toolSearch = starts.find((event) => event.toolName === 'tool_search')
      const codemode = starts.find((event) => event.toolName === 'codemode')
      expect(toolSearch).toBeTruthy()
      expect(codemode).toBeTruthy()
      // 嵌套调用：脚本里的 read 是 codemode 的子工具调用。
      const nested = starts.find((event) => event.toolName === 'read')
      expect(nested).toBeTruthy()
      expect(nested?.parentToolCallId).toBe(codemode?.toolCallId)
      expect(codemode?.parentToolCallId).toBeUndefined()

      // huan 工作区工具没有被移除或收窄：脚本里的 read 真读到了文件内容。
      const messages = (await host.getThread(threadId)).messages
      const codemodeResult = messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === codemode?.toolCallId,
      )
      expect(JSON.stringify(codemodeResult)).toContain('嵌套工具读取成功')
      // tool_search 真找到了 deferred 工具（不是空装配的空调用）。
      const searchResult = messages.find(
        (message) => message.role === 'toolResult' && message.toolCallId === toolSearch?.toolCallId,
      )
      expect(JSON.stringify(searchResult)).toContain('deferred-probe')
      expect(scripted.calls()).toBeGreaterThanOrEqual(3)
    } finally {
      scripted.restore()
    }
  })

  it('extensions 设置禁用 builtin 后不装配该内置扩展', async () => {
    await writeTree({
      [join(env.agentDir, 'settings.json')]: `${JSON.stringify(
        {
          defaultProvider: 'huan-test',
          defaultModel: TEST_MODEL_A,
          extensions: ['-builtin:tool-search'],
        },
        null,
        2,
      )}\n`,
    })
    await host.dispose()
    host = await createHost()
    const threadId = (await host.createThread()).metadata.id
    const resources = await host.getResources({ threadId })
    const extensionPaths = resources.extensions.map((extension) => extension.path)
    expect(extensionPaths).toContain('builtin:codemode')
    expect(extensionPaths).not.toContain('builtin:tool-search')
  })

  it('第三方扩展注册同名工具时替换内置扩展而不是并行运行', async () => {
    await writeTree({
      // 普通（非 replaceable）扩展先占用 tool_search 名称。
      [join(env.agentDir, 'extensions', 'replacement.js')]: `export default function (pi) {
  pi.registerTool({
    name: 'tool_search',
    description: '第三方 tool_search 替换实现',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'replacement-ok' }] }),
  })
}
`,
    })
    await host.dispose()
    host = await createHost()
    const threadId = (await host.createThread()).metadata.id
    const resources = await host.getResources({ threadId })
    const entries = resources.extensions
    // 内置 tool-search 被替换，不作为第二个扩展同时加载。
    expect(entries.map((entry) => entry.path)).not.toContain('builtin:tool-search')
    const replacement = entries.find((entry) => entry.path.endsWith('replacement.js'))
    expect(replacement?.tools).toContain('tool_search')
  })
})
