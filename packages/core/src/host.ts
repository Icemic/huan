/**
 * 自研宿主（@huan/core）：组合根与协议客户端。
 *
 * 会话、装配、目录、操作协调、事件投影、导入与配置分别由 host/ 下的服务持有；
 * 本文件只解析固定启动配置、创建对象、组合领域能力并暴露 HarnessClient。
 */

import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ProjectTrustStore, SessionManager } from '@earendil-works/pi-coding-agent'
import { createMcpOAuthService, McpServerLog, mcpConfigPaths } from '@huan/mcp'
import {
  HARNESS_PROTOCOL_VERSION,
  type HarnessBashAbortResult,
  type HarnessBashStartResult,
  type HarnessClient,
  type HarnessCommandArgumentCompletion,
  type HarnessCommandArgumentInput,
  type HarnessCommandCatalog,
  type HarnessCompactionAbortResult,
  type HarnessCompactionOutcome,
  type HarnessCreateThreadInput,
  type HarnessFileSearchInput,
  type HarnessFileSearchResult,
  type HarnessHostInfo,
  type HarnessHostInteractionAnswer,
  type HarnessHostInteractionEvent,
  type HarnessHostInteractionSnapshot,
  type HarnessHostUiResponse,
  type HarnessMcpAuthCancelResult,
  type HarnessMcpAuthRespondInput,
  type HarnessMcpAuthRespondResult,
  type HarnessMcpAuthSnapshot,
  type HarnessMcpAuthStartInput,
  type HarnessMcpAuthStartResult,
  type HarnessMcpConfigSaveInput,
  type HarnessMcpConfigSaveResult,
  type HarnessMcpConfigSnapshot,
  type HarnessMcpDetailsInput,
  type HarnessMcpDetailsResult,
  type HarnessMcpManageInput,
  type HarnessMcpManageResult,
  type HarnessMcpSnapshot,
  type HarnessMcpTargetInput,
  type HarnessModelInfo,
  type HarnessModelRefreshInput,
  type HarnessModelRefreshResult,
  type HarnessProviderAuthCancelResult,
  type HarnessProviderAuthRespondResult,
  type HarnessProviderAuthSnapshot,
  type HarnessProviderAuthStartResult,
  type HarnessProviderAuthStreamEvent,
  type HarnessRecentProject,
  type HarnessReloadResult,
  type HarnessReloadTargetInput,
  type HarnessResourceQueryInput,
  type HarnessResourceSnapshot,
  type HarnessSendMessageOptions,
  type HarnessSettingsSaveInput,
  type HarnessSettingsSaveResult,
  type HarnessSettingsSnapshot,
  type HarnessSettingsTargetInput,
  type HarnessThinkingLevel,
  type HarnessThreadDetails,
  type HarnessThreadForkResult,
  type HarnessThreadImportPreview,
  type HarnessThreadImportResult,
  type HarnessThreadMetadata,
  type HarnessThreadSnapshot,
  type HarnessThreadTree,
  type HarnessTreeLabelResult,
  type HarnessTreeNavigateResult,
  type HarnessWorkspace,
  type HarnessWorkspaceCatalog,
  type HarnessWorkspaceMutationResult,
} from '@huan/protocol'
import { ConfigurationService } from './host/configuration-service.js'
import { LiveSessions } from './host/live-sessions.js'
import { ModelCatalogService } from './host/model-service.js'
import { OperationCoordinator } from './host/operation-coordinator.js'
import { canonicalProjectPath, ProjectAssembly } from './host/project-assembly.js'
import { SessionCatalog } from './host/session-catalog.js'
import { SessionEvents } from './host/session-events.js'
import { SessionImportService } from './host/session-import-service.js'
import { SessionOperations } from './host/session-operations.js'
import {
  callerContext,
  type HarnessDefaultModel,
  type HarnessHostOptions,
  ImageInputUnsupportedError,
  ProjectTrustRequiredError,
  ReservedBuiltinCommandError,
  type ThreadRecord,
  ThreadStructureBusyError,
  UnsupportedHostCommandActionError,
} from './host/shared.js'
import { SubagentSessions } from './host/subagent-sessions.js'
import { createHostInteractions } from './host-interactions.js'
import { createMcpHost, type McpHost } from './mcp-host.js'
import { mapSessionInfo } from './metadata.js'
import {
  createSharedModelRuntime,
  getModelReadiness,
  resolveDefaultModel,
} from './model-catalog.js'
import { createProviderAuthBroker } from './provider-auth.js'
import {
  commandArgumentsFromLoader,
  commandArgumentsFromSession,
  commandCatalogFromLoader,
  commandCatalogFromSession,
  type FileSearchRoot,
  searchWorkspaceFiles,
} from './resource-queries.js'
import {
  createSessionDirResolver,
  defaultSessionsRoot,
  ENV_SESSION_DIR,
  readSessionDirSetting,
  resolveAgentDir,
} from './session-dir.js'
import { pathKey } from './workspace-path.js'
import {
  defaultWorkspaceId,
  sessionStoreId,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceStateUnavailableError,
  WorkspaceStore,
  type WorkspaceStoreWorkspace,
  WorkspaceValidationError,
} from './workspace-store.js'

export type { HarnessDefaultModel, HarnessHostOptions }
export {
  ImageInputUnsupportedError,
  ProjectTrustRequiredError,
  ReservedBuiltinCommandError,
  ThreadStructureBusyError,
  UnsupportedHostCommandActionError,
}

/** 宿主：协议客户端 + 生命周期管理。 */
export type HarnessHost = HarnessClient & {
  dispose(): Promise<void>
  /** 启动期诊断（模型目录刷新错误、扩展装配诊断等），供应用呈现。 */
  diagnostics(): readonly string[]
}

export async function createHarnessHost(options: HarnessHostOptions): Promise<HarnessHost> {
  const workspacePath = options.workspacePath
  // 用户空间在宿主创建时固定：显式值 > PI_CODING_AGENT_DIR > 默认 ~/.pi/agent。
  // 全进程只在这里解析一次，不在运行中改写 process.env（支持同进程多空间）。
  const agentDir = resolveAgentDir(options.agentDir)
  const agentDirSource = options.agentDir?.trim()
    ? 'option'
    : process.env.PI_CODING_AGENT_DIR?.trim()
      ? 'env'
      : 'default'
  // 会话目录覆盖同理只读一次；无覆盖时每个目标 cwd 使用自己的默认分组。
  const resolveSessionDirFor = createSessionDirResolver({
    agentDir,
    workspacePath,
    option: options.sessionDir,
    env: process.env[ENV_SESSION_DIR],
    setting: readSessionDirSetting(workspacePath, agentDir),
  })
  const resourceLoaderOptions = options.resourceLoaderOptions
  const diagnostics: string[] = []
  // GUI 只接收受控诊断代码，原始扩展/网络错误可能包含密钥，留在宿主本地。
  const safeDiagnostics = new Set<
    'assembly-warning' | 'catalog-refresh-failed' | 'model-fallback'
  >()
  /** 追加本地诊断并去重：重复重载同一失败不应无限增长。 */
  const pushDiagnostic = (message: string): void => {
    if (!diagnostics.includes(message)) diagnostics.push(message)
  }

  // ---- 共享资源：模型运行时、OAuth、日志、交互通道、工作区存储 ----
  const modelRuntime = await createSharedModelRuntime(agentDir)
  // OAuth 凭据与日志按宿主共享；两者构造均无 I/O，连接层显式注入。
  // 日志路径只由固定 agentDir/启动工作区推导，不读取 Pi 的日志/凭据文件。
  const mcpOAuth = createMcpOAuthService({ agentDir })
  const mcpLog = new McpServerLog(mcpConfigPaths(agentDir, workspacePath).log)
  const startRefresh = options.refreshCatalogOnStart ?? true
  const refreshTimeoutMs = options.catalogRefreshTimeoutMs ?? 15_000
  const interactions = createHostInteractions()
  const trustStore = new ProjectTrustStore(agentDir)

  // ---- 工作区元数据（单文件、串行原子写） ----
  // 存储作用域标识按实际会话存储根计算：默认空间是 <agentDir>/sessions，
  // 显式覆盖是解析后的平铺 sessionDir。它与会话 cwd 无关。
  const startupScope = resolveSessionDirFor(workspacePath)
  const sessionStoreRoot = startupScope.grouped ? defaultSessionsRoot(agentDir) : startupScope.dir
  const storeId = sessionStoreId(sessionStoreRoot)
  const workspaceStore = new WorkspaceStore(agentDir)
  await workspaceStore.load()

  const isAvailableDirectory = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  const workspaceViewOf = (workspace: WorkspaceStoreWorkspace): HarnessWorkspace => ({
    id: workspace.id,
    name: workspace.name,
    revision: workspace.revision,
    projects: workspace.projects.map((project) => ({
      alias: project.alias,
      path: project.path,
      available: isAvailableDirectory(project.path),
    })),
    ...(workspace.modelPatterns ? { modelPatterns: [...workspace.modelPatterns] } : {}),
  })

  /** 扩展运行边界读取的权威快照：每次都从已提交的内存状态生成。 */
  const workspaceSnapshotOf = (workspaceId: string) => {
    const workspace = workspaceStore.workspace(workspaceId)
    if (!workspace) return null
    return {
      workspaceId: workspace.id,
      name: workspace.name,
      revision: workspace.revision,
      roots: workspace.projects.map((project) => ({
        alias: project.alias,
        path: project.path,
        available: isAvailableDirectory(project.path),
      })),
    }
  }

  // 单项目也走同一工作区模型：状态健康且没有任何定义时，提供一个仅存于
  // 内存的启动工作区；首次写入时随状态文件落盘。已有无元数据的 Pi 会话
  // 不会被自动归入，仍需用户明确接入。
  let startupWorkspaceId: string | undefined
  if (workspaceStore.healthy) {
    const startupPath = canonicalProjectPath(workspacePath)
    const existing = workspaceStore
      .listWorkspaces()
      .find((workspace) =>
        workspace.projects.some((project) => pathKey(project.path) === pathKey(startupPath)),
      )
    if (existing) {
      startupWorkspaceId = existing.id
    } else if (workspaceStore.listWorkspaces().length === 0) {
      const id = defaultWorkspaceId(agentDir, startupPath)
      try {
        workspaceStore.seedDefaultWorkspace({
          id,
          name: basename(startupPath) || startupPath,
          path: startupPath,
        })
        startupWorkspaceId = id
      } catch (error) {
        diagnostics.push(`默认工作区初始化：${String(error)}`)
      }
    }
    // 启动路径不属于任何已有工作区时保持未选中：不把新会话静默放进第一个
    // 无关工作区；GUI 会按窗口选择显式传入 workspaceId。
  }

  /** 工作区修改结果投影：冲突时附带权威定义供页面立即重读。 */
  const workspaceMutationResult = async (
    run: () => Promise<WorkspaceStoreWorkspace>,
  ): Promise<HarnessWorkspaceMutationResult> => {
    try {
      return { ok: true, workspace: workspaceViewOf(await run()) }
    } catch (error) {
      if (error instanceof WorkspaceConflictError) {
        return { ok: false, error: 'conflict', workspace: workspaceViewOf(error.current) }
      }
      if (error instanceof WorkspaceNotFoundError) return { ok: false, error: 'not-found' }
      if (error instanceof WorkspaceStateUnavailableError) {
        return { ok: false, error: 'state-unavailable' }
      }
      if (error instanceof WorkspaceValidationError) {
        return { ok: false, error: 'invalid', reason: error.reason }
      }
      throw error
    }
  }

  let disposed = false
  let generation = 0
  const assertActive = (): void => {
    if (disposed) throw new Error('Harness host has been disposed')
  }
  const isDisposed = (): boolean => disposed

  // 组合根持有可变引用：服务间只通过窄回调绑定，不互相注入完整上下文。
  let events!: SessionEvents
  let live!: LiveSessions
  let configuration!: ConfigurationService
  let operations!: SessionOperations
  let mcpHost: McpHost | undefined

  const coordinator = new OperationCoordinator({
    assertActive,
    diagnose: pushDiagnostic,
    emitSnapshot: (record) => events?.emitSnapshot(record),
  })
  const modelService = new ModelCatalogService({
    modelRuntime,
    refreshCatalogOnStart: startRefresh,
    refreshTimeoutMs,
    diagnose: pushDiagnostic,
    addSafeDiagnostic: (code) => safeDiagnostics.add(code),
    onChanged: () => {
      for (const record of live?.all() ?? []) events?.emitSnapshot(record)
    },
  })
  events = new SessionEvents({
    modelRuntime,
    modelCatalogRevision: () => modelService.modelCatalogRevision,
    workspaceStore,
    storeId,
    invalidateCatalog: (cwd) => catalog.invalidateCatalog(cwd),
    coordinator,
    interactions,
  })
  const catalog = new SessionCatalog({
    agentDir,
    workspacePath,
    resolveSessionDirFor,
    workspaceStore,
    storeId,
    modelRuntime,
    events,
  })
  let subagents: SubagentSessions
  const assembly = new ProjectAssembly({
    agentDir,
    workspacePath,
    ...(options.model ? { model: options.model } : {}),
    resourceLoaderOptions,
    modelRuntime,
    mcpOAuth,
    mcpLog,
    interactions,
    trustStore,
    diagnose: pushDiagnostic,
    addSafeDiagnostic: (code) => safeDiagnostics.add(code),
    refreshCatalog: () => modelService.refreshOnStart(),
    refreshCatalogOnStart: startRefresh,
    listScopeInfos: () => catalog.listScopeInfos(),
    workspaceSnapshotOf,
    subagents: {
      createTask: (context) => subagents.createTask(context),
      runTask: (input) => subagents.runTask(input),
    },
  })
  subagents = new SubagentSessions({
    agentDir,
    modelRuntime,
    workspaceStore,
    assembly,
    events,
  })

  live = new LiveSessions({
    agentDir,
    workspacePath,
    ...(options.model ? { model: options.model } : {}),
    modelRuntime,
    workspaceStore,
    storeId,
    assembly,
    catalog,
    events,
    coordinator,
    commandActionsFor: (record) => operations.commandActionsFor(record),
    diagnose: pushDiagnostic,
    addSafeDiagnostic: (code) => safeDiagnostics.add(code),
    assertActive,
    isDisposed,
    generation: () => generation,
    resourceRevision: () => configuration.resourceRevision(),
    invalidateMcpRuntime: (runtimeId) => mcpHost?.invalidateRuntime(runtimeId),
  })
  catalog.attachLive({
    get: (threadId) => live.get(threadId),
    all: () => live.all(),
    metadataOf: (record) => events.metadataOf(record),
    snapshotOf: (record) => events.snapshotOf(record),
    treeOperationView: (record) => events.treeOperationView(record),
  })
  configuration = new ConfigurationService({
    agentDir,
    workspacePath,
    modelRuntime,
    modelService,
    live,
    assembly,
    catalog,
    events,
    coordinator,
    workspaceStore,
    storeId,
    diagnose: pushDiagnostic,
    addSafeDiagnostic: (code) => safeDiagnostics.add(code),
    assertActive,
    isDisposed,
  })
  operations = new SessionOperations({
    live,
    catalog,
    events,
    coordinator,
    assembly,
    workspaceStore,
    storeId,
    workspacePath,
    reloadThread: (record, trigger) => configuration.reloadThread(record, trigger),
    resolveModelScope: (workspaceId) => configuration.modelScopeFor(workspaceId),
    diagnose: pushDiagnostic,
    assertActive,
    isDisposed,
    modelRuntime,
  })
  const importService = new SessionImportService({
    workspaceStore,
    storeId,
    workspacePath,
    startupWorkspaceId: () => startupWorkspaceId,
    assembly,
    catalog,
    assertActive,
    isDisposed,
    diagnose: pushDiagnostic,
  })

  /** 工作区定义变更后，让已订阅该工作区的窗口立即读到最新的待生效 revision。 */
  const emitWorkspaceSnapshots = (workspaceId: string): void => {
    for (const record of live.all()) {
      if (record.workspaceId !== workspaceId) continue
      events.emit(record, { type: 'snapshot', snapshot: events.snapshotOf(record) })
    }
  }

  /** 解析文件查询的可见根：仅会话/选中工作区成员，退化为空白页固定 cwd。 */
  const fileSearchRootsOf = async (input: HarnessFileSearchInput): Promise<FileSearchRoot[]> => {
    let workspaceId = input.workspaceId
    let cwd = input.workspacePath
    if (input.threadId) {
      const record = live.get(input.threadId)
      if (record) {
        workspaceId ??= record.workspaceId
        cwd ??= record.workspacePath
      } else {
        const info = await catalog.findSessionInfo(input.threadId)
        if (!info) throw new Error(`Unknown thread: ${input.threadId}`)
        cwd ??= info.cwd
        workspaceId ??= workspaceStore.sessionWorkspace(storeId, info.id)
      }
    }
    const workspace = workspaceId ? workspaceSnapshotOf(workspaceId) : null
    if (workspace) {
      return workspace.roots.map((root) => ({
        alias: root.alias,
        path: root.path,
        projectName: basename(root.path) || root.path,
        workspaceName: workspace.name,
      }))
    }
    if (!cwd) throw new Error('文件查询需要会话、工作区或固定起始目录')
    return [{ path: cwd, projectName: basename(cwd) || cwd }]
  }

  // ---- 启动引导：先准备启动项目，再注册 provider；阻断式交互让位给 HTTP ----
  let resolvedDefault = resolveDefaultModel({
    modelRuntime,
    cwd: workspacePath,
    agentDir,
    ...(options.model ? { model: options.model } : {}),
  })
  const startupGeneration = generation
  const startupAssembly = assembly.loadRuntime(workspacePath, disposed)
  let startupBlocked = false
  let resolveStartupBlocked: () => void = () => {}
  const startupBlockedSignal = new Promise<void>((resolveBlocked) => {
    resolveStartupBlocked = resolveBlocked
  })
  const unsubscribeStartupInteraction = interactions.subscribe((snapshot) => {
    if (snapshot.requests.length === 0) return
    startupBlocked = true
    resolveStartupBlocked()
  })

  const finishStartupAssembly = async (
    runtime: import('./host/shared.js').ProjectRuntime,
  ): Promise<void> => {
    if (generation !== startupGeneration) return
    resolvedDefault = runtime.defaultModel
    if (startRefresh && runtime.info.status !== 'needs-trust') await modelService.refreshOnStart()
  }

  try {
    const outcome = await Promise.race([
      startupAssembly.then((runtime) => ({ kind: 'done' as const, runtime })),
      startupBlockedSignal.then(() => ({ kind: 'blocked' as const })),
    ])
    if (outcome.kind === 'done') {
      await finishStartupAssembly(outcome.runtime)
    } else if (startupBlocked) {
      // 装配仍在等待用户应答：完成后再回填默认模型与诊断。
      void startupAssembly
        .then((runtime) => finishStartupAssembly(runtime))
        .catch((error: unknown) => {
          if (generation !== startupGeneration) return
          pushDiagnostic(`启动项目装配（${workspacePath}）：${String(error)}`)
          safeDiagnostics.add('assembly-warning')
        })
    }
  } catch (error) {
    pushDiagnostic(`启动项目装配（${workspacePath}）：${String(error)}`)
    safeDiagnostics.add('assembly-warning')
  } finally {
    unsubscribeStartupInteraction()
  }

  /**
   * 认证 broker：操作表、回填/取消与持久化竞态全部在该模块处理。
   * host 只提供本地安全刷新钩子，并把可用性变化广播到已有会话。
   */
  const providerAuth = createProviderAuthBroker({
    runtime: modelRuntime,
    async onAvailabilityChanged(providerId) {
      try {
        await modelService.refreshLocal([providerId])
      } catch {
        // 只保留受控诊断，不把可能含凭据的原始错误写入 UI 可读信息。
        pushDiagnostic('认证后本地模型目录刷新失败')
        safeDiagnostics.add('catalog-refresh-failed')
      }
    },
  })

  /**
   * MCP 管理 broker：复用配置目标/信任解析，不在 broker 内重新查路径或信任。
   * live manager 来自 record 的 MCP binding；弱映射在 manager 替换时生成新 runtimeId。
   */
  mcpHost = createMcpHost({
    agentDir,
    oauth: mcpOAuth,
    resolveTarget: async (input) => {
      const resolved = await configuration.resolveConfigTarget(input)
      // 全局目标只管理用户配置：不查询项目信任，也不返回可当成 cwd 的路径。
      if (resolved.target.kind === 'global') {
        return {
          target: { kind: 'global', workspacePath: '' },
          cwd: '',
          trust: { decision: 'untrusted', requiresTrust: false, origin: 'global' },
          global: true,
        }
      }
      const trust = await configuration.configTrustOf(resolved.cwd, resolved.record)
      return {
        target: {
          kind: resolved.target.kind,
          workspacePath: resolved.target.workspacePath,
          ...(resolved.target.threadId ? { threadId: resolved.target.threadId } : {}),
        },
        cwd: resolved.cwd,
        trust: configuration.trustViewOf(trust),
        ...(resolved.record ? { record: resolved.record } : {}),
      }
    },
    getLive: live.liveMcpBindingOf.bind(live),
    listLive: () => [...live.all()],
  })
  const mcpBroker = (): McpHost => {
    if (!mcpHost) throw new Error('MCP 管理模块尚未初始化')
    return mcpHost
  }

  const client: HarnessClient = {
    getSubagentTask: (parentThreadId, taskId) => {
      assertActive()
      return subagents.getTask(parentThreadId, taskId)
    },
    cancelSubagentTask: (parentThreadId, taskId) => {
      assertActive()
      return subagents.cancelTask(parentThreadId, taskId)
    },
    respondSubagentTask: (parentThreadId, taskId, response) => {
      assertActive()
      return subagents.respondTask(parentThreadId, taskId, response)
    },
    async getHostInfo(): Promise<HarnessHostInfo> {
      assertActive()
      const scope = catalog.scopeOf(workspacePath)
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        workspacePath,
        agentDir,
        agentDirSource,
        sessionStorage: {
          mode: scope.grouped ? 'grouped' : 'flat',
          root: catalog.scopeRootOf(scope),
          directory: scope.dir,
          source: scope.source,
        },
        defaultModel: {
          ...resolvedDefault.info,
          readiness: getModelReadiness(
            modelRuntime,
            resolvedDefault.info.provider && resolvedDefault.info.modelId
              ? {
                  provider: resolvedDefault.info.provider,
                  modelId: resolvedDefault.info.modelId,
                }
              : undefined,
            resolvedDefault.info.providerSource === 'env' ||
              resolvedDefault.info.modelIdSource === 'env'
              ? 'env'
              : 'pi-default',
          ),
        },
        diagnostics: [...safeDiagnostics],
      }
    },
    async listWorkspaces() {
      assertActive()
      const workspaces = workspaceStore.listWorkspaces().map(workspaceViewOf)
      const startup = startupWorkspaceId
        ? workspaces.find((workspace) => workspace.id === startupWorkspaceId)
        : undefined
      return {
        workspaces,
        state: workspaceStore.integrity,
        ...(startup ? { startupWorkspaceId: startup.id } : {}),
      } satisfies HarnessWorkspaceCatalog
    },

    async createWorkspace(input) {
      assertActive()
      return workspaceMutationResult(() =>
        workspaceStore.createWorkspace({
          ...input,
          projects: input.projects.map((project) => ({
            ...project,
            path: canonicalProjectPath(project.path),
          })),
        }),
      )
    },

    async updateWorkspace(input) {
      assertActive()
      const result = await workspaceMutationResult(() =>
        workspaceStore.updateWorkspace({
          ...input,
          ...(input.projects
            ? {
                projects: input.projects.map((project) => ({
                  ...project,
                  path: canonicalProjectPath(project.path),
                })),
              }
            : {}),
        }),
      )
      if (result.ok) {
        emitWorkspaceSnapshots(result.workspace.id)
        // 范围变更只推进既有目录代数并广播快照；已在运行的会话保持当前模型。
        if (
          input.modelPatterns !== undefined &&
          result.workspace.revision !== input.expectedRevision
        ) {
          modelService.notifyScopeChanged()
        }
      } else if (result.workspace) {
        emitWorkspaceSnapshots(result.workspace.id)
      }
      return result
    },

    async assignThreadWorkspace(input) {
      assertActive()
      const info = live.get(input.threadId)
        ? undefined
        : await catalog.findSessionInfo(input.threadId)
      const record = live.get(input.threadId)
      if (!record && !info) return { ok: false, error: 'not-found' as const }
      try {
        await workspaceStore.assignSession({
          storeId,
          sessionId: input.threadId,
          workspaceId: input.workspaceId,
        })
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          return { ok: false, error: 'not-found' as const }
        }
        if (error instanceof WorkspaceStateUnavailableError) {
          return { ok: false, error: 'state-unavailable' as const }
        }
        throw error
      }
      if (record) {
        record.workspaceId = input.workspaceId
        // 归属变更在下一轮运行开始时应用；当前轮保持原快照。
        record.workspaceAppliedRevision = undefined
        record.workspaceBinding.workspaceId = input.workspaceId
        events.emit(record, { type: 'snapshot', snapshot: events.snapshotOf(record) })
        return { ok: true as const, thread: events.metadataOf(record) }
      }
      const workspace = workspaceStore.workspace(input.workspaceId)
      // 到这里 record 为空，info 必然存在（已在上面按 not-found 返回）。
      const catalogInfo = info as import('./metadata.js').SessionCatalogInfo
      return {
        ok: true as const,
        thread: {
          ...mapSessionInfo(catalogInfo, { liveStatus: 'idle' }),
          ...(workspace
            ? {
                workspaceId: workspace.id,
                workspaceRevision: workspace.revision,
                workspaceAppliedRevision: workspace.revision,
              }
            : {}),
          ...(workspaceStore.sessionArchived(storeId, catalogInfo.id) ? { archived: true } : {}),
        },
      }
    },

    async listThreads(input): Promise<HarnessThreadMetadata[]> {
      assertActive()
      return catalog.listThreads(input)
    },

    async checkProjectPath(path: string) {
      assertActive()
      return assembly.inspectPath(path)
    },

    async getProject(input) {
      assertActive()
      return assembly.query(input.path, disposed)
    },

    async inspectProjectTrust(input) {
      assertActive()
      return assembly.inspectTrust(input.path)
    },

    async decideProjectTrust(input) {
      assertActive()
      return assembly.decide(input, disposed)
    },

    async listRecentProjects(): Promise<HarnessRecentProject[]> {
      assertActive()
      return assembly.listRecent()
    },

    async createThread(input?: HarnessCreateThreadInput, createOptions?: { callerId?: string }) {
      if (createOptions?.callerId && callerContext.getStore() !== createOptions.callerId) {
        return callerContext.run(createOptions.callerId, () => client.createThread(input))
      }
      assertActive()
      if (!workspaceStore.healthy) {
        throw new WorkspaceStateUnavailableError(
          workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
          workspaceStore.stateFile,
        )
      }
      const workspaceId = input?.workspaceId ?? startupWorkspaceId
      if (!workspaceId) throw new Error('没有可用工作区，不能新建会话')
      const workspace = workspaceStore.workspace(workspaceId)
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId)
      const requestedStart = input?.startProjectPath?.trim()
      const startProject = requestedStart
        ? workspace.projects.find((project) => pathKey(project.path) === pathKey(requestedStart))
        : workspace.projects[0]
      if (!startProject) {
        throw new WorkspaceValidationError('invalid-path')
      }
      // 统一信任入口：只按起始 cwd 装配项目资源；其他成员不装配扩展/MCP。
      const project = await assembly.acquire(startProject.path, disposed)
      const cwd = project.runtime.cwd
      let record: ThreadRecord
      try {
        // 显式模型：按 registry 校验并解析为模型对象（找不到时报错，不静默回退）。
        let explicitModel: HarnessDefaultModel | undefined
        if (input?.model) {
          const resolved = modelRuntime.getModel(input.model.provider, input.model.modelId)
          if (!resolved) {
            throw new Error(
              `${input.model.provider}/${input.model.modelId} is not in Pi's model registry`,
            )
          }
          explicitModel = resolved
        }
        const sessionDir = resolveSessionDirFor(cwd).dir
        // 尚未生成文件名，先检查目录中的探针路径；父目录链接也不得越过默认空间。
        catalog.assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
        const sessionManager = SessionManager.create(cwd, sessionDir)
        record = await live.openSession(sessionManager, cwd, {
          isNew: true,
          project,
          workspaceId,
          ...(explicitModel ? { model: explicitModel } : {}),
          ...(input?.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        })
      } catch (error) {
        // 项目装配已被本次创建消费但尚未发布会话（模型校验/打开失败等）：
        // 主动关闭其 MCP binding，避免 pending 连接或晚启动残留。
        await assembly.closeBinding(project.prepared.mcp)
        throw error
      }
      // 先保存归属再返回成功；失败时保留 Pi 文件作为未归属会话，不删除。
      try {
        await workspaceStore.assignSession({
          storeId,
          sessionId: record.threadId,
          workspaceId,
        })
      } catch (error) {
        await live.abandon(record)
        throw error
      }
      catalog.invalidateCatalog(cwd)
      if (input?.title) record.session.setSessionName(input.title)
      return events.snapshotOf(record)
    },

    async getThread(threadId: string): Promise<HarnessThreadSnapshot> {
      assertActive()
      return catalog.getThread(threadId)
    },

    async getThreadDetails(threadId: string): Promise<HarnessThreadDetails> {
      assertActive()
      return catalog.threadDetailsOf(threadId)
    },

    async listCommands(input?: {
      threadId?: string
      workspacePath?: string
    }): Promise<HarnessCommandCatalog> {
      assertActive()
      if (input?.threadId) {
        const record = await live.ensureOpen(input.threadId)
        return commandCatalogFromSession(record.session)
      }
      if (input?.workspacePath) {
        const prepared = await assembly.peek(input.workspacePath, disposed)
        return commandCatalogFromLoader(
          prepared.trust.resourceLoader,
          prepared.trust.settingsManager,
        )
      }
      throw new Error('命令目录需要会话或固定起始目录')
    },

    async getCommandArgumentCompletions(
      input: HarnessCommandArgumentInput,
    ): Promise<readonly HarnessCommandArgumentCompletion[]> {
      assertActive()
      if (input.threadId) {
        const record = await live.ensureOpen(input.threadId)
        return commandArgumentsFromSession(record.session, input.name, input.prefix)
      }
      if (input.workspacePath) {
        const prepared = await assembly.peek(input.workspacePath, disposed)
        return commandArgumentsFromLoader(prepared.trust.resourceLoader, input.name, input.prefix)
      }
      return []
    },

    async getSettings(input: HarnessSettingsTargetInput): Promise<HarnessSettingsSnapshot> {
      assertActive()
      if (input.global === true) return configuration.globalSettingsSnapshot(input)
      const resolved = await configuration.resolveConfigTarget(input)
      return configuration.settingsSnapshotOf(resolved.target, resolved.cwd, resolved.record)
    },

    async saveSettings(input: HarnessSettingsSaveInput): Promise<HarnessSettingsSaveResult> {
      // 与既有自动压缩/模型范围写入共享同一队列，避免同一文件并发写。
      return configuration.withSettingsWrite(() => configuration.saveSettings(input))
    },

    async getResources(input: HarnessResourceQueryInput): Promise<HarnessResourceSnapshot> {
      return configuration.resourceInventory(input)
    },

    async reloadResources(input: HarnessReloadTargetInput): Promise<HarnessReloadResult> {
      return configuration.reloadResources(input)
    },

    async searchFiles(
      input: HarnessFileSearchInput,
      options?: { signal?: AbortSignal },
    ): Promise<HarnessFileSearchResult> {
      assertActive()
      const roots = await fileSearchRootsOf(input)
      return searchWorkspaceFiles(
        roots,
        {
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
        options?.signal,
      )
    },

    async getThreadTree(threadId: string): Promise<HarnessThreadTree> {
      assertActive()
      return catalog.getThreadTree(threadId)
    },

    async navigateThreadTree(threadId, input): Promise<HarnessTreeNavigateResult> {
      return operations.navigateThreadTree(threadId, input)
    },

    async setThreadEntryLabel(threadId, input): Promise<HarnessTreeLabelResult> {
      return operations.setThreadEntryLabel(threadId, input)
    },

    async cancelThreadTreeNavigation(threadId) {
      return operations.cancelThreadTreeNavigation(threadId)
    },

    async forkThread(threadId, input): Promise<HarnessThreadForkResult> {
      return operations.forkThread(threadId, input)
    },

    async previewThreadImport(input): Promise<HarnessThreadImportPreview> {
      return importService.preview(input)
    },

    async importThread(input): Promise<HarnessThreadImportResult> {
      assertActive()
      return importService.import(input)
    },

    async sendMessage(threadId, input, options?: HarnessSendMessageOptions) {
      return operations.sendMessage(threadId, input, options)
    },

    async cancelRun(threadId) {
      return operations.cancelRun(threadId)
    },

    async clearQueue(threadId) {
      return operations.clearQueue(threadId)
    },

    async runThreadBash(
      threadId: string,
      input: { command: string; excludeFromContext?: boolean },
    ): Promise<HarnessBashStartResult> {
      return operations.runThreadBash(threadId, input)
    },

    async abortThreadBash(threadId: string): Promise<HarnessBashAbortResult> {
      assertActive()
      return operations.abortThreadBash(threadId)
    },

    async compactThread(
      threadId: string,
      input?: { customInstructions?: string },
    ): Promise<HarnessCompactionOutcome> {
      return operations.compactThread(threadId, input)
    },

    async abortThreadCompaction(threadId: string): Promise<HarnessCompactionAbortResult> {
      assertActive()
      return operations.abortThreadCompaction(threadId)
    },

    async setAutoCompaction(threadId, enabled) {
      return configuration.withSettingsWrite(() =>
        configuration.setAutoCompaction(threadId, enabled),
      )
    },

    async refreshModels(input: HarnessModelRefreshInput): Promise<HarnessModelRefreshResult> {
      return configuration.refreshModels(input)
    },

    async getAvailableModels(input): Promise<HarnessModelInfo[]> {
      return configuration.getAvailableModels(input)
    },

    async setModel(threadId, input) {
      return operations.setModel(threadId, input)
    },

    async setThinkingLevel(threadId, level: HarnessThinkingLevel) {
      return operations.setThinkingLevel(threadId, level)
    },

    async renameThread(threadId, title) {
      return operations.renameThread(threadId, title)
    },

    async archiveThread(threadId) {
      assertActive()
      const record = live.get(threadId)
      const info = record ? undefined : await catalog.findSessionInfo(threadId)
      if (!record && !info) throw new Error(`Unknown thread: ${threadId}`)
      // 归档是 huan 侧车组织标记：不改 Pi JSONL、不改工作区 revision、不停止任务。
      await workspaceStore.setSessionArchived({ storeId, sessionId: threadId, archived: true })
      if (record) events.emit(record, { type: 'snapshot', snapshot: events.snapshotOf(record) })
    },

    async unarchiveThread(threadId) {
      assertActive()
      const record = live.get(threadId)
      const info = record ? undefined : await catalog.findSessionInfo(threadId)
      if (!record && !info) throw new Error(`Unknown thread: ${threadId}`)
      await workspaceStore.setSessionArchived({ storeId, sessionId: threadId, archived: false })
      if (record) events.emit(record, { type: 'snapshot', snapshot: events.snapshotOf(record) })
    },

    deleteThread(threadId) {
      return live.deleteOnce(threadId)
    },

    async respondToHostUiRequest(threadId, response: HarnessHostUiResponse) {
      live.respondToHostUiRequest(threadId, response)
    },

    async getHostInteractions(): Promise<HarnessHostInteractionSnapshot> {
      assertActive()
      return interactions.snapshot()
    },

    async getProviderAuth(): Promise<HarnessProviderAuthSnapshot> {
      assertActive()
      // 每次查询都重读凭据元数据（不解析密钥）；外部 Pi 改动也能及时发现。
      await providerAuth.refresh()
      return providerAuth.snapshot()
    },

    subscribeProviderAuth(listener: (event: HarnessProviderAuthStreamEvent) => void) {
      if (disposed) return () => {}
      return providerAuth.subscribe(listener)
    },

    async startProviderLogin(input): Promise<HarnessProviderAuthStartResult> {
      assertActive()
      return providerAuth.startLogin(input.providerId, input.method)
    },

    async respondProviderAuthPrompt(input): Promise<HarnessProviderAuthRespondResult> {
      assertActive()
      return providerAuth.respond(input)
    },

    async cancelProviderAuth(operationId): Promise<HarnessProviderAuthCancelResult> {
      assertActive()
      return providerAuth.cancel(operationId)
    },

    async logoutProvider(providerId): Promise<HarnessProviderAuthStartResult> {
      assertActive()
      return providerAuth.logout(providerId)
    },

    async getMcp(input: HarnessMcpTargetInput): Promise<HarnessMcpSnapshot> {
      assertActive()
      return mcpBroker().getMcp(input)
    },

    async getMcpDetails(input: HarnessMcpDetailsInput): Promise<HarnessMcpDetailsResult> {
      assertActive()
      return mcpBroker().getMcpDetails(input)
    },

    async getMcpConfig(input: HarnessMcpTargetInput): Promise<HarnessMcpConfigSnapshot> {
      assertActive()
      return mcpBroker().getMcpConfig(input)
    },

    async saveMcpConfig(input: HarnessMcpConfigSaveInput): Promise<HarnessMcpConfigSaveResult> {
      assertActive()
      return mcpBroker().saveMcpConfig(input)
    },

    async manageMcp(input: HarnessMcpManageInput): Promise<HarnessMcpManageResult> {
      assertActive()
      return mcpBroker().manageMcp(input)
    },

    async getMcpAuth(): Promise<HarnessMcpAuthSnapshot> {
      assertActive()
      return mcpBroker().getMcpAuth()
    },

    async startMcpLogin(input: HarnessMcpAuthStartInput): Promise<HarnessMcpAuthStartResult> {
      assertActive()
      return mcpBroker().startMcpLogin(input)
    },

    async respondMcpAuth(input: HarnessMcpAuthRespondInput): Promise<HarnessMcpAuthRespondResult> {
      assertActive()
      return mcpBroker().respondMcpAuth(input)
    },

    async cancelMcpAuth(operationId): Promise<HarnessMcpAuthCancelResult> {
      assertActive()
      return mcpBroker().cancelMcpAuth(operationId)
    },

    async logoutMcp(input: HarnessMcpAuthStartInput): Promise<HarnessMcpAuthStartResult> {
      assertActive()
      return mcpBroker().logoutMcp(input)
    },

    subscribeHostInteractions(listener: (event: HarnessHostInteractionEvent) => void) {
      if (disposed) return () => {}
      return interactions.subscribe((snapshot) => {
        listener({ type: 'snapshot', seq: snapshot.seq, snapshot })
      })
    },

    async respondToHostInteraction(
      response: HarnessHostUiResponse,
    ): Promise<HarnessHostInteractionAnswer> {
      assertActive()
      return { accepted: interactions.respond(response) }
    },

    async consumeHostUiDirective(threadId, directiveId, options) {
      assertActive()
      return live.consumeHostUiDirective(threadId, directiveId, options)
    },

    subscribe(threadId, listener, subOptions) {
      return live.subscribe(threadId, listener, subOptions)
    },
  }

  return {
    ...client,
    async dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      // 先同步使全部 MCP binding 失效并启动管理器关闭，再 await 认证等收尾：
      // 创建进行中、尚未发布 record 的装配也必须被回收，不能只等 session_shutdown。
      for (const record of live.all()) live.invalidateMcpRuntime(record)
      const closingMcp = assembly.pendingBindingList().map((mcp) => assembly.closeBinding(mcp))
      // 认证 broker 与 MCP broker 的取消尽早开始，避免登录/回填阻塞其他清理。
      const closingMcpHost = mcpHost?.dispose()
      // 先结算所有宿主级启动请求与认证流程，解除 project/session 装配等待。
      interactions.dispose()
      await providerAuth.dispose()
      const closingSubagents = subagents.dispose()
      // live 负责 pending opens 中止与逐 record 收尾（同一 retire 流程）。
      await live.disposeAll().catch((error) => {
        pushDiagnostic(`会话收尾：${String(error)}`)
      })
      await closingSubagents
      await Promise.allSettled(closingMcp)
      // 共享 OAuth/log 必须等所有连接关闭后再收尾；放在其他 cleanup 之后，
      // 不让登录/日志落盘阻塞会话回收。
      await closingMcpHost
      await mcpOAuth.close()
      await mcpLog.close()
    },
    diagnostics: () => [...diagnostics],
  }
}
