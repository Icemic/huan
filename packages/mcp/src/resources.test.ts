/**
 * MCP 资源工具测试（G1.4d2b）。
 *
 * 覆盖分页/全量、模板、部分服务器失败、MCP Apps/icons/_meta 过滤、
 * 读取拒绝 App 内容、二进制/图片与 exposure 映射。
 */

import type { Resource, ResourceTemplate } from '@earendil-works/pi-mcp'
import { describe, expect, it } from 'vitest'
import {
  createMcpResourceToolDefinitions,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  LIST_MCP_RESOURCES_TOOL,
  type McpResourceServer,
  READ_MCP_RESOURCE_TOOL,
} from './index.js'

type ToolResult = Awaited<ReturnType<ReturnType<typeof definitions>[number]['execute']>>

function definitions(
  servers: McpResourceServer[],
  exposure: 'codemode' | 'direct' | 'deferred' | 'hidden' = 'codemode',
) {
  return createMcpResourceToolDefinitions({ exposure, servers: () => servers })
}

function find(defs: ReturnType<typeof definitions>, name: string) {
  const definition = defs.find((candidate) => candidate.name === name)
  if (!definition) throw new Error(`missing definition: ${name}`)
  return definition
}

async function call(
  defs: ReturnType<typeof definitions>,
  name: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  return find(defs, name).execute('call', params, undefined, undefined, undefined as never)
}

function makeServer(name: string, overrides: Partial<McpResourceServer> = {}): McpResourceServer {
  return {
    name,
    timeoutMs: 1000,
    resourcesPage: async () => ({ resources: [] }),
    resourceTemplatesPage: async () => ({ resourceTemplates: [] }),
    allResources: async () => [],
    allResourceTemplates: async () => [],
    readResource: async () => ({ contents: [] }),
    ...overrides,
  }
}

const alphaResources: Resource[] = [
  {
    uri: 'file:///tmp/a.txt',
    name: 'a',
    mimeType: 'text/plain',
    _meta: { secret: true },
    icons: [{ src: 'icon.png' }],
  } as Resource & { icons: unknown },
  {
    uri: 'ui://widget/app',
    name: 'app',
    mimeType: 'text/html; profile=mcp-app',
  },
]

const alphaTemplates: ResourceTemplate[] = [
  {
    uriTemplate: 'file:///{path}',
    name: 'files',
    _meta: { secret: true },
  },
  {
    uriTemplate: 'ui://widget/{id}',
    name: 'widget',
    mimeType: 'text/html; profile=mcp-app',
  },
]

describe('MCP 资源列表', () => {
  it('无 server 时汇总所有服务器，部分失败只返回受控错误', async () => {
    const alpha = makeServer('alpha', {
      allResources: async () => alphaResources,
      allResourceTemplates: async () => alphaTemplates,
    })
    const beta = makeServer('beta', {
      allResources: async () => {
        throw new Error('secret https://token@example.com')
      },
      allResourceTemplates: async () => {
        throw new Error('secret templates')
      },
    })
    const list = await call(definitions([beta, alpha], 'direct'), LIST_MCP_RESOURCES_TOOL, {})
    const structured = list.structuredContent as {
      resources: Record<string, unknown>[]
      errors?: { server: string; error: string }[]
    }
    expect(structured.resources).toHaveLength(1)
    expect(structured.resources[0]).toMatchObject({ server: 'alpha', name: 'a' })
    expect(structured.resources[0]?._meta).toBeUndefined()
    expect((structured.resources[0] as { icons?: unknown })?.icons).toBeUndefined()
    expect(structured.errors).toEqual([{ server: 'beta', error: '无法列出该服务器的资源。' }])
    expect(JSON.stringify(structured)).not.toContain('token')

    const templates = await call(
      definitions([alpha, beta], 'direct'),
      LIST_MCP_RESOURCE_TEMPLATES_TOOL,
      {},
    )
    const structuredTemplates = templates.structuredContent as {
      resourceTemplates: Record<string, unknown>[]
      errors?: { server: string; error: string }[]
    }
    expect(structuredTemplates.resourceTemplates).toEqual([
      {
        server: 'alpha',
        uriTemplate: 'file:///{path}',
        name: 'files',
      },
    ])
    expect(structuredTemplates.errors).toEqual([
      { server: 'beta', error: '无法列出该服务器的资源。' },
    ])
  })

  it('指定 server 时支持分页游标并过滤 App', async () => {
    const cursors: (string | undefined)[] = []
    const alpha = makeServer('alpha', {
      resourcesPage: async (cursor) => {
        cursors.push(cursor)
        return {
          resources: alphaResources,
          ...(cursor === undefined ? { nextCursor: 'next-page' } : {}),
        }
      },
    })
    const result = await call(definitions([alpha]), LIST_MCP_RESOURCES_TOOL, {
      server: 'alpha',
    })
    expect(cursors).toEqual([undefined])
    const structured = result.structuredContent as {
      server: string
      resources: { uri: string }[]
      nextCursor?: string
    }
    expect(structured.server).toBe('alpha')
    expect(structured.resources.map((item) => item.uri)).toEqual(['file:///tmp/a.txt'])
    expect(structured.nextCursor).toBe('next-page')
    await expect(
      call(definitions([alpha]), LIST_MCP_RESOURCES_TOOL, { cursor: 'orphan' }),
    ).rejects.toThrow(/cursor/)
  })
})

describe('MCP 资源读取', () => {
  it('文本/图片内容转换，多内容按 URI 标注', async () => {
    const alpha = makeServer('alpha', {
      readResource: async () => ({
        contents: [
          { uri: 'file:///tmp/note.txt', mimeType: 'text/plain', text: 'hello' },
          {
            uri: 'file:///tmp/image.png',
            mimeType: 'image/png',
            blob: Buffer.from('png').toString('base64'),
          },
        ],
      }),
    })
    const result = await call(definitions([alpha], 'codemode'), READ_MCP_RESOURCE_TOOL, {
      server: 'alpha',
      uri: 'file:///tmp/note.txt',
    })
    expect(result.content).toEqual([
      { type: 'text', text: 'file:///tmp/note.txt:' },
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'file:///tmp/image.png:' },
      { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
    ])
    const structured = result.structuredContent as {
      server: string
      uri: string
      contents: unknown[]
    }
    expect(structured.contents).toHaveLength(2)
  })

  it('拒绝已知 MCP App URI 与内容', async () => {
    const read: string[] = []
    const alpha = makeServer('alpha', {
      readResource: async (uri) => {
        read.push(uri)
        return {
          contents: [
            {
              uri,
              mimeType: 'text/html; profile=mcp-app',
              text: '<html></html>',
            },
          ],
        }
      },
    })
    const defs = definitions([alpha])
    await expect(
      call(defs, READ_MCP_RESOURCE_TOOL, { server: 'alpha', uri: 'ui://widget/app' }),
    ).rejects.toThrow(/MCP App/)
    expect(read).toEqual([])
    await expect(
      call(defs, READ_MCP_RESOURCE_TOOL, {
        server: 'alpha',
        uri: 'file:///tmp/app.html',
      }),
    ).rejects.toThrow(/MCP App/)
  })

  it('server 不存在时列出可用资源服务器', async () => {
    const defs = definitions([makeServer('alpha')])
    await expect(
      call(defs, READ_MCP_RESOURCE_TOOL, { server: 'missing', uri: 'file:///x' }),
    ).rejects.toThrow(/alpha/)
  })
})

describe('MCP 资源工具 exposure', () => {
  it('codemode 映射为 deferred，direct 保持 direct，hidden 保持 hidden', () => {
    expect(definitions([], 'codemode')[0]?.exposure).toBe('deferred')
    expect(definitions([], 'direct')[0]?.exposure).toBe('direct')
    expect(definitions([], 'hidden')[0]?.exposure).toBe('hidden')
  })
})
