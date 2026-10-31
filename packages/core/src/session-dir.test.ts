import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  defaultSessionDir,
  encodeCwdForSessionDir,
  isPathWithinScope,
  resolveAgentDir,
  resolveSessionDir,
  toAbsolutePath,
} from './session-dir.js'

const run = promisify(execFile)

/** packages/core 目录（子进程在此解析 SDK 依赖）。 */
const coreDir = fileURLToPath(new URL('..', import.meta.url))

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'huan-session-dir-test-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * 在独立子进程中读取 Pi 的真实默认目录结果。
 *
 * 为什么用子进程：`getAgentDir()` 与 SDK 的默认会话目录读取进程环境变量，
 * 而同进程内的 SDK 可能已缓存、且 Vitest worker 会共享环境；独立子进程 +
 * 临时 HOME/USERPROFILE 才能验证真实缺省行为且不触碰个人目录。
 */
async function readPiDefaultDirs(input: {
  cwd: string
  /** undefined 表示不设置 PI_CODING_AGENT_DIR（走 ~/.pi/agent 缺省）。 */
  agentDir?: string
  home: string
}): Promise<{ agentDir: string; sessionDir: string }> {
  const script = `
import { getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'
const manager = SessionManager.create(process.env.HUAN_TEST_CWD)
process.stdout.write(JSON.stringify({ agentDir: getAgentDir(), sessionDir: manager.getSessionDir() }))
`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.home,
    USERPROFILE: input.home,
    HUAN_TEST_CWD: input.cwd,
  }
  delete env.PI_CODING_AGENT_DIR
  delete env.PI_CODING_AGENT_SESSION_DIR
  if (input.agentDir) env.PI_CODING_AGENT_DIR = input.agentDir
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: coreDir,
    env,
  })
  return JSON.parse(stdout) as { agentDir: string; sessionDir: string }
}

describe('路径解析', () => {
  it('toAbsolutePath 展开 ~ 与相对路径', () => {
    expect(toAbsolutePath('~/projects', '/base')).toBe(resolve(homedir(), 'projects'))
    expect(toAbsolutePath('~', '/base')).toBe(resolve(homedir()))
    expect(toAbsolutePath('./sessions', '/base')).toBe(resolve('/base', 'sessions'))
    expect(toAbsolutePath('/abs/dir', '/base')).toBe(resolve('/abs/dir'))
    // 非 ~ 前导的波浪号按普通路径处理（与 Pi 同口径）。
    expect(toAbsolutePath('~other/dir', '/base')).toBe(resolve('/base', '~other/dir'))
  })

  it('resolveAgentDir 显式值优先并固定为绝对路径', () => {
    expect(resolveAgentDir(join(root, 'custom-agent'))).toBe(resolve(root, 'custom-agent'))
    // 纯空白视同未提供（回退 Pi 缺省，不产生空路径）。
    expect(resolveAgentDir('   ')).not.toBe('')
  })

  it('resolveSessionDir 优先级：option > env > setting > 默认分组', () => {
    const base = { agentDir: '/agent', cwd: '/work', workspacePath: '/work' }
    expect(
      resolveSessionDir({
        ...base,
        option: '/opt',
        env: '/env',
        setting: '/setting',
        launchDir: '/launch',
      }),
    ).toEqual({ dir: resolve('/opt'), source: 'option', grouped: false })
    expect(
      resolveSessionDir({ ...base, env: '/env', setting: '/setting', launchDir: '/launch' }),
    ).toEqual({ dir: resolve('/env'), source: 'env', grouped: false })
    expect(resolveSessionDir({ ...base, setting: './setting-flat' })).toEqual({
      dir: resolve('/work', 'setting-flat'),
      source: 'settings',
      grouped: false,
    })
    const fallback = resolveSessionDir({ ...base, option: '  ', env: '', setting: '  ' })
    expect(fallback.source).toBe('default')
    expect(fallback.grouped).toBe(true)
    expect(fallback.dir).toBe(join('/agent', 'sessions', encodeCwdForSessionDir('/work')))
  })

  it('显式值/环境变量的相对路径以启动进程目录解析', () => {
    const resolved = resolveSessionDir({
      agentDir: '/agent',
      cwd: '/work',
      workspacePath: '/work',
      option: './flat',
      launchDir: '/launch',
    })
    expect(resolved.dir).toBe(resolve('/launch', 'flat'))
  })
})

describe('Pi 默认目录兼容', () => {
  it('编码结果与 SDK 在子进程中的默认会话目录一致（临时 HOME）', async () => {
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })

    const actual = await readPiDefaultDirs({ cwd, home })
    // 缺省用户空间 = <HOME>/.pi/agent。
    expect(actual.agentDir).toBe(join(home, '.pi', 'agent'))
    // 我们的默认目录公式必须与 SDK 完全一致（同一 cwd、同一 agentDir）。
    expect(defaultSessionDir(actual.agentDir, cwd)).toBe(actual.sessionDir)
  })

  it('编码结果与 SDK 在显式 agentDir 下一致', async () => {
    const home = join(root, 'home-explicit')
    const cwd = join(root, 'workspace-explicit')
    const agentDir = join(root, 'agent-explicit')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await mkdir(agentDir, { recursive: true })

    const actual = await readPiDefaultDirs({ cwd, agentDir, home })
    expect(actual.agentDir).toBe(resolve(agentDir))
    expect(defaultSessionDir(actual.agentDir, cwd)).toBe(actual.sessionDir)
  })

  it.runIf(process.platform === 'win32')('Git Bash 盘符路径的编码与 SDK 一致', async () => {
    const home = join(root, 'home-shell-path')
    const agentDir = join(root, 'agent-shell-path')
    await mkdir(home, { recursive: true })
    await mkdir(agentDir, { recursive: true })
    // Pi 在 Windows 上把 /d/xxx 视为 D:\xxx（TUI 会话可能用这种写法启动）。
    const shellCwd = '/d/huan-shell-path'
    const actual = await readPiDefaultDirs({ cwd: shellCwd, agentDir, home })
    expect(defaultSessionDir(actual.agentDir, shellCwd)).toBe(actual.sessionDir)
  })
})

describe('作用域边界', () => {
  it('作用域内的直接文件与子路径命中，界外路径不命中', async () => {
    const scope = join(root, 'scope')
    const inside = join(scope, 'a.jsonl')
    const nested = join(scope, 'nested', 'b.jsonl')
    const outside = join(root, 'outside.jsonl')
    await mkdir(join(scope, 'nested'), { recursive: true })
    await writeFile(inside, '{}')
    await writeFile(nested, '{}')
    await writeFile(outside, '{}')

    expect(isPathWithinScope(scope, inside)).toBe(true)
    expect(isPathWithinScope(scope, nested)).toBe(true)
    expect(isPathWithinScope(scope, outside)).toBe(false)
    expect(isPathWithinScope(scope, scope)).toBe(false)
    // 不存在的路径按绝对路径判断（不抛错）。
    expect(isPathWithinScope(scope, join(scope, 'missing.jsonl'))).toBe(true)
  })

  it('尚未创建的文件也不能通过父目录链接越过作用域', async () => {
    const scope = join(root, 'scope-parent-link')
    const outside = join(root, 'outside-parent-link')
    await mkdir(scope, { recursive: true })
    await mkdir(outside, { recursive: true })
    const link = join(scope, 'group')
    await symlink(outside, link, 'junction')
    expect(isPathWithinScope(scope, join(link, 'not-created.jsonl'))).toBe(false)
  })

  it('指向作用域外的符号链接不算命中（默认空间不暴露外部入口）', async () => {
    const scope = join(root, 'scope-symlink')
    const outsideDir = join(root, 'outside-dir')
    await mkdir(scope, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'target.jsonl'), '{}')
    const link = join(scope, 'link.jsonl')
    try {
      await symlink(join(outsideDir, 'target.jsonl'), link)
    } catch {
      // Windows 无符号链接权限时跳过该断言（其余用例仍覆盖路径比较）。
      return
    }
    expect(isPathWithinScope(scope, link)).toBe(false)
    expect(isPathWithinScope(scope, join(outsideDir, 'target.jsonl'))).toBe(false)
  })
})
