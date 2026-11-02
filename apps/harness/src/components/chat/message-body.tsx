/**
 * 一条助手消息的内容分派：正文、Thinking、工具、图片与数据回退。
 *
 * 工具父子关系在渲染层按 parentToolCallId 组树；子调用不再重复占据顶层
 * 顺序。投影仍负责权威顺序与数据，这里只改变折叠内的呈现层级。
 */

import type { HarnessMessageView, HarnessMessageViewPart, HarnessToolViewPart } from '@huan/react'
import { Fragment, useMemo } from 'react'
import { DataPart } from './data-part'
import { MarkdownText } from './markdown'
import { MessageImage } from './message-image'
import { ThinkingPart, type ToolNode, ToolPart } from './tool-part'

const toolTreeOf = (
  parts: readonly HarnessMessageViewPart[],
  messageId: string,
): { roots: ToolNode[]; nodes: ReadonlyMap<string, ToolNode>; nested: ReadonlySet<string> } => {
  const toolParts = parts.filter((part): part is HarnessToolViewPart => part.type === 'tool')
  const nodes = new Map<string, ToolNode>()
  const roots: ToolNode[] = []
  const nested = new Set<string>()
  for (const part of toolParts) {
    nodes.set(part.toolCallId, {
      key: `${messageId}:tool:${part.toolCallId}`,
      part,
      children: [],
    })
  }
  for (const part of toolParts) {
    const node = nodes.get(part.toolCallId)
    if (!node) continue
    const parentId = part.parentToolCallId
    const parent = parentId ? nodes.get(parentId) : undefined
    // 父调用存在时归入父节点；自引用/环回或父项不在本消息时保留为根。
    if (parent && parent !== node && !isDescendant(nodes, parent, node)) {
      parent.children.push(node)
      nested.add(part.toolCallId)
    } else {
      roots.push(node)
    }
  }
  return { roots, nodes, nested }
}

const isDescendant = (
  nodes: ReadonlyMap<string, ToolNode>,
  candidate: ToolNode,
  node: ToolNode,
): boolean => {
  let current: ToolNode | undefined = candidate
  const seen = new Set<string>()
  while (current) {
    if (current === node) return true
    if (seen.has(current.key)) return false
    seen.add(current.key)
    const parentId: string | undefined = current.part.parentToolCallId
    current = parentId ? nodes.get(parentId) : undefined
  }
  return false
}

/** 助手消息正文；按 part 顺序保留，工具子项在父项折叠中递归。 */
export function AssistantMessageParts({
  view,
  threadId,
}: {
  view: HarnessMessageView
  threadId: string | undefined
}) {
  const tree = useMemo(
    () => toolTreeOf(view.parts, `${threadId ?? 'none'}:${view.id}`),
    [threadId, view.id, view.parts],
  )
  const running = view.status.type === 'running'
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {view.parts.map((part, index) => {
        const key = `${view.id}:${part.type}:${index}`
        switch (part.type) {
          case 'text':
            return part.text.trim() ? <MarkdownText key={key} text={part.text} /> : null
          case 'thinking':
            return (
              <ThinkingPart
                key={key}
                part={part}
                partKey={`${threadId ?? 'none'}:${view.id}:thinking:${index}`}
                running={running}
              />
            )
          case 'tool': {
            if (tree.nested.has(part.toolCallId)) return null
            const node = tree.nodes.get(part.toolCallId)
            return node ? <ToolPart key={key} node={node} threadId={threadId} /> : null
          }
          case 'image':
            return (
              <MessageImage key={key} src={part.data} alt="助手消息中的图片" className="max-h-80" />
            )
          case 'data':
            return (
              <Fragment key={key}>
                <DataPart part={part} />
              </Fragment>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
