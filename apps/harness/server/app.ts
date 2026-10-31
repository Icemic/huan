import type { HarnessClient } from '@huan/protocol'
import { Hono } from 'hono'
import type { ServerConfig } from './config.js'
import { registerHostRoutes } from './host-routes.js'
import { createEventsRoute } from './sse.js'

/**
 * 组装宿主 HTTP 路由。
 *
 * 生产入口与浏览器验收启动器共用这一份路由：测试不得复制路由，也不引入
 * 生产 testMode；测试专属的控制端点由启动器在返回的应用上追加。
 */
export function createApp(piClient: HarnessClient, config: ServerConfig): Hono {
  const app = new Hono()

  registerHostRoutes(app, piClient, config)

  app.get('/api/pi/threads', async (c) => {
    const workspacePath = c.req.query('workspacePath') ?? undefined
    const includeArchived = c.req.query('includeArchived') === 'true'
    return c.json(await piClient.listThreads({ workspacePath, includeArchived }))
  })

  app.post('/api/pi/threads', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await piClient.createThread(body))
  })

  app.get('/api/pi/threads/:id', async (c) => {
    return c.json(await piClient.getThread(c.req.param('id')))
  })

  app.patch('/api/pi/threads/:id', async (c) => {
    const { title } = await c.req.json()
    await piClient.renameThread(c.req.param('id'), title)
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/messages', async (c) => {
    const { input } = await c.req.json()
    await piClient.sendMessage(c.req.param('id'), input)
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/cancel', async (c) => {
    await piClient.cancelRun(c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/queue/clear', async (c) => {
    return c.json(await piClient.clearQueue(c.req.param('id')))
  })

  app.get('/api/pi/models', async (c) => {
    const workspacePath = c.req.query('workspacePath') ?? undefined
    return c.json(await piClient.getAvailableModels({ workspacePath }))
  })

  app.post('/api/pi/threads/:id/model', async (c) => {
    const { provider, modelId } = await c.req.json()
    await piClient.setModel(c.req.param('id'), { provider, modelId })
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/thinking', async (c) => {
    const { level } = await c.req.json()
    await piClient.setThinkingLevel(c.req.param('id'), level)
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/archive', async (c) => {
    await piClient.archiveThread(c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/unarchive', async (c) => {
    await piClient.unarchiveThread(c.req.param('id'))
    return c.body(null, 204)
  })

  app.delete('/api/pi/threads/:id', async (c) => {
    await piClient.deleteThread(c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/host-ui', async (c) => {
    const { response } = await c.req.json()
    await piClient.respondToHostUiRequest(c.req.param('id'), response)
    return c.body(null, 204)
  })

  // SSE 事件流：快照优先（?snapshot=false 跳过）；断开只退订，不中止运行。
  app.get('/api/pi/threads/:id/events', createEventsRoute(piClient))

  return app
}
