/**
 * G1.2d JSONL 导入：真实宿主 + 隔离用户空间。
 *
 * 覆盖预览只读、宿主路径/上传、cwd 修复、同 ID 冲突与副本、完整树保留、
 * 并发导入、坏 JSONL/断链/版本、未知扩展条目透传、旧版迁移、信任入口与
 * 元数据失败边界。全部使用临时目录与合成模型，不读取个人 Pi 配置。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost, ProjectTrustRequiredError } from './host.js'
import { importFileName, parseSessionJsonl } from './session-import.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'
import { WorkspaceStateUnavailableError, workspaceStateFile } from './workspace-store.js'

let env: IsolatedPiEnv
let host: HarnessHost
let fetchStub: TestFetchStub
let savedEnv: Map<string, string | undefined>
let workspaceId: string

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const createHost = () =>
  createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
  })

const TIMESTAMP = '2026-10-31T00:00:00.000Z'

type SourceOptions = {
  id: string
  cwd: string
  text?: string
  reply?: string
  version?: number
  parentSession?: string
  extraEntries?: readonly Record<string, unknown>[]
  omitUserIds?: boolean
}

/** 构造最小合法会话 JSONL（可带额外/畸形条目用于负例）。 */
function buildSessionText(options: SourceOptions): string {
  const {
    id,
    cwd,
    text = '导入问题',
    reply = '导入回答',
    version = 3,
    parentSession,
    extraEntries = [],
    omitUserIds = false,
  } = options
  const header: Record<string, unknown> = {
    type: 'session',
    version,
    id,
    timestamp: TIMESTAMP,
    cwd,
    ...(parentSession ? { parentSession } : {}),
  }
  const userId = 'entry-user'
  const assistantId = 'entry-assistant'
  const userTimestamp = Date.parse(TIMESTAMP) + 1
  const entries: Record<string, unknown>[] = [
    {
      type: 'message',
      ...(omitUserIds ? {} : { id: userId, parentId: null }),
      timestamp: new Date(userTimestamp).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: userTimestamp,
      },
    },
    {
      type: 'message',
      ...(omitUserIds ? {} : { id: assistantId, parentId: userId }),
      timestamp: new Date(userTimestamp + 1).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        api: 'openai-completions',
        provider: TEST_PROVIDER,
        model: 'test-model-a',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: userTimestamp + 1,
      },
    },
    ...extraEntries.map((entry) => ({ ...entry })),
  ]
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/** 在临时根下写一个源 JSONL，返回绝对路径。 */
async function writeSource(name: string, content: string): Promise<string> {
  const file = join(env.root, 'imports', name)
  await mkdir(join(env.root, 'imports'), { recursive: true })
  await writeFile(file, content)
  return file
}

async function createProject(name: string): Promise<string> {
  const path = join(env.root, 'projects', name)
  await mkdir(path, { recursive: true })
  return path
}

async function createWorkspace(projects: readonly string[]): Promise<string> {
  const result = await host.createWorkspace({
    name: `导入工作区 ${Date.now().toString(36)}`,
    projects: projects.map((path, index) => ({ alias: `p${index}`, path })),
  })
  if (!result.ok) throw new Error(`创建工作区失败：${result.error}`)
  return result.workspace.id
}

async function sessionFiles(): Promise<string[]> {
  const dir = env.defaultSessionDir(env.workspace)
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((name) => name.endsWith('.jsonl')).sort()
}

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-import-test-')
  fetchStub = installTestFetch('继续回复')
  host = await createHost()
  const catalog = await host.listWorkspaces()
  const startup = catalog.workspaces.find(
    (workspace) => workspace.id === catalog.startupWorkspaceId,
  )
  workspaceId = startup?.id ?? catalog.workspaces[0]?.id ?? ''
})

afterEach(async () => {
  await host.dispose().catch(() => {})
  fetchStub.restore()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('预览', () => {
  it('宿主路径预览只解析文件与目录，不装配项目、不发模型请求', async () => {
    // 项目扩展探针：预览不得触发装配。
    await mkdir(join(env.workspace, '.pi', 'extensions'), { recursive: true })
    const marker = join(env.root, 'preview.marker')
    await writeFile(
      join(env.workspace, '.pi', 'extensions', 'probe.ts'),
      `import { appendFileSync } from 'node:fs'

export default function () {
  appendFileSync(${JSON.stringify(marker)}, 'project\\n')
}
`,
    )
    const source = await writeSource(
      'preview.jsonl',
      buildSessionText({ id: 'import-preview', cwd: env.workspace }),
    )
    const preview = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(preview.status).toBe('ok')
    expect(preview.source).toMatchObject({
      kind: 'path',
      id: 'import-preview',
      cwd: env.workspace,
      entries: 2,
      version: 3,
    })
    expect(preview.sourceCwd).toMatchObject({
      path: expect.any(String),
      available: true,
      workspaceMember: true,
    })
    expect(preview.sessionDir).toBe(env.defaultSessionDir(env.workspace))
    expect(preview.conflict).toBe('none')
    expect(preview.warnings?.some((warning) => warning.includes('敏感'))).toBe(true)
    // 预览不触发项目扩展，也不请求模型。
    expect(existsSync(marker)).toBe(false)
    expect(fetchStub.calls()).toBe(0)
  })

  it('坏 JSONL / 重复 header / 断链 / 环 / 未知版本被严格拒绝', async () => {
    const cwdJson = JSON.stringify(env.workspace)
    const cases: Array<{ name: string; content: string; error: string }> = [
      {
        name: 'bad-line.jsonl',
        content: `{"type":"session","version":3,"id":"bad-line","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}\nnot-json\n`,
        error: 'invalid-json',
      },
      {
        name: 'double-header.jsonl',
        content: `{"type":"session","version":3,"id":"double-header","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}\n{"type":"session","version":3,"id":"other","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}\n`,
        error: 'invalid-header',
      },
      {
        name: 'no-header.jsonl',
        content:
          '{"type":"message","id":"a","parentId":null,"timestamp":"2026-10-31T00:00:00.000Z"}\n',
        error: 'invalid-header',
      },
      {
        name: 'bad-id.jsonl',
        content: `{"type":"session","version":3,"id":"bad id!","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}\n`,
        error: 'invalid-header',
      },
      {
        name: 'duplicate-entry.jsonl',
        content: `{"type":"session","version":3,"id":"dup-entry","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}
{"type":"message","id":"same","parentId":null,"timestamp":"${TIMESTAMP}","message":{"role":"user","content":"a","timestamp":1}}
{"type":"message","id":"same","parentId":"same","timestamp":"${TIMESTAMP}","message":{"role":"assistant","content":[],"api":"x","provider":"x","model":"x","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}
`,
        error: 'duplicate-entry',
      },
      {
        name: 'broken-chain.jsonl',
        content: `{"type":"session","version":3,"id":"broken-chain","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}
{"type":"message","id":"a","parentId":"missing","timestamp":"${TIMESTAMP}","message":{"role":"user","content":"a","timestamp":1}}
`,
        error: 'broken-chain',
      },
      {
        name: 'cycle.jsonl',
        content: `{"type":"session","version":3,"id":"cycle","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}
{"type":"message","id":"a","parentId":"b","timestamp":"${TIMESTAMP}","message":{"role":"user","content":"a","timestamp":1}}
{"type":"message","id":"b","parentId":"a","timestamp":"${TIMESTAMP}","message":{"role":"assistant","content":[],"api":"x","provider":"x","model":"x","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}
`,
        error: 'cycle',
      },
      {
        name: 'version.jsonl',
        content: `{"type":"session","version":99,"id":"future","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}\n`,
        error: 'unsupported-version',
      },
      {
        name: 'entry-shape.jsonl',
        content: `{"type":"session","version":3,"id":"entry-shape","timestamp":"${TIMESTAMP}","cwd":${cwdJson}}\n{"id":"a","parentId":null,"timestamp":"${TIMESTAMP}"}\n`,
        error: 'invalid-entry',
      },
    ]
    const before = await sessionFiles()
    for (const item of cases) {
      const path = await writeSource(item.name, item.content)
      const preview = await host.previewThreadImport({
        source: { kind: 'path', path },
        workspaceId,
      })
      expect(preview.status, item.name).toBe('invalid')
      expect(preview.error, item.name).toBe(item.error)
      const result = await host.importThread({
        source: { kind: 'path', path },
        workspaceId,
      })
      expect(result.status, item.name).toBe('invalid')
      expect(result.error, item.name).toBe(item.error)
    }
    expect(await sessionFiles()).toEqual(before)
  })
})

describe('宿主路径导入', () => {
  it('保留源 ID 与完整树，记录父路径、归属并可继续发送', async () => {
    const sourceText = buildSessionText({ id: 'import-host', cwd: env.workspace })
    const source = await writeSource('host.jsonl', sourceText)
    const beforeFiles = await sessionFiles()

    const result = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
      expectedSourceId: 'import-host',
    })
    expect(result.status).toBe('imported')
    expect(result.threadId).toBe('import-host')
    // 源文件永不改写。
    expect(await readFile(source, 'utf8')).toBe(sourceText)
    const files = await sessionFiles()
    expect(files.length).toBe(beforeFiles.length + 1)
    const importedFile = join(
      env.defaultSessionDir(env.workspace),
      files.find((name) => name.includes('import-host')) ?? '',
    )
    const header = SessionManager.open(importedFile).getHeader()
    expect(header).toMatchObject({
      id: 'import-host',
      cwd: expect.any(String),
      parentSession: source,
    })

    const threads = await host.listThreads({ workspaceId })
    expect(threads.some((thread) => thread.id === 'import-host')).toBe(true)
    const snapshot = await host.getThread('import-host')
    expect(JSON.stringify(snapshot.messages)).toContain('导入问题')
    expect(snapshot.metadata.workspaceId).toBe(workspaceId)

    // 导入后可直接继续对话（真实宿主会话）。
    await host.sendMessage('import-host', { content: '导入后继续' })
    await waitFor(async () => {
      const current = await host.getThread('import-host')
      return current.metadata.status === 'idle' &&
        JSON.stringify(current.messages).includes('继续回复')
        ? true
        : undefined
    })
    expect(JSON.stringify((await host.getThread('import-host')).messages)).toContain('导入后继续')
  })

  it('cwd 不可用/非成员时要求替代目录，导入写入替代目录', async () => {
    const other = await createProject('import-other')
    const scopedWorkspace = await createWorkspace([other])
    const missing = join(env.root, 'missing-project')
    const source = await writeSource(
      'cwd.jsonl',
      buildSessionText({ id: 'import-cwd', cwd: missing, text: 'cwd 导入' }),
    )

    const invalid = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId: scopedWorkspace,
    })
    expect(invalid.status).toBe('invalid')
    expect(invalid.error).toBe('cwd-not-member')

    // 相对 cwd 不按宿主进程目录猜测，要求显式替代目录。
    const relativeSource = await writeSource(
      'relative-cwd.jsonl',
      buildSessionText({ id: 'import-relative', cwd: 'relative/project' }),
    )
    const relative = await host.previewThreadImport({
      source: { kind: 'path', path: relativeSource },
      workspaceId: scopedWorkspace,
    })
    expect(relative.status).toBe('invalid')
    expect(relative.error).toBe('cwd-required')

    const preview = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId: scopedWorkspace,
      cwdOverride: other,
    })
    expect(preview.status).toBe('ok')
    expect(preview.cwd).toBe(other)
    expect(preview.sessionDir).toBe(env.defaultSessionDir(other))
    expect(preview.warnings?.some((warning) => warning.includes('替代'))).toBe(true)

    const result = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId: scopedWorkspace,
      cwdOverride: other,
    })
    expect(result.status).toBe('imported')
    const files = await readdir(env.defaultSessionDir(other))
    expect(files.some((name) => name.includes('import-cwd'))).toBe(true)
    const imported = await host.getThread('import-cwd')
    expect(imported.metadata.workspaceId).toBe(scopedWorkspace)
    expect(imported.metadata.workspacePath).toBe(other)
  })

  it('依据源 cwd 的默认目录写入；浏览器上传不使用文件名拼接', async () => {
    const content = buildSessionText({ id: 'import-upload', cwd: env.workspace, text: '上传内容' })
    const preview = await host.previewThreadImport({
      source: { kind: 'upload', filename: '../../evil/name.jsonl', content },
      workspaceId,
    })
    expect(preview.status).toBe('ok')
    expect(preview.source?.kind).toBe('upload')
    const result = await host.importThread({
      source: { kind: 'upload', filename: '../../evil/name.jsonl', content },
      workspaceId,
    })
    expect(result.status).toBe('imported')
    const files = await sessionFiles()
    expect(files.every((name) => !name.includes('evil') && !name.includes('..'))).toBe(true)
    expect(files.some((name) => name.includes('import-upload'))).toBe(true)
    // 上传来源没有真实宿主路径，不写 parentSession。
    const importedFile = join(
      env.defaultSessionDir(env.workspace),
      files.find((name) => name.includes('import-upload')) ?? '',
    )
    expect(SessionManager.open(importedFile).getHeader()?.parentSession).toBeUndefined()
  })
})

describe('安全文件名', () => {
  it('header 时间戳含斜杠时规范为 ISO 文件名，不生成子目录', () => {
    const text = buildSessionText({ id: 'import-timestamp', cwd: '/tmp/project' }).replace(
      TIMESTAMP,
      '2026/10/31',
    )
    const parsed = parseSessionJsonl(text)
    if ('error' in parsed) throw new Error(parsed.message)
    const name = importFileName(parsed, 'import-timestamp')
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T.*_import-timestamp\.jsonl$/)
  })
})

describe('冲突、副本与完整树', () => {
  it('同 ID 相同内容返回 already-exists；内容不同需明确副本', async () => {
    const sourceText = buildSessionText({ id: 'import-conflict', cwd: env.workspace })
    const source = await writeSource('conflict-a.jsonl', sourceText)
    const first = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(first.status).toBe('imported')
    const filesAfterFirst = await sessionFiles()

    // 完全相同：定位既有会话，不复制。
    const same = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(same.status).toBe('already-exists')
    expect(same.existingThreadId).toBe('import-conflict')
    expect(await sessionFiles()).toEqual(filesAfterFirst)

    // 同 ID 不同内容：冲突，未确认副本时不写入。
    const changed = await writeSource(
      'conflict-b.jsonl',
      buildSessionText({
        id: 'import-conflict',
        cwd: env.workspace,
        text: '冲突问题',
        reply: '冲突回答',
        extraEntries: [
          {
            type: 'future_entry',
            id: 'future-1',
            parentId: 'entry-assistant',
            timestamp: TIMESTAMP,
            payload: { keep: true },
          },
        ],
      }),
    )
    const preview = await host.previewThreadImport({
      source: { kind: 'path', path: changed },
      workspaceId,
    })
    expect(preview.conflict).toBe('conflict')
    expect(preview.canCopy).toBe(true)
    const conflict = await host.importThread({
      source: { kind: 'path', path: changed },
      workspaceId,
    })
    expect(conflict.status).toBe('conflict')
    expect(await sessionFiles()).toEqual(filesAfterFirst)

    const copy = await host.importThread({
      source: { kind: 'path', path: changed },
      workspaceId,
      asCopy: true,
      expectedSourceId: 'import-conflict',
    })
    expect(copy.status).toBe('imported')
    expect(copy.threadId).toBeTruthy()
    expect(copy.threadId).not.toBe('import-conflict')
    const filesAfterCopy = await sessionFiles()
    expect(filesAfterCopy.length).toBe(filesAfterFirst.length + 1)
    const copyFile = join(
      env.defaultSessionDir(env.workspace),
      filesAfterCopy.find((name) => name.includes(copy.threadId ?? '')) ?? '',
    )
    const copyHeader = SessionManager.open(copyFile).getHeader()
    expect(copyHeader?.id).toBe(copy.threadId)
    expect(copyHeader?.parentSession).toBe(changed)
    // 未知扩展条目透传，完整树保留（不是只复制活动路径）。
    const entries = SessionManager.open(copyFile).getEntries()
    expect(entries.some((entry) => (entry as { type: string }).type === 'future_entry')).toBe(true)
    expect(await readFile(changed, 'utf8')).toContain('future_entry')
    const copied = await host.getThread(copy.threadId ?? '')
    expect(JSON.stringify(copied.messages)).toContain('冲突问题')
    const copiedTree = await host.getThreadTree(copy.threadId ?? '')
    expect(copiedTree.nodes.some((node) => node.entryType === 'future_entry')).toBe(true)
  })

  it('并发导入同 ID 串行化，只写入一份', async () => {
    const source = await writeSource(
      'concurrent.jsonl',
      buildSessionText({ id: 'import-concurrent', cwd: env.workspace }),
    )
    const before = await sessionFiles()
    const [left, right] = await Promise.all([
      host.importThread({ source: { kind: 'path', path: source }, workspaceId }),
      host.importThread({ source: { kind: 'path', path: source }, workspaceId }),
    ])
    expect([left.status, right.status].sort()).toEqual(['already-exists', 'imported'])
    expect((await sessionFiles()).length).toBe(before.length + 1)
  })

  it('同 ID 源内容变化也必须重新预览', async () => {
    const source = await writeSource(
      'same-id-change.jsonl',
      buildSessionText({
        id: 'same-id-change',
        cwd: env.workspace,
        text: '原内容',
      }),
    )
    const preview = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    await writeFile(
      source,
      buildSessionText({ id: 'same-id-change', cwd: env.workspace, text: '已变化' }),
    )
    const result = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
      expectedSourceFingerprint: preview.source?.fingerprint,
    })
    expect(result.error).toBe('source-changed')
    expect(result.status).toBe('invalid')
  })

  it('缺失 cwd 的源可以明确指定成员替代', async () => {
    const raw = buildSessionText({ id: 'missing-cwd', cwd: env.workspace })
    const lines = raw.trim().split('\n')
    const header = JSON.parse(lines[0] ?? '{}')
    delete header.cwd
    lines[0] = JSON.stringify(header)
    const source = {
      kind: 'upload' as const,
      filename: 'missing.jsonl',
      content: `${lines.join('\n')}\n`,
    }
    expect((await host.previewThreadImport({ source, workspaceId })).error).toBe('cwd-required')
    const imported = await host.importThread({ source, workspaceId, cwdOverride: env.workspace })
    expect(imported.status).toBe('imported')
  })

  it('源在预览后变化时拒绝确认；重新预览后可继续', async () => {
    const source = await writeSource(
      'changing.jsonl',
      buildSessionText({ id: 'import-changing', cwd: env.workspace, text: '原始内容' }),
    )
    const preview = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(preview.status).toBe('ok')
    // 确认前源被替换为另一个会话。
    await writeSource(
      'changing.jsonl',
      buildSessionText({ id: 'import-changed', cwd: env.workspace }),
    )
    const result = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
      expectedSourceId: preview.source?.id,
    })
    expect(result.status).toBe('invalid')
    expect(result.error).toBe('source-changed')

    const refreshed = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(refreshed.source?.id).toBe('import-changed')
    const retried = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
      expectedSourceId: 'import-changed',
    })
    expect(retried.status).toBe('imported')
  })
})

describe('旧版、信任与失败边界', () => {
  it('v1 会话经公开迁移后导入；未知扩展条目保留', async () => {
    const legacy = buildSessionText({
      id: 'import-legacy',
      cwd: env.workspace,
      text: '旧版问题',
      reply: '旧版回答',
      version: 1,
      omitUserIds: true,
      extraEntries: [
        {
          type: 'mystery_entry',
          id: 'mystery-1',
          parentId: null,
          timestamp: TIMESTAMP,
          data: { preserved: true },
        },
      ],
    })
    const source = await writeSource('legacy.jsonl', legacy)
    const preview = await host.previewThreadImport({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(preview.status).toBe('ok')
    expect(preview.source?.version).toBe(1)
    expect(preview.warnings?.some((warning) => warning.includes('迁移'))).toBe(true)

    const result = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(result.status).toBe('imported')
    const importedFile = join(
      env.defaultSessionDir(env.workspace),
      (await sessionFiles()).find((name) => name.includes('import-legacy')) ?? '',
    )
    const manager = SessionManager.open(importedFile)
    expect(manager.getHeader()?.version).toBe(3)
    const entries = manager.getEntries()
    expect(entries.every((entry) => typeof entry.id === 'string')).toBe(true)
    // v1 迁移会为未知条目补 id/parentId，额外字段保留。
    const mystery = entries.find((entry) => (entry as { type: string }).type === 'mystery_entry') as
      | (Record<string, unknown> & { data?: unknown })
      | undefined
    expect(mystery?.data).toEqual({ preserved: true })
    const snapshot = await host.getThread('import-legacy')
    expect(JSON.stringify(snapshot.messages)).toContain('旧版问题')
  })

  it('项目需要信任时拒绝导入；拒绝信任后仍可使用用户资源导入', async () => {
    const project = await createProject('import-trust')
    await mkdir(join(project, '.pi', 'extensions'), { recursive: true })
    const marker = join(env.root, 'trust.marker')
    await writeFile(
      join(project, '.pi', 'extensions', 'probe.ts'),
      `import { appendFileSync } from 'node:fs'

export default function () {
  appendFileSync(${JSON.stringify(marker)}, 'project\\n')
}
`,
    )
    const scoped = await createWorkspace([project])
    const source = await writeSource(
      'trust.jsonl',
      buildSessionText({ id: 'import-trust', cwd: project }),
    )

    await expect(
      host.importThread({ source: { kind: 'path', path: source }, workspaceId: scoped }),
    ).rejects.toBeInstanceOf(ProjectTrustRequiredError)
    // 需要信任期间未写入任何导入文件、未执行项目代码。
    expect(existsSync(marker)).toBe(false)
    expect(
      (await readdir(env.defaultSessionDir(project)).catch(() => [] as string[])).some((name) =>
        name.includes('import-trust'),
      ),
    ).toBe(false)

    const decided = await host.decideProjectTrust({ path: project, trusted: false })
    expect(decided.status).toBe('ready')
    const result = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId: scoped,
    })
    expect(result.status).toBe('imported')
    expect(existsSync(marker)).toBe(false)
  })

  it('元数据损坏拒绝导入且不写文件；归属保存失败保留文件并如实报告', async () => {
    const source = await writeSource(
      'metadata.jsonl',
      buildSessionText({ id: 'import-metadata', cwd: env.workspace }),
    )
    // 先让归属保存失败：用同名文件阻断 huan 元数据目录。
    const stateDir = join(env.agentDir, 'huan')
    await rm(stateDir, { recursive: true, force: true })
    await writeFile(stateDir, 'blocked')
    const failed = await host.importThread({
      source: { kind: 'path', path: source },
      workspaceId,
    })
    expect(failed.status).toBe('metadata-failed')
    expect(failed.threadId).toBe('import-metadata')
    expect(failed.message).toContain('归属保存失败')
    // 文件保留为可发现的未归属会话，不伪报成功。
    const importedFile = join(
      env.defaultSessionDir(env.workspace),
      (await sessionFiles()).find((name) => name.includes('import-metadata')) ?? '',
    )
    expect(existsSync(importedFile)).toBe(true)
    const threads = await host.listThreads()
    expect(threads.find((thread) => thread.id === 'import-metadata')?.workspaceId).toBeUndefined()

    // 回到健康状态后，导入其余会话仍可用。
    await rm(stateDir, { force: true })
    const recovered = await host.decideProjectTrust({ path: env.workspace, trusted: true })
    expect(recovered.status).toBe('ready')
    const other = await writeSource(
      'metadata-ok.jsonl',
      buildSessionText({ id: 'import-metadata-ok', cwd: env.workspace }),
    )
    const ok = await host.importThread({
      source: { kind: 'path', path: other },
      workspaceId,
    })
    expect(ok.status).toBe('imported')
  })

  it('元数据不可用时确认导入抛出可识别的 state 错误', async () => {
    await host.dispose()
    // 写一个损坏的 state.json 后重启宿主。
    await mkdir(join(env.agentDir, 'huan'), { recursive: true })
    await writeFile(workspaceStateFile(env.agentDir), '{not json')
    host = await createHost()
    const source = await writeSource(
      'state.jsonl',
      buildSessionText({ id: 'import-state', cwd: env.workspace }),
    )
    await expect(
      host.importThread({ source: { kind: 'path', path: source }, workspaceId }),
    ).rejects.toBeInstanceOf(WorkspaceStateUnavailableError)
    expect((await sessionFiles()).some((name) => name.includes('import-state'))).toBe(false)
  })
})
