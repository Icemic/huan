/**
 * G1.3a 运行操作：直接 Shell、上下文压缩与模型范围。
 *
 * 真实 Pi SDK + 隔离临时用户空间 + 可控合成模型；不读取个人 Pi 配置，
 * 不允许任何非合成 provider 的网络请求。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessClientEvent } from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost, ThreadStructureBusyError } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  TEST_MODEL_A,
  TEST_MODEL_B,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
} from './test-support.js'

type PendingModelRequest = {
  body: string
  release: (text: string) => void
}

/**
 * 可控合成模型：请求挂起直到测试释放；可选按 `<conversation>` 识别摘要请求。
 * 所有请求都是本地合成 provider，不访问网络。
 */
class ControlledModel {
  private previous = globalThis.fetch
  private pending: PendingModelRequest[] = []
  private failNextSummary = false
  private waiters: Array<() => void> = []

  install(): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('http://127.0.0.1:9/')) {
        throw new Error(`测试禁止非预期网络请求：${url}`)
      }
      const body = typeof init?.body === 'string' ? init.body : ''
      if (this.failNextSummary && body.includes('<conversation>')) {
        this.failNextSummary = false
        return new Response(JSON.stringify({ error: { message: '合成摘要失败' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      const encoder = new TextEncoder()
      let streamController!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
        },
      })
      const write = (text: string) => {
        try {
          streamController.enqueue(encoder.encode(text))
        } catch {
          // 已中止/关闭时忽略。
        }
      }
      const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
      const request: PendingModelRequest = {
        body,
        release: (text) => {
          const index = this.pending.indexOf(request)
          if (index >= 0) this.pending.splice(index, 1)
          write(
            chunk({
              id: 'chatcmpl-huan-runtime',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'huan-test',
              choices: [
                { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
              ],
            }),
          )
          write(
            chunk({
              id: 'chatcmpl-huan-runtime',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'huan-test',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }),
          )
          write('data: [DONE]\n\n')
          try {
            streamController.close()
          } catch {
            // 已关闭时忽略。
          }
        },
      }
      this.pending.push(request)
      this.wake()
      const signal = init?.signal
      if (signal) {
        const abort = () => {
          const index = this.pending.indexOf(request)
          if (index >= 0) this.pending.splice(index, 1)
          try {
            streamController.error(new Error('aborted'))
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

  async waitForPending(count = 1): Promise<void> {
    while (this.pending.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  release(text = '模型回复'): void {
    const request = this.pending[0]
    if (!request) throw new Error('没有等待释放的模型请求')
    request.release(text)
  }

  lastBody(): string | undefined {
    return this.pending.at(-1)?.body
  }

  failSummary(): void {
    this.failNextSummary = true
  }

  restore(): void {
    globalThis.fetch = this.previous
  }
}

let env: IsolatedPiEnv
let host: HarnessHost
let model: ControlledModel
let savedEnv: Map<string, string | undefined>

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const settingsFile = () => join(env.agentDir, 'settings.json')

const createHost = (options: Partial<Parameters<typeof createHarnessHost>[0]> = {}) =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...options,
  })

async function restartHost(): Promise<void> {
  await host.dispose()
  host = await createHost()
}

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

async function waitIdle(threadId: string): Promise<void> {
  await waitFor(async () => {
    const snapshot = await host.getThread(threadId)
    return snapshot.metadata.status === 'idle' ? true : undefined
  })
}

/** 收集事件并等待断言条件（订阅保持到测试结束）。 */
function collectEvents(threadId: string) {
  const events: HarnessClientEvent[] = []
  const unsubscribe = host.subscribe(
    threadId,
    (event) => {
      events.push(event)
    },
    { includeSnapshot: false },
  )
  return {
    events,
    unsubscribe,
    waitFor: async <E extends HarnessClientEvent>(
      predicate: (event: HarnessClientEvent) => event is E,
      timeoutMs = 15_000,
    ): Promise<E> => waitFor(() => events.find(predicate), timeoutMs),
    waitForAny: async (
      predicate: (event: HarnessClientEvent) => boolean,
      timeoutMs = 15_000,
    ): Promise<HarnessClientEvent> => waitFor(() => events.find(predicate), timeoutMs),
  }
}

const bashEndOf = (event: HarnessClientEvent) => (event.type === 'bash_end' ? event : undefined)

async function createEmptyThread(): Promise<string> {
  return (await host.createThread()).metadata.id
}

async function createTurn(content: string, reply: string): Promise<string> {
  const created = await host.createThread({ initialMessage: { content } })
  const threadId = created.metadata.id
  await model.waitForPending()
  model.release(reply)
  await waitIdle(threadId)
  return threadId
}

async function addTurn(threadId: string, content: string, reply: string): Promise<void> {
  await host.sendMessage(threadId, { content })
  await model.waitForPending()
  model.release(reply)
  await waitIdle(threadId)
}

async function waitBashEvent(
  collector: ReturnType<typeof collectEvents>,
  command: string,
): Promise<NonNullable<ReturnType<typeof bashEndOf>>> {
  return collector.waitFor(
    (event): event is Extract<HarnessClientEvent, { type: 'bash_end' }> =>
      event.type === 'bash_end' && event.run.command === command,
  )
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-runtime-test-')
  // 压缩阈值调小，使 3 轮短会话也能产生可压缩历史（仍使用真实 SDK 的压缩路径）。
  await writeFile(
    settingsFile(),
    `${JSON.stringify(
      {
        defaultProvider: TEST_PROVIDER,
        defaultModel: TEST_MODEL_A,
        compaction: { enabled: true, keepRecentTokens: 40, reserveTokens: 1_000 },
      },
      null,
      2,
    )}\n`,
  )
  model = new ControlledModel()
  model.install()
  host = await createHost()
})

afterEach(async () => {
  await host.dispose().catch(() => {})
  model.restore()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('用户 Shell（! / !!）', () => {
  it('! 实时输出、退出码与历史消息，且输出进入模型上下文', async () => {
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const token = `shell-include-${Date.now().toString(36)}`
    const command = `printf '${token}-a'; sleep 0.2; printf '${token}-b\\n'`

    const started = await host.runThreadBash(threadId, { command })
    expect(started.status).toBe('started')
    if (started.status !== 'started') throw new Error('未启动')
    expect(started.run.output).toBe('')
    expect(started.run.cwd).toBe(env.workspace)

    const end = await waitBashEvent(collector, command)
    expect(end.run.status).toBe('complete')
    expect(end.run.output).toBe(`${token}-a${token}-b\n`)
    expect(end.run.result?.exitCode).toBe(0)
    expect(end.run.result?.cancelled).toBe(false)

    // 增量输出：至少产生过带内容的 delta，而不是直到结束才一次性可见。
    const deltas = collector.events.filter(
      (event) => event.type === 'bash_output' && event.id === started.run.id,
    )
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.some((event) => event.type === 'bash_output' && event.delta.length > 0)).toBe(
      true,
    )

    // 空闲会话完成后消息立即落盘，快照不再保留运行态（不重复展示）。
    const snapshot = await host.getThread(threadId)
    expect(snapshot.bash).toBeUndefined()
    const bashMessages = snapshot.messages.filter((message) => message.role === 'bashExecution')
    expect(bashMessages).toHaveLength(1)
    expect(bashMessages[0]).toMatchObject({
      command,
      exitCode: 0,
      cancelled: false,
      excludeFromContext: false,
    })

    await host.sendMessage(threadId, { content: '上下文包含检查' })
    await model.waitForPending()
    expect(model.lastBody()).toContain(`${token}-a`)
    model.release('ok')
    await waitIdle(threadId)
    collector.unsubscribe()
  })

  it('!! 保留历史但排除模型上下文', async () => {
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const token = `shell-exclude-${Date.now().toString(36)}`
    const command = `printf '${token}\\n'`

    const started = await host.runThreadBash(threadId, { command, excludeFromContext: true })
    expect(started.status).toBe('started')
    await waitBashEvent(collector, command)

    const snapshot = await host.getThread(threadId)
    const bashMessages = snapshot.messages.filter((message) => message.role === 'bashExecution')
    expect(bashMessages).toHaveLength(1)
    expect(bashMessages[0]).toMatchObject({ command, excludeFromContext: true })

    await host.sendMessage(threadId, { content: '上下文排除检查' })
    await model.waitForPending()
    expect(model.lastBody()).not.toContain(token)
    model.release('ok')
    await waitIdle(threadId)
    collector.unsubscribe()
  })

  it('同一会话同时只允许一条 Shell，取消后结果标记为 cancelled', async () => {
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const started = await host.runThreadBash(threadId, { command: 'sleep 5' })
    expect(started.status).toBe('started')
    const second = await host.runThreadBash(threadId, { command: 'echo second' })
    expect(second.status).toBe('busy')

    const snapshot = await host.getThread(threadId)
    expect(snapshot.bash?.status).toBe('running')
    expect(await host.abortThreadBash(threadId)).toEqual({ status: 'requested' })
    const end = await waitBashEvent(collector, 'sleep 5')
    expect(end.run.result?.cancelled).toBe(true)
    expect(end.run.result?.exitCode).toBeUndefined()
    expect(await host.abortThreadBash(threadId)).toEqual({ status: 'idle' })

    const after = await waitFor(async () => {
      const value = await host.getThread(threadId)
      return value.messages.some((message) => message.role === 'bashExecution' && message.cancelled)
        ? value
        : undefined
    })
    expect(after.bash).toBeUndefined()
    collector.unsubscribe()
  })

  it('可与模型运行并存，完成后不重复消息', async () => {
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    await host.sendMessage(threadId, { content: '运行中' })
    await model.waitForPending()

    const started = await host.runThreadBash(threadId, { command: 'echo during-run' })
    expect(started.status).toBe('started')
    await waitBashEvent(collector, 'echo during-run')

    // 运行中 SDK 会缓冲 bash 消息，完成卡保留在快照中（尚未持久化）。
    const during = await host.getThread(threadId)
    expect(during.bash?.status).toBe('complete')
    expect(during.bash?.output).toContain('during-run')

    model.release('模型完成')
    await waitIdle(threadId)
    const settled = await host.getThread(threadId)
    expect(settled.bash).toBeUndefined()
    expect(
      settled.messages.filter(
        (message) => message.role === 'bashExecution' && message.command === 'echo during-run',
      ),
    ).toHaveLength(1)
    collector.unsubscribe()
  })

  it('扩展显式steer进入转向队列，整体取回不重复投递', async () => {
    const extensionFile = join(env.root, 'steer-extension.mjs')
    await writeFile(
      extensionFile,
      `export default function (pi) {
  pi.registerCommand('steer-explicit', {
    handler: async () => pi.sendUserMessage('扩展转向文本', { deliverAs: 'steer' }),
  })
}
`,
    )
    await host.dispose()
    host = await createHost({
      resourceLoaderOptions: {
        ...TEST_RESOURCE_ISOLATION,
        additionalExtensionPaths: [extensionFile],
      },
    })
    const threadId = await createEmptyThread()
    await host.sendMessage(threadId, { content: '保持运行' })
    await model.waitForPending()
    await host.sendMessage(threadId, { content: '/steer-explicit' })
    expect((await host.getThread(threadId)).metadata.queuedMessages).toEqual([
      expect.objectContaining({ mode: 'steer', content: '扩展转向文本' }),
    ])
    expect(await host.clearQueue(threadId)).toEqual({ steering: ['扩展转向文本'], followUp: [] })
    model.release()
    await waitIdle(threadId)
    expect((await host.getThread(threadId)).metadata.queuedMessages ?? []).toEqual([])
  })

  it('结构操作与 Shell 互斥：Shell 运行中导航返回 busy', async () => {
    const threadId = await createTurn('第一问', '第一答')
    const collector = collectEvents(threadId)
    const started = await host.runThreadBash(threadId, { command: 'sleep 5' })
    expect(started.status).toBe('started')

    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')
    const result = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
      stopRunning: true,
    })
    expect(result.status).toBe('busy')
    expect(result.message).toContain('Shell')
    await host.abortThreadBash(threadId)
    await waitBashEvent(collector, 'sleep 5')
    collector.unsubscribe()
  })

  it('宿主销毁会取消并等待 Shell 结束', async () => {
    const threadId = await createEmptyThread()
    const started = await host.runThreadBash(threadId, { command: 'sleep 30' })
    expect(started.status).toBe('started')
    const begin = Date.now()
    await host.dispose()
    // 有上限地取消并等待，不挂死（具体耗时随平台，约束为明显小于 sleep 30）。
    expect(Date.now() - begin).toBeLessThan(10_000)
    await expect(host.getThread(threadId)).rejects.toThrow('disposed')
  })

  it('删除会话会取消并等待 Shell 结束', async () => {
    const threadId = await createEmptyThread()
    const sessionFile = (await host.getThread(threadId)).metadata.sessionFile
    const started = await host.runThreadBash(threadId, { command: 'sleep 30' })
    expect(started.status).toBe('started')
    await host.deleteThread(threadId)
    expect(await host.listThreads()).not.toContainEqual(expect.objectContaining({ id: threadId }))
    if (sessionFile) expect(existsSync(sessionFile)).toBe(false)
  })

  it('扩展 user_bash 等待期间拒绝并发启动', async () => {
    const extensionFile = join(env.root, 'slow-user-bash.mjs')
    await writeFile(
      extensionFile,
      `export default function (pi) {
  pi.on('user_bash', async (event) => {
    if (event.command === 'slow:test') await new Promise((resolve) => setTimeout(resolve, 300))
    return undefined
  })
}
`,
    )
    await host.dispose()
    host = await createHost({
      resourceLoaderOptions: {
        ...TEST_RESOURCE_ISOLATION,
        noExtensions: true,
        additionalExtensionPaths: [extensionFile],
      },
    })
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const first = host.runThreadBash(threadId, { command: 'slow:test' })
    // 扩展事件仍在等待：第二条立即被拒绝，不能并发登记两条 Shell。
    const concurrent = await host.runThreadBash(threadId, { command: 'echo second' })
    expect(concurrent.status).toBe('busy')
    const started = await first
    expect(started.status).toBe('started')
    await waitBashEvent(collector, 'slow:test')
    collector.unsubscribe()
  })

  it('启动钩子等待时取消不再启动本地命令', async () => {
    const extensionFile = join(env.root, 'cancel-bash.mjs')
    const marker = join(env.root, 'cancelled-command')
    await writeFile(
      extensionFile,
      `export default function (pi) {
  pi.on('user_bash', async () => {
    await new Promise((resolve) => setTimeout(resolve, 250))
  })
}
`,
    )
    await host.dispose()
    host = await createHost({
      resourceLoaderOptions: {
        ...TEST_RESOURCE_ISOLATION,
        additionalExtensionPaths: [extensionFile],
      },
    })
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const command = `touch '${marker.replaceAll('\\', '/')}'`
    expect((await host.runThreadBash(threadId, { command })).status).toBe('started')
    expect((await host.getThread(threadId)).bash?.status).toBe('running')
    expect(await host.abortThreadBash(threadId)).toEqual({ status: 'requested' })
    expect((await waitBashEvent(collector, command)).run.result?.cancelled).toBe(true)
    expect(existsSync(marker)).toBe(false)
    collector.unsubscribe()
  })

  it('扩展 user_bash 自定义 operations 必须执行而不回退本地命令', async () => {
    const marker = join(env.root, 'must-not-exist')
    const extensionFile = join(env.root, 'remote-bash.mjs')
    await writeFile(
      extensionFile,
      `export default function (pi) {
  pi.on('user_bash', () => ({ operations: {
    exec: async (_command, _cwd, { onData }) => {
      onData(Buffer.from('remote-only\\n'))
      return { exitCode: 0 }
    },
  }}))
}
`,
    )
    await host.dispose()
    host = await createHost({
      resourceLoaderOptions: {
        ...TEST_RESOURCE_ISOLATION,
        additionalExtensionPaths: [extensionFile],
      },
    })
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const command = `touch '${marker.replaceAll('\\', '/')}'`
    await host.runThreadBash(threadId, { command })
    const end = await waitBashEvent(collector, command)
    expect(end.run.output).toBe('remote-only\n')
    expect(existsSync(marker)).toBe(false)
    collector.unsubscribe()
  })

  it('重复命令的完成卡不可误匹配旧历史', async () => {
    const threadId = await createEmptyThread()
    const first = collectEvents(threadId)
    await host.runThreadBash(threadId, { command: 'echo repeated' })
    await waitBashEvent(first, 'echo repeated')
    first.unsubscribe()
    await host.sendMessage(threadId, { content: '保持模型运行' })
    await model.waitForPending()
    const second = collectEvents(threadId)
    await host.runThreadBash(threadId, { command: 'echo repeated' })
    await waitBashEvent(second, 'echo repeated')
    expect((await host.getThread(threadId)).bash?.status).toBe('complete')
    model.release()
    await waitIdle(threadId)
    expect((await host.getThread(threadId)).bash).toBeUndefined()
    second.unsubscribe()
  })

  it('扩展 user_bash 返回结果时按 recordBashResult 语义入历史，不回退本地执行', async () => {
    const extensionFile = join(env.root, 'user-bash-extension.mjs')
    await writeFile(
      extensionFile,
      `export default function (pi) {
  pi.on('user_bash', (event) => {
    if (event.command !== 'handled:test') return undefined
    return {
      result: {
        output: 'handled-output\\n',
        exitCode: 7,
        cancelled: false,
        truncated: false,
      },
    }
  })
}
`,
    )
    await host.dispose()
    host = await createHost({
      resourceLoaderOptions: {
        ...TEST_RESOURCE_ISOLATION,
        noExtensions: true,
        additionalExtensionPaths: [extensionFile],
      },
    })
    const threadId = await createEmptyThread()
    const collector = collectEvents(threadId)
    const started = await host.runThreadBash(threadId, { command: 'handled:test' })
    expect(started.status).toBe('started')
    const end = await waitBashEvent(collector, 'handled:test')
    expect(end.run.output).toBe('handled-output\n')
    expect(end.run.result?.exitCode).toBe(7)

    const snapshot = await host.getThread(threadId)
    const message = snapshot.messages.find((item) => item.role === 'bashExecution')
    expect(message).toMatchObject({
      command: 'handled:test',
      output: 'handled-output\n',
      exitCode: 7,
    })
    collector.unsubscribe()
  })
})

describe('The user Shell is limited to an existing session', () => {
  it('未知会话不会创建会话或执行命令', async () => {
    await expect(host.runThreadBash('missing-thread', { command: 'echo x' })).rejects.toThrow(
      'Unknown thread',
    )
    expect(await host.listThreads()).toEqual([])
  })
})

describe('上下文压缩', () => {
  /** 三轮长消息，保证有可摘要的历史（keepRecentTokens 已调小）。 */
  async function createCompactableThread(): Promise<string> {
    const threadId = await createTurn('第一问'.repeat(30), '第一答'.repeat(30))
    await addTurn(threadId, '第二问'.repeat(30), '第二答'.repeat(30))
    await addTurn(threadId, '第三问'.repeat(30), '第三答'.repeat(30))
    return threadId
  }

  it('手动压缩成功：写入摘要、原始 JSONL 保留、运行态复位', async () => {
    const threadId = await createCompactableThread()
    const sessionFile = (await host.getThread(threadId)).metadata.sessionFile
    if (!sessionFile) throw new Error('缺少会话文件')
    const before = await readFile(sessionFile, 'utf8')
    const collector = collectEvents(threadId)

    const pending = host.compactThread(threadId, { customInstructions: '压缩测试' })
    await model.waitForPending()
    expect(model.lastBody()).toContain('<conversation>')
    model.release('合成压缩摘要')
    const outcome = await pending
    expect(outcome.status).toBe('compacted')
    if (outcome.status !== 'compacted') throw new Error('压缩失败')
    expect(outcome.tokensBefore).toBeGreaterThan(0)
    expect(outcome.estimatedTokensAfter).toBeGreaterThanOrEqual(0)

    const snapshot = await host.getThread(threadId)
    expect(snapshot.compaction?.active).toBe(false)
    expect(snapshot.compaction?.error).toBeUndefined()
    expect(snapshot.messages.some((message) => message.role === 'compactionSummary')).toBe(true)
    // 原始历史仍保留在 Pi 文件中（压缩只追加摘要条目）。
    const after = await readFile(sessionFile, 'utf8')
    expect(after.length).toBeGreaterThan(before.length)
    expect(after).toContain('第一问')
    expect(before.split('\n').length).toBeLessThan(after.split('\n').length)

    const endEvent = await collector.waitForAny(
      (event) => event.type === 'compaction_end' && event.reason === 'manual',
    )
    expect(endEvent.type === 'compaction_end' ? endEvent.errorMessage : undefined).toBeUndefined()
    collector.unsubscribe()
  })

  it('压缩失败：保留历史并暴露错误；不写入摘要', async () => {
    const threadId = await createCompactableThread()
    const sessionFile = (await host.getThread(threadId)).metadata.sessionFile
    if (!sessionFile) throw new Error('缺少会话文件')
    const before = await readFile(sessionFile, 'utf8')
    const collector = collectEvents(threadId)

    model.failSummary()
    const outcome = await host.compactThread(threadId)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.message).toContain('Compaction failed')

    const snapshot = await host.getThread(threadId)
    expect(snapshot.compaction?.active).toBe(false)
    expect(snapshot.compaction?.error).toContain('Compaction failed')
    expect(snapshot.messages.some((message) => message.role === 'compactionSummary')).toBe(false)
    expect(await readFile(sessionFile, 'utf8')).toBe(before)
    collector.unsubscribe()
  })

  it('取消压缩：结果为 cancelled，原始树保持不变，取消不算失败', async () => {
    const threadId = await createCompactableThread()
    const collector = collectEvents(threadId)
    const pending = host.compactThread(threadId)
    await model.waitForPending()
    expect(await host.abortThreadCompaction(threadId)).toEqual({ status: 'requested' })
    const outcome = await pending
    expect(outcome.status).toBe('cancelled')
    const snapshot = await host.getThread(threadId)
    expect(snapshot.compaction?.active).toBe(false)
    expect(snapshot.compaction?.error).toBeUndefined()
    expect(snapshot.messages.some((message) => message.role === 'compactionSummary')).toBe(false)
    expect(await host.abortThreadCompaction(threadId)).toEqual({ status: 'idle' })
    collector.unsubscribe()
  })

  it('删除会话会取消进行中的压缩并结束', async () => {
    const threadId = await createCompactableThread()
    const pending = host.compactThread(threadId)
    await model.waitForPending()
    await host.deleteThread(threadId)
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(await host.listThreads()).not.toContainEqual(expect.objectContaining({ id: threadId }))
  })

  it('压缩期间发送与 Shell 明确 busy，不静默投递', async () => {
    const threadId = await createCompactableThread()
    const pending = host.compactThread(threadId)
    await model.waitForPending()
    const snapshot = await host.getThread(threadId)
    expect(snapshot.compaction?.active).toBe(true)
    expect(snapshot.metadata.compactionActive).toBe(true)

    await expect(host.sendMessage(threadId, { content: '压缩中发送' })).rejects.toBeInstanceOf(
      ThreadStructureBusyError,
    )
    expect(await host.runThreadBash(threadId, { command: 'echo x' })).toMatchObject({
      status: 'busy',
    })
    const second = await host.compactThread(threadId)
    expect(second.status).toBe('busy')

    await host.abortThreadCompaction(threadId)
    await pending
  })

  it('自动压缩保存到用户全局设置，并在多会话重启后保持一致', async () => {
    // 空会话在首条消息前没有 JSONL，重启后不可恢复；用有消息的会话验证持久化。
    const first = await createTurn('自动压缩检查', '好的')
    const second = await createEmptyThread()
    const cachedProject = join(env.root, 'cached-project')
    await mkdir(cachedProject)
    expect((await host.getProject({ path: cachedProject })).status).toBe('ready')

    const saved = await host.setAutoCompaction(first, false)
    expect(saved).toMatchObject({ status: 'saved', enabled: false, scope: 'global' })
    const persisted = JSON.parse(await readFile(settingsFile(), 'utf8')) as {
      compaction?: { enabled?: boolean }
    }
    expect(persisted.compaction?.enabled).toBe(false)

    // 其他已打开会话经设置缓存同步后立即读到同一有效值。
    const secondSnapshot = await host.getThread(second)
    expect(secondSnapshot.metadata.autoCompactionEnabled).toBe(false)
    const workspace = await host.createWorkspace({
      name: '缓存项目设置',
      projects: [{ alias: 'cached', path: cachedProject }],
    })
    if (!workspace.ok) throw new Error('创建工作区失败')
    const fromCached = await host.createThread({ workspaceId: workspace.workspace.id })
    expect(fromCached.metadata.autoCompactionEnabled).toBe(false)

    await restartHost()
    const reopened = await host.getThread(first)
    expect(reopened.metadata.autoCompactionEnabled).toBe(false)
    const created = await host.createThread()
    expect(created.metadata.autoCompactionEnabled).toBe(false)

    const reenabled = await host.setAutoCompaction(created.metadata.id, true)
    expect(reenabled).toMatchObject({ status: 'saved', enabled: true })
  })

  it('并发设置写入按宿主串行提交，不误报已保存', async () => {
    const first = await createEmptyThread()
    const second = await createEmptyThread()
    const results = await Promise.all([
      host.setAutoCompaction(first, false),
      host.setAutoCompaction(second, true),
    ])
    expect(results.every((result) => result.status === 'saved')).toBe(true)
    expect((await host.getThread(first)).metadata.autoCompactionEnabled).toBe(true)
    expect((await host.getThread(second)).metadata.autoCompactionEnabled).toBe(true)
    expect(JSON.parse(await readFile(settingsFile(), 'utf8')).compaction.enabled).toBe(true)
  })

  it('自动压缩写盘失败时如实返回 failed 且不伪报成功', async () => {
    const threadId = await createEmptyThread()
    // 把 settings.json 换成目录：写入与校验都会失败（模拟不可写的用户设置）。
    const original = await readFile(settingsFile(), 'utf8')
    await rm(settingsFile())
    await mkdir(settingsFile())
    const result = await host.setAutoCompaction(threadId, true)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.message).toContain('保存失败')
    // 恢复设置文件，后续清理不受影响。
    await rm(settingsFile(), { recursive: true, force: true })
    await writeFile(settingsFile(), original)
  })
})

describe('模型目录、范围与 Thinking', () => {
  const modelKey = (modelId: string) => `${TEST_PROVIDER}/${modelId}`

  it('目录透传 Thinking 能力（含 max）与输入模态', async () => {
    const models = await host.getAvailableModels()
    const a = models.find((item) => item.modelId === TEST_MODEL_A)
    const b = models.find((item) => item.modelId === TEST_MODEL_B)
    expect(a?.availableThinkingLevels).toContain('max')
    expect(a?.input).toEqual(['text', 'image'])
    expect(b?.input).toEqual(['text'])
  })

  it('Thinking max 可设置并持久化到会话记录', async () => {
    const threadId = await createTurn('级别检查', '好的')
    await host.setThinkingLevel(threadId, 'max')
    const snapshot = await host.getThread(threadId)
    expect(snapshot.metadata.config?.thinkingLevel).toBe('max')
  })

  it('会话范围默认只改会话；显式保存才写用户默认并影响新会话', async () => {
    const threadId = await createTurn('范围检查', '好的')
    const initial = await host.getThreadModelScope(threadId)
    expect(initial.patterns).toEqual([])
    expect(initial.models).toEqual([])
    expect(initial.savedPatterns).toBeUndefined()

    const updated = await host.setThreadModelScope(threadId, {
      patterns: [modelKey(TEST_MODEL_B)],
      saveAsDefault: true,
    })
    expect(updated.models.map((item) => item.modelId)).toEqual([TEST_MODEL_B])
    expect(updated.patterns).toEqual([modelKey(TEST_MODEL_B)])
    expect(updated.persistence).toBe('saved')
    expect(updated.savedPatterns).toEqual([modelKey(TEST_MODEL_B)])
    // 范围配置不意外更换当前模型。
    expect((await host.getThread(threadId)).metadata.config?.modelId).toBe(TEST_MODEL_A)

    const persisted = JSON.parse(await readFile(settingsFile(), 'utf8')) as {
      enabledModels?: string[]
      compaction?: { enabled?: boolean }
      defaultProvider?: string
      defaultModel?: string
    }
    expect(persisted.enabledModels).toEqual([modelKey(TEST_MODEL_B)])
    // 保存范围只改 enabledModels，不覆盖其他设置字段。
    expect(persisted.compaction?.enabled).toBe(true)
    expect(persisted.defaultProvider).toBe(TEST_PROVIDER)
    expect(persisted.defaultModel).toBe(TEST_MODEL_A)

    // 新会话读取已保存范围（会话级内存）。
    const next = await createTurn('范围继承检查', '好的')
    const nextScope = await host.getThreadModelScope(next)
    expect(nextScope.patterns).toEqual([modelKey(TEST_MODEL_B)])
    expect(nextScope.models.map((item) => item.modelId)).toEqual([TEST_MODEL_B])

    // 重启后冷打开的会话仍读取同一保存范围。
    await restartHost()
    const reopened = await host.getThreadModelScope(next)
    expect(reopened.patterns).toEqual([modelKey(TEST_MODEL_B)])

    // 清空范围（= 全部）不等于清除用户默认。
    const cleared = await host.setThreadModelScope(next, { patterns: [] })
    expect(cleared.patterns).toEqual([])
    expect(cleared.persistence).toBe('skipped')
    expect(cleared.savedPatterns).toEqual([modelKey(TEST_MODEL_B)])
  })

  it('无匹配范围保持原范围并返回诊断', async () => {
    const threadId = await createEmptyThread()
    const result = await host.setThreadModelScope(threadId, {
      patterns: ['nope/not-a-model'],
    })
    expect(result.models).toEqual([])
    expect(result.diagnostics.some((item) => item.code === 'no-match')).toBe(true)
    expect(result.persistence).toBe('skipped')
    expect(result.message).toContain('没有匹配的模型')
  })

  it('目录刷新不重建会话、不发起模型请求，并支持显式固定目录', async () => {
    const threadId = await createEmptyThread()
    const result = await host.refreshModels({ threadId })
    expect(result.models.some((item) => item.modelId === TEST_MODEL_A)).toBe(true)
    expect(result.failedProviders).toEqual([])
    // 未发起任何模型请求（合成 provider 的请求计数只由受控模型间接体现）。
    expect(model.lastBody()).toBeUndefined()
    const byPath = await host.refreshModels({ workspacePath: env.workspace })
    expect(byPath.models.length).toBeGreaterThan(0)
    await expect(host.refreshModels({})).rejects.toThrow('需要指定会话或绝对起始目录')
    await expect(host.refreshModels({ workspacePath: 'relative/path' })).rejects.toThrow(
      '需要指定会话或绝对起始目录',
    )
  })
})
