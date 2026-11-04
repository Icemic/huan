import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverSubagentAgents,
  type SubagentAgentDefinition,
  SubagentDefinitionError,
} from './subagent-definitions.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.length = 0
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'huan-subagent-definitions-'))
  roots.push(root)
  return root
}

async function writeAgent(dir: string, fileName: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, fileName)
  await writeFile(filePath, content, 'utf8')
  return filePath
}

function findAgent(
  agents: readonly SubagentAgentDefinition[],
  name: string,
): SubagentAgentDefinition {
  const agent = agents.find((item) => item.name === name)
  if (!agent) throw new Error(`missing agent: ${name}`)
  return agent
}

describe('子agent定义发现', () => {
  it('读取用户 Markdown 字段，分别保留 tools 字符串、数组与明确空数组', async () => {
    const root = await tempRoot()
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const agentsDir = join(agentDir, 'agents')

    const stringToolsPath = await writeAgent(
      agentsDir,
      'string-tools.md',
      [
        '---',
        'name: string-tools',
        'description: 使用字符串工具列表',
        'model: test/model-a',
        'tools: read, bash ,grep',
        '---',
        '',
        '字符串正文',
      ].join('\n'),
    )
    const arrayToolsPath = await writeAgent(
      agentsDir,
      'array-tools.md',
      [
        '---',
        'name: array-tools',
        'description: 使用数组工具列表',
        'tools:',
        '  - read',
        '  - write',
        '---',
        '数组正文',
      ].join('\n'),
    )
    const emptyToolsPath = await writeAgent(
      agentsDir,
      'empty-tools.md',
      [
        '---',
        'name: empty-tools',
        'description: 明确禁用工具',
        'tools: []',
        '---',
        '空工具正文',
      ].join('\n'),
    )
    await writeAgent(
      agentsDir,
      'inherit-tools.md',
      ['---', 'name: inherit-tools', 'description: 未指定工具', '---', '继承正文'].join('\n'),
    )

    const discovery = discoverSubagentAgents({ agentDir, cwd })
    expect(discovery.userDir).toBe(agentsDir)
    expect(discovery.projectDir).toBeNull()
    expect(discovery.agents).toHaveLength(4)

    const stringTools = findAgent(discovery.agents, 'string-tools')
    expect(stringTools).toEqual({
      name: 'string-tools',
      description: '使用字符串工具列表',
      model: 'test/model-a',
      tools: ['read', 'bash', 'grep'],
      body: '字符串正文',
      source: 'user',
      filePath: stringToolsPath,
    })
    expect(findAgent(discovery.agents, 'array-tools')).toMatchObject({
      tools: ['read', 'write'],
      source: 'user',
      filePath: arrayToolsPath,
    })
    expect(findAgent(discovery.agents, 'empty-tools')).toMatchObject({
      tools: [],
      filePath: emptyToolsPath,
    })
    expect(findAgent(discovery.agents, 'inherit-tools').tools).toBeUndefined()
  })

  it('both 使用最近祖先项目目录并让项目定义覆盖同名用户定义', async () => {
    const root = await tempRoot()
    const agentDir = join(root, 'agent')
    const repo = join(root, 'repo')
    const cwd = join(repo, 'packages', 'app', 'src')
    const userAgentsDir = join(agentDir, 'agents')
    const projectAgentsDir = join(repo, 'packages', 'app', '.pi', 'agents')

    await writeAgent(
      userAgentsDir,
      'review.md',
      ['---', 'name: review', 'description: 用户 review', 'tools: read', '---', '用户正文'].join(
        '\n',
      ),
    )
    await writeAgent(
      userAgentsDir,
      'plan.md',
      ['---', 'name: plan', 'description: 用户 plan', '---', '用户 plan 正文'].join('\n'),
    )
    await writeAgent(
      projectAgentsDir,
      'review.md',
      [
        '---',
        'name: review',
        'description: 项目 review',
        'tools: [read, grep]',
        '---',
        '项目正文',
      ].join('\n'),
    )
    // 更远的祖先同目录不应被选中。
    await writeAgent(
      join(repo, '.pi', 'agents'),
      'review.md',
      ['---', 'name: review', 'description: 根目录 review', '---', '根正文'].join('\n'),
    )
    await mkdir(cwd, { recursive: true })

    const discovery = discoverSubagentAgents({ agentDir, cwd, scope: 'both' })
    expect(discovery.projectDir).toBe(projectAgentsDir)
    expect(discovery.agents.map((agent) => agent.name).sort()).toEqual(['plan', 'review'])
    expect(findAgent(discovery.agents, 'review')).toMatchObject({
      description: '项目 review',
      tools: ['read', 'grep'],
      source: 'project',
      body: '项目正文',
    })
    expect(findAgent(discovery.agents, 'plan')).toMatchObject({
      description: '用户 plan',
      source: 'user',
    })
  })

  it('默认 scope 为 user，并在每次调用时重新读取文件', async () => {
    const root = await tempRoot()
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'work')
    const projectAgentsDir = join(cwd, '.pi', 'agents')
    await mkdir(cwd, { recursive: true })
    await writeAgent(
      projectAgentsDir,
      'project-only.md',
      ['---', 'name: project-only', 'description: 项目定义', '---', '项目正文'].join('\n'),
    )
    const filePath = await writeAgent(
      join(agentDir, 'agents'),
      'review.md',
      ['---', 'name: review', 'description: 第一版', '---', '正文'].join('\n'),
    )

    const first = discoverSubagentAgents({ agentDir, cwd })
    expect(first.agents.map((agent) => agent.name)).toEqual(['review'])
    expect(findAgent(first.agents, 'review').description).toBe('第一版')

    await writeFile(
      filePath,
      ['---', 'name: review', 'description: 第二版', '---', '新正文'].join('\n'),
      'utf8',
    )
    const second = discoverSubagentAgents({ agentDir, cwd })
    expect(findAgent(second.agents, 'review')).toMatchObject({
      description: '第二版',
      body: '新正文',
      source: 'user',
    })
  })

  it('坏文件抛出带路径与原因的错误，而不是静默跳过', async () => {
    const root = await tempRoot()
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const agentsDir = join(agentDir, 'agents')

    const missingDescription = await writeAgent(
      agentsDir,
      'broken.md',
      ['---', 'name: broken', '---', '正文'].join('\n'),
    )

    try {
      discoverSubagentAgents({ agentDir, cwd })
      throw new Error('expected discovery to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentDefinitionError)
      const definitionError = error as SubagentDefinitionError
      expect(definitionError.filePath).toBe(missingDescription)
      expect(definitionError.message).toContain(missingDescription)
      expect(definitionError.message).toContain('description')
    }

    await writeFile(
      missingDescription,
      ['---', 'name: broken', 'description: 坏工具', 'tools: [read, 42]', '---'].join('\n'),
      'utf8',
    )
    try {
      discoverSubagentAgents({ agentDir, cwd })
      throw new Error('expected discovery to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentDefinitionError)
      expect((error as SubagentDefinitionError).message).toContain('tools[1]')
    }
  })

  it('非法 YAML frontmatter 也转换为可理解错误', async () => {
    const root = await tempRoot()
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const filePath = await writeAgent(
      join(agentDir, 'agents'),
      'bad-yaml.md',
      ['---', 'name: [unclosed', 'description: bad', '---'].join('\n'),
    )

    expect(() => discoverSubagentAgents({ agentDir, cwd })).toThrowError(SubagentDefinitionError)
    try {
      discoverSubagentAgents({ agentDir, cwd })
    } catch (error) {
      expect((error as SubagentDefinitionError).filePath).toBe(filePath)
      expect((error as SubagentDefinitionError).message).toContain('frontmatter')
    }
  })
})
