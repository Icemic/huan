/**
 * MCP 连接管理器（G1.4d2a）。
 *
 * 每个实例只服务一个会话：构造只校验并克隆已通过配置校验/信任门控的条目，
 * 不读盘、不解析值、不创建 transport。显式 `start()` 后连接启用的服务器；
 * 管理操作串行，禁用/关闭会立即失效并中止进行中的 opening。
 *
 * 对外快照只暴露身份、scope/source、启停/exposure、数量与受控错误码；
 * 工具目录与 instructions 通过独立的 Node 内部查询提供，供后续 Pi 桥接使用。
 * 临时启停与 exposure 只修改实例状态，持久化留给后续阶段。
 */

import { resolve } from 'node:path'
import type { McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent'
import type {
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  McpRequestOptions,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ToolAnnotations,
  ToolExecution,
} from '@earendil-works/pi-mcp'
import type { McpConfigScope, McpServerEntry } from './config.js'
import {
  getMcpToolExposure,
  isValidMcpServerName,
  MCP_EXPOSURES,
  mcpNamespace,
  validateMcpServerConfig,
} from './config.js'
import type { McpCommandRunner } from './config-values.js'
import {
  type McpAuthProviderFactory,
  type McpConnectionError,
  type McpConnectionState,
  McpOperationError,
  McpServerConnection,
  type McpTransportFactory,
} from './connection.js'

/** 单服务器管理快照；不含配置原文、URL、env、headers、stderr 或原始异常。 */
export interface McpServerSnapshot {
  name: string
  scope: McpConfigScope
  source: string
  override?: string
  enabled: boolean
  exposure: McpExposure
  state: McpConnectionState | 'disabled'
  toolCount: number
  hasResources: boolean
  toolRevision: number
  error?: McpConnectionError
}

/** 管理器快照。每次读取/发布都是独立副本。 */
export interface McpConnectionManagerSnapshot {
  revision: number
  started: boolean
  closed: boolean
  servers: readonly McpServerSnapshot[]
}

/** 目录查询里的单个工具；服务端元数据只传递，不执行。 */
export interface McpToolCatalogEntry {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: ToolAnnotations
  execution?: ToolExecution
  _meta?: Record<string, unknown>
  exposure: McpExposure
}

/** 单个服务器的工具目录与版本。 */
export interface McpToolCatalog {
  server: string
  revision: number
  tools: readonly McpToolCatalogEntry[]
  instructions?: string
}

/** 管理器构造选项。 */
export interface McpConnectionManagerOptions {
  cwd: string
  servers: readonly McpServerEntry[]
  createTransport?: McpTransportFactory
  createAuthProvider?: McpAuthProviderFactory
  providerToken?: (provider: string) => Promise<string | undefined>
  env?: Readonly<Record<string, string | undefined>>
  runCommand?: McpCommandRunner
}

/** 管理器输入的受控错误。 */
export type McpManagerInputErrorCode = 'invalid-input' | 'namespace-collision'

export class McpManagerInputError extends Error {
  readonly code: McpManagerInputErrorCode

  constructor(code: McpManagerInputErrorCode, message: string) {
    super(message)
    this.name = 'McpManagerInputError'
    this.code = code
  }
}

export type McpManagerListener = (snapshot: McpConnectionManagerSnapshot) => void

interface Slot {
  entry: McpServerEntry
  /** 生命周期代次；禁用/重连等操作会递增，使旧操作失效。 */
  epoch: number
  catalogRevision: number
  connection?: McpServerConnection
  closing?: Promise<void>
  connectPromise?: Promise<void>
}

function inputError(message: string): McpManagerInputError {
  return new McpManagerInputError('invalid-input', message)
}

function isScope(value: unknown): value is McpConfigScope {
  return value === 'user' || value === 'project'
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && MCP_EXPOSURES.includes(value as McpExposure)
}

function cloneEntry(entry: McpServerEntry): McpServerEntry {
  try {
    return structuredClone(entry)
  } catch {
    throw inputError('MCP 服务器条目包含不可克隆的值。')
  }
}

/** 校验并转换一个输入条目；错误消息不回显配置值。 */
function validateEntry(raw: unknown): McpServerEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw inputError('MCP 服务器条目必须是对象。')
  }
  const entry = raw as Partial<McpServerEntry>
  if (typeof entry.name !== 'string' || !isValidMcpServerName(entry.name)) {
    throw inputError('MCP 服务器名称无效。')
  }
  if (typeof entry.source !== 'string' || !entry.source) {
    throw inputError(`MCP 服务器 "${entry.name}" 缺少来源。`)
  }
  if (!isScope(entry.scope)) {
    throw inputError(`MCP 服务器 "${entry.name}" 的 scope 无效。`)
  }
  if (entry.override !== undefined && (typeof entry.override !== 'string' || !entry.override)) {
    throw inputError(`MCP 服务器 "${entry.name}" 的 override 无效。`)
  }
  const config = validateMcpServerConfig(entry.name, entry.config)
  if (typeof config === 'string') throw inputError(config)
  return cloneEntry({
    name: entry.name,
    config,
    source: entry.source,
    scope: entry.scope,
    ...(entry.override ? { override: entry.override } : {}),
  })
}

/**
 * 每会话独立的 MCP 连接管理器。
 *
 * 管理操作（重连/启用）共享一个串行队列；禁用与关闭不等队列，立即关闭
 * 连接并递增代次，使排队操作和晚到结果失效。
 */
export class McpConnectionManager {
  readonly cwd: string
  private readonly options: McpConnectionManagerOptions
  private readonly slots: Slot[]
  private readonly slotsByName = new Map<string, Slot>()
  private readonly listeners = new Set<McpManagerListener>()
  private revisionValue = 0
  private startedValue = false
  private closedValue = false
  private management: Promise<void> = Promise.resolve()
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined

  constructor(options: McpConnectionManagerOptions) {
    if (typeof options.cwd !== 'string' || !options.cwd) {
      throw inputError('MCP 连接管理器需要 cwd。')
    }
    if (!Array.isArray(options.servers)) {
      throw inputError('MCP 服务器列表无效。')
    }
    this.options = {
      ...options,
      ...(options.env ? { env: { ...options.env } } : {}),
    }
    this.cwd = resolve(options.cwd)
    const namespaces = new Map<string, string>()
    const slots: Slot[] = []
    for (const raw of options.servers) {
      const entry = validateEntry(raw)
      const namespace = mcpNamespace(entry.name)
      const existing = namespaces.get(namespace)
      if (existing !== undefined) {
        throw new McpManagerInputError(
          'namespace-collision',
          `MCP 服务器 "${entry.name}" 与 "${existing}" 的 namespace 冲突。`,
        )
      }
      namespaces.set(namespace, entry.name)
      const slot: Slot = { entry, epoch: 0, catalogRevision: 0 }
      slots.push(slot)
      this.slotsByName.set(entry.name, slot)
    }
    this.slots = slots
  }

  /** 显式启动；所有启用服务器的初始连接尝试都落定后返回。 */
  start(): Promise<void> {
    if (this.closedValue) return Promise.reject(new McpOperationError('manager-closed'))
    if (this.startPromise) return this.startPromise
    this.startedValue = true
    const starts = this.slots.map((slot) => {
      if (slot.entry.config.enabled === false) return Promise.resolve()
      const epoch = ++slot.epoch
      return this.openSlot(slot, epoch)
    })
    this.startPromise = Promise.allSettled(starts).then(() => {
      if (!this.closedValue) this.publish()
    })
    this.publish()
    return this.startPromise
  }

  snapshot(): McpConnectionManagerSnapshot {
    return {
      revision: this.revisionValue,
      started: this.startedValue,
      closed: this.closedValue,
      servers: this.slots.map((slot) => this.buildServerSnapshot(slot)),
    }
  }

  subscribe(listener: McpManagerListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 独立工具目录查询；返回副本，调用方不能改到内部目录。 */
  getToolCatalog(name: string): McpToolCatalog {
    const slot = this.getSlot(name)
    if (this.closedValue || slot.entry.config.enabled === false || !slot.connection) {
      return { server: name, revision: slot.catalogRevision, tools: [] }
    }
    const catalog = slot.connection.getToolCatalog()
    const tools = catalog.tools.map((tool) => ({
      ...tool,
      exposure: getMcpToolExposure(slot.entry.config, tool.name),
    }))
    return {
      server: name,
      revision: slot.catalogRevision,
      tools,
      ...(catalog.instructions === undefined ? {} : { instructions: catalog.instructions }),
    }
  }

  /** 单调目录版本，禁用/关闭/重建与 exposure 变化也会使旧目录失效。 */
  getToolCatalogRevision(name: string): number {
    const slot = this.getSlot(name)
    return slot.catalogRevision
  }

  /** 供桥接判断资源可用性：启用、未关闭、已确认 resources 能力且 server exposure 不是 hidden。 */
  listResourceServers(): readonly string[] {
    if (this.closedValue) return []
    return this.slots
      .filter((slot) => {
        if (slot.entry.config.enabled === false) return false
        if ((slot.entry.config.exposure ?? 'codemode') === 'hidden') return false
        const snapshot = slot.connection?.getSnapshot()
        return snapshot?.state === 'connected' && snapshot.hasResources
      })
      .map((slot) => slot.entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  /** 显式重连；与启用操作串行，禁用/关闭可立即中止。 */
  reconnect(name: string): Promise<void> {
    const slot = this.getSlot(name)
    if (this.closedValue) return Promise.reject(new McpOperationError('manager-closed'))
    if (!this.startedValue) return Promise.reject(new McpOperationError('not-started'))
    if (slot.entry.config.enabled === false) {
      return Promise.reject(new McpOperationError('server-disabled'))
    }
    const epoch = ++slot.epoch
    return this.enqueue(async () => {
      if (!this.canOpen(slot, epoch)) return
      await slot.closing
      if (!this.canOpen(slot, epoch)) return
      const previous = slot.connection
      if (previous) await this.closeSlotConnection(slot, previous)
      if (!this.canOpen(slot, epoch)) return
      const connection = await this.ensureConnection(slot)
      const reconnecting = connection.open()
      slot.connectPromise = reconnecting
      try {
        await reconnecting
      } finally {
        if (slot.connectPromise === reconnecting) slot.connectPromise = undefined
      }
    })
  }

  /** 临时启用/禁用；禁用立即关闭连接，启用排队等待旧连接收尾。 */
  setEnabled(name: string, enabled: boolean): Promise<void> {
    const slot = this.getSlot(name)
    if (this.closedValue) return Promise.reject(new McpOperationError('manager-closed'))
    if (typeof enabled !== 'boolean') {
      return Promise.reject(inputError('MCP enabled 必须是布尔值。'))
    }
    const currentlyEnabled = slot.entry.config.enabled !== false
    if (currentlyEnabled === enabled) return slot.closing ?? Promise.resolve()
    const epoch = ++slot.epoch
    slot.entry.config = { ...slot.entry.config, enabled } as McpServerConfig
    slot.catalogRevision += 1
    this.publish()

    if (!enabled) {
      const connection = slot.connection
      if (!connection) return Promise.resolve()
      // 立即失效并关闭；连接会中止进行中的 opening。
      const closePromise = connection.close()
      const closing = Promise.allSettled([closePromise, slot.connectPromise]).then(() => undefined)
      slot.closing = closing
      void closing.finally(() => {
        if (slot.closing === closing) slot.closing = undefined
        if (slot.connection === connection) slot.connection = undefined
        this.publish()
      })
      return closing
    }

    if (!this.startedValue) return Promise.resolve()
    return this.enqueue(async () => {
      if (!this.canOpen(slot, epoch)) return
      await slot.closing
      if (!this.canOpen(slot, epoch)) return
      await this.openSlot(slot, epoch)
    })
  }

  /** 临时修改 exposure；只改实例状态，不重连。 */
  setExposure(name: string, exposure: McpExposure): void {
    const slot = this.getSlot(name)
    if (this.closedValue) throw new McpOperationError('manager-closed')
    if (!isExposure(exposure)) throw inputError('MCP exposure 无效。')
    if ((slot.entry.config.exposure ?? 'codemode') === exposure) return
    slot.entry.config = { ...slot.entry.config, exposure } as McpServerConfig
    slot.catalogRevision += 1
    this.publish()
  }

  /** Node 内部工具调用入口；hidden/disabled 的普通调用不会触发连接。 */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
    options?: McpRequestOptions,
  ): Promise<CallToolResult> {
    const slot = this.assertCallable(server)
    if (getMcpToolExposure(slot.entry.config, tool) === 'hidden') {
      throw new McpOperationError('tool-hidden')
    }
    const connection = await this.ensureConnection(slot)
    this.assertCallable(server)
    if (getMcpToolExposure(slot.entry.config, tool) === 'hidden') {
      throw new McpOperationError('tool-hidden')
    }
    return connection.callTool(tool, args, options)
  }

  async listResources(
    server: string,
    cursor?: string,
    options?: McpRequestOptions,
  ): Promise<ListResourcesResult> {
    const slot = this.assertResourceServer(server)
    return (await this.ensureConnection(slot)).listResourcesPage(cursor, options)
  }

  async listAllResources(server: string, options?: McpRequestOptions): Promise<Resource[]> {
    const slot = this.assertResourceServer(server)
    return (await this.ensureConnection(slot)).listAllResources(options)
  }

  async listResourceTemplates(
    server: string,
    cursor?: string,
    options?: McpRequestOptions,
  ): Promise<ListResourceTemplatesResult> {
    const slot = this.assertResourceServer(server)
    return (await this.ensureConnection(slot)).listResourceTemplatesPage(cursor, options)
  }

  async listAllResourceTemplates(
    server: string,
    options?: McpRequestOptions,
  ): Promise<ResourceTemplate[]> {
    const slot = this.assertResourceServer(server)
    return (await this.ensureConnection(slot)).listAllResourceTemplates(options)
  }

  async readResource(
    server: string,
    uri: string,
    options?: McpRequestOptions,
  ): Promise<ReadResourceResult> {
    const slot = this.assertResourceServer(server)
    return (await this.ensureConnection(slot)).readResource(uri, options)
  }

  /** 终态关闭；等待所有连接、transport close promise 与后台任务。 */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closedValue = true
      this.closePromise = Promise.resolve().then(() => this.closeInternal())
      for (const slot of this.slots) void slot.connection?.close()
    }
    return this.closePromise
  }

  private closeInternal(): Promise<void> {
    this.closedValue = true
    this.publish()
    const connections = this.slots.flatMap((slot) => (slot.connection ? [slot.connection] : []))
    // 立即关闭，不能等管理队列。
    const closing = connections.map((connection) => connection.close())
    return Promise.allSettled([this.management, ...closing])
      .then(async () => {
        // 兜底：排队操作可能刚创建了连接。
        for (let round = 0; round < 3; round += 1) {
          const remaining = this.slots.flatMap((slot) => (slot.connection ? [slot.connection] : []))
          await Promise.allSettled(remaining.map((connection) => connection.close()))
          if (remaining.length === 0) break
        }
      })
      .then(() => undefined)
  }

  private canOpen(slot: Slot, epoch: number): boolean {
    return (
      !this.closedValue &&
      this.startedValue &&
      slot.epoch === epoch &&
      slot.entry.config.enabled !== false
    )
  }

  private async openSlot(slot: Slot, epoch: number): Promise<void> {
    if (!this.canOpen(slot, epoch)) return
    await slot.closing
    if (!this.canOpen(slot, epoch)) return
    const connection = await this.ensureConnection(slot)
    const opening = connection.open()
    slot.connectPromise = opening
    try {
      await opening
    } finally {
      if (slot.connectPromise === opening) slot.connectPromise = undefined
    }
    if (!this.canOpen(slot, epoch) && (this.closedValue || slot.entry.config.enabled === false)) {
      await this.closeSlotConnection(slot, connection)
    }
  }

  private async ensureConnection(slot: Slot): Promise<McpServerConnection> {
    if (this.closedValue) throw new McpOperationError('manager-closed')
    if (slot.entry.config.enabled === false) throw new McpOperationError('server-disabled')
    // closing 优先于可见状态；close 的同步失效可能早于状态通知。
    if (slot.closing) await slot.closing.catch(() => undefined)
    this.assertCallable(slot.entry.name)
    if (slot.connection && slot.connection.getSnapshot().state !== 'closed') {
      return slot.connection
    }
    let observedCatalogRevision = 0
    const connection = new McpServerConnection({
      entry: slot.entry,
      cwd: this.cwd,
      ...(this.options.createTransport ? { createTransport: this.options.createTransport } : {}),
      ...(this.options.createAuthProvider
        ? { createAuthProvider: this.options.createAuthProvider }
        : {}),
      ...(this.options.providerToken ? { providerToken: this.options.providerToken } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.runCommand ? { runCommand: this.options.runCommand } : {}),
      assertRequestAllowed: (tool) => {
        this.assertCallable(slot.entry.name)
        if (tool === undefined) this.assertResourceServer(slot.entry.name)
        else if (getMcpToolExposure(slot.entry.config, tool) === 'hidden') {
          throw new McpOperationError('tool-hidden')
        }
      },
      onChange: (changed) => {
        if (changed.catalogRevision !== observedCatalogRevision) {
          observedCatalogRevision = changed.catalogRevision
          slot.catalogRevision += 1
        }
        this.publish()
      },
    })
    slot.connection = connection
    return connection
  }

  private closeSlotConnection(slot: Slot, connection: McpServerConnection): Promise<void> {
    const closing = connection.close()
    slot.closing = closing
    void closing.finally(() => {
      if (slot.closing === closing) slot.closing = undefined
      if (slot.connection === connection) slot.connection = undefined
      this.publish()
    })
    return closing
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.management.then(task, task)
    this.management = run.catch(() => undefined)
    return run
  }

  private assertCallable(name: string): Slot {
    const slot = this.getSlot(name)
    if (this.closedValue) throw new McpOperationError('manager-closed')
    if (!this.startedValue) throw new McpOperationError('not-started')
    if (slot.entry.config.enabled === false) throw new McpOperationError('server-disabled')
    return slot
  }

  private assertResourceServer(name: string): Slot {
    const slot = this.assertCallable(name)
    if ((slot.entry.config.exposure ?? 'codemode') === 'hidden') {
      throw new McpOperationError('server-hidden')
    }
    return slot
  }

  private getSlot(name: string): Slot {
    const slot = this.slotsByName.get(name)
    if (!slot) throw new McpOperationError('unknown-server')
    return slot
  }

  private buildServerSnapshot(slot: Slot): McpServerSnapshot {
    const enabled = slot.entry.config.enabled !== false
    const connection = slot.connection?.getSnapshot()
    const includeConnection = enabled && !this.closedValue && connection !== undefined
    const state: McpConnectionState | 'disabled' = this.closedValue
      ? 'closed'
      : !enabled
        ? 'disabled'
        : (connection?.state ?? 'disconnected')
    return {
      name: slot.entry.name,
      scope: slot.entry.scope,
      source: slot.entry.source,
      ...(slot.entry.override ? { override: slot.entry.override } : {}),
      enabled,
      exposure: slot.entry.config.exposure ?? 'codemode',
      state,
      toolCount: includeConnection ? connection.toolCount : 0,
      hasResources: includeConnection ? connection.hasResources : false,
      toolRevision: slot.catalogRevision,
      ...(includeConnection && connection.error ? { error: { ...connection.error } } : {}),
    }
  }

  private publish(): void {
    this.revisionValue += 1
    if (this.listeners.size === 0) return
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot())
      } catch {
        // 监听者异常不阻止其他监听者，也不影响管理器状态。
      }
    }
  }
}

/** 创建每会话独立的连接管理器；构造无 I/O。 */
export function createMcpConnectionManager(
  options: McpConnectionManagerOptions,
): McpConnectionManager {
  return new McpConnectionManager(options)
}
