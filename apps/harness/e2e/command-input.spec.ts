/**
 * G1.3b 浏览器验收：命令目录/内置路由、扩展命令与参数补全、@ 文件引用、
 * 图片能力拒绝、草稿/长输入/历史与显式队列。
 *
 * 使用真实 HTTP/SSE、真实 Pi SDK 与隔离临时用户空间；不访问个人空间或
 * 付费模型。模型流由测试控制端点显式释放。
 */
import { expect, test } from '@playwright/test'
import {
  assistantMessages,
  configureStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  streamState,
  threadListItem,
  userMessages,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

const messageInput = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'Message input' })

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

test('命令目录展示内置/扩展/未实施阶段，内置命令不当作普通 prompt', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: '打开命令面板' }).click()
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option', { name: /\/probe/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /\/model/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: /\/settings/ })).not.toContainText('G1.')
  await expect(palette.getByRole('option', { name: /\/export/ })).toContainText('G1.5')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  // /model 打开现有模型选择器，不创建会话、不发用户消息。
  await messageInput(page).fill('/model')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(page.locator('[data-slot="model-selector-content"]')).toBeVisible()
  await expect(userMessages(page)).toHaveCount(0)
  await expect(messageInput(page)).toHaveValue('')
  await page.keyboard.press('Escape')

  // 已实施内置命令打开同一设置面板，不发送给模型；完成后回到输入框。
  await messageInput(page).fill('/settings')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  const settings = page.getByRole('dialog', { name: '设置与资源' })
  await expect(settings).toBeVisible()
  await expect(userMessages(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(messageInput(page)).toHaveValue('')
})

test('扩展命令经 SDK 执行且参数补全不进入模型', async ({ page }) => {
  await openApp(page)
  await selectModel(page)

  // 斜杠补全：键盘选择 /probe。
  await messageInput(page).fill('/pro')
  const commandList = page.getByRole('listbox', { name: '命令补全' })
  await expect(commandList).toBeVisible()
  await expect(commandList.getByRole('option', { name: /\/probe/ })).toBeVisible()
  await messageInput(page).press('Enter')
  await expect(messageInput(page)).toHaveValue('/probe ')

  // 扩展参数补全来自宿主公开的 getArgumentCompletions。
  await messageInput(page).fill('/probe a')
  const argumentList = page.getByRole('listbox', { name: '命令参数补全' })
  await expect(argumentList).toBeVisible()
  await expect(argumentList.getByRole('option', { name: /alpha/ })).toBeVisible()
  await messageInput(page).press('Enter')
  await expect(messageInput(page)).toHaveValue('/probe alpha')

  // 扩展命令自己处理输入：不产生用户消息，也不请求模型。
  await messageInput(page).press('Enter')
  await expect(page.locator('[data-slot="huan-composer-notice"]')).toHaveCount(0)
  await expect(userMessages(page)).toHaveCount(0)
  await expect(assistantMessages(page)).toHaveCount(0)
  await expect(messageInput(page)).toHaveValue('')
})

test('@ 文件引用来自当前工作区，支持中文与空格', async ({ page }) => {
  await openApp(page)
  await messageInput(page).fill('@')
  const fileList = page.getByRole('listbox', { name: '文件引用补全' })
  await expect(fileList).toBeVisible()
  await expect(fileList.getByRole('option', { name: /main\.ts/ })).toBeVisible()

  await messageInput(page).fill('@指南')
  await expect(fileList.getByRole('option', { name: /指南 文件\.md/ })).toBeVisible()
  await fileList.getByRole('option', { name: /指南 文件\.md/ }).click()
  await expect(messageInput(page)).toHaveValue('@"workspace/docs/指南 文件.md" ')
})

test('图片在不支持图像的模型下被拒绝，文字与附件保留', async ({ page }) => {
  await openApp(page)
  await selectModel(page, 'Test Model B')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Add Attachment' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZkAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(page.locator('.aui-attachment-tile')).toHaveCount(1)
  await messageInput(page).fill('图片能力测试')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.locator('[data-slot="huan-composer-notice"]')).toContainText(
    '未声明图像输入能力',
  )
  await expect(messageInput(page)).toHaveValue('图片能力测试')
  await expect(page.locator('.aui-attachment-tile')).toHaveCount(1)
  await expect(userMessages(page)).toHaveCount(0)
})

test('粘贴图片生成浏览器附件，可预览移除', async ({ page }) => {
  await openApp(page)
  await messageInput(page).evaluate((element) => {
    const binary = atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    )
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'paste.png', { type: 'image/png' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  })
  const tile = page.locator('.aui-attachment-tile')
  await expect(tile).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Preview paste.png', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Remove paste.png', exact: true }).click()
  await expect(tile).toHaveCount(0)
})

test('两个窗口的草稿互不覆盖，刷新只恢复本窗口文字', async ({ page, context }) => {
  await openApp(page)
  await messageInput(page).fill('窗口一草稿')
  const second = await context.newPage()
  await openApp(second)
  await expect(messageInput(second)).toHaveValue('')
  await messageInput(second).fill('窗口二草稿')
  await expect(messageInput(page)).toHaveValue('窗口一草稿')
  await second.reload()
  await expect(second.getByRole('region', { name: 'Pi host status' })).toBeVisible()
  await expect(messageInput(second)).toHaveValue('窗口二草稿')
  await expect(messageInput(page)).toHaveValue('窗口一草稿')
  await second.close()
})

test('草稿刷新恢复、长输入取消与应用、窗口历史回到空输入框', async ({ page, request }) => {
  await openApp(page)
  await selectModel(page)
  await messageInput(page).fill('刷新后恢复的草稿')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Pi host status' })).toBeVisible()
  await expect(messageInput(page)).toHaveValue('刷新后恢复的草稿')
  // 模型草稿不持久化：刷新后重新选择测试模型再发送。
  await selectModel(page)

  // 长输入：取消保留原草稿，确认才写回。
  await page.getByRole('button', { name: '展开编辑长输入' }).click()
  const longDialog = page.getByRole('dialog', { name: '展开编辑输入' })
  await expect(longDialog).toBeVisible()
  await longDialog.getByRole('textbox', { name: '长输入内容' }).fill('取消不应写回')
  await page.keyboard.press('Escape')
  await expect(longDialog).toHaveCount(0)
  await expect(messageInput(page)).toHaveValue('刷新后恢复的草稿')

  await page.getByRole('button', { name: '展开编辑长输入' }).click()
  await longDialog.getByRole('textbox', { name: '长输入内容' }).fill('应用后的长文本')
  await longDialog.getByRole('button', { name: '应用' }).click()
  await expect(messageInput(page)).toHaveValue('应用后的长文本')

  // 发送后空框 ArrowUp 回到本窗口已提交文字。
  await messageInput(page).fill('')
  const sent = `窗口历史-${Date.now().toString(36)}`
  await sendMessage(page, sent)
  await expect(assistantMessages(page).last()).toBeVisible()
  await messageInput(page).press('ArrowUp')
  await expect(messageInput(page)).toHaveValue(sent)
  await resetStream(request)
})

test('打开旧会话后新增输入不会把历史消息补记到窗口输入历史', async ({ page }) => {
  const run = Date.now().toString(36)
  const oldest = `旧会话首条-${run}`
  const latestOld = `旧会话末条-${run}`
  const fresh = `本窗口新输入-${run}`
  await openApp(page)
  await startNewSession(page)
  await selectModel(page)
  await sendMessage(page, oldest)
  await expect(userMessages(page)).toHaveCount(1)
  await expect(assistantMessages(page).last()).toContainText('这是确定性测试回复。')
  await expect(page.locator('[data-slot="huan-run-status"]')).toHaveCount(0)
  await sendMessage(page, latestOld)
  await expect(userMessages(page)).toHaveCount(2)
  await expect(page.locator('[data-slot="huan-run-status"]')).toHaveCount(0)
  await page.reload()
  await threadListItem(page, oldest).click()
  await expect(userMessages(page)).toHaveCount(2)
  await sendMessage(page, fresh)
  await expect(userMessages(page)).toHaveCount(3)
  await expect(messageInput(page)).toHaveValue('')
  await messageInput(page).press('ArrowUp')
  await expect(messageInput(page)).toHaveValue(fresh)
  await messageInput(page).press('ArrowUp')
  await expect(messageInput(page)).toHaveValue(fresh)
})

test('输入 ! / !! 直接执行 Shell，不把命令发给模型', async ({ page }) => {
  await openApp(page)
  await selectModel(page)
  await sendMessage(page, '建立 Shell 会话')
  await expect(assistantMessages(page).last()).toBeVisible()
  await expect(userMessages(page)).toHaveCount(1)

  const run = Date.now().toString(36)
  await messageInput(page).fill(`!echo huan-inline-${run}`)
  await messageInput(page).press('Enter')
  const includeCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(includeCard).toContainText(`echo huan-inline-${run}`)
  await expect(includeCard).toContainText(`huan-inline-${run}`)
  await expect(userMessages(page)).toHaveCount(1)

  await messageInput(page).fill(`!!echo huan-excluded-${run}`)
  await messageInput(page).press('Enter')
  const excludeCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(excludeCard).toContainText(`echo huan-excluded-${run}`)
  await expect(excludeCard).toContainText('不进入上下文')
  await expect(userMessages(page)).toHaveCount(1)
})

test('运行中显式转向/后续、队列标注与整体取回', async ({ page, request }) => {
  await openApp(page)
  await selectModel(page)
  await configureStream(request, ['队列第一段'])
  await sendMessage(page, '队列运行开始')
  await expect.poll(async () => (await streamState(request)).active).toBe(true)
  await releaseSegment(request)
  await expect(assistantMessages(page).last()).toContainText('队列第一段')
  await expect(page.locator('[data-slot="huan-run-status"]')).toContainText('运行中')

  await messageInput(page).fill('转向内容')
  await page
    .locator('[data-slot="huan-composer-queue-mode"]')
    .getByRole('button', {
      name: '转向',
    })
    .click()
  await page.getByRole('button', { name: 'Send message' }).click()
  const queue = page.locator('[data-slot="huan-composer-queue"]')
  await expect(queue).toContainText('转向')
  await expect(queue).toContainText('转向内容')

  await messageInput(page).fill('后续内容')
  await page
    .locator('[data-slot="huan-composer-queue-mode"]')
    .getByRole('button', {
      name: '后续',
    })
    .click()
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(queue).toContainText('后续内容')

  await page.locator('[data-slot="huan-queue-retrieve"]').click()
  await expect(queue).toHaveCount(0)
  const value = await messageInput(page).inputValue()
  expect(value).toContain('转向内容')
  expect(value).toContain('后续内容')

  await page.getByRole('button', { name: 'Stop generating' }).click()
})
