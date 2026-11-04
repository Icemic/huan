/**
 * 会话树 DTO 构造与落点恢复规则。
 *
 * 只使用 Pi SDK 公开的 SessionManager 读取方法（getTree/getEntry/getLeafId/
 * getEntryCount/branch/resetLeaf），不深导入内部 helper，也不复制 SDK 的
 * navigateTree 实现：这里只做「目标节点的预期落点」与展示投影。
 */
import type { SessionEntry, SessionManager, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type {
  HarnessThreadTree,
  HarnessThreadTreeNode,
  HarnessThreadTreeOperation,
  HarnessTreeEntryKind,
} from '@huan/protocol'
import type { WorkspaceSessionLeaf } from './workspace-store.js'

/** 树摘要的最大展示长度（单行）。 */
const SUMMARY_MAX_LENGTH = 160

/** 结构 revision：条目数 + 活动落点。任何 append 都会推进 leaf 或条目数。 */
export function sessionTreeRevision(sessionManager: SessionManager): string {
  const leafId = sessionManager.getLeafId()
  return `v1:${sessionManager.getEntryCount()}:${leafId ?? 'null'}`
}

/** 合并空白并截断，供树行单行展示。 */
function normalizeSummary(text: string | undefined): string | undefined {
  if (!text) return undefined
  const compact = text.replaceAll(/\s+/g, ' ').trim()
  if (!compact) return undefined
  return compact.length > SUMMARY_MAX_LENGTH
    ? `${compact.slice(0, SUMMARY_MAX_LENGTH - 1)}…`
    : compact
}

/** 读取消息/自定义消息内容中的文本（不含图片二进制）。 */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const block = part as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** 一个 Pi 条目的呈现分类与摘要。 */
function describeEntry(entry: SessionEntry): {
  kind: HarnessTreeEntryKind
  summary: string
  role?: string
  hasToolCalls?: boolean
} {
  switch (entry.type) {
    case 'message': {
      const message = entry.message
      const role = message.role
      if (role === 'system') {
        return { kind: 'state', role, summary: '系统提示' }
      }
      if (role === 'user') {
        return {
          kind: 'user',
          role,
          summary: normalizeSummary(contentText(message.content)) ?? '(空消息)',
        }
      }
      if (role === 'assistant') {
        const toolCalls = Array.isArray(message.content)
          ? message.content.filter(
              (part) =>
                part !== null &&
                typeof part === 'object' &&
                (part as { type?: unknown }).type === 'toolCall',
            )
          : []
        const text = normalizeSummary(contentText(message.content))
        const error =
          message.stopReason === 'error' && message.errorMessage
            ? normalizeSummary(message.errorMessage)
            : undefined
        const toolNames = toolCalls
          .map((part) => (part as { name?: unknown }).name)
          .filter((name): name is string => typeof name === 'string')
        const summary =
          text ??
          error ??
          (toolNames.length > 0 ? `工具调用：${toolNames.join('、')}` : '(空助手消息)')
        // 只有没有任何正文/错误的工具调用才整体归入工具节点；正文或错误仍按助手
        // 消息呈现，不根据摘要是否以「工具调用：」开头来猜测类型。
        const kind: HarnessTreeEntryKind =
          toolCalls.length > 0 && text === undefined && error === undefined ? 'tool' : 'assistant'
        return {
          kind,
          role,
          summary,
          ...(toolCalls.length > 0 ? { hasToolCalls: true } : {}),
        }
      }
      if (role === 'toolResult') {
        const text = normalizeSummary(contentText(message.content)) ?? '(无输出)'
        return {
          kind: 'tool',
          role,
          summary: normalizeSummary(`${message.toolName}：${text}`) ?? text,
        }
      }
      if (role === 'bashExecution') {
        return {
          kind: 'tool',
          role,
          summary: normalizeSummary(`$ ${message.command}`) ?? '$',
        }
      }
      if (role === 'branchSummary' || role === 'compactionSummary') {
        return {
          kind: 'summary',
          role,
          summary: normalizeSummary(message.summary) ?? '(摘要)',
        }
      }
      if (role === 'custom') {
        return {
          kind: 'custom',
          role,
          summary:
            normalizeSummary(contentText(message.content)) ??
            normalizeSummary(`自定义消息：${message.customType}`) ??
            '自定义消息',
        }
      }
      return {
        kind: 'state',
        role,
        summary: normalizeSummary(contentText((message as { content?: unknown }).content)) ?? role,
      }
    }
    case 'custom_message': {
      return {
        kind: 'custom',
        summary:
          normalizeSummary(contentText(entry.content)) ??
          normalizeSummary(`自定义消息：${entry.customType}`) ??
          '自定义消息',
      }
    }
    case 'compaction':
      return { kind: 'summary', summary: normalizeSummary(entry.summary) ?? '压缩摘要' }
    case 'branch_summary':
      return { kind: 'summary', summary: normalizeSummary(entry.summary) ?? '分支摘要' }
    case 'label':
      return {
        kind: 'state',
        summary: entry.label ? `标签：${entry.label}` : '清除标签',
      }
    case 'model_change':
      return { kind: 'state', summary: `模型：${entry.provider}/${entry.modelId}` }
    case 'thinking_level_change':
      return { kind: 'state', summary: `Thinking：${entry.thinkingLevel}` }
    case 'session_info':
      return {
        kind: 'state',
        summary: entry.name ? `会话名称：${entry.name}` : '清除会话名称',
      }
    case 'usage':
      return { kind: 'state', summary: `用量记录：${entry.kind}` }
    case 'custom':
      return { kind: 'state', summary: `自定义条目：${entry.customType}` }
    case 'context_edit':
      return { kind: 'state', summary: '上下文编辑' }
    default:
      return {
        kind: 'state',
        summary: (entry as { type: string }).type,
      }
  }
}

/** 从 session manager 构建扁平先序树。 */
export function buildSessionTree(
  threadId: string,
  sessionManager: SessionManager,
  options: {
    branchSummarySkipPrompt: boolean
    operation?: HarnessThreadTreeOperation
  },
): HarnessThreadTree {
  const roots = sessionManager.getTree()
  const leafId = sessionManager.getLeafId()
  const parentById = new Map<string, string | null>()
  const activePath = new Set<string>()

  // 索引与展开都使用显式栈：线性会话可能有上万个条目，递归会栈溢出。
  const indexStack: SessionTreeNode[] = [...roots]
  while (indexStack.length > 0) {
    const node = indexStack.pop()
    if (!node) continue
    parentById.set(node.entry.id, node.entry.parentId)
    for (const child of node.children) indexStack.push(child)
  }

  // 活动路径：从当前 leaf 沿父链回溯（entryId 来自真实记录，不猜测）。
  let cursor = leafId
  while (cursor) {
    if (activePath.has(cursor)) break
    activePath.add(cursor)
    cursor = parentById.get(cursor) ?? null
  }

  const nodes: HarnessThreadTreeNode[] = []
  const stack: Array<{ node: SessionTreeNode; depth: number }> = []
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index]
    if (root) stack.push({ node: root, depth: 0 })
  }
  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    const { node, depth } = item
    const entry = node.entry
    const described = describeEntry(entry)
    nodes.push({
      entryId: entry.id,
      parentId: entry.parentId,
      depth,
      kind: described.kind,
      entryType: entry.type,
      ...(described.role ? { role: described.role } : {}),
      summary: described.summary,
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(node.label ? { label: node.label } : {}),
      active: activePath.has(entry.id),
      isLeaf: entry.id === leafId,
      childCount: node.children.length,
      ...(described.hasToolCalls ? { hasToolCalls: true } : {}),
    })
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index]
      if (child) stack.push({ node: child, depth: depth + 1 })
    }
  }

  return {
    threadId,
    leafId,
    revision: sessionTreeRevision(sessionManager),
    nodes,
    branchSummarySkipPrompt: options.branchSummarySkipPrompt,
    ...(options.operation ? { operation: options.operation } : {}),
  }
}

/**
 * 应用 sidecar 树落点。
 *
 * 水位不同（外部 Pi 或正常发送追加了条目）或节点已不存在时忽略落点，
 * 以 Pi JSONL 为准；不修改 Pi 文件。返回状态供测试与调用方判断。
 */
export function applyStoredSessionLeaf(
  sessionManager: SessionManager,
  stored: WorkspaceSessionLeaf | undefined,
): 'applied' | 'stale' | 'missing' {
  if (!stored) return 'missing'
  if (sessionManager.getEntryCount() !== stored.entryCount) return 'stale'
  if (stored.leafId !== null && !sessionManager.getEntry(stored.leafId)) return 'stale'
  if (sessionManager.getLeafId() === stored.leafId) return 'applied'
  if (stored.leafId === null) sessionManager.resetLeaf()
  else sessionManager.branch(stored.leafId)
  return 'applied'
}
