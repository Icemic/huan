import {
  IMPORT_UPLOAD_MAX_BYTES,
  ImageInputUnsupportedError,
  ProjectTrustRequiredError,
  ReservedBuiltinCommandError,
  SETTINGS_CONTENT_MAX_BYTES,
  ThreadStructureBusyError,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceStateUnavailableError,
  WorkspaceValidationError,
} from '@huan/core'
import type { HarnessClient, HarnessThreadImportSource } from '@huan/protocol'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ServerConfig } from './config.js'
import { registerHostRoutes } from './host-routes.js'
import { registerMcpRoutes } from './mcp-routes.js'
import { registerProviderAuthRoutes } from './provider-auth-routes.js'
import { createEventsRoute, createHostInteractionEventsRoute } from './sse.js'

/**
 * 上传请求体的宽松上限：文本本身按 20MiB 限制，JSON 转义/包装需要少量余量。
 * 超过该 Content-Length 的请求在读取正文前直接拒绝。
 */
const IMPORT_BODY_LIMIT_BYTES = IMPORT_UPLOAD_MAX_BYTES + 4 * 1024 * 1024

/** 设置保存请求体上限：完整文件 + JSON 包装余量。 */
const SETTINGS_BODY_LIMIT_BYTES = SETTINGS_CONTENT_MAX_BYTES + 64 * 1024

/** 解析导入源（路径或上传文本）；无效输入返回 undefined。 */
function parseImportSource(value: unknown): HarnessThreadImportSource | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as { kind?: unknown; path?: unknown; filename?: unknown; content?: unknown }
  if (source.kind === 'path' && typeof source.path === 'string') {
    return { kind: 'path', path: source.path }
  }
  if (
    source.kind === 'upload' &&
    typeof source.filename === 'string' &&
    typeof source.content === 'string'
  ) {
    return { kind: 'upload', filename: source.filename, content: source.content }
  }
  return undefined
}

/** 上传文本超过限制时返回统一的 413。 */
const importTooLarge = (content: string | undefined): boolean =>
  content !== undefined && new TextEncoder().encode(content).byteLength > IMPORT_UPLOAD_MAX_BYTES

/** 只接受字符串数组的工作区模型范围（null/缺失不在此处处理）。 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** 工作区成员请求体的受控投影：忽略非法项，保持既有路由的宽容行为。 */
const workspaceProjectsOf = (value: unknown): { alias: string; path: string }[] =>
  Array.isArray(value)
    ? value.flatMap((project) =>
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
    : []

/**
 * 解析设置/资源目标：threadId、workspacePath、global 必须恰好提供一个。
 * 返回的对象可直接作为宿主输入；缺失、同时出现或不允许的 global 为 undefined。
 */
function parseConfigTarget(
  threadId: string | undefined,
  workspacePath: string | undefined,
  global: string | undefined = undefined,
  allowGlobal = false,
): { threadId?: string; workspacePath?: string; global?: true } | undefined {
  const wantsGlobal = global === 'true'
  if (global !== undefined && !wantsGlobal) return undefined
  const hasThread = typeof threadId === 'string' && threadId.trim().length > 0
  const hasPath = typeof workspacePath === 'string' && workspacePath.trim().length > 0
  if (wantsGlobal) {
    if (!allowGlobal || hasThread || hasPath) return undefined
    return { global: true }
  }
  if (hasThread === hasPath) return undefined
  return hasThread ? { threadId: threadId?.trim() } : { workspacePath: workspacePath?.trim() }
}

/** 解析设置保存请求体中的目标对象；只有设置/资源支持 global。 */
function parseConfigTargetObject(
  value: unknown,
  allowGlobal = false,
): { threadId?: string; workspacePath?: string; global?: true } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const target = value as { threadId?: unknown; workspacePath?: unknown; global?: unknown }
  if (target.threadId !== undefined && typeof target.threadId !== 'string') return undefined
  if (target.workspacePath !== undefined && typeof target.workspacePath !== 'string')
    return undefined
  if (target.global !== undefined && typeof target.global !== 'boolean') return undefined
  return parseConfigTarget(
    target.threadId,
    target.workspacePath,
    target.global === true ? 'true' : undefined,
    allowGlobal,
  )
}

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
    if (error instanceof ThreadStructureBusyError) {
      return c.json({ error: 'thread-structure-busy', message: error.message }, 409)
    }
    if (error instanceof ReservedBuiltinCommandError) {
      return c.json(
        { error: 'reserved-builtin-command', command: error.command, message: error.message },
        409,
      )
    }
    if (error instanceof ImageInputUnsupportedError) {
      return c.json(
        {
          error: 'image-input-unsupported',
          provider: error.provider,
          modelId: error.modelId,
          message: error.message,
        },
        415,
      )
    }
    return c.json({ error: 'internal-error' }, 500)
  })

  registerHostRoutes(app, piClient, config)
  registerProviderAuthRoutes(app, piClient)
  registerMcpRoutes(app, piClient)

  app.get('/api/pi/workspaces', async (c) => c.json(await piClient.listWorkspaces()))

  app.post('/api/pi/workspaces', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown
      projects?: unknown
      modelPatterns?: unknown
    }
    return c.json(
      await piClient.createWorkspace({
        name: typeof body.name === 'string' ? body.name : '',
        projects: workspaceProjectsOf(body.projects),
        ...(isStringArray(body.modelPatterns) ? { modelPatterns: body.modelPatterns } : {}),
      }),
    )
  })

  app.patch('/api/pi/workspaces/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      expectedRevision?: unknown
      name?: unknown
      projects?: unknown
      modelPatterns?: unknown
    }
    return c.json(
      await piClient.updateWorkspace({
        workspaceId: c.req.param('id'),
        expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : -1,
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(Array.isArray(body.projects) ? { projects: workspaceProjectsOf(body.projects) } : {}),
        ...(body.modelPatterns === null
          ? { modelPatterns: null }
          : isStringArray(body.modelPatterns)
            ? { modelPatterns: body.modelPatterns }
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
    const refresh = c.req.query('refresh') === 'true'
    return c.json(
      await piClient.listThreads({
        ...(workspaceId ? { workspaceId } : {}),
        ...(unassigned ? { unassigned } : {}),
        includeArchived,
        ...(refresh ? { refresh } : {}),
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
    return c.json(await piClient.createThread(body, { callerId: c.req.header('x-huan-caller') }))
  })

  app.get('/api/pi/threads/:id', async (c) => {
    return c.json(await piClient.getThread(c.req.param('id')))
  })

  // 只读详情：受同一 Host/Origin/凭证中间件保护，不订阅、不隐式激活冷会话。
  app.get('/api/pi/threads/:id/details', async (c) => {
    return c.json(await piClient.getThreadDetails(c.req.param('id')))
  })

  // 资源命令目录：会话优先；空白页必须显式给固定起始目录。
  app.get('/api/pi/commands', async (c) => {
    const threadId = c.req.query('threadId') ?? undefined
    const workspacePath = c.req.query('workspacePath') ?? undefined
    if (!threadId && !workspacePath) return c.json({ error: 'invalid-command-input' }, 400)
    return c.json(
      await piClient.listCommands({
        ...(threadId ? { threadId } : {}),
        ...(workspacePath ? { workspacePath } : {}),
      }),
    )
  })

  // 设置：目标必须显式二选一；读取不加载项目扩展（未信任时不读项目原文）。
  app.get('/api/pi/settings', async (c) => {
    const target = parseConfigTarget(
      c.req.query('threadId'),
      c.req.query('workspacePath'),
      c.req.query('global'),
      true,
    )
    if (!target) return c.json({ error: 'invalid-config-target' }, 400)
    return c.json(await piClient.getSettings(target))
  })

  app.use(
    '/api/pi/settings',
    bodyLimit({
      maxSize: SETTINGS_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'settings-too-large' }, 413),
    }),
  )

  // 保存：完整文件语义 + 乐观 revision；保存与应用分开，不在本请求内重载。
  app.put('/api/pi/settings', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > SETTINGS_BODY_LIMIT_BYTES) {
      return c.json({ error: 'settings-too-large' }, 413)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      target?: unknown
      scope?: unknown
      content?: unknown
      expectedRevision?: unknown
    }
    const target = parseConfigTargetObject(body.target, true)
    if (
      !target ||
      (target.global === true && body.scope !== 'user') ||
      (body.scope !== 'user' && body.scope !== 'project') ||
      typeof body.content !== 'string' ||
      (body.expectedRevision !== null && typeof body.expectedRevision !== 'string')
    ) {
      return c.json({ error: 'invalid-settings-input' }, 400)
    }
    if (Buffer.byteLength(body.content, 'utf8') > SETTINGS_CONTENT_MAX_BYTES) {
      return c.json({ error: 'settings-too-large' }, 413)
    }
    const result = await piClient.saveSettings({
      target,
      scope: body.scope,
      content: body.content,
      expectedRevision: body.expectedRevision,
    })
    if (result.status === 'conflict') {
      return c.json({ error: 'settings-conflict', ...result }, 409)
    }
    if (result.status === 'untrusted') {
      return c.json({ error: 'settings-untrusted', ...result }, 409)
    }
    if (result.status === 'too-large') {
      return c.json({ error: 'settings-too-large', ...result }, 413)
    }
    if (result.status === 'failed') {
      return c.json({ error: 'settings-write-failed', ...result }, 500)
    }
    return c.json(result)
  })

  // 资源清单：只读现有 loader；文本需显式 includeText。
  app.get('/api/pi/resources', async (c) => {
    const target = parseConfigTarget(c.req.query('threadId'), c.req.query('workspacePath'))
    if (!target) return c.json({ error: 'invalid-config-target' }, 400)
    return c.json(
      await piClient.getResources({
        ...target,
        ...(c.req.query('includeText') === 'true' ? { includeText: true } : {}),
      }),
    )
  })

  // 资源重载：会话或空白页目标二选一；busy/failed 都如实返回，不伪报成功。
  // 触发来源只用于展示，不参与授权；省略时按 api 处理。
  app.post('/api/pi/reload', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      target?: unknown
      trigger?: unknown
    }
    const target = parseConfigTargetObject(body.target)
    if (!target) return c.json({ error: 'invalid-config-target' }, 400)
    if (
      body.trigger !== undefined &&
      body.trigger !== 'command' &&
      body.trigger !== 'settings' &&
      body.trigger !== 'extension' &&
      body.trigger !== 'api'
    ) {
      return c.json({ error: 'invalid-reload-trigger' }, 400)
    }
    return c.json(
      await piClient.reloadResources({
        ...target,
        ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
      }),
    )
  })

  // 扩展参数补全：按需调用，空结果表示该命令没有补全。
  app.post('/api/pi/commands/arguments', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: unknown
      workspacePath?: unknown
      name?: unknown
      prefix?: unknown
    }
    if (
      typeof body.name !== 'string' ||
      !body.name ||
      typeof body.prefix !== 'string' ||
      (body.threadId !== undefined && typeof body.threadId !== 'string') ||
      (body.workspacePath !== undefined && typeof body.workspacePath !== 'string')
    ) {
      return c.json({ error: 'invalid-command-input' }, 400)
    }
    return c.json(
      await piClient.getCommandArgumentCompletions(
        {
          name: body.name,
          prefix: body.prefix,
          ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
          ...(typeof body.workspacePath === 'string' ? { workspacePath: body.workspacePath } : {}),
        },
        { signal: c.req.raw.signal },
      ),
    )
  })

  // 文件引用：只返回路径/类型；请求中止会停止宿主侧目录遍历。
  app.post('/api/pi/files', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: unknown
      workspaceId?: unknown
      workspacePath?: unknown
      query?: unknown
      limit?: unknown
    }
    if (
      (body.threadId !== undefined && typeof body.threadId !== 'string') ||
      (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') ||
      (body.workspacePath !== undefined && typeof body.workspacePath !== 'string') ||
      (body.query !== undefined && typeof body.query !== 'string') ||
      (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit)))
    ) {
      return c.json({ error: 'invalid-file-input' }, 400)
    }
    return c.json(
      await piClient.searchFiles(
        {
          ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
          ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
          ...(typeof body.workspacePath === 'string' ? { workspacePath: body.workspacePath } : {}),
          ...(typeof body.query === 'string' ? { query: body.query } : {}),
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        },
        { signal: c.req.raw.signal },
      ),
    )
  })

  // 会话树：按需读取；冷树不装配项目扩展。
  app.get('/api/pi/threads/:id/tree', async (c) => {
    return c.json(await piClient.getThreadTree(c.req.param('id')))
  })

  app.post('/api/pi/threads/:id/tree/navigate', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetId?: unknown
      expectedRevision?: unknown
      summarize?: unknown
      customInstructions?: unknown
      replaceInstructions?: unknown
      stopRunning?: unknown
    }
    if (typeof body.targetId !== 'string' || typeof body.expectedRevision !== 'string') {
      return c.json({ error: 'invalid-tree-input' }, 400)
    }
    return c.json(
      await piClient.navigateThreadTree(c.req.param('id'), {
        targetId: body.targetId,
        expectedRevision: body.expectedRevision,
        ...(body.summarize === true ? { summarize: true } : {}),
        ...(typeof body.customInstructions === 'string'
          ? { customInstructions: body.customInstructions }
          : {}),
        ...(body.replaceInstructions === true ? { replaceInstructions: true } : {}),
        ...(body.stopRunning === true ? { stopRunning: true } : {}),
      }),
    )
  })

  app.post('/api/pi/threads/:id/tree/label', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      entryId?: unknown
      label?: unknown
      expectedRevision?: unknown
    }
    if (typeof body.entryId !== 'string') {
      return c.json({ error: 'invalid-tree-input' }, 400)
    }
    return c.json(
      await piClient.setThreadEntryLabel(c.req.param('id'), {
        entryId: body.entryId,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.expectedRevision === 'string'
          ? { expectedRevision: body.expectedRevision }
          : {}),
      }),
    )
  })

  app.post('/api/pi/threads/:id/tree/cancel', async (c) => {
    return c.json(await piClient.cancelThreadTreeNavigation(c.req.param('id')))
  })

  // fork/clone：扩展取消/父会话繁忙都返回可识别的 result.status，不抛通用错误。
  app.post('/api/pi/threads/:id/fork', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      entryId?: unknown
      position?: unknown
      expectedRevision?: unknown
    }
    if (body.position !== undefined && body.position !== 'before' && body.position !== 'at') {
      return c.json({ error: 'invalid-fork-input' }, 400)
    }
    if (body.entryId !== undefined && typeof body.entryId !== 'string') {
      return c.json({ error: 'invalid-fork-input' }, 400)
    }
    if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'string') {
      return c.json({ error: 'invalid-fork-input' }, 400)
    }
    return c.json(
      await piClient.forkThread(c.req.param('id'), {
        ...(typeof body.entryId === 'string' ? { entryId: body.entryId } : {}),
        ...(body.position === 'before' || body.position === 'at'
          ? { position: body.position }
          : {}),
        ...(typeof body.expectedRevision === 'string'
          ? { expectedRevision: body.expectedRevision }
          : {}),
      }),
    )
  })

  app.use(
    '/api/pi/threads/import/*',
    bodyLimit({
      maxSize: IMPORT_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'import-too-large' }, 413),
    }),
  )
  app.use(
    '/api/pi/threads/import',
    bodyLimit({
      maxSize: IMPORT_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'import-too-large' }, 413),
    }),
  )

  // 导入预览：只读文件/目录/冲突，不装配项目；上传文本按 20MiB 上限拒绝。
  app.post('/api/pi/threads/import/preview', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > IMPORT_BODY_LIMIT_BYTES) {
      return c.json({ error: 'import-too-large' }, 413)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: unknown
      workspaceId?: unknown
      cwdOverride?: unknown
    }
    const source = parseImportSource(body.source)
    if (!source) return c.json({ error: 'invalid-import-input' }, 400)
    if (source.kind === 'upload' && importTooLarge(source.content)) {
      return c.json({ error: 'import-too-large' }, 413)
    }
    return c.json(
      await piClient.previewThreadImport({
        source,
        ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
        ...(typeof body.cwdOverride === 'string' ? { cwdOverride: body.cwdOverride } : {}),
      }),
    )
  })

  // 确认导入：必须带目标工作区；源会重新读取并校验，预览不是授权令牌。
  app.post('/api/pi/threads/import', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > IMPORT_BODY_LIMIT_BYTES) {
      return c.json({ error: 'import-too-large' }, 413)
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: unknown
      workspaceId?: unknown
      cwdOverride?: unknown
      asCopy?: unknown
      expectedSourceId?: unknown
      expectedSourceFingerprint?: unknown
    }
    const source = parseImportSource(body.source)
    if (!source || typeof body.workspaceId !== 'string' || !body.workspaceId) {
      return c.json({ error: 'invalid-import-input' }, 400)
    }
    if (source.kind === 'upload' && importTooLarge(source.content)) {
      return c.json({ error: 'import-too-large' }, 413)
    }
    return c.json(
      await piClient.importThread({
        source,
        workspaceId: body.workspaceId,
        ...(typeof body.cwdOverride === 'string' ? { cwdOverride: body.cwdOverride } : {}),
        ...(body.asCopy === true ? { asCopy: true } : {}),
        ...(typeof body.expectedSourceId === 'string'
          ? { expectedSourceId: body.expectedSourceId }
          : {}),
        ...(typeof body.expectedSourceFingerprint === 'string'
          ? { expectedSourceFingerprint: body.expectedSourceFingerprint }
          : {}),
      }),
    )
  })

  app.patch('/api/pi/threads/:id', async (c) => {
    const { title } = await c.req.json()
    await piClient.renameThread(c.req.param('id'), title)
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/messages', async (c) => {
    const { input } = await c.req.json()
    const callerId = c.req.header('x-huan-caller')?.trim()
    return c.json(
      await piClient.sendMessage(c.req.param('id'), input, callerId ? { callerId } : undefined),
    )
  })

  app.post('/api/pi/threads/:id/cancel', async (c) => {
    await piClient.cancelRun(c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/pi/threads/:id/queue/clear', async (c) => {
    return c.json(await piClient.clearQueue(c.req.param('id')))
  })

  // 直接 Shell（! / !!）：返回 started 即已登记，输出经 bash_* 事件同步。
  app.post('/api/pi/threads/:id/bash', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      command?: unknown
      excludeFromContext?: unknown
    }
    if (
      typeof body.command !== 'string' ||
      (body.excludeFromContext !== undefined && typeof body.excludeFromContext !== 'boolean')
    ) {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    return c.json(
      await piClient.runThreadBash(c.req.param('id'), {
        command: body.command,
        ...(body.excludeFromContext === true ? { excludeFromContext: true } : {}),
      }),
    )
  })

  app.post('/api/pi/threads/:id/bash/abort', async (c) => {
    return c.json(await piClient.abortThreadBash(c.req.param('id')))
  })

  // 手动压缩：失败/取消都返回可识别 status，原始历史由宿主保留。
  app.post('/api/pi/threads/:id/compact', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { customInstructions?: unknown }
    if (body.customInstructions !== undefined && typeof body.customInstructions !== 'string') {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    return c.json(
      await piClient.compactThread(c.req.param('id'), {
        ...(typeof body.customInstructions === 'string'
          ? { customInstructions: body.customInstructions }
          : {}),
      }),
    )
  })

  app.post('/api/pi/threads/:id/compact/abort', async (c) => {
    return c.json(await piClient.abortThreadCompaction(c.req.param('id')))
  })

  // 自动压缩开关：保存到当前 agentDir 用户设置；写盘失败如实返回 failed。
  app.post('/api/pi/threads/:id/auto-compaction', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    return c.json(await piClient.setAutoCompaction(c.req.param('id'), body.enabled))
  })

  app.get('/api/pi/models', async (c) => {
    const workspacePath = c.req.query('workspacePath') ?? undefined
    const workspaceId = c.req.query('workspaceId') ?? undefined
    const threadId = c.req.query('threadId') ?? undefined
    const all = c.req.query('all') === 'true'
    return c.json(
      await piClient.getAvailableModels({
        ...(workspacePath ? { workspacePath } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(all ? { all: true } : {}),
      }),
    )
  })

  // 显式目录刷新：会话、固定起始目录或已有共享注册表（global）三选一。
  app.post('/api/pi/models/refresh', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: unknown
      workspacePath?: unknown
      global?: unknown
    }
    if (body.threadId !== undefined && (typeof body.threadId !== 'string' || !body.threadId)) {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    if (
      body.workspacePath !== undefined &&
      (typeof body.workspacePath !== 'string' || !body.workspacePath)
    ) {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    if (body.global !== undefined && typeof body.global !== 'boolean') {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    const global = body.global === true
    if (global && (body.threadId !== undefined || body.workspacePath !== undefined)) {
      return c.json({ error: 'invalid-runtime-input' }, 400)
    }
    return c.json(
      await piClient.refreshModels({
        ...(global ? { global: true } : {}),
        ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
        ...(typeof body.workspacePath === 'string' ? { workspacePath: body.workspacePath } : {}),
      }),
    )
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

  // 消费会话级 Host UI 指令（编辑器文本/命令目标）；幂等，未知 ID 也成功。
  app.post('/api/pi/threads/:id/host-ui/consume', async (c) => {
    const { id } = await c.req.json().catch(() => ({ id: undefined }))
    if (typeof id !== 'string' || !id) return c.json({ error: 'invalid-directive-id' }, 400)
    return c.json({
      accepted: await piClient.consumeHostUiDirective(c.req.param('id'), id, {
        callerId: c.req.header('x-huan-caller'),
      }),
    })
  })

  // 宿主级交互：启动装配期也可查询/应答，不依赖选中会话。
  app.get('/api/pi/interactions', async (c) => c.json(await piClient.getHostInteractions()))
  app.post('/api/pi/interactions/respond', async (c) => {
    const { response } = await c.req.json()
    return c.json(await piClient.respondToHostInteraction(response))
  })
  app.get('/api/pi/interactions/events', createHostInteractionEventsRoute(piClient))

  // SSE 事件流：快照优先（?snapshot=false 跳过）；断开只退订，不中止运行。
  app.get('/api/pi/threads/:id/events', createEventsRoute(piClient))

  return app
}
