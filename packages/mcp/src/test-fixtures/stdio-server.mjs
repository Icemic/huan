// 真实 stdio MCP 测试服务器。逐行读取 JSON-RPC，逐行写回。
// 环境变量用于控制慢初始化、动态工具、进度/取消与孙进程回收测试。

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createState, handleNotification, handleRequest } from './mcp-protocol.mjs'

const state = createState(process.env)
const slowInitMs = Number(process.env.FIXTURE_SLOW_INIT_MS ?? 0)
const grandchild = process.env.FIXTURE_GRANDCHILD === '1'

let grandchildProcess
if (grandchild) {
  grandchildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  if (process.env.FIXTURE_GRANDCHILD_PID_FILE && grandchildProcess.pid) {
    writeFileSync(process.env.FIXTURE_GRANDCHILD_PID_FILE, String(grandchildProcess.pid))
  }
}
if (process.env.FIXTURE_PID_FILE) {
  writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid))
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, error) {
  send({ jsonrpc: '2.0', id, error })
}

async function handle(message) {
  if (message.id === undefined) {
    handleNotification(message, state)
    return
  }
  if (message.method === 'initialize' && slowInitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, slowInitMs))
  }
  const response = await handleRequest(message, state, notify)
  if (response.cancelled) return
  if (response.error) sendError(message.id, response.error)
  else sendResult(message.id, response.result)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    void handle(message).catch((error) => {
      if (message.id !== undefined) sendError(message.id, { code: -32603, message: String(error) })
    })
  }
})

function shutdown() {
  // 不主动清理孙进程：由 transport 的进程组/tree 关闭逻辑负责回收。
  process.exit(0)
}
// 不监听 stdin end：留着孙进程句柄，让 transport 的 SIGTERM/tree kill 能先回收整组。
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
