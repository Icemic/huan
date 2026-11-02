import { createTestSseResponse, TEST_BASE_URL } from '@huan/core/testing'
import { DEFAULT_TEST_REPLY } from './config.js'

/** 手动分段计划：每段需调用 `release()` 才输出，结束需调用 `finish()`。 */
export type ManualStreamPlan = {
  segments: string[]
}

/** 脚本化模型轮次：工具调用或最终文本；用于真实 SDK 工具路径。 */
export type ScriptedTurn = {
  tool?: { name: string; args: Record<string, unknown> }
  text?: string
}

/** 流状态：测试可查询完成数，确保断开/恢复断言不依赖固定睡眠。 */
export type ModelControlState = {
  /** 已写出 `[DONE]` 的模型请求数。 */
  completed: number
  /** 已有模型请求进入分段流（可安全 release）。 */
  active: boolean
}

type ActiveStream = {
  segments: string[]
  released: number
  finished: boolean
  waiters: Set<() => void>
}

/** 安装后进程内的 fetch 只应答合成 provider，其余地址直接失败。 */
export type ModelControl = {
  configure: (plan: ManualStreamPlan) => void
  /** 配置确定性的工具/文本轮次；每次模型请求消费一轮。 */
  configureTurns: (turns: ScriptedTurn[]) => void
  release: () => void
  finish: () => void
  reset: () => void
  state: () => ModelControlState
  restore: () => void
}

const TEST_ORIGIN = new URL(TEST_BASE_URL).origin
const TEST_PATH_PREFIX = `${new URL(TEST_BASE_URL).pathname.replace(/\/$/, '')}/`

type FetchInput = Parameters<typeof fetch>[0]

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

/** 等待条件成立；每次控制动作都会唤醒全部等待者。 */
async function waitFor(stream: ActiveStream, predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise<void>((resolve) => stream.waiters.add(resolve))
  }
}

/** 构造分段可控的 OpenAI-compatible SSE 响应。 */
function createManualResponse(
  stream: ActiveStream,
  onCompleted: () => void,
  onAborted: () => void,
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text))
      try {
        for (const [index, segment] of stream.segments.entries()) {
          await waitFor(stream, () => stream.released > index)
          write(
            chunk({
              id: 'chatcmpl-huan-e2e',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'huan-test',
              choices: [
                {
                  index: 0,
                  delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: segment },
                  finish_reason: null,
                },
              ],
            }),
          )
        }
        await waitFor(stream, () => stream.finished)
        write(
          chunk({
            id: 'chatcmpl-huan-e2e',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'huan-test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }),
        )
        write('data: [DONE]\n\n')
        controller.close()
        onCompleted()
      } catch {
        // 运行被取消时宿主会中断响应；测试不把它视为完成。
        onAborted()
        controller.error(new Error('e2e model stream aborted'))
      }
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 构造工具调用或文本轮次响应；真实 Pi SDK 负责执行工具并继续下一轮。 */
function createScriptedResponse(turn: ScriptedTurn): Response {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  const base = {
    id: 'chatcmpl-huan-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'huan-test',
  }
  if (turn.tool) {
    return new Response(
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_huan_e2e_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: turn.tool.name,
                    arguments: JSON.stringify(turn.tool.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  return new Response(
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: turn.text ?? '完成' },
          finish_reason: null,
        },
      ],
    }) +
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/**
 * 安装确定性模型控制。
 *
 * 只替换宿主进程的全局 fetch：真实 Pi SDK 仍按 OpenAI-compatible 协议解析
 * SSE；测试通过控制端点决定分几段输出、何时结束，从而精确制造「回复中途
 * 断线」场景。
 */
export function installModelControl(allowedOrigins: readonly string[] = []): ModelControl {
  const previous = globalThis.fetch
  const passthrough = new Set(allowedOrigins)
  let plan: ManualStreamPlan | undefined
  let turns: ScriptedTurn[] | undefined
  let turnIndex = 0
  let active: ActiveStream | undefined
  let completed = 0

  const wakeAll = (stream: ActiveStream) => {
    const waiters = [...stream.waiters]
    stream.waiters.clear()
    for (const resolve of waiters) resolve()
  }

  globalThis.fetch = (async (input: FetchInput, init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input)
    let synthetic = false
    let allowed = false
    try {
      const parsed = new URL(url)
      synthetic = parsed.origin === TEST_ORIGIN && parsed.pathname.startsWith(TEST_PATH_PREFIX)
      // 只放行显式声明的 loopback fixture origin，避免任意公网请求。
      allowed = passthrough.has(parsed.origin)
    } catch {
      // 非法 URL 按非预期请求处理。
    }
    if (allowed) return previous(input, init)
    if (!synthetic) throw new Error(`e2e 禁止非预期网络请求：${url}`)
    if (turns) {
      const turn = turns[turnIndex]
      if (turn) {
        turnIndex += 1
        completed += 1
        return createScriptedResponse(turn)
      }
      // 脚本轮次耗尽后回到默认确定性回复，避免污染后续用例。
      turns = undefined
      turnIndex = 0
    }
    if (!plan) return createTestSseResponse(DEFAULT_TEST_REPLY)

    const current = plan
    plan = undefined
    const stream: ActiveStream = {
      segments: current.segments,
      released: 0,
      finished: false,
      waiters: new Set(),
    }
    active = stream
    return createManualResponse(
      stream,
      () => {
        completed += 1
        if (active === stream) active = undefined
      },
      () => {
        if (active === stream) active = undefined
      },
    )
  }) as typeof fetch

  const release = () => {
    if (!active) throw new Error('没有等待释放的模型响应')
    active.released += 1
    wakeAll(active)
  }

  return {
    configure: (next) => {
      if (active) throw new Error('上一段模型响应尚未完成')
      // 每个计划独立计数，重复运行（--repeat-each）时断言仍可复用。
      completed = 0
      turns = undefined
      turnIndex = 0
      plan = { segments: [...next.segments] }
    },
    configureTurns: (next) => {
      if (active) throw new Error('上一段模型响应尚未完成')
      completed = 0
      plan = undefined
      turns = next.map((turn) => ({ ...turn }))
      turnIndex = 0
    },
    release: () => release(),
    finish: () => {
      if (!active) throw new Error('没有等待结束的模型响应')
      active.finished = true
      wakeAll(active)
    },
    reset: () => {
      plan = undefined
      turns = undefined
      turnIndex = 0
      if (active) {
        active.released = active.segments.length
        active.finished = true
        wakeAll(active)
      }
    },
    state: () => ({ completed, active: active !== undefined }),
    restore: () => {
      globalThis.fetch = previous
    },
  }
}
