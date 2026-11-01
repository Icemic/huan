// 最小 MCP 协议 fixture：stdio 与 HTTP 测试脚本共用。只实现测试需要的 MCP 方法。

import { appendFileSync } from 'node:fs'

const METHOD_NOT_FOUND = -32601

export function createState(env = process.env) {
  return {
    env,
    tools: [
      {
        name: 'echo',
        description: 'Echo text back',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: 'side-effect',
        description: 'Append a line to the side effect file',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'slow',
        description: 'Slow tool with progress notifications',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: 'fail-after-side-effect',
        description: 'Append a line, then fail',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'add-dynamic-tool',
        description: 'Add dynamic_tool and send list_changed',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    dynamicAdded: false,
    cancelled: new Set(),
    initAttempts: 0,
    initSuccesses: 0,
    toolListCalls: 0,
    resourceListCalls: 0,
    templateListCalls: 0,
    readCalls: 0,
    resource500Served: false,
  }
}

export function appendSideEffect(state, name) {
  const file = state.env.FIXTURE_SIDE_EFFECT_FILE
  if (file) appendFileSync(file, `${name}\n`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function resourcePage(state, cursor) {
  const pageSize = Number(state.env.FIXTURE_RESOURCE_PAGE_SIZE ?? 2)
  const count = Number(state.env.FIXTURE_RESOURCE_COUNT ?? 3)
  const offset = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid cursor')
  const end = Math.min(count, offset + pageSize)
  const resources = []
  for (let index = offset; index < end; index += 1) {
    resources.push({
      uri: `resource://fixture/${index}`,
      name: `resource-${index}`,
      mimeType: 'text/plain',
    })
  }
  return { resources, ...(end < count ? { nextCursor: String(end) } : {}) }
}

function templatePage(state, cursor) {
  const pageSize = Number(state.env.FIXTURE_TEMPLATE_PAGE_SIZE ?? 2)
  const count = Number(state.env.FIXTURE_TEMPLATE_COUNT ?? 3)
  const offset = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid cursor')
  const end = Math.min(count, offset + pageSize)
  const resourceTemplates = []
  for (let index = offset; index < end; index += 1) {
    resourceTemplates.push({
      uriTemplate: `resource://fixture/template/{id}-${index}`,
      name: `template-${index}`,
      mimeType: 'text/plain',
    })
  }
  return { resourceTemplates, ...(end < count ? { nextCursor: String(end) } : {}) }
}

async function callTool(message, state, notify) {
  const name = message.params?.name
  const args = message.params?.arguments ?? {}
  const progressToken = message.params?._meta?.progressToken

  if (name === 'echo') return textResult(`echo:${String(args.text ?? '')}`)

  if (name === 'side-effect') {
    appendSideEffect(state, name)
    return textResult('side effect done')
  }

  if (name === 'fail-after-side-effect') {
    appendSideEffect(state, name)
    return { error: { code: -32000, message: 'fixture tool failed' } }
  }

  if (name === 'slow') {
    const waitMs = Number(state.env.FIXTURE_CALL_DELAY_MS ?? 300)
    if (progressToken !== undefined) {
      notify?.('notifications/progress', {
        progressToken,
        progress: 0,
        total: 3,
        message: 'started',
      })
    }
    await delay(waitMs)
    if (state.cancelled.has(message.id)) return { cancelled: true }
    if (progressToken !== undefined) {
      notify?.('notifications/progress', {
        progressToken,
        progress: 2,
        total: 3,
        message: 'working',
      })
    }
    await delay(Math.min(50, waitMs))
    if (state.cancelled.has(message.id)) return { cancelled: true }
    appendSideEffect(state, name)
    if (progressToken !== undefined) {
      notify?.('notifications/progress', {
        progressToken,
        progress: 3,
        total: 3,
        message: 'done',
      })
    }
    return textResult(`slow:${String(args.text ?? '')}`)
  }

  if (name === 'dynamic_tool') return textResult('dynamic:ok')

  if (name === 'add-dynamic-tool') {
    if (!state.dynamicAdded) {
      state.dynamicAdded = true
      state.tools.push({
        name: 'dynamic_tool',
        description: 'Added after connect',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })
      notify?.('notifications/tools/list_changed', undefined)
    }
    return textResult('dynamic tool added')
  }

  return { error: { code: -32602, message: `unknown tool: ${name}` } }
}

/** 处理一个 JSON-RPC 请求，返回 {result} / {error}；通知返回 undefined。 */
export async function handleRequest(message, state, notify) {
  switch (message.method) {
    case 'initialize': {
      state.initAttempts += 1
      state.initSuccesses += 1
      return {
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
          capabilities: {
            ...(state.env.FIXTURE_NO_TOOLS ? {} : { tools: { listChanged: true } }),
            ...(state.env.FIXTURE_NO_RESOURCES ? {} : { resources: {} }),
          },
          serverInfo: { name: 'fixture', version: '1.0.0' },
          instructions: 'Fixture server instructions',
        },
      }
    }
    case 'ping':
      return { result: {} }
    case 'tools/list': {
      state.toolListCalls += 1
      const waitMs = Number(state.env.FIXTURE_TOOLS_LIST_DELAY_MS ?? 0)
      if (waitMs > 0) await delay(waitMs)
      if (state.env.FIXTURE_TOOLS_LIST_FAIL_ONCE === '1' && state.toolListCalls === 1) {
        return { error: { code: -32603, message: 'fixture tools/list failed' } }
      }
      return { result: { tools: state.tools.map((tool) => ({ ...tool })) } }
    }
    case 'tools/call': {
      const result = await callTool(message, state, notify)
      if (result?.error || result?.cancelled) return result
      return { result }
    }
    case 'resources/list': {
      state.resourceListCalls += 1
      if (state.env.FIXTURE_RESOURCE_500_ONCE === '1' && !state.resource500Served) {
        state.resource500Served = true
        return { httpStatus: 500 }
      }
      return { result: resourcePage(state, message.params?.cursor) }
    }
    case 'resources/templates/list': {
      state.templateListCalls += 1
      if (state.env.FIXTURE_NO_TEMPLATES === '1') {
        return { error: { code: METHOD_NOT_FOUND, message: 'Method not found' } }
      }
      return { result: templatePage(state, message.params?.cursor) }
    }
    case 'resources/read': {
      state.readCalls += 1
      const uri = message.params?.uri
      return {
        result: {
          contents: [{ uri, mimeType: 'text/plain', text: `resource:${uri}` }],
        },
      }
    }
    default:
      return { error: { code: METHOD_NOT_FOUND, message: 'Method not found' } }
  }
}

/** 处理客户端通知。 */
export function handleNotification(message, state) {
  if (message.method === 'notifications/cancelled') {
    const requestId = message.params?.requestId
    if (requestId !== undefined) state.cancelled.add(requestId)
  }
}
