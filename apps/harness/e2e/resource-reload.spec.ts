/**
 * G1.4b 浏览器验收：/reload、设置面板应用重载、双窗口资源版本与启动交互接管。
 *
 * 真实宿主/路由 + 隔离临时用户空间；扩展探针经测试控制面写入临时目录。
 * 重载不替换消息与分支，也不覆盖设置面板的未保存草稿。
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  DEFAULT_REPLY,
  openApp,
  selectModel,
  sendMessage,
  threadListItem,
  userMessages,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

const messageInput = (page: Page) => page.getByRole('textbox', { name: '消息输入' })
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: '设置与资源' })
const settingsNotice = (page: Page) =>
  settingsDialog(page).locator('[data-slot="huan-settings-notice"]')
const composerNotice = (page: Page) => page.locator('[data-slot="huan-composer-notice"]')

/** 在临时用户空间/工作区写文件（测试控制面，仅测试启动器注册）。 */
async function writeTestFile(
  request: APIRequestContext,
  root: 'agent' | 'workspace',
  path: string,
  content: string,
): Promise<void> {
  const response = await request.put(`${E2E_HOST_URL}/__e2e__/file`, {
    data: { root, path, content },
  })
  expect(response.ok()).toBe(true)
}

async function removeTestFile(
  request: APIRequestContext,
  root: 'agent' | 'workspace',
  path: string,
): Promise<void> {
  const response = await request.delete(
    `${E2E_HOST_URL}/__e2e__/file?root=${root}&path=${encodeURIComponent(path)}`,
  )
  expect(response.ok()).toBe(true)
}

/** 写一个注册命令的扩展（重载后应出现在命令目录）。 */
async function writeCommandExtension(
  request: APIRequestContext,
  file: string,
  command: string,
): Promise<void> {
  await writeTestFile(
    request,
    'agent',
    `extensions/${file}`,
    `export default function (pi) {
  pi.registerCommand(${JSON.stringify(command)}, {
    description: 'G1.4b 重载探针命令',
    handler: async (_args, ctx) => {
      ctx.ui.notify('probe:' + ${JSON.stringify(command)}, 'info')
    },
  })
}
`,
  )
}

/** 发一条消息并等待确定性回复（建立后端会话）；title 用于侧栏定位。 */
async function openSessionWithTurn(page: Page, title = '第一问'): Promise<void> {
  await openApp(page)
  await selectModel(page)
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
}

test('会话内 /reload 重载资源、刷新命令目录且不新增消息', async ({ page, request }) => {
  await openSessionWithTurn(page)
  await writeCommandExtension(request, 'reload-probe.js', 'reload-probe')

  await messageInput(page).fill('/reload')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(composerNotice(page)).toContainText('已应用到当前会话')
  // 命令自身不进入会话历史：仍只有首条用户消息。
  await expect(userMessages(page)).toHaveCount(1)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(messageInput(page)).toHaveValue('')

  // 命令目录按资源版本重新读取：新扩展命令可发现。
  await page.getByRole('button', { name: '打开命令面板' }).click()
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option', { name: /\/reload-probe/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
})

test('设置保存后可应用资源重载，保留未保存草稿', async ({ page }) => {
  await openSessionWithTurn(page)
  await page.getByRole('button', { name: '设置与资源' }).click()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: 'JSON 原文' }).click()

  const editor = dialog.getByRole('textbox', { name: '设置 JSON' })
  const original = await editor.inputValue()
  const next = original.replace('"keepRecentTokens": 40', '"keepRecentTokens": 50')
  expect(next).not.toBe(original)
  await editor.fill(next)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(settingsNotice(page)).toContainText('已保存')
  await expect(settingsNotice(page)).toContainText('可应用到当前会话')
  // 磁盘值与会话值不同：面板如实提示需要重载。
  await dialog.getByRole('tab', { name: '常用项' }).click()
  await expect(dialog).toContainText('与当前会话使用的设置不同')

  // 制造未保存草稿：应用资源重载不得覆盖它。
  await dialog.getByRole('tab', { name: 'JSON 原文' }).click()
  const draft = `${next.trimEnd()}\n// 草稿标记\n`
  await editor.fill(draft.replace('// 草稿标记', '"draftMarker": 1,'))
  const unsaved = await editor.inputValue()
  await dialog.getByRole('button', { name: '应用到当前会话' }).click()
  await expect(settingsNotice(page)).toContainText('已应用到当前会话')
  await expect(editor).toHaveValue(unsaved)
  await dialog.getByRole('tab', { name: '常用项' }).click()
  await expect(dialog).not.toContainText('与当前会话使用的设置不同')
})

test('双窗口共享资源版本：另一窗口重载后本窗口命令目录更新', async ({ page, request }) => {
  await openSessionWithTurn(page, '双窗口会话')
  await writeCommandExtension(request, 'reload-shared.js', 'shared-reload-cmd')

  // 第二个窗口打开同一会话（通过侧栏标题定位）。
  const second = await page.context().newPage()
  await openApp(second)
  await threadListItem(second, '双窗口会话').click()
  await expect(second.locator('[data-slot="huan-message"][data-role="user"]')).toHaveCount(1)

  // 第二窗口的资源面板此时看到的还是自己的 loader（尚未加载新扩展）。
  await second.getByRole('button', { name: '设置与资源' }).click()
  const secondDialog = settingsDialog(second)
  await secondDialog.getByRole('tab', { name: '资源清单' }).click()
  await expect(secondDialog).not.toContainText('reload-shared.js')

  await messageInput(page).fill('/reload')
  await messageInput(page).press('Enter')
  await expect(composerNotice(page)).toContainText('已应用到当前会话')

  // 资源版本经快照/事件传播：另一窗口的资源面板与命令目录按需重读。
  await expect(secondDialog).toContainText('reload-shared.js')
  await second.keyboard.press('Escape')
  await second.getByRole('button', { name: '打开命令面板' }).click()
  const palette = second.getByRole('dialog', { name: '命令面板' })
  await expect(palette.getByRole('option', { name: /\/shared-reload-cmd/ })).toBeVisible()
  await second.keyboard.press('Escape')
  await second.close()
})

test('重载期间 session_start 确认可页面应答，结束后恢复', async ({ page, request }) => {
  await openSessionWithTurn(page)
  await writeTestFile(request, 'workspace', '.pi/ask-startup', '')
  try {
    await messageInput(page).fill('/reload')
    await messageInput(page).press('Enter')
    const card = page.locator('[data-slot="huan-host-interaction"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText('HOSTUI-启动确认')
    // 重载处于启动期：回答后同一请求结算并完成重载。
    await card.getByRole('button', { name: '允许' }).click()
    await expect(card).toHaveCount(0)
    await expect(composerNotice(page)).toContainText('已应用到当前会话')
    await expect(userMessages(page)).toHaveCount(1)
  } finally {
    await removeTestFile(request, 'workspace', '.pi/ask-startup')
  }
})

test('空白页 /reload 只提示起始目录装配，不创建会话', async ({ page, request }) => {
  await openApp(page)
  await writeCommandExtension(request, 'reload-blank.js', 'blank-reload-cmd')
  await messageInput(page).fill('/reload')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(composerNotice(page)).toContainText('已刷新项目资源')
  await expect(userMessages(page)).toHaveCount(0)
  await page.getByRole('button', { name: '打开命令面板' }).click()
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette.getByRole('option', { name: /\/blank-reload-cmd/ })).toBeVisible()
  await page.keyboard.press('Escape')
  // 仍停留在空白页：重载没有隐式创建会话。
  await expect(userMessages(page)).toHaveCount(0)
})
