/**
 * 项目入口与信任契约（G1.2a）。
 *
 * 只包含页面需要的 JSON-safe 摘要：真实路径、可控状态码与信任来源；
 * 不携带扩展错误原文、文件内容或认证信息。
 */

/** 项目路径校验结果（由 Node 侧解析与检查，浏览器不自行判断）。 */
export type HarnessProjectPathCheck = {
  /** 用户输入的原始路径。 */
  input: string
  /** 规范化后的绝对路径（realpath；不存在时退回解析后的绝对路径）。 */
  path: string
  exists: boolean
  isDirectory: boolean
  error?: {
    code: 'invalid-path' | 'not-found' | 'not-directory'
  }
}

/** 信任结论。`unknown` 表示尚未作出决定（等待用户回答）。 */
export type HarnessProjectTrustDecision = 'trusted' | 'untrusted' | 'unknown'

/** 决定来源（与 Pi 信任语义一致）。 */
export type HarnessProjectTrustOrigin =
  | 'explicit'
  | 'extension'
  | 'saved'
  | 'default'
  | 'ask'
  | 'no-resources'
  | 'none'

/** 全局默认信任策略。 */
export type HarnessProjectDefaultPolicy = 'ask' | 'always' | 'never'

/** 项目信任摘要。 */
export type HarnessProjectTrust = {
  decision: HarnessProjectTrustDecision
  origin: HarnessProjectTrustOrigin
  /** 是否存在需要信任门控的项目资源（扩展/skills/模板/主题等）。 */
  requiresTrust: boolean
  defaultPolicy: HarnessProjectDefaultPolicy
  /** 命中的保存决定路径（父路径继承时为父路径）。 */
  savedPath?: string
  /** 用户级 `project_trust` 扩展的处理错误数量（不暴露原文）。 */
  extensionErrorCount: number
}

/** 项目状态。`loading` 由 UI 在请求进行中呈现，服务端只在失败/待决定/就绪间切换。 */
export type HarnessProjectStatus = 'ready' | 'needs-trust' | 'loading' | 'failed'

/** 项目失败分类（文案由页面翻译，不传任意服务端错误）。 */
export type HarnessProjectFailureCode =
  | 'invalid-path'
  | 'not-found'
  | 'not-directory'
  | 'load-failed'

/** 项目摘要。 */
export type HarnessProjectInfo = {
  /** 规范化后的项目路径。 */
  path: string
  /** 路径最后一段（无路径分隔符时退回完整路径）。 */
  name: string
  status: HarnessProjectStatus
  trust: HarnessProjectTrust
  failure?: {
    code: HarnessProjectFailureCode
  }
}

/** 最近项目（来自同一用户空间的会话 header 与窗口已选项目）。 */
export type HarnessRecentProject = {
  path: string
  name: string
  /** 最近会话活动时间（ISO）；无会话记录时省略。 */
  lastActiveAt?: string
}

/** 保存信任决定的输入。 */
export type HarnessProjectTrustInput = {
  path: string
  trusted: boolean
  /** 写入 trust.json（当前路径），缺省仅本次生效。 */
  remember?: boolean
}
