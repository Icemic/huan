/**
 * 统一设置导航浏览器验收：唯一顶栏入口、七页垂直导航与键盘切换、
 * 全局设置跨页共享草稿、保存写盘与外观主题切换。
 *
 * 明暗截图写入本次运行的测试产物目录并作为测试附件，供人工核对界面密度与配色。
 */
import { type APIRequestContext, expect, type Page, type TestInfo, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  openApp,
  openSettings,
  settingsDialog,
  settingsTab,
  settingsTrigger,
  userMessages,
} from './helpers.js'

const SETTINGS_PAGES = [
  '外观',
  '模型与服务商',
  '对话',
  '工具与资源',
  'MCP',
  '高级',
  '服务与诊断',
] as const

async function readUserSettings(request: APIRequestContext): Promise<string | null> {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/settings-file`, {
    params: { scope: 'user' },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { content: string | null }).content
}

async function writeUserSettings(
  request: APIRequestContext,
  content: string | null,
): Promise<void> {
  const response = await request.put(`${E2E_HOST_URL}/__e2e__/settings-file`, {
    data: { scope: 'user', content },
  })
  expect(response.ok()).toBe(true)
}

/** 截图保存到本次运行的测试产物目录，并作为附件挂到测试结果。 */
async function captureSettings(
  page: Page,
  testInfo: TestInfo,
  name: 'unified-settings-light' | 'unified-settings-dark',
): Promise<void> {
  const target = testInfo.outputPath(`${name}.png`)
  await settingsDialog(page).screenshot({ path: target })
  await testInfo.attach(name, { path: target, contentType: 'image/png' })
}

test('顶栏唯一入口在无选中会话时打开全局设置，七页垂直导航支持方向键', async ({ page }) => {
  await openApp(page)
  // 空白新会话目标尚未创建会话，仍可独立访问全局设置。
  await expect(page.locator('[data-slot="huan-session-context"]')).toContainText('新会话')
  await expect(userMessages(page)).toHaveCount(0)
  await expect(
    page.locator('[data-slot="huan-header"] [data-slot="huan-settings-trigger"]'),
  ).toHaveCount(1)
  await expect(page.locator('[data-slot="huan-settings-trigger"]')).toHaveCount(1)

  await settingsTrigger(page).click()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tablist', { name: '设置分类' })).toHaveAttribute(
    'aria-orientation',
    'vertical',
  )
  const tabs = dialog.locator('[data-slot="huan-settings-nav"] [role="tab"]')
  await expect(tabs).toHaveCount(SETTINGS_PAGES.length)
  for (const name of SETTINGS_PAGES) await expect(settingsTab(page, name)).toBeVisible()

  // 垂直页签：方向键移动焦点，Enter 激活当前焦点页。
  await settingsTab(page, '外观').focus()
  await page.keyboard.press('ArrowDown')
  await expect(settingsTab(page, '模型与服务商')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(settingsTab(page, '模型与服务商')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(settingsTab(page, '对话')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(settingsTab(page, '对话')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(settingsTab(page, '模型与服务商')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('全局设置跨页共享草稿、保存写盘，外观明暗可截图', async ({ page, request }, testInfo) => {
  const original = await readUserSettings(request)
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    await openApp(page)
    await openSettings(page, '高级')
    const dialog = settingsDialog(page)
    const editor = dialog.getByRole('textbox', { name: '设置 JSON' })
    await expect(editor).toHaveValue(/"defaultProvider"/)

    // 高级页写入的草稿切到其他全局页后仍保留。
    const current = JSON.parse(await editor.inputValue()) as Record<string, unknown>
    await editor.fill(`${JSON.stringify({ ...current, e2eUnifiedSettings: true }, null, 2)}\n`)
    await settingsTab(page, '模型与服务商').click()
    await expect(dialog.locator('[data-slot="huan-settings-unsaved"]:visible')).toBeVisible()
    await settingsTab(page, '高级').click()
    await expect(editor).toHaveValue(/"e2eUnifiedSettings": true/)

    const actions = dialog.locator('[data-slot="huan-settings-actions"]:visible')
    await actions.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.locator('[data-slot="huan-settings-notice"]:visible')).toContainText(
      '已保存',
    )
    expect(await readUserSettings(request)).toContain('"e2eUnifiedSettings": true')

    // 外观页切换主题并留下明暗截图附件。
    await settingsTab(page, '外观').click()
    const html = page.locator('html')
    const themeTrigger = dialog.locator('[data-slot="theme-selector-trigger"]')
    await themeTrigger.click()
    await page.getByRole('option', { name: '浅色' }).click()
    await expect(themeTrigger).toContainText('浅色')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(html).not.toHaveClass(/dark/)
    await captureSettings(page, testInfo, 'unified-settings-light')

    await themeTrigger.click()
    await page.getByRole('option', { name: '深色' }).click()
    await expect(themeTrigger).toContainText('深色')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(html).toHaveClass(/dark/)
    expect(await page.evaluate(() => localStorage.getItem('huan.theme'))).toBe('dark')
    await captureSettings(page, testInfo, 'unified-settings-dark')

    // 审阅材料覆盖字段、多选、列表与配置表单；同时核对内容区独立滚动。
    for (const theme of ['light', 'dark'] as const) {
      await settingsTab(page, '外观').click()
      await themeTrigger.click()
      await page.getByRole('option', { name: theme === 'light' ? '浅色' : '深色' }).click()
      for (const section of ['模型与服务商', '对话', 'MCP']) {
        await settingsTab(page, section).click()
        await expect(dialog.getByRole('heading', { name: section, exact: true })).toBeVisible()
        if (section === 'MCP') {
          await expect(dialog.getByRole('tab', { name: 'MCP 常用编辑' })).toBeVisible()
        } else {
          await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeVisible()
        }
        const path = testInfo.outputPath(`${section}-${theme}.png`)
        await dialog.screenshot({ path })
        await testInfo.attach(`${section}-${theme}`, { path, contentType: 'image/png' })
        const bounds = await dialog.evaluate((element) => ({
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
        }))
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width)
        expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.height)
      }
    }
  } finally {
    await writeUserSettings(request, original)
  }
})
