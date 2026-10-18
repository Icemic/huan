/**
 * Host UI 辅助函数——Pi 的 human-in-the-loop 界面的浏览器侧半部。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/runtime/hostUi.ts`
 * （MIT 许可）。改动：类型改用 `@huan/protocol`，命名 `Pi*` → `Harness*`，
 * 注释译为中文。逻辑与上游逐行等价。
 *
 * Pi 没有内建审批系统；唯一的闸门是扩展/工具调用
 * `ctx.ui.confirm / select / input / editor`。每次阻断式调用以一个
 * `HarnessHostUiRequest` 浮出。本模块是纯函数且浏览器安全：
 *
 * - `splitHostUiRequests` 把待处理请求划分为**工具关联**与**游离**两类。
 *   前者带 `toolCallId`（由宿主在「单工具因果」下盖章，审批能应答它）→
 *   投影为工具调用的 `approval`；后者无 `toolCallId`（或审批无法应答）→
 *   走始终可用的侧信道（`useHarnessHostUiRequests`）。
 *   浏览器绝不**推断** `toolCallId`，只承认宿主设置的值（多工具并行运行时
 *   宿主不会盖章）。
 * - `responseFor*` 系列把 UI 应答映射回已核验的 Pi 响应语义：
 *   confirm → boolean（取消/超时 = false = 拒绝；Pi 无「已取消」通道）
 *   select / input / editor → string | undefined（undefined = 已 dismiss）
 *
 * 浏览器安全，不导入任何 Pi SDK 包。
 */

import type { RespondToToolApprovalOptions, ToolCallMessagePart } from '@assistant-ui/react'
import type { HarnessHostUiRequest, HarnessHostUiResponse } from '@huan/protocol'

/** 请求分流结果。 */
export interface SplitHostUiRequests {
  /**
   * 宿主关联到单个正在执行的工具、且审批能应答的请求，按 `toolCallId` 索引。
   * 被投影为工具调用部分的 approval。
   */
  toolAssociated: Map<string, HarnessHostUiRequest>
  /** 其余全部——经侧信道渲染。 */
  freeStanding: HarnessHostUiRequest[]
}

/** 把待处理请求分为工具关联与游离两类。 */
export const splitHostUiRequests = (
  requests: readonly HarnessHostUiRequest[],
): SplitHostUiRequests => {
  const toolAssociated = new Map<string, HarnessHostUiRequest>()
  const freeStanding: HarnessHostUiRequest[] = []

  for (const request of requests) {
    if (request.toolCallId !== undefined && approvalForRequest(request)) {
      // 若两个请求声称同一 toolCallId，先到者生效；宿主的单工具因果规则
      // 应能防止这种情况。
      if (!toolAssociated.has(request.toolCallId)) {
        toolAssociated.set(request.toolCallId, request)
      } else {
        freeStanding.push(request)
      }
    } else {
      freeStanding.push(request)
    }
  }

  return { toolAssociated, freeStanding }
}

/**
 * `confirm` 请求映射为布尔值。
 * 取消 = `approved: false` = 拒绝（Pi 把取消/超时折叠为 `false`）。
 */
export const responseForApproval = (
  requestId: string,
  approved: boolean,
): HarnessHostUiResponse => ({ requestId, confirmed: approved })

/**
 * 工具关联请求投影为工具调用的 approval：`confirm` 请求一个决定，
 * `select` 请求其选项之一（选项 id 是下标），`input`/`editor` 请求文本应答。
 * 审批无法应答的请求（无选项的 `select`，或本客户端不认识的 kind）没有
 * approval，留在侧信道。问题类 kind 被投影为可 dismiss，因为 Pi 以
 * `undefined` 解决被取消的请求。
 */
export const approvalForRequest = (
  request: HarnessHostUiRequest,
): ToolCallMessagePart['approval'] => {
  switch (request.kind) {
    case 'confirm':
      return { id: request.id, prompt: `${request.title}\n${request.message}` }
    case 'select':
      if (request.options.length === 0) return undefined
      return {
        id: request.id,
        prompt: request.title,
        display: 'select',
        dismissible: true,
        options: request.options.map((label, index) => ({
          id: String(index),
          kind: `_${index}`,
          label,
        })),
      }
    case 'input':
    case 'editor':
      return {
        id: request.id,
        prompt: request.title,
        display: 'text',
        dismissible: true,
      }
  }
}

/**
 * 把工具关联请求投影成的 approval 上的应答映射回 Pi 响应。
 * 拒绝即 dismiss `select`/`input`/`editor` 请求；其他应答必须携带请求所问的
 * 选项或文本。
 */
export const responseForToolApproval = (
  request: HarnessHostUiRequest,
  response: RespondToToolApprovalOptions,
): HarnessHostUiResponse => {
  if (request.kind === 'confirm') {
    return responseForApproval(request.id, response.approved)
  }
  if (!response.approved) return { requestId: request.id, dismissed: true }

  const value =
    request.kind === 'select'
      ? request.options.find((_, index) => String(index) === response.optionId)
      : response.text
  if (value === undefined) {
    throw new Error(
      `Pi ${request.kind} request "${request.id}" was not answered with ${
        request.kind === 'select' ? 'one of its options' : 'text'
      }`,
    )
  }
  return { requestId: request.id, value }
}

/**
 * UI 在按值解决 `select`/`input`/`editor` 请求时可回传的形状：
 * 裸字符串，或携带 value / dismissal 的对象。
 */
export type HarnessInterruptAnswer =
  | string
  | { value?: string | null; dismissed?: boolean }
  | null
  | undefined

const readAnswerValue = (answer: HarnessInterruptAnswer): string | undefined => {
  if (typeof answer === 'string') return answer
  if (answer != null && typeof answer === 'object') {
    if (answer.dismissed) return undefined
    if (typeof answer.value === 'string') return answer.value
  }
  return undefined
}

/**
 * `select`/`input`/`editor` 映射为 `string | undefined`：具体字符串是选中的
 * 值；其他（null/undefined/`{dismissed}`）把请求解决为「dismiss 且无值」。
 */
export const responseForInterrupt = (
  requestId: string,
  answer: HarnessInterruptAnswer,
): HarnessHostUiResponse => {
  const value = readAnswerValue(answer)
  return value !== undefined ? { requestId, value } : { requestId, dismissed: true }
}

/**
 * 通用应答 → 响应，按请求 kind 分派。
 * 用于侧信道——单个处理器应答任意待处理请求。
 */
export const responseForRequest = (
  request: HarnessHostUiRequest,
  answer: boolean | HarnessInterruptAnswer,
): HarnessHostUiResponse => {
  if (request.kind === 'confirm') {
    return responseForApproval(request.id, answer === true)
  }
  return responseForInterrupt(request.id, answer as HarnessInterruptAnswer)
}
