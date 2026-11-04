import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import {
  assistantMessages,
  chooseSessionAction,
  configureStream,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  disconnectClients,
  openApp,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  threadListItem,
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

const panel = (page: Page) => page.getByRole('dialog', { name: '运行操作' })

async function openPanel(page: Page) {
  await chooseSessionAction(page, '运行操作')
  const dialog = panel(page)
  await expect(dialog).toBeVisible()
  return dialog
}

async function closePanel(page: Page) {
  await panel(page).getByRole('button', { name: '关闭' }).click()
  await expect(panel(page)).toHaveCount(0)
}

/** 新建一个只含一个项目的隔离工作区，避免跨用例的归属/信任互相影响。 */
async function prepareWorkspace(request: APIRequestContext, label: string): Promise<string> {
  const run = Date.now().toString(36)
  const project = await createProject(request, `${label}-${run}`)
  const workspaceName = `${label}工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  return workspaceName
}

/** 在当前会话发送一条长消息，确保会话文件存在且压缩有可摘要历史。 */
async function sendLongMessage(page: Page, text: string): Promise<void> {
  await sendMessage(page, `${text} ${'上下文历史'.repeat(24)}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
}

test('Shell 实时输出、历史卡片与 !! 排除上下文', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const workspaceName = await prepareWorkspace(request, 'Shell')
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  const title = `Shell-${run}`
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, title)).toBeVisible()

  // `!`：实时输出在面板内可见，完成后历史卡片可展开阅读。
  const dialog = await openPanel(page)
  await dialog
    .getByRole('textbox', { name: 'Shell 命令' })
    .fill(`printf 'shell-live-${run}'; sleep 5; printf -- '-done\\n'`)
  await dialog.getByRole('button', { name: '运行 Shell' }).click()
  await expect(dialog.getByText('运行中', { exact: true })).toBeVisible()
  await expect(dialog.locator('[data-slot="huan-shell-output"]')).toContainText(`shell-live-${run}`)
  await closePanel(page)

  // 空闲会话完成后立即持久化，运行卡由历史卡片取代（不重复展示）。
  const includeCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(includeCard).toContainText(`printf 'shell-live-${run}'`, { timeout: 10_000 })
  await expect(includeCard).toContainText('退出码 0')
  await expect(includeCard).not.toContainText('不进入上下文')
  await includeCard.getByRole('button').first().click()
  await expect(includeCard).toContainText(`shell-live-${run}-done`)

  // `!!`：选择排除上下文后，历史卡片明确标注。
  const second = await openPanel(page)
  await second.getByRole('combobox', { name: 'Shell 上下文' }).click()
  await page.getByRole('option', { name: '不进入上下文（!!）' }).click()
  await second.getByRole('textbox', { name: 'Shell 命令' }).fill(`echo excluded-${run}`)
  await second.getByRole('button', { name: '运行 Shell' }).click()
  await closePanel(page)

  const excludeCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(excludeCard).toContainText(`echo excluded-${run}`)
  await expect(excludeCard).toContainText('不进入上下文')
  await expect(excludeCard).toContainText('退出码 0')
})

test('Shell 双窗实时、断线重连与独立取消', async ({ page, context, request }) => {
  const run = Date.now().toString(36)
  // 第二个窗口默认活动工作区是宿主启动工作区；显式用它以保证会话可见。
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  const title = `Shell双窗-${run}`
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, title)).toBeVisible()

  const second = await context.newPage()
  await openApp(second)
  await threadListItem(second, title).click()
  await expect(
    second.locator('[data-slot="huan-message"][data-role="user"]').first(),
  ).toContainText(title)

  const dialog = await openPanel(page)
  const command = `printf 'shell-a-${run}'; sleep 6; printf 'shell-b-${run}'`
  await dialog.getByRole('textbox', { name: 'Shell 命令' }).fill(command)
  await dialog.getByRole('button', { name: '运行 Shell' }).click()
  await expect(dialog.getByText('运行中', { exact: true })).toBeVisible()
  await expect(dialog.locator('[data-slot="huan-shell-output"]')).toContainText(`shell-a-${run}`)

  // 另一窗口无需刷新即可看到同一运行状态。
  const secondDialog = await openPanel(second)
  await expect(secondDialog.getByText(command)).toBeVisible()
  await expect(secondDialog.getByText('运行中', { exact: true })).toBeVisible()

  // 断开事件流：客户端读到 EOF 后重连；断开期间产生的新输出必须补上，
  // 只看到断开前的旧文字不足以证明重新订阅成功（命令随后完成并落为历史卡片）。
  await disconnectClients(request)
  const firstCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(firstCard).toContainText(`shell-b-${run}`, { timeout: 20_000 })
  const secondCard = second.locator('[data-slot="huan-bash-message"]').last()
  await expect(secondCard).toContainText(`shell-b-${run}`, { timeout: 20_000 })
  await expect(secondCard).toContainText(`shell-a-${run}`)

  // 独立取消：再起一个长时间运行的 Shell，在另一窗口取消；两个窗口都收到
  // 同一取消完成态（空闲会话不保留重复的运行卡）。
  const cancelCommand = `sleep 30 # ${run}`
  await page.getByRole('textbox', { name: 'Shell 命令' }).fill(cancelCommand)
  await page.getByRole('button', { name: '运行 Shell' }).click()
  await expect(secondDialog.getByText('运行中', { exact: true })).toBeVisible()
  await secondDialog.getByRole('button', { name: '取消 Shell' }).click()
  await closePanel(second)
  await closePanel(page)
  const cancelledFirst = page.locator('[data-slot="huan-bash-message"]').last()
  const cancelledSecond = second.locator('[data-slot="huan-bash-message"]').last()
  await expect(cancelledFirst).toContainText('已取消')
  await expect(cancelledSecond).toContainText('已取消')
  await expect(cancelledSecond).toContainText(cancelCommand)
  await second.close()
})

test('手动压缩成功与取消后恢复', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const workspaceName = await prepareWorkspace(request, '压缩')
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendLongMessage(page, `压缩一-${run}`)
  await sendLongMessage(page, `压缩二-${run}`)
  await sendLongMessage(page, `压缩三-${run}`)

  const dialog = await openPanel(page)
  await dialog.getByRole('textbox', { name: '压缩指令' }).fill('保留关键决策')
  await dialog.getByRole('button', { name: '压缩上下文' }).click()
  await expect(
    page.locator('[data-slot="huan-compaction-status"][data-status="compacted"]'),
  ).toContainText('上下文已压缩')
  await closePanel(page)
  await expect(page.locator('[data-slot="huan-compaction-status"]')).toHaveCount(1)
  await page.getByRole('button', { name: /上下文已压缩/ }).click()
  await expect(page.locator('[data-slot="huan-compaction-status"]')).toContainText(DEFAULT_REPLY)

  // 手动压缩取消：新会话凑够可压缩历史，再挂起摘要请求后取消。
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendLongMessage(page, `取消一-${run}`)
  await sendLongMessage(page, `取消二-${run}`)
  await sendLongMessage(page, `取消三-${run}`)
  await configureStream(request, ['不会使用的摘要'])
  const cancelDialog = await openPanel(page)
  await cancelDialog.getByRole('button', { name: '压缩上下文' }).click()
  await expect(cancelDialog.getByText(/压缩中（手动）/)).toBeVisible()
  await cancelDialog.getByRole('button', { name: '取消压缩' }).click()
  await expect(
    page.locator('[data-slot="huan-compaction-status"][data-status="cancelled"]'),
  ).toContainText('压缩已取消')
  await closePanel(page)
  await resetStream(request)

  // 取消后可继续正常对话（不通过 reload 掩盖状态传播）。
  const recovery = `取消后恢复-${run}`
  await sendMessage(page, recovery)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(page.locator('[data-slot="huan-message"][data-role="user"]').last()).toContainText(
    recovery,
  )
})
