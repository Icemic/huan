/**
 * 服务作用域 Zustand 状态：一个 client/存储作用域的目录、会话数据、工作区定义、
 * 模型目录查询与安全认证快照。
 *
 * 设计（见 R1 §3）：
 * - `threadsById` 是会话元数据的唯一实体；目录扫描与实时事件只更新它。
 * - `workspacesById` + `workspaceIds` 是工作区定义的唯一实体与顺序。
 * - `modelCatalogByKey` 按目标与 resource/auth/modelCatalog 版本保存目录查询。
 * - `sessionDataById` 只保存消息、工具执行、Host UI、Shell、readiness 等运行数据，
 *   不复制 status/队列/contextUsage/重试/压缩活动标志等元数据字段。
 * - 目录扫描带开始版本：扫描期间被事件更新的实体不会被旧列表覆盖。
 * - 冷读请求带本地 epoch 与序号水位：迟到的 HTTP 快照不能覆盖更新的实时状态。
 * - 认证/宿主交互只保存宿主安全投影，不含凭据原文。
 */

import type {
  HarnessClient,
  HarnessClientEvent,
  HarnessHostInfo,
  HarnessHostInteractionEvent,
  HarnessHostInteractionSnapshot,
  HarnessMcpAuthSnapshot,
  HarnessModelInfo,
  HarnessProviderAuthSnapshot,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
  HarnessWorkspace,
  HarnessWorkspaceState,
} from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { errorText } from '../error-text.js'
import {
  createHarnessThreadMetadata,
  createHarnessThreadSession,
  type HarnessThreadReduction,
  type HarnessThreadSession,
  isStaleHttpSnapshot,
  reduceHarnessThreadState,
} from '../model/thread-state.js'

/** 会话列表查询条件（只影响目录查询，不冒充权威过滤）。 */
export interface HarnessThreadQuery {
  workspaceId?: string
  unassigned?: boolean
  includeArchived?: boolean
  /** 显式重扫宿主作用域目录（外部 Pi 改动可见）。 */
  refresh?: boolean
}

/**
 * 模型目录目标：固定起始目录；会话目标另带 threadId，工作区目标带 workspaceId
 * 区分同路径的不同范围，`all` 明确请求完整目录而非最终候选。
 */
export interface HarnessModelCatalogTarget {
  workspacePath: string
  workspaceId?: string
  threadId?: string
  /** true 只读取完整目录供范围管理；缺省按工作区覆盖或用户范围筛选。 */
  all?: boolean
}

/** 模型目录依赖版本；缺省时由服务状态中的认证/会话/工作区元数据补齐。 */
export interface HarnessModelCatalogVersions {
  resourceRevision?: number
  authRevision?: number
  modelCatalogRevision?: number
  /** 工作区定义版本；范围与成员变化都会推进。 */
  workspaceRevision?: number
}

/** 模型目录查询：目标与实际使用的依赖版本。 */
export interface HarnessModelCatalogQuery
  extends HarnessModelCatalogTarget,
    HarnessModelCatalogVersions {}

/** 按目标与版本唯一的模型目录条目。 */
export interface HarnessModelCatalogEntry extends HarnessModelCatalogQuery {
  key: string
  loading: boolean
  error: string | undefined
  models: readonly HarnessModelInfo[]
}

/** 模型目录缓存键：目标（含工作区/完整目录标记）与依赖版本共同决定。 */
export const modelCatalogKeyOf = (query: HarnessModelCatalogQuery): string =>
  JSON.stringify([
    query.threadId ?? null,
    query.workspacePath,
    query.workspaceId ?? null,
    query.workspaceRevision ?? null,
    query.all === true,
    query.resourceRevision ?? null,
    query.authRevision ?? null,
    query.modelCatalogRevision ?? null,
  ])

/** 目录查询状态；结果只保存 ID，标题/运行状态始终从实体读取。 */
export interface HarnessCatalogState {
  query: HarnessThreadQuery
  loading: boolean
  error: string | undefined
  ids: readonly string[]
}

/** 服务作用域 Zustand 状态。 */
export interface HarnessServiceState {
  host: HarnessHostInfo | undefined
  hostLoading: boolean
  hostError: string | undefined
  threadsById: Readonly<Record<string, HarnessThreadMetadata>>
  sessionDataById: Readonly<Record<string, HarnessThreadSession>>
  /** 工作区定义唯一实体；顺序由 workspaceIds 表达。 */
  workspacesById: Readonly<Record<string, HarnessWorkspace>>
  workspaceIds: readonly string[]
  workspaceState: HarnessWorkspaceState | undefined
  startupWorkspaceId: string | undefined
  workspaceLoading: boolean
  workspaceError: string | undefined
  /** 按目标和版本唯一的模型目录查询状态。 */
  modelCatalogByKey: Readonly<Record<string, HarnessModelCatalogEntry>>
  /**
   * 元数据实体版本：目录扫描用它判断实体是否在扫描期间被事件更新。
   * 仅用于合并保护，不参与展示。
   */
  threadRevisions: Readonly<Record<string, number>>
  catalog: HarnessCatalogState
  providerAuth: HarnessProviderAuthSnapshot | undefined
  hostInteractions: HarnessHostInteractionSnapshot | undefined
  mcpAuth: HarnessMcpAuthSnapshot | undefined
  mcpAuthError: string | undefined
  disposed: boolean

  /**
   * 读取宿主信息；成功后回调存储作用域（由组合根接入窗口状态）。
   * 并发调用共享同一次请求，`force` 等待在途结果后再读一次。
   */
  loadHostInfo: (options?: { force?: boolean }) => Promise<HarnessHostInfo | undefined>
  /** 刷新会话目录；带扫描代次，旧结果不覆盖新扫描。 */
  refreshThreads: (query?: HarnessThreadQuery) => Promise<void>
  /** 刷新工作区目录；失败保留上一次成功定义并记录受控错误。 */
  refreshWorkspaces: () => Promise<void>
  /** 应用业务动作返回的权威工作区定义（创建/修改结果）。 */
  applyWorkspace: (workspace: HarnessWorkspace) => void
  /** 按目标和当前版本读取/刷新模型目录；换目标立即使用新目标状态。 */
  loadModelCatalog: (
    query: HarnessModelCatalogTarget & HarnessModelCatalogVersions,
  ) => Promise<readonly HarnessModelInfo[] | undefined>
  /** 冷读会话（只读快照）；同会话并发请求复用，迟到响应按 epoch 与序号水位丢弃。 */
  loadThread: (threadId: string, options?: { force?: boolean }) => Promise<void>
  /** 应用单个实时/权威事件。 */
  applyThreadEvent: (threadId: string, event: HarnessClientEvent) => void
  /** 按顺序应用一批事件（帧合并或冷读恢复）。 */
  applyThreadEvents: (threadId: string, events: readonly HarnessClientEvent[]) => void
  /** 应用业务动作返回的权威快照（树导航、重载等）。 */
  applyThreadSnapshot: (threadId: string, snapshot: HarnessThreadSnapshot) => void
  /** 释放完整会话缓存；保留目录元数据与窗口草稿。 */
  evictThreadSession: (threadId: string) => void
  /** 应用 provider 认证安全快照（序号回退视为宿主重启）。 */
  applyProviderAuth: (snapshot: HarnessProviderAuthSnapshot) => void
  /** 主动重读 provider 认证快照；失败保留上一次成功结果。 */
  refreshProviderAuth: () => Promise<void>
  /** 应用宿主交互安全快照。 */
  applyHostInteractions: (event: HarnessHostInteractionEvent) => void
  /** 应用 MCP 认证安全快照。 */
  applyMcpAuth: (snapshot: HarnessMcpAuthSnapshot) => void
  /** 记录 MCP 认证读取失败（受控文案）；成功快照会清除。 */
  setMcpAuthError: (message: string | undefined) => void
  /** 永久销毁实例状态；之后动作不再生效。 */
  dispose: () => void
}

export interface CreateHarnessServiceStoreOptions {
  client: HarnessClient
  /** 宿主信息解析后回调（组合根用于更新窗口草稿/选择作用域）。 */
  onHostInfo?: (host: HarnessHostInfo) => void
}

const createInitialState = (): Omit<
  HarnessServiceState,
  | 'loadHostInfo'
  | 'refreshThreads'
  | 'refreshWorkspaces'
  | 'applyWorkspace'
  | 'loadModelCatalog'
  | 'loadThread'
  | 'applyThreadEvent'
  | 'applyThreadEvents'
  | 'applyThreadSnapshot'
  | 'evictThreadSession'
  | 'applyProviderAuth'
  | 'refreshProviderAuth'
  | 'applyHostInteractions'
  | 'applyMcpAuth'
  | 'setMcpAuthError'
  | 'dispose'
> => ({
  host: undefined,
  hostLoading: false,
  hostError: undefined,
  threadsById: {},
  sessionDataById: {},
  workspacesById: {},
  workspaceIds: [],
  workspaceState: undefined,
  startupWorkspaceId: undefined,
  workspaceLoading: false,
  workspaceError: undefined,
  modelCatalogByKey: {},
  threadRevisions: {},
  catalog: { query: {}, loading: false, error: undefined, ids: [] },
  providerAuth: undefined,
  hostInteractions: undefined,
  mcpAuth: undefined,
  mcpAuthError: undefined,
  disposed: false,
})

/** 服务端会话列表只负责目录字段；这些运行字段保留事件/快照的当前值。 */
const RUNTIME_METADATA_FIELDS = [
  'status',
  'compactionActive',
  'compactionReason',
  'retryActive',
  'retryAttempt',
  'runningRunId',
  'queuedMessages',
  'contextUsage',
  'runMetrics',
  'treeOperation',
  'reload',
  'modelFallback',
] as const satisfies readonly (keyof HarnessThreadMetadata)[]

/** 目录扫描结果合并：覆盖目录字段，保留运行中字段。 */
const mergeCatalogMetadata = (
  existing: HarnessThreadMetadata,
  listed: HarnessThreadMetadata,
): HarnessThreadMetadata => {
  const merged: HarnessThreadMetadata = { ...listed }
  for (const field of RUNTIME_METADATA_FIELDS) {
    const value = existing[field]
    // 字段名受上表约束，写入同类型值。
    if (value !== undefined) Object.assign(merged, { [field]: value })
    else delete merged[field]
  }
  return merged
}

const withSession = (
  state: HarnessServiceState,
  threadId: string,
  session: HarnessThreadSession,
): HarnessServiceState => ({
  ...state,
  sessionDataById: { ...state.sessionDataById, [threadId]: session },
})

/** 用当前服务状态补齐模型目录查询的身份与依赖版本。 */
const resolveModelCatalogQuery = (
  state: HarnessServiceState,
  query: HarnessModelCatalogTarget & HarnessModelCatalogVersions,
): HarnessModelCatalogQuery => {
  const metadata = query.threadId ? state.threadsById[query.threadId] : undefined
  const workspaceId = query.workspaceId ?? metadata?.workspaceId
  const workspace = workspaceId ? state.workspacesById[workspaceId] : undefined
  const resourceRevision = query.resourceRevision ?? metadata?.resourceRevision
  const authRevision = query.authRevision ?? state.providerAuth?.authRevision
  const modelCatalogRevision = query.modelCatalogRevision ?? metadata?.modelCatalogRevision
  const workspaceRevision =
    query.workspaceRevision ?? workspace?.revision ?? metadata?.workspaceRevision
  return {
    workspacePath: query.workspacePath,
    ...(workspaceId ? { workspaceId } : {}),
    ...(query.threadId ? { threadId: query.threadId } : {}),
    ...(query.all === true ? { all: true } : {}),
    ...(resourceRevision !== undefined ? { resourceRevision } : {}),
    ...(authRevision !== undefined ? { authRevision } : {}),
    ...(modelCatalogRevision !== undefined ? { modelCatalogRevision } : {}),
    ...(workspaceRevision !== undefined ? { workspaceRevision } : {}),
  }
}

/** 选择当前目标和版本对应的模型目录条目；换目标不会回退到前目标结果。 */
export const selectHarnessModelCatalog = (
  state: HarnessServiceState,
  query: HarnessModelCatalogTarget & HarnessModelCatalogVersions,
): HarnessModelCatalogEntry | undefined =>
  state.modelCatalogByKey[modelCatalogKeyOf(resolveModelCatalogQuery(state, query))]

/**
 * 同一目标只保留最新版本条目；不同目标各自保留当前版本。
 * 完整目录与最终候选是不同目标，不能互相覆盖。
 */
const pruneModelCatalogTarget = (
  entries: Readonly<Record<string, HarnessModelCatalogEntry>>,
  next: HarnessModelCatalogEntry,
): Record<string, HarnessModelCatalogEntry> => {
  const result: Record<string, HarnessModelCatalogEntry> = {}
  for (const [key, entry] of Object.entries(entries)) {
    if (key === next.key) continue
    if (
      entry.threadId === next.threadId &&
      entry.workspacePath === next.workspacePath &&
      entry.workspaceId === next.workspaceId &&
      (entry.all === true) === (next.all === true)
    ) {
      continue
    }
    result[key] = entry
  }
  result[next.key] = next
  return result
}

export const createHarnessServiceStore = (
  options: CreateHarnessServiceStoreOptions,
): StoreApi<HarnessServiceState> => {
  const { client, onHostInfo } = options
  let hostEpoch = 0
  let hostPromise: Promise<HarnessHostInfo | undefined> | undefined
  let catalogEpoch = 0
  let workspaceEpoch = 0
  let providerAuthSeq = -1
  let hostInteractionSeq = -1
  let mcpAuthSeq = -1
  const loadEpochByThread = new Map<string, number>()
  const loadPromiseByThread = new Map<string, Promise<void>>()
  const modelEpochByKey = new Map<string, number>()
  const modelPromiseByKey = new Map<string, Promise<readonly HarnessModelInfo[] | undefined>>()

  return createStore<HarnessServiceState>()((set, get) => {
    const applyEvents = (
      state: HarnessServiceState,
      threadId: string,
      events: readonly HarnessClientEvent[],
    ): HarnessServiceState => {
      const existingMetadata = state.threadsById[threadId]
      const existingSession = state.sessionDataById[threadId]
      const initial: HarnessThreadReduction = {
        metadata: existingMetadata ?? createHarnessThreadMetadata(threadId),
        session: existingSession ?? createHarnessThreadSession(),
      }
      let next = initial
      for (const event of events) next = reduceHarnessThreadState(next, event)
      if (next.metadata === initial.metadata && next.session === initial.session) return state

      // 实时会话必须先有元数据实体；目录尚未扫描时用最小实体占位。
      const metadataChanged = existingMetadata === undefined || next.metadata !== existingMetadata
      const threadsById = metadataChanged
        ? { ...state.threadsById, [threadId]: next.metadata }
        : state.threadsById
      const sessionDataById =
        next.session === existingSession
          ? state.sessionDataById
          : { ...state.sessionDataById, [threadId]: next.session }
      const threadRevisions = metadataChanged
        ? {
            ...state.threadRevisions,
            [threadId]: (state.threadRevisions[threadId] ?? 0) + 1,
          }
        : state.threadRevisions
      return { ...state, threadsById, sessionDataById, threadRevisions }
    }

    const applyColdSnapshot = (
      state: HarnessServiceState,
      threadId: string,
      snapshot: HarnessThreadSnapshot,
      sequenceAtStart: number,
    ): HarnessServiceState => {
      const session = state.sessionDataById[threadId] ?? createHarnessThreadSession()
      if (isStaleHttpSnapshot(session, snapshot, sequenceAtStart)) {
        return withSession(state, threadId, { ...session, loadState: 'loaded' })
      }
      return applyEvents(withSession(state, threadId, session), threadId, [
        {
          type: 'snapshot',
          snapshot,
          threadId,
          seq: snapshot.seq ?? 0,
        } as HarnessClientEvent,
      ])
    }

    const getLoadEpoch = (threadId: string) => loadEpochByThread.get(threadId) ?? 0

    return {
      ...createInitialState(),

      loadHostInfo: async (loadOptions) => {
        if (get().disposed) return undefined
        // 根启动与工作区初始化会同时读取宿主信息：共享在途请求，不让后到的
        // 调用作废前一次结果（否则调用方拿到 undefined 并误判为宿主不可用）。
        if (hostPromise) {
          const shared = await hostPromise
          if (!loadOptions?.force || get().disposed) return shared
        }
        const epoch = ++hostEpoch
        set({ hostLoading: true, hostError: undefined })
        const request = (async (): Promise<HarnessHostInfo | undefined> => {
          try {
            const host = await client.getHostInfo()
            if (get().disposed || epoch !== hostEpoch) return undefined
            // 同版部署：一次明确比较；不匹配立即停止业务初始化，不做范围协商。
            if (host.protocolVersion !== HARNESS_PROTOCOL_VERSION) {
              throw new Error(
                `协议版本不匹配：宿主 ${host.protocolVersion}，页面 ${HARNESS_PROTOCOL_VERSION}；请更新页面或宿主。`,
              )
            }
            set({ host, hostLoading: false, hostError: undefined })
            onHostInfo?.(host)
            return host
          } catch (error) {
            if (get().disposed || epoch !== hostEpoch) return undefined
            set({ hostLoading: false, hostError: errorText(error) })
            return undefined
          }
        })()
        hostPromise = request
        try {
          return await request
        } finally {
          if (hostPromise === request) hostPromise = undefined
        }
      },

      refreshThreads: async (query) => {
        if (get().disposed) return
        const nextQuery = query ?? get().catalog.query
        const epoch = ++catalogEpoch
        const versionsAtStart = get().threadRevisions
        set((state) => ({
          ...state,
          catalog: { ...state.catalog, query: nextQuery, loading: true, error: undefined },
        }))
        try {
          const listed = await client.listThreads(nextQuery)
          if (get().disposed || epoch !== catalogEpoch) return
          set((state) => {
            const threadsById = { ...state.threadsById }
            const threadRevisions = { ...state.threadRevisions }
            for (const metadata of listed) {
              const existing = threadsById[metadata.id]
              // 扫描期间被事件更新的实体以事件为准，不被旧列表覆盖。
              if (existing && threadRevisions[metadata.id] !== versionsAtStart[metadata.id]) {
                continue
              }
              threadsById[metadata.id] =
                existing && state.sessionDataById[metadata.id]
                  ? mergeCatalogMetadata(existing, metadata)
                  : metadata
              threadRevisions[metadata.id] = (threadRevisions[metadata.id] ?? 0) + 1
            }
            return {
              ...state,
              threadsById,
              threadRevisions,
              catalog: {
                ...state.catalog,
                loading: false,
                error: undefined,
                ids: listed.map((metadata) => metadata.id),
              },
            }
          })
        } catch (error) {
          if (get().disposed || epoch !== catalogEpoch) return
          set((state) => ({
            ...state,
            catalog: { ...state.catalog, loading: false, error: errorText(error) },
          }))
          throw error
        }
      },

      refreshWorkspaces: async () => {
        if (get().disposed) return
        const epoch = ++workspaceEpoch
        set({ workspaceLoading: true, workspaceError: undefined })
        try {
          const catalog = await client.listWorkspaces()
          if (get().disposed || epoch !== workspaceEpoch) return
          const workspacesById: Record<string, HarnessWorkspace> = {}
          const workspaceIds: string[] = []
          for (const workspace of catalog.workspaces) {
            if (workspacesById[workspace.id]) continue
            workspacesById[workspace.id] = workspace
            workspaceIds.push(workspace.id)
          }
          set({
            workspacesById,
            workspaceIds,
            workspaceState: catalog.state,
            startupWorkspaceId: catalog.startupWorkspaceId,
            workspaceLoading: false,
            workspaceError: undefined,
          })
        } catch (error) {
          if (get().disposed || epoch !== workspaceEpoch) return
          set({ workspaceLoading: false, workspaceError: errorText(error) })
          throw error
        }
      },

      applyWorkspace: (workspace) => {
        if (get().disposed) return
        // 修改结果取代正在进行的旧目录扫描，防止晚到的列表覆盖新定义。
        workspaceEpoch += 1
        set((state) => {
          const workspaceIds = state.workspacesById[workspace.id]
            ? state.workspaceIds
            : [...state.workspaceIds, workspace.id]
          return {
            ...state,
            workspacesById: { ...state.workspacesById, [workspace.id]: workspace },
            workspaceIds,
            workspaceLoading: false,
            workspaceError: undefined,
          }
        })
      },

      loadModelCatalog: async (query) => {
        if (get().disposed) return undefined
        const resolved = resolveModelCatalogQuery(get(), query)
        const key = modelCatalogKeyOf(resolved)
        const existing = modelPromiseByKey.get(key)
        if (existing && get().modelCatalogByKey[key]?.loading) return existing

        const epoch = (modelEpochByKey.get(key) ?? 0) + 1
        modelEpochByKey.set(key, epoch)
        const currentEntries = get().modelCatalogByKey
        const nextEntries = pruneModelCatalogTarget(currentEntries, {
          key,
          ...resolved,
          loading: true,
          error: undefined,
          // 同一目标与版本的目录只刷新不变量：保留上一次结果，避免弹层重新
          // 打开时瞬间变空（键盘 Tab 会直接离开原本存在的 Thinking 控件）。
          models: currentEntries[key]?.models ?? [],
        })
        // 旧版本条目的代次与在途句柄一并释放，晚到响应不得重新写入。
        for (const oldKey of Object.keys(currentEntries)) {
          if (oldKey in nextEntries) continue
          modelEpochByKey.delete(oldKey)
          modelPromiseByKey.delete(oldKey)
        }
        set((state) => ({ ...state, modelCatalogByKey: nextEntries }))

        const request = (async (): Promise<readonly HarnessModelInfo[] | undefined> => {
          try {
            const models = await client.getAvailableModels({
              workspacePath: resolved.workspacePath,
              ...(resolved.workspaceId ? { workspaceId: resolved.workspaceId } : {}),
              ...(resolved.threadId ? { threadId: resolved.threadId } : {}),
              ...(resolved.all ? { all: true } : {}),
            })
            if (
              get().disposed ||
              modelEpochByKey.get(key) !== epoch ||
              get().modelCatalogByKey[key] === undefined
            ) {
              return undefined
            }
            set((state) => {
              const entry = state.modelCatalogByKey[key]
              if (!entry) return state
              return {
                ...state,
                modelCatalogByKey: {
                  ...state.modelCatalogByKey,
                  [key]: { ...entry, loading: false, error: undefined, models },
                },
              }
            })
            return models
          } catch (error) {
            if (
              get().disposed ||
              modelEpochByKey.get(key) !== epoch ||
              get().modelCatalogByKey[key] === undefined
            ) {
              return undefined
            }
            set((state) => {
              const entry = state.modelCatalogByKey[key]
              if (!entry) return state
              return {
                ...state,
                modelCatalogByKey: {
                  ...state.modelCatalogByKey,
                  [key]: {
                    ...entry,
                    loading: false,
                    error: errorText(error),
                    models: [],
                  },
                },
              }
            })
            return undefined
          }
        })()
        modelPromiseByKey.set(key, request)
        void request.finally(() => {
          if (modelPromiseByKey.get(key) === request) modelPromiseByKey.delete(key)
        })
        return request
      },

      loadThread: async (threadId, loadOptions) => {
        if (get().disposed) return
        // 同一会话的并发冷读复用在途请求，避免未知事件触发请求风暴。
        const existing = loadPromiseByThread.get(threadId)
        if (existing && loadOptions?.force !== true) return existing

        const epoch = getLoadEpoch(threadId) + 1
        loadEpochByThread.set(threadId, epoch)
        set((state) => {
          const session = state.sessionDataById[threadId] ?? createHarnessThreadSession()
          return withSession(state, threadId, { ...session, loadState: 'loading' })
        })
        const sequenceAtStart = get().sessionDataById[threadId]?.lastSeq ?? 0
        const request = (async () => {
          try {
            const snapshot = await client.getThread(threadId)
            if (get().disposed || getLoadEpoch(threadId) !== epoch) return
            set((state) => applyColdSnapshot(state, threadId, snapshot, sequenceAtStart))
          } catch (error) {
            if (get().disposed || getLoadEpoch(threadId) !== epoch) return
            set((state) => {
              const session = state.sessionDataById[threadId] ?? createHarnessThreadSession()
              return withSession(state, threadId, {
                ...session,
                loadState: 'loaded',
                lastError: errorText(error),
              })
            })
            throw error
          }
        })()
        loadPromiseByThread.set(threadId, request)
        try {
          await request
        } finally {
          if (loadPromiseByThread.get(threadId) === request) {
            loadPromiseByThread.delete(threadId)
          }
        }
      },

      applyThreadEvent: (threadId, event) => {
        if (get().disposed) return
        // 实时首帧即使序号与冷读相同也代表新的权威边界，旧读取必须失效。
        if (event.type === 'snapshot') {
          loadEpochByThread.set(threadId, getLoadEpoch(threadId) + 1)
          loadPromiseByThread.delete(threadId)
        }
        set((state) => applyEvents(state, threadId, [event]))
      },

      applyThreadEvents: (threadId, events) => {
        if (get().disposed || events.length === 0) return
        if (events.some((event) => event.type === 'snapshot')) {
          loadEpochByThread.set(threadId, getLoadEpoch(threadId) + 1)
          loadPromiseByThread.delete(threadId)
        }
        set((state) => applyEvents(state, threadId, events))
      },

      applyThreadSnapshot: (threadId, snapshot) => {
        if (get().disposed) return
        set((state) => {
          const session = state.sessionDataById[threadId] ?? createHarnessThreadSession()
          return applyEvents(state, threadId, [
            {
              type: 'snapshot',
              snapshot,
              threadId,
              seq: snapshot.seq ?? session.lastSeq,
            } as HarnessClientEvent,
          ])
        })
      },

      evictThreadSession: (threadId) => {
        if (get().disposed) return
        // 让仍在途的冷读响应失效；目录与窗口草稿不在此释放。
        loadEpochByThread.set(threadId, getLoadEpoch(threadId) + 1)
        loadPromiseByThread.delete(threadId)
        set((state) => {
          if (state.sessionDataById[threadId] === undefined) return state
          const sessionDataById = { ...state.sessionDataById }
          delete sessionDataById[threadId]
          return { ...state, sessionDataById }
        })
      },

      applyProviderAuth: (snapshot) => {
        if (get().disposed) return
        if (snapshot.seq < providerAuthSeq) providerAuthSeq = -1
        if (snapshot.seq === providerAuthSeq && get().providerAuth !== undefined) return
        providerAuthSeq = snapshot.seq
        set({ providerAuth: snapshot })
      },

      refreshProviderAuth: async () => {
        if (get().disposed) return
        const sequence = get().providerAuth?.seq
        try {
          const snapshot = await client.getProviderAuth()
          if (get().disposed || get().providerAuth?.seq !== sequence) return
          get().applyProviderAuth(snapshot)
        } catch {
          // 保留上一次成功快照；面板按操作错误提示，不把原始网络错误写入共享状态。
        }
      },

      applyHostInteractions: (event) => {
        if (get().disposed) return
        if (event.seq < hostInteractionSeq) hostInteractionSeq = -1
        if (event.seq === hostInteractionSeq && get().hostInteractions !== undefined) return
        hostInteractionSeq = event.seq
        set({ hostInteractions: event.snapshot })
      },

      applyMcpAuth: (snapshot) => {
        if (get().disposed) return
        if (snapshot.seq < mcpAuthSeq) mcpAuthSeq = -1
        if (snapshot.seq === mcpAuthSeq && get().mcpAuth !== undefined) {
          if (get().mcpAuthError !== undefined) set({ mcpAuthError: undefined })
          return
        }
        mcpAuthSeq = snapshot.seq
        set({ mcpAuth: snapshot, mcpAuthError: undefined })
      },

      setMcpAuthError: (message) => {
        if (get().disposed) return
        if (get().mcpAuthError === message) return
        set({ mcpAuthError: message })
      },

      dispose: () => {
        if (get().disposed) return
        hostEpoch += 1
        hostPromise = undefined
        catalogEpoch += 1
        workspaceEpoch += 1
        loadEpochByThread.clear()
        loadPromiseByThread.clear()
        modelEpochByKey.clear()
        modelPromiseByKey.clear()
        providerAuthSeq = -1
        hostInteractionSeq = -1
        mcpAuthSeq = -1
        set({ ...createInitialState(), disposed: true })
      },
    }
  })
}
