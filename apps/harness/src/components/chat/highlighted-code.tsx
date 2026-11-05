/**
 * 代码语法高亮的业务组合。
 *
 * 直接挂载官方 useHighlightedCode，由 lib/highlighter.tsx 决定语言是否可用；
 * 未知语言由 hook 回退为原文。高亮行用 memo 隔离父组件刷新，复制值仍由
 * 调用方保存原字符串。diff 模式只给既有行套用增删/hunk 样式，不拆分或
 * 重建行内容。
 */

import { memo } from 'react'
import { CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { cn } from '@/lib/utils'
import { diffLinesOf } from './tool-presentation'

interface HighlightedCodeContentProps {
  value: string
  language?: string
  lineNumbers?: boolean
  wrap?: boolean
  className?: string
  /** 按统一 diff 解析行类型；行内容仍来自高亮结果，保留原始正负号。 */
  diff?: boolean
}

const contentClassName = 'overflow-visible'

/** 代码正文；行号、滚动与空行保持上游 CodeBlock 行为。 */
export const HighlightedCodeContent = memo(function HighlightedCodeContent({
  value,
  language,
  lineNumbers = false,
  wrap = false,
  className,
  diff = false,
}: HighlightedCodeContentProps) {
  const lines = useHighlightedCode(value, language ?? 'text')
  const diffLines = diff ? diffLinesOf(value) : undefined
  return (
    <CodeBlockContent
      wrap={wrap}
      lineNumbers={lineNumbers}
      startLine={1}
      className={cn(contentClassName, className)}
      style={{ maskImage: 'none' }}
    >
      {lines.map((line, index) => {
        const kind = diffLines?.[index]?.kind
        return (
          <CodeBlockLine
            // biome-ignore lint/suspicious/noArrayIndexKey: 高亮行没有稳定 ID，顺序即内容
            key={index}
            variant={
              kind === 'added'
                ? 'added'
                : kind === 'removed'
                  ? 'removed'
                  : kind === 'hunk'
                    ? 'highlighted'
                    : 'default'
            }
            className={cn(
              (kind === 'file' || kind === 'hunk') && 'text-xs text-muted-foreground',
              // 正负号已在原始行内容里，取消行变体自带的前缀，避免重复。
              (kind === 'added' || kind === 'removed') && 'after:content-none',
            )}
          >
            {line}
          </CodeBlockLine>
        )
      })}
    </CodeBlockContent>
  )
})
