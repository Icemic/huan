/**
 * MCP 日志测试（G1.4d3）。
 *
 * 验证构造无 I/O、写入队列/flush/close、单条有界、5 MiB 轮换、0600/0700、
 * 不序列化 OAuth/body/headers/config 字段，以及符号链接目标不被写入。
 */

import { existsSync } from 'node:fs'
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatMcpLogMessage,
  MCP_LOG_MAX_BYTES,
  MCP_LOG_MAX_MESSAGE_BYTES,
  McpServerLog,
} from './index.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'huan-mcp-log-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'EINVAL') {
      return false
    }
    throw error
  }
}

describe('MCP 日志', () => {
  it('构造无 I/O，write/flush/close 可等待且权限收紧', async () => {
    const root = await tempRoot()
    const path = join(root, 'state', 'mcp.log')
    const log = new McpServerLog(path)
    expect(existsSync(join(root, 'state'))).toBe(false)

    const first = log.write('demo', { level: 'info', data: 'hello' })
    await first
    await log.flush()
    expect(existsSync(join(root, 'state'))).toBe(true)
    expect(await readFile(path, 'utf8')).toContain('hello')

    await log.close()
    await log.write('demo', { level: 'info', data: 'after-close' })
    await log.flush()
    expect(await readFile(path, 'utf8')).not.toContain('after-close')

    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o077).toBe(0)
      expect((await stat(join(root, 'state'))).mode & 0o077).toBe(0)
    }
  })

  it('单条消息有界，且只记录 level/logger/data', async () => {
    const root = await tempRoot()
    const path = join(root, 'mcp.log')
    const log = new McpServerLog(path, { maxMessageBytes: 160 })
    const secret = 'super-secret-value'
    await log.write('demo', {
      level: 'info',
      logger: 'test',
      data: 'ok',
      body: secret,
      headers: { authorization: secret },
      config: { oauth: { clientSecret: secret } },
      tokens: { access_token: secret },
    })
    await log.flush()
    const text = await readFile(path, 'utf8')
    expect(text).toContain('ok')
    expect(text).not.toContain(secret)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(160)

    const formatted = formatMcpLogMessage(
      'demo',
      { level: 'error', logger: 'x', data: 'y'.repeat(1_000) },
      new Date('2026-01-01T00:00:00.000Z'),
      128,
    )
    expect(Buffer.byteLength(formatted)).toBeLessThanOrEqual(128)
    expect(formatted.endsWith('\n')).toBe(true)
  })

  it('超过上限后轮换到 .1，当前文件保持有界', async () => {
    const root = await tempRoot()
    const path = join(root, 'mcp.log')
    const log = new McpServerLog(path, { maxBytes: 512, maxMessageBytes: 200 })
    for (let index = 0; index < 12; index += 1) {
      await log.write('demo', { level: 'info', data: `${index}-${'x'.repeat(100)}` })
    }
    await log.flush()
    expect(existsSync(`${path}.1`)).toBe(true)
    expect((await stat(path)).size).toBeLessThanOrEqual(512)
    const current = await readFile(path, 'utf8')
    expect(current).toContain('11-')
  })

  it('默认可轮换上限为 5 MiB', async () => {
    expect(MCP_LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(MCP_LOG_MAX_MESSAGE_BYTES).toBe(16 * 1024)
    const root = await tempRoot()
    const path = join(root, 'mcp.log')
    const log = new McpServerLog(path)
    // 只写一条即可确认默认上限没有把消息拒之门外。
    await log.write('demo', { level: 'info', data: 'x' })
    await log.flush()
    expect((await stat(path)).size).toBeGreaterThan(0)
  })

  it('符号链接日志目标不被写入', async () => {
    const root = await tempRoot()
    const target = join(root, 'sentinel.log')
    await writeFile(target, 'sentinel')
    const path = join(root, 'mcp.log')
    if (!(await trySymlink(target, path))) return
    const log = new McpServerLog(path)
    await log.write('demo', { level: 'info', data: 'should-not-write' })
    await log.flush()
    expect(await readFile(target, 'utf8')).toBe('sentinel')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })
})
