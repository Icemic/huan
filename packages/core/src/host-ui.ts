/**
 * Host UI 桥：把 Pi 的 ExtensionUIContext 四类阻断式交互
 * （confirm / select / input / editor）映射为协议请求/响应。
 *
 * 语义（对照 react-pi 的实现保持等价）：
 * - 请求注册进 pending 表，承诺在「被应答 / 被中止 / 超时 / dismissAll」时结算；
 * - 结算时先出表再发 resolved 事件（幂等：重复应答无效果）；
 * - select/input/editor 的 dismiss 返回 undefined；confirm 的 dismiss 返回 false。
 */

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { HarnessHostUiRequest } from '@huan/protocol'

/** 无头环境下不受支持的能力（TUI 组件）。 */
export class HarnessUnsupportedHostUiError extends Error {
  readonly method: string
  constructor(method: string) {
    super(`Pi host-UI method "${method}" is not supported in the huan node host.`)
    this.method = method
    this.name = 'HarnessUnsupportedHostUiError'
  }
}

/** 桥依赖：由宿主注入（发事件、取当前工具调用、生成请求 ID、通知）。 */
export type HostUiBridgeDeps = {
  nextRequestId: () => string
  /** 当前工具调用 ID（用于把审批关联到工具卡片）；无则 undefined。 */
  currentToolCallId: () => string | undefined
  emitRequest: (request: HarnessHostUiRequest) => void
  emitResolved: (requestId: string) => void
  onNotify?: (message: string, type: string) => void
}

/** 桥接口：ui 供 session.bindExtensions 使用；pending/resolve/dismissAll 供宿主管理。 */
export type HostUiBridge = {
  ui: ExtensionUIContext
  pending: () => HarnessHostUiRequest[]
  /** 应答请求；返回 false 表示请求不存在或已被结算（幂等忽略）。 */
  resolve: (response: {
    requestId: string
    confirmed?: boolean
    value?: string
    dismissed?: boolean
  }) => boolean
  dismissAll: () => void
}

type PendingEntry = {
  request: HarnessHostUiRequest
  settle: (response: {
    requestId: string
    confirmed?: boolean
    value?: string
    dismissed?: boolean
  }) => void
  dismiss: () => void
}

const valueOrUndefined = (response: { value?: string }): string | undefined => response.value

export function createHostUiBridge(deps: HostUiBridgeDeps): HostUiBridge {
  const pendingById = new Map<string, PendingEntry>()

  /**
   * 注册一个阻断式请求并返回承诺（应答/中止/超时/取消时结算）。
   * dismissValue 为中止或超时时的兜底返回值。
   */
  const ask = <T>(
    request: HarnessHostUiRequest,
    toNative: (response: { confirmed?: boolean; value?: string }) => T,
    dismissValue: T,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> =>
    new Promise<T>((resolvePromise) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
      }
      const finish = (value: T) => {
        if (settled) return
        settled = true
        pendingById.delete(request.id)
        cleanup()
        deps.emitResolved(request.id)
        resolvePromise(value)
      }
      const onAbort = () => finish(dismissValue)

      pendingById.set(request.id, {
        request,
        settle: (response) => finish(toNative(response)),
        dismiss: () => finish(dismissValue),
      })

      if (opts?.signal) {
        if (opts.signal.aborted) {
          finish(dismissValue)
          return
        }
        opts.signal.addEventListener('abort', onAbort)
      }
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => finish(dismissValue), opts.timeout)
      }
      deps.emitRequest(request)
    })

  /** 关联字段：toolCallId / timeoutMs 缺席时不写入，保持载荷干净。 */
  const correlation = (opts?: { timeout?: number }) => {
    const toolCallId = deps.currentToolCallId()
    return {
      ...(toolCallId ? { toolCallId } : {}),
      ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}),
    }
  }

  return {
    ui: {
      confirm: (title, message, opts) => {
        const request: HarnessHostUiRequest = {
          id: deps.nextRequestId(),
          kind: 'confirm',
          title,
          message,
          ...correlation(opts),
        }
        return ask(request, (r) => r.confirmed ?? false, false, opts)
      },
      select: (title, options, opts) => {
        const request: HarnessHostUiRequest = {
          id: deps.nextRequestId(),
          kind: 'select',
          title,
          options,
          ...correlation(opts),
        }
        return ask(request, valueOrUndefined, undefined, opts)
      },
      input: (title, placeholder, opts) => {
        const request: HarnessHostUiRequest = {
          id: deps.nextRequestId(),
          kind: 'input',
          title,
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...correlation(opts),
        }
        return ask(request, valueOrUndefined, undefined, opts)
      },
      editor: (title, prefill) => {
        const toolCallId = deps.currentToolCallId()
        const request: HarnessHostUiRequest = {
          id: deps.nextRequestId(),
          kind: 'editor',
          title,
          ...(prefill !== undefined ? { prefill } : {}),
          ...(toolCallId ? { toolCallId } : {}),
        }
        return ask(request, valueOrUndefined, undefined)
      },
      notify: (message, type) => deps.onNotify?.(message, type ?? 'info'),
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      custom: () => Promise.reject(new HarnessUnsupportedHostUiError('custom')),
      // 无头宿主不提供 TUI 主题能力；getter 返回空对象的类型断言与 react-pi 实现一致。
      get theme() {
        return {} as ExtensionUIContext['theme']
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: 'Themes are not supported in the huan node host.',
      }),
    },
    pending: () => [...pendingById.values()].map((entry) => entry.request),
    resolve: (response) => {
      const entry = pendingById.get(response.requestId)
      if (!entry) return false
      entry.settle(response)
      return true
    },
    dismissAll: () => {
      for (const entry of [...pendingById.values()]) entry.dismiss()
    },
  }
}
