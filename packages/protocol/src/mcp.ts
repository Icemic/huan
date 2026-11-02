/**
 * MCP 管理、配置与 OAuth 契约（G1.4d3）。
 *
 * 纯 TS、JSON-safe，不依赖 Node 或 Pi SDK：
 * - 普通 MCP 快照只含服务器身份、受控运行状态与认证资格，不含 URL、env、
 *   headers、token、日志文本或原始异常；
 * - 配置原文/可能含秘密的字段只在显式编辑接口返回，并带 revision；
 * - 管理操作以 runtimeId + identity 校验目标，临时启停/exposure 不自动保存；
 * - 认证快照独立于普通会话快照，回填值只进入宿主内存 resolver，不出现在任何
 *   响应中；不新增 SSE，客户端按需轮询。
 */

/** MCP exposure；与 Pi 配置保持同名语义，但协议不导入 Pi SDK 类型。 */
export type HarnessMcpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden'

/** 管理/认证目标：会话或空白页固定起始目录二选一。 */
export type HarnessMcpTargetInput = {
  /** 活/冷会话 ID：使用该会话固定的 cwd。 */
  threadId?: string
  /** 空白页的固定起始目录（绝对路径）。 */
  workspacePath?: string
}

/** 解析后的目标；runtimeId 只在目标存在 live manager 时由快照单独提供。 */
export type HarnessMcpTarget = {
  kind: 'session' | 'workspace'
  workspacePath: string
  threadId?: string
}

/** 项目信任结论的只读投影。 */
export type HarnessMcpTrust = {
  decision: 'trusted' | 'untrusted' | 'needs-trust'
  requiresTrust: boolean
  origin: string
}

/** 配置诊断分类；与 @huan/mcp 的受控诊断同名。 */
export type HarnessMcpConfigIssueKind =
  | 'parse'
  | 'shape'
  | 'unsafe-key'
  | 'too-deep'
  | 'too-large'
  | 'read'
  | 'invalid-server'
  | 'invalid-override'
  | 'namespace-collision'
  | 'project-auth'

/** 一条配置诊断；消息只描述字段/原因，不回显配置值。 */
export type HarnessMcpConfigIssue = {
  kind: HarnessMcpConfigIssueKind
  scope: 'user' | 'project'
  file: string
  server?: string
  message: string
}

/** 单个配置文件的状态与原文（显式配置编辑接口才返回原文）。 */
export type HarnessMcpConfigFile = {
  scope: 'user' | 'project'
  path: string
  /** 项目未信任时为 false，且不返回存在性。 */
  readable: boolean
  exists: boolean
  /** 文件原文；不可读或不存在时为空串。可能含秘密。 */
  content: string
  /** 原文 UTF-8 字节的 SHA-256；不存在为 null。 */
  revision: string | null
  bytes: number
  tooLarge: boolean
  issues: readonly HarnessMcpConfigIssue[]
  readError?: string
}

/** 合并后的受控服务器摘要；不包含连接字段。 */
export type HarnessMcpConfiguredServer = {
  name: string
  /** 规范服务器身份；只含名称与 URL 截断哈希。 */
  identity: string
  scope: 'user' | 'project'
  /** 是否由项目 override 提供 enabled/exposure/toolExposure。 */
  override: boolean
  enabled: boolean
  exposure: HarnessMcpExposure
}

/** 配置编辑快照：包含原文与磁盘合并预览。 */
export type HarnessMcpConfigSnapshot = {
  target: HarnessMcpTarget
  projectTrusted: boolean
  trust: HarnessMcpTrust
  files: {
    user: HarnessMcpConfigFile
    project: HarnessMcpConfigFile
  }
  effective: {
    autoEnableCodemode?: boolean
    servers: readonly HarnessMcpConfiguredServer[]
    issues: readonly HarnessMcpConfigIssue[]
  }
}

/** 整份原文保存输入；expectedRevision 缺文件必须为 null。 */
export type HarnessMcpConfigSaveInput = {
  target: HarnessMcpTargetInput
  scope: 'user' | 'project'
  content: string
  expectedRevision: string | null
}

/** 保存后的应用说明；保存不自动重载 live manager。 */
export type HarnessMcpConfigApplyState = {
  persisted: boolean
  reloadRequired: boolean
  message: string
}

/** 整份原文保存结果。 */
export type HarnessMcpConfigSaveResult =
  | {
      status: 'saved'
      scope: 'user' | 'project'
      path: string
      revision: string
      bytes: number
      snapshot: HarnessMcpConfigSnapshot
      apply: HarnessMcpConfigApplyState
    }
  | {
      status: 'conflict'
      scope: 'user' | 'project'
      path: string
      revision: string | null
      message: string
    }
  | {
      status: 'invalid'
      scope: 'user' | 'project'
      path: string
      issues: readonly HarnessMcpConfigIssue[]
      message: string
    }
  | {
      status: 'too-large'
      scope: 'user' | 'project'
      path: string
      limitBytes: number
      message: string
    }
  | {
      status: 'untrusted'
      scope: 'user' | 'project'
      path: string
      message: string
    }
  | {
      status: 'failed'
      scope: 'user' | 'project'
      path: string
      message: string
    }

/** 单个服务器的运行状态；config-only 表示冷目标尚未连接。 */
export type HarnessMcpServerState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs-auth'
  | 'failed'
  | 'closed'
  | 'disabled'
  | 'not-connected'

/** OAuth 登录资格分类；非 OAuth 连接明确不可交互登录。 */
export type HarnessMcpAuthKind = 'oauth' | 'static-header' | 'provider' | 'stdio'

/** 单个服务器的认证摘要。 */
export type HarnessMcpServerAuth = {
  kind: HarnessMcpAuthKind
  loginable: boolean
  /** 仅 OAuth 条目读取宿主凭据库；其它分类恒为 false。 */
  hasCredentials: boolean
  /** 登录成功但 live 会话忙于运行，未强制重连；下次连接可读取新 token。 */
  needsRefresh: boolean
}

/** 普通 MCP 快照中的服务器摘要。 */
export type HarnessMcpServerSummary = {
  name: string
  identity: string
  scope: 'user' | 'project' | 'extension'
  override: boolean
  enabled: boolean
  exposure: HarnessMcpExposure
  state: HarnessMcpServerState
  toolCount: number
  hasResources: boolean
  toolRevision: number
  auth: HarnessMcpServerAuth
  error?: {
    code: string
    message: string
  }
}

/** live manager 的受控运行时摘要。 */
export type HarnessMcpRuntimeInfo = {
  runtimeId: string
  revision: number
  started: boolean
  closed: boolean
}

/** 普通 MCP 快照：不启动连接、不读取配置原文。 */
export type HarnessMcpSnapshot = {
  target: HarnessMcpTarget
  live: boolean
  runtime?: HarnessMcpRuntimeInfo
  projectTrusted: boolean
  trust: HarnessMcpTrust
  servers: readonly HarnessMcpServerSummary[]
  /** 冷目标读取配置时的诊断；live 快照不携带配置原文/字段。 */
  issues?: readonly HarnessMcpConfigIssue[]
}

/** 显式详情查询包含的目录。 */
export type HarnessMcpDetailSection = 'tools' | 'resources' | 'resource-templates'

/** 工具目录条目；服务端元数据只传递，不执行。 */
export type HarnessMcpToolSummary = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  execution?: {
    taskSupport?: 'forbidden' | 'optional' | 'required'
  }
  _meta?: Record<string, unknown>
  exposure: HarnessMcpExposure
}

/** 资源注解。 */
export type HarnessMcpContentAnnotations = {
  audience?: readonly ('user' | 'assistant')[]
  priority?: number
  lastModified?: string
}

/** 资源目录条目。 */
export type HarnessMcpResourceSummary = {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
  annotations?: HarnessMcpContentAnnotations
  _meta?: Record<string, unknown>
}

/** 资源模板目录条目。 */
export type HarnessMcpResourceTemplateSummary = {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: HarnessMcpContentAnnotations
  _meta?: Record<string, unknown>
}

/** 详情查询输入；include 必须显式列出要读取的目录。 */
export type HarnessMcpDetailsInput = {
  target: HarnessMcpTargetInput
  expectedRuntimeId: string
  server: string
  include: readonly HarnessMcpDetailSection[]
}

/** 详情查询结果；tools/resources 只在请求时存在。 */
export type HarnessMcpDetails = {
  target: HarnessMcpTarget
  runtimeId: string
  server: {
    name: string
    identity: string
    state: HarnessMcpServerState
    exposure: HarnessMcpExposure
    toolRevision: number
  }
  instructions?: string
  tools?: readonly HarnessMcpToolSummary[]
  resources?: readonly HarnessMcpResourceSummary[]
  resourceTemplates?: readonly HarnessMcpResourceTemplateSummary[]
}

/** 详情查询的受控结果。 */
export type HarnessMcpDetailsResult =
  | { status: 'ok'; details: HarnessMcpDetails }
  | { status: 'busy' | 'stale' | 'unavailable' | 'failed' | 'invalid'; message: string }

/** 临时管理动作；只改 live manager，不写配置文件。 */
export type HarnessMcpManageAction =
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'setExposure'; exposure: HarnessMcpExposure }
  | { type: 'setToolExposure'; tool: string; exposure: HarnessMcpExposure | null }
  | { type: 'reconnect' }

/** 管理输入：必须带上一次快照中的 runtimeId 与服务器身份。 */
export type HarnessMcpManageInput = {
  target: HarnessMcpTargetInput
  expectedRuntimeId: string
  server: string
  expectedIdentity: string
  action: HarnessMcpManageAction
}

/** 管理结果；success 附带操作后的权威快照。 */
export type HarnessMcpManageResult =
  | { status: 'applied'; snapshot: HarnessMcpSnapshot }
  | { status: 'busy' | 'stale' | 'unavailable' | 'failed' | 'invalid'; message: string }

/** 认证操作类别。 */
export type HarnessMcpAuthOperationKind = 'login' | 'logout'

/** 认证阶段；cancelling 表示已请求取消，等待真实流程结算。 */
export type HarnessMcpAuthPhase =
  | 'starting'
  | 'waiting'
  | 'prompt'
  | 'verifying'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/** 当前等待用户回填的提示；不包含已提交值。 */
export type HarnessMcpAuthPrompt = {
  promptId: string
  kind: 'redirect_url'
  message: string
  placeholder?: string
}

/** 受控失败分类；不转发 OAuth 原始错误文案。 */
export type HarnessMcpAuthFailureCode =
  | 'unsupported'
  | 'login-failed'
  | 'logout-failed'
  | 'storage-failed'
  | 'cancelled'

/** 登录/退出终态结果。 */
export type HarnessMcpAuthResult = {
  status: 'succeeded' | 'failed' | 'cancelled'
  code?: HarnessMcpAuthFailureCode
  message: string
  retryable?: boolean
  /**
   * 登录成功后对同身份 live manager 的处理：
   * - started：已在安全 idle 准入内后台重连；
   * - deferred：会话正忙，未强制断开，只标记 needsRefresh；
   * - not-live：目标已失效或服务器已不在 live manager 中。
   */
  reconnect?: 'started' | 'deferred' | 'not-live'
}

/** 一次认证/退出操作的安全快照。 */
export type HarnessMcpAuthOperation = {
  id: string
  server: string
  identity: string
  kind: HarnessMcpAuthOperationKind
  phase: HarnessMcpAuthPhase
  target: HarnessMcpTarget
  runtimeId: string
  startedAt: string
  updatedAt: string
  /** 授权页链接；只允许 http(s)，由用户点击打开。 */
  authUrl?: string
  prompt?: HarnessMcpAuthPrompt
  result?: HarnessMcpAuthResult
}

/** 认证权威快照；客户端轮询，不需要 target。 */
export type HarnessMcpAuthSnapshot = {
  seq: number
  authRevision: number
  operations: readonly HarnessMcpAuthOperation[]
}

/** 登录/退出启动输入。 */
export type HarnessMcpAuthStartInput = {
  target: HarnessMcpTargetInput
  expectedRuntimeId: string
  server: string
  expectedIdentity: string
}

/** 登录/退出启动结果；stale 覆盖旧 runtime/identity。 */
export type HarnessMcpAuthStartResult =
  | { status: 'started'; operation: HarnessMcpAuthOperation }
  | { status: 'busy'; operation?: HarnessMcpAuthOperation; message?: string }
  | { status: 'stale'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'invalid'; message: string }

/** 回填结果；promptId 只能成功领取一次。 */
export type HarnessMcpAuthRespondInput = {
  operationId: string
  promptId: string
  value: string
}

/** 回填结果；stale 覆盖重复提交、过期提示与已取消操作。 */
export type HarnessMcpAuthRespondResult =
  | { status: 'accepted' }
  | { status: 'stale' }
  | { status: 'invalid'; message: string }

/** 取消结果；finished 表示操作已真实结算。 */
export type HarnessMcpAuthCancelResult =
  | { status: 'cancelling'; operation: HarnessMcpAuthOperation }
  | { status: 'finished'; operation: HarnessMcpAuthOperation }
  | { status: 'not-found' }

/** 配置正文上限（与共享配置文件一致）。 */
export const HARNESS_MCP_CONFIG_CONTENT_MAX_BYTES = 512 * 1024

/** 配置 HTTP 请求体上限（正文 + JSON 包装余量）。 */
export const HARNESS_MCP_CONFIG_BODY_LIMIT_BYTES = 768 * 1024

/** 管理/认证 HTTP 请求体上限。 */
export const HARNESS_MCP_SMALL_BODY_LIMIT_BYTES = 16 * 1024

/** 回填 URL 的字符上限；与宿主内存 resolver 一致。 */
export const HARNESS_MCP_AUTH_PROMPT_MAX_CHARS = 8_192
