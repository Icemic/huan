import {
  ProjectTrustRequiredError,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceStateUnavailableError,
  WorkspaceValidationError,
} from '@huan/core'
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

  // 项目未取得信任时返回可识别的 409，页面先展示信任提示而不是通用错误。
  app.onError((error, c) => {
    if (error instanceof ProjectTrustRequiredError) {
      return c.json({ error: 'project-needs-trust', project: error.project }, 409)
    }
    if (error instanceof WorkspaceConflictError) {
      return c.json({ error: 'workspace-conflict' }, 409)
    }
    if (error instanceof WorkspaceStateUnavailableError) {
      return c.json({ error: 'workspace-state-unavailable', state: error.integrity }, 409)
    }
    if (error instanceof WorkspaceNotFoundError) {
      return c.json({ error: 'workspace-not-found' }, 404)
    }
    if (error instanceof WorkspaceValidationError) {
      return c.json({ error: 'workspace-invalid', reason: error.reason }, 400)
    }
    return c.json({ error: 'internal-error' }, 500)
  })

  registerHostRoutes(app, piClient, config)

  app.get('/api/pi/workspaces', async (c) => c.json(await piClient.listWorkspaces()))

  app.post('/api/pi/workspaces', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown
      projects?: unknown
    }
    return c.json(
      await piClient.createWorkspace({
        name: typeof body.name === 'string' ? body.name : '',
        projects: Array.isArray(body.projects)
          ? body.projects.flatMap((project) =>
              project !== null &&
              typeof project === 'object' &&
              typeof (project as { alias?: unknown }).alias === 'string' &&
              typeof (project as { path?: unknown }).path === 'string'
                ? [
                    {
                      alias: (project as { alias: string }).alias,
                      path: (project as { path: string }).path,
                    },
                  ]
                : [],
            )
          : [],
      }),
    )
  })

  app.patch('/api/pi/workspaces/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      expectedRevision?: unknown
      name?: unknown
      projects?: unknown
    }
    return c.json(
      await piClient.updateWorkspace({
        workspaceId: c.req.param('id'),
        expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : -1,
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(Array.isArray(body.projects)
          ? {
              projects: body.projects.flatMap((project) =>
                project !== null &&
                typeof project === 'object' &&
                typeof (project as { alias?: unknown }).alias === 'string' &&
                typeof (project as { path?: unknown }).path === 'string'
                  ? [
                      {
                        alias: (project as { alias: string }).alias,
                        path: (project as { path: string }).path,
                      },
                    ]
                  : [],
              ),
            }
          : {}),
      }),
    )
  })

  app.get('/api/pi/projects', async (c) => c.json(await piClient.listRecentProjects()))

  app.post('/api/pi/projects/check', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown }
    return c.json(await piClient.checkProjectPath(typeof body.path === 'string' ? body.path : ''))
  })

  app.get('/api/pi/projects/info', async (c) => {
    return c.json(await piClient.getProject({ path: c.req.query('path') ?? '' }))
  })

  app.get('/api/pi/projects/trust-summary', async (c) => {
    return c.json(await piClient.inspectProjectTrust({ path: c.req.query('path') ?? '' }))
  })

  app.post('/api/pi/projects/trust', async (c) => {
    const body = (await c.req.json()) as { path?: unknown; trusted?: unknown; remember?: unknown }
    return c.json(
      await piClient.decideProjectTrust({
        path: typeof body.path === 'string' ? body.path : '',
        trusted: body.trusted === true,
        ...(body.remember === true ? { remember: true } : {}),
      }),
    )
  })

  app.get('/api/pi/threads', async (c) => {
    const workspaceId = c.req.query('workspaceId') ?? undefined
    const unassigned = c.req.query('unassigned') === 'true'
    const includeArchived = c.req.query('includeArchived') === 'true'
    return c.json(
      await piClient.listThreads({
        ...(workspaceId ? { workspaceId } : {}),
        ...(unassigned ? { unassigned } : {}),
        includeArchived,
      }),
    )
  })

  app.post('/api/pi/threads/:id/workspace', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: unknown }
    return c.json(
      await piClient.assignThreadWorkspace({
        threadId: c.req.param('id'),
        workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
      }),
    )
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
