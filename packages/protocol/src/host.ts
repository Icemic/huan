import type { HarnessRuntimeReadiness } from './thread.js'

/** 启动配置的生效来源；不包含配置原文或认证数据。 */
export type HarnessConfigSource = 'option' | 'env' | 'settings' | 'default'

/** 只读宿主信息；可在尚未创建会话时查询。 */
export type HarnessHostInfo = {
  /** wire 协议版本；浏览器启动时与自身版本比较，不做范围协商。 */
  protocolVersion: number
  workspacePath: string
  agentDir: string
  agentDirSource: HarnessConfigSource
  sessionStorage: {
    mode: 'grouped' | 'flat'
    root: string
    directory: string
    source: HarnessConfigSource
  }
  defaultModel: {
    provider?: string
    modelId?: string
    providerSource: HarnessConfigSource
    modelIdSource: HarnessConfigSource
    readiness: HarnessRuntimeReadiness
  }
  /** 仅传输受控代码；不透传扩展错误、请求头、堆栈或任意错误文案。 */
  diagnostics: readonly ('assembly-warning' | 'catalog-refresh-failed' | 'model-fallback')[]
}
