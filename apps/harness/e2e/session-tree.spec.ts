import { writeFile } from 'node:fs/promises'
import type { HarnessThreadTree } from '@huan/protocol'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  chooseSessionAction,
  configureStream,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  openApp,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  streamState,
  threadListItem,
  userMessages,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

let browserErrors: string[] = []

test.beforeEach(async ({ context }) => {
  browserErrors = []
  context.on('page', (page) => {
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
  })
})

test.afterEach(async ({ request }) => {
  await resetStream(request)
  expect(browserErrors).toEqual([])
})

async function prepareWorkspace(
  request: APIRequestContext,
  label: string,
): Promise<{ workspaceName: string; projectPath: string }> {
  const run = Date.now().toString(36)
  const project = await createProject(request, `${label}-${run}`)
  const workspaceName = `${label}工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  return { workspaceName, projectPath: project.path }
}

const treeDialog = (page: Page) => page.getByRole('dialog', { name: '会话树' })
const treeRows = (page: Page) => treeDialog(page).locator('[data-slot="huan-tree-row"]')
const treeList = (page: Page) => treeDialog(page).locator('[data-slot="huan-tree-list"]')

/** 虚拟列表只挂载可视行，节点总数以列表投影计数为准，不能数 DOM 行。 */
async function treeTotal(page: Page): Promise<number> {
  const value = await treeList(page).getAttribute('data-total-count')
  return Number(value ?? Number.NaN)
}

/** 经搜索定位虚拟列表中的特定行；返回行与恢复原搜索词的函数。 */
async function locateTreeRow(page: Page, rowText: string) {
  const search = treeDialog(page).getByRole('textbox', { name: '搜索会话树' })
  const previous = await search.inputValue()
  if (previous !== rowText) await search.fill(rowText)
  const row = treeRows(page).filter({ hasText: rowText }).first()
  await expect(row).toBeVisible()
  return {
    row,
    restore: async () => {
      if (previous !== rowText) await search.fill(previous)
    },
  }
}

/** 对话过滤可见的节点类型；与面板 conversation 过滤保持一致。 */
const conversationKinds: ReadonlySet<string> = new Set(['user', 'assistant', 'summary', 'custom'])

/**
 * 按对话过滤回溯 leaf 的最近可见祖先。
 *
 * 导入或记录类条目会成为活动链末尾的 state 节点（当前 leaf），默认对话过滤
 * 隐藏它；面板定位的正是这个祖先，不伪造可见 leaf。
 */
function nearestConversationEntryId(tree: HarnessThreadTree): string {
  const byId = new Map(tree.nodes.map((node) => [node.entryId, node]))
  let cursor = tree.leafId
  while (cursor !== null) {
    const node = byId.get(cursor)
    if (!node) throw new Error(`树响应缺少节点：${cursor}`)
    if (conversationKinds.has(node.kind)) return node.entryId
    cursor = node.parentId
  }
  throw new Error('活动链上没有对话过滤可见的节点')
}

/**
 * 打开树面板并等待定位到当前可见落点。
 *
 * 首次读树由菜单项动作触发，必须先挂响应等待；解析 /tree 响应回溯 leaf 在
 * 对话过滤下的最近可见祖先，等该行真正可见，而不是盲等 leaf 标记。
 */
async function openTree(page: Page): Promise<HarnessThreadTree> {
  const pendingTree = page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().endsWith('/tree'),
  )
  // 入口已收进会话操作菜单；运行中宿主仍会持续推送事件，菜单动作不等待主线程静止。
  await chooseSessionAction(page, '会话树')
  const response = await pendingTree
  expect(response.ok()).toBe(true)
  const tree = (await response.json()) as HarnessThreadTree
  await expect(treeDialog(page)).toBeVisible()
  await expect(treeList(page)).toBeVisible()
  await expect.poll(async () => treeTotal(page)).toBeGreaterThan(0)
  const currentEntryId = nearestConversationEntryId(tree)
  const currentRow = treeDialog(page).locator(
    `[data-slot="huan-tree-row"][data-entry-id="${currentEntryId}"]`,
  )
  await expect(currentRow).toBeVisible()
  // 虚拟列表按可视区挂载并带 overscan，只有滚到位才算定位完成。
  await expect(currentRow).toBeInViewport()
  // leaf 自身总在活动路径上，其最近可见祖先必然是活动行。
  await expect(currentRow).toHaveAttribute('data-active', 'true')
  return tree
}

/** 按标题读取当前会话 ID（显式刷新作用域缓存）。 */
async function threadIdByTitle(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(response.ok()).toBe(true)
  const threads = (await response.json()) as Array<{ id: string; title?: string }>
  const hit = threads.find((thread) => thread.title === title)
  if (!hit) throw new Error(`未找到会话：${title}`)
  return hit.id
}

async function navigateToRow(page: Page, rowText: string): Promise<void> {
  const { row, restore } = await locateTreeRow(page, rowText)
  await row.hover()
  await row.getByRole('button', { name: '跳转到此节点' }).click()
  await restore()
}

/**
 * 构造带非活动分支持久后代的最小合法会话。
 *
 * 根下先分叉出 hidden 分支（三条后代），再分叉出 active 分支；文件最后一条
 * 为 active 叶，因此打开后 hidden 入口默认折叠、active 路径默认展开。
 */
function branchedSessionJsonl(input: {
  id: string
  cwd: string
  texts: {
    root: string
    rootReply: string
    hiddenBranch: string
    hiddenReply: string
    hiddenFollowUp: string
    hiddenTail: string
    activeBranch: string
    activeReply: string
  }
}): string {
  const base = Date.parse('2026-11-01T00:00:00.000Z')
  const at = (offset: number) => base + offset
  const user = (id: string, parentId: string | null, text: string, offset: number) => ({
    type: 'message',
    id,
    parentId,
    timestamp: new Date(at(offset)).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: at(offset),
    },
  })
  const assistant = (id: string, parentId: string, text: string, offset: number) => ({
    type: 'message',
    id,
    parentId,
    timestamp: new Date(at(offset)).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions',
      provider: 'huan-test',
      model: 'test-model-a',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: at(offset),
    },
  })
  const { texts } = input
  const header = {
    type: 'session',
    version: 3,
    id: input.id,
    timestamp: new Date(at(0)).toISOString(),
    cwd: input.cwd,
  }
  const entries = [
    user('root-user', null, texts.root, 1),
    assistant('root-reply', 'root-user', texts.rootReply, 2),
    user('hidden-branch', 'root-reply', texts.hiddenBranch, 3),
    assistant('hidden-reply', 'hidden-branch', texts.hiddenReply, 4),
    user('hidden-follow-up', 'hidden-reply', texts.hiddenFollowUp, 5),
    assistant('hidden-tail', 'hidden-follow-up', texts.hiddenTail, 6),
    user('active-branch', 'root-reply', texts.activeBranch, 7),
    assistant('active-reply', 'active-branch', texts.activeReply, 8),
  ]
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

test('树面板展示真实分支、标签与过滤，用户节点导航按确认替换草稿', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '树')
  const first = `树第一问-${run}`
  const branch = `树分支问题-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, first)).toBeVisible()

  // 非空草稿：导航前必须显式确认替换。
  const draft = `树草稿-${run}`
  await page.getByRole('textbox', { name: '消息输入' }).fill(draft)
  await openTree(page)
  const dialog = treeDialog(page)
  // 对话过滤只显示用户/助手；全部还会显示模型/Thinking 等状态节点。
  const conversationCount = await treeTotal(page)
  expect(conversationCount).toBeGreaterThanOrEqual(2)
  await dialog.getByRole('button', { name: '全部', exact: true }).click()
  await expect.poll(async () => treeTotal(page)).toBeGreaterThan(conversationCount)
  await dialog.getByRole('button', { name: '已标记', exact: true }).click()
  await expect(treeList(page)).toHaveAttribute('data-total-count', '0')
  await expect(treeRows(page)).toHaveCount(0)
  await expect(dialog.getByText('没有匹配的节点。')).toBeVisible()

  // 设置标签后可在“已标记”过滤中找到；先搜索定位可能不在虚拟初始视口内的首条用户行。
  await dialog.getByRole('button', { name: '对话', exact: true }).click()
  const search = dialog.getByRole('textbox', { name: '搜索会话树' })
  await search.fill(first)
  const firstRow = treeRows(page).filter({ hasText: first }).first()
  await expect(firstRow).toBeVisible()
  await firstRow.hover()
  await firstRow.getByRole('button', { name: '设置标签' }).click()
  await dialog.getByRole('textbox', { name: '节点标签' }).fill(`起点-${run}`)
  await dialog.getByRole('button', { name: '保存标签' }).click()
  await expect(treeRows(page).filter({ hasText: `起点-${run}` })).toHaveCount(1)
  await dialog.getByRole('button', { name: '已标记', exact: true }).click()
  await expect(treeList(page)).toHaveAttribute('data-total-count', '1')
  await expect(treeRows(page)).toHaveCount(1)
  await dialog.getByRole('button', { name: '对话', exact: true }).click()

  // 搜索按摘要过滤。
  await search.fill(`树第一问-${run}`)
  await expect(treeList(page)).toHaveAttribute('data-total-count', '1')
  await expect(treeRows(page)).toHaveCount(1)
  await search.fill('')
  await expect(treeRows(page).filter({ hasText: first })).toHaveCount(1)

  // 空草稿时直接接收节点原文。
  await navigateToRow(page, first)
  await expect(dialog.getByRole('checkbox', { name: /替换当前输入框草稿/ })).toBeChecked()
  await dialog.getByRole('button', { name: '确认跳转' }).click()
  await expect(dialog.getByText('已跳转到所选节点。')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭' }).first().click()
  await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(first)

  // 从该用户节点继续发送，形成第二个分支。
  await sendMessage(page, branch)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const currentTree = await openTree(page)
  await expect(treeRows(page).filter({ hasText: first })).toHaveCount(1)
  await expect(treeRows(page).filter({ hasText: branch })).toHaveCount(1)
  // 活动路径在分支侧；落点已由 openTree 定位到最近可见祖先。
  await expect(treeRows(page).filter({ hasText: branch }).first()).toHaveAttribute(
    'data-active',
    'true',
  )
  // 真实 leaf 可能是被对话过滤隐藏的状态条目；切到“全部”核对 leaf 标记本身。
  await dialog.getByRole('button', { name: '全部', exact: true }).click()
  const leafRow = treeDialog(page).locator('[data-slot="huan-tree-row"][data-leaf="true"]')
  await expect(leafRow).toHaveCount(1)
  if (currentTree.leafId === null) throw new Error('树响应缺少 leaf')
  await expect(leafRow).toHaveAttribute('data-entry-id', currentTree.leafId)
})

test('双窗口导航同步，其他窗口保留本地草稿且不接收 editorText', async ({ page, context }) => {
  const run = Date.now().toString(36)
  const first = `双树第一问-${run}`
  const branch = `双树分支-${run}`

  await openApp(page)
  // 显式使用宿主启动工作区，保证第二个窗口的默认活动工作区能看到该会话。
  await startNewSession(page, 'workspace')
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  const page2 = await context.newPage()
  await openApp(page2)
  await threadListItem(page2, first).click()
  await expect(userMessages(page2).first()).toContainText(first)
  const draft = `第二窗口草稿-${run}`
  await page2.getByRole('textbox', { name: '消息输入' }).fill(draft)

  await openTree(page)
  await navigateToRow(page, first)
  await treeDialog(page).getByRole('button', { name: '确认跳转' }).click()
  await expect(treeDialog(page).getByText('已跳转到所选节点。')).toBeVisible()
  await treeDialog(page).getByRole('button', { name: '关闭' }).first().click()
  await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(first)

  // 另一个窗口只更新历史与落点，不动本地草稿，也不接收 editorText。
  await expect(userMessages(page2)).toHaveCount(0)
  await expect(page2.getByRole('textbox', { name: '消息输入' })).toHaveValue(draft)

  // 发起窗口继续发送后，另一窗口同步看到新分支。
  await sendMessage(page, branch)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(userMessages(page2).filter({ hasText: branch })).toBeVisible()
  await expect(page2.getByRole('textbox', { name: '消息输入' })).toHaveValue(draft)
})

test('运行中停止并跳转取回整体队列，不自动发送', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '停止树')
  const first = `停止树第一问-${run}`
  const running = `停止树运行中-${run}`
  const queued = `停止树排队-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const threadId = await threadIdByTitle(request, first)

  await configureStream(request, ['停止前的半段'])
  await sendMessage(page, running)
  await expect.poll(async () => (await streamState(request)).active).toBe(true)
  // 运行中显式 followUp 进入服务端队列（不依赖 composer 队列的渲染细节）。
  const queuedResponse = await request.post(`${E2E_HOST_URL}/api/pi/threads/${threadId}/messages`, {
    data: { input: { content: queued, streamingBehavior: 'followUp' } },
  })
  expect(queuedResponse.ok()).toBe(true)
  await expect
    .poll(async () => {
      const snapshot = await request.get(`${E2E_HOST_URL}/api/pi/threads/${threadId}`)
      const body = (await snapshot.json()) as {
        metadata: { queuedMessages?: Array<{ content: string }> }
      }
      return body.metadata.queuedMessages?.some((message) => message.content === queued) ?? false
    })
    .toBe(true)

  await openTree(page)
  await navigateToRow(page, first)
  const confirm = treeDialog(page).getByRole('button', { name: '停止并跳转' })
  await expect(confirm).toBeVisible()
  await confirm.click()

  const recovered = page.locator('[data-slot="huan-recovered-queue"]')
  await expect(recovered).toContainText(queued)
  await treeDialog(page).getByRole('button', { name: '关闭' }).first().click()
  const composer = page.getByRole('textbox', { name: '消息输入' })
  await expect(composer).toHaveValue(first)
  await expect(userMessages(page)).toHaveCount(0)
  await expect(recovered).toContainText('不会自动发送')

  // 显式恢复到输入框（不自动发送）。
  await recovered.getByRole('button', { name: '恢复到输入框' }).click()
  await expect(composer).toHaveValue(`${first}

${queued}`)
  await expect(userMessages(page)).toHaveCount(0)
})

test('分支摘要进行中可取消，取消后活动落点与草稿不变', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '摘要树')
  const first = `摘要树第一问-${run}`
  const draft = `摘要前草稿-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  await page.getByRole('textbox', { name: '消息输入' }).fill(draft)
  await configureStream(request, ['摘要生成中'])
  await openTree(page)
  await navigateToRow(page, first)
  const dialog = treeDialog(page)
  await dialog.getByRole('radio', { name: /生成摘要/ }).check()
  await dialog.getByRole('button', { name: '确认跳转' }).click()

  // 摘要请求挂起时，所有窗口都能看到进行中状态并可取消。
  await expect.poll(async () => (await streamState(request)).active).toBe(true)
  await expect(dialog.getByText('正在生成分支摘要（可能计费）…')).toBeVisible()
  await dialog.getByRole('button', { name: '取消摘要' }).click()
  await expect(dialog.getByText('分支摘要已取消，活动落点未改变。')).toBeVisible({
    timeout: 20_000,
  })

  // 没有任何摘要条目被写入；用搜索核对完整树，避免虚拟列表未挂载的行被误判。
  await dialog.getByRole('button', { name: '全部', exact: true }).click()
  await dialog.getByRole('textbox', { name: '搜索会话树' }).fill('分支摘要')
  await expect(treeList(page)).toHaveAttribute('data-total-count', '0')
  await expect(treeRows(page)).toHaveCount(0)

  // 关闭面板后才检查被模态遮挡的输入框与历史（取消不改变活动落点与草稿）。
  await dialog.getByRole('button', { name: '关闭' }).first().click()
  await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(draft)
  await expect(userMessages(page).first()).toContainText(first)
})

test('导航在途时关闭面板并输入新草稿，迟到结果不覆盖', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '迟到')
  const first = `迟到第一问-${run}`
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, first)).toBeVisible()

  await openTree(page)
  const dialog = treeDialog(page)
  const { row } = await locateTreeRow(page, first)
  await row.hover()
  await row.getByRole('button', { name: '跳转到此节点' }).click()
  const panel = dialog.locator('[data-slot="huan-tree-navigate-panel"]')
  await panel.getByRole('checkbox', { name: /确认替换当前输入框草稿/ }).check()

  // 延迟导航响应，制造“请求在途时用户关闭面板并输入新草稿”的真实竞态。
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/tree/navigate', async (route) => {
    await gate
    await route.continue()
  })
  try {
    const responded = page.waitForResponse((response) => response.url().includes('/tree/navigate'))
    await panel.getByRole('button', { name: '确认跳转' }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const draft = `迟到新草稿-${run}`
    await page.getByRole('textbox', { name: '消息输入' }).fill(draft)
    release()
    expect((await responded).ok()).toBe(true)
    // 迟到的导航结果不得替换关闭面板之后输入的新草稿，也不得重开面板。
    await page.waitForTimeout(500)
    await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(draft)
    await expect(treeDialog(page)).toHaveCount(0)
  } finally {
    await page.unroute('**/tree/navigate')
  }
})

test('非活动分支默认折叠，展开、搜索后清空与刷新均保留用户折叠', async ({
  page,
  request,
}, testInfo) => {
  const run = Date.now().toString(36)
  const { workspaceName, projectPath } = await prepareWorkspace(request, '折叠树')
  const texts = {
    root: `折叠根-${run}`,
    rootReply: `折叠根回答-${run}`,
    hiddenBranch: `折叠非活动入口-${run}`,
    hiddenReply: `折叠隐藏回答一-${run}`,
    hiddenFollowUp: `折叠隐藏追问-${run}`,
    hiddenTail: `折叠隐藏回答二-${run}`,
    activeBranch: `折叠活动入口-${run}`,
    activeReply: `折叠活动回答-${run}`,
  }
  const sourcePath = testInfo.outputPath(`branched-tree-${run}.jsonl`)
  await writeFile(
    sourcePath,
    branchedSessionJsonl({ id: `e2e-branched-${run}`, cwd: projectPath, texts }),
  )

  await openApp(page)
  await page.getByRole('button', { name: '导入 JSONL', exact: true }).click()
  const importDialog = page.getByRole('dialog', { name: '导入 JSONL 会话' })
  await expect(importDialog).toBeVisible()
  await importDialog.getByRole('combobox', { name: '目标工作区' }).click()
  await page.getByRole('option', { name: workspaceName, exact: true }).click()
  await importDialog.getByLabel('服务端 JSONL 绝对路径').fill(sourcePath)
  await importDialog.getByRole('button', { name: '预览导入' }).click()
  await expect(importDialog.locator('[data-slot="huan-import-preview"]')).toBeVisible({
    timeout: 20_000,
  })
  await importDialog.getByRole('button', { name: '确认导入' }).click()
  await expect(importDialog.getByRole('status')).toContainText('会话已导入', {
    timeout: 30_000,
  })
  await importDialog.getByRole('button', { name: '打开已导入会话' }).click()
  await expect(importDialog).toHaveCount(0)
  await expect(userMessages(page).first()).toContainText(texts.root)

  await openTree(page)
  const dialog = treeDialog(page)
  // 等入场缩放动画结束再量宽度，避免量到 zoom-in-95 的中间态。
  await dialog.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  // 桌面视口下弹层宽度取 896px 上限与“视口减官方 2rem 安全边距”的较小值。
  const dialogBox = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, viewportWidth: document.documentElement.clientWidth }
  })
  expect(dialogBox.viewportWidth).toBeGreaterThanOrEqual(640)
  expect(
    Math.abs(dialogBox.width - Math.min(dialogBox.viewportWidth - 32, 896)),
  ).toBeLessThanOrEqual(1)
  const initialTotal = await treeTotal(page)
  const branchRow = treeRows(page).filter({ hasText: texts.hiddenBranch }).first()
  await expect(branchRow).toBeVisible()
  await expect(branchRow).toHaveAttribute('data-branch', 'true')
  await expect(branchRow).toHaveAttribute('data-expanded', 'false')
  await expect(branchRow.getByRole('button', { name: '展开分支' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(branchRow).toContainText('另有 3 条')
  for (const text of [texts.hiddenReply, texts.hiddenFollowUp, texts.hiddenTail]) {
    await expect(treeRows(page).filter({ hasText: text })).toHaveCount(0)
  }

  // 单链保持同缩进；分叉入口与其后的分支内后代使用同一级 padding。
  const paddingOf = (row: Locator) =>
    row.evaluate((element) => getComputedStyle(element).paddingInlineStart)
  const rootRow = treeRows(page).filter({ hasText: texts.root }).first()
  const rootReplyRow = treeRows(page).filter({ hasText: texts.rootReply }).first()
  await expect(rootRow).toBeVisible()
  await expect(rootReplyRow).toBeVisible()
  const rootPadding = await paddingOf(rootRow)
  // depth 0 单链不留缩进：首个子元素就是类型图标，既没有折叠按钮也没有占位。
  expect(Number.parseFloat(rootPadding)).toBe(0)
  expect(await paddingOf(rootReplyRow)).toBe(rootPadding)
  const rootLead = await rootRow.evaluate((element) => {
    const first = element.firstElementChild
    if (!(first instanceof HTMLElement)) throw new Error('根行缺少首个子元素')
    return {
      isButton: first.tagName === 'BUTTON',
      slot: first.dataset.slot,
      offset: first.getBoundingClientRect().left - element.getBoundingClientRect().left,
    }
  })
  expect(rootLead.isButton).toBe(false)
  expect(rootLead.slot).toBe('huan-tree-kind-icon')
  expect(Math.abs(rootLead.offset)).toBeLessThanOrEqual(0.5)

  await branchRow.getByRole('button', { name: '展开分支' }).click()
  await expect(branchRow).toHaveAttribute('data-expanded', 'true')
  await expect(branchRow.getByRole('button', { name: '收起分支' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect.poll(async () => treeTotal(page)).toBe(initialTotal + 3)
  for (const text of [texts.hiddenReply, texts.hiddenFollowUp, texts.hiddenTail]) {
    await expect(treeRows(page).filter({ hasText: text })).toBeVisible()
  }
  const branchPadding = await paddingOf(branchRow)
  expect(await paddingOf(treeRows(page).filter({ hasText: texts.hiddenTail }).first())).toBe(
    branchPadding,
  )
  expect(Number.parseFloat(branchPadding)).toBeGreaterThan(Number.parseFloat(rootPadding))

  await branchRow.getByRole('button', { name: '收起分支' }).click()
  await expect(branchRow).toHaveAttribute('data-expanded', 'false')
  await expect(branchRow).toContainText('另有 3 条')
  await expect.poll(async () => treeTotal(page)).toBe(initialTotal)
  for (const text of [texts.hiddenReply, texts.hiddenFollowUp, texts.hiddenTail]) {
    await expect(treeRows(page).filter({ hasText: text })).toHaveCount(0)
  }

  // 搜索临时揭示隐藏后代；清空后恢复用户折叠集合。
  const search = dialog.getByRole('textbox', { name: '搜索会话树' })
  await search.fill(texts.hiddenTail)
  await expect(treeRows(page).filter({ hasText: texts.hiddenTail })).toBeVisible()
  await expect(branchRow).toBeVisible()
  await expect(branchRow).toHaveAttribute('data-expanded', 'true')
  await expect.poll(async () => treeTotal(page)).toBe(2)
  await search.fill('')
  await expect(treeRows(page).filter({ hasText: texts.hiddenTail })).toHaveCount(0)
  await expect(branchRow).toHaveAttribute('data-expanded', 'false')
  await expect(branchRow).toContainText('另有 3 条')
  await expect.poll(async () => treeTotal(page)).toBe(initialTotal)

  // 显式刷新保留用户收起；活动分支仍展开并显示最近可见落点。
  const refresh = dialog.getByRole('button', { name: '刷新会话树' })
  const refreshed = page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().endsWith('/tree'),
  )
  await refresh.click()
  expect((await refreshed).ok()).toBe(true)
  await expect(refresh).toBeEnabled()
  await expect(branchRow).toHaveAttribute('data-expanded', 'false')
  await expect(branchRow).toContainText('另有 3 条')
  await expect(treeRows(page).filter({ hasText: texts.hiddenTail })).toHaveCount(0)
  await expect(treeRows(page).filter({ hasText: texts.activeReply })).toBeVisible()
})
