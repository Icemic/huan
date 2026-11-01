/**
 * MCP 配置存储测试（G1.4d1；2026-11-02 改为与 Pi 共享配置）。
 *
 * 覆盖共享路径读写、旧隔离路径不读不写、BOM/revision、512KiB UTF-8 上限、
 * 坏 JSON 秘密不回显、项目信任、符号链接拒绝、Pi 凭据/日志 sentinel、
 * 原子写入/权限失败/临时文件清理、revision 冲突与不同 store 实例并发。
 * 全部使用临时目录。
 */
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeMcpConfigFileAtomic } from './file-io.js'
import {
  createMcpConfigStore,
  MCP_CONFIG_FILE_MAX_BYTES,
  type McpConfigScope,
  mcpConfigPaths,
  mcpConfigRevision,
} from './index.js'

let root: string
let agentDir: string
let cwd: string
let paths: ReturnType<typeof mcpConfigPaths>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'huan-mcp-store-test-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'workspace')
  await mkdir(agentDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  paths = mcpConfigPaths(agentDir, cwd)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function createStore(agent = agentDir) {
  return createMcpConfigStore({ agentDir: agent, cwd })
}

async function writeRaw(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function trySymlink(target: string, path: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    // Windows 目录使用 junction，避免普通用户没有创建符号链接的权限。
    await symlink(target, path, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'EINVAL') {
      return false
    }
    throw error
  }
}

describe('读取与 revision', () => {
  it('缺失文件 revision 为 null；保存后读取内容与 SHA-256 一致', async () => {
    const store = createStore()
    const missing = await store.read('user')
    expect(missing).toMatchObject({
      scope: 'user',
      path: paths.user,
      readable: true,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
    })

    const content = '{"mcpServers":{}}\n'
    const saved = await store.save({ scope: 'user', content, expectedRevision: null })
    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') return
    expect(saved.revision).toBe(mcpConfigRevision(content))
    expect(saved.bytes).toBe(Buffer.byteLength(content))

    const read = await store.read('user')
    expect(read).toMatchObject({
      readable: true,
      exists: true,
      content,
      revision: saved.revision,
      bytes: Buffer.byteLength(content),
      tooLarge: false,
      issues: [],
    })
    // auth/log 本阶段只定义路径，不创建、不读写。
    await expect(readFile(paths.auth, 'utf8')).rejects.toBeTruthy()
    await expect(readFile(paths.log, 'utf8')).rejects.toBeTruthy()
  })

  it('保留 BOM 原文，解析不报错，revision 基于实际字节', async () => {
    const store = createStore()
    const content = '\uFEFF{"mcpServers":{}}\n'
    const saved = await store.save({ scope: 'user', content, expectedRevision: null })
    expect(saved.status).toBe('saved')

    const read = await store.read('user')
    expect(read.content).toBe(content)
    expect(read.issues).toEqual([])
    expect(read.revision).toBe(
      createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
    )
  })

  it('超过 512KiB 不返回不完整原文，保存也拒绝覆盖', async () => {
    const store = createStore()
    await writeRaw(paths.user, 'x'.repeat(MCP_CONFIG_FILE_MAX_BYTES + 1))
    const read = await store.read('user')
    expect(read.tooLarge).toBe(true)
    expect(read.content).toBe('')
    expect(read.revision).toBeNull()
    expect(read.issues[0]?.kind).toBe('too-large')

    const saved = await store.save({
      scope: 'user',
      content: '{"mcpServers":{}}',
      expectedRevision: null,
    })
    expect(saved.status).toBe('too-large')
  })

  it('上限按 UTF-8 字节计算，边界内可保存、超一字节拒绝', async () => {
    const store = createStore()
    const prefix = '{"mcpServers":{},"pad":"'
    const suffix = '"}'
    const overhead = Buffer.byteLength(prefix + suffix)

    const exact = `${prefix}${'x'.repeat(MCP_CONFIG_FILE_MAX_BYTES - overhead)}${suffix}`
    expect(Buffer.byteLength(exact)).toBe(MCP_CONFIG_FILE_MAX_BYTES)
    expect(
      await store.save({ scope: 'user', content: exact, expectedRevision: null }),
    ).toMatchObject({ status: 'saved' })

    const store2 = createStore()
    const multiByte = `${prefix}${'你'.repeat(
      Math.ceil((MCP_CONFIG_FILE_MAX_BYTES - overhead) / 3) + 1,
    )}${suffix}`
    expect(Buffer.byteLength(multiByte)).toBeGreaterThan(MCP_CONFIG_FILE_MAX_BYTES)
    expect(multiByte.length).toBeLessThan(MCP_CONFIG_FILE_MAX_BYTES)
    const rejected = await store2.save({
      scope: 'user',
      content: multiByte,
      expectedRevision: null,
    })
    expect(rejected.status).toBe('too-large')
  })

  it('无效 UTF-8 读取失败且不返回有损原文', async () => {
    const store = createStore()
    await writeRaw(paths.user, Buffer.from([0x7b, 0xff, 0x7d]))
    const read = await store.read('user')
    expect(read.readable).toBe(true)
    expect(read.readError).toContain('UTF-8')
    expect(read.content).toBe('')
    expect(read.revision).toBeNull()
    expect(read.issues[0]?.kind).toBe('read')
  })

  it('含孤立代理项的文本保存前被拒绝', async () => {
    const store = createStore()
    const result = await store.save({
      scope: 'user',
      content: '{"mcpServers":{},"x":"\uD800"}',
      expectedRevision: null,
    })
    expect(result.status).toBe('invalid')
    await expect(readFile(paths.user, 'utf8')).rejects.toBeTruthy()
  })
})

describe('共享配置', () => {
  it('读到 Pi 共享的用户/项目服务器；保存写回同一文件、保留未知字段、不动另一 scope', async () => {
    const store = createStore()
    const userContent = `${JSON.stringify(
      {
        mcpServers: { shared: { command: 'node', args: ['user'] } },
        customTop: { keep: 'yes' },
      },
      null,
      2,
    )}\n`
    const projectContent = `${JSON.stringify(
      { mcpServers: { project_server: { command: 'node' } } },
      null,
      2,
    )}\n`
    await writeRaw(paths.user, userContent)
    await writeRaw(paths.project, projectContent)

    const loaded = await store.load({ projectTrusted: true })
    expect(loaded.servers.map((server) => server.name).sort()).toEqual(['project_server', 'shared'])
    expect(loaded.servers.find((server) => server.name === 'shared')?.source).toBe(paths.user)
    expect(loaded.servers.find((server) => server.name === 'project_server')?.source).toBe(
      paths.project,
    )

    const read = await store.read('user')
    const next = `${JSON.stringify(
      {
        mcpServers: { shared: { command: 'node', args: ['edited'] } },
        customTop: { keep: 'yes' },
      },
      null,
      2,
    )}\n`
    const saved = await store.save({
      scope: 'user',
      content: next,
      expectedRevision: read.revision,
    })
    expect(saved.status).toBe('saved')
    expect(await readFile(paths.user, 'utf8')).toBe(next)
    expect(
      (JSON.parse(await readFile(paths.user, 'utf8')) as { customTop: unknown }).customTop,
    ).toEqual({ keep: 'yes' })
    // 项目 scope 保持原样，不被用户 scope 的保存连带修改。
    expect(await readFile(paths.project, 'utf8')).toBe(projectContent)

    const projectRead = await store.read('project', { projectTrusted: true })
    const projectNext = JSON.stringify({
      mcpServers: { project_server: { command: 'node', enabled: false } },
      projectExtra: { keep: true },
    })
    expect(
      await store.save({
        scope: 'project',
        content: projectNext,
        expectedRevision: projectRead.revision,
        projectTrusted: true,
      }),
    ).toMatchObject({ status: 'saved' })
    expect(await readFile(paths.project, 'utf8')).toBe(projectNext)
    expect(await readFile(paths.user, 'utf8')).toBe(next)
    // 只保存服务器配置，不创建 huan 专属状态目录。
    await expect(readdir(join(agentDir, 'huan'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('坏内容与保存校验', () => {
  it('坏 JSON 可读取修复；错误信息不泄露秘密，保存前拒绝同样内容', async () => {
    const store = createStore()
    const secret = 'HUAN-MCP-SECRET-TOKEN'
    const bad = `{"mcpServers":{"demo":{"command":"${secret}"}}`
    await writeRaw(paths.user, bad)

    const before = await store.read('user')
    expect(before.exists).toBe(true)
    expect(before.content).toBe(bad)
    expect(before.issues[0]?.kind).toBe('parse')
    expect(before.revision).not.toBeNull()
    expect(JSON.stringify(before.issues)).not.toContain(secret)

    const rejected = await store.save({
      scope: 'user',
      content: bad,
      expectedRevision: before.revision,
    })
    expect(rejected.status).toBe('invalid')
    if (rejected.status === 'invalid') {
      expect(JSON.stringify(rejected.issues)).not.toContain(secret)
    }

    const fixed = '{"mcpServers":{"demo":{"command":"node"}}}\n'
    const saved = await store.save({
      scope: 'user',
      content: fixed,
      expectedRevision: before.revision,
    })
    expect(saved.status).toBe('saved')
    const after = await store.read('user')
    expect(after.content).toBe(fixed)
    expect(after.issues).toEqual([])
  })

  it('整份保存不重建内容，未知顶层/条目字段原样保留', async () => {
    const store = createStore()
    const content = `${JSON.stringify({
      mcpServers: {
        demo: { command: 'node', customServer: { keep: [1, true] } },
      },
      customTop: { keep: 'yes' },
    })}
`
    expect((await store.save({ scope: 'user', content, expectedRevision: null })).status).toBe(
      'saved',
    )
    expect(await readFile(paths.user, 'utf8')).toBe(content)
    const loaded = await store.load({ projectTrusted: false })
    const demoConfig = loaded.servers.find((server) => server.name === 'demo')?.config
    expect(demoConfig).toBeDefined()
    expect((demoConfig as unknown as { customServer: unknown }).customServer).toEqual({
      keep: [1, true],
    })
  })

  it('空文件可读取并修复', async () => {
    const store = createStore()
    await writeRaw(paths.user, '')
    const before = await store.read('user')
    expect(before.exists).toBe(true)
    expect(before.issues[0]?.kind).toBe('parse')
    expect(before.revision).not.toBeNull()

    const saved = await store.save({
      scope: 'user',
      content: '{}\n',
      expectedRevision: before.revision,
    })
    expect(saved.status).toBe('saved')
  })

  it('拒绝有已知语义错误的新内容', async () => {
    const store = createStore()
    const invalid = [
      JSON.stringify({ mcpServers: { demo: { command: 42 } } }),
      JSON.stringify({ mcpServers: { demo: { command: 'node', exposure: 'bogus' } } }),
      '{"mcpServers":{},"__proto__":{"polluted":true}}',
      JSON.stringify({
        mcpServers: {},
        nested: Array.from({ length: 64 }).reduce<unknown>((child) => ({ child }), {}),
      }),
    ]
    for (const content of invalid) {
      const result = await store.save({ scope: 'user', content, expectedRevision: null })
      expect(result.status).toBe('invalid')
      await expect(readFile(paths.user, 'utf8')).rejects.toBeTruthy()
    }
  })
})

describe('项目信任与项目保存', () => {
  it('非法运行时 scope 不可绕过项目信任', async () => {
    const store = createStore()
    const scope = 'invalid' as McpConfigScope
    await expect(store.read(scope)).rejects.toThrow('scope')
    await expect(store.save({ scope, content: '{}', expectedRevision: null })).rejects.toThrow(
      'scope',
    )
    await expect(readFile(paths.project, 'utf8')).rejects.toBeTruthy()
  })

  it('未信任项目读取/保存/加载都不触碰文件', async () => {
    const store = createStore()
    const original = JSON.stringify({
      mcpServers: { remote: { command: 'node', args: ['project-secret'] } },
    })
    await writeRaw(paths.project, original)

    const read = await store.read('project', { projectTrusted: false })
    expect(read).toMatchObject({
      readable: false,
      exists: false,
      content: '',
      revision: null,
      bytes: 0,
      tooLarge: false,
      issues: [],
    })
    const readOmitted = await store.read('project')
    expect(readOmitted.readable).toBe(false)

    const saved = await store.save({
      scope: 'project',
      content: '{"mcpServers":{}}',
      expectedRevision: null,
      projectTrusted: false,
    })
    expect(saved.status).toBe('untrusted')
    expect(await readFile(paths.project, 'utf8')).toBe(original)

    const loaded = await store.load({ projectTrusted: false })
    expect(loaded.servers).toEqual([])
    expect(loaded.issues).toEqual([])
    expect(loaded.projectConfig).toBeUndefined()

    const trusted = await store.read('project', { projectTrusted: true })
    expect(trusted.readable).toBe(true)
    expect(trusted.content).toBe(original)
  })

  it('项目完整条目 auth.provider 保存被拒绝，错误不回显 provider 值', async () => {
    const store = createStore()
    const content = JSON.stringify({
      mcpServers: {
        remote: { url: 'https://example.com/mcp', auth: { provider: 'HUAN-SECRET-PROVIDER' } },
      },
    })
    const result = await store.save({
      scope: 'project',
      content,
      expectedRevision: null,
      projectTrusted: true,
    })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.issues[0]?.kind).toBe('project-auth')
      expect(JSON.stringify(result.issues)).not.toContain('HUAN-SECRET-PROVIDER')
    }
    await expect(readFile(paths.project, 'utf8')).rejects.toBeTruthy()
  })

  it('项目 override 缺少用户条目时拒绝；补上用户条目后可保存并生效', async () => {
    const store = createStore()
    const override = JSON.stringify({ mcpServers: { demo: { enabled: false } } })
    const missing = await store.save({
      scope: 'project',
      content: override,
      expectedRevision: null,
      projectTrusted: true,
    })
    expect(missing.status).toBe('invalid')
    if (missing.status === 'invalid') {
      expect(missing.issues[0]?.kind).toBe('invalid-override')
    }

    const user = JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['base'] } } })
    expect(
      (await store.save({ scope: 'user', content: user, expectedRevision: null })).status,
    ).toBe('saved')
    const saved = await store.save({
      scope: 'project',
      content: override,
      expectedRevision: null,
      projectTrusted: true,
    })
    expect(saved.status).toBe('saved')

    const loaded = await store.load({ projectTrusted: true })
    const demo = loaded.servers.find((server) => server.name === 'demo')
    expect(demo?.config).toMatchObject({ command: 'node', args: ['base'], enabled: false })
    expect(demo?.override).toBe(paths.project)
  })

  it('项目文件跨文件 namespace 碰撞保存被拒绝', async () => {
    const store = createStore()
    await store.save({
      scope: 'user',
      content: JSON.stringify({ mcpServers: { 'a-b': { command: 'node' } } }),
      expectedRevision: null,
    })
    const result = await store.save({
      scope: 'project',
      content: JSON.stringify({ mcpServers: { a_b: { command: 'node' } } }),
      expectedRevision: null,
      projectTrusted: true,
    })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.issues.some((issue) => issue.kind === 'namespace-collision')).toBe(true)
    }
  })
})

describe('路径与符号链接', () => {
  it('agentDir 本身是符号链接时仍允许读写用户配置', async () => {
    const aliasAgentDir = join(root, 'agent-link')
    if (!(await trySymlink(agentDir, aliasAgentDir, 'dir'))) return
    const store = createStore(aliasAgentDir)

    const content = '{"mcpServers":{"linked":{"command":"node"}}}'
    expect((await store.save({ scope: 'user', content, expectedRevision: null })).status).toBe(
      'saved',
    )
    expect(await readFile(paths.user, 'utf8')).toBe(content)
    const read = await store.read('user')
    expect(read.readError).toBeUndefined()
    expect(read.content).toBe(content)
  })

  it('用户配置目标文件是符号链接时读取/保存都拒绝', async () => {
    const store = createStore()
    const sentinelFile = join(root, 'target-sentinel.json')
    await writeFile(sentinelFile, '{"sentinel":true}', 'utf8')
    if (!(await trySymlink(sentinelFile, paths.user, 'file'))) return

    const read = await store.read('user')
    expect(read.readError).toContain('符号链接')
    expect(read.content).toBe('')

    const saved = await store.save({
      scope: 'user',
      content: '{"mcpServers":{}}',
      expectedRevision: null,
    })
    expect(saved.status).toBe('failed')
    expect(await readFile(sentinelFile, 'utf8')).toBe('{"sentinel":true}')
  })

  it('项目 .pi 目录是符号链接时拒绝读取/保存；未信任时不触碰', async () => {
    const store = createStore()
    // 用外部 sentinel 目录而非 Pi 配置目录，验证拒绝发生在组件检查阶段。
    const sentinelDir = join(root, 'pi-sentinel-dir')
    await mkdir(sentinelDir, { recursive: true })
    const sentinelFile = join(sentinelDir, 'mcp.json')
    const original = '{"mcpServers":{"sentinel":{"command":"sentinel"}}}'
    await writeFile(sentinelFile, original, 'utf8')
    if (!(await trySymlink(sentinelDir, join(cwd, '.pi'), 'dir'))) return

    const untrusted = await store.read('project', { projectTrusted: false })
    expect(untrusted.readable).toBe(false)
    expect(untrusted.content).toBe('')
    expect((await store.load({ projectTrusted: false })).issues).toEqual([])

    const trusted = await store.read('project', { projectTrusted: true })
    expect(trusted.readError).toContain('符号链接')
    expect(trusted.content).toBe('')

    const saved = await store.save({
      scope: 'project',
      content: '{"mcpServers":{}}',
      expectedRevision: null,
      projectTrusted: true,
    })
    expect(saved.status).toBe('failed')
    expect(await readFile(sentinelFile, 'utf8')).toBe(original)
  })

  it('Pi 的 mcp-auth.json/mcp.log sentinel 不被读取或修改；huan 的 auth/log 不创建', async () => {
    const store = createStore()
    const piAuth = join(agentDir, 'mcp-auth.json')
    const piLog = join(agentDir, 'mcp.log')
    const piAuthContent = '{"piAuthSecret":true'
    const piLogContent = 'pi-log-sentinel'
    await writeRaw(piAuth, piAuthContent)
    await writeRaw(piLog, piLogContent)

    const loaded = await store.load({ projectTrusted: true })
    expect(loaded.issues).toEqual([])
    await store.read('user')
    await store.read('project', { projectTrusted: true })
    expect(
      (
        await store.save({
          scope: 'user',
          content: JSON.stringify({ mcpServers: { demo: { command: 'node' } } }),
          expectedRevision: null,
        })
      ).status,
    ).toBe('saved')
    expect(
      (
        await store.save({
          scope: 'project',
          content: JSON.stringify({ mcpServers: {} }),
          expectedRevision: null,
          projectTrusted: true,
        })
      ).status,
    ).toBe('saved')

    expect(await readFile(piAuth, 'utf8')).toBe(piAuthContent)
    expect(await readFile(piLog, 'utf8')).toBe(piLogContent)
    // huan 自己的凭据/日志路径仍只定义不创建。
    await expect(readFile(paths.auth, 'utf8')).rejects.toBeTruthy()
    await expect(readFile(paths.log, 'utf8')).rejects.toBeTruthy()
  })

  it('旧隔离配置即使有效或损坏也不读取、不修改、不作 fallback', async () => {
    const store = createStore()
    const legacyUser = join(agentDir, 'huan', 'mcp.json')
    const legacyProject = join(cwd, '.huan', 'mcp.json')
    const legacyUserContent = '{"mcpServers":{"legacyUser":{"command":"node"}}}'
    const legacyProjectContent = '{"mcpServers":{"legacyProject":{"command":"node"}}}'
    await writeRaw(legacyUser, legacyUserContent)
    await writeRaw(legacyProject, legacyProjectContent)

    const loaded = await store.load({ projectTrusted: true })
    expect(loaded.servers).toEqual([])
    expect(loaded.issues).toEqual([])
    expect(loaded.projectConfig).toBe(paths.project)

    // 保存共享文件不会触碰旧隔离文件。
    expect(
      (
        await store.save({
          scope: 'user',
          content: JSON.stringify({ mcpServers: { shared: { command: 'node' } } }),
          expectedRevision: null,
        })
      ).status,
    ).toBe('saved')
    expect(
      (
        await store.save({
          scope: 'project',
          content: JSON.stringify({ mcpServers: {} }),
          expectedRevision: null,
          projectTrusted: true,
        })
      ).status,
    ).toBe('saved')
    expect(await readFile(legacyUser, 'utf8')).toBe(legacyUserContent)
    expect(await readFile(legacyProject, 'utf8')).toBe(legacyProjectContent)

    // 损坏的旧文件同样不参与读取与诊断，也不作为 fallback。
    await writeRaw(legacyUser, '{ bad legacy')
    await writeRaw(legacyProject, '{"mcpServers":{"broken":')
    const badLoaded = await store.load({ projectTrusted: true })
    expect(badLoaded.issues).toEqual([])
    expect(badLoaded.servers.map((server) => server.name)).toEqual(['shared'])
  })
})

describe('revision 与并发', () => {
  it('旧 revision 冲突，磁盘保留新内容', async () => {
    const store = createStore()
    const initial = '{"mcpServers":{"a":{"command":"node"}}}'
    const first = await store.save({ scope: 'user', content: initial, expectedRevision: null })
    expect(first.status).toBe('saved')
    if (first.status !== 'saved') return
    const revision = first.revision

    const next = '{"mcpServers":{"a":{"command":"node","args":["next"]}}}'
    const second = await store.save({ scope: 'user', content: next, expectedRevision: revision })
    expect(second.status).toBe('saved')

    const stale = await store.save({
      scope: 'user',
      content: '{"mcpServers":{}}',
      expectedRevision: revision,
    })
    expect(stale.status).toBe('conflict')
    if (stale.status === 'conflict') {
      expect(stale.revision).toBe(mcpConfigRevision(next))
    }
    expect(await readFile(paths.user, 'utf8')).toBe(next)
  })

  it('expectedRevision 必须与文件状态匹配', async () => {
    const store = createStore()
    const missing = await store.save({
      scope: 'user',
      content: '{}',
      expectedRevision: 'not-the-missing-revision',
    })
    expect(missing.status).toBe('conflict')

    const created = await store.save({
      scope: 'user',
      content: '{"mcpServers":{}}',
      expectedRevision: null,
    })
    expect(created.status).toBe('saved')
    const conflict = await store.save({
      scope: 'user',
      content: '{"mcpServers":{}}',
      expectedRevision: null,
    })
    expect(conflict.status).toBe('conflict')
  })

  it('外部 writeFile 修改已读文件后旧 revision 冲突，重读后可保存', async () => {
    const store = createStore()
    const original = '{"mcpServers":{"a":{"command":"node"}}}'
    const saved = await store.save({ scope: 'user', content: original, expectedRevision: null })
    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') return

    // 模拟 Pi TUI/编辑器在读取之后直接改写同一共享文件。
    const external = '{"mcpServers":{"a":{"command":"node","args":["external"]}}}'
    await writeFile(paths.user, external, 'utf8')

    const stale = await store.save({
      scope: 'user',
      content: '{"mcpServers":{}}',
      expectedRevision: saved.revision,
    })
    expect(stale.status).toBe('conflict')
    if (stale.status === 'conflict') {
      expect(stale.revision).toBe(mcpConfigRevision(external))
    }
    expect(await readFile(paths.user, 'utf8')).toBe(external)

    // revision 只检测已经发生的修改，不提供跨进程 CAS；重读后再提交即可。
    const reread = await store.read('user')
    const next = '{"mcpServers":{"a":{"command":"node","args":["after-reread"]}}}'
    const retried = await store.save({
      scope: 'user',
      content: next,
      expectedRevision: reread.revision,
    })
    expect(retried.status).toBe('saved')
    expect(await readFile(paths.user, 'utf8')).toBe(next)
  })

  it('不同 store 实例并发保存同一文件时只有一个成功', async () => {
    const aliasAgentDir = join(root, 'agent-link')
    const linked = await trySymlink(agentDir, aliasAgentDir, 'dir')
    const storeA = createStore()
    const storeB = createStore(linked ? aliasAgentDir : agentDir)

    const initial = '{"mcpServers":{"a":{"command":"node"}}}'
    const first = await storeA.save({ scope: 'user', content: initial, expectedRevision: null })
    expect(first.status).toBe('saved')
    if (first.status !== 'saved') return

    const contentA = '{"mcpServers":{"a":{"command":"node","args":["a"]}}}'
    const contentB = '{"mcpServers":{"a":{"command":"node","args":["b"]}}}'
    const results = await Promise.all([
      storeA.save({ scope: 'user', content: contentA, expectedRevision: first.revision }),
      storeB.save({ scope: 'user', content: contentB, expectedRevision: first.revision }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'saved'])
    expect([contentA, contentB]).toContain(await readFile(paths.user, 'utf8'))
  })
})

describe('原子写入', () => {
  it('写入失败时清理同目录临时文件', async () => {
    // 用户配置现在是 agentDir 的直接子文件，临时文件也在 agentDir 下。
    // 目标路径是目录：rename 必然失败，用于验证 wx 临时文件被清理。
    await mkdir(paths.user)
    await expect(
      writeMcpConfigFileAtomic(paths.user, '{"mcpServers":{}}', agentDir),
    ).rejects.toBeTruthy()
    expect(await readdir(agentDir)).toEqual(['mcp.json'])
  })

  it.skipIf(process.platform === 'win32')('落盘文件不对 group/other 开放', async () => {
    const store = createStore()
    expect(
      (await store.save({ scope: 'user', content: '{}', expectedRevision: null })).status,
    ).toBe('saved')
    const info = await stat(paths.user)
    expect(info.mode & 0o077).toBe(0)
  })

  it.skipIf(process.platform !== 'win32')(
    '目标只读导致 rename 失败时保留原文并清理临时文件',
    async () => {
      const store = createStore()
      const original = '{"mcpServers":{"a":{"command":"node"}}}'
      const first = await store.save({
        scope: 'user',
        content: original,
        expectedRevision: null,
      })
      expect(first.status).toBe('saved')
      if (first.status !== 'saved') return

      // Windows 上 chmod 目录不阻止创建文件；把目标标记为只读可让 rename 失败。
      await chmod(paths.user, 0o400)
      try {
        const result = await store.save({
          scope: 'user',
          content: '{"mcpServers":{"a":{"command":"node","args":["next"]}}}',
          expectedRevision: first.revision,
        })
        expect(result.status).toBe('failed')
        expect((await readdir(agentDir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
      } finally {
        await chmod(paths.user, 0o600)
      }
      expect(await readFile(paths.user, 'utf8')).toBe(original)
    },
  )

  const skipPermission =
    process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
  it.skipIf(skipPermission)('权限失败时保留原文件且不留下临时文件', async () => {
    const store = createStore()
    const original = '{"mcpServers":{"a":{"command":"node"}}}'
    const first = await store.save({
      scope: 'user',
      content: original,
      expectedRevision: null,
    })
    expect(first.status).toBe('saved')
    if (first.status !== 'saved') return

    // 用户文件在 agentDir 本层，权限失败时同目录临时文件也必须清理。
    const directory = agentDir
    await chmod(directory, 0o500)
    try {
      const result = await store.save({
        scope: 'user',
        content: '{"mcpServers":{"a":{"command":"node","args":["next"]}}}',
        expectedRevision: first.revision,
      })
      expect(result.status).toBe('failed')
      expect(await readdir(directory)).toEqual(['mcp.json'])
    } finally {
      await chmod(directory, 0o700)
    }
    expect(await readFile(paths.user, 'utf8')).toBe(original)
  })
})
