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

  it('启动默认工作区使用稳定 ID，同一路径重启一致', async () => {
    const path = join(root, 'project')
    const store = new WorkspaceStore(agentDir)
    await store.load()
    const id = defaultWorkspaceId(agentDir, path)
    const workspace = store.seedDefaultWorkspace({ id, name: 'project', path })
    expect(workspace.id).toBe(id)
    expect(store.listWorkspaces()[0]?.id).toBe(id)
  })
})
