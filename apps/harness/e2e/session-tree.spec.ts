import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
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

async function openTree(page: Page): Promise<void> {
  // 运行中宿主仍会持续推送事件；强制点击避免等待一个非必要的主线程稳定窗口。
  await page.getByRole('button', { name: '会话树', exact: true }).click({ force: true })
  await expect(treeDialog(page)).toBeVisible()
  await expect(treeRows(page).first()).toBeVisible()
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
  const row = treeRows(page).filter({ hasText: rowText }).first()
  await row.hover()
  await row.getByRole('button', { name: '跳转到此节点' }).click()
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
  const conversationCount = await treeRows(page).count()
  expect(conversationCount).toBeGreaterThanOrEqual(2)
  await dialog.getByRole('button', { name: '全部', exact: true }).click()
  expect(await treeRows(page).count()).toBeGreaterThan(conversationCount)
  await dialog.getByRole('button', { name: '已标记', exact: true }).click()
  await expect(treeRows(page)).toHaveCount(0)
  await expect(dialog.getByText('没有匹配的节点。')).toBeVisible()

  // 设置标签后可在“已标记”过滤中找到。
  await dialog.getByRole('button', { name: '对话', exact: true }).click()
  const firstRow = treeRows(page).filter({ hasText: first }).first()
  await firstRow.hover()
  await firstRow.getByRole('button', { name: '设置标签' }).click()
  await dialog.getByRole('textbox', { name: '节点标签' }).fill(`起点-${run}`)
  await dialog.getByRole('button', { name: '保存标签' }).click()
  await expect(treeRows(page).filter({ hasText: `起点-${run}` })).toHaveCount(1)
  await dialog.getByRole('button', { name: '已标记', exact: true }).click()
  await expect(treeRows(page)).toHaveCount(1)
  await dialog.getByRole('button', { name: '对话', exact: true }).click()

  // 搜索按摘要过滤。
  await dialog.getByRole('textbox', { name: '搜索会话树' }).fill(`树第一问-${run}`)
  await expect(treeRows(page)).toHaveCount(1)
  await dialog.getByRole('textbox', { name: '搜索会话树' }).fill('')
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
  await openTree(page)
  await expect(treeRows(page).filter({ hasText: first })).toHaveCount(1)
  await expect(treeRows(page).filter({ hasText: branch })).toHaveCount(1)
  // 活动路径与当前 leaf 标记在分支侧。
  await expect(treeRows(page).filter({ hasText: branch }).first()).toHaveAttribute(
    'data-active',
    'true',
  )
  const leafRow = treeDialog(page).locator('[data-slot="huan-tree-row"][data-leaf="true"]')
  await expect(leafRow).toHaveCount(1)
  await expect(leafRow).toContainText(DEFAULT_REPLY)
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

  // 没有任何摘要条目被写入。
  await dialog.getByRole('button', { name: '全部', exact: true }).click()
  await expect(treeRows(page).filter({ hasText: '分支摘要' })).toHaveCount(0)

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
  const row = treeRows(page).filter({ hasText: first }).first()
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
