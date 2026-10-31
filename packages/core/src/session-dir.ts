/**
 * 用户空间（agentDir）与会话目录（sessionDir）解析。
 *
 * 规则来源：`docs/iteration/2026-10/2026-10-31-feat-user-space-reliability.md` §3。
 * 目标是把「配置目录」与「会话存储作用域」在宿主创建时一次性固定为绝对路径，
 * 后续创建、枚举、跨 cwd 查找、打开、改名、删除都使用同一份解析结果，避免
 * 各模块各自展开 `~`／相对路径，或经进程环境变量隐式切换目录。
 *
 * 会话目录优先级（与 Pi CLI 的 `--session-dir` 一致）：
 * 1. 宿主显式 `sessionDir`；
 * 2. `PI_CODING_AGENT_SESSION_DIR`；
 * 3. 启动工作区合并后的 `sessionDir` setting（项目 setting 优先于用户 setting）；
 * 4. 默认 `<agentDir>/sessions/<Pi 编码 cwd>/`。
 *
 * 相对路径基准：显式值与环境变量按宿主启动进程 cwd 解析；setting 按宿主启动
 * 工作区解析（Pi CLI 以工作区为进程 cwd，两者一致）。
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent'

/** Pi 的会话目录环境变量（包根未导出该常量，按文档名称固定）。 */
export const ENV_SESSION_DIR = 'PI_CODING_AGENT_SESSION_DIR'

/** 会话目录的来源（供诊断与测试断言；本阶段不对外暴露状态接口）。 */
export type SessionDirSource = 'option' | 'env' | 'settings' | 'default'

/** 解析后的会话目录。 */
export type ResolvedSessionDir = {
  /** 绝对路径；显式/环境变量/setting 为平铺目录，默认值为按 cwd 编码的分组目录。 */
  dir: string
  source: SessionDirSource
  /** 是否为默认分组目录（按 cwd 编码，非平铺）。 */
  grouped: boolean
}

/**
 * 展开 `~` 并把路径解析为绝对路径。
 *
 * `~` 只识别 `~`、`~/`、`~\` 三种前缀（与 Pi 的 `normalizePath` 同口径），
 * 其它形态按普通相对路径处理。
 */
export function toAbsolutePath(value: string, baseDir: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return resolve(homedir())
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(join(homedir(), trimmed.slice(2)))
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed)
}

/**
 * 解析用户空间目录并在宿主创建时固定为绝对路径。
 *
 * 显式空值（`undefined`/空串/纯空白）回退到 Pi 的 `getAgentDir()`，因此
 * `PI_CODING_AGENT_DIR` 仍按 Pi 原生规则生效；两者都按宿主启动进程 cwd
 * 解析相对路径。
 */
export function resolveAgentDir(explicit?: string): string {
  const value = explicit?.trim()
  return toAbsolutePath(value ? value : getAgentDir(), process.cwd())
}

/**
 * 把 Windows 下的 Git Bash / MSYS / Cygwin 盘符路径转成本地形式（与 Pi 同口径）。
 * 仅用于默认分组目录名兼容；不影响宿主其它路径解析。
 */
function normalizeWindowsShellPath(value: string): string {
  if (process.platform !== 'win32') return value
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return value
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value)
  if (!match) return value
  const drive = (match[1] ?? '').toUpperCase()
  const rest = (match[2] ?? '').replaceAll('/', '\\')
  return `${drive}:\\${rest}`
}

/**
 * Pi 默认会话分组目录名。
 *
 * 兼容逻辑来源：`@earendil-works/pi-coding-agent@1.1.0`
 * `dist/core/session-manager.js` 的 `getDefaultSessionDirPath()`：
 * 解析 cwd → 去掉开头一个路径分隔符 → 把 `/`、`\`、`:` 换成 `-` → 两侧加 `--`。
 * 目录名只用于兼容存储，**不能反向推导 cwd**（cwd 以 session header 为准）。
 *
 * 该辅助函数未从包根导出；这里保留唯一实现，生产代码不深导入 SDK 子路径。
 * 若升级后发现公开替代接口，优先改用公开接口并删除本函数。
 */
export function encodeCwdForSessionDir(cwd: string): string {
  const resolvedCwd = resolve(toAbsolutePath(normalizeWindowsShellPath(cwd), process.cwd()))
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return safePath
}

/** 默认会话分组目录（`<agentDir>/sessions/<编码 cwd>`）。 */
export function defaultSessionDir(agentDir: string, cwd: string): string {
  return join(agentDir, 'sessions', encodeCwdForSessionDir(cwd))
}

/** 默认空间根目录（其直接子目录是按 cwd 编码的分组目录）。 */
export function defaultSessionsRoot(agentDir: string): string {
  return join(agentDir, 'sessions')
}

/**
 * 按优先级解析某个 cwd 的会话目录。
 *
 * 无覆盖时每个目标 cwd 使用自己的默认分组；有覆盖时所有 cwd 共享同一平铺目录。
 */
export function resolveSessionDir(input: {
  agentDir: string
  cwd: string
  /** 宿主显式 sessionDir。 */
  option?: string | undefined
  /** `PI_CODING_AGENT_SESSION_DIR` 的当前值。 */
  env?: string | undefined
  /** 启动工作区合并后的 `sessionDir` setting。 */
  setting?: string | undefined
  /** 显式值/环境变量相对路径的基准（宿主启动进程 cwd）。 */
  launchDir?: string | undefined
  /** setting 相对路径的基准（宿主启动工作区）。 */
  workspacePath: string
}): ResolvedSessionDir {
  const launchDir = input.launchDir ?? process.cwd()
  const option = input.option?.trim()
  if (option) return { dir: toAbsolutePath(option, launchDir), source: 'option', grouped: false }

  const env = input.env?.trim()
  if (env) return { dir: toAbsolutePath(env, launchDir), source: 'env', grouped: false }

  const setting = input.setting?.trim()
  if (setting) {
    return { dir: toAbsolutePath(setting, input.workspacePath), source: 'settings', grouped: false }
  }

  return { dir: defaultSessionDir(input.agentDir, input.cwd), source: 'default', grouped: true }
}

/**
 * 读取启动工作区合并后的 `sessionDir` setting。
 *
 * `SettingsManager.create(cwd, agentDir)` 默认加载项目 setting（与 CLI 在信任
 * 确认前用它发现会话目录的行为一致）；合并结果中项目 setting 优先于用户
 * setting。这里只读取这一个必要字段，不代表授权项目扩展。
 */
export function readSessionDirSetting(workspacePath: string, agentDir: string): string | undefined {
  return SettingsManager.create(workspacePath, agentDir).getSessionDir()
}

/** 按 cwd 解析会话目录的解析器（结果按 cwd 缓存，O(1) 命中）。 */
export type SessionDirResolver = (cwd: string) => ResolvedSessionDir

/** 创建启动时固定的会话目录解析器（覆盖值与环境变量只读一次）。 */
export function createSessionDirResolver(input: {
  agentDir: string
  /** 宿主启动工作区（setting 相对路径基准）。 */
  workspacePath: string
  option?: string | undefined
  env?: string | undefined
  setting?: string | undefined
  launchDir?: string | undefined
}): SessionDirResolver {
  const cache = new Map<string, ResolvedSessionDir>()
  return (cwd: string): ResolvedSessionDir => {
    const cached = cache.get(cwd)
    if (cached) return cached
    const resolved = resolveSessionDir({
      agentDir: input.agentDir,
      cwd,
      option: input.option,
      env: input.env,
      setting: input.setting,
      launchDir: input.launchDir,
      workspacePath: input.workspacePath,
    })
    cache.set(cwd, resolved)
    return resolved
  }
}

/**
 * 路径比较用的规范形态：存在则跟随符号链接取真实路径，否则按绝对路径解析。
 * Windows 上大小写不敏感，统一转小写再比较。
 */
function canonicalForCompare(path: string): string {
  const absolute = resolve(path)
  let canonical: string
  try {
    canonical = realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // 文件可能尚未创建，仍需沿父目录解析链接，避免创建时经 junction 写入另一空间。
    const parent = dirname(absolute)
    canonical =
      parent === absolute ? absolute : join(canonicalForCompare(parent), relative(parent, absolute))
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * 判断文件是否位于指定作用域目录内（含 Windows 盘符、大小写与符号链接）。
 *
 * 指向作用域外的符号链接按真实路径判定为「界外」，因此默认空间根下的符号
 * 链接不会成为另一个空间的隐式入口。文件本身必须是作用域目录的直接或
 * 间接后代（作用域目录自身不算命中）。
 */
export function isPathWithinScope(scopeDir: string, filePath: string): boolean {
  const rel = relative(canonicalForCompare(scopeDir), canonicalForCompare(filePath))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
