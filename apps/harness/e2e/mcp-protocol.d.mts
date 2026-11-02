/** 测试 fixture 的最小类型声明；只供 e2e 测试服务器导入。 */
export type McpFixtureState = {
  env: NodeJS.ProcessEnv
  tools: unknown[]
  dynamicAdded: boolean
  cancelled: Set<unknown>
  initAttempts: number
  initSuccesses: number
  toolListCalls: number
  resourceListCalls: number
  templateListCalls: number
  readCalls: number
  resource500Served: boolean
}

export function createState(env?: NodeJS.ProcessEnv): McpFixtureState

export function handleNotification(
  message: { method?: string; params?: { requestId?: unknown } },
  state: McpFixtureState,
): void

export function handleRequest(
  message: { method?: string; params?: Record<string, unknown>; id?: unknown },
  state: McpFixtureState,
  notify?: (method: string, params?: unknown) => void,
): Promise<{
  result?: unknown
  error?: unknown
  httpStatus?: number
  cancelled?: boolean
}>
