/**
 * G1.2b：会话列表字段、显式刷新、持久归档、删除清理与只读统计。
 *
 * 全部使用临时用户空间 + 合成 provider；统计口径与真实 SDK 输出对照
 * （热会话走 `getSessionStats()`，冷会话走宿主聚合），不读取个人数据。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import { defaultSessionDir, defaultSessionsRoot } from './session-dir.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_A,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'
import { sessionStoreId, WorkspaceStore, workspaceStateFile } from './workspace-store.js'

/** 合成 usage（含费用明细，字段与 Pi `Usage` 一致）。 */
type UsageFixture = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

const usageOf = (value: UsageFixture) => ({
  input: value.input,
  output: value.output,
  cacheRead: value.cacheRead,
  cacheWrite: value.cacheWrite,
  totalTokens: value.input + value.output + value.cacheRead + value.cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: value.cost },
})

let env: IsolatedPiEnv
let fetchStub: TestFetchStub
const hosts: HarnessHost[] = []

async function openHost(
  overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {},
): Promise<HarnessHost> {
  const host = await createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...overrides,
  })
  hosts.push(host)
  return host
}

async function disposeHost(host: HarnessHost): Promise<void> {
  await host.dispose()
  const index = hosts.indexOf(host)
  if (index >= 0) hosts.splice(index, 1)
}

function sessionDirOf(cwd: string = env.workspace): string {
  return defaultSessionDir(env.agentDir, cwd)
}

/** 探针会话：可选显式名称，落盘后返回 ID 与文件路径。 */
function seedSession(
  text: string,
  options: { cwd?: string; name?: string; parentSession?: string } = {},
): { id: string; path: string } {
  const cwd = options.cwd ?? env.workspace
  const manager = SessionManager.create(cwd, sessionDirOf(cwd), {
    ...(options.parentSession ? { parentSession: options.parentSession } : {}),
  })
  if (options.name) manager.appendSessionInfo(options.name)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  const path = manager.getSessionFile()
  if (!path) throw new Error('探针会话未落盘')
  return { id: manager.getSessionId(), path }
}

/**
 * 统计夹具：覆盖全部累计来源（assistant/toolResult/usage/compaction/
 * branch_summary），并保留一条不在活动分支上的历史路径。
 */
function seedStatsSession(): { id: string; path: string } {
  const manager = SessionManager.create(env.workspace, sessionDirOf())
  const first = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '统计会话首条消息' }],
    timestamp: 1_700_000_000_000,
  })
  const assistant = manager.appendMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: '先调用工具' },
      { type: 'toolCall', id: 'call_stats', name: 'read', arguments: { path: 'a.txt' } },
    ],
    api: 'openai-completions',
    provider: TEST_PROVIDER,
    model: TEST_MODEL_A,
    usage: usageOf({ input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: 0.011 }),
    stopReason: 'toolUse',
    timestamp: 1_700_000_000_100,
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call_stats',
    toolName: 'read',
    content: [{ type: 'text', text: '文件内容' }],
    isError: false,
    usage: usageOf({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.002 }),
    timestamp: 1_700_000_000_200,
  })
  manager.appendUsage(
    'cache_warm',
    TEST_PROVIDER,
    TEST_MODEL_A,
    usageOf({ input: 3, output: 4, cacheRead: 1, cacheWrite: 0, cost: 0.0005 }),
    '缓存预热',
  )
  manager.appendCompaction(
    '压缩摘要',
    first,
    1000,
    undefined,
    false,
    usageOf({ input: 7, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.0007 }),
  )
  // 从 assistant 处开启新分支并带摘要：摘要的 usage 属于活动分支之外的来源。
  manager.branchWithSummary(
    assistant,
    '分支摘要',
    undefined,
    false,
    usageOf({ input: 9, output: 1, cacheRead: 2, cacheWrite: 0, cost: 0.0009 }),
  )
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '另一分支消息' }],
    timestamp: 1_700_000_000_300,
  })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '另一分支回复' }],
    api: 'openai-completions',
    provider: TEST_PROVIDER,
    model: TEST_MODEL_A,
    usage: usageOf({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.005 }),
    stopReason: 'stop',
    timestamp: 1_700_000_000_400,
  })
  const path = manager.getSessionFile()
  if (!path) throw new Error('统计会话未落盘')
  return { id: manager.getSessionId(), path }
}

/** 指定模型变更与压缩边界的夹具。 */
function seedContextSession(options: {
  model: { provider: string; modelId: string }
  compacted: boolean
}): { id: string; path: string } {
  const manager = SessionManager.create(env.workspace, sessionDirOf())
  manager.appendModelChange(options.model.provider, options.model.modelId)
  const user = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '上下文测试消息' }],
    timestamp: 1_700_000_001_000,
  })
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '上下文测试回复' }],
    api: 'openai-completions',
    provider: options.model.provider,
    model: options.model.modelId,
    usage: usageOf({ input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 }),
    stopReason: 'stop',
    timestamp: 1_700_000_001_100,
  })
  if (options.compacted) manager.appendCompaction('压缩摘要', user, 500)
  const path = manager.getSessionFile()
  if (!path) throw new Error('上下文会话未落盘')
  return { id: manager.getSessionId(), path }
}

async function readState(): Promise<{
  workspaces: Record<string, unknown>
  sessionMetadata: Record<string, Record<string, unknown>>
}> {
  return JSON.parse(await readFile(workspaceStateFile(env.agentDir), 'utf8'))
}

beforeEach(async () => {
  env = await createIsolatedPiEnv('huan-session-management-')
  fetchStub = installTestFetch('会话管理测试回复')
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.dispose()
  fetchStub.restore()
  await env.cleanup()
})

describe('会话列表字段与显式刷新', () => {
  it('旧扫描晚到不会覆盖显式刷新后的目录缓存', async () => {
    seedSession('缓存基线')
    const host = await openHost()
    let release!: () => void
    let ready!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scanned = new Promise<void>((resolve) => {
      ready = resolve
    })
    const listAll = SessionManager.listAll.bind(SessionManager)
    vi.spyOn(SessionManager, 'listAll').mockImplementationOnce(async (...args) => {
      const result = await listAll(...args)
      ready()
      await gate
      return result
    })
    const older = host.listThreads()
    await scanned
    const external = seedSession('刷新后新增')
    expect((await host.listThreads({ refresh: true })).map((item) => item.id)).toContain(
      external.id,
    )
    release()
    await older
    expect((await host.listThreads()).map((item) => item.id)).toContain(external.id)
  })

  it('名称与首条消息为独立字段；外部新增/改名/删除只在显式刷新后可见', async () => {
    const named = seedSession('命名会话的首条消息', { name: '外部可读名称' })
    const unnamed = seedSession('未命名会话的首条消息')
    const host = await openHost()

    const first = await host.listThreads()
    const namedMeta = first.find((item) => item.id === named.id)
    const unnamedMeta = first.find((item) => item.id === unnamed.id)
    expect(namedMeta?.name).toBe('外部可读名称')
    expect(namedMeta?.title).toBe('外部可读名称')
    expect(namedMeta?.firstMessageText).toBe('命名会话的首条消息')
    expect(unnamedMeta?.name).toBeUndefined()
    expect(unnamedMeta?.title).toBe('未命名会话的首条消息')
    expect(unnamedMeta?.firstMessageText).toBe('未命名会话的首条消息')

    // 外部新增：普通列表沿用作用域缓存，显式刷新才重扫。
    const external = seedSession('外部新增会话')
    expect((await host.listThreads()).map((item) => item.id)).not.toContain(external.id)
    expect((await host.listThreads({ refresh: true })).map((item) => item.id)).toContain(
      external.id,
    )

    // 外部改名：同样需要显式刷新。
    const manager = SessionManager.open(unnamed.path, sessionDirOf())
    manager.appendSessionInfo('外部改名后')
    expect((await host.listThreads()).find((item) => item.id === unnamed.id)?.name).toBeUndefined()
    const renamed = await host.listThreads({ refresh: true })
    expect(renamed.find((item) => item.id === unnamed.id)?.name).toBe('外部改名后')

    // 外部删除：刷新后从列表消失。
    await rm(external.path, { force: true })
    expect((await host.listThreads({ refresh: true })).map((item) => item.id)).not.toContain(
      external.id,
    )
  }, 90_000)
})

describe('持久归档与删除清理', () => {
  const storeKey = () => sessionStoreId(defaultSessionsRoot(env.agentDir))

  it('未归属会话归档重启保留；归属更新保留归档；删除清理元数据', async () => {
    const unassigned = seedSession('未归属归档会话')
    const assigned = seedSession('归属会话')
    const host = await openHost()
    const catalog = await host.listWorkspaces()
    const workspaceId = catalog.startupWorkspaceId
    if (!workspaceId) throw new Error('缺少启动工作区')
    expect((await host.assignThreadWorkspace({ threadId: assigned.id, workspaceId })).ok).toBe(true)

    // 未归属也能归档，且不要求 workspaceId。
    await host.archiveThread(unassigned.id)
    const state = await readState()
    expect(state.sessionMetadata[storeKey()]?.[unassigned.id]).toEqual({ archived: true })
    expect((await host.listThreads({ unassigned: true })).map((item) => item.id)).not.toContain(
      unassigned.id,
    )
    const archivedList = await host.listThreads({ unassigned: true, includeArchived: true })
    expect(archivedList.find((item) => item.id === unassigned.id)?.archived).toBe(true)
    // 冷读快照也带归档标记。
    expect((await host.getThread(unassigned.id)).metadata.archived).toBe(true)

    // 归属更新保留归档，且不改工作区 revision。
    const before = await readState()
    const revisionBefore = (before.workspaces[workspaceId] as { revision: number }).revision
    const assignedResult = await host.assignThreadWorkspace({
      threadId: unassigned.id,
      workspaceId,
    })
    expect(assignedResult.ok).toBe(true)
    if (assignedResult.ok) expect(assignedResult.thread.archived).toBe(true)
    const afterAssign = await readState()
    expect((afterAssign.workspaces[workspaceId] as { revision: number }).revision).toBe(
      revisionBefore,
    )

    // 重启后归档保留。
    await disposeHost(host)
    const restarted = await openHost()
    expect((await restarted.listThreads()).map((item) => item.id)).not.toContain(unassigned.id)
    const restartedArchived = await restarted.listThreads({ includeArchived: true })
    expect(restartedArchived.find((item) => item.id === unassigned.id)?.archived).toBe(true)

    // 恢复归档后重新出现在普通列表。
    await restarted.unarchiveThread(unassigned.id)
    expect((await restarted.listThreads()).map((item) => item.id)).toContain(unassigned.id)

    // 删除：文件消失且元数据清理，不留空作用域。
    await restarted.deleteThread(unassigned.id)
    expect(existsSync(unassigned.path)).toBe(false)
    const cleared = await readState()
    expect(cleared.sessionMetadata[storeKey()]?.[unassigned.id]).toBeUndefined()
    expect(
      (await restarted.listThreads({ includeArchived: true })).map((item) => item.id),
    ).not.toContain(unassigned.id)
  }, 90_000)

  it('文件已删但元数据清理失败后，再次删除仍可完成清理', async () => {
    const seeded = seedSession('删除重试')
    const host = await openHost()
    await host.archiveThread(seeded.id)
    const cleanup = vi.spyOn(WorkspaceStore.prototype, 'removeSessionMetadata')
    cleanup.mockRejectedValueOnce(new Error('模拟落盘失败'))
    await expect(host.deleteThread(seeded.id)).rejects.toThrow('模拟落盘失败')
    expect(existsSync(seeded.path)).toBe(false)
    expect((await readState()).sessionMetadata[storeKey()]?.[seeded.id]).toBeDefined()
    await host.deleteThread(seeded.id)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect((await readState()).sessionMetadata[storeKey()]?.[seeded.id]).toBeUndefined()
  })

  it('损坏的 state.json 禁止归档/恢复/删除后的清理写入，也不覆盖原文件', async () => {
    const seeded = seedSession('损坏元数据会话')
    await mkdir(join(env.agentDir, 'huan'), { recursive: true })
    const stateFile = workspaceStateFile(env.agentDir)
    await writeFile(stateFile, '{ broken')
    const original = await readFile(stateFile, 'utf8')

    const host = await openHost()
    await expect(host.archiveThread(seeded.id)).rejects.toThrow(/工作区元数据不可用/)
    await expect(host.unarchiveThread(seeded.id)).rejects.toThrow(/工作区元数据不可用/)
    await expect(host.deleteThread(seeded.id)).rejects.toThrow(/工作区元数据不可用/)
    expect(existsSync(seeded.path)).toBe(true)
    expect(await readFile(stateFile, 'utf8')).toBe(original)
    // 冷列表与详情仍可用（只读路径不依赖元数据）。
    expect((await host.listThreads({ includeArchived: true })).map((item) => item.id)).toContain(
      seeded.id,
    )
    expect((await host.getThreadDetails(seeded.id)).stats.userMessages).toBe(1)
  }, 90_000)
})

describe('只读详情与累计统计', () => {
  it('冷聚合与真实 SDK 统计一致，覆盖其他分支/压缩/摘要/usage/toolResult', async () => {
    const seeded = seedStatsSession()
    const host = await openHost()

    // 冷读：不打开 AgentSession，直接按 SDK 规则聚合全文件。
    const cold = await host.getThreadDetails(seeded.id)
    expect(cold.metadata.name).toBeUndefined()
    expect(cold.metadata.firstMessageText).toBe('统计会话首条消息')
    expect(cold.stats).toMatchObject({
      userMessages: 2,
      assistantMessages: 2,
      toolResults: 1,
      toolCalls: 1,
      totalMessages: 5,
      tokens: { input: 179, output: 48, cacheRead: 8, cacheWrite: 2, total: 237 },
    })
    expect(cold.stats.cost).toBeCloseTo(0.0201, 10)
    // 活动分支：user、assistant、branch_summary、user、assistant。
    expect(cold.branchEntryCount).toBe(5)
    expect(cold.contextUsage?.contextWindow).toBe(32_768)
    expect(typeof cold.contextUsage?.tokens).toBe('number')

    // 热读：打开真实 AgentSession（不发起模型请求）后使用 SDK getSessionStats。
    await host.setThinkingLevel(seeded.id, 'high')
    const hot = await host.getThreadDetails(seeded.id)
    expect(hot.stats).toEqual(cold.stats)
    expect(hot.metadata.createdAt).toBe(cold.metadata.createdAt)
    expect(hot.metadata.updatedAt).toBe(cold.metadata.updatedAt)
    expect(hot.contextUsage).toEqual(cold.contextUsage)
    expect(hot.metadata.firstMessageText).toBe(cold.metadata.firstMessageText)
    // 打开会话会追加 model/thinking 记录，证明本次确实是热读路径；统计口径不受影响。
    expect(hot.branchEntryCount).toBeGreaterThan(cold.branchEntryCount)
  }, 90_000)

  it('热详情保留目录时间与父会话路径', async () => {
    const parent = seedSession('父会话')
    const child = seedSession('子会话', { parentSession: parent.path })
    const host = await openHost()
    const cold = await host.getThreadDetails(child.id)
    await host.setThinkingLevel(child.id, 'high')
    const hot = await host.getThreadDetails(child.id)
    expect(hot.metadata.parentSessionPath).toBe(parent.path)
    expect(hot.metadata.createdAt).toBe(cold.metadata.createdAt)
    expect(hot.metadata.updatedAt).toBe(cold.metadata.updatedAt)
  })

  it('未知模型窗口不填零；压缩后无有效助手响应时上下文未知', async () => {
    const unknownModel = seedContextSession({
      model: { provider: 'huan-unknown-provider', modelId: 'huan-unknown-model' },
      compacted: false,
    })
    const compacted = seedContextSession({
      model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_A },
      compacted: true,
    })
    const host = await openHost()

    const unknown = await host.getThreadDetails(unknownModel.id)
    expect(unknown.contextUsage).toBeUndefined()
    expect(unknown.stats.totalMessages).toBe(2)

    const afterCompaction = await host.getThreadDetails(compacted.id)
    expect(afterCompaction.contextUsage).toEqual({
      tokens: null,
      contextWindow: 32_768,
      percent: null,
    })
  }, 90_000)

  it('冷读详情不装配项目扩展、不联网', async () => {
    const project = join(env.root, 'details-project')
    const extensionDir = join(project, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const marker = join(env.root, 'details-project.marker')
    await writeFile(
      join(extensionDir, 'probe.js'),
      `import { appendFileSync } from 'node:fs'\nexport default function () { appendFileSync(${JSON.stringify(marker)}, 'project\\n') }\n`,
    )
    const seeded = seedSession('带项目扩展的冷会话', { cwd: project })

    const host = await openHost()
    expect(existsSync(marker)).toBe(false)
    const details = await host.getThreadDetails(seeded.id)
    expect(details.metadata.workspacePath).toBe(project)
    expect(details.stats.totalMessages).toBe(1)
    // 冷读只做文件聚合：项目扩展未执行，也没有任何网络请求。
    expect(existsSync(marker)).toBe(false)
    expect(fetchStub.calls()).toBe(0)
    expect(fetchStub.unexpected()).toEqual([])
  }, 90_000)
})
