/**
 * MCP 配置解析/合并测试（G1.4d1）。
 *
 * 覆盖固定路径、exposure 通配与别名、namespace 碰撞、项目覆盖、项目 auth 限制、
 * 逐项错误、未知字段、BOM、坏 JSON 秘密不回显、污染键与过度嵌套。
 * 全部使用临时目录。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServerConfig } from './index.js'
import {
  getMcpToolExposure,
  isMcpServerConfigOverride,
  loadMcpConfig,
  MCP_CONFIG_MAX_DEPTH,
  mcpConfigPaths,
  mcpNamespace,
  parseMcpConfigContent,
  resolveMcpExposureAlias,
  validateMcpServerConfig,
} from './index.js'

let root: string
let agentDir: string
let cwd: string
let paths: ReturnType<typeof mcpConfigPaths>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'huan-mcp-config-test-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'workspace')
  await mkdir(agentDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  paths = mcpConfigPaths(agentDir, cwd)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function findServer(loaded: Awaited<ReturnType<typeof loadMcpConfig>>, name: string) {
  return loaded.servers.find((server) => server.name === name)
}

describe('固定路径与 namespace', () => {
  it('用户/项目配置与 Pi 共享，凭据与日志留在 huan 子目录', () => {
    expect(paths.user).toBe(join(agentDir, 'mcp.json'))
    expect(paths.project).toBe(join(cwd, '.pi', 'mcp.json'))
    expect(paths.auth).toBe(join(agentDir, 'huan', 'mcp-auth.json'))
    expect(paths.log).toBe(join(agentDir, 'huan', 'mcp.log'))
    expect(paths.user).not.toBe(paths.auth)
    expect(paths.project).not.toBe(join(cwd, '.huan', 'mcp.json'))
  })

  it('namespace 将 - 归一化为 _', () => {
    expect(mcpNamespace('my-server')).toBe('mcp__my_server')
    expect(mcpNamespace('a_b')).toBe('mcp__a_b')
  })

  it('识别项目 override 形状', () => {
    expect(isMcpServerConfigOverride({ enabled: false })).toBe(true)
    expect(isMcpServerConfigOverride({ exposure: 'hidden' })).toBe(true)
    expect(isMcpServerConfigOverride({ command: 'node' })).toBe(false)
    expect(isMcpServerConfigOverride({ url: 'https://example.com/mcp' })).toBe(false)
    expect(isMcpServerConfigOverride({ type: 'stdio' })).toBe(false)
  })
})

describe('exposure', () => {
  it('别名归一化为当前名称', () => {
    expect(resolveMcpExposureAlias('codemode-deferred')).toBe('codemode')
    expect(resolveMcpExposureAlias('hidden')).toBe('hidden')
    expect(resolveMcpExposureAlias('__proto__')).toBe('__proto__')
    expect(resolveMcpExposureAlias(42)).toBe(42)
  })

  it('精确名优先于通配，通配按对象顺序匹配，最后回退服务器默认值', () => {
    const config: McpServerConfig = {
      command: 'node',
      exposure: 'direct',
      toolExposure: {
        'read_*': 'hidden',
        read_file: 'codemode',
        '*': 'deferred',
      },
    }
    expect(getMcpToolExposure(config, 'read_file')).toBe('codemode')
    expect(getMcpToolExposure(config, 'read_other')).toBe('hidden')
    expect(getMcpToolExposure(config, 'write_file')).toBe('deferred')
    expect(getMcpToolExposure({ command: 'node' }, 'anything')).toBe('codemode')
    expect(getMcpToolExposure({ command: 'node' }, '__proto__')).toBe('codemode')
  })

  it('校验时解析 exposure 与 toolExposure 别名，并保留未知字段', () => {
    const result = validateMcpServerConfig('demo', {
      command: 'node',
      exposure: 'codemode-deferred',
      toolExposure: { 'read_*': 'codemode-deferred' },
      custom: { keep: true },
    })
    expect(typeof result).toBe('object')
    if (typeof result === 'string') return
    expect(result.exposure).toBe('codemode')
    expect(result.toolExposure?.['read_*']).toBe('codemode')
    expect((result as unknown as { custom: unknown }).custom).toEqual({ keep: true })
  })

  it('非法 exposure 的错误不回显配置值', () => {
    const secret = 'HUAN-SECRET-EXPOSURE'
    const result = validateMcpServerConfig('demo', { command: 'node', exposure: secret })
    expect(typeof result).toBe('string')
    expect(result).not.toContain(secret)
  })
})

describe('服务器条目校验', () => {
  it('拒绝非法名称、SSE 与缺少连接方式', () => {
    expect(validateMcpServerConfig('bad name', { command: 'node' })).toContain('名称无效')
    expect(validateMcpServerConfig('demo', { type: 'sse', url: 'https://example.com' })).toContain(
      'SSE',
    )
    expect(validateMcpServerConfig('demo', { enabled: true })).toContain('command')
  })

  it('拒绝无穷 timeout，包括 JSON 数值溢出', () => {
    expect(validateMcpServerConfig('demo', { command: 'node', timeout: Infinity })).toContain(
      '有限',
    )
    const document = parseMcpConfigContent(
      '{"mcpServers":{"demo":{"command":"node","timeout":1e999}}}',
      { scope: 'user', path: paths.user },
    )
    expect(document.servers).toEqual([])
    expect(document.issues[0]?.kind).toBe('invalid-server')
  })

  it('项目完整条目禁止 auth.provider，用户条目允许', () => {
    const raw = JSON.stringify({
      mcpServers: {
        remote: { url: 'https://example.com/mcp', auth: { provider: 'secret-provider' } },
      },
    })
    const user = parseMcpConfigContent(raw, { scope: 'user', path: paths.user })
    expect(user.issues).toEqual([])
    expect(user.servers.map((server) => server.name)).toEqual(['remote'])

    const project = parseMcpConfigContent(raw, { scope: 'project', path: paths.project })
    expect(project.servers).toEqual([])
    expect(project.issues[0]?.kind).toBe('project-auth')
    expect(JSON.stringify(project.issues)).not.toContain('secret-provider')
  })

  it('无效 OAuth 配置逐项报错且不回显值', () => {
    const secret = 'HUAN-SECRET-CALLBACK'
    const result = validateMcpServerConfig('demo', {
      url: 'https://example.com/mcp',
      oauth: { callbackUrl: secret },
    })
    expect(typeof result).toBe('string')
    expect(result).not.toContain(secret)
  })
})

describe('配置解析', () => {
  it('支持 UTF-8 BOM 并保留未知顶层/条目字段', () => {
    const content = `\uFEFF${JSON.stringify({
      mcpServers: {
        demo: { command: 'node', customServerField: { nested: [1, true] } },
      },
      customTop: { keep: 'yes' },
    })}`
    const document = parseMcpConfigContent(content, { scope: 'user', path: paths.user })
    expect(document.issues).toEqual([])
    expect(document.value?.customTop).toEqual({ keep: 'yes' })
    const demoConfig = document.servers[0]?.config
    expect(demoConfig).toBeDefined()
    expect((demoConfig as unknown as { customServerField: unknown }).customServerField).toEqual({
      nested: [1, true],
    })
  })

  it('坏 JSON 只报告位置，不回显可能包含秘密的原文', () => {
    const secret = 'HUAN-SECRET-TOKEN'
    const document = parseMcpConfigContent(`{"mcpServers":{"demo":{"command":"${secret}"}}`, {
      scope: 'user',
      path: paths.user,
    })
    expect(document.servers).toEqual([])
    expect(document.issues[0]?.kind).toBe('parse')
    expect(JSON.stringify(document.issues)).not.toContain(secret)
  })

  it('逐项跳过无效条目，不影响其他有效服务器', () => {
    const document = parseMcpConfigContent(
      JSON.stringify({
        mcpServers: {
          good: { command: 'node' },
          bad: { command: 42 },
          alsoBad: { command: 'node', exposure: 'bogus' },
        },
      }),
      { scope: 'user', path: paths.user },
    )
    expect(document.servers.map((server) => server.name)).toEqual(['good'])
    expect(document.issues.map((issue) => issue.kind)).toEqual(['invalid-server', 'invalid-server'])
  })

  it('项目文件内的完整条目 namespace 碰撞同样被拒绝', () => {
    const document = parseMcpConfigContent(
      JSON.stringify({
        mcpServers: {
          'a-b': { command: 'node' },
          a_b: { command: 'node' },
        },
      }),
      { scope: 'project', path: paths.project },
    )
    expect(document.servers.map((server) => server.name)).toEqual(['a-b'])
    expect(document.issues[0]?.kind).toBe('namespace-collision')
  })

  it('用户文件内的 namespace 碰撞被逐项拒绝', () => {
    const document = parseMcpConfigContent(
      JSON.stringify({
        mcpServers: {
          'a-b': { command: 'node' },
          a_b: { command: 'node' },
        },
      }),
      { scope: 'user', path: paths.user },
    )
    expect(document.servers.map((server) => server.name)).toEqual(['a-b'])
    expect(document.issues[0]?.kind).toBe('namespace-collision')
  })

  it('拒绝原型污染键（含嵌套）', () => {
    const top = parseMcpConfigContent('{"__proto__":{"polluted":true}}', {
      scope: 'user',
      path: paths.user,
    })
    expect(top.issues[0]?.kind).toBe('unsafe-key')
    const nested = parseMcpConfigContent('{"custom":{"constructor":{}}}', {
      scope: 'user',
      path: paths.user,
    })
    expect(nested.issues[0]?.kind).toBe('unsafe-key')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('过度嵌套受控拒绝，不抛递归错误', () => {
    let deep: unknown = {}
    for (let index = 0; index <= MCP_CONFIG_MAX_DEPTH + 5; index += 1) {
      deep = { nested: deep }
    }
    const document = parseMcpConfigContent(JSON.stringify({ mcpServers: {}, extra: deep }), {
      scope: 'user',
      path: paths.user,
    })
    expect(document.issues[0]?.kind).toBe('too-deep')
    expect(document.servers).toEqual([])
  })

  it('形状错误与非法 autoEnableCodemode 被诊断，条目仍可加载', () => {
    const document = parseMcpConfigContent(
      JSON.stringify({
        mcpServers: { demo: { command: 'node' } },
        autoEnableCodemode: 'yes',
      }),
      { scope: 'user', path: paths.user },
    )
    expect(document.issues[0]?.kind).toBe('shape')
    expect(document.servers.map((server) => server.name)).toEqual(['demo'])
    expect(document.autoEnableCodemode).toBeUndefined()

    const badTop = parseMcpConfigContent('[]', { scope: 'user', path: paths.user })
    expect(badTop.issues[0]?.kind).toBe('shape')
    const badServers = parseMcpConfigContent('{"mcpServers":[]}', {
      scope: 'user',
      path: paths.user,
    })
    expect(badServers.issues[0]?.kind).toBe('shape')
  })
})

describe('用户/项目合并', () => {
  it('项目完整条目替换同名用户条目，override 只覆盖三字段并保留连接字段', async () => {
    await writeConfig(paths.user, {
      mcpServers: {
        alpha: { command: 'node', args: ['user'], custom: { keep: true } },
        shared: { command: 'node', args: ['user'], enabled: true },
        'a-b': { command: 'node' },
      },
      autoEnableCodemode: true,
    })
    await writeConfig(paths.project, {
      mcpServers: {
        alpha: { url: 'https://example.com/mcp', headers: { 'X-Test': '1' } },
        shared: {
          enabled: false,
          exposure: 'hidden',
          toolExposure: { 'read_*': 'codemode-deferred' },
        },
        a_b: { command: 'node' },
      },
      autoEnableCodemode: false,
    })

    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    expect(loaded.projectConfig).toBe(paths.project)
    expect(loaded.autoEnableCodemode).toBe(false)

    const alpha = findServer(loaded, 'alpha')
    expect(alpha?.scope).toBe('project')
    expect(alpha?.source).toBe(paths.project)
    expect(alpha?.config).toMatchObject({ url: 'https://example.com/mcp' })
    const alphaConfig = alpha?.config
    expect(alphaConfig).toBeDefined()
    expect((alphaConfig as unknown as { custom?: unknown }).custom).toBeUndefined()

    const shared = findServer(loaded, 'shared')
    expect(shared?.scope).toBe('user')
    expect(shared?.source).toBe(paths.user)
    expect(shared?.override).toBe(paths.project)
    expect(shared?.config).toMatchObject({
      command: 'node',
      args: ['user'],
      enabled: false,
      exposure: 'hidden',
      toolExposure: { 'read_*': 'codemode' },
    })

    // 用户 a-b 与项目 a_b 命名空间冲突，项目条目被跳过。
    expect(findServer(loaded, 'a-b')?.scope).toBe('user')
    expect(findServer(loaded, 'a_b')).toBeUndefined()
    expect(loaded.issues.some((issue) => issue.kind === 'namespace-collision')).toBe(true)
    // 诊断只归属当前两个配置作用域，不再指向旧隔离目录。
    expect(
      loaded.issues.every((issue) => issue.file === paths.user || issue.file === paths.project),
    ).toBe(true)
  })

  it('项目 override 只允许三个字段；多项错误逐项报告', async () => {
    await writeConfig(paths.user, {
      mcpServers: {
        demo: { command: 'node', args: ['user'] },
        remote: { url: 'https://example.com/mcp', auth: { provider: 'user-provider' } },
      },
    })
    await writeConfig(paths.project, {
      mcpServers: {
        demo: { enabled: false, timeout: 5 },
        remote: { auth: { provider: 'project-provider' } },
        missing: { enabled: false },
        invalidExposure: { exposure: 'bogus' },
      },
    })

    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    expect(findServer(loaded, 'demo')?.config).toMatchObject({
      command: 'node',
      args: ['user'],
    })
    const demoConfig = findServer(loaded, 'demo')?.config
    expect(demoConfig).toBeDefined()
    expect((demoConfig as { enabled?: boolean }).enabled).toBeUndefined()
    expect(findServer(loaded, 'remote')?.scope).toBe('user')
    expect(findServer(loaded, 'missing')).toBeUndefined()
    expect(findServer(loaded, 'invalidExposure')).toBeUndefined()
    expect(loaded.issues.filter((issue) => issue.kind === 'invalid-override').length).toBe(4)
  })

  it('项目 override 保留用户条目继承的 auth，并应用三个字段', async () => {
    await writeConfig(paths.user, {
      mcpServers: {
        remote: { url: 'https://example.com/mcp', auth: { provider: 'user-provider' } },
      },
    })
    await writeConfig(paths.project, {
      mcpServers: {
        remote: {
          enabled: false,
          exposure: 'direct',
          toolExposure: { '*': 'hidden' },
        },
      },
    })
    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    const remote = findServer(loaded, 'remote')
    expect(remote?.config).toMatchObject({
      url: 'https://example.com/mcp',
      auth: { provider: 'user-provider' },
      enabled: false,
      exposure: 'direct',
      toolExposure: { '*': 'hidden' },
    })
    expect(remote?.override).toBe(paths.project)
    expect(loaded.issues).toEqual([])
  })

  it('项目完整条目禁止 auth.provider；用户条目允许', async () => {
    await writeConfig(paths.user, {
      mcpServers: {
        remote: { url: 'https://example.com/mcp', auth: { provider: 'user-provider' } },
      },
    })
    await writeConfig(paths.project, {
      mcpServers: {
        other: { url: 'https://example.com/mcp', auth: { provider: 'project-provider' } },
      },
    })
    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    expect(findServer(loaded, 'remote')?.config).toMatchObject({
      auth: { provider: 'user-provider' },
    })
    expect(findServer(loaded, 'other')).toBeUndefined()
    expect(loaded.issues.some((issue) => issue.kind === 'project-auth')).toBe(true)
    expect(JSON.stringify(loaded.issues)).not.toContain('project-provider')
  })

  it('未信任项目绝不读取项目原文，也不把文件存在当作信任', async () => {
    // 坏 JSON + 秘密：若被读取会产生 parse 诊断或泄露内容。
    await mkdir(dirname(paths.project), { recursive: true })
    await writeFile(
      paths.project,
      '{"mcpServers":{"secret":{"command":"HUAN-PROJECT-SECRET"}}',
      'utf8',
    )
    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: false })
    expect(loaded.servers).toEqual([])
    expect(loaded.issues).toEqual([])
    expect(loaded.projectConfig).toBeUndefined()

    // 运行时只接受严格 true；truthy 非布尔值也按未信任处理。
    const truthy = await loadMcpConfig({
      agentDir,
      cwd,
      projectTrusted: 'yes' as unknown as boolean,
    })
    expect(truthy.issues).toEqual([])
    expect(truthy.servers).toEqual([])

    const trusted = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    expect(trusted.issues[0]?.kind).toBe('parse')
    expect(JSON.stringify(trusted.issues)).not.toContain('HUAN-PROJECT-SECRET')
  })

  it('用户坏 JSON 不影响读取结果结构；项目缺失时仍给出 projectConfig', async () => {
    await mkdir(dirname(paths.user), { recursive: true })
    await writeFile(paths.user, '{ bad', 'utf8')
    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    expect(loaded.servers).toEqual([])
    expect(loaded.issues[0]?.kind).toBe('parse')
    expect(loaded.projectConfig).toBe(paths.project)
  })

  it('项目 autoEnableCodemode 覆盖用户值；非法类型不覆盖', async () => {
    await writeConfig(paths.user, { mcpServers: {}, autoEnableCodemode: true })
    await writeConfig(paths.project, { mcpServers: {}, autoEnableCodemode: false })
    expect((await loadMcpConfig({ agentDir, cwd, projectTrusted: true })).autoEnableCodemode).toBe(
      false,
    )

    await writeConfig(paths.project, { mcpServers: {}, autoEnableCodemode: 'no' })
    const loaded = await loadMcpConfig({ agentDir, cwd, projectTrusted: true })
    expect(loaded.autoEnableCodemode).toBe(true)
    expect(loaded.issues[0]?.kind).toBe('shape')
  })
})
