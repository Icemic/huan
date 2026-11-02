/**
 * 消息复制/下载的纯文本与 Markdown 序列化。
 *
 * 复制只取可读正文；下载保留思考、工具输出与数据回退，便于用户留存完整
 * 记录。不读取 store，也不改变权威消息。
 */

import type { HarnessMessageView, HarnessMessageViewPart } from '@huan/react'

const imageMarkdown = (part: Extract<HarnessMessageViewPart, { type: 'image' }>): string =>
  `![图片](${part.data})`

const fence = (value: string, language = 'text'): string => {
  const longest = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length + 1))
  const marker = '`'.repeat(longest)
  return `${marker}${language}\n${value}\n${marker}`
}

const toolMarkdown = (part: Extract<HarnessMessageViewPart, { type: 'tool' }>): string => {
  const lines = [`**工具：${part.toolName}**（${part.status}）`]
  if (Object.keys(part.arguments).length > 0) {
    lines.push(fence(JSON.stringify(part.arguments, null, 2), 'json'))
  }
  if (part.output) lines.push(fence(part.output))
  if (part.outputImages?.length) lines.push(...part.outputImages.map(imageMarkdown))
  if (part.nestedCalls) {
    const calls = part.nestedCalls.calls
      .map((call) => `- ${call.name}（${call.status}）${call.error ? `：${call.error}` : ''}`)
      .join('\n')
    lines.push(`**子调用摘要**${part.nestedCalls.complete ? '' : '（不完整）'}\n${calls}`)
  }
  return lines.join('\n\n')
}

const partMarkdown = (part: HarnessMessageViewPart): string => {
  switch (part.type) {
    case 'text':
      return part.text
    case 'thinking':
      return `> **思考**\n> ${part.text.replace(/\n/g, '\n> ')}`
    case 'image':
      return imageMarkdown(part)
    case 'tool':
      return toolMarkdown(part)
    case 'data':
      return `**数据：${part.name}**\n\n${fence(JSON.stringify(part.data, null, 2), 'json')}`
  }
}

/** 复制用正文：只取文本部分，图片与工具输出不拼进剪贴板。 */
export const textOfMessage = (view: HarnessMessageView): string =>
  view.parts
    .filter(
      (part): part is Extract<HarnessMessageViewPart, { type: 'text' }> => part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n\n')

/** 下载用 Markdown：保留思考、工具、图片和数据回退。 */
export const markdownOfMessage = (view: HarnessMessageView): string => {
  const body = view.parts.map(partMarkdown).filter(Boolean).join('\n\n')
  if (view.status.type !== 'incomplete') return body
  const reason =
    view.status.reason === 'cancelled'
      ? '已取消'
      : view.status.reason === 'length'
        ? '输出达到长度上限'
        : `运行失败${view.status.message ? `：${view.status.message}` : ''}`
  return `${body}\n\n> ${reason}`
}

/** 文件名按角色与消息 ID 生成；不含路径分隔符。 */
export const markdownFileName = (view: HarnessMessageView, title?: string): string => {
  const role = view.role === 'user' ? '用户' : '助手'
  const safeTitle = (title ?? '会话').replace(/[/:*?"<>|]+/g, '-').slice(0, 40)
  return `${safeTitle}-${role}-${view.id.replace(/[^\w.-]+/g, '-')}.md`
}

/** 触发浏览器下载；对象 URL 在点击后释放。 */
export const downloadTextFile = (fileName: string, content: string): void => {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
