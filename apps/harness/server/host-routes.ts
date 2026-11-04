import type { HarnessClient, HarnessHostUiResponse } from '@huan/protocol'
import type { Hono } from 'hono'
import type { ServerConfig } from './config.js'
import { createHostGuard, createSecurityMiddleware } from './security.js'

/** 与 core 的子任务 ID 规则一致：只允许安全字符，避免路径穿越。 */
const SAFE_SUBAGENT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

const isSafeSubagentId = (value: string): boolean => SAFE_SUBAGENT_ID.test(value)

/**
 * 子任务 Host UI 应答守卫：只校验传输字段形状。
 *
 * 子任务请求的 kind 不在本层可见，confirm/select/input/editor 是否接受该
 * 应答交由 core 按待答请求校验。
 */
const parseSubagentResponse = (value: unknown): HarnessHostUiResponse | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const response = value as {
    requestId?: unknown
    confirmed?: unknown
    value?: unknown
    dismissed?: unknown
  }
  if (typeof response.requestId !== 'string' || response.requestId.length === 0) return undefined
  const shaped = [
    typeof response.confirmed === 'boolean',
    typeof response.value === 'string',
    response.dismissed === true,
  ].filter(Boolean)
  return shaped.length === 1 ? (value as HarnessHostUiResponse) : undefined
}

/** 统一注册宿主边界：health 只公开存活状态，路径和诊断必须鉴权后查询。 */
export function registerHostRoutes(
  app: Hono,
  client: Pick<
    HarnessClient,
    'getHostInfo' | 'getSubagentTask' | 'cancelSubagentTask' | 'respondSubagentTask'
  >,
  config: ServerConfig,
) {
  app.use('/api/pi/*', createHostGuard(config))
  app.get('/api/pi/health', (c) => c.json({ ok: true }))
  app.use('/api/pi/*', createSecurityMiddleware(config))
  app.get('/api/pi/host', async (c) => c.json(await client.getHostInfo()))

  // 子任务只读查看/逐任务取消/待答交互应答：与宿主状态共用同一鉴权。
  // 读取只按父会话路径转发 core，不激活父会话、不读取父快照，也不启动模型；
  // 父 ID 与任务摘要的归属关系由 core 校验。
  app.get('/api/pi/threads/:threadId/subagents/:taskId', async (c) => {
    const parentThreadId = c.req.param('threadId')
    const taskId = c.req.param('taskId')
    if (!isSafeSubagentId(parentThreadId) || !isSafeSubagentId(taskId)) {
      return c.json({ error: 'invalid-subagent-input' }, 400)
    }
    return c.json(await client.getSubagentTask(parentThreadId, taskId))
  })

  app.post('/api/pi/threads/:threadId/subagents/:taskId/cancel', async (c) => {
    const parentThreadId = c.req.param('threadId')
    const taskId = c.req.param('taskId')
    if (!isSafeSubagentId(parentThreadId) || !isSafeSubagentId(taskId)) {
      return c.json({ error: 'invalid-subagent-input' }, 400)
    }
    await client.cancelSubagentTask(parentThreadId, taskId)
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:threadId/subagents/:taskId/respond', async (c) => {
    const parentThreadId = c.req.param('threadId')
    const taskId = c.req.param('taskId')
    if (!isSafeSubagentId(parentThreadId) || !isSafeSubagentId(taskId)) {
      return c.json({ error: 'invalid-subagent-input' }, 400)
    }
    const body = (await c.req.json().catch(() => ({}))) as { response?: unknown }
    const response = parseSubagentResponse(body.response)
    if (!response) return c.json({ error: 'invalid-subagent-input' }, 400)
    await client.respondSubagentTask(parentThreadId, taskId, response)
    return c.body(null, 204)
  })
}
