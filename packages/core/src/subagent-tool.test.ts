import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type {
  HarnessSubagentDetails,
  HarnessSubagentTask,
  HarnessSubagentUsage,
} from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThreadRecord } from './host/shared.js'
import {
  createSubagentToolDefinition,
  createSubagentToolExtension,
  type SubagentProjectConfirmation,
  type SubagentTaskContext,
  type SubagentTaskExecution,
  type SubagentTaskRunner,
  type SubagentToolHost,
  type SubagentToolParams,
  truncateSubagentOutput,
} from './subagent-tool.js'

const roots: string[] = []
let root: string
let agentDir: string
let cwd: string
const parent = { threadId: 'parent-thread' } as ThreadRecord

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'huan-subagent-tool-'))
  roots.push(root)
  agentDir = join(root, 'agent')
  cwd = join(root, 'work')
  await mkdir(cwd, { recursive: true })
  await writeAgent(join(agentDir, 'agents'), 'review.md', {
    name: 'review',
    description: '代码审查',
    model: 'test/model-a',
    tools: ['read', 'grep'],
    body: 'review 正文',
  })
  await writeAgent(join(agentDir, 'agents'), 'explore.md', {
    name: 'explore',
    description: '探索代码',
    tools: ['read'],
    body: 'explore 正文',
  })
})

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.length = 0
})

async function writeAgent(
  dir: string,
  fileName: string,
  definition: {
    name: string
    description: string
    model?: string
    tools?: string[]
    body?: string
  },
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const lines = ['---', `name: ${definition.name}`, `description: ${definition.description}`]
  if (definition.model !== undefined) lines.push(`model: ${definition.model}`)
  if (definition.tools !== undefined) lines.push(`tools: [${definition.tools.join(', ')}]`)
  lines.push('---', definition.body ?? '')
  const filePath = join(dir, fileName)
  await writeFile(filePath, lines.join('\n'), 'utf8')
  return filePath
}

function zeroUsage(): HarnessSubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

type FakeRunner = {
  runner: SubagentTaskRunner
  created: SubagentTaskContext[]
  runs: SubagentTaskExecution[]
}

function fakeRunner(
  handler: (
    input: SubagentTaskExecution,
    index: number,
  ) => HarnessSubagentTask | Promise<HarnessSubagentTask>,
): FakeRunner {
  const created: SubagentTaskContext[] = []
  const runs: SubagentTaskExecution[] = []
  let nextId = 0
  const runner: SubagentTaskRunner = {
    createTask(context) {
      created.push(context)
      nextId += 1
      return {
        taskId: `task-${nextId}`,
        parentThreadId: context.parent?.threadId ?? 'unknown-parent',
        agent: context.agent.name,
        task: context.task,
        status: 'waiting',
        usage: zeroUsage(),
      }
    },
    async runTask(input) {
      runs.push(input)
      return handler(input, runs.length - 1)
    },
  }
  return { runner, created, runs }
}

function completed(
  summary: HarnessSubagentTask,
  output: string,
  usage: HarnessSubagentUsage = zeroUsage(),
  runMetrics?: HarnessSubagentTask['runMetrics'],
): HarnessSubagentTask {
  return { ...summary, status: 'completed', output, usage, ...(runMetrics ? { runMetrics } : {}) }
}

function failed(
  summary: HarnessSubagentTask,
  error: string,
  usage: HarnessSubagentUsage = zeroUsage(),
): HarnessSubagentTask {
  return { ...summary, status: 'failed', error, usage }
}

type HostOptions = {
  agentDir?: string
  getParent?: () => ThreadRecord | undefined
  isSubagentSession?: () => boolean
  confirmProject?: (input: SubagentProjectConfirmation) => Promise<boolean>
}

function makeHost(
  runner: SubagentTaskRunner,
  options: HostOptions = {},
): { host: SubagentToolHost; confirmations: SubagentProjectConfirmation[] } {
  const confirmations: SubagentProjectConfirmation[] = []
  return {
    host: {
      agentDir: options.agentDir ?? agentDir,
      getParent: options.getParent ?? (() => parent),
      ...(options.isSubagentSession ? { isSubagentSession: options.isSubagentSession } : {}),
      runner,
      confirmProject:
        options.confirmProject ??
        (async (input) => {
          confirmations.push(input)
          return true
        }),
    },
    confirmations,
  }
}

async function callTool(
  host: SubagentToolHost,
  params: SubagentToolParams,
  options: { signal?: AbortSignal; cwd?: string } = {},
): Promise<{
  result: AgentToolResult<HarnessSubagentDetails>
  updates: AgentToolResult<HarnessSubagentDetails>[]
}> {
  const definition = createSubagentToolDefinition(host)
  const updates: AgentToolResult<HarnessSubagentDetails>[] = []
  const result = await definition.execute(
    'call-1',
    params,
    options.signal,
    (update) => updates.push(update),
    { cwd: options.cwd ?? cwd } as ExtensionToolContext,
  )
  return { result, updates }
}

function resultText(result: AgentToolResult<HarnessSubagentDetails>): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n')
}

type BeforeAgentStartHandler = (
  event: { systemPrompt: string; [key: string]: unknown },
  ctx: { cwd: string; [key: string]: unknown },
) => { systemPrompt?: string } | undefined

type FakeExtensionApi = {
  handlers: Map<string, BeforeAgentStartHandler>
  tools: string[]
  on(event: string, handler: BeforeAgentStartHandler): () => void
  registerTool(tool: { name: string }): void
}

function fakeExtensionApi(): FakeExtensionApi {
  const handlers = new Map<string, BeforeAgentStartHandler>()
  return {
    handlers,
    tools: [],
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    registerTool(tool) {
      this.tools.push(tool.name)
    },
  }
}

function installSubagentExtension(host: SubagentToolHost): FakeExtensionApi {
  const api = fakeExtensionApi()
  const extension = createSubagentToolExtension(host)
  if (typeof extension === 'function') throw new Error('内置扩展应为对象')
  extension.factory(api as never)
  return api
}

async function promptFromHook(
  api: FakeExtensionApi,
  systemPrompt: string,
  hookCwd = cwd,
): Promise<string | undefined> {
  const handler = api.handlers.get('before_agent_start')
  if (!handler) throw new Error('缺少 before_agent_start 处理器')
  const result = await handler(
    {
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'hello',
      systemPrompt,
      systemPromptOptions: {},
    },
    { cwd: hookCwd },
  )
  return result?.systemPrompt
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('subagent 工具', () => {
  it('single 模式调用注入 runner，进度只带任务摘要，最终输出与 usage 正确', async () => {
    const usage: HarnessSubagentUsage = {
      input: 3,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.004,
    }
    const runMetrics = {
      status: 'completed' as const,
      outputTokens: 7,
      durationMs: 1400,
      firstResponseMs: 220,
    }
    const fake = fakeRunner((input) => {
      input.onProgress?.({ ...input.summary, status: 'running' })
      return completed(input.summary, 'single output', usage, runMetrics)
    })
    const { host } = makeHost(fake.runner)

    const { result, updates } = await callTool(host, {
      agent: 'review',
      task: 'inspect code',
    })

    expect(resultText(result)).toBe('single output')
    expect(result.isError).toBeUndefined()
    expect(result.details).toMatchObject({ kind: 'huan-subagent', mode: 'single' })
    expect(result.details.tasks).toEqual([
      {
        taskId: 'task-1',
        parentThreadId: parent.threadId,
        agent: 'review',
        task: 'inspect code',
        status: 'completed',
        model: undefined,
        output: 'single output',
        runMetrics,
        usage,
      },
    ])
    expect(result.usage).toEqual({
      input: 3,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 13,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 },
    })

    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]?.parent).toBe(parent)
    // createTask 阶段即携带父 signal，服务端可在等待期登记取消。
    expect(fake.created[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(fake.created[0]?.agent).toMatchObject({
      name: 'review',
      description: '代码审查',
      model: 'test/model-a',
      tools: ['read', 'grep'],
      body: 'review 正文',
      source: 'user',
    })
    expect(fake.runs[0]?.summary.taskId).toBe('task-1')

    expect(updates.length).toBeGreaterThan(0)
    for (const update of updates) {
      expect(update.details.mode).toBe('single')
      // 运行中/完成回传都不复制 output，只保留任务摘要。
      expect(update.details.tasks[0]?.output).toBeUndefined()
    }
  })

  it('parallel 8 项最多同时执行 4 项，并保持创建顺序', async () => {
    let active = 0
    let maxActive = 0
    const fake = fakeRunner(async (input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      input.onProgress?.({ ...input.summary, status: 'running' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return completed(input.summary, `out-${input.summary.task}`)
    })
    const { host } = makeHost(fake.runner)
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      agent: 'review',
      task: `t${index}`,
    }))

    const { result } = await callTool(host, { tasks })

    expect(fake.created).toHaveLength(8)
    expect(fake.runs).toHaveLength(8)
    expect(maxActive).toBe(4)
    expect(result.details.mode).toBe('parallel')
    expect(result.details.tasks.map((task) => task.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
      'task-6',
      'task-7',
      'task-8',
    ])
    expect(result.details.tasks.every((task) => task.status === 'completed')).toBe(true)
    expect(resultText(result)).toContain('Parallel: 8/8 succeeded')
    expect(resultText(result)).toContain('out-t7')
    expect(result.isError).toBeUndefined()
  })

  it('父 signal 取消后不再启动等待任务，所有未完成摘要变为 cancelled', async () => {
    let active = 0
    let maxActive = 0
    const started: string[] = []
    const fake = fakeRunner((input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      started.push(input.summary.taskId)
      input.onProgress?.({ ...input.summary, status: 'running' })
      return new Promise<HarnessSubagentTask>((resolve) => {
        const finish = () => {
          active -= 1
          resolve({
            ...input.summary,
            status: 'cancelled',
            error: 'parent cancelled',
          })
        }
        if (input.signal.aborted) finish()
        else input.signal.addEventListener('abort', finish, { once: true })
      })
    })
    const { host } = makeHost(fake.runner)
    const controller = new AbortController()
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      agent: 'review',
      task: `t${index}`,
    }))

    const pending = callTool(host, { tasks }, { signal: controller.signal })
    await waitFor(() => started.length === 4)
    expect(maxActive).toBe(4)
    controller.abort()
    const { result } = await pending

    expect(fake.created).toHaveLength(8)
    expect(fake.created.every((context) => context.signal === controller.signal)).toBe(true)
    expect(fake.runs).toHaveLength(4)
    expect(started).toEqual(['task-1', 'task-2', 'task-3', 'task-4'])
    expect(result.details.tasks).toHaveLength(8)
    expect(result.details.tasks.every((task) => task.status === 'cancelled')).toBe(true)
    expect(result.details.tasks[7]).toMatchObject({
      taskId: 'task-8',
      status: 'cancelled',
      error: '父工具调用已取消，等待任务未启动。',
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('Parallel: 0/8 succeeded')
  })

  it('chain 逐项替换 {previous}，失败后停止后续步骤', async () => {
    const fake = fakeRunner((input, index) => {
      input.onProgress?.({ ...input.summary, status: 'running' })
      const outputs = ['A', 'B', 'C']
      return completed(input.summary, outputs[index] ?? '?')
    })
    const { host } = makeHost(fake.runner)

    const { result } = await callTool(host, {
      chain: [
        { agent: 'review', task: 'one {previous}' },
        { agent: 'review', task: 'two {previous}' },
        { agent: 'review', task: 'three {previous}' },
      ],
    })

    expect(fake.created.map((context) => context.task)).toEqual(['one ', 'two A', 'three B'])
    expect(fake.created.every((context) => context.signal instanceof AbortSignal)).toBe(true)
    expect(resultText(result)).toBe('C')
    expect(result.details).toMatchObject({ mode: 'chain' })
    expect(result.details.tasks.map((task) => task.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ])
    expect(result.isError).toBeUndefined()

    const stopping = fakeRunner((input, index) =>
      index === 0 ? completed(input.summary, 'first') : failed(input.summary, 'boom'),
    )
    const { host: stoppingHost } = makeHost(stopping.runner)
    const { result: stoppedResult } = await callTool(stoppingHost, {
      chain: [
        { agent: 'review', task: 'one' },
        { agent: 'review', task: 'two' },
        { agent: 'review', task: 'three' },
      ],
    })

    expect(stopping.created).toHaveLength(2)
    expect(stopping.runs).toHaveLength(2)
    expect(stoppedResult.isError).toBe(true)
    expect(resultText(stoppedResult)).toContain('Chain stopped at step 2 (review)')
    expect(resultText(stoppedResult)).toContain('boom')

    const largeOutput = '中'.repeat(30_000)
    const large = fakeRunner((input) => completed(input.summary, largeOutput))
    const { host: largeHost } = makeHost(large.runner)
    const { result: largeResult } = await callTool(largeHost, {
      chain: [{ agent: 'review', task: 'large' }],
    })
    expect(resultText(largeResult)).toContain('[Output truncated:')
    expect(resultText(largeResult)).not.toContain(largeOutput)
  })

  it('usage 顶层按任务汇总，不重复计费', async () => {
    const usages: HarnessSubagentUsage[] = [
      { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01 },
      { input: 20, output: 6, cacheRead: 3, cacheWrite: 4, cost: 0.02 },
    ]
    const fake = fakeRunner((input, index) =>
      completed(input.summary, `out-${index}`, usages[index] ?? zeroUsage()),
    )
    const { host } = makeHost(fake.runner)

    const { result } = await callTool(host, {
      tasks: [
        { agent: 'review', task: 'first' },
        { agent: 'explore', task: 'second' },
      ],
    })

    expect(result.usage).toEqual({
      input: 30,
      output: 11,
      cacheRead: 5,
      cacheWrite: 5,
      totalTokens: 51,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    })
  })

  it('项目来源定义在创建任务前请求 confirmProject，拒绝后不执行', async () => {
    await writeAgent(join(cwd, '.pi', 'agents'), 'project-review.md', {
      name: 'project-review',
      description: '项目审查',
      tools: ['read'],
      body: '项目正文',
    })
    const fake = fakeRunner((input) => completed(input.summary, 'should not run'))
    const confirmations: SubagentProjectConfirmation[] = []
    const { host } = makeHost(fake.runner, {
      confirmProject: async (input) => {
        confirmations.push(input)
        // 确认必须发生在任何 createTask 之前。
        expect(fake.created).toHaveLength(0)
        return false
      },
    })

    const { result } = await callTool(host, {
      agent: 'project-review',
      task: 'review project',
      agentScope: 'both',
    })

    expect(confirmations).toHaveLength(1)
    expect(confirmations[0]).toMatchObject({
      parent,
      toolCallId: 'call-1',
      cwd,
      projectDir: join(cwd, '.pi', 'agents'),
      targetCwds: [cwd],
    })
    expect(confirmations[0]?.agents).toMatchObject([
      {
        name: 'project-review',
        source: 'project',
        filePath: join(cwd, '.pi', 'agents', 'project-review.md'),
      },
    ])
    expect(fake.created).toHaveLength(0)
    expect(fake.runs).toHaveLength(0)
    expect(result.details.tasks).toEqual([])
    expect(resultText(result)).toContain('not approved')
    expect(result.isError).toBeUndefined()
  })

  it('真正冲突与 parallel 上限在创建任务前拒绝', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner)

    const multiple = await callTool(host, {
      agent: 'review',
      task: 'single',
      tasks: [{ agent: 'review', task: 'parallel' }],
    })
    expect(multiple.result.isError).toBe(true)
    expect(resultText(multiple.result)).toContain('多个有效模式')

    const tooMany = await callTool(host, {
      tasks: Array.from({ length: 9 }, (_, index) => ({
        agent: 'review',
        task: `t${index}`,
      })),
    })
    expect(tooMany.result.isError).toBe(true)
    expect(resultText(tooMany.result)).toContain('最多 8 个')
    expect(fake.created).toHaveLength(0)
  })

  it('工具说明与参数描述明确三模式互斥、空占位与无 mode 字段', () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner)
    const definition = createSubagentToolDefinition(host)

    expect(definition.description).toContain('mutually exclusive')
    expect(definition.description).toContain('there is no "mode" field')
    expect(definition.description).toContain('single {"agent":"<name>"')
    expect(definition.description).toContain('parallel {"tasks"')
    expect(definition.description).toContain('chain {"chain"')
    expect(definition.description).toContain('Empty arrays or empty strings')

    const guidelines = (definition.promptGuidelines ?? []).join(' ')
    expect(guidelines).toContain('mutually exclusive')
    expect(guidelines).toContain('Do not combine modes or send a mode field')
    expect(guidelines).toContain('empty arrays or empty strings are placeholders')
    expect(guidelines).toContain('single {"agent":"<name>"')
    expect(guidelines).toContain('parallel {"tasks"')
    expect(guidelines).toContain('chain {"chain"')

    const properties = definition.parameters.properties as Record<string, { description?: string }>
    expect(Object.keys(properties)).not.toContain('mode')
    expect(properties.agent?.description).toContain('omit for parallel/chain')
    expect(properties.task?.description).toContain('omit for parallel/chain')
    expect(properties.tasks?.description).toContain('empty array is not a mode')
    expect(properties.chain?.description).toContain('empty array is not a mode')
  })

  it('按有效内容选模式，空占位不冲突', async () => {
    const fake = fakeRunner((input) => completed(input.summary, `out-${input.summary.task}`))
    const { host } = makeHost(fake.runner)

    const single = await callTool(host, {
      agent: 'review',
      task: 'single',
      tasks: [],
      chain: [],
    })
    expect(single.result.details.mode).toBe('single')
    expect(resultText(single.result)).toBe('out-single')
    expect(fake.created.map((context) => context.task)).toEqual(['single'])

    const parallel = await callTool(host, {
      agent: '',
      task: '',
      tasks: [
        { agent: 'review', task: 'p1' },
        { agent: 'explore', task: 'p2' },
      ],
    })
    expect(parallel.result.details.mode).toBe('parallel')
    expect(fake.created.slice(1).map((context) => context.task)).toEqual(['p1', 'p2'])

    const chain = await callTool(host, {
      agent: '',
      task: '',
      chain: [
        { agent: 'review', task: 'c1' },
        { agent: 'review', task: 'c2 {previous}' },
      ],
    })
    expect(chain.result.details.mode).toBe('chain')
    expect(fake.created.slice(3).map((context) => context.task)).toEqual(['c1', 'c2 out-c1'])
  })

  it('多个有效模式仍拒绝，并列出实际字段与三个示例', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner)

    const singleAndParallel = await callTool(host, {
      agent: 'review',
      task: 'single task',
      tasks: [{ agent: 'review', task: 'parallel task' }],
    })
    expect(singleAndParallel.result.isError).toBe(true)
    const singleText = resultText(singleAndParallel.result)
    expect(singleText).toContain('检测到多个有效模式（single、parallel）')
    expect(singleText).toContain('agent="review"')
    expect(singleText).toContain('tasks=1 项')
    // 示例使用发现的第一个 agent（文件名排序为 explore），未发现时才用 <agent>。
    expect(singleText).toContain('single: {"agent":"explore"')
    expect(singleText).toContain('parallel: {"tasks":[{"agent":"explore"')
    expect(singleText).toContain('chain: {"chain":[{"agent":"explore"')
    expect(singleText).not.toContain('<agent>')

    const parallelAndChain = await callTool(host, {
      agent: '',
      task: '',
      tasks: [{ agent: 'review', task: 'parallel task' }],
      chain: [{ agent: 'review', task: 'chain step' }],
    })
    expect(parallelAndChain.result.isError).toBe(true)
    expect(resultText(parallelAndChain.result)).toContain('检测到多个有效模式（parallel、chain）')
    expect(fake.created).toHaveLength(0)
  })

  it('全空参数列出实际字段并给出三个示例', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner)

    const empty = await callTool(host, { agent: '', task: '', tasks: [], chain: [] })
    expect(empty.result.isError).toBe(true)
    const text = resultText(empty.result)
    expect(text).toContain('没有可执行的模式')
    expect(text).toContain('收到字段：agent=""')
    expect(text).toContain('task=""')
    expect(text).toContain('tasks=0 项')
    expect(text).toContain('chain=0 项')
    expect(text).toContain('single: {"agent":"explore"')
    expect(text).toContain('parallel: {"tasks"')
    expect(text).toContain('chain: {"chain"')

    const absent = await callTool(host, {})
    expect(absent.result.isError).toBe(true)
    expect(resultText(absent.result)).toContain('未提供 agent、task、tasks 或 chain')

    const { host: noAgentHost } = makeHost(fake.runner, { agentDir: join(root, 'no-agent') })
    const noAgents = await callTool(noAgentHost, {})
    expect(resultText(noAgents.result)).toContain('"agent":"<agent>"')
    expect(fake.created).toHaveLength(0)
  })

  it('部分 single 且无其他有效模式时准确报缺失字段', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner)

    const missingTask = await callTool(host, { agent: 'review', tasks: [] })
    expect(missingTask.result.isError).toBe(true)
    expect(resultText(missingTask.result)).toContain('single 模式缺少非空 task')
    expect(resultText(missingTask.result)).toContain('agent="review"')

    const missingAgent = await callTool(host, { task: 'inspect', chain: [] })
    expect(missingAgent.result.isError).toBe(true)
    expect(resultText(missingAgent.result)).toContain('single 模式缺少非空 agent')
    expect(resultText(missingAgent.result)).toContain('task="inspect"')

    const emptyAgent = await callTool(host, { agent: '', task: 'inspect' })
    expect(emptyAgent.result.isError).toBe(true)
    expect(resultText(emptyAgent.result)).toContain('single 模式缺少非空 agent')
    expect(fake.created).toHaveLength(0)
  })

  it('before_agent_start 每轮注入用户定义名称与职责，刷新修改且忽略项目定义', async () => {
    await writeAgent(join(cwd, '.pi', 'agents'), 'project-only.md', {
      name: 'project-only',
      description: '项目定义',
      body: '项目正文',
    })
    await writeAgent(join(cwd, '.pi', 'agents'), 'review.md', {
      name: 'review',
      description: '项目审查',
      body: '项目正文',
    })
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner)
    const api = installSubagentExtension(host)

    expect(api.tools).toEqual(['subagent'])
    expect([...api.handlers.keys()]).toEqual(['before_agent_start'])

    const first = await promptFromHook(api, 'BASE')
    expect(first).toContain('BASE')
    expect(first).toContain('- explore: 探索代码')
    expect(first).toContain('- review: 代码审查')
    expect(first).toContain('不要传 mode 字段')
    expect(first).not.toContain('project-only')
    expect(first).not.toContain('项目审查')
    expect(first).not.toContain('review 正文')

    // 下一轮重新读取文件：新增、修改、删除都应立即反映，且不重复累积旧提示。
    await writeAgent(join(agentDir, 'agents'), 'review.md', {
      name: 'review',
      description: '新的审查职责',
      body: '新的正文',
    })
    await writeAgent(join(agentDir, 'agents'), 'docs.md', {
      name: 'docs',
      description: '更新文档',
      body: 'docs 正文',
    })
    await rm(join(agentDir, 'agents', 'explore.md'))

    const second = await promptFromHook(api, 'BASE')
    expect(second).toContain('- review: 新的审查职责')
    expect(second).toContain('- docs: 更新文档')
    expect(second).not.toContain('代码审查')
    expect(second).not.toContain('explore')
    expect(second).not.toContain('新的正文')
    expect(second).not.toContain('docs 正文')
    expect(second?.match(/BASE/g) ?? []).toHaveLength(1)
  })

  it('子会话不注入子agent推荐', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner, { isSubagentSession: () => true })
    const api = installSubagentExtension(host)

    expect(await promptFromHook(api, 'BASE')).toBeUndefined()
  })

  it('无用户定义或目录读取失败时给出简短提示且不阻断主对话', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))

    const emptyAgentDir = join(root, 'empty-agent')
    const { host: emptyHost } = makeHost(fake.runner, { agentDir: emptyAgentDir })
    const emptyApi = installSubagentExtension(emptyHost)
    const emptyPrompt = await promptFromHook(emptyApi, 'BASE')
    expect(emptyPrompt).toContain('BASE')
    expect(emptyPrompt).toContain('没有可用的用户子agent定义')

    // 定义文件缺 description 会让发现过程抛错；钩子只追加简短提示，不把异常抛给主对话。
    const brokenAgentDir = join(root, 'broken-agent')
    await mkdir(join(brokenAgentDir, 'agents'), { recursive: true })
    await writeFile(join(brokenAgentDir, 'agents', 'broken.md'), '---\nname: broken\n---\n', 'utf8')
    const { host: brokenHost } = makeHost(fake.runner, { agentDir: brokenAgentDir })
    const brokenApi = installSubagentExtension(brokenHost)
    const brokenPrompt = await promptFromHook(brokenApi, 'BASE')
    expect(brokenPrompt).toContain('BASE')
    expect(brokenPrompt).toContain('子agent目录当前不可用')
    expect(brokenPrompt).not.toContain('broken.md')
  })

  it('子会话标志或缺失 parent 时直接拒绝嵌套，且扩展名固定为 builtin:subagent', async () => {
    const fake = fakeRunner((input) => completed(input.summary, 'ok'))
    const { host } = makeHost(fake.runner, { isSubagentSession: () => true })
    const extension = createSubagentToolExtension(host)

    expect(extension).toMatchObject({ name: 'subagent', builtin: true })
    if (typeof extension !== 'function') {
      expect(extension.replaceable).toBeUndefined()
    }
    await expect(callTool(host, { agent: 'review', task: 'nested' })).rejects.toThrow(/禁止嵌套/)
    expect(fake.created).toHaveLength(0)

    const { host: missingParentHost } = makeHost(fake.runner, { getParent: () => undefined })
    await expect(
      callTool(missingParentHost, { agent: 'review', task: 'no parent' }),
    ).rejects.toThrow(/缺少父会话记录/)
    expect(fake.created).toHaveLength(0)
  })

  it('50KiB 截断按 UTF-8 字节一次完成并保留完整文本到调用方', () => {
    const text = `${'a'.repeat(10)}\n${'中'.repeat(30_000)}`
    const truncated = truncateSubagentOutput(text, 16)

    expect(
      Buffer.byteLength(truncated.split('\n\n[Output truncated:')[0] ?? '', 'utf8'),
    ).toBeLessThanOrEqual(16)
    expect(truncated).toContain('[Output truncated:')
    expect(text.length).toBeGreaterThan(truncated.length)
  })
})
