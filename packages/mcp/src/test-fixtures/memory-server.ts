// 官方 testing 内存 transport 上的最小 MCP 服务器，用于确定性定序/竞态测试。

import {
  type CallToolResult,
  JSON_RPC_ERROR_CODES,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type McpTransport,
  type ReadResourceResult,
  type Tool,
} from '@earendil-works/pi-mcp'
import { createInMemoryTransportPair, type InMemoryTransport } from '@earendil-works/pi-mcp/testing'

/** 让测试处理器返回 JSON-RPC 错误。 */
export class MemoryRpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'MemoryRpcError'
    this.code = code
  }
}

export interface MemoryMcpServerOptions {
  tools?: Tool[]
  instructions?: string
  capabilities?: Record<string, unknown>
  initializeDelayMs?: number
  initializeHandler?: (
    request: JsonRpcRequest,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  listToolsHandler?: (
    call: number,
    cursor: string | undefined,
  ) => Promise<{ tools: Tool[]; nextCursor?: string }> | { tools: Tool[]; nextCursor?: string }
  callToolHandler?: (
    name: string,
    args: Record<string, unknown>,
    request: JsonRpcRequest,
    server: MemoryMcpServer,
  ) => Promise<CallToolResult> | CallToolResult
  resourcesHandler?: (
    cursor: string | undefined,
  ) => Promise<ListResourcesResult> | ListResourcesResult
  templatesHandler?: (
    cursor: string | undefined,
  ) => Promise<ListResourceTemplatesResult> | ListResourceTemplatesResult
  readResourceHandler?: (uri: string) => Promise<ReadResourceResult> | ReadResourceResult
}

const ECHO_TOOL: Tool = {
  name: 'echo',
  description: 'Echo text',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    additionalProperties: false,
  },
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

/** 记录请求并应答的内存 MCP 服务器。 */
export class MemoryMcpServer {
  readonly transport: InMemoryTransport
  readonly clientTransport: McpTransport
  tools: Tool[]
  instructions: string | undefined
  capabilities: Record<string, unknown>
  initializeCount = 0
  toolListCount = 0
  readonly methods: string[] = []
  readonly notifications: JsonRpcNotification[] = []
  readonly cancelled: JsonRpcId[] = []
  readonly toolCalls: { name: string; args: Record<string, unknown> }[] = []
  initializeDelayMs: number
  initializeHandler: MemoryMcpServerOptions['initializeHandler']
  listToolsHandler: MemoryMcpServerOptions['listToolsHandler']
  callToolHandler: MemoryMcpServerOptions['callToolHandler']
  resourcesHandler: MemoryMcpServerOptions['resourcesHandler']
  templatesHandler: MemoryMcpServerOptions['templatesHandler']
  readResourceHandler: MemoryMcpServerOptions['readResourceHandler']

  private constructor(options: MemoryMcpServerOptions) {
    const pair = createInMemoryTransportPair()
    this.transport = pair.server
    this.clientTransport = pair.client
    this.tools = options.tools ?? [ECHO_TOOL]
    this.instructions = options.instructions
    this.capabilities = options.capabilities ?? {
      tools: { listChanged: true },
      resources: {},
    }
    this.initializeDelayMs = options.initializeDelayMs ?? 0
    this.initializeHandler = options.initializeHandler
    this.listToolsHandler = options.listToolsHandler
    this.callToolHandler = options.callToolHandler
    this.resourcesHandler = options.resourcesHandler
    this.templatesHandler = options.templatesHandler
    this.readResourceHandler = options.readResourceHandler
  }

  static async create(options: MemoryMcpServerOptions = {}): Promise<MemoryMcpServer> {
    const server = new MemoryMcpServer(options)
    server.transport.onMessage((message) => {
      void server.handle(message).catch(() => undefined)
    })
    await server.transport.start()
    return server
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    }
    this.notifications.push(notification)
    await this.transport.send(notification)
  }

  async close(): Promise<void> {
    await this.transport.close()
  }

  private async sendResponse(message: JsonRpcRequest, result: unknown): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', id: message.id, result })
  }

  private async sendError(message: JsonRpcRequest, error: unknown): Promise<void> {
    if (error instanceof MemoryRpcError) {
      await this.transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error.code, message: error.message },
      })
      return
    }
    await this.transport.send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: JSON_RPC_ERROR_CODES.internalError, message: 'memory fixture failure' },
    })
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    if (!('method' in message)) return
    if (!('id' in message)) {
      if (message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId
        if (requestId !== undefined) this.cancelled.push(requestId)
      }
      return
    }
    this.methods.push(message.method)
    try {
      await this.sendResponse(message, await this.dispatch(message))
    } catch (error) {
      await this.sendError(message, error)
    }
  }

  private async dispatch(message: JsonRpcRequest): Promise<unknown> {
    const params = (message.params ?? {}) as Record<string, unknown>
    switch (message.method) {
      case 'initialize': {
        this.initializeCount += 1
        if (this.initializeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.initializeDelayMs))
        }
        if (this.initializeHandler) return this.initializeHandler(message)
        return {
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
          capabilities: this.capabilities,
          serverInfo: { name: 'memory', version: '1.0.0' },
          ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
        }
      }
      case 'ping':
        return {}
      case 'tools/list': {
        this.toolListCount += 1
        const cursor = typeof params.cursor === 'string' ? params.cursor : undefined
        if (this.listToolsHandler) return this.listToolsHandler(this.toolListCount, cursor)
        return { tools: this.tools }
      }
      case 'tools/call': {
        const name = String(params.name)
        const args = (params.arguments ?? {}) as Record<string, unknown>
        this.toolCalls.push({ name, args })
        if (this.callToolHandler) return this.callToolHandler(name, args, message, this)
        return textResult(`echo:${String(args.text ?? '')}`)
      }
      case 'resources/list': {
        if (!this.resourcesHandler) {
          throw new MemoryRpcError(JSON_RPC_ERROR_CODES.methodNotFound, 'Method not found')
        }
        return this.resourcesHandler(typeof params.cursor === 'string' ? params.cursor : undefined)
      }
      case 'resources/templates/list': {
        if (!this.templatesHandler) {
          throw new MemoryRpcError(JSON_RPC_ERROR_CODES.methodNotFound, 'Method not found')
        }
        return this.templatesHandler(typeof params.cursor === 'string' ? params.cursor : undefined)
      }
      case 'resources/read': {
        if (!this.readResourceHandler) {
          throw new MemoryRpcError(JSON_RPC_ERROR_CODES.methodNotFound, 'Method not found')
        }
        return this.readResourceHandler(String(params.uri))
      }
      default:
        throw new MemoryRpcError(JSON_RPC_ERROR_CODES.methodNotFound, 'Method not found')
    }
  }
}

export async function createMemoryMcpServer(
  options: MemoryMcpServerOptions = {},
): Promise<MemoryMcpServer> {
  return MemoryMcpServer.create(options)
}
