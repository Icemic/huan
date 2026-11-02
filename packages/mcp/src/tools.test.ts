/**
 * MCP 工具命名与结果转换测试（G1.4d2b）。
 *
 * 覆盖规范化/长度/碰撞、UTF-8 中间截断、完整结构化结果、资源链接与二进制、
 * schema 局部引用重定位、annotations 过滤及真实临时文件权限。
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CallToolResult } from '@earendil-works/pi-mcp'
import { describe, expect, it } from 'vitest'
import {
  convertMcpResult,
  createMcpResultSchema,
  createMcpToolDefinition,
  createMcpToolName,
  limitMcpContent,
  MCP_OUTPUT_MAX_BYTES,
  saveToTempFile,
} from './index.js'

const text = (value: string) => ({ type: 'text' as const, text: value })

describe('MCP 工具命名', () => {
  it('规范化非法字符、保留稳定名称并限制 64 字符', () => {
    expect(createMcpToolName('docs', 'read-file')).toBe('mcp__docs__read_file')
    const long = createMcpToolName('server', 'x'.repeat(100))
    expect(long.length).toBe(64)
    expect(long).toMatch(/_[0-9a-f]{8}$/)
    expect(createMcpToolName('server', 'x'.repeat(100))).toBe(long)
  })

  it('同一目录内规范化碰撞的两项都带哈希后缀', () => {
    const names = ['a-b', 'a_b']
    const counts = new Map<string, number>()
    for (const name of names) {
      const plain = createMcpToolName('srv', name)
      counts.set(plain, (counts.get(plain) ?? 0) + 1)
    }
    const assigned = names.map((name) =>
      createMcpToolName('srv', name, (candidate) => (counts.get(candidate) ?? 0) > 1),
    )
    expect(assigned[0]).not.toBe(assigned[1])
    expect(assigned.every((name) => name.length <= 64)).toBe(true)
  })
})

describe('MCP 结果 schema', () => {
  it('把 structuredContent 的局部引用重定位到 CallToolResult 之下', () => {
    const schema = createMcpResultSchema({
      type: 'object',
      properties: { item: { $ref: '#/$defs/Item' } },
      $defs: { Item: { type: 'string' } },
    }) as unknown as {
      properties: {
        structuredContent: {
          properties: { item: { $ref: string } }
          $defs: unknown
        }
      }
    }
    expect(schema.properties.structuredContent.properties.item.$ref).toBe(
      '#/properties/structuredContent/$defs/Item',
    )
    expect(schema.properties.structuredContent.$defs).toEqual({ Item: { type: 'string' } })
  })
})

describe('MCP 输出截断', () => {
  it('超过 20KiB 时按 UTF-8 边界截断中间并保存完整文本', async () => {
    const full = '你'.repeat(10_000)
    const saved: { data: string | Uint8Array; extension: string }[] = []
    const result = await limitMcpContent(
      [text(full), { type: 'image', data: 'AA==', mimeType: 'image/png' }],
      async (data, extension) => {
        saved.push({ data, extension })
        return '/tmp/full.txt'
      },
    )
    expect(saved).toHaveLength(1)
    expect(saved[0]?.data).toBe(full)
    expect(saved[0]?.extension).toBe('.txt')
    expect(result.fullOutputPath).toBe('/tmp/full.txt')
    const truncated = result.content[0]
    expect(truncated?.type).toBe('text')
    if (truncated?.type !== 'text') throw new Error('missing text')
    expect(truncated.text).toContain('chars truncated')
    expect(truncated.text).toContain('[Full output: /tmp/full.txt')
    expect(truncated.text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(truncated.text)).toBeGreaterThan(MCP_OUTPUT_MAX_BYTES)
    expect(result.content.some((block) => block.type === 'image')).toBe(true)
  })

  it('保存失败只返回受控提示', async () => {
    const result = await limitMcpContent([text('x'.repeat(MCP_OUTPUT_MAX_BYTES * 2))], async () => {
      throw new Error('secret /home/user/token')
    })
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('missing text')
    expect(block.text).toContain('[Could not save the full output]')
    expect(block.text).not.toContain('secret')
  })

  it('真实临时文件为 0600 且内容完整', async () => {
    const path = await saveToTempFile('full text', '.txt')
    try {
      expect(await readFile(path, 'utf8')).toBe('full text')
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(dirname(path), { recursive: true, force: true })
    }
  })
})

describe('MCP 结果转换', () => {
  it('保留结构化结果、isError，并剔除顶层 _meta', async () => {
    const result: CallToolResult = {
      content: [text('ok')],
      structuredContent: { value: 1 },
      isError: true,
      _meta: { secret: 'hidden' },
    }
    const converted = await convertMcpResult('srv', 'tool', result)
    expect(converted.isError).toBe(true)
    expect(converted.details).toEqual({ server: 'srv', tool: 'tool' })
    const structured = converted.structuredContent as { content: unknown; _meta?: unknown }
    expect(structured.content).toEqual(result.content)
    expect(structured._meta).toBeUndefined()
  })

  it('空错误结果补一条错误文本', async () => {
    const converted = await convertMcpResult('srv', 'tool', { content: [], isError: true })
    const block = converted.content[0]
    if (block?.type !== 'text') throw new Error('missing text')
    expect(block.text).toContain('returned an error')
  })

  it('资源链接提示 read_mcp_resource，二进制保存并保留扩展名', async () => {
    const saved: string[] = []
    const converted = await convertMcpResult(
      'srv',
      'tool',
      {
        content: [
          {
            type: 'resource_link',
            uri: 'file:///tmp/report.json',
            name: 'report',
            mimeType: 'application/json',
            size: 2048,
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/data.bin',
              mimeType: 'application/octet-stream',
              blob: Buffer.from('binary').toString('base64'),
            },
          },
        ],
      },
      {
        readableResources: true,
        saveOutput: async (_data, extension) => {
          saved.push(extension)
          return `/tmp/saved${extension}`
        },
      },
    )
    const all = converted.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    expect(all).toContain('read_mcp_resource')
    expect(all).toContain('2.0KB')
    expect(all).toContain('/tmp/saved.bin')
    expect(saved).toEqual(['.bin'])
  })

  it('文本 MIME 的 blob 内联，图片仍交给模型', async () => {
    const converted = await convertMcpResult('srv', 'tool', {
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///tmp/note.txt',
            mimeType: 'text/plain',
            blob: Buffer.from('hello text').toString('base64'),
          },
        },
        {
          type: 'image',
          data: 'AA==',
          mimeType: 'image/png',
        },
      ],
    })
    expect(converted.content).toEqual([
      { type: 'text', text: 'hello text' },
      { type: 'image', data: 'AA==', mimeType: 'image/png' },
    ])
  })
})

describe('MCP 工具定义', () => {
  it('执行时解析当前 caller 并把进度映射为 onUpdate', async () => {
    const updates: unknown[] = []
    const definition = createMcpToolDefinition({
      server: 'srv',
      tool: {
        name: 'echo',
        description: 'Echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        annotations: { readOnlyHint: true, title: 'not-boolean' },
      },
      name: 'mcp__srv__echo',
      exposure: 'codemode',
      namespace: { name: 'mcp__srv', aliases: ['srv'] },
      timeoutMs: 1000,
      getClient: async () => ({
        callTool: async (_name, _args, options) => {
          options.onProgress?.({ progressToken: 'token', progress: 1, total: 2, message: 'half' })
          return { content: [text('done')] }
        },
      }),
    })
    expect(definition.exposure).toBe('deferred')
    expect(definition.annotations).toEqual({ readOnlyHint: true })
    expect(definition.parameters).toMatchObject({ type: 'object' })
    expect(definition.outputSchema).toBeDefined()
    const result = await definition.execute(
      'call',
      { text: 'hi' },
      undefined,
      (update) => updates.push(update),
      undefined as never,
    )
    expect(updates).toHaveLength(1)
    expect(result.details).toEqual({ server: 'srv', tool: 'echo' })
  })
})
