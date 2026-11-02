/**
 * MCP 工具到 Pi ToolDefinition 的适配与结果转换（G1.4d2b）。
 *
 * 选择性移植自 `@earendil-works/pi-coding-agent@1.4.0` 的
 * `packages/coding-agent/src/extensions/mcp/tools.ts` 与 `utils/output-files.ts`，
 * 来源指纹与本地差异见 `packages/mcp/THIRD-PARTY-NOTICES.md`。
 *
 * 本地差异：
 * - 不复制 TUI renderers，也不导入任何私有渲染/截断工具；
 * - 完整输出写入新建的临时目录，文件 0600；
 * - 只通过公开类型描述 Pi 工具结果，不额外依赖 pi-ai/agent-core；
 * - 保存失败不回显原始异常。
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentToolResult,
  McpExposure,
  ToolAnnotations,
  ToolDefinition,
  ToolNamespace,
} from '@earendil-works/pi-coding-agent'
import { formatSize } from '@earendil-works/pi-coding-agent'
import type {
  CallToolResult,
  ContentBlock,
  LlmContent,
  McpRequestOptions,
  Tool as McpTool,
} from '@earendil-works/pi-mcp'
import { toLlmContent } from '@earendil-works/pi-mcp'

/** Pi ToolDefinition 使用的 JSON Schema 类型；从公开类型推导，避免直接依赖 typebox。 */
export type JsonSchema = ToolDefinition['parameters']
/** 供包内桥接使用的具体工具定义。 */
export type McpToolDefinition = ToolDefinition<JsonSchema, McpToolDetails>

/** Pi 的 exposure 与 MCP exposure 不完全同名：codemode 在 Pi 侧表现为 deferred。 */
export function toToolExposure(
  exposure: McpExposure,
): 'codemode' | 'deferred' | 'direct' | 'hidden' {
  return exposure === 'codemode' ? 'deferred' : exposure
}

const MAX_TOOL_NAME_LENGTH = 64
/** 模型可见文本上限；超出时从中间截断。 */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024
const OUTPUT_FILE_MODE = 0o600
const OUTPUT_DIR_MODE = 0o700

export interface McpToolDetails {
  server: string
  tool: string
  /** 完整文本输出被截断时保存到临时文件的路径。 */
  fullOutputPath?: string
}

/** 保存完整输出或二进制资源；扩展名包含点。 */
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>

/** 写入权限受限的新临时文件；目录每次新建以缩小可预测性。 */
export async function saveToTempFile(
  data: string | Uint8Array,
  extension: string,
): Promise<string> {
  const safeExtension = /^\.[A-Za-z0-9]{1,8}$/.test(extension) ? extension : '.bin'
  const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-'))
  try {
    await chmod(dir, OUTPUT_DIR_MODE)
  } catch {
    // Windows 不保证 POSIX 权限；文件仍以 wx + 0600 新建。
  }
  const path = join(dir, `output-${randomBytes(8).toString('hex')}${safeExtension}`)
  // `wx` 不会跟随他人预先放置的链接。
  await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: 'wx' })
  return path
}

export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult>
}

/**
 * `mcp__<server>__<tool>`；除 `[A-Za-z0-9_]` 外都替换为 `_`，超长或冲突时加哈希后缀。
 * `isTaken` 由调用方用 Map 维护，保证同一目录内所有规范化碰撞项都带后缀。
 */
export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8)
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`
}

function textOf(content: readonly LlmContent[]): string {
  return content
    .filter((block): block is Extract<LlmContent, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** 一行文本的计数口径与官方一致：末尾换行不计额外一行。 */
function countLines(content: string): number {
  if (content.length === 0) return 0
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines.length
}

interface Truncation {
  content: string
  truncated: boolean
  totalBytes: number
  totalLines: number
}

/** 按 UTF-8 字节从中间截断，保证不会切断多字节字符。 */
function truncateMiddle(content: string, maxBytes: number): Truncation {
  const buffer = Buffer.from(content, 'utf-8')
  const totalLines = countLines(content)
  if (buffer.length <= maxBytes) {
    return { content, truncated: false, totalBytes: buffer.length, totalLines }
  }
  const isBoundary = (index: number) => {
    const value = buffer[index]
    return index >= buffer.length || value === undefined || (value & 0xc0) !== 0x80
  }
  let headEnd = Math.floor(maxBytes / 2)
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd -= 1
  let tailStart = buffer.length - (maxBytes - Math.floor(maxBytes / 2))
  while (tailStart < buffer.length && !isBoundary(tailStart)) tailStart += 1
  const head = buffer.subarray(0, headEnd).toString('utf-8')
  const tail = buffer.subarray(tailStart).toString('utf-8')
  const removedChars = Array.from(buffer.subarray(headEnd, tailStart).toString('utf-8')).length
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    totalBytes: buffer.length,
    totalLines,
  }
}

/** 限制模型可见文本；长文本保留首尾，完整文本写入临时文件。图片原样保留。 */
export async function limitMcpContent(
  content: LlmContent[],
  saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{ content: LlmContent[]; fullOutputPath?: string }> {
  const combined = textOf(content)
  const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES)
  if (!truncation.truncated) return { content }
  let fullOutputPath: string | undefined
  let where: string
  try {
    fullOutputPath = await saveOutput(combined, '.txt')
    where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`
  } catch {
    // 不向模型回显保存异常或路径细节。
    where = '[Could not save the full output]'
  }
  const tokens = Math.ceil(truncation.totalBytes / 4)
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`
  return {
    content: [{ type: 'text', text }, ...content.filter((block) => block.type === 'image')],
    ...(fullOutputPath ? { fullOutputPath } : {}),
  }
}

/** 所有 MCP 工具声明的输出结构：脚本收到的 CallToolResult（不含 _meta）。 */
export function createMcpResultSchema(
  structuredContentSchema: Record<string, unknown> | undefined,
): JsonSchema {
  return {
    type: 'object',
    properties: {
      content: { type: 'array', items: CONTENT_BLOCK_SCHEMA },
      // 服务器可能未声明 structuredContent 结构，且它可以是任意 JSON 值。
      structuredContent: structuredContentSchema
        ? relocateSchema(structuredContentSchema, '#/properties/structuredContent')
        : {},
      isError: { type: 'boolean' },
    },
    required: ['content'],
    // 新协议版本可能增加字段。
    additionalProperties: true,
  } as unknown as JsonSchema
}

const CONTENT_BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    type: { enum: ['text', 'image', 'audio', 'resource_link', 'resource'] },
    text: { type: 'string' },
    data: { type: 'string' },
    mimeType: { type: 'string' },
  },
  required: ['type'],
  additionalProperties: true,
}

/** 这些关键字的值是数据，其中的 `$ref` 不是引用。 */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(['const', 'enum', 'default', 'examples'])
/** 这些关键字的值是名称到 schema 的映射，键不是 schema 关键字。 */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  '$defs',
  'definitions',
])

/** 把局部 `$ref` 重定位到另一个 schema 的 `pointer` 之下。 */
function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer))
  if (typeof schema !== 'object' || schema === null) return schema
  const relocated: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' && (value === '#' || value.startsWith('#/'))) {
      relocated[key] = `${pointer}${value.slice(1)}`
    } else if (SCHEMA_DATA_KEYWORDS.has(key)) {
      relocated[key] = value
    } else if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      relocated[key] = Object.fromEntries(
        Object.entries(value).map(([name, subschema]) => [
          name,
          relocateSchema(subschema, pointer),
        ]),
      )
    } else {
      relocated[key] = relocateSchema(value, pointer)
    }
  }
  return relocated
}

/** 常见文本 MIME 以内联文本返回，其它二进制保存到临时文件。 */
function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  const [first] = mimeType.split(';', 1)
  const type = (first ?? '').trim().toLowerCase()
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  )
}

function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? '.bin'
}

export interface ConvertMcpResultOptions {
  /** 保存截断文本和二进制资源；默认写临时文件。 */
  saveOutput?: McpOutputSaver
  /** 资源链接是否可由 read_mcp_resource 读取。 */
  readableResources?: boolean
}

async function blockToContent(
  server: string,
  block: ContentBlock,
  options: ConvertMcpResultOptions,
): Promise<LlmContent[]> {
  if (block.type === 'resource_link') {
    const details = [
      block.mimeType,
      block.size === undefined ? undefined : formatSize(block.size),
    ].filter(Boolean)
    const read = options.readableResources
      ? `. Read it with read_mcp_resource (server "${server}")`
      : ''
    const description = block.description ? `: ${block.description}` : ''
    return [
      {
        type: 'text',
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(', ')})` : ''}${description}${read}]`,
      },
    ]
  }
  if (
    block.type === 'resource' &&
    'blob' in block.resource &&
    !block.resource.mimeType?.startsWith('image/')
  ) {
    const { uri, mimeType, blob } = block.resource
    const data = Buffer.from(blob, 'base64')
    if (isTextMimeType(mimeType)) return [{ type: 'text', text: data.toString('utf8') }]
    const kind = `${mimeType ?? 'unknown type'}, ${formatSize(data.length)}`
    try {
      const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri))
      return [{ type: 'text', text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }]
    } catch {
      return [{ type: 'text', text: `[Binary resource ${uri} (${kind}) could not be saved]` }]
    }
  }
  return toLlmContent({ content: [block] })
}

/** 把 MCP 内容块转换为模型可见文本/图片，尚未做长度限制。 */
export async function toModelContent(
  server: string,
  blocks: readonly ContentBlock[],
  options: ConvertMcpResultOptions = {},
): Promise<LlmContent[]> {
  const converted = await Promise.all(blocks.map((block) => blockToContent(server, block, options)))
  return converted.flat()
}

/** 转换 MCP 工具结果；isError 结果仍保留 structuredContent 并标记为错误。 */
export async function convertMcpResult(
  server: string,
  tool: string,
  result: CallToolResult,
  options: ConvertMcpResultOptions = {},
): Promise<AgentToolResult<McpToolDetails>> {
  // 没有内容块时，toLlmContent 会用 structuredContent 的 JSON 兜底。
  const converted: LlmContent[] =
    result.content.length > 0
      ? await toModelContent(server, result.content, options)
      : toLlmContent(result)
  if (result.isError && textOf(converted) === '') {
    converted.push({ type: 'text', text: `MCP tool ${server}/${tool} returned an error` })
  }
  const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput)
  const { _meta: _ignored, ...scriptResult } = result
  return {
    content,
    details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
    structuredContent: scriptResult as unknown as AgentToolResult['structuredContent'],
    ...(result.isError ? { isError: true } : {}),
  }
}

/** 工具 inputSchema 必须是对象；服务器可能省略 type。 */
function toParameters(schema: Record<string, unknown>): JsonSchema {
  return {
    ...schema,
    type: schema.type ?? 'object',
    ...(schema.properties === undefined ? { properties: {} } : {}),
  } as unknown as JsonSchema
}

const ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const

/** 只保留布尔 annotations，不透传服务端任意字段。 */
function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
  const annotations: ToolAnnotations = {}
  for (const hint of ANNOTATION_HINTS) {
    const value = tool.annotations?.[hint]
    if (typeof value === 'boolean') annotations[hint] = value
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}

export interface CreateMcpToolDefinitionOptions {
  server: string
  tool: McpTool
  name: string
  exposure: McpExposure
  namespace: ToolNamespace
  timeoutMs: number
  /** 每次执行都解析当前 manager 的连接，不能持有旧 connection。 */
  getClient: () => Promise<McpToolCaller>
  /** 调用时判断资源链接是否可由 read_mcp_resource 读取。 */
  readableResources?: () => boolean
}

/** 创建一个 Pi 工具定义；执行仍走正常 ToolDefinition.execute 与 SDK 权限 hook。 */
export function createMcpToolDefinition(
  options: CreateMcpToolDefinitionOptions,
): McpToolDefinition {
  const { server, tool } = options
  const title = tool.title ?? tool.annotations?.title
  const annotations = toToolAnnotations(tool)
  return {
    name: options.name,
    label: `${server}/${tool.name}`,
    description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
    parameters: toParameters(tool.inputSchema),
    outputSchema: createMcpResultSchema(tool.outputSchema),
    exposure: toToolExposure(options.exposure),
    namespace: options.namespace,
    ...(annotations ? { annotations } : {}),
    async execute(_toolCallId, params, signal, onUpdate) {
      const caller = await options.getClient()
      const result = await caller.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
        ...(signal ? { signal } : {}),
        timeoutMs: options.timeoutMs,
        onProgress: (progress) => {
          const total = progress.total === undefined ? '' : `/${progress.total}`
          const text = progress.message ?? `Progress ${progress.progress}${total}`
          onUpdate?.({
            content: [{ type: 'text', text }],
            details: { server, tool: tool.name },
          })
        },
      })
      return convertMcpResult(server, tool.name, result, {
        readableResources: options.readableResources?.(),
      })
    },
  }
}
