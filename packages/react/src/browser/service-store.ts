/**
 * 服务作用域 Zustand 状态：一个 client/存储作用域的目录、会话数据与安全认证快照。
 *
 * 设计（见 R1 §3）：
 * - `threadsById` 是会话元数据的唯一实体；目录扫描与实时事件只更新它。
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
  HarnessProviderAuthSnapshot,
  HarnessThreadMetadata,
  HarnessThreadSnapshot,
} from '@huan/protocol'
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
}

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

  /** 读取宿主信息；成功后回调存储作用域（由组合根接入窗口状态）。 */
  loadHostInfo: () => Promise<HarnessHostInfo | undefined>
  /** 刷新会话目录；带扫描代次，旧结果不覆盖新扫描。 */
  refreshThreads: (query?: HarnessThreadQuery) => Promise<void>
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
  'treeOperation',
  'reload',
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

export const createHarnessServiceStore = (
  options: CreateHarnessServiceStoreOptions,
): StoreApi<HarnessServiceState> => {
  const { client, onHostInfo } = options
  let hostEpoch = 0
  let catalogEpoch = 0
  let providerAuthSeq = -1
  let hostInteractionSeq = -1
  let mcpAuthSeq = -1
  const loadEpochByThread = new Map<string, number>()
  const loadPromiseByThread = new Map<string, Promise<void>>()

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

      loadHostInfo: async () => {
        if (get().disposed) return undefined
        const epoch = ++hostEpoch
        set({ hostLoading: true, hostError: undefined })
        try {
          const host = await client.getHostInfo()
          if (get().disposed || epoch !== hostEpoch) return undefined
          set({ host, hostLoading: false, hostError: undefined })
          onHostInfo?.(host)
          return host
        } catch (error) {
          if (get().disposed || epoch !== hostEpoch) return undefined
          set({ hostLoading: false, hostError: errorText(error) })
          return undefined
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
              threadsById[metadata.id] = existing && state.sessionDataById[metadata.id]
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
        set((state) => applyEvents(state, threadId, [event]))
      },

      applyThreadEvents: (threadId, events) => {
        if (get().disposed || events.length === 0) return
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
        catalogEpoch += 1
        loadEpochByThread.clear()
        loadPromiseByThread.clear()
        providerAuthSeq = -1
        hostInteractionSeq = -1
        mcpAuthSeq = -1
        set({ ...createInitialState(), disposed: true })
      },
    }
  })
}
