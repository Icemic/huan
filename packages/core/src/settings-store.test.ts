/**
 * 设置文件读写/校验的纯逻辑测试（G1.4a）。
 *
 * 覆盖：随包 schema 校验（未知字段透传）、原型污染键、revision、
 * 原子写入与失败清理、磁盘合并来源。全部使用临时目录。
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changedTopLevelKeys,
  mergeSettingsFromDisk,
  parseSettingsContent,
  readSettingsFile,
  restartRequiredKeys,
  SETTINGS_FILE_MAX_BYTES,
  settingsFilePaths,
  settingsRevision,
  writeSettingsFileAtomic,
} from './settings-store.js'
import { createIsolatedPiEnv, type IsolatedPiEnv } from './test-support.js'

let env: IsolatedPiEnv

beforeEach(async () => {
  env = await createIsolatedPiEnv('huan-settings-store-test-')
})

afterEach(async () => {
  await env.cleanup()
})

describe('设置 schema 校验', () => {
  it('已知字段合法时通过，未知字段与嵌套扩展配置原样保留', () => {
    const content = JSON.stringify({
      defaultProvider: 'huan-test',
      defaultModel: 'test-model-a',
      retry: { enabled: true, maxRetries: 2 },
      compaction: { enabled: false, reserveTokens: 1024 },
      customUnknown: { nested: [{ flag: true }] },
    })
    const { value, issues } = parseSettingsContent(content)
    expect(issues).toEqual([])
    expect(value).toMatchObject({
      customUnknown: { nested: [{ flag: true }] },
      retry: { enabled: true, maxRetries: 2 },
    })
  })

  it('非法类型与越界数字被拒绝（只报告位置，不回显值）', () => {
    const { issues } = parseSettingsContent(
      JSON.stringify({
        retry: { enabled: 'yes' },
        compaction: { reserveTokens: -1 },
      }),
    )
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.every((issue) => issue.kind === 'schema')).toBe(true)
    expect(issues.map((issue) => issue.path)).toContain('/retry/enabled')
    expect(issues.map((issue) => issue.path)).toContain('/compaction/reserveTokens')
    expect(JSON.stringify(issues)).not.toContain('yes')
  })

  it('解析错误不回显原文片段（避免把疑似密码写入诊断/日志）', () => {
    const secret = 'HUAN-SECRET-TOKEN'
    const { issues } = parseSettingsContent(`{"apiKey":"${secret}" bad`)
    expect(issues[0]?.kind).toBe('parse')
    expect(JSON.stringify(issues)).not.toContain(secret)
  })

  it('损坏 JSON 返回 parse 问题但保留其它路径', () => {
    const { value, issues } = parseSettingsContent('{ bad json')
    expect(value).toBeUndefined()
    expect(issues[0]?.kind).toBe('parse')
  })

  it('允许 UTF-8 BOM（SDK 同口径）', () => {
    const { value, issues } = parseSettingsContent(`${String.fromCharCode(0xfeff)}{"a":1}`)
    expect(issues).toEqual([])
    expect(value).toEqual({ a: 1 })
  })

  it('拒绝原型污染键（含嵌套）', () => {
    const top = parseSettingsContent('{"__proto__":{"polluted":true}}')
    expect(top.issues[0]?.kind).toBe('unsafe-key')
    const nested = parseSettingsContent('{"custom":{"constructor":{}}}')
    expect(nested.issues[0]?.kind).toBe('unsafe-key')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('设置文件读写', () => {
  it('revision 是原文 SHA-256；不存在文件为 null', async () => {
    const paths = settingsFilePaths(env.workspace, env.agentDir)
    const missing = await readSettingsFile(paths.project, 'project')
    expect(missing.exists).toBe(false)
    expect(missing.revision).toBeNull()

    const content = '{"a":1}'
    await writeSettingsFileAtomic(paths.project, content)
    const present = await readSettingsFile(paths.project, 'project')
    expect(present.exists).toBe(true)
    expect(present.content).toBe(content)
    expect(present.revision).toBe(settingsRevision(content))
  })

  it('超过读取上限时不返回不完整原文，便于 GUI 阻止覆盖', async () => {
    const paths = settingsFilePaths(env.workspace, env.agentDir)
    await writeSettingsFileAtomic(paths.user, 'x'.repeat(SETTINGS_FILE_MAX_BYTES + 1))
    const file = await readSettingsFile(paths.user, 'user')
    expect(file.tooLarge).toBe(true)
    expect(file.content).toBe('')
    expect(file.issues[0]?.kind).toBe('too-large')
  })

  it('原子写入失败时保留原文件并清理临时文件', async () => {
    const paths = settingsFilePaths(env.workspace, env.agentDir)
    // 目标路径是目录：rename 覆盖必然失败。
    await mkdir(paths.project, { recursive: true })
    await expect(writeSettingsFileAtomic(paths.project, '{"a":1}')).rejects.toBeTruthy()
    const entries = await readdir(join(env.workspace, '.pi'))
    expect(entries).toEqual(['settings.json'])
  })

  it('磁盘合并按项目 > 用户优先级，并给出来源', async () => {
    const paths = settingsFilePaths(env.workspace, env.agentDir)
    await writeSettingsFileAtomic(
      paths.user,
      JSON.stringify({ defaultModel: 'test-model-a', onlyUser: { a: 1 } }),
    )
    await writeSettingsFileAtomic(
      paths.project,
      JSON.stringify({ defaultModel: 'test-model-b', onlyProject: true }),
    )
    const effective = mergeSettingsFromDisk({
      cwd: env.workspace,
      agentDir: env.agentDir,
      projectTrusted: true,
      files: {
        user: await readSettingsFile(paths.user, 'user'),
        project: await readSettingsFile(paths.project, 'project'),
      },
    })
    expect(effective.values.defaultModel).toBe('test-model-b')
    expect(effective.values.onlyUser).toEqual({ a: 1 })
    expect(effective.origins.defaultModel).toBe('project')
    expect(effective.origins.onlyUser).toBe('user')
    expect(effective.origins.onlyProject).toBe('project')
  })

  it('项目未信任时合并忽略项目文件', async () => {
    const paths = settingsFilePaths(env.workspace, env.agentDir)
    await writeSettingsFileAtomic(paths.user, JSON.stringify({ defaultModel: 'test-model-a' }))
    await writeSettingsFileAtomic(paths.project, JSON.stringify({ defaultModel: 'test-model-b' }))
    const effective = mergeSettingsFromDisk({
      cwd: env.workspace,
      agentDir: env.agentDir,
      projectTrusted: false,
      files: {
        user: await readSettingsFile(paths.user, 'user'),
        project: await readSettingsFile(paths.project, 'project', { readable: false }),
      },
    })
    expect(effective.values.defaultModel).toBe('test-model-a')
    expect(effective.origins.defaultModel).toBe('user')
  })

  it('变化检测区分普通键与需重启键', () => {
    const changed = changedTopLevelKeys({ a: 1 }, { a: 2, sessionDir: '/x', httpProxy: 'p' })
    expect(changed.sort()).toEqual(['a', 'httpProxy', 'sessionDir'])
    expect(restartRequiredKeys(changed).sort()).toEqual(['httpProxy', 'sessionDir'])
  })
})
