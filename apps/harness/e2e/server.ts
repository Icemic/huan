/**
 * 浏览器验收启动器：真实 Pi SDK + 真实生产路由 + Vite。
 *
 * 与生产入口共享 `createApp`；测试专属控制端点只在此进程注册，不进入
 * 生产应用。用户空间、工作区与会话目录均由 `@huan/core/testing` 在
 * Playwright 输出目录内创建，结束（或收到信号）时删除。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { serve } from '@hono/node-server'
import { createHarnessHost, workspaceStateFile } from '@huan/core'
import { createIsolatedPiEnv, TEST_RESOURCE_ISOLATION } from '@huan/core/testing'
import type { HarnessClient } from '@huan/protocol'
import { createServer as createViteServer } from 'vite'
import { createApp } from '../server/app.js'
import type { ServerConfig } from '../server/config.js'
import {
  E2E_APP_PORT,
  E2E_APP_URL,
  E2E_HOST_PORT,
  E2E_HOST_URL,
  E2E_UNASSIGNED_TITLE,
} from './config.js'
import { installModelControl } from './model-control.js'

// 不继承个人 Pi 配置与默认模型；所有作用域都显式落在临时目录。
for (const key of [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
]) {
  delete process.env[key]
}
delete process.env.HUAN_TOKEN
// Vite 代理目标（见 vite.config.ts）指向本次隔离宿主。
process.env.HUAN_API_TARGET = E2E_HOST_URL

// 临时根放在 Playwright 输出目录内：Windows 下 webServer 会被强制结束，
// 由 global-teardown 统一清理；该目录不入 Git。
const tempParent = resolve(import.meta.dirname, '..', 'test-results', 'e2e')
await mkdir(tempParent, { recursive: true })
const env = await createIsolatedPiEnv('run-', { parentDir: tempParent })
// 默认模型故意无效：空白页必须呈现错误并允许从模型选择器恢复。
await writeFile(
  join(env.agentDir, 'settings.json'),
  `${JSON.stringify(
    { defaultProvider: 'e2e-missing-provider', defaultModel: 'e2e-missing-model' },
    null,
    2,
  )}\n`,
)

const modelControl = installModelControl()

// 启动前落盘一个没有 huan 归属的 Pi 会话：用于验证未归属分组与显式接入。
// 必须在宿主启动前写入，避免绕过宿主目录缓存。
const unassignedManager = SessionManager.create(env.workspace, env.defaultSessionDir(env.workspace))
unassignedManager.appendMessage({
  role: 'user',
  content: [{ type: 'text', text: E2E_UNASSIGNED_TITLE }],
  timestamp: Date.now(),
})

const host = await createHarnessHost({
  workspacePath: env.workspace,
  agentDir: env.agentDir,
  // 合成 provider 已在本地 models.json 中，无需联网刷新。
  refreshCatalogOnStart: false,
  resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
})

// 记录 SSE 订阅生命周期，供断线/恢复测试做确定性断言。
let totalSubscriptions = 0
let activeSubscriptions = 0
const countedClient: HarnessClient = {
  ...host,
  subscribe(threadId, listener, options) {
    totalSubscriptions += 1
    activeSubscriptions += 1
    const unsubscribe = host.subscribe(threadId, listener, options)
    let released = false
    return () => {
      if (released) return
      released = true
      activeSubscriptions -= 1
      unsubscribe()
    }
  },
}

const config: ServerConfig = {
  port: E2E_HOST_PORT,
  workspacePath: env.workspace,
  agentDir: env.agentDir,
  allowedHosts: [
    `127.0.0.1:${E2E_APP_PORT}`,
    `localhost:${E2E_APP_PORT}`,
    `127.0.0.1:${E2E_HOST_PORT}`,
    `localhost:${E2E_HOST_PORT}`,
  ],
  allowedOrigins: [`http://127.0.0.1:${E2E_APP_PORT}`, `http://localhost:${E2E_APP_PORT}`],
  token: '',
}

const app = createApp(countedClient, config)

// SSE 响应包装：保留真实路由，只在测试进程持有下游控制器，以便让事件流
// 干净结束（浏览器读到 EOF 后按既有逻辑重连）。
const liveSseStreams = new Set<{ close: () => void }>()
const fetchWithSseControl = (async (request: Request) => {
  const response = await app.fetch(request)
  if (!new URL(request.url).pathname.endsWith('/events') || !response.body) return response

  const reader = response.body.getReader()
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined
  let settled = false
  const handle = {
    close: () => {
      if (settled) return
      settled = true
      try {
        downstream?.close()
      } catch {
        // 已关闭时忽略。
      }
      void reader.cancel().catch(() => {})
    },
  }
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller
    },
    cancel() {
      handle.close()
    },
  })
  liveSseStreams.add(handle)
  void (async () => {
    try {
      while (!settled) {
        const { value, done } = await reader.read()
        if (done) break
        downstream?.enqueue(value)
      }
      handle.close()
    } catch {
      handle.close()
    } finally {
      liveSseStreams.delete(handle)
    }
  })()

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}) as typeof app.fetch

const server = serve({ fetch: fetchWithSseControl, port: E2E_HOST_PORT, hostname: '127.0.0.1' })

// 测试控制面：只监听环回地址，且不注册进生产应用。
app.get('/__e2e__/info', (c) =>
  c.json({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
  }),
)
// 创建隔离项目（可选写入项目扩展探针）；路径与会话都在临时根内。
app.post('/__e2e__/projects', async (c) => {
  const body = (await c.req.json()) as {
    name?: unknown
    extension?: unknown
    settings?: unknown
  }
  const rawName = typeof body.name === 'string' ? body.name : `project-${Date.now()}`
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '-')
  const projectPath = join(env.root, 'projects', name)
  await mkdir(projectPath, { recursive: true })
  let marker: string | undefined
  if (body.extension === true) {
    const extensionDir = join(projectPath, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    marker = join(env.root, `project-${name}.marker`)
    await writeFile(
      join(extensionDir, 'probe.js'),
      `import { appendFileSync } from 'node:fs'

export default function () {
  appendFileSync(${JSON.stringify(marker)}, 'project\\n')
}
`,
    )
  }
  if (body.settings && typeof body.settings === 'object') {
    await mkdir(join(projectPath, '.pi'), { recursive: true })
    await writeFile(
      join(projectPath, '.pi', 'settings.json'),
      `${JSON.stringify(body.settings, null, 2)}
`,
    )
  }
  return c.json({ path: projectPath, name, marker })
})
app.get('/__e2e__/subscriptions', (c) => c.json({ totalSubscriptions, activeSubscriptions }))
// 工作区元数据读写：仅供损坏文件 UI 场景备份/恢复，不进入生产应用。
app.get('/__e2e__/workspace-state', async (c) => {
  const file = workspaceStateFile(env.agentDir)
  const content = await readFile(file, 'utf8').catch(() => null)
  return c.json({ content })
})
app.put('/__e2e__/workspace-state', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: unknown }
  const file = workspaceStateFile(env.agentDir)
  if (typeof body.content === 'string') {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body.content)
  } else {
    await rm(file, { force: true })
  }
  return c.body(null, 204)
})
app.get('/__e2e__/stream', (c) => c.json(modelControl.state()))
app.post('/__e2e__/stream', async (c) => {
  modelControl.configure(await c.req.json())
  return c.body(null, 204)
})
app.post('/__e2e__/stream/release', (c) => {
  modelControl.release()
  return c.body(null, 204)
})
app.post('/__e2e__/stream/finish', (c) => {
  modelControl.finish()
  return c.body(null, 204)
})
app.post('/__e2e__/stream/reset', (c) => {
  modelControl.reset()
  return c.body(null, 204)
})
// 让所有在途事件流正常结束，客户端应读到 EOF 并重连。
app.post('/__e2e__/disconnect', (c) => {
  for (const stream of liveSseStreams) stream.close()
  liveSseStreams.clear()
  return c.body(null, 204)
})

const vite = await createViteServer({
  root: resolve(import.meta.dirname, '..'),
  server: { host: '127.0.0.1', port: E2E_APP_PORT, strictPort: true },
})
await vite.listen()
console.log(`[e2e] 宿主 ${E2E_HOST_URL}，页面 ${E2E_APP_URL}`)
console.log(`[e2e] 临时用户空间：${env.agentDir}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  console.log('[e2e] 正在关闭…')
  modelControl.restore()
  // 先结束事件流并强制释放连接，避免 server.close 等待长连接。
  for (const stream of liveSseStreams) stream.close()
  liveSseStreams.clear()
  const serverClosed = new Promise<void>((resolveClose) => {
    server.close(() => resolveClose())
    ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
  })
  await Promise.race([
    Promise.allSettled([vite.close(), serverClosed]),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000)),
  ])
  await host.dispose().catch(() => {})
  await env.cleanup().catch(() => {})
  console.log('[e2e] 已释放临时目录')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
