import { expect, type FileChooser, type Page, test } from '@playwright/test'
import {
  assistantMessages,
  DEFAULT_REPLY,
  messageInput,
  openApp,
  openSettings,
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
  const trigger = page.locator('[data-slot="huan-composer"]').getByRole('combobox')
  const search = page.getByRole('combobox', { name: '搜索模型' })

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

  // Thinking 是 listbox 之外的独立 radiogroup，可由 Tab 进入并用方向键选择。
  await page.keyboard.press('Enter')
  await expect(search).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('radio', { name: 'off', exact: true })).toBeFocused()
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: 'high', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()

  // 空白会话的模型与 Thinking 先写入草稿，首条消息创建后应保留。
  await sendMessage(page, '键盘选择模型与 Thinking')
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await trigger.click()
  await expect(page.getByRole('radio', { name: 'high', exact: true })).toBeChecked()
  await expect(trigger).toContainText('Test Model B')
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
  await expect(addContent).toHaveCount(1)

  // 复用原图片 file input：图片类型、多选，且不进入 Tab 序列。
  const fileInput = composer.locator('input[type="file"]')
  await expect(fileInput).toHaveCount(1)
  await expect(fileInput).toHaveAttribute('accept', 'image/*')
  await expect(fileInput).toHaveAttribute('multiple', '')

  // 旧命令面板与 @ 按钮已删除；@ 文件引用仍由输入框补全提供。
  await expect(composer.getByRole('button', { name: '打开命令面板' })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: /引用文件/ })).toHaveCount(0)

  const draft = '  保留文字草稿\n第二行  '
  await input.fill(draft)
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
  await openSettings(page, '外观')
  await expect(themeTrigger()).toContainText('One Dark')

  await themeTrigger().click()
  await page.getByRole('option', { name: 'Solarized Light' }).click()
  await expect(html).toHaveClass(/solarized-light/)
  await expect(html).not.toHaveClass(/dark/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    'rgb(40, 44, 52)',
  )

  // 紧凑尺度与字体：28px 小按钮、32px 默认按钮、0.25rem 圆角基准。
  const compact = await page.evaluate(() => {
    const height = (selector: string) => {
      const element = document.querySelector(selector)
      return element ? Math.round(element.getBoundingClientRect().height) : null
    }
    return {
      theme: height('[data-slot="theme-selector-trigger"]'),
      send: height('[aria-label="发送消息"]'),
      model: height('[data-slot="model-selector-trigger"]'),
      radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
      font: getComputedStyle(document.body).fontFamily,
    }
  })
  expect(compact.theme).toBe(28)
  expect(compact.send).toBe(28)
  expect(compact.model).toBe(32)
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
