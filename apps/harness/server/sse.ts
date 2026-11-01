/**
 * SSE 事件流路由（宿主侧）。
 *
 * 独立成模块以便测试：传输链路的端到端验证（宿主编码 → HTTP/SSE →
 * 客户端解码 → reducer）需要能构造真实路由而不启动完整宿主。
 *
 * 语义：
 * - 快照优先：默认首帧投递快照；`?snapshot=false` 跳过（客户端已自行冷读时用）。
 * - 断开只退订，不中止运行（技术架构 §4.1「Disconnect ≠ abort」）。
 * - 慢客户端（待写事件超过上限）被断开，由客户端重连走快照恢复，避免无界积压。
 */

import type { HarnessClient } from '@huan/protocol'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

/** 待写事件上限；超过即断开慢客户端。 */
const MAX_INFLIGHT_WRITES = 500

/**
 * 处理 `GET /threads/:id/events`：把客户端的 `subscribe` 扇出为 SSE 帧。
 *
 * 事件体经 `JSON.stringify` 编码为 `data:` 行；客户端的
 * `createHarnessHttpClient` 用同一 JSON 形状解码，因此两侧互为契约。
 */
export function createEventsRoute(client: Pick<HarnessClient, 'subscribe'>) {
  return async (c: Context) => {
    const threadId = c.req.param('id') ?? ''
    const includeSnapshot = c.req.query('snapshot') !== 'false'

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | undefined
      let settled = false
      let inflight = 0

      await new Promise<void>((resolve) => {
        const cleanup = () => {
          if (settled) return
          settled = true
          unsubscribe?.()
          resolve()
        }

        stream.onAbort(cleanup)

        unsubscribe = client.subscribe(
          threadId,
          (event) => {
            if (settled) return
            if (inflight >= MAX_INFLIGHT_WRITES) {
              void stream.close().catch(() => {})
              cleanup()
              return
            }
            inflight++
            void stream
              .writeSSE({ data: JSON.stringify(event) })
              .catch(() => {
                // 写入失败（客户端已断开）由 onAbort 兜底清理。
              })
              .finally(() => {
                inflight--
              })
          },
          { includeSnapshot },
        )
      })
    })
  }
}

/**
 * 宿主级交互快照事件流。
 *
 * 与线程流共用慢客户端上限；断开只退订，不取消任何任务或请求。
 * 首帧由 `subscribeHostInteractions` 保证为权威快照（重连同样如此）。
 */
export function createHostInteractionEventsRoute(
  client: Pick<HarnessClient, 'subscribeHostInteractions'>,
) {
  return async (c: Context) =>
    streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | undefined
      let settled = false
      let inflight = 0

      await new Promise<void>((resolve) => {
        const cleanup = () => {
          if (settled) return
          settled = true
          unsubscribe?.()
          resolve()
        }
        stream.onAbort(cleanup)
        unsubscribe = client.subscribeHostInteractions((event) => {
          if (settled) return
          if (inflight >= MAX_INFLIGHT_WRITES) {
            void stream.close().catch(() => {})
            cleanup()
            return
          }
          inflight++
          void stream
            .writeSSE({ data: JSON.stringify(event) })
            .catch(() => {})
            .finally(() => {
              inflight--
            })
        })
      })
    })
}
