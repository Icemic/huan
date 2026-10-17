import type { Context, Next } from 'hono'
import type { ServerConfig } from './config.js'

/**
 * Host 校验（单独成中间件，依次序在健康检查前注册）。
 *
 * 防 DNS rebinding：攻击者域名解析到 loopback 后，同源 GET 请求无 Origin 头，
 * 仅靠 Origin 白名单拦不住，因此 Host 必须对所有端点（含健康检查）生效。
 */
export function createHostGuard(config: ServerConfig) {
  return async (c: Context, next: Next) => {
    const host = c.req.header('host')
    if (host && !config.allowedHosts.includes(host)) {
      return c.json({ error: `Host not allowed: ${host}` }, 403)
    }
    await next()
  }
}

/**
 * 鉴权与来源校验中间件（健康检查之后注册）。
 *
 * - Origin 校验：防跨站请求（存在 Origin 时必须属于允许列表）；
 * - 访问凭证：token 非空时校验（非浏览器客户端无 Origin/Host 约束时兜底）。
 */
export function createSecurityMiddleware(config: ServerConfig) {
  return async (c: Context, next: Next) => {
    const origin = c.req.header('origin')
    if (origin && !config.allowedOrigins.includes(origin)) {
      return c.json({ error: `Origin not allowed: ${origin}` }, 403)
    }

    if (config.token.length > 0 && c.req.header('x-huan-token') !== config.token) {
      return c.json({ error: 'Missing or invalid token' }, 401)
    }

    await next()
  }
}
