import type {
  HarnessHostInfo,
  HarnessProjectFailureCode,
  HarnessProjectInfo,
  HarnessProjectTrustInput,
  HarnessRecentProject,
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

/** 页面侧失败分类（路径校验与项目装配共用）。 */
export type ProjectUiError = HarnessProjectFailureCode

type ProjectContextValue = {
  hostInfo: HarnessHostInfo | undefined
  project: HarnessProjectInfo | undefined
  recent: readonly HarnessRecentProject[]
  /** 项目请求进行中（路径校验/查询/信任决定）。 */
  busy: boolean
  /** 宿主信息加载失败。 */
  hostUnavailable: boolean
  error: ProjectUiError | undefined
  /** 等待用户回答的项目（信任弹层的数据源）。 */
  pendingTrust: HarnessProjectInfo | undefined
  openProject: (path: string) => Promise<boolean>
  decideTrust: (input: Omit<HarnessProjectTrustInput, 'path'>) => Promise<boolean>
  /** 把当前项目切到信任审阅视图（不改变项目本身）。 */
  reviewTrust: () => void
  cancelTrust: () => void
  retryProject: () => Promise<void>
  clearError: () => void
  refreshRecent: () => Promise<void>
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined)

/** 窗口内选择记录按宿主身份隔离：同一浏览器可连接不同用户空间。 */
const storageKeyOf = (info: HarnessHostInfo): string =>
  `huan.projectPath:${info.agentDir}:${info.workspacePath}`

const recentKeyOf = (info: HarnessHostInfo): string =>
  `huan.recentProjects:${info.agentDir}:${info.workspacePath}`

/** 路径最后一段（不依赖 node:path，浏览器安全）。 */
const projectNameOfPath = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** 读取本窗口已选项目（无会话的项目也能出现在最近列表）。 */
const readLocalRecent = (key: string): string[] => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

/** 记住本窗口已选项目（去重、上限 10 条）。 */
const rememberLocalProject = (key: string, path: string): string[] => {
  const next = [path, ...readLocalRecent(key).filter((item) => item !== path)].slice(0, 10)
  try {
    sessionStorage.setItem(key, JSON.stringify(next))
  } catch {
    // 存储不可用只影响窗口记录，不影响项目本身。
  }
  return next
}

/** 合并宿主会话 header 与窗口已选项目；宿主顺序优先。 */
const mergeRecent = (
  server: readonly HarnessRecentProject[],
  local: readonly string[],
): HarnessRecentProject[] => {
  const seen = new Set<string>()
  const result: HarnessRecentProject[] = []
  for (const item of server) {
    if (seen.has(item.path)) continue
    seen.add(item.path)
    result.push(item)
  }
  for (const path of local) {
    if (seen.has(path)) continue
    seen.add(path)
    result.push({ path, name: projectNameOfPath(path) })
  }
  return result
}

/**
 * 项目选择上下文（G1.2a）。
 *
 * 选择结果只影响本窗口的会话列表与新建目标；不调用 chdir，不停止其他窗口
 * 或其他项目的运行。信任决定经宿主统一入口执行，页面不自行推断。
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [hostInfo, setHostInfo] = useState<HarnessHostInfo>()
  const [project, setProject] = useState<HarnessProjectInfo>()
  const [recent, setRecent] = useState<readonly HarnessRecentProject[]>([])
  const [pendingTrust, setPendingTrust] = useState<HarnessProjectInfo>()
  const [busy, setBusy] = useState(true)
  const [hostUnavailable, setHostUnavailable] = useState(false)
  const [error, setError] = useState<ProjectUiError>()
  const storageKey = useRef<string | undefined>(undefined)
  const recentKey = useRef<string | undefined>(undefined)
  const localRecent = useRef<string[]>([])
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const loadRecent = useCallback(async () => {
    try {
      const value = await harnessHttpClient.listRecentProjects()
      if (active.current) setRecent(mergeRecent(value, localRecent.current))
    } catch {
      // 最近项目失败不阻断项目进入；保留上次结果。
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const info = await harnessHttpClient.getHostInfo()
        if (!active.current) return
        setHostInfo(info)
        storageKey.current = storageKeyOf(info)
        recentKey.current = recentKeyOf(info)
        localRecent.current = readLocalRecent(recentKey.current)
        const preferred = sessionStorage.getItem(storageKeyOf(info)) ?? info.workspacePath
        const [nextRecent, nextProject] = await Promise.all([
          harnessHttpClient.listRecentProjects().catch(() => [] as HarnessRecentProject[]),
          harnessHttpClient.getProject({ path: preferred }),
        ])
        if (!active.current) return
        setRecent(mergeRecent(nextRecent, localRecent.current))
        setProject(nextProject)
        if (nextProject.status === 'needs-trust') setPendingTrust(nextProject)
        if (nextProject.status === 'failed') {
          setError(nextProject.failure?.code ?? 'load-failed')
        }
      } catch {
        if (active.current) setHostUnavailable(true)
      } finally {
        if (active.current) setBusy(false)
      }
    })()
  }, [])

  const refreshRecent = useCallback(async () => {
    await loadRecent()
  }, [loadRecent])

  const acceptProject = useCallback((info: HarnessProjectInfo) => {
    setProject(info)
    setPendingTrust(undefined)
    setError(info.status === 'failed' ? (info.failure?.code ?? 'load-failed') : undefined)
    if (info.status !== 'failed' && storageKey.current) {
      try {
        sessionStorage.setItem(storageKey.current, info.path)
      } catch {
        // 存储不可用只影响窗口恢复，不影响当前项目。
      }
      if (recentKey.current) {
        localRecent.current = rememberLocalProject(recentKey.current, info.path)
      }
    }
  }, [])

  const openProject = useCallback(
    async (path: string): Promise<boolean> => {
      setBusy(true)
      setError(undefined)
      try {
        const check = await harnessHttpClient.checkProjectPath(path)
        if (check.error) {
          setError(check.error.code)
          return false
        }
        const info = await harnessHttpClient.getProject({ path: check.path })
        if (info.status === 'failed') {
          setError(info.failure?.code ?? 'load-failed')
          return false
        }
        if (info.status === 'needs-trust') {
          // 先展示风险与来源；取消时保持原项目不动。
          setPendingTrust(info)
          return true
        }
        acceptProject(info)
        await loadRecent()
        return true
      } catch {
        setError('load-failed')
        return false
      } finally {
        setBusy(false)
      }
    },
    [acceptProject, loadRecent],
  )

  const decideTrust = useCallback(
    async (input: Omit<HarnessProjectTrustInput, 'path'>) => {
      const target = pendingTrust
      if (!target) return false
      setBusy(true)
      setError(undefined)
      try {
        const info = await harnessHttpClient.decideProjectTrust({ ...input, path: target.path })
        if (info.status === 'failed') {
          setError(info.failure?.code ?? 'load-failed')
          return false
        }
        acceptProject(info)
        await loadRecent()
        return true
      } catch {
        setError('load-failed')
        return false
      } finally {
        setBusy(false)
      }
    },
    [acceptProject, loadRecent, pendingTrust],
  )

  const reviewTrust = useCallback(() => {
    if (project && project.status !== 'failed') setPendingTrust(project)
  }, [project])

  const cancelTrust = useCallback(() => {
    // 取消只关闭弹层，不写决定、不切换项目。
    setPendingTrust(undefined)
  }, [])

  const retryProject = useCallback(async () => {
    if (!project) return
    setBusy(true)
    setError(undefined)
    try {
      const info = await harnessHttpClient.getProject({ path: project.path })
      if (info.status === 'needs-trust') {
        setProject(info)
        setPendingTrust(info)
        return
      }
      acceptProject(info)
      await loadRecent()
    } catch {
      setError('load-failed')
    } finally {
      setBusy(false)
    }
  }, [acceptProject, loadRecent, project])

  const value = useMemo<ProjectContextValue>(
    () => ({
      hostInfo,
      project,
      recent,
      busy,
      hostUnavailable,
      error,
      pendingTrust,
      openProject,
      decideTrust,
      reviewTrust,
      cancelTrust,
      retryProject,
      clearError: () => setError(undefined),
      refreshRecent,
    }),
    [
      hostInfo,
      project,
      recent,
      busy,
      hostUnavailable,
      error,
      pendingTrust,
      openProject,
      decideTrust,
      reviewTrust,
      cancelTrust,
      retryProject,
      refreshRecent,
    ],
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext)
  if (!value) throw new Error('useProject must be used inside ProjectProvider')
  return value
}
