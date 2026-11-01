/**
 * 真实 stdio transport 测试（G1.4d2a）。
 *
 * 使用 Node 脚本 fixture 子进程验证初始化、工具/进度、资源分页/模板、动态
 * tools、取消、临时目录值解析、慢初始化关闭与子/孙进程回收。
 */

import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMcpConnectionManager,
  type McpConnectionManager,
  type McpServerConfig,
  type McpServerEntry,
} from './index.js'

const fixturePath = fileURLToPath(new URL('./test-fixtures/stdio-server.mjs', import.meta.url))

interface Harness {
  manager: McpConnectionManager
  dir: string
  sideEffectFile: string
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function makeEntry(config: McpServerConfig): McpServerEntry {
  return { name: 'demo', config, source: '/tmp/mcp.json', scope: 'user' }
}

async function createStdioHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-stdio-'))
  const sideEffectFile = join(dir, 'side-effects.txt')
  const entry = makeEntry({
    command: process.execPath,
    args: [fixturePath],
    cwd: dir,
    env: { FIXTURE_SIDE_EFFECT_FILE: sideEffectFile, ...env },
  })
  const manager = createMcpConnectionManager({ cwd: dir, servers: [entry] })
  cleanups.push(async () => {
    await manager.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { manager, dir, sideEffectFile }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(() => existsSync(path))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe('真实 stdio', () => {
  it('初始化、工具目录、进度与工具调用', async () => {
    const harness = await createStdioHarness({ FIXTURE_CALL_DELAY_MS: '60' })
    try {
      await harness.manager.start()
      const snapshot = harness.manager.snapshot()
      expect(snapshot.servers[0]).toMatchObject({
        state: 'connected',
        hasResources: true,
        toolCount: 5,
        toolRevision: 1,
      })
      const catalog = harness.manager.getToolCatalog('demo')
      expect(catalog.instructions).toBe('Fixture server instructions')
      expect(catalog.tools.map((tool) => tool.name)).toContain('echo')
      expect(catalog.tools.map((tool) => tool.name)).toContain('slow')

      await expect(
        harness.manager.callTool('demo', 'echo', { text: 'hello' }),
      ).resolves.toMatchObject({ content: [{ type: 'text', text: 'echo:hello' }] })

      const progress: number[] = []
      const result = await harness.manager.callTool(
        'demo',
        'slow',
        { text: 'work' },
        {
          onProgress: (notification) => {
            progress.push(notification.progress)
          },
        },
      )
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'slow:work' }] })
      expect(progress).toEqual([0, 2, 3])
    } finally {
      await rm(harness.sideEffectFile, { force: true })
    }
  })

  it('资源分页、模板分页与模板 MethodNotFound 空返回', async () => {
    const harness = await createStdioHarness({
      FIXTURE_RESOURCE_PAGE_SIZE: '2',
      FIXTURE_RESOURCE_COUNT: '3',
      FIXTURE_TEMPLATE_PAGE_SIZE: '2',
      FIXTURE_TEMPLATE_COUNT: '3',
    })
    await harness.manager.start()
    const first = await harness.manager.listResources('demo')
    expect(first.resources).toHaveLength(2)
    expect(first.nextCursor).toBe('2')
    const second = await harness.manager.listResources('demo', first.nextCursor)
    expect(second.resources).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    const all = await harness.manager.listAllResources('demo')
    expect(all).toHaveLength(3)

    const templates = await harness.manager.listResourceTemplates('demo')
    expect(templates.resourceTemplates).toHaveLength(2)
    expect(templates.nextCursor).toBe('2')
    const next = await harness.manager.listResourceTemplates('demo', templates.nextCursor)
    expect(next.resourceTemplates).toHaveLength(1)
    const allTemplates = await harness.manager.listAllResourceTemplates('demo')
    expect(allTemplates).toHaveLength(3)
    await expect(
      harness.manager.readResource('demo', 'resource://fixture/0'),
    ).resolves.toMatchObject({
      contents: [{ text: 'resource:resource://fixture/0' }],
    })

    const noTemplates = await createStdioHarness({ FIXTURE_NO_TEMPLATES: '1' })
    await noTemplates.manager.start()
    await expect(noTemplates.manager.listResourceTemplates('demo')).resolves.toEqual({
      resourceTemplates: [],
    })
    await expect(noTemplates.manager.listAllResourceTemplates('demo')).resolves.toEqual([])
  })

  it('动态 tools/list_changed 刷新真实目录', async () => {
    const harness = await createStdioHarness()
    await harness.manager.start()
    expect(harness.manager.getToolCatalog('demo').tools).toHaveLength(5)
    await expect(harness.manager.callTool('demo', 'add-dynamic-tool')).resolves.toMatchObject({
      content: [{ type: 'text', text: 'dynamic tool added' }],
    })
    await waitFor(() => harness.manager.snapshot().servers[0]?.toolCount === 6)
    expect(harness.manager.getToolCatalog('demo').tools.map((tool) => tool.name)).toContain(
      'dynamic_tool',
    )
    await expect(harness.manager.callTool('demo', 'dynamic_tool')).resolves.toBeDefined()
  })

  it('取消慢调用后不产生副作用', async () => {
    const harness = await createStdioHarness({ FIXTURE_CALL_DELAY_MS: '400' })
    const sideEffectFile = harness.sideEffectFile
    try {
      await rm(sideEffectFile, { force: true })
      await harness.manager.start()
      const controller = new AbortController()
      const pending = harness.manager.callTool(
        'demo',
        'slow',
        { text: 'cancel' },
        {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        },
      )
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(existsSync(sideEffectFile)).toBe(false)
    } finally {
      await rm(sideEffectFile, { force: true })
    }
  })

  it('慢初始化期间 close 会回收服务器进程与孙进程', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-reap-'))
    const pidFile = join(dir, 'server.pid')
    const grandchildPidFile = join(dir, 'grandchild.pid')
    const manager = createMcpConnectionManager({
      cwd: dir,
      servers: [
        makeEntry({
          command: process.execPath,
          args: [fixturePath],
          cwd: dir,
          env: {
            FIXTURE_SLOW_INIT_MS: '60000',
            FIXTURE_PID_FILE: pidFile,
            FIXTURE_GRANDCHILD: '1',
            FIXTURE_GRANDCHILD_PID_FILE: grandchildPidFile,
          },
        }),
      ],
    })
    cleanups.push(async () => {
      await manager.close()
      await rm(dir, { recursive: true, force: true })
    })

    const starting = manager.start()
    await waitForFile(pidFile)
    await waitForFile(grandchildPidFile)
    const pid = Number(await readFile(pidFile, 'utf8'))
    const grandchildPid = Number(await readFile(grandchildPidFile, 'utf8'))
    expect(isAlive(pid)).toBe(true)
    expect(isAlive(grandchildPid)).toBe(true)

    const started = Date.now()
    await manager.close()
    await starting
    expect(Date.now() - started).toBeLessThan(5_000)
    await waitFor(() => !isAlive(pid) && !isAlive(grandchildPid))
  })

  it('连接失败快照不包含 stderr 或环境秘密', async () => {
    const secret = 'HUAN-SECRET-STDIO'
    const manager = createMcpConnectionManager({
      cwd: process.cwd(),
      servers: [
        makeEntry({
          command: process.execPath,
          args: ['-e', `process.stderr.write(${JSON.stringify(secret)}); process.exit(1)`],
          env: { SECRET_TOKEN: secret },
        }),
      ],
    })
    cleanups.push(async () => {
      await manager.close()
    })
    await manager.start()
    const snapshot = manager.snapshot()
    expect(snapshot.servers[0]).toMatchObject({
      state: 'failed',
      error: { code: 'connect-failed' },
    })
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    try {
      await manager.callTool('demo', 'echo')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })

  it('构造不执行 !command，start 时才解析并按会话 cwd 运行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-values-'))
    const marker = join(dir, 'marker.txt')
    let runnerCalls = 0
    const manager = createMcpConnectionManager({
      cwd: dir,
      servers: [
        makeEntry({
          command: process.execPath,
          args: [fixturePath],
          cwd: dir,
          env: { FIXTURE_TOKEN: '!make-token' },
        }),
      ],
      runCommand: async (command, options) => {
        runnerCalls += 1
        expect(command).toBe('make-token')
        expect(options.cwd).toBe(dir)
        writeFileSync(marker, 'x')
        return 'resolved-token'
      },
    })
    cleanups.push(async () => {
      await manager.close()
      await rm(dir, { recursive: true, force: true })
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runnerCalls).toBe(0)
    expect(existsSync(marker)).toBe(false)
    await manager.start()
    expect(runnerCalls).toBe(1)
    expect(existsSync(marker)).toBe(true)
    expect(manager.snapshot().servers[0]?.state).toBe('connected')
  })
})
