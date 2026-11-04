/**
 * 项目装配服务：唯一持有项目信任缓存、待消费 loader 与准备中 MCP binding。
 *
 * 装配只经统一信任入口创建 loader；查询只借用，会话创建通过 `acquire` 原子
 * 取走 pending loader。pending 资源在发布为 live record 前仍归本服务关闭；
 * `transferBinding` 是 MCP binding 所有权移交的唯一入口。
 */

import { realpathSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  hasTrustRequiringProjectResources,
  type LoadExtensionsResult,
  type ProjectTrustContext,
  type ProjectTrustStore,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { McpOAuthService } from '@huan/mcp'
import { createMcpIntegration, type McpIntegration, type McpServerLog } from '@huan/mcp'
import type {
  HarnessHostInteractionScope,
  HarnessProjectFailureCode,
  HarnessProjectInfo,
  HarnessProjectTrustInput,
  HarnessRecentProject,
} from '@huan/protocol'
import { createBuiltinExtensionFactories } from '../builtin-extensions.js'
import type { createHostInteractions } from '../host-interactions.js'
import type { SessionCatalogInfo } from '../metadata.js'
import { type HarnessResourceLoaderOptions, toResourceLoaderOptions } from '../model-catalog.js'
import {
  type ProjectTrustResult,
  type ProjectTrustSource,
  prepareProjectTrust,
} from '../project-trust.js'
import { bindResourceLoaderTrust } from '../resource-reload.js'
import {
  createSubagentToolExtension,
  type SubagentProjectConfirmation,
  type SubagentTaskRunner,
} from '../subagent-tool.js'
import { pathKey, type WorkspaceSnapshot } from '../workspace-path.js'
import type { WorkspaceStoreWorkspace } from '../workspace-store.js'
import { createWorkspaceToolsExtension } from '../workspace-tools.js'
import {
  createInputGuardExtension,
  type HarnessDefaultModel,
  type PreparedProject,
  type ProjectRuntime,
  ProjectTrustRequiredError,
  ThreadStructureBusyError,
} from './shared.js'
import type { SubagentPrepareOptions } from './subagent-sessions.js'

/** 内置 SDK 子agent 扩展的资源名；其他扩展的同名工具均被视为外部旧实现。 */
const BUILTIN_SUBAGENT_PATH = 'builtin:subagent'

/** 装配依赖：只包含实际使用的路径、共享模型与读能力。 */
export type ProjectAssemblyDeps = {
  agentDir: string
  workspacePath: string
  model?: HarnessDefaultModel
  resourceLoaderOptions?: HarnessResourceLoaderOptions
  modelRuntime: ReturnType<
    typeof import('../model-catalog.js').createSharedModelRuntime
  > extends Promise<infer T>
    ? T
    : never
  mcpOAuth: Pick<McpOAuthService, 'createAuthProvider'>
  mcpLog: Pick<McpServerLog, 'write'>
  interactions: ReturnType<typeof createHostInteractions>
  trustStore: ProjectTrustStore
  /** 受控诊断与安全代码；不把原始错误送达浏览器。 */
  diagnose: (message: string) => void
  addSafeDiagnostic: (
    code: 'assembly-warning' | 'catalog-refresh-failed' | 'model-fallback',
  ) => void
  refreshCatalog: () => Promise<void>
  refreshCatalogOnStart: boolean
  listScopeInfos: () => Promise<SessionCatalogInfo[]>
  workspaceSnapshotOf: (workspaceId: string) => WorkspaceSnapshot | null
  /** 子任务执行层；由组合根代理注入，装配层不持有子会话服务。 */
  subagents: SubagentTaskRunner
}

/** 解析真实路径；不存在时保留绝对路径（与 SDK 口径一致）。 */
export const canonicalProjectPath = (path: string): string => {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export const projectNameOf = (path: string): string => basename(path) || path

export const isAvailableDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class ProjectAssembly {
  /** 项目状态与可复用装配按规范化 cwd 缓存；live session 仍各自重新装配。 */
  private readonly projectRuntimes = new Map<string, ProjectRuntime>()
  private readonly pendingProjects = new Map<string, Promise<ProjectRuntime>>()
  /** 已创建、尚未移交给 live record 的 MCP binding。 */
  private readonly pendingBindings = new Set<McpIntegration>()
  /** 本宿主内的显式信任覆盖（按规范化 cwd）。 */
  readonly explicitTrust = new Map<string, boolean>()
  /** 空白页目标的重载闸门。 */
  readonly workspaceReloads = new Set<string>()
  /** 宿主级交互请求 ID（与线程请求 ID 命名空间分离）。 */
  private interactionRequestCounter = 0

  constructor(private readonly deps: ProjectAssemblyDeps) {}

  runtime(cwd: string): ProjectRuntime | undefined {
    return this.projectRuntimes.get(cwd)
  }

  runtimes(): IterableIterator<ProjectRuntime> {
    return this.projectRuntimes.values()
  }

  bindingCount(): number {
    return this.pendingBindings.size
  }

  hasPendingLoad(cwd: string): boolean {
    return this.pendingProjects.has(cwd)
  }

  pendingBindingList(): McpIntegration[] {
    return [...this.pendingBindings]
  }

  /** 关闭并移除一个仍归装配所有的 binding；close 幂等且同步禁止晚结果。 */
  async closeBinding(mcp: McpIntegration): Promise<void> {
    this.pendingBindings.delete(mcp)
    try {
      await mcp.close()
    } catch {
      // 清理失败不改变调用方失败/成功口径。
    }
  }

  /**
   * 原子移交给 live record：之后由 record/删除/销毁路径负责关闭。
   * 只移除本服务所有权，不调用 close。
   */
  transferBinding(mcp: McpIntegration): void {
    this.pendingBindings.delete(mcp)
  }

  private nextInteractionRequestId(): string {
    this.interactionRequestCounter += 1
    return `host:ui:${this.interactionRequestCounter}:${Math.random().toString(36).slice(2, 8)}`
  }

  private projectTrustContextOf(cwd: string): ProjectTrustContext {
    const canonicalCwd = canonicalProjectPath(cwd)
    const scope: HarnessHostInteractionScope = { kind: 'project', cwd: canonicalCwd }
    const interactions = this.deps.interactions
    return {
      cwd: canonicalCwd,
      mode: 'rpc',
      hasUI: true,
      ui: {
        select: async (title, options, opts) => {
          const answer = await interactions.ask(
            {
              id: this.nextInteractionRequestId(),
              kind: 'select',
              title,
              options,
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            },
            scope,
            opts,
          )
          return answer.dismissed ? undefined : answer.value
        },
        confirm: async (title, message, opts) => {
          const answer = await interactions.ask(
            {
              id: this.nextInteractionRequestId(),
              kind: 'confirm',
              title,
              message,
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            },
            scope,
            opts,
          )
          return answer.confirmed ?? false
        },
        input: async (title, placeholder, opts) => {
          const answer = await interactions.ask(
            {
              id: this.nextInteractionRequestId(),
              kind: 'input',
              title,
              ...(placeholder !== undefined ? { placeholder } : {}),
              ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
            },
            scope,
            opts,
          )
          return answer.dismissed ? undefined : answer.value
        },
        notify: (message, type) => interactions.notify(scope, message, type),
      },
    }
  }

  /** 把核心信任结果投影为 JSON-safe 项目摘要（不传扩展错误原文）。 */
  projectInfoOf(prepared: { trust: ProjectTrustResult }): HarnessProjectInfo {
    const state = prepared.trust.state
    return {
      path: state.cwd,
      name: projectNameOf(state.cwd),
      status: state.status === 'needs-trust' ? 'needs-trust' : 'ready',
      trust: {
        decision: state.status === 'needs-trust' ? 'unknown' : state.status,
        origin: state.source,
        requiresTrust: state.requiresTrust,
        defaultPolicy: state.defaultProjectTrust,
        ...(state.savedPath ? { savedPath: state.savedPath } : {}),
        extensionErrorCount: state.extensionErrors.length,
      },
    }
  }

  failedProjectInfo(path: string, code: HarnessProjectFailureCode): HarnessProjectInfo {
    return {
      path,
      name: projectNameOf(path),
      status: 'failed',
      failure: { code },
      trust: {
        decision: 'unknown',
        origin: 'none',
        requiresTrust: false,
        defaultPolicy: 'ask',
        extensionErrorCount: 0,
      },
    }
  }

  /** 把扩展装配期登记的项目 provider/虚拟模型写入共享 modelRuntime。 */
  registerPreparedProviders(extensions: LoadExtensionsResult): void {
    const runtime = extensions.runtime
    for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
      try {
        this.deps.modelRuntime.registerProvider(name, config)
      } catch (error) {
        this.deps.diagnose(`扩展 provider（${extensionPath}）：${String(error)}`)
        this.deps.addSafeDiagnostic('assembly-warning')
      }
    }
    runtime.pendingProviderRegistrations = []
    for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
      try {
        this.deps.modelRuntime.registerNativeProvider(provider)
      } catch (error) {
        this.deps.diagnose(`原生 provider（${extensionPath}）：${String(error)}`)
        this.deps.addSafeDiagnostic('assembly-warning')
      }
    }
    runtime.pendingNativeProviderRegistrations = []
    for (const { definition, extensionPath } of runtime.pendingVirtualModelRegistrations) {
      try {
        this.deps.modelRuntime.registerVirtualModel(definition)
      } catch (error) {
        this.deps.diagnose(`虚拟模型（${extensionPath}）：${String(error)}`)
        this.deps.addSafeDiagnostic('assembly-warning')
      }
    }
    runtime.pendingVirtualModelRegistrations = []
  }

  /** 经统一信任入口准备一份会话装配；子会话选项只影响本次准备的 loader。 */
  async prepare(
    cwd: string,
    override?: boolean,
    disposed = false,
    options?: SubagentPrepareOptions,
  ): Promise<PreparedProject> {
    if (disposed) throw new Error('Harness host is disposed')
    const guard: { record?: import('./shared.js').ThreadRecord } = {}
    const workspaceBinding: PreparedProject['workspaceBinding'] = {
      loadedInstructionPaths: [],
    }
    const subagentSession = options?.subagent === true
    const appendSystemPrompt = options?.appendSystemPrompt ?? []
    const mcpOverrides = options?.mcpOverrides
    // binding 先于信任装配创建：工厂在此轮 loader.reload 中就会注册事件。
    // 初始尚未取得 trust 时闭包必须返回 false，避免把“未知”当作已信任。
    let trustState: import('../project-trust.js').ProjectTrustState | undefined
    const mcp = createMcpIntegration({
      agentDir: this.deps.agentDir,
      getProjectTrusted: () =>
        trustState?.status === 'trusted' &&
        // 装配后、session_start 前新出现的资源不能沿用 no-resources 授权。
        (trustState.source !== 'no-resources' || !hasTrustRequiringProjectResources(cwd)),
      // 同 cwd 的子会话临时继承父会话的启停/exposure 选择；仅在内存中合并，
      // 不写回 mcp.json。文件条目与扩展动态注册的同名服务器都应用这份选择。
      ...(mcpOverrides && Object.keys(mcpOverrides).length > 0
        ? { serverOverrides: mcpOverrides }
        : {}),
      // OAuth 与日志按宿主共享；连接层只接受公开工厂/接收器。
      createAuthProvider: this.deps.mcpOAuth.createAuthProvider,
      onLog: (server, params) => {
        void this.deps.mcpLog.write(server, params)
      },
    })
    this.pendingBindings.add(mcp)
    try {
      const trust = await prepareProjectTrust({
        cwd,
        agentDir: this.deps.agentDir,
        ...(override !== undefined ? { override } : {}),
        trustStore: this.deps.trustStore,
        resourceLoaderOptions: {
          ...toResourceLoaderOptions(this.deps.resourceLoaderOptions),
          // SDK 的 appendSystemPrompt 选项会替换自动发现的 APPEND_SYSTEM 文件；
          // 用 override 在既有追加内容之后补定义正文，保留父项目原有追加提示。
          ...(appendSystemPrompt.length > 0
            ? {
                appendSystemPromptOverride: (base: string[]) => [...base, ...appendSystemPrompt],
              }
            : {}),
          // 外部同名 subagent 工具由下方 extensionsOverride 从加载结果中移除；
          // 这里的内置扩展保留给直接工具调用，子会话则由 isSubagentSession 拒绝嵌套。
          extensionsOverride: (base) => this.removeExternalSubagentTools(base, cwd),
          extensionFactories: [
            createInputGuardExtension(() => guard.record),
            // 工作区扩展按会话实例装配。loader 若先用于查询，绑定槽为空；
            // 被某个 live session 消费时才写入归属，不会按 cwd 复用给另一个工作区。
            createWorkspaceToolsExtension({
              getWorkspace: () =>
                workspaceBinding.workspaceId
                  ? this.deps.workspaceSnapshotOf(workspaceBinding.workspaceId)
                  : null,
              getLoadedInstructionPaths: () => workspaceBinding.loadedInstructionPaths,
              onWorkspaceApplied: (workspace) => workspaceBinding.onApplied?.(workspace),
            }),
            // SDK 子agent 固定为内置实现：定义来源、项目确认与子任务执行均经
            // 注入的 runner；子会话 parent 由 guard.record 在发布后提供。
            createSubagentToolExtension({
              agentDir: this.deps.agentDir,
              getParent: () => guard.record,
              isSubagentSession: () => subagentSession,
              runner: this.deps.subagents,
              confirmProject: (input) => this.confirmSubagentProject(input),
            }),
            // codemode / tool_search / mcp 按 CLI 的 named builtin + replaceable
            // 约定装配；MCP 只注入 huan 的无界面集成工厂，不注入官方实现。
            ...createBuiltinExtensionFactories(mcp.extension),
          ],
        },
        // 项目信任扩展可以获得真实 RPC UI；请求在 record 发布前也可发现/应答。
        projectTrustContext: options?.projectTrustContext ?? this.projectTrustContextOf(cwd),
      })
      // 本轮 loader 的权威状态对象会在 reload 时被就地更新；session_start 的
      // getProjectTrusted 每次读取它，因此 no-resources 之后新增受保护资源
      // 不会沿用旧结论。
      trustState = trust.state
      for (const message of [...trust.loadErrors, ...trust.state.extensionErrors]) {
        this.deps.diagnose(`扩展装配（${trust.state.cwd}）：${message}`)
        this.deps.addSafeDiagnostic('assembly-warning')
      }
      const extensions = trust.resourceLoader.getExtensions()
      // 上游 pi-workspaces 与本宿主的同名工具职责重叠。若用户仍安装该插件，
      // 明确拒绝装配并给出诊断，避免双重注册/双重权威静默并存。
      const conflicting = extensions.extensions.find((extension) => {
        const segments = extension.path.split(/[\\/]/)
        return segments.some(
          (segment) => segment === 'pi-workspaces' || segment.startsWith('pi-workspaces.'),
        )
      })
      if (conflicting) {
        const message =
          `检测到 pi-workspaces 扩展（${conflicting.path}）；huan 已内置工作区工具，` +
          '请移除该扩展后重新打开项目，避免同名工具重复注册。'
        this.deps.diagnose(`扩展装配（${trust.state.cwd}）：${message}`)
        this.deps.addSafeDiagnostic('assembly-warning')
        throw new Error(message)
      }
      this.registerPreparedProviders(extensions)
      // 与 SDK 服务装配一致：注册完 provider 后物化本地目录，不触发联网。
      await this.deps.modelRuntime.refresh({ allowNetwork: false })
      workspaceBinding.loadedInstructionPaths = trust.resourceLoader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.path)
      // SDK 的 AgentSession.reload() 调 loader.reload() 时不传信任回调；宿主必须
      // 保证重载不能绕过信任门控（新出现的项目资源不得沿用 no-resources 结论）。
      const trustBinding = bindResourceLoaderTrust(trust.resourceLoader, {
        cwd: trust.state.cwd,
        settingsManager: trust.settingsManager,
        trustStore: this.deps.trustStore,
        state: trust.state,
        explicitDecision: () => this.explicitTrust.get(pathKey(trust.state.cwd)),
        projectTrustContext: () => this.projectTrustContextOf(trust.state.cwd),
        onExtensionErrors: (errors) => {
          for (const message of errors) {
            this.deps.diagnose(`重载信任扩展（${trust.state.cwd}）：${message}`)
            this.deps.addSafeDiagnostic('assembly-warning')
          }
        },
      })
      return { trust, guard, workspaceBinding, trustBinding, mcp }
    } catch (error) {
      // 装配中途失败（含信任/扩展冲突/模型目录刷新）：本 binding 不会被会话
      // 消费，立即关闭，避免工厂已注册的晚启动路径留下连接。
      await this.closeBinding(mcp)
      throw error
    }
  }

  /**
   * 项目来源定义运行前的确认。
   *
   * 父会话已有可信项目结论时不再重复询问；no-resources 结论不能覆盖后来发现
   * 的项目定义。这里只负责用户确认，目标 cwd 的项目信任仍由服务层 prepare
   * 独立检查，confirmProjectAgents=false 不能绕过该检查。
   */
  private async confirmSubagentProject(input: SubagentProjectConfirmation): Promise<boolean> {
    const parent = input.parent
    const trust = parent.trustBinding?.state?.()
    if (trust?.status === 'trusted' && trust.source !== 'no-resources') return true
    const agents = input.agents.map((agent) => `${agent.name}（${agent.source}）`).join('、')
    const source = input.projectDir ?? input.targetCwds.join('、')
    return parent.uiBridge.ui.confirm(
      '运行项目子agent？',
      `子agent：${agents}\n项目来源：${source}`,
      { signal: input.signal },
    )
  }

  /**
   * D5：外部扩展的 subagent 工具固定由内置 SDK 实现替代。
   *
   * 只摘除非 `builtin:subagent` 扩展 tools Map 中的同名条目，扩展本身、其他工具、
   * 命令与事件处理器保持原样；SDK 在 override 之前已经生成了同名工具冲突诊断，
   * 这里仅过滤本次替代产生的 subagent 冲突，其他原始错误继续保留。
   */
  private removeExternalSubagentTools(
    base: LoadExtensionsResult,
    cwd: string,
  ): LoadExtensionsResult {
    const replacedPaths = new Set<string>()
    const extensions = base.extensions.map((extension) => {
      if (extension.path === BUILTIN_SUBAGENT_PATH || !extension.tools.has('subagent')) {
        return extension
      }
      replacedPaths.add(extension.path)
      const tools = new Map(extension.tools)
      tools.delete('subagent')
      return { ...extension, tools }
    })
    if (replacedPaths.size === 0) return base

    for (const path of replacedPaths) {
      const message =
        `检测到外部 subagent 工具（${path}）；已改用内置 SDK 版 subagent，` +
        '保留该扩展的其他工具与事件。'
      this.deps.diagnose(`扩展装配（${cwd}）：${message}`)
      this.deps.addSafeDiagnostic('assembly-warning')
    }

    const errors = base.errors.filter(
      (error) =>
        !(
          error.error.startsWith('Tool "subagent" conflicts with ') &&
          (error.path === BUILTIN_SUBAGENT_PATH || replacedPaths.has(error.path))
        ),
    )
    return {
      ...base,
      extensions,
      errors,
      warnings: [
        ...(base.warnings ?? []),
        ...[...replacedPaths].map((path) => ({
          path,
          warning: '此扩展的 subagent 工具已由 huan 内置 SDK 实现替代；其他注册保持。',
        })),
      ],
    }
  }

  /** 由一次装配结果建立/替换项目缓存。旧 loader 未被消费时直接丢弃。 */
  runtimeFrom(prepared: PreparedProject, originOverride?: ProjectTrustSource): ProjectRuntime {
    const info = this.projectInfoOf(prepared)
    const runtime: ProjectRuntime = {
      cwd: info.path,
      info: originOverride ? { ...info, trust: { ...info.trust, origin: originOverride } } : info,
      settingsManager: prepared.trust.settingsManager,
      defaultModel: this.defaultModelOf(info.path, prepared.trust.settingsManager),
      pending: prepared,
    }
    // 替换缓存时旧 pending loader 不会再被消费；其 MCP binding 必须同步收尾，
    // 不能等宿主 dispose（查询路径可能反复重建项目装配）。
    const previous = this.projectRuntimes.get(runtime.cwd)
    if (previous?.pending && previous.pending !== prepared) {
      void this.closeBinding(previous.pending.mcp)
    }
    runtime.lastLoader = {
      loader: prepared.trust.resourceLoader,
      settings: prepared.trust.settingsManager,
    }
    this.projectRuntimes.set(runtime.cwd, runtime)
    return runtime
  }

  private defaultModelOf(
    cwd: string,
    settingsManager: SettingsManager,
  ): ProjectRuntime['defaultModel'] {
    return resolveDefaultModelWithDeps(
      this.deps.modelRuntime,
      cwd,
      this.deps.agentDir,
      this.deps.model,
      settingsManager,
    )
  }

  /** 装载一个新的项目装配并缓存状态（可能停在 needs-trust）。 */
  loadRuntime(cwd: string, disposed = false): Promise<ProjectRuntime> {
    const existing = this.pendingProjects.get(cwd)
    if (existing) return existing
    const pending = this.prepare(cwd, undefined, disposed)
      .then((prepared) => this.runtimeFrom(prepared))
      .finally(() => {
        this.pendingProjects.delete(cwd)
      })
    this.pendingProjects.set(cwd, pending)
    return pending
  }

  /** 查询项目：优先缓存；项目资源集合变化时重新评估，不用过期结论。 */
  async query(input: string, disposed = false): Promise<HarnessProjectInfo> {
    const check = await this.inspectPath(input)
    if (check.error) return this.failedProjectInfo(check.path || input, check.error.code)
    const cached = this.projectRuntimes.get(check.path)
    if (cached && cached.info.status !== 'failed') {
      const requiresTrust = hasTrustRequiringProjectResources(check.path)
      if (requiresTrust === cached.info.trust.requiresTrust) return cached.info
    }
    try {
      return (await this.loadRuntime(check.path, disposed)).info
    } catch (error) {
      this.deps.diagnose(`项目装配（${check.path}）：${String(error)}`)
      this.deps.addSafeDiagnostic('assembly-warning')
      return this.failedProjectInfo(check.path, 'load-failed')
    }
  }

  /**
   * 只读信任摘要：用于工作区成员管理展示，不加载项目扩展或资源。
   *
   * 该路径只读取 trust.json、全局默认策略与项目资源存在性；用户级
   * project_trust 扩展的实际决定仍会在真正装配/新建会话时执行。
   */
  async inspectTrust(input: string): Promise<HarnessProjectInfo> {
    const check = await this.inspectPath(input)
    if (check.error) return this.failedProjectInfo(check.path || input, check.error.code)
    try {
      const trust = await prepareProjectTrust({
        cwd: check.path,
        agentDir: this.deps.agentDir,
        trustStore: this.deps.trustStore,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      })
      return this.projectInfoOf({ trust })
    } catch (error) {
      this.deps.diagnose(`项目信任摘要（${check.path}）：${String(error)}`)
      return this.failedProjectInfo(check.path, 'load-failed')
    }
  }

  /** 会话装配：复用未消费的启动/决定 loader，否则按已知结论重新装配。 */
  async acquire(
    input: string,
    disposed = false,
  ): Promise<{
    runtime: ProjectRuntime
    prepared: PreparedProject
  }> {
    const check = await this.inspectPath(input)
    if (this.workspaceReloads.has(check.path)) {
      throw new ThreadStructureBusyError('起始目录资源正在重载，请稍后重试')
    }
    if (check.error) {
      throw new Error(`项目路径不可用：${check.error.code}`)
    }
    const takePending = (runtime: ProjectRuntime): PreparedProject | undefined => {
      const prepared = runtime.pending
      runtime.pending = undefined
      return prepared
    }
    let runtime = this.projectRuntimes.get(check.path)
    if (runtime?.info.status === 'needs-trust') {
      throw new ProjectTrustRequiredError(runtime.info)
    }
    if (runtime?.info.status === 'failed') {
      // 上次装配失败：本次会话重新尝试，不复用失败结论。
      runtime.pending = undefined
      runtime = await this.loadRuntime(check.path, disposed)
      if (runtime.info.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(runtime.info)
      }
    } else if (runtime) {
      // 项目资源集合变化：旧结论与旧 loader 都不能再用。
      const requiresTrust = hasTrustRequiringProjectResources(check.path)
      if (requiresTrust !== runtime.info.trust.requiresTrust) {
        runtime.pending = undefined
        runtime = await this.loadRuntime(check.path, disposed)
        if (runtime.info.status === 'needs-trust') {
          throw new ProjectTrustRequiredError(runtime.info)
        }
      }
    } else {
      runtime = await this.loadRuntime(check.path, disposed)
      if (runtime.info.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(runtime.info)
      }
    }

    const pending = takePending(runtime)
    if (pending) return { runtime, prepared: pending }

    // 缓存中的结论仍然有效：按同一结论重新装配，不再次询问用户。
    const prepared = await this.prepare(
      runtime.cwd,
      runtime.info.trust.decision === 'trusted',
      disposed,
    )
    runtime.settingsManager = prepared.trust.settingsManager
    runtime.defaultModel = this.defaultModelOf(runtime.cwd, prepared.trust.settingsManager)
    runtime.lastLoader = {
      loader: prepared.trust.resourceLoader,
      settings: prepared.trust.settingsManager,
    }
    return { runtime, prepared }
  }

  /**
   * 读取空白页资源目录所需的装配，但不消费 loader。
   *
   * 目录查询会在首个会话创建前发生；这里把装配结果留在 pending，
   * 后续 createThread 直接复用，避免扩展工厂因浏览命令目录被重复执行。
   */
  async peek(input: string, disposed = false): Promise<PreparedProject> {
    const check = await this.inspectPath(input)
    if (this.workspaceReloads.has(check.path)) {
      throw new ThreadStructureBusyError('起始目录资源正在重载，请稍后重试')
    }
    if (check.error) throw new Error(`项目路径不可用：${check.error.code}`)
    let runtime = this.projectRuntimes.get(check.path)
    if (!runtime || runtime.info.status === 'failed') {
      runtime = await this.loadRuntime(check.path, disposed)
    }
    if (runtime.info.status === 'needs-trust') {
      throw new ProjectTrustRequiredError(runtime.info)
    }
    if (runtime.pending) return runtime.pending
    const prepared = await this.prepare(
      runtime.cwd,
      runtime.info.trust.decision === 'trusted',
      disposed,
    )
    runtime.pending = prepared
    runtime.settingsManager = prepared.trust.settingsManager
    runtime.lastLoader = {
      loader: prepared.trust.resourceLoader,
      settings: prepared.trust.settingsManager,
    }
    return prepared
  }

  /** 保存决定后立即装配；保留本次显式来源与保存路径供页面展示。 */
  async decide(input: HarnessProjectTrustInput, disposed = false): Promise<HarnessProjectInfo> {
    const check = await this.inspectPath(input.path)
    if (check.error) return this.failedProjectInfo(check.path || input.path, check.error.code)
    if (input.remember === true) this.deps.trustStore.set(check.path, input.trusted)
    // 显式决定即使不保存也必须对本次进程内的后续重载可见（否则重载会误拒）。
    this.explicitTrust.set(pathKey(check.path), input.trusted)
    try {
      const prepared = await this.prepare(check.path, input.trusted, disposed)
      const runtime = this.runtimeFrom(prepared, 'explicit')
      if (input.remember === true) {
        runtime.info = {
          ...runtime.info,
          trust: { ...runtime.info.trust, savedPath: check.path },
        }
      }
      if (input.trusted && this.deps.refreshCatalogOnStart) await this.deps.refreshCatalog()
      return runtime.info
    } catch (error) {
      this.deps.diagnose(`信任决定（${check.path}）：${String(error)}`)
      this.deps.addSafeDiagnostic('assembly-warning')
      return this.failedProjectInfo(check.path, 'load-failed')
    }
  }

  /** 最近项目：同一 agentDir 的会话 header + 缓存过的项目；按活动时间排序。 */
  async listRecent(): Promise<HarnessRecentProject[]> {
    const projects = new Map<string, { lastActiveAt?: string }>()
    for (const info of await this.deps.listScopeInfos()) {
      if (!info.cwd) continue
      const path = canonicalProjectPath(info.cwd)
      const time = info.modified.toISOString()
      const existing = projects.get(path)
      if (!existing?.lastActiveAt || time > existing.lastActiveAt) {
        projects.set(path, { lastActiveAt: time })
      }
    }
    for (const runtime of this.projectRuntimes.values()) {
      if (!projects.has(runtime.cwd)) projects.set(runtime.cwd, {})
    }
    const startup = canonicalProjectPath(this.deps.workspacePath)
    if (!projects.has(startup)) projects.set(startup, {})
    return [...projects.entries()]
      .map(([path, activity]) => ({
        path,
        name: projectNameOf(path),
        ...(activity.lastActiveAt ? { lastActiveAt: activity.lastActiveAt } : {}),
      }))
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
      .slice(0, 20)
  }

  /** 路径校验只做文件系统检查，不执行任何项目代码。 */
  async inspectPath(input: string): Promise<import('@huan/protocol').HarnessProjectPathCheck> {
    const requested = input.trim()
    if (!requested) {
      return { input, path: '', exists: false, isDirectory: false, error: { code: 'invalid-path' } }
    }
    const path = canonicalProjectPath(requested)
    try {
      const info = await stat(path)
      if (!info.isDirectory()) {
        return { input, path, exists: true, isDirectory: false, error: { code: 'not-directory' } }
      }
      return { input, path, exists: true, isDirectory: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        input,
        path,
        exists: false,
        isDirectory: false,
        error: { code: code === 'ENOENT' ? 'not-found' : 'invalid-path' },
      }
    }
  }
}

/** 延迟到装配服务内部，避免 shared 反向依赖模型目录实现。 */
import { resolveDefaultModel as resolveDefaultModelImpl } from '../model-catalog.js'

function resolveDefaultModelWithDeps(
  modelRuntime: ProjectAssemblyDeps['modelRuntime'],
  cwd: string,
  agentDir: string,
  model: HarnessDefaultModel | undefined,
  settingsManager: SettingsManager,
): ProjectRuntime['defaultModel'] {
  return resolveDefaultModelImpl({
    modelRuntime,
    cwd,
    agentDir,
    ...(model ? { model } : {}),
    settingsManager,
  })
}

export type { McpIntegration, McpServerLog, ProjectTrustResult, WorkspaceStoreWorkspace }
