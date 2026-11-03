/**
 * 多项目工作区契约。
 *
 * workspaceId 是稳定产品 ID；项目 path 与 session cwd 都是文件系统路径，
 * 三者不互相替代。工作区定义由宿主串行持久化，浏览器只提交带预期
 * revision 的修改并读取权威结果。
 */
import type { HarnessThreadMetadata } from './thread.js'

/** 工作区成员（含宿主探测的目录可用性，不持久化为权威状态）。 */
export type HarnessWorkspaceProject = {
  alias: string
  path: string
  /** 宿主最近一次列目录时路径存在且为目录。 */
  available: boolean
}

/** 工作区权威定义。 */
export type HarnessWorkspace = {
  id: string
  name: string
  /** 每次成功修改递增；修改请求必须携带预期值。 */
  revision: number
  projects: HarnessWorkspaceProject[]
  /**
   * 自定义模型范围（完整替换用户启用范围）；缺失表示跟随全局。
   * 自定义时至少一项，空数组不作为继承或无模型的表示。
   */
  modelPatterns?: string[]
}

/** 元数据文件状态。非 ok 时冷历史仍可读，但依赖归属的修改禁用。 */
export type HarnessWorkspaceState = 'ok' | 'corrupted' | 'unsupported-version' | 'unreadable'

/** 工作区列表 + 文件健康状态。 */
export type HarnessWorkspaceCatalog = {
  workspaces: HarnessWorkspace[]
  state: HarnessWorkspaceState
  /** 宿主启动项目对应的默认工作区（存在时）；窗口首次选择可使用。 */
  startupWorkspaceId?: string
}

/** 创建/修改时提交的成员。 */
export type HarnessWorkspaceProjectInput = {
  alias: string
  path: string
}

/** 创建工作区。 */
export type HarnessCreateWorkspaceInput = {
  name: string
  projects: HarnessWorkspaceProjectInput[]
  /** 可选自定义模型范围；省略表示跟随全局。 */
  modelPatterns?: string[]
}

/** 修改工作区；name/projects/modelPatterns 至少一项，revision 必须匹配当前值。 */
export type HarnessUpdateWorkspaceInput = {
  workspaceId: string
  expectedRevision: number
  name?: string
  projects?: HarnessWorkspaceProjectInput[]
  /** 自定义模型范围；null 清除覆盖并跟随全局。 */
  modelPatterns?: string[] | null
}

/** 工作区修改失败分类（页面可据此提示重读或修复输入）。 */
export type HarnessWorkspaceMutationError =
  | 'conflict'
  | 'state-unavailable'
  | 'not-found'
  | 'invalid'

/** 工作区修改结果：冲突时附带宿主当前定义，便于立即重读。 */
export type HarnessWorkspaceMutationResult =
  | { ok: true; workspace: HarnessWorkspace }
  | {
      ok: false
      error: HarnessWorkspaceMutationError
      workspace?: HarnessWorkspace
      /** 受控原因代码（如 invalid-alias），不传任意服务端错误。 */
      reason?: string
    }

/** 明确把无归属会话加入工作区。 */
export type HarnessAssignThreadInput = {
  threadId: string
  workspaceId: string
}

/** 会话归属结果；成功时返回更新后的会话元数据（热/冷口径一致）。 */
export type HarnessAssignThreadResult =
  | { ok: true; thread: HarnessThreadMetadata }
  | {
      ok: false
      error: Exclude<HarnessWorkspaceMutationError, 'conflict'>
      reason?: string
    }
