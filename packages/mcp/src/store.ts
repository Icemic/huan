/**
 * MCP 隔离配置存储（G1.4d1）。
 *
 * 存储对象固定 agentDir/cwd，只通过 user/project scope 访问固定文件，不接受来自
 * HTTP 的任意路径。读取必须显式确认项目信任；未信任时不触碰项目文件。
 *
 * 保存是「整份原文」语义：
 * - 新内容必须通过解析、形状、污染键、深度与服务器语义校验，避免写入已知错误；
 * - 磁盘上原有坏文件仍可读取并修复（校验只针对提交的新内容）；
 * - expectedRevision 强制提供，队列内重新读取后比较；
 * - 原子写入 + 回读；rename 前失败保留原文件，提交后无法确认时明确要求重读。
 *
 * 本阶段只改磁盘，不自动连接、不改变 live 状态，也不读写 Pi 的 mcp.json。
 */
import { resolve } from 'node:path'
import {
  configDocumentFromRead,
  type LoadedMcpConfig,
  loadMcpConfig,
  type McpConfigDocument,
  type McpConfigIssue,
  type McpConfigScope,
  mergeMcpConfigDocuments,
  parseMcpConfigContent,
} from './config.js'
import {
  assertMcpConfigPathSafe,
  MCP_CONFIG_FILE_MAX_BYTES,
  McpConfigPathError,
  McpConfigWriteError,
  mcpConfigContentIsEncodable,
  mcpConfigRevision,
  readMcpConfigText,
  withMcpConfigPathQueue,
  writeMcpConfigFileAtomic,
} from './file-io.js'
import { type McpConfigPaths, mcpConfigPaths } from './paths.js'

/** 单个配置文件的存储状态。 */
export interface McpConfigFileState {
  scope: McpConfigScope
  path: string
  /** 项目未信任时为 false，且不读盘、不返回存在性。 */
  readable: boolean
  exists: boolean
  content: string
  revision: string | null
  bytes: number
  tooLarge: boolean
  issues: McpConfigIssue[]
  readError?: string
}

/** 读取项目配置时必须显式说明信任结论；缺省按未信任处理。 */
export interface McpConfigReadOptions {
  projectTrusted?: boolean
}

/** 整份原文保存输入。 */
export interface McpConfigSaveInput {
  scope: McpConfigScope
  content: string
  /** 读取时得到的 revision；缺文件必须传 null。 */
  expectedRevision: string | null
  /** 保存项目配置时必须显式传 true。 */
  projectTrusted?: boolean
}

/** 保存结果。失败/冲突都如实报告，不静默覆盖。 */
export type McpConfigSaveResult =
  | {
      status: 'saved'
      scope: McpConfigScope
      path: string
      revision: string
      bytes: number
    }
  | {
      status: 'conflict'
      scope: McpConfigScope
      path: string
      revision: string | null
      message: string
    }
  | {
      status: 'invalid'
      scope: McpConfigScope
      path: string
      issues: McpConfigIssue[]
      message: string
    }
  | {
      status: 'too-large'
      scope: McpConfigScope
      path: string
      limitBytes: number
      message: string
    }
  | {
      status: 'untrusted'
      scope: McpConfigScope
      path: string
      message: string
    }
  | {
      status: 'failed'
      scope: McpConfigScope
      path: string
      message: string
    }

/** 创建存储的固定输入。 */
export interface McpConfigStoreOptions {
  agentDir: string
  cwd: string
}

/** MCP 配置存储；方法不接受任意文件路径。 */
export interface McpConfigStore {
  /** 固定路径的只读副本；修改副本不会改变内部写入目标。 */
  readonly paths: Readonly<McpConfigPaths>
  read(scope: McpConfigScope, options?: McpConfigReadOptions): Promise<McpConfigFileState>
  load(options: { projectTrusted: boolean }): Promise<LoadedMcpConfig>
  save(input: McpConfigSaveInput): Promise<McpConfigSaveResult>
}

function untrustedState(scope: McpConfigScope, path: string): McpConfigFileState {
  return {
    scope,
    path,
    readable: false,
    exists: false,
    content: '',
    revision: null,
    bytes: 0,
    tooLarge: false,
    issues: [],
  }
}

function readFailureState(
  scope: McpConfigScope,
  path: string,
  message: string,
): McpConfigFileState {
  return {
    scope,
    path,
    readable: true,
    exists: false,
    content: '',
    revision: null,
    bytes: 0,
    tooLarge: false,
    issues: [{ kind: 'read', scope, file: path, message }],
    readError: message,
  }
}

function invalidIssue(scope: McpConfigScope, path: string, message: string): McpConfigIssue {
  return { kind: 'shape', scope, file: path, message }
}

/**
 * 保存项目配置时，用磁盘上的用户配置补充跨文件诊断。
 *
 * 只做本文件无法判断的检查（override 是否有同名用户条目、跨文件 namespace 碰撞）。
 * 用户文件级损坏（解析/形状/污染/深度/读取失败）时不阻塞项目修复；此时只做本文件内校验。
 */
async function projectContextIssues(
  project: McpConfigDocument,
  configPaths: McpConfigPaths,
  agentDir: string,
): Promise<McpConfigIssue[]> {
  const userRead = await readMcpConfigText(configPaths.user, agentDir)
  if (userRead.readError || userRead.tooLarge) return []
  const user = configDocumentFromRead('user', configPaths.user, userRead)
  const blocking: ReadonlySet<string> = new Set([
    'parse',
    'shape',
    'unsafe-key',
    'too-deep',
    'read',
    'too-large',
  ])
  if (user.issues.some((issue) => blocking.has(issue.kind))) return []
  const merged = mergeMcpConfigDocuments(user, project)
  return merged.issues.filter((issue) => issue.file === project.path)
}

/**
 * 创建固定 agentDir/cwd 的 MCP 配置存储。
 *
 * 读取/保存项目 scope 必须显式 `projectTrusted: true`；否则不读盘。
 */
export function createMcpConfigStore(options: McpConfigStoreOptions): McpConfigStore {
  const agentDir = resolve(options.agentDir)
  const cwd = resolve(options.cwd)
  // 内部路径不对外暴露可变引用；写操作只使用这个封闭对象。
  const configPaths = mcpConfigPaths(agentDir, cwd)

  const read = async (
    scope: McpConfigScope,
    readOptions: McpConfigReadOptions = {},
  ): Promise<McpConfigFileState> => {
    if (scope !== 'user' && scope !== 'project') {
      throw new TypeError('MCP 配置 scope 必须是 user 或 project。')
    }
    const path = scope === 'user' ? configPaths.user : configPaths.project
    if (scope === 'project' && readOptions.projectTrusted !== true) {
      return untrustedState(scope, path)
    }
    const root = scope === 'user' ? agentDir : cwd
    try {
      const raw = await readMcpConfigText(path, root)
      const document = configDocumentFromRead(scope, path, raw)
      return {
        scope,
        path,
        readable: true,
        exists: raw.exists,
        content: raw.content,
        revision: raw.revision,
        bytes: raw.bytes,
        tooLarge: raw.tooLarge,
        issues: document.issues,
        ...(raw.readError === undefined ? {} : { readError: raw.readError }),
      }
    } catch {
      return readFailureState(scope, path, '无法读取 MCP 配置文件；请检查文件权限。')
    }
  }

  const save = async (input: McpConfigSaveInput): Promise<McpConfigSaveResult> => {
    const scope = input.scope
    if (scope !== 'user' && scope !== 'project') {
      throw new TypeError('MCP 配置 scope 必须是 user 或 project。')
    }
    const path = scope === 'user' ? configPaths.user : configPaths.project
    if (scope === 'project' && input.projectTrusted !== true) {
      return {
        status: 'untrusted',
        scope,
        path,
        message: '项目未取得信任：不读取也不写入项目 MCP 配置；用户配置仍可编辑。',
      }
    }
    if (typeof input.content !== 'string') {
      const message = 'MCP 配置内容必须是字符串。'
      return {
        status: 'invalid',
        scope,
        path,
        issues: [invalidIssue(scope, path, message)],
        message,
      }
    }
    if (input.expectedRevision !== null && typeof input.expectedRevision !== 'string') {
      const message = '保存 MCP 配置必须提供 expectedRevision（缺文件用 null）。'
      return {
        status: 'invalid',
        scope,
        path,
        issues: [invalidIssue(scope, path, message)],
        message,
      }
    }
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (bytes > MCP_CONFIG_FILE_MAX_BYTES) {
      return {
        status: 'too-large',
        scope,
        path,
        limitBytes: MCP_CONFIG_FILE_MAX_BYTES,
        message: `MCP 配置超过上限（${MCP_CONFIG_FILE_MAX_BYTES} 字节），未保存。`,
      }
    }
    if (!mcpConfigContentIsEncodable(input.content)) {
      const message = 'MCP 配置包含无法无损编码为 UTF-8 的字符，未保存。'
      return {
        status: 'invalid',
        scope,
        path,
        issues: [invalidIssue(scope, path, message)],
        message,
      }
    }

    const root = scope === 'user' ? agentDir : cwd
    try {
      return await withMcpConfigPathQueue(path, async (): Promise<McpConfigSaveResult> => {
        // 队列内部重新读取：并发保存以磁盘 revision 为准。
        const current = await readMcpConfigText(path, root)
        if (current.readError) {
          return { status: 'failed', scope, path, message: current.readError }
        }
        if (current.tooLarge) {
          return {
            status: 'too-large',
            scope,
            path,
            limitBytes: MCP_CONFIG_FILE_MAX_BYTES,
            message: '现有 MCP 配置文件超过读取上限；为避免覆盖未知内容，请先手动处理该文件。',
          }
        }
        if (current.revision !== input.expectedRevision) {
          return {
            status: 'conflict',
            scope,
            path,
            revision: current.revision,
            message: 'MCP 配置已被其他窗口或进程修改；请重新加载原文后再保存。',
          }
        }

        // 只校验提交的新内容；磁盘上原有坏文件仍可通过本次保存修复。
        const document = parseMcpConfigContent(input.content, { scope, path })
        if (document.issues.length > 0) {
          return {
            status: 'invalid',
            scope,
            path,
            issues: document.issues,
            message: 'MCP 配置未保存：请先修复解析或校验问题。',
          }
        }
        if (scope === 'project') {
          const contextIssues = await projectContextIssues(document, configPaths, agentDir)
          if (contextIssues.length > 0) {
            return {
              status: 'invalid',
              scope,
              path,
              issues: contextIssues,
              message: 'MCP 配置未保存：项目 override 或命名空间与用户配置冲突。',
            }
          }
        }

        try {
          // 写入前再检查一次现有组件/目标符号链接。
          await assertMcpConfigPathSafe(root, path)
          await writeMcpConfigFileAtomic(path, input.content, root)
        } catch (error) {
          return {
            status: 'failed',
            scope,
            path,
            message:
              error instanceof McpConfigPathError || error instanceof McpConfigWriteError
                ? error.message
                : 'MCP 配置保存未确认；请重新读取磁盘状态。',
          }
        }

        return {
          status: 'saved',
          scope,
          path,
          revision: mcpConfigRevision(input.content),
          bytes,
        }
      })
    } catch {
      return {
        status: 'failed',
        scope,
        path,
        message: 'MCP 配置保存未确认；请重新读取磁盘状态。',
      }
    }
  }

  return {
    paths: Object.freeze({ ...configPaths }),
    read,
    load: (loadOptions) =>
      loadMcpConfig({
        agentDir,
        cwd,
        projectTrusted: loadOptions.projectTrusted === true,
      }),
    save,
  }
}
