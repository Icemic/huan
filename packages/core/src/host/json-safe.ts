/**
 * 扩展 unknown 载荷的 JSON-safe 边界。
 *
 * 只处理需要展示/广播的扩展数据：BigInt → 十进制字符串，非有限数字/数组
 * undefined → null，对象中的 undefined/function/symbol 省略；当前祖先循环或
 * 编码异常 → 可读“不支持的扩展数据”标记。普通共享引用不当作循环。
 *
 * 不改变 SDK 执行参数、Pi 历史或已知协议字段；秘密识别仍由认证/配置领域负责。
 */

import type {
  HarnessAgentMessage,
  HarnessClientEventBody,
  HarnessThreadSnapshot,
} from '@huan/protocol'

const UNSUPPORTED = '[不支持的扩展数据]'
const OMIT = Symbol('huan-json-omit')

type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue }

const convert = (value: unknown, ancestors: Set<object>): JsonSafeValue | typeof OMIT => {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value as string | boolean
  if (type === 'number') return Number.isFinite(value as number) ? (value as number) : null
  if (type === 'bigint') return (value as bigint).toString(10)
  if (type === 'undefined' || type === 'function' || type === 'symbol') return OMIT

  const object = value as object
  if (ancestors.has(object)) return UNSUPPORTED
  ancestors.add(object)
  try {
    if (Array.isArray(object)) {
      return object.map((item) => {
        const converted = convert(item, ancestors)
        return converted === OMIT ? null : converted
      })
    }
    // Date 等标准 JSON 支持的类型按 JSON 语义输出。
    const json = object as { toJSON?: unknown }
    if (typeof json.toJSON === 'function') {
      const converted = convert((json.toJSON as () => unknown).call(object), ancestors)
      return converted === OMIT ? UNSUPPORTED : converted
    }
    const result: { [key: string]: JsonSafeValue } = Object.create(null)
    for (const key of Object.keys(object)) {
      let raw: unknown
      try {
        raw = (object as Record<string, unknown>)[key]
      } catch {
        result[key] = UNSUPPORTED
        continue
      }
      const converted = convert(raw, ancestors)
      if (converted !== OMIT) result[key] = converted
    }
    return result
  } catch {
    return UNSUPPORTED
  } finally {
    ancestors.delete(object)
  }
}

/** 把任意扩展值转为 JSON-safe；无法表示的子载荷用受控标记替代。 */
export const toJsonSafe = (value: unknown): unknown => {
  try {
    const converted = convert(value, new Set())
    return converted === OMIT ? null : converted
  } catch {
    return UNSUPPORTED
  }
}

const jsonSafeMessages = (messages: readonly HarnessAgentMessage[]): HarnessAgentMessage[] =>
  messages.map((message) => toJsonSafe(message) as HarnessAgentMessage)

export const jsonSafeSnapshot = (snapshot: HarnessThreadSnapshot): HarnessThreadSnapshot => ({
  ...snapshot,
  messages: jsonSafeMessages(snapshot.messages),
  ...(snapshot.toolExecutions
    ? {
        toolExecutions: snapshot.toolExecutions.map(
          (execution) => toJsonSafe(execution) as (typeof snapshot.toolExecutions)[number],
        ),
      }
    : {}),
})

/** 在事件广播前转换可能含扩展 unknown 的字段；已知文本/ID 保持原样。 */
export const jsonSafeEventBody = (body: HarnessClientEventBody): HarnessClientEventBody => {
  switch (body.type) {
    case 'snapshot':
      return { ...body, snapshot: jsonSafeSnapshot(body.snapshot) }
    case 'message_start':
    case 'message_end':
      return { ...body, message: toJsonSafe(body.message) as HarnessAgentMessage }
    case 'message_update':
      return {
        ...body,
        message: toJsonSafe(body.message) as HarnessAgentMessage,
        assistantMessageEvent: toJsonSafe(
          body.assistantMessageEvent,
        ) as typeof body.assistantMessageEvent,
      }
    case 'tool_execution_start':
      return { ...body, args: toJsonSafe(body.args) }
    case 'tool_execution_update':
      return { ...body, partialResult: toJsonSafe(body.partialResult) }
    case 'tool_execution_end':
      return { ...body, result: toJsonSafe(body.result) }
    case 'entry_appended':
      return { ...body, entry: toJsonSafe(body.entry) as typeof body.entry }
    default:
      return body
  }
}

export { UNSUPPORTED as UNSUPPORTED_EXTENSION_DATA }
