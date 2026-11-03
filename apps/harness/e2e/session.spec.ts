import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  openApp,
  renameThread,
  resetStream,
  selectModel,
  sendMessage,
  sessionRow,
  startNewSession,
  threadListItem,
  userMessages,
  workspaceGroup,
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

/** 选中 Base UI Select 的选项（原生 select 会污染全局 option 断言）。 */
async function chooseOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** 新建一个只含一个项目的隔离工作区。 */
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

test('搜索限定名称与首条消息，范围/排序/仅命名过滤生效', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '筛选')
  const group = workspaceGroup(page, workspaceName)
  const triggers = group.locator('[data-slot="huan-session-trigger"]')

  await openApp(page)
  // 会话一：命名后标题与首条消息不同，便于区分搜索来源。
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `首条甲-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, `首条甲-${run}`)).toBeVisible()
  await renameThread(page, `首条甲-${run}`, `Z命名-${run}`)

  // 会话二：保持未命名，首条消息含独有关键词。
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `独有乙-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, `独有乙-${run}`)).toBeVisible()

  // 会话三：命名为 A，用于验证名称排序。
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `首条丙-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await renameThread(page, `首条丙-${run}`, `A命名-${run}`)
  await expect(triggers).toHaveCount(3)

  // 搜索命中首条消息（未命名会话与已命名会话都按全文件首条消息匹配）。
  await page.getByLabel('搜索会话').fill(`首条甲-${run}`)
  await expect(triggers).toHaveCount(1)
  await expect(triggers.first()).toContainText(`Z命名-${run}`)
  await page.getByLabel('搜索会话').fill(`独有乙-${run}`)
  await expect(triggers).toHaveCount(1)
  await expect(triggers.first()).toContainText(`独有乙-${run}`)

  // 搜索命中显式名称。
  await page.getByLabel('搜索会话').fill(`A命名-${run}`)
  await expect(triggers).toHaveCount(1)
  await expect(triggers.first()).toContainText(`A命名-${run}`)

  // 未命中任何会话时列表为空，清空后恢复。
  await page.getByLabel('搜索会话').fill('不存在的会话内容')
  await expect(triggers).toHaveCount(0)
  await page.getByLabel('搜索会话').fill('')
  await expect(triggers).toHaveCount(3)

  // 仅命名：只剩两个有显式名称的会话。
  await page.getByLabel('仅命名', { exact: true }).check()
  await expect(triggers).toHaveCount(2)
  await expect(triggers.filter({ hasText: `独有乙-${run}` })).toHaveCount(0)
  await page.getByLabel('仅命名', { exact: true }).uncheck()
  await expect(triggers).toHaveCount(3)

  // 名称升序：仅命名视图中 A 在 Z 之前，同值以 ID 稳定排序。
  await page.getByLabel('仅命名', { exact: true }).check()
  await chooseOption(page, '会话排序', '名称')
  await expect(triggers).toHaveCount(2)
  await expect(triggers.nth(0)).toContainText(`A命名-${run}`)
  await expect(triggers.nth(1)).toContainText(`Z命名-${run}`)
  await chooseOption(page, '会话排序', '创建时间')
  await page.getByLabel('仅命名', { exact: true }).uncheck()
  await expect(triggers).toHaveCount(3)

  // 继续最近不被搜索和命名/名称排序的视图过滤影响。
  await page.getByLabel('搜索会话').fill(`Z命名-${run}`)
  await group.getByRole('button', { name: '继续最近', exact: true }).click()
  await expect(userMessages(page).first()).toContainText(`首条丙-${run}`)
  await page.getByLabel('搜索会话').fill('')

  // 清空名称恢复为未命名，首条消息标题仍可搜索。
  await threadListItem(page, `A命名-${run}`).click()
  const context = page.locator('[data-slot="huan-session-context"]')
  await context.getByRole('button', { name: '详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '会话详情' })
  await details.getByRole('textbox', { name: '会话名称' }).fill('')
  await details.getByRole('button', { name: '保存名称' }).click()
  await expect(details.getByRole('status')).toContainText('会话名称已清空')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(threadListItem(page, `首条丙-${run}`)).toBeVisible()
  await page.getByLabel('仅命名', { exact: true }).check()
  await expect(triggers).toHaveCount(1)
  await page.getByLabel('仅命名', { exact: true }).uncheck()

  // 范围切到当前工作区：未归属分组与其他工作区都不再显示。
  // 先造一个确定性未归属会话（测试顺序无关，前序用例可能已接入默认未归属会话）。
  const external = await request.post(`${E2E_HOST_URL}/__e2e__/sessions`, {
    data: { text: `范围未归属-${run}`, name: `范围未归属-${run}` },
  })
  expect(external.ok()).toBe(true)
  await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
  const unassignedGroup = page.locator('[data-slot="huan-unassigned-group"]')
  await expect(unassignedGroup).toHaveCount(1)
  await chooseOption(page, '会话范围', '当前工作区')
  await expect(triggers).toHaveCount(3)
  await expect(unassignedGroup).toHaveCount(0)
  await expect(page.locator('[data-slot="huan-workspace-group"]')).toHaveCount(1)
})

test('显式刷新发现外部新增会话，未刷新时保持宿主缓存', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '外部会话')
  const externalTitle = `外部新增会话-${run}`
  const unassignedGroup = page.locator('[data-slot="huan-unassigned-group"]')

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `内部会话-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, `内部会话-${run}`)).toBeVisible()

  // 让一次旧扫描响应晚到，验证较新的显式刷新结果不会被它覆盖。
  let releaseOld!: () => void
  let markOldReady!: () => void
  let markOldSent!: () => void
  const oldReady = new Promise<void>((resolve) => {
    markOldReady = resolve
  })
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const oldSent = new Promise<void>((resolve) => {
    markOldSent = resolve
  })
  let holdNext = true
  await page.route('**/api/pi/threads?*', async (route) => {
    if (!holdNext) return route.continue()
    holdNext = false
    const response = await route.fetch()
    const body = await response.body()
    markOldReady()
    await oldGate
    await route.fulfill({ response, body })
    markOldSent()
  })
  await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
  await oldReady

  // 外部写入 Pi 会话文件：不经宿主 API，也没有 huan 归属元数据。
  const created = await request.post(`${E2E_HOST_URL}/__e2e__/sessions`, {
    data: { text: externalTitle, name: externalTitle },
  })
  expect(created.ok()).toBe(true)
  await expect(unassignedGroup).not.toContainText(externalTitle)

  // 显式刷新清除作用域缓存后重新扫描，外部会话出现在未归属分组。
  // 按钮在扫描期间禁用，这里用文档化的另一入口（窗口重新聚焦）触发新扫描。
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(unassignedGroup).toContainText(externalTitle)
  await expect(sessionRow(page, externalTitle)).toBeVisible()
  releaseOld()
  await oldSent
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await expect(sessionRow(page, externalTitle)).toBeVisible()
})

test('详情展示累计统计与路径，归档/恢复可从全部会话操作', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '详情')
  const title = `详情会话-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const row = sessionRow(page, title)
  await expect(row).toBeVisible()

  // 详情：只读统计、完整会话文件路径与上下文（选中会话后由上下文栏打开）。
  await row.locator('[data-slot="huan-session-trigger"]').click()
  const context = page.locator('[data-slot="huan-session-context"]')
  await context.getByRole('button', { name: '详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '会话详情' })
  await expect(details).toBeVisible()
  await expect(details).toContainText('用户 1')
  await expect(details).toContainText('助手 1')
  await expect(details).toContainText('.jsonl')
  await expect(details).toContainText('当前上下文')
  await expect(details).toContainText('累计费用')
  // 手动刷新详情不改变统计口径。
  await details.getByRole('button', { name: '刷新详情' }).click()
  await expect(details).toContainText('用户 1')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  // 关闭后焦点回到打开它的上下文栏入口。
  await expect(context.getByRole('button', { name: '详情', exact: true })).toBeFocused()

  // 归档：普通视图隐藏，归档视图可见，恢复后回到普通视图。
  await context.getByRole('button', { name: '归档', exact: true }).click()
  await expect(threadListItem(page, title)).toHaveCount(0)
  await page.getByLabel('已归档会话', { exact: true }).check()
  await expect(threadListItem(page, title)).toBeVisible()
  await threadListItem(page, title).click()
  await context.getByRole('button', { name: '取消归档', exact: true }).click()
  await page.getByLabel('已归档会话', { exact: true }).uncheck()
  await expect(threadListItem(page, title)).toBeVisible()

  // 未归属会话同样可以查看详情（只读，不隐式加入工作区）。
  // 外部会话没有 huan 归属元数据，验证未归属路径且不依赖前序用例状态。
  const unassignedTitle = `未归属详情-${run}`
  const external = await request.post(`${E2E_HOST_URL}/__e2e__/sessions`, {
    data: { text: unassignedTitle },
  })
  expect(external.ok()).toBe(true)
  await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
  const unassignedRow = sessionRow(page, unassignedTitle)
  await unassignedRow.locator('[data-slot="huan-session-trigger"]').click()
  await context.getByRole('button', { name: '详情', exact: true }).click()
  const unassignedDetails = page.getByRole('dialog', { name: '会话详情' })
  await expect(unassignedDetails).toContainText('未归属')
  await expect(unassignedDetails).toContainText('用户 1')
  await page.keyboard.press('Escape')
  await expect(unassignedDetails).toHaveCount(0)
})

test('删除需确认：取消保留会话，确认后会话消失且刷新不复活', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '删除')
  const title = `待删除会话-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const row = sessionRow(page, title)
  await expect(row).toBeVisible()

  // 取消：不写数据、不删除文件。
  await row.locator('[data-slot="huan-session-trigger"]').click()
  const context = page.locator('[data-slot="huan-session-context"]')
  await context.getByRole('button', { name: '删除', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '删除会话' })
  await expect(confirm).toContainText(title)
  await expect(confirm).toContainText('.jsonl')
  await expect(confirm).toContainText('停止当前任务')
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(threadListItem(page, title)).toBeVisible()

  // 确认：会话从列表消失，显式刷新后也不复活。
  await context.getByRole('button', { name: '删除', exact: true }).click()
  await page
    .getByRole('dialog', { name: '删除会话' })
    .getByRole('button', { name: '删除会话' })
    .click()
  await expect(page.getByRole('dialog', { name: '删除会话' })).toHaveCount(0)
  await expect(threadListItem(page, title)).toHaveCount(0)
  await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
  await expect(threadListItem(page, title)).toHaveCount(0)
  await expect(userMessages(page)).toHaveCount(0)
})
