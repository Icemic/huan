/**
 * 多项目工作区的工具适配与项目指令注入。
 *
 * 工具部分不是复制 SDK 内置工具：每个覆盖项都委托给 Pi 1.4.0 公开导出的
 * `createXxxToolDefinition`，只负责把 `@别名/路径` 解析为绝对路径，并在
 * bash 显式 cwd 时替换传给 SDK 的上下文工作目录。这样文件读写、搜索、
 * 截断、渲染与文件写入串行化仍由 SDK 维护。
 *
 * 项目指令在 `before_agent_start` 按成员注入并标明路径适用范围；会话起始
 * 成员的文件已由 SDK 的项目上下文机制加载，因此跳过，避免同一份 AGENTS.md
 * 在同一系统提示中出现两次。没有采用上游的“首次触达后补指令”机制。
 *
 * 状态边界：扩展在每次运行开始时读取宿主已应用的快照并固定下来。运行中的
 * steer、follow-up、自动重试与工具调用都使用同一快照；下一次运行开始时再
 * 读取新 revision。getter 可随持久化提交而更新，只有运行开始时才采纳新值。
 *
 * 设计来源：选择性复用 pi-workspaces（MIT，commit
 * 3d97e7acfafd92e737907a5453c16013a9f9dc1f）的工具委托与 bash cwd 方案；
 * 来源与许可见 `packages/core/THIRD-PARTY-NOTICES.md`。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionToolContext,
  type InlineExtension,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { type TSchema, Type } from 'typebox'
import { colorShellContext } from './shell.js'
import {
  owningRoot,
  pathKey,
  resolveWorkspacePath,
  type WorkspaceSnapshot,
} from './workspace-path.js'

/** 扩展配置。快照读取是 getter：宿主在运行边界更新，扩展在运行开始时固定。 */
export type WorkspaceToolsOptions = {
  /** 返回宿主当前已应用的工作区快照；null 表示会话暂未归属工作区。 */
  getWorkspace: () => WorkspaceSnapshot | null
  /** 会话固定起始目录的初始值；`session_start` 会以 ctx.cwd 覆盖。 */
  sessionCwd?: string
  /** SDK 实际已装入系统提示的指令路径，避免推算与 noContextFiles/覆盖选项不符。 */
  getLoadedInstructionPaths?: () => readonly string[]
  /**
   * 运行边界实际应用的工作区快照。
   *
   * 宿主用它记录会话已生效的 revision，供页面区分「权威定义」与
   * 「本轮实际使用」。不写入 Pi 自定义条目，避免与 sidecar 形成第二权威。
   */
  onWorkspaceApplied?: (workspace: WorkspaceSnapshot | null) => void
}

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionToolContext,
) => Promise<AgentToolResult<unknown>>

type FileToolFactory = (cwd: string) => ToolDefinition

type FileToolSpec = {
  name: string
  factory: FileToolFactory
  /** grep/find/ls 的 path 可选；缺省时锚定会话起始目录。 */
  pathOptional: boolean
}

// SDK 各工具定义的参数/渲染泛型彼此不同；这里只保留委托所需的公共结构，
// 执行时再按实际定义调用。
function fileToolSpec(
  name: string,
  factory: (cwd: string) => unknown,
  pathOptional: boolean,
): FileToolSpec {
  return { name, factory: factory as unknown as FileToolFactory, pathOptional }
}

const FILE_TOOL_SPECS: FileToolSpec[] = [
  fileToolSpec('read', createReadToolDefinition, false),
  fileToolSpec('write', createWriteToolDefinition, false),
  fileToolSpec('edit', createEditToolDefinition, false),
  fileToolSpec('grep', createGrepToolDefinition, true),
  fileToolSpec('find', createFindToolDefinition, true),
  fileToolSpec('ls', createLsToolDefinition, true),
]

const WORKSPACE_PATH_NOTE =
  "\n\nWorkspace path syntax: prefix a path with '@alias/' to address a workspace project, " +
  "for example '@backend/src/app.ts'. '@alias' alone is the project root. Bare relative paths " +
  'always resolve against the fixed session start directory. Unknown aliases and .. escapes ' +
  'are reported as errors.'

const WORKSPACE_PATH_GUIDELINE =
  "Tool paths accept '@alias/...' to address a workspace project; bare relative paths always " +
  'resolve against the fixed session start directory.'

const BASH_CWD_DESCRIPTION =
  'Working directory to run the command in (optional, defaults to the session start directory): ' +
  "an absolute path, or '@alias/sub/dir' to run inside a workspace project. Unknown aliases " +
  'and .. escapes are reported as errors.'

const BASH_CWD_NOTE =
  "\n\nUse the optional 'cwd' parameter with '@alias/sub/dir' or an absolute path to run in " +
  'another workspace project; omit it to run in the session start directory.'

const BASH_CWD_GUIDELINE =
  "The bash tool accepts an optional 'cwd' ('@alias/sub/dir' or an absolute path); omit it to " +
  'run in the session start directory.'

/** 同一目录下 SDK 会优先读取的指令文件，顺序与 Pi 1.4.0 保持一致。 */
const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

type RuntimeState = {
  sessionCwd: string
  /** undefined 表示本轮尚未在 before_agent_start 固定；null 是合法的“无工作区”。 */
  runWorkspace: WorkspaceSnapshot | null | undefined
  getWorkspace: () => WorkspaceSnapshot | null
}

/**
 * 创建内嵌扩展。实例状态（起始目录、本轮快照）保存在工厂闭包里，每个会话
 * 独立创建，不跨会话共享。
 */
export function createWorkspaceToolsExtension(options: WorkspaceToolsOptions): InlineExtension {
  return {
    name: 'huan-workspace',
    hidden: true,
    factory: (pi) => registerWorkspaceTools(pi, options),
  }
}

function registerWorkspaceTools(pi: ExtensionAPI, options: WorkspaceToolsOptions): void {
  const state: RuntimeState = {
    sessionCwd: options.sessionCwd ?? '',
    runWorkspace: undefined,
    getWorkspace: options.getWorkspace,
  }
  // 注册期的内置定义只提供名称、参数、描述与渲染元数据；execute 永远走
  // 按实际会话目录重新创建的定义，绑定目录不在这里生效。
  const registrationCwd = state.sessionCwd

  for (const spec of FILE_TOOL_SPECS) {
    const base = spec.factory(registrationCwd)
    const {
      execute: _baseExecute,
      renderCall: _omitRenderCall,
      renderResult: _omitRenderResult,
      ...rest
    } = base
    pi.registerTool({
      ...rest,
      description: `${base.description}${WORKSPACE_PATH_NOTE}`,
      promptGuidelines: [...(base.promptGuidelines ?? []), WORKSPACE_PATH_GUIDELINE],
      execute: createFileExecute(spec, state) as typeof base.execute,
    })
  }

  registerBashTool(pi, state)

  pi.on('session_start', (_event, ctx) => {
    state.sessionCwd = ctx.cwd
    state.runWorkspace = captureWorkspace(state)
  })

  pi.on('before_agent_start', (event, ctx) => {
    if (state.sessionCwd === '') state.sessionCwd = ctx.cwd
    // 运行边界：本轮固定宿主已应用的 revision，之后本轮内不再读取 getter。
    state.runWorkspace = captureWorkspace(state)
    options.onWorkspaceApplied?.(state.runWorkspace)
    const section = buildWorkspacePromptSection(
      state.runWorkspace,
      state.sessionCwd,
      options.getLoadedInstructionPaths?.() ?? [],
    )
    if (section === null) return undefined
    return { systemPrompt: `${event.systemPrompt}\n\n${section}` }
  })
}

/** 运行开始时固化可访问性，之后同一轮内的路径判定保持稳定。 */
function captureWorkspace(state: RuntimeState): WorkspaceSnapshot | null {
  const workspace = state.getWorkspace()
  if (!workspace) return null
  return {
    ...workspace,
    roots: workspace.roots.map((root) => ({
      ...root,
      available: existsSync(root.path),
    })),
  }
}

function currentWorkspace(state: RuntimeState): WorkspaceSnapshot | null {
  return state.runWorkspace === undefined ? captureWorkspace(state) : state.runWorkspace
}

function requireSessionCwd(state: RuntimeState): string {
  if (state.sessionCwd === '') {
    throw new Error('Workspace tools are not initialized: the session start directory is unknown.')
  }
  return state.sessionCwd
}

/** 解析工具路径并统一转为绝对路径，确保裸相对路径不受调用上下文 cwd 影响。 */
function resolveToolPath(input: string, state: RuntimeState): string {
  const resolved = resolveWorkspacePath(input, currentWorkspace(state), requireSessionCwd(state))
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.absolutePath
}

function createFileExecute(spec: FileToolSpec, state: RuntimeState): ToolExecute {
  return async (toolCallId, rawParams, signal, onUpdate, ctx) => {
    const params = { ...rawParams }
    const input = params.path
    if (input === undefined && spec.pathOptional) {
      // 搜索/列目录的默认范围同样锚定会话 cwd，而不是依赖调用上下文的 cwd。
      params.path = requireSessionCwd(state)
    } else if (typeof input !== 'string') {
      throw new Error(`Tool '${spec.name}' requires a string 'path' parameter.`)
    } else {
      params.path = resolveToolPath(input, state)
    }
    const definition = spec.factory(requireSessionCwd(state))
    const execute = definition.execute as unknown as ToolExecute
    return execute(toolCallId, params, signal, onUpdate, ctx)
  }
}

function registerBashTool(pi: ExtensionAPI, state: RuntimeState): void {
  const base = createBashToolDefinition(state.sessionCwd)
  const {
    execute: _baseExecute,
    renderCall: _omitRenderCall,
    renderResult: _omitRenderResult,
    parameters: baseParameters,
    ...rest
  } = base
  const properties = (baseParameters as { properties: Record<string, TSchema> }).properties
  const parameters = Type.Object({
    ...properties,
    cwd: Type.Optional(Type.String({ description: BASH_CWD_DESCRIPTION })),
  })
  pi.registerTool({
    ...rest,
    description: `${base.description}${BASH_CWD_NOTE}`,
    promptGuidelines: [...(base.promptGuidelines ?? []), BASH_CWD_GUIDELINE],
    parameters,
    execute: createBashExecute(state) as unknown as ToolDefinition<typeof parameters>['execute'],
  } as unknown as ToolDefinition<typeof parameters>)
}

function createBashExecute(state: RuntimeState): ToolExecute {
  return async (toolCallId, rawParams, signal, onUpdate, ctx) => {
    const params = { ...rawParams }
    const input = params.cwd
    let target = requireSessionCwd(state)
    if (input !== undefined) {
      if (typeof input !== 'string')
        throw new Error("Tool 'bash' requires a string 'cwd' parameter.")
      target = resolveToolPath(input, state)
    }
    delete params.cwd
    const definition = createBashToolDefinition(requireSessionCwd(state), { spawnHook: colorShellContext })
    const execute = definition.execute as unknown as ToolExecute
    // 必须传 ctx 才能让 SDK 注入 PI_* 会话环境变量；上游在显式 cwd 分支丢弃
    // ctx，导致这些变量被删除。这里只替换 cwd，其余会话信息原样保留。
    return execute(toolCallId, params, signal, onUpdate, { ...ctx, cwd: target })
  }
}

/**
 * 构建追加到系统提示的工作区段。
 *
 * 纯展示逻辑之外只读取成员自己的指令文件：会话起始成员及 SDK 已沿 cwd 祖先
 * 加载的同一文件会跳过，避免重复；不把一个成员的规则当作其他成员的默认规则。
 */
export function buildWorkspacePromptSection(
  workspace: WorkspaceSnapshot | null,
  sessionCwd: string,
  loadedInstructionPaths: readonly string[] = [],
): string | null {
  if (!workspace || sessionCwd === '') return null
  const anchor = owningRoot(workspace, sessionCwd)
  const loadedBySdk = new Set(loadedInstructionPaths.map(pathKey))
  const lines: string[] = [
    `## Workspace '${workspace.name}'`,
    '',
    'Projects (tool path syntax: @alias/relative/path):',
  ]
  for (const root of workspace.roots) {
    const marks: string[] = []
    if (root.available === false) marks.push('MISSING')
    if (anchor === root) marks.push('session start project')
    lines.push(
      `- @${root.alias} -> ${root.path}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`,
    )
  }
  lines.push(
    '',
    'Path rules:',
    `- Bare relative paths resolve against the fixed session start directory (${sessionCwd}).`,
    "- '@alias/path' resolves inside that project; '@alias' alone is the project root. Unknown aliases and .. escapes are rejected.",
    '- Absolute paths work unchanged.',
    "- The bash tool accepts an optional 'cwd' parameter using the same path syntax.",
  )

  const instructionSections: string[] = []
  for (const root of workspace.roots) {
    if (root.available === false) continue
    const target = findInstructionFile(root.path)
    if (target === null) continue
    if (loadedBySdk.has(pathKey(target))) continue
    const contents = readInstructionFile(target)
    if (contents === null) continue
    instructionSections.push(
      `### Instructions for @${root.alias} (apply only to paths under ${root.path})`,
      `Source: ${target}`,
      contents.trimEnd(),
    )
  }
  if (instructionSections.length > 0) {
    lines.push('', ...instructionSections)
  }
  return lines.join('\n')
}

/** 返回目录内第一个存在的指令文件；顺序与 SDK 一致。 */
function findInstructionFile(dir: string): string | null {
  for (const fileName of INSTRUCTION_FILES) {
    const file = join(dir, fileName)
    try {
      if (statSync(file).isFile()) return file
    } catch {
      // 不存在或不可访问：继续尝试下一个候选。
    }
  }
  return null
}

function readInstructionFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
