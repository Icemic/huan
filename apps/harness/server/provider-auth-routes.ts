/**
 * 模型认证 HTTP 路由（G1.4c）。
 *
 * 与普通 Host UI 通道分离：凭据回填只经本组路由进入认证 broker，不写入线程
 * 快照或扩展交互记录。所有请求沿用现有 Host/Origin/token 校验，POST 正文
 * 有独立小上限；URL 合法性由核心 broker 再校验一次。
 */
import type { HarnessClient, HarnessProviderAuthMethod } from '@huan/protocol'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/** 认证请求体上限：回填值本身另有 8KiB 字符限制。 */
export const PROVIDER_AUTH_BODY_LIMIT_BYTES = 16 * 1024

const isMethod = (value: unknown): value is HarnessProviderAuthMethod =>
  value === 'api_key' || value === 'oauth'

/** 注册认证快照、登录/退出、回填与取消；快照订阅由客户端轮询实现。 */
export function registerProviderAuthRoutes(
  app: Hono,
  client: Pick<
    HarnessClient,
    | 'getProviderAuth'
    | 'startProviderLogin'
    | 'respondProviderAuthPrompt'
    | 'cancelProviderAuth'
    | 'logoutProvider'
  >,
): void {
  app.use(
    '/api/pi/provider-auth/*',
    bodyLimit({
      maxSize: PROVIDER_AUTH_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'provider-auth-too-large' }, 413),
    }),
  )

  app.get('/api/pi/provider-auth', async (c) => c.json(await client.getProviderAuth()))

  app.post('/api/pi/provider-auth/login', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > PROVIDER_AUTH_BODY_LIMIT_BYTES) {
      return c.json({ error: 'provider-auth-too-large' }, 413)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      providerId?: unknown
      method?: unknown
    }
    if (typeof body.providerId !== 'string' || !body.providerId.trim() || !isMethod(body.method)) {
      return c.json({ error: 'invalid-provider-auth-input' }, 400)
    }
    return c.json(
      await client.startProviderLogin({ providerId: body.providerId, method: body.method }),
    )
  })

  app.post('/api/pi/provider-auth/logout', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { providerId?: unknown }
    if (typeof body.providerId !== 'string' || !body.providerId.trim()) {
      return c.json({ error: 'invalid-provider-auth-input' }, 400)
    }
    return c.json(await client.logoutProvider(body.providerId))
  })

  app.post('/api/pi/provider-auth/respond', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      operationId?: unknown
      promptId?: unknown
      value?: unknown
    }
    if (
      typeof body.operationId !== 'string' ||
      typeof body.promptId !== 'string' ||
      typeof body.value !== 'string'
    ) {
      return c.json({ error: 'invalid-provider-auth-input' }, 400)
    }
    // 不把提交值写回响应或错误；超长直接按输入错误拒绝。
    if (body.value.length > 8_192) {
      return c.json({ error: 'invalid-provider-auth-input' }, 400)
    }
    return c.json(
      await client.respondProviderAuthPrompt({
        operationId: body.operationId,
        promptId: body.promptId,
        value: body.value,
      }),
    )
  })

  app.post('/api/pi/provider-auth/cancel', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { operationId?: unknown }
    if (typeof body.operationId !== 'string') {
      return c.json({ error: 'invalid-provider-auth-input' }, 400)
    }
    return c.json(await client.cancelProviderAuth(body.operationId))
  })
}
