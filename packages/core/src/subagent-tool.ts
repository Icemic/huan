/**
 * SDK 子 agent 工具（SDK 版 subagent 编排层）。
 *
 * 本文件只负责定义发现、参数模式、每次调用的调度、进度摘要与父工具结果；
 * 子会话的创建、模型/工具继承、记录持久化、逐任务取消与 Host UI 转发由注入的
 * `SubagentTaskRunner` 负责，避免工具层直接依赖会话装配内部。
 *
 * 工具名固定为 `subagent`，作为 `builtin:subagent` 加载；刻意不设置
 * `replaceable: true`：外部同名扩展不能替换该实现，冲突由宿主装配层处理。
 */
import { resolve } from 'node:path'
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  InlineExtension,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessSubagentDetails,
  HarnessSubagentTask,
  HarnessSubagentTaskStatus,
} from '@huan/protocol'
import { type Static, Type } from 'typebox'
import type { ThreadRecord } from './host/shared.js'
import {
  discoverSubagentAgents,
  isSubagentAgentScope,
  SUBAGENT_DEFAULT_AGENT_SCOPE,
  type SubagentAgentDefinition,
  type SubagentAgentDiscovery,
  type SubagentAgentScope,
} from './subagent-definitions.js'

/** 每次并行调用最多任务数。 */
export const SUBAGENT_MAX_PARALLEL_TASKS = 8
/** 单次并行调用内同时执行的子会话上限（不同调用之间不共享额度）。 */
export const SUBAGENT_MAX_CONCURRENCY = 4
/** 模型可见的单个子任务输出上限（UTF-8 字节）；完整输出由子会话记录保留。 */
export const SUBAGENT_MODEL_OUTPUT_LIMIT_BYTES = 50 * 1024

/** 与 Pi SDK `Usage` 相同的结构；由协议任务中的简单 usage 汇总得到。 */
export type SubagentUsageTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

/** 子任务创建上下文；一次工具调用内所有任务共享同一 parent、toolCallId 与父 signal。 */
export type SubagentTaskContext = {
  parent: ThreadRecord | undefined
  toolCallId: string
  agent: SubagentAgentDefinition
  task: string
  cwd: string
  /**
   * 父工具取消信号；等待中的任务也携带它，服务端可在 createTask 时登记取消。
   * runTask 的 input 会以必填 signal 再覆盖一次，避免调度层漏传。
   */
  signal?: AbortSignal
  /** 等待任务被逐项取消时也及时更新父工具。 */
  onProgress?: (task: HarnessSubagentTask) => void
}

/** 子任务执行输入；summary 必须先由 `createTask` 分配稳定 taskId。 */
export type SubagentTaskExecution = SubagentTaskContext & {
  summary: HarnessSubagentTask
  signal: AbortSignal
  onProgress?: (task: HarnessSubagentTask) => void
}

/**
 * 子会话执行层。
 *
 * 划分 createTask/runTask 的目的：等待中的任务也立即拥有 taskId，服务端可在
 * `runTask` 之前按 ID 单项取消；工具调度只决定何时调用 runTask。
 */
export interface SubagentTaskRunner {
  /** 同步创建 waiting 摘要并分配 taskId；服务端应持久化该摘要。 */
  createTask(context: SubagentTaskContext): HarnessSubagentTask
  /**
   * 执行一个已创建任务。任务失败应返回 `failed`/`cancelled` 摘要而不是仅抛
   * 普通文本；工具会对抛出异常再包装为 failed。signal 中止时不得再启动子会话。
   * 若任务在 waiting 期间已被服务端按 taskId 取消，必须直接返回 cancelled，
   * 不得创建子会话；父 signal 中止后工具不会再调用未开始的 waiting 任务。
   */
  runTask(input: SubagentTaskExecution): Promise<HarnessSubagentTask>
}

/** 项目来源定义执行前的信任/确认输入。 */
export type SubagentProjectConfirmation = {
  parent: ThreadRecord
  toolCallId: string
  signal: AbortSignal
  /** 发起定义的父会话 cwd。 */
  cwd: string
  /** 定义来源目录；用于在确认 UI 中展示。 */
  projectDir: string | null
  /** 本次实际请求的项目来源定义（已去重）。 */
  agents: readonly SubagentAgentDefinition[]
  /** 本次调用涉及的目标 cwd（去重）；宿主应按目标重新检查资源信任。 */
  targetCwds: readonly string[]
}

/**
 * 工具宿主注入。
 *
 * `getParent` 在每次 execute 开始时读取一次并固定；子会话装配应返回
 * undefined（或提供 `isSubagentSession`），使嵌套调用直接失败。
 */
export type SubagentToolHost = {
  /** 用户定义所在 Pi 配置目录；工具每次调用重新发现。 */
  agentDir: string
  /** 当前父会话记录；子会话没有可发布记录时应返回 undefined。 */
  getParent: () => ThreadRecord | undefined
  /** 显式子会话标志；用于即使误传 parent 也禁止嵌套。 */
  isSubagentSession?: () => boolean
  runner: SubagentTaskRunner
  /** 项目定义信任检查；返回 false 时本次调用不执行任何任务。 */
  confirmProject: (input: SubagentProjectConfirmation) => Promise<boolean>
}

const subagentTaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for this task (optional; relative to the parent session cwd)',
    }),
  ),
})

const agentScopeSchema = Type.Union(
  [Type.Literal('user'), Type.Literal('project'), Type.Literal('both')],
  {
    description:
      'Which agent directories to use. Default: "user". "both" loads project agents and lets them override user agents with the same name.',
    default: SUBAGENT_DEFAULT_AGENT_SCOPE,
  },
)

/** subagent 工具参数；保留旧扩展的字段与 exactly-one-mode 语义。 */
export const subagentToolParameters = Type.Object({
  agent: Type.Optional(Type.String({ description: 'Agent name for single mode' })),
  task: Type.Optional(Type.String({ description: 'Task for single mode' })),
  tasks: Type.Optional(
    Type.Array(subagentTaskItem, {
      description: `Parallel tasks (max ${SUBAGENT_MAX_PARALLEL_TASKS}, max ${SUBAGENT_MAX_CONCURRENCY} running at once)`,
    }),
  ),
  chain: Type.Optional(
    Type.Array(subagentTaskItem, {
      description:
        'Sequential tasks; each task may contain {previous} to receive the previous step output',
    }),
  ),
  agentScope: Type.Optional(agentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: 'Ask before running project-local agents. Default: true.',
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        'Working directory for single mode (optional; relative to the parent session cwd)',
    }),
  ),
})

/** 工具参数的静态类型。 */
export type SubagentToolParams = Static<typeof subagentToolParameters>

type SubagentMode = HarnessSubagentDetails['mode']

type TaskSpec = {
  agent: string
  task: string
  cwd?: string
}

type ResolvedTask = {
  spec: TaskSpec
  definition: SubagentAgentDefinition
  cwd: string
}

type InvocationResolution =
  | { ok: true; mode: SubagentMode; tasks: ResolvedTask[] }
  | { ok: false; mode: SubagentMode; error: string }

const NEVER_ABORTED = new AbortController().signal

/** 创建可注册的 subagent 工具定义；测试与宿主装配共用同一入口。 */
export function createSubagentToolDefinition(
  host: SubagentToolHost,
): ToolDefinition<typeof subagentToolParameters, HarnessSubagentDetails> {
  return {
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate tasks to specialized subagents with isolated context.',
      'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
      `Parallel mode accepts at most ${SUBAGENT_MAX_PARALLEL_TASKS} tasks and runs at most ${SUBAGENT_MAX_CONCURRENCY} at once.`,
      'Agent definitions come from user or project Markdown files; project agents require approval.',
    ].join(' '),
    promptSnippet: 'Delegate work to a subagent with isolated context',
    promptGuidelines: [
      'Use subagent for self-contained delegation; child agents cannot delegate again.',
      'In chain mode, use {previous} in a task to insert the previous step output.',
    ],
    parameters: subagentToolParameters,

    async execute(
      toolCallId: string,
      params: SubagentToolParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<HarnessSubagentDetails> | undefined,
      ctx,
    ): Promise<AgentToolResult<HarnessSubagentDetails>> {
      if (host.isSubagentSession?.()) {
        throw new Error('subagent 不能在子agent会话中运行：本版本禁止嵌套委派。')
      }

      // parent 在一次调用中只读取一次；定义发现、项目确认和全部子任务共用它。
      const parent = host.getParent()
      if (!parent) {
        throw new Error('subagent 缺少父会话记录，不能在子会话或未绑定会话中运行。')
      }

      const scope = normalizeScope(params.agentScope)
      const modeHint = modeHintOf(params)
      if (scope === undefined) {
        return buildResult(modeHint, [], 'agentScope 必须是 user、project 或 both。', true)
      }

      // 每次调用都重新发现；不缓存定义，保证文件修改在下一次调用生效。
      const discovery = discoverSubagentAgents({
        agentDir: host.agentDir,
        cwd: ctx.cwd,
        scope,
      })
      const resolution = resolveInvocation(params, discovery, scope, ctx.cwd)
      if (!resolution.ok) {
        return buildResult(resolution.mode, [], resolution.error, true)
      }

      const executionSignal = signal ?? NEVER_ABORTED
      if (executionSignal.aborted) {
        return buildResult(
          resolution.mode,
          [],
          'Subagent invocation cancelled before starting.',
          true,
        )
      }

      if (params.confirmProjectAgents !== false) {
        const projectAgents = uniqueProjectAgents(resolution.tasks)
        if (projectAgents.length > 0) {
          const approved = await host.confirmProject({
            parent,
            toolCallId,
            signal: executionSignal,
            cwd: ctx.cwd,
            projectDir: discovery.projectDir,
            agents: projectAgents,
            targetCwds: uniqueTargetCwds(resolution.tasks),
          })
          if (!approved) {
            return buildResult(
              resolution.mode,
              [],
              'Canceled: project-local agents were not approved.',
              false,
            )
          }
          if (executionSignal.aborted) {
            return buildResult(
              resolution.mode,
              [],
              'Subagent invocation cancelled before starting.',
              true,
            )
          }
        }
      }

      return resolution.mode === 'single'
        ? executeSingle(
            host.runner,
            parent,
            toolCallId,
            executionSignal,
            resolution.tasks[0],
            onUpdate,
          )
        : resolution.mode === 'parallel'
          ? executeParallel(
              host.runner,
              parent,
              toolCallId,
              executionSignal,
              resolution.tasks,
              onUpdate,
            )
          : executeChain(
              host.runner,
              parent,
              toolCallId,
              executionSignal,
              resolution.tasks,
              onUpdate,
            )
    },
  }
}

/** 创建内置扩展；`builtin: true` 使资源名为 `builtin:subagent`。 */
export function createSubagentToolExtension(host: SubagentToolHost): InlineExtension {
  return {
    name: 'subagent',
    builtin: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(createSubagentToolDefinition(host))
    },
  }
}

function normalizeScope(value: unknown): SubagentAgentScope | undefined {
  if (value === undefined) return SUBAGENT_DEFAULT_AGENT_SCOPE
  return isSubagentAgentScope(value) ? value : undefined
}

function modeHintOf(params: SubagentToolParams): SubagentMode {
  if (params.chain !== undefined) return 'chain'
  if (params.tasks !== undefined) return 'parallel'
  return 'single'
}

/**
 * 校验 exactly-one-mode、任务数量与 agent 定义。
 *
 * 这里不创建任务；项目确认失败或定义不存在时不会留下 waiting 摘要。
 */
function resolveInvocation(
  params: SubagentToolParams,
  discovery: SubagentAgentDiscovery,
  scope: SubagentAgentScope,
  parentCwd: string,
): InvocationResolution {
  const hasSingle = params.agent !== undefined || params.task !== undefined
  const hasParallel = params.tasks !== undefined
  const hasChain = params.chain !== undefined
  const modeCount = Number(hasSingle) + Number(hasParallel) + Number(hasChain)
  const mode = modeHintOf(params)

  if (modeCount !== 1) {
    return {
      ok: false,
      mode,
      error: `请只提供一种模式（single、parallel、chain）。可用子agent：${formatAvailableAgents(discovery, scope)}。`,
    }
  }

  let specs: TaskSpec[]
  if (hasSingle) {
    if (!isNonEmptyString(params.agent) || !isNonEmptyString(params.task)) {
      return {
        ok: false,
        mode,
        error: `single 模式需要非空的 agent 与 task。可用子agent：${formatAvailableAgents(discovery, scope)}。`,
      }
    }
    specs = [
      {
        agent: params.agent.trim(),
        task: params.task,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      },
    ]
  } else if (hasParallel) {
    const tasks = params.tasks ?? []
    if (tasks.length === 0) {
      return { ok: false, mode, error: 'parallel 模式至少需要一个任务。' }
    }
    if (tasks.length > SUBAGENT_MAX_PARALLEL_TASKS) {
      return {
        ok: false,
        mode,
        error: `parallel 任务过多（${tasks.length}），最多 ${SUBAGENT_MAX_PARALLEL_TASKS} 个。`,
      }
    }
    const validated = validateTaskItems(tasks)
    if (typeof validated === 'string') return { ok: false, mode, error: validated }
    specs = validated
  } else {
    const chain = params.chain ?? []
    if (chain.length === 0) {
      return { ok: false, mode, error: 'chain 模式至少需要一个步骤。' }
    }
    const validated = validateTaskItems(chain)
    if (typeof validated === 'string') return { ok: false, mode, error: validated }
    specs = validated
  }

  const byName = new Map(discovery.agents.map((agent) => [agent.name, agent]))
  const tasks: ResolvedTask[] = []
  for (const spec of specs) {
    const definition = byName.get(spec.agent)
    if (!definition) {
      return {
        ok: false,
        mode,
        error: `未知子agent “${spec.agent}”。可用子agent：${formatAvailableAgents(discovery, scope)}。`,
      }
    }
    tasks.push({
      spec,
      definition,
      cwd: resolveTaskCwd(parentCwd, spec.cwd),
    })
  }

  return { ok: true, mode, tasks }
}

function validateTaskItems(
  items: readonly { agent: string; task: string; cwd?: string }[],
): TaskSpec[] | string {
  const specs: TaskSpec[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || !isNonEmptyString(item.agent) || !isNonEmptyString(item.task)) {
      return `第 ${index + 1} 个任务需要非空的 agent 与 task。`
    }
    specs.push({
      agent: item.agent.trim(),
      task: item.task,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    })
  }
  return specs
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function resolveTaskCwd(parentCwd: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') return parentCwd
  return resolve(parentCwd, cwd)
}

function uniqueProjectAgents(tasks: readonly ResolvedTask[]): SubagentAgentDefinition[] {
  const agents = new Map<string, SubagentAgentDefinition>()
  for (const task of tasks) {
    if (task.definition.source === 'project') agents.set(task.definition.name, task.definition)
  }
  return Array.from(agents.values())
}

function uniqueTargetCwds(tasks: readonly ResolvedTask[]): string[] {
  return Array.from(new Set(tasks.map((task) => task.cwd)))
}

function formatAvailableAgents(
  discovery: SubagentAgentDiscovery,
  scope: SubagentAgentScope,
): string {
  if (discovery.agents.length === 0) {
    const dirs =
      scope === 'project'
        ? (discovery.projectDir ?? '未找到项目 .pi/agents')
        : scope === 'user'
          ? discovery.userDir
          : `${discovery.userDir}；${discovery.projectDir ?? '未找到项目 .pi/agents'}`
    return `none（目录：${dirs}）`
  }
  return discovery.agents.map((agent) => `${agent.name} (${agent.source})`).join(', ')
}

/** 单个任务：先 createTask 再 runTask；取消时保留已分配的 waiting 摘要。 */
async function executeSingle(
  runner: SubagentTaskRunner,
  parent: ThreadRecord,
  toolCallId: string,
  signal: AbortSignal,
  task: ResolvedTask | undefined,
  onUpdate: AgentToolUpdateCallback<HarnessSubagentDetails> | undefined,
): Promise<AgentToolResult<HarnessSubagentDetails>> {
  if (!task) return buildResult('single', [], 'single 模式缺少任务。', true)

  const rawTasks: HarnessSubagentTask[] = []
  const context = taskContext(parent, toolCallId, task, signal)
  const summary = runner.createTask(context)
  rawTasks.push(summary)
  emitProgress('single', rawTasks, onUpdate)
  await runAt(runner, rawTasks, 0, context, summary, signal, 'single', onUpdate)

  const result = rawTasks[0]
  if (!result) return buildResult('single', rawTasks, 'Subagent task was not created.', true)
  const failed = result.status !== 'completed'
  const text = failed
    ? `Agent ${result.agent} ${result.status}: ${taskResultText(result)}`
    : taskResultText(result)
  return buildResult('single', rawTasks, text, failed)
}

/** 并行任务：先创建全部 waiting 摘要，再以 4 并发执行；取消后不再启动等待项。 */
async function executeParallel(
  runner: SubagentTaskRunner,
  parent: ThreadRecord,
  toolCallId: string,
  signal: AbortSignal,
  tasks: readonly ResolvedTask[],
  onUpdate: AgentToolUpdateCallback<HarnessSubagentDetails> | undefined,
): Promise<AgentToolResult<HarnessSubagentDetails>> {
  const contexts = tasks.map((task) => taskContext(parent, toolCallId, task, signal))
  const rawTasks: HarnessSubagentTask[] = []
  for (const [index, context] of contexts.entries()) {
    rawTasks.push(
      runner.createTask({
        ...context,
        onProgress: (task) => {
          rawTasks[index] = task
          emitProgress('parallel', rawTasks, onUpdate)
        },
      }),
    )
  }
  emitProgress('parallel', rawTasks, onUpdate)

  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) return
      const index = nextIndex
      nextIndex += 1
      if (index >= contexts.length) return
      if (signal.aborted) return
      const context = contexts[index]
      const summary = rawTasks[index]
      if (!context || !summary) return
      await runAt(runner, rawTasks, index, context, summary, signal, 'parallel', onUpdate)
    }
  }

  const workerCount = Math.min(SUBAGENT_MAX_CONCURRENCY, contexts.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  // 取消后未启动的 waiting 项在这里统一转为 cancelled，避免父工具结果展示为永等待。
  if (signal.aborted) {
    markWaitingCancelled(rawTasks, '父工具调用已取消，等待任务未启动。')
  }
  emitProgress('parallel', rawTasks, onUpdate)

  const succeeded = rawTasks.filter((task) => task.status === 'completed').length
  const sections = rawTasks.map((task) => {
    const status = task.status === 'completed' ? 'completed' : task.status
    return `### [${task.agent}] ${status}\n\n${taskResultText(task)}`
  })
  const text = `Parallel: ${succeeded}/${rawTasks.length} succeeded\n\n${sections.join('\n\n---\n\n')}`
  return buildResult(
    'parallel',
    rawTasks,
    text,
    rawTasks.some((task) => task.status !== 'completed'),
  )
}

/** 链式任务：当前步失败/取消即停止，且取消后不再创建下一步。 */
async function executeChain(
  runner: SubagentTaskRunner,
  parent: ThreadRecord,
  toolCallId: string,
  signal: AbortSignal,
  tasks: readonly ResolvedTask[],
  onUpdate: AgentToolUpdateCallback<HarnessSubagentDetails> | undefined,
): Promise<AgentToolResult<HarnessSubagentDetails>> {
  const rawTasks: HarnessSubagentTask[] = []
  let previousOutput = ''
  let stoppedAt = -1
  let stoppedBeforeStart = false

  for (let index = 0; index < tasks.length; index += 1) {
    if (signal.aborted) {
      stoppedAt = index
      stoppedBeforeStart = true
      break
    }
    const task = tasks[index]
    if (!task) break
    const taskText = task.spec.task.replace(/\{previous\}/g, previousOutput)
    const context: SubagentTaskContext = {
      parent,
      toolCallId,
      agent: task.definition,
      task: taskText,
      cwd: task.cwd,
      signal,
    }
    const summary = runner.createTask(context)
    rawTasks.push(summary)
    emitProgress('chain', rawTasks, onUpdate)
    const result = await runAt(runner, rawTasks, index, context, summary, signal, 'chain', onUpdate)
    if (result.status !== 'completed') {
      stoppedAt = index
      break
    }
    previousOutput = result.output ?? ''
  }

  if (stoppedAt === -1) {
    return buildResult(
      'chain',
      rawTasks,
      truncateSubagentOutput(previousOutput || '(no output)'),
      false,
    )
  }

  const stoppedTask = rawTasks[stoppedAt]
  const step = stoppedAt + 1
  const agent = tasks[stoppedAt]?.definition.name ?? stoppedTask?.agent ?? 'unknown'
  const reason = stoppedBeforeStart
    ? 'invocation cancelled before this step started'
    : stoppedTask
      ? taskResultText(stoppedTask)
      : 'step did not start'
  return buildResult('chain', rawTasks, `Chain stopped at step ${step} (${agent}): ${reason}`, true)
}

/** 创建一个任务并执行；进度只回传任务摘要，不复制子会话消息。 */
async function runAt(
  runner: SubagentTaskRunner,
  rawTasks: HarnessSubagentTask[],
  index: number,
  context: SubagentTaskContext,
  summary: HarnessSubagentTask,
  signal: AbortSignal,
  mode: SubagentMode,
  onUpdate: AgentToolUpdateCallback<HarnessSubagentDetails> | undefined,
): Promise<HarnessSubagentTask> {
  if (signal.aborted) {
    const cancelled = cancelledTask(summary, '父工具调用已取消，任务未启动。')
    rawTasks[index] = cancelled
    emitProgress(mode, rawTasks, onUpdate)
    return cancelled
  }

  try {
    const result = await runner.runTask({
      ...context,
      summary,
      signal,
      onProgress: (task) => {
        rawTasks[index] = task
        emitProgress(mode, rawTasks, onUpdate)
      },
    })
    rawTasks[index] = result
    emitProgress(mode, rawTasks, onUpdate)
    return result
  } catch (error) {
    const failed: HarnessSubagentTask = {
      ...summary,
      status: 'failed',
      error: errorMessage(error),
    }
    rawTasks[index] = failed
    emitProgress(mode, rawTasks, onUpdate)
    return failed
  }
}

function taskContext(
  parent: ThreadRecord,
  toolCallId: string,
  task: ResolvedTask,
  signal: AbortSignal,
): SubagentTaskContext {
  return {
    parent,
    toolCallId,
    agent: task.definition,
    task: task.spec.task,
    cwd: task.cwd,
    signal,
  }
}

function cancelledTask(task: HarnessSubagentTask, reason: string): HarnessSubagentTask {
  return {
    ...task,
    status: 'cancelled',
    error: reason,
  }
}

function markWaitingCancelled(tasks: HarnessSubagentTask[], reason: string): void {
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    if (task?.status === 'waiting') tasks[index] = cancelledTask(task, reason)
  }
}

/** 只更新 status/error，不重建 usage；用于未启动的 waiting 摘要。 */
function emitProgress(
  mode: SubagentMode,
  rawTasks: readonly HarnessSubagentTask[],
  onUpdate: AgentToolUpdateCallback<HarnessSubagentDetails> | undefined,
): void {
  if (!onUpdate) return
  onUpdate({
    content: [{ type: 'text', text: progressText(mode, rawTasks) }],
    // 实时 details 只带任务摘要，不复制子会话消息或完整 output。
    details: {
      kind: 'huan-subagent',
      mode,
      tasks: rawTasks.map((task) => presentTask(task, false)),
    },
  })
}

function progressText(mode: SubagentMode, tasks: readonly HarnessSubagentTask[]): string {
  if (tasks.length === 0) return `Subagent ${mode}: preparing`
  const counts = countStatuses(tasks)
  const parts = [`${counts.completed}/${tasks.length} completed`]
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  return `Subagent ${mode}: ${parts.join(', ')}`
}

function countStatuses(
  tasks: readonly HarnessSubagentTask[],
): Record<HarnessSubagentTaskStatus, number> {
  const counts: Record<HarnessSubagentTaskStatus, number> = {
    waiting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const task of tasks) counts[task.status] += 1
  return counts
}

/** 生成父工具结果：最终 details 才包含截断后的 output；usage 在这里一次性汇总。 */
function buildResult(
  mode: SubagentMode,
  rawTasks: readonly HarnessSubagentTask[],
  text: string,
  isError: boolean,
): AgentToolResult<HarnessSubagentDetails> {
  return {
    content: [{ type: 'text', text }],
    details: {
      kind: 'huan-subagent',
      mode,
      tasks: rawTasks.map((task) => presentTask(task, true)),
    },
    usage: aggregateUsage(rawTasks),
    ...(isError ? { isError: true } : {}),
  }
}

function presentTask(task: HarnessSubagentTask, includeOutput: boolean): HarnessSubagentTask {
  const output =
    includeOutput && task.output !== undefined ? truncateSubagentOutput(task.output) : undefined
  return {
    taskId: task.taskId,
    parentThreadId: task.parentThreadId,
    agent: task.agent,
    task: task.task,
    status: task.status,
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(output === undefined ? {} : { output }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.pendingRequestCount ? { pendingRequestCount: task.pendingRequestCount } : {}),
    ...(task.runMetrics ? { runMetrics: { ...task.runMetrics } } : {}),
    usage: task.usage,
  }
}

function taskResultText(task: HarnessSubagentTask): string {
  const output = task.output?.trim()
  if (task.status === 'completed') {
    return truncateSubagentOutput(output || '(no output)')
  }
  return truncateSubagentOutput(task.error || output || '(no output)')
}

/**
 * 按 UTF-8 字节截断一次，避免按字符递归重编码。
 *
 * Buffer 已包含完整文本，只在末尾回退到 UTF-8 字符边界；完整输出仍由
 * `SubagentTaskRunner` 持久化的子会话记录保留。
 */
export function truncateSubagentOutput(
  text: string,
  limitBytes = SUBAGENT_MODEL_OUTPUT_LIMIT_BYTES,
): string {
  if (text === '' || limitBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limitBytes) return text

  let end = limitBytes
  // 0b10xxxxxx 是 UTF-8 续字节；回退到起始字节，避免产生 U+FFFD。
  while (end > 0) {
    const byte = bytes[end]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    end -= 1
  }
  const kept = bytes.subarray(0, end).toString('utf8')
  const omitted = bytes.length - end
  return `${kept}\n\n[Output truncated: ${omitted} bytes omitted. Full output is kept in the subagent record.]`
}

/** 汇总协议中的简单 usage；cost 只有 total，避免重复计费。 */
function aggregateUsage(tasks: readonly HarnessSubagentTask[]): SubagentUsageTotals {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let costTotal = 0
  for (const task of tasks) {
    input += tokenCount(task.usage.input)
    output += tokenCount(task.usage.output)
    cacheRead += tokenCount(task.usage.cacheRead)
    cacheWrite += tokenCount(task.usage.cacheWrite)
    costTotal += tokenCount(task.usage.cost)
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costTotal,
    },
  }
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
