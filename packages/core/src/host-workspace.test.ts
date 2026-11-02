import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import { defaultSessionDir } from './session-dir.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'
import { workspaceStateFile } from './workspace-store.js'

const TESTED_ENV_KEYS = ['PI_PROVIDER', 'PI_MODEL_ID', 'PI_CODING_AGENT_DIR'] as const
const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'

let env: IsolatedPiEnv
let fetchStub: TestFetchStub
const hosts: HarnessHost[] = []
const savedEnv = new Map<string, string | undefined>()

async function openHost(
  target: IsolatedPiEnv,
  overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {},
): Promise<HarnessHost> {
  const host = await createHarnessHost({
    workspacePath: target.workspace,
    agentDir: target.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...overrides,
  })
  hosts.push(host)
  return host
}

function seedSession(cwd: string, sessionDir: string, text: string): { id: string; path: string } {
  const manager = SessionManager.create(cwd, sessionDir)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  const path = manager.getSessionFile()
  if (!path) throw new Error('探针会话未落盘')
  return { id: manager.getSessionId(), path }
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 合成模型返回一次工具调用；后续请求回退到测试 fetch 的文本响应。 */
function toolCallSse(name: string, args: Record<string, unknown>): Response {
  const base = {
    id: 'chatcmpl-huan-workspace-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'huan-test',
  }
  return new Response(
    sseChunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_huan_workspace',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
      sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function waitForIdle(host: HarnessHost, threadId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await host.getThread(threadId)
    if (snapshot.metadata.status !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待会话空闲超时')
}

beforeEach(async () => {
  for (const key of [...TESTED_ENV_KEYS, SESSION_DIR_ENV]) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-host-workspace-')
  fetchStub = installTestFetch('工作区测试回复')
})

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  await env.cleanup()
  fetchStub.restore()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

describe('宿主工作区生命周期', () => {
  it('同一项目属于两个工作区时不串会话，重启与改名保持归属', async () => {
    const host = await openHost(env)
    const first = await host.createWorkspace({
      name: '工作区 A',
      projects: [{ alias: 'shared', path: env.workspace }],
    })
    const second = await host.createWorkspace({
      name: '工作区 B',
      projects: [{ alias: 'shared', path: env.workspace }],
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('工作区创建失败')

    const threadA = await host.createThread({ workspaceId: first.workspace.id })
    await host.sendMessage(threadA.metadata.id, { content: '工作区 A 会话' })
    const threadB = await host.createThread({ workspaceId: second.workspace.id })
    await host.sendMessage(threadB.metadata.id, { content: '工作区 B 会话' })
    expect(threadA.metadata.workspaceId).toBe(first.workspace.id)
    expect(threadB.metadata.workspaceId).toBe(second.workspace.id)
    expect(threadA.metadata.workspacePath).toBe(threadB.metadata.workspacePath)

    expect(
      (await host.listThreads({ workspaceId: first.workspace.id })).map((item) => item.id),
    ).toEqual([threadA.metadata.id])
    expect(
      (await host.listThreads({ workspaceId: second.workspace.id })).map((item) => item.id),
    ).toEqual([threadB.metadata.id])

    const renamed = await host.updateWorkspace({
      workspaceId: second.workspace.id,
      expectedRevision: second.workspace.revision,
      name: '工作区 B 改名',
    })
    expect(renamed.ok).toBe(true)
    const conflict = await host.updateWorkspace({
      workspaceId: second.workspace.id,
      expectedRevision: second.workspace.revision,
      name: '过期提交',
    })
    expect(conflict.ok).toBe(false)
    if (conflict.ok) throw new Error('应返回冲突')
    expect(conflict.error).toBe('conflict')
    expect(conflict.workspace?.name).toBe('工作区 B 改名')

    await host.dispose()
    hosts.splice(hosts.indexOf(host), 1)

    const restarted = await openHost(env)
    const catalog = await restarted.listWorkspaces()
    // 启动默认工作区在首次显式创建工作区时随状态文件落盘，仍保留。
    expect(catalog.workspaces.map((workspace) => workspace.name)).toEqual(
      expect.arrayContaining(['工作区 A', '工作区 B 改名']),
    )
    expect(
      (await restarted.listThreads({ workspaceId: first.workspace.id })).map((item) => item.id),
    ).toEqual([threadA.metadata.id])
    expect(
      (await restarted.listThreads({ workspaceId: second.workspace.id })).map((item) => item.id),
    ).toEqual([threadB.metadata.id])
  }, 90_000)

  it('已有无元数据会话保持未归属，只能明确加入工作区', async () => {
    const seeded = seedSession(
      env.workspace,
      defaultSessionDir(env.agentDir, env.workspace),
      '未归属历史',
    )
    const host = await openHost(env)
    const unassigned = await host.listThreads({ unassigned: true })
    expect(unassigned.map((item) => item.id)).toContain(seeded.id)
    expect(unassigned.find((item) => item.id === seeded.id)?.workspaceId).toBeUndefined()

    const catalog = await host.listWorkspaces()
    const workspace = catalog.startupWorkspaceId
      ? catalog.workspaces.find((item) => item.id === catalog.startupWorkspaceId)
      : undefined
    expect(workspace).toBeDefined()
    if (!workspace) throw new Error('缺少启动工作区')

    const assigned = await host.assignThreadWorkspace({
      threadId: seeded.id,
      workspaceId: workspace.id,
    })
    expect(assigned.ok).toBe(true)
    if (!assigned.ok) throw new Error('归属失败')
    expect(assigned.thread.workspaceId).toBe(workspace.id)
    expect(
      (await host.listThreads({ workspaceId: workspace.id })).map((item) => item.id),
    ).toContain(seeded.id)
    expect(await host.listThreads({ unassigned: true })).toEqual([])
    // 归属保存后冷读也带同一工作区。
    const cold = await host.getThread(seeded.id)
    expect(cold.metadata.workspaceId).toBe(workspace.id)
  }, 90_000)

  it('会话扩展按起始项目装配，未运行成员的项目扩展不执行；@别名工具可用', async () => {
    const start = join(env.root, 'start-project')
    const other = join(env.root, 'other-project')
    await mkdir(start, { recursive: true })
    const extensionDir = join(other, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const marker = join(env.root, 'other-project.marker')
    await writeFile(
      join(extensionDir, 'probe.js'),
      `import { appendFileSync } from 'node:fs'\nexport default function () { appendFileSync(${JSON.stringify(marker)}, 'other\\n') }\n`,
    )

    const host = await openHost(env, { workspacePath: start })
    const created = await host.createWorkspace({
      name: '多项目',
      projects: [
        { alias: 'start', path: start },
        { alias: 'other', path: other },
      ],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('工作区创建失败')

    const thread = await host.createThread({
      workspaceId: created.workspace.id,
      startProjectPath: start,
    })
    const threadId = thread.metadata.id
    expect(existsSync(marker)).toBe(false)

    const fallbackFetch = globalThis.fetch
    let first = true
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (first) {
        first = false
        return toolCallSse('write', {
          path: '@other/from-workspace.txt',
          content: '跨成员写入\n',
        })
      }
      return fallbackFetch(input, init)
    }) as typeof fetch
    try {
      await host.sendMessage(threadId, { content: '写入其他成员' })
      await waitForIdle(host, threadId)
    } finally {
      globalThis.fetch = fallbackFetch
    }
    expect(await readFile(join(other, 'from-workspace.txt'), 'utf8')).toBe('跨成员写入\n')
    // 其他成员的扩展没有被装配执行。
    expect(existsSync(marker)).toBe(false)
  }, 90_000)

  it('成员修改在运行边界生效：当前 applied 保持旧 revision，下一轮更新', async () => {
    const alpha = join(env.root, 'alpha')
    const beta = join(env.root, 'beta')
    await mkdir(alpha, { recursive: true })
    await mkdir(beta, { recursive: true })
    await writeFile(join(beta, 'value.txt'), 'beta-value')
    const host = await openHost(env, { workspacePath: alpha })
    const created = await host.createWorkspace({
      name: '动态成员',
      projects: [
        { alias: 'alpha', path: alpha },
        { alias: 'beta', path: beta },
      ],
    })
    if (!created.ok) throw new Error('工作区创建失败')
    const thread = await host.createThread({
      workspaceId: created.workspace.id,
      startProjectPath: alpha,
    })
    const id = thread.metadata.id
    expect(thread.metadata.workspaceRevision).toBe(1)
    expect(thread.metadata.workspaceAppliedRevision).toBe(1)

    const updated = await host.updateWorkspace({
      workspaceId: created.workspace.id,
      expectedRevision: 1,
      projects: [{ alias: 'alpha', path: alpha }],
    })
    expect(updated.ok).toBe(true)
    const pending = await host.getThread(id)
    expect(pending.metadata.workspaceRevision).toBe(2)
    expect(pending.metadata.workspaceAppliedRevision).toBe(1)

    // 下一轮开始（before_agent_start）采纳新 revision。
    await host.sendMessage(id, { content: '下一轮' })
    await waitForIdle(host, id)
    const applied = await host.getThread(id)
    expect(applied.metadata.workspaceRevision).toBe(2)
    expect(applied.metadata.workspaceAppliedRevision).toBe(2)
  }, 90_000)

  it('损坏元数据不覆盖文件；冷历史可读，依赖归属的修改禁用', async () => {
    const seeded = seedSession(
      env.workspace,
      defaultSessionDir(env.agentDir, env.workspace),
      '损坏元数据下的冷历史',
    )
    await mkdir(join(env.agentDir, 'huan'), { recursive: true })
    const stateFile = workspaceStateFile(env.agentDir)
    await writeFile(stateFile, '{ invalid json')
    const original = await readFile(stateFile, 'utf8')

    const host = await openHost(env)
    const catalog = await host.listWorkspaces()
    expect(catalog.state).toBe('corrupted')
    expect(catalog.workspaces).toEqual([])
    // 未归属列表与冷读不依赖 huan 元数据。
    expect((await host.listThreads({ unassigned: true })).map((item) => item.id)).toContain(
      seeded.id,
    )
    expect((await host.getThread(seeded.id)).messages.length).toBeGreaterThan(0)
    await expect(host.createThread()).rejects.toThrow(/工作区元数据不可用/)
    await expect(host.sendMessage(seeded.id, { content: '禁止运行' })).rejects.toThrow(
      /工作区元数据不可用/,
    )
    await expect(host.setModel(seeded.id, { provider: 'x', modelId: 'y' })).rejects.toThrow(
      /工作区元数据不可用/,
    )
    const assigned = await host.assignThreadWorkspace({
      threadId: seeded.id,
      workspaceId: 'ws_missing',
    })
    expect(assigned).toEqual({ ok: false, error: 'state-unavailable' })
    expect(await readFile(stateFile, 'utf8')).toBe(original)
  }, 90_000)

  it('工作区成员信任摘要不加载或执行项目扩展', async () => {
    const extensionDir = join(env.workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const marker = join(env.root, 'summary.marker')
    await writeFile(
      join(extensionDir, 'probe.js'),
      `import { appendFileSync } from 'node:fs'
export default function () { appendFileSync(${JSON.stringify(marker)}, 'project\n') }
`,
    )
    const host = await openHost(env)
    const summary = await host.inspectProjectTrust({ path: env.workspace })
    expect(summary.status).toBe('needs-trust')
    expect(summary.trust.requiresTrust).toBe(true)
    expect(existsSync(marker)).toBe(false)
  }, 90_000)

  it('检测到 pi-workspaces 时明确拒绝装配并记录诊断', async () => {
    const extensionDir = join(env.workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    await writeFile(join(extensionDir, 'pi-workspaces.js'), 'export default function () {}\n')

    const host = await openHost(env)
    const decided = await host.decideProjectTrust({
      path: env.workspace,
      trusted: true,
      remember: true,
    })
    expect(decided.status).toBe('failed')
    expect(host.diagnostics().some((message) => message.includes('pi-workspaces'))).toBe(true)
  }, 90_000)
})
