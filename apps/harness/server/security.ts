import type { Context, Next } from 'hono'
import type { ServerConfig } from './config.js'

/**
 * 鉴权与来源校验中间件。
 *
 * 只接受标准请求，避免恶意网页借用户浏览器向本机宿主发起有效请求：
 * - 校验 Origin（存在时必须属于允许列表）；
 * - 校验访问凭证（token 非空时）。
 * 非浏览器客户端（无 Origin）仍需凭证；开发期前端经 Vite 代理，代理会保留 Origin。
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
