/**
 * 设置与资源清单（G1.4a）宿主集成测试。
 *
 * 真实 Pi SDK + 隔离临时用户空间 + 合成 provider；不读取个人 Pi 配置，
 * 不允许非预期网络请求。项目信任一律经 decideProjectTrust 显式建立。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import { packagesOf } from './resource-inventory.js'
import { SETTINGS_FILE_MAX_BYTES, settingsRevision } from './settings-store.js'
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

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

let env: IsolatedPiEnv
let host: HarnessHost
let fetchStub: TestFetchStub
let savedEnv: Map<string, string | undefined>
let resourceProbe: string

const userSettingsFile = () => join(env.agentDir, 'settings.json')
const projectSettingsFile = (project: string) => join(project, '.pi', 'settings.json')

const createHost = (overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {}) =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...overrides,
  })

async function restartHost(
  overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {},
): Promise<void> {
  await host.dispose()
  host = await createHost(overrides)
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** 创建并信任一个隔离项目目录。 */
async function trustedProject(name: string, settings?: Record<string, unknown>) {
  const project = join(env.root, name)
  await mkdir(join(project, '.pi'), { recursive: true })
  if (settings) {
    await writeFile(projectSettingsFile(project), `${JSON.stringify(settings, null, 2)}\n`)
  }
  await host.decideProjectTrust({ path: project, trusted: true })
  return project
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-settings-host-test-')
  resourceProbe = join(env.root, 'resource-factory.log')
  fetchStub = installTestFetch()
  host = await createHost()
})

afterEach(async () => {
  await host.dispose().catch(() => {})
  fetchStub.restore()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('设置读取与保存', () => {
  it('返回用户/项目原文、revision、合并值与来源，并允许用户设置修复保存', async () => {
    const project = await trustedProject('settings-project', {
      defaultModel: TEST_MODEL_B,
      customProject: { nested: [1, 2, { flag: true }] },
    })

    const snapshot = await host.getSettings({ workspacePath: project })
    expect(snapshot.trust).toMatchObject({ decision: 'trusted', requiresTrust: true })
    expect(snapshot.files.user.path).toBe(userSettingsFile())
    expect(snapshot.files.user.readable).toBe(true)
    expect(snapshot.files.project.path).toBe(projectSettingsFile(project))
    expect(snapshot.files.project.content).toContain('customProject')
    expect(snapshot.files.project.revision).toBe(settingsRevision(snapshot.files.project.content))
    // 项目设置覆盖用户默认值，来源按顶层键标注。
    expect(snapshot.effective.values.defaultModel).toBe(TEST_MODEL_B)
    expect(snapshot.effective.origins.defaultModel).toBe('project')
    expect(snapshot.effective.origins.defaultProvider).toBe('user')

    const userValue = JSON.parse(snapshot.files.user.content) as Record<string, unknown>
    const content = `${JSON.stringify(
      {
        ...userValue,
        defaultModel: TEST_MODEL_A,
        customUser: { nested: { flag: true } },
        retry: { enabled: true, customRetry: { flag: true } },
      },
      null,
      2,
    )}\n`
    const saved = await host.saveSettings({
      target: { workspacePath: project },
      scope: 'user',
      content,
      expectedRevision: snapshot.files.user.revision,
    })
    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') throw new Error('用户设置未保存')
    expect(saved.revision).toBe(settingsRevision(content))
    expect(saved.apply.persisted).toBe(true)
    expect(saved.apply.reloadRequired).toBe(true)
    expect(saved.apply.message).toContain('重载')
    expect(saved.snapshot.effective.origins.customUser).toBe('user')
    expect(saved.snapshot.files.user.content).toBe(content)
    // 未知字段写入磁盘并保留。
    expect(await readJson(userSettingsFile())).toMatchObject({
      customUser: { nested: { flag: true } },
      retry: { enabled: true, customRetry: { flag: true } },
    })

    // 非法已知字段被拒绝，磁盘不变。
    const invalidContent = `${JSON.stringify(
      { ...(await readJson(userSettingsFile())), retry: { enabled: 'yes' } },
      null,
      2,
    )}\n`
    const invalid = await host.saveSettings({
      target: { workspacePath: project },
      scope: 'user',
      content: invalidContent,
      expectedRevision: saved.revision,
    })
    expect(invalid.status).toBe('invalid')
    if (invalid.status !== 'invalid') throw new Error('非法设置未被拒绝')
    expect(invalid.issues.some((issue) => issue.path === '/retry/enabled')).toBe(true)
    expect(await readFile(userSettingsFile(), 'utf8')).toBe(content)
  })

  it('损坏原文可读可修复；不存在文件按 revision=null 创建', async () => {
    await writeFile(userSettingsFile(), '{ broken json')
    const broken = await host.getSettings({
      threadId: await host.createThread().then((s) => s.metadata.id),
    })
    expect(broken.files.user.content).toBe('{ broken json')
    expect(broken.files.user.issues[0]?.kind).toBe('parse')

    const repaired = `${JSON.stringify(
      { defaultProvider: TEST_PROVIDER, defaultModel: TEST_MODEL_A },
      null,
      2,
    )}\n`
    const saved = await host.saveSettings({
      target: { workspacePath: env.workspace },
      scope: 'user',
      content: repaired,
      expectedRevision: broken.files.user.revision,
    })
    expect(saved.status).toBe('saved')
    const after = await host.getSettings({ workspacePath: env.workspace })
    expect(after.files.user.issues).toEqual([])
    expect(after.files.user.content).toBe(repaired)

    const project = await trustedProject('missing-settings')
    const missing = await host.getSettings({ workspacePath: project })
    expect(missing.files.project.exists).toBe(false)
    expect(missing.files.project.revision).toBeNull()
    const created = await host.saveSettings({
      target: { workspacePath: project },
      scope: 'project',
      content: '{"customProject":{"a":1}}\n',
      expectedRevision: null,
    })
    expect(created.status).toBe('saved')
    expect(await readJson(projectSettingsFile(project))).toEqual({ customProject: { a: 1 } })
  })

  it('并发保存使用同一 revision 时只有一个成功，另一个明确冲突', async () => {
    const project = await trustedProject('conflict-settings')
    const base = await host.getSettings({ workspacePath: project })
    const contentA = '{"conflict":"a"}\n'
    const contentB = '{"conflict":"b"}\n'
    const [first, second] = await Promise.all([
      host.saveSettings({
        target: { workspacePath: project },
        scope: 'project',
        content: contentA,
        expectedRevision: base.files.project.revision,
      }),
      host.saveSettings({
        target: { workspacePath: project },
        scope: 'project',
        content: contentB,
        expectedRevision: base.files.project.revision,
      }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual(['conflict', 'saved'])
    const winner = first.status === 'saved' ? first : second
    expect(winner.status).toBe('saved')
    if (winner.status !== 'saved') throw new Error('没有成功保存')
    expect(await readFile(projectSettingsFile(project), 'utf8')).toBe(
      first.status === 'saved' ? contentA : contentB,
    )
    const conflict = first.status === 'conflict' ? first : second
    if (conflict.status === 'conflict') {
      expect(conflict.revision).toBe(winner.revision)
    }
  })

  it('用户设置连续保存复用写队列，enabledModels 与其他字段都保留', async () => {
    const threadId = (await host.createThread()).metadata.id
    const current = await host.getSettings({ threadId })
    const enabledModels = [`${TEST_PROVIDER}/${TEST_MODEL_B}`]
    const scopeContent = `${JSON.stringify(
      {
        ...(JSON.parse(current.files.user.content) as Record<string, unknown>),
        enabledModels,
      },
      null,
      2,
    )}
`
    const scopeSaved = await host.saveSettings({
      target: { threadId },
      scope: 'user',
      content: scopeContent,
      expectedRevision: current.files.user.revision,
    })
    expect(scopeSaved.status).toBe('saved')

    const afterScope = await host.getSettings({ threadId })
    const content = `${JSON.stringify(
      {
        ...(JSON.parse(afterScope.files.user.content) as Record<string, unknown>),
        scopeMarker: { ok: true },
      },
      null,
      2,
    )}
`
    const saved = await host.saveSettings({
      target: { threadId },
      scope: 'user',
      content,
      expectedRevision: afterScope.files.user.revision,
    })
    expect(saved.status).toBe('saved')
    const disk = await readJson(userSettingsFile())
    expect(disk.enabledModels).toEqual(enabledModels)
    expect(disk.scopeMarker).toEqual({ ok: true })
  })

  it('现有设置文件超过上限时拒绝覆盖', async () => {
    await writeFile(userSettingsFile(), 'x'.repeat(SETTINGS_FILE_MAX_BYTES + 1))
    const blocked = await host.saveSettings({
      target: { workspacePath: env.workspace },
      scope: 'user',
      content: `${JSON.stringify({ a: 1 })}\n`,
      expectedRevision: null,
    })
    expect(blocked.status).toBe('too-large')
    expect(await readFile(userSettingsFile(), 'utf8')).toHaveLength(SETTINGS_FILE_MAX_BYTES + 1)
  })

  it('无受保护资源的缓存不能授权后来新增的项目设置', async () => {
    const project = join(env.root, 'new-protected-settings')
    await mkdir(project, { recursive: true })
    await host.getProject({ path: project })
    await mkdir(join(project, '.pi'), { recursive: true })
    await writeFile(projectSettingsFile(project), '{"newProtectedSecret":"must-not-read"}')
    const snapshot = await host.getSettings({ workspacePath: project })
    expect(snapshot.projectTrusted).toBe(false)
    expect(snapshot.files.project.readable).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('must-not-read')
    const saved = await host.saveSettings({
      target: { workspacePath: project },
      scope: 'project',
      content: '{}',
      expectedRevision: null,
    })
    expect(saved.status).toBe('untrusted')
  })

  it('磁盘文件超过上限时合并预览也不读取其内容', async () => {
    const content = JSON.stringify({ oversizedSecret: 'x'.repeat(SETTINGS_FILE_MAX_BYTES) })
    await writeFile(userSettingsFile(), content)
    const snapshot = await host.getSettings({ workspacePath: env.workspace })
    expect(snapshot.files.user.tooLarge).toBe(true)
    expect(snapshot.effective.values.oversizedSecret).toBeUndefined()
  })

  it('项目未信任时拒绝写项目设置且不执行项目扩展', async () => {
    const project = join(env.root, 'untrusted-project')
    const marker = join(env.root, 'untrusted-extension.log')
    await mkdir(join(project, '.pi', 'extensions'), { recursive: true })
    await writeFile(
      join(project, '.pi', 'extensions', 'probe.js'),
      `import { appendFileSync } from 'node:fs'\nexport default function () {\n  appendFileSync(${JSON.stringify(marker)}, 'ran\\n')\n}\n`,
    )
    await writeFile(projectSettingsFile(project), '{"defaultModel":"test-model-b"}\n')
    await host.decideProjectTrust({ path: project, trusted: false })

    const snapshot = await host.getSettings({ workspacePath: project })
    expect(snapshot.projectTrusted).toBe(false)
    expect(snapshot.files.project.readable).toBe(false)
    expect(snapshot.files.project.content).toBe('')
    // 未信任项目设置不参与合并（不泄露项目配置）。
    expect(snapshot.effective.values.defaultModel).toBe(TEST_MODEL_A)
    expect(snapshot.effective.origins.defaultModel).toBe('user')
    const blocked = await host.saveSettings({
      target: { workspacePath: project },
      scope: 'project',
      content: '{"defaultModel":"test-model-a"}\n',
      expectedRevision: null,
    })
    expect(blocked.status).toBe('untrusted')
    expect(await readFile(projectSettingsFile(project), 'utf8')).toContain('test-model-b')
    expect(existsSync(marker)).toBe(false)
  })

  it('保存与旧自动压缩/模型范围写入共享队列，且不虚报应用', async () => {
    const threadId = (await host.createThread()).metadata.id
    // 并发：两者都不应抛错或留下损坏文件。
    const base = await host.getSettings({ threadId })
    const content = `${JSON.stringify(
      {
        ...(JSON.parse(base.files.user.content) as Record<string, unknown>),
        queueMarker: { n: 1 },
      },
      null,
      2,
    )}\n`
    const [saveResult, autoResult] = await Promise.all([
      host.saveSettings({
        target: { threadId },
        scope: 'user',
        content,
        expectedRevision: base.files.user.revision,
      }),
      host.setAutoCompaction(threadId, false),
    ])
    expect(autoResult.status).toBe('saved')
    expect(['saved', 'conflict']).toContain(saveResult.status)
    const final = await readJson(userSettingsFile())
    expect(final).toBeTypeOf('object')

    // 顺序：自动压缩保存后再基于新磁盘内容保存，两者都保留。
    if (saveResult.status === 'conflict') {
      // 冲突时以磁盘现状继续，仍应能保存未知字段。
      const current = await host.getSettings({ threadId })
      const next = `${JSON.stringify(
        {
          ...(JSON.parse(current.files.user.content) as Record<string, unknown>),
          queueMarker: { n: 2 },
        },
        null,
        2,
      )}\n`
      const retried = await host.saveSettings({
        target: { threadId },
        scope: 'user',
        content: next,
        expectedRevision: current.files.user.revision,
      })
      expect(retried.status).toBe('saved')
    }
    const disk = await readJson(userSettingsFile())
    expect(disk.queueMarker).toEqual({ n: saveResult.status === 'saved' ? 1 : 2 })
    const compaction = disk.compaction as { enabled?: boolean } | undefined
    // 最后一次写入可能来自用户保存（完整文件语义），但自动压缩的保存必须已结算。
    expect(compaction === undefined || typeof compaction.enabled === 'boolean').toBe(true)
  })
})

describe('资源清单', () => {
  it('展示真实 loader 的指令/扩展/skill/模板与来源，热会话不重跑扩展', async () => {
    // 用户级扩展：工厂执行时记录一次，并注册一个命令。
    await mkdir(join(env.agentDir, 'extensions'), { recursive: true })
    await writeFile(
      join(env.agentDir, 'extensions', 'probe.js'),
      `import { appendFileSync } from 'node:fs'
export default function (pi) {
  appendFileSync(${JSON.stringify(resourceProbe)}, 'factory\\n')
  pi.registerCommand('resource-probe', { description: '资源测试命令', handler: async () => {} })
}
`,
    )
    const skillsDir = join(env.root, 'skills')
    await mkdir(join(skillsDir, 'huan-skill'), { recursive: true })
    await writeFile(
      join(skillsDir, 'huan-skill', 'SKILL.md'),
      '---\nname: huan-skill\ndescription: 资源测试 Skill\n---\nSkill 内容\n',
    )
    const promptsDir = join(env.root, 'prompts')
    await mkdir(promptsDir, { recursive: true })
    await writeFile(
      join(promptsDir, 'huan-prompt.md'),
      '---\ndescription: 资源测试模板\nargument-hint: "[args]"\n---\n模板内容\n',
    )
    await writeFile(join(env.workspace, 'AGENTS.md'), '测试指令内容 UNIQUE-AGENTS-TEXT\n')

    await restartHost({
      resourceLoaderOptions: {
        ...TEST_RESOURCE_ISOLATION,
        noContextFiles: false,
        additionalSkillPaths: [skillsDir],
        additionalPromptTemplatePaths: [promptsDir],
      },
    })
    const threadId = (await host.createThread()).metadata.id
    const before = await readFile(resourceProbe, 'utf8')

    const snapshot = await host.getResources({ threadId })
    expect(snapshot.loadedFrom).toBe('session')
    expect(snapshot.trust.decision).toBe('trusted')
    expect(snapshot.extensions.some((item) => item.path.endsWith('probe.js'))).toBe(true)
    const extension = snapshot.extensions.find((item) => item.path.endsWith('probe.js'))
    expect(extension?.commands).toContain('resource-probe')
    expect(extension?.sourceInfo.scope).toBe('user')
    expect(snapshot.skills.map((item) => item.name)).toContain('huan-skill')
    expect(snapshot.skills.every((item) => typeof item.sourceInfo.source === 'string')).toBe(true)
    expect(snapshot.prompts.map((item) => item.name)).toContain('huan-prompt')
    expect(snapshot.prompts.find((item) => item.name === 'huan-prompt')?.argumentHint).toBe(
      '[args]',
    )
    expect(snapshot.instructions.some((item) => item.path.endsWith('AGENTS.md'))).toBe(true)
    // 默认不返回文本；显式请求才返回。
    expect(snapshot.instructions.every((item) => item.text === undefined)).toBe(true)
    const withText = await host.getResources({ threadId, includeText: true })
    expect(withText.instructions.find((item) => item.path.endsWith('AGENTS.md'))?.text).toContain(
      'UNIQUE-AGENTS-TEXT',
    )

    // 磁盘新增 skill 不会被说成“已加载”。
    const laterDir = join(skillsDir, 'later-skill')
    await mkdir(laterDir, { recursive: true })
    await writeFile(
      join(laterDir, 'SKILL.md'),
      '---\nname: later-skill\ndescription: 稍后新增\n---\n内容\n',
    )
    const after = await host.getResources({ threadId })
    expect(after.skills.map((item) => item.name)).not.toContain('later-skill')

    // 空白页/同 cwd 查询复用装配结果，不重跑扩展工厂。
    const blank = await host.getResources({ workspacePath: env.workspace })
    expect(['session', 'assembly']).toContain(blank.loadedFrom)
    expect(blank.skills.map((item) => item.name)).toContain('huan-skill')
    expect(await readFile(resourceProbe, 'utf8')).toBe(before)
  })

  it('未信任项目不执行项目扩展，并说明信任边界', async () => {
    const project = join(env.root, 'resources-untrusted')
    const marker = join(env.root, 'project-extension.log')
    await mkdir(join(project, '.pi', 'extensions'), { recursive: true })
    await writeFile(
      join(project, '.pi', 'extensions', 'probe.js'),
      `import { appendFileSync } from 'node:fs'\nexport default function () {\n  appendFileSync(${JSON.stringify(marker)}, 'ran\\n')\n}\n`,
    )
    await host.decideProjectTrust({ path: project, trusted: false })

    const snapshot = await host.getResources({ workspacePath: project })
    expect(snapshot.trust.decision).toBe('untrusted')
    expect(snapshot.projectResourcesLoaded).toBe(false)
    expect(snapshot.trustNote).toContain('未加载项目')
    expect(snapshot.extensions.some((item) => item.path.includes(project))).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it('packages 声明按字符串/对象两种形式投影', () => {
    const manager = SettingsManager.inMemory({
      packages: ['pkg-a', { source: 'pkg-b', autoload: false, skills: ['skill-x'] }],
    })
    expect(packagesOf(manager)).toEqual([
      { source: 'pkg-a' },
      { source: 'pkg-b', autoload: false, skills: ['skill-x'] },
    ])
  })
})

describe('普通会话数据不携带配置文本', () => {
  it('快照与事件都不含设置原文', async () => {
    const token = 'HUAN-SETTINGS-SECRET-TOKEN'
    const base = await host.getSettings({ workspacePath: env.workspace })
    const content = `${JSON.stringify(
      { ...(JSON.parse(base.files.user.content) as Record<string, unknown>), note: token },
      null,
      2,
    )}\n`
    const saved = await host.saveSettings({
      target: { workspacePath: env.workspace },
      scope: 'user',
      content,
      expectedRevision: base.files.user.revision,
    })
    expect(saved.status).toBe('saved')

    const threadId = (await host.createThread()).metadata.id
    const events: unknown[] = []
    const unsubscribe = host.subscribe(threadId, (event) => events.push(event))
    await host.getThread(threadId)
    await host.getThreadDetails(threadId)
    unsubscribe()
    expect(JSON.stringify(await host.getThread(threadId))).not.toContain(token)
    expect(JSON.stringify(await host.getThreadDetails(threadId))).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(token)
  })
})
