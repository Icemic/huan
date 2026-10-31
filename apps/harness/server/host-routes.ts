import type { HarnessClient } from '@huan/protocol'
import type { Hono } from 'hono'
import type { ServerConfig } from './config.js'
import { createHostGuard, createSecurityMiddleware } from './security.js'

/** 统一注册宿主边界：health 只公开存活状态，路径和诊断必须鉴权后查询。 */
export function registerHostRoutes(
  app: Hono,
  client: Pick<HarnessClient, 'getHostInfo'>,
  config: ServerConfig,
) {
  app.use('/api/pi/*', createHostGuard(config))
  app.get('/api/pi/health', (c) => c.json({ ok: true }))
  app.use('/api/pi/*', createSecurityMiddleware(config))
  app.get('/api/pi/host', async (c) => c.json(await client.getHostInfo()))
}
