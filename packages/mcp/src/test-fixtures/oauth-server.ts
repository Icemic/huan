// 本地真实 OAuth 测试服务器：metadata、DCR、authorization、token、resource 与回调。
// 测试直接通过 HTTP 完成真实登录/刷新，不用 mock authorize。

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

interface Client {
  redirectUris: string[]
  clientSecret?: string
}

interface AuthorizationCode {
  clientId: string
  redirectUri: string
  challenge: string
  scope?: string
  resource?: string
  used: boolean
}

interface Grant {
  clientId: string
  refreshToken: string
  scope?: string
  resource?: string
}

export interface OAuthTestServerOptions {
  /** 授权码换取的 access token 有效期（秒）。 */
  expiresIn?: number
  /** 刷新后的 access token 有效期（秒）。 */
  refreshExpiresIn?: number
  /** refresh_token 请求的响应延迟。 */
  refreshDelayMs?: number
  /** 授权码请求的响应延迟。 */
  tokenDelayMs?: number
  /** 授权响应中的 iss 模式。 */
  authorizationIssuer?: 'auto' | 'wrong' | 'omit'
  /** discovery metadata 的 issuer 覆盖；用于测试 issuer 校验。 */
  metadataIssuer?: 'auto' | 'wrong'
  /** 401 challenge 中的 scope。 */
  challengeScope?: string
  /** 401 challenge 中的 error，例如 insufficient_scope。 */
  challengeError?: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
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

/** 真实 OAuth 授权服务器 + 受保护资源端点。 */
export class OAuthTestServer {
  readonly server: Server
  origin = ''
  readonly clients = new Map<string, Client>()
  readonly refreshTokens = new Map<string, Grant>()
  readonly accessTokens = new Set<string>()
  readonly codes = new Map<string, AuthorizationCode>()
  readonly authorizationRequests: URL[] = []
  readonly tokenRequests: URLSearchParams[] = []
  readonly resourceRequests: number[] = []
  authorizationIssuer: OAuthTestServerOptions['authorizationIssuer']
  metadataIssuer: OAuthTestServerOptions['metadataIssuer']
  expiresIn: number
  refreshExpiresIn: number
  refreshDelayMs: number
  tokenDelayMs: number
  challengeScope: string
  challengeError: string | undefined
  registrationCount = 0
  exchangeCount = 0
  refreshCount = 0
  private counter = 0

  private constructor(options: OAuthTestServerOptions) {
    this.authorizationIssuer = options.authorizationIssuer ?? 'auto'
    this.metadataIssuer = options.metadataIssuer ?? 'auto'
    this.expiresIn = options.expiresIn ?? 3600
    this.refreshExpiresIn = options.refreshExpiresIn ?? 3600
    this.refreshDelayMs = options.refreshDelayMs ?? 0
    this.tokenDelayMs = options.tokenDelayMs ?? 0
    this.challengeScope = options.challengeScope ?? 'read write'
    this.challengeError = options.challengeError
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('fixture failure')
        }
      })
    })
  }

  static async start(options: OAuthTestServerOptions = {}): Promise<OAuthTestServer> {
    const instance = new OAuthTestServer(options)
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

  /** 当前仍然有效的 refresh token 数量（用于确认轮换删除旧值）。 */
  get liveRefreshTokens(): string[] {
    return [...this.refreshTokens.keys()]
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
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
      issuer: this.metadataIssuer === 'wrong' ? `${this.origin}/wrong` : this.origin,
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
    this.codes.set(code, {
      clientId,
      redirectUri,
      challenge,
      ...(url.searchParams.get('scope')
        ? { scope: url.searchParams.get('scope') ?? undefined }
        : {}),
      ...(url.searchParams.get('resource')
        ? { resource: url.searchParams.get('resource') ?? undefined }
        : {}),
      used: false,
    })
    const location = new URL(redirectUri)
    location.searchParams.set('code', code)
    location.searchParams.set('state', state)
    if (this.authorizationIssuer !== 'omit') {
      location.searchParams.set(
        'iss',
        this.authorizationIssuer === 'wrong' ? `${this.origin}/wrong` : this.origin,
      )
    }
    res.writeHead(302, { location: location.href, 'cache-control': 'no-store' })
    res.end()
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readBody(req))
    this.tokenRequests.push(params)
    const grantType = params.get('grant_type')
    if (grantType === 'authorization_code') {
      if (this.tokenDelayMs > 0) await delay(this.tokenDelayMs)
      this.exchange(req, res, params)
      return
    }
    if (grantType === 'refresh_token') {
      this.refreshCount += 1
      if (this.refreshDelayMs > 0) await delay(this.refreshDelayMs)
      this.refresh(req, res, params)
      return
    }
    this.json(res, 400, { error: 'unsupported_grant_type' })
  }

  private exchange(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void {
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
    this.refreshTokens.set(refresh, {
      clientId,
      refreshToken: refresh,
      ...(stored.scope ? { scope: stored.scope } : {}),
      ...(stored.resource ? { resource: stored.resource } : {}),
    })
    this.json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      refresh_token: refresh,
      ...(stored.scope ? { scope: stored.scope } : {}),
    })
    void req
  }

  private refresh(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void {
    const token = params.get('refresh_token')
    const grant = token ? this.refreshTokens.get(token) : undefined
    if (!grant || !token) {
      this.json(res, 400, { error: 'invalid_grant' })
      return
    }
    // 轮换 refresh token：旧值立即失效，旧刷新晚结果不能覆盖新 grant。
    this.refreshTokens.delete(token)
    const access = `access-${++this.counter}`
    const refresh = `refresh-${++this.counter}`
    this.accessTokens.add(access)
    this.refreshTokens.set(refresh, { ...grant, refreshToken: refresh })
    this.json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.refreshExpiresIn,
      refresh_token: refresh,
      ...(grant.scope ? { scope: grant.scope } : {}),
    })
    void req
  }

  private async resource(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.resourceRequests.push(Date.now())
    if (req.method === 'POST') await readBody(req).catch(() => '')
    const authorization = req.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    if (token && this.accessTokens.has(token)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(401, {
      'content-type': 'text/plain',
      'www-authenticate': `Bearer resource_metadata="${this.metadataUrl}", scope="${this.challengeScope}"${this.challengeError ? `, error="${this.challengeError}"` : ''}`,
    })
    res.end('authentication required')
  }
}
