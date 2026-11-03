/**
 * 配置与资源服务：唯一持有 settings 写队列、配置目标解析、范围/自动压缩保存、
 * 资源重载流程与资源版本。
 *
 * 保存不等于应用；live 变更仍经 operation-coordinator 准入。资源重载复用
 * 现有 settings/resource 模块与项目装配服务。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { hasTrustRequiringProjectResources, SettingsManager } from '@earendil-works/pi-coding-agent'
import type {
  HarnessAutoCompactionUpdateResult,
  HarnessModelInfo,
  HarnessModelRefreshInput,
  HarnessModelRefreshResult,
  HarnessProjectTrust,
  HarnessReloadOperation,
  HarnessReloadResult,
  HarnessReloadTargetInput,
  HarnessReloadTrigger,
  HarnessResourceQueryInput,
  HarnessResourceSnapshot,
  HarnessSettingsSaveInput,
  HarnessSettingsSaveResult,
  HarnessSettingsSnapshot,
  HarnessSettingsTarget,
  HarnessSettingsTargetInput,
} from '@huan/protocol'
import {
  globalModelPatterns,
  listModelCatalog,
  type ResolvedModelScope,
  resolveModelScopePatterns,
} from '../model-catalog.js'
import { resourceSnapshotOf } from '../resource-inventory.js'
import { ResourceReloadTrustError } from '../resource-reload.js'
import {
  byteLengthOf,
  changedTopLevelKeys,
  mergeSettingsFromDisk,
  parseSettingsContent,
  readSettingsFile,
  restartRequiredKeys,
  SETTINGS_CONTENT_MAX_BYTES,
  settingsEffectiveOfManager,
  settingsEquivalent,
  settingsFilePaths,
  settingsRevision,
  writeSettingsFileAtomic,
} from '../settings-store.js'
import { pathKey } from '../workspace-path.js'
import { WorkspaceNotFoundError, type WorkspaceStore } from '../workspace-store.js'
import type { LiveSessions } from './live-sessions.js'
import type { ModelCatalogService, SharedModelRuntime } from './model-service.js'
import type { OperationCoordinator } from './operation-coordinator.js'
import { canonicalProjectPath as canonicalPath, type ProjectAssembly } from './project-assembly.js'
import type { SessionCatalog } from './session-catalog.js'
import type { SessionEvents } from './session-events.js'
import { ProjectTrustRequiredError, type ThreadRecord, ThreadStructureBusyError } from './shared.js'

export type ConfigurationServiceDeps = {
  agentDir: string
  workspacePath: string
  modelRuntime: SharedModelRuntime
  modelService: ModelCatalogService
  live: Pick<LiveSessions, 'all' | 'ensureOpen' | 'get' | 'invalidateMcpRuntime'>
  assembly: Pick<
    ProjectAssembly,
    | 'explicitTrust'
    | 'hasPendingLoad'
    | 'inspectPath'
    | 'inspectTrust'
    | 'loadRuntime'
    | 'prepare'
    | 'query'
    | 'registerPreparedProviders'
    | 'runtime'
    | 'runtimeFrom'
    | 'workspaceReloads'
  >
  catalog: Pick<SessionCatalog, 'findSessionInfo'>
  events: Pick<SessionEvents, 'emit' | 'emitSnapshot' | 'resetHostUiForReload' | 'snapshotOf'>
  coordinator: Pick<OperationCoordinator, 'beginStructure' | 'releaseStructure'>
  workspaceStore: WorkspaceStore
  storeId: string
  diagnose: (message: string) => void
  addSafeDiagnostic: (
    code: 'assembly-warning' | 'catalog-refresh-failed' | 'model-fallback',
  ) => void
  assertActive: () => void
  isDisposed: () => boolean
}

export class ConfigurationService {
  private settingsWrites: Promise<unknown> = Promise.resolve()
  private reloadCounter = 0
  private resourceRevisionSeq = 0

  constructor(private readonly deps: ConfigurationServiceDeps) {}

  /** 当前资源版本（新装配继承）。 */
  resourceRevision(): number {
    return this.resourceRevisionSeq
  }

  /**
   * 解析某工作区当前的模型范围：工作区自定义优先，否则读取用户全局设置。
   *
   * 全局范围只读 Pi 用户 settings.json 的 enabledModels，不使用项目覆盖；
   * 从磁盘新建只读管理器，保存用户设置后下一次查询立即生效。
   */
  async modelScopeFor(workspaceId?: string): Promise<ResolvedModelScope> {
    const workspace = workspaceId ? this.deps.workspaceStore.workspace(workspaceId) : undefined
    if (workspaceId && !workspace) throw new WorkspaceNotFoundError(workspaceId)
    const patterns =
      workspace?.modelPatterns ??
      globalModelPatterns(
        SettingsManager.create(this.deps.workspacePath, this.deps.agentDir, {
          projectTrusted: false,
        }),
      )
    return resolveModelScopePatterns(this.deps.modelRuntime, patterns, {
      diagnose: this.deps.diagnose,
    })
  }

  withSettingsWrite<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.settingsWrites.then(action)
    this.settingsWrites = pending.catch(() => {})
    return pending
  }

  /**
   * 解析设置/资源查询目标。
   *
   * 只接受会话 ID 或绝对起始目录，且两者互斥；不接受任意配置文件路径。
   * 冷会话只按会话头解析 cwd，不构造 AgentSession。
   */
  async resolveConfigTarget(
    input: HarnessSettingsTargetInput,
  ): Promise<{ target: HarnessSettingsTarget; cwd: string; record?: ThreadRecord }> {
    const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : ''
    const requestedPath = typeof input.workspacePath === 'string' ? input.workspacePath.trim() : ''
    if (threadId.length > 0 === requestedPath.length > 0) {
      throw new Error('配置查询需要且只能指定会话或起始目录')
    }
    if (threadId) {
      const record = this.deps.live.get(threadId)
      if (record) {
        return {
          target: { kind: 'session', threadId, workspacePath: record.workspacePath },
          cwd: record.workspacePath,
          record,
        }
      }
      const info = await this.deps.catalog.findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      // 会话头缺失 cwd 时退回宿主启动目录；不使用调用方未提供的路径。
      const cwd = canonicalPath(info.cwd || this.deps.workspacePath)
      return { target: { kind: 'session', threadId, workspacePath: cwd }, cwd }
    }
    if (!isAbsolute(requestedPath)) throw new Error('起始目录必须是绝对路径')
    const check = await this.deps.assembly.inspectPath(requestedPath)
    if (check.error) throw new Error('起始目录不可用')
    return { target: { kind: 'workspace', workspacePath: check.path }, cwd: check.path }
  }

  /**
   * 目标项目的信任结论。
   *
   * live 会话以正在服务的 loader 的信任状态为准（重载就地更新）；其余优先
   * 复用已装配的项目缓存，没有缓存时走只读摘要（不加载项目扩展）。
   */
  async configTrustOf(cwd: string, record?: ThreadRecord): Promise<HarnessProjectTrust> {
    // live 会话：以它正在使用的 loader 的信任状态为权威。资源重载会就地更新
    // 该状态，因此「重载因新资源被拒」后页面不会仍显示旧的 trusted 结论。
    if (record) {
      const state = record.trustBinding.state()
      if (state.source === 'no-resources' && hasTrustRequiringProjectResources(cwd)) {
        return (await this.deps.assembly.inspectTrust(cwd)).trust
      }
      return {
        decision:
          state.status === 'trusted'
            ? 'trusted'
            : state.status === 'untrusted'
              ? 'untrusted'
              : 'unknown',
        origin: state.source,
        requiresTrust: state.requiresTrust,
        defaultPolicy: state.defaultProjectTrust,
        ...(state.savedPath ? { savedPath: state.savedPath } : {}),
        extensionErrorCount: state.extensionErrors.length,
      }
    }
    const cached = this.deps.assembly.runtime(cwd)
    if (
      cached &&
      cached.info.status !== 'failed' &&
      (cached.info.trust.requiresTrust === hasTrustRequiringProjectResources(cwd) ||
        cached.info.trust.origin !== 'no-resources')
    )
      return cached.info.trust
    return (await this.deps.assembly.inspectTrust(cwd)).trust
  }

  trustViewOf(trust: HarnessProjectTrust): {
    decision: 'trusted' | 'untrusted' | 'needs-trust'
    requiresTrust: boolean
    origin: string
  } {
    return {
      decision:
        trust.decision === 'trusted'
          ? ('trusted' as const)
          : trust.decision === 'untrusted'
            ? ('untrusted' as const)
            : ('needs-trust' as const),
      requiresTrust: trust.requiresTrust,
      origin: trust.origin,
    }
  }

  /** 读取用户/项目原文与磁盘合并预览；项目未信任时不读取其原文。 */
  async settingsSnapshotOf(
    target: HarnessSettingsTarget,
    cwd: string,
    record?: ThreadRecord,
  ): Promise<HarnessSettingsSnapshot> {
    const trust = await this.configTrustOf(cwd, record)
    const trusted = trust.decision === 'trusted'
    const paths = settingsFilePaths(cwd, this.deps.agentDir)
    const [user, project] = await Promise.all([
      readSettingsFile(paths.user, 'user'),
      readSettingsFile(paths.project, 'project', { readable: trusted }),
    ])
    const effective = mergeSettingsFromDisk({
      cwd,
      agentDir: this.deps.agentDir,
      projectTrusted: trusted,
      files: { user, project },
    })
    const live = record ? settingsEffectiveOfManager(record.settingsManager, 'session') : undefined
    return {
      target,
      agentDir: this.deps.agentDir,
      projectTrusted: trusted,
      trust: this.trustViewOf(trust),
      files: { user, project },
      effective,
      ...(live ? { live } : {}),
      ...(live ? { reloadRequired: !settingsEquivalent(live.values, effective.values) } : {}),
    }
  }

  /**
   * 保存设置原文。
   *
   * 设计约束：
   * - 只改指定文件，内容为完整文件语义（未知字段由调用方保留）；
   * - 先校验 JSON/schema/原型污染键，再检查 revision（乐观并发）；
   * - 与自动压缩/模型范围写入共用 settingsWrites 队列；
   * - 原子写入 + 回读校验，失败如实报告；
   * - 不触碰任何 live SettingsManager 缓存（保存不等于应用）。
   */
  async saveSettings(input: HarnessSettingsSaveInput): Promise<HarnessSettingsSaveResult> {
    this.deps.assertActive()
    const resolved = await this.resolveConfigTarget(input.target)
    const trust = await this.configTrustOf(resolved.cwd, resolved.record)
    const trusted = trust.decision === 'trusted'
    const paths = settingsFilePaths(resolved.cwd, this.deps.agentDir)
    const path = input.scope === 'project' ? paths.project : paths.user
    if (input.scope === 'project' && !trusted) {
      return {
        status: 'untrusted',
        scope: input.scope,
        path,
        message: '项目未取得信任：不读取也不写入项目设置；用户设置仍可编辑。',
      }
    }
    if (typeof input.content !== 'string') {
      return {
        status: 'invalid',
        scope: input.scope,
        path,
        issues: [{ kind: 'parse', path: '/', message: '设置内容必须是字符串。' }],
        message: '设置未保存：内容形状无效。',
      }
    }
    const bytes = byteLengthOf(input.content)
    if (bytes > SETTINGS_CONTENT_MAX_BYTES) {
      return {
        status: 'too-large',
        scope: input.scope,
        path,
        limitBytes: SETTINGS_CONTENT_MAX_BYTES,
        message: `设置文件超过上限（${SETTINGS_CONTENT_MAX_BYTES} 字节），未保存。`,
      }
    }
    // revision 检查在队列内部执行：并发保存不会相互覆盖。
    const current = await readSettingsFile(path, input.scope)
    if (current.readError) {
      return { status: 'failed', scope: input.scope, path, message: current.readError }
    }
    if (current.tooLarge) {
      // 不返回不完整原文时无法可靠比较 revision；拒绝覆盖未知的大文件。
      return {
        status: 'too-large',
        scope: input.scope,
        path,
        limitBytes: SETTINGS_CONTENT_MAX_BYTES,
        message: '现有设置文件超过读取上限；为避免覆盖未知内容，请先手动处理该文件。',
      }
    }
    if (current.revision !== input.expectedRevision) {
      return {
        status: 'conflict',
        scope: input.scope,
        path,
        revision: current.revision,
        message: '设置文件已被其他窗口或进程修改；请重新读取文件后再保存。',
      }
    }
    const parsed = parseSettingsContent(input.content)
    if (!parsed.value || parsed.issues.length > 0) {
      return {
        status: 'invalid',
        scope: input.scope,
        path,
        issues: parsed.issues,
        message: '设置未保存：请先修复解析或校验问题。',
      }
    }
    const before =
      current.issues.length === 0 ? parseSettingsContent(current.content).value : undefined
    const changed = changedTopLevelKeys(before, parsed.value)
    try {
      await writeSettingsFileAtomic(path, input.content)
    } catch (error) {
      this.deps.diagnose(`设置写入（${path}）：${errorText(error)}`)
      return {
        status: 'failed',
        scope: input.scope,
        path,
        message: '设置写入失败；磁盘文件保持原状。',
      }
    }
    const verify = await readFile(path, 'utf8').catch(() => undefined)
    if (verify !== input.content) {
      return {
        status: 'failed',
        scope: input.scope,
        path,
        message: '写入后回读与提交内容不一致；请不要依赖本次保存结果。',
      }
    }
    const snapshot = await this.settingsSnapshotOf(resolved.target, resolved.cwd, resolved.record)
    const restartKeys = restartRequiredKeys(changed)
    const reloadRequired = changed.length > 0
    // 用户全局 enabledModels 是两层模型范围的底层；保存后推进既有目录代数，
    // 让已打开窗口通过既有的快照广播重新读取候选（不重设旧会话模型）。
    if (input.scope === 'user' && changed.includes('enabledModels')) {
      this.deps.modelService.notifyScopeChanged()
    }
    return {
      status: 'saved',
      scope: input.scope,
      path,
      revision: settingsRevision(input.content),
      bytes,
      snapshot,
      apply: {
        persisted: true,
        reloadRequired,
        restartRequiredKeys: restartKeys,
        message: !reloadRequired
          ? '内容未变化；已确认磁盘文件与提交一致。'
          : restartKeys.length > 0
            ? `已保存到磁盘；需重启宿主后生效：${restartKeys.join('、')}。当前会话仍使用已加载的设置。`
            : '已保存到磁盘；常用运行设置与资源需重载宿主后才会被会话使用。当前会话未被静默修改。',
      },
    }
  }

  /**
   * 资源清单：只读取现有 loader 的公开 getter。
   *
   * 热会话用正在使用的 loader；空白页/冷会话复用同 cwd 的 live loader、
   * 待消费的受信装配缓存或最近一次装配结果。除首次无缓存时按现有受信
   * 装配路径装配一次外，不调用 reload、不重新执行扩展、不联网重扫。
   */
  async resourceInventory(input: HarnessResourceQueryInput): Promise<HarnessResourceSnapshot> {
    this.deps.assertActive()
    const resolved = await this.resolveConfigTarget(input)
    let loader: import('@earendil-works/pi-coding-agent').ResourceLoader
    let settings: SettingsManager
    let loadedFrom: 'session' | 'assembly'
    if (resolved.record) {
      loader = resolved.record.resourceLoader
      settings = resolved.record.settingsManager
      loadedFrom = 'session'
    } else {
      const sameCwd = [...this.deps.live.all()].find(
        (record) => !record.retired && pathKey(record.workspacePath) === pathKey(resolved.cwd),
      )
      const runtime = this.deps.assembly.runtime(resolved.cwd)
      if (runtime?.pending) {
        loader = runtime.pending.trust.resourceLoader
        settings = runtime.pending.trust.settingsManager
        loadedFrom = 'assembly'
      } else if (sameCwd) {
        loader = sameCwd.resourceLoader
        settings = sameCwd.settingsManager
        loadedFrom = 'session'
      } else if (runtime?.lastLoader) {
        loader = runtime.lastLoader.loader
        settings = runtime.lastLoader.settings
        loadedFrom = 'assembly'
      } else {
        // 首次查询仍由正常装配路径处理信任，不复用装配前推测的结论。
        const loaded =
          runtime ?? (await this.deps.assembly.loadRuntime(resolved.cwd, this.deps.isDisposed()))
        const prepared =
          loaded.pending ??
          (await this.deps.assembly.prepare(
            loaded.cwd,
            loaded.info.trust.decision === 'trusted',
            this.deps.isDisposed(),
          ))
        loaded.pending = prepared
        loaded.lastLoader = {
          loader: prepared.trust.resourceLoader,
          settings: prepared.trust.settingsManager,
        }
        loader = prepared.trust.resourceLoader
        settings = prepared.trust.settingsManager
        loadedFrom = 'assembly'
      }
    }
    return resourceSnapshotOf(
      {
        target: resolved.target,
        agentDir: this.deps.agentDir,
        loadedFrom,
        trust: this.trustViewOf(await this.configTrustOf(resolved.cwd, resolved.record)),
        loader,
        settings,
      },
      { includeText: input.includeText === true },
    )
  }

  /** 用独立管理器保存用户设置，失败不改 live 会话缓存。 */
  private async writeGlobalSetting(
    record: ThreadRecord,
    label: string,
    apply: (manager: SettingsManager) => void,
    verify: () => Promise<boolean>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    this.deps.assertActive()
    if (record.retired) return { ok: false, message: '会话正在关闭，设置未保存' }
    const manager = SettingsManager.create(record.workspacePath, this.deps.agentDir, {
      projectTrusted: false,
    })
    // 先清掉之前积压的写盘错误，避免误归因到本次设置。
    for (const stale of manager.drainErrors()) {
      this.deps.diagnose(`${label}（旧错误）${record.workspacePath}：${String(stale.error)}`)
    }
    try {
      apply(manager)
      await manager.flush()
    } catch (error) {
      this.deps.diagnose(`${label}（${record.workspacePath}）：${errorText(error)}`)
    }
    const errors = manager.drainErrors()
    for (const error of errors) {
      this.deps.diagnose(`${label}（${record.workspacePath}）：${String(error.error)}`)
    }
    const persisted = errors.length === 0 ? await verify().catch(() => false) : false
    if (persisted) return { ok: true }
    return {
      ok: false,
      message: `${label}保存失败或未能确认，请检查用户设置文件（settings.json）。`,
    }
  }

  /** 读取 agentDir 用户设置原文（校验写盘结果用）；坏文件按不可确认处理。 */
  private async readUserSettings(): Promise<Record<string, unknown> | undefined> {
    try {
      const text = await readFile(join(this.deps.agentDir, 'settings.json'), 'utf8')
      const parsed: unknown = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 全局设置变更后同步其他已打开会话的设置缓存并广播快照。
   *
   * 每个 live session 有独立的 SettingsManager；不刷新则旧会话仍显示旧值。
   */
  private async syncSettingsCaches(source: ThreadRecord): Promise<void> {
    for (const other of [...this.deps.live.all()]) {
      if (other.retired) continue
      try {
        // 先排空其他会话自己的待写入，避免 reload 丢弃尚未落盘的修改。
        await other.settingsManager.flush()
        await other.settingsManager.reload()
      } catch (error) {
        this.deps.diagnose(`设置同步（${other.workspacePath}）：${errorText(error)}`)
      }
      this.deps.events.emitSnapshot(other)
    }
    this.deps.events.emitSnapshot(source)
  }

  /** 保存自动压缩开关（用户全局设置）并同步所有 live 会话的缓存。 */
  async setAutoCompaction(
    threadId: string,
    enabled: boolean,
  ): Promise<HarnessAutoCompactionUpdateResult> {
    this.deps.assertActive()
    const record = await this.deps.live.ensureOpen(threadId)
    const written = await this.writeGlobalSetting(
      record,
      '自动压缩设置',
      (manager) => {
        manager.setCompactionEnabled(enabled)
      },
      async () => {
        const settings = await this.readUserSettings()
        const compaction =
          settings?.compaction !== null && typeof settings?.compaction === 'object'
            ? (settings.compaction as { enabled?: unknown })
            : undefined
        return compaction?.enabled === enabled
      },
    )
    if (!written.ok) return { status: 'failed', message: written.message }
    await this.syncSettingsCaches(record)
    const effective = record.settingsManager.getCompactionEnabled()
    return {
      status: 'saved',
      enabled: effective,
      scope: 'global',
      ...(effective === enabled
        ? {}
        : {
            overridden: true,
            message: '用户默认已保存，但项目设置覆盖了该开关，当前会话仍按项目设置生效。',
          }),
    }
  }

  /**
   * 显式刷新模型目录（共享 modelRuntime）。
   *
   * 必须显式指定会话或固定起始目录：不使用窗口当前工作区替代 live cwd。
   * 不重建 live session、不发起付费模型请求；失败时返回缓存目录与失败 provider。
   */
  async refreshModels(input: HarnessModelRefreshInput): Promise<HarnessModelRefreshResult> {
    this.deps.assertActive()
    if (input.threadId) {
      await this.deps.live.ensureOpen(input.threadId)
    } else {
      const path = input.workspacePath?.trim()
      if (!path || !isAbsolute(path)) {
        throw new Error('模型目录刷新需要指定会话或绝对起始目录')
      }
      const check = await this.deps.assembly.inspectPath(path)
      if (check.error) throw new Error('模型目录刷新的起始目录不可用')
    }
    return this.deps.modelService.refreshExplicit()
  }

  /**
   * 查询模型目录：默认返回两层范围解析后的候选，`all:true` 返回完整目录。
   *
   * 会话归属只按 huan 元数据解析，不按 cwd 推测工作区；workspaceId 只用于
   * 新会话，不因窗口当前目录自动映射。项目装配只用于登记模型 provider，
   * 项目 settings.enabledModels 不参与筛选。
   */
  async getAvailableModels(input?: {
    workspacePath?: string
    workspaceId?: string
    threadId?: string
    all?: boolean
  }): Promise<HarnessModelInfo[]> {
    this.deps.assertActive()
    let threadCwd: string | undefined
    let threadWorkspaceId: string | undefined
    const threadId = input?.threadId?.trim()
    if (threadId) {
      const record = this.deps.live.get(threadId)
      if (record) {
        threadCwd = record.workspacePath
      } else {
        const info = await this.deps.catalog.findSessionInfo(threadId)
        if (!info) throw new Error(`Unknown thread: ${threadId}`)
        threadCwd = info.cwd || undefined
      }
      threadWorkspaceId = this.deps.workspaceStore.sessionWorkspace(this.deps.storeId, threadId)
    }
    // threadId 的归属以 huan 元数据为权威，忽略调用方同时传入的 workspaceId。
    const workspaceId = threadId ? threadWorkspaceId : input?.workspaceId
    const workspace = workspaceId ? this.deps.workspaceStore.workspace(workspaceId) : undefined
    if (workspaceId && !workspace) throw new WorkspaceNotFoundError(workspaceId)
    const assemblyPath =
      input?.workspacePath ?? threadCwd ?? workspace?.projects[0]?.path ?? this.deps.workspacePath
    const info = await this.deps.assembly.query(assemblyPath, this.deps.isDisposed())
    if (info.status === 'needs-trust') throw new ProjectTrustRequiredError(info)
    if (info.status === 'failed') throw new Error('项目装配失败')
    const catalog = listModelCatalog(this.deps.modelRuntime)
    if (input?.all === true) return catalog
    const scope = await this.modelScopeFor(workspaceId)
    if (scope.patterns.length === 0) return catalog
    const byKey = new Map(catalog.map((model) => [`${model.provider}/${model.modelId}`, model]))
    return scope.scopedModels.flatMap((item) => {
      const model = byKey.get(`${item.model.provider}/${item.model.id}`)
      return model ? [model] : []
    })
  }

  // ---- 资源重载 ----

  /**
   * 重载成功后刷新与资源绑定的宿主缓存。
   *
   * 只做本地动作：登记新扩展 provider、物化本地模型目录（不联网）、更新
   * 工作区绑定实际加载的指令路径，并保留最近一次 loader 供只读清单查询。
   * 不覆盖用户已选模型/Thinking，也不重新执行扩展工厂（loader 负责一次）。
   */
  private async applyReloadedResources(record: ThreadRecord): Promise<void> {
    const loader = record.resourceLoader
    const extensions = loader.getExtensions()
    // 新 ExtensionRunner 已把 provider 注册写入共享 modelRuntime；这里对未消费
    // 的登记做兜底（幂等），并显式物化本地目录，保证选择器立即看到新模型。
    this.deps.assembly.registerPreparedProviders(extensions)
    try {
      await this.deps.modelRuntime.refresh({ allowNetwork: false })
    } catch (error) {
      this.deps.diagnose(`模型目录本地刷新（${record.workspacePath}）：${errorText(error)}`)
      this.deps.addSafeDiagnostic('catalog-refresh-failed')
    }
    record.workspaceBinding.loadedInstructionPaths = loader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.path)
    for (const { path: file, error } of extensions.errors) {
      this.deps.diagnose(`扩展装配重载（${record.workspacePath}）：${file}：${error}`)
      this.deps.addSafeDiagnostic('assembly-warning')
    }
    const runtime = this.deps.assembly.runtime(record.workspacePath)
    if (runtime) runtime.lastLoader = { loader, settings: record.settingsManager }
  }

  /** 会话目标的重载结果投影（成功时附带权威快照）。 */
  private reloadedResultOf(
    record: ThreadRecord,
    operation: HarnessReloadOperation,
  ): HarnessReloadResult {
    return {
      status: 'reloaded',
      kind: 'session',
      threadId: record.threadId,
      workspacePath: record.workspacePath,
      operation: { ...operation },
      resourceRevision: operation.resourceRevision,
      ...(record.retired ? {} : { snapshot: this.deps.events.snapshotOf(record) }),
    }
  }

  /**
   * 在同一个 Pi 会话内重载设置、指令、扩展与资源。
   *
   * 生命周期的关键顺序见原实现：
   * 1) 占用结构闸门；2) 广播 reload_start 并结算旧交互；3) 清空旧扩展 UI；
   * 4) flush 设置后公开 AgentSession.reload；5) 广播 reload_end 与权威快照。
   */
  async reloadThread(
    record: ThreadRecord,
    trigger: HarnessReloadTrigger,
  ): Promise<HarnessReloadResult> {
    this.deps.assertActive()
    const workspacePath = record.workspacePath
    this.reloadCounter += 1
    const operation: HarnessReloadOperation = {
      id: `${record.threadId}:reload:${this.reloadCounter}`,
      trigger,
      status: 'running',
      threadId: record.threadId,
      workspacePath,
      startedAt: new Date().toISOString(),
      fromResourceRevision: record.resourceRevision,
      resourceRevision: record.resourceRevision,
    }
    let structure: import('./shared.js').StructureOperation
    try {
      structure = this.deps.coordinator.beginStructure(record, 'reload')
    } catch (error) {
      if (!(error instanceof ThreadStructureBusyError)) throw error
      return {
        status: 'busy',
        message: error.message,
        threadId: record.threadId,
        workspacePath,
      }
    }
    // 退休/销毁时先解除阻断请求，避免重载卡在无人应答的启动期对话。
    structure.cancel = () => record.uiBridge.dismissAll()
    record.reload = operation
    this.deps.events.emit(record, { type: 'reload_start', operation: { ...operation } })
    this.deps.events.emitSnapshot(record)

    const fail = (
      reason: 'trust' | 'assembly' | 'disposed',
      message: string,
    ): HarnessReloadResult => {
      operation.status = reason === 'disposed' ? 'cancelled' : 'failed'
      operation.finishedAt = new Date().toISOString()
      operation.message = message
      if (!record.retired) {
        this.deps.events.emit(record, {
          type: 'reload_end',
          operation: { ...operation },
          resourceRevision: record.resourceRevision,
        })
      }
      if (operation.status === 'cancelled') {
        return { status: 'cancelled', message, operation: { ...operation } }
      }
      return { status: 'failed', reason, message, operation: { ...operation } }
    }

    try {
      // 1) 旧交互不能跨运行时存活：本地 pending 与宿主级会话作用域请求一起结算。
      record.uiBridge.dismissAll()
      this.deps.events.resetHostUiForReload(record)
      record.uiBridge.setStartup(true)
      // 2) 先排空本会话的设置写入，避免 reload 丢弃尚未落盘的修改。
      try {
        await record.settingsManager.flush()
      } catch (error) {
        this.deps.diagnose(`设置落盘（${workspacePath}）：${errorText(error)}`)
      }
      // 3) 先关闭本会话当前的 MCP 连接代次（只关当前 manager，不关闭 binding）：
      // 旧进程必须在其他扩展的 session_shutdown handler 可能阻塞之前回收；
      // session.reload 之后由新 factory 的 session_start 启动新代次。
      // 旧 runtimeId 的认证操作必须立即失效，不能把结果附着到新 manager。
      this.deps.live.invalidateMcpRuntime(record)
      const mcpManager = record.mcp.getManager()
      if (mcpManager) {
        try {
          await mcpManager.close()
        } catch (error) {
          this.deps.diagnose(`MCP 连接回收（${workspacePath}）：${errorText(error)}`)
        }
      }
      await record.session.reload({
        beforeSessionStart: async () => {
          if (record.retired || this.deps.isDisposed()) throw new Error('会话正在关闭')
          await this.applyReloadedResources(record)
          if (record.retired || this.deps.isDisposed()) throw new Error('会话正在关闭')
        },
      })
      if (record.retired || this.deps.isDisposed()) {
        return fail('disposed', '会话正在关闭，资源重载已取消；请重新打开会话后再试。')
      }
      this.resourceRevisionSeq += 1
      record.resourceRevision = this.resourceRevisionSeq
      operation.status = 'succeeded'
      operation.finishedAt = new Date().toISOString()
      operation.resourceRevision = this.resourceRevisionSeq
      delete operation.message
      this.deps.events.emit(record, {
        type: 'reload_end',
        operation: { ...operation },
        resourceRevision: this.resourceRevisionSeq,
      })
      return this.reloadedResultOf(record, operation)
    } catch (error) {
      if (record.retired || this.deps.isDisposed()) {
        return fail('disposed', '会话正在关闭，资源重载已取消；请重新打开会话后再试。')
      }
      if (error instanceof ResourceReloadTrustError) {
        this.deps.diagnose(`资源重载信任（${workspacePath}）：${error.message}`)
        this.deps.addSafeDiagnostic('assembly-warning')
        return fail('trust', error.message)
      }
      this.deps.diagnose(`资源重载（${workspacePath}）：${errorText(error)}`)
      this.deps.addSafeDiagnostic('assembly-warning')
      return fail(
        'assembly',
        `资源重载失败：${errorText(error)}。旧扩展可能已关闭；修复后可在同一会话重试。`,
      )
    } finally {
      record.uiBridge.setStartup(false)
      structure.cancel = () => {}
      this.deps.coordinator.releaseStructure(record, structure)
    }
  }

  /**
   * 空白页目标：只刷新该 cwd 的待消费装配。
   *
   * 不创建会话、不停止同 cwd 的其他会话；已有的 live 会话使用自己的 loader，
   * 不会被本操作替换。结果明确标记 kind=workspace，便于页面提示“只重载本目标”。
   */
  private async reloadWorkspace(
    cwd: string,
    trigger: HarnessReloadTrigger,
  ): Promise<HarnessReloadResult> {
    this.deps.assertActive()
    this.reloadCounter += 1
    const workspacePath = canonicalPath(cwd)
    const operation: HarnessReloadOperation = {
      id: `workspace:${workspacePath}:reload:${this.reloadCounter}`,
      trigger,
      status: 'running',
      workspacePath,
      startedAt: new Date().toISOString(),
      fromResourceRevision: this.resourceRevisionSeq,
      resourceRevision: this.resourceRevisionSeq,
    }
    if (
      this.deps.assembly.workspaceReloads.has(workspacePath) ||
      this.deps.assembly.hasPendingLoad(workspacePath)
    ) {
      return { status: 'busy', message: '该起始目录正在装配或重载', workspacePath }
    }
    this.deps.assembly.workspaceReloads.add(workspacePath)
    try {
      const runtime = this.deps.assembly.runtime(workspacePath)
      let prepared: import('./shared.js').PreparedProject
      if (runtime?.pending) {
        // 已有待消费装配：用带信任检查的 loader.reload 刷新（不重复装配工厂）。
        prepared = runtime.pending
        await prepared.trust.resourceLoader.reload()
        // 待消费 loader 没有 runner 负责登记 provider；下次会话复用它之前补上。
        this.deps.assembly.registerPreparedProviders(prepared.trust.resourceLoader.getExtensions())
      } else {
        // 无待消费装配：经正常受信装配路径准备一次（首次查询不猜测信任）。
        prepared = await this.deps.assembly.prepare(
          workspacePath,
          this.deps.assembly.explicitTrust.get(pathKey(workspacePath)),
          this.deps.isDisposed(),
        )
        if (this.deps.isDisposed()) throw new Error('宿主已关闭')
        if (prepared.trust.state.status === 'needs-trust') {
          throw new ResourceReloadTrustError(prepared.trust.state)
        }
        this.deps.assembly.runtimeFrom(prepared)
      }
      if (this.deps.isDisposed()) throw new Error('宿主已关闭')
      // 只物化本地目录；联网刷新仍由显式 refreshModels 触发。
      await this.deps.modelRuntime.refresh({ allowNetwork: false })
      if (this.deps.isDisposed()) throw new Error('宿主已关闭')
      prepared.workspaceBinding.loadedInstructionPaths = prepared.trust.resourceLoader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.path)
      const target = this.deps.assembly.runtime(workspacePath)
      if (target) {
        target.lastLoader = {
          loader: prepared.trust.resourceLoader,
          settings: prepared.trust.settingsManager,
        }
      }
      this.resourceRevisionSeq += 1
      operation.status = 'succeeded'
      operation.finishedAt = new Date().toISOString()
      operation.resourceRevision = this.resourceRevisionSeq
      return {
        status: 'reloaded',
        kind: 'workspace',
        workspacePath,
        operation: { ...operation },
        resourceRevision: this.resourceRevisionSeq,
      }
    } catch (error) {
      if (this.deps.isDisposed()) {
        operation.status = 'cancelled'
        operation.finishedAt = new Date().toISOString()
        return { status: 'cancelled', message: '宿主已关闭，资源重载已取消', operation }
      }
      if (error instanceof ResourceReloadTrustError || error instanceof ProjectTrustRequiredError) {
        const message =
          error instanceof ResourceReloadTrustError
            ? error.message
            : '项目需要信任决定；请先在项目信任面板完成允许/拒绝，再重试资源重载。'
        this.deps.diagnose(`待消费装配重载信任（${workspacePath}）：${message}`)
        this.deps.addSafeDiagnostic('assembly-warning')
        operation.status = 'failed'
        operation.finishedAt = new Date().toISOString()
        operation.message = message
        return { status: 'failed', reason: 'trust', message, operation: { ...operation } }
      }
      const message = `资源重载失败：${errorText(error)}。请修正后重试。`
      this.deps.diagnose(`待消费装配重载（${workspacePath}）：${errorText(error)}`)
      this.deps.addSafeDiagnostic('assembly-warning')
      operation.status = 'failed'
      operation.finishedAt = new Date().toISOString()
      operation.message = message
      return { status: 'failed', reason: 'assembly', message, operation: { ...operation } }
    } finally {
      this.deps.assembly.workspaceReloads.delete(workspacePath)
    }
  }

  /** 资源重载入口：会话与空白页目标二选一（与设置/资源查询同形）。 */
  async reloadResources(input: HarnessReloadTargetInput): Promise<HarnessReloadResult> {
    this.deps.assertActive()
    const trigger = input.trigger ?? 'api'
    const resolved = await this.resolveConfigTarget(input)
    if (resolved.target.kind === 'session') {
      const threadId = resolved.target.threadId
      if (!threadId) throw new Error('资源重载缺少会话 ID')
      const record = resolved.record ?? (await this.deps.live.ensureOpen(threadId))
      return this.reloadThread(record, trigger)
    }
    return this.reloadWorkspace(resolved.cwd, trigger)
  }
}

/** 提取诊断错误文本。 */
const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)
