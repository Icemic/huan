/**
 * `resolveToolApprovalResponse` 的本地副本（anti-corruption layer）。
 *
 * 出处：`@assistant-ui/core@0.3.27` 的
 * `runtime/utils/resolveToolApprovalResponse`。许可：MIT。
 * 该模块只经 `@assistant-ui/core/internal` 暴露。
 *
 * 改动：类型改用 `@assistant-ui/react` 公共导出，并把上游依赖的
 * `toolApprovalAcceptsText` 一并内联（3 行）；逻辑与上游等价。
 *
 * 用途：把渲染面朝向的审批应答（布尔、optionId、自由文本、问卷应答）
 * 按审批请求的形状解析为运行时朝向的决定形状。
 */

import type {
  RespondToToolApprovalOptions,
  ToolApprovalAnswer,
  ToolApprovalDisplay,
  ToolApprovalOption,
  ToolApprovalQuestion,
  ToolApprovalResponse,
} from '@assistant-ui/react'

/** 解析所需的审批请求形状。 */
type ResolvableApproval = {
  readonly id: string
  readonly display?: ToolApprovalDisplay
  readonly allowFreeform?: boolean
  readonly options?: readonly ToolApprovalOption[]
  readonly questions?: readonly ToolApprovalQuestion[]
}

/** 请求是否接受自由文本应答。 */
const toolApprovalAcceptsText = (approval: {
  display?: ToolApprovalDisplay
  allowFreeform?: boolean
}): boolean =>
  approval.display === 'text' ||
  (approval.display !== 'questions' && approval.allowFreeform === true)

const APPROVED_BY_KIND: Record<string, boolean> = {
  'allow-once': true,
  'allow-always': true,
  'reject-once': false,
  'reject-always': false,
}

const validateAnswers = (
  approval: ResolvableApproval,
  answers: Readonly<Record<string, ToolApprovalAnswer>>,
): void => {
  const questions = approval.questions ?? []
  if (questions.length === 0) {
    throw new Error(
      `Tool approval "${approval.id}" has display "questions" but declares no questions`,
    )
  }
  const questionIds = new Set<string>()
  for (const question of questions) {
    if (questionIds.has(question.id)) {
      throw new Error(
        `Tool approval "${approval.id}" declares question "${question.id}" more than once`,
      )
    }
    questionIds.add(question.id)
  }
  for (const id of Object.keys(answers)) {
    if (!questionIds.has(id)) {
      throw new Error(`Tool approval "${approval.id}" has no question with id "${id}"`)
    }
  }
  for (const question of questions) {
    const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined
    const optionIds = answer?.optionIds ?? []
    const text = answer?.text
    if (!Array.isArray(optionIds) || (text !== undefined && typeof text !== 'string')) {
      throw new Error(`Question "${question.id}" takes optionIds as an array and text as a string`)
    }
    if (optionIds.length === 0 && (text === undefined || text.trim() === '')) {
      throw new Error(
        `Tool approval "${approval.id}" is missing an answer to question "${question.id}"`,
      )
    }
    if (optionIds.length > 1 && !question.multiple) {
      throw new Error(`Question "${question.id}" takes one option, not ${optionIds.length}`)
    }
    if (new Set(optionIds).size !== optionIds.length) {
      throw new Error(`Question "${question.id}" lists an option more than once`)
    }
    for (const optionId of optionIds) {
      if (!question.options?.some((option) => option.id === optionId)) {
        throw new Error(`Question "${question.id}" has no option with id "${optionId}"`)
      }
    }
    if (text !== undefined && (question.options?.length ?? 0) > 0 && !question.allowFreeform) {
      throw new Error(
        `Question "${question.id}" does not accept a typed answer; it must declare allowFreeform`,
      )
    }
  }
}

const resolveQuestionsResponse = (
  approval: ResolvableApproval,
  response: ToolApprovalResponse,
): RespondToToolApprovalOptions => {
  const reason = response.reason
  if ('answers' in response) {
    if ('approved' in response || 'optionId' in response || 'text' in response) {
      throw new Error(
        `Tool approval "${approval.id}" takes its answers alone, without approved, optionId or text`,
      )
    }
    validateAnswers(approval, response.answers)
    return {
      approvalId: approval.id,
      approved: true,
      answers: response.answers,
      ...(reason != null && { reason }),
    }
  }
  if (
    'approved' in response &&
    response.approved === false &&
    !('optionId' in response) &&
    response.text === undefined
  ) {
    return {
      approvalId: approval.id,
      approved: false,
      ...(reason != null && { reason }),
    }
  }
  throw new Error(
    `Tool approval "${approval.id}" asks questions; respond with answers, or with approved: false to dismiss it`,
  )
}

/**
 * 把渲染面朝向的审批应答（布尔、optionId、自由文本或问卷应答）按审批请求的
 * 形状解析为运行时朝向的决定形状。
 */
export const resolveToolApprovalResponse = (
  approval: ResolvableApproval,
  response: ToolApprovalResponse,
): RespondToToolApprovalOptions => {
  if (approval.display === 'questions') return resolveQuestionsResponse(approval, response)
  if ('answers' in response) {
    throw new Error(
      `Tool approval "${approval.id}" asks no questions; answers only resolve a display "questions" request`,
    )
  }
  const text = response.text
  if (text !== undefined && !toolApprovalAcceptsText(approval)) {
    throw new Error(
      `Tool approval "${approval.id}" does not accept a free-form answer; the request must declare display "text" or allowFreeform`,
    )
  }
  let approved: boolean
  let optionId: string | undefined
  if ('optionId' in response) {
    const option = approval.options?.find((o) => o.id === response.optionId)
    if (!option) {
      throw new Error(`Tool approval has no option with id "${response.optionId}"`)
    }
    if ('approved' in response) {
      approved = response.approved
    } else {
      const kind = option.kind
      if (kind === undefined || !Object.hasOwn(APPROVED_BY_KIND, kind)) {
        throw new Error(
          `Tool approval option "${option.id}" has a custom kind "${kind}"; respond with an explicit approved value instead`,
        )
      }
      approved = APPROVED_BY_KIND[kind] as boolean
    }
    optionId = option.id
  } else if ('approved' in response) {
    approved = response.approved
  } else {
    if (approval.display !== 'text' && approval.display !== 'select') {
      throw new Error(
        `Tool approval "${approval.id}" is a decision, not a question; respond with an explicit approved value, optionally alongside the answer`,
      )
    }
    approved = true
  }
  return {
    approvalId: approval.id,
    approved,
    ...(optionId !== undefined && { optionId }),
    ...(text !== undefined && { text }),
    ...(response.reason != null && { reason: response.reason }),
  }
}
