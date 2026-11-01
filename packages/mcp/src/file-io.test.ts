/** 有界 I/O 的确定性回归，不依赖实际文件读取恰好返回完整 buffer。 */
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_CONFIG_FILE_MAX_BYTES, mcpConfigRevision, readMcpConfigText } from './file-io.js'
import { createMcpConfigStore } from './store.js'

const io = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  lstat: io.lstat,
  open: io.open,
}))

afterEach(() => vi.resetAllMocks())

function mockFile(content: Buffer, reportedSize: number, shortRead?: number) {
  io.lstat.mockImplementation(async (path: string) => ({
    size: reportedSize,
    isSymbolicLink: () => false,
    isFile: () => path.endsWith('mcp.json'),
    isDirectory: () => !path.endsWith('mcp.json'),
  }))
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = Math.min(length, shortRead ?? length, content.length - position)
    content.copy(buffer, offset, position, position + bytesRead)
    return { bytesRead, buffer }
  })
  const close = vi.fn(async () => {})
  io.open.mockResolvedValue({ read, close })
  return { read, close }
}

describe('配置有界读取', () => {
  it('未信任项目的读取/保存不检查路径，合并只检查用户路径', async () => {
    const agentDir = resolve('test-agent')
    const cwd = resolve('test-project')
    const store = createMcpConfigStore({ agentDir, cwd })
    io.lstat.mockRejectedValue(Object.assign(new Error('不存在'), { code: 'ENOENT' }))
    expect((await store.read('project')).readable).toBe(false)
    expect(
      await store.save({ scope: 'project', content: '{}', expectedRevision: null }),
    ).toMatchObject({ status: 'untrusted' })
    expect(io.lstat).not.toHaveBeenCalled()
    await store.load({ projectTrusted: false })
    expect(io.lstat.mock.calls.length).toBeGreaterThan(0)
    expect(io.lstat.mock.calls.every(([path]) => !String(path).startsWith(cwd))).toBe(true)
    expect(io.open).not.toHaveBeenCalled()
  })

  it('多次短读完整收集 UTF-8 与 BOM，revision 按字节计算', async () => {
    const content = '\uFEFF{"extra":"中文","mcpServers":{}}'
    const file = mockFile(Buffer.from(content), Buffer.byteLength(content), 2)
    const root = resolve('test-root')
    const result = await readMcpConfigText(`${root}/mcp.json`, root)
    expect(result.content).toBe(content)
    expect(result.revision).toBe(mcpConfigRevision(content))
    expect(file.read.mock.calls.length).toBeGreaterThan(2)
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('stat 后增长只读取上限加一字节，不返回部分内容', async () => {
    const file = mockFile(Buffer.alloc(MCP_CONFIG_FILE_MAX_BYTES + 100, 0x20), 2)
    const root = resolve('test-root')
    const result = await readMcpConfigText(`${root}/mcp.json`, root)
    expect(result.tooLarge).toBe(true)
    expect(result.content).toBe('')
    expect(result.revision).toBeNull()
    expect(file.read).toHaveBeenCalledOnce()
    expect(file.read.mock.calls[0]?.[2]).toBe(MCP_CONFIG_FILE_MAX_BYTES + 1)
    expect(file.close).toHaveBeenCalledOnce()
  })
})
