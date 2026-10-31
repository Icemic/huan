import { serve } from '@hono/node-server'
import { createHarnessHost } from '@huan/core'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const host = await createHarnessHost({
  workspacePath: config.workspacePath,
  ...(config.agentDir ? { agentDir: config.agentDir } : {}),
})
for (const diagnostic of host.diagnostics()) {
  console.warn(`[huan] ${diagnostic}`)
}
console.log('[huan] 宿主已装配（@huan/core）')

const app = createApp(host, config)

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
