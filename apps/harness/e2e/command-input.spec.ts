/**
 * G1.3b 浏览器验收：命令目录/内置路由、扩展命令与参数补全、@ 文件引用、
 * 图片能力拒绝、草稿/历史与显式队列。
 *
 * 使用真实 HTTP/SSE、真实 Pi SDK 与隔离临时用户空间；不访问个人空间或
 * 付费模型。模型流由测试控制端点显式释放。
 */
import { expect, type Locator, type Page, test } from '@playwright/test'
import {
  assistantMessages,
  configureStream,
  DEFAULT_REPLY,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  settingsDialog,
  startNewSession,
  streamState,
  threadListItem,
  userMessages,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

const messageInput = (page: Page) => page.getByRole('textbox', { name: '消息输入' })

/** 输入区表单与输入框的稳定布局（补全悬浮不应改变）。 */
async function composerGeometry(page: Page) {
  const form = page.locator('[data-slot="huan-composer"]')
  const input = messageInput(page)
  const formBox = await form.boundingBox()
  const inputBox = await input.boundingBox()
  if (!formBox || !inputBox) throw new Error('输入区缺少可测量的布局框')
  return { form: formBox, input: inputBox }
}

/** 补全列表绝对定位在输入区上方，出现时输入区位置与高度不变。 */
async function expectFloatingCompletions(page: Page): Promise<void> {
  const popup = page.locator('[data-slot="huan-composer-completions"]')
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('listbox')).toBeVisible()
  const geometry = await popup.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { position: style.position, bottom: rect.bottom }
  })
  expect(geometry.position).toBe('absolute')
  const inputBox = await messageInput(page).boundingBox()
  if (!inputBox) throw new Error('输入框没有布局框')
  expect(geometry.bottom).toBeLessThanOrEqual(inputBox.y + 0.5)
}

function expectSameComposerGeometry(
  before: Awaited<ReturnType<typeof composerGeometry>>,
  after: Awaited<ReturnType<typeof composerGeometry>>,
): void {
  for (const key of ['form', 'input'] as const) {
    expect(Math.abs(after[key].y - before[key].y)).toBeLessThan(0.5)
    expect(Math.abs(after[key].height - before[key].height)).toBeLessThan(0.5)
  }
}

/** 键入命令前缀，检查输入框展示的实际补全结果。 */
async function expectCommandListed(page: Page, prefix: string, name: string): Promise<Locator> {
  await messageInput(page).fill(prefix)
  const option = page
    .getByRole('listbox', { name: '命令补全' })
    .getByRole('option', { name: new RegExp(`^/${name}(?:\\s|$)`) })
  await expect(option).toBeVisible()
  return option
}

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

test('命令目录展示内置/扩展/未实施阶段，内置命令不当作普通 prompt', async ({ page }) => {
  await openApp(page)
  const input = messageInput(page)

  // 命令统一从输入框的 / 补全发现，来源与阶段直接落在 listbox 选项上。
  const emptyGeometry = await composerGeometry(page)
  const probe = await expectCommandListed(page, '/pro', 'probe')
  await expectFloatingCompletions(page)
  expectSameComposerGeometry(emptyGeometry, await composerGeometry(page))
  await expect(probe.getByText('扩展', { exact: true })).toBeVisible()
  const model = await expectCommandListed(page, '/model', 'model')
  await expect(model.getByText('内置', { exact: true })).toBeVisible()
  const settingsOption = await expectCommandListed(page, '/settings', 'settings')
  await expect(settingsOption.getByText('内置', { exact: true })).toBeVisible()
  await expect(settingsOption).not.toContainText('G1.')
  const llama = await expectCommandListed(page, '/llama', 'llama')
  await expect(llama.getByText('内置 · G1.4', { exact: true })).toBeVisible()
  const exported = await expectCommandListed(page, '/export', 'export')
  await expect(exported.getByText('内置 · G1.5', { exact: true })).toBeVisible()

  // 旧命令入口与命令面板已删除，不再提供隐藏按钮。
  await expect(page.getByRole('button', { name: '打开命令面板' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /引用文件/ })).toHaveCount(0)

  // /model 打开现有模型选择器，不创建会话、不发用户消息。
  const beforeModel = await composerGeometry(page)
  await input.fill('/model')
  await expect(page.getByRole('listbox', { name: '命令补全' })).toBeVisible()
  expectSameComposerGeometry(beforeModel, await composerGeometry(page))
  await input.press('Escape')
  await expect(page.getByRole('listbox', { name: '命令补全' })).toHaveCount(0)
  expectSameComposerGeometry(beforeModel, await composerGeometry(page))
  await input.press('Enter')
  await expect(page.locator('[data-slot="model-selector-content"]')).toBeVisible()
  await expect(userMessages(page)).toHaveCount(0)
  await expect(input).toHaveValue('')
  await page.keyboard.press('Escape')

  // 已实施内置命令打开同一统一设置，不发送给模型；完成后回到输入框。
  await input.fill('/settings')
  await input.press('Escape')
  await input.press('Enter')
  const settings = settingsDialog(page)
  await expect(settings).toBeVisible()
  await expect(userMessages(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(input).toHaveValue('')
})

test('扩展命令经 SDK 执行且参数补全不进入模型', async ({ page }) => {
  await openApp(page)
  await selectModel(page)

  // 斜杠补全：键盘选择 /probe。
  await expectCommandListed(page, '/pro', 'probe')
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
  const emptyGeometry = await composerGeometry(page)
  await messageInput(page).fill('@')
  const fileList = page.getByRole('listbox', { name: '文件引用补全' })
  await expect(fileList).toBeVisible()
  await expectFloatingCompletions(page)
  expectSameComposerGeometry(emptyGeometry, await composerGeometry(page))
  await expect(fileList.getByRole('option', { name: /main\.ts/ })).toBeVisible()

  await messageInput(page).fill('@指南')
  await expect(fileList.getByRole('option', { name: /指南 文件\.md/ })).toBeVisible()
  await fileList.getByRole('option', { name: /指南 文件\.md/ }).click()
  await expect(messageInput(page)).toHaveValue('@"workspace/docs/指南 文件.md" ')
  await expect(fileList).toHaveCount(0)
  expectSameComposerGeometry(emptyGeometry, await composerGeometry(page))
})

test('图片在不支持图像的模型下被拒绝，文字与附件保留', async ({ page }) => {
  await openApp(page)
  await selectModel(page, 'Test Model B')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加内容', exact: true }).click()
  await page.getByRole('menuitem', { name: '添加图片', exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZkAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(page.locator('[data-slot="huan-composer-attachment"]')).toHaveCount(1)
  await messageInput(page).fill('图片能力测试')
  await page.getByRole('button', { name: '发送消息' }).click()

  await expect(page.locator('[data-slot="huan-composer-notice"]')).toContainText(
    '未声明图像输入能力',
  )
  await expect(messageInput(page)).toHaveValue('图片能力测试')
  await expect(page.locator('[data-slot="huan-composer-attachment"]')).toHaveCount(1)
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
  const tile = page.locator('[data-slot="huan-composer-attachment"]')
  await expect(tile).toHaveCount(1)
  await expect(page.getByRole('button', { name: '预览附件 paste.png', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '移除附件 paste.png', exact: true }).click()
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
  await expect(second.locator('[data-slot="huan-header"]')).toBeVisible()
  await expect(messageInput(second)).toHaveValue('窗口二草稿')
  await expect(messageInput(page)).toHaveValue('窗口一草稿')
  await second.close()
})

test('草稿刷新恢复、多行草稿直接编辑、窗口历史回到空输入框', async ({ page, request }) => {
  await openApp(page)
  await selectModel(page)
  await messageInput(page).fill('刷新后恢复的草稿')
  await page.reload()
  await expect(page.locator('[data-slot="huan-header"]')).toBeVisible()
  await expect(messageInput(page)).toHaveValue('刷新后恢复的草稿')
  // 模型草稿不持久化：刷新后重新选择测试模型再发送。
  await selectModel(page)

  // 展开编辑入口与对话框已删除；多行草稿直接在输入框编辑。
  await expect(page.getByRole('button', { name: '展开编辑长输入' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '展开编辑输入' })).toHaveCount(0)
  const multiline = '直接编辑第一行\n直接编辑第二行\n直接编辑第三行'
  await messageInput(page).fill(multiline)
  await expect(messageInput(page)).toHaveValue(multiline)

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
  await page.getByRole('button', { name: '发送消息' }).click()
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
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(queue).toContainText('后续内容')

  await page.locator('[data-slot="huan-queue-retrieve"]').click()
  await expect(queue).toHaveCount(0)
  const value = await messageInput(page).inputValue()
  expect(value).toContain('转向内容')
  expect(value).toContain('后续内容')

  await page.getByRole('button', { name: '停止当前运行' }).click()
})

test('异步命令完成不清除同目标的新草稿', async ({ page }) => {
  const run = Date.now().toString(36)
  await openApp(page)
  // 延迟模型目录请求：命令完成时用户已经输入了新草稿。
  await page.route('**/api/pi/models*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  try {
    await messageInput(page).fill('/model test-model-b')
    await messageInput(page).press('Escape')
    await messageInput(page).press('Enter')
    const draft = `同目标新草稿-${run}`
    await messageInput(page).fill(draft)
    await expect(page.locator('[data-slot="huan-composer-notice"]')).toContainText('新会话将使用', {
      timeout: 20_000,
    })
    // 命令只作用于自己的草稿版本，不能清掉之后输入的文本。
    await expect(messageInput(page)).toHaveValue(draft)
  } finally {
    await page.unroute('**/api/pi/models*')
  }
})

test('窗口输入历史只记录本窗口提交，其他窗口的消息不进入', async ({ page, context }) => {
  const run = Date.now().toString(36)
  const base = `历史基线-${run}`
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  await sendMessage(page, base)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  const second = await context.newPage()
  await openApp(second)
  await threadListItem(second, base).click()
  await selectModel(second)

  // 另一窗口发送：本窗口历史不应记入这条消息。
  const fromFirst = `他窗消息-${run}`
  await sendMessage(page, fromFirst)
  await expect(userMessages(page).last()).toContainText(fromFirst)

  await messageInput(second).press('ArrowUp')
  await expect(messageInput(second)).toHaveValue('')
  await messageInput(second).press('ArrowUp')
  await expect(messageInput(second)).toHaveValue('')

  // 本窗口自己提交后才进入本窗口历史。
  const own = `本窗消息-${run}`
  await sendMessage(second, own)
  await expect(assistantMessages(second).last()).toContainText(DEFAULT_REPLY)
  await messageInput(second).press('ArrowUp')
  await expect(messageInput(second)).toHaveValue(own)
  await messageInput(second).press('ArrowUp')
  await expect(messageInput(second)).toHaveValue(own)
  await second.close()
})
