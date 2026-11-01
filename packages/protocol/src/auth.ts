/**
 * 模型 provider 认证契约（G1.4c）。
 *
 * 安全边界：
 * - 只传输 provider 标识、可登录方法、凭据类型与受控状态，不传输凭据原文、
 *   auth.json 内容、环境变量值或 provider 原始错误文案；
 * - 回填值只经一次请求交给宿主内存中的 resolver，绝不进入快照、事件或日志；
 * - 授权 URL 只允许 http(s)，由用户点击打开，宿主不自动拉起浏览器。
 */

/** provider 提供的登录方法（与 Pi auth 类型同名，不引入 SDK 依赖）。 */
export type HarnessProviderAuthMethod = 'api_key' | 'oauth'

/** 受控凭据来源：不暴露 SDK 的原始 label（对齐到固定枚举）。 */
export type HarnessProviderAuthSource =
  | 'stored'
  | 'runtime'
  | 'environment'
  | 'fallback'
  | 'models-json-key'
  | 'models-json-command'

/** 一个可登录方法的安全描述。 */
export type HarnessProviderAuthMethodInfo = {
  type: HarnessProviderAuthMethod
  label: string
  /** false 表示仅环境/配置提供凭据（ambient-only），不能交互登录。 */
  loginable: boolean
  /** OAuth 是否为订阅型登录（仅展示用途）。 */
  subscription?: boolean
}

/** provider 认证状态（不含 getAuth 结果与实际密钥）。 */
export type HarnessProviderAuthProvider = {
  providerId: string
  name: string
  configured: boolean
  source?: HarnessProviderAuthSource
  /** 已存凭据类型；来源为环境/配置时可能缺失。 */
  storedCredentialType?: HarnessProviderAuthMethod
  methods: readonly HarnessProviderAuthMethodInfo[]
  /** 所有方法都不可交互登录：只能通过环境变量或 models.json 配置。 */
  ambientOnly: boolean
}

/** 认证过程的安全事件（进度、授权链接、设备码）。 */
export type HarnessProviderAuthEvent = { eventId: string } & (
  | {
      type: 'info'
      message: string
      links?: readonly { url: string; label?: string }[]
    }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }
)

/** 当前等待用户回填的提示；不包含任何已提交值。 */
export type HarnessProviderAuthPrompt = {
  /** 每次提示独立 ID；过期/旧 ID 的回填一律拒绝。 */
  promptId: string
  kind: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: readonly { id: string; label: string; description?: string }[]
}

/** 受控失败分类；不转发 provider 原始错误。 */
export type HarnessProviderAuthFailureCode =
  | 'unsupported'
  | 'login-failed'
  | 'logout-failed'
  | 'sync-failed'
  | 'cancelled'

/** 操作终态结果。 */
export type HarnessProviderAuthResult = {
  status: 'succeeded' | 'failed' | 'cancelled'
  code?: HarnessProviderAuthFailureCode
  message: string
  retryable?: boolean
  /**
   * 凭据可能已经提交（登录）或移除（退出），但本地状态同步失败/取消竞态
   * 未能确认。UI 必须提示用户刷新 provider 状态，不自动重试覆盖。
   */
  credentialUncertain?: boolean
}

/** 操作阶段；`cancelling` 表示已请求取消，等待流程结算。 */
export type HarnessProviderAuthPhase =
  | 'starting'
  | 'waiting'
  | 'prompt'
  | 'verifying'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type HarnessProviderAuthOperationKind = 'login' | 'logout'

/**
 * 一次认证/退出操作的安全快照。
 *
 * `events` 有界且只含白名单字段；`prompt` 只描述当前提示本身，已回填值
 * 在提交时立即从快照移除且不保留副本。
 */
export type HarnessProviderAuthOperation = {
  id: string
  providerId: string
  providerName: string
  kind: HarnessProviderAuthOperationKind
  /** 登录方法；退出操作缺失。 */
  method?: HarnessProviderAuthMethod
  phase: HarnessProviderAuthPhase
  startedAt: string
  updatedAt: string
  events: readonly HarnessProviderAuthEvent[]
  prompt?: HarnessProviderAuthPrompt
  result?: HarnessProviderAuthResult
}

/** 认证权威快照；`authRevision` 在凭据/可用性可能变化后递增。 */
export type HarnessProviderAuthSnapshot = {
  seq: number
  authRevision: number
  providers: readonly HarnessProviderAuthProvider[]
  operations: readonly HarnessProviderAuthOperation[]
}

/** 订阅事件：每次变化投递完整快照（首帧即恢复，不依赖增量顺序）。 */
export type HarnessProviderAuthStreamEvent = {
  type: 'snapshot'
  seq: number
  snapshot: HarnessProviderAuthSnapshot
}

/** 登录/退出启动结果；`busy` 带当前同 provider 操作。 */
export type HarnessProviderAuthStartResult =
  | { status: 'started'; operation: HarnessProviderAuthOperation }
  | { status: 'busy'; operation: HarnessProviderAuthOperation }
  | { status: 'invalid'; message: string }

/** 回填结果：`stale` 覆盖重复提交、过期提示与已取消操作。 */
export type HarnessProviderAuthRespondResult =
  | { status: 'accepted' }
  | { status: 'stale' }
  | { status: 'invalid'; message: string }

/** 取消结果；`finished` 表示操作已结算（取消未生效或已结束）。 */
export type HarnessProviderAuthCancelResult =
  | { status: 'cancelling'; operation: HarnessProviderAuthOperation }
  | { status: 'finished'; operation: HarnessProviderAuthOperation }
  | { status: 'not-found' }
