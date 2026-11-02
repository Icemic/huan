/**
 * G1.2c 会话树：真实 SDK + 隔离用户空间 + 可控合成模型。
 *
 * 覆盖树读取、用户/非用户导航、标签、revision 冲突、运行中停止并取回队列、
 * 摘要等待/取消、sidecar 落点重启恢复与保存失败边界；不读取个人 Pi 配置，
 * 也不允许任何非合成 provider 网络请求。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost, ThreadStructureBusyError } from './host.js'
import { defaultSessionsRoot } from './session-dir.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  TEST_BASE_URL,
  TEST_RESOURCE_ISOLATION,
} from './test-support.js'
import { sessionStoreId, WorkspaceStore } from './workspace-store.js'

type PendingModelRequest = {
  body: string
  release: (text: string) => void
  aborted: Promise<void>
}

/** 合成 provider 的可控响应：每次请求挂起，直到测试显式释放。 */
class ControlledModel {
  private previous = globalThis.fetch
  private pending: PendingModelRequest[] = []
  private requests = 0
  private failNextRequest = false
  private failSummaryRequest = false
  private waiters: Array<() => void> = []

  install(): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(TEST_BASE_URL)) {
        throw new Error(`测试禁止非预期网络请求：${url}`)
      }
      this.requests += 1
      const body = typeof init?.body === 'string' ? init.body : ''
      if (this.failNextRequest || (this.failSummaryRequest && body.includes('<conversation>'))) {
        this.failNextRequest = false
        this.failSummaryRequest = false
        // 400 不触发 SDK 的重试退避；测试只需确定性失败。
        return new Response(JSON.stringify({ error: { message: '合成模型失败' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      const encoder = new TextEncoder()
      let streamController!: ReadableStreamDefaultController<Uint8Array>
      let markAborted: () => void = () => {}
      const aborted = new Promise<void>((resolve) => {
        markAborted = resolve
      })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
        },
        cancel() {
          markAborted()
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
        aborted,
        release: (text) => {
          const index = this.pending.indexOf(request)
          if (index >= 0) this.pending.splice(index, 1)
          write(
            chunk({
              id: 'chatcmpl-huan-tree',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'huan-test',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: text },
                  finish_reason: null,
                },
              ],
            }),
          )
          write(
            chunk({
              id: 'chatcmpl-huan-tree',
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
          markAborted()
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

  count(): number {
    return this.requests
  }

  /** 下一次模型请求返回 HTTP 400（用于运行失败边界）。 */
  failNext(): void {
    this.failNextRequest = true
  }

  /** 仅让下一次分支摘要请求失败，不影响被中止的当前运行。 */
  failSummary(): void {
    this.failSummaryRequest = true
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

const createHost = () =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
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

/** 新建会话并完成一次真实合成运行（用户 + 助手两条 entry）。 */
async function createTurn(content: string, reply: string): Promise<string> {
  const created = await host.createThread()
  const threadId = created.metadata.id
  await host.sendMessage(threadId, { content })
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

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-tree-test-')
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

describe('会话树读取与导航', () => {
  it('读取真实 entryId、活动路径与多叉结构', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')

    const tree = await host.getThreadTree(threadId)
    expect(tree.threadId).toBe(threadId)
    expect(tree.leafId).toBeTruthy()
    expect(tree.revision).toMatch(/^v1:\d+:/)
    // 工作区扩展在运行前注入 system 消息（state 分类），对话过滤不显示。
    expect(tree.nodes.filter((node) => node.kind !== 'state').map((node) => node.kind)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(tree.nodes.every((node) => node.active)).toBe(true)
    expect(tree.nodes.at(-1)?.isLeaf).toBe(true)
    expect(tree.nodes.find((node) => node.kind === 'user')?.summary).toBe('第一问')
    // entryId 来自真实会话记录，不是下标。
    expect(tree.nodes[0]?.entryId).not.toBe('0')
  })

  it('用户节点导航回到其父并返回 editorText；冷读沿用落点', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')
    const sessionFile = (await host.getThread(threadId)).metadata.sessionFile
    if (!sessionFile) throw new Error('缺少会话文件')
    const jsonlBefore = await readFile(sessionFile, 'utf8')

    const result = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
    })
    expect(result.status).toBe('applied')
    expect(result.editorText).toBe('第一问')
    // 无摘要导航只写 sidecar，不改动 Pi JSONL。
    expect(await readFile(sessionFile, 'utf8')).toBe(jsonlBefore)
    expect(result.persistence).toBe('saved')
    // 首条用户消息的父节点是扩展注入的 system entry，因此上下文只剩它。
    expect(result.snapshot?.messages.map((message) => message.role)).toEqual(['system'])
    expect(result.leafId).not.toBeNull()

    await restartHost()
    const cold = await host.getThread(threadId)
    expect(cold.messages.map((message) => message.role)).toEqual(['system'])
    expect(cold.metadata.leafId).toBe(result.leafId)
    const coldTree = await host.getThreadTree(threadId)
    expect(coldTree.leafId).toBe(result.leafId)
    // 冷读详情同样使用落点（活动路径到恢复后的 leaf），不是文件末尾。
    const details = await host.getThreadDetails(threadId)
    expect(details.branchEntryCount).toBe(coldTree.nodes.filter((node) => node.active).length)
  })

  it('非用户节点从目标继续，重启恢复该落点', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'assistant')
    if (!target) throw new Error('缺少助手节点')

    const result = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
    })
    expect(result.status).toBe('applied')
    expect(result.editorText).toBeUndefined()
    expect(result.snapshot?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
    ])
    expect(result.snapshot?.messages.at(-1)?.role).toBe('assistant')

    await restartHost()
    const cold = await host.getThread(threadId)
    expect(cold.messages).toHaveLength(3)
    expect(cold.metadata.leafId).toBe(target.entryId)
    const coldTree = await host.getThreadTree(threadId)
    expect(coldTree.leafId).toBe(target.entryId)
    expect(coldTree.nodes.find((node) => node.entryId === target.entryId)?.active).toBe(true)
  })

  it('新条目使旧落点失效，以 Pi JSONL 为准', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')
    const navigated = await host.navigateThreadTree(threadId, {
      targetId: firstUser.entryId,
      expectedRevision: tree.revision,
    })
    expect(navigated.status).toBe('applied')

    // 正常发送会从恢复后的空上下文继续；文件条目数变化，旧落点水位失效。
    await addTurn(threadId, '分支后的新问题', '分支后的新回答')
    await restartHost()

    const cold = await host.getThread(threadId)
    expect(cold.messages.length).toBeGreaterThan(0)
    expect(cold.metadata.leafId).not.toBeNull()
    expect(cold.messages[0]?.role).toBe('system')
    const text = JSON.stringify(cold.messages[1])
    expect(text).toContain('分支后的新问题')
  })

  it('revision 冲突拒绝旧请求，刷新后可重试', async () => {
    const threadId = await createTurn('第一问', '第一答')
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')

    await addTurn(threadId, '第二问', '第二答')
    const stale = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
    })
    expect(stale.status).toBe('conflict')
    expect(stale.snapshot?.messages).toHaveLength(5)

    const current = await host.getThreadTree(threadId)
    expect(current.revision).not.toBe(tree.revision)
    const retried = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: current.revision,
    })
    expect(retried.status).toBe('applied')
  })
})

describe('标签与落点水位', () => {
  it('标签写在 Pi 文件且不改变活动落点；重启仍可读', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')
    const leafBefore = tree.leafId

    const labelled = await host.setThreadEntryLabel(threadId, {
      entryId: firstUser.entryId,
      label: '起点',
      expectedRevision: tree.revision,
    })
    expect(labelled.status).toBe('applied')
    expect(labelled.label).toBe('起点')
    expect(labelled.snapshot?.metadata.leafId).toBe(leafBefore)

    const after = await host.getThreadTree(threadId)
    expect(after.leafId).toBe(leafBefore)
    expect(after.nodes.find((node) => node.entryId === firstUser.entryId)?.label).toBe('起点')

    // 旧 revision 的标签请求被拒绝，不按旧树修改。
    const staleLabel = await host.setThreadEntryLabel(threadId, {
      entryId: firstUser.entryId,
      label: '过期标签',
      expectedRevision: tree.revision,
    })
    expect(staleLabel.status).toBe('conflict')

    await restartHost()
    const coldTree = await host.getThreadTree(threadId)
    expect(coldTree.nodes.find((node) => node.entryId === firstUser.entryId)?.label).toBe('起点')

    // 清除标签
    const cleared = await host.setThreadEntryLabel(threadId, {
      entryId: firstUser.entryId,
      expectedRevision: coldTree.revision,
    })
    expect(cleared.status).toBe('applied')
    const clearedTree = await host.getThreadTree(threadId)
    expect(
      clearedTree.nodes.find((node) => node.entryId === firstUser.entryId)?.label,
    ).toBeUndefined()
  })

  it('标签追加条目时刷新既有落点水位，重启仍恢复非叶落点', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const firstAssistant = tree.nodes.find((node) => node.kind === 'assistant')
    const secondUser = tree.nodes.filter((node) => node.kind === 'user')[1]
    if (!firstAssistant || !secondUser) throw new Error('缺少测试节点')

    const navigated = await host.navigateThreadTree(threadId, {
      targetId: firstAssistant.entryId,
      expectedRevision: tree.revision,
    })
    expect(navigated.status).toBe('applied')
    const afterNavigate = await host.getThreadTree(threadId)

    const labelled = await host.setThreadEntryLabel(threadId, {
      entryId: secondUser.entryId,
      label: '待办',
      expectedRevision: afterNavigate.revision,
    })
    expect(labelled.status).toBe('applied')
    expect(labelled.persistence).toBe('saved')

    await restartHost()
    const cold = await host.getThread(threadId)
    expect(cold.metadata.leafId).toBe(firstAssistant.entryId)
    expect(cold.messages).toHaveLength(3)
  })
})

describe('运行中停止并跳转与摘要取消', () => {
  it('运行中不显式 stopRunning 时返回 busy，且不停止当前响应', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await host.sendMessage(threadId, { content: '第二问' })
    await model.waitForPending()
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')

    const busy = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
    })
    expect(busy.status).toBe('busy')
    // 响应仍可正常完成。
    model.release('第二答')
    await waitIdle(threadId)
    const after = await host.getThreadTree(threadId)
    expect(after.nodes.at(-1)?.summary).toBe('第二答')
  })

  it('停止并跳转取回整体队列，失败路径也不丢失队列', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await host.sendMessage(threadId, { content: '第二问' })
    await model.waitForPending()
    await host.sendMessage(threadId, {
      content: '排队中的后续',
      streamingBehavior: 'followUp',
    })
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.metadata.queuedMessages?.some((message) => message.content === '排队中的后续')
        ? true
        : undefined
    })
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')

    const result = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
      stopRunning: true,
    })
    expect(result.status).toBe('applied')
    expect(result.recoveredQueue?.followUp).toContain('排队中的后续')
    expect(result.snapshot?.messages.map((message) => message.role)).toEqual(['system'])
    expect(result.snapshot?.metadata.queuedMessages).toBeUndefined()
  })

  it('分支摘要成功后写入摘要，取消时活动落点不变', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')

    const summarizing = host.navigateThreadTree(threadId, {
      targetId: firstUser.entryId,
      expectedRevision: tree.revision,
      summarize: true,
      customInstructions: '自定义焦点：保留关键决策',
    })
    await model.waitForPending()
    expect(model.lastBody()).toContain('自定义焦点：保留关键决策')
    // 摘要进行中：所有窗口可见 summarizing 状态，可取消。
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.metadata.treeOperation?.status === 'summarizing' ? true : undefined
    })
    // 树读取同样携带进行中的操作状态，供面板重新打开后显示/取消。
    expect((await host.getThreadTree(threadId)).operation?.status).toBe('summarizing')
    model.release('压缩后的分支摘要')
    const success = await summarizing
    expect(success.status).toBe('applied')
    expect(success.summaryCommitted).toBe(true)
    const afterSummary = await host.getThreadTree(threadId)
    expect(afterSummary.nodes.some((node) => node.entryType === 'branch_summary')).toBe(true)

    const target = afterSummary.nodes.find(
      (node) => node.kind === 'user' && node.entryId !== firstUser.entryId,
    )
    if (!target) throw new Error('缺少第二个用户节点')
    const leafBefore = afterSummary.leafId
    const cancelling = host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: afterSummary.revision,
      summarize: true,
    })
    await model.waitForPending()
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.metadata.treeOperation?.status === 'summarizing' ? true : undefined
    })
    const cancel = await host.cancelThreadTreeNavigation(threadId)
    expect(cancel.status).toBe('cancelled')
    const cancelled = await cancelling
    expect(cancelled.status).toBe('aborted')
    expect(cancelled.summaryCommitted).toBeUndefined()
    const finalSnapshot = await host.getThread(threadId)
    expect(finalSnapshot.metadata.leafId).toBe(leafBefore)
  })
})

describe('持久化失败边界', () => {
  it('sidecar 保存失败时恢复原落点并如实报告，摘要不可逆如实标记', async () => {
    const threadId = await createTurn('第一问', '第一答')
    await addTurn(threadId, '第二问', '第二答')
    const tree = await host.getThreadTree(threadId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')
    const leafBefore = tree.leafId

    // 让 state.json 的父目录不可写：用一个同名文件阻断 mkdir/写临时文件。
    const stateDir = join(env.agentDir, 'huan')
    await rm(stateDir, { recursive: true, force: true })
    await writeFile(stateDir, 'blocked')

    const result = await host.navigateThreadTree(threadId, {
      targetId: firstUser.entryId,
      expectedRevision: tree.revision,
    })
    expect(result.status).toBe('persistence-failed')
    expect(result.persistence).toBe('failed')
    expect(result.recovered).toBe(true)
    expect(result.snapshot?.metadata.leafId).toBe(leafBefore)
    expect(result.snapshot?.messages).toHaveLength(5)
    expect(result.message).toContain('恢复')
    expect(existsSync(stateDir) && (await stat(stateDir)).isFile()).toBe(true)
  })
})

describe('冷树不执行项目扩展或联网', () => {
  it('读取冷树不触发扩展工厂，也不发模型请求', async () => {
    const marker = join(env.root, 'project.marker')
    await mkdir(join(env.workspace, '.pi', 'extensions'), { recursive: true })
    await writeFile(
      join(env.workspace, '.pi', 'extensions', 'probe.ts'),
      `import { appendFileSync } from 'node:fs'

export default function () {
  appendFileSync(${JSON.stringify(marker)}, 'project\\n')
}
`,
    )
    const trusted = await host.decideProjectTrust({ path: env.workspace, trusted: true })
    expect(trusted.status).toBe('ready')
    const threadId = await createTurn('第一问', '第一答')
    await restartHost()

    const countLines = async () =>
      (await readFile(marker, 'utf8').catch(() => '')).split('\\n').filter(Boolean).length
    const before = await countLines()
    expect(before).toBeGreaterThan(0)
    const requestsBefore = model.count()
    const tree = await host.getThreadTree(threadId)
    expect(tree.nodes.length).toBeGreaterThan(0)
    expect(model.count()).toBe(requestsBefore)
    // 冷树只读文件与 sidecar，不触发项目扩展工厂。
    expect(await countLines()).toBe(before)
  })
})

describe('结构互斥、失败与删除边界', () => {
  it('摘要进行中发送被明确拒绝 busy，取消后可继续发送', async () => {
    const threadId = await createTurn('互斥第一问', '互斥第一答')
    await addTurn(threadId, '互斥第二问', '互斥第二答')
    const tree = await host.getThreadTree(threadId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')

    const navigating = host.navigateThreadTree(threadId, {
      targetId: firstUser.entryId,
      expectedRevision: tree.revision,
      summarize: true,
    })
    await model.waitForPending()
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.metadata.treeOperation?.status === 'summarizing' ? true : undefined
    })
    await expect(
      host.sendMessage(threadId, { content: '结构操作期间不应穿过' }),
    ).rejects.toBeInstanceOf(ThreadStructureBusyError)

    await host.cancelThreadTreeNavigation(threadId)
    const cancelled = await navigating
    expect(cancelled.status).toBe('aborted')

    await host.sendMessage(threadId, { content: '取消后仍可发送' })
    await model.waitForPending()
    model.release('取消后的回答')
    await waitIdle(threadId)
    const snapshot = await host.getThread(threadId)
    expect(snapshot.messages.at(-1)?.role).toBe('assistant')
  })

  it('摘要失败不伪报成功；运行中失败仍返回取回的队列', async () => {
    const threadId = await createTurn('失败第一问', '失败第一答')
    await host.sendMessage(threadId, { content: '失败第二问' })
    await model.waitForPending()
    await host.sendMessage(threadId, {
      content: '失败时排队的后续',
      streamingBehavior: 'followUp',
    })
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.metadata.queuedMessages?.some(
        (message) => message.content === '失败时排队的后续',
      )
        ? true
        : undefined
    })
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')

    model.failSummary()
    const result = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
      summarize: true,
      stopRunning: true,
    })
    expect(result.status).toBe('failed')
    expect(result.summaryCommitted).toBeUndefined()
    expect(result.recoveredQueue?.followUp).toContain('失败时排队的后续')
    const finalTree = await host.getThreadTree(threadId)
    expect(finalTree.nodes.some((node) => node.entryType === 'branch_summary')).toBe(false)
    expect(finalTree.leafId).toBe(result.leafId)
  }, 30_000)

  it('项目扩展取消导航时不改变活动落点', async () => {
    await mkdir(join(env.workspace, '.pi', 'extensions'), { recursive: true })
    await writeFile(
      join(env.workspace, '.pi', 'extensions', 'cancel-tree.ts'),
      `export default function (pi) {
  pi.on('session_before_tree', () => ({ cancel: true }))
}
`,
    )
    const trusted = await host.decideProjectTrust({ path: env.workspace, trusted: true })
    expect(trusted.status).toBe('ready')

    const threadId = await createTurn('扩展第一问', '扩展第一答')
    const tree = await host.getThreadTree(threadId)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')

    const result = await host.navigateThreadTree(threadId, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
      summarize: true,
    })
    expect(result.status).toBe('cancelled')
    expect(result.snapshot?.metadata.leafId).toBe(tree.leafId)
    expect((await host.getThreadTree(threadId)).leafId).toBe(tree.leafId)
  })

  it('删除会话时取消并排空摘要导航，不提交落点', async () => {
    const threadId = await createTurn('删除第一问', '删除第一答')
    await addTurn(threadId, '删除第二问', '删除第二答')
    const tree = await host.getThreadTree(threadId)
    const firstUser = tree.nodes.find((node) => node.kind === 'user')
    if (!firstUser) throw new Error('缺少用户节点')
    const sessionFile = (await host.getThread(threadId)).metadata.sessionFile
    if (!sessionFile) throw new Error('缺少会话文件')

    const navigating = host.navigateThreadTree(threadId, {
      targetId: firstUser.entryId,
      expectedRevision: tree.revision,
      summarize: true,
    })
    await model.waitForPending()
    await waitFor(async () => {
      const snapshot = await host.getThread(threadId)
      return snapshot.metadata.treeOperation?.status === 'summarizing' ? true : undefined
    })

    const [, navigation] = await Promise.all([host.deleteThread(threadId), navigating])
    expect(navigation.status === 'aborted' || navigation.status === 'cancelled').toBe(true)
    expect(existsSync(sessionFile)).toBe(false)
    await expect(host.getThread(threadId)).rejects.toThrow('Unknown thread')
  })
})

describe('冷树结构细节与损坏落点', () => {
  it('冷树显示工具/标签，sidecar 指向不存在节点时忽略', async () => {
    const manager = SessionManager.create(env.workspace, env.defaultSessionDir(env.workspace))
    const userId = manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '冷树问题' }],
      timestamp: Date.now(),
    })
    const assistantId = manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: '准备调用工具' },
        { type: 'toolCall', id: 'call_cold', name: 'read', arguments: { path: 'a.txt' } },
      ],
      api: 'openai-completions',
      provider: 'huan-test',
      model: 'test-model-a',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    })
    const toolId = manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'call_cold',
      toolName: 'read',
      content: [{ type: 'text', text: '文件内容' }],
      isError: false,
      timestamp: Date.now(),
    })
    manager.appendLabelChange(assistantId, '工具节点')
    const threadId = manager.getSessionId()
    const originalLeaf = manager.getLeafId()
    const entryCount = manager.getEntryCount()
    await host.listThreads({ refresh: true })

    const tree = await host.getThreadTree(threadId)
    expect(tree.nodes.find((node) => node.entryId === assistantId)).toMatchObject({
      kind: 'assistant',
      label: '工具节点',
      hasToolCalls: true,
    })
    expect(tree.nodes.find((node) => node.kind === 'tool')?.summary).toContain('文件内容')
    expect(tree.leafId).toBe(originalLeaf)

    // 水位相同但 leafId 不存在：冷读取忽略落点，以文件为准。
    await host.dispose()
    const store = new WorkspaceStore(env.agentDir)
    await store.load()
    await store.setSessionLeaf({
      storeId: sessionStoreId(defaultSessionsRoot(env.agentDir)),
      sessionId: threadId,
      leaf: { leafId: 'missing-entry', entryCount },
    })
    host = await createHost()
    const coldTree = await host.getThreadTree(threadId)
    expect(coldTree.leafId).toBe(originalLeaf)
    expect(coldTree.leafId).not.toBe('missing-entry')
    const coldSnapshot = await host.getThread(threadId)
    expect(coldSnapshot.messages.length).toBeGreaterThan(0)
    // 冷快照同样提供与消息等长的来源 entryId（真实记录，非下标）。
    expect(coldSnapshot.messageEntryIds).toEqual([userId, assistantId, toolId])
  })
  it('null 树落点（根之前）在重启后恢复为空上下文', async () => {
    const manager = SessionManager.create(env.workspace, env.defaultSessionDir(env.workspace))
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '根用户消息' }],
      timestamp: Date.now(),
    })
    const threadId = manager.getSessionId()
    const entryCount = manager.getEntryCount()

    await host.dispose()
    const store = new WorkspaceStore(env.agentDir)
    await store.load()
    await store.setSessionLeaf({
      storeId: sessionStoreId(defaultSessionsRoot(env.agentDir)),
      sessionId: threadId,
      leaf: { leafId: null, entryCount },
    })
    host = await createHost()

    const cold = await host.getThread(threadId)
    expect(cold.messages).toEqual([])
    expect(cold.metadata.leafId).toBeNull()
    expect(cold.metadata.treeRevision).toBe(`v1:${entryCount}:null`)
    expect((await host.getThreadDetails(threadId)).branchEntryCount).toBe(0)
    expect((await host.getThreadTree(threadId)).leafId).toBeNull()
  })
})
