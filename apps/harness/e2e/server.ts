/**
 * 浏览器验收启动器：真实 Pi SDK + 真实生产路由 + Vite。
 *
 * 与生产入口共享 `createApp`；测试专属控制端点只在此进程注册，不进入
 * 生产应用。用户空间、工作区与会话目录均由 `@huan/core/testing` 在
 * Playwright 输出目录内创建，结束（或收到信号）时删除。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { serve } from '@hono/node-server'
import { createHarnessHost, workspaceStateFile } from '@huan/core'
import { createIsolatedPiEnv, TEST_RESOURCE_ISOLATION } from '@huan/core/testing'
import type { HarnessClient } from '@huan/protocol'
import { build, createServer as createViteServer, preview } from 'vite'
import { createApp } from '../server/app.js'
import type { ServerConfig } from '../server/config.js'
import {
  E2E_APP_PORT,
  E2E_APP_URL,
  E2E_HOST_PORT,
  E2E_HOST_URL,
  E2E_UNASSIGNED_TITLE,
} from './config.js'
import { startMcpFixtures } from './mcp-oauth-fixture.js'
import { installModelControl } from './model-control.js'
import { renderReviewPlugin } from './render-review.js'

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
// 固定资源：一条扩展命令用于验证“未知 slash 交给 SDK 执行”和参数补全；
// 工作区文件用于 @ 引用查询（不读取文件内容，也不访问个人空间）。
await mkdir(join(env.agentDir, 'extensions'), { recursive: true })
await writeFile(
  join(env.agentDir, 'extensions', 'command-probe.js'),
  `import { existsSync } from 'node:fs'
import { join } from 'node:path'
export default function (pi) {
  pi.registerCommand('probe', {
    description: '浏览器测试扩展命令',
    getArgumentCompletions: (prefix) =>
      [
        { value: 'alpha', label: 'alpha', description: '第一项' },
        { value: 'beta', label: 'beta' },
      ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      ctx.ui.notify('probe-command:' + (args || '(empty)'), 'info')
    },
  })
  pi.registerCommand('host-ui', {
    description: '浏览器测试运行期 Host UI',
    handler: async (_args, ctx) => {
      ctx.ui.notify('HOSTUI-通知', 'warning')
      ctx.ui.setStatus('huan-test', 'HOSTUI-状态')
      ctx.ui.setWidget('huan-widget', ['HOSTUI-行一', 'HOSTUI-行二'], { placement: 'belowEditor' })
      ctx.ui.setTitle('HOSTUI-扩展标题')
      ctx.ui.setEditorText('HOSTUI-编辑内容')
    },
  })
  pi.registerCommand('ask-host-ui', {
    description: '浏览器测试阻断交互',
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm('HOSTUI-工具确认', '允许这次操作？')
      ctx.ui.notify('HOSTUI-确认结果:' + ok, 'info')
    },
  })
  // 展示层探针：工具图片、嵌套子调用与工具关联的多行编辑器请求。
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  pi.registerTool({
    name: 'e2e-image',
    label: '图片探针',
    description: '返回纯图片或图文混合结果',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string' } },
      additionalProperties: false,
    },
    execute: async (_callId, params) => {
      const image = { type: 'image', data: pixel, mimeType: 'image/png' }
      return params?.mode === 'pure'
        ? { content: [image] }
        : { content: [{ type: 'text', text: 'IMAGE-MIXED-TEXT' }, image] }
    },
  })
  pi.registerTool({
    name: 'e2e-child-ask',
    label: '子工具探针',
    description: '子工具：先上报固定进度，再等待一次确认',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string' } },
      additionalProperties: false,
    },
    execute: async (_callId, params, _signal, onUpdate, ctx) => {
      // 确认前先发一次固定进度：GUI 必须能看到子调用的部分输出与参数，
      // 而不是只有名字行。
      const progress = 'CHILD-PROGRESS:' + (params?.note ?? '(empty)')
      onUpdate?.({ content: [{ type: 'text', text: progress }], details: { progress } })
      const ok = await ctx.ui.confirm('E2E 子工具确认', '允许子工具继续？')
      return { content: [{ type: 'text', text: ok ? 'CHILD-ALLOWED' : 'CHILD-DENIED' }] }
    },
  })
  pi.registerTool({
    name: 'e2e-nested',
    label: '嵌套探针',
    description: '通过 executeTool 调用子工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_callId, _params, _signal, _onUpdate, ctx) => {
      const outcome = await ctx.executeTool('e2e-child-ask', { note: 'nested-progress-arg' })
      return {
        content: [{ type: 'text', text: outcome.isError ? 'NESTED-CHILD-ERROR' : 'NESTED-PARENT-DONE' }],
      }
    },
  })
  pi.registerTool({
    name: 'e2e-editor',
    label: '编辑器探针',
    description: '请求多行编辑器原文',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_callId, _params, _signal, _onUpdate, ctx) => {
      const answer = await ctx.ui.editor('E2E 编辑器请求', '第一行原文\\n第二行原文')
      return {
        content: [
          {
            type: 'text',
            text: 'EDITOR-ANSWER:' + String(answer ?? '').replace(/\\n/g, '|'),
          },
        ],
      }
    },
  })
  pi.on('project_trust', async (_event, ctx) => {
    if (!existsSync(join(ctx.cwd, '.pi', 'ask-trust'))) return { trusted: 'undecided' }
    const ok = await ctx.ui.confirm('HOSTUI-项目信任', ctx.cwd)
    return { trusted: ok ? 'yes' : 'no' }
  })
  pi.on('session_start', async (_event, ctx) => {
    if (!existsSync(join(ctx.cwd, '.pi', 'ask-startup'))) return
    await ctx.ui.confirm('HOSTUI-启动确认', '允许启动？')
  })
}
`,
)
// 合成认证 provider：真实原生 provider + 本地 prompt/OAuth 模拟，不联网。
// API key 与 OAuth 凭据由真实 ModelRuntime 写入临时 agentDir/auth.json。
await writeFile(
  join(env.agentDir, 'extensions', 'auth-probe.js'),
  `export default function (pi) {
  pi.registerProvider({
    id: 'huan-auth-test',
    name: '认证测试 Provider',
    auth: {
      apiKey: {
        name: '测试 API key',
        async login(interaction) {
          await interaction.prompt({
            type: 'secret',
            message: '输入合成 API key',
            placeholder: 'synthetic-e2e-key',
          })
          return { type: 'api_key', key: 'synthetic-e2e-key' }
        },
        async resolve({ credential }) {
          return credential?.key
            ? { auth: { apiKey: credential.key }, source: 'synthetic' }
            : undefined
        },
      },
      oauth: {
        name: '测试 OAuth',
        login: async (interaction) => {
          const mode = await interaction.prompt({
            type: 'select',
            message: '选择授权方式',
            options: [
              { id: 'url', label: '授权链接' },
              { id: 'device', label: '设备码' },
            ],
          })
          if (mode === 'url') {
            interaction.notify({
              type: 'auth_url',
              url: 'http://127.0.0.1:9/oauth',
              instructions: '打开链接后输入测试授权码 test-code',
            })
          } else {
            interaction.notify({
              type: 'device_code',
              userCode: 'TEST-CODE',
              verificationUri: 'http://127.0.0.1:9/device',
            })
          }
          const code = await interaction.prompt({
            type: 'manual_code',
            message: '输入测试授权码',
            placeholder: 'test-code',
          })
          if (code !== 'test-code') throw new Error('invalid synthetic code')
          return {
            type: 'oauth',
            refresh: 'synthetic-refresh',
            access: 'synthetic-access',
            expires: Date.now() + 3600000,
          }
        },
        async refresh(credential) {
          return credential
        },
        async toAuth() {
          return { apiKey: 'synthetic-oauth' }
        },
      },
    },
    getModels() {
      return [
        {
          id: 'auth-model',
          name: '认证测试模型',
          provider: 'huan-auth-test',
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:9/v1',
          input: ['text'],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ]
    },
    stream() {
      throw new Error('认证测试 provider 不提供聊天')
    },
    streamSimple() {
      throw new Error('认证测试 provider 不提供聊天')
    },
  })
}
`,
)

await mkdir(join(env.workspace, 'docs'), { recursive: true })
await mkdir(join(env.workspace, 'src'), { recursive: true })
await writeFile(join(env.workspace, 'docs', '指南 文件.md'), '# 指南\n')
await writeFile(join(env.workspace, 'src', 'main.ts'), 'export {}\n')
// 默认模型故意无效：空白页必须呈现错误并允许从模型选择器恢复。
// 压缩阈值调小，使浏览器验收里的短会话也能走真实的手动压缩路径。
await writeFile(
  join(env.agentDir, 'settings.json'),
  `${JSON.stringify(
    {
      defaultProvider: 'e2e-missing-provider',
      defaultModel: 'e2e-missing-model',
      compaction: { enabled: true, keepRecentTokens: 40, reserveTokens: 1_000 },
    },
    null,
    2,
  )}\n`,
)

const mcpFixtures = await startMcpFixtures(resolve(import.meta.dirname, 'mcp-stdio-fixture.mjs'))
const modelControl = installModelControl([mcpFixtures.oauthOrigin])

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

// 认证测试专用：取消合成 provider 的在途操作并退出登录，保证用例相互独立。
// 只作用于测试启动器注册的原生 provider，不进入生产应用。
app.post('/__e2e__/provider-auth/reset', async (c) => {
  const providerId = 'huan-auth-test'
  const initial = await host.getProviderAuth()
  for (const operation of initial.operations) {
    if (
      operation.providerId === providerId &&
      operation.phase !== 'succeeded' &&
      operation.phase !== 'failed' &&
      operation.phase !== 'cancelled'
    ) {
      await host.cancelProviderAuth(operation.id)
    }
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const snapshot = await host.getProviderAuth()
    const active = snapshot.operations.some(
      (operation) =>
        operation.providerId === providerId &&
        operation.phase !== 'succeeded' &&
        operation.phase !== 'failed' &&
        operation.phase !== 'cancelled',
    )
    const provider = snapshot.providers.find((item) => item.providerId === providerId)
    if (!active && provider && !provider.configured) return c.json({ ok: true })
    if (!active && provider) {
      const result = await host.logoutProvider(providerId)
      if (result.status === 'invalid') return c.json({ ok: true })
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return c.json({ ok: false }, 500)
})

// 创建隔离项目（可选写入项目扩展探针）；路径与会话都在临时根内。
app.post('/__e2e__/projects', async (c) => {
  const body = (await c.req.json()) as {
    name?: unknown
    extension?: unknown
    settings?: unknown
    askTrust?: unknown
    askStartup?: unknown
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
  if (body.askTrust === true || body.askStartup === true) {
    await mkdir(join(projectPath, '.pi'), { recursive: true })
    if (body.askTrust === true) await writeFile(join(projectPath, '.pi', 'ask-trust'), '')
    if (body.askStartup === true) await writeFile(join(projectPath, '.pi', 'ask-startup'), '')
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
// 设置文件读写：仅供设置面板测试读取/制造外部修改与冲突，不进入生产应用。
const settingsTargetPath = (scope: 'user' | 'project', projectPath?: string): string =>
  scope === 'user'
    ? join(env.agentDir, 'settings.json')
    : join(projectPath ?? env.workspace, '.pi', 'settings.json')

const withinTestRoot = (path: string): boolean => {
  const target = resolve(path)
  const roots = [resolve(env.root), resolve(env.agentDir)]
  return roots.some((root) => target === root || target.startsWith(`${root}${sep}`))
}

app.get('/__e2e__/settings-file', async (c) => {
  const scope = c.req.query('scope') === 'project' ? 'project' : 'user'
  const path = settingsTargetPath(scope, c.req.query('projectPath') ?? undefined)
  if (!withinTestRoot(path)) return c.json({ error: 'outside-scope' }, 400)
  const content = await readFile(path, 'utf8').catch(() => null)
  return c.json({ path, content })
})

app.put('/__e2e__/settings-file', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    scope?: unknown
    projectPath?: unknown
    content?: unknown
  }
  const scope = body.scope === 'project' ? 'project' : 'user'
  const path = settingsTargetPath(
    scope,
    typeof body.projectPath === 'string' ? body.projectPath : undefined,
  )
  if (!withinTestRoot(path)) return c.json({ error: 'outside-scope' }, 400)
  if (typeof body.content === 'string') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body.content)
  } else {
    await rm(path, { force: true })
  }
  return c.body(null, 204)
})

// MCP 配置读写：仅供浏览器测试制造外部 revision、准备独立 target 与清理。
const mcpTargetPath = (scope: 'user' | 'project', projectPath?: string): string =>
  scope === 'user'
    ? join(env.agentDir, 'mcp.json')
    : join(projectPath ?? env.workspace, '.pi', 'mcp.json')

app.get('/__e2e__/mcp-file', async (c) => {
  const scope = c.req.query('scope') === 'project' ? 'project' : 'user'
  const path = mcpTargetPath(scope, c.req.query('projectPath') ?? undefined)
  if (!withinTestRoot(path)) return c.json({ error: 'outside-scope' }, 400)
  const content = await readFile(path, 'utf8').catch(() => null)
  return c.json({ path, content })
})

app.put('/__e2e__/mcp-file', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    scope?: unknown
    projectPath?: unknown
    content?: unknown
  }
  const scope = body.scope === 'project' ? 'project' : 'user'
  const path = mcpTargetPath(
    scope,
    typeof body.projectPath === 'string' ? body.projectPath : undefined,
  )
  if (!withinTestRoot(path)) return c.json({ error: 'outside-scope' }, 400)
  if (typeof body.content === 'string') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body.content)
  } else {
    await rm(path, { force: true })
  }
  return c.body(null, 204)
})

app.get('/__e2e__/mcp-fixture', (c) =>
  c.json({
    stdioFixturePath: mcpFixtures.stdioFixturePath,
    oauthOrigin: mcpFixtures.oauthOrigin,
    oauthResourceUrl: mcpFixtures.oauthResourceUrl,
    nodePath: mcpFixtures.nodePath,
  }),
)

// 测试控制面：在临时用户空间/工作区内写入文件（扩展、模板、指令探针）。
// 只允许 env.agentDir 与 env.workspace 下的路径；不进入生产应用。
app.put('/__e2e__/file', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    root?: unknown
    path?: unknown
    content?: unknown
  }
  const root =
    body.root === 'agent' ? env.agentDir : body.root === 'workspace' ? env.workspace : undefined
  const relative = typeof body.path === 'string' ? body.path : ''
  if (!root || !relative || relative.includes('..') || typeof body.content !== 'string') {
    return c.json({ error: 'invalid-file-write' }, 400)
  }
  const target = join(root, relative)
  if (!withinTestRoot(target)) return c.json({ error: 'outside-scope' }, 400)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body.content)
  return c.body(null, 204)
})
app.delete('/__e2e__/file', async (c) => {
  const root = c.req.query('root') === 'agent' ? env.agentDir : env.workspace
  const relative = c.req.query('path') ?? ''
  if (!relative || relative.includes('..')) return c.json({ error: 'invalid-file-write' }, 400)
  const target = join(root, relative)
  if (!withinTestRoot(target)) return c.json({ error: 'outside-scope' }, 400)
  await rm(target, { force: true })
  return c.body(null, 204)
})

app.get('/__e2e__/file', async (c) => {
  const root = c.req.query('root') === 'agent' ? env.agentDir : env.workspace
  const relative = c.req.query('path') ?? ''
  if (!relative || relative.includes('..')) return c.json({ error: 'invalid-file-read' }, 400)
  const target = join(root, relative)
  if (!withinTestRoot(target)) return c.json({ error: 'outside-scope' }, 400)
  const content = await readFile(target, 'utf8').catch(() => null)
  return c.json({ content })
})

app.get('/__e2e__/process-alive', (c) => {
  const pid = Number(c.req.query('pid'))
  if (!Number.isInteger(pid) || pid <= 0) return c.json({ error: 'invalid-pid' }, 400)
  try {
    process.kill(pid, 0)
    return c.json({ alive: true })
  } catch (error) {
    return c.json({ alive: (error as NodeJS.ErrnoException).code !== 'ESRCH' })
  }
})

// 外部 Pi 会话：用于验证「显式刷新重新扫描作用域」能发现宿主启动后新增的文件。
// 刻意不经宿主 API 创建，也不写入 huan 工作区元数据（应出现在未归属分组）。
app.post('/__e2e__/sessions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; name?: unknown }
  const text = typeof body.text === 'string' ? body.text : '外部会话'
  const manager = SessionManager.create(env.workspace, env.defaultSessionDir(env.workspace))
  if (typeof body.name === 'string' && body.name) manager.appendSessionInfo(body.name)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  return c.json({ id: manager.getSessionId(), path: manager.getSessionFile() ?? null })
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

app.post('/__e2e__/model-turns', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { turns?: unknown }
  if (!Array.isArray(body.turns)) return c.json({ error: 'invalid-turns' }, 400)
  modelControl.configureTurns(body.turns as Parameters<typeof modelControl.configureTurns>[0])
  return c.body(null, 204)
})
// 让所有在途事件流正常结束，客户端应读到 EOF 并重连。
app.post('/__e2e__/disconnect', (c) => {
  for (const stream of liveSseStreams) stream.close()
  liveSseStreams.clear()
  return c.body(null, 204)
})

// 生产性能验证复用相同隔离宿主，只切换静态页面服务。
const appRoot = resolve(import.meta.dirname, '..')

async function startProductionPreview() {
  // 按当前源码构建临时产物：旧 dist 可能滞后，也无法带上仅 e2e 的观测探针。
  const outDir = resolve(tempParent, 'preview')
  await build({
    root: appRoot,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
    plugins: [renderReviewPlugin()],
  })
  return preview({
    root: appRoot,
    build: { outDir },
    preview: { host: '127.0.0.1', port: E2E_APP_PORT, strictPort: true },
  })
}

const vite =
  process.env.HUAN_E2E_PREVIEW === '1'
    ? await startProductionPreview()
    : await createViteServer({
        root: appRoot,
        server: { host: '127.0.0.1', port: E2E_APP_PORT, strictPort: true },
      })
if ('listen' in vite) await vite.listen()
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
  await mcpFixtures.close().catch(() => {})
  await env.cleanup().catch(() => {})
  console.log('[e2e] 已释放临时目录')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
