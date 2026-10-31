import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost, ProjectTrustRequiredError } from './host.js'
import { defaultSessionDir } from './session-dir.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_A,
  TEST_MODEL_B,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

/**
 * 项目入口与信任（G1.2a）宿主测试。
 *
 * 每个用例使用临时用户空间与工作区；项目扩展只写探针文件，不访问网络。
 * 信任一律通过 `decideProjectTrust` 显式建立，不提供生产旁路。
 */

const TESTED_ENV_KEYS = ['PI_PROVIDER', 'PI_MODEL_ID', 'PI_CODING_AGENT_DIR'] as const
const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'

let fetchStub: TestFetchStub
let env: IsolatedPiEnv
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

/** 项目扩展示例：工厂执行时向探针文件追加一行。 */
async function writeProjectProbe(workspace: string, marker: string): Promise<void> {
  const dir = join(workspace, '.pi', 'extensions')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'probe.js'),
    `import { appendFileSync } from 'node:fs'

export default function () {
  appendFileSync(${JSON.stringify(marker)}, 'project\\n')
}
`,
  )
}

/** 写入项目 settings（同样属于需要信任的资源）。 */
async function writeProjectSettings(
  workspace: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(workspace, '.pi'), { recursive: true })
  await writeFile(join(workspace, '.pi', 'settings.json'), JSON.stringify(settings, null, 2))
}

/** 与宿主一致的规范化路径口径。 */
function canonical(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

async function markerCount(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf-8')
    return text.trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** 直接落盘一个探针会话（不经过宿主，用于冷历史断言）。 */
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

beforeEach(async () => {
  for (const key of [...TESTED_ENV_KEYS, SESSION_DIR_ENV]) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  fetchStub = installTestFetch()
  env = await createIsolatedPiEnv('huan-host-project-')
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
  expect(fetchStub.unexpected()).toEqual([])
})

describe('项目信任与安全启动', () => {
  it('未知信任不执行项目扩展，health/项目状态/冷历史仍可用', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)
    const seeded = seedSession(
      env.workspace,
      defaultSessionDir(env.agentDir, env.workspace),
      '冷历史消息',
    )

    const host = await openHost(env)
    expect(await markerCount(marker)).toBe(0)
    expect((await host.getHostInfo()).workspacePath).toBe(env.workspace)

    const project = await host.getProject({ path: env.workspace })
    expect(project.status).toBe('needs-trust')
    expect(project.trust).toMatchObject({
      decision: 'unknown',
      origin: 'ask',
      requiresTrust: true,
      defaultPolicy: 'ask',
      extensionErrorCount: 0,
    })
    expect(project.trust.savedPath).toBeUndefined()
    expect(await markerCount(marker)).toBe(0)

    // 冷历史/列表不执行项目代码。
    const cold = await host.getThread(seeded.id)
    expect(cold.messages.some((message) => message.role === 'user')).toBe(true)
    expect((await host.listThreads()).map((item) => item.id)).toContain(seeded.id)
    expect(await markerCount(marker)).toBe(0)

    // 创建/冷激活前必须取得决定。
    await expect(host.createThread()).rejects.toBeInstanceOf(ProjectTrustRequiredError)
    await expect(
      host.sendMessage(seeded.id, { content: '冷激活必须被拒绝' }),
    ).rejects.toBeInstanceOf(ProjectTrustRequiredError)
    expect(await markerCount(marker)).toBe(0)
  }, 60_000)

  it('显式允许装配一次并保存决定；重启沿用 saved 来源', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)

    const first = await openHost(env)
    const allowed = await first.decideProjectTrust({
      path: env.workspace,
      trusted: true,
      remember: true,
    })
    expect(allowed).toMatchObject({
      status: 'ready',
      trust: { decision: 'trusted', origin: 'explicit', requiresTrust: true },
    })
    expect(allowed.trust.savedPath).toBe(canonical(env.workspace))
    expect(await markerCount(marker)).toBe(1)

    // 决定阶段的 loader 交给首个会话复用：扩展工厂不重复执行。
    const created = await first.createThread()
    expect(created.metadata.workspacePath).toBe(canonical(env.workspace))
    expect(await markerCount(marker)).toBe(1)
    expect(JSON.parse(await readFile(join(env.agentDir, 'trust.json'), 'utf-8'))).toEqual({
      [canonical(env.workspace)]: true,
    })
    await first.dispose()

    const second = await openHost(env)
    const saved = await second.getProject({ path: env.workspace })
    expect(saved).toMatchObject({
      status: 'ready',
      trust: {
        decision: 'trusted',
        origin: 'saved',
        savedPath: canonical(env.workspace),
        requiresTrust: true,
      },
    })
    // 启动阶段已装配项目资源；首个会话复用该 loader。
    const afterStartup = await markerCount(marker)
    expect(afterStartup).toBeGreaterThanOrEqual(2)
    await second.createThread()
    expect(await markerCount(marker)).toBe(afterStartup)
  }, 90_000)

  it('拒绝只跳过项目资源，仍可创建会话运行；显式拒绝不写 trust.json', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)

    const host = await openHost(env)
    const denied = await host.decideProjectTrust({
      path: env.workspace,
      trusted: false,
    })
    expect(denied).toMatchObject({
      status: 'ready',
      trust: { decision: 'untrusted', origin: 'explicit', requiresTrust: true },
    })
    expect(denied.trust.savedPath).toBeUndefined()
    expect(await markerCount(marker)).toBe(0)
    expect(existsSync(join(env.agentDir, 'trust.json'))).toBe(false)

    const created = await host.createThread({ initialMessage: { content: '拒绝后仍可对话' } })
    expect(created.metadata.id).toBeTruthy()
    expect(await markerCount(marker)).toBe(0)
  }, 60_000)

  it('默认模型按目标项目的可信 settings 解析，不沿用启动项目默认模型', async () => {
    const other = join(env.root, 'other-project')
    await mkdir(other, { recursive: true })
    await writeProjectSettings(other, {
      defaultProvider: TEST_PROVIDER,
      defaultModel: TEST_MODEL_B,
    })

    const host = await openHost(env)
    // 启动项目仍是隔离环境的默认模型 A。
    expect((await host.getHostInfo()).defaultModel.modelId).toBe(TEST_MODEL_A)

    const project = await host.getProject({ path: other })
    expect(project.status).toBe('needs-trust')
    await host.decideProjectTrust({ path: other, trusted: true })
    const otherWorkspace = await host.createWorkspace({
      name: '另一项目工作区',
      projects: [{ alias: 'other', path: other }],
    })
    expect(otherWorkspace.ok).toBe(true)
    if (!otherWorkspace.ok) throw new Error('工作区创建失败')

    const created = await host.createThread({ workspaceId: otherWorkspace.workspace.id })
    expect(created.metadata.config?.provider).toBe(TEST_PROVIDER)
    expect(created.metadata.config?.modelId).toBe(TEST_MODEL_B)
    expect(created.metadata.workspaceId).toBe(otherWorkspace.workspace.id)
    expect(created.metadata.workspacePath).toBe(canonical(other))

    // 未信任时新建被拒绝，且不会静默回退到启动默认模型。
    const third = join(env.root, 'third-project')
    await mkdir(third, { recursive: true })
    await writeProjectSettings(third, { defaultModel: TEST_MODEL_B })
    const thirdWorkspace = await host.createWorkspace({
      name: '第三项目工作区',
      projects: [{ alias: 'third', path: third }],
    })
    expect(thirdWorkspace.ok).toBe(true)
    if (!thirdWorkspace.ok) throw new Error('工作区创建失败')
    await expect(
      host.createThread({ workspaceId: thirdWorkspace.workspace.id }),
    ).rejects.toBeInstanceOf(ProjectTrustRequiredError)
  }, 90_000)
})

describe('最近项目', () => {
  it('按 agentDir 隔离，并合并同一空间的会话 header 与已选项目', async () => {
    const otherEnv = await createIsolatedPiEnv('huan-host-project-b-')
    try {
      const workspaceB = join(env.root, 'only-in-b')
      await mkdir(workspaceB, { recursive: true })
      const peer = join(env.root, 'peer-without-sessions')
      await mkdir(peer, { recursive: true })
      seedSession(
        env.workspace,
        defaultSessionDir(env.agentDir, env.workspace),
        '空间 A 的会话标题',
      )
      seedSession(workspaceB, defaultSessionDir(env.agentDir, workspaceB), '空间 A 的另一个项目')
      seedSession(
        otherEnv.workspace,
        defaultSessionDir(otherEnv.agentDir, otherEnv.workspace),
        '空间 B 的会话',
      )

      const host = await openHost(env)
      await host.decideProjectTrust({ path: peer, trusted: true })
      const recent = await host.listRecentProjects()
      const paths = recent.map((item) => item.path)
      expect(paths).toContain(env.workspace)
      expect(paths).toContain(workspaceB)
      expect(paths).toContain(peer)
      expect(paths).not.toContain(otherEnv.workspace)
      expect(recent.every((item) => item.name.length > 0)).toBe(true)

      const otherHost = await openHost(otherEnv)
      const otherRecent = await otherHost.listRecentProjects()
      expect(otherRecent.map((item) => item.path)).not.toContain(env.workspace)
    } finally {
      await rm(otherEnv.root, { recursive: true, force: true })
    }
  }, 90_000)
})
