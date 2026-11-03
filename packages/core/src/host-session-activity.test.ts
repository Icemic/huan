/**
 * 会话活动时间投影：与 Pi `SessionInfo` 同口径的 created/modified。
 *
 * 全部使用真实 SessionManager 写入隔离用户空间，对照 Pi 目录扫描结果；覆盖
 * 冷列表、快照（HTTP 同源）、SSE 首帧与热详情的一致性，以及新消息推进、
 * 改名/Thinking/分支导航不推进、跨分支与无序时间戳、无活动回退 header。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { HarnessClientEvent, HarnessThreadMetadata } from '@huan/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCatalog } from './host/session-catalog.js'
import { createHarnessHost, type HarnessHost } from './host.js'
import { defaultSessionDir } from './session-dir.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_A,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

let env: IsolatedPiEnv
let fetchStub: TestFetchStub
const hosts: HarnessHost[] = []

async function openHost(): Promise<HarnessHost> {
  const host = await createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
  })
  hosts.push(host)
  return host
}

function sessionDirOf(): string {
  return defaultSessionDir(env.agentDir, env.workspace)
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const userMessage = (text: string, timestamp: number) => ({
  role: 'user' as const,
  content: [{ type: 'text' as const, text }],
  timestamp,
})

const assistantMessage = (text: string, timestamp: number) => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text }],
  api: 'openai-completions',
  provider: TEST_PROVIDER,
  model: TEST_MODEL_A,
  usage,
  stopReason: 'stop' as const,
  timestamp,
})

/**
 * 活动时间夹具：文件顺序与时间都无序，且最大活动时间位于已离开的分支。
 *
 * 文件顺序：首条 user(100) → 旧分支 user(900) → 当前分支 user(300) → 当前分支
 * assistant(200)。当前分支（session.messages）不含时间最大的旧分支消息。
 */
function seedActivitySession(): { id: string; path: string; createdAt: number } {
  const manager = SessionManager.create(env.workspace, sessionDirOf())
  const first = manager.appendMessage(userMessage('文件首条用户消息', 1_600_000_000_100))
  manager.appendMessage(userMessage('已离开分支的较晚消息', 1_600_000_000_900))
  manager.branch(first)
  manager.appendMessage(userMessage('当前分支用户消息', 1_600_000_000_300))
  manager.appendMessage(assistantMessage('当前分支助手回复', 1_600_000_000_200))
  const path = manager.getSessionFile()
  if (!path) throw new Error('活动时间探针会话未落盘')
  return {
    id: manager.getSessionId(),
    path,
    createdAt: new Date(manager.getHeader()?.timestamp ?? '').getTime(),
  }
}

async function piSessionInfo(id: string) {
  const info = (await SessionManager.list(env.workspace, sessionDirOf())).find(
    (item) => item.id === id,
  )
  if (!info) throw new Error(`Pi 目录中缺少会话 ${id}`)
  return info
}

function metadataOf(listed: readonly HarnessThreadMetadata[], id: string): HarnessThreadMetadata {
  const metadata = listed.find((item) => item.id === id)
  if (!metadata) throw new Error(`宿主列表中缺少会话 ${id}`)
  return metadata
}

/** 订阅首帧快照：等同 HTTP SSE 的 snapshot 帧；同时把会话打开为热记录。 */
function firstSnapshotOf(host: HarnessHost, threadId: string): Promise<HarnessClientEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('等待 SSE 首帧快照超时'))
    }, 20_000)
    const unsubscribe = host.subscribe(threadId, (event) => {
      if (event.type !== 'snapshot') return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

function expectTimes(
  metadata: HarnessThreadMetadata,
  expected: { createdAt: string; updatedAt: string },
): void {
  expect(metadata.createdAt).toBe(expected.createdAt)
  expect(metadata.updatedAt).toBe(expected.updatedAt)
}

beforeEach(async () => {
  env = await createIsolatedPiEnv('huan-session-activity-')
  fetchStub = installTestFetch('ok')
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.dispose()
  fetchStub.restore()
  await env.cleanup()
})

describe('活动时间投影（真实 SessionManager）', () => {
  it('冷列表、快照、SSE 首帧与热详情使用同一 Pi created/modified', async () => {
    const seeded = seedActivitySession()
    const info = await piSessionInfo(seeded.id)
    // 最大活动时间来自已离开当前分支的消息；Pi 目录仍按全文件计算。
    expect(info.modified.getTime()).toBe(1_600_000_000_900)
    expect(info.created.getTime()).toBe(seeded.createdAt)
    const branch = SessionManager.open(seeded.path, sessionDirOf()).getBranch()
    expect(JSON.stringify(branch)).not.toContain('已离开分支的较晚消息')

    const expected = {
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
    }
    const host = await openHost()

    // 冷读：列表、HTTP 快照与只读详情同一口径。
    const coldListed = metadataOf(await host.listThreads({ refresh: true }), seeded.id)
    const coldSnapshot = await host.getThread(seeded.id)
    const coldDetails = await host.getThreadDetails(seeded.id)
    expectTimes(coldListed, expected)
    expectTimes(coldSnapshot.metadata, expected)
    expectTimes(coldDetails.metadata, expected)
    expect(JSON.stringify(coldSnapshot.messages)).not.toContain('已离开分支的较晚消息')

    // 热读：SSE 首帧、快照、列表与详情均保持同一时间。
    const firstFrame = await firstSnapshotOf(host, seeded.id)
    if (firstFrame.type !== 'snapshot') throw new Error('首帧不是快照')
    expectTimes(firstFrame.snapshot.metadata, expected)
    expectTimes((await host.getThread(seeded.id)).metadata, expected)
    expectTimes(metadataOf(await host.listThreads(), seeded.id), expected)
    expectTimes((await host.getThreadDetails(seeded.id)).metadata, expected)
  }, 90_000)

  it('后续真实消息推进活动时间，列表不被旧目录缓存覆盖', async () => {
    const seeded = seedActivitySession()
    const info = await piSessionInfo(seeded.id)
    const host = await openHost()

    // 先建立目录缓存并打开热会话，模拟「选中已归属会话」后的固定列表数据源。
    const initialListed = metadataOf(await host.listThreads(), seeded.id)
    expectTimes(initialListed, {
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
    })
    await firstSnapshotOf(host, seeded.id)
    const before = await host.getThread(seeded.id)
    expect(before.metadata.updatedAt).toBe(info.modified.toISOString())

    // 模拟目录缓存未被失效（例如其他路径追加了活动）：列表仍必须采用 live 投影，
    // 不得回写打开前的旧目录时间。
    vi.spyOn(SessionCatalog.prototype, 'invalidateCatalog').mockImplementation(() => {})

    await host.sendMessage(seeded.id, { content: '继续对话' })
    const deadline = Date.now() + 60_000
    let after = await host.getThread(seeded.id)
    while (Date.now() < deadline) {
      after = await host.getThread(seeded.id)
      const hasReply = after.messages.some(
        (message) => message.role === 'assistant' && JSON.stringify(message).includes('ok'),
      )
      if (after.metadata.status === 'idle' && hasReply) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(after.metadata.status).toBe('idle')
    expect(JSON.stringify(after.messages)).toContain('继续对话')
    const advanced = new Date(after.metadata.updatedAt ?? 0).getTime()
    expect(advanced).toBeGreaterThan(info.modified.getTime())
    // 与 Pi 对同一文件的扫描结果一致（新消息的 message.timestamp）。
    expect(after.metadata.updatedAt).toBe((await piSessionInfo(seeded.id)).modified.toISOString())

    // 列表不刷新也必须采用 live 投影的最新时间，而不是打开前的目录缓存。
    expectTimes(metadataOf(await host.listThreads(), seeded.id), {
      createdAt: info.created.toISOString(),
      updatedAt: after.metadata.updatedAt ?? '',
    })
  }, 90_000)

  it('改名、Thinking 与分支导航不推进活动时间', async () => {
    const seeded = seedActivitySession()
    const info = await piSessionInfo(seeded.id)
    const host = await openHost()
    await firstSnapshotOf(host, seeded.id)
    const before = await host.getThread(seeded.id)
    const expected = {
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
    }
    expectTimes(before.metadata, expected)

    await host.renameThread(seeded.id, '活动时间基线')
    expect((await host.getThread(seeded.id)).metadata.title).toBe('活动时间基线')
    await host.setThinkingLevel(seeded.id, 'high')
    expect((await host.getThread(seeded.id)).metadata.config?.thinkingLevel).toBe('high')

    const tree = await host.getThreadTree(seeded.id)
    const target = tree.nodes.find((node) => node.kind === 'user')
    if (!target) throw new Error('缺少用户节点')
    const navigated = await host.navigateThreadTree(seeded.id, {
      targetId: target.entryId,
      expectedRevision: tree.revision,
    })
    expect(navigated.status).toBe('applied')

    const after = await host.getThread(seeded.id)
    expectTimes(after.metadata, expected)
    expectTimes(metadataOf(await host.listThreads(), seeded.id), expected)
  }, 90_000)

  it('无 user/assistant 活动时时间回退 header.timestamp', async () => {
    const manager = SessionManager.create(env.workspace, sessionDirOf())
    manager.appendSessionInfo('仅设置项')
    manager.appendThinkingLevelChange('high')
    manager.appendMessage(userMessage('用于落盘后移除', 1_600_000_000_000))
    const path = manager.getSessionFile()
    if (!path) throw new Error('无活动探针会话未落盘')
    // 真实文件只保留 header 与设置条目：Pi 目录的 modified 回退 header 时间。
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const kept = lines.filter((line) => (JSON.parse(line) as { type?: string }).type !== 'message')
    await writeFile(path, `${kept.join('\n')}\n`)

    const info = await piSessionInfo(manager.getSessionId())
    expect(info.messageCount).toBe(0)
    expect(info.modified.getTime()).toBe(info.created.getTime())
    const expected = {
      createdAt: info.created.toISOString(),
      updatedAt: info.modified.toISOString(),
    }

    const host = await openHost()
    expectTimes(metadataOf(await host.listThreads({ refresh: true }), info.id), expected)
    expectTimes((await host.getThread(info.id)).metadata, expected)
    expectTimes((await host.getThreadDetails(info.id)).metadata, expected)

    const firstFrame = await firstSnapshotOf(host, info.id)
    if (firstFrame.type !== 'snapshot') throw new Error('首帧不是快照')
    expectTimes(firstFrame.snapshot.metadata, expected)
  }, 90_000)
})
