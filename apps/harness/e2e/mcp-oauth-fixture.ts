/**
 * e2e 专用真实 OAuth + Streamable HTTP MCP fixture。
 *
 * 这是测试 fixture（不是生产运行时代码）：实现最小 OAuth metadata/DCR/授权/令牌
 * 端点，并在受保护资源端点后处理真实 MCP JSON-RPC。测试通过 HTTP 完成真实
 * 授权码 + PKCE 登录，不使用 mock authorize。
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createState, handleNotification, handleRequest } from './mcp-protocol.mjs'

interface Client {
  redirectUris: string[]
}

interface AuthorizationCode {
  clientId: string
  redirectUri: string
  challenge: string
  used: boolean
}

interface Grant {
  clientId: string
  refreshToken: string
}

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** 真实 OAuth 授权服务器 + 受保护的 Streamable HTTP MCP 资源。 */
export class OAuthMcpTestServer {
  readonly server: Server
  origin = ''
  readonly clients = new Map<string, Client>()
  readonly refreshTokens = new Map<string, Grant>()
  readonly accessTokens = new Set<string>()
  readonly codes = new Map<string, AuthorizationCode>()
  readonly authorizationRequests: URL[] = []
  readonly tokenRequests: URLSearchParams[] = []
  readonly resourceRequests: number[] = []
  registrationCount = 0
  exchangeCount = 0
  refreshCount = 0
  private counter = 0
  private readonly state = createState(process.env)

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('fixture failure')
        }
      })
    })
  }

  static async start(): Promise<OAuthMcpTestServer> {
    const instance = new OAuthMcpTestServer()
    await new Promise<void>((resolve, reject) => {
      instance.server.once('error', reject)
      instance.server.listen(0, '127.0.0.1', () => {
        instance.server.off('error', reject)
        const address = instance.server.address() as AddressInfo
        instance.origin = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
    return instance
  }

  get resourceUrl(): string {
    return `${this.origin}/mcp`
  }

  get metadataUrl(): string {
    return `${this.origin}/resource-metadata`
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private json(res: ServerResponse, status: number, value: unknown, sessionId?: string): void {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    })
    res.end(body)
  }

  private resourceMetadata() {
    return {
      resource: `${this.origin}/mcp`,
      authorization_servers: [this.origin],
      scopes_supported: ['read', 'write', 'offline_access'],
    }
  }

  private authorizationMetadata() {
    return {
      issuer: this.origin,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: `${this.origin}/token`,
      registration_endpoint: `${this.origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['read', 'write', 'offline_access'],
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      this.json(res, 200, this.resourceMetadata())
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      this.json(res, 200, this.authorizationMetadata())
      return
    }
    if (url.pathname === '/resource-metadata') {
      this.json(res, 200, this.resourceMetadata())
      return
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      await this.register(req, res)
      return
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      this.authorize(url, res)
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      await this.token(req, res)
      return
    }
    if (url.pathname.startsWith('/mcp')) {
      await this.resource(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as {
      redirect_uris?: unknown
      client_name?: unknown
      token_endpoint_auth_method?: unknown
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((value): value is string => typeof value === 'string')
      : []
    this.registrationCount += 1
    const clientId = `client-${this.registrationCount}`
    this.clients.set(clientId, { redirectUris })
    this.json(res, 201, {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method:
        typeof body.token_endpoint_auth_method === 'string'
          ? body.token_endpoint_auth_method
          : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
    })
  }

  private authorize(url: URL, res: ServerResponse): void {
    this.authorizationRequests.push(new URL(url.href))
    const clientId = url.searchParams.get('client_id')
    const redirectUri = url.searchParams.get('redirect_uri')
    const challenge = url.searchParams.get('code_challenge')
    const state = url.searchParams.get('state')
    if (
      url.searchParams.get('response_type') !== 'code' ||
      !clientId ||
      !redirectUri ||
      !challenge ||
      !state
    ) {
      this.json(res, 400, { error: 'invalid_request' })
      return
    }
    if (!this.clients.has(clientId)) {
      this.clients.set(clientId, { redirectUris: [redirectUri] })
    }
    const code = `code-${++this.counter}`
    this.codes.set(code, { clientId, redirectUri, challenge, used: false })
    const location = new URL(redirectUri)
    location.searchParams.set('code', code)
    location.searchParams.set('state', state)
    location.searchParams.set('iss', this.origin)
    res.writeHead(302, { location: location.href, 'cache-control': 'no-store' })
    res.end()
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readBody(req))
    this.tokenRequests.push(params)
    if (params.get('grant_type') === 'authorization_code') {
      this.exchange(res, params)
      return
    }
    if (params.get('grant_type') === 'refresh_token') {
      this.refresh(res, params)
      return
    }
    this.json(res, 400, { error: 'unsupported_grant_type' })
  }

  private exchange(res: ServerResponse, params: URLSearchParams): void {
    this.exchangeCount += 1
    const code = params.get('code')
    const clientId = params.get('client_id')
    const redirectUri = params.get('redirect_uri')
    const verifier = params.get('code_verifier')
    const stored = code ? this.codes.get(code) : undefined
    if (!stored || stored.used || !clientId || !redirectUri || !verifier) {
      this.json(res, 400, { error: 'invalid_grant' })
      return
    }
    if (
      stored.clientId !== clientId ||
      stored.redirectUri !== redirectUri ||
      stored.challenge !== pkceChallenge(verifier)
    ) {
      this.json(res, 400, { error: 'invalid_grant' })
      return
    }
    stored.used = true
    const access = `access-${++this.counter}`
    const refresh = `refresh-${++this.counter}`
    this.accessTokens.add(access)
    this.refreshTokens.set(refresh, { clientId, refreshToken: refresh })
    this.json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: 'read write',
    })
  }

  private refresh(res: ServerResponse, params: URLSearchParams): void {
    this.refreshCount += 1
    const token = params.get('refresh_token')
    const grant = token ? this.refreshTokens.get(token) : undefined
    if (!grant || !token) {
      this.json(res, 400, { error: 'invalid_grant' })
      return
    }
    this.refreshTokens.delete(token)
    const access = `access-${++this.counter}`
    const refresh = `refresh-${++this.counter}`
    this.accessTokens.add(access)
    this.refreshTokens.set(refresh, { ...grant, refreshToken: refresh })
    this.json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
      scope: 'read write',
    })
  }

  private async resource(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.resourceRequests.push(Date.now())
    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST, DELETE' })
      res.end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }

    const authorization = req.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    if (!token || !this.accessTokens.has(token)) {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate': `Bearer resource_metadata="${this.metadataUrl}", scope="read write"`,
      })
      res.end('authentication required')
      return
    }

    let message: { id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(await readBody(req)) as typeof message
    } catch {
      res.writeHead(400)
      res.end('invalid json')
      return
    }
    if (Array.isArray(message)) {
      res.writeHead(400)
      res.end('batch not supported')
      return
    }
    const sessionId = `fixture-session-${this.state.initSuccesses + 1}`
    if (message.id === undefined) {
      handleNotification(message, this.state)
      res.writeHead(202)
      res.end()
      return
    }
    const response = await handleRequest(message, this.state)
    if (response.httpStatus) {
      res.writeHead(response.httpStatus, { 'content-type': 'text/plain' })
      res.end('fixture http failure')
      return
    }
    if (response.error) {
      this.json(res, 200, { jsonrpc: '2.0', id: message.id, error: response.error }, sessionId)
      return
    }
    this.json(res, 200, { jsonrpc: '2.0', id: message.id, result: response.result }, sessionId)
  }
}

/** e2e 夹具集合：stdio 脚本路径 + OAuth MCP 服务。 */
export type McpFixtures = {
  stdioFixturePath: string
  oauthOrigin: string
  oauthResourceUrl: string
  nodePath: string
  close: () => Promise<void>
}

export async function startMcpFixtures(stdioFixturePath: string): Promise<McpFixtures> {
  const oauth = await OAuthMcpTestServer.start()
  return {
    stdioFixturePath,
    oauthOrigin: oauth.origin,
    oauthResourceUrl: oauth.resourceUrl,
    nodePath: process.execPath,
    close: () => oauth.close(),
  }
}
