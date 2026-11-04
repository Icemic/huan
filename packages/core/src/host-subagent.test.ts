/**
 * 宿主级 SDK 子agent 集成测试。
 *
 * 从真实 `createHarnessHost` 的父会话发起子任务，使用隔离 agentDir/workspace、
 * 合成 provider 与确定性 SSE；不读取个人配置、不启动 CLI、不访问平台服务。
 * fetch 只应答合成 provider 端点，并记录请求体用于核对父子上下文隔离。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  HarnessSubagentDetails,
  HarnessSubagentTask,
  HarnessThreadSnapshot,
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
})
