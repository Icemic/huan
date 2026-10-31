/**
 * 工作区路径解析：纯函数、零 IO。
 *
 * 会话有一个固定起始目录（session cwd）；工作区成员（项目目录）通过
 * `@别名/相对路径` 访问。本模块只负责把工具调用里的路径翻译为绝对路径，
 * 并做词法包含检查，不读写文件、不持有工作区生命周期状态。
 *
 * 设计来源：选择性复用 pi-workspaces（MIT，commit
 * 3d97e7acfafd92e737907a5453c16013a9f9dc1f）的路径解析思路，按 huan 的
 * `@别名` 语义改写。来源与许可见 `packages/core/THIRD-PARTY-NOTICES.md`。
 */
import { isAbsolute, join, normalize, resolve } from 'node:path'

/** 工作区成员：别名只用于工具路径，path 由宿主校验后保存为绝对路径。 */
export type WorkspaceRoot = {
  alias: string
  path: string
  /**
   * 宿主在运行开始时探测的可用性；缺省视为可用。
   * 缺失路径保留成员记录，但工具调用明确失败，不静默切换到其他成员。
   */
  available?: boolean
}

/** 一次运行使用的工作区快照；revision 用于宿主判断成员变更是否已应用。 */
export type WorkspaceSnapshot = {
  workspaceId: string
  name: string
  revision: number
  roots: readonly WorkspaceRoot[]
}

/** 路径解析结果：失败时返回可直接呈现给模型的错误文本。 */
export type WorkspacePathResolution =
  | { ok: true; absolutePath: string; root: WorkspaceRoot | null }
  | { ok: false; error: string }

/**
 * 路径比较键：分隔符统一为 `/`，Windows 盘符小写，去掉多余的行尾分隔符。
 * 其余部分逐字比较（词法、区分大小写），与上游的包含判定口径一致。
 */
export function pathKey(path: string): string {
  let key = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(key)) key = key.charAt(0).toLowerCase() + key.slice(1)
  if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  return key
}

/** 词法包含：child 等于 parent 或位于其下。 */
export function isInside(parent: string, child: string): boolean {
  const parentKey = pathKey(parent)
  const childKey = pathKey(child)
  if (childKey === parentKey) return true
  const prefix = parentKey.endsWith('/') ? parentKey : `${parentKey}/`
  return childKey.startsWith(prefix)
}

/** 绝对路径所属的成员：嵌套成员时选择最长匹配路径。 */
export function owningRoot(
  workspace: Pick<WorkspaceSnapshot, 'roots'> | null,
  absolutePath: string,
): WorkspaceRoot | null {
  if (!workspace) return null
  let best: WorkspaceRoot | null = null
  let bestLength = -1
  for (const root of workspace.roots) {
    if (!isInside(root.path, absolutePath)) continue
    const length = pathKey(root.path).length
    if (length > bestLength) {
      best = root
      bestLength = length
    }
  }
  return best
}

// `@别名` 或 `@别名/剩余路径`；别名延伸到第一个路径分隔符，剩余部分可为空。
const ROOT_REF = /^@([^/\\]*)(?:[/\\]+([\s\S]*))?$/

/**
 * 解析工具调用路径。优先级与设计一致：
 * 1. 绝对路径原样规范化，并归因到所属成员；
 * 2. `@别名/...` 解析到成员目录，禁止 `..` 越出成员根；
 * 3. 裸相对路径锚定到固定会话 cwd，永不按工作区成员切换。
 */
export function resolveWorkspacePath(
  input: string,
  workspace: WorkspaceSnapshot | null,
  sessionCwd: string,
): WorkspacePathResolution {
  if (isAbsolute(input)) {
    const absolutePath = normalize(input)
    const root = owningRoot(workspace, absolutePath)
    if (root && root.available === false) return { ok: false, error: unavailableError(root) }
    return { ok: true, absolutePath, root }
  }

  if (input.startsWith('@')) {
    if (!workspace) {
      return {
        ok: false,
        error: `No workspace is active; cannot resolve '${input}'.`,
      }
    }
    const match = ROOT_REF.exec(input)
    const alias = match?.[1] ?? ''
    const rest = match?.[2] ?? ''
    const root = workspace.roots.find((candidate) => candidate.alias === alias)
    if (!root) {
      const aliases = workspace.roots.map((candidate) => `@${candidate.alias}`).join(', ')
      return {
        ok: false,
        error: `Unknown workspace project '@${alias}' in '${input}'. Available projects: ${aliases || '(none)'}.`,
      }
    }
    if (root.available === false) return { ok: false, error: unavailableError(root) }
    // 空剩余路径表示成员根目录本身；path.join 会折叠 "." 与 ".." 段。
    const absolutePath = rest === '' ? root.path : join(root.path, rest)
    if (!isInside(root.path, absolutePath)) {
      return {
        ok: false,
        error: `Path '${input}' escapes workspace project '@${root.alias}'; '@alias' paths must stay inside their project.`,
      }
    }
    return { ok: true, absolutePath, root }
  }

  if (sessionCwd === '') {
    return { ok: false, error: 'The session start directory is not initialized.' }
  }
  return { ok: true, absolutePath: resolve(sessionCwd, input), root: null }
}

function unavailableError(root: WorkspaceRoot): string {
  return `Workspace project '@${root.alias}' is unavailable (path missing on disk): ${root.path}`
}
