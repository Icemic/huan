/**
 * `createHarnessHttpClient`——浏览器侧 `HarnessClient`，由一层薄 HTTP/SSE
 * 路由对接宿主的 `@huan/core` 宿主实现。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/client/httpClient.ts`
 * （MIT 许可）。改动：
 * - 类型改用 `@huan/protocol`（含 `createThread` 的 `model` / `thinkingLevel`
 *   扩展字段——react-pi 类型未声明）；
 * - 命名 `Pi*` → `Harness*`；上游内部工具改从 `../vendor/anti-corruption.js`
 *   引入；注释译为中文；
 * - `subscribe` 由 `createSharedStreamCache`（多组件共享单个 SSE 连接，
 *   469 行）改为**单订阅实现**——见下。
 *
 * **订阅实现说明**：上游用 sharedStreamCache 让同页多个组件共享一条 SSE 连接。
 * 本项目经调研（迭代文档决策点 5）确认无此场景，故不移植共享逻辑，
 * 但保留其**对外语义**：每次 subscribe 建立独立连接；`includeSnapshot: false`
 * 时首帧跳过快照、断线重连切到带快照的 URL 以恢复；终止性流错误
 *（解码器大小/配置限制）向监听者投递带外 error 事件并关闭连接。
 * 防抖由 Controller 侧的 30 秒断开定时器承担，客户端不再叠加延迟。
 *
 * 浏览器安全：不导入任何 Pi SDK 包。路由层是唯一接触 Pi SDK 之处，
 * 且位于服务端的 `@huan/core` 中。
 *
 * 线契约（相对 `baseUrl`，默认 `/api/pi`）：
 *   GET    /workspaces              → HarnessWorkspaceCatalog
 *   POST   /workspaces              → HarnessWorkspaceMutationResult (body: 创建输入)
 *   PATCH  /workspaces/:id          → HarnessWorkspaceMutationResult (body: 修改输入)
 *   GET    /threads                 → HarnessThreadMetadata[]   (?workspaceId=&unassigned=&includeArchived=&refresh=)
 *   POST   /threads                 → HarnessThreadSnapshot      (body: workspaceId + startProjectPath 等)
 *   POST   /threads/:id/workspace   → HarnessAssignThreadResult  (body: { workspaceId })
 *   GET    /threads/:id             → HarnessThreadSnapshot
 *   GET    /threads/:id/details     → HarnessThreadDetails       (只读详情与累计统计)
 *   PATCH  /threads/:id             → 204                        (body: { title })
 *   POST   /threads/:id/messages    → 204                        (body: { input })
 *   POST   /threads/:id/cancel      → 204
 *   POST   /threads/:id/queue/clear → { steering, followUp }      (被清空的文本)
 *   GET    /projects                → HarnessRecentProject[]
 *   POST   /projects/check          → HarnessProjectPathCheck     (body: { path })
 *   GET    /projects/info?path=     → HarnessProjectInfo
 *   GET    /projects/trust-summary?path= → HarnessProjectInfo     (只读信任摘要)
 *   POST   /projects/trust          → HarnessProjectInfo          (body: { path, trusted, remember? })
 *   GET    /models                  → HarnessModelInfo[]
 *   POST   /threads/:id/model       → 204                        (body: { provider, modelId })
 *   POST   /threads/:id/thinking    → 204                        (body: { level })
 *   POST   /threads/:id/archive     → 204
 *   POST   /threads/:id/unarchive   → 204
 *   DELETE /threads/:id             → 204（线程本就不存在时同样）
 *   POST   /threads/:id/host-ui     → 204                        (body: { response })
 *   GET    /threads/:id/events      → HarnessClientEvent 的 SSE（?snapshot=false 跳过首帧快照）
 */

import type {
  HarnessClient,
  HarnessClientEvent,
  HarnessHostInfo,
  HarnessHostUiResponse,
  HarnessModelInfo,
  HarnessProjectInfo,
  HarnessProjectPathCheck,
  HarnessProjectTrustInput,
  HarnessRecentProject,
  HarnessSendMessageInput,
  HarnessThinkingLevel,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceMutationResult,
} from '@huan/protocol'
import { invokeUserCallback, isRecord } from '../vendor/anti-corruption.js'
import { createHarnessEventStreamConnection, isTerminalStreamError } from './event-source.js'
import { isThreadDetails, isThreadMetadata, isThreadSnapshot } from './validation.js'

/** HTTP 客户端选项。 */
export interface HarnessHttpClientOptions {
  /** 路由层的基路径/URL。默认 `/api/pi`。 */
  baseUrl?: string
  /** 注入的 `fetch`（默认全局）。 */
  fetchImpl?: typeof fetch
  /** 应用于每个请求的额外头（如鉴权）。 */
  headers?: Record<string, string>
  /**
   * SSE 流错误。其后会重连，除非是解码器限制错误——那会结束流并向监听者
   * 发送一条 error 事件。
   */
  onStreamError?: (error: unknown) => void
  /** 事件流重连退避；为测试可注入。 */
  reconnectDelay?: () => Promise<void>
  /** 单条 SSE 行接受的最大 UTF-16 码元数。默认 16 MiB。 */
  maxStreamLineLength?: number | undefined
  /** 单个 SSE 事件累计保留的最大 UTF-16 码元数。默认 16 MiB。 */
  maxStreamEventLength?: number | undefined
}

const trimTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value

/** 对任何非 2xx 响应抛出可诊断错误（含响应体）。 */
const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return
  const body = await response.text().catch(() => '')
  throw new Error(
    `Pi HTTP request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`,
  )
}

const invalidResponse = (operation: string, expectation: string, cause?: unknown): Error =>
  new Error(
    `Invalid Pi HTTP response while ${operation}: ${expectation}`,
    cause === undefined ? undefined : { cause },
  )

const readJson = async (response: Response, operation: string): Promise<unknown> => {
  await assertOk(response)
  try {
    return await response.json()
  } catch (error) {
    throw invalidResponse(operation, 'expected valid JSON.', error)
  }
}

const parseThreadListResponse = (value: unknown): HarnessThreadMetadata[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse('listing threads', 'expected an array of threads.')
  }

  for (const [index, thread] of value.entries()) {
    if (!isThreadMetadata(thread)) {
      throw invalidResponse(
        'listing threads',
        `thread at index ${index} must have a non-empty string "id", a string "status", and correctly typed known fields.`,
      )
    }
  }
  return value
}

const parseThreadSnapshotResponse = (
  value: unknown,
  operation: 'creating a thread' | 'fetching a thread',
): HarnessThreadSnapshot => {
  if (!isThreadSnapshot(value)) {
    throw invalidResponse(
      operation,
      'expected a thread snapshot with valid "metadata", a "messages" array, and valid host UI requests when present.',
    )
  }
  return value
}

const parseClearQueueResponse = (value: unknown): { steering: string[]; followUp: string[] } => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.steering) ||
    !value.steering.every((item) => typeof item === 'string') ||
    !Array.isArray(value.followUp) ||
    !value.followUp.every((item) => typeof item === 'string')
  ) {
    throw invalidResponse(
      'clearing a thread queue',
      'expected an object with string arrays "steering" and "followUp".',
    )
  }
  return value as { steering: string[]; followUp: string[] }
}

/** 项目摘要守卫：只接受页面会读取的受控字段。 */
const isProjectTrust = (value: unknown): boolean =>
  isRecord(value) &&
  (value.decision === 'trusted' ||
    value.decision === 'untrusted' ||
    value.decision === 'unknown') &&
  typeof value.origin === 'string' &&
  typeof value.requiresTrust === 'boolean' &&
  (value.defaultPolicy === 'ask' ||
    value.defaultPolicy === 'always' ||
    value.defaultPolicy === 'never') &&
  (value.savedPath === undefined || typeof value.savedPath === 'string') &&
  typeof value.extensionErrorCount === 'number'

const isProjectInfo = (value: unknown): value is HarnessProjectInfo =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.name === 'string' &&
  (value.status === 'ready' ||
    value.status === 'needs-trust' ||
    value.status === 'loading' ||
    value.status === 'failed') &&
  isProjectTrust(value.trust) &&
  (value.failure === undefined ||
    (isRecord(value.failure) && typeof value.failure.code === 'string'))

const isProjectPathCheck = (value: unknown): value is HarnessProjectPathCheck =>
  isRecord(value) &&
  typeof value.input === 'string' &&
  typeof value.path === 'string' &&
  typeof value.exists === 'boolean' &&
  typeof value.isDirectory === 'boolean' &&
  (value.error === undefined ||
    (isRecord(value.error) &&
      (value.error.code === 'invalid-path' ||
        value.error.code === 'not-found' ||
        value.error.code === 'not-directory')))

const isRecentProject = (value: unknown): value is HarnessRecentProject =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.name === 'string' &&
  (value.lastActiveAt === undefined || typeof value.lastActiveAt === 'string')

const isWorkspaceProject = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.alias === 'string' &&
  typeof value.path === 'string' &&
  typeof value.available === 'boolean'

const isWorkspace = (value: unknown): value is HarnessWorkspace =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.revision === 'number' &&
  Array.isArray(value.projects) &&
  value.projects.every(isWorkspaceProject)

const isWorkspaceCatalog = (value: unknown): value is HarnessWorkspaceCatalog =>
  isRecord(value) &&
  Array.isArray(value.workspaces) &&
  value.workspaces.every(isWorkspace) &&
  (value.state === 'ok' ||
    value.state === 'corrupted' ||
    value.state === 'unsupported-version' ||
    value.state === 'unreadable') &&
  (value.startupWorkspaceId === undefined || typeof value.startupWorkspaceId === 'string')

const isWorkspaceMutationResult = (value: unknown): value is HarnessWorkspaceMutationResult => {
  if (!isRecord(value)) return false
  if (value.ok === true) return isWorkspace(value.workspace)
  if (value.ok !== false) return false
  return (
    (value.error === 'conflict' ||
      value.error === 'state-unavailable' ||
      value.error === 'not-found' ||
      value.error === 'invalid') &&
    (value.workspace === undefined || isWorkspace(value.workspace)) &&
    (value.reason === undefined || typeof value.reason === 'string')
  )
}

const isAssignThreadResult = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.ok === true) return isThreadMetadata(value.thread)
  return (
    value.ok === false &&
    (value.error === 'state-unavailable' ||
      value.error === 'not-found' ||
      value.error === 'invalid') &&
    (value.reason === undefined || typeof value.reason === 'string')
  )
}

const parseProjectInfo = (value: unknown): HarnessProjectInfo => {
  if (!isProjectInfo(value)) {
    throw invalidResponse('fetching a project', 'expected a valid project summary.')
  }
  return value
}

const parseProjectPathCheck = (value: unknown): HarnessProjectPathCheck => {
  if (!isProjectPathCheck(value)) {
    throw invalidResponse('checking a project path', 'expected a valid path check result.')
  }
  return value
}

const parseRecentProjects = (value: unknown): HarnessRecentProject[] => {
  if (!Array.isArray(value) || !value.every(isRecentProject)) {
    throw invalidResponse('listing recent projects', 'expected an array of recent projects.')
  }
  return value
}

const isModelInfo = (value: unknown): value is HarnessModelInfo =>
  isRecord(value) &&
  typeof value.provider === 'string' &&
  value.provider.length > 0 &&
  typeof value.modelId === 'string' &&
  value.modelId.length > 0

const parseModelListResponse = (value: unknown): HarnessModelInfo[] => {
  if (!Array.isArray(value)) {
    throw invalidResponse('listing models', 'expected an array of models.')
  }

  for (const [index, model] of value.entries()) {
    if (!isModelInfo(model)) {
      throw invalidResponse(
        'listing models',
        `model at index ${index} must have non-empty string "provider" and "modelId" fields.`,
      )
    }
  }
  return value
}

/** 校验 GUI 实际读取的宿主字段；诊断只接受约定代码，不展示任意扩展文案。 */
const isHostInfo = (value: unknown): value is HarnessHostInfo => {
  if (!isRecord(value) || !isRecord(value.sessionStorage) || !isRecord(value.defaultModel))
    return false
  const storage = value.sessionStorage
  const model = value.defaultModel
  return (
    typeof value.workspacePath === 'string' &&
    typeof value.agentDir === 'string' &&
    typeof value.agentDirSource === 'string' &&
    typeof storage.root === 'string' &&
    typeof storage.directory === 'string' &&
    typeof storage.source === 'string' &&
    (storage.mode === 'grouped' || storage.mode === 'flat') &&
    typeof model.providerSource === 'string' &&
    typeof model.modelIdSource === 'string' &&
    isRecord(model.readiness) &&
    typeof model.readiness.state === 'string' &&
    (model.readiness.message === undefined || typeof model.readiness.message === 'string') &&
    (model.provider === undefined || typeof model.provider === 'string') &&
    (model.modelId === undefined || typeof model.modelId === 'string') &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(
      (code) =>
        code === 'assembly-warning' ||
        code === 'catalog-refresh-failed' ||
        code === 'model-fallback',
    )
  )
}

/**
 * 创建浏览器侧 HTTP 客户端。
 *
 * 无内部连接状态：SSE 仅在 `subscribe` 期间开启，因此可作为模块级单例在
 * 运行时与模型选择器之间共享。
 */
export const createHarnessHttpClient = (options: HarnessHttpClientOptions = {}): HarnessClient => {
  const { baseUrl = '/api/pi', fetchImpl = fetch, headers } = options
  const { onStreamError, reconnectDelay, maxStreamLineLength, maxStreamEventLength } = options

  const base = trimTrailingSlash(baseUrl)
  const threadUrl = (threadId: string) => `${base}/threads/${encodeURIComponent(threadId)}`

  const jsonHeaders = { 'content-type': 'application/json', ...headers }

  const send = (url: string, method: string, body?: unknown) =>
    fetchImpl(url, {
      method,
      ...(body !== undefined
        ? { headers: jsonHeaders, body: JSON.stringify(body) }
        : headers
          ? { headers }
          : {}),
    })

  /**
   * 订阅线程事件。
   *
   * 每次调用建立独立 SSE 连接（不做跨组件共享，见文件头说明）。
   * 监听者抛错被隔离，不影响传输层。
   */
  const subscribe: HarnessClient['subscribe'] = (threadId, listener, subscribeOptions) => {
    const includeSnapshot = subscribeOptions?.includeSnapshot !== false
    const eventsUrl = `${threadUrl(threadId)}/events${includeSnapshot ? '' : '?snapshot=false'}`
    let listening = true
    let connection: { close: () => void } | undefined

    const notify = (event: HarnessClientEvent) => {
      if (!listening) return
      try {
        listener(event)
      } catch (error) {
        console.error('[huan-react] Listener threw an error', error)
      }
    }

    connection = createHarnessEventStreamConnection({
      url: eventsUrl,
      expectedThreadId: threadId,
      // includeSnapshot=false 的订阅在断线后要切回带快照的 URL 才能恢复
      ...(!includeSnapshot && { snapshotRecoveryUrl: `${threadUrl(threadId)}/events` }),
      fetchImpl,
      ...(headers ? { headers } : {}),
      ...(reconnectDelay ? { reconnectDelay } : {}),
      maxStreamLineLength,
      maxStreamEventLength,
      onError: (error) => {
        if (!isTerminalStreamError(error)) {
          onStreamError?.(error)
          return
        }
        // 终止性错误：解码器限制无法继续重连，投递带外 error 事件后关闭。
        // 监听者（Controller）据此重置订阅状态，使后续 connect() 能重新建立。
        queueMicrotask(() => {
          connection?.close()
          void invokeUserCallback('huan-react', 'onError', onStreamError, error)
          notify({
            type: 'error',
            threadId,
            seq: 0,
            error: (error as Error).message,
            terminal: true,
          })
        })
      },
      onEvent: (event) => {
        notify(event as HarnessClientEvent)
      },
    })

    return () => {
      listening = false
      connection?.close()
    }
  }

  return {
    getHostInfo: async () => {
      const value = await readJson(await send(`${base}/host`, 'GET'), 'fetching host information')
      if (!isHostInfo(value))
        throw invalidResponse('fetching host information', 'expected valid host information.')
      return value
    },
    listWorkspaces: async () => {
      const value = await readJson(await send(`${base}/workspaces`, 'GET'), 'listing workspaces')
      if (!isWorkspaceCatalog(value)) {
        throw invalidResponse('listing workspaces', 'expected a valid workspace catalog.')
      }
      return value
    },

    createWorkspace: async (input) => {
      const value = await readJson(
        await send(`${base}/workspaces`, 'POST', input),
        'creating a workspace',
      )
      if (!isWorkspaceMutationResult(value)) {
        throw invalidResponse('creating a workspace', 'expected a workspace mutation result.')
      }
      return value
    },

    updateWorkspace: async (input) => {
      const value = await readJson(
        await send(`${base}/workspaces/${encodeURIComponent(input.workspaceId)}`, 'PATCH', {
          expectedRevision: input.expectedRevision,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.projects !== undefined ? { projects: input.projects } : {}),
        }),
        'updating a workspace',
      )
      if (!isWorkspaceMutationResult(value)) {
        throw invalidResponse('updating a workspace', 'expected a workspace mutation result.')
      }
      return value
    },

    assignThreadWorkspace: async (input) => {
      const value = await readJson(
        await send(`${threadUrl(input.threadId)}/workspace`, 'POST', {
          workspaceId: input.workspaceId,
        }),
        'assigning a thread workspace',
      )
      if (!isAssignThreadResult(value)) {
        throw invalidResponse(
          'assigning a thread workspace',
          'expected a thread assignment result.',
        )
      }
      return value as Awaited<ReturnType<HarnessClient['assignThreadWorkspace']>>
    },

    listThreads: async (input) => {
      const params = new URLSearchParams()
      if (input?.workspaceId) params.set('workspaceId', input.workspaceId)
      if (input?.unassigned) params.set('unassigned', 'true')
      if (input?.includeArchived) params.set('includeArchived', 'true')
      // 显式刷新清除宿主作用域缓存并重新扫描（外部 Pi 改动可见）。
      if (input?.refresh) params.set('refresh', 'true')
      const query = params.toString()
      return parseThreadListResponse(
        await readJson(
          await send(`${base}/threads${query ? `?${query}` : ''}`, 'GET'),
          'listing threads',
        ),
      )
    },

    createThread: async (input) =>
      parseThreadSnapshotResponse(
        await readJson(await send(`${base}/threads`, 'POST', input ?? {}), 'creating a thread'),
        'creating a thread',
      ),

    getThread: async (threadId) =>
      parseThreadSnapshotResponse(
        await readJson(await send(threadUrl(threadId), 'GET'), 'fetching a thread'),
        'fetching a thread',
      ),

    getThreadDetails: async (threadId) => {
      const value = await readJson(
        await send(`${threadUrl(threadId)}/details`, 'GET'),
        'fetching thread details',
      )
      if (!isThreadDetails(value)) {
        throw invalidResponse(
          'fetching thread details',
          'expected metadata, accumulated stats and an optional context usage.',
        )
      }
      return value
    },

    sendMessage: async (threadId, input: HarnessSendMessageInput) => {
      await assertOk(await send(`${threadUrl(threadId)}/messages`, 'POST', { input }))
    },

    cancelRun: async (threadId) => {
      await assertOk(await send(`${threadUrl(threadId)}/cancel`, 'POST'))
    },

    clearQueue: async (threadId) =>
      parseClearQueueResponse(
        await readJson(
          await send(`${threadUrl(threadId)}/queue/clear`, 'POST'),
          'clearing a thread queue',
        ),
      ),

    checkProjectPath: async (path) =>
      parseProjectPathCheck(
        await readJson(
          await send(`${base}/projects/check`, 'POST', { path }),
          'checking a project path',
        ),
      ),

    getProject: async (input) => {
      const params = new URLSearchParams({ path: input.path })
      return parseProjectInfo(
        await readJson(
          await send(`${base}/projects/info?${params.toString()}`, 'GET'),
          'fetching a project',
        ),
      )
    },

    inspectProjectTrust: async (input) => {
      const params = new URLSearchParams({ path: input.path })
      return parseProjectInfo(
        await readJson(
          await send(`${base}/projects/trust-summary?${params.toString()}`, 'GET'),
          'fetching project trust summary',
        ),
      )
    },

    decideProjectTrust: async (input: HarnessProjectTrustInput) =>
      parseProjectInfo(
        await readJson(
          await send(`${base}/projects/trust`, 'POST', input),
          'deciding project trust',
        ),
      ),

    listRecentProjects: async () =>
      parseRecentProjects(
        await readJson(await send(`${base}/projects`, 'GET'), 'listing recent projects'),
      ),

    getAvailableModels: async (input) => {
      const params = new URLSearchParams()
      if (input?.workspacePath) params.set('workspacePath', input.workspacePath)
      const query = params.toString()
      return parseModelListResponse(
        await readJson(
          await send(`${base}/models${query ? `?${query}` : ''}`, 'GET'),
          'listing models',
        ),
      )
    },

    setModel: async (threadId, input) => {
      await assertOk(await send(`${threadUrl(threadId)}/model`, 'POST', input))
    },

    setThinkingLevel: async (threadId, level: HarnessThinkingLevel) => {
      await assertOk(await send(`${threadUrl(threadId)}/thinking`, 'POST', { level }))
    },

    renameThread: async (threadId, title) => {
      await assertOk(await send(threadUrl(threadId), 'PATCH', { title }))
    },

    archiveThread: async (threadId) => {
      await assertOk(await send(`${threadUrl(threadId)}/archive`, 'POST'))
    },

    unarchiveThread: async (threadId) => {
      await assertOk(await send(`${threadUrl(threadId)}/unarchive`, 'POST'))
    },

    deleteThread: async (threadId) => {
      const response = await send(threadUrl(threadId), 'DELETE')
      if (response.status === 404) return
      await assertOk(response)
    },

    respondToHostUiRequest: async (threadId, response: HarnessHostUiResponse) => {
      await assertOk(await send(`${threadUrl(threadId)}/host-ui`, 'POST', { response }))
    },

    subscribe,
  }
}
