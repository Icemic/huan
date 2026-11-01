import { expect, test } from '@playwright/test'
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

test('运行期通知/状态/widget/标题与定向编辑器指令可见且可恢复', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `hostui-${run}`)
  const workspaceName = `HostUI 工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'a', path: project.path }])

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, '/host-ui')

  const threadUi = page.locator('[data-slot="huan-thread-host-ui"]')
  await expect(threadUi).toContainText('HOSTUI-状态')
  await expect(threadUi).toContainText('HOSTUI-扩展标题')
  await expect(page.locator('[data-slot="huan-extension-notifications"]')).toContainText(
    'HOSTUI-通知',
  )
  const widget = page.locator('[data-slot="huan-widget-belowEditor"]')
  await expect(widget).toContainText('HOSTUI-行一')
  await expect(widget).toContainText('HOSTUI-行二')

  const directive = page.locator('[data-slot="huan-editor-directive"]')
  await expect(directive).toContainText('HOSTUI-编辑内容')
  const input = page.getByRole('textbox', { name: 'Message input' })
  // 不自动覆盖：先由用户确认应用。
  await expect(input).toHaveValue('')
  await directive.getByRole('button', { name: '应用' }).click()
  await expect(input).toHaveValue('HOSTUI-编辑内容')
  await expect(page.locator('[data-slot="huan-editor-directive-recovery"]')).toBeVisible()
  await page.getByRole('button', { name: '恢复原内容' }).click()
  await expect(input).toHaveValue('')
})

test('定向编辑器指令只在发起窗口可应用，另一窗口保留草稿', async ({ page, context }) => {
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  const title = `定向双窗-${Date.now().toString(36)}`
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const second = await context.newPage()
  await openApp(second)
  await threadListItem(second, title).click()
  const secondInput = second.getByRole('textbox', { name: 'Message input' })
  await secondInput.fill('另一窗口草稿')
  await sendMessage(page, '/host-ui')
  const directive = page.locator('[data-slot="huan-editor-directive"]')
  await expect(directive).toBeVisible()
  await expect(second.locator('[data-slot="huan-editor-directive"]')).toHaveCount(0)
  await directive.getByRole('button', { name: '应用' }).click()
  await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('HOSTUI-编辑内容')
  await expect(secondInput).toHaveValue('另一窗口草稿')
  await second.close()
})

test('游离 confirm 在会话内可应答并产生可见结果', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `hostask-${run}`)
  const workspaceName = `Host 交互工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'a', path: project.path }])

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, '/ask-host-ui')

  const card = page
    .locator('[data-slot="huan-host-ui-request"]')
    .filter({ hasText: 'HOSTUI-工具确认' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '允许' }).click()
  await expect(page.locator('[data-slot="huan-thread-host-ui"]')).toContainText(
    'HOSTUI-确认结果:true',
  )
})

test('启动请求可在发起窗口关闭后由另一窗口接管', async ({ page, context, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `host-takeover-${run}`, {
    extension: true,
    askTrust: true,
  })
  const name = `启动接管-${run}`
  await createWorkspaceApi(request, name, [{ alias: 'p', path: project.path }])
  await openApp(page)
  await workspaceGroup(page, name).getByRole('button', { name: '新建会话', exact: true }).click()
  const card = page
    .locator('[data-slot="huan-host-interaction"]')
    .filter({ hasText: 'HOSTUI-项目信任' })
  await expect(card).toBeVisible()
  const second = await context.newPage()
  // 继承中的启动交互会先以模态显示，应用背景此时不可操作。
  await second.goto('/')
  const inherited = second
    .locator('[data-slot="huan-host-interaction"]')
    .filter({ hasText: 'HOSTUI-项目信任' })
  await expect(inherited).toBeVisible()
  await page.close()
  await inherited.getByRole('button', { name: '允许' }).click()
  await expect(inherited).toHaveCount(0)
  await startNewSession(second, name)
  await selectModel(second)
  await sendMessage(second, `接管后发送-${run}`)
  await expect(assistantMessages(second).last()).toContainText(DEFAULT_REPLY)
  await second.close()
})

test('启动期项目信任与 session_start 请求在会话创建中可发现/应答', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `hoststart-${run}`, {
    extension: true,
    askTrust: true,
    askStartup: true,
  })
  const workspaceName = `Host 启动工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'a', path: project.path }])

  await openApp(page)
  const group = workspaceGroup(page, workspaceName)
  await group.getByRole('button', { name: '新建会话', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })

  // 资源目录查询亦可能先触发信任；必须先完成顶层交互，才能继续底层模态。
  const panel = page.getByRole('region', { name: '宿主交互' })
  const trustCard = panel
    .locator('[data-slot="huan-host-interaction"]')
    .filter({ hasText: 'HOSTUI-项目信任' })
  await expect(trustCard).toBeVisible({ timeout: 20_000 })
  await trustCard.getByRole('button', { name: '允许' }).click()
  await dialog.getByRole('button', { name: '开始新会话' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible()
  await selectModel(page)
  // 实际 Pi 会话在首条消息时才创建：session_start 请求会阻塞这条发送。
  await sendMessage(page, `启动交互后对话-${run}`)

  const startupCard = panel
    .locator('[data-slot="huan-host-interaction"]')
    .filter({ hasText: 'HOSTUI-启动确认' })
  await expect(startupCard).toBeVisible({ timeout: 20_000 })
  await startupCard.getByRole('button', { name: '允许' }).click()
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  // 启动期请求完成后宿主通道清空。
  await expect(panel).toHaveCount(0)
})
