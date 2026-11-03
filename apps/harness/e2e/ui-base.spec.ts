import { expect, type FileChooser, type Page, test } from '@playwright/test'
import {
  assistantMessages,
  DEFAULT_REPLY,
  messageInput,
  openApp,
  openSettings,
  selectModel,
  sendButton,
  sendMessage,
  settingsDialog,
  settingsTrigger,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)

const addContentButton = (page: Page) =>
  page.locator('[data-slot="huan-composer"]').getByRole('button', { name: '添加内容', exact: true })

/** 打开输入区唯一的+菜单并确认仅有“添加图片”。 */
async function openAddImageMenu(page: Page) {
  await addContentButton(page).click()
  const menu = page.getByRole('menu', { name: '添加内容' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '添加图片', exact: true })).toBeVisible()
  return menu
}

/** 经+菜单触发原 file input，返回真实 filechooser 供测试选择/取消。 */
async function openImageChooser(page: Page): Promise<FileChooser> {
  const menu = await openAddImageMenu(page)
  const chooser = page.waitForEvent('filechooser')
  await menu.getByRole('menuitem', { name: '添加图片', exact: true }).click()
  return chooser
}

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

test('模型选择器支持键盘搜索、独立 Thinking 与空白会话草稿', async ({ page }) => {
  await openApp(page)
  const composer = page.locator('[data-slot="huan-composer"]')
  const trigger = composer.getByRole('combobox')
  const thinkingTrigger = composer.getByRole('button', { name: '选择思考强度' })
  const search = page.getByRole('combobox', { name: '搜索模型' })

  // 尚未选择支持思考的模型时没有思考入口；默认未选模型即隐藏。
  await expect(thinkingTrigger).toHaveCount(0)

  // 键盘打开搜索，输入过滤后可直接回车选中。
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(search).toBeFocused()
  await search.pressSequentially('Model B')
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option', { name: /Test Model B/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(trigger).toContainText('Test Model B')
  await expect(trigger).toBeFocused()

  // 选择后才出现思考入口；官方 Combobox 追加的箭头实际不可见。
  await expect(thinkingTrigger).toBeVisible()
  const modelArrow = trigger.locator('svg')
  await expect(modelArrow).toHaveCount(1)
  await expect(modelArrow).toBeHidden()

  // 模型与思考强度共享同一个 ButtonGroup，两个按钮边界贴合；移开焦点后检查常态边框。
  await messageInput(page).focus()
  await expect(trigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  const groupGeometry = await composer.evaluate((element) => {
    const model = element.querySelector('[data-slot="model-selector-trigger"]')
    const thinking = element.querySelector('[data-slot="thinking-selector-trigger"]')
    const group = model?.parentElement
    if (!model || !thinking || !group) throw new Error('缺少模型按钮组元素')
    const modelRect = model.getBoundingClientRect()
    const thinkingRect = thinking.getBoundingClientRect()
    return {
      slot: group.getAttribute('data-slot'),
      thinkingInGroup: thinking.parentElement === group,
      gap: Math.round(thinkingRect.left - modelRect.right),
      borderLeftWidth: getComputedStyle(thinking).borderLeftWidth,
      modelBorderColor: getComputedStyle(model).borderTopColor,
      thinkingBorderColor: getComputedStyle(thinking).borderTopColor,
    }
  })
  expect(groupGeometry.slot).toBe('button-group')
  expect(groupGeometry.thinkingInGroup).toBe(true)
  expect(groupGeometry.gap).toBe(0)
  expect(groupGeometry.borderLeftWidth).toBe('0px')
  expect(groupGeometry.modelBorderColor).toBe('rgba(0, 0, 0, 0)')
  expect(groupGeometry.thinkingBorderColor).toBe('rgba(0, 0, 0, 0)')

  // 模型菜单不再内嵌 Thinking；思考强度是独立按钮与菜单。
  await trigger.click()
  const modelContent = page.locator('[data-slot="model-selector-content"]')
  await expect(modelContent).toBeVisible()
  await expect(modelContent.getByRole('menuitemradio')).toHaveCount(0)
  await expect(modelContent.getByRole('radio')).toHaveCount(0)
  await expect(page.locator('[data-slot="model-selector-effort"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await messageInput(page).fill('/thinking')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  const thinkingContent = page.locator('[data-slot="thinking-selector-content"]')
  await expect(thinkingContent).toBeVisible()
  await expect(page.locator('[data-slot="model-selector-content"]')).toHaveCount(0)
  await thinkingContent.getByRole('menuitemradio', { name: 'high', exact: true }).click()
  await expect(thinkingTrigger).toContainText('high')
  // 成功修改 Thinking 不写冗余提示。
  await expect(composer.locator('[data-slot="huan-model-selector"] [role="status"]')).toHaveCount(0)

  // 空白会话的模型与 Thinking 先写入草稿，首条消息创建后应保留。
  await sendMessage(page, '键盘选择模型与 Thinking')
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(trigger).toContainText('Test Model B')
  await thinkingTrigger.click()
  await expect(
    thinkingContent.getByRole('menuitemradio', { name: 'high', exact: true }),
  ).toBeChecked()
  // 已有会话切换思考级别不显示额外的 busy 省略号，也不写成功提示。
  await thinkingContent.getByRole('menuitemradio', { name: 'low', exact: true }).click()
  await expect(composer.locator('[data-slot="huan-model-selector"]')).not.toContainText('…')
  await expect(thinkingTrigger).toContainText('low')
  await expect(thinkingContent).toHaveCount(0)
  await expect(composer.locator('[data-slot="huan-model-selector"] [role="status"]')).toHaveCount(0)
  await messageInput(page).fill('/thinking low')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(thinkingTrigger).toContainText('low')
  await expect(composer.locator('[data-slot="huan-composer-notice"]')).toHaveCount(0)
})

test('图片附件预览关闭后恢复焦点，移除不触发预览', async ({ page }) => {
  await openApp(page)
  const upload = await openImageChooser(page)
  await upload.setFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: PIXEL_PNG,
  })
  const preview = page.getByRole('button', { name: '预览附件 pixel.png', exact: true })
  await expect(preview).toBeVisible()
  await preview.click()
  const dialog = page.getByRole('dialog', { name: '附件预览', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(preview).toBeFocused()
  await page.getByRole('button', { name: '移除附件 pixel.png', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('输入区只有单一+菜单：添加图片、Escape 回焦、取消与重复选择不改草稿', async ({ page }) => {
  await openApp(page)
  const composer = page.locator('[data-slot="huan-composer"]')
  const input = messageInput(page)
  const addContent = addContentButton(page)
  const modelTrigger = composer.getByRole('combobox')
  const sessionActions = composer.getByRole('button', { name: '会话操作', exact: true })
  const send = sendButton(page)
  await expect(addContent).toHaveCount(1)

  // 空输入时输入组不因发送禁用而降低透明度，左侧入口仍可用。
  const inputGroup = composer.locator('[data-slot="input-group"]')
  const emptyOpacity = await inputGroup.evaluate((element) => getComputedStyle(element).opacity)
  expect(emptyOpacity).toBe('1')
  await expect(addContent).toBeEnabled()
  await expect(modelTrigger).toBeVisible()
  await expect(modelTrigger).toBeEnabled()
  await expect(sessionActions).toBeVisible()
  await expect(sessionActions).toBeEnabled()
  await expect(send).toBeDisabled()
  // 会话操作只保留图标：没有可见文案，名称仍由 aria-label 提供。
  expect(await sessionActions.evaluate((element) => (element as HTMLElement).innerText)).toBe('')
  await expect(sessionActions).toHaveAttribute('aria-label', '会话操作')

  // 空输入也能打开+菜单，Escape 关闭后焦点回到入口。
  const emptyMenu = await openAddImageMenu(page)
  await page.keyboard.press('Escape')
  await expect(emptyMenu).toHaveCount(0)
  await expect(addContent).toBeFocused()

  // 复用原图片 file input：图片类型、多选，且不进入 Tab 序列。
  const fileInput = composer.locator('input[type="file"]')
  await expect(fileInput).toHaveCount(1)
  await expect(fileInput).toHaveAttribute('accept', 'image/*')
  await expect(fileInput).toHaveAttribute('multiple', '')

  // 旧命令面板与 @ 按钮已删除；@ 文件引用仍由输入框补全提供。
  await expect(composer.getByRole('button', { name: '打开命令面板' })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: /引用文件/ })).toHaveCount(0)

  const draft = '  保留文字草稿\n第二行  '
  const emptyBackground = await inputGroup.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  await input.fill(draft)
  const filledBackground = await inputGroup.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  const filledOpacity = await inputGroup.evaluate((element) => getComputedStyle(element).opacity)
  // 输入有无内容时背景与透明度一致，不因发送按钮禁用态切换。
  expect(filledBackground).toBe(emptyBackground)
  expect(filledOpacity).toBe('1')
  await expect(send).toBeEnabled()
  const menu = await openAddImageMenu(page)
  await expect(menu.getByRole('menuitem')).toHaveCount(1)
  await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(addContent).toBeFocused()
  await expect(input).toHaveValue(draft)

  // 空文件选择不产生附件，文字草稿保持不变。
  const cancelled = await openImageChooser(page)
  await cancelled.setFiles([])
  const attachments = page.locator('[data-slot="huan-composer-attachment"]')
  await expect(attachments).toHaveCount(0)
  await expect(input).toHaveValue(draft)

  // 同一张图片可以再次选择：选择后 input 清空，重复文件仍会触发 change。
  const first = await openImageChooser(page)
  await first.setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL_PNG })
  await expect(attachments).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(draft)

  const second = await openImageChooser(page)
  await second.setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL_PNG })
  await expect(attachments).toHaveCount(2)
})

test('主题切换写入本地存储，刷新与跟随系统均可恢复', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openApp(page)
  const html = page.locator('html')
  const themeTrigger = () => settingsDialog(page).locator('[data-slot="theme-selector-trigger"]')

  await openSettings(page, '外观')
  await themeTrigger().click()
  await page.getByRole('option', { name: 'One Dark' }).click()
  await expect(html).toHaveClass(/dark/)
  await expect(html).toHaveClass(/one-dark/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(40, 44, 52)',
  )
  expect(await page.evaluate(() => localStorage.getItem('huan.theme'))).toBe('one-dark')

  await page.reload()
  await expect(page.locator('[data-slot="huan-header"]')).toBeVisible()
  await expect(html).toHaveClass(/one-dark/)
  // 刷新后仍是未选模型的新会话：先选有思考能力的模型，才能检查思考按钮尺寸。
  await selectModel(page, 'Test Model A')
  await openSettings(page, '外观')
  await expect(themeTrigger()).toContainText('One Dark')

  await themeTrigger().click()
  await page.getByRole('option', { name: 'Solarized Light' }).click()
  await expect(html).toHaveClass(/solarized-light/)
  await expect(html).not.toHaveClass(/dark/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    'rgb(40, 44, 52)',
  )

  // 紧凑尺度与字体：工具行按钮统一 28px、0.25rem 圆角基准。
  const compact = await page.evaluate(() => {
    const geometry = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`缺少布局元素：${selector}`)
      const rect = element.getBoundingClientRect()
      return { x: rect.x, width: rect.width, height: Math.round(rect.height) }
    }
    return {
      theme: geometry('[data-slot="theme-selector-trigger"]'),
      add: geometry('[data-slot="huan-composer"] [aria-label="添加内容"]'),
      model: geometry('[data-slot="model-selector-trigger"]'),
      thinking: geometry('[data-slot="thinking-selector-trigger"]'),
      session: geometry('[data-slot="huan-composer"] [aria-label="会话操作"]'),
      send: geometry('[aria-label="发送消息"]'),
      radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
      font: getComputedStyle(document.body).fontFamily,
    }
  })
  for (const key of ['theme', 'add', 'model', 'thinking', 'session', 'send'] as const) {
    expect(compact[key].height, key).toBe(28)
  }
  expect(compact.add.x).toBeLessThan(compact.model.x)
  expect(compact.model.x).toBeLessThan(compact.thinking.x)
  expect(compact.thinking.x).toBeLessThan(compact.session.x)
  expect(compact.model.x + compact.model.width).toBeLessThanOrEqual(compact.send.x)
  expect(compact.thinking.x + compact.thinking.width).toBeLessThanOrEqual(compact.send.x)
  expect(compact.radius).toBe('0.25rem')
  expect(compact.font).toContain('Geist Variable')

  await themeTrigger().click()
  await page.getByRole('option', { name: '跟随系统' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).not.toHaveClass(/dark/)
  expect(await page.evaluate(() => localStorage.getItem('huan.theme'))).toBe('system')
})

test('Dialog 内弹层按 Escape 逐层关闭并恢复焦点', async ({ page }) => {
  await openApp(page)
  const opener = settingsTrigger(page)
  await openSettings(page, '对话')
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()

  // Dialog 内的 Select 是独立弹层：第一次 Escape 只关闭它并回到触发按钮。
  const trigger = dialog.getByRole('combobox', { name: '转向队列' })
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(listbox).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(trigger).toBeFocused()

  // 第二次 Escape 才关闭 Dialog，焦点回到顶栏入口。
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})
