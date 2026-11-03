/**
 * 消息 Markdown 渲染：react-markdown + remark-gfm。
 *
 * 代码块复用官方 CodeBlock 组合（语言、复制、独立横向滚动），表格与图片
 * 在内容列内自适应；不引入第二套 Markdown 解析器或高亮运行时。
 */

import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

const languageOf = (className: string | undefined): string => {
  const match = className?.match(/(?:^|\s)language-([\w#+.-]+)/)
  return match?.[1] ?? ''
}

const components: Components = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn('mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn('mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        'mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0',
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        'mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0',
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn('mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn('mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p className={cn('my-3 leading-relaxed first:mt-0 last:mb-0', className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn('text-primary underline underline-offset-2 hover:text-primary/80', className)}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        'border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4',
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn('marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1', className)}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn('marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1', className)}
      {...props}
    />
  ),
  li: ({ className, ...props }) => <li className={cn('leading-relaxed', className)} {...props} />,
  hr: ({ className, ...props }) => (
    <hr className={cn('border-muted-foreground/20 my-3', className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn('font-semibold', className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <ScrollArea
      orientation="horizontal"
      className="my-3 w-full min-w-0"
      viewportProps={{ className: 'overscroll-x-contain' }}
    >
      <table
        className={cn('w-full min-w-max border-separate border-spacing-0 text-sm', className)}
        {...props}
      />
    </ScrollArea>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        'bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right',
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        'border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right',
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        'm-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg',
        className,
      )}
      {...props}
    />
  ),
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children
    if (typeof child !== 'object' || child === null || !('props' in child)) {
      return (
        <ScrollArea orientation="horizontal" className="bg-muted/30 my-3 rounded-lg">
          <pre className="p-3">{textOf(children)}</pre>
        </ScrollArea>
      )
    }
    const props = (child as { props?: { className?: string; children?: ReactNode } }).props
    const language = languageOf(props?.className)
    const code = textOf(props?.children).replace(/\n$/, '')
    return (
      <CodeBlock className="my-3">
        <CodeBlockHeader>
          <CodeBlockTitle>{language || '代码'}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent className="max-h-[min(60vh,32rem)]">{code}</CodeBlockContent>
      </CodeBlock>
    )
  },
  code: ({ className, ...props }) => (
    <code
      className={cn(
        'bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em] break-words',
        className,
      )}
      {...props}
    />
  ),
  img: ({ className, alt, ...props }) => (
    <img
      className={cn('my-2 max-w-full rounded-md border object-contain', className)}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      {...props}
    />
  ),
}

/** 单个文本部分；按内容 memo，流式时仅当前部分重渲染。 */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  if (!text) return null
  return (
    <div className="min-w-0 text-sm leading-relaxed wrap-break-word">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
