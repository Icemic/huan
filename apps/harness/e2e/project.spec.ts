import { existsSync, readFileSync } from 'node:fs'
import type { HarnessThreadMetadata } from '@huan/protocol'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL, E2E_UNASSIGNED_TITLE } from './config.js'
import {
  assistantMessages,
  chooseSessionAction,
  configureStream,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  finishStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
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

const markerLines = (marker: string | undefined): number => {
  if (!marker || !existsSync(marker)) return 0
  return readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).length
}

test('继续最近、归档与恢复在两级列表中可用', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `archive-${run}`)
  const name = `归档工作区-${run}`
  const title = `归档会话-${run}`
  await createWorkspaceApi(request, name, [{ alias: 'a', path: project.path }])
  await openApp(page)
  const group = workspaceGroup(page, name)
  // 没有可继续的会话时，“继续最近”打开同一个预检表单。
  await group.getByRole('button', { name: '继续最近', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '开始新会话' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(userMessages(page)).toHaveCount(0)
  await selectModel(page)
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await startNewSession(page, name)
  await group.getByRole('button', { name: '继续最近', exact: true }).click()
  await expect(userMessages(page).first()).toContainText(title)
  // 归档/取消归档在会话操作菜单（选中会话后可用）。
  await chooseSessionAction(page, '归档')
  await expect(threadListItem(page, title)).toHaveCount(0)
  await page.getByLabel('已归档会话', { exact: true }).check()
  await expect(threadListItem(page, title)).toBeVisible()
  await threadListItem(page, title).click()
  await chooseSessionAction(page, '取消归档')
  await expect(threadListItem(page, title)).toHaveCount(0)
  await page.getByLabel('已归档会话', { exact: true }).uncheck()
  await expect(threadListItem(page, title)).toBeVisible()
})

test('管理工作区动态增删成员，已有会话保持起始目录', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const alpha = await createProject(request, `members-a-${run}`)
  const beta = await createProject(request, `members-b-${run}`)
  const name = `成员工作区-${run}`
  await createWorkspaceApi(request, name, [{ alias: 'alpha', path: alpha.path }])
  await openApp(page)
  await startNewSession(page, name)
  await selectModel(page)
  await sendMessage(page, `成员消息-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const group = workspaceGroup(page, name)
  await group.getByRole('button', { name: '管理工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await dialog.getByRole('button', { name: '添加成员' }).click()
  await dialog.getByLabel('项目别名').nth(1).fill('beta')
  await dialog.getByLabel('项目路径').nth(1).fill(beta.path)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const bar = page.locator('[data-slot="huan-session-context"]')
  await expect(bar).toContainText('2 个项目')
  await expect(bar).toContainText(alpha.path)
  await group.getByRole('button', { name: '管理工作区', exact: true }).click()
  await dialog.getByRole('button', { name: '移除成员' }).first().click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(bar).toContainText('1 个项目')
  await expect(bar).toContainText(alpha.path)
  await sendMessage(page, `移除起始成员后-${run}`)
  await expect(userMessages(page).last()).toContainText(`移除起始成员后-${run}`)
  await expect(assistantMessages(page).filter({ hasText: DEFAULT_REPLY })).toHaveCount(2)
  // 生效版本属于服务端行为，界面不再展示内部版本和应用时机。
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(response.ok()).toBe(true)
  const threads = (await response.json()) as HarnessThreadMetadata[]
  expect(
    threads.find((thread) => thread.title === `成员消息-${run}`)?.workspaceAppliedRevision,
  ).toBe(3)
  await expect(bar).not.toContainText(/实际生效|本轮仍使用|下次运行生效|成员变更将在/)
})

test('创建工作区、选择起始项目并保存窗口偏好，会话 cwd 固定', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const projectA = await createProject(request, `start-a-${run}`)
  const projectB = await createProject(request, `start-b-${run}`)
  const workspaceName = `起点工作区-${run}`
  const prompt = `起始项目消息-${run}`

  await openApp(page)
  await page.getByRole('button', { name: '新建工作区' }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建工作区' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('工作区名称').fill(workspaceName)
  await dialog.getByLabel('项目别名').nth(0).fill('alpha')
  await dialog.getByLabel('项目路径').nth(0).fill(projectA.path)
  await dialog.getByRole('button', { name: '添加成员' }).click()
  await dialog.getByLabel('项目别名').nth(1).fill('beta')
  await dialog.getByLabel('项目路径').nth(1).fill(projectB.path)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(workspaceGroup(page, workspaceName)).toBeVisible()

  // 新会话默认使用第一个成员；这里先验证创建后 cwd 固定为 alpha。
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, prompt)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const contextBar = page.locator('[data-slot="huan-session-context"]')
  await expect(contextBar).toContainText(projectA.path)
  await expect(
    workspaceGroup(page, workspaceName).locator('[data-slot="huan-session-trigger"]'),
  ).toHaveCount(1)

  // 第二个会话选择 beta，并作为窗口偏好保留。
  await workspaceGroup(page, workspaceName)
    .getByRole('button', { name: '新建会话', exact: true })
    .click()
  const secondDialog = page.getByRole('dialog', { name: '新建会话' })
  await secondDialog.getByRole('radio').nth(1).check()
  await secondDialog.getByRole('button', { name: '开始新会话' }).click()
  await expect(secondDialog).toHaveCount(0)
  await expect(page.locator('[data-slot="huan-message"][data-role="user"]')).toHaveCount(0)
  await selectModel(page)
  await sendMessage(page, `第二起始项目-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(contextBar).toContainText(projectB.path)
  await expect(
    workspaceGroup(page, workspaceName).locator('[data-slot="huan-session-trigger"]'),
  ).toHaveCount(2)

  // 刷新后窗口偏好仍在：下一次新建默认选中 beta。
  await page.reload()
  await expect(workspaceGroup(page, workspaceName)).toBeVisible()
  await workspaceGroup(page, workspaceName)
    .getByRole('button', { name: '新建会话', exact: true })
    .click()
  const restored = page.getByRole('dialog', { name: '新建会话' })
  await expect(restored.getByRole('radio').nth(1)).toBeChecked()
  await restored.getByRole('button', { name: '取消' }).click()
})

test('多个展开工作区分别显示会话，切换工作区不终止运行', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const projectA = await createProject(request, `group-a-${run}`)
  const projectB = await createProject(request, `group-b-${run}`)
  const workspaceA = `工作区甲-${run}`
  const workspaceB = `工作区乙-${run}`
  await createWorkspaceApi(request, workspaceA, [{ alias: 'a', path: projectA.path }])
  await createWorkspaceApi(request, workspaceB, [{ alias: 'b', path: projectB.path }])

  const titleA = `甲会话-${run}`
  const titleB = `乙会话-${run}`
  await openApp(page)
  await startNewSession(page, workspaceA)
  await selectModel(page)
  await sendMessage(page, titleA)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(
    workspaceGroup(page, workspaceA).locator('[data-slot="huan-session-trigger"]'),
  ).toHaveCount(1)

  await startNewSession(page, workspaceB)
  await selectModel(page)
  await sendMessage(page, titleB)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(
    workspaceGroup(page, workspaceB).locator('[data-slot="huan-session-trigger"]'),
  ).toHaveCount(1)

  // 两个工作区同时展开，各自只显示自己的会话。
  await expect(workspaceGroup(page, workspaceA)).toContainText(titleA)
  await expect(workspaceGroup(page, workspaceA)).not.toContainText(titleB)
  await expect(workspaceGroup(page, workspaceB)).toContainText(titleB)
  await expect(workspaceGroup(page, workspaceB)).not.toContainText(titleA)

  // 在乙会话发起分段运行，切到甲会话阅读历史期间，乙运行继续。
  const segment1 = '切换前的第一段。'
  const segment2 = '切回后的第二段。'
  await configureStream(request, [segment1, segment2])
  await sendMessage(page, `乙运行-${run}`)
  await releaseSegment(request)
  await expect(assistantMessages(page).last()).toContainText(segment1, { timeout: 20_000 })

  await threadListItem(page, titleA).click()
  await expect(userMessages(page).first()).toContainText(titleA)
  await expect(page.locator('[data-slot="huan-session-context"]')).toContainText(projectA.path)
  await expect(assistantMessages(page).filter({ hasText: segment1 })).toHaveCount(0)

  await releaseSegment(request)
  await finishStream(request)
  await threadListItem(page, titleB).click()
  await expect(assistantMessages(page).last()).toContainText(`${segment1}${segment2}`, {
    timeout: 20_000,
  })
  await expect(userMessages(page).last()).toContainText(`乙运行-${run}`)
})

test('工作区改名跨窗口可见，显式刷新不掩盖状态更新', async ({ page, context, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `rename-${run}`)
  const oldName = `旧名字-${run}`
  const newName = `新名字-${run}`
  await createWorkspaceApi(request, oldName, [{ alias: 'p', path: project.path }])

  await openApp(page)
  const page2 = await context.newPage()
  await openApp(page2)
  await expect(workspaceGroup(page2, oldName)).toBeVisible()

  await workspaceGroup(page, oldName).getByRole('button', { name: '管理工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await dialog.getByLabel('工作区名称').fill(newName)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(workspaceGroup(page, newName)).toBeVisible()

  // 另一个窗口不刷新页面，用显式刷新读取宿主权威定义。
  await expect(workspaceGroup(page2, oldName)).toBeVisible()
  await page2.getByRole('button', { name: '刷新工作区' }).click()
  await expect(workspaceGroup(page2, newName)).toBeVisible()
  await expect(workspaceGroup(page2, oldName)).toHaveCount(0)
})

test('未归属会话不自动猜测，GUI 明确加入工作区', async ({ page }) => {
  await openApp(page)
  const row = page
    .locator('[data-slot="huan-session-row"]')
    .filter({ hasText: E2E_UNASSIGNED_TITLE })
  await expect(row).toBeVisible()
  const unassigned = page.locator('[data-slot="huan-unassigned-group"]')
  await expect(unassigned).toContainText(E2E_UNASSIGNED_TITLE)

  // 明确加入要在选中该会话后由会话操作菜单触发；宿主不按 cwd 猜测归属。
  await row.locator('[data-slot="huan-session-trigger"]').click()
  await chooseSessionAction(page, '加入工作区')
  const dialog = page.getByRole('dialog', { name: '加入工作区' })
  await dialog.getByRole('combobox', { name: '目标工作区' }).click()
  const options = page.getByRole('option')
  const targetName = (await options.first().textContent())?.trim() ?? ''
  expect(targetName.length).toBeGreaterThan(0)
  await options.first().click()
  await dialog.getByRole('button', { name: '加入' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(unassigned).toHaveCount(0)

  const target = workspaceGroup(page, targetName)
  if ((await target.getByRole('button', { name: '展开工作区' }).count()) > 0) {
    await target.getByRole('button', { name: '展开工作区' }).click()
  }
  await expect(target).toContainText(E2E_UNASSIGNED_TITLE)
})

test('拒绝成员项目信任仍可对话，且不执行项目扩展', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `denied-${run}`, { extension: true })
  const workspaceName = `拒绝信任工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'denied', path: project.path }])

  await openApp(page)
  await workspaceGroup(page, workspaceName).getByRole('button', { name: '管理工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(dialog.getByText('需要信任决定')).toBeVisible()
  await dialog.getByRole('button', { name: '决定信任' }).click()
  await dialog.getByRole('button', { name: '本次拒绝' }).click()
  await expect(dialog.getByText('仅用户资源')).toBeVisible()
  expect(markerLines(project.marker)).toBe(0)
  await dialog.getByRole('button', { name: '取消' }).click()

  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `拒绝信任后对话-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  expect(markerLines(project.marker)).toBe(0)
})

test('工作区成员信任在管理弹层完成，项目扩展只在允许后执行', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `trusted-${run}`, { extension: true })
  const workspaceName = `信任工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'trusted', path: project.path }])

  await openApp(page)
  await workspaceGroup(page, workspaceName).getByRole('button', { name: '管理工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(dialog.getByText('需要信任决定')).toBeVisible()
  expect(markerLines(project.marker)).toBe(0)

  await dialog.getByRole('button', { name: '决定信任' }).click()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '本次允许' }).click()
  await expect(dialog.getByText('已信任')).toBeVisible()
  expect(markerLines(project.marker)).toBe(1)
  await dialog.getByRole('button', { name: '取消' }).click()

  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `信任后运行-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  expect(markerLines(project.marker)).toBe(1)

  // 已保存的信任决定在刷新后直接显示，不再要求确认。
  await page.reload()
  await workspaceGroup(page, workspaceName).getByRole('button', { name: '管理工作区' }).click()
  const reloadedDialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(reloadedDialog.getByText('已信任')).toBeVisible()
  await expect(reloadedDialog.getByText('需要信任决定')).toHaveCount(0)
})
