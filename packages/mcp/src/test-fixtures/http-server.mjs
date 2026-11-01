// 真实本地 Streamable HTTP MCP 测试服务器。POST 处理 JSON-RPC，GET 返回 405，
// DELETE 结束会话。环境变量用于认证、连接退避、只读重试与 tools/call 404 测试。

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createState, handleNotification, handleRequest } from './mcp-protocol.mjs'

const state = createState(process.env)
const requireToken = process.env.FIXTURE_REQUIRE_TOKEN
const rejectAllAuth = process.env.FIXTURE_REJECT_ALL_AUTH === '1'
const initFails = Number(process.env.FIXTURE_INIT_FAILS ?? 0)
let initAttempts = 0

function logAuth(value) {
  if (process.env.FIXTURE_AUTH_LOG_FILE) {
    appendFileSync(process.env.FIXTURE_AUTH_LOG_FILE, `${value ?? ''}\n`)
  }
}

function appendSideEffect(name) {
  if (process.env.FIXTURE_SIDE_EFFECT_FILE) {
    appendFileSync(process.env.FIXTURE_SIDE_EFFECT_FILE, `${name}\n`)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body, sessionId) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  })
  res.end(payload)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(405, { allow: 'POST, DELETE' })
    res.end()
    return
  }
  if (req.method === 'DELETE') {
    res.writeHead(200)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }

  const auth = req.headers.authorization
  logAuth(auth)
  if (rejectAllAuth || (requireToken && auth !== `Bearer ${requireToken}`)) {
    res.writeHead(401, {
      'content-type': 'text/plain',
      'www-authenticate': 'Bearer realm="fixture"',
    })
    res.end('authentication required')
    return
  }

  let message
  try {
    message = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400)
    res.end('invalid json')
    return
  }
  if (Array.isArray(message)) {
    res.writeHead(400)
    res.end('batch not supported')
    return
  }
  if (process.env.FIXTURE_REQUEST_LOG_FILE) {
    appendFileSync(process.env.FIXTURE_REQUEST_LOG_FILE, `${message.method}\n`)
  }

  if (message.method === 'initialize') {
    initAttempts += 1
    if (initAttempts <= initFails) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('temporarily unavailable')
      return
    }
  }

  if (message.id === undefined) {
    handleNotification(message, state)
    res.writeHead(202)
    res.end()
    return
  }

  const sessionId = `fixture-session-${state.initSuccesses + 1}`

  if (
    message.method === 'tools/call' &&
    process.env.FIXTURE_TOOL_404 &&
    message.params?.name === process.env.FIXTURE_TOOL_404
  ) {
    appendSideEffect(message.params.name)
    res.writeHead(404, { 'content-type': 'text/plain', 'mcp-session-id': sessionId })
    res.end('session expired')
    return
  }
  if (
    message.method === 'tools/call' &&
    process.env.FIXTURE_TOOL_500 &&
    message.params?.name === process.env.FIXTURE_TOOL_500
  ) {
    appendSideEffect(message.params.name)
    res.writeHead(500, { 'content-type': 'text/plain', 'mcp-session-id': sessionId })
    res.end('temporarily failed')
    return
  }

  let response
  try {
    response = await handleRequest(message, state, () => undefined)
  } catch (error) {
    sendJson(res, 500, {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: String(error) },
    })
    return
  }

  if (response.httpStatus) {
    res.writeHead(response.httpStatus, { 'content-type': 'text/plain' })
    res.end('fixture http failure')
    return
  }
  if (response.cancelled) {
    res.writeHead(499)
    res.end()
    return
  }
  if (response.error) {
    sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: response.error }, sessionId)
    return
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result: response.result }, sessionId)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
