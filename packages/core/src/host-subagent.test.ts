/**
 * 宿主级 SDK 子agent 集成测试。
 *
 * 从真实 `createHarnessHost` 的父会话发起子任务，使用隔离 agentDir/workspace、
 * 合成 provider 与确定性 SSE；不读取个人配置、不启动 CLI、不访问平台服务。
 * fetch 只应答合成 provider 端点，并记录请求体用于核对父子上下文隔离。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type {
  HarnessSubagentDetails,
  HarnessSubagentTask,
  HarnessThreadSnapshot,
  HarnessToolExecutionSnapshot,
  HarnessUsage,
} from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import { aggregateSessionStats } from './session-stats.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  TEST_BASE_URL,
  TEST_MODEL_A,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
} from './test-support.js'

/** 与 host.test.ts 相同的继承环境隔离项。 */
const TESTED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const TEST_ORIGIN = new URL(TEST_BASE_URL).origin
const TEST_PATH_PREFIX = `${new URL(TEST_BASE_URL).pathname.replace(/\/$/, '')}/`
const TEST_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

let env: IsolatedPiEnv
let host: HarnessHost | undefined
let fetchStub: ScriptedFetch | undefined
const savedEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  for (const key of TESTED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-host-subagent-')
  await addTestModelCosts()
})

afterEach(async () => {
  const unexpected = fetchStub?.unexpected() ?? []
  try {
    await host?.dispose()
  } finally {
    host = undefined
    fetchStub?.restore()
    fetchStub = undefined
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
    await env.cleanup()
  }
  expect(unexpected).toEqual([])
})

/** 合成模型默认费用为零；加入固定费率，让子任务费用与父工具 usage 可验证。 */
async function addTestModelCosts(): Promise<void> {
  const modelsPath = join(env.agentDir, 'models.json')
  const config = JSON.parse(await readFile(modelsPath, 'utf8')) as {
    providers: Record<string, { models?: Array<{ cost?: unknown }> }>
  }
  for (const provider of Object.values(config.providers)) {
    for (const model of provider.models ?? []) model.cost = { ...TEST_COST }
  }
  await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function createTestHost(): Promise<HarnessHost> {
  return createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
  })
}

async function writeAgent(name: string, body: string): Promise<void> {
  const dir = join(env.agentDir, 'agents')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${name}.md`),
    ['---', `name: ${name}`, 'description: 宿主集成测试子agent', '---', body].join('\n'),
    'utf8',
  )
}

type ScriptUsage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

type RecordedRequest = {
  body: Record<string, unknown>
  text: string
}

type ScriptedFetch = {
  requests: readonly RecordedRequest[]
  unexpected: () => readonly string[]
  restore: () => void
}

/** 本地脚本化 fetch：只应答合成 provider，其他地址不联网并记录。 */
function installScriptedFetch(script: (request: RecordedRequest) => Response): ScriptedFetch {
  const previous = globalThis.fetch
  const requests: RecordedRequest[] = []
  const unexpected: string[] = []
  let restored = false
  globalThis.fetch = (async (input, init) => {
    const url = requestUrl(input)
    let isSyntheticProvider = false
    try {
      const parsed = new URL(url)
      isSyntheticProvider =
        parsed.origin === TEST_ORIGIN && parsed.pathname.startsWith(TEST_PATH_PREFIX)
    } catch {
      // 非法 URL 按非预期请求处理。
    }
    if (!isSyntheticProvider) {
      unexpected.push(url)
      throw new Error(`测试禁止非预期网络请求：${url}`)
    }
    const text = await requestBodyText(init?.body)
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}
    const request = { body, text }
    requests.push(request)
    return script(request)
  }) as typeof fetch
  return {
    requests,
    unexpected: () => [...unexpected],
    restore: () => {
      if (restored) return
      restored = true
      globalThis.fetch = previous
    },
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body']

async function requestBodyText(body: FetchBody | undefined): Promise<string> {
  if (body === null || body === undefined) return ''
  if (typeof body === 'string') return body
  return new Response(body).text()
}

function eventChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(chunks: readonly unknown[]): Response {
  return new Response(`${chunks.map(eventChunk).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function usagePayload(usage: ScriptUsage): Record<string, unknown> {
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  return {
    prompt_tokens: usage.input + cacheRead + cacheWrite,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output + cacheRead + cacheWrite,
    ...(cacheRead > 0 || cacheWrite > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
          },
        }
      : {}),
  }
}

function textResponse(text: string, usage: ScriptUsage): Response {
  return sseResponse([
    {
      id: 'chatcmpl-huan-host-subagent',
      object: 'chat.completion.chunk',
      created: 0,
      model: TEST_MODEL_A,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: text },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-huan-host-subagent',
      object: 'chat.completion.chunk',
      created: 0,
      model: TEST_MODEL_A,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: usagePayload(usage),
    },
  ])
}

function toolCallResponse(
  toolCallId: string,
  args: Record<string, unknown>,
  usage: ScriptUsage,
): Response {
  return sseResponse([
    {
      id: 'chatcmpl-huan-host-subagent',
      object: 'chat.completion.chunk',
      created: 0,
      model: TEST_MODEL_A,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: toolCallId,
                type: 'function',
                function: { name: 'subagent', arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-huan-host-subagent',
      object: 'chat.completion.chunk',
      created: 0,
      model: TEST_MODEL_A,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: usagePayload(usage),
    },
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = messagesOf(body)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return contentText(message.content)
  }
  return ''
}

function hasToolMessage(body: Record<string, unknown>): boolean {
  return messagesOf(body).some(
    (message) => message.role === 'tool' || message.role === 'toolResult',
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string | (() => string),
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(20)
  }
  throw new Error(typeof message === 'function' ? message() : message)
}

async function waitForSnapshot(
  target: HarnessHost,
  threadId: string,
  predicate: (snapshot: HarnessThreadSnapshot) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<HarnessThreadSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await target.getThread(threadId)
    if (predicate(snapshot)) return snapshot
    await delay(20)
  }
  throw new Error(message)
}

function messageTexts(snapshot: HarnessThreadSnapshot): string[] {
  return snapshot.messages.map((message) => {
    if (!isRecord(message)) return ''
    return 'content' in message ? contentText(message.content) : ''
  })
}

type ParentEntry = {
  type?: string
  message?: {
    role?: string
    content?: unknown
    usage?: HarnessUsage
    details?: unknown
    toolName?: string
  }
}

function parseSessionEntries(text: string): ParentEntry[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ParentEntry)
}

function sumTaskUsage(tasks: readonly HarnessSubagentTask[]): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
} {
  return tasks.reduce(
    (total, task) => ({
      input: total.input + task.usage.input,
      output: total.output + task.usage.output,
      cacheRead: total.cacheRead + task.usage.cacheRead,
      cacheWrite: total.cacheWrite + task.usage.cacheWrite,
      cost: total.cost + task.usage.cost,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

type StoredTask = {
  taskId: string
  status: HarnessSubagentTask['status']
  task: string
}

/** 只读任务摘要；轮询期间仅忽略文件尚未创建，其他读取/解析错误直接失败。 */
async function readTaskFiles(parentThreadId: string): Promise<StoredTask[]> {
  const root = join(env.agentDir, 'huan', 'subagents', parentThreadId)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  const tasks: StoredTask[] = []
  for (const entry of entries) {
    let raw: string
    try {
      raw = await readFile(join(root, entry, 'task.json'), 'utf8')
    } catch (error) {
      if (isNotFound(error)) continue
      throw error
    }
    tasks.push(JSON.parse(raw) as StoredTask)
  }
  return tasks
}

async function readApprovalLines(filePath: string): Promise<string[]> {
  try {
    const text = await readFile(filePath, 'utf8')
    return text.split('\n').filter((line) => line.length > 0)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

const ZERO_USAGE: HarnessUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** 构造父会话中的 subagent 工具调用消息。 */
function subagentCallMessage(
  toolCallId: string,
  args: Record<string, unknown>,
): Parameters<SessionManager['appendMessage']>[0] {
  return {
    role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, id: toolCallId, name: 'subagent', arguments: args }],
    api: 'openai-completions',
    provider: TEST_PROVIDER,
    model: TEST_MODEL_A,
    usage: ZERO_USAGE,
    stopReason: 'toolUse' as const,
    timestamp: Date.now(),
  } as Parameters<SessionManager['appendMessage']>[0]
}

/**
 * 用真实 SessionManager 模拟崩溃前已保存的父记录。
 *
 * 旧分支上的 subagent 调用不应恢复；当前分支保留一个缺最终结果的调用和
 * 一个已有最终结果的调用，供冷/热快照和分支过滤共同验证。
 */
function seedInterruptedParent(): { parentId: string; sessionFile: string } {
  const manager = SessionManager.create(env.workspace, env.defaultSessionDir(env.workspace))
  const userId = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '崩溃恢复父会话' }],
    timestamp: 1_760_000_000_000,
  })
  manager.appendMessage(
    subagentCallMessage('call_old_branch', { agent: 'review', task: '旧分支任务' }),
  )
  manager.branch(userId)
  manager.appendMessage(
    subagentCallMessage('call_interrupted', {
      agent: '',
      task: '',
      tasks: [{ agent: 'review', task: '并行任务一' }],
    }),
  )
  manager.appendMessage(
    subagentCallMessage('call_final_result', { agent: 'review', task: '已有最终结果' }),
  )
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call_final_result',
    toolName: 'subagent',
    content: [{ type: 'text', text: 'FINAL_RESULT_TEXT' }],
    isError: false,
    timestamp: 1_760_000_000_003,
  })
  manager.appendMessage(
    subagentCallMessage('call_chain', {
      agent: '',
      task: '',
      chain: [{ agent: 'review', task: '链式任务一' }],
    }),
  )
  const sessionFile = manager.getSessionFile()
  if (!sessionFile) throw new Error('恢复探针父会话未落盘')
  return { parentId: manager.getSessionId(), sessionFile }
}

type RecoveryTaskFixture = {
  taskId: string
  toolCallId: string
  status: HarnessSubagentTask['status']
  task: string
  output?: string
  pendingRequestCount?: number
  runMetrics?: HarnessSubagentTask['runMetrics']
}

/** 写入隔离的 task.json；不创建子会话记录，只验证父工具卡恢复。 */
async function writeRecoveryTask(
  parentThreadId: string,
  fixture: RecoveryTaskFixture,
): Promise<void> {
  const dir = join(env.agentDir, 'huan', 'subagents', parentThreadId, fixture.taskId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'task.json'),
    `${JSON.stringify(
      {
        taskId: fixture.taskId,
        parentThreadId,
        agent: 'review',
        task: fixture.task,
        status: fixture.status,
        usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.02 },
        toolCallId: fixture.toolCallId,
        cwd: env.workspace,
        createdAt: '2026-11-05T00:00:00.000Z',
        ...(fixture.output === undefined ? {} : { output: fixture.output }),
        ...(fixture.pendingRequestCount === undefined
          ? {}
          : { pendingRequestCount: fixture.pendingRequestCount }),
        ...(fixture.runMetrics === undefined ? {} : { runMetrics: fixture.runMetrics }),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function recoveredDetailsOf(execution: HarnessToolExecutionSnapshot): HarnessSubagentDetails {
  if (!isRecord(execution.partialResult) || !isRecord(execution.partialResult.details)) {
    throw new Error('恢复工具执行缺少 details')
  }
  return execution.partialResult.details as unknown as HarnessSubagentDetails
}

describe('宿主级 SDK 子agent', () => {
  it('真实父会话执行 chain，子上下文隔离，父工具 usage 与累计统计只计一次', async () => {
    const parentMarker = 'PARENT_PRIVATE_MARKER_DO_NOT_LEAK'
    const bodyMarker = 'CHILD_BODY_MARKER_ISOLATED_CONTEXT'
    const taskOne = 'CHILD_TASK_ONE'
    const taskTwo = 'CHILD_TASK_TWO'
    const childOneText = 'CHILD_ONE_TEXT'
    const childTwoText = 'CHILD_TWO_TEXT'
    const parentFinalText = 'PARENT_FINAL_TEXT'

    // TEST_RESOURCE_ISOLATION 关闭祖先 AGENTS 发现；以 user agent 正文作为
    // 独立上下文标记，避免读取个人或祖先项目文件。
    await writeAgent('review', `${bodyMarker}\n只在子agent正文中出现的指令。`)

    const childOneUsage = { input: 40, output: 6, cacheRead: 2, cacheWrite: 1 }
    const childTwoUsage = { input: 50, output: 7, cacheRead: 0, cacheWrite: 0 }
    fetchStub = installScriptedFetch((request) => {
      const lastUser = lastUserText(request.body)
      if (lastUser.includes(taskOne)) return textResponse(childOneText, childOneUsage)
      if (lastUser.includes(taskTwo)) return textResponse(childTwoText, childTwoUsage)
      if (lastUser.includes(parentMarker)) {
        if (!hasToolMessage(request.body)) {
          return toolCallResponse(
            'call_subagent_chain',
            {
              agent: '',
              task: '',
              tasks: [],
              chain: [
                { agent: 'review', task: `${taskOne} {previous}` },
                { agent: 'review', task: `${taskTwo} {previous}` },
              ],
            },
            { input: 100, output: 20, cacheRead: 5, cacheWrite: 2 },
          )
        }
        return textResponse(parentFinalText, { input: 120, output: 10, cacheRead: 1 })
      }
      throw new Error(`未预期的合成模型请求：${lastUser}`)
    })

    const target = await createTestHost()
    host = target
    const created = await target.createThread()
    const parentId = created.metadata.id
    await target.sendMessage(parentId, {
      content: `${parentMarker} 请把任务拆成两步交给 review 子agent。`,
    })

    const finalSnapshot = await waitForSnapshot(
      target,
      parentId,
      (snapshot) =>
        snapshot.metadata.status === 'idle' &&
        messageTexts(snapshot).some((text) => text.includes(parentFinalText)),
      '等待父会话 chain 子agent 运行结束超时',
    )
    const sessionFile = finalSnapshot.metadata.sessionFile
    if (!sessionFile) throw new Error('父会话缺少 sessionFile')
    const entries = parseSessionEntries(await readFile(sessionFile, 'utf8'))
    const toolEntry = entries.find(
      (entry) => entry.message?.role === 'toolResult' && entry.message.toolName === 'subagent',
    )
    if (!toolEntry?.message) throw new Error('父会话缺少 subagent 工具结果')
    const toolDetails = toolEntry.message.details as HarnessSubagentDetails
    expect(toolDetails.mode).toBe('chain')
    expect(toolDetails.tasks.map((task) => task.agent)).toEqual(['review', 'review'])
    expect(toolDetails.tasks.map((task) => task.status)).toEqual(['completed', 'completed'])
    expect(toolDetails.tasks.map((task) => task.output)).toEqual([childOneText, childTwoText])
    expect(toolDetails.tasks[1]?.task).toContain(childOneText)
    expect(toolEntry.message.content).toEqual([{ type: 'text', text: childTwoText }])

    const parentRequests = fetchStub.requests.filter((request) =>
      lastUserText(request.body).includes(parentMarker),
    )
    expect(parentRequests.length).toBeGreaterThan(0)
    const firstParent = parentRequests[0]
    if (!firstParent) throw new Error('缺少父模型请求')
    const systemMessages = messagesOf(firstParent.body).filter(
      (message) => message.role === 'system' || message.role === 'developer',
    )
    expect(JSON.stringify(systemMessages)).toContain('review: 宿主集成测试子agent')
    expect(JSON.stringify(systemMessages)).not.toContain(bodyMarker)

    const childRequests = fetchStub.requests.filter((request) => {
      const lastUser = lastUserText(request.body)
      return lastUser.includes(taskOne) || lastUser.includes(taskTwo)
    })
    expect(childRequests).toHaveLength(2)
    const [firstChild, secondChild] = childRequests
    if (!firstChild || !secondChild) throw new Error('缺少子任务模型请求')
    expect(lastUserText(firstChild.body)).toContain(taskOne)
    expect(lastUserText(secondChild.body)).toContain(taskTwo)
    expect(lastUserText(secondChild.body)).toContain(childOneText)
    for (const request of childRequests) {
      // 子会话只收到独立 system + 当前任务，不携带父聊天记录。
      const roles = messagesOf(request.body).map((message) => message.role)
      expect(roles.some((role) => role === 'system' || role === 'developer')).toBe(true)
      expect(roles).toContain('user')
      expect(roles.filter((role) => role === 'assistant' || role === 'tool')).toEqual([])
      expect(request.text).toContain(bodyMarker)
      expect(request.text).not.toContain(parentMarker)
    }

    const toolUsage = toolEntry.message.usage
    if (!toolUsage) throw new Error('父工具结果缺少 usage')
    const childTotals = sumTaskUsage(toolDetails.tasks)
    expect(childTotals.cost).toBeGreaterThan(0)
    expect(toolUsage.input).toBe(childTotals.input)
    expect(toolUsage.output).toBe(childTotals.output)
    expect(toolUsage.cacheRead).toBe(childTotals.cacheRead)
    expect(toolUsage.cacheWrite).toBe(childTotals.cacheWrite)
    expect(toolUsage.totalTokens).toBe(
      childTotals.input + childTotals.output + childTotals.cacheRead + childTotals.cacheWrite,
    )
    expect(toolUsage.cost.total).toBeCloseTo(childTotals.cost, 12)

    const aggregate = aggregateSessionStats(entries)
    const parentAssistantCost = entries
      .filter((entry) => entry.message?.role === 'assistant')
      .reduce((total, entry) => total + (entry.message?.usage?.cost.total ?? 0), 0)
    expect(aggregate.toolResults).toBe(1)
    // 子任务 usage 只随父工具结果计入一次：不是 0，也不是父助手 + 两倍子费用。
    expect(aggregate.cost).toBeCloseTo(parentAssistantCost + childTotals.cost, 10)
    const details = await target.getThreadDetails(parentId)
    expect(details.stats.toolResults).toBe(1)
    expect(details.stats.tokens).toEqual(aggregate.tokens)
    expect(details.stats.cost).toBeCloseTo(aggregate.cost, 10)
  }, 60_000)

  it('父运行取消时 4 个审批阻塞子任务中止、等待项取消且不产生第 5 次模型请求', async () => {
    const parentMarker = 'PARENT_CANCEL_MARKER'
    const childMarker = 'CHILD_BLOCK_MARKER'
    const approvalLog = join(env.workspace, 'child-approvals.log')
    await writeAgent('review', `${childMarker} 子agent正文`)

    const extensionDir = join(env.agentDir, 'extensions')
    await mkdir(extensionDir, { recursive: true })
    await writeFile(
      join(extensionDir, 'hold-child-approval.ts'),
      `
import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType !== 'user' || !event.prompt.includes(${JSON.stringify(childMarker)})) return
    appendFileSync(${JSON.stringify(approvalLog)}, event.prompt + String.fromCharCode(10))
    await ctx.ui.confirm('子任务审批', '测试：等待父运行取消')
  })
}
`,
      'utf8',
    )

    fetchStub = installScriptedFetch((request) => {
      const lastUser = lastUserText(request.body)
      if (!lastUser.includes(parentMarker)) {
        // 子任务若真的发起模型请求，让进度条件显式失败而不是挂起。
        return textResponse('UNEXPECTED_CHILD_MODEL_REQUEST', { input: 1, output: 1 })
      }
      return toolCallResponse(
        'call_subagent_parallel',
        {
          agent: '',
          task: '',
          chain: [],
          tasks: Array.from({ length: 5 }, (_, index) => ({
            agent: 'review',
            task: `${childMarker}_${index}`,
          })),
        },
        { input: 80, output: 16 },
      )
    })

    const target = await createTestHost()
    host = target
    const created = await target.createThread()
    const parentId = created.metadata.id

    // 进度来自父工具 onUpdate 的权威摘要；运行中不读 task.json，避免与原子
    // 写入/rename 竞争，也避免把文件系统时序误判为并发调度结果。
    const progress: HarnessSubagentTask[][] = []
    const unsubscribe = target.subscribe(parentId, (event) => {
      if (event.type !== 'tool_execution_update') return
      if (!isRecord(event.partialResult)) return
      const partial = event.partialResult
      const details = partial.details
      if (!isRecord(details) || details.kind !== 'huan-subagent') return
      progress.push([...(details as unknown as HarnessSubagentDetails).tasks])
    })

    try {
      await target.sendMessage(parentId, {
        content: `${parentMarker} 请并行委派五个会等待审批的子任务。`,
      })

      let runningIds: string[] = []
      let waitingIds: string[] = []
      let latestTasks: readonly HarnessSubagentTask[] = []
      await waitFor(
        async () => {
          latestTasks = progress.at(-1) ?? []
          const running = latestTasks.filter((task) => task.status === 'running')
          const waiting = latestTasks.filter((task) => task.status === 'waiting')
          const approvals = await readApprovalLines(approvalLog)
          if (latestTasks.length !== 5 || running.length !== 4 || waiting.length !== 1) {
            return false
          }
          if (approvals.length < 4) return false
          runningIds = running.map((task) => task.taskId)
          waitingIds = waiting.map((task) => task.taskId)
          return true
        },
        () => {
          const counts = latestTasks.map((task) => task.status).join(',')
          return `等待 4 个子任务进入审批阻塞、1 个保持 waiting 超时（进度：${counts}）`
        },
      )

      expect(runningIds).toHaveLength(4)
      expect(waitingIds).toHaveLength(1)
      await target.cancelRun(parentId)
      await waitForSnapshot(
        target,
        parentId,
        (snapshot) => snapshot.metadata.status === 'idle',
        '等待父运行取消后会话空闲超时',
      )

      // cancelRun 已等待工具调用收尾；此时读取最终摘要不会与写入竞争。
      const finalTasks = await readTaskFiles(parentId)
      expect(finalTasks.map((task) => task.taskId).sort()).toEqual(
        [...runningIds, ...waitingIds].sort(),
      )
      expect(finalTasks).toHaveLength(5)
      expect(finalTasks.every((task) => task.status === 'cancelled')).toBe(true)
      expect(fetchStub.requests).toHaveLength(1)
      expect(lastUserText(fetchStub.requests[0]?.body ?? {})).toContain(parentMarker)
      expect(
        fetchStub.requests.filter((request) => lastUserText(request.body).includes(childMarker)),
      ).toEqual([])

      for (const taskId of [...runningIds, ...waitingIds]) {
        const view = await target.getSubagentTask(parentId, taskId)
        expect(view.task.status).toBe('cancelled')
      }
    } finally {
      unsubscribe()
    }
  }, 60_000)

  it('服务重启后冷/热快照恢复父subagent卡片，完成项保留且孤立任务取消', async () => {
    const { parentId } = seedInterruptedParent()
    await writeRecoveryTask(parentId, {
      taskId: 'task-completed',
      toolCallId: 'call_interrupted',
      status: 'completed',
      task: '已完成任务',
      output: 'COMPLETED_OUTPUT',
      runMetrics: { status: 'completed', outputTokens: 5, durationMs: 900 },
    })
    await writeRecoveryTask(parentId, {
      taskId: 'task-running',
      toolCallId: 'call_interrupted',
      status: 'running',
      task: '运行中任务',
      pendingRequestCount: 2,
      runMetrics: { status: 'running', outputTokens: 8, durationMs: 1_200 },
    })
    await writeRecoveryTask(parentId, {
      taskId: 'task-waiting',
      toolCallId: 'call_interrupted',
      status: 'waiting',
      task: '等待中任务',
      pendingRequestCount: 1,
    })
    await writeRecoveryTask(parentId, {
      taskId: 'task-chain-done',
      toolCallId: 'call_chain',
      status: 'completed',
      task: '链式任务一',
      output: 'CHAIN_OUTPUT',
    })
    await writeRecoveryTask(parentId, {
      taskId: 'task-chain-stopped',
      toolCallId: 'call_chain',
      status: 'cancelled',
      task: '链式任务二',
      output: 'CHAIN_STOPPED_OUTPUT',
    })
    // 旧分支和已有最终结果的调用都留有摘要，但不得被恢复。
    await writeRecoveryTask(parentId, {
      taskId: 'task-old-branch',
      toolCallId: 'call_old_branch',
      status: 'running',
      task: '旧分支任务',
    })
    await writeRecoveryTask(parentId, {
      taskId: 'task-final-result',
      toolCallId: 'call_final_result',
      status: 'completed',
      task: '已有最终结果',
      output: 'RECOVERED_MUST_NOT_APPEAR',
    })

    const target = await createTestHost()
    host = target
    const cold = await target.getThread(parentId)
    const coldExecutions = cold.toolExecutions ?? []
    expect(coldExecutions.map((execution) => execution.toolCallId)).toEqual([
      'call_interrupted',
      'call_chain',
    ])
    const coldExecution = coldExecutions[0]
    if (!coldExecution) throw new Error('冷快照缺少恢复的 subagent 工具执行')
    expect(coldExecution).toMatchObject({ toolName: 'subagent', status: 'error' })
    const coldDetails = recoveredDetailsOf(coldExecution)
    expect(coldDetails.mode).toBe('parallel')
    const coldTasks = new Map(coldDetails.tasks.map((task) => [task.taskId, task]))
    expect(coldTasks.get('task-completed')).toMatchObject({
      status: 'completed',
      output: 'COMPLETED_OUTPUT',
      runMetrics: { status: 'completed', outputTokens: 5 },
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.02 },
    })
    expect(coldTasks.get('task-running')).toMatchObject({
      status: 'cancelled',
      error: '任务已结束（服务不再持有）。',
      runMetrics: { status: 'cancelled', outputTokens: 8 },
    })
    expect(coldTasks.get('task-running')?.pendingRequestCount).toBeUndefined()
    expect(coldTasks.get('task-waiting')).toMatchObject({
      status: 'cancelled',
      error: '任务已结束（服务不再持有）。',
    })
    expect(coldTasks.get('task-waiting')?.pendingRequestCount).toBeUndefined()
    expect(coldTasks.has('task-old-branch')).toBe(false)
    expect(coldTasks.has('task-final-result')).toBe(false)

    const chainExecution = coldExecutions[1]
    if (!chainExecution) throw new Error('冷快照缺少链式恢复项')
    const chainDetails = recoveredDetailsOf(chainExecution)
    expect(chainDetails.mode).toBe('chain')
    const chainTasks = new Map(chainDetails.tasks.map((task) => [task.taskId, task]))
    expect(chainTasks.get('task-chain-done')).toMatchObject({
      status: 'completed',
      output: 'CHAIN_OUTPUT',
    })
    expect(chainTasks.get('task-chain-stopped')).toMatchObject({
      status: 'cancelled',
      output: 'CHAIN_STOPPED_OUTPUT',
    })

    let hot: HarnessThreadSnapshot | undefined
    const unsubscribe = target.subscribe(parentId, (event) => {
      if (event.type === 'snapshot') hot = event.snapshot
    })
    try {
      await waitFor(() => hot !== undefined, '等待热快照超时')
      if (!hot) throw new Error('缺少热快照')
      expect(hot.toolExecutions).toEqual(cold.toolExecutions)
    } finally {
      unsubscribe()
    }

    const runningView = await target.getSubagentTask(parentId, 'task-running')
    expect(runningView.task).toMatchObject({
      status: 'cancelled',
      error: '任务已结束（服务不再持有）。',
      runMetrics: { status: 'cancelled' },
    })
    expect(runningView.task.pendingRequestCount).toBeUndefined()
    expect(runningView.requests).toEqual([])
    expect(runningView.snapshot).toBeUndefined()

    const waitingView = await target.getSubagentTask(parentId, 'task-waiting')
    expect(waitingView.task).toMatchObject({ status: 'cancelled' })
    expect(waitingView.task.pendingRequestCount).toBeUndefined()
    expect(waitingView.requests).toEqual([])

    // 恢复只覆盖视图；崩溃前保存的摘要保持原状。
    const runningFile = join(
      env.agentDir,
      'huan',
      'subagents',
      parentId,
      'task-running',
      'task.json',
    )
    expect(JSON.parse(await readFile(runningFile, 'utf8'))).toMatchObject({
      status: 'running',
      pendingRequestCount: 2,
    })
  }, 30_000)

  it('真实活动 subagent 优先于同一 toolCallId 的恢复摘要', async () => {
    const childMarker = 'CHILD_ACTIVE_RECOVERY_MARKER'
    const approvalLog = join(env.workspace, 'child-active-recovery.log')
    await writeAgent('review', `${childMarker} 子agent正文`)

    const extensionDir = join(env.agentDir, 'extensions')
    await mkdir(extensionDir, { recursive: true })
    await writeFile(
      join(extensionDir, 'hold-active-recovery.ts'),
      `
import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType !== 'user' || !event.prompt.includes(${JSON.stringify(childMarker)})) return
    appendFileSync(${JSON.stringify(approvalLog)}, event.prompt + String.fromCharCode(10))
    await ctx.ui.confirm('子任务审批', '测试：真实活动优先')
  })
}
`,
      'utf8',
    )

    fetchStub = installScriptedFetch((request) => {
      const lastUser = lastUserText(request.body)
      if (lastUser.includes(childMarker)) {
        return textResponse('UNEXPECTED_CHILD_MODEL_REQUEST', { input: 1, output: 1 })
      }
      return toolCallResponse(
        'call_live_override',
        { agent: 'review', task: childMarker },
        { input: 20, output: 4 },
      )
    })

    const target = await createTestHost()
    host = target
    const created = await target.createThread()
    const parentId = created.metadata.id
    await writeRecoveryTask(parentId, {
      taskId: 'stale-running',
      toolCallId: 'call_live_override',
      status: 'running',
      task: 'STALE_RECOVERED_TASK',
      pendingRequestCount: 2,
    })

    await target.sendMessage(parentId, {
      content: 'ACTIVE_PARENT_MARKER 请委派一个等待审批的子任务。',
    })
    const snapshot = await waitForSnapshot(
      target,
      parentId,
      (current) => {
        const execution = (current.toolExecutions ?? []).find(
          (item) => item.toolCallId === 'call_live_override',
        )
        if (!execution) return false
        const details = recoveredDetailsOf(execution)
        return details.tasks.some((task) => task.task.includes(childMarker))
      },
      '等待真实活动子任务快照超时',
    )
    const executions = (snapshot.toolExecutions ?? []).filter(
      (item) => item.toolCallId === 'call_live_override',
    )
    expect(executions).toHaveLength(1)
    expect(executions[0]?.status).toBe('running')
    const details = recoveredDetailsOf(executions[0] as HarnessToolExecutionSnapshot)
    expect(details.tasks.some((task) => task.taskId === 'stale-running')).toBe(false)

    await target.cancelRun(parentId)
    await waitForSnapshot(
      target,
      parentId,
      (current) => current.metadata.status === 'idle',
      '等待活动恢复用例取消后空闲超时',
    )
  }, 60_000)
})
