/**
 * 应用 bootstrap：显式创建 HTTP client、浏览器实例、应用 feature store 与 DOM 资源。
 *
 * 这是浏览器侧唯一组合根。React Context 只传这里创建的实例；不同标签页各自
 * 创建，通过 Node 权威数据同步。重载/嵌入根销毁时由调用方 dispose。
 */

import { createHarnessBrowser, type HarnessBrowser, type HarnessBrowserStorage } from '@huan/react'
import { createHarnessHttpClient } from '@huan/react/client'
import type { StoreApi } from 'zustand/vanilla'
import { applyThemeToDocument, type ThemeStorage } from './lib/theme'
import { type AuthFeatureState, createAuthFeatureStore } from './state/auth-store'
import { type ChatFeatureState, createChatFeatureStore } from './state/chat-store'
import { type ComposerFeatureState, createComposerFeatureStore } from './state/composer-store'
import { createHostFeatureStore, type HostFeatureState } from './state/host-store'
import { createMcpFeatureStore, type McpFeatureState } from './state/mcp-store'
import { createModelFeatureStore, type ModelFeatureState } from './state/model-store'
import { createRuntimeFeatureStore, type RuntimeFeatureState } from './state/runtime-store'
import { createSessionsFeatureStore, type SessionsFeatureState } from './state/sessions-store'
import { createSettingsFeatureStore, type SettingsFeatureState } from './state/settings-store'
import { createSettingsUiStore, type SettingsUiState } from './state/settings-ui-store'
import { createSubagentFeatureStore, type SubagentFeatureState } from './state/subagent-store'
import { createThemeStore, type ThemeStoreState } from './state/theme-store'
import { createWorkspaceFeatureStore, type WorkspaceFeatureState } from './state/workspace-store'

/** bootstrap 返回的应用实例组合；Context 只传这个对象。 */
export interface HarnessApp {
  browser: HarnessBrowser
  workspaceStore: StoreApi<WorkspaceFeatureState>
  sessionsStore: StoreApi<SessionsFeatureState>
  settingsStore: StoreApi<SettingsFeatureState>
  settingsUiStore: StoreApi<SettingsUiState>
  authStore: StoreApi<AuthFeatureState>
  hostStore: StoreApi<HostFeatureState>
  mcpStore: StoreApi<McpFeatureState>
  runtimeStore: StoreApi<RuntimeFeatureState>
  modelStore: StoreApi<ModelFeatureState>
  composerStore: StoreApi<ComposerFeatureState>
  chatStore: StoreApi<ChatFeatureState>
  subagentStore: StoreApi<SubagentFeatureState>
  themeStore: StoreApi<ThemeStoreState>
  dispose(): void
}

const WINDOW_ID_KEY = 'huan.window-id'

const browserStorage = (): HarnessBrowserStorage | null => {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage
  } catch {
    return null
  }
}

const themeStorage = (): ThemeStorage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

/** 当前浏览器窗口的稳定标识（同一标签页刷新后保持）。 */
const createWindowId = (storage: HarnessBrowserStorage | null): string => {
  if (typeof window === 'undefined') return 'host'
  try {
    const existing = storage?.getItem(WINDOW_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    storage?.setItem(WINDOW_ID_KEY, id)
    return id
  } catch {
    // 隐私模式等无法持久化时退回进程内随机值。
    return crypto.randomUUID()
  }
}

const connectionKeyOf = (): string => {
  if (typeof location === 'undefined') return 'huan'
  return `${location.origin}/api/pi`
}

/** 创建应用唯一实例；调用方负责在根销毁/HMR 时 dispose。 */
export const createHarnessApp = (): HarnessApp => {
  const storage = browserStorage()
  const windowId = createWindowId(storage)
  const token = typeof __HUAN_TOKEN__ === 'string' ? __HUAN_TOKEN__ : ''
  const client = createHarnessHttpClient({
    callerId: windowId,
    ...(token ? { headers: { 'x-huan-token': token } } : {}),
  })
  const browser = createHarnessBrowser({
    client,
    connectionKey: connectionKeyOf(),
    windowId,
    ...(storage ? { storage } : { storage: null }),
  })

  const workspaceStore = createWorkspaceFeatureStore({
    browser,
    ...(storage ? { storage } : { storage: null }),
  })
  const sessionsStore = createSessionsFeatureStore({
    browser,
    onNotice: (message) => workspaceStore.getState().showNotice(message),
  })
  const fallbackWorkspacePath = () => {
    const workspaceId = workspaceStore.getState().activeWorkspaceId
    if (!workspaceId) return browser.serviceStore.getState().host?.workspacePath
    return (
      workspaceStore.getState().startProjectFor(workspaceId) ??
      browser.serviceStore.getState().host?.workspacePath
    )
  }
  const composerRef: { current?: StoreApi<ComposerFeatureState> } = {}
  const settingsStore = createSettingsFeatureStore({
    browser,
    fallbackWorkspacePath,
    onResourceReloaded: () => {
      void composerRef.current?.getState().refreshCatalog()
    },
  })
  const authStore = createAuthFeatureStore({ browser })
  const chatStore = createChatFeatureStore()
  const subagentStore = createSubagentFeatureStore({ client })
  const hostStore = createHostFeatureStore({ browser })
  const mcpStore = createMcpFeatureStore({ browser, fallbackWorkspacePath })
  const runtimeStore = createRuntimeFeatureStore({ browser, fallbackWorkspacePath })
  const modelStore = createModelFeatureStore({ browser, fallbackWorkspacePath })

  // 统一设置导航只保存开关/页签；页面数据加载与短期清理集中在这里，
  // 避免各页签组件并行维护业务加载或秘密输入生命周期。
  const settingsUiStore = createSettingsUiStore({
    onChange: (page, previous, context) => {
      const leavingModels = context.wasOpen && previous === 'models' && page !== 'models'
      if (leavingModels) authStore.getState().resetView()
      switch (page) {
        case 'models': {
          if (context.focus) {
            void authStore.getState().focusProvider(context.focus)
          } else {
            if (!context.wasOpen || previous !== 'models') authStore.getState().resetView()
            void authStore.getState().refresh()
          }
          // 全局设置不依赖当前会话/目录；具体页签内容由 GlobalSettingsContent 展示。
          void settingsStore.getState().openPanel({ global: true })
          break
        }
        case 'conversation':
        case 'tools':
        case 'advanced':
          void settingsStore.getState().openPanel({ global: true })
          break
        case 'mcp':
          void mcpStore.getState().openPanel({ target: { global: true } })
          break
        case 'service':
          void hostStore.getState().refreshHostInfo()
          break
        case 'appearance':
          break
      }
    },
    onClose: (page) => {
      // 关闭请求立即失效在途读取与秘密回填；进行中的认证/写入继续。
      if (page === 'models') authStore.getState().resetView()
      settingsStore.getState().close()
      mcpStore.getState().close()
    },
    onCloseComplete: () => {
      // 退出动画完成后才丢弃页面视图，避免关闭阶段正文突然变空。
      settingsStore.getState().finishClose()
      mcpStore.getState().finishClose()
    },
  })
  const composerStore = createComposerFeatureStore({
    browser,
    workspaceStore,
    sessionsStore,
    settingsStore,
    mcpStore,
    runtimeStore,
    modelStore,
    settingsUiStore,
  })
  composerRef.current = composerStore
  composerStore
    .getState()
    .refreshCatalog()
    .catch(() => {})

  // 主题业务状态在 Zustand；matchMedia 与文档 class 写入由 bootstrap 持有。
  const media =
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? undefined
      : window.matchMedia('(prefers-color-scheme: dark)')
  const themeStore = createThemeStore({
    storage: themeStorage(),
    prefersDark: () => media?.matches ?? false,
    apply: (resolved) => {
      if (typeof document === 'undefined') return
      applyThemeToDocument(resolved, document)
    },
  })
  // 首次渲染前应用已保存主题，避免暗色页面闪白；DOM 写入留在 bootstrap。
  if (typeof document !== 'undefined') {
    applyThemeToDocument(themeStore.getState().resolved, document)
  }
  const onSystemThemeChange = () => themeStore.getState().syncSystem()
  media?.addEventListener('change', onSystemThemeChange)

  // 窗口存储作用域与显式选择的变化同步到应用 feature；不复制选择值。
  let previousScope = browser.windowStore.getState().storageScope
  let previousSelection = browser.windowStore.getState().selection
  const unsubscribeWindow = browser.windowStore.subscribe((state) => {
    if (state.storageScope !== previousScope) {
      previousScope = state.storageScope
      workspaceStore.getState().setStorageScope(state.storageScope)
    }
    if (state.selection !== previousSelection) {
      previousSelection = state.selection
      workspaceStore.getState().syncSelection()
      composerStore.getState().onSelectionChanged()
      runtimeStore.getState().close()
      modelStore.getState().close()
    }
  })

  // 窗口聚焦/恢复时显式重扫作用域，外部 Pi 与跨窗口改动可见。
  const onFocus = () => {
    void workspaceStore.getState().refresh({ rescan: true })
  }
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onFocus()
  }
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }

  let disposed = false
  return {
    browser,
    workspaceStore,
    sessionsStore,
    settingsStore,
    settingsUiStore,
    authStore,
    hostStore,
    mcpStore,
    runtimeStore,
    modelStore,
    composerStore,
    chatStore,
    subagentStore,
    themeStore,
    dispose: () => {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      media?.removeEventListener('change', onSystemThemeChange)
      try {
        unsubscribeWindow()
      } catch (error) {
        errors.push(error)
      }
      try {
        chatStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        composerStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        subagentStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        mcpStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        runtimeStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        modelStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        sessionsStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        settingsStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        authStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        hostStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        workspaceStore.getState().dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        browser.dispose()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        for (const error of errors.slice(1)) console.error('[huan-app] 实例释放失败', error)
        throw errors[0]
      }
    },
  }
}
