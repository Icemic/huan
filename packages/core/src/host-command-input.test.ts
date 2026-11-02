/**
 * G1.3b：命令目录、参数补全、提交守卫、图片能力与文件引用。
 *
 * 真实 Pi SDK + 隔离临时用户空间 + 合成 provider；扩展/模板/skill 都写在
 * 临时 agentDir 内，不读取个人 Pi 配置，也不允许非合成端点联网。
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createHarnessHost,
  type HarnessHost,
  ImageInputUnsupportedError,
  ReservedBuiltinCommandError,
} from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_MODEL_B,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

let env: IsolatedPiEnv
let host: HarnessHost
let fetchStub: TestFetchStub
let savedEnv: Map<string, string | undefined>

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const extensionSource = `export default function (pi) {
  pi.registerCommand('plan', {
    description: '计划一次改动',
    getArgumentCompletions: (prefix) =>
      [
        { value: 'alpha', label: 'alpha', description: '第一项' },
        { value: 'beta', label: 'beta' },
      ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      await ctx.ui.confirm('plan-command', args)
    },
  })
}
`

async function createHost(): Promise<HarnessHost> {
  return createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    // 保留扩展/模板/skill 发现，只关闭主题与祖先上下文。
    resourceLoaderOptions: {
      ...TEST_RESOURCE_ISOLATION,
      noSkills: false,
      noPromptTemplates: false,
    },
  })
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-command-test-')
  await mkdir(join(env.agentDir, 'extensions'), { recursive: true })
  await writeFile(join(env.agentDir, 'extensions', 'plan.ts'), extensionSource)
  await mkdir(join(env.agentDir, 'prompts'), { recursive: true })
  await writeFile(
    join(env.agentDir, 'prompts', 'review.md'),
    '---\ndescription: 审查改动\nargument-hint: "[focus]"\n---\n请审查：$ARGUMENTS\n',
  )
  await mkdir(join(env.agentDir, 'skills', 'demo-skill'), { recursive: true })
  await writeFile(
    join(env.agentDir, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示 Skill\n---\n按步骤执行。\n',
  )
  fetchStub = installTestFetch('ok')
  host = await createHost()
})

afterEach(async () => {
  fetchStub.restore()
  await host.dispose()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('命令目录与参数补全', () => {
  it('活会话目录包含扩展、模板与 skill，并保留参数提示和来源', async () => {
    const threadId = (await host.createThread()).metadata.id
    const catalog = await host.listCommands({ threadId })
    expect(catalog.skillCommandsEnabled).toBe(true)

    const extension = catalog.commands.find((command) => command.name === 'plan')
    expect(extension).toMatchObject({
      source: 'extension',
      description: '计划一次改动',
      supportsArguments: true,
    })
    expect(extension?.sourceInfo.path).toContain('plan.ts')

    const prompt = catalog.commands.find((command) => command.name === 'review')
    expect(prompt).toMatchObject({
      source: 'prompt',
      argumentHint: '[focus]',
      supportsArguments: true,
    })

    const skill = catalog.commands.find((command) => command.name === 'skill:demo-skill')
    expect(skill).toMatchObject({ source: 'skill', supportsArguments: true })

    const completions = await host.getCommandArgumentCompletions({
      threadId,
      name: 'plan',
      prefix: 'a',
    })
    expect(completions).toEqual([{ value: 'alpha', label: 'alpha', description: '第一项' }])
  })

  it('模板参数与skill调用由真实SDK展开，不只返回目录', async () => {
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '/review correctness' })
    await new Promise<void>((resolve) => {
      const release = host.subscribe(threadId, (event) => {
        if (event.type !== 'agent_settled') return
        release()
        resolve()
      })
    })
    let snapshot = await host.getThread(threadId)
    expect(
      snapshot.messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('请审查：correctness'),
      ),
    ).toBe(true)
    await host.cancelRun(threadId)
    await host.sendMessage(threadId, { content: '/skill:demo-skill 按要求执行' })
    await new Promise<void>((resolve) => {
      const release = host.subscribe(threadId, (event) => {
        if (event.type !== 'agent_settled') return
        release()
        resolve()
      })
    })
    snapshot = await host.getThread(threadId)
    expect(
      snapshot.messages.some(
        (message) =>
          message.role === 'user' && JSON.stringify(message.content).includes('按步骤执行'),
      ),
    ).toBe(true)
  })

  it('空白页按固定起始目录读取资源目录，不创建会话', async () => {
    const before = (await host.listThreads()).length
    const catalog = await host.listCommands({ workspacePath: env.workspace })
    expect(catalog.commands.some((command) => command.name === 'plan')).toBe(true)
    expect(catalog.commands.some((command) => command.name === 'review')).toBe(true)
    expect((await host.listThreads()).length).toBe(before)
    const completions = await host.getCommandArgumentCompletions({
      workspacePath: env.workspace,
      name: 'plan',
      prefix: 'b',
    })
    expect(completions.map((item) => item.value)).toEqual(['beta'])
  })
})

describe('提交前守卫', () => {
  it('已知内置 slash 不会作为普通 prompt 进入模型', async () => {
    const threadId = (await host.createThread()).metadata.id
    await expect(host.sendMessage(threadId, { content: '/model test-model-a' })).rejects.toThrow(
      ReservedBuiltinCommandError,
    )
    expect(fetchStub.calls()).toBe(0)
    expect((await host.getThread(threadId)).messages).toHaveLength(0)

    // 发送首条消息也遵守同一守卫；创建与发送是两步，发送被拒不改变历史。
    const created = await host.createThread()
    const before = (await host.listThreads()).length
    await expect(host.sendMessage(created.metadata.id, { content: '/settings' })).rejects.toThrow(
      ReservedBuiltinCommandError,
    )
    expect((await host.listThreads()).length).toBe(before)
    expect(fetchStub.calls()).toBe(0)
  })

  it('未知 slash 不当作内置命令拦截', async () => {
    const threadId = (await host.createThread()).metadata.id
    await expect(host.sendMessage(threadId, { content: '/not-a-builtin hello' })).resolves.toEqual({
      disposition: 'started',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchStub.calls()).toBe(1)
  })

  it('当前模型不支持图片时在预检前拒绝，且不写历史', async () => {
    const threadId = (
      await host.createThread({
        model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_B },
      })
    ).metadata.id
    await expect(
      host.sendMessage(threadId, {
        content: '看这张图',
        attachments: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZkAAAAASUVORK5CYII=',
          },
        ],
      }),
    ).rejects.toThrow(ImageInputUnsupportedError)
    expect(fetchStub.calls()).toBe(0)
    expect((await host.getThread(threadId)).messages).toHaveLength(0)
  })

  it('首条发送的图片能力在预检前校验（创建后发送唯一路径）', async () => {
    const created = await host.createThread({
      model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_B },
    })
    await expect(
      host.sendMessage(created.metadata.id, {
        content: '图片',
        attachments: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZkAAAAASUVORK5CYII=',
          },
        ],
      }),
    ).rejects.toThrow(ImageInputUnsupportedError)
    expect(fetchStub.calls()).toBe(0)
    await host.deleteThread(created.metadata.id)
  })
})

describe('文件引用查询', () => {
  it('按工作区成员返回 @alias 引用，跳过隐藏/依赖目录并限制结果数', async () => {
    await mkdir(join(env.workspace, 'src'), { recursive: true })
    await mkdir(join(env.workspace, 'docs'), { recursive: true })
    await mkdir(join(env.workspace, '.hidden'), { recursive: true })
    await mkdir(join(env.workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(env.workspace, 'src', 'main.ts'), 'export {}\n')
    await writeFile(join(env.workspace, 'docs', '指南 文件.md'), '# 指南\n')
    await writeFile(join(env.workspace, '.hidden', 'secret.txt'), 'secret\n')
    await writeFile(join(env.workspace, 'node_modules', 'pkg', 'index.js'), 'module\n')
    await writeFile(join(env.workspace, 'docs', 'second.md'), '# second\n')

    const workspace = (await host.listWorkspaces()).workspaces.find((item) =>
      item.projects.some((project) => project.path === env.workspace),
    )
    expect(workspace).toBeDefined()
    const alias = workspace?.projects.find((project) => project.path === env.workspace)?.alias

    const main = await host.searchFiles({
      workspaceId: workspace?.id,
      workspacePath: env.workspace,
      query: 'main',
    })
    expect(main.files[0]).toMatchObject({
      reference: `@${alias}/src/main.ts`,
      relativePath: 'src/main.ts',
      kind: 'file',
    })

    const chinese = await host.searchFiles({
      workspaceId: workspace?.id,
      workspacePath: env.workspace,
      query: '指南',
    })
    expect(chinese.files.map((file) => file.relativePath)).toContain('docs/指南 文件.md')

    const hidden = await host.searchFiles({
      workspaceId: workspace?.id,
      workspacePath: env.workspace,
      query: 'secret',
    })
    expect(hidden.files).toHaveLength(0)

    const dependency = await host.searchFiles({
      workspaceId: workspace?.id,
      workspacePath: env.workspace,
      query: 'node_modules',
    })
    expect(dependency.files).toHaveLength(0)

    const limited = await host.searchFiles({
      workspaceId: workspace?.id,
      workspacePath: env.workspace,
      query: '',
      limit: 1,
    })
    expect(limited.files).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it('遵守嵌套gitignore与否定规则，避免返回被忽略文件', async () => {
    await writeFile(join(env.workspace, '.gitignore'), '*.log\nsecret/\n')
    await mkdir(join(env.workspace, 'src'), { recursive: true })
    await mkdir(join(env.workspace, 'secret'), { recursive: true })
    await writeFile(join(env.workspace, 'a.log'), 'ignored')
    await writeFile(join(env.workspace, 'secret', 'hidden.txt'), 'ignored')
    await writeFile(join(env.workspace, 'src', '.gitignore'), '!keep.log\n*.tmp\n')
    await writeFile(join(env.workspace, 'src', 'keep.log'), 'visible')
    await writeFile(join(env.workspace, 'src', 'hidden.tmp'), 'ignored')
    const result = await host.searchFiles({ workspacePath: env.workspace })
    const paths = result.files.map((file) => file.relativePath)
    expect(paths).toContain('src/keep.log')
    expect(paths).not.toContain('a.log')
    expect(paths).not.toContain('secret/hidden.txt')
    expect(paths).not.toContain('src/hidden.tmp')
  })

  it('不遍历符号链接目录，避免逃逸工作区', async () => {
    const outside = join(env.root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'outside-secret.txt'), 'secret\n')
    const link = join(env.workspace, 'linked')
    try {
      await symlink(outside, link, 'junction')
    } catch {
      // 平台不允许创建链接时跳过该断言；隐藏/依赖目录用例仍覆盖范围限制。
      return
    }
    const result = await host.searchFiles({
      workspacePath: env.workspace,
      query: 'outside-secret',
    })
    expect(result.files).toHaveLength(0)
    await rm(link, { recursive: true, force: true })
  })
})
