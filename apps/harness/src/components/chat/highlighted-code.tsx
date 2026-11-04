/**
 * 代码语法高亮的业务组合。
 *
 * 只有语言受支持且内容在显示上限内时才挂载调用官方 useHighlightedCode
 * 的子组件；其余情况沿用 CodeBlockContent 的纯文本渲染，不加载语法。
 * 高亮行用 memo 隔离父组件刷新，复制值仍由调用方保存原字符串。
 */

import { memo } from 'react'
import { CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { cn } from '@/lib/utils'
import { highlightLanguageOf, withinHighlightLimits } from './code-syntax'

interface HighlightedCodeContentProps {
  value: string
  language?: string
  lineNumbers?: boolean
  wrap?: boolean
  className?: string
}

const contentClassName = 'overflow-visible'

/** 高亮行：memo 保证内容与语言不变时，父组件刷新不重复分词。 */
const HighlightedLines = memo(function HighlightedLines({
  value,
  language,
  lineNumbers,
  wrap,
  className,
}: HighlightedCodeContentProps & { language: string }) {
  const lines = useHighlightedCode(value, language)
  return (
    <CodeBlockContent
      wrap={wrap}
      lineNumbers={lineNumbers}
      startLine={1}
      className={cn(contentClassName, className)}
      style={{ maskImage: 'none' }}
    >
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 高亮行没有稳定 ID，顺序即内容
        <CodeBlockLine key={index}>{line}</CodeBlockLine>
      ))}
    </CodeBlockContent>
  )
})

/** 代码正文；不满足高亮条件时按原字符串渲染，行号与滚动保持上游行为。
 * 外层 memo 同样隔离父组件刷新，避免重复计算语言与上限。 */
export const HighlightedCodeContent = memo(function HighlightedCodeContent({
  value,
  language,
  lineNumbers = false,
  wrap = false,
  className,
}: HighlightedCodeContentProps) {
  const resolved = highlightLanguageOf(language)
  if (!resolved || !withinHighlightLimits(value)) {
    return (
      <CodeBlockContent
        wrap={wrap}
        lineNumbers={lineNumbers}
        startLine={1}
        className={cn(contentClassName, className)}
        style={{ maskImage: 'none' }}
      >
        {value}
      </CodeBlockContent>
    )
  }
  return (
    <HighlightedLines
      value={value}
      language={resolved}
      lineNumbers={lineNumbers}
      wrap={wrap}
      className={className}
    />
  )
})
