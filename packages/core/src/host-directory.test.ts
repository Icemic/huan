import { copyFile, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost, type HarnessHostOptions } from './host.js'
import { defaultSessionDir } from './session-dir.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_B,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

/**
 * 用户空间与会话目录一致性（迭代设计 §3 / §7.2「目录」验证组）。
 *
 * 全部使用临时 agentDir / workspace / sessions；探针 SessionManager 显式传
 * 隔离目录；fetch 被确定性桩替代（禁止非预期联网）。
 */
const TESTED_ENV_KEYS = ['PI_PROVIDER', 'PI_MODEL_ID', 'PI_CODING_AGENT_DIR'] as const
const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'

const savedEnv = new Map<string, string | undefined>()
let fetchStub: TestFetchStub | undefined
const createdHosts: HarnessHost[] = []
const createdEnvs: IsolatedPiEnv[] = []

async function newEnv(prefix: string): Promise<IsolatedPiEnv> {
  const env = await createIsolatedPiEnv(prefix)
  createdEnvs.push(env)
  return env
}

/** 创建宿主并登记，确保用例结束时全部释放。 */
async function openHost(
  options: Partial<HarnessHostOptions> & { workspacePath: string },
): Promise<HarnessHost> {
  const host = await createHarnessHost({
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...options,
  })
  createdHosts.push(host)
  return host
}

/** 直接用 SessionManager 落盘一个探针会话（显式目录，不碰个人空间）。 */
function seedSession(
  cwd: string,
  sessionDir: string,
  text: string,
  options?: { id?: string },
): { id: string; path: string } {
  const manager = SessionManager.create(cwd, sessionDir, options)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  const path = manager.getSessionFile()
  if (!path) throw new Error('探针会话未落盘')
  return { id: manager.getSessionId(), path }
}

/** 等待会话文件落盘（首条消息写入是异步的，不靠固定睡眠猜）。 */
async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`等待会话文件落盘超时：${filePath}`)
}

beforeAll(() => {
  for (const key of [...TESTED_ENV_KEYS, SESSION_DIR_ENV]) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  fetchStub = installTestFetch()
})

afterEach(async () => {
  for (const host of createdHosts.splice(0)) await host.dispose()
  delete process.env[SESSION_DIR_ENV]
})

afterAll(async () => {
  // 先确认没有非预期联网，再还原桩与临时空间。
  const unexpected = fetchStub?.unexpected() ?? []
  fetchStub?.restore()
  for (const env of createdEnvs.splice(0)) await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  expect(unexpected).toEqual([])
})

describe('默认会话目录', () => {
  it('新建与冷读都落在 <agentDir>/sessions/<编码 cwd>，删除只作用于该文件', async () => {
    const env = await newEnv('huan-dir-default-')
    const host = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })

    const created = await host.createThread({ initialMessage: { content: '默认目录探针' } })
    const id = created.metadata.id
    const sessionFile = created.metadata.sessionFile
    expect(sessionFile).toBeDefined()
    expect(dirname(sessionFile ?? '')).toBe(defaultSessionDir(env.agentDir, env.workspace))
    // 位于临时用户空间内，绝不落到真实缺省目录。
    expect(dirname(sessionFile ?? '').startsWith(env.agentDir)).toBe(true)

    // 创建后立即列表（首条消息可能尚未落盘，瞬时为空属预期）；
    // 空结果不得被长期缓存：落盘后同一宿主必须能看到新会话。
    await host.listThreads()
    await waitForFile(sessionFile ?? '')
    expect((await host.listThreads()).map((item) => item.id)).toContain(id)

    // 冷读宿主（新实例，不用创作者的 list 缓存）：列表与读取均命中默认分组。
    const coldHost = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    expect((await coldHost.listThreads()).map((item) => item.id)).toContain(id)
    expect((await coldHost.getThread(id)).metadata.title).toBe('默认目录探针')

    await coldHost.deleteThread(id)
    const remaining = await readdir(defaultSessionDir(env.agentDir, env.workspace)).catch(() => [])
    expect(remaining.some((file) => file.endsWith('.jsonl'))).toBe(false)
  }, 60_000)
})

describe('显式会话目录（平铺覆盖）', () => {
  it('所有 cwd 共享平铺目录；列表按 header cwd 过滤，跨 cwd 可定位', async () => {
    const env = await newEnv('huan-dir-flat-')
    const otherWorkspace = join(env.root, 'workspace-b')
    await mkdir(otherWorkspace, { recursive: true })
    const flatDir = join(env.root, 'flat-sessions')

    const hostA = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    const hostB = await openHost({
      workspacePath: otherWorkspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })

    const created = await hostA.createThread({ initialMessage: { content: '平铺目录探针' } })
    const id = created.metadata.id
    expect(dirname(created.metadata.sessionFile ?? '')).toBe(flatDir)
    await waitForFile(created.metadata.sessionFile ?? '')

    // 同目录列表按 cwd 过滤：其它项目看不到；本项目的冷宿主能看到。
    const coldB = await openHost({
      workspacePath: otherWorkspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    expect((await coldB.listThreads()).map((item) => item.id)).not.toContain(id)
    const coldA = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    expect((await coldA.listThreads()).map((item) => item.id)).toContain(id)

    // B 通过平铺目录跨 cwd 定位并冷读（不把它当默认根递归）。
    expect((await hostB.getThread(id)).metadata.title).toBe('平铺目录探针')
    // 改名与删除也使用该作用域。
    const namedAt = Date.now() + 5_000
    await hostB.renameThread(id, '平铺改名')
    expect(Date.now()).toBeLessThan(namedAt)
    const coldD = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    expect((await coldD.getThread(id)).metadata.title).toBe('平铺改名')

    await hostB.deleteThread(id)
    const coldE = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    expect((await coldE.listThreads()).map((item) => item.id)).not.toContain(id)
    await expect(coldE.getThread(id)).rejects.toThrow(/Unknown thread/)

    // 默认空间的宿主不应看到平铺目录里的会话（无全局 listAll 泄漏）。
    const defaultHost = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
    })
    expect((await defaultHost.listThreads()).map((item) => item.id)).not.toContain(id)
    await expect(defaultHost.getThread(id)).rejects.toThrow(/Unknown thread/)
  }, 90_000)

  it('相对 sessionDir 以启动工作区解析（setting）且项目 setting 优先于用户 setting', async () => {
    const env = await newEnv('huan-dir-setting-')
    await mkdir(join(env.workspace, '.pi'), { recursive: true })
    await writeFile(
      join(env.workspace, '.pi', 'settings.json'),
      JSON.stringify({ sessionDir: './project-sessions' }),
    )
    // 用户 setting 同时存在，但项目 setting 优先。
    await writeFile(
      join(env.agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: TEST_PROVIDER,
        defaultModel: TEST_MODEL_B,
        sessionDir: './user-sessions',
      }),
    )

    const host = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    const created = await host.createThread({ initialMessage: { content: 'setting 目录探针' } })
    expect(dirname(created.metadata.sessionFile ?? '')).toBe(
      join(env.workspace, 'project-sessions'),
    )
  }, 60_000)

  it('优先级：显式 sessionDir > 环境变量 > setting > 默认', async () => {
    const env = await newEnv('huan-dir-priority-')
    await mkdir(join(env.workspace, '.pi'), { recursive: true })
    await writeFile(
      join(env.workspace, '.pi', 'settings.json'),
      JSON.stringify({ sessionDir: './setting-sessions' }),
    )
    const envDir = join(env.root, 'env-sessions')
    const optionDir = join(env.root, 'option-sessions')

    process.env[SESSION_DIR_ENV] = envDir
    const optionHost = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: optionDir,
    })
    const optionThread = await optionHost.createThread({
      initialMessage: { content: '显式优先' },
    })
    expect(dirname(optionThread.metadata.sessionFile ?? '')).toBe(optionDir)

    const envHost = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    const envThread = await envHost.createThread({ initialMessage: { content: '环境变量' } })
    expect(dirname(envThread.metadata.sessionFile ?? '')).toBe(envDir)

    // 覆盖值在宿主创建时固定：后续改环境变量不影响已创建宿主。
    delete process.env[SESSION_DIR_ENV]
    const envThread2 = await envHost.createThread({ initialMessage: { content: '环境变量已固定' } })
    expect(dirname(envThread2.metadata.sessionFile ?? '')).toBe(envDir)

    delete process.env[SESSION_DIR_ENV]
    const settingHost = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    const settingThread = await settingHost.createThread({ initialMessage: { content: 'setting' } })
    expect(dirname(settingThread.metadata.sessionFile ?? '')).toBe(
      join(env.workspace, 'setting-sessions'),
    )
  }, 90_000)
})

describe('同进程多用户空间', () => {
  it('两个不同 agentDir 的宿主并存，各自解析自己的默认模型与会话目录', async () => {
    const envA = await newEnv('huan-space-a-')
    const envB = await newEnv('huan-space-b-')
    await writeFile(
      join(envB.agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: TEST_PROVIDER, defaultModel: TEST_MODEL_B }),
    )

    const hostA = await openHost({ workspacePath: envA.workspace, agentDir: envA.agentDir })
    const hostB = await openHost({ workspacePath: envB.workspace, agentDir: envB.agentDir })

    const threadA = await hostA.createThread({ initialMessage: { content: '空间 A' } })
    const threadB = await hostB.createThread({ initialMessage: { content: '空间 B' } })
    expect(threadA.metadata.config?.modelId).not.toBe(threadB.metadata.config?.modelId)
    expect(dirname(threadA.metadata.sessionFile ?? '')).toBe(
      defaultSessionDir(envA.agentDir, envA.workspace),
    )
    expect(dirname(threadB.metadata.sessionFile ?? '')).toBe(
      defaultSessionDir(envB.agentDir, envB.workspace),
    )

    // 互不可见：跨空间既不命中分组目录，也不经全局 listAll 泄漏。
    expect((await hostB.listThreads()).map((item) => item.id)).not.toContain(threadA.metadata.id)
    await expect(hostB.getThread(threadA.metadata.id)).rejects.toThrow(/Unknown thread/)
    await expect(hostA.getThread(threadB.metadata.id)).rejects.toThrow(/Unknown thread/)
  }, 90_000)
})

describe('作用域内查找与安全边界', () => {
  it('默认空间跨 cwd 定位当前 agentDir 下的会话，但不越过该空间', async () => {
    const env = await newEnv('huan-dir-cross-')
    const otherWorkspace = join(env.root, 'workspace-other')
    await mkdir(otherWorkspace, { recursive: true })
    const probe = seedSession(
      otherWorkspace,
      defaultSessionDir(env.agentDir, otherWorkspace),
      '跨项目探针',
    )

    const host = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    // 列表按 cwd 过滤，不包含其它项目。
    expect((await host.listThreads()).map((item) => item.id)).not.toContain(probe.id)
    // 按 ID 查找可在当前空间内跨 cwd 命中。
    expect((await host.getThread(probe.id)).metadata.title).toBe('跨项目探针')
    await host.renameThread(probe.id, '跨项目改名')
    expect((await host.getThread(probe.id)).metadata.title).toBe('跨项目改名')
    await host.deleteThread(probe.id)
    await expect(host.getThread(probe.id)).rejects.toThrow(/Unknown thread/)

    // 同一 cwd 在另一个 agentDir 的宿主中找不到（不回落到全局默认空间）。
    const otherEnv = await newEnv('huan-dir-other-space-')
    const otherHost = await openHost({
      workspacePath: env.workspace,
      agentDir: otherEnv.agentDir,
    })
    const foreign = seedSession(
      env.workspace,
      defaultSessionDir(env.agentDir, env.workspace),
      '另一个空间',
    )
    await expect(otherHost.getThread(foreign.id)).rejects.toThrow(/Unknown thread/)
    await expect(otherHost.deleteThread(foreign.id)).resolves.toBeUndefined()
  }, 90_000)

  it('同一目录内重复 ID 报歧义，不静默选择其中一个文件', async () => {
    const env = await newEnv('huan-dir-duplicate-')
    const flatDir = join(env.root, 'flat-duplicate')
    const probe = seedSession(env.workspace, flatDir, '重复 ID', { id: 'duplicate-thread-id' })
    const copyPath = join(flatDir, `copy_${probe.id}.jsonl`)
    await copyFile(probe.path, copyPath)

    const host = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    await expect(host.getThread(probe.id)).rejects.toThrow(/多个文件|歧义/)
    await expect(host.deleteThread(probe.id)).rejects.toThrow(/多个文件|歧义/)
  }, 60_000)

  it('默认分组跨 cwd 的重复 ID 也报歧义（本地命中不得绕过作用域检查）', async () => {
    // 本地分组里确实存在该 ID：若「本地命中即返回」，就会静默拿到本项目文件，
    // 而同一个存储作用域内还存在另一个 cwd 分组的同 ID 文件。
    const env = await newEnv('huan-dir-duplicate-cross-')
    const otherWorkspace = join(env.root, 'workspace-other')
    await mkdir(otherWorkspace, { recursive: true })
    const local = seedSession(
      env.workspace,
      defaultSessionDir(env.agentDir, env.workspace),
      '本项目探针',
      { id: 'cross-cwd-duplicate-id' },
    )
    const remote = seedSession(
      otherWorkspace,
      defaultSessionDir(env.agentDir, otherWorkspace),
      '跨项目同名 ID',
      { id: 'cross-cwd-duplicate-id' },
    )
    expect(local.path).not.toBe(remote.path)

    const host = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    // 列表仍按 cwd 过滤：只看到本项目的那条。
    expect((await host.listThreads()).map((item) => item.id)).toContain('cross-cwd-duplicate-id')
    await expect(host.getThread('cross-cwd-duplicate-id')).rejects.toThrow(/多个文件|歧义/)
    await expect(host.deleteThread('cross-cwd-duplicate-id')).rejects.toThrow(/多个文件|歧义/)
    // 不得静默删除任何一个文件。
    expect(await stat(local.path).then(() => true)).toBe(true)
    expect(await stat(remote.path).then(() => true)).toBe(true)
  }, 60_000)

  it('默认空间根不可读（非不存在）时报可诊断的目录错误，不当作空目录', async () => {
    const env = await newEnv('huan-dir-root-broken-')
    // 把 sessions 根变成普通文件：readdir 得到 ENOTDIR（跨平台稳定）。
    await writeFile(join(env.agentDir, 'sessions'), 'occupied')
    const host = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })

    // 当前 cwd 的本地列表仍可为空（SDK 对不可读目录返回空）。
    await expect(host.listThreads()).resolves.toEqual([])
    // 跨 cwd 定位必须把目录故障上报给调用方（带路径与原因），而不是吞成空。
    await expect(host.getThread('missing-thread')).rejects.toThrow(/会话目录不可用/)
  }, 60_000)

  it('目录不可用：列表为空，创建失败且不回退默认空间', async () => {
    const env = await newEnv('huan-dir-unusable-')
    const notADir = join(env.root, 'not-a-dir')
    await writeFile(notADir, 'occupied')

    const listHost = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: notADir,
    })
    // 列表可为空（不抛错）。
    await expect(listHost.listThreads()).resolves.toEqual([])

    // 无法创建目录（父级是普通文件）：创建失败并报目录错误。
    const createHost = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: join(notADir, 'nested'),
    })
    await expect(
      createHost.createThread({ initialMessage: { content: '应失败' } }),
    ).rejects.toThrow(/not-a-dir|ENOTDIR|EEXIST/i)
    // 不得静默回退到用户默认空间。
    const defaultDir = defaultSessionDir(env.agentDir, env.workspace)
    const files = await readdir(defaultDir).catch(() => [])
    expect(files.filter((file) => file.endsWith('.jsonl'))).toEqual([])
  }, 60_000)

  it('默认分组被父目录链接指向外部空间时拒绝创建', async () => {
    const env = await newEnv('huan-dir-link-create-')
    const outside = join(env.root, 'outside')
    const group = defaultSessionDir(env.agentDir, env.workspace)
    await mkdir(outside, { recursive: true })
    await mkdir(dirname(group), { recursive: true })
    await symlink(outside, group, 'junction')
    const host = await openHost({ workspacePath: env.workspace, agentDir: env.agentDir })
    await expect(host.createThread()).rejects.toThrow('不在当前存储作用域内')
    expect(await readdir(outside)).toEqual([])
  })

  it('平铺目录不存在时：列表为空，首次创建自动建立目录', async () => {
    const env = await newEnv('huan-dir-missing-')
    const flatDir = join(env.root, 'not-created-yet')
    const host = await openHost({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      sessionDir: flatDir,
    })
    await expect(host.listThreads()).resolves.toEqual([])
    const created = await host.createThread({ initialMessage: { content: '自动建目录' } })
    expect(dirname(created.metadata.sessionFile ?? '')).toBe(flatDir)
  }, 60_000)
})
