/**
 * Host UI 桥：把 Pi 的 ExtensionUIContext 映射为协议请求/响应与运行期状态回调。
 *
 * 语义：
 * - 四类阻断式交互（confirm/select/input/editor）在 record 发布后进入本地
 *   pending 表；装配期（session_start）改由宿主级交互域承接，避免 record
 *   尚未发布时无法应答而挂死；
 * - 请求在「被应答 / 被中止 / 超时 / dismissAll」时结算；结算先出表再通知；
 * - 重复应答/非法应答（select 值不在选项内、类型不匹配）被忽略，不交给扩展；
 * - select/input/editor 的 dismiss 返回 undefined；confirm 的 dismiss 返回 false；
 * - 通知/状态/文本 widget/标题/编辑器写入等运行期能力通过回调交给宿主投影，
 *   终端专属组件不执行工厂、不伪造成 React 组件，只报告“不支持”。
 */

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { HarnessHostUiRequest } from '@huan/protocol'

/** 无头环境下不受支持的能力（TUI 组件/终端主题）。 */
export class HarnessUnsupportedHostUiError extends Error {
  readonly method: string
  constructor(method: string) {
    super(`Pi host-UI method "${method}" is not supported in the huan node host.`)
    this.method = method
    this.name = 'HarnessUnsupportedHostUiError'
  }
}

/** 桥依赖：由宿主注入（发事件、取当前工具调用、生成请求 ID、状态回调）。 */
export type HostUiBridgeDeps = {
  nextRequestId: () => string
  /** 当前工具调用 ID（用于把审批关联到工具卡片）；无则 undefined。 */
  currentToolCallId: () => string | undefined
  emitRequest: (request: HarnessHostUiRequest) => void
  emitResolved: (requestId: string) => void
  /** 运行期可见通知；装配期由 startup.notify 接手。 */
  onNotify?: (message: string, type: string) => void
  onStatus?: (key: string, text: string | undefined) => void
  onWidget?: (
    key: string,
    lines: string[] | undefined,
    placement: 'aboveEditor' | 'belowEditor',
  ) => void
  onTitle?: (title: string) => void
  onWorkingMessage?: (message: string | undefined) => void
  onWorkingVisible?: (visible: boolean) => void
  onHiddenThinkingLabel?: (label: string | undefined) => void
  /** 读取调用方窗口的草稿镜像（无调用方返回空串）。 */
  getEditorText?: () => string
  /** 扩展写输入框；宿主按调用方窗口生成定向指令。 */
  onEditorWrite?: (text: string, mode: 'set' | 'paste') => void
  /** 终端专属能力被调用；宿主记录可见的不支持说明。 */
  onUnsupported?: (method: string) => void
  /**
   * 装配期通道：session_start 期间请求进入宿主级交互域。
   * 未提供时保留旧行为（立即以默认值结算并告警），仅用于无宿主环境。
   */
  startup?: {
    ask: (
      request: HarnessHostUiRequest,
      options?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<{ confirmed?: boolean; value?: string; dismissed?: boolean }>
    dismissAll: () => void
    notify?: (message: string, type: string) => void
  }
}

/** 桥接口：ui 供 session.bindExtensions 使用；pending/resolve/dismissAll 供宿主管理。 */
export type HostUiBridge = {
  ui: ExtensionUIContext
  pending: () => HarnessHostUiRequest[]
  /** 应答请求；返回 false 表示请求不存在、已结算或应答不合法（幂等忽略）。 */
  resolve: (response: {
    requestId: string
    confirmed?: boolean
    value?: string
    dismissed?: boolean
  }) => boolean
  dismissAll: () => void
  /**
   * 装配期策略开关：true 时阻断请求进入宿主级交互域；false 时恢复线程通道，
   * 并清掉装配期遗留（handler 未 await 的请求不能重复出现在两个通道）。
   */
  setStartup: (startup: boolean) => void
}

type NativeResponse = { confirmed?: boolean; value?: string; dismissed?: boolean }

type PendingEntry = {
  request: HarnessHostUiRequest
  settle: (response: NativeResponse) => void
  dismiss: () => void
}

const valueOrUndefined = (response: { value?: string }): string | undefined => response.value

/** 应答类型与请求匹配：非法 select 值不能被当作扩展答案。 */
const matchesRequest = (request: HarnessHostUiRequest, response: NativeResponse): boolean => {
  if (response.dismissed === true) return true
  if (request.kind === 'confirm') return typeof response.confirmed === 'boolean'
  if (typeof response.value !== 'string') return false
  if (request.kind === 'select') return request.options.includes(response.value)
  return true
}

export function createHostUiBridge(deps: HostUiBridgeDeps): HostUiBridge {
  const pendingById = new Map<string, PendingEntry>()
  let startup = true

  /** 运行期本地登记（装配期不走这里）。 */
  const registerLocal = <T>(
    request: HarnessHostUiRequest,
    toNative: (response: NativeResponse) => T,
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

  /**
   * 注册一个阻断式请求并返回承诺（应答/中止/超时/取消时结算）。
   * dismissValue 为中止或超时时的兜底返回值。
   */
  const ask = <T>(
    request: HarnessHostUiRequest,
    toNative: (response: NativeResponse) => T,
    dismissValue: T,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> => {
    if (startup && deps.startup) {
      return deps.startup.ask(request, opts).then(toNative)
    }
    if (startup) {
      // 无宿主级通道的降级环境：明确告警后以默认值结算，不能静默挂起。
      deps.startup?.notify?.(
        `装配期 UI 请求（${request.kind}）已自动忽略：${request.title}`,
        'warning',
      )
      return Promise.resolve(dismissValue)
    }
    return registerLocal(request, toNative, dismissValue, opts)
  }

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
      notify: (message, type) => {
        if (startup && deps.startup?.notify) {
          deps.startup.notify(message, type ?? 'info')
          return
        }
        deps.onNotify?.(message, type ?? 'info')
      },
      onTerminalInput: () => {
        deps.onUnsupported?.('onTerminalInput')
        return () => {}
      },
      setStatus: (key, text) => deps.onStatus?.(key, text),
      setWorkingMessage: (message) => deps.onWorkingMessage?.(message),
      setWorkingVisible: (visible) => deps.onWorkingVisible?.(visible),
      setWorkingIndicator: () => deps.onUnsupported?.('setWorkingIndicator'),
      setHiddenThinkingLabel: (label) => deps.onHiddenThinkingLabel?.(label),
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) {
          deps.onWidget?.(
            key,
            content ? [...content] : undefined,
            options?.placement ?? 'aboveEditor',
          )
          return
        }
        // 组件工厂是终端 TUI 专属：不执行、不转 React。
        deps.onUnsupported?.('setWidget(component)')
      },
      setFooter: () => deps.onUnsupported?.('setFooter'),
      setHeader: () => deps.onUnsupported?.('setHeader'),
      setTitle: (title) => deps.onTitle?.(title),
      pasteToEditor: (text) => deps.onEditorWrite?.(text, 'paste'),
      setEditorText: (text) => deps.onEditorWrite?.(text, 'set'),
      getEditorText: () => deps.getEditorText?.() ?? '',
      addAutocompleteProvider: () => deps.onUnsupported?.('addAutocompleteProvider'),
      setEditorComponent: () => deps.onUnsupported?.('setEditorComponent'),
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
      if (!matchesRequest(entry.request, response)) return false
      entry.settle(response)
      return true
    },
    dismissAll: () => {
      for (const entry of [...pendingById.values()]) entry.dismiss()
      deps.startup?.dismissAll()
    },
    setStartup: (value: boolean) => {
      if (value === startup) return
      // 离开装配期：清掉遗留的装配请求，避免与线程通道重复出现。
      if (!value) deps.startup?.dismissAll()
      startup = value
    },
  }
}
