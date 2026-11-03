import { expect, type Page, test } from '@playwright/test'
import {
  assistantMessages,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  openApp,
  selectModel,
  sendMessage,
  startNewSession,
  threadListItem,
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

test.afterEach(async () => {
  expect(browserErrors).toEqual([])
})

/** 输入区模型选择器与弹层；页面只有这一个最终候选入口。 */
const modelTrigger = (page: Page) =>
  page.locator('[data-slot="huan-composer"]').getByRole('combobox')
const modelPopup = (page: Page) => page.locator('[data-slot="model-selector-content"]')

test('工作区自定义范围约束新会话候选，旧模型继续显示与发送', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `model-scope-${run}`)
  const workspaceName = `模型范围工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page, 'Test Model B')
  const title = `范围旧模型-${run}`
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  const second = await page.context().newPage()
  await openApp(second)
  await workspaceGroup(second, workspaceName)
    .getByRole('button', { name: '展开工作区', exact: true })
    .click()
  await threadListItem(second, title).click()
  await expect(modelTrigger(second)).toContainText('Test Model B')

  const group = workspaceGroup(page, workspaceName)
  await group.getByRole('button', { name: '管理工作区', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: '跟随全局' })).toBeChecked()
  await dialog.getByRole('radio', { name: '自定义' }).check()
  await expect(dialog.getByRole('checkbox', { name: /Test Model A/ })).toBeChecked()
  const modelB = dialog.getByRole('checkbox', { name: /Test Model B/ })
  await expect(modelB).toBeChecked()
  await modelB.uncheck()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // 范围只影响新建与主动选择：已有会话仍显示原模型并继续发送。
  await expect(modelTrigger(page)).toContainText('huan-test/test-model-b')
  await modelTrigger(second).click()
  await expect(modelPopup(second).getByRole('option', { name: /Test Model A/ })).toBeVisible()
  await expect(modelPopup(second).getByRole('option', { name: /Test Model B/ })).toHaveCount(0)
  await second.keyboard.press('Escape')
  await expect(modelTrigger(second)).toContainText('huan-test/test-model-b')
  await second.close()
  await sendMessage(page, `旧模型继续-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  // 新会话只列最终候选；被排除的 B 不再以禁用项出现在下拉中。
  await startNewSession(page, workspaceName)
  await modelTrigger(page).click()
  await expect(modelPopup(page).getByRole('option', { name: /Test Model A/ })).toBeVisible()
  await expect(modelPopup(page).getByRole('option', { name: /Test Model B/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // 自定义范围无匹配时明确显示无候选，并指向现有设置/认证入口。
  await group.getByRole('button', { name: '管理工作区', exact: true }).click()
  const emptyDialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(emptyDialog.getByRole('radio', { name: '自定义' })).toBeChecked()
  await emptyDialog.locator('[data-slot="huan-model-scope-advanced"] summary').click()
  await emptyDialog.getByRole('textbox', { name: '模型 patterns' }).fill('huan-test/missing')
  await emptyDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(emptyDialog).toHaveCount(0)

  await startNewSession(page, workspaceName)
  await modelTrigger(page).click()
  await expect(modelPopup(page).getByText('当前范围内没有可用模型。')).toBeVisible()
  await expect(modelPopup(page).getByRole('button', { name: '打开设置' })).toBeVisible()
  await expect(modelPopup(page).getByRole('button', { name: '管理认证' })).toBeVisible()
  await modelPopup(page).getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('dialog', { name: '设置与资源' })).toBeVisible()
})
