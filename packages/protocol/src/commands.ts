/**
 * 命令目录、参数补全与文件引用契约。
 *
 * 纯 TS、JSON-safe；内置命令的行为索引由 huan 自己维护，不深导入 Pi SDK
 * 的内置 slash 表。宿主返回的资源命令来自公开的 session/resourceLoader/
 * extensionRunner；应用再把内置索引与资源目录合并展示和路由。
 */

/** 内置命令在 huan 中的实施阶段。 */
export type HarnessBuiltinCommandStage = 'available' | 'g1.4' | 'g1.5' | 'hidden'

/** 应用维护的内置 slash 行为索引（名称是行为索引，不强制逐字保留输入）。 */
export type HarnessBuiltinCommand = {
  name: string
  description: string
  argumentHint?: string
  stage: HarnessBuiltinCommandStage
  /** 未实现时的等价入口或原因；已实现时通常省略。 */
  availability?: string
}

/**
 * Pi 1.4.0 TUI 内置命令索引（含未在文档列出的 /debug 与隐藏彩蛋）。
 *
 * 这里只维护“哪些输入属于内置命令”，具体 GUI 动作留在 apps 层。
 * 核心守卫据此拒绝绕过 GUI、把已知内置命令当普通 prompt 发给模型。
 */
export const HARNESS_BUILTIN_COMMANDS: readonly HarnessBuiltinCommand[] = [
  {
    name: 'model',
    description: '选择或在提供参数时切换模型',
    argumentHint: '<provider/model>',
    stage: 'available',
  },
  {
    name: 'thinking',
    description: '设置 Thinking 级别',
    argumentHint: '<level>',
    stage: 'available',
  },
  { name: 'scoped-models', description: '配置当前会话可用的模型范围', stage: 'available' },
  {
    name: 'compact',
    description: '压缩上下文，可附加摘要指令',
    argumentHint: '[instructions]',
    stage: 'available',
  },
  { name: 'new', description: '开始新会话', stage: 'available' },
  { name: 'resume', description: '切换到已有会话（左侧会话列表）', stage: 'available' },
  {
    name: 'name',
    description: '设置当前会话名称；省略参数时显示名称',
    argumentHint: '[name]',
    stage: 'available',
  },
  { name: 'session', description: '查看会话信息与统计', stage: 'available' },
  { name: 'tree', description: '打开会话树并切换分支', stage: 'available' },
  { name: 'fork', description: '从历史用户消息创建独立分支', stage: 'available' },
  { name: 'clone', description: '复制当前位置到独立会话', stage: 'available' },
  { name: 'import', description: '导入 JSONL 会话', argumentHint: '<path>', stage: 'available' },
  { name: 'trust', description: '管理当前项目的信任决定', stage: 'available' },
  { name: 'copy', description: '复制最后一条助手消息', stage: 'available' },
  {
    name: 'settings',
    description: '打开设置与资源清单',
    stage: 'available',
  },
  {
    name: 'mcp',
    description: '打开 MCP 管理面板',
    argumentHint: '[login|logout|reconnect] [server]',
    stage: 'available',
  },
  {
    name: 'login',
    description: '配置 provider 认证',
    argumentHint: '[provider]',
    stage: 'available',
  },
  {
    name: 'logout',
    description: '移除 provider 已存认证',
    argumentHint: '[provider]',
    stage: 'available',
  },
  {
    name: 'llama',
    description: '管理 llama.cpp 模型',
    stage: 'g1.4',
    availability: 'llama.cpp 管理在 G1.4 实施；当前可在 Pi 中管理后重启宿主。',
  },
  {
    name: 'reload',
    description: '重载设置、指令与资源（保持同一会话）',
    stage: 'available',
  },
  {
    name: 'export',
    description: '导出会话',
    argumentHint: '[path]',
    stage: 'g1.5',
    availability: '导出入口在 G1.5 实施；当前可复制单条回复。',
  },
  {
    name: 'share',
    description: '分享会话',
    stage: 'g1.5',
    availability: '分享入口在 G1.5 实施；不会上传会话内容。',
  },
  {
    name: 'bug',
    description: '准备问题报告',
    argumentHint: '[description]',
    stage: 'g1.5',
    availability: '问题报告在 G1.5 实施。',
  },
  {
    name: 'debug',
    description: '显示调试信息',
    stage: 'g1.5',
    availability: '调试面板在 G1.5 实施；当前可查看宿主诊断。',
  },
  {
    name: 'hotkeys',
    description: '显示快捷键',
    stage: 'g1.5',
    availability: '快捷键帮助在 G1.5 实施。',
  },
  {
    name: 'changelog',
    description: '显示 Pi 变更记录',
    stage: 'g1.5',
    availability: '变更记录在 G1.5 实施。',
  },
  {
    name: 'quit',
    description: '退出 Pi / 宿主',
    stage: 'g1.5',
    availability: '宿主结束操作在 G1.5 实施；当前请关闭宿主进程。',
  },
  {
    name: 'arminsayshi',
    description: 'Pi 内置彩蛋',
    stage: 'hidden',
    availability: '该命令无 GUI 入口。',
  },
  {
    name: 'dementedelves',
    description: 'Pi 内置彩蛋',
    stage: 'hidden',
    availability: '该命令无 GUI 入口。',
  },
]

const BUILTIN_NAMES = new Set(HARNESS_BUILTIN_COMMANDS.map((command) => command.name))

/** 解析输入首部的 slash 命令；非 slash 或空名称返回 undefined。 */
export function parseLeadingSlashCommand(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return undefined
  const name = match[1]
  if (!name) return undefined
  return { name, args: (match[2] ?? '').trim() }
}

/** 已知内置命令名（用于宿主提交守卫）；未知名（扩展/模板/skill）返回 undefined。 */
export function builtinCommandNameOf(text: string): string | undefined {
  const parsed = parseLeadingSlashCommand(text)
  return parsed && BUILTIN_NAMES.has(parsed.name) ? parsed.name : undefined
}

/** 是否为已知内置 slash 命令（不判断参数是否有效）。 */
export function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

/** 资源命令来源。 */
export type HarnessCommandSource = 'extension' | 'prompt' | 'skill'

/** 资源来源的安全投影（不包含扩展运行时代码或凭据）。 */
export type HarnessCommandSourceInfo = {
  path: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  baseDir?: string
}

/** 宿主返回的一条资源命令。 */
export type HarnessResourceCommand = {
  name: string
  description?: string
  /** 资源声明的参数提示（模板有；扩展在 Pi 1.4 未提供该字段）。 */
  argumentHint?: string
  source: HarnessCommandSource
  sourceInfo: HarnessCommandSourceInfo
  /** 是否支持参数补全（扩展声明 getArgumentCompletions，模板/skill 可带参）。 */
  supportsArguments: boolean
  /** 同名时被更高优先级来源遮蔽（扩展优先于模板/skill）；不表示内置冲突。 */
  shadowedBy?: HarnessCommandSource
}

/** 命令目录；内置命令由应用另行合并。 */
export type HarnessCommandCatalog = {
  commands: readonly HarnessResourceCommand[]
  /** Pi 设置中的 skill 命令开关；关闭时目录不包含 skill 命令。 */
  skillCommandsEnabled: boolean
  /** 资源加载/冲突诊断（安全文案，不含原始堆栈）。 */
  diagnostics: readonly string[]
}

/** 扩展参数补全查询输入。 */
export type HarnessCommandArgumentInput = {
  /** 活会话；与 workspacePath 二选一。 */
  threadId?: string
  /** 空白页的固定起始目录。 */
  workspacePath?: string
  /** 命令名（扩展 invocationName 或 skill:/模板名）。 */
  name: string
  /** 当前参数前缀。 */
  prefix: string
}

/** 一条参数补全项（对照 Pi AutocompleteItem）。 */
export type HarnessCommandArgumentCompletion = {
  value: string
  label: string
  description?: string
}

/** 文件引用查询输入。 */
export type HarnessFileSearchInput = {
  /** 活/冷会话；用于解析归属工作区与固定 cwd。 */
  threadId?: string
  /** 选中工作区；空白页优先使用它解析全部成员。 */
  workspaceId?: string
  /** 空白页固定起始目录；无工作区时作为唯一搜索根。 */
  workspacePath?: string
  query?: string
  limit?: number
}

/** 文件引用条目（只含路径/类型，不预读文件内容）。 */
export type HarnessFileReference = {
  /** 宿主绝对路径（用于展示，不用于自动读取内容）。 */
  path: string
  /** 插入输入框的文本：有工作区时为 @alias/路径，否则为相对 cwd 路径。 */
  reference: string
  /** 相对所属项目根的路径（统一使用 / 分隔）。 */
  relativePath: string
  kind: 'file' | 'directory'
  /** 所属项目别名（无工作区时缺失）。 */
  alias?: string
  /** 所属工作区显示名。 */
  workspaceName?: string
}

/** 文件引用查询结果；truncated 表示达到扫描或结果上限。 */
export type HarnessFileSearchResult = {
  files: readonly HarnessFileReference[]
  truncated: boolean
}
