/**
 * 窗口级工作区上下文。
 *
 * 负责宿主信息、工作区目录、会话归属列表、展开状态和新建起始项目偏好。
 * 展开/选中/起始项目属于窗口本地状态，按宿主（agentDir + 会话存储根）
 * 隔离写入 sessionStorage；工作区定义与归属始终以宿主返回为权威。
 */
import type {
  HarnessCreateThreadInput,
  HarnessHostInfo,
  HarnessThreadMetadata,
  HarnessWorkspace,
  HarnessWorkspaceCatalog,
  HarnessWorkspaceState,
} from '@huan/protocol'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { harnessHttpClient } from './pi-http-client'

/** 页面级工作区错误分类。 */
export type WorkspaceUiError =
  | 'host-unavailable'
  | 'load-failed'
  | 'state-unavailable'
  | 'conflict'
  | 'invalid'
  | 'not-found'

type WorkspaceContextValue = {
  hostInfo: HarnessHostInfo | undefined
  workspaces: readonly HarnessWorkspace[]
  state: HarnessWorkspaceState | undefined
  startupWorkspaceId: string | undefined
  threads: readonly HarnessThreadMetadata[]
  activeWorkspaceId: string | undefined
  expanded: ReadonlySet<string>
  busy: boolean
  error: WorkspaceUiError | undefined
  notice: string | undefined
  refresh: (options?: { threads?: boolean }) => Promise<void>
  selectWorkspace: (workspaceId: string) => void
  toggleWorkspace: (workspaceId: string) => void
  startProjectFor: (workspace: HarnessWorkspace) => string | undefined
  setStartProject: (workspaceId: string, path: string) => void
  /** 记录新建目标并立即生效，供运行时 initialize 读取。 */
  beginNewSession: (workspaceId: string, startProjectPath: string) => void
  /** 运行时创建新会话时求值，保证读取的是点击时确定的窗口偏好。 */
  createThreadInput: () => HarnessCreateThreadInput
  showNotice: (message: string) => void
  showError: (error: WorkspaceUiError) => void
  clearError: () => void
  clearNotice: () => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined)

const storageKeys = (info: HarnessHostInfo) => {
  const scope = `${info.agentDir}\u0000${info.sessionStorage.root}`
  return {
    active: `huan.activeWorkspace:${scope}`,
    expanded: `huan.expandedWorkspaces:${scope}`,
    start: `huan.workspaceStartProject:${scope}`,
  }
}

const readString = (key: string): string | undefined => {
  try {
    const value = sessionStorage.getItem(key)
    return value ?? undefined
  } catch {
    return undefined
  }
}

const writeString = (key: string, value: string | undefined): void => {
  try {
    if (value === undefined) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    // 存储不可用只影响窗口恢复，不影响宿主数据。
  }
}

const readExpanded = (key: string): Set<string> => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]')
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

const readStartPreferences = (key: string): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([workspaceId, path]) =>
        typeof path === 'string' ? [[workspaceId, path] as const] : [],
      ),
    )
  } catch {
    return {}
  }
}

/** 工作区窗口状态提供者。 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [hostInfo, setHostInfo] = useState<HarnessHostInfo>()
  const [catalog, setCatalog] = useState<HarnessWorkspaceCatalog>()
  const [threads, setThreads] = useState<readonly HarnessThreadMetadata[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<WorkspaceUiError>()
  const [notice, setNotice] = useState<string>()

  const activeRef = useRef<string | undefined>(undefined)
  const keysRef = useRef<ReturnType<typeof storageKeys> | undefined>(undefined)
  const startPreferencesRef = useRef<Record<string, string>>({})
  const creationTargetRef = useRef<{ workspaceId?: string; startProjectPath?: string }>({})
  const catalogRef = useRef<HarnessWorkspaceCatalog | undefined>(undefined)
  const initializedRef = useRef(false)
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const chooseActive = useCallback((next: HarnessWorkspaceCatalog) => {
    const current = activeRef.current
    if (current && next.workspaces.some((workspace) => workspace.id === current)) return current
    return next.startupWorkspaceId ?? next.workspaces[0]?.id
  }, [])

  const applyActive = useCallback((workspaceId: string | undefined) => {
    activeRef.current = workspaceId
    setActiveWorkspaceId(workspaceId)
    if (workspaceId && keysRef.current) writeString(keysRef.current.active, workspaceId)
    if (workspaceId) {
      setExpanded((current) => {
        if (current.has(workspaceId)) return current
        const next = new Set(current)
        next.add(workspaceId)
        if (keysRef.current) writeString(keysRef.current.expanded, JSON.stringify([...next]))
        return next
      })
    }
  }, [])

  const refresh = useCallback(
    async (options?: { threads?: boolean }) => {
      try {
        const [nextHost, nextCatalog, nextThreads] = await Promise.all([
          hostInfo ? Promise.resolve(hostInfo) : harnessHttpClient.getHostInfo(),
          harnessHttpClient.listWorkspaces(),
          options?.threads === false
            ? Promise.resolve(threads)
            : harnessHttpClient.listThreads({ includeArchived: true }),
        ])
        if (!active.current) return
        if (!initializedRef.current) {
          // 并发 refresh（挂载 + 聚焦/事件）只能有一个执行窗口状态恢复；
          // 否则后完成的空 expanded 会覆盖先完成的默认展开。
          initializedRef.current = true
          const keys = storageKeys(nextHost)
          keysRef.current = keys
          startPreferencesRef.current = readStartPreferences(keys.start)
          const restored = readExpanded(keys.expanded)
          setExpanded(restored)
          const storedActive = readString(keys.active)
          activeRef.current =
            storedActive &&
            nextCatalog.workspaces.some((workspace) => workspace.id === storedActive)
              ? storedActive
              : undefined
          setHostInfo(nextHost)
        }
        catalogRef.current = nextCatalog
        setCatalog(nextCatalog)
        setThreads(nextThreads)
        if (nextCatalog.state === 'ok') setError(undefined)
        else setError('state-unavailable')
        const chosen = chooseActive(nextCatalog)
        if (chosen !== activeRef.current) applyActive(chosen)
        else if (chosen) setActiveWorkspaceId(chosen)
      } catch {
        if (active.current) setError('load-failed')
      } finally {
        if (active.current) setBusy(false)
      }
    },
    [applyActive, chooseActive, hostInfo, threads],
  )

  // refresh 的闭包会随列表变化更新；通过 ref 供窗口事件与初次挂载使用，
  // 避免把 refresh 放进依赖后触发「刷新 → 列表变化 → 再刷新」的循环。
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    void refreshRef.current?.()
    // 窗口聚焦/恢复时显式重查，跨窗口改动可见。
    const onFocus = () => void refreshRef.current?.()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshRef.current?.()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // 创建会话/首条消息接受后由 HTTP 客户端发出轻量通知；只重查列表，
  // 不把整份工作区定义附到流式事件里。
  useEffect(() => {
    const onChanged = () => void refresh()
    window.addEventListener('huan:thread-created', onChanged)
    window.addEventListener('huan:thread-updated', onChanged)
    return () => {
      window.removeEventListener('huan:thread-created', onChanged)
      window.removeEventListener('huan:thread-updated', onChanged)
    }
  }, [refresh])

  // 已展开但被移除的工作区从本地状态清理；不自动猜测新归属。
  useEffect(() => {
    if (!catalog) return
    const ids = new Set(catalog.workspaces.map((workspace) => workspace.id))
    setExpanded((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [catalog])

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      creationTargetRef.current = { workspaceId }
      applyActive(workspaceId)
    },
    [applyActive],
  )

  const toggleWorkspace = useCallback((workspaceId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      if (keysRef.current) writeString(keysRef.current.expanded, JSON.stringify([...next]))
      return next
    })
  }, [])

  const startProjectFor = useCallback((workspace: HarnessWorkspace): string | undefined => {
    const preferred = startPreferencesRef.current[workspace.id]
    if (preferred && workspace.projects.some((project) => project.path === preferred)) {
      return preferred
    }
    return workspace.projects[0]?.path
  }, [])

  const setStartProject = useCallback((workspaceId: string, path: string) => {
    startPreferencesRef.current = {
      ...startPreferencesRef.current,
      [workspaceId]: path,
    }
    if (keysRef.current) {
      writeString(keysRef.current.start, JSON.stringify(startPreferencesRef.current))
    }
  }, [])

  const beginNewSession = useCallback(
    (workspaceId: string, startProjectPath: string) => {
      creationTargetRef.current = { workspaceId, startProjectPath }
      setStartProject(workspaceId, startProjectPath)
      applyActive(workspaceId)
    },
    [applyActive, setStartProject],
  )

  const createThreadInput = useCallback((): HarnessCreateThreadInput => {
    const workspaceId = creationTargetRef.current.workspaceId ?? activeRef.current
    const workspace = catalogRef.current?.workspaces.find((item) => item.id === workspaceId)
    const startProjectPath =
      creationTargetRef.current.startProjectPath ??
      (workspace ? startPreferencesRef.current[workspace.id] : undefined) ??
      workspace?.projects[0]?.path
    return {
      ...(workspaceId ? { workspaceId } : {}),
      ...(startProjectPath ? { startProjectPath } : {}),
    }
  }, [])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      hostInfo,
      workspaces: catalog?.workspaces ?? [],
      state: catalog?.state,
      startupWorkspaceId: catalog?.startupWorkspaceId,
      threads,
      activeWorkspaceId,
      expanded,
      busy,
      error,
      notice,
      refresh,
      selectWorkspace,
      toggleWorkspace,
      startProjectFor,
      setStartProject,
      beginNewSession,
      createThreadInput,
      showNotice: (message) => {
        setNotice(message)
        setError(undefined)
      },
      showError: setError,
      clearError: () => setError(undefined),
      clearNotice: () => setNotice(undefined),
    }),
    [
      hostInfo,
      catalog,
      threads,
      activeWorkspaceId,
      expanded,
      busy,
      error,
      notice,
      refresh,
      selectWorkspace,
      toggleWorkspace,
      startProjectFor,
      setStartProject,
      beginNewSession,
      createThreadInput,
    ],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return value
}
