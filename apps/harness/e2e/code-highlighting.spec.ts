/** 语法高亮经隔离 SDK 会话验证颜色、流式、回退与原文复制。 */
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  configureStream,
  finishStream,
  messageInput,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  streamState,
} from './helpers.js'

test('ANSI八色空白背景经bash工具与用户Shell完整保留', async ({ page, request }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  const command = "printf '\\033[41m   \\033[42m   \\033[43m   \\033[44m   \\033[45m   \\033[46m   \\033[47m   \\033[100m   \\033[m\\nplain\\n'"
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: {turns:[{tool:{name:'bash',args:{command}}},{text:'色块完成'}]},
  })
  expect(response.ok()).toBe(true)
  await sendMessage(page, '验证ANSI空白色块')
  await expect(assistantMessages(page).last()).toContainText('色块完成')
  await page.getByRole('button', {name:`执行 ${command}`,exact:true}).click()
  const toolOutput = page.locator('[data-slot="huan-output-block"]').last()
  await expect(toolOutput.locator('.huan-syntax-token')).toHaveCount(9)
  await messageInput(page).fill(`!!${command}`)
  await messageInput(page).press('Enter')
  const card = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(card).toContainText('退出码 0')
  await card.getByRole('button').first().click()
  const userOutput = card.locator('[data-slot="huan-user-shell-output"]')
  await expect(userOutput.locator('.huan-syntax-token')).toHaveCount(9)
  for (const output of [toolOutput, userOutput]) {
    for (const theme of ['', 'dark', 'dark one-dark', 'solarized-light']) {
      await page.evaluate((name) => { document.documentElement.className = name }, theme)
      const colors = await output.locator('.huan-syntax-token').evaluateAll((nodes) => nodes.map((node) => ({text:node.textContent,bg:getComputedStyle(node).backgroundColor})))
      expect(colors.slice(0,8).map((item) => item.text)).toEqual(Array(8).fill('   '))
      expect(new Set(colors.slice(0,8).map((item) => item.bg)).size).toBe(8)
      expect(colors.slice(0,8).every((item) => item.bg !== 'rgba(0, 0, 0, 0)')).toBe(true)
      expect(colors[8]).toEqual({text:'plain',bg:'rgba(0, 0, 0, 0)'})
    }
    await output.hover()
    await output.getByRole('button', {name:'复制输出',exact:true}).click()
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g,'\n')).toBe(`${' '.repeat(24)}\nplain\n`)
  }
  await userOutput.scrollIntoViewIfNeeded()
  await page.screenshot({path:test.info().outputPath('ansi-palette.png'),fullPage:true})
})

const tokens = '[style*="--shiki-light"]'

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

test('Markdown 分段到达时立即高亮并追加后续内容', async ({ page, request }) => {
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
  const code = assistantMessages(page).last().locator('[data-slot="code-block-content"]')
  await expect(code.locator(tokens).first()).toBeVisible()
  await expect(code).toHaveText('const alpha = 1')
  await releaseSegment(request)
  await finishStream(request)
  await expect(code.locator('[data-slot="code-block-line"]')).toHaveCount(3)
  await expect(code).toContainText('const beta = "two"')
})

test('Markdown 四主题、长代码和复制保留完整内容', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  const initial = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns: [{ text: '代码示例：\n\n```ts\nconst alpha = 1\n\nconst beta = "two"\n```' }] },
  })
  expect(initial.ok()).toBe(true)
  await sendMessage(page, '展示四主题高亮')
  const message = assistantMessages(page).last()
  const code = message.locator('[data-slot="code-block-content"]')
  await expect(code.locator(tokens).first()).toBeVisible()
  await expect(code.locator('[data-slot="code-block-line"]')).toHaveCount(3)
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
  for (const label of ['One Dark', 'Solarized Light']) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await theme.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(settings).toHaveCount(0)
    const variable = label === 'One Dark' ? '--shiki-oneDark' : '--shiki-solarized'
    const colors = await keyword.evaluate((element, name) => {
      const probe = document.createElement('span')
      probe.style.color = getComputedStyle(element).getPropertyValue(name)
      element.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return { actual: getComputedStyle(element).color, expected }
    }, variable)
    expect(colors.actual).toBe(colors.expected)
    expect(colors.actual).not.toBe(light)
    await page.screenshot({ path: test.info().outputPath(`syntax-${label}.png`), fullPage: true })
  }
  await message.hover()
  await message.locator('[data-slot="code-block-copy-button"]').click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
    )
    .toBe('const alpha = 1\n\nconst beta = "two"')

  // 超过旧字符和行数限制仍高亮，未知语言保留完整原文。
  const large = `${'const row = 1\n'.repeat(8_001)}//${'x'.repeat(100_001)}`
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
  await expect(blocks).toHaveCount(3, { timeout: 20_000 })
  await expect(blocks.nth(0).locator(tokens).first()).toBeVisible()
  await expect(blocks.nth(0)).not.toContainText('alpha')
  await expect(blocks.nth(1)).toHaveText('plain <value>')
  await expect(blocks.nth(1).locator(tokens)).toHaveCount(0)
  await expect.poll(() => blocks.nth(2).locator('[data-slot="code-block-line"]').allTextContents().then((lines) => lines.join('\n'))).toBe(large)
  await expect(blocks.nth(2).locator(tokens).first()).toBeVisible()
  await expect(blocks.nth(2).locator('[data-slot="code-block-line"]')).toHaveCount(8_002)
  await expect(blocks.nth(2).locator('[data-slot="code-block-line"]').last()).toHaveText(`//${'x'.repeat(100_001)}`)
  expect(errors).toEqual([])
})

test('同一代码组件替换文本及语言后不残留旧语法和空行', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/e2e/fixtures/code-highlighting.html')
  const code = page.locator('[data-slot="code-block-content"]').first()
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
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  await expect(code).toHaveText('{"enabled": true, "count": 2}')
  await expect(code.locator(tokens).filter({ hasText: /^true$/ })).toBeVisible()
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: '括号', exact: true }).click()
  const bracketColors = await code.locator('.huan-syntax-token').evaluateAll((nodes) => nodes.filter((n) => ['{','}','[',']','(',')'].includes(n.textContent?.trim() ?? '')).map((n) => ({text:n.textContent?.trim(), color:getComputedStyle(n).color})))
  expect(new Set(bracketColors.map((n) => n.color)).size).toBeGreaterThan(1)
  expect(bracketColors.find((n) => n.text === '{')?.color).toBe(bracketColors.find((n) => n.text === '}')?.color)
  const patch = page.getByTestId('patch')
  const added = patch.locator('[data-variant="added"]')
  await expect(added).toHaveText('+const added = "after"')
  const keyword = added.locator('.huan-syntax-token').filter({hasText:/^const$/})
  const string = added.locator('.huan-syntax-token').filter({hasText:/after/})
  await expect(keyword).toBeVisible()
  expect(await keyword.evaluate((n) => getComputedStyle(n).color)).not.toBe(await string.evaluate((n) => getComputedStyle(n).color))
  await page.getByRole('button', {name:'ANSI', exact:true}).click()
  await expect(code).toHaveText('redstill redstyled')
  const red = code.locator('.huan-syntax-token').filter({hasText:/^red$/})
  const continued = code.locator('.huan-syntax-token').filter({hasText:/^still red$/})
  expect(await red.evaluate((n) => getComputedStyle(n).color)).toBe(await continued.evaluate((n) => getComputedStyle(n).color))
  const styled = code.locator('.huan-syntax-token').filter({hasText:/^styled$/})
  await expect(styled).toHaveCSS('background-color','rgb(12, 34, 56)')
  await expect(styled).toHaveCSS('font-weight','700')
  await expect(styled).toHaveCSS('text-decoration-line','underline')
  await page.screenshot({path:test.info().outputPath('transformers-ansi.png'),fullPage:true})
  expect(errors).toEqual([])
})
