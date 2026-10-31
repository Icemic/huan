import { expect, test } from '@playwright/test'
import {
  assistantMessages,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  openApp,
  sendMessage,
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

test('模型选择器支持键盘搜索、独立 Thinking 与空白会话草稿', async ({ page }) => {
  await openApp(page)
  const composer = page.locator('[data-slot="aui_composer-shell"]')
  const trigger = composer.getByRole('combobox')
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
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Add Attachment', exact: true }).click()
  const upload = await chooser
  await upload.setFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  const preview = page.getByRole('button', { name: 'Preview pixel.png', exact: true })
  await expect(preview).toBeVisible()
  await preview.click()
  const dialog = page.getByRole('dialog', { name: 'Preview pixel.png', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(preview).toBeFocused()
  await page.getByRole('button', { name: 'Remove pixel.png', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('主题切换写入本地存储，刷新与跟随系统均可恢复', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openApp(page)
  const html = page.locator('html')
  const trigger = page.locator('[data-slot="theme-selector-trigger"]')

  await trigger.click()
  await page.getByRole('option', { name: 'One Dark' }).click()
  await expect(html).toHaveClass(/dark/)
  await expect(html).toHaveClass(/one-dark/)
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(40, 44, 52)',
  )
  expect(await page.evaluate(() => localStorage.getItem('huan.theme'))).toBe('one-dark')

  await page.reload()
  await expect(page.getByRole('region', { name: 'Pi host status' })).toBeVisible()
  await expect(html).toHaveClass(/one-dark/)
  await expect(trigger).toContainText('One Dark')

  await trigger.click()
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
      send: height('[aria-label="Send message"]'),
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

  await trigger.click()
  await page.getByRole('option', { name: '跟随系统' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).not.toHaveClass(/dark/)
  expect(await page.evaluate(() => localStorage.getItem('huan.theme'))).toBe('system')
})

test('Dialog 内 Popover 按 Escape 逐层关闭并恢复焦点', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `escape-${run}`)
  const name = `层级弹层-${run}`
  await createWorkspaceApi(request, name, [{ alias: 'layer', path: project.path }])

  await openApp(page)
  const group = workspaceGroup(page, name)
  const manage = group.getByRole('button', { name: '管理工作区', exact: true })
  await manage.click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(dialog).toBeVisible()

  const memberActions = dialog.getByRole('button', { name: '成员操作' })
  await memberActions.click()
  const popover = page.locator('[data-slot="popover-content"]')
  await expect(popover).toBeVisible()
  await expect(page.getByRole('button', { name: '移除成员' })).toBeVisible()

  // 第一次 Escape 只关闭内层 Popover，焦点回到触发按钮。
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(memberActions).toBeFocused()

  // 第二次 Escape 才关闭 Dialog，焦点回到“管理工作区”入口。
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(manage).toBeFocused()
})
