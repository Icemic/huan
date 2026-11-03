/**
 * 设置与资源清单契约（G1.4a）。
 *
 * 纯 TS、JSON-safe：宿主返回设置文件原文、revision、校验问题与生效来源，
 * 以及当前实际加载的指令/system prompt/扩展/skill/模板/主题/packages 与诊断。
 *
 * 语义约定（迭代设计）：
 * - 查询目标 `threadId`、`workspacePath` 与 `global` 三选一，不接受任意配置文件路径；
 * - `global` 只查询/保存用户配置，不探测目录、不读取项目文件；
 * - 项目未信任时不返回其设置原文、不允许写项目设置；
 * - 设置原文可能损坏：GUI 保留原文用于修复，revision 用于多窗口乐观并发；
 * - 保存与应用分开：保存只返回磁盘合并预览与“需重载/重启”说明，
 *   当前会话不会被静默替换模型、Thinking 或资源。
 */

/** 设置作用域：用户（agentDir）或项目（<cwd>/.pi）。 */
export type HarnessSettingsScope = 'user' | 'project'

/** 设置查询目标：会话、空白页固定起始目录或用户全局三选一。 */
export type HarnessSettingsTargetInput = {
  /** 活/冷会话 ID：使用该会话固定的 cwd。 */
  threadId?: string
  /** 空白页的固定起始目录（绝对路径）。 */
  workspacePath?: string
  /** 只使用用户配置，不需要会话、目录或项目信任。 */
  global?: boolean
}

/** 解析后的查询目标（回显给 GUI，便于展示实际使用的目录）。 */
export type HarnessSettingsTarget = {
  kind: 'session' | 'workspace' | 'global'
  /** 全局目标使用空串，不伪造启动目录。 */
  workspacePath: string
  threadId?: string
}

/**
 * 原文问题分类。
 *
 * - `parse`：JSON 无法解析；
 * - `schema`：已知字段类型/取值不符合随包 settings schema；
 * - `unsafe-key`：包含原型污染键（`__proto__`/`constructor`/`prototype`）；
 * - `too-large`：超过读取上限，内容不完整，不能直接保存。
 */
export type HarnessSettingsIssueKind = 'parse' | 'schema' | 'unsafe-key' | 'too-large'

/** 一条原文问题（只含位置与受控文案，不回显配置值）。 */
export type HarnessSettingsIssue = {
  kind: HarnessSettingsIssueKind
  /** 出错位置（JSON Pointer 形式，根为 `/`）。 */
  path: string
  message: string
}

/** 一个设置文件的磁盘状态与原文。 */
export type HarnessSettingsFile = {
  scope: HarnessSettingsScope
  /** 绝对路径；项目作用域是 `<cwd>/.pi/settings.json`。 */
  path: string
  exists: boolean
  /**
   * 原文（不存在时为空串）。项目未信任时恒为空串，见 readable。
   * 原文可能损坏，GUI 必须保留供修复。
   */
  content: string
  /** 原文 UTF-8 字节数的 SHA-256（十六进制）；文件不存在为 null。 */
  revision: string | null
  /** 内容字节数（读取被上限截断时为文件实际大小）。 */
  bytes: number
  /** 是否允许读取原文（项目未信任时为 false）。 */
  readable: boolean
  /** 原文可读但超过上限：内容不完整，禁止直接保存。 */
  tooLarge: boolean
  /** 解析/校验问题；原文仍返回以便修复。 */
  issues: readonly HarnessSettingsIssue[]
  /** 读取失败（权限等）时的受控说明；成功/不存在时缺失。 */
  readError?: string
}

/** 合并设置中某个顶层键的来源。 */
export type HarnessSettingsOrigin = HarnessSettingsScope | 'default'

/** 一份合并后的设置视图（值 + 顶层来源）。 */
export type HarnessSettingsEffective = {
  /** disk：从磁盘文件现算；session：live 会话装配时加载的值。 */
  source: 'disk' | 'session'
  /** SDK 合并语义后的设置对象（保留未知字段）。 */
  values: Record<string, unknown>
  /** 每个顶层键在合并时来自哪个作用域；仅包含 values 中出现的键。 */
  origins: Record<string, HarnessSettingsOrigin>
}

/** 设置读取结果。 */
export type HarnessSettingsSnapshot = {
  target: HarnessSettingsTarget
  agentDir: string
  /** 项目作用域是否可读/可写（信任结论为 trusted）。 */
  projectTrusted: boolean
  trust: {
    decision: 'trusted' | 'untrusted' | 'needs-trust'
    /** 是否存在需要信任门控的项目资源。 */
    requiresTrust: boolean
    /** 信任结论来源（与项目契约一致）。 */
    origin: string
  }
  files: {
    user: HarnessSettingsFile
    project: HarnessSettingsFile
  }
  /** 磁盘合并预览（保存后实际写入文件的效果）。 */
  effective: HarnessSettingsEffective
  /** live 会话当前实际使用的合并值；冷目标缺失。 */
  live?: HarnessSettingsEffective
  /**
   * live 会话的已加载值与磁盘是否不同（只表示可能需要重载，
   * 不表示宿主会自动应用）。
   */
  reloadRequired?: boolean
}

/** 设置保存输入。 */
export type HarnessSettingsSaveInput = {
  target: HarnessSettingsTargetInput
  scope: HarnessSettingsScope
  /** 完整文件原文（整体替换该文件；未知字段由调用方保留在原文中）。 */
  content: string
  /**
   * 保存前读取的 revision（文件不存在时为 null）。
   * 不匹配表示其他窗口/进程已修改，拒绝本次保存。
   */
  expectedRevision: string | null
}

/** 保存后的应用状态说明（不虚报已生效）。 */
export type HarnessSettingsApplyState = {
  /** 写入并回读校验通过。 */
  persisted: boolean
  /** 常见运行设置/资源需要重载宿主后才会被会话使用。 */
  reloadRequired: boolean
  /** 需要重启宿主才能生效的顶层字段（如 sessionDir/代理）。 */
  restartRequiredKeys: readonly string[]
  /** 面向用户的受控说明。 */
  message: string
}

/** 保存结果。 */
export type HarnessSettingsSaveResult =
  | {
      status: 'saved'
      scope: HarnessSettingsScope
      path: string
      /** 写入后的新 revision。 */
      revision: string
      bytes: number
      /** 保存后的磁盘合并预览（不是 live 会话的已加载值）。 */
      snapshot: HarnessSettingsSnapshot
      apply: HarnessSettingsApplyState
    }
  | {
      status: 'conflict'
      scope: HarnessSettingsScope
      path: string
      /** 磁盘当前 revision（不存在为 null）。 */
      revision: string | null
      message: string
    }
  | {
      status: 'invalid'
      scope: HarnessSettingsScope
      path: string
      issues: readonly HarnessSettingsIssue[]
      message: string
    }
  | { status: 'untrusted'; scope: HarnessSettingsScope; path: string; message: string }
  | {
      status: 'too-large'
      scope: HarnessSettingsScope
      path: string
      limitBytes: number
      message: string
    }
  | { status: 'failed'; scope: HarnessSettingsScope; path: string; message: string }

/** 资源来源的安全投影（不包含扩展运行时代码或凭据）。 */
export type HarnessResourceSourceInfo = {
  /** 资源路径；内置资源可能不是真实文件路径。 */
  path: string
  /** 来源标识（包名、user、project 等）；不包含凭据。 */
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  baseDir?: string
}

/** 已加载的指令文件（AGENTS.md 等）。 */
export type HarnessResourceInstruction = {
  path: string
  bytes: number
  /** 仅在显式 includeText 查询时包含；截断时见 textTruncated。 */
  text?: string
  textTruncated?: boolean
}

/** 已加载的 system prompt（含追加片段）。 */
export type HarnessResourceSystemPrompt = {
  source?: string
  bytes: number
  text?: string
  textTruncated?: boolean
  append: readonly {
    source?: string
    bytes: number
    text?: string
    textTruncated?: boolean
  }[]
}

/** 已加载的扩展（不暴露处理器、运行时动作或错误堆栈）。 */
export type HarnessResourceExtension = {
  path: string
  hidden: boolean
  sourceInfo: HarnessResourceSourceInfo
  commands: readonly string[]
  tools: readonly string[]
}

/** 已加载的 skill。 */
export type HarnessResourceSkill = {
  name: string
  description: string
  path: string
  sourceInfo: HarnessResourceSourceInfo
  /** 仅可通过 /skill:name 显式调用。 */
  disableModelInvocation: boolean
}

/** 已加载的模板命令。 */
export type HarnessResourcePrompt = {
  name: string
  description: string
  argumentHint?: string
  path: string
  sourceInfo: HarnessResourceSourceInfo
}

/** 已加载的主题（终端主题，不是浏览器主题）。 */
export type HarnessResourceTheme = {
  name: string
  path?: string
  sourceInfo?: HarnessResourceSourceInfo
}

/** 设置中声明的 package 来源（不展开远程安装信息）。 */
export type HarnessResourcePackage = {
  source: string
  /** 对象形式的过滤声明；字符串形式为 undefined。 */
  autoload?: boolean
  extensions?: readonly string[]
  skills?: readonly string[]
  prompts?: readonly string[]
  themes?: readonly string[]
}

/** 一项已加载资源（用于统计实际来源）。 */
export type HarnessResourceLoadedRef = {
  kind: 'extension' | 'skill' | 'prompt' | 'theme'
  name: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  path: string
}

/** 资源清单查询输入。 */
export type HarnessResourceQueryInput = HarnessSettingsTargetInput & {
  /**
   * 显式请求指令与 system prompt 文本（页面打开文本区域时才传 true）。
   * 默认只返回路径与大小，避免把配置全文附到普通查询。
   */
  includeText?: boolean
}

/** 资源清单。 */
export type HarnessResourceSnapshot = {
  target: HarnessSettingsTarget
  agentDir: string
  /** 项目信任结论；未信任时项目资源不会被装配。 */
  trust: {
    decision: 'trusted' | 'untrusted' | 'needs-trust'
    requiresTrust: boolean
    origin: string
  }
  /** 清单来源：live 会话正在使用的 loader，或空白页的受信装配缓存。 */
  loadedFrom: 'session' | 'assembly'
  /** 项目资源是否实际加载（未信任/待决定时为 false）。 */
  projectResourcesLoaded: boolean
  /** 说明信任边界/缓存来源的受控文案。 */
  trustNote?: string
  instructions: readonly HarnessResourceInstruction[]
  systemPrompt?: HarnessResourceSystemPrompt
  extensions: readonly HarnessResourceExtension[]
  skills: readonly HarnessResourceSkill[]
  prompts: readonly HarnessResourcePrompt[]
  themes: readonly HarnessResourceTheme[]
  /** 设置中声明的 packages。 */
  packages: readonly HarnessResourcePackage[]
  /** 实际已加载资源（含来源），用于核对声明与生效情况。 */
  loaded: readonly HarnessResourceLoadedRef[]
  /** 资源/设置组件报告的诊断（受控文案，不含堆栈/凭据）。 */
  diagnostics: readonly string[]
}
