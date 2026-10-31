import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isInside,
  owningRoot,
  pathKey,
  resolveWorkspacePath,
  type WorkspaceSnapshot,
} from './workspace-path.js'

// 用绝对路径构造用例，避免测试依赖当前平台的分隔符。
const base = join(tmpdir(), 'huan-workspace-path-unit')
const alphaPath = join(base, 'alpha')
const betaPath = join(base, 'beta')
const nestedPath = join(alphaPath, 'nested')
const sessionCwd = join(alphaPath, 'app')

function workspace(roots: WorkspaceSnapshot['roots']): WorkspaceSnapshot {
  return { workspaceId: 'ws_test', name: '测试工作区', revision: 1, roots }
}

const workspaceWithRoots = workspace([
  { alias: 'alpha', path: alphaPath },
  { alias: 'beta', path: betaPath },
  { alias: 'nested', path: nestedPath },
])

describe('pathKey / isInside', () => {
  it('统一分隔符与 Windows 盘符大小写，保留其余路径字符', () => {
    expect(pathKey('D:\\Work\\Alpha\\')).toBe('d:/Work/Alpha')
    expect(pathKey('d:/Work/Alpha')).toBe('d:/Work/Alpha')
    expect(pathKey('/home/项目/')).toBe('/home/项目')
    expect(pathKey('/')).toBe('/')
  })

  it('按词法判断包含关系', () => {
    expect(isInside(alphaPath, join(alphaPath, 'src', 'app.ts'))).toBe(true)
    expect(isInside(alphaPath, alphaPath)).toBe(true)
    expect(isInside(alphaPath, join(base, 'alphabet', 'app.ts'))).toBe(false)
    expect(isInside(alphaPath, base)).toBe(false)
  })
})

describe('owningRoot', () => {
  it('嵌套成员选择最长匹配路径', () => {
    expect(owningRoot(workspaceWithRoots, join(alphaPath, 'src', 'app.ts'))?.alias).toBe('alpha')
    expect(owningRoot(workspaceWithRoots, join(nestedPath, 'src', 'app.ts'))?.alias).toBe('nested')
    expect(owningRoot(workspaceWithRoots, join(base, 'other', 'app.ts'))).toBeNull()
    expect(owningRoot(null, join(alphaPath, 'src', 'app.ts'))).toBeNull()
  })
})

describe('resolveWorkspacePath', () => {
  it('绝对路径原样规范化并归因到所属成员', () => {
    const input = join(alphaPath, 'src', '..', 'src', 'app.ts')
    const resolved = resolveWorkspacePath(input, workspaceWithRoots, sessionCwd)
    expect(resolved).toEqual({
      ok: true,
      absolutePath: join(alphaPath, 'src', 'app.ts'),
      root: workspaceWithRoots.roots[0],
    })
  })

  it('@别名 解析成员根目录与子路径', () => {
    expect(resolveWorkspacePath('@beta', workspaceWithRoots, sessionCwd)).toMatchObject({
      ok: true,
      absolutePath: betaPath,
      root: { alias: 'beta' },
    })
    expect(resolveWorkspacePath('@beta/src/app.ts', workspaceWithRoots, sessionCwd)).toMatchObject({
      ok: true,
      absolutePath: join(betaPath, 'src', 'app.ts'),
      root: { alias: 'beta' },
    })
    expect(
      resolveWorkspacePath('@beta\\src\\app.ts', workspaceWithRoots, sessionCwd),
    ).toMatchObject({ ok: true, absolutePath: join(betaPath, 'src', 'app.ts') })
  })

  it('裸相对路径锚定固定会话 cwd，而不是成员根目录', () => {
    expect(resolveWorkspacePath('src/app.ts', workspaceWithRoots, sessionCwd)).toEqual({
      ok: true,
      absolutePath: resolve(sessionCwd, 'src/app.ts'),
      root: null,
    })
  })

  it('未知别名列出可用成员', () => {
    const resolved = resolveWorkspacePath('@gamma/x', workspaceWithRoots, sessionCwd)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.error).toContain('@gamma')
      expect(resolved.error).toContain('@alpha, @beta, @nested')
    }
  })

  it('拒绝 @别名 路径逃逸出成员根目录', () => {
    const resolved = resolveWorkspacePath('@beta/../alpha/x', workspaceWithRoots, sessionCwd)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain('escapes workspace project')
  })

  it('成员不可用时明确失败', () => {
    const missingPath = join(base, 'missing', 'beta')
    const broken = workspace([{ alias: 'beta', path: missingPath, available: false }])
    const aliasResult = resolveWorkspacePath('@beta/x', broken, sessionCwd)
    const absoluteResult = resolveWorkspacePath(join(missingPath, 'x'), broken, sessionCwd)
    expect(aliasResult.ok).toBe(false)
    expect(absoluteResult.ok).toBe(false)
    if (!aliasResult.ok) expect(aliasResult.error).toContain('unavailable')
    if (!absoluteResult.ok) expect(absoluteResult.error).toContain('unavailable')
  })

  it('没有活动工作区时 @别名 失败，裸路径照旧可用', () => {
    const aliasResult = resolveWorkspacePath('@beta/x', null, sessionCwd)
    expect(aliasResult.ok).toBe(false)
    if (!aliasResult.ok) expect(aliasResult.error).toContain('No workspace is active')
    expect(resolveWorkspacePath('local.txt', null, sessionCwd)).toEqual({
      ok: true,
      absolutePath: resolve(sessionCwd, 'local.txt'),
      root: null,
    })
  })
})
