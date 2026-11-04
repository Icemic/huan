/**
 * 会话树纯投影。
 *
 * 输入仍是宿主给出的先序扁平节点；这里一次性建立父链、子树边界与分支入口，
 * 再按筛选/搜索/折叠生成可见行。所有遍历都使用下标和显式循环，避免长单链
 * 递归栈溢出，也不缓存第二份树数据。
 *
 * 分支入口是「同父多个子节点」中的每个子节点（多个根也算）；只有分支入口
 * 提供折叠，折叠只隐藏其后代。单链不增加缩进，分叉子入口比父级分支深一层，
 * 同一分支内直到下一次分叉都保持该深度。
 */
import type { HarnessThreadTree, HarnessThreadTreeNode } from '@huan/protocol'

/** 树过滤模式。 */
export type SessionTreeFilter = 'conversation' | 'tools' | 'all' | 'labeled'

/** 索引行；只引用协议节点，不复制节点字段。 */
export interface SessionTreeIndexRow {
  readonly node: HarnessThreadTreeNode
  readonly index: number
  readonly parentId: string | null
  /** 父行下标；根为 -1。 */
  readonly parentIndex: number
  /** 子树结束下标（不含）；无子节点时等于 index + 1。 */
  readonly subtreeEnd: number
  /** 是否为分支入口（同父多子，含多根）；即使无子节点也可能为 true。 */
  readonly branchRoot: boolean
  /** 是否提供折叠；只有带后代的分支入口为 true。 */
  readonly expandable: boolean
  /** 所属分支入口的 entryId。 */
  readonly branchId: string
  /** 展示深度；同一分支内不继续增加。 */
  readonly branchDepth: number
  /** 完整子树的后代数（不含自身）。 */
  readonly descendantCount: number
}

/** 分支入口元信息。 */
export interface SessionTreeBranchInfo {
  readonly entryId: string
  readonly parentId: string | null
  readonly depth: number
  readonly subtreeEnd: number
  readonly childCount: number
  readonly descendantCount: number
  readonly expandable: boolean
}

export interface SessionTreeIndexMeta {
  readonly nodeCount: number
  readonly leafId: string | null
  readonly rootCount: number
  readonly branchRootCount: number
}

/** 完整树的 O(n) 索引。 */
export interface SessionTreeIndex {
  readonly rows: readonly SessionTreeIndexRow[]
  readonly byId: ReadonlyMap<string, SessionTreeIndexRow>
  readonly parentById: ReadonlyMap<string, string | null>
  readonly branchById: ReadonlyMap<string, SessionTreeBranchInfo>
  readonly meta: SessionTreeIndexMeta
  /** root→leaf 路径上需要默认展开的分支入口（根到叶顺序）。 */
  readonly activeBranchIds: readonly string[]
}

export interface SessionTreeProjectionOptions {
  readonly expanded: ReadonlySet<string>
  readonly filter: SessionTreeFilter
  readonly search: string
}

/** 可见行；`branch` 表示该行是可折叠的分支入口。 */
export interface SessionTreeVisibleRow {
  readonly node: HarnessThreadTreeNode
  readonly depth: number
  readonly branch: boolean
  readonly expanded: boolean
  /** 折叠时隐藏的完整子树条数；展开或搜索临时揭示时为 0。 */
  readonly hiddenCount: number
  /** 本行类型/搜索不匹配，仅为承载匹配后代的上下文而显示。 */
  readonly contextOnly?: boolean
}

/** 展开与当前选中；由面板状态提供。 */
export interface SessionTreeExpansionState {
  readonly expanded: ReadonlySet<string>
  readonly selectedEntryId: string | undefined
}

/** 应用一棵新树后应保留的展开与选中。 */
export interface NextSessionTreeExpansion {
  readonly expandedEntryIds: ReadonlySet<string>
  readonly selectedEntryId: string | undefined
}

const matchesFilter = (node: HarnessThreadTreeNode, filter: SessionTreeFilter): boolean => {
  if (filter === 'conversation') {
    return (
      node.kind === 'user' ||
      node.kind === 'assistant' ||
      node.kind === 'summary' ||
      node.kind === 'custom'
    )
  }
  if (filter === 'tools') return node.kind === 'tool' || node.hasToolCalls === true
  if (filter === 'labeled') return node.label !== undefined
  return true
}

const matchesSearch = (node: HarnessThreadTreeNode, needle: string): boolean => {
  if (!needle) return true
  const haystack =
    `${node.summary} ${node.label ?? ''} ${node.role ?? ''} ${node.entryId}`.toLowerCase()
  return haystack.includes(needle)
}

/** 建立父链、子树边界、分支入口与活动路径；单次或常数次线性遍历。 */
export const buildSessionTreeIndex = (
  nodes: readonly HarnessThreadTreeNode[],
): SessionTreeIndex => {
  const count = nodes.length
  const indexById = new Map<string, number>()
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]
    if (!node || indexById.has(node.entryId)) continue
    indexById.set(node.entryId, index)
  }

  const parentIndices = new Array<number>(count).fill(-1)
  const childCounts = new Array<number>(count).fill(0)
  const parentById = new Map<string, string | null>()
  const rootIndices: number[] = []
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]
    if (!node) continue
    const parentIndex = node.parentId === null ? -1 : (indexById.get(node.parentId) ?? -1)
    const parent = parentIndex >= 0 && parentIndex < index ? parentIndex : -1
    parentIndices[index] = parent
    parentById.set(node.entryId, node.parentId)
    if (parent < 0) {
      rootIndices.push(index)
    } else {
      childCounts[parent] = (childCounts[parent] ?? 0) + 1
    }
  }

  // 先序遍历下，深度不小于当前节点的最近栈顶就是上一个兄弟子树结束的位置。
  const subtreeEnds = new Array<number>(count).fill(count)
  const open: number[] = []
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]
    if (!node) continue
    while (open.length > 0) {
      const top = open[open.length - 1]
      if (top === undefined) break
      const topNode = nodes[top]
      if ((topNode?.depth ?? -1) < node.depth) break
      open.pop()
      subtreeEnds[top] = index
    }
    open.push(index)
  }
  while (open.length > 0) {
    const top = open.pop()
    if (top !== undefined) subtreeEnds[top] = count
  }

  const rows: SessionTreeIndexRow[] = []
  const byId = new Map<string, SessionTreeIndexRow>()
  const branchById = new Map<string, SessionTreeBranchInfo>()
  let leafId: string | null = null
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]
    if (!node) continue
    const parentIndex = parentIndices[index] ?? -1
    const parentRow = parentIndex >= 0 ? rows[parentIndex] : undefined
    const branchRoot =
      parentIndex < 0 ? rootIndices.length > 1 : (childCounts[parentIndex] ?? 0) > 1
    const branchDepth = parentIndex < 0 ? 0 : (parentRow?.branchDepth ?? 0) + (branchRoot ? 1 : 0)
    const subtreeEnd = subtreeEnds[index] ?? count
    const descendantCount = Math.max(0, subtreeEnd - index - 1)
    const expandable = branchRoot && descendantCount > 0
    const branchId = branchRoot ? node.entryId : (parentRow?.branchId ?? node.entryId)
    const row: SessionTreeIndexRow = {
      node,
      index,
      parentId: node.parentId,
      parentIndex,
      subtreeEnd,
      branchRoot,
      expandable,
      branchId,
      branchDepth,
      descendantCount,
    }
    rows[index] = row
    byId.set(node.entryId, row)
    if (branchRoot) {
      branchById.set(node.entryId, {
        entryId: node.entryId,
        parentId: node.parentId,
        depth: branchDepth,
        subtreeEnd,
        childCount: childCounts[index] ?? 0,
        descendantCount,
        expandable,
      })
    }
    if (leafId === null && node.isLeaf) leafId = node.entryId
  }

  const activeBranchIds: string[] = []
  const leafRow = leafId === null ? undefined : byId.get(leafId)
  let cursor = leafRow?.parentIndex ?? -1
  const seen = new Set<number>()
  while (cursor >= 0 && cursor < count && !seen.has(cursor)) {
    seen.add(cursor)
    const row = rows[cursor]
    if (!row) break
    if (row.expandable) activeBranchIds.push(row.node.entryId)
    cursor = row.parentIndex
  }
  activeBranchIds.reverse()

  return {
    rows,
    byId,
    parentById,
    branchById,
    meta: {
      nodeCount: count,
      leafId,
      rootCount: rootIndices.length,
      branchRootCount: branchById.size,
    },
    activeBranchIds,
  }
}

/**
 * 按当前筛选、搜索与折叠集合生成可见行。
 *
 * 搜索暂时忽略折叠，只揭示命中节点与其路径上必要的分支入口，不修改传入的
 * 展开集合。无搜索时，类型过滤保留承载匹配后代的分支入口并标记 contextOnly；
 * 被折叠祖先遮住的后代不会显示，隐藏条数为该分支完整子树后代数。
 */
export const projectSessionTree = (
  index: SessionTreeIndex,
  options: SessionTreeProjectionOptions,
): SessionTreeVisibleRow[] => {
  const { rows } = index
  const count = rows.length
  const needle = options.search.trim().toLowerCase()
  const searchActive = needle.length > 0

  const matchFlags = new Uint8Array(count)
  for (let position = 0; position < count; position += 1) {
    const row = rows[position]
    if (!row) continue
    matchFlags[position] =
      matchesFilter(row.node, options.filter) && matchesSearch(row.node, needle) ? 1 : 0
  }

  // 逆先序累加：子节点下标总在父节点之后，一次循环即可得到每个子树的
  // 匹配数，供保留上下文的 branch root 使用。
  const matchCounts = new Uint32Array(count)
  for (let position = count - 1; position >= 0; position -= 1) {
    const row = rows[position]
    if (!row) continue
    if (matchFlags[position] === 1) {
      matchCounts[position] = (matchCounts[position] ?? 0) + 1
    }
    if (row.parentIndex >= 0) {
      matchCounts[row.parentIndex] =
        (matchCounts[row.parentIndex] ?? 0) + (matchCounts[position] ?? 0)
    }
  }

  // 无搜索时按折叠祖先屏蔽子树；搜索时临时忽略折叠，不写回展开集合。
  const blockedByCollapse = new Uint8Array(count)
  if (!searchActive) {
    for (let position = 0; position < count; position += 1) {
      const row = rows[position]
      if (!row || row.parentIndex < 0) continue
      const parent = rows[row.parentIndex]
      const parentCollapsed =
        parent?.expandable === true && !options.expanded.has(parent.node.entryId)
      blockedByCollapse[position] =
        blockedByCollapse[row.parentIndex] === 1 || parentCollapsed ? 1 : 0
    }
  }

  const visible: SessionTreeVisibleRow[] = []
  for (let position = 0; position < count; position += 1) {
    const row = rows[position]
    if (!row) continue
    if (!searchActive && blockedByCollapse[position] === 1) continue
    const matched = matchFlags[position] === 1
    const contextOnly = !matched && row.expandable && (matchCounts[position] ?? 0) > 0
    if (!matched && !contextOnly) continue
    const branch = row.expandable
    const expandedNow = branch
      ? searchActive
        ? true
        : options.expanded.has(row.node.entryId)
      : false
    visible.push({
      node: row.node,
      depth: row.branchDepth,
      branch,
      expanded: expandedNow,
      hiddenCount: branch && !expandedNow ? row.descendantCount : 0,
      ...(matched ? {} : { contextOnly: true }),
    })
  }
  return visible
}

/**
 * 将新树快照合并进面板展开/选中状态。
 *
 * - 首次加载：展开 root→leaf 路径上的分支入口，并选中 leaf；
 * - 后续刷新：保留仍存在的可折叠入口；leaf 改变时只补开新路径，不强制重新
 *   展开用户已收起的分支；
 * - leaf 改变时默认选中新 leaf，但保留用户此前显式选择的其他节点；
 * - 选中节点从新树消失时回退到 leaf。
 */
export const resolveSessionTreeExpansion = (
  previousTree: HarnessThreadTree | undefined,
  nextTree: HarnessThreadTree,
  current: SessionTreeExpansionState,
): NextSessionTreeExpansion => {
  const index = buildSessionTreeIndex(nextTree.nodes)
  const treeLeafId =
    nextTree.leafId !== null && index.byId.has(nextTree.leafId)
      ? nextTree.leafId
      : index.meta.leafId
  const defaultSelected = treeLeafId !== null && index.byId.has(treeLeafId) ? treeLeafId : undefined
  const validSelected =
    current.selectedEntryId !== undefined && index.byId.has(current.selectedEntryId)
      ? current.selectedEntryId
      : undefined

  if (!previousTree) {
    const expanded = new Set(index.activeBranchIds)
    // 历史消息入口会在读取完成前指定节点；保留该选择并揭示其分支。
    let cursor = validSelected ? index.byId.get(validSelected)?.parentIndex : undefined
    while (cursor !== undefined && cursor >= 0) {
      const row = index.rows[cursor]
      if (!row) break
      if (row.expandable) expanded.add(row.node.entryId)
      cursor = row.parentIndex
    }
    return {
      expandedEntryIds: expanded,
      selectedEntryId: validSelected ?? defaultSelected,
    }
  }

  const expanded = new Set<string>()
  for (const entryId of current.expanded) {
    if (index.branchById.get(entryId)?.expandable) expanded.add(entryId)
  }
  const leafChanged = previousTree.leafId !== nextTree.leafId
  if (leafChanged) {
    for (const entryId of index.activeBranchIds) expanded.add(entryId)
  }

  const keepSelection =
    leafChanged && validSelected !== undefined && current.selectedEntryId !== previousTree.leafId
  const selectedEntryId = keepSelection
    ? validSelected
    : leafChanged
      ? defaultSelected
      : (validSelected ?? defaultSelected)
  return { expandedEntryIds: expanded, selectedEntryId }
}
