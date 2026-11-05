/**
 * SDK 子任务服务隔离测试。
 *
 * 使用隔离 agentDir/workspace、合成 provider 与真实 Pi SessionManager；
 * 不读取个人配置、不启动 CLI、不访问 8799/8788。装配用 `prepareProjectTrust`
 * 的最小 PreparedProject 夹具替代完整 host，只验证本服务的所有权与投影。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSession, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { McpConnectionManager, McpIntegration } from '@huan/mcp'
import type {
  HarnessAgentMessage,
  HarnessHostUiResponse,
  HarnessSubagentTask,
  HarnessSubagentTaskView,
  HarnessThreadSnapshot,
} from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSharedModelRuntime } from '../model-catalog.js'
import { prepareProjectTrust } from '../project-trust.js'
import type { SubagentAgentDefinition } from '../subagent-definitions.js'
import type { SubagentTaskContext, SubagentTaskExecution } from '../subagent-tool.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_A,
  TEST_MODEL_B,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  TEST_UNAUTH_MODEL,
  TEST_UNAUTH_PROVIDER,
  type TestFetchStub,
} from '../test-support.js'
import type { WorkspaceStore } from '../workspace-store.js'
import type { ThreadRecord } from './shared.js'
import type { SubagentPrepareOptions } from './subagent-sessions.js'
import { SubagentSessions } from './subagent-sessions.js'

type ModelRuntime = Awaited<ReturnType<typeof createSharedModelRuntime>>
type ParentOptions = {
  workspaceId?: string
  activeTools?: string[]
  thinkingLevel?: AgentSession['thinkingLevel']
  mcpManager?: Partial<McpConnectionManager>
  /** 父会话已作出的项目信任结论；缺省为显式 trusted。 */
  trust?: 'trusted' | 'untrusted'
}

type Fixture = {
  service: SubagentSessions
  parent: ThreadRecord
  runtime: ModelRuntime
  prepared: SubagentPrepareOptions[]
  /** 装配收到的显式信任覆盖值，用于确认是否沿用父结论。 */
  prepareOverrides: (boolean | undefined)[]
  mcpClosed: () => number
}

let env: IsolatedPiEnv
let fetchStub: TestFetchStub
const services: SubagentSessions[] = []

beforeEach(async () => {
  env = await createIsolatedPiEnv('huan-subagent-sessions-')
  fetchStub = installTestFetch('子任务回复')
})

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  fetchStub.restore()
  await env.cleanup()
})

function agentDefinition(
  overrides: Partial<SubagentAgentDefinition> = {},
): SubagentAgentDefinition {
  return {
    name: 'review',
    description: '代码审查',
    body: 'REVIEW BODY',
    source: 'user',
    filePath: join(env.agentDir, 'agents', 'review.md'),
    ...overrides,
  }
}

function parentRecord(runtime: ModelRuntime, options: ParentOptions = {}): ThreadRecord {
  const model = runtime.getModel(TEST_PROVIDER, TEST_MODEL_A)
  if (!model) throw new Error('测试模型未注册')
  return {
    threadId: 'parent-thread',
    session: {
      model,
      thinkingLevel: options.thinkingLevel ?? 'low',
      getActiveToolNames: () => options.activeTools ?? ['read'],
    } as unknown as ThreadRecord['session'],
    workspacePath: env.workspace,
    workspaceId: options.workspaceId,
    workspaceAppliedRevision: undefined,
    resourceRevision: 0,
    trustBinding: {
      state: () => ({
        cwd: env.workspace,
        status: options.trust ?? 'trusted',
        source: options.trust === 'untrusted' ? 'saved' : 'explicit',
        requiresTrust: options.trust === 'untrusted',
        defaultProjectTrust: 'ask' as const,
        extensionErrors: [],
      }),
    },
    mcp: {
      getManager: () => options.mcpManager,
    },
  } as unknown as ThreadRecord
}

function workspaceStore(patterns?: readonly string[]): Pick<WorkspaceStore, 'workspace'> {
  return {
    workspace: (workspaceId: string) =>
      workspaceId === 'workspace-1'
        ? {
            id: workspaceId,
            name: '测试工作区',
            revision: 1,
            projects: [],
            ...(patterns !== undefined ? { modelPatterns: [...patterns] } : {}),
          }
        : undefined,
  }
}

function fakeMcpManager(): McpConnectionManager {
  return {
    snapshot: () => ({ servers: [{ name: 'demo' }] }),
    getServerEntry: (name: string) => ({
      name,
      scope: 'user',
      source: join(env.agentDir, 'mcp.json'),
      config: {
        enabled: false,
        exposure: 'direct',
        toolExposure: { echo: 'hidden' },
      },
    }),
  } as unknown as McpConnectionManager
}

function testSnapshot(record: ThreadRecord): HarnessThreadSnapshot {
  return {
    metadata: { id: record.threadId, status: 'running' },
    messages: record.session.messages as HarnessThreadSnapshot['messages'],
  }
}

/** 让真实 SDK 请求停在 fetch；中止 signal 时按 AbortSignal 拒绝。 */
function holdProviderFetch(): { requested: Promise<void>; restore: () => void } {
  const base = globalThis.fetch
  let markRequested: () => void = () => {}
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  globalThis.fetch = (async (input, init) => {
    markRequested()
    await new Promise<never>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(new Error('aborted'))
        return
      }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    return base(input, init)
  }) as typeof fetch
  return {
    requested,
    restore: () => {
      globalThis.fetch = base
    },
  }
}

async function fixture(
  options: {
    parent?: ParentOptions
    extension?: InlineExtension
    scopePatterns?: readonly string[]
    prepareBarrier?: Promise<void>
    onPrepareStarted?: () => void
    /** 在装配返回前用子任务信任上下文模拟交互；测试可挂起等待取消。 */
    prepareInteraction?: (prepareOptions: SubagentPrepareOptions | undefined) => Promise<void>
  } = {},
): Promise<Fixture> {
  const runtime = await createSharedModelRuntime(env.agentDir)
  await runtime.refresh({ allowNetwork: false })
  const parent = parentRecord(runtime, options.parent)
  const prepared: SubagentPrepareOptions[] = []
  const prepareOverrides: (boolean | undefined)[] = []
  let closed = 0

  const makeMcp = (): McpIntegration =>
    ({
      getManager: () => undefined,
      close: async () => {
        closed += 1
      },
    }) as unknown as McpIntegration

  const assembly = {
    prepare: async (
      cwd: string,
      override?: boolean,
      _disposed?: boolean,
      prepareOptions?: SubagentPrepareOptions,
    ) => {
      prepared.push(prepareOptions ?? {})
      prepareOverrides.push(override)
      const trust = await prepareProjectTrust({
        cwd,
        agentDir: env.agentDir,
        override,
        resourceLoaderOptions: {
          ...TEST_RESOURCE_ISOLATION,
          ...(prepareOptions?.appendSystemPrompt?.length
            ? { appendSystemPrompt: [...prepareOptions.appendSystemPrompt] }
            : {}),
          ...(options.extension ? { extensionFactories: [options.extension] } : {}),
        },
      })
      // 模拟装配期信任交互：取消后的后续询问必须由同一 bridge 立即结算。
      await options.prepareInteraction?.(prepareOptions)
      options.onPrepareStarted?.()
      await options.prepareBarrier
      return {
        trust,
        guard: {},
        workspaceBinding: { loadedInstructionPaths: [] },
        trustBinding: { state: () => trust.state },
        mcp: makeMcp(),
      }
    },
    closeBinding: async (mcp: McpIntegration) => {
      await mcp.close()
    },
    transferBinding: () => {},
  }
  const service = new SubagentSessions({
    agentDir: env.agentDir,
    modelRuntime: runtime,
    workspaceStore: workspaceStore(options.scopePatterns),
    assembly,
    events: {
      // 本服务测试只验证“热任务交给 events 投影”；真实投影由宿主编排测试覆盖。
      snapshotOf: testSnapshot,
    },
  })
  services.push(service)
  return {
    service,
    parent,
    runtime,
    prepared,
    prepareOverrides,
    mcpClosed: () => closed,
  }
}

function taskContext(
  parent: ThreadRecord,
  agent: SubagentAgentDefinition,
  task: string,
  extra: { toolCallId?: string; cwd?: string; signal?: AbortSignal } = {},
): SubagentTaskContext {
  return {
    parent,
    toolCallId: extra.toolCallId ?? 'call-parent',
    agent,
    task,
    cwd: extra.cwd ?? env.workspace,
    ...(extra.signal ? { signal: extra.signal } : {}),
  } as SubagentTaskContext
}

async function runTask(
  service: SubagentSessions,
  context: SubagentTaskContext,
  summary: HarnessSubagentTask,
  signal: AbortSignal = new AbortController().signal,
): Promise<HarnessSubagentTask> {
  const input: SubagentTaskExecution = {
    ...context,
    summary,
    signal,
  }
  return service.runTask(input)
}

async function waitForTask(
  service: SubagentSessions,
  parentThreadId: string,
  taskId: string,
  predicate: (view: HarnessSubagentTaskView) => boolean,
  timeoutMs = 5_000,
): Promise<HarnessSubagentTaskView> {
  const started = Date.now()
  while (true) {
    const view = await service.getTask(parentThreadId, taskId)
    if (predicate(view)) return view
    if (Date.now() - started > timeoutMs) throw new Error('等待子任务条件超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function messageRoles(snapshot: HarnessThreadSnapshot | undefined): string[] {
  return snapshot?.messages.map((message) => message.role) ?? []
}

describe('SubagentSessions', () => {
  it('等待摘要、子会话持久化与重启后只读快照隔离于普通目录', async () => {
    const f = await fixture({ parent: { mcpManager: fakeMcpManager() } })
    const context = taskContext(f.parent, agentDefinition(), '审查这个模块')
    const summary = f.service.createTask(context)

    expect(summary).toMatchObject({
      parentThreadId: f.parent.threadId,
      agent: 'review',
      task: '审查这个模块',
      status: 'waiting',
    })
    const taskDir = join(env.agentDir, 'huan', 'subagents', f.parent.threadId, summary.taskId)
    expect(existsSync(join(taskDir, 'task.json'))).toBe(true)
    expect(f.prepared).toHaveLength(0)

    const result = await runTask(f.service, context, summary)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('子任务回复')
    expect(existsSync(join(taskDir, 'session.jsonl'))).toBe(true)
    expect(f.prepared[0]?.subagent).toBe(true)
    expect(f.prepared[0]?.appendSystemPrompt).toEqual(['REVIEW BODY'])
    expect(f.prepared[0]?.mcpOverrides).toEqual({
      demo: {
        enabled: false,
        exposure: 'direct',
        toolExposure: { echo: 'hidden' },
      },
    })
    expect(f.mcpClosed()).toBe(1)
    expect(existsSync(env.defaultSessionDir(env.workspace))).toBe(false)

    // 运行结束后 live 状态已释放；新服务只能从 task.json/session.jsonl 冷读。
    const restarted = new SubagentSessions({
      agentDir: env.agentDir,
      modelRuntime: f.runtime,
      workspaceStore: workspaceStore(),
      assembly: {
        prepare: async () => {
          throw new Error('冷读不得装配')
        },
        closeBinding: async () => {},
        transferBinding: () => {},
      },
      events: { snapshotOf: testSnapshot },
    })
    services.push(restarted)
    const view = await restarted.getTask(f.parent.threadId, summary.taskId)
    expect(view.task).toMatchObject({ status: 'completed', output: '子任务回复' })
    expect(view.task.model).toBe(`${TEST_PROVIDER}/${TEST_MODEL_A}`)
    expect(view.requests).toEqual([])
    expect(view.snapshot?.metadata.title).toBe('review: 审查这个模块')
    expect(messageRoles(view.snapshot)).toEqual(['user', 'assistant'])
    expect(view.snapshot?.metadata.id).toBe(summary.taskId)
    expect(view.snapshot?.metadata.sessionFile).toBe(join(taskDir, 'session.jsonl'))
    expect(view.snapshot?.metadata.workspacePath).toBe(env.workspace)
    expect(view.snapshot?.readiness).toMatchObject({ state: 'ready' })
  })

  it('等待任务逐项取消只影响目标任务；父 signal 取消同调用全部等待项', async () => {
    const f = await fixture()
    const a = f.service.createTask(taskContext(f.parent, agentDefinition(), 'a'))
    const b = f.service.createTask(taskContext(f.parent, agentDefinition(), 'b'))

    await f.service.cancelTask(f.parent.threadId, a.taskId)
    expect((await f.service.getTask(f.parent.threadId, a.taskId)).task.status).toBe('cancelled')
    expect((await f.service.getTask(f.parent.threadId, b.taskId)).task.status).toBe('waiting')

    const bResult = await runTask(f.service, taskContext(f.parent, agentDefinition(), 'b'), b)
    expect(bResult.status).toBe('completed')
    const aResult = await runTask(f.service, taskContext(f.parent, agentDefinition(), 'a'), a)
    expect(aResult.status).toBe('cancelled')

    const controller = new AbortController()
    const c = f.service.createTask(
      taskContext(f.parent, agentDefinition(), 'c', { signal: controller.signal }),
    )
    const d = f.service.createTask(
      taskContext(f.parent, agentDefinition(), 'd', { signal: controller.signal }),
    )
    controller.abort()
    expect((await f.service.getTask(f.parent.threadId, c.taskId)).task.status).toBe('cancelled')
    expect((await f.service.getTask(f.parent.threadId, d.taskId)).task.status).toBe('cancelled')
    expect(
      await runTask(
        f.service,
        taskContext(f.parent, agentDefinition(), 'c', { signal: controller.signal }),
        c,
        controller.signal,
      ),
    ).toMatchObject({ status: 'cancelled' })
  })

  it('交互请求固定父 toolCallId、标题带 agent，并可应答或随单项取消解除', async () => {
    const editorWrites: string[] = []
    let shutdowns = 0
    const extension: InlineExtension = {
      name: 'subagent-ui-test',
      factory: (pi) => {
        pi.on('session_shutdown', () => {
          shutdowns += 1
        })
        pi.on('before_agent_start', async (_event, ctx) => {
          try {
            ctx.ui.setEditorText('不应写入主输入框')
          } catch (error) {
            editorWrites.push(error instanceof Error ? error.message : String(error))
          }
          await ctx.ui.confirm('确认子任务', '继续执行？')
        })
      },
    }
    const f = await fixture({ extension })
    const context = taskContext(f.parent, agentDefinition(), '需要确认')
    const summary = f.service.createTask(context)
    const pendingRun = runTask(f.service, context, summary)

    const view = await waitForTask(
      f.service,
      f.parent.threadId,
      summary.taskId,
      (current) => current.requests.length > 0,
    )
    const request = view.requests[0]
    expect(view.task.pendingRequestCount).toBe(1)
    expect(request).toMatchObject({
      kind: 'confirm',
      toolCallId: 'call-parent',
      title: '[review: 需要确认] 确认子任务',
    })
    expect(editorWrites[0]).toContain('主会话输入框')

    await f.service.respondTask(f.parent.threadId, summary.taskId, {
      requestId: request?.id ?? '',
      confirmed: true,
    } satisfies HarnessHostUiResponse)
    expect(
      (await f.service.getTask(f.parent.threadId, summary.taskId)).task.pendingRequestCount,
    ).toBeUndefined()
    expect((await pendingRun).status).toBe('completed')
    expect(shutdowns).toBe(1)
    expect(f.mcpClosed()).toBe(1)

    const controller = new AbortController()
    const cancelContext = taskContext(f.parent, agentDefinition(), '等待信号取消', {
      signal: controller.signal,
    })
    const cancelSummary = f.service.createTask(cancelContext)
    const cancelRun = runTask(f.service, cancelContext, cancelSummary, controller.signal)
    await waitForTask(
      f.service,
      f.parent.threadId,
      cancelSummary.taskId,
      (current) => current.requests.length > 0,
    )
    controller.abort()
    expect((await cancelRun).status).toBe('cancelled')
    const cancelled = await f.service.getTask(f.parent.threadId, cancelSummary.taskId)
    expect(cancelled.task.status).toBe('cancelled')
    expect(cancelled.requests).toEqual([])
    expect(f.mcpClosed()).toBe(2)
  })

  it('父项目拒绝信任时，仅用户资源子任务仍可运行并应答请求', async () => {
    const extension: InlineExtension = {
      name: 'subagent-untrusted-test',
      factory: (pi) => {
        pi.on('before_agent_start', async (_event, ctx) => {
          await ctx.ui.confirm('继续执行？', '用户资源子任务')
        })
      },
    }
    const f = await fixture({
      // 父会话已明确拒绝目标项目信任；同 cwd 子任务继承 false 而不是停在未决。
      parent: { trust: 'untrusted' },
      extension,
    })
    const context = taskContext(f.parent, agentDefinition(), '用户资源任务')
    const summary = f.service.createTask(context)
    const pendingRun = runTask(f.service, context, summary)

    const view = await waitForTask(
      f.service,
      f.parent.threadId,
      summary.taskId,
      (current) => current.requests.length > 0,
    )
    // untrusted 只关闭项目资源，不得被当成 needs-trust 拒绝用户资源子任务。
    expect(f.prepareOverrides).toEqual([false])
    expect(view.task.pendingRequestCount).toBe(1)
    const request = view.requests[0]

    await f.service.respondTask(f.parent.threadId, summary.taskId, {
      requestId: request?.id ?? '',
      confirmed: true,
    } satisfies HarnessHostUiResponse)
    expect((await pendingRun).status).toBe('completed')
    expect(
      (await f.service.getTask(f.parent.threadId, summary.taskId)).task.pendingRequestCount,
    ).toBeUndefined()
  })

  it('继承父模型/Thinking；显式模型解析、范围与缺凭据严格失败', async () => {
    const scoped = await fixture({
      parent: { workspaceId: 'workspace-1', thinkingLevel: 'low' },
      scopePatterns: [`${TEST_PROVIDER}/${TEST_MODEL_B}`],
    })
    const inherited = scoped.service.createTask(
      taskContext(scoped.parent, agentDefinition(), '继承父模型'),
    )
    const inheritedResult = await runTask(
      scoped.service,
      taskContext(scoped.parent, agentDefinition(), '继承父模型'),
      inherited,
    )
    expect(inheritedResult).toMatchObject({
      status: 'completed',
      model: `${TEST_PROVIDER}/${TEST_MODEL_A}`,
    })
    const inheritedView = await scoped.service.getTask(scoped.parent.threadId, inherited.taskId)
    expect(inheritedView.snapshot?.metadata.config).toMatchObject({
      provider: TEST_PROVIDER,
      modelId: TEST_MODEL_A,
      thinkingLevel: 'low',
    })

    const explicitContext = taskContext(
      scoped.parent,
      agentDefinition({ model: `${TEST_PROVIDER}/${TEST_MODEL_B}:high` }),
      '显式模型',
    )
    const explicit = scoped.service.createTask(explicitContext)
    const explicitResult = await runTask(scoped.service, explicitContext, explicit)
    expect(explicitResult).toMatchObject({
      status: 'completed',
      model: `${TEST_PROVIDER}/${TEST_MODEL_B}`,
    })
    const explicitView = await scoped.service.getTask(scoped.parent.threadId, explicit.taskId)
    expect(explicitView.snapshot?.metadata.config).toMatchObject({
      provider: TEST_PROVIDER,
      modelId: TEST_MODEL_B,
      thinkingLevel: 'high',
    })

    const outsideContext = taskContext(
      scoped.parent,
      agentDefinition({ model: `${TEST_PROVIDER}/${TEST_MODEL_A}` }),
      '范围外模型',
    )
    const outside = scoped.service.createTask(outsideContext)
    const outsideResult = await runTask(scoped.service, outsideContext, outside)
    expect(outsideResult.status).toBe('failed')
    expect(outsideResult.error).toContain('模型范围')

    const noAuth = await fixture()
    const noAuthContext = taskContext(
      noAuth.parent,
      agentDefinition({ model: `${TEST_UNAUTH_PROVIDER}/${TEST_UNAUTH_MODEL}` }),
      '缺凭据模型',
    )
    const noAuthSummary = noAuth.service.createTask(noAuthContext)
    const noAuthResult = await runTask(noAuth.service, noAuthContext, noAuthSummary)
    expect(noAuthResult.status).toBe('failed')
    expect(noAuthResult.error).toContain('缺少凭据')
    expect(noAuth.mcpClosed()).toBe(1)

    const missingContext = taskContext(
      noAuth.parent,
      agentDefinition({ model: 'missing/model-does-not-exist' }),
      '不存在模型',
    )
    const missing = noAuth.service.createTask(missingContext)
    const missingResult = await runTask(noAuth.service, missingContext, missing)
    expect(missingResult.status).toBe('failed')
    expect(missingResult.error).toContain('无法解析')
  })

  it('createTask 固定父模型、Thinking 与工具选择，等待期间父变化不影响任务', async () => {
    let observedTools: string[] = []
    const extension: InlineExtension = {
      name: 'capture-parent-choice',
      factory: (pi) => {
        pi.on('before_agent_start', () => {
          observedTools = pi.getActiveTools()
        })
      },
    }
    const f = await fixture({ extension })
    const context = taskContext(f.parent, agentDefinition(), '捕获父选择')
    const summary = f.service.createTask(context)

    const mutableSession = f.parent.session as unknown as {
      model: AgentSession['model']
      thinkingLevel: AgentSession['thinkingLevel']
      getActiveToolNames: () => string[]
    }
    mutableSession.model = f.runtime.getModel(TEST_PROVIDER, TEST_MODEL_B)
    mutableSession.thinkingLevel = 'high'
    mutableSession.getActiveToolNames = () => ['bash']

    const result = await runTask(f.service, context, summary)
    expect(result).toMatchObject({
      status: 'completed',
      model: `${TEST_PROVIDER}/${TEST_MODEL_A}`,
    })
    expect(observedTools).toEqual(['read'])
    const view = await f.service.getTask(f.parent.threadId, summary.taskId)
    expect(view.snapshot?.metadata.config).toMatchObject({
      provider: TEST_PROVIDER,
      modelId: TEST_MODEL_A,
      thinkingLevel: 'low',
    })
  })

  it('装配期间取消会立即中止且不创建模型请求，收尾关闭 MCP binding', async () => {
    let releasePrepare: () => void = () => {}
    const prepareBarrier = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    let markStarted: () => void = () => {}
    const prepareStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const f = await fixture({
      prepareBarrier,
      onPrepareStarted: () => markStarted(),
    })
    const controller = new AbortController()
    const context = taskContext(f.parent, agentDefinition(), '装配中取消', {
      signal: controller.signal,
    })
    const summary = f.service.createTask(context)
    const pending = runTask(f.service, context, summary, controller.signal)

    await prepareStarted
    controller.abort()
    releasePrepare()

    expect(await pending).toMatchObject({ status: 'cancelled' })
    expect(f.mcpClosed()).toBe(1)
    expect(fetchStub.calls()).toBe(0)
    const taskDir = join(env.agentDir, 'huan', 'subagents', f.parent.threadId, summary.taskId)
    expect(existsSync(join(taskDir, 'session.jsonl'))).toBe(false)
  })

  it('装配期交互取消解除连续确认，取消后的询问立即返回 false 且不创建会话', async () => {
    let service: SubagentSessions | undefined
    let parentThreadId = ''
    let taskId = ''
    const confirmResults: boolean[] = []
    let pendingAfterSecondConfirm = -1
    const f = await fixture({
      prepareInteraction: async (prepareOptions) => {
        const ui = prepareOptions?.projectTrustContext?.ui
        if (!ui) throw new Error('装配期缺少子任务信任 UI')
        // 第一次询问在装配期挂起，由 cancelTask 中止。
        confirmResults.push(await ui.confirm('装配期确认一', '第一次装配期询问'))
        // 取消已经发生：后续询问必须立即按取消返回，不能重新进入 pending。
        confirmResults.push(await ui.confirm('装配期确认二', '取消后的询问'))
        if (!service) throw new Error('装配期服务尚未就绪')
        pendingAfterSecondConfirm = (await service.getTask(parentThreadId, taskId)).requests.length
      },
    })
    service = f.service
    parentThreadId = f.parent.threadId
    const context = taskContext(f.parent, agentDefinition(), '装配期交互', {
      toolCallId: 'call-assembly',
    })
    const summary = f.service.createTask(context)
    taskId = summary.taskId
    const pending = runTask(f.service, context, summary)

    const view = await waitForTask(
      f.service,
      f.parent.threadId,
      summary.taskId,
      (current) => current.requests.length > 0,
    )
    expect(view.task).toMatchObject({ agent: 'review', pendingRequestCount: 1 })
    expect(view.requests[0]).toMatchObject({
      kind: 'confirm',
      toolCallId: 'call-assembly',
      title: '[review: 装配期交互] 装配期确认一',
    })

    await f.service.cancelTask(f.parent.threadId, summary.taskId)

    expect(await pending).toMatchObject({ status: 'cancelled' })
    // 第一次随取消以 false 结算；第二次在取消后调用也立即返回 false。
    expect(confirmResults).toEqual([false, false])
    expect(pendingAfterSecondConfirm).toBe(0)
    const cancelled = await f.service.getTask(f.parent.threadId, summary.taskId)
    expect(cancelled.task.status).toBe('cancelled')
    expect(cancelled.requests).toEqual([])
    expect(cancelled.task.pendingRequestCount).toBeUndefined()
    expect(fetchStub.calls()).toBe(0)
    const taskDir = join(env.agentDir, 'huan', 'subagents', f.parent.threadId, summary.taskId)
    expect(existsSync(join(taskDir, 'session.jsonl'))).toBe(false)
  })

  it('真实 SDK 请求中断后仍保留已发生的用户消息', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const context = taskContext(f.parent, agentDefinition(), '请求中断', {
      signal: controller.signal,
    })
    const summary = f.service.createTask(context)
    const hold = holdProviderFetch()
    try {
      const pending = runTask(f.service, context, summary, controller.signal)
      await hold.requested
      controller.abort()
      expect(await pending).toMatchObject({ status: 'cancelled' })
    } finally {
      hold.restore()
    }

    expect(f.mcpClosed()).toBe(1)
    const sessionFile = join(
      env.agentDir,
      'huan',
      'subagents',
      f.parent.threadId,
      summary.taskId,
      'session.jsonl',
    )
    const entries = readFileSync(sessionFile, 'utf8')
      .trim()
      .split(String.fromCharCode(10))
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } })
    expect(entries.some((entry) => entry.message?.role === 'user')).toBe(true)
  })

  it('冷读非终态摘要只显示服务已不再持有，不写回恢复状态', async () => {
    const f = await fixture()
    const summary = f.service.createTask(taskContext(f.parent, agentDefinition(), '崩溃前等待'))
    const restarted = new SubagentSessions({
      agentDir: env.agentDir,
      modelRuntime: f.runtime,
      workspaceStore: workspaceStore(),
      assembly: {
        prepare: async () => {
          throw new Error('冷读不得装配')
        },
        closeBinding: async () => {},
        transferBinding: () => {},
      },
      events: { snapshotOf: testSnapshot },
    })
    services.push(restarted)

    const view = await restarted.getTask(f.parent.threadId, summary.taskId)
    expect(view.task.status).toBe('cancelled')
    expect(view.task.error).toContain('任务已结束（服务不再持有）')
    expect(view.snapshot).toBeUndefined()

    const taskFile = join(
      env.agentDir,
      'huan',
      'subagents',
      f.parent.threadId,
      summary.taskId,
      'task.json',
    )
    expect(JSON.parse(readFileSync(taskFile, 'utf8'))).toMatchObject({ status: 'waiting' })
  })

  it('冷读损坏的 session.jsonl 明确抛错，不返回空聊天', async () => {
    const f = await fixture()
    const context = taskContext(f.parent, agentDefinition(), '损坏记录')
    const summary = f.service.createTask(context)
    await runTask(f.service, context, summary)
    const sessionFile = join(
      env.agentDir,
      'huan',
      'subagents',
      f.parent.threadId,
      summary.taskId,
      'session.jsonl',
    )
    writeFileSync(sessionFile, 'not-json\n', 'utf8')
    await expect(f.service.getTask(f.parent.threadId, summary.taskId)).rejects.toThrow()
  })

  it('恢复扫描遇到损坏的任务摘要明确报错，不伪造卡片', async () => {
    const f = await fixture()
    const taskDir = join(env.agentDir, 'huan', 'subagents', f.parent.threadId, 'broken-task')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'task.json'), 'not-json', 'utf8')
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-parent', name: 'subagent', arguments: {} }],
      },
    ] as unknown as HarnessAgentMessage[]

    expect(() => f.service.recoverToolExecutions(f.parent.threadId, messages)).toThrow(
      /子任务摘要损坏/,
    )
  })
})
