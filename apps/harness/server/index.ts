import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import { Hono } from 'hono'
import { createPiNodeClient } from '@assistant-ui/react-pi/node'
import { loadConfig } from './config.js'
import { resolveDefaultModel } from './model-resolution.js'
import { createSecurityMiddleware } from './security.js'

const config = loadConfig()
const defaultModel = await resolveDefaultModel(config)
if (defaultModel) {
  console.log(`[huan] 默认模型：${defaultModel.provider}/${defaultModel.id}`)
} else {
  console.warn('[huan] 未解析到默认模型；新会话将没有预设模型')
}
const piClient = createPiNodeClient({
  workspacePath: config.workspacePath,
  ...(config.agentDir ? { agentDir: config.agentDir } : {}),
  ...(defaultModel ? { model: defaultModel } : {}),
})

const app = new Hono()

// 统一鉴权与来源校验（健康检查除外，便于探活）。
app.get('/api/pi/health', (c) => c.json({ ok: true, workspacePath: config.workspacePath }))
app.use('/api/pi/*', createSecurityMiddleware(config))

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
app.get('/api/pi/threads/:id/events', async (c) => {
  const threadId = c.req.param('id')
  const includeSnapshot = c.req.query('snapshot') !== 'false'

  return streamSSE(c, async (stream) => {
    let unsubscribe: (() => void) | undefined
    let closed = false

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe?.()
        closed = true
        resolve()
      })
      unsubscribe = piClient.subscribe(
        threadId,
        (event) => {
          if (closed) return
          void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {
            // 客户端已断开，忽略写入失败。
          })
        },
        { includeSnapshot },
      )
    })
  })
})

serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[huan] 宿主已启动：http://127.0.0.1:${info.port}`)
  console.log(`[huan] 工作目录：${config.workspacePath}`)
})
