/** 语法高亮经隔离 SDK 会话验证颜色、流式、回退与原文复制。 */
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  configureStream,
  finishStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  streamState,
} from './helpers.js'

const tokens = '[style*="--shiki-light"]'

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

test('Markdown 高亮随流式追加和主题切换，复制与回退保留内容', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  await configureStream(request, [
    '代码示例：\n\n```ts\nconst alpha = 1\n',
    '\nconst beta = "two"\n```',
  ])
  await sendMessage(page, '展示流式高亮')
  await expect.poll(async () => (await streamState(request)).active).toBe(true)
  await releaseSegment(request)
  const message = assistantMessages(page).last()
  const code = message.locator('[data-slot="code-block-content"]')
  await expect(code.locator(tokens).first()).toBeVisible()
  await expect(code).toHaveText('const alpha = 1')
  await releaseSegment(request)
  await finishStream(request)
  await expect(code.locator('[data-slot="code-block-line"]')).toHaveCount(3)
  await expect(code).toContainText('const beta = "two"')
  const keyword = code
    .locator(tokens)
    .filter({ hasText: /^const$/ })
    .first()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('tab', { name: '外观', exact: true }).click()
  const theme = settings.locator('[data-slot="theme-selector-trigger"]')
  await theme.click()
  await page.getByRole('option', { name: '浅色', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(settings).toHaveCount(0)
  const light = await keyword.evaluate((element) => getComputedStyle(element).color)
  await page.screenshot({ path: test.info().outputPath('syntax-light.png'), fullPage: true })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await theme.click()
  await page.getByRole('option', { name: '深色', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect
    .poll(() => keyword.evaluate((element) => getComputedStyle(element).color))
    .not.toBe(light)
  await page.screenshot({ path: test.info().outputPath('syntax-dark.png'), fullPage: true })
  await message.hover()
  await message.locator('[data-slot="code-block-copy-button"]').click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
    )
    .toBe('const alpha = 1\n\nconst beta = "two"')

  // 下一条响应同时覆盖语言切换、未知语法和超过高亮上限的完整回退。
  const large = 'x'.repeat(100_001)
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: {
      turns: [
        {
          text: `\`\`\`py\nprint("next")\n\`\`\`\n\n\`\`\`unknown\nplain <value>\n\`\`\`\n\n\`\`\`ts\n${large}\n\`\`\``,
        },
      ],
    },
  })
  expect(response.ok()).toBe(true)
  await sendMessage(page, '展示回退')
  const next = assistantMessages(page).last()
  const blocks = next.locator('[data-slot="code-block-content"]')
  await expect(blocks).toHaveCount(3)
  await expect(blocks.nth(0).locator(tokens).first()).toBeVisible()
  await expect(blocks.nth(0)).not.toContainText('alpha')
  await expect(blocks.nth(1)).toHaveText('plain <value>')
  await expect(blocks.nth(1).locator(tokens)).toHaveCount(0)
  await expect(blocks.nth(2)).toHaveText(large)
  await expect(blocks.nth(2).locator(tokens)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('同一代码组件替换文本及语言后不残留旧语法和空行', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/e2e/fixtures/code-highlighting.html')
  const code = page.locator('[data-slot="code-block-content"]')
  await expect(code.locator(tokens).first()).toBeVisible()
  await expect(code.locator('[data-slot="code-block-line"]')).toHaveCount(4)
  await page.getByRole('button', { name: '替换内容' }).click()
  await expect(code).toContainText('replaced')
  await expect(code).not.toContainText('old comment')
  await expect(code.locator('[data-slot="code-block-line"]')).toHaveCount(3)
  await expect(
    code
      .locator(tokens)
      .filter({ hasText: /^const$/ })
      .first(),
  ).toBeVisible()
  await page.getByRole('button', { name: '切换语言' }).click()
  await expect(code).toHaveText('print("changed")')
  await expect(code.locator('[data-slot="code-block-line"]')).toHaveCount(1)
  await expect(code.locator(tokens).first()).toBeVisible()
  expect(errors).toEqual([])
})
