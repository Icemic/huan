/**
 * 宿主级交互 broker（G1.3c）。
 *
 * 存在原因：Pi 的 `project_trust` 与 `session_start` 钩子可能在任何会话 record
 * 发布之前发起阻断式 UI 请求。线程级通道此时既不可达也无法应答，若直接等待
 * 会让宿主初始化或 HTTP 长请求永久挂起。
 *
 * 语义：
 * - 请求进入 pending 表后才能被快照发现；每次变化投递完整权威快照（seq 单调）；
 * - 结算唯一：应答、超时、signal 中止、作用域取消、宿主销毁都只结算一次，
 *   先出表再广播，重复应答返回 false；
 * - 未声明 timeout 的请求一直等待用户/取消/销毁，不保留永不清理的 timer；
 * - 通知有界（保留最近 20 条），只用于启动期可见提示，不参与阻断。
 */
import type {
  HarnessHostInteractionNotification,
  HarnessHostInteractionRequest,
  HarnessHostInteractionScope,
  HarnessHostInteractionSnapshot,
  HarnessHostUiRequest,
  HarnessHostUiResponse,
} from '@huan/protocol'
import { hostInteractionScopeKey } from '@huan/protocol'

/** 请求结算值（由桥/信任上下文映射成 Pi 原生值）。 */
export type HostInteractionAnswer = {
  confirmed?: boolean
  value?: string
  dismissed?: boolean
}

export type HostInteractionAskOptions = {
  signal?: AbortSignal
  timeout?: number
}

export type HostInteractions = {
  /** 注册阻断请求；signal 已中止或宿主已销毁时立即以 dismissed 结算。 */
  ask: (
    request: HarnessHostUiRequest,
    scope: HarnessHostInteractionScope,
    options?: HostInteractionAskOptions,
  ) => Promise<HostInteractionAnswer>
  /** 可见通知（有界）。 */
  notify: (
    scope: HarnessHostInteractionScope,
    message: string,
    type?: HarnessHostInteractionNotification['type'],
  ) => void
  /** 应答请求；返回 false 表示未知/已结算（幂等忽略）。 */
  respond: (response: HarnessHostUiResponse) => boolean
  snapshot: () => HarnessHostInteractionSnapshot
  /** 订阅：立即投递当前快照，之后每次变化投递新快照。 */
  subscribe: (listener: (snapshot: HarnessHostInteractionSnapshot) => void) => () => void
  /** 取消某个作用域内的全部请求（open signal/装配失败）。 */
  cancelScope: (scope: HarnessHostInteractionScope) => void
  /** 宿主销毁：取消全部请求并停止接受新请求。 */
  dispose: () => void
}

type PendingEntry = {
  request: HarnessHostInteractionRequest
  settle: (answer: HostInteractionAnswer) => void
}

/** 通知保留上限：与线程运行期通知一致，避免快照无界增长。 */
const MAX_NOTIFICATIONS = 20

const scopeHas = (request: HarnessHostInteractionRequest, scopeKey: string): boolean =>
  hostInteractionScopeKey(request.scope) === scopeKey

/** 把桥的请求映射为宿主请求（只保留协议字段）。 */
function interactionRequestOf(
  request: HarnessHostUiRequest,
  scope: HarnessHostInteractionScope,
): HarnessHostInteractionRequest {
  return {
    id: request.id,
    scope,
    kind: request.kind,
    title: request.title,
    ...('message' in request && request.message !== undefined ? { message: request.message } : {}),
    ...('options' in request ? { options: request.options } : {}),
    ...('placeholder' in request && request.placeholder !== undefined
      ? { placeholder: request.placeholder }
      : {}),
    ...('prefill' in request && request.prefill !== undefined ? { prefill: request.prefill } : {}),
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    createdAt: Date.now(),
  }
}

/** 应答是否与请求类型匹配（非法 select 值不能交给扩展）。 */
function answerMatchesRequest(
  request: HarnessHostInteractionRequest,
  response: HarnessHostUiResponse,
): boolean {
  if ('dismissed' in response) return response.dismissed === true
  if (request.kind === 'confirm') {
    return 'confirmed' in response && typeof response.confirmed === 'boolean'
  }
  if (!('value' in response) || typeof response.value !== 'string') return false
  if (request.kind === 'select') {
    return (request.options ?? []).includes(response.value)
  }
  return true
}

export function createHostInteractions(): HostInteractions {
  const pending = new Map<string, PendingEntry>()
  const listeners = new Set<(snapshot: HarnessHostInteractionSnapshot) => void>()
  let notifications: HarnessHostInteractionNotification[] = []
  let seq = 0
  let notificationCounter = 0
  let disposed = false

  const snapshot = (): HarnessHostInteractionSnapshot =>
    structuredClone({
      seq,
      requests: [...pending.values()].map((entry) => entry.request),
      notifications,
    })

  const emit = () => {
    seq += 1
    const current = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(current)
      } catch {
        // 单个订阅者抛错不影响其他订阅者。
      }
    }
  }

  const settleEntry = (id: string, answer: HostInteractionAnswer): boolean => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    entry.settle(answer)
    emit()
    return true
  }

  return {
    ask(request, scope, options) {
      const answer: HostInteractionAnswer = { dismissed: true }
      if (disposed || options?.signal?.aborted === true) {
        return Promise.resolve(answer)
      }
      const interaction = interactionRequestOf(request, scope)
      return new Promise<HostInteractionAnswer>((resolvePromise) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          options?.signal?.removeEventListener('abort', onAbort)
        }
        const finish = (value: HostInteractionAnswer) => {
          if (settled) return
          settled = true
          cleanup()
          resolvePromise(value)
        }
        const onAbort = () => {
          // 先出表：保证快照里不会留下不可应答的请求。
          if (pending.delete(interaction.id)) emit()
          finish(answer)
        }

        pending.set(interaction.id, { request: interaction, settle: finish })
        if (options?.signal) options.signal.addEventListener('abort', onAbort, { once: true })
        if (options?.timeout && options.timeout > 0) {
          timer = setTimeout(() => {
            // 超时按 SDK 默认值结算：confirm=false，其余 undefined。
            if (pending.delete(interaction.id)) emit()
            finish({ dismissed: true })
          }, options.timeout)
        }
        emit()
      })
    },

    notify(scope, message, type = 'info') {
      if (disposed) return
      notificationCounter += 1
      notifications = [
        ...notifications,
        {
          id: `host-notify:${notificationCounter}`,
          scope,
          message,
          type,
          createdAt: Date.now(),
        },
      ].slice(-MAX_NOTIFICATIONS)
      emit()
    },

    respond(response) {
      const entry = pending.get(response.requestId)
      if (!entry) return false
      if (!answerMatchesRequest(entry.request, response)) return false
      if ('dismissed' in response) return settleEntry(response.requestId, { dismissed: true })
      if ('confirmed' in response) {
        return settleEntry(response.requestId, { confirmed: response.confirmed })
      }
      return settleEntry(response.requestId, { value: response.value })
    },

    snapshot,

    subscribe(listener) {
      listeners.add(listener)
      try {
        listener(snapshot())
      } catch {
        // 初始投递失败不应阻止后续订阅。
      }
      return () => {
        listeners.delete(listener)
      }
    },

    cancelScope(scope) {
      const key = hostInteractionScopeKey(scope)
      for (const entry of [...pending.values()]) {
        if (!scopeHas(entry.request, key)) continue
        if (pending.delete(entry.request.id)) emit()
        entry.settle({ dismissed: true })
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of [...pending.values()]) {
        pending.delete(entry.request.id)
        entry.settle({ dismissed: true })
      }
      notifications = []
      seq += 1
      // 先投递最后一次权威快照，让已连接页面立即移除待答项；随后停止订阅。
      const current = snapshot()
      for (const listener of [...listeners]) {
        try {
          listener(current)
        } catch {
          // 销毁阶段的订阅者抛错不再传播。
        }
      }
      listeners.clear()
    },
  }
}
