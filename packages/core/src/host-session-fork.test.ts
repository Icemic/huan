/**
 * G1.2d 独立分支：真实 SDK + 隔离用户空间 + 确定性合成模型。
 *
 * 覆盖历史用户消息 fork、当前位置 clone、空/首用户前分叉、标签保留、
 * parentSession 血缘、扩展取消、session_start 事件、模型/Thinking 恢复、
 * 父会话独立与结构闸门、目录（默认/平铺）以及失败清理。
 * 不读取个人 Pi 配置，不发出任何非合成 provider 请求。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost, ThreadStructureBusyError } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_BASE_URL,
  TEST_MODEL_B,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

let env: IsolatedPiEnv
let host: HarnessHost
let fetchStub: TestFetchStub | undefined
let savedEnv: Map<string, string | undefined>

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const createHost = (options: { sessionDir?: string } = {}) =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
  })

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

async function waitIdle(threadId: string, minMessages = 1): Promise<void> {
  await waitFor(async () => {
    const snapshot = await host.getThread(threadId)
    return snapshot.metadata.status === 'idle' && snapshot.messages.length >= minMessages
      ? true
      : undefined
  })
}

/** 新建会话并等待首轮合成回复落盘。 */
async function createTurn(content: string): Promise<string> {
  const created = await host.createThread({ initialMessage: { content } })
  const threadId = created.metadata.id
  await waitIdle(threadId, 2)
  return threadId
}

async function addTurn(threadId: string, content: string, minMessages: number): Promise<void> {
  await host.sendMessage(threadId, { content })
  await waitIdle(threadId, minMessages)
}

const roleList = (messages: readonly { role: string }[]) => messages.map((message) => message.role)
const textOf = (value: unknown) => JSON.stringify(value)

/** 合成模型的挂起响应（运行中 busy 场景）。 */
class HoldingModel {
  private previous = globalThis.fetch
  private pending: Array<() => void> = []
  private waiters: Array<() => void> = []

  install(): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(TEST_BASE_URL)) {
        throw new Error(`测试禁止非预期网络请求：${url}`)
      }
      const encoder = new TextEncoder()
      let streamController!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
        },
      })
      const release = () => {
        const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
        streamController.enqueue(
          encoder.encode(
            chunk({
              id: 'chatcmpl-huan-fork',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'huan-test',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: '挂起回复' },
                  finish_reason: null,
                },
              ],
            }) +
              chunk({
                id: 'chatcmpl-huan-fork',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'huan-test',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }) +
              'data: [DONE]\n\n',
          ),
        )
        streamController.close()
      }
      this.pending.push(release)
      for (const wake of this.waiters.splice(0)) wake()
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
  }

  async waitForPending(): Promise<void> {
    while (this.pending.length === 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  release(): void {
    const next = this.pending.shift()
    if (!next) throw new Error('没有挂起的模型请求')
    next()
  }

  restore(): void {
    globalThis.fetch = this.previous
  }
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-fork-test-')
  fetchStub = installTestFetch('合成回复')
  host = await createHost()
})

afterEach(async () => {
  await host.dispose().catch(() => {})
  fetchStub?.restore()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('历史用户消息 fork', () => {
  it('只复制根到所选用户消息之前，返回原文，父会话与文件不变', async () => {
    const parentId = await createTurn('第一问')
    await addTurn(parentId, '第二问', 5)
    const parentFile = (await host.getThread(parentId)).metadata.sessionFile
    if (!parentFile) throw new Error('缺少父会话文件')
    const parentBefore = await readFile(parentFile, 'utf8')

    const tree = await host.getThreadTree(parentId)
    const secondUser = tree.nodes.filter((node) => node.kind === 'user')[1]
    if (!secondUser) throw new Error('缺少第二个用户节点')

    const result = await host.forkThread(parentId, {
      entryId: secondUser.entryId,
      position: 'before',
      expectedRevision: tree.revision,
    })
    expect(result.status).toBe('created')
    expect(result.parentThreadId).toBe(parentId)
    expect(result.threadId).toBeTruthy()
    expect(result.threadId).not.toBe(parentId)
    expect(result.selectedText).toBe('第二问')
    // 子会话上下文只到第一条问答（含启动时注入的 system 消息）。
    expect(roleList(result.snapshot?.messages ?? [])).toEqual(['system', 'user', 'assistant'])
    expect(textOf(result.snapshot?.messages?.[1])).toContain('第一问')
    expect(textOf(result.snapshot?.messages)).not.toContain('第二问')

    // 父会话仍 live：同一 ID、同一落点、历史完整，文件不被改写。
    const parentAfter = await host.getThread(parentId)
    expect(parentAfter.messages).toHaveLength(5)
    expect(parentAfter.metadata.leafId).toBe(tree.leafId)
    expect(await readFile(parentFile, 'utf8')).toBe(parentBefore)

    // 子文件是独立记录，血缘指向父文件。
    const childFile = result.snapshot?.metadata.sessionFile
    if (!childFile) throw new Error('缺少子会话文件')
    expect(childFile).not.toBe(parentFile)
    const childManager = SessionManager.open(childFile)
    expect(childManager.getHeader()?.parentSession).toBe(parentFile)
    expect(childManager.getSessionId()).toBe(result.threadId)
  })

  it('分叉保留标签与 compaction，不复制废弃分支', async () => {
    const parentId = await createTurn('标签第一问')
    await addTurn(parentId, '标签第二问', 5)
    let tree = await host.getThreadTree(parentId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    const secondUser = tree.nodes.filter((node) => node.kind === 'user')[1]
    if (!firstUser || !secondUser) throw new Error('缺少测试节点')

    const labelled = await host.setThreadEntryLabel(parentId, {
      entryId: firstUser.entryId,
      label: '起点',
      expectedRevision: tree.revision,
    })
    expect(labelled.status).toBe('applied')

    // 从第一个助手节点继续发送，形成一条不进入 fork 路径的分支。
    tree = await host.getThreadTree(parentId)
    const firstAssistant = tree.nodes.find((node) => node.kind === 'assistant')
    if (!firstAssistant) throw new Error('缺少助手节点')
    const navigated = await host.navigateThreadTree(parentId, {
      targetId: firstAssistant.entryId,
      expectedRevision: tree.revision,
    })
    expect(navigated.status).toBe('applied')
    await addTurn(parentId, '废弃分支问题', 5)

    tree = await host.getThreadTree(parentId)
    const target = tree.nodes.find(
      (node) => node.kind === 'user' && node.entryId !== firstUser.entryId,
    )
    if (!target) throw new Error('缺少第二问节点')
    const result = await host.forkThread(parentId, {
      entryId: target.entryId,
      position: 'before',
      expectedRevision: tree.revision,
    })
    expect(result.status).toBe('created')
    const childId = result.threadId
    if (!childId) throw new Error('缺少子会话 ID')

    // 标签在子文件重建；废弃分支问题不在子上下文。
    const childTree = await host.getThreadTree(childId)
    expect(childTree.nodes.find((node) => node.entryId === firstUser.entryId)?.label).toBe('起点')
    expect(textOf(result.snapshot?.messages)).toContain('标签第一问')
    expect(textOf(result.snapshot?.messages)).not.toContain('废弃分支问题')
    // 子文件只包含活动路径（含标签重建条目），不是整文件复制。
    const childFile = result.snapshot?.metadata.sessionFile
    if (!childFile) throw new Error('缺少子文件')
    const childEntries = SessionManager.open(childFile).getEntries()
    expect(childEntries.some((entry) => entry.type === 'label')).toBe(true)
    expect(textOf(childEntries)).not.toContain('废弃分支问题')
  }, 30_000)

  it('用户消息位于首条（父节点 null）时 fork 生成带 parentSession 的空子会话', async () => {
    // 手工会话没有启动 system 消息：首条用户消息的 parentId 为 null。
    const manager = SessionManager.create(env.workspace, env.defaultSessionDir(env.workspace))
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '裸首问' }],
      timestamp: Date.now(),
    })
    const parentId = manager.getSessionId()
    const parentFile = manager.getSessionFile()
    if (!parentFile) throw new Error('缺少父文件')
    await host.listThreads({ refresh: true })

    const tree = await host.getThreadTree(parentId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')
    const result = await host.forkThread(parentId, {
      entryId: firstUser.entryId,
      position: 'before',
      expectedRevision: tree.revision,
    })
    expect(result.status).toBe('created')
    expect(result.selectedText).toBe('裸首问')
    expect(result.snapshot?.messages).toEqual([])
    // 空子会话在首条消息前不落盘；宿主记录仍提供 ID 与血缘。
    const emptyChildFile = result.snapshot?.metadata.sessionFile
    if (emptyChildFile) expect(existsSync(emptyChildFile)).toBe(false)
    // 父会话 JSONL 仍原样包含用户消息。
    expect(await readFile(parentFile, 'utf8')).toContain('裸首问')
  })
})

describe('clone（当前位置）', () => {
  it('复制当前完整活动路径；省略 entryId 时使用 leaf', async () => {
    const parentId = await createTurn('克隆第一问')
    await addTurn(parentId, '克隆第二问', 5)
    const parent = await host.getThread(parentId)
    const result = await host.forkThread(parentId, { position: 'at' })
    expect(result.status).toBe('created')
    expect(result.selectedText).toBeUndefined()
    expect(roleList(result.snapshot?.messages ?? [])).toEqual(roleList(parent.messages))
    expect(textOf(result.snapshot?.messages)).toContain('克隆第二问')
  })

  it('空会话 clone 生成空独立子会话；fork before 无节点时明确失败', async () => {
    const created = await host.createThread()
    const parentId = created.metadata.id
    const cloned = await host.forkThread(parentId, { position: 'at' })
    expect(cloned.status).toBe('created')
    expect(cloned.threadId).not.toBe(parentId)
    expect(cloned.snapshot?.messages).toEqual([])

    const invalid = await host.forkThread(parentId, { position: 'before' })
    expect(invalid.status).toBe('failed')
    expect(invalid.message).toContain('用户消息')
  })

  it('切换模型与 Thinking 后 clone，子会话恢复同一配置并可继续发送', async () => {
    const parentId = await createTurn('配置第一问')
    await host.setModel(parentId, { provider: 'huan-test', modelId: TEST_MODEL_B })
    await host.setThinkingLevel(parentId, 'high')

    const result = await host.forkThread(parentId, { position: 'at' })
    expect(result.status).toBe('created')
    expect(result.snapshot?.metadata.config).toMatchObject({
      provider: 'huan-test',
      modelId: TEST_MODEL_B,
      thinkingLevel: 'high',
    })
    const childId = result.threadId
    if (!childId) throw new Error('缺少子会话 ID')
    // 子会话可独立继续运行（使用恢复的模型，不请求非合成 provider）。
    await host.sendMessage(childId, { content: '子会话继续' })
    await waitIdle(childId, 5)
    const child = await host.getThread(childId)
    expect(textOf(child.messages)).toContain('子会话继续')
    expect(child.metadata.config?.modelId).toBe(TEST_MODEL_B)
  })
})

describe('扩展事件、父会话隔离与并发', () => {
  it('session_before_fork 取消时不创建子文件或归属', async () => {
    await mkdir(join(env.workspace, '.pi', 'extensions'), { recursive: true })
    await writeFile(
      join(env.workspace, '.pi', 'extensions', 'cancel-fork.ts'),
      `export default function (pi) {
  pi.on('session_before_fork', () => ({ cancel: true }))
}
`,
    )
    const trusted = await host.decideProjectTrust({ path: env.workspace, trusted: true })
    expect(trusted.status).toBe('ready')
    const parentId = await createTurn('取消分叉第一问')

    const sessionDir = env.defaultSessionDir(env.workspace)
    const before = (await readdir(sessionDir, { withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    ).length
    const result = await host.forkThread(parentId, { position: 'at' })
    expect(result.status).toBe('cancelled')
    expect(result.threadId).toBeUndefined()
    const after = (await readdir(sessionDir, { withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    ).length
    expect(after).toBe(before)
    // 父会话仍可正常使用。
    await addTurn(parentId, '取消后继续', 5)
  })

  it('session_start 带 fork 原因与父文件；父会话保持独立', async () => {
    await mkdir(join(env.workspace, '.pi', 'extensions'), { recursive: true })
    const marker = join(env.root, 'session-start.jsonl')
    await writeFile(
      join(env.workspace, '.pi', 'extensions', 'record-start.ts'),
      `import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('session_start', (event) => {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify(event) + '\\n')
  })
}
`,
    )
    const trusted = await host.decideProjectTrust({ path: env.workspace, trusted: true })
    expect(trusted.status).toBe('ready')
    const parentId = await createTurn('事件第一问')
    const parentFile = (await host.getThread(parentId)).metadata.sessionFile
    if (!parentFile) throw new Error('缺少父文件')

    const result = await host.forkThread(parentId, { position: 'at' })
    expect(result.status).toBe('created')
    const events = (await readFile(marker, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { reason?: string; previousSessionFile?: string })
    expect(events.some((event) => event.reason === 'fork')).toBe(true)
    const forkEvent = events.find((event) => event.reason === 'fork')
    expect(forkEvent?.previousSessionFile).toBe(parentFile)

    // 父会话可继续追加；子会话历史不随父变化。
    await addTurn(parentId, '父会话新问题', 5)
    const childAfter = await host.getThread(result.threadId ?? '')
    expect(textOf(childAfter.messages)).not.toContain('父会话新问题')
  })

  it('源会话运行中返回 busy 且不中止父运行；结构闸门拒绝穿过', async () => {
    const parentId = await createTurn('运行中第一问')
    const holding = new HoldingModel()
    holding.install()
    try {
      await host.sendMessage(parentId, { content: '运行中第二问' })
      await holding.waitForPending()

      // 运行中 fork 返回 busy，且不中止父运行。
      const busy = await host.forkThread(parentId, { position: 'at' })
      expect(busy.status).toBe('busy')

      // 父运行未被中止，可正常完成。
      holding.release()
      await waitIdle(parentId, 5)
      const parent = await host.getThread(parentId)
      expect(textOf(parent.messages)).toContain('运行中第二问')
    } finally {
      holding.restore()
    }
  }, 30_000)

  it('fork 持有结构闸门期间发送被拒绝，完成后父会话可继续', async () => {
    await mkdir(join(env.workspace, '.pi', 'extensions'), { recursive: true })
    const marker = join(env.root, 'slow-fork.started')
    await writeFile(
      join(env.workspace, '.pi', 'extensions', 'slow-fork.ts'),
      `import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('session_before_fork', async () => {
    appendFileSync(${JSON.stringify(marker)}, 'started\\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}
`,
    )
    const trusted = await host.decideProjectTrust({ path: env.workspace, trusted: true })
    expect(trusted.status).toBe('ready')
    const parentId = await createTurn('闸门第一问')

    const forking = host.forkThread(parentId, { position: 'at' })
    // 扩展开始处理即表示结构闸门已占用；此时发送必须被明确拒绝。
    await waitFor(async () => {
      const content = await readFile(marker, 'utf8').catch(() => '')
      return content.includes('started') ? true : undefined
    })
    await expect(host.sendMessage(parentId, { content: '闸门探测' })).rejects.toBeInstanceOf(
      ThreadStructureBusyError,
    )
    const result = await forking
    expect(result.status).toBe('created')
    await addTurn(parentId, '闸门后继续', 5)
  }, 30_000)
})

describe('目录与失败清理', () => {
  it('平铺 sessionDir 覆盖下子文件写入同一平铺目录', async () => {
    await host.dispose()
    const flatDir = join(env.root, 'flat-sessions')
    await mkdir(flatDir, { recursive: true })
    host = await createHost({ sessionDir: flatDir })

    const parentId = await createTurn('平铺第一问')
    const result = await host.forkThread(parentId, { position: 'at' })
    expect(result.status).toBe('created')
    const childFile = result.snapshot?.metadata.sessionFile
    if (!childFile) throw new Error('缺少子文件')
    expect(childFile.startsWith(flatDir)).toBe(true)
  })

  it('归属保存失败时清理新建子文件与记录，不破坏父会话', async () => {
    const parentId = await createTurn('清理第一问')
    const sessionDir = env.defaultSessionDir(env.workspace)
    const filesBefore = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'))

    // 用同名文件阻断 huan 元数据目录，使子会话归属保存失败。
    const stateDir = join(env.agentDir, 'huan')
    await rm(stateDir, { recursive: true, force: true })
    await writeFile(stateDir, 'blocked')

    const result = await host.forkThread(parentId, { position: 'at' })
    expect(result.status).toBe('failed')
    expect(result.threadId).toBeUndefined()
    const filesAfter = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'))
    expect(filesAfter.sort()).toEqual(filesBefore.sort())

    // 父会话仍可读且历史完整。
    const parent = await host.getThread(parentId)
    expect(roleList(parent.messages)).toEqual(['system', 'user', 'assistant'])
  })
})
