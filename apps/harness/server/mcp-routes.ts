/**
 * MCP 配置、管理与认证 HTTP 路由（G1.4d3）。
 *
 * 所有请求沿用 `/api/pi/*` 的 Host/Origin/token 校验；本模块只负责输入形状、
 * 请求体上限与 typed 结果映射，不复制核心的信任/身份判断。配置正文上限
 * 768KiB（正文本身 512KiB），管理/认证请求 16KiB；无 Content-Length 时由
 * Hono bodyLimit 对实际读取的流继续限流。
 */
import type {
  HarnessClient,
  HarnessMcpAuthStartInput,
  HarnessMcpConfigSaveInput,
  HarnessMcpDetailSection,
  HarnessMcpDetailsInput,
  HarnessMcpExposure,
  HarnessMcpManageAction,
  HarnessMcpManageInput,
  HarnessMcpTargetInput,
} from '@huan/protocol'
import {
  HARNESS_MCP_AUTH_PROMPT_MAX_CHARS,
  HARNESS_MCP_CONFIG_BODY_LIMIT_BYTES,
  HARNESS_MCP_CONFIG_CONTENT_MAX_BYTES,
  HARNESS_MCP_SMALL_BODY_LIMIT_BYTES,
} from '@huan/protocol'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

type McpRouteClient = Pick<
  HarnessClient,
  | 'getMcp'
  | 'getMcpDetails'
  | 'getMcpConfig'
  | 'saveMcpConfig'
  | 'manageMcp'
  | 'getMcpAuth'
  | 'startMcpLogin'
  | 'respondMcpAuth'
  | 'cancelMcpAuth'
  | 'logoutMcp'
>

const isExposure = (value: unknown): value is HarnessMcpExposure =>
  value === 'codemode' || value === 'deferred' || value === 'direct' || value === 'hidden'

const isDetailSection = (value: unknown): value is HarnessMcpDetailSection =>
  value === 'tools' || value === 'resources' || value === 'resource-templates'

/** 解析 query/body 中的目标：threadId、workspacePath、global 恰好一个。 */
function parseTarget(
  threadId: string | undefined,
  workspacePath: string | undefined,
  global: string | undefined,
  allowGlobal = false,
): HarnessMcpTargetInput | undefined {
  const wantsGlobal = global === 'true'
  if (global !== undefined && !wantsGlobal) return undefined
  const hasThread = typeof threadId === 'string' && threadId.trim().length > 0
  const hasPath = typeof workspacePath === 'string' && workspacePath.trim().length > 0
  if (wantsGlobal) {
    if (!allowGlobal || hasThread || hasPath) return undefined
    return { global: true }
  }
  if (hasThread === hasPath) return undefined
  return hasThread ? { threadId: threadId?.trim() } : { workspacePath: workspacePath?.trim() }
}

function parseTargetObject(value: unknown, allowGlobal = false): HarnessMcpTargetInput | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const target = value as { threadId?: unknown; workspacePath?: unknown; global?: unknown }
  if (target.threadId !== undefined && typeof target.threadId !== 'string') return undefined
  if (target.workspacePath !== undefined && typeof target.workspacePath !== 'string')
    return undefined
  if (target.global !== undefined && typeof target.global !== 'boolean') return undefined
  return parseTarget(
    target.threadId,
    target.workspacePath,
    target.global === true ? 'true' : undefined,
    allowGlobal,
  )
}

function parseManageAction(value: unknown): HarnessMcpManageAction | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const action = value as {
    type?: unknown
    enabled?: unknown
    exposure?: unknown
    tool?: unknown
  }
  if (action.type === 'setEnabled') {
    return typeof action.enabled === 'boolean'
      ? { type: 'setEnabled', enabled: action.enabled }
      : undefined
  }
  if (action.type === 'setExposure') {
    return isExposure(action.exposure)
      ? { type: 'setExposure', exposure: action.exposure }
      : undefined
  }
  if (action.type === 'setToolExposure') {
    if (typeof action.tool !== 'string' || !action.tool) return undefined
    if (action.exposure !== null && !isExposure(action.exposure)) return undefined
    return {
      type: 'setToolExposure',
      tool: action.tool,
      exposure: action.exposure as HarnessMcpExposure | null,
    }
  }
  if (action.type === 'reconnect') return { type: 'reconnect' }
  return undefined
}

function parseManageInput(value: unknown): HarnessMcpManageInput | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const body = value as {
    target?: unknown
    expectedRuntimeId?: unknown
    server?: unknown
    expectedIdentity?: unknown
    action?: unknown
  }
  const target = parseTargetObject(body.target)
  const action = parseManageAction(body.action)
  if (
    !target ||
    !action ||
    typeof body.expectedRuntimeId !== 'string' ||
    !body.expectedRuntimeId ||
    typeof body.server !== 'string' ||
    !body.server ||
    typeof body.expectedIdentity !== 'string' ||
    !body.expectedIdentity
  ) {
    return undefined
  }
  return {
    target,
    expectedRuntimeId: body.expectedRuntimeId,
    server: body.server,
    expectedIdentity: body.expectedIdentity,
    action,
  }
}

function parseAuthStartInput(value: unknown): HarnessMcpAuthStartInput | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const body = value as {
    target?: unknown
    expectedRuntimeId?: unknown
    server?: unknown
    expectedIdentity?: unknown
  }
  const target = parseTargetObject(body.target)
  if (
    !target ||
    typeof body.expectedRuntimeId !== 'string' ||
    !body.expectedRuntimeId ||
    typeof body.server !== 'string' ||
    !body.server ||
    typeof body.expectedIdentity !== 'string' ||
    !body.expectedIdentity
  ) {
    return undefined
  }
  return {
    target,
    expectedRuntimeId: body.expectedRuntimeId,
    server: body.server,
    expectedIdentity: body.expectedIdentity,
  }
}

function parseDetailsInput(value: unknown): HarnessMcpDetailsInput | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const body = value as {
    target?: unknown
    expectedRuntimeId?: unknown
    server?: unknown
    include?: unknown
  }
  const target = parseTargetObject(body.target)
  if (
    !target ||
    typeof body.expectedRuntimeId !== 'string' ||
    !body.expectedRuntimeId ||
    typeof body.server !== 'string' ||
    !body.server ||
    !Array.isArray(body.include) ||
    body.include.length === 0 ||
    !body.include.every(isDetailSection)
  ) {
    return undefined
  }
  return {
    target,
    expectedRuntimeId: body.expectedRuntimeId,
    server: body.server,
    include: [...new Set(body.include)],
  }
}

function parseSaveInput(value: unknown): HarnessMcpConfigSaveInput | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const body = value as {
    target?: unknown
    scope?: unknown
    content?: unknown
    expectedRevision?: unknown
  }
  const target = parseTargetObject(body.target, true)
  if (
    !target ||
    (target.global === true && body.scope !== 'user') ||
    (body.scope !== 'user' && body.scope !== 'project') ||
    typeof body.content !== 'string' ||
    (body.expectedRevision !== null && typeof body.expectedRevision !== 'string')
  ) {
    return undefined
  }
  return {
    target,
    scope: body.scope,
    content: body.content,
    expectedRevision: body.expectedRevision,
  }
}

/** 注册 MCP 路由；调用方保证已在 `/api/pi/*` 注册安全中间件。 */
export function registerMcpRoutes(app: Hono, client: McpRouteClient): void {
  app.use(
    '/api/pi/mcp/config',
    bodyLimit({
      maxSize: HARNESS_MCP_CONFIG_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'mcp-config-too-large' }, 413),
    }),
  )
  app.use(
    '/api/pi/mcp/details',
    bodyLimit({
      maxSize: HARNESS_MCP_SMALL_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'mcp-request-too-large' }, 413),
    }),
  )
  app.use(
    '/api/pi/mcp/manage',
    bodyLimit({
      maxSize: HARNESS_MCP_SMALL_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'mcp-request-too-large' }, 413),
    }),
  )
  app.use(
    '/api/pi/mcp/auth/*',
    bodyLimit({
      maxSize: HARNESS_MCP_SMALL_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'mcp-request-too-large' }, 413),
    }),
  )

  app.get('/api/pi/mcp', async (c) => {
    const target = parseTarget(
      c.req.query('threadId'),
      c.req.query('workspacePath'),
      c.req.query('global'),
    )
    if (!target) return c.json({ error: 'invalid-mcp-target' }, 400)
    return c.json(await client.getMcp(target))
  })

  app.post('/api/pi/mcp/details', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_SMALL_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-request-too-large' }, 413)
    }
    const input = parseDetailsInput(await c.req.json().catch(() => undefined))
    if (!input) return c.json({ error: 'invalid-mcp-input' }, 400)
    return c.json(await client.getMcpDetails(input))
  })

  app.get('/api/pi/mcp/config', async (c) => {
    const target = parseTarget(
      c.req.query('threadId'),
      c.req.query('workspacePath'),
      c.req.query('global'),
      true,
    )
    if (!target) return c.json({ error: 'invalid-mcp-target' }, 400)
    return c.json(await client.getMcpConfig(target))
  })

  app.put('/api/pi/mcp/config', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_CONFIG_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-config-too-large' }, 413)
    }
    const input = parseSaveInput(await c.req.json().catch(() => undefined))
    if (!input) return c.json({ error: 'invalid-mcp-config-input' }, 400)
    if (Buffer.byteLength(input.content, 'utf8') > HARNESS_MCP_CONFIG_CONTENT_MAX_BYTES) {
      return c.json({ error: 'mcp-config-too-large' }, 413)
    }
    const result = await client.saveMcpConfig(input)
    if (result.status === 'conflict') {
      return c.json({ error: 'mcp-config-conflict', ...result }, 409)
    }
    if (result.status === 'untrusted') {
      return c.json({ error: 'mcp-config-untrusted', ...result }, 409)
    }
    if (result.status === 'too-large') {
      return c.json({ error: 'mcp-config-too-large', ...result }, 413)
    }
    if (result.status === 'failed') {
      return c.json({ error: 'mcp-config-write-failed', ...result }, 500)
    }
    return c.json(result)
  })

  app.post('/api/pi/mcp/manage', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_SMALL_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-request-too-large' }, 413)
    }
    const input = parseManageInput(await c.req.json().catch(() => undefined))
    if (!input) return c.json({ error: 'invalid-mcp-input' }, 400)
    return c.json(await client.manageMcp(input))
  })

  app.get('/api/pi/mcp/auth', async (c) => c.json(await client.getMcpAuth()))

  app.post('/api/pi/mcp/auth/login', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_SMALL_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-request-too-large' }, 413)
    }
    const input = parseAuthStartInput(await c.req.json().catch(() => undefined))
    if (!input) return c.json({ error: 'invalid-mcp-auth-input' }, 400)
    return c.json(await client.startMcpLogin(input))
  })

  app.post('/api/pi/mcp/auth/logout', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_SMALL_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-request-too-large' }, 413)
    }
    const input = parseAuthStartInput(await c.req.json().catch(() => undefined))
    if (!input) return c.json({ error: 'invalid-mcp-auth-input' }, 400)
    return c.json(await client.logoutMcp(input))
  })

  app.post('/api/pi/mcp/auth/respond', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_SMALL_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-request-too-large' }, 413)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      operationId?: unknown
      promptId?: unknown
      value?: unknown
    }
    if (
      typeof body.operationId !== 'string' ||
      typeof body.promptId !== 'string' ||
      typeof body.value !== 'string' ||
      body.value.length > HARNESS_MCP_AUTH_PROMPT_MAX_CHARS
    ) {
      return c.json({ error: 'invalid-mcp-auth-input' }, 400)
    }
    return c.json(
      await client.respondMcpAuth({
        operationId: body.operationId,
        promptId: body.promptId,
        value: body.value,
      }),
    )
  })

  app.post('/api/pi/mcp/auth/cancel', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > HARNESS_MCP_SMALL_BODY_LIMIT_BYTES) {
      return c.json({ error: 'mcp-request-too-large' }, 413)
    }
    const body = (await c.req.json().catch(() => ({}))) as { operationId?: unknown }
    if (typeof body.operationId !== 'string' || !body.operationId) {
      return c.json({ error: 'invalid-mcp-auth-input' }, 400)
    }
    return c.json(await client.cancelMcpAuth(body.operationId))
  })
}
