import type { HarnessThreadTree, HarnessThreadTreeNode } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildSessionTreeIndex,
  projectSessionTree,
  resolveSessionTreeExpansion,
} from './session-tree-view'

const nodeOf = (
  entryId: string,
  parentId: string | null,
  depth: number,
  overrides: Partial<HarnessThreadTreeNode> = {},
): HarnessThreadTreeNode => ({
  entryId,
  parentId,
  depth,
  kind: 'user',
  entryType: 'message',
  summary: entryId,
  active: false,
  isLeaf: false,
  childCount: 0,
  ...overrides,
})

const treeOf = (
  nodes: HarnessThreadTreeNode[],
  leafId: string | null,
  revision = 'v1',
): HarnessThreadTree => ({
  threadId: 't1',
  leafId,
  revision,
  nodes,
  branchSummarySkipPrompt: true,
})

/** 根下 a/b 两个分支，各自带一个叶节点。 */
const forkedNodes = (leaf: 'a1' | 'b1'): HarnessThreadTreeNode[] => [
  nodeOf('r', null, 0, { childCount: 2, active: true }),
  nodeOf('a', 'r', 1, { childCount: 1, active: leaf === 'a1' }),
  nodeOf('a1', 'a', 2, { isLeaf: leaf === 'a1', active: leaf === 'a1' }),
  nodeOf('b', 'r', 1, { childCount: 1, active: leaf === 'b1' }),
  nodeOf('b1', 'b', 2, { isLeaf: leaf === 'b1', active: leaf === 'b1' }),
]

const idsOf = (rows: ReturnType<typeof projectSessionTree>): string[] =>
  rows.map((row) => row.node.entryId)

describe('会话树索引与投影', () => {
  it('长单链不缩进、无分支入口，也不会递归溢出', () => {
    const count = 5000
    const nodes = Array.from({ length: count }, (_, index) =>
      nodeOf(`n${index}`, index === 0 ? null : `n${index - 1}`, index, {
        active: true,
        isLeaf: index === count - 1,
      }),
    )
    const index = buildSessionTreeIndex(nodes)

    expect(index.rows).toHaveLength(count)
    expect(index.rows.every((row) => row.branchDepth === 0)).toBe(true)
    expect(index.meta.branchRootCount).toBe(0)
    expect(index.activeBranchIds).toEqual([])
    expect(index.meta.leafId).toBe(`n${count - 1}`)

    const rows = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'all',
      search: '',
    })
    expect(rows).toHaveLength(count)
    expect(rows.every((row) => row.depth === 0 && !row.branch && row.hiddenCount === 0)).toBe(true)
  })

  it('同父分叉的子入口深一层，分支内后代保持同深度；折叠只隐藏后代', () => {
    const index = buildSessionTreeIndex(forkedNodes('a1'))

    expect(index.branchById.get('a')).toMatchObject({
      depth: 1,
      descendantCount: 1,
      expandable: true,
    })
    expect(index.branchById.get('b')).toMatchObject({
      depth: 1,
      descendantCount: 1,
      expandable: true,
    })
    expect(index.rows.find((row) => row.node.entryId === 'a1')?.branchDepth).toBe(1)
    expect(index.activeBranchIds).toEqual(['a'])

    const collapsed = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'all',
      search: '',
    })
    expect(idsOf(collapsed)).toEqual(['r', 'a', 'b'])
    expect(collapsed.find((row) => row.node.entryId === 'a')).toMatchObject({
      branch: true,
      expanded: false,
      hiddenCount: 1,
    })
    expect(collapsed.find((row) => row.node.entryId === 'r')).toMatchObject({
      branch: false,
      hiddenCount: 0,
    })

    const opened = projectSessionTree(index, {
      expanded: new Set(['a']),
      filter: 'all',
      search: '',
    })
    expect(idsOf(opened)).toEqual(['r', 'a', 'a1', 'b'])
    expect(opened.find((row) => row.node.entryId === 'a')).toMatchObject({
      branch: true,
      expanded: true,
      hiddenCount: 0,
    })
  })

  it('多根各自是分支入口，嵌套分叉按父分支深度递增', () => {
    const roots = buildSessionTreeIndex([
      nodeOf('r1', null, 0, { childCount: 1, active: true }),
      nodeOf('a', 'r1', 1, { isLeaf: true, active: true }),
      nodeOf('r2', null, 0, { childCount: 1 }),
      nodeOf('b', 'r2', 1),
    ])
    expect(roots.meta.rootCount).toBe(2)
    expect(roots.rows.find((row) => row.node.entryId === 'r1')?.branchDepth).toBe(0)
    expect(roots.rows.find((row) => row.node.entryId === 'a')?.branchDepth).toBe(0)
    expect(roots.activeBranchIds).toEqual(['r1'])
    expect(
      idsOf(
        projectSessionTree(roots, {
          expanded: new Set(['r1']),
          filter: 'all',
          search: '',
        }),
      ),
    ).toEqual(['r1', 'a', 'r2'])

    const nested = buildSessionTreeIndex([
      nodeOf('r', null, 0, { childCount: 1 }),
      nodeOf('p', 'r', 1, { childCount: 2 }),
      nodeOf('x', 'p', 2, { childCount: 1 }),
      nodeOf('x1', 'x', 3, { childCount: 1 }),
      nodeOf('x2', 'x1', 4, { childCount: 2 }),
      nodeOf('m', 'x2', 5),
      nodeOf('n', 'x2', 5),
      nodeOf('y', 'p', 2),
    ])
    expect(nested.rows.find((row) => row.node.entryId === 'x')?.branchDepth).toBe(1)
    expect(nested.rows.find((row) => row.node.entryId === 'y')?.branchDepth).toBe(1)
    expect(nested.rows.find((row) => row.node.entryId === 'x1')?.branchDepth).toBe(1)
    expect(nested.rows.find((row) => row.node.entryId === 'x2')?.branchDepth).toBe(1)
    expect(nested.rows.find((row) => row.node.entryId === 'm')?.branchDepth).toBe(2)
    expect(nested.rows.find((row) => row.node.entryId === 'n')?.branchDepth).toBe(2)
    // x2 是单链延续，不是分支入口；m/n 才是 x2 下的分支入口。
    expect(nested.branchById.get('x2')).toBeUndefined()
    expect(nested.branchById.get('x')?.descendantCount).toBe(4)
  })

  it('无子节点的分支入口不提供折叠', () => {
    const index = buildSessionTreeIndex([
      nodeOf('r', null, 0, { childCount: 2 }),
      nodeOf('a', 'r', 1, { childCount: 1 }),
      nodeOf('a1', 'a', 2),
      nodeOf('b', 'r', 1, { isLeaf: true }),
    ])
    expect(index.branchById.get('b')).toMatchObject({ expandable: false, descendantCount: 0 })
    const rows = projectSessionTree(index, {
      expanded: new Set(['a']),
      filter: 'all',
      search: '',
    })
    expect(rows.find((row) => row.node.entryId === 'b')).toMatchObject({
      branch: false,
      expanded: false,
      hiddenCount: 0,
    })
  })

  it('类型过滤保留承载匹配后代的分支入口，并标记 contextOnly', () => {
    const index = buildSessionTreeIndex([
      nodeOf('r', null, 0, { childCount: 2 }),
      nodeOf('a', 'r', 1, { childCount: 1, kind: 'state' }),
      nodeOf('a1', 'a', 2, { kind: 'user' }),
      nodeOf('z', 'r', 1, { childCount: 1, kind: 'state' }),
      nodeOf('z1', 'z', 2, { kind: 'state' }),
    ])

    const collapsed = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'conversation',
      search: '',
    })
    expect(idsOf(collapsed)).toEqual(['r', 'a'])
    expect(collapsed.find((row) => row.node.entryId === 'a')).toMatchObject({
      branch: true,
      expanded: false,
      hiddenCount: 1,
      contextOnly: true,
    })

    const opened = projectSessionTree(index, {
      expanded: new Set(['a']),
      filter: 'conversation',
      search: '',
    })
    expect(idsOf(opened)).toEqual(['r', 'a', 'a1'])
    expect(opened.find((row) => row.node.entryId === 'a')?.contextOnly).toBe(true)
    expect(opened.find((row) => row.node.entryId === 'a1')?.contextOnly).toBeUndefined()

    const none = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'labeled',
      search: '',
    })
    expect(none).toEqual([])
  })

  it('纯工具调用默认不进 conversation，但进 tools/all；混合助手消息仍算对话', () => {
    const index = buildSessionTreeIndex([
      nodeOf('u', null, 0, { childCount: 1 }),
      nodeOf('pure', 'u', 1, {
        kind: 'tool',
        role: 'assistant',
        summary: '工具调用：read',
        hasToolCalls: true,
        childCount: 1,
      }),
      nodeOf('mixed', 'pure', 2, {
        kind: 'assistant',
        role: 'assistant',
        summary: '准备调用工具',
        hasToolCalls: true,
        isLeaf: true,
      }),
    ])

    const conversation = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'conversation',
      search: '',
    })
    expect(idsOf(conversation)).toEqual(['u', 'mixed'])

    const tools = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'tools',
      search: '',
    })
    expect(idsOf(tools)).toEqual(['pure', 'mixed'])

    const all = projectSessionTree(index, {
      expanded: new Set(),
      filter: 'all',
      search: '',
    })
    expect(idsOf(all)).toEqual(['u', 'pure', 'mixed'])
  })

  it('搜索临时忽略折叠，只显示命中节点与必要分支入口，不写入展开集合', () => {
    const nodes = forkedNodes('a1').map((node) =>
      node.entryId === 'a1' ? { ...node, summary: 'needle hit' } : node,
    )
    const index = buildSessionTreeIndex(nodes)
    const expanded = new Set<string>()

    const rows = projectSessionTree(index, { expanded, filter: 'all', search: 'needle' })
    expect(expanded.size).toBe(0)
    expect(idsOf(rows)).toEqual(['a', 'a1'])
    expect(rows.find((row) => row.node.entryId === 'a')).toMatchObject({
      branch: true,
      expanded: true,
      hiddenCount: 0,
      contextOnly: true,
    })
    expect(rows.find((row) => row.node.entryId === 'a1')).toMatchObject({
      branch: false,
      expanded: false,
    })
    expect(rows.find((row) => row.node.entryId === 'a1')?.contextOnly).toBeUndefined()

    expect(projectSessionTree(index, { expanded, filter: 'all', search: 'missing' })).toEqual([])
    expect(idsOf(projectSessionTree(index, { expanded, filter: 'all', search: '   ' }))).toEqual([
      'r',
      'a',
      'b',
    ])
  })
})

describe('会话树展开状态合并', () => {
  it('首次加载展开活动路径并选中 leaf', () => {
    const next = treeOf(forkedNodes('a1'), 'a1')
    const result = resolveSessionTreeExpansion(undefined, next, {
      expanded: new Set(),
      selectedEntryId: undefined,
    })
    expect([...result.expandedEntryIds]).toEqual(['a'])
    expect(result.selectedEntryId).toBe('a1')
  })

  it('首次读取保留历史消息入口提前指定的节点，并展开其分支', () => {
    const result = resolveSessionTreeExpansion(undefined, treeOf(forkedNodes('a1'), 'a1'), {
      expanded: new Set(),
      selectedEntryId: 'b1',
    })
    expect([...result.expandedEntryIds].sort()).toEqual(['a', 'b'])
    expect(result.selectedEntryId).toBe('b1')
  })

  it('刷新保留用户收起，不强制重开活动路径；leaf 改变时只补开新路径', () => {
    const first = treeOf(forkedNodes('a1'), 'a1')
    const sameLeaf = resolveSessionTreeExpansion(first, treeOf(forkedNodes('a1'), 'a1', 'v2'), {
      expanded: new Set(),
      selectedEntryId: 'a1',
    })
    expect(sameLeaf.expandedEntryIds.size).toBe(0)
    expect(sameLeaf.selectedEntryId).toBe('a1')

    const nextLeaf = resolveSessionTreeExpansion(first, treeOf(forkedNodes('b1'), 'b1', 'v3'), {
      expanded: new Set(),
      selectedEntryId: 'a1',
    })
    expect([...nextLeaf.expandedEntryIds]).toEqual(['b'])
    expect(nextLeaf.selectedEntryId).toBe('b1')
  })

  it('leaf 改变时保留用户显式选择，非法展开 ID 随新树丢弃', () => {
    const first = treeOf(forkedNodes('a1'), 'a1')
    const kept = resolveSessionTreeExpansion(first, treeOf(forkedNodes('b1'), 'b1', 'v2'), {
      expanded: new Set(['a']),
      selectedEntryId: 'b',
    })
    expect([...kept.expandedEntryIds].sort()).toEqual(['a', 'b'])
    expect(kept.selectedEntryId).toBe('b')

    const singleChain = treeOf(
      [
        nodeOf('r', null, 0, { childCount: 1 }),
        nodeOf('a', 'r', 1, { childCount: 1 }),
        nodeOf('a1', 'a', 2, { isLeaf: true }),
      ],
      'a1',
      'v3',
    )
    const dropped = resolveSessionTreeExpansion(first, singleChain, {
      expanded: new Set(['a']),
      selectedEntryId: 'missing',
    })
    expect(dropped.expandedEntryIds.size).toBe(0)
    expect(dropped.selectedEntryId).toBe('a1')
  })
})
