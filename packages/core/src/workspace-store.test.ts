import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultWorkspaceId,
  sessionStoreId,
  WorkspaceConflictError,
  WorkspaceStateUnavailableError,
  WorkspaceStore,
  workspaceStateFile,
} from './workspace-store.js'

let root: string
let agentDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'huan-workspace-store-'))
  agentDir = join(root, 'agent')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('工作区元数据存储', () => {
  it('缺失文件初始化为空；创建后落盘并可重新加载', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    expect(store.integrity).toBe('ok')
    expect(store.listWorkspaces()).toEqual([])

    const workspace = await store.createWorkspace({
      name: '幻开发',
      projects: [
        { alias: 'harness', path: join(root, 'huan') },
        { alias: 'editor', path: join(root, 'editor') },
      ],
    })
    expect(workspace.revision).toBe(1)
    const file = workspaceStateFile(agentDir)
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.workspaces[workspace.id]).toMatchObject({
      name: '幻开发',
      revision: 1,
      projects: [
        { alias: 'harness', path: join(root, 'huan') },
        { alias: 'editor', path: join(root, 'editor') },
      ],
    })
    // 原子写完成后不留下临时文件。
    const entries = await readdir(join(agentDir, 'huan'))
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([])

    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(reloaded.listWorkspaces()).toEqual([workspace])
  })

  it('链接父目录下尚未创建的存储根，创建前后作用域 ID 一致', async () => {
    const real = join(root, 'real')
    const linked = join(root, 'linked')
    await mkdir(real)
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const nested = join(linked, 'agent', 'sessions')
    const before = sessionStoreId(nested)
    await mkdir(nested, { recursive: true })
    expect(sessionStoreId(nested)).toBe(before)
    expect(sessionStoreId(join(real, 'agent', 'sessions'))).toBe(before)
  })

  it.each([null, []])('元数据顶层集合为 %j 时不作为空状态覆盖', async (value) => {
    await mkdir(join(agentDir, 'huan'), { recursive: true })
    const content = JSON.stringify({ version: 1, workspaces: value, sessionMetadata: {} })
    await writeFile(workspaceStateFile(agentDir), content)
    const store = new WorkspaceStore(agentDir)
    await store.load()
    expect(store.integrity).toBe('corrupted')
    await expect(
      store.createWorkspace({ name: '禁止覆盖', projects: [{ alias: 'a', path: root }] }),
    ).rejects.toBeInstanceOf(WorkspaceStateUnavailableError)
    expect(await readFile(workspaceStateFile(agentDir), 'utf8')).toBe(content)
  })

  it('revision 冲突不覆盖文件，成功修改才递增', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const created = await store.createWorkspace({
      name: '工作区',
      projects: [{ alias: 'a', path: join(root, 'a') }],
    })

    const updated = await store.updateWorkspace({
      workspaceId: created.id,
      expectedRevision: 1,
      name: '改名后',
      projects: [
        { alias: 'a', path: join(root, 'a') },
        { alias: 'b', path: join(root, 'b') },
      ],
    })
    expect(updated.revision).toBe(2)
    expect(updated.name).toBe('改名后')

    await expect(
      store.updateWorkspace({
        workspaceId: created.id,
        expectedRevision: 1,
        name: '过期写入',
      }),
    ).rejects.toBeInstanceOf(WorkspaceConflictError)
    expect(store.workspace(created.id)?.name).toBe('改名后')
    const onDisk = JSON.parse(await readFile(workspaceStateFile(agentDir), 'utf8'))
    expect(onDisk.workspaces[created.id].name).toBe('改名后')
    expect(onDisk.workspaces[created.id].revision).toBe(2)
  })

  it('工作区模型范围可创建/完整替换/清除，空数组不被当作继承', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const created = await store.createWorkspace({
      name: '范围工作区',
      projects: [{ alias: 'a', path: join(root, 'a') }],
      modelPatterns: [' huan-test/a ', 'huan-test/a', 'huan-test/b:high'],
    })
    expect(created.modelPatterns).toEqual(['huan-test/a', 'huan-test/b:high'])

    const replaced = await store.updateWorkspace({
      workspaceId: created.id,
      expectedRevision: created.revision,
      modelPatterns: ['huan-test/c'],
    })
    expect(replaced.modelPatterns).toEqual(['huan-test/c'])
    expect(replaced.revision).toBe(created.revision + 1)

    // 相同范围不制造新 revision。
    const unchanged = await store.updateWorkspace({
      workspaceId: created.id,
      expectedRevision: replaced.revision,
      modelPatterns: ['huan-test/c'],
    })
    expect(unchanged.revision).toBe(replaced.revision)

    const cleared = await store.updateWorkspace({
      workspaceId: created.id,
      expectedRevision: replaced.revision,
      modelPatterns: null,
    })
    expect(cleared.modelPatterns).toBeUndefined()

    await expect(
      store.updateWorkspace({
        workspaceId: created.id,
        expectedRevision: cleared.revision,
        modelPatterns: [],
      }),
    ).rejects.toThrow('invalid-model-patterns')

    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(reloaded.workspace(created.id)?.modelPatterns).toBeUndefined()
  })

  it('会话归属按存储根摘要隔离，同一会话 ID 不会跨作用域串用', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const workspace = await store.createWorkspace({
      name: '工作区',
      projects: [{ alias: 'a', path: join(root, 'a') }],
    })
    const storeA = sessionStoreId(join(root, 'sessions'))
    const storeB = sessionStoreId(join(root, 'flat-sessions'))
    expect(storeA).not.toBe(storeB)

    await store.assignSession({ storeId: storeA, sessionId: 'same-id', workspaceId: workspace.id })
    expect(store.sessionWorkspace(storeA, 'same-id')).toBe(workspace.id)
    expect(store.sessionWorkspace(storeB, 'same-id')).toBeUndefined()

    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(reloaded.sessionWorkspace(storeA, 'same-id')).toBe(workspace.id)
    expect(reloaded.sessionWorkspace(storeB, 'same-id')).toBeUndefined()
  })

  it('损坏或未知版本保留原文件，依赖元数据的写入被拒绝', async () => {
    const file = workspaceStateFile(agentDir)
    await mkdir(join(agentDir, 'huan'), { recursive: true })
    await writeFile(file, '{ broken')
    const original = await readFile(file, 'utf8')
    const corrupted = new WorkspaceStore(agentDir)
    await corrupted.load()
    expect(corrupted.integrity).toBe('corrupted')
    await expect(
      corrupted.createWorkspace({
        name: '不应创建',
        projects: [{ alias: 'a', path: join(root, 'a') }],
      }),
    ).rejects.toBeInstanceOf(WorkspaceStateUnavailableError)
    expect(await readFile(file, 'utf8')).toBe(original)

    await writeFile(file, JSON.stringify({ version: 99, workspaces: {}, sessionMetadata: {} }))
    const unsupported = new WorkspaceStore(agentDir)
    await unsupported.load()
    expect(unsupported.integrity).toBe('unsupported-version')
    await expect(
      unsupported.assignSession({ storeId: 'x', sessionId: 'y', workspaceId: 'z' }),
    ).rejects.toBeInstanceOf(WorkspaceStateUnavailableError)
  })

  it('写入失败不提交内存，也不留下临时文件', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const first = await store.createWorkspace({
      name: '已提交',
      projects: [{ alias: 'a', path: join(root, 'a') }],
    })
    // 用目录占据 state.json，使原子替换必然失败（跨平台稳定）。
    const file = workspaceStateFile(agentDir)
    await rm(file, { force: true })
    await mkdir(file, { recursive: true })

    await expect(
      store.createWorkspace({
        name: '不应提交',
        projects: [{ alias: 'b', path: join(root, 'b') }],
      }),
    ).rejects.toBeTruthy()
    expect(store.listWorkspaces()).toEqual([first])
    const entries = await readdir(join(agentDir, 'huan'))
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('并发修改经同一队列串行落盘', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const created = await Promise.all([
      store.createWorkspace({
        name: '并发一',
        projects: [{ alias: 'a', path: join(root, 'a') }],
      }),
      store.createWorkspace({
        name: '并发二',
        projects: [{ alias: 'b', path: join(root, 'b') }],
      }),
    ])
    expect(new Set(created.map((workspace) => workspace.id)).size).toBe(2)
    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(
      reloaded
        .listWorkspaces()
        .map((workspace) => workspace.name)
        .sort(),
    ).toEqual(['并发一', '并发二'])
  })

  it('归档可独立于归属保存：未归属归档、再归属保留、重启恢复与删除清理', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const workspace = await store.createWorkspace({
      name: '工作区',
      projects: [{ alias: 'a', path: join(root, 'a') }],
    })
    const storeA = sessionStoreId(join(root, 'sessions'))
    const storeB = sessionStoreId(join(root, 'flat-sessions'))

    // 未归属会话可以归档：只写 archived，不要求 workspaceId。
    await store.setSessionArchived({ storeId: storeA, sessionId: 's1', archived: true })
    expect(store.sessionArchived(storeA, 's1')).toBe(true)
    expect(store.sessionWorkspace(storeA, 's1')).toBeUndefined()
    const onDisk = JSON.parse(await readFile(workspaceStateFile(agentDir), 'utf8'))
    expect(onDisk.sessionMetadata[storeA].s1).toEqual({ archived: true })
    // 归档按存储作用域隔离。
    expect(store.sessionArchived(storeB, 's1')).toBe(false)

    // 归属更新保留归档，且不改工作区 revision。
    await store.assignSession({ storeId: storeA, sessionId: 's1', workspaceId: workspace.id })
    expect(store.sessionWorkspace(storeA, 's1')).toBe(workspace.id)
    expect(store.sessionArchived(storeA, 's1')).toBe(true)
    const afterAssign = JSON.parse(await readFile(workspaceStateFile(agentDir), 'utf8'))
    expect(afterAssign.workspaces[workspace.id].revision).toBe(workspace.revision)

    // 重启后归档与归属都恢复。
    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(reloaded.sessionArchived(storeA, 's1')).toBe(true)
    expect(reloaded.sessionWorkspace(storeA, 's1')).toBe(workspace.id)

    // 清除归档但保留归属；再清除后条目被删除。
    await reloaded.setSessionArchived({ storeId: storeA, sessionId: 's1', archived: false })
    expect(reloaded.sessionArchived(storeA, 's1')).toBe(false)
    expect(reloaded.sessionWorkspace(storeA, 's1')).toBe(workspace.id)
    const assignedOnly = JSON.parse(await readFile(workspaceStateFile(agentDir), 'utf8'))
    expect(assignedOnly.sessionMetadata[storeA].s1).toEqual({ workspaceId: workspace.id })

    // 删除会话元数据后不留空作用域。
    await reloaded.removeSessionMetadata({ storeId: storeA, sessionId: 's1' })
    expect(reloaded.sessionWorkspace(storeA, 's1')).toBeUndefined()
    const cleared = JSON.parse(await readFile(workspaceStateFile(agentDir), 'utf8'))
    expect(cleared.sessionMetadata[storeA]).toBeUndefined()
  })

  it('未归属归档被取消后删除空条目，不产生无意义元数据', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const storeA = sessionStoreId(join(root, 'sessions'))
    await store.setSessionArchived({ storeId: storeA, sessionId: 's2', archived: true })
    await store.setSessionArchived({ storeId: storeA, sessionId: 's2', archived: false })
    const onDisk = JSON.parse(await readFile(workspaceStateFile(agentDir), 'utf8'))
    expect(onDisk.sessionMetadata[storeA]).toBeUndefined()
  })

  it('损坏状态下归档与删除清理被拒绝，原文件保持不变', async () => {
    const file = workspaceStateFile(agentDir)
    await mkdir(join(agentDir, 'huan'), { recursive: true })
    await writeFile(file, '{ broken')
    const original = await readFile(file, 'utf8')
    const store = new WorkspaceStore(agentDir)
    await store.load()
    expect(store.integrity).toBe('corrupted')
    await expect(
      store.setSessionArchived({ storeId: 's', sessionId: 'x', archived: true }),
    ).rejects.toBeInstanceOf(WorkspaceStateUnavailableError)
    await expect(
      store.removeSessionMetadata({ storeId: 's', sessionId: 'x' }),
    ).rejects.toBeInstanceOf(WorkspaceStateUnavailableError)
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('会话元数据缺少归属且未归档时视为损坏，不静默丢弃', async () => {
    await mkdir(join(agentDir, 'huan'), { recursive: true })
    await writeFile(
      workspaceStateFile(agentDir),
      JSON.stringify({ version: 1, workspaces: {}, sessionMetadata: { store: { s: {} } } }),
    )
    const store = new WorkspaceStore(agentDir)
    await store.load()
    expect(store.integrity).toBe('corrupted')
  })

  it('启动默认工作区使用稳定 ID，同一路径重启一致', async () => {
    const path = join(root, 'project')
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const id = defaultWorkspaceId(agentDir, path)
    const workspace = store.seedDefaultWorkspace({ id, name: 'project', path })
    expect(workspace.id).toBe(id)
    expect(store.listWorkspaces()[0]?.id).toBe(id)
  })

  it('树落点与归属/归档互相保留，null 落点与水位重启可读', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const workspace = await store.createWorkspace({
      name: '树落点',
      projects: [{ alias: 'a', path: join(root, 'a') }],
    })
    const storeId = sessionStoreId(join(root, 'sessions'))
    await store.assignSession({ storeId, sessionId: 's1', workspaceId: workspace.id })
    await store.setSessionArchived({ storeId, sessionId: 's1', archived: true })
    await store.setSessionLeaf({
      storeId,
      sessionId: 's1',
      leaf: { leafId: null, entryCount: 0 },
    })

    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(reloaded.sessionLeaf(storeId, 's1')).toEqual({ leafId: null, entryCount: 0 })
    expect(reloaded.sessionWorkspace(storeId, 's1')).toBe(workspace.id)
    expect(reloaded.sessionArchived(storeId, 's1')).toBe(true)

    // 归属与归档更新不得丢掉树落点。
    await reloaded.assignSession({ storeId, sessionId: 's1', workspaceId: workspace.id })
    await reloaded.setSessionArchived({ storeId, sessionId: 's1', archived: false })
    expect(reloaded.sessionLeaf(storeId, 's1')).toEqual({ leafId: null, entryCount: 0 })

    await reloaded.setSessionLeaf({
      storeId,
      sessionId: 's1',
      leaf: { leafId: 'entry-1', entryCount: 4 },
    })
    const afterLeaf = new WorkspaceStore(agentDir)
    await afterLeaf.load()
    expect(afterLeaf.sessionLeaf(storeId, 's1')).toEqual({
      leafId: 'entry-1',
      entryCount: 4,
    })

    // 清除落点后保留归属，不留下空条目。
    await afterLeaf.setSessionLeaf({ storeId, sessionId: 's1', leaf: undefined })
    expect(afterLeaf.sessionLeaf(storeId, 's1')).toBeUndefined()
    expect(afterLeaf.sessionWorkspace(storeId, 's1')).toBe(workspace.id)
  })

  it('仅树落点的未归属会话元数据可保存，不要求归属或归档', async () => {
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const storeId = sessionStoreId(join(root, 'sessions'))
    await store.setSessionLeaf({
      storeId,
      sessionId: 'unassigned',
      leaf: { leafId: null, entryCount: 2 },
    })
    const reloaded = new WorkspaceStore(agentDir)
    await reloaded.load()
    expect(reloaded.integrity).toBe('ok')
    expect(reloaded.sessionLeaf(storeId, 'unassigned')).toEqual({
      leafId: null,
      entryCount: 2,
    })
    expect(reloaded.sessionWorkspace(storeId, 'unassigned')).toBeUndefined()
  })

  it('非法树落点（水位/leafId）视为损坏且不覆盖文件', async () => {
    const storeId = sessionStoreId(join(root, 'sessions'))
    for (const leaf of [
      { leafId: 'e', entryCount: -1 },
      { leafId: '', entryCount: 1 },
      { leafId: 1, entryCount: 1 },
      { entryCount: 1 },
    ]) {
      await mkdir(join(agentDir, 'huan'), { recursive: true })
      const content = JSON.stringify({
        version: 1,
        workspaces: {},
        sessionMetadata: { [storeId]: { s: { leaf } } },
      })
      await writeFile(workspaceStateFile(agentDir), content)
      const store = new WorkspaceStore(agentDir)
      await store.load()
      expect(store.integrity).toBe('corrupted')
      expect(await readFile(workspaceStateFile(agentDir), 'utf8')).toBe(content)
    }
  })
})
