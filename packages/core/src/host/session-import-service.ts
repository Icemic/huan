/**
 * JSONL 导入服务：唯一持有导入串行队列。
 *
 * 预览只读文件/sidecar；确认重新读取、校验源与冲突、经项目信任入口后独占写入，
 * 最后保存归属。文件写入成功而归属失败保留为可发现的未归属会话。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  HarnessThreadImportErrorCode,
  HarnessThreadImportInput,
  HarnessThreadImportPreview,
  HarnessThreadImportPreviewInput,
  HarnessThreadImportResult,
  HarnessThreadImportSource,
  HarnessThreadImportSourceInfo,
} from '@huan/protocol'
import type { SessionCatalogInfo } from '../metadata.js'
import {
  buildImportText,
  importFileName,
  importMatchesExisting,
  type ParsedImportSession,
  parseSessionJsonl,
  planImportWrite,
  readImportSource,
} from '../session-import.js'
import { pathKey } from '../workspace-path.js'
import type { WorkspaceStore, WorkspaceStoreWorkspace } from '../workspace-store.js'
import type { ProjectAssembly } from './project-assembly.js'
import { canonicalProjectPath, isAvailableDirectory } from './project-assembly.js'
import type { SessionCatalog } from './session-catalog.js'
import { ProjectTrustRequiredError } from './shared.js'

export type SessionImportServiceDeps = {
  workspaceStore: WorkspaceStore
  storeId: string
  workspacePath: string
  startupWorkspaceId: () => string | undefined
  assembly: ProjectAssembly
  catalog: SessionCatalog
  assertActive: () => void
  isDisposed: () => boolean
  diagnose: (message: string) => void
}

type ImportCwdResolution =
  | {
      ok: true
      cwd: string
      overrideUsed: boolean
      sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
    }
  | {
      ok: false
      error: 'cwd-required' | 'cwd-unavailable' | 'cwd-not-member'
      message: string
      sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
    }

type ImportAnalysis =
  | {
      ok: true
      parsed: ParsedImportSession
      sourcePath?: string
      workspaceId: string
      cwd: string
      sessionDir: string
      sourceInfo: HarnessThreadImportSourceInfo
      sourceCwd?: { path: string; available: boolean; workspaceMember: boolean }
      warnings: string[]
      existing?: { id: string; path: string }
      conflict: 'none' | 'already-exists' | 'conflict'
    }
  | { ok: false; preview: HarnessThreadImportPreview }

export class SessionImportService {
  /** 导入确认在宿主内串行提交，避免同 ID 的并发请求各写一份。 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: SessionImportServiceDeps) {}

  private withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private workspaceMember(workspace: WorkspaceStoreWorkspace, path: string): boolean {
    return workspace.projects.some((project) => pathKey(project.path) === pathKey(path))
  }

  /** 预览/确认共用的源摘要。 */
  private sourceInfoOf(
    source: HarnessThreadImportSource,
    parsed: ParsedImportSession,
  ): HarnessThreadImportSourceInfo {
    return {
      kind: source.kind,
      id: parsed.header.id,
      cwd: parsed.header.cwd,
      ...(parsed.name ? { name: parsed.name } : {}),
      entries: parsed.entries.length,
      version: parsed.sourceVersion,
      size: parsed.size,
      fingerprint: parsed.fingerprint,
    }
  }

  /** 起始目录解析：源 cwd 可用且为成员时默认使用，否则要求显式替代成员。 */
  private resolveCwd(
    workspace: WorkspaceStoreWorkspace,
    sourceCwdRaw: string,
    cwdOverride: string | undefined,
  ): ImportCwdResolution {
    const sourceCwdPath = sourceCwdRaw.trim()
    // 源 cwd 必须是绝对路径；相对路径会按宿主进程目录隐式解析，不能作为
    // 用户选择的目标。缺失/非法时要求显式选择工作区成员作为替代目录。
    const sourceCwd =
      sourceCwdPath && isAbsolute(sourceCwdPath) ? canonicalProjectPath(sourceCwdPath) : undefined
    const sourceCwdInfo = sourceCwd
      ? {
          path: sourceCwd,
          available: isAvailableDirectory(sourceCwd),
          workspaceMember: this.workspaceMember(workspace, sourceCwd),
        }
      : undefined

    const override = cwdOverride?.trim()
    if (override) {
      const cwd = canonicalProjectPath(override)
      if (!this.workspaceMember(workspace, cwd)) {
        return {
          ok: false,
          error: 'cwd-not-member',
          message: '替代起始目录必须是目标工作区的成员',
          ...(sourceCwdInfo ? { sourceCwd: sourceCwdInfo } : {}),
        }
      }
      if (!isAvailableDirectory(cwd)) {
        return {
          ok: false,
          error: 'cwd-unavailable',
          message: '替代起始目录不存在或不可用',
          ...(sourceCwdInfo ? { sourceCwd: sourceCwdInfo } : {}),
        }
      }
      return {
        ok: true,
        cwd,
        overrideUsed: true,
        ...(sourceCwdInfo ? { sourceCwd: sourceCwdInfo } : {}),
      }
    }

    if (!sourceCwdInfo) {
      return {
        ok: false,
        error: 'cwd-required',
        message: '源会话没有起始目录，请选择目标工作区成员作为替代目录',
      }
    }
    if (!sourceCwdInfo.workspaceMember) {
      return {
        ok: false,
        error: 'cwd-not-member',
        message: '源起始目录不在目标工作区内，请选择成员作为替代目录',
        sourceCwd: sourceCwdInfo,
      }
    }
    if (!sourceCwdInfo.available) {
      return {
        ok: false,
        error: 'cwd-unavailable',
        message: '源起始目录不存在，请选择成员作为替代目录',
        sourceCwd: sourceCwdInfo,
      }
    }
    return { ok: true, cwd: sourceCwdInfo.path, overrideUsed: false, sourceCwd: sourceCwdInfo }
  }

  private failure(
    error: HarnessThreadImportErrorCode,
    message: string,
    extra: Partial<HarnessThreadImportPreview> = {},
  ): ImportAnalysis {
    return { ok: false, preview: { status: 'invalid', error, message, ...extra } }
  }

  /**
   * 读取源、严格解析、解析 cwd、检查目标作用域与同 ID 冲突。
   *
   * 只读文件与 sidecar，不装配项目、不执行项目代码；确认路径会再次调用本函数。
   */
  private async analyze(input: HarnessThreadImportPreviewInput): Promise<ImportAnalysis> {
    const workspaceId = input.workspaceId ?? this.deps.startupWorkspaceId()
    if (!workspaceId) {
      return this.failure('invalid-input', '没有可用工作区，不能导入会话')
    }
    const workspace = this.deps.workspaceStore.workspace(workspaceId)
    if (!workspace) return this.failure('invalid-input', '目标工作区不存在')

    const read = await readImportSource(input.source)
    if ('error' in read) {
      return this.failure(read.error, read.message, {
        workspaceId,
        source: { kind: input.source.kind },
      })
    }
    const parsed = parseSessionJsonl(read.text)
    if ('error' in parsed) {
      return this.failure(parsed.error, parsed.message, {
        workspaceId,
        source: { kind: input.source.kind },
      })
    }
    const sourceInfo = this.sourceInfoOf(input.source, parsed)

    const cwdResolution = this.resolveCwd(workspace, parsed.header.cwd, input.cwdOverride)
    if (!cwdResolution.ok) {
      return this.failure(cwdResolution.error, cwdResolution.message, {
        workspaceId,
        source: sourceInfo,
        ...(cwdResolution.sourceCwd ? { sourceCwd: cwdResolution.sourceCwd } : {}),
      })
    }
    const cwd = cwdResolution.cwd
    const sessionDir = this.deps.catalog.scopeOf(cwd).dir
    try {
      // 目标目录不得越过存储作用域（含符号链接/父目录链接）。
      this.deps.catalog.assertSessionFileInScope(join(sessionDir, '.huan-scope-check'), cwd)
    } catch (error) {
      return this.failure('scope-invalid', errorText(error), {
        workspaceId,
        source: sourceInfo,
        cwd,
        sessionDir,
        ...(cwdResolution.sourceCwd ? { sourceCwd: cwdResolution.sourceCwd } : {}),
      })
    }

    // 冲突检查必须重新扫描整个目标作用域，不能信任目录缓存。
    let infos: SessionCatalogInfo[]
    try {
      infos = await this.deps.catalog.scanScopeInfos(this.deps.catalog.scopeOf(cwd))
    } catch (error) {
      return this.failure('scope-invalid', `无法读取目标存储目录：${errorText(error)}`, {
        workspaceId,
        source: sourceInfo,
        cwd,
        sessionDir,
      })
    }
    const existing = this.deps.catalog.pickSessionInfo(infos, parsed.header.id)
    let conflict: 'none' | 'already-exists' | 'conflict' = 'none'
    if (existing) {
      const plan = planImportWrite(parsed, {
        cwd,
        ...(read.sourcePath ? { sourcePath: read.sourcePath } : {}),
        asCopy: false,
      })
      const sameFile = read.sourcePath
        ? pathKey(canonicalProjectPath(read.sourcePath)) ===
          pathKey(canonicalProjectPath(existing.path))
        : false
      if (sameFile) conflict = 'already-exists'
      else {
        const existingText = await readFile(existing.path, 'utf8').catch(() => undefined)
        conflict =
          existingText !== undefined && importMatchesExisting(existingText, parsed, plan)
            ? 'already-exists'
            : 'conflict'
      }
    }

    const warnings: string[] = [
      '导入会把文件内容复制到本机会话目录；请确认其中没有不希望持久化的敏感信息。',
    ]
    if (parsed.migrated) {
      warnings.push(
        `源会话是旧版 v${parsed.sourceVersion}，导入时会迁移到 v${parsed.header.version}。`,
      )
    }
    if (cwdResolution.overrideUsed) {
      warnings.push('源起始目录不可用或不属于目标工作区，将使用所选成员作为替代起始目录。')
    }
    if (conflict === 'conflict') {
      warnings.push(
        '目标存储已有同 ID 但内容不同的会话；作为副本导入会生成新会话 ID 并保留完整树。',
      )
    }

    return {
      ok: true,
      parsed,
      ...(read.sourcePath ? { sourcePath: read.sourcePath } : {}),
      workspaceId,
      cwd,
      sessionDir,
      sourceInfo,
      ...(cwdResolution.sourceCwd ? { sourceCwd: cwdResolution.sourceCwd } : {}),
      warnings,
      ...(existing ? { existing: { id: existing.id, path: existing.path } } : {}),
      conflict,
    }
  }

  private previewOf(analysis: ImportAnalysis): HarnessThreadImportPreview {
    if (!analysis.ok) return analysis.preview
    return {
      status: 'ok',
      source: analysis.sourceInfo,
      workspaceId: analysis.workspaceId,
      cwd: analysis.cwd,
      ...(analysis.sourceCwd ? { sourceCwd: analysis.sourceCwd } : {}),
      sessionDir: analysis.sessionDir,
      conflict: analysis.conflict,
      ...(analysis.existing ? { existingThreadId: analysis.existing.id } : {}),
      ...(analysis.conflict === 'conflict' ? { canCopy: true } : {}),
      warnings: analysis.warnings,
    }
  }

  async preview(input: HarnessThreadImportPreviewInput): Promise<HarnessThreadImportPreview> {
    this.deps.assertActive()
    if (!this.deps.workspaceStore.healthy) {
      return {
        status: 'failed',
        error: 'state-unavailable',
        message: '工作区元数据不可用，无法检查导入目标；请修复 state.json 后重启宿主',
      }
    }
    try {
      return this.previewOf(await this.analyze(input))
    } catch (error) {
      return { status: 'failed', error: 'invalid-input', message: errorText(error) }
    }
  }

  /**
   * 确认导入：重新读取/校验源与冲突，再走项目信任入口，最后独占写入。
   *
   * 预览不是授权 token；期间的源变化、目录变化与同 ID 占用都会在此被拒绝。
   */
  async import(input: HarnessThreadImportInput): Promise<HarnessThreadImportResult> {
    this.deps.assertActive()
    if (!this.deps.workspaceStore.healthy) {
      throw new WorkspaceStateUnavailableError(
        this.deps.workspaceStore.integrity === 'ok'
          ? 'unreadable'
          : this.deps.workspaceStore.integrity,
        this.deps.workspaceStore.stateFile,
      )
    }
    return this.withLock(async () => {
      const analysis = await this.analyze({
        source: input.source,
        workspaceId: input.workspaceId,
        ...(input.cwdOverride !== undefined ? { cwdOverride: input.cwdOverride } : {}),
      })
      const preview = this.previewOf(analysis)
      if (!analysis.ok) {
        return {
          status: 'invalid',
          preview,
          ...(preview.error ? { error: preview.error } : {}),
          ...(preview.message ? { message: preview.message } : {}),
        }
      }
      if (
        (input.expectedSourceId && analysis.sourceInfo.id !== input.expectedSourceId) ||
        (input.expectedSourceFingerprint &&
          analysis.parsed.fingerprint !== input.expectedSourceFingerprint)
      ) {
        return {
          status: 'invalid',
          preview,
          error: 'source-changed',
          message: '源会话内容或 ID 已变化，请重新预览后再导入',
        }
      }
      if (analysis.conflict === 'already-exists') {
        return {
          status: 'already-exists',
          ...(analysis.existing ? { existingThreadId: analysis.existing.id } : {}),
          preview,
          message: '目标存储中已有内容完全相同的会话',
        }
      }
      if (analysis.conflict === 'conflict' && input.asCopy !== true) {
        return {
          status: 'conflict',
          preview,
          message: '同一会话 ID 的内容不同；如确需导入，请选择“作为独立副本导入”',
        }
      }

      // 信任入口：与新建/激活会话一致；needs-trust 抛可识别错误，GUI 决定后重试。
      const projectInfo = await this.deps.assembly.query(analysis.cwd, this.deps.isDisposed())
      if (projectInfo.status === 'needs-trust') {
        throw new ProjectTrustRequiredError(projectInfo)
      }
      if (projectInfo.status === 'failed') {
        return {
          status: 'failed',
          preview,
          error: 'scope-invalid',
          message: '目标项目装配失败，请检查路径与宿主诊断',
        }
      }

      this.deps.assertActive()
      // 项目装配可能异步等待；提交前复查工作区成员，避免已移除目录仍被导入。
      const currentWorkspace = this.deps.workspaceStore.workspace(analysis.workspaceId)
      if (!currentWorkspace || !this.workspaceMember(currentWorkspace, analysis.cwd)) {
        return {
          status: 'invalid',
          error: 'cwd-not-member',
          message: '目标工作区成员已变化，请重新预览',
        }
      }
      // 是否生成新 ID：冲突副本或用户显式要求副本；已完全相同的情况已在上面返回。
      const asCopy = analysis.existing !== undefined || input.asCopy === true
      const plan = planImportWrite(analysis.parsed, {
        cwd: analysis.cwd,
        ...(analysis.sourcePath ? { sourcePath: analysis.sourcePath } : {}),
        asCopy,
      })
      const targetPath = join(analysis.sessionDir, importFileName(analysis.parsed, plan.id))
      try {
        this.deps.catalog.assertSessionFileInScope(targetPath, analysis.cwd)
      } catch (error) {
        return { status: 'failed', preview, error: 'scope-invalid', message: errorText(error) }
      }

      try {
        await mkdir(analysis.sessionDir, { recursive: true })
        // 独占写入：绝不覆盖既有文件；内部并发已由导入队列串行化。
        await writeFile(targetPath, buildImportText(analysis.parsed, plan), { flag: 'wx' })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return {
          status: code === 'EEXIST' ? 'conflict' : 'failed',
          preview,
          error: 'write-failed',
          message:
            code === 'EEXIST'
              ? '目标文件已存在，请重新预览后再导入'
              : `写入导入文件失败：${errorText(error)}`,
        }
      }
      // 文件已出现：先让列表缓存失效，再保存归属。
      this.deps.catalog.invalidateCatalog(analysis.cwd)
      try {
        await this.deps.workspaceStore.assignSession({
          storeId: this.deps.storeId,
          sessionId: plan.id,
          workspaceId: analysis.workspaceId,
        })
      } catch (error) {
        // 文件保留为可发现的未归属会话，不删除、不伪报成功。
        return {
          status: 'metadata-failed',
          threadId: plan.id,
          preview,
          error: 'metadata-failed',
          message: `导入文件已写入，但会话归属保存失败：${errorText(error)}`,
        }
      }
      return {
        status: 'imported',
        threadId: plan.id,
        preview: { ...preview, conflict: 'none', canCopy: false },
      }
    })
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

import { WorkspaceStateUnavailableError } from '../workspace-store.js'
