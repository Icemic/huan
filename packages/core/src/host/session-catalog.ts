/**
 * 会话目录服务：唯一持有作用域扫描缓存、冷读 SessionManager 与只读投影。
 *
 * 冷读只打开 JSONL/sidecar，不构造 AgentSession、不装配项目扩展、不联网。
 * 目录扫描与 live 事件合并为同一元数据实体：列表只负责目录字段，运行字段
 * 仍取 live record。
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessThreadDetails,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessThreadTree,
} from '@huan/protocol'
import { deriveContextUsage } from '../context-usage.js'
import { mapColdMetadata, mapSessionInfo, type SessionCatalogInfo } from '../metadata.js'
import { getModelReadiness } from '../model-catalog.js'
import { defaultSessionsRoot, isPathWithinScope, type ResolvedSessionDir } from '../session-dir.js'
import { aggregateSessionStats } from '../session-stats.js'
import { applyStoredSessionLeaf, buildSessionTree, sessionTreeRevision } from '../session-tree.js'
import type { WorkspaceStore } from '../workspace-store.js'
import type { SharedModelRuntime } from './model-service.js'
import type { SessionEvents } from './session-events.js'
import { mapWithConcurrency, SCOPE_LIST_CONCURRENCY, type ThreadRecord } from './shared.js'

/** live 会话只向目录借出实际需要的投影。 */
export type CatalogLiveView = {
  get(threadId: string): ThreadRecord | undefined
  all(): Iterable<ThreadRecord>
  metadataOf(record: ThreadRecord): HarnessThreadMetadata
  snapshotOf(record: ThreadRecord): HarnessThreadSnapshot
  treeOperationView(
    record: ThreadRecord,
  ): import('@huan/protocol').HarnessThreadTreeOperation | undefined
}

export type SessionCatalogDeps = {
  agentDir: string
  workspacePath: string
  resolveSessionDirFor: (cwd: string) => ResolvedSessionDir
  workspaceStore: WorkspaceStore
  storeId: string
  modelRuntime: SharedModelRuntime
  events: Pick<SessionEvents, 'sessionWorkspaceFields'>
}

export class SessionCatalog {
  /**
   * 整个存储作用域（默认空间或平铺覆盖）的跨 cwd 列表缓存，按作用域目录区分。
   */
  private readonly scopeCatalogCache = new Map<
    string,
    { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> }
  >()
  private live: CatalogLiveView | undefined

  constructor(private readonly deps: SessionCatalogDeps) {}

  /** 组合根在 live 服务创建后绑定；目录在此之前只提供冷读。 */
  attachLive(live: CatalogLiveView): void {
    this.live = live
  }

  /** 作用域目录：记录本身的 cwd（空值回退启动工作区）。 */
  scopeOf(cwd: string | undefined): ResolvedSessionDir {
    return this.deps.resolveSessionDirFor(cwd?.trim() ? cwd : this.deps.workspacePath)
  }

  /** 作用域根：默认空间为 `<agentDir>/sessions`（可跨分组），平铺覆盖为其自身。 */
  scopeRootOf(scope: ResolvedSessionDir): string {
    return scope.grouped ? defaultSessionsRoot(this.deps.agentDir) : scope.dir
  }

  /**
   * 存储作用域校验：仅接受当前空间内的会话文件。
   * 作用域外的路径（包括指向外部的符号链接）一律拒绝，用于打开/改名/删除。
   */
  assertSessionFileInScope(filePath: string, cwd: string | undefined): ResolvedSessionDir {
    const scope = this.scopeOf(cwd)
    if (!isPathWithinScope(this.scopeRootOf(scope), filePath)) {
      throw new Error(`会话文件不在当前存储作用域内：${filePath}`)
    }
    return scope
  }

  /**
   * 打开作用域内的会话记录并统一应用有效树落点。
   *
   * 冷树、冷快照、冷详情与 ensureOpen 必须共用这一入口，避免任一路径遗漏
   * 水位/节点校验或错误地写入 Pi 文件。
   */
  openScopedSessionManager(info: SessionCatalogInfo): SessionManager {
    const scope = this.assertSessionFileInScope(info.path, info.cwd)
    const sessionManager = SessionManager.open(info.path, scope.dir)
    applyStoredSessionLeaf(
      sessionManager,
      this.deps.workspaceStore.healthy
        ? this.deps.workspaceStore.sessionLeaf(this.deps.storeId, info.id)
        : undefined,
    )
    return sessionManager
  }

  /**
   * 默认空间的跨 cwd 枚举：只扫描当前 agentDir 下 sessions 的直接分组目录。
   *
   * 不用无参 `SessionManager.listAll()`（它读进程默认用户空间，会泄漏到另一个
   * agentDir）；也不用递归扫描。路径符号链接的分组目录不作为隐式入口（避免
   * 默认空间变成任意外部目录的入口）。
   */
  private async listGroupedScopeInfos(): Promise<SessionCatalogInfo[]> {
    const sessionsRoot = defaultSessionsRoot(this.deps.agentDir)
    let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>
    try {
      entries = await readdir(sessionsRoot, { withFileTypes: true })
    } catch (error) {
      // 只有「不存在」等价于空目录；权限、非目录等故障必须上报，
      // 不能笼统吞成空列表（否则用户看到的是「没有会话」而不是「目录不可用」）。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(
        `会话目录不可用（${sessionsRoot}）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(sessionsRoot, entry.name))
    // 限制并发：项目多的用户空间不应一次性打开所有分组目录（Pi 自己的
    // listAll 也做并发限制）；总工作量仍为 O(会话数)。
    const listed = await mapWithConcurrency(dirs, SCOPE_LIST_CONCURRENCY, (dir) =>
      SessionManager.listAll(dir),
    )
    return listed.flat() as unknown as SessionCatalogInfo[]
  }

  /** 存储作用域内的全部会话（跨 cwd，按需重新扫描）。 */
  async scanScopeInfos(scope: ResolvedSessionDir): Promise<SessionCatalogInfo[]> {
    return scope.grouped
      ? await this.listGroupedScopeInfos()
      : ((await SessionManager.listAll(scope.dir)) as unknown as SessionCatalogInfo[])
  }

  async listScopeInfos(): Promise<SessionCatalogInfo[]> {
    const scope = this.scopeOf(this.deps.workspacePath)
    const key = this.scopeRootOf(scope)
    const existing = this.scopeCatalogCache.get(key)
    if (existing?.infos) return existing.infos
    if (existing?.promise) return existing.promise
    const entry: { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> } = {}
    const promise = (async () => {
      const infos = await this.scanScopeInfos(scope)
      // 只在本次扫描仍是当前缓存条目时写回：显式刷新可能已用新条目替换它，
      // 旧 promise 不得覆盖新结果，也不能删掉新条目。
      if (this.scopeCatalogCache.get(key) !== entry) return infos
      // 空结果不缓存（同上：会话可能在创建后落盘）。
      if (infos.length === 0) this.scopeCatalogCache.delete(key)
      else entry.infos = infos
      return infos
    })().finally(() => {
      entry.promise = undefined
    })
    entry.promise = promise
    this.scopeCatalogCache.set(key, entry)
    return promise
  }

  invalidateCatalog(_cwd: string = this.deps.workspacePath): void {
    // 列表已统一走跨 cwd 作用域缓存；任何会话文件变化都清整份缓存，
    // 避免删除/更名/首条消息落盘后仍读到旧值。
    this.scopeCatalogCache.clear()
  }

  clearCatalogCache(): void {
    this.scopeCatalogCache.clear()
  }

  /**
   * 在给定列表里按 ID 定位会话；同一 ID 对应多个文件时报歧义（不静默选一个）。
   */
  pickSessionInfo(
    infos: readonly SessionCatalogInfo[],
    threadId: string,
  ): SessionCatalogInfo | undefined {
    let hit: SessionCatalogInfo | undefined
    const paths = new Set<string>()
    for (const info of infos) {
      if (info.id !== threadId) continue
      paths.add(info.path)
      hit = info
    }
    if (paths.size > 1) {
      throw new Error(`会话 ID ${threadId} 在存储作用域内对应多个文件，无法安全定位`)
    }
    return hit
  }

  async findSessionInfo(threadId: string): Promise<SessionCatalogInfo | undefined> {
    // 统一经作用域缓存（默认空间跨分组 / 平铺覆盖）定位，不先做「本地命中即返回」：
    // 本地列表只是作用域的子集，直接返回会让「同一 ID 存在于另一个 cwd 分组」
    // 的重复 ID 被静默选中，违背作用域内重复 ID 必须报歧义的约定。
    // 缓存命中时这里是纯内存 O(n) 过滤，不逐次重扫目录。
    return this.pickSessionInfo(await this.listScopeInfos(), threadId)
  }

  /** 列表：冷目录条目 + 尚未落盘/未被扫描到的 live 会话。 */
  async listThreads(input?: {
    workspaceId?: string
    unassigned?: boolean
    includeArchived?: boolean
    refresh?: boolean
  }): Promise<HarnessThreadMetadata[]> {
    if (input?.refresh) this.scopeCatalogCache.clear()
    const infos = await this.listScopeInfos()
    const seen = new Set<string>()
    const result: HarnessThreadMetadata[] = []
    for (const info of infos) {
      seen.add(info.id)
      if (
        !input?.includeArchived &&
        this.deps.workspaceStore.sessionArchived(this.deps.storeId, info.id)
      ) {
        continue
      }
      const storedWorkspaceId = this.deps.workspaceStore.sessionWorkspace(
        this.deps.storeId,
        info.id,
      )
      const workspace = storedWorkspaceId
        ? this.deps.workspaceStore.workspace(storedWorkspaceId)
        : undefined
      const workspaceId = workspace?.id
      if (input?.workspaceId && workspaceId !== input.workspaceId) continue
      if (input?.unassigned && workspaceId) continue
      const liveView = this.live
      const live = liveView?.get(info.id)
      if (live && liveView) {
        // live 元数据自带完整时间投影；不再用目录扫描结果覆盖，否则打开会话前
        // 缓存的旧时间会盖掉后续消息的真实活动时间。
        result.push({
          ...liveView.metadataOf(live),
          ...(workspace
            ? {
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
              }
            : {}),
        })
      } else {
        // 冷条目也要叠加归档标记与工作区归属（过滤与呈现口径一致）。
        result.push({
          ...mapSessionInfo(info, { liveStatus: 'idle' }),
          ...(workspace
            ? {
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
                workspaceAppliedRevision: workspace.revision,
              }
            : {}),
          ...(this.deps.workspaceStore.sessionArchived(this.deps.storeId, info.id)
            ? { archived: true }
            : {}),
        })
      }
    }

    // 新建会话在首条用户消息落盘前不在磁盘列表；live 目录实体仍需可发现。
    if (this.live) {
      for (const record of this.live.all()) {
        if (seen.has(record.threadId) || record.retired) continue
        const storedWorkspaceId = this.deps.workspaceStore.sessionWorkspace(
          this.deps.storeId,
          record.threadId,
        )
        const workspace = storedWorkspaceId
          ? this.deps.workspaceStore.workspace(storedWorkspaceId)
          : undefined
        const workspaceId = workspace?.id
        if (input?.workspaceId && workspaceId !== input.workspaceId) continue
        if (input?.unassigned && workspaceId) continue
        if (
          !input?.includeArchived &&
          this.deps.workspaceStore.sessionArchived(this.deps.storeId, record.threadId)
        ) {
          continue
        }
        result.push({
          ...this.live.metadataOf(record),
          ...(workspace
            ? {
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
              }
            : {}),
        })
      }
    }
    return result
  }

  /** 冷读装载：只打开作用域校验后的 SessionManager，读取活动分支与上下文。 */
  private loadColdSession(info: SessionCatalogInfo) {
    const sessionManager = this.openScopedSessionManager(info)
    const branch = sessionManager.getBranch() as unknown as HarnessAnySessionEntry[]
    const context = sessionManager.buildSessionContext()
    const contextWindow = context.model
      ? (this.deps.modelRuntime.getModel(context.model.provider, context.model.modelId)
          ?.contextWindow ?? 0)
      : 0
    const contextUsage = deriveContextUsage(contextWindow, branch, context.messages)
    const storedWorkspaceId = this.deps.workspaceStore.sessionWorkspace(this.deps.storeId, info.id)
    const workspaceMetadata = this.deps.events.sessionWorkspaceFields(
      info.id,
      storedWorkspaceId
        ? this.deps.workspaceStore.workspace(storedWorkspaceId)?.revision
        : undefined,
    )
    const metadata: HarnessThreadMetadata = {
      ...mapColdMetadata(
        info,
        {
          messages: context.messages,
          thinkingLevel: context.thinkingLevel,
          model: context.model,
        },
        {
          archived: this.deps.workspaceStore.sessionArchived(this.deps.storeId, info.id),
          ...(contextUsage ? { contextUsage } : {}),
        },
      ),
      leafId: sessionManager.getLeafId(),
      treeRevision: sessionTreeRevision(sessionManager),
      ...(() => {
        const enabled = this.coldAutoCompactionEnabled(info.cwd)
        return enabled === undefined ? {} : { autoCompactionEnabled: enabled }
      })(),
      ...workspaceMetadata,
    }
    return { sessionManager, branch, context, contextUsage, metadata }
  }

  private coldAutoCompactionEnabled(cwd: string | undefined): boolean | undefined {
    try {
      return requireSettingsManager()
        .create(cwd?.trim() || this.deps.workspacePath, this.deps.agentDir, {
          projectTrusted: false,
        })
        .getCompactionEnabled()
    } catch {
      return undefined
    }
  }

  /** 冷读快照（不经 AgentSession）。 */
  snapshotFromSessionFile(info: SessionCatalogInfo): HarnessThreadSnapshot {
    const cold = this.loadColdSession(info)
    return jsonSafeSnapshot({
      metadata: cold.metadata,
      messages: cold.context.messages as HarnessAgentMessage[],
      messageEntryIds: messageEntryIdsOf(cold.sessionManager, cold.context.messages),
      readiness: getModelReadiness(
        this.deps.modelRuntime,
        cold.context.model
          ? {
              provider: cold.context.model.provider,
              modelId: cold.context.model.modelId,
            }
          : undefined,
        'session',
      ),
    })
  }

  getThread(threadId: string): HarnessThreadSnapshot | Promise<HarnessThreadSnapshot> {
    const liveView = this.live
    const live = liveView?.get(threadId)
    if (live && liveView) return liveView.snapshotOf(live)
    return this.findSessionInfo(threadId).then((info) => {
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      return this.snapshotFromSessionFile(info)
    })
  }

  async getThreadTree(threadId: string): Promise<HarnessThreadTree> {
    const liveView = this.live
    const live = liveView?.get(threadId)
    if (live && liveView) {
      const operation = liveView.treeOperationView(live)
      return buildSessionTree(threadId, live.sessionManager, {
        branchSummarySkipPrompt: live.settingsManager.getBranchSummarySkipPrompt(),
        ...(operation ? { operation } : {}),
      })
    }
    const info = await this.findSessionInfo(threadId)
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    // 冷树：只读 JSONL + sidecar，不构造 AgentSession、不装配项目扩展。
    const sessionManager = this.openScopedSessionManager(info)
    return buildSessionTree(threadId, sessionManager, {
      branchSummarySkipPrompt: this.coldBranchSummarySkipPrompt(info.cwd),
    })
  }

  private coldBranchSummarySkipPrompt(cwd: string | undefined): boolean {
    try {
      return requireSettingsManager()
        .create(cwd?.trim() || this.deps.workspacePath, this.deps.agentDir, {
          projectTrusted: false,
        })
        .getBranchSummarySkipPrompt()
    } catch {
      return false
    }
  }

  /**
   * 只读详情：热会话直接使用 SDK 统计，冷会话按 SDK 同口径聚合全文件条目。
   */
  async threadDetailsOf(threadId: string): Promise<HarnessThreadDetails> {
    const liveView = this.live
    const record = liveView?.get(threadId)
    if (record && liveView) {
      // 热会话：`getSessionStats()` 是权威口径（全文件累计），上下文复用同一会话。
      const stats = record.session.getSessionStats()
      return {
        metadata: liveView.metadataOf(record),
        stats: {
          userMessages: stats.userMessages,
          assistantMessages: stats.assistantMessages,
          toolResults: stats.toolResults,
          toolCalls: stats.toolCalls,
          totalMessages: stats.totalMessages,
          tokens: stats.tokens,
          cost: stats.cost,
        },
        ...(stats.contextUsage ? { contextUsage: stats.contextUsage } : {}),
        branchEntryCount: record.sessionManager.getBranch().length,
      }
    }
    const info = await this.findSessionInfo(threadId)
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    const cold = this.loadColdSession(info)
    return {
      metadata: cold.metadata,
      stats: aggregateSessionStats(cold.sessionManager.getEntries()),
      ...(cold.contextUsage ? { contextUsage: cold.contextUsage } : {}),
      branchEntryCount: cold.branch.length,
    }
  }
}

/** 避免循环导入：SettingsManager 只在冷读路径需要。 */
import { SettingsManager as SettingsManagerImpl } from '@earendil-works/pi-coding-agent'

const requireSettingsManager = (): typeof SettingsManagerImpl => SettingsManagerImpl

import { jsonSafeSnapshot } from './json-safe.js'
/** 复用事件模块的消息来源映射，避免两套下标规则。 */
import { messageEntryIds as messageEntryIdsImpl } from './session-events.js'

const messageEntryIdsOf = messageEntryIdsImpl
