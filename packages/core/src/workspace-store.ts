/**
 * huan 工作区元数据存储（`<agentDir>/huan/state.json`）。
 *
 * 设计来源：多项目工作区迭代设计 §4。要点：
 * - 单个版本化 JSON 文件，工作区定义与会话归属共用；
 * - Node 宿主是唯一写入方，所有修改经过同一串行队列；
 * - 先写同目录临时文件再原子替换，成功后才提交内存；
 * - 文件损坏/未知版本保留原文件，不当作空状态覆盖；
 * - 会话归属按「会话存储根」摘要分作用域，切换 sessionDir 不串数据。
 */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** 当前文件格式版本。未知版本只读报错，不尝试迁移。 */
export const WORKSPACE_STATE_VERSION = 1 as const

/** 读取状态。`ok` 之外都保留原文件并禁止依赖元数据的写入。 */
export type WorkspaceStoreIntegrity = 'ok' | 'corrupted' | 'unsupported-version' | 'unreadable'

/** 持久化的工作区成员。 */
export type WorkspaceStoreProject = {
  alias: string
  path: string
}

/** 持久化的工作区定义。 */
export type WorkspaceStoreWorkspace = {
  id: string
  name: string
  revision: number
  projects: WorkspaceStoreProject[]
}

/** 会话在某个存储作用域内的附加元数据。 */
export type WorkspaceSessionMetadata = {
  /**
   * 明确归属的工作区；缺失表示未归属。
   *
   * 未归属会话也允许保存归档等组织标记，因此该字段可选。
   */
  workspaceId?: string
  /** 归档标记；重启保留，不修改 Pi JSONL。 */
  archived?: boolean
}

/** 对外暴露的只读快照（深拷贝，调用方不能修改内部状态）。 */
export type WorkspaceStoreState = {
  version: typeof WORKSPACE_STATE_VERSION
  workspaces: Record<string, Omit<WorkspaceStoreWorkspace, 'id'>>
  sessionMetadata: Record<string, Record<string, WorkspaceSessionMetadata>>
}

/** 工作区元数据不可用（损坏、未知版本或读取失败）。 */
export class WorkspaceStateUnavailableError extends Error {
  readonly code = 'workspace-state-unavailable'
  constructor(
    readonly integrity: Exclude<WorkspaceStoreIntegrity, 'ok'>,
    readonly stateFile: string,
  ) {
    super(`工作区元数据不可用（${integrity}）：${stateFile}`)
    this.name = 'WorkspaceStateUnavailableError'
  }
}

/** 修改携带的 revision 已过期。 */
export class WorkspaceConflictError extends Error {
  readonly code = 'workspace-conflict'
  constructor(readonly current: WorkspaceStoreWorkspace) {
    super(`工作区定义已更新（当前 revision ${current.revision}）`)
    this.name = 'WorkspaceConflictError'
  }
}

/** 工作区不存在。 */
export class WorkspaceNotFoundError extends Error {
  readonly code = 'workspace-not-found'
  constructor(readonly workspaceId: string) {
    super(`工作区不存在：${workspaceId}`)
    this.name = 'WorkspaceNotFoundError'
  }
}

/** 工作区定义或成员输入无效。 */
export class WorkspaceValidationError extends Error {
  readonly code = 'workspace-invalid'
  constructor(
    readonly reason:
      | 'invalid-name'
      | 'empty-projects'
      | 'invalid-alias'
      | 'duplicate-alias'
      | 'invalid-path',
  ) {
    super(`工作区输入无效：${reason}`)
    this.name = 'WorkspaceValidationError'
  }
}

/** 创建/修改工作区的输入。 */
export type WorkspaceMutationInput = {
  name: string
  projects: readonly WorkspaceStoreProject[]
}

/** 工作区 tick（JSON 内部形状）。 */
type StoredFile = {
  version?: unknown
  workspaces?: unknown
  sessionMetadata?: unknown
}

/** 规范化路径比较键：Windows 盘符/大小写不敏感。 */
function canonicalPathKey(path: string): string {
  const absolute = resolve(path)
  let canonical: string
  try {
    canonical = realpathSync(absolute)
  } catch (error) {
    // 尚未创建的 sessions 目录也解析已存在父目录，避免首次写入前后摘要变化。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    canonical =
      parent === absolute ? absolute : join(canonicalPathKey(parent), relative(parent, absolute))
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * 会话存储作用域标识。
 *
 * 使用实际存储根的确定性摘要：默认空间是 `<agentDir>/sessions`，显式覆盖
 * 是解析后的平铺 sessionDir。重启后相同目录得到相同标识。
 */
export function sessionStoreId(storageRoot: string): string {
  return createHash('sha256')
    .update(`huan-session-store:${canonicalPathKey(storageRoot)}`)
    .digest('hex')
    .slice(0, 16)
}

/** 工作区状态文件路径。 */
export function workspaceStateFile(agentDir: string): string {
  return join(agentDir, 'huan', 'state.json')
}

const ALIAS_PATTERN = /^[^\s/\\]+$/u

function validateMutation(input: WorkspaceMutationInput): {
  name: string
  projects: WorkspaceStoreProject[]
} {
  const name = input.name.trim()
  if (!name) throw new WorkspaceValidationError('invalid-name')
  if (input.projects.length === 0) throw new WorkspaceValidationError('empty-projects')
  const aliases = new Set<string>()
  const projects = input.projects.map((project) => {
    // 存储别名不带 @；容忍用户在管理界面输入 @alias 的写法。
    const alias = project.alias.trim().replace(/^@+/u, '')
    if (!alias || alias === '.' || alias === '..' || !ALIAS_PATTERN.test(alias)) {
      throw new WorkspaceValidationError('invalid-alias')
    }
    if (aliases.has(alias)) throw new WorkspaceValidationError('duplicate-alias')
    aliases.add(alias)
    const path = project.path.trim()
    if (!path || !isAbsolute(path)) throw new WorkspaceValidationError('invalid-path')
    return { alias, path: resolve(path) }
  })
  return { name, projects }
}

const sameProjects = (
  left: readonly WorkspaceStoreProject[],
  right: readonly WorkspaceStoreProject[],
): boolean =>
  left.length === right.length &&
  left.every((project, index) => {
    const peer = right[index]
    return peer !== undefined && project.alias === peer.alias && project.path === peer.path
  })

function parseStoredFile(value: unknown): WorkspaceStoreState {
  if (value === null || typeof value !== 'object') throw new Error('state.json 不是对象')
  const file = value as StoredFile
  if (file.version !== WORKSPACE_STATE_VERSION) {
    // 交给调用方区分未知版本与普通损坏。
    throw new UnsupportedVersionError(file.version)
  }
  if (!file.workspaces || typeof file.workspaces !== 'object' || Array.isArray(file.workspaces)) {
    throw new Error('state.json 缺少 workspaces 对象')
  }
  if (
    !file.sessionMetadata ||
    typeof file.sessionMetadata !== 'object' ||
    Array.isArray(file.sessionMetadata)
  ) {
    throw new Error('state.json 缺少 sessionMetadata 对象')
  }

  const workspaces: WorkspaceStoreState['workspaces'] = {}
  for (const [id, raw] of Object.entries((file.workspaces ?? {}) as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') throw new Error(`工作区 ${id} 无效`)
    const candidate = raw as { name?: unknown; revision?: unknown; projects?: unknown }
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
      throw new Error(`工作区 ${id} 缺少名称`)
    }
    if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1) {
      throw new Error(`工作区 ${id} 的 revision 无效`)
    }
    if (!Array.isArray(candidate.projects) || candidate.projects.length === 0) {
      throw new Error(`工作区 ${id} 缺少成员`)
    }
    const projects = candidate.projects.map((project) => {
      if (project === null || typeof project !== 'object') {
        throw new Error(`工作区 ${id} 的成员无效`)
      }
      const member = project as { alias?: unknown; path?: unknown }
      if (typeof member.alias !== 'string' || typeof member.path !== 'string') {
        throw new Error(`工作区 ${id} 的成员缺少 alias/path`)
      }
      return { alias: member.alias, path: member.path }
    })
    // 复用写入口校验，避免手改文件后产生非法别名/重复别名。
    const normalized = validateMutation({ name: candidate.name, projects })
    workspaces[id] = {
      name: normalized.name,
      revision: candidate.revision as number,
      projects: normalized.projects,
    }
  }

  const sessionMetadata: WorkspaceStoreState['sessionMetadata'] = {}
  for (const [storeId, raw] of Object.entries(
    (file.sessionMetadata ?? {}) as Record<string, unknown>,
  )) {
    if (raw === null || typeof raw !== 'object') throw new Error(`会话作用域 ${storeId} 无效`)
    const sessions: Record<string, WorkspaceSessionMetadata> = {}
    for (const [sessionId, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') {
        throw new Error(`会话 ${sessionId} 的元数据无效`)
      }
      const candidate = entry as { workspaceId?: unknown; archived?: unknown }
      const workspaceId = candidate.workspaceId
      if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !workspaceId)) {
        throw new Error(`会话 ${sessionId} 的 workspaceId 无效`)
      }
      const archived = candidate.archived
      if (archived !== undefined && typeof archived !== 'boolean') {
        throw new Error(`会话 ${sessionId} 的 archived 无效`)
      }
      if (workspaceId === undefined && archived !== true) {
        // 既无归属也未归档的空条目没有语义，视为损坏而不静默丢弃。
        throw new Error(`会话 ${sessionId} 的元数据为空`)
      }
      sessions[sessionId] = {
        ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
        ...(archived === true ? { archived: true } : {}),
      }
    }
    sessionMetadata[storeId] = sessions
  }

  return { version: WORKSPACE_STATE_VERSION, workspaces, sessionMetadata }
}

class UnsupportedVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`不支持的 state.json 版本：${String(version)}`)
  }
}

/** 深拷贝状态，避免调用方修改内部对象。 */
function cloneState(state: WorkspaceStoreState): WorkspaceStoreState {
  const workspaces: WorkspaceStoreState['workspaces'] = {}
  for (const [id, workspace] of Object.entries(state.workspaces)) {
    workspaces[id] = {
      name: workspace.name,
      revision: workspace.revision,
      projects: workspace.projects.map((project) => ({ ...project })),
    }
  }
  const sessionMetadata: WorkspaceStoreState['sessionMetadata'] = {}
  for (const [storeId, sessions] of Object.entries(state.sessionMetadata)) {
    sessionMetadata[storeId] = Object.fromEntries(
      Object.entries(sessions).map(([sessionId, entry]) => [sessionId, { ...entry }]),
    )
  }
  return { version: state.version, workspaces, sessionMetadata }
}

/** 单宿主串行、原子落盘的工作区存储。 */
export class WorkspaceStore {
  readonly stateFile: string
  #state: WorkspaceStoreState = emptyState()
  #integrity: WorkspaceStoreIntegrity = 'ok'
  /** 串行写入链：每次修改基于上一笔成功后的内存状态生成新文件。 */
  #writeChain: Promise<unknown> = Promise.resolve()
  #tempCounter = 0
  #loaded = false

  constructor(readonly agentDir: string) {
    this.stateFile = workspaceStateFile(agentDir)
  }

  get integrity(): WorkspaceStoreIntegrity {
    return this.#integrity
  }

  get healthy(): boolean {
    return this.#integrity === 'ok'
  }

  /** 读取一次磁盘状态；只读方式不会创建目录或文件。 */
  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    let text: string
    try {
      text = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#state = emptyState()
        this.#integrity = 'ok'
        return
      }
      this.#state = emptyState()
      this.#integrity = 'unreadable'
      return
    }
    try {
      this.#state = parseStoredFile(JSON.parse(text) as unknown)
      this.#integrity = 'ok'
    } catch (error) {
      // 保留原文件；重复加载也不会覆盖。
      this.#state = emptyState()
      this.#integrity =
        error instanceof UnsupportedVersionError ? 'unsupported-version' : 'corrupted'
    }
  }

  /** 当前内存状态快照。 */
  snapshot(): WorkspaceStoreState {
    return cloneState(this.#state)
  }

  /** 按 ID 顺序列出工作区（ID 排序保证 UI 稳定）。 */
  listWorkspaces(): WorkspaceStoreWorkspace[] {
    return Object.entries(this.#state.workspaces)
      .map(([id, workspace]) => ({
        id,
        name: workspace.name,
        revision: workspace.revision,
        projects: workspace.projects.map((project) => ({ ...project })),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  workspace(workspaceId: string): WorkspaceStoreWorkspace | undefined {
    const workspace = this.#state.workspaces[workspaceId]
    if (!workspace) return undefined
    return {
      id: workspaceId,
      name: workspace.name,
      revision: workspace.revision,
      projects: workspace.projects.map((project) => ({ ...project })),
    }
  }

  /** 会话归属；没有记录时返回 undefined（绝不按 cwd 推断）。 */
  sessionWorkspace(storeId: string, sessionId: string): string | undefined {
    return this.#state.sessionMetadata[storeId]?.[sessionId]?.workspaceId
  }

  /** 会话归档标记；没有记录时为 false。 */
  sessionArchived(storeId: string, sessionId: string): boolean {
    return this.#state.sessionMetadata[storeId]?.[sessionId]?.archived === true
  }

  /**
   * 启动时的单项目工作区兜底。
   *
   * 只在状态健康且当前没有任何工作区时放入内存（不立即写盘）。它为
   * 「单项目也用同一模型」提供默认入口；已有无元数据的 Pi 会话不会被
   * 自动归入，必须由用户明确接入。
   */
  seedDefaultWorkspace(input: { id: string; name: string; path: string }): WorkspaceStoreWorkspace {
    const existing = this.workspace(input.id)
    if (existing) return existing
    if (!this.healthy || this.listWorkspaces().length > 0) {
      throw new WorkspaceStateUnavailableError(
        this.#integrity === 'ok' ? 'unreadable' : this.#integrity,
        this.stateFile,
      )
    }
    const workspace: WorkspaceStoreWorkspace = {
      id: input.id,
      name: input.name.trim() || '默认工作区',
      revision: 1,
      projects: [{ alias: defaultAlias(input.path), path: resolve(input.path) }],
    }
    this.#state.workspaces[workspace.id] = {
      name: workspace.name,
      revision: workspace.revision,
      projects: workspace.projects,
    }
    return workspace
  }

  /** 创建工作区并原子落盘；成功后才进入内存。 */
  async createWorkspace(input: WorkspaceMutationInput): Promise<WorkspaceStoreWorkspace> {
    const normalized = validateMutation(input)
    return this.enqueue(async () => {
      this.assertHealthy()
      const id = `ws_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const workspace: WorkspaceStoreWorkspace = {
        id,
        name: normalized.name,
        revision: 1,
        projects: normalized.projects,
      }
      const next = cloneState(this.#state)
      next.workspaces[id] = {
        name: workspace.name,
        revision: workspace.revision,
        projects: workspace.projects,
      }
      await this.commit(next)
      return workspace
    })
  }

  /** 修改名称/成员；携带过期 revision 时返回冲突。 */
  async updateWorkspace(input: {
    workspaceId: string
    expectedRevision: number
    name?: string
    projects?: readonly WorkspaceStoreProject[]
  }): Promise<WorkspaceStoreWorkspace> {
    return this.enqueue(async () => {
      this.assertHealthy()
      const current = this.workspace(input.workspaceId)
      if (!current) throw new WorkspaceNotFoundError(input.workspaceId)
      if (current.revision !== input.expectedRevision) throw new WorkspaceConflictError(current)
      const normalized = validateMutation({
        name: input.name ?? current.name,
        projects: input.projects ?? current.projects,
      })
      if (normalized.name === current.name && sameProjects(normalized.projects, current.projects)) {
        return current
      }
      const next = cloneState(this.#state)
      next.workspaces[current.id] = {
        name: normalized.name,
        revision: current.revision + 1,
        projects: normalized.projects,
      }
      await this.commit(next)
      return {
        id: current.id,
        name: normalized.name,
        revision: current.revision + 1,
        projects: normalized.projects,
      }
    })
  }

  /** 会话明确加入工作区（覆盖为同一工作区是幂等操作）；保留归档标记。 */
  async assignSession(input: {
    storeId: string
    sessionId: string
    workspaceId: string
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertHealthy()
      if (!this.workspace(input.workspaceId)) throw new WorkspaceNotFoundError(input.workspaceId)
      if (this.sessionWorkspace(input.storeId, input.sessionId) === input.workspaceId) return
      const next = cloneState(this.#state)
      const existing = next.sessionMetadata[input.storeId]?.[input.sessionId]
      const sessions = next.sessionMetadata[input.storeId] ?? {}
      // 归属更新不能丢掉同一会话的归档等组织标记。
      sessions[input.sessionId] = { ...existing, workspaceId: input.workspaceId }
      next.sessionMetadata[input.storeId] = sessions
      await this.commit(next)
    })
  }

  /**
   * 设置/清除归档标记。
   *
   * 不改工作区 revision，也不修改 Pi JSONL；未归属会话同样可以归档。
   */
  async setSessionArchived(input: {
    storeId: string
    sessionId: string
    archived: boolean
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertHealthy()
      const existing = this.#state.sessionMetadata[input.storeId]?.[input.sessionId]
      if ((existing?.archived === true) === input.archived) return
      const next = cloneState(this.#state)
      const sessions = { ...(next.sessionMetadata[input.storeId] ?? {}) }
      const entry: WorkspaceSessionMetadata = { ...existing }
      if (input.archived) entry.archived = true
      else delete entry.archived
      // 既无归属也不再归档时删除条目，避免留下空对象。
      if (entry.workspaceId === undefined && entry.archived === undefined) {
        delete sessions[input.sessionId]
      } else {
        sessions[input.sessionId] = entry
      }
      if (Object.keys(sessions).length === 0) delete next.sessionMetadata[input.storeId]
      else next.sessionMetadata[input.storeId] = sessions
      await this.commit(next)
    })
  }

  /** 删除会话文件成功后清理其归属与归档元数据。 */
  async removeSessionMetadata(input: { storeId: string; sessionId: string }): Promise<void> {
    await this.enqueue(async () => {
      this.assertHealthy()
      const existing = this.#state.sessionMetadata[input.storeId]?.[input.sessionId]
      if (!existing) return
      const next = cloneState(this.#state)
      const sessions = { ...(next.sessionMetadata[input.storeId] ?? {}) }
      delete sessions[input.sessionId]
      if (Object.keys(sessions).length === 0) delete next.sessionMetadata[input.storeId]
      else next.sessionMetadata[input.storeId] = sessions
      await this.commit(next)
    })
  }

  private assertHealthy(): void {
    if (!this.healthy) {
      throw new WorkspaceStateUnavailableError(
        this.#integrity === 'ok' ? 'unreadable' : this.#integrity,
        this.stateFile,
      )
    }
  }

  /** 串行执行修改；失败不会污染后续队列。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writeChain.then(task, task)
    this.#writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 写临时文件 → 原子替换 → 提交内存。任何一步失败都不改变内存。 */
  private async commit(next: WorkspaceStoreState): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    this.#tempCounter += 1
    const tempFile = `${this.stateFile}.${process.pid}.${this.#tempCounter}.tmp`
    const payload = `${JSON.stringify(next, null, 2)}\n`
    try {
      const handle = await open(tempFile, 'w', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tempFile, this.stateFile)
    } catch (error) {
      await rm(tempFile, { force: true }).catch(() => {})
      throw error
    }
    this.#state = next
  }
}

function emptyState(): WorkspaceStoreState {
  return { version: WORKSPACE_STATE_VERSION, workspaces: {}, sessionMetadata: {} }
}

/** 默认工作区的稳定 ID：同一 agentDir + 启动路径重启后一致。 */
export function defaultWorkspaceId(agentDir: string, path: string): string {
  return `ws_start_${createHash('sha256')
    .update(`${canonicalPathKey(agentDir)}\u0000${canonicalPathKey(path)}`)
    .digest('hex')
    .slice(0, 12)}`
}

/** 从路径生成合法别名（保留中文，去掉路径分隔符与空白）。 */
export function defaultAlias(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  const base = segments[segments.length - 1] ?? 'project'
  const alias = base
    .replace(/[\s/\\]+/gu, '-')
    .replace(/^@+/, '')
    .trim()
  return alias || 'project'
}
