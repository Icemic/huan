/**
 * Pi MCP 集成绑定（G1.4d2b）。
 *
 * 工厂只注册命令与事件；配置仅在 `session_start` 通过共享配置读取，随后在后台
 * 启动一个每会话独立的连接管理器。桥接把管理器目录注册为 Pi 工具与资源工具，
 * 并按 `mcp_servers_change` 对账运行时扩展注册的服务器。
 *
 * 不提供 GUI、登录或 OAuth 存储；`/mcp` 只输出受控状态摘要。所有生产导入均来自
 * Pi SDK / pi-mcp 的公开根入口或公开子路径。
 */

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  McpExposure,
  RegisteredMcpServer,
} from '@earendil-works/pi-coding-agent'
import { type LoadedMcpConfig, loadMcpConfig, type McpServerEntry, mcpNamespace } from './config.js'
import type { McpCommandRunner } from './config-values.js'
import { type McpAuthProviderFactory, resolveMcpRequestTimeoutMs } from './connection.js'
import type { McpServerLogSink } from './log.js'
import {
  createMcpConnectionManager,
  type McpConnectionManager,
  type McpConnectionManagerOptions,
  type McpServerSnapshot,
} from './manager.js'
import {
  createMcpResourceToolDefinitions,
  MCP_RESOURCE_TOOL_NAMES,
  type McpResourceServer,
} from './resources.js'
import {
  createMcpToolDefinition,
  createMcpToolName,
  type McpToolCaller,
  type McpToolDefinition,
  toToolExposure,
} from './tools.js'

/** 系统提示中列出未直接声明工具的服务器段落名。 */
export const MCP_SERVERS_SECTION = 'mcp_servers'
/** 单个服务器描述字符上限。 */
export const MAX_SERVER_DESCRIPTION_CHARS = 250
/** 整个 mcp_servers 段落字符上限。 */
export const MAX_SERVERS_SECTION_CHARS = 4096
const DEFAULT_STARTUP_WAIT_MS = 10_000
const CODEMODE_TOOL_NAME = 'codemode'
const TOOL_SEARCH_TOOL_NAME = 'tool_search'

/** 集成构造选项；测试可注入配置加载与 transport。 */
export interface McpIntegrationOptions {
  agentDir: string
  /** 读取本次 loader 的项目信任决定；只在 session_start 调用。 */
  getProjectTrusted: () => boolean
  /** 测试注入；默认使用共享的 loadMcpConfig。 */
  loadConfig?: (options: {
    agentDir: string
    cwd: string
    projectTrusted: boolean
  }) => LoadedMcpConfig | Promise<LoadedMcpConfig>
  /** direct 工具首轮等待上限；默认 10 秒。 */
  startupWaitMs?: number
  createTransport?: McpConnectionManagerOptions['createTransport']
  createAuthProvider?: McpAuthProviderFactory
  env?: Readonly<Record<string, string | undefined>>
  runCommand?: McpCommandRunner
  /** 收到服务器 `notifications/message` 时调用；由 core 注入固定 agentDir 的日志。 */
  onLog?: McpServerLogSink
}

/** 无界面集成绑定。 */
export interface McpIntegration {
  /** 每次 loader 装配调用一次，产生新的局部上下文与连接代次。 */
  extension: ExtensionFactory
  /** 当前会话的管理器；未启动或已关闭时为 undefined。 */
  getManager(): McpConnectionManager | undefined
  /** 宿主最终释放：同步禁止晚结果/后续 session_start，并等待所有管理器关闭。 */
  close(): Promise<void>
}

/** 单个服务器的桥接输入。 */
export interface McpServerListing {
  entry: McpServerEntry
  connection?: { instructions?: string }
}

interface ServerRun {
  alive: boolean
  manager?: McpConnectionManager
  controller: AbortController
  ctx: ExtensionContext
  config?: LoadedMcpConfig
  entries: Map<string, McpServerEntry>
  overridden: string[]
  autoEnableCodemode: boolean
  waitedForStartup: boolean
  warnedUnreachable: boolean
  unsubscribe?: () => void
  synced: Map<string, string>
  serverTools: Map<string, Set<string>>
  definitions: Map<string, McpToolDefinition>
  toolOwners: Map<string, string>
  resourceExposure?: McpExposure
}

interface FactoryContext {
  alive: boolean
  run?: ServerRun
  /** 本扩展上下文创建过的管理器；close 时全部收尾。 */
  managers: Set<McpConnectionManager>
}

const EXPOSURE_LABELS: Readonly<Record<McpExposure, string>> = {
  codemode: 'codemode',
  deferred: 'deferred',
  direct: 'direct',
  hidden: 'hidden',
}

const STATE_LABELS: Readonly<Record<string, string>> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开（下次调用重连）',
  'needs-auth': '需要认证',
  failed: '连接失败',
  closed: '已关闭',
  disabled: '已禁用',
}

function exposureOf(entry: McpServerEntry): McpExposure {
  return entry.config.exposure ?? 'codemode'
}

function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
  return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})])
}

function hasDirectTools(entry: McpServerEntry): boolean {
  return configuredExposures(entry).has('direct')
}

function hasIndirectTools(entry: McpServerEntry): boolean {
  const exposures = configuredExposures(entry)
  return exposures.has('codemode') || exposures.has('deferred')
}

function isEnabled(entry: McpServerEntry): boolean {
  return entry.config.enabled !== false
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return max <= 1 ? '' : `${text.slice(0, max - 1).trimEnd()}…`
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n', 1)[0] ?? ''
}

function serverSummary(listing: McpServerListing): string {
  const text = listing.entry.config.description?.trim() || listing.connection?.instructions || ''
  return firstLine(text).trim()
}

function serversSectionIntro(reaches: ReadonlySet<string>): string {
  let intro = 'MCP servers whose tools are not declared to you.'
  if (reaches.has('codemode')) {
    intro += ' Call the tools of `codemode` servers from codemode scripts.'
  }
  if (reaches.has('tool_search')) {
    intro += ' Load the tools of `tool_search` servers with `tool_search`.'
  }
  return intro
}

/**
 * 生成有界的 `mcp_servers` 系统段。
 *
 * 与上游相比，服务器裁剪与描述预算使用前缀和一次线性扫描，不反复 slice/join。
 * 返回 undefined 表示没有需要列出的服务器。
 */
export function renderMcpServersSection(servers: readonly McpServerListing[]): string | undefined {
  const listed = servers
    .filter((server) => isEnabled(server.entry) && hasIndirectTools(server.entry))
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name))
  if (listed.length === 0) return undefined
  const reaches = listed.map((server) =>
    configuredExposures(server.entry).has('codemode') ? 'codemode' : 'tool_search',
  )
  const intro = serversSectionIntro(new Set(reaches))
  const heads = listed.map(
    (server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`,
  )
  const omission = (count: number) =>
    `- … ${count} more server${count === 1 ? '' : 's'}; find their tools with searchTools()`

  // 前缀和：heads 的累计长度；size(kept) 为 O(1)。
  const prefix = new Array<number>(heads.length + 1).fill(0)
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index]
    const previous = prefix[index]
    if (head === undefined || previous === undefined) continue
    prefix[index + 1] = previous + head.length
  }
  const size = (kept: number): number => {
    const omitted = listed.length - kept
    const lines = kept + (omitted > 0 ? 1 : 0)
    return intro.length + (prefix[kept] ?? 0) + (omitted > 0 ? omission(omitted).length : 0) + lines
  }
  let kept = listed.length
  while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept -= 1
  const perServer =
    kept === 0
      ? 0
      : Math.min(
          MAX_SERVER_DESCRIPTION_CHARS,
          Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2,
        )
  const lines = listed.slice(0, kept).map((server, index) => {
    const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : ''
    const head = heads[index] ?? ''
    return summary ? `${head}: ${summary}` : head
  })
  return [intro, ...lines, ...(listed.length > kept ? [omission(listed.length - kept)] : [])].join(
    '\n',
  )
}

/** 一个 call 的 reachesTools 结果是否可能触及该服务器。 */
function reachesServer(reach: 'all' | readonly string[], server: string): boolean {
  if (reach === 'all') return true
  const namespace = mcpNamespace(server)
  return reach.some((word) => word.includes(namespace))
}

function safeNotify(
  ctx: ExtensionContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  try {
    ctx.ui.notify(message, type)
  } catch {
    // 无 UI 的模式下忽略通知失败。
  }
}

/** 组合多个取消信号；没有信号时返回 undefined。 */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  return present.length === 1 ? present[0] : AbortSignal.any(present)
}

/** 从 Pi 注册表得到非配置覆盖的运行时条目。配置按 namespace 优先。 */
function registeredEntries(
  registered: readonly RegisteredMcpServer[],
  configured: readonly McpServerEntry[],
): { entries: McpServerEntry[]; overridden: string[] } {
  const configuredNamespaces = new Set(configured.map((entry) => mcpNamespace(entry.name)))
  const entries: McpServerEntry[] = []
  const overridden: string[] = []
  for (const server of registered) {
    if (configuredNamespaces.has(mcpNamespace(server.name))) {
      overridden.push(server.name)
      continue
    }
    entries.push({
      name: server.name,
      config: structuredClone(server.config),
      source: server.extensionPath,
      scope: 'extension',
    })
  }
  return { entries, overridden }
}

function resourceServerList(run: ServerRun): McpResourceServer[] {
  const manager = run.manager
  if (!manager || !run.alive) return []
  return manager.listResourceServers().map((name) => {
    const entry = run.entries.get(name)
    const timeoutMs = resolveMcpRequestTimeoutMs(entry?.config.timeout)
    return {
      name,
      timeoutMs,
      resourcesPage: (cursor, options) => manager.listResources(name, cursor, options),
      resourceTemplatesPage: (cursor, options) =>
        manager.listResourceTemplates(name, cursor, options),
      allResources: (options) => manager.listAllResources(name, options),
      allResourceTemplates: (options) => manager.listAllResourceTemplates(name, options),
      readResource: (uri, options) => manager.readResource(name, uri, options),
    }
  })
}

export function createMcpIntegration(options: McpIntegrationOptions): McpIntegration {
  let closed = false
  let activeManager: McpConnectionManager | undefined
  let closePromise: Promise<void> | undefined
  const contexts = new Set<FactoryContext>()
  const startupWaitMs = Number.isFinite(options.startupWaitMs)
    ? Math.max(0, options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS)
    : DEFAULT_STARTUP_WAIT_MS

  const detachRun = async (local: FactoryContext, run: ServerRun | undefined): Promise<void> => {
    if (!run) return
    // 同步撤销注册资格，再等待完整关闭。
    run.alive = false
    run.unsubscribe?.()
    run.unsubscribe = undefined
    run.controller.abort()
    const manager = run.manager
    run.manager = undefined
    if (manager) {
      if (activeManager === manager) activeManager = undefined
      try {
        await manager.close()
      } finally {
        local.managers.delete(manager)
      }
    }
  }

  const hideServerTools = (pi: ExtensionAPI, run: ServerRun, server: string): void => {
    const names = run.serverTools.get(server)
    if (!names || names.size === 0) return
    for (const name of names) {
      const definition = run.definitions.get(name)
      if (!definition) continue
      pi.registerTool({ ...definition, exposure: 'hidden' })
    }
    run.serverTools.set(server, new Set())
    // hidden 定义不再声明，也不应残留在 active set 中。
    const active = pi.getActiveTools()
    const filtered = active.filter((name) => !names.has(name))
    if (filtered.length !== active.length) pi.setActiveTools(filtered)
  }

  const registerServerTools = (
    pi: ExtensionAPI,
    run: ServerRun,
    manager: McpConnectionManager,
    snapshot: McpServerSnapshot,
  ): void => {
    const entry = run.entries.get(snapshot.name)
    if (!entry || !run.alive || run.manager !== manager) return
    const catalog = manager.getToolCatalog(snapshot.name)
    const description = entry.config.description?.trim()
    const signature = `${snapshot.toolRevision}|${snapshot.enabled}|${description ?? ''}`
    if (run.synced.get(snapshot.name) === signature) return
    const unavailable =
      !snapshot.enabled ||
      snapshot.state === 'closed' ||
      ((snapshot.state === 'failed' || snapshot.state === 'needs-auth') &&
        catalog.tools.length === 0)
    if (unavailable) {
      hideServerTools(pi, run, snapshot.name)
      run.synced.set(snapshot.name, signature)
      return
    }
    if (catalog.tools.length === 0 && !run.serverTools.get(snapshot.name)?.size) {
      run.synced.set(snapshot.name, signature)
      return
    }

    const namespace = {
      name: mcpNamespace(snapshot.name),
      aliases: [snapshot.name],
      ...(description ? { description } : {}),
      ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
    }
    // 同一目录内规范化后重名的工具全部加后缀；计数用 Map，整体 O(n)。
    const unique = new Map<string, (typeof catalog.tools)[number]>()
    for (const tool of catalog.tools) {
      if (!unique.has(tool.name)) unique.set(tool.name, tool)
    }
    const tools = [...unique.values()]
    const counts = new Map<string, number>()
    for (const tool of tools) {
      const plain = createMcpToolName(snapshot.name, tool.name)
      counts.set(plain, (counts.get(plain) ?? 0) + 1)
    }
    const previous = run.serverTools.get(snapshot.name) ?? new Set<string>()
    const current = new Set<string>()
    const indirect: string[] = []
    for (const tool of tools) {
      const owner = `${snapshot.name}\0${tool.name}`
      const name = createMcpToolName(snapshot.name, tool.name, (candidate) => {
        const existing = run.toolOwners.get(candidate)
        return (existing !== undefined && existing !== owner) || (counts.get(candidate) ?? 0) > 1
      })
      run.toolOwners.set(name, owner)
      current.add(name)
      const definition = createMcpToolDefinition({
        server: snapshot.name,
        tool,
        name,
        exposure: tool.exposure,
        namespace,
        timeoutMs: resolveMcpRequestTimeoutMs(entry.config.timeout),
        getClient: async (): Promise<McpToolCaller> => {
          if (!run.alive || run.manager !== manager) {
            throw new Error('MCP 连接管理器已关闭。')
          }
          return {
            callTool: (toolName, args, requestOptions) =>
              manager.callTool(snapshot.name, toolName, args, requestOptions),
          }
        },
        readableResources: () => manager.listResourceServers().includes(snapshot.name),
      })
      const wasDirect = run.definitions.get(name)?.exposure === 'direct'
      run.definitions.set(name, definition)
      pi.registerTool(definition)
      // tool_search 已加载的 deferred 工具保持声明；只撤下真实降级或 hidden。
      if (tool.exposure === 'hidden' || (wasDirect && toToolExposure(tool.exposure) !== 'direct')) {
        indirect.push(name)
      }
    }
    run.serverTools.set(snapshot.name, current)
    // 不能反注册：旧目录中已撤下的工具重新注册为 hidden，避免遗留声明。
    const hidden = new Set<string>()
    for (const name of previous) {
      if (current.has(name)) continue
      const definition = run.definitions.get(name)
      if (definition) {
        pi.registerTool({ ...definition, exposure: 'hidden' })
        hidden.add(name)
      }
    }
    const removed = [...indirect, ...hidden]
    if (removed.length > 0) {
      const filtered = new Set(removed)
      pi.setActiveTools(pi.getActiveTools().filter((name) => !filtered.has(name)))
    }
    run.synced.set(snapshot.name, signature)
  }

  const syncResourceTools = (pi: ExtensionAPI, run: ServerRun): void => {
    const manager = run.manager
    if (!manager || !run.alive) return
    const names = manager.listResourceServers()
    const exposures = new Set<McpExposure>()
    const snapshots = new Map(manager.snapshot().servers.map((server) => [server.name, server]))
    for (const name of names) {
      const server = snapshots.get(name)
      if (server) exposures.add(server.exposure)
    }
    // 资源工具采用所触达服务器的最宽 exposure；没有资源时 hidden。
    const next =
      (['direct', 'codemode', 'deferred'] as const).find((candidate) => exposures.has(candidate)) ??
      'hidden'
    if (run.resourceExposure === next) return
    const wasDirect = run.resourceExposure === 'direct'
    run.resourceExposure = next
    const definitions = createMcpResourceToolDefinitions({
      exposure: next,
      servers: () => resourceServerList(run),
    })
    for (const definition of definitions) pi.registerTool(definition)
    if (wasDirect && next !== 'direct') {
      const names = new Set(definitions.map((definition) => definition.name))
      pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)))
    }
  }

  const ensureDiscoveryActive = (pi: ExtensionAPI, run: ServerRun, ctx: ExtensionContext): void => {
    const exposures = new Set<McpExposure>()
    const snapshots = new Map(
      run.manager?.snapshot().servers.map((server) => [server.name, server]),
    )
    for (const entry of run.entries.values()) {
      const server = snapshots.get(entry.name)
      if (server ? !server.enabled : !isEnabled(entry)) continue
      exposures.add(server?.exposure ?? exposureOf(entry))
      for (const exposure of Object.values(entry.config.toolExposure ?? {})) exposures.add(exposure)
    }
    const needsCodemode = exposures.has('codemode')
    const needsToolSearch = exposures.has('deferred')
    if (!needsCodemode && !needsToolSearch) return
    const tools = pi.getAllTools()
    const hasReachingTool = (name: string) =>
      tools.some((tool) => tool.name === name && tool.reachesTools)
    const hasCodemode = hasReachingTool(CODEMODE_TOOL_NAME)
    const hasToolSearch = hasReachingTool(TOOL_SEARCH_TOOL_NAME)
    const active = pi.getActiveTools()
    const activate: string[] = []
    if (
      needsCodemode &&
      hasCodemode &&
      run.autoEnableCodemode &&
      !active.includes(CODEMODE_TOOL_NAME)
    ) {
      activate.push(CODEMODE_TOOL_NAME)
    }
    if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
      activate.push(TOOL_SEARCH_TOOL_NAME)
    }
    if (activate.length > 0) pi.setActiveTools([...active, ...activate])
    const reachable = [...active, ...activate]
    if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return
    if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return
    if (run.warnedUnreachable) return
    run.warnedUnreachable = true
    const reason =
      needsCodemode && hasCodemode && !run.autoEnableCodemode
        ? '（autoEnableCodemode 为 false）'
        : ''
    safeNotify(
      ctx,
      `MCP 工具只能经由 codemode 或 tool_search 调用，但两者都未激活${reason}；这些工具当前不可调用。`,
      'warning',
    )
  }

  const syncFromManager = (pi: ExtensionAPI, run: ServerRun): void => {
    const manager = run.manager
    if (!manager || !run.alive) return
    const snapshot = manager.snapshot()
    const seen = new Set<string>()
    for (const server of snapshot.servers) {
      seen.add(server.name)
      if (snapshot.closed || !server.enabled || server.state === 'closed') {
        hideServerTools(pi, run, server.name)
        run.synced.set(server.name, `${server.toolRevision}|disabled`)
        continue
      }
      registerServerTools(pi, run, manager, server)
    }
    for (const name of [...run.serverTools.keys()]) {
      if (!seen.has(name)) {
        hideServerTools(pi, run, name)
        run.synced.delete(name)
      }
    }
    syncResourceTools(pi, run)
    ensureDiscoveryActive(pi, run, run.ctx)
  }

  const renderSectionForRun = (run: ServerRun): string | undefined => {
    const manager = run.manager
    if (!manager || !run.alive) return undefined
    const snapshot = manager.snapshot()
    const listings: McpServerListing[] = []
    for (const server of snapshot.servers) {
      const entry = run.entries.get(server.name)
      if (!entry) continue
      const catalog = manager.getToolCatalog(server.name)
      listings.push({
        entry: {
          ...entry,
          config: { ...entry.config, enabled: server.enabled, exposure: server.exposure },
        },
        ...(catalog.instructions ? { connection: { instructions: catalog.instructions } } : {}),
      })
    }
    return renderMcpServersSection(listings)
  }

  const waitForDirectServers = async (run: ServerRun, ctx: ExtensionContext): Promise<void> => {
    if (run.waitedForStartup) return
    run.waitedForStartup = true
    const manager = run.manager
    if (!manager || !run.alive) return
    const names = [...run.entries.values()]
      .filter((entry) => isEnabled(entry) && hasDirectTools(entry))
      .map((entry) => entry.name)
    if (names.length === 0) return
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), startupWaitMs)
    timer.unref?.()
    try {
      const signal = combineSignals([run.controller.signal, timeout.signal, ctx.signal])
      await manager.waitForServers(names, signal ? { signal } : {})
      if (
        timeout.signal.aborted &&
        run.alive &&
        !run.controller.signal.aborted &&
        !ctx.signal?.aborted
      ) {
        safeNotify(ctx, 'MCP 服务器仍在连接；连接完成后其工具即可使用。', 'info')
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const waitForRelevantServers = async (
    run: ServerRun,
    pi: ExtensionAPI,
    event: { toolName: string; input?: unknown },
    ctx: ExtensionContext,
  ): Promise<void> => {
    const manager = run.manager
    if (!manager || !run.alive) return
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName)
    if (!tool) return
    const enabled = [...run.entries.values()].filter(isEnabled).map((entry) => entry.name)
    let waiting: string[] = []
    const reach = tool.reachesTools?.(event.input as Record<string, unknown>)
    if (reach !== undefined) {
      waiting = enabled.filter((name) => reachesServer(reach, name))
    } else if (MCP_RESOURCE_TOOL_NAMES.has(tool.name)) {
      waiting = enabled
    } else {
      const owner = run.toolOwners.get(event.toolName)?.split('\0', 1)[0]
      if (owner) waiting = enabled.filter((name) => name === owner)
    }
    if (waiting.length === 0) return
    const signal = combineSignals([run.controller.signal, ctx.signal])
    await manager.waitForServers(waiting, signal ? { signal } : {})
  }

  const formatStatus = (run: ServerRun | undefined): string => {
    if (!run) return 'MCP 尚未在当前会话初始化。'
    const manager = run.manager
    if (!manager) return 'MCP 尚未在当前会话初始化。'
    const snapshot = manager.snapshot()
    const lines: string[] = []
    if (snapshot.servers.length === 0) {
      lines.push('未配置 MCP 服务器。')
    } else {
      lines.push(`MCP 服务器（${snapshot.servers.length}）：`)
      for (const server of snapshot.servers) {
        const state = snapshot.closed ? '已关闭' : (STATE_LABELS[server.state] ?? server.state)
        const counts = [
          server.toolCount > 0 ? `${server.toolCount} 个工具` : undefined,
          server.hasResources ? '资源' : undefined,
        ].filter(Boolean)
        const scope = server.scope === 'extension' ? '扩展注册' : '配置'
        lines.push(
          `- ${server.name}：${state}${counts.length > 0 ? `，${counts.join('，')}` : ''}；exposure ${EXPOSURE_LABELS[server.exposure]}；${scope}`,
        )
        if (server.error) lines.push(`  ${server.error.message}`)
      }
    }
    if (run.overridden.length > 0) {
      lines.push(`扩展注册被配置覆盖：${run.overridden.join('，')}`)
    }
    const issues = run.config?.issues ?? []
    if (issues.length > 0) {
      lines.push('配置问题：')
      for (const issue of issues) lines.push(`- ${issue.message}`)
    }
    return lines.join('\n')
  }

  const extension: ExtensionFactory = (pi: ExtensionAPI) => {
    const local: FactoryContext = { alive: true, managers: new Set() }
    contexts.add(local)

    pi.registerCommand('mcp', {
      description: '查看 MCP 服务器状态摘要（不提供登录或管理界面）',
      handler: async (_args, ctx) => {
        safeNotify(ctx, formatStatus(local.run), 'info')
      },
    })

    pi.on('session_start', async (_event, ctx) => {
      if (closed || !local.alive) return
      contexts.add(local)
      await detachRun(local, local.run)
      if (closed || !local.alive) return
      const run: ServerRun = {
        alive: true,
        controller: new AbortController(),
        ctx,
        entries: new Map(),
        overridden: [],
        autoEnableCodemode: true,
        waitedForStartup: false,
        warnedUnreachable: false,
        synced: new Map(),
        serverTools: new Map(),
        definitions: new Map(),
        toolOwners: new Map(),
      }
      local.run = run
      // 资源工具预注册为 hidden：即使在首次资源调用时服务器仍在连接，工具也已存在，
      // tool_call 才能按 reachesTools 等待相关连接。
      run.resourceExposure = 'hidden'
      for (const definition of createMcpResourceToolDefinitions({
        exposure: 'hidden',
        servers: () => resourceServerList(run),
      })) {
        pi.registerTool(definition)
      }

      let loaded: LoadedMcpConfig
      try {
        loaded = await (options.loadConfig ?? loadMcpConfig)({
          agentDir: options.agentDir,
          cwd: ctx.cwd,
          projectTrusted: options.getProjectTrusted(),
        })
      } catch {
        safeNotify(ctx, 'MCP 配置加载失败；本次会话未连接服务器。', 'error')
        return
      }
      if (!run.alive || closed || local.run !== run) return
      run.config = loaded
      run.autoEnableCodemode = loaded.autoEnableCodemode ?? true
      const registered = registeredEntries(pi.getMcpServers(), loaded.servers)
      run.overridden = registered.overridden
      const entries = [...loaded.servers, ...registered.entries]
      run.entries = new Map(entries.map((entry) => [entry.name, entry]))

      let manager: McpConnectionManager
      try {
        manager = createMcpConnectionManager({
          cwd: ctx.cwd,
          servers: entries,
          ...(options.createTransport ? { createTransport: options.createTransport } : {}),
          ...(options.createAuthProvider ? { createAuthProvider: options.createAuthProvider } : {}),
          // 每次请求读取当前 provider token，不缓存。
          providerToken: async (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
          ...(options.env ? { env: options.env } : {}),
          ...(options.runCommand ? { runCommand: options.runCommand } : {}),
          ...(options.onLog ? { onLog: options.onLog } : {}),
        })
      } catch {
        safeNotify(ctx, 'MCP 服务器条目无效；本次会话未连接服务器。', 'error')
        return
      }
      run.manager = manager
      local.managers.add(manager)
      activeManager = manager
      run.unsubscribe = manager.subscribe(() => syncFromManager(pi, run))
      syncFromManager(pi, run)
      ensureDiscoveryActive(pi, run, ctx)
      // 连接在后台进行；首次 direct 等待与工具注册由事件驱动。
      void manager.start().catch(() => undefined)
    })

    pi.on('mcp_servers_change', async (event, ctx) => {
      const run = local.run
      const manager = run?.manager
      const config = run?.config
      if (!run?.alive || !manager || !config || closed) return
      const registered = registeredEntries(event.servers, config.servers)
      const previousOverridden = run.overridden
      const previousEntries = run.entries
      run.overridden = registered.overridden
      const entries = [...config.servers, ...registered.entries]
      // 先更新桥接条目，manager 同步发布时即可撤下移除项。
      run.entries = new Map(entries.map((entry) => [entry.name, entry]))
      try {
        await manager.setServers(entries)
      } catch {
        run.entries = previousEntries
        run.overridden = previousOverridden
        if (run.alive) safeNotify(ctx, 'MCP 扩展注册更新失败；保留当前已连接服务器。', 'error')
        return
      }
      if (!run.alive) return
      syncFromManager(pi, run)
      ensureDiscoveryActive(pi, run, ctx)
    })

    pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx) => {
      const run = local.run
      if (!run?.alive) return
      await waitForDirectServers(run, ctx)
      if (!run.alive) return
      const section = renderSectionForRun(run)
      const { sections } = event.systemPromptOptions
      if (section) sections[MCP_SERVERS_SECTION] = section
      else delete sections[MCP_SERVERS_SECTION]
    })

    pi.on('tool_call', async (event, ctx) => {
      const run = local.run
      if (!run?.alive) return
      await waitForRelevantServers(run, pi, event, ctx)
    })

    pi.on('session_shutdown', async () => {
      const run = local.run
      local.run = undefined
      await detachRun(local, run)
      contexts.delete(local)
    })
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    // 同步禁止晚结果与后续 session_start。
    closed = true
    const managers = new Set<McpConnectionManager>()
    for (const local of contexts) {
      local.alive = false
      const run = local.run
      local.run = undefined
      if (run) {
        run.alive = false
        run.unsubscribe?.()
        run.unsubscribe = undefined
        run.controller.abort()
        if (run.manager) managers.add(run.manager)
        run.manager = undefined
      }
      for (const manager of local.managers) managers.add(manager)
      local.managers.clear()
    }
    activeManager = undefined
    closePromise = Promise.allSettled([...managers].map((manager) => manager.close())).then(
      () => undefined,
    )
    return closePromise
  }

  return {
    extension,
    getManager: () => (closed ? undefined : activeManager),
    close,
  }
}
