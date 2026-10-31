/**
 * 自研宿主（@huan/core）：Pi 会话运行时的所有者，实现协议 HarnessClient。
 *
 * 设计要点（对照迭代③设计 §3.3）：
 * - **装配粒度**：modelRuntime 全宿主共享一份（provider 注册为合并语义）；
 *   settingsManager / resourceLoader / 扩展 runtime 每 live session 独立装配
 *   （扩展 runner 会把动作绑定写入共享 runtime，复用会导致会话串扰）。
 * - **新/冷语义分离**：新建会话传默认模型；冷打开历史会话不传 model，
 *   让 SDK 从会话记录恢复（否则默认模型会覆盖会话自身记录）。
 * - **行为契约**：sendMessage 返回 = 输入已被接受（不等待运行结束）；
 *   删除先 abort 再 dispose 再 unlink；订阅先快照后实时（同一 record、同一 seq 边界）。
 * - **存储作用域（G1.1 §3）**：agentDir 与 sessionDir 在宿主创建时解析为绝对路径
 *   并固定（显式 > `PI_CODING_AGENT_SESSION_DIR` > 启动工作区 setting >
 *   `<agentDir>/sessions/<编码 cwd>`）；创建、枚举、按 ID 查找、打开、改名、
 *   删除均限定在该作用域，无覆盖时跨 cwd 只枚举当前 agentDir 下的分组目录。
 * - **取消与失败口径**：取消以 SDK 的 `agent_settled.aborted` 为权威，
 *   不向前端报告为失败；失败在 `agent_settled` 时结算（不在 `agent_end`，
 *   因为其后仍可能重试/压缩/继续）。
 * - **预检取消兜底（SDL 缺口补偿）**：SDK 的 `abort()` 只在运行激活后生效，
 *   预检期（input hook / 认证 / before_agent_start）的取消需宿主自行兜底，
 *   由三件机制协作（详见 `acquireAdmission` / `createInputGuardExtension` /
 *   `onSessionEvent` 的注释）：准入闸门串行化「预检 → 运行确认」段、
 *   输入守卫在 SDK 提交点否决已取消输入、`agent_start` 时中止已取消的运行。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync, statSync } from 'node:fs'
import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  type AgentSession,
  type AgentSessionServices,
  createAgentSessionFromServices,
  ExtensionRunner,
  hasTrustRequiringProjectResources,
  type InlineExtension,
  type LoadExtensionsResult,
  ModelRegistry,
  ProjectTrustStore,
  type ResourceLoader,
  SessionManager,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type {
  HarnessAgentMessage,
  HarnessAnySessionEntry,
  HarnessClient,
  HarnessClientEvent,
  HarnessClientEventBody,
  HarnessCreateThreadInput,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
  HarnessProjectFailureCode,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectTrustInput,
  HarnessRecentProject,
  HarnessSendMessageInput,
  HarnessThinkingLevel,
  HarnessThreadDetails,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceMutationResult,
  HarnessWorkspaceProject,
} from '@huan/protocol'
import { deriveContextUsage } from './context-usage.js'
import { mapSessionEvent } from './event-mapping.js'
import { createHostUiBridge, type HostUiBridge } from './host-ui.js'
import {
  extractMessageText,
  mapColdMetadata,
  mapQueuedMessages,
  mapSessionInfo,
  normalizeTitle,
  type SessionCatalogInfo,
} from './metadata.js'
import {
  createSharedModelRuntime,
  getModelReadiness,
  type HarnessResourceLoaderOptions,
  listModelCatalog,
  refreshModelCatalog,
  resolveDefaultModel,
  toResourceLoaderOptions,
} from './model-catalog.js'
import {
  type ProjectTrustResult,
  type ProjectTrustSource,
  prepareProjectTrust,
} from './project-trust.js'
import {
  createSessionDirResolver,
  defaultSessionsRoot,
  ENV_SESSION_DIR,
  isPathWithinScope,
  type ResolvedSessionDir,
  readSessionDirSetting,
  resolveAgentDir,
} from './session-dir.js'
import { aggregateSessionStats } from './session-stats.js'
import { pathKey, type WorkspaceSnapshot } from './workspace-path.js'
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
import { createWorkspaceToolsExtension } from './workspace-tools.js'

/** 宿主动作选项。 */
export type HarnessHostOptions = {
  /** 默认工作目录（listThreads/createThread 未指定时使用）。 */
  workspacePath: string
  /**
   * Pi 配置目录（用户空间）。
   * 未提供时用 Pi 的 `getAgentDir()`（读取 `PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`）；
   * 宿主创建时解析为绝对路径并固定，auth/models/settings/资源/默认会话均使用它。
   */
  agentDir?: string
  /**
   * 会话存储目录覆盖（对应 CLI 的 `--session-dir`）。
   * 设置后所有 cwd 共享该平铺目录；未设置时按优先级读取
   * `PI_CODING_AGENT_SESSION_DIR` → 启动工作区合并后的 `sessionDir` setting →
   * 默认 `<agentDir>/sessions/<编码 cwd>`。宿主创建时固定。
   */
  sessionDir?: string
  /**
   * 覆盖默认模型（最高优先级；通常由环境变量解析后传入）。
   * 未提供时，新建会话交 SDK 按 settings 解析；冷打开永不传模型。
   */
  model?: HarnessDefaultModel
  /** 启动时是否允许联网刷新模型目录（默认 true）。 */
  refreshCatalogOnStart?: boolean
  /** 目录刷新超时（毫秒；默认 15000；0 表示不设超时）。 */
  catalogRefreshTimeoutMs?: number
  /**
   * 受约束的资源装配选项（测试隔离用）。
   * 只影响 Skills/模板/主题/上下文等发现的开关；宿主输入守卫始终追加，不可替换。
   */
  resourceLoaderOptions?: HarnessResourceLoaderOptions
}

/** 默认模型的宽松形状（SDK Model 的透明转发）。 */
export type HarnessDefaultModel = NonNullable<
  Parameters<typeof createAgentSessionFromServices>[0]['model']
>

/** 宿主：协议客户端 + 生命周期管理。 */
export type HarnessHost = HarnessClient & {
  dispose(): Promise<void>
  /** 启动期诊断（模型目录刷新错误、扩展装配诊断等），供应用呈现。 */
  diagnostics(): readonly string[]
}

/**
 * 项目尚未取得信任决定：拒绝创建/激活会话。
 *
 * HTTP 层据此返回 409 与项目状态，页面先展示信任提示；不能静默按拒绝装配
 *（那会一信任就执行代码却没有任何提示）。
 */
export class ProjectTrustRequiredError extends Error {
  readonly code = 'project-needs-trust'
  constructor(readonly project: HarnessProjectInfo) {
    super(`Project requires a trust decision: ${project.path}`)
    this.name = 'ProjectTrustRequiredError'
  }
}

/** 一次装载的项目信任结果与输入守卫绑定槽（loader 只服务一个 live session）。 */
type PreparedProject = {
  trust: ProjectTrustResult
  guard: { record?: ThreadRecord }
  /**
   * 会话级工作区绑定。
   *
   * loader 在信任查询/启动阶段就可能装配，因此这里用可变槽延迟绑定：
   * 一个 loader 只被一个 live session 消费，消费时写入会话归属；扩展
   * 每次运行开始读取该槽对应的最新工作区定义。查询阶段未绑定时不注入
   * 工作区工具提示。
   */
  workspaceBinding: {
    workspaceId?: string
    /** SDK 实际加载的指令文件（reload 后填充，避免推算）。 */
    loadedInstructionPaths: readonly string[]
    onApplied?: (workspace: WorkspaceSnapshot | null) => void
  }
}

/** 每 cwd 的项目状态缓存与可复用的启动/决定装配。 */
type ProjectRuntime = {
  cwd: string
  info: HarnessProjectInfo
  settingsManager: SettingsManager
  defaultModel: ReturnType<typeof resolveDefaultModel>
  /**
   * 已装配但尚未被会话消费的 loader。
   *
   * 启动引导与信任决定都只需要装配一次；首个会话直接复用它，避免扩展工厂
   * 在同一轮启动里重复执行。一个 loader 只能绑定一个 live session。
   */
  pending?: PreparedProject
}

type ThreadRecord = {
  threadId: string
  session: AgentSession
  /** 会话记录管理器（标题推导需从完整记录语义读取，而非投影后的消息）。 */
  sessionManager: SessionManager
  uiBridge: HostUiBridge
  unsubscribe: () => void
  listeners: Set<(event: HarnessClientEvent) => void>
  seq: number
  turnIndex: number
  /** 固定起始 cwd（不是工作区 ID）。 */
  workspacePath: string
  workspaceId: string | undefined
  /** 本轮实际应用的工作区 revision；未运行或刚改归属时可能缺失。 */
  workspaceAppliedRevision: number | undefined
  workspaceBinding: PreparedProject['workspaceBinding']
  lastError: string | undefined
  /** 该会话的资源加载器（用于 dispose 时补发 session_shutdown）。 */
  resourceLoader: ResourceLoader
  /** 在途发送（含预检阶段），取消/删除需使它们全部失效并等待退出。 */
  inFlight: Set<InFlightSend>
  /** 当前运行的归属与结局候选（agent_start 建立、agent_settled 结算）。 */
  currentRun: CurrentRun | undefined
  /**
   * 启动窗口的准入控制（每会话同时至多一个发送处于预检→运行确认段）。
   * 作用：防止两个发送并发越过 SDK 的预检，后到者的运行收尾提前结算前者。
   */
  admission: RunAdmission | undefined
  /** 等待准入闸门的发送（取消/退休时唤醒，使其重新检查并尽快退出）。 */
  admissionWaiters: Set<() => void>
  /** 已确认「即将启动运行」、尚未被 `agent_start` 消费的发送（归属单槽）。 */
  startingSend: InFlightSend | undefined
  /** 会话是否已进入收尾（删除/销毁）：此后不再启动新运行，等待者放弃。 */
  retired: boolean
  /**
   * 需要清扫「下一无归属运行」：取消时会置位。
   *
   * 背景：SDK 的延迟动作（`_deferredSettledActions`，如扩展的
   * `sendMessage(..., { triggerTurn: true })`）可能在取消之后启动一个
   * 不属于任何宿主发送（owner 为空）的运行；宿主只能凭此标记在
   * `agent_start` 处中止它，否则取消后仍会发出模型请求。
   */
  sweepUnattendedRun: boolean
  /** 缓存的首条用户消息文本（仅存找到的值；历史只追加，找到后不变）。 */
  firstUserMessageText?: string | undefined
}

type InFlightSend = {
  /** 已确认被接受（started/queued/handled）。 */
  accepted: boolean
  /** 已被取消（取消后不得再启动运行）。 */
  cancelled: boolean
  /** 预检完成（无论接受或失败）；用于删除时等待退出。 */
  finished: Promise<void>
  /** 标记预检完成（内部使用）。 */
  markFinished: () => void
}

/**
 * 发送的启动窗口（宿主侧准入控制）。
 *
 * SDK 的 `prompt()` 在「预检通过」与「运行建立」之间可被其他发送交错：
 * 两者都能越过 `isStreaming` 检查，后到者进入 `_runAgentPrompt()` 后会在
 * 其 finally 中发出 `agent_settled`，提前结算前者的运行（已核对源码：
 * `_runAgentPrompt()` 的 finally 无条件 `_emitAgentSettled()`）。
 * 因此宿主把「预检 → 运行确认」段串行化：每会话同时至多一个发送处于
 * 启动窗口，后来者在此等待，避免并发越过预检以及取消后的输入被入队。
 */
type RunAdmission = {
  /** 启动窗口结束（预检结算或发送退出）时 resolve。 */
  done: Promise<void>
  /** 释放启动窗口（幂等）。 */
  release: () => void
}

/**
 * 当前运行的归属与结局候选。
 *
 * 取消判定必须绑定「当前这次运行」，不能扫描整个在途发送集合：
 * 否则已取消的 A 仍停在预检、而 B 真实失败时，B 的失败会被 A 的取消标记吞掉。
 */
type CurrentRun = {
  /** 触发本次运行的发送（若运行由扩展等外部入口触发则为空）。 */
  owner: InFlightSend | undefined
  /** 运行自身是否被取消（由 agent_start 时的中止或 agent_settled.aborted 置位）。 */
  cancelled: boolean
  /** 候选失败信息：agent_end 时记录，agent_settled 时按取消状态裁定。 */
  pendingError: string | undefined
  /** 运行结算完毕（agent_settled 处理完）后 resolve；供取消后的等待者挂起，免轮询。 */
  settled: Promise<void>
  /** 标记结算完毕（内部使用）。 */
  markSettled: () => void
}

/**
 * 当前 prompt 的身份（供输入守卫精确归属，而非按文本猜测）。
 *
 * 为什么不用文本匹配：SDK 的 `emitInput()` 会把前一个 hook 的
 * `transform.text` 传给后续 handler，被改写的文本会让匹配失效；
 * 同一文本的多次发送也无法区分。用 `AsyncLocalStorage` 沿
 * `prompt()` 的调用链传递发送对象，守卫即可直接读当前发送的取消状态。
 */
const sendContext = new AsyncLocalStorage<InFlightSend | undefined>()

/**
 * 宿主输入守卫（合成扩展）：在 SDK 的 input 拦截点否决「已取消 / 已退休」的输入。
 *
 * 为什么需要：SDK 在 input hook 之后才做「流式中 → 入队 / 空闲 → 启动运行」的
 * 分流，预检期间的取消无法回撤已进入该路径的输入（可能泄漏进队列供下次运行
 * 执行，或在退休后仍启动运行）。`input` 事件的 `handled` 是 SDK 自带的「提交前」
 * 否决点；合成扩展排在文件扩展之后，因此能覆盖「其它扩展 hook 期间发生取消」
 * 这一最宽的窗口。
 */
function createInputGuardExtension(getRecord: () => ThreadRecord | undefined): InlineExtension {
  return {
    name: 'huan-input-guard',
    hidden: true,
    factory: (pi) => {
      pi.on('input', () => {
        const record = getRecord()
        const current = sendContext.getStore()
        if (!record) return undefined
        if (record.retired) return { action: 'handled' as const }
        // 属于宿主发送的输入：直接看该发送的取消状态（不依赖文本）。
        if (current?.cancelled === true) return { action: 'handled' as const }
        return undefined
      })
    },
  }
}

type StartingSend = { cancelled: boolean }

/** 会话收尾（删除/销毁）等待在途发送退出的上限：SDK 层无法中断输入 hook。 */
const RETIRE_DRAIN_TIMEOUT_MS = 5_000

/**
 * 会话收尾等待 `session.abort()` 返回的上限。
 *
 * Pi 1.4 的 `abort()` 会 `await waitForIdle()`，而运行可能停在无法中断的扩展
 * hook（`input` / `before_agent_start`）里；此时若无限等待，删除/断开会挂死。
 * 超时后继续收尾（会话即将 dispose/退订，不再有模型请求），与
 * `RETIRE_DRAIN_TIMEOUT_MS` 的已知限制同口径。
 */
const RETIRE_ABORT_TIMEOUT_MS = 5_000

/** 收尾用中止：有上限、不抛错（单会话中止失败不阻断其余清理）。 */
async function abortForRetire(session: AgentSession): Promise<void> {
  await withTimeout(session.abort(), RETIRE_ABORT_TIMEOUT_MS, '会话中止').catch(() => {})
}

/** 默认空间跨分组枚举的并发上限（与 Pi 自身目录发现的保守值一致）。 */
const SCOPE_LIST_CONCURRENCY = 8

/** 按上限并发执行（结果保持输入顺序）。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 丢弃 SDK 在结算窗口内缓冲的延迟动作（`_deferredSettledActions`）。
 *
 * 为什么需要：扩展 `sendMessage(..., { triggerTurn: true })` 在结算窗口
 * （`_isEmittingAgentSettled`）会被压入该数组，稍后由 SDK 直接调
 * `_runAgentPrompt` 启动运行（agent-session.js:1805）——该路径不经输入守卫、
 * 不经 `preflightResult`，取消/退休时必须主动丢弃，否则会在取消后仍发出
 * 模型请求（已由测试证实：不丢弃时 fetch 计数 +1）。
 *
 * 注：SDK 未暴露公开 API；字段缺失时静默跳过（退化为不拦截，仍由
 * `agent_start` 的无归属清扫兜底）。
 */
const discardDeferredRuns = (session: AgentSession): void => {
  const internal = session as unknown as { _deferredSettledActions?: unknown[] }
  if (Array.isArray(internal._deferredSettledActions)) internal._deferredSettledActions.length = 0
}

/** 给承诺加超时（0 或负数表示不设超时）。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!(timeoutMs > 0)) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

  // ---- 装配层：共享 modelRuntime（全宿主一份），其余每会话独立 ----
  const modelRuntime = await createSharedModelRuntime(agentDir)
  const startRefresh = options.refreshCatalogOnStart ?? true
  const refreshTimeoutMs = options.catalogRefreshTimeoutMs ?? 15_000

  const records = new Map<string, ThreadRecord>()
  /** 进行中的冷打开（并发调用共享同一 promise，避免同文件双开）。 */
  const pendingOpens = new Map<
    string,
    { promise: Promise<ThreadRecord>; controller: AbortController }
  >()
  /** 每线程的发送取消令牌（覆盖「冷打开中 → 启动 prompt」窗口）。 */
  const startingSends = new Map<string, Set<StartingSend>>()
  const pendingDeletes = new Map<string, Promise<void>>()
  const recordsBySessionFile = new Map<string, ThreadRecord>()
  /** dispose 后拒绝新操作。 */
  let disposed = false
  /** 代数计数：使 dispose 前发起的异步打开失效。 */
  let generation = 0

  /** 项目状态与可复用装配按规范化 cwd 缓存；live session 仍各自重新装配。 */
  const projectRuntimes = new Map<string, ProjectRuntime>()
  const pendingProjects = new Map<string, Promise<ProjectRuntime>>()
  const trustStore = new ProjectTrustStore(agentDir)

  /** 与 SDK 相同的 realpath 口径；目标不存在时保留绝对路径。 */
  const canonicalProjectPath = (path: string): string => {
    const absolute = resolve(path)
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }

  const projectNameOf = (path: string): string => basename(path) || path

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
    projects: workspace.projects.map(
      (project): HarnessWorkspaceProject => ({
        alias: project.alias,
        path: project.path,
        available: isAvailableDirectory(project.path),
      }),
    ),
  })

  /** 扩展运行边界读取的权威快照：每次都从已提交的内存状态生成。 */
  const workspaceSnapshotOf = (workspaceId: string): WorkspaceSnapshot | null => {
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
          name: projectNameOf(startupPath),
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

  /** 工作区定义变更后，让已订阅该工作区的窗口立即读到最新的待生效 revision。 */
  const emitWorkspaceSnapshots = (workspaceId: string): void => {
    for (const record of records.values()) {
      if (record.workspaceId !== workspaceId) continue
      emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    }
  }

  /** 路径校验只做文件系统检查，不执行任何项目代码。 */
  const inspectProjectPath = async (input: string): Promise<HarnessProjectPathCheck> => {
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

  const failedProjectInfo = (
    path: string,
    code: HarnessProjectFailureCode,
  ): HarnessProjectInfo => ({
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
  })

  /** 把核心信任结果投影为 JSON-safe 项目摘要（不传扩展错误原文）。 */
  const projectInfoOf = (prepared: { trust: ProjectTrustResult }): HarnessProjectInfo => {
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

  /** 把扩展装配期登记的项目 provider/虚拟模型写入共享 modelRuntime。 */
  const registerPreparedProviders = (extensions: LoadExtensionsResult): void => {
    const runtime = extensions.runtime
    for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
      try {
        modelRuntime.registerProvider(name, config)
      } catch (error) {
        diagnostics.push(`扩展 provider（${extensionPath}）：${String(error)}`)
        safeDiagnostics.add('assembly-warning')
      }
    }
    runtime.pendingProviderRegistrations = []
    for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
      try {
        modelRuntime.registerNativeProvider(provider)
      } catch (error) {
        diagnostics.push(`原生 provider（${extensionPath}）：${String(error)}`)
        safeDiagnostics.add('assembly-warning')
      }
    }
    runtime.pendingNativeProviderRegistrations = []
    for (const { definition, extensionPath } of runtime.pendingVirtualModelRegistrations) {
      try {
        modelRuntime.registerVirtualModel(definition)
      } catch (error) {
        diagnostics.push(`虚拟模型（${extensionPath}）：${String(error)}`)
        safeDiagnostics.add('assembly-warning')
      }
    }
    runtime.pendingVirtualModelRegistrations = []
  }

  /**
   * 经统一信任入口准备一份会话装配。
   *
   * 只在这里创建 loader：上一版 `prepareProjectTrust` + `createHostServices`
   * 会把扩展工厂执行两次，且第二次装配没有信任回调。
   */
  const prepareProjectSession = async (
    cwd: string,
    override?: boolean,
  ): Promise<PreparedProject> => {
    const guard: { record?: ThreadRecord } = {}
    const workspaceBinding: PreparedProject['workspaceBinding'] = {
      loadedInstructionPaths: [],
    }
    const trust = await prepareProjectTrust({
      cwd,
      agentDir,
      ...(override !== undefined ? { override } : {}),
      trustStore,
      resourceLoaderOptions: {
        ...toResourceLoaderOptions(resourceLoaderOptions),
        extensionFactories: [
          createInputGuardExtension(() => guard.record),
          // 工作区扩展按会话实例装配。loader 若先用于查询，绑定槽为空；
          // 被某个 live session 消费时才写入归属，不会按 cwd 复用给另一个工作区。
          createWorkspaceToolsExtension({
            getWorkspace: () =>
              workspaceBinding.workspaceId
                ? workspaceSnapshotOf(workspaceBinding.workspaceId)
                : null,
            getLoadedInstructionPaths: () => workspaceBinding.loadedInstructionPaths,
            onWorkspaceApplied: (workspace) => workspaceBinding.onApplied?.(workspace),
          }),
        ],
      },
    })
    for (const message of [...trust.loadErrors, ...trust.state.extensionErrors]) {
      diagnostics.push(`扩展装配（${trust.state.cwd}）：${message}`)
      safeDiagnostics.add('assembly-warning')
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
      diagnostics.push(`扩展装配（${trust.state.cwd}）：${message}`)
      safeDiagnostics.add('assembly-warning')
      throw new Error(message)
    }
    registerPreparedProviders(extensions)
    // 与 SDK 服务装配一致：注册完 provider 后物化本地目录，不触发联网。
    await modelRuntime.refresh({ allowNetwork: false })
    workspaceBinding.loadedInstructionPaths = trust.resourceLoader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.path)
    return { trust, guard, workspaceBinding }
  }

  /** 由一次装配结果建立/替换项目缓存。旧 loader 未被消费时直接丢弃。 */
  const projectRuntimeFrom = (
    prepared: PreparedProject,
    originOverride?: ProjectTrustSource,
  ): ProjectRuntime => {
    const info = projectInfoOf(prepared)
    const runtime: ProjectRuntime = {
      cwd: info.path,
      info: originOverride ? { ...info, trust: { ...info.trust, origin: originOverride } } : info,
      settingsManager: prepared.trust.settingsManager,
      defaultModel: resolveDefaultModel({
        modelRuntime,
        cwd: info.path,
        agentDir,
        ...(options.model ? { model: options.model } : {}),
        settingsManager: prepared.trust.settingsManager,
      }),
      pending: prepared,
    }
    projectRuntimes.set(runtime.cwd, runtime)
    return runtime
  }

  /** 装载一个新的项目装配并缓存状态（可能停在 needs-trust）。 */
  const loadProjectRuntime = (cwd: string): Promise<ProjectRuntime> => {
    const existing = pendingProjects.get(cwd)
    if (existing) return existing
    const pending = prepareProjectSession(cwd)
      .then(projectRuntimeFrom)
      .finally(() => {
        pendingProjects.delete(cwd)
      })
    pendingProjects.set(cwd, pending)
    return pending
  }

  /** 查询项目：优先缓存；项目资源集合变化时重新评估，不用过期结论。 */
  const queryProject = async (input: string): Promise<HarnessProjectInfo> => {
    const check = await inspectProjectPath(input)
    if (check.error) return failedProjectInfo(check.path || input, check.error.code)
    const cached = projectRuntimes.get(check.path)
    if (cached && cached.info.status !== 'failed') {
      const requiresTrust = hasTrustRequiringProjectResources(check.path)
      if (requiresTrust === cached.info.trust.requiresTrust) return cached.info
    }
    try {
      return (await loadProjectRuntime(check.path)).info
    } catch (error) {
      diagnostics.push(`项目装配（${check.path}）：${String(error)}`)
      safeDiagnostics.add('assembly-warning')
      return failedProjectInfo(check.path, 'load-failed')
    }
  }

  /**
   * 只读信任摘要：用于工作区成员管理展示，不加载项目扩展或资源。
   *
   * 该路径只读取 trust.json、全局默认策略与项目资源存在性；用户级
   * project_trust 扩展的实际决定仍会在真正装配/新建会话时执行。
   */
  const inspectProjectTrust = async (input: string): Promise<HarnessProjectInfo> => {
    const check = await inspectProjectPath(input)
    if (check.error) return failedProjectInfo(check.path || input, check.error.code)
    try {
      const trust = await prepareProjectTrust({
        cwd: check.path,
        agentDir,
        trustStore,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      })
      return projectInfoOf({ trust })
    } catch (error) {
      diagnostics.push(`项目信任摘要（${check.path}）：${String(error)}`)
      return failedProjectInfo(check.path, 'load-failed')
    }
  }

  /** 会话装配：复用未消费的启动/决定 loader，否则按已知结论重新装配。 */
  const acquireProjectSession = async (
    input: string,
  ): Promise<{ runtime: ProjectRuntime; prepared: PreparedProject }> => {
    const check = await inspectProjectPath(input)
    if (check.error) {
      throw new Error(`项目路径不可用：${check.error.code}`)
    }
    const takePending = (runtime: ProjectRuntime): PreparedProject | undefined => {
      const prepared = runtime.pending
      runtime.pending = undefined
      return prepared
    }
    let runtime = projectRuntimes.get(check.path)
    if (runtime?.info.status === 'needs-trust') {
      throw new ProjectTrustRequiredError(runtime.info)
    }
    if (runtime?.info.status === 'failed') {
      // 上次装配失败：本次会话重新尝试，不复用失败结论。
      runtime.pending = undefined
      runtime = await loadProjectRuntime(check.path)
      if (runtime.info.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(runtime.info)
      }
    } else if (runtime) {
      // 项目资源集合变化：旧结论与旧 loader 都不能再用。
      const requiresTrust = hasTrustRequiringProjectResources(check.path)
      if (requiresTrust !== runtime.info.trust.requiresTrust) {
        runtime.pending = undefined
        runtime = await loadProjectRuntime(check.path)
        if (runtime.info.status === 'needs-trust') {
          throw new ProjectTrustRequiredError(runtime.info)
        }
      }
    } else {
      runtime = await loadProjectRuntime(check.path)
      if (runtime.info.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(runtime.info)
      }
    }

    const pending = takePending(runtime)
    if (pending) return { runtime, prepared: pending }

    // 缓存中的结论仍然有效：按同一结论重新装配，不再次询问用户。
    const prepared = await prepareProjectSession(
      runtime.cwd,
      runtime.info.trust.decision === 'trusted',
    )
    runtime.settingsManager = prepared.trust.settingsManager
    runtime.defaultModel = resolveDefaultModel({
      modelRuntime,
      cwd: runtime.cwd,
      agentDir,
      ...(options.model ? { model: options.model } : {}),
      settingsManager: prepared.trust.settingsManager,
    })
    return { runtime, prepared }
  }

  /** 保存决定后立即装配；保留本次显式来源与保存路径供页面展示。 */
  const decideProject = async (input: HarnessProjectTrustInput): Promise<HarnessProjectInfo> => {
    const check = await inspectProjectPath(input.path)
    if (check.error) return failedProjectInfo(check.path || input.path, check.error.code)
    if (input.remember === true) trustStore.set(check.path, input.trusted)
    try {
      const prepared = await prepareProjectSession(check.path, input.trusted)
      const runtime = projectRuntimeFrom(prepared, 'explicit')
      if (input.remember === true) {
        runtime.info = {
          ...runtime.info,
          trust: { ...runtime.info.trust, savedPath: check.path },
        }
      }
      if (input.trusted && startRefresh) await refreshCatalog()
      return runtime.info
    } catch (error) {
      diagnostics.push(`信任决定（${check.path}）：${String(error)}`)
      safeDiagnostics.add('assembly-warning')
      return failedProjectInfo(check.path, 'load-failed')
    }
  }

  /** 最近项目：同一 agentDir 的会话 header + 缓存过的项目；按活动时间排序。 */
  const listRecentProjects = async (): Promise<HarnessRecentProject[]> => {
    const projects = new Map<string, { lastActiveAt?: string }>()
    for (const info of await listScopeInfos()) {
      if (!info.cwd) continue
      const path = canonicalProjectPath(info.cwd)
      const time = info.modified.toISOString()
      const existing = projects.get(path)
      if (!existing?.lastActiveAt || time > existing.lastActiveAt) {
        projects.set(path, { lastActiveAt: time })
      }
    }
    for (const runtime of projectRuntimes.values()) {
      if (!projects.has(runtime.cwd)) projects.set(runtime.cwd, {})
    }
    const startup = canonicalProjectPath(workspacePath)
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

  /** 受控目录刷新：失败只记诊断，不阻断启动或信任决定。 */
  const refreshCatalog = async (): Promise<void> => {
    try {
      // 联网刷新可能因扩展 provider 的远程拉取而长期挂起；超时后放弃等待。
      await withTimeout(
        refreshModelCatalog(modelRuntime, { allowNetwork: true }),
        refreshTimeoutMs,
        '模型目录刷新',
      ).then(
        ({ errors }) => {
          diagnostics.push(...errors.map((message) => `模型目录刷新：${message}`))
          if (errors.length) safeDiagnostics.add('catalog-refresh-failed')
        },
        (error: unknown) => {
          diagnostics.push(`模型目录刷新失败：${String(error)}`)
          safeDiagnostics.add('catalog-refresh-failed')
        },
      )
    } catch (error) {
      diagnostics.push(`模型目录刷新失败：${String(error)}`)
      safeDiagnostics.add('catalog-refresh-failed')
    }
  }

  // 启动引导：先准备启动项目（未知信任时只装配用户资源），再注册 provider。
  // 该 loader 留给首个会话复用；needs-trust 时跳过联网目录刷新。
  let startupRuntime: ProjectRuntime | undefined
  try {
    startupRuntime = await loadProjectRuntime(workspacePath)
  } catch (error) {
    diagnostics.push(`启动项目装配（${workspacePath}）：${String(error)}`)
    safeDiagnostics.add('assembly-warning')
  }
  if (startRefresh && startupRuntime?.info.status !== 'needs-trust') {
    await refreshCatalog()
  }
  const resolvedDefault =
    startupRuntime?.defaultModel ??
    resolveDefaultModel({
      modelRuntime,
      cwd: workspacePath,
      agentDir,
      ...(options.model ? { model: options.model } : {}),
    })

  /** 整个存储作用域（默认空间或平铺覆盖）的跨 cwd 列表缓存，按作用域目录区分。 */
  const scopeCatalogCache = new Map<
    string,
    { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> }
  >()

  const assertActive = () => {
    if (disposed) throw new Error('Harness host has been disposed')
  }

  /** 作用域目录：记录本身的 cwd（空值回退启动工作区）。 */
  const scopeOf = (cwd: string | undefined): ResolvedSessionDir =>
    resolveSessionDirFor(cwd?.trim() ? cwd : workspacePath)

  /** 作用域根：默认空间为 `<agentDir>/sessions`（可跨分组），平铺覆盖为其自身。 */
  const scopeRootOf = (scope: ResolvedSessionDir): string =>
    scope.grouped ? defaultSessionsRoot(agentDir) : scope.dir

  /**
   * 存储作用域校验：仅接受当前空间内的会话文件。
   * 作用域外的路径（包括指向外部的符号链接）一律拒绝，用于打开/改名/删除。
   */
  const assertSessionFileInScope = (
    filePath: string,
    cwd: string | undefined,
  ): ResolvedSessionDir => {
    const scope = scopeOf(cwd)
    if (!isPathWithinScope(scopeRootOf(scope), filePath)) {
      throw new Error(`会话文件不在当前存储作用域内：${filePath}`)
    }
    return scope
  }

  /**
   * 默认空间的跨 cwd 枚举：只扫描当前 agentDir 下 sessions 的直接分组目录。
   *
   * 不用无参 `SessionManager.listAll()`（它读进程默认用户空间，会泄漏到另一个
   * agentDir）；也不用递归扫描。路径符号链接的分组目录不作为隐式入口（避免
   * 默认空间变成任意外部目录的入口）。
   */
  const listGroupedScopeInfos = async (): Promise<SessionCatalogInfo[]> => {
    const sessionsRoot = defaultSessionsRoot(agentDir)
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

  /**
   * 存储作用域内的全部会话（跨 cwd）。
   *
   * 默认空间：枚举 `<agentDir>/sessions/` 的直接分组目录，逐个经公开列表方法读取；
   * 显式平铺目录：`SessionManager.listAll(explicitDir)`。不把平铺目录当默认根递归扫描。
   */
  const listScopeInfos = async (): Promise<SessionCatalogInfo[]> => {
    const scope = scopeOf(workspacePath)
    const key = scopeRootOf(scope)
    const existing = scopeCatalogCache.get(key)
    if (existing?.infos) return existing.infos
    if (existing?.promise) return existing.promise
    const entry: { infos?: SessionCatalogInfo[]; promise?: Promise<SessionCatalogInfo[]> } = {}
    const promise = (async () => {
      const infos = scope.grouped
        ? await listGroupedScopeInfos()
        : ((await SessionManager.listAll(scope.dir)) as unknown as SessionCatalogInfo[])
      // 只在本次扫描仍是当前缓存条目时写回：显式刷新可能已用新条目替换它，
      // 旧 promise 不得覆盖新结果，也不能删掉新条目。
      if (scopeCatalogCache.get(key) !== entry) return infos
      // 空结果不缓存（同上：会话可能在创建后落盘）。
      if (infos.length === 0) scopeCatalogCache.delete(key)
      else entry.infos = infos
      return infos
    })().finally(() => {
      entry.promise = undefined
    })
    entry.promise = promise
    scopeCatalogCache.set(key, entry)
    return promise
  }

  const invalidateCatalog = (_cwd: string = workspacePath) => {
    // 列表已统一走跨 cwd 作用域缓存；任何会话文件变化都清整份缓存，
    // 避免删除/更名/首条消息落盘后仍读到旧值。
    scopeCatalogCache.clear()
  }

  /**
   * 在给定列表里按 ID 定位会话；同一 ID 对应多个文件时报歧义（不静默选一个）。
   */
  const pickSessionInfo = (
    infos: readonly SessionCatalogInfo[],
    threadId: string,
  ): SessionCatalogInfo | undefined => {
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

  const findSessionInfo = async (threadId: string): Promise<SessionCatalogInfo | undefined> => {
    // 统一经作用域缓存（默认空间跨分组 / 平铺覆盖）定位，不先做「本地命中即返回」：
    // 本地列表只是作用域的子集，直接返回会让「同一 ID 存在于另一个 cwd 分组」
    // 的重复 ID 被静默选中，违背作用域内重复 ID 必须报歧义的约定。
    // 缓存命中时这里是纯内存 O(n) 过滤，不逐次重扫目录。
    return pickSessionInfo(await listScopeInfos(), threadId)
  }

  // ---- 状态推导（热/冷共用口径） ----
  const runStatus = (record: ThreadRecord): HarnessThreadMetadata['status'] => {
    const session = record.session
    if (session.isStreaming || session.isCompacting || session.isRetrying) return 'running'
    return record.lastError ? 'failed' : 'idle'
  }

  /** 工作区相关元数据；归属按会话元数据定位，绝不按 cwd 推断。 */
  const workspaceFields = (
    workspaceId: string | undefined,
    appliedRevision?: number,
  ): Pick<
    HarnessThreadMetadata,
    'workspaceId' | 'workspaceRevision' | 'workspaceAppliedRevision'
  > => {
    if (!workspaceId) return {}
    const workspace = workspaceStore.workspace(workspaceId)
    if (!workspace) return {}
    return {
      workspaceId,
      workspaceRevision: workspace.revision,
      ...(appliedRevision !== undefined ? { workspaceAppliedRevision: appliedRevision } : {}),
    }
  }

  const sessionWorkspaceFields = (
    threadId: string,
    appliedRevision?: number,
  ): ReturnType<typeof workspaceFields> =>
    workspaceFields(workspaceStore.sessionWorkspace(storeId, threadId), appliedRevision)

  const metadataOf = (record: ThreadRecord): HarnessThreadMetadata => {
    const session = record.session
    const model = session.model
    const usage = session.getContextUsage()
    const queued = mapQueuedMessages(session.getSteeringMessages(), session.getFollowUpMessages())
    const title = deriveLiveTitle(record)
    const explicitName = session.sessionName?.trim()
    const firstMessageText = firstUserMessageTextOf(record)
    return {
      id: record.threadId,
      status: runStatus(record),
      compactionActive: session.isCompacting,
      retryActive: session.isRetrying,
      retryAttempt: session.retryAttempt,
      workspacePath: record.workspacePath,
      ...workspaceFields(record.workspaceId, record.workspaceAppliedRevision),
      messageCount: session.messages.length,
      // 标题口径与冷读路径一致：显式会话名 > 首条用户消息（截断）> 会话文件名。
      // 注意：仅「显式命名」会持久化；未命名会话重启后由冷路径推导同一标题。
      ...(title ? { title } : {}),
      // 命名状态与首条消息独立暴露：与冷读路径同为全文件口径。
      ...(explicitName ? { name: explicitName } : {}),
      ...(firstMessageText ? { firstMessageText } : {}),
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      ...(model
        ? {
            config: {
              provider: model.provider,
              modelId: model.id,
              thinkingLevel: session.thinkingLevel,
            },
          }
        : { config: { thinkingLevel: session.thinkingLevel } }),
      ...(usage ? { contextUsage: usage } : {}),
      ...(workspaceStore.sessionArchived(storeId, record.threadId) ? { archived: true } : {}),
      ...(queued.length ? { queuedMessages: queued } : {}),
    }
  }

  /**
   * 热会话标题：显式会话名 > 首条用户消息（截断 60）> 会话文件名。
   *
   * 关键：首条用户消息必须从**会话记录（全文件）**读取，而不是：
   * - `session.messages`：压缩感知的投影，压缩后原始首条消息会被省略；
   * - `getBranch()`：仅当前分支，而 Pi 冷目录扫全文件取首条（分支场景会不一致）。
   * 缓存「首条消息文本」而非最终标题：改名/清空名称不影响它，无需失效。
   */
  const deriveLiveTitle = (record: ThreadRecord): string | undefined => {
    const explicit = record.session.sessionName?.trim()
    if (explicit) return explicit
    const firstText = firstUserMessageTextOf(record)
    return normalizeTitle({
      firstMessageText: firstText,
      sessionFilePath: record.session.sessionFile,
    })
  }

  /** 从会话记录（全文件顺序）取首条用户消息文本（带缓存；仅缓存找到的值）。 */
  const firstUserMessageTextOf = (record: ThreadRecord): string | undefined => {
    if (record.firstUserMessageText !== undefined) return record.firstUserMessageText
    for (const entry of record.sessionManager.getEntries()) {
      if (entry.type !== 'message') continue
      const message = (entry as { message?: { role?: string } }).message
      if (message?.role !== 'user') continue
      const text = extractMessageText(message)
      if (text) {
        record.firstUserMessageText = text
        return text
      }
    }
    return undefined
  }

  /**
   * 快照的消息隔离：数组与消息对象都复制。
   *
   * 两个真实的可变源（均已核对 SDK 源码）：
   * 1. `session.messages` 是 agent-core 的活跃数组，后续轮次会直接 push；
   * 2. 扩展在 `message_end` hook 中返回替换消息时，SDK 用
   *    `_replaceMessageInPlace()` **原地改写**已有消息对象（delete + assign），
   *    因此仅复制数组仍不够——已交付给订阅者的消息对象会随后变化。
   *
   * 浅复制单个消息足以覆盖上述两个路径：SDK 内建路径的原地改写只作用于
   * 消息对象的顶层键（替换 `content` 是替换引用，旧快照保留的原引用不受影响）。
   * 注意这是**边界而非全量保证**：扩展若自行修改已有 content 内部结构，
   * 或调用方改动返回值，共享对象仍可能变化。
   */
  const isolateMessages = (messages: readonly unknown[]): HarnessAgentMessage[] =>
    messages.map((message) => ({ ...(message as object) })) as HarnessAgentMessage[]

  const snapshotOf = (record: ThreadRecord): HarnessThreadSnapshot => {
    const pending = record.uiBridge.pending()
    return {
      metadata: metadataOf(record),
      messages: isolateMessages(record.session.messages),
      readiness: getModelReadiness(
        modelRuntime,
        record.session.model
          ? {
              provider: record.session.model.provider,
              modelId: record.session.model.id,
            }
          : undefined,
        'session',
      ),
      seq: record.seq,
      ...(pending.length ? { hostUiRequests: pending } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
    }
  }

  // ---- 事件投递 ----
  const emit = (record: ThreadRecord, body: HarnessClientEventBody) => {
    record.seq += 1
    const event = { ...body, threadId: record.threadId, seq: record.seq } as HarnessClientEvent
    for (const listener of [...record.listeners]) {
      try {
        listener(event)
      } catch {
        // 单个订阅者抛错不影响其他订阅者。
      }
    }
  }

  const emitContextUsage = (record: ThreadRecord) => {
    const usage = record.session.getContextUsage()
    if (usage) emit(record, { type: 'context_usage', contextUsage: usage })
  }

  function onSessionEvent(
    record: ThreadRecord,
    event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0],
  ): void {
    if (event.type === 'turn_start') record.turnIndex += 1
    if (event.type === 'session_info_changed') invalidateCatalog(record.workspacePath)
    // 新会话的 JSONL 直到首条用户消息才真正落盘；空会话创建后列表缓存可能
    // 仍是旧结果。首条用户消息开始时清一次目录缓存，让后续列表看到文件与标题。
    if (event.type === 'message_start' && event.message.role === 'user') {
      invalidateCatalog(record.workspacePath)
    }

    // 运行激活（activeRun 已建立、模型请求尚未发出）时处理预检期取消。
    // 用 agent_start 而非微任务：这是 SDK 语义内的最早稳定时点，
    // 不依赖「preflightResult 回调与运行启动在同一同步块」这类实现细节。
    if (event.type === 'agent_start') {
      if (record.currentRun === undefined) {
        // 一个运行周期开始：消费归属槽。准入闸门保证「预检 → 运行确认」段
        // 每会话串行，因此槽内至多一个发送，且必然属于本次运行。
        const owner = record.startingSend
        record.startingSend = undefined
        let markSettled: () => void = () => {}
        const settled = new Promise<void>((resolve) => {
          markSettled = resolve
        })
        record.currentRun = {
          owner,
          cancelled: owner?.cancelled ?? false,
          pendingError: undefined,
          settled,
          markSettled,
        }
      }
      const run = record.currentRun
      // 中止条件：
      // 1) 归属发送已取消 / 运行自身已取消（常规取消路径）；
      // 2) 会话已退休（延迟动作可能在收尾后启动运行）；
      // 3) 无归属运行 + 清扫标记（SDK 延迟动作在取消后启动的运行）。
      const unattended = run.owner === undefined && !record.retired
      const sweep = unattended && record.sweepUnattendedRun
      if (run.owner?.cancelled || run.cancelled || record.retired || sweep) {
        run.cancelled = true
        record.sweepUnattendedRun = false
        // 同步发起中止（内部置标志并 abort controller），不 await：
        // agent 会等待监听器返回，await 会与 waitForIdle 互锁。
        record.session.abort().catch(() => {})
      } else if (run.owner !== undefined) {
        // 新一轮用户发起的运行：上一次取消的影响到此为止。
        record.sweepUnattendedRun = false
      }
    }

    if (event.type === 'agent_end') {
      // 只记录候选错误，不在此时裁定：agent_end 后 SDK 仍可能重试/压缩/继续。
      // 无条件赋值：「重试成功」的轮次会把候选错误清回 undefined。
      const run = record.currentRun
      if (run) run.pendingError = record.session.state.errorMessage ?? undefined
    }

    // 运行级权威取消标志（SDK 直接取自 _agentRunAbortRequested），不受
    // 消息 stopReason 分类影响（lazyStream 的 setup 失败会把取消写死为 'error'）。
    // 先落地内部状态，再发布事件：同步订阅者在 settled 上必须读到结算后的状态。
    let settledError: string | undefined
    if (event.type === 'agent_settled') {
      const run = record.currentRun
      if (run) {
        if (event.aborted) run.cancelled = true
        if (!run.cancelled) {
          if (run.pendingError !== undefined) {
            record.lastError = run.pendingError
            settledError = run.pendingError
          } else if (record.lastError !== undefined) {
            // 本轮成功结束：清除此前残留的失败状态（失败不在轮次间存留）。
            record.lastError = undefined
          }
        }
        // 取消：保持既有 lastError 不变（取消不消灭此前失败的记录）。
      }
      record.currentRun = undefined
      run?.markSettled()
    }

    const mapped = mapSessionEvent(event, { turnIndex: record.turnIndex })
    if (mapped.kind === 'mapped') emit(record, mapped.event)
    if (settledError !== undefined) emit(record, { type: 'error', error: settledError })

    if (
      event.type === 'turn_end' ||
      event.type === 'agent_end' ||
      event.type === 'compaction_end'
    ) {
      emitContextUsage(record)
    }
  }

  // ---- 会话打开 ----
  const openSession = async (
    sessionManager: SessionManager,
    cwd: string,
    opts: {
      isNew: boolean
      signal?: AbortSignal
      /** 新会话的显式模型（优先于目标项目的默认模型）。 */
      model?: HarnessDefaultModel
      /** 新会话的 Thinking 级别（在模型应用后设置）。 */
      thinkingLevel?: HarnessThinkingLevel
      /** 已获取的项目装配（createThread 在检查默认模型前已取得）。 */
      project?: { runtime: ProjectRuntime; prepared: PreparedProject }
      /** 会话显式归属的工作区；未归属时为空。 */
      workspaceId?: string
    },
  ): Promise<ThreadRecord> => {
    const openedGeneration = generation
    throwIfOpenCancelled(opts.signal, openedGeneration)

    // 同一份 loader 直接交给会话：不再经 createHostServices 重装扩展，
    // 避免扩展工厂在一次会话装配中执行两次（第二次也没有信任回调）。
    // 输入守卫在 prepareProjectSession 中已作为合成扩展追加。
    const project = opts.project ?? (await acquireProjectSession(cwd))
    const prepared = project.prepared
    const projectCwd = project.runtime.cwd
    // loader 只能服务一个 live session；这里写入本次会话的工作区归属。
    prepared.workspaceBinding.workspaceId = opts.workspaceId
    const services: AgentSessionServices = {
      cwd: projectCwd,
      agentDir,
      modelRuntime,
      settingsManager: prepared.trust.settingsManager,
      resourceLoader: prepared.trust.resourceLoader,
      diagnostics: [],
    }
    throwIfOpenCancelled(opts.signal, openedGeneration)

    // 新会话：显式模型 > 目标项目默认模型；冷打开不传，由 SDK 从会话记录恢复。
    const newSessionModel = opts.model ?? project.runtime.defaultModel.model
    const { session, modelFallbackMessage } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(opts.isNew && newSessionModel ? { model: newSessionModel } : {}),
    })
    // SDK 在恢复失败时会回退到其他模型；该原因必须可见（不静默）。
    if (modelFallbackMessage) {
      diagnostics.push(`模型回退（${projectCwd}）：${modelFallbackMessage}`)
      safeDiagnostics.add('model-fallback')
    }

    if (openWasCancelled(opts.signal, openedGeneration)) {
      session.dispose()
      throwOpenCancelled()
    }

    // Thinking 级别在模型应用之后设置（SDK 的 setModel 自身会调整级别）。
    if (opts.isNew && opts.thinkingLevel) {
      try {
        await session.setThinkingLevel(opts.thinkingLevel)
      } catch (error) {
        diagnostics.push(`Thinking 级别设置（${projectCwd}）：${String(error)}`)
      }
      throwIfOpenCancelled(opts.signal, openedGeneration)
    }

    const threadId = session.sessionId
    const record: ThreadRecord = {
      threadId,
      session,
      sessionManager,
      uiBridge: undefined as unknown as HostUiBridge,
      unsubscribe: () => {},
      listeners: new Set(),
      seq: 0,
      turnIndex: -1,
      workspacePath: projectCwd,
      workspaceId: opts.workspaceId,
      workspaceAppliedRevision: opts.workspaceId
        ? workspaceStore.workspace(opts.workspaceId)?.revision
        : undefined,
      workspaceBinding: prepared.workspaceBinding,
      lastError: undefined,
      resourceLoader: prepared.trust.resourceLoader,
      inFlight: new Set(),
      currentRun: undefined,
      admission: undefined,
      admissionWaiters: new Set(),
      startingSend: undefined,
      retired: false,
      sweepUnattendedRun: false,
    }

    const uiBridge = createHostUiBridge({
      nextRequestId: () => `${threadId}:ui:${record.seq}:${Math.random().toString(36).slice(2, 8)}`,
      currentToolCallId: () => {
        const pending = session.state.pendingToolCalls
        return pending.size === 1 ? [...pending][0] : undefined
      },
      emitRequest: (request: HarnessHostUiRequest) => {
        emit(record, { type: 'extension_ui_request', request })
      },
      emitResolved: (requestId: string) => {
        emit(record, { type: 'extension_ui_resolved', requestId })
      },
      onNotify: (message, type) => {
        // 装配期的自动忽略等提示：记入诊断（无订阅者时也能被应用看到）。
        if (type !== 'info') diagnostics.push(`Host UI（${cwd}）：${message}`)
      },
    })
    record.uiBridge = uiBridge
    // 运行边界回调：before_agent_start 固定本轮 revision，供页面显示实际生效版本。
    prepared.workspaceBinding.onApplied = (workspace) => {
      if (record.workspaceAppliedRevision === workspace?.revision) return
      record.workspaceAppliedRevision = workspace?.revision
      emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    }

    // 装配期：session_start handler 发起的阻断请求立即结算（record 尚未发布）。
    uiBridge.setStartup(true)

    try {
      await session.bindExtensions({
        uiContext: uiBridge.ui,
        onError: (error) => {
          record.lastError = error.error
          emit(record, { type: 'error', error: error.error })
        },
      })
    } catch (error) {
      uiBridge.dismissAll()
      session.dispose()
      throw error
    }

    if (openWasCancelled(opts.signal, openedGeneration)) {
      uiBridge.dismissAll()
      session.dispose()
      throwOpenCancelled()
    }

    try {
      record.unsubscribe = session.subscribe((event) => onSessionEvent(record, event))
      // agent 级兜底订阅（直连 `session.agent`，**刻意不提供退订**）：
      // 它不受 `session.dispose()` 清理影响（那只断开 agent→session 的转发）。
      // 必要性：SDK 在 `_emitAgentSettled()` 里先 `splice(0)` 把延迟动作取入
      // **局部数组**再逐个 `await`；若退休发生在「第一个动作运行中」，后续
      // 动作就留在这个局部数组里，成员数组清空够不到——只有本订阅能在它们
      // 启动（`agent_start`）时中止（探针实证：不保留则多发出 1 次请求）。
      // 局部批次链的结束没有可靠信号，故永久保留；record 最终成为只被该
      // 闭包引用的孤立环，随会话一起被 GC 回收。
      session.agent.subscribe((event) => {
        if (event.type !== 'agent_start') return
        if (record.retired) {
          // 退休后仍启动的运行：立即中止（不 await，避免与 agent 的监听等待互锁）。
          session.agent.abort()
          return
        }
        // 取消后由延迟动作启动的无归属运行：按清扫标记中止。
        const run = record.currentRun
        if (run && run.owner === undefined && record.sweepUnattendedRun) {
          run.cancelled = true
          record.sweepUnattendedRun = false
          session.agent.abort()
        }
      })
    } catch (error) {
      try {
        uiBridge.dismissAll()
      } catch {
        // 清理失败不掩盖原始错误。
      }
      try {
        session.dispose()
      } catch {
        // 同上。
      }
      throw error
    }

    records.set(threadId, record)
    if (session.sessionFile) recordsBySessionFile.set(session.sessionFile, record)
    // record 已发布：绑定守卫的目标会话，后续阻断请求输送到订阅者。
    prepared.guard.record = record
    uiBridge.setStartup(false)
    return record
  }

  const openWasCancelled = (signal: AbortSignal | undefined, openedGeneration: number) =>
    signal?.aborted === true || openedGeneration !== generation

  const throwIfOpenCancelled = (signal: AbortSignal | undefined, openedGeneration = generation) => {
    if (openWasCancelled(signal, openedGeneration)) throwOpenCancelled()
  }

  const throwOpenCancelled = () => {
    throw new Error('Harness session open was cancelled')
  }

  const ensureOpen = async (threadId: string): Promise<ThreadRecord> => {
    assertActive()
    if (!workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
        workspaceStore.stateFile,
      )
    }
    if (pendingDeletes.has(threadId)) throwOpenCancelled()
    const existing = records.get(threadId)
    if (existing) return existing
    const pending = pendingOpens.get(threadId)
    if (pending) return pending.promise

    const controller = new AbortController()
    const open = openCold(threadId, controller.signal).finally(() => {
      if (pendingOpens.get(threadId)?.promise === open) pendingOpens.delete(threadId)
    })
    pendingOpens.set(threadId, { promise: open, controller })
    return open
  }

  const openCold = async (threadId: string, signal: AbortSignal): Promise<ThreadRecord> => {
    const info = await findSessionInfo(threadId)
    throwIfOpenCancelled(signal)
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    const existingBySessionFile = recordsBySessionFile.get(info.path)
    if (existingBySessionFile) {
      records.set(threadId, existingBySessionFile)
      return existingBySessionFile
    }
    // 打开也使用同一存储规则：会话文件必须属于当前作用域（含符号链接真实路径）。
    const scope = assertSessionFileInScope(info.path, info.cwd)
    const sessionManager = SessionManager.open(info.path, scope.dir)
    // 归属只在 huan 元数据中查找；没有记录的旧会话保持未归属，不按 cwd 猜测。
    const workspaceId = workspaceStore.sessionWorkspace(storeId, info.id)
    return openSession(sessionManager, info.cwd || workspacePath, {
      isNew: false,
      signal,
      ...(workspaceId ? { workspaceId } : {}),
    })
  }

  // ---- 发送 ----

  /** 唤醒所有等待准入闸门的发送（取消/退休时调用），使其重新检查条件并退出。 */
  const wakeAdmissionWaiters = (record: ThreadRecord): void => {
    for (const wake of [...record.admissionWaiters]) wake()
    record.admissionWaiters.clear()
  }

  /**
   * 等待在途发送退出（会话收尾用）。
   *
   * 有上限：SDK 层无法中断阻塞在输入 hook 里的预检；超时后继续收尾，
   * 此时该发送视为已放弃（不再有能力启动运行——退休标记先行阻止）。
   */
  const drainInFlight = async (record: ThreadRecord): Promise<void> => {
    const waits = [...record.inFlight].map((pending) => pending.finished)
    if (waits.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RETIRE_DRAIN_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 获取启动窗口（准入闸门）。
   *
   * 保证同一会话同时至多一个发送处于「预检 → 运行确认」段（统一占窗，
   * 不在「运行中」时偷跑：否则运行可能先结束、预检后完成，导致两个发送
   * 都走「启动运行」路径而重叠结算）。
   *
   * 返回 undefined 表示放弃本次发送（已取消 / 会话退休）。
   *
   * 为何「任一在途运行」都要等其结算：SDK 在 `_emitAgentSettled()` 期间
   * （`_isEmittingAgentSettled` 为真）会把 `prompt()` 静默压入
   * `_deferredSettledActions` 并立即返回（agent-session.js:1517）；
   * 若此刻放行新发送，宿主会误判「已接受」而移除跟踪，取消再也够不到它。
   *
   * 已知边界：若占窗者的预检被扩展的输入 hook 永久阻塞，后续发送会一直等待
   * （SDK 无法中断 hook）；取消会唤醒等待者退出，但仍会等待阻塞解除。
   */
  const acquireAdmission = async (
    record: ThreadRecord,
    inFlight: InFlightSend,
    isCancelled: () => boolean,
  ): Promise<RunAdmission | undefined> => {
    // 取消来源有二：冷打开窗口的 token（isCancelled）与发送级标记（cancelRun）。
    const cancelled = () => isCancelled() || inFlight.cancelled
    while (true) {
      if (record.retired || cancelled()) return undefined
      const run = record.currentRun
      if (run !== undefined && !record.session.isStreaming) {
        // 「结算窗口」：SDK 已置 `_isAgentRunActive = false`（故 isStreaming 为假）
        // 但仍在 await 扩展的 agent_settled hook；此时 `prompt()` 会被静默压入
        // `_deferredSettledActions` 并立即返回（agent-session.js:1517），宿主会
        // 误判「已接受」而移除跟踪。等它真正结算后再评估。
        // 注册唤醒：本发送自身被取消 / 会话退休时也要能退出。
        let wakeRun: () => void = () => {}
        const wokenRun = new Promise<void>((resolve) => {
          wakeRun = resolve
        })
        record.admissionWaiters.add(wakeRun)
        try {
          await Promise.race([run.settled, wokenRun])
        } finally {
          record.admissionWaiters.delete(wakeRun)
        }
        continue
      }
      // 正常运行中（isStreaming 为真）：交给 SDK 的排队分支（steer/follow-up），
      // 不在此等待——否则排队消息会被推迟到整次运行结算后才送达。
      const current = record.admission
      if (current === undefined) break
      // 等待前一个占窗者的预检结算；期间可被取消/退休路径唤醒以尽快退出。
      let wake: () => void = () => {}
      const woken = new Promise<void>((resolve) => {
        wake = resolve
      })
      record.admissionWaiters.add(wake)
      try {
        await Promise.race([current.done, woken])
      } finally {
        record.admissionWaiters.delete(wake)
      }
    }
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let released = false
    const admission: RunAdmission = {
      done,
      release: () => {
        if (released) return
        released = true
        if (record.admission === admission) record.admission = undefined
        resolveDone()
      },
    }
    record.admission = admission
    return admission
  }

  /**
   * 发送一次 prompt，返回「输入已被接受」的承诺（不等待运行结束）。
   *
   * 预检取消兜底：SDK 的 `abort()` 只在 `_isAgentRunActive` 为真时记录中止意图，
   * 而预检（input hook / 认证检查 / before_agent_start）期间该标志尚未置位，
   * 且 `_runAgentPrompt()` 启动时会重置中止标志——预检期间的取消直接落空。
   * 因此取消意图先随发送登记（`startingSend`），运行激活（`agent_start`）时
   * 取用为当前运行归属并立即中止，阻止模型请求真正发出。
   *
   * 判定口径：一次运行是否属「取消」以 `agent_settled.aborted`（SDK 直接取自
   * `_agentRunAbortRequested`）为权威，不受消息 `stopReason` 分类影响
   * （`lazyStream` 的 setup 失败路径会把取消写死为 `'error'`）。
   */
  const send = async (
    record: ThreadRecord,
    input: HarnessSendMessageInput,
    isCancelled: () => boolean,
  ): Promise<void> => {
    assertActive()

    let resolveFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const inFlight: InFlightSend = {
      accepted: false,
      cancelled: false,
      finished,
      markFinished: () => resolveFinished(),
    }
    record.inFlight.add(inFlight)

    // 准入闸门：串行化每会话的「预检 → 运行确认」段，防止后到者提前结算前者运行。
    const admission = await acquireAdmission(record, inFlight, isCancelled)
    if (admission === undefined && (record.retired || isCancelled() || inFlight.cancelled)) {
      // 等待期间被取消 / 会话进入收尾：不进入预检，按「未启动即取消」上报。
      emit(record, { type: 'agent_end', cancelledBeforeStart: true })
      record.inFlight.delete(inFlight)
      inFlight.markFinished()
      return
    }

    try {
      // 预检承诺：接受（含入队）或被拒绝时结算一次。
      let settlePreflight: (error?: unknown) => void = () => {}
      let preflightSettled = false
      const accepted = new Promise<void>((resolve, reject) => {
        settlePreflight = (error) => {
          if (preflightSettled) return
          preflightSettled = true
          if (error) reject(error)
          else resolve()
        }
      })

      // 运行中 Pi 要求显式声明排队语义；默认 followUp。
      const streamingBehavior =
        input.streamingBehavior ?? (record.session.isStreaming ? 'followUp' : undefined)

      // 用 AsyncLocalStorage 绑定本次发送：输入守卫据此精确认领（不用文本匹配）。
      // `prompting` 在后台继续（接受语义：不等待运行结束）；其失败已在 catch 内处理。
      void sendContext.run(inFlight, () =>
        record.session
          .prompt(input.content, {
            ...(input.attachments?.length ? { images: input.attachments } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
            preflightResult: (disposition) => {
              // 提交点拒绝（已退休 / 已取消）：此刻放行会让 SDK 继续进入
              // `_runAgentPrompt()` 启动运行。
              // - 退休：宿主已退订，无 agent_start 可兜底；
              // - 取消：本发送在闸门等待期间被标记，或以延迟动作身份
              //   在结算窗口后恢复（`_deferredSettledActions`）。
              // 抛错使 prompt 以拒绝收尾（SDK 不捕获此回调异常）。
              if (record.retired) throw new Error('Harness session is retired')
              if (isCancelled() || inFlight.cancelled) throw new Error('Harness send was cancelled')
              inFlight.accepted = true
              settlePreflight()
              // 取消意图统一记入发送级标记。
              if (isCancelled()) inFlight.cancelled = true
              // 仅 'started' 会启动运行；'handled'/'queued' 无独立运行可归属。
              if (disposition !== 'started') return
              record.startingSend = inFlight
              // 运行确认后释放准入闸门：后续发送可以开始它们的预检
              // （SDK 会因运行中而走 queued 分支，不再建立新运行）。
              admission?.release()
            },
          })
          .then(() => {
            settlePreflight()
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            // 已取消 / 已退休的发送被拒（含提交点拒绝与 SDK「Agent is already processing」）：
            // 属取消的预期结果，不记为失败，也不向订阅者抛错误。
            if (inFlight.cancelled || isCancelled() || record.retired) {
              settlePreflight()
              return
            }
            record.lastError = message
            if (preflightSettled) {
              emit(record, { type: 'error', error: message })
            } else {
              settlePreflight(error)
            }
          })
          .finally(() => {
            record.inFlight.delete(inFlight)
            // 运行从未启动（如被拒）时不要留下占用的归属槽。
            if (record.startingSend === inFlight) record.startingSend = undefined
            admission?.release()
            inFlight.markFinished()
          }),
      )

      try {
        await accepted
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        record.lastError = message
        emit(record, { type: 'error', error: message })
        throw error
      }
    } finally {
      // 任一路径退出发送（接受 / 预检异常 / 早起退出）都要释放闸门，
      // 否则后续发送会永久等待（release 幂等）。
      admission?.release()
    }
  }

  // ---- 删除 ----
  const deleteThreadNow = async (threadId: string): Promise<void> => {
    pendingOpens.get(threadId)?.controller.abort()
    const record = records.get(threadId)
    const info = record ? undefined : await findSessionInfo(threadId)
    if (!record && !info) {
      // 上次可能已删除文件但侧车清理失败；重试仍须完成清理。
      await workspaceStore.removeSessionMetadata({ storeId, sessionId: threadId })
      return
    }
    // 已知侧车不可写时在删除文件前拒绝，避免可预知的部分删除。
    if (!workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        workspaceStore.integrity === 'ok' ? 'unreadable' : workspaceStore.integrity,
        workspaceStore.stateFile,
      )
    }
    const sessionFile = record?.session.sessionFile ?? info?.path
    const cwd = record?.workspacePath ?? info?.cwd
    if (!sessionFile) throw new Error(`Unknown thread: ${threadId}`)
    // 在中止或移除 live record 之前拒绝越界路径，失败不得先破坏当前会话。
    assertSessionFileInScope(sessionFile, cwd)

    if (record) {
      // 0) 进入收尾：不再接受新运行，并唤醒等待闸门的发送使其退出。
      record.retired = true
      wakeAdmissionWaiters(record)
      // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
      discardDeferredRuns(record.session)
      // 1) 使在途发送（含预检）失效，避免删除后仍启动运行。
      for (const pending of record.inFlight) pending.cancelled = true
      // 2) 先解除阻断式 UI 等待，否则 abort 可能等一个永不应答的对话（工具在等 UI）。
      record.uiBridge.dismissAll()
      // 3) 中止运行并等待收尾（此时工具/UI 已不再阻断；等待有上限）。
      await abortForRetire(record.session)
      // 4) 等待在途发送的预检退出（它们不再启动运行）。
      await drainInFlight(record)
      // 5) 收尾：先补发 shutdown（扩展可能在 handler 里再次提交延迟动作），
      //    随后**同步链内**再次清空延迟数组并 dispose，中间不插 await，
      //    否则放行的扩展 hook 会在清空与 dispose 之间启动延迟运行。
      //    注：清空够不到 SDK 已 `splice(0)` 取走的局部批次，那部分由
      //    agent 级兜底订阅在 agent_start 时中止（见 record 字段注释）。
      await emitShutdown(record, 'quit')
      discardDeferredRuns(record.session)
      record.session.dispose()
      record.unsubscribe()
      // 保留 agent 级兜底订阅：局部批次可能在收尾后才启动（见字段注释）。
      records.delete(threadId)
      recordsBySessionFile.delete(sessionFile)
    }
    // 删除同样限于当前存储作用域（防止作用域外路径被作用到）。
    assertSessionFileInScope(sessionFile, cwd)
    await unlink(sessionFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (cwd) invalidateCatalog(cwd)
    // 文件删除成功后才清理归属与归档元数据。文件与 sidecar 没有跨文件事务，
    // 清理失败必须报告（由调用方呈现），不伪造成功。
    await workspaceStore.removeSessionMetadata({ storeId, sessionId: threadId })
  }

  /**
   * 补发 `session_shutdown`。
   *
   * SDK 的 `AgentSession.dispose()` 只做 abort 与内部清理，不发 shutdown 事件；
   * 官方 runtime 在销毁前显式发它（`agent-session-runtime.js`）。扩展若在
   * `session_start` 建连接/定时器并在 `session_shutdown` 释放，缺这一步会泄漏。
   */
  const emitShutdown = async (
    record: ThreadRecord,
    reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork',
  ): Promise<void> => {
    try {
      const extensionsResult = record.resourceLoader.getExtensions()
      const runner = new ExtensionRunner(
        extensionsResult.extensions,
        extensionsResult.runtime,
        record.workspacePath,
        SessionManager.open(
          record.session.sessionFile ?? '',
          resolveSessionDirFor(record.workspacePath).dir,
        ),
        new ModelRegistry(modelRuntime),
      )
      await runner.emit({ type: 'session_shutdown', reason })
    } catch (error) {
      diagnostics.push(`session_shutdown（${record.workspacePath}）：${String(error)}`)
    }
  }

  /**
   * 收尾一个刚创建但归属保存失败的会话：保留 Pi 文件供「未归属」发现，
   * 不删除、不伪报创建成功。
   */
  const abandonRecord = async (record: ThreadRecord): Promise<void> => {
    record.retired = true
    wakeAdmissionWaiters(record)
    discardDeferredRuns(record.session)
    for (const pending of record.inFlight) pending.cancelled = true
    record.uiBridge.dismissAll()
    await abortForRetire(record.session)
    await drainInFlight(record)
    await emitShutdown(record, 'quit')
    discardDeferredRuns(record.session)
    record.session.dispose()
    record.unsubscribe()
    records.delete(record.threadId)
    if (record.session.sessionFile) recordsBySessionFile.delete(record.session.sessionFile)
  }

  const client: HarnessClient = {
    async getHostInfo() {
      assertActive()
      const scope = scopeOf(workspacePath)
      return {
        workspacePath,
        agentDir,
        agentDirSource,
        sessionStorage: {
          mode: scope.grouped ? 'grouped' : 'flat',
          root: scopeRootOf(scope),
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
      if (result.ok) emitWorkspaceSnapshots(result.workspace.id)
      else if (result.workspace) emitWorkspaceSnapshots(result.workspace.id)
      return result
    },

    async assignThreadWorkspace(input) {
      assertActive()
      const info = records.get(input.threadId) ? undefined : await findSessionInfo(input.threadId)
      const record = records.get(input.threadId)
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
        emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
        return { ok: true as const, thread: metadataOf(record) }
      }
      const workspace = workspaceStore.workspace(input.workspaceId)
      // 到这里 record 为空，info 必然存在（已在上面按 not-found 返回）。
      const catalogInfo = info as SessionCatalogInfo
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

    async listThreads(input) {
      assertActive()
      // 显式刷新（含窗口重新聚焦）：清空作用域缓存后重新扫描，外部 Pi 新增/
      // 删除/改名可见；普通操作仍复用已有失效机制。
      if (input?.refresh) scopeCatalogCache.clear()
      // 工作区会话跨 cwd 聚合：使用整个存储作用域列表，而不是只过滤 header.cwd。
      const infos = await listScopeInfos()
      return infos
        .filter(
          (info) => input?.includeArchived || !workspaceStore.sessionArchived(storeId, info.id),
        )
        .flatMap((info) => {
          const storedWorkspaceId = workspaceStore.sessionWorkspace(storeId, info.id)
          const workspace = storedWorkspaceId
            ? workspaceStore.workspace(storedWorkspaceId)
            : undefined
          const workspaceId = workspace?.id
          if (input?.workspaceId && workspaceId !== input.workspaceId) return []
          if (input?.unassigned && workspaceId) return []
          const live = records.get(info.id)
          if (live) {
            // live 元数据本身不带时间（事件路径避免逐次 stat）；列表补上目录时间，
            // 使「继续最近」等排序与冷条目同一口径。
            return [
              {
                ...metadataOf(live),
                ...(workspace
                  ? {
                      workspaceId: workspace.id,
                      workspaceRevision: workspace.revision,
                    }
                  : {}),
                createdAt: info.created.toISOString(),
                updatedAt: info.modified.toISOString(),
              },
            ]
          }
          // 冷条目也要叠加归档标记与工作区归属（过滤与呈现口径一致）。
          return [
            {
              ...mapSessionInfo(info, { liveStatus: 'idle' }),
              ...(workspace
                ? {
                    workspaceId: workspace.id,
                    workspaceRevision: workspace.revision,
                    workspaceAppliedRevision: workspace.revision,
                  }
                : {}),
              ...(workspaceStore.sessionArchived(storeId, info.id) ? { archived: true } : {}),
            },
          ]
        })
    },

    async checkProjectPath(path: string) {
      assertActive()
      return inspectProjectPath(path)
    },

    async getProject(input) {
      assertActive()
      return queryProject(input.path)
    },

    async inspectProjectTrust(input) {
      assertActive()
      return inspectProjectTrust(input.path)
    },

    async decideProjectTrust(input) {
      assertActive()
      return decideProject(input)
    },

    async listRecentProjects() {
      assertActive()
      return listRecentProjects()
    },

    async createThread(input?: HarnessCreateThreadInput) {
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
      const project = await acquireProjectSession(startProject.path)
      const cwd = project.runtime.cwd
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
      if (
        !input?.model &&
        project.runtime.defaultModel.info.readiness.state === 'unavailable-model'
      ) {
        throw new Error('默认模型不在注册表中，请先选择有效模型，或修正配置后重启宿主。')
      }
      const sessionDir = resolveSessionDirFor(cwd).dir
      // 尚未生成文件名，先检查目录中的探针路径；父目录链接也不得越过默认空间。
      assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
      const sessionManager = SessionManager.create(cwd, sessionDir)
      const record = await openSession(sessionManager, cwd, {
        isNew: true,
        project,
        workspaceId,
        ...(explicitModel ? { model: explicitModel } : {}),
        ...(input?.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      })
      // 先保存归属再返回成功；失败时保留 Pi 文件作为未归属会话，不删除。
      try {
        await workspaceStore.assignSession({
          storeId,
          sessionId: record.threadId,
          workspaceId,
        })
      } catch (error) {
        await abandonRecord(record)
        throw error
      }
      invalidateCatalog(cwd)
      if (input?.title) record.session.setSessionName(input.title)
      if (input?.initialMessage) await send(record, input.initialMessage, () => false)
      return snapshotOf(record)
    },

    async getThread(threadId: string) {
      assertActive()
      const live = records.get(threadId)
      if (live) return snapshotOf(live)
      const info = await findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      return snapshotFromSessionFile(info)
    },

    async getThreadDetails(threadId: string) {
      assertActive()
      return threadDetailsOf(threadId)
    },

    async sendMessage(threadId, input) {
      assertActive()
      const token: StartingSend = { cancelled: false }
      let tokens = startingSends.get(threadId)
      if (!tokens) {
        tokens = new Set()
        startingSends.set(threadId, tokens)
      }
      tokens.add(token)
      try {
        const record = await ensureOpen(threadId)
        if (token.cancelled) {
          emit(record, { type: 'agent_end', cancelledBeforeStart: true })
          return
        }
        // 取消判断合并两个来源：冷打开窗口的 token 与 record 上的在途取消标记。
        await send(record, input, () => token.cancelled)
      } finally {
        tokens.delete(token)
        if (tokens.size === 0) startingSends.delete(threadId)
      }
    },

    async cancelRun(threadId) {
      const tokens = startingSends.get(threadId)
      if (tokens) for (const token of tokens) token.cancelled = true
      const record = records.get(threadId)
      if (!record) return
      // 停止语义 = 中止当前运行 + 丢弃尚未送达的排队输入：
      // - 预检中的发送（尚未被接受）标记取消：其运行将在建立后立即被中止；
      // - 当前运行标记取消：使「中止窗口内」的新发送改为等待运行退出并
      //   重新启动，而不是排进一个注定中止的运行（否则会滞留到下次人为触发）；
      // - 已在 SDK 队列中的输入直接丢弃（按停止键的预期语义）；
      // - 已启动的运行交由 abort 中止（其收尾按取消结算，不算失败）。
      for (const pending of record.inFlight) {
        if (!pending.accepted) pending.cancelled = true
      }
      if (record.currentRun) record.currentRun.cancelled = true
      // 丢弃 SDK 缓冲的延迟动作（扩展的 triggerTurn 消息），并置位清扫标记：
      // 它可能在取消后由 SDK 直接启动一个无归属运行。
      discardDeferredRuns(record.session)
      record.sweepUnattendedRun = true
      record.session.clearQueue()
      // 唤醒等待准入闸门的发送（已被取消者可就此退出，不必干等占窗者）。
      wakeAdmissionWaiters(record)
      // 解除阻断式 UI 等待（否则运行可能在等一个永不应答的对话）。
      record.uiBridge.dismissAll()
      await record.session.abort()
    },

    async clearQueue(threadId) {
      const record = records.get(threadId)
      if (!record) return { steering: [], followUp: [] }
      return record.session.clearQueue()
    },

    async getAvailableModels(input) {
      assertActive()
      const info = await queryProject(input?.workspacePath ?? workspacePath)
      if (info.status === 'needs-trust') throw new ProjectTrustRequiredError(info)
      if (info.status === 'failed') throw new Error('项目装配失败')
      return listModelCatalog(modelRuntime)
    },

    async setModel(threadId, input) {
      const record = await ensureOpen(threadId)
      const model = modelRuntime.getModel(input.provider, input.modelId)
      if (!model)
        throw new Error(`${input.provider}/${input.modelId} is not in Pi's model registry`)
      await record.session.setModel(model)
      record.lastError = undefined
      emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    async setThinkingLevel(threadId, level: HarnessThinkingLevel) {
      const record = await ensureOpen(threadId)
      await record.session.setThinkingLevel(level)
    },

    async renameThread(threadId, title) {
      const record = records.get(threadId)
      if (record) {
        record.session.setSessionName(title)
        invalidateCatalog(record.workspacePath)
        return
      }
      const info = await findSessionInfo(threadId)
      if (!info) throw new Error(`Unknown thread: ${threadId}`)
      const scope = assertSessionFileInScope(info.path, info.cwd)
      SessionManager.open(info.path, scope.dir).appendSessionInfo(title)
      invalidateCatalog(info.cwd || workspacePath)
    },

    async archiveThread(threadId) {
      assertActive()
      const record = records.get(threadId)
      const info = record ? undefined : await findSessionInfo(threadId)
      if (!record && !info) throw new Error(`Unknown thread: ${threadId}`)
      // 归档是 huan 侧车组织标记：不改 Pi JSONL、不改工作区 revision、不停止任务。
      await workspaceStore.setSessionArchived({ storeId, sessionId: threadId, archived: true })
      if (record) emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    async unarchiveThread(threadId) {
      assertActive()
      const record = records.get(threadId)
      const info = record ? undefined : await findSessionInfo(threadId)
      if (!record && !info) throw new Error(`Unknown thread: ${threadId}`)
      await workspaceStore.setSessionArchived({ storeId, sessionId: threadId, archived: false })
      if (record) emit(record, { type: 'snapshot', snapshot: snapshotOf(record) })
    },

    deleteThread(threadId) {
      const pending = pendingDeletes.get(threadId)
      if (pending) return pending
      const deletion = deleteThreadNow(threadId).finally(() => {
        if (pendingDeletes.get(threadId) === deletion) pendingDeletes.delete(threadId)
      })
      pendingDeletes.set(threadId, deletion)
      return deletion
    },

    async respondToHostUiRequest(threadId, response: HarnessHostUiResponse) {
      records.get(threadId)?.uiBridge.resolve(response)
    },

    subscribe(threadId, listener, subOptions) {
      // 损坏元数据仅允许冷读，订阅也不能隐式装配项目代码。
      if (!workspaceStore.healthy) {
        let active = true
        void client
          .getThread(threadId)
          .then((snapshot) => {
            if (active && subOptions?.includeSnapshot !== false) {
              listener({ type: 'snapshot', snapshot, threadId, seq: 0 })
            }
          })
          .catch(() => {})
        return () => {
          active = false
        }
      }
      let active = true
      let record: ThreadRecord | undefined
      ensureOpen(threadId)
        .then((opened) => {
          if (!active) return
          record = opened
          opened.listeners.add(listener)
          if (subOptions?.includeSnapshot !== false) {
            try {
              listener({
                type: 'snapshot',
                snapshot: snapshotOf(opened),
                threadId,
                seq: opened.seq,
              })
            } catch {
              // 订阅者抛错不影响其他订阅者。
            }
          }
        })
        .catch((error: unknown) => {
          if (active) {
            try {
              listener({
                type: 'error',
                error: error instanceof Error ? error.message : String(error),
                threadId,
                seq: 0,
              })
            } catch {
              // 同上。
            }
          }
        })
      return () => {
        active = false
        record?.listeners.delete(listener)
      }
    },
  }

  /**
   * 冷读装载：只打开作用域校验后的 SessionManager，读取活动分支与上下文。
   *
   * 不构造 AgentSession、不装配项目设置/扩展、不联网；未知模型窗口时
   * `contextUsage` 缺失（不填 0）；压缩后无有效助手 usage 时由
   * `deriveContextUsage` 返回 tokens=null。
   */
  const loadColdSession = (info: SessionCatalogInfo) => {
    const scope = assertSessionFileInScope(info.path, info.cwd)
    const sessionManager = SessionManager.open(info.path, scope.dir)
    const branch = sessionManager.getBranch() as unknown as HarnessAnySessionEntry[]
    const context = sessionManager.buildSessionContext()
    const contextWindow = context.model
      ? (modelRuntime.getModel(context.model.provider, context.model.modelId)?.contextWindow ?? 0)
      : 0
    const contextUsage = deriveContextUsage(contextWindow, branch, context.messages)
    const storedWorkspaceId = workspaceStore.sessionWorkspace(storeId, info.id)
    const workspaceMetadata = sessionWorkspaceFields(
      info.id,
      storedWorkspaceId ? workspaceStore.workspace(storedWorkspaceId)?.revision : undefined,
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
          archived: workspaceStore.sessionArchived(storeId, info.id),
          ...(contextUsage ? { contextUsage } : {}),
        },
      ),
      ...workspaceMetadata,
    }
    return { sessionManager, branch, context, contextUsage, metadata }
  }

  /** 冷读快照（不经 AgentSession）。 */
  const snapshotFromSessionFile = (info: SessionCatalogInfo): HarnessThreadSnapshot => {
    const cold = loadColdSession(info)
    return {
      metadata: cold.metadata,
      messages: cold.context.messages as HarnessAgentMessage[],
      readiness: getModelReadiness(
        modelRuntime,
        cold.context.model
          ? {
              provider: cold.context.model.provider,
              modelId: cold.context.model.modelId,
            }
          : undefined,
        'session',
      ),
    }
  }

  /**
   * 只读详情：热会话直接使用 SDK 统计，冷会话按 SDK 同口径聚合全文件条目。
   *
   * 详情按需请求，不随每个 token 事件聚合整棵树，也不建立全历史索引。
   */
  const threadDetailsOf = async (threadId: string): Promise<HarnessThreadDetails> => {
    const info = await findSessionInfo(threadId)
    const record = records.get(threadId)
    if (record) {
      // 热会话：`getSessionStats()` 是权威口径（全文件累计），上下文复用同一会话。
      const stats = record.session.getSessionStats()
      return {
        metadata: {
          ...metadataOf(record),
          ...(info
            ? {
                createdAt: info.created.toISOString(),
                updatedAt: info.modified.toISOString(),
                ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
              }
            : {}),
        },
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
    if (!info) throw new Error(`Unknown thread: ${threadId}`)
    const cold = loadColdSession(info)
    return {
      metadata: cold.metadata,
      stats: aggregateSessionStats(cold.sessionManager.getEntries()),
      ...(cold.contextUsage ? { contextUsage: cold.contextUsage } : {}),
      branchEntryCount: cold.branch.length,
    }
  }

  return {
    ...client,
    async dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      for (const pending of pendingOpens.values()) pending.controller.abort()
      pendingOpens.clear()
      for (const record of [...records.values()]) {
        // 进入收尾：不再接受新运行；唤醒等待闸门的发送（随后被取消并排空）。
        record.retired = true
        wakeAdmissionWaiters(record)
        // 丢弃 SDK 缓冲的延迟动作（否则收尾后仍可能启动运行）。
        discardDeferredRuns(record.session)
        // 使在途发送失效，并解除阻断式 UI 等待（避免 abort 等不到对话）。
        for (const pending of record.inFlight) pending.cancelled = true
        record.uiBridge.dismissAll()
        // 中止运行并等待收尾（等待有上限：SDK 的 abort() 会等 idle）。
        await abortForRetire(record.session)
        // 等待在途发送退出（有上限）。
        await drainInFlight(record)
        // 收尾：先补发 shutdown（扩展可能在 handler 里再次提交延迟动作），随后
        // 同步链内清空延迟数组并 dispose（中间不插 await，否则放行的扩展 hook
        // 会在清空与 dispose 之间启动延迟运行）。清空够不到 SDK 已取走的
        // 局部批次，那部分由 agent 级兜底订阅在 agent_start 时中止。
        await emitShutdown(record, 'quit')
        discardDeferredRuns(record.session)
        record.session.dispose()
        record.unsubscribe()
        // 保留 agent 级兜底订阅：局部批次可能在收尾后才启动（见字段注释）。
      }
      records.clear()
      recordsBySessionFile.clear()
    },
    diagnostics: () => [...diagnostics],
  }
}
