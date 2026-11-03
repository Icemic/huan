/**
 * ScrollArea 定向浏览器验收。
 *
 * 第一部分使用真实全局设置“对话”页：在确定溢出的正文视口上验证滚轮、
 * PageDown 与轨道拖动只改变 scrollTop，页头/页脚与弹层 Root 不移动、不外溢。
 * 第二部分通过测试专用夹具复用真实官方 Select/DropdownMenu/Combobox/ScrollArea
 * 组合，覆盖键盘末项导航、max-h 高度约束与横向滚动；夹具不注册生产入口。
 */
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test'
import { openApp, openSettings, settingsDialog, settingsTab } from './helpers.js'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Metrics {
  scrollTop: number
  scrollLeft: number
  clientWidth: number
  clientHeight: number
  scrollWidth: number
  scrollHeight: number
  scrollbarWidth: string
}

async function metricsOf(locator: Locator): Promise<Metrics> {
  return locator.evaluate((element) => {
    const node = element as HTMLElement
    return {
      scrollTop: node.scrollTop,
      scrollLeft: node.scrollLeft,
      clientWidth: node.clientWidth,
      clientHeight: node.clientHeight,
      scrollWidth: node.scrollWidth,
      scrollHeight: node.scrollHeight,
      scrollbarWidth: getComputedStyle(node).getPropertyValue('scrollbar-width'),
    }
  })
}

async function boxOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('元素没有可测量的布局框')
  return box
}

function expectInside(inner: Rect, outer: Rect): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1)
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 1)
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1)
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 1)
}

function expectSameBox(before: Rect, after: Rect): void {
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.5)
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.5)
  expect(Math.abs(after.width - before.width)).toBeLessThan(0.5)
  expect(Math.abs(after.height - before.height)).toBeLessThan(0.5)
}

async function resetScroll(viewport: Locator): Promise<void> {
  await viewport.evaluate((element) => {
    element.scrollTop = 0
    element.scrollLeft = 0
  })
  await expect.poll(async () => (await metricsOf(viewport)).scrollTop).toBe(0)
}

async function chooseTheme(page: Page, name: '浅色' | '深色'): Promise<void> {
  await settingsTab(page, '外观').click()
  const trigger = settingsDialog(page).locator('[data-slot="theme-selector-trigger"]')
  await trigger.click()
  await page.getByRole('option', { name, exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

async function attachScreenshot(testInfo: TestInfo, name: string, dialog: Locator): Promise<void> {
  await testInfo.attach(name, {
    body: await dialog.screenshot(),
    contentType: 'image/png',
  })
}

test('设置对话页：溢出视口支持滚轮、PageDown 与 thumb 拖动且页头页脚稳定', async ({
  page,
}, testInfo) => {
  // 固定较矮视口，让真实设置内容确定超出面板正文可用高度。
  await page.setViewportSize({ width: 1280, height: 560 })
  await openApp(page)
  await openSettings(page, '对话')
  await chooseTheme(page, '浅色')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await settingsTab(page, '对话').click()

  const dialog = settingsDialog(page)
  const panel = dialog.locator('[data-slot="tabs-content"]:visible')
  await expect(panel.locator('[data-slot="huan-global-settings-conversation"]')).toBeVisible()
  const viewport = panel.locator('[data-slot="scroll-area-viewport"]')
  const root = panel.locator('[data-slot="scroll-area"]').first()
  await expect(viewport).toHaveCount(1)

  // 实际内容必须产生溢出；原生滚动条由组件样式隐藏。
  await expect
    .poll(async () => {
      const metrics = await metricsOf(viewport)
      return metrics.scrollHeight - metrics.clientHeight
    })
    .toBeGreaterThan(0)
  await expect.poll(async () => (await metricsOf(viewport)).scrollbarWidth).toBe('none')
  const initial = await metricsOf(viewport)
  expect(initial.scrollWidth).toBeLessThanOrEqual(initial.clientWidth + 1)

  const rootMetrics = await root.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  }))
  expect(rootMetrics.scrollWidth).toBeLessThanOrEqual(rootMetrics.clientWidth + 1)
  expect(rootMetrics.scrollHeight).toBeLessThanOrEqual(rootMetrics.clientHeight + 1)
  const dialogMetrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  }))
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.clientWidth + 1)
  expect(dialogMetrics.scrollHeight).toBeLessThanOrEqual(dialogMetrics.clientHeight + 1)

  const header = panel.locator('header')
  const footer = panel.locator('[data-slot="huan-settings-actions"]').locator('..')
  const dialogBox = await boxOf(dialog)
  const headerBox = await boxOf(header)
  const footerBox = await boxOf(footer)
  const expectLayoutStable = async () => {
    expectSameBox(dialogBox, await boxOf(dialog))
    expectSameBox(headerBox, await boxOf(header))
    expectSameBox(footerBox, await boxOf(footer))
  }

  // 滚轮只移动正文视口。
  await viewport.hover()
  await page.mouse.wheel(0, 90)
  await expect.poll(async () => (await metricsOf(viewport)).scrollTop).toBeGreaterThan(0)
  await expectLayoutStable()

  // PageDown 在视口获得焦点后继续滚动。
  await resetScroll(viewport)
  await viewport.focus()
  await expect(viewport).toBeFocused()
  // 等待浏览器的平滑键盘滚动结束，再开始下一次独立拖动检查。
  await Promise.all([
    viewport.evaluate(
      (element) =>
        new Promise<void>((resolve) =>
          element.addEventListener('scrollend', () => resolve(), { once: true }),
        ),
    ),
    page.keyboard.press('PageDown'),
  ])
  await expect.poll(async () => (await metricsOf(viewport)).scrollTop).toBeGreaterThan(0)
  await expectLayoutStable()

  // 竖直 thumb 拖动同样实际改变 scrollTop。
  await resetScroll(viewport)
  const scrollbar = root.locator('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]')
  await expect(scrollbar).toBeVisible()
  const thumb = scrollbar.locator('[data-slot="scroll-area-thumb"]')
  const trackBox = await boxOf(scrollbar)
  await expect
    .poll(async () => (await boxOf(thumb)).y)
    .toBeLessThan(trackBox.y + trackBox.height / 2)
  const thumbBox = await boxOf(thumb)
  const startX = thumbBox.x + thumbBox.width / 2
  const startY = thumbBox.y + thumbBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + 30, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await metricsOf(viewport)).scrollTop).toBeGreaterThan(0)
  await expectLayoutStable()

  await resetScroll(viewport)
  await attachScreenshot(testInfo, 'settings-conversation-scroll-light', dialog)

  // 深色主题下同样保持真实溢出与原生滚动条隐藏；截图仅作附件，不宣称视觉审阅通过。
  await chooseTheme(page, '深色')
  await settingsTab(page, '对话').click()
  await expect(panel.locator('[data-slot="huan-global-settings-conversation"]')).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect
    .poll(async () => {
      const metrics = await metricsOf(viewport)
      return metrics.scrollHeight - metrics.clientHeight
    })
    .toBeGreaterThan(0)
  await expect.poll(async () => (await metricsOf(viewport)).scrollbarWidth).toBe('none')
  await resetScroll(viewport)
  await attachScreenshot(testInfo, 'settings-conversation-scroll-dark', dialog)
})

async function openScrollFixture(page: Page): Promise<void> {
  await page.goto('/e2e/fixtures/scroll-area.html')
  await expect(page.getByTestId('scroll-fixture')).toBeVisible()
}

test('长列表：Select End 高亮末项并可见、Enter 选中，Menu End 选中', async ({ page }) => {
  await openScrollFixture(page)

  const selectTrigger = page.getByTestId('select-trigger')
  await selectTrigger.click()
  const selectItems = page.locator('[data-slot="select-item"]')
  await expect(selectItems).toHaveCount(40)
  const selectList = page.locator('[data-slot="select-content"] [data-slot="scroll-area-viewport"]')
  await expect(selectList).toBeVisible()

  const lastSelect = selectItems.last()
  const lastSelectText = (await lastSelect.innerText()).trim()
  await page.keyboard.press('End')
  await expect(lastSelect).toHaveAttribute('data-highlighted', '')
  await expect.poll(async () => (await metricsOf(selectList)).scrollTop).toBeGreaterThan(0)
  expectInside(await boxOf(lastSelect), await boxOf(selectList))

  await page.keyboard.press('Enter')
  // Select在触发器聚焦时预挂载条目供关闭态typeahead使用，验证关闭语义与回焦。
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(selectTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(selectTrigger).toBeFocused()
  await expect(selectTrigger).toContainText(lastSelectText)

  await page.getByTestId('menu-trigger').click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const menuItems = page.locator('[data-slot="dropdown-menu-item"]')
  await expect(menuItems).toHaveCount(40)
  const menuViewport = page.locator(
    '[data-slot="dropdown-menu-content"] [data-slot="scroll-area-viewport"]',
  )
  const lastMenu = menuItems.last()
  const lastMenuText = (await lastMenu.innerText()).trim()

  await page.keyboard.press('End')
  await expect(lastMenu).toHaveAttribute('data-highlighted', '')
  await expect.poll(async () => (await metricsOf(menuViewport)).scrollTop).toBeGreaterThan(0)
  expectInside(await boxOf(lastMenu), await boxOf(menuViewport))

  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('menu-value')).toHaveText(lastMenuText)
})

test('长列表：Combobox 搜索结果用箭头走到末项并保持可见', async ({ page }) => {
  await openScrollFixture(page)

  await page.getByTestId('combobox-trigger').click()
  const search = page.getByTestId('combobox-search')
  await expect(search).toBeVisible()
  await search.fill('模型')

  const items = page.locator('[data-slot="combobox-item"]')
  await expect(items).toHaveCount(30)
  const first = items.first()
  await expect(first).toHaveAttribute('data-highlighted', '')

  // 从自动高亮的第一项逐项下移到末项，验证可见区域内跟随滚动。
  for (let index = 1; index < 30; index += 1) {
    await page.keyboard.press('ArrowDown')
  }
  const last = items.last()
  await expect(last).toHaveAttribute('data-highlighted', '')
  const scroll = page.locator('[data-slot="combobox-content"] [data-slot="scroll-area-viewport"]')
  await expect.poll(async () => (await metricsOf(scroll)).scrollTop).toBeGreaterThan(0)
  expectInside(await boxOf(last), await boxOf(scroll))
})

test('ScrollArea：max-h 短内容不强撑、长内容限高，横向滚动与 thumb 拖动有效', async ({ page }) => {
  await openScrollFixture(page)

  const shortRoot = page.getByTestId('maxheight-short')
  const shortBox = await boxOf(shortRoot)
  expect(shortBox.height).toBeLessThan(160)
  const shortViewport = shortRoot.locator('[data-slot="scroll-area-viewport"]')
  const shortMetrics = await metricsOf(shortViewport)
  expect(shortMetrics.scrollHeight).toBeLessThanOrEqual(shortMetrics.clientHeight + 1)
  await expect(shortRoot.locator('[data-slot="scroll-area-scrollbar"]')).toHaveCount(0)

  const longRoot = page.getByTestId('maxheight-long')
  const longViewport = longRoot.locator('[data-slot="scroll-area-viewport"]')
  const longMetrics = await metricsOf(longViewport)
  expect(longMetrics.clientHeight).toBeGreaterThanOrEqual(159)
  expect(longMetrics.clientHeight).toBeLessThanOrEqual(161)
  expect(longMetrics.scrollHeight).toBeGreaterThan(longMetrics.clientHeight)
  await expect(
    longRoot.locator('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]'),
  ).toBeVisible()

  const horizontalRoot = page.getByTestId('horizontal-scroll')
  const horizontalViewport = horizontalRoot.locator('[data-slot="scroll-area-viewport"]')
  const horizontal = await metricsOf(horizontalViewport)
  expect(horizontal.scrollWidth).toBeGreaterThan(horizontal.clientWidth)
  const horizontalBar = horizontalRoot.locator(
    '[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]',
  )
  await expect(horizontalBar).toBeVisible()

  // 横向滚轮。
  await horizontalViewport.hover()
  await page.mouse.wheel(180, 0)
  await expect.poll(async () => (await metricsOf(horizontalViewport)).scrollLeft).toBeGreaterThan(0)

  // 横向 thumb 拖动。
  await horizontalViewport.evaluate((element) => {
    element.scrollLeft = 0
  })
  await expect.poll(async () => (await metricsOf(horizontalViewport)).scrollLeft).toBe(0)
  const thumb = horizontalBar.locator('[data-slot="scroll-area-thumb"]')
  const trackBox = await boxOf(horizontalBar)
  await expect
    .poll(async () => (await boxOf(thumb)).x)
    .toBeLessThan(trackBox.x + trackBox.width / 2)
  const thumbBox = await boxOf(thumb)
  const startX = thumbBox.x + thumbBox.width / 2
  const startY = thumbBox.y + thumbBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 80, startY, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await metricsOf(horizontalViewport)).scrollLeft).toBeGreaterThan(0)
})
