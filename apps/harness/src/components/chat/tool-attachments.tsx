/**
 * 工具展开内容中的附件：输出图片与历史子调用摘要。
 *
 * 两者与具体工具类型无关，专门工具和通用回退共用，避免专门展示后丢失
 * 图片或嵌套调用入口。子调用摘要仍是有界摘要，不承诺完整子结果。
 */

import type { HarnessToolViewPart } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { MessageImage } from './message-image'

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function ToolImages({ part }: { part: HarnessToolViewPart }) {
  const images = part.outputImages ?? []
  if (images.length === 0) return null
  return (
    <div data-slot="huan-tool-images" className="grid max-w-full grid-cols-1 gap-2 sm:grid-cols-2">
      {images.map((image, index) => (
        <MessageImage
          // biome-ignore lint/suspicious/noArrayIndexKey: 图片没有独立业务 ID，顺序来自工具结果
          key={`${part.toolCallId}:image:${index}`}
          src={image.data}
          alt={`工具 ${part.toolName} 输出图片 ${index + 1}`}
          className="max-h-48 w-full object-cover"
        />
      ))}
    </div>
  )
}

export function NestedCallsSummary({ part }: { part: HarnessToolViewPart }) {
  const nested = part.nestedCalls
  if (!nested || nested.calls.length === 0) return null
  const failed = nested.calls.filter((call) => call.status === 'error').length
  return (
    <details
      data-slot="huan-nested-calls"
      className="bg-muted/30 rounded-md border px-2 py-1.5 text-xs"
    >
      <summary className="cursor-pointer">
        <Trans>子调用摘要</Trans>
        <span className="text-muted-foreground">
          {' '}
          {nested.complete ? <Trans>完整</Trans> : <Trans>不完整</Trans>} · {nested.calls.length}
          {failed > 0 ? ` · ${failed} 失败` : ''}
        </span>
      </summary>
      <ul className="mt-1 space-y-0.5">
        {nested.calls.map((call) => (
          <li key={call.id} className="flex min-w-0 items-start gap-2">
            <span
              className={
                call.status === 'error'
                  ? 'text-destructive shrink-0'
                  : 'text-muted-foreground shrink-0'
              }
            >
              {call.status === 'error' ? '×' : call.status === 'ok' ? '✓' : '…'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono">
              {call.name}
              {call.arguments && Object.keys(call.arguments).length > 0
                ? ` ${safeJson(call.arguments).replace(/\s+/g, ' ')}`
                : ''}
            </span>
            {call.durationMs !== undefined ? (
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {call.durationMs}ms
              </span>
            ) : null}
            {call.error ? (
              <span className="text-destructive max-w-40 truncate" title={call.error}>
                {call.error}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  )
}
