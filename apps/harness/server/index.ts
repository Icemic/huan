import { serve } from '@hono/node-server'
import { createHarnessHost } from '@huan/core'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { loadConfig } from './config.js'
import { createHostGuard, createSecurityMiddleware } from './security.js'

const config = loadConfig()
const host = await createHarnessHost({
  workspacePath: config.workspacePath,
  ...(config.agentDir ? { agentDir: config.agentDir } : {}),
})
for (const diagnostic of host.diagnostics()) {
  console.warn(`[huan] ${diagnostic}`)
}
console.log('[huan] 宿主已装配（@huan/core）')
const piClient = host

const app = new Hono()

// 健康检查（不需要凭证，便于探活；不携带工作目录等敏感信息）。
// Host 校验先于健康检查注册，防 DNS rebinding 覆盖全部端点；Origin/token 校验在其后。
app.use('/api/pi/*', createHostGuard(config))
app.get('/api/pi/health', (c) => c.json({ ok: true }))
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
// 慢客户端（待写事件超过上限）会被断开，由客户端重连走快照恢复，避免无界积压。
app.get('/api/pi/threads/:id/events', async (c) => {
  const threadId = c.req.param('id')
  const includeSnapshot = c.req.query('snapshot') !== 'false'
  const MAX_INFLIGHT_WRITES = 500

  return streamSSE(c, async (stream) => {
    let unsubscribe: (() => void) | undefined
    let settled = false
    let inflight = 0

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        if (settled) return
        settled = true
        unsubscribe?.()
        resolve()
      }

      stream.onAbort(cleanup)

      unsubscribe = piClient.subscribe(
        threadId,
        (event) => {
          if (settled) return
          if (inflight >= MAX_INFLIGHT_WRITES) {
            void stream.close().catch(() => {})
            cleanup()
            return
          }
          inflight++
          void stream
            .writeSSE({ data: JSON.stringify(event) })
            .catch(() => {
              // 写入失败（客户端已断开）由 onAbort 兜底清理。
            })
            .finally(() => {
              inflight--
            })
        },
        { includeSnapshot },
      )
    })
  })
})

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`[huan] 宿主已启动：http://127.0.0.1:${info.port}`)
  console.log(`[huan] 工作目录：${config.workspacePath}`)
})

// 退出时优雅关闭：中止运行中的会话、解除 UI 等待、补发扩展 session_shutdown，
// 避免扩展持有的连接/定时器泄漏（宿主由应用持有，销毁是应用责任）。
let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[huan] 收到 ${signal}，正在关闭宿主…`)
  try {
    await host.dispose()
  } catch (error) {
    console.error('[huan] 关闭时出错：', error)
  }
  server.close(() => process.exit(0))
  // 兜底：若连接未在限定时间内释放，强制退出。
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
