/**
 * 代码语法高亮的业务组合。
 *
 * 完整代码交给lib/highlighter同步高亮；diff只把每个hunk的修改前/
 * 修改后代码交给对应文件语言，再把高亮行映回原补丁顺序。文件头、hunk
 * 头、增删前缀与旧版行号均保留原文，复制仍由调用方使用原字符串。
 */

import { memo, type ReactNode, useMemo } from 'react'
import { CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import { useCodeHighlighter } from '@/lib/highlighter'
import { cn } from '@/lib/utils'
import { type DiffLineKind, parseDiff } from './code-diff'

interface HighlightedCodeContentProps {
  value: string
  language?: string
  lineNumbers?: boolean
  wrap?: boolean
  className?: string
  /** 按统一 diff 或旧版带行号 diff 解析，并按文件语言分别高亮两侧。 */
  diff?: boolean
}

const contentClassName = 'overflow-visible'

const variantOf = (kind: DiffLineKind | undefined) => {
  if (kind === 'added') return 'added'
  if (kind === 'removed') return 'removed'
  if (kind === 'hunk') return 'highlighted'
  return 'default'
}

const lineClassNameOf = (kind: DiffLineKind | undefined) =>
  cn(
    (kind === 'file' || kind === 'hunk' || kind === 'meta') && 'text-xs text-muted-foreground',
    // 正负号来自补丁原文，取消行变体自带的前缀，避免重复。
    (kind === 'added' || kind === 'removed') && 'after:content-none',
  )

/** 代码正文；行号、滚动与空行保持上游 CodeBlock 行为。 */
export const HighlightedCodeContent = memo(function HighlightedCodeContent({
  value,
  language,
  lineNumbers = false,
  wrap = false,
  className,
  diff = false,
}: HighlightedCodeContentProps) {
  const highlight = useCodeHighlighter(language)
  // 末尾换行不额外渲染空行；内部空行保持原位置。
  const code = diff ? value : value.replace(/\r?\n$/, '')

  const rendered = useMemo(() => {
    if (!diff) {
      return highlight(code).map((content) => ({ kind: undefined, content }))
    }

    const parsed = parseDiff(value)
    // 每个 hunk 独立分词，避免跨 hunk 的语法状态互相影响。
    const highlighted = parsed.hunks.map((hunk) => ({
      before: highlight(hunk.beforeLines.join('\n')),
      after: highlight(hunk.afterLines.join('\n')),
    }))

    return parsed.lines.map((line) => {
      if (line.code === undefined) {
        return { kind: line.kind, content: line.text }
      }

      const hunk = line.hunkIndex === undefined ? undefined : highlighted[line.hunkIndex]
      // 上下文同时进入两侧；优先使用修改后状态，删除行只取前侧。
      const nodes = line.afterIndex !== undefined ? hunk?.after : hunk?.before
      const index = line.afterIndex ?? line.beforeIndex
      const node = index === undefined ? undefined : nodes?.[index]
      const content: ReactNode = (
        <>
          {line.prefix}
          {node ?? line.code}
        </>
      )
      return { kind: line.kind, content }
    })
  }, [code, diff, highlight, value])

  return (
    <CodeBlockContent
      wrap={wrap}
      lineNumbers={lineNumbers}
      startLine={1}
      className={cn(contentClassName, className)}
      style={{ maskImage: 'none' }}
    >
      {rendered.map((line, index) => (
        <CodeBlockLine
          // biome-ignore lint/suspicious/noArrayIndexKey: 高亮行没有稳定 ID，顺序即内容
          key={index}
          variant={variantOf(line.kind)}
          className={lineClassNameOf(line.kind)}
        >
          {line.content}
        </CodeBlockLine>
      ))}
    </CodeBlockContent>
  )
})
