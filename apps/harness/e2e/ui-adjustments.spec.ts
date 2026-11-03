/**
 * UI 调整首批浏览器验收：聊天滚动条、输入焦点、工具长串换行与 Tooltip 箭头。
 *
 * 滚动/工具用真实 Pi SDK 与隔离用户空间；Tooltip 用测试专属夹具复用真实
 * 组件，覆盖四向、碰撞翻转与明暗主题，不向生产入口增加展示页。
 */
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  chooseSessionAction,
  configureStream,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  finishStream,
  messageInput,
  openApp,
  openSessionActions,
  openSettings,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  sessionActionsTrigger,
  settingsDialog,
  startNewSession,
  streamState,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

/** 配置脚本化模型轮次（工具调用或文本）。 */
async function scriptTurns(request: APIRequestContext, turns: unknown[]): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns },
  })
  expect(response.ok()).toBe(true)
}

const scrollViewport = (page: Page) => page.locator('[data-slot="huan-chat-scroll"]')
const chatContent = (page: Page) => page.locator('[data-slot="huan-chat-content"]')
const scrollToBottom = (page: Page) => page.locator('[data-slot="huan-scroll-to-bottom"]')

async function scrollMetrics(page: Page) {
  return scrollViewport(page).evaluate((element) => {
    const viewport = element as HTMLElement
    return {
      top: viewport.scrollTop,
      max: viewport.scrollHeight - viewport.clientHeight,
      offsetWidth: viewport.offsetWidth,
      clientWidth: viewport.clientWidth,
    }
  })
}

async function bottomGap(page: Page): Promise<number> {
  const metrics = await scrollMetrics(page)
  return metrics.max - metrics.top
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('元素没有可测量的布局框')
  return box
}

/** 生成长历史：短内容对照后发送足够多的行，确保消息区溢出。 */
async function seedLongHistory(page: Page): Promise<void> {
  const run = Date.now().toString(36)
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  await sendMessage(page, `短内容-${run}`)
  await expect(assistantMessages(page)).toHaveCount(1)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const lines = Array.from({ length: 90 }, (_, index) => `长历史第 ${index + 1} 行内容`)
  await sendMessage(page, `长内容-${run}\n${lines.join('\n')}`)
  await expect(assistantMessages(page)).toHaveCount(2)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect
    .poll(async () => (await scrollMetrics(page)).max, { timeout: 15_000 })
    .toBeGreaterThan(0)
}

test('聊天输入取消粗 ring，保留 border 加深、按钮焦点与拖入高亮', async ({ page }) => {
  await openApp(page)
  const composer = page.locator('[data-slot="huan-composer"]')
  const group = composer.locator('[data-slot="input-group"]')
  const input = messageInput(page)

  const base = await group.evaluate((element) => {
    const style = getComputedStyle(element)
    return { border: style.borderTopColor, shadow: style.boxShadow }
  })
  await input.click()
  const focused = await group.evaluate((element) => {
    const style = getComputedStyle(element)
    return { border: style.borderTopColor, shadow: style.boxShadow }
  })
  expect(focused.border).not.toBe(base.border)
  expect(focused.shadow).not.toContain('3px')

  // Tab 进入相邻按钮时，按钮自身的键盘焦点 ring 不能被聊天输入的局部覆盖影响。
  await page.keyboard.press('Tab')
  const attach = page.getByRole('button', { name: '添加图片附件', exact: true })
  await expect(attach).toBeFocused()
  await expect
    .poll(async () => attach.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain('3px')

  // 图片拖入仍使用原有 2px 高亮，而不是被焦点规则取消。
  await composer.evaluate((form) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['drag'], 'drag.png', { type: 'image/png' }))
    form.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    )
  })
  await expect(composer).toHaveAttribute('data-dragging', 'true')
  const draggingShadow = await group.evaluate((element) => getComputedStyle(element).boxShadow)
  expect(draggingShadow).toContain('2px')
  await composer.evaluate((form) => {
    form.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
  })
  await expect(composer).not.toHaveAttribute('data-dragging')

  // 局部覆盖不能影响其他表单：统一设置里的普通 Input 仍保留键盘焦点 ring。
  await openSettings(page, '模型与服务商')
  const settings = settingsDialog(page)
  await expect(settings).toBeVisible()
  const otherInput = settings.getByRole('textbox', { name: '默认服务商' })
  await otherInput.click()
  await expect
    .poll(async () => otherInput.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain('3px')
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
})

test('消息滚动条悬浮不占宽，短到长布局稳定且拖动/键盘/回底有效', async ({ page }) => {
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  await sendMessage(page, '短内容')
  await expect(assistantMessages(page)).toHaveCount(1)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const shortContent = await boxOf(chatContent(page))
  const shortViewport = await boxOf(scrollViewport(page))
  const shortMetrics = await scrollMetrics(page)
  expect(shortMetrics.offsetWidth - shortMetrics.clientWidth).toBe(0)

  await seedLongHistoryAfterShort(page, '长内容')
  await expect.poll(async () => bottomGap(page)).toBeLessThan(2)
  const longContent = await boxOf(chatContent(page))
  const viewport = scrollViewport(page)
  const metrics = await scrollMetrics(page)

  // Windows 经典滚动条也必须是 0 占宽；内容列横坐标/宽度不能随溢出变化。
  expect(metrics.offsetWidth - metrics.clientWidth).toBe(0)
  expect(Math.abs(longContent.x - shortContent.x)).toBeLessThan(0.5)
  expect(Math.abs(longContent.width - shortContent.width)).toBeLessThan(0.5)
  expect(Math.abs((await boxOf(viewport)).width - shortViewport.width)).toBeLessThan(0.5)

  const track = page.locator('[data-slot="huan-chat-scrollbar"]')
  await expect(track).toHaveCount(1)
  const trackBox = await boxOf(track)
  const thumb = page.locator('[data-slot="huan-chat-scroll-thumb"]')
  const thumbBox = await boxOf(thumb)
  const viewportBox = await boxOf(viewport)
  expect(Math.round(trackBox.width)).toBe(8)
  expect(trackBox.x).toBeGreaterThanOrEqual(viewportBox.x)
  expect(trackBox.x + trackBox.width).toBeLessThanOrEqual(viewportBox.x + viewportBox.width + 0.5)
  expect(thumbBox.x).toBeGreaterThanOrEqual(trackBox.x - 0.5)
  expect(thumbBox.x + thumbBox.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 0.5)
  expect(thumbBox.height).toBeGreaterThan(0)
  expect(thumbBox.height).toBeLessThan(trackBox.height)
  expect(await track.evaluate((element) => getComputedStyle(element).position)).toBe('absolute')

  // 轨道拖动：从底部向上拖，滚动位置必须实际变化并出现回底入口。
  const startY = thumbBox.y + thumbBox.height / 2
  const startX = thumbBox.x + thumbBox.width / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY - 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await scrollMetrics(page)).top).toBeLessThan(metrics.max - 20)
  const back = scrollToBottom(page)
  await expect(back).toBeVisible()
  await back.click()
  await expect.poll(async () => bottomGap(page)).toBeLessThan(2)

  // 键盘可继续滚动，并能用 End 回到最底。
  await viewport.focus()
  await expect(viewport).toBeFocused()
  await page.keyboard.press('PageUp')
  await expect.poll(async () => bottomGap(page)).toBeGreaterThan(20)
  await page.keyboard.press('End')
  await expect.poll(async () => bottomGap(page)).toBeLessThan(2)

  await expect(back).toHaveCount(0)
})

test('上滚后流式输出不把视图拉回，新输出提示可回底', async ({ page, request }) => {
  await seedLongHistory(page)
  const viewport = scrollViewport(page)
  const textTop = (await scrollMetrics(page)).top
  await viewport.hover()
  await page.mouse.wheel(0, -1600)
  await expect.poll(async () => (await scrollMetrics(page)).top).toBeLessThan(textTop - 100)
  const before = (await scrollMetrics(page)).top
  const back = scrollToBottom(page)
  await expect(back).toContainText('回到底部')

  await configureStream(request, ['流式第一段。', '流式第二段。'])
  await sendMessage(page, '上滚后发送流式消息')
  await expect.poll(async () => (await streamState(request)).active).toBe(true)
  const afterSend = (await scrollMetrics(page)).top
  expect(Math.abs(afterSend - before)).toBeLessThan(12)
  await expect(back).toContainText('有新输出')

  await releaseSegment(request)
  await expect(assistantMessages(page).last()).toContainText('流式第一段。')
  const afterFirst = await scrollMetrics(page)
  expect(afterFirst.top).toBeLessThan(afterFirst.max - 100)

  await releaseSegment(request)
  await finishStream(request)
  await expect(assistantMessages(page).last()).toContainText('流式第一段。流式第二段。')
  const afterDone = await scrollMetrics(page)
  expect(afterDone.top).toBeLessThan(afterDone.max - 100)
  await expect(back).toContainText('有新输出')

  await back.click()
  await expect.poll(async () => bottomGap(page)).toBeLessThan(2)
})

test('工具参数/输出/详情显式换行且复制原文，Markdown 代码默认横向滚动', async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  const run = Date.now().toString(36)
  const note = `WRAP-${run}-${'X'.repeat(240)}`
  const markdownCode = 'M'.repeat(260)
  await scriptTurns(request, [
    { tool: { name: 'e2e-wrap', args: { note } } },
    { text: `换行完成\n\n\`\`\`text\n${markdownCode}\n\`\`\`` },
  ])
  await sendMessage(page, `工具换行-${run}`)
  await expect(assistantMessages(page).last()).toContainText('换行完成')
  await page.getByRole('button', { name: '已运行 e2e-wrap' }).click()
  const card = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-wrap' }).last()
  await card.locator('summary').filter({ hasText: '工具详情' }).click()

  const contents = card.locator('[data-slot="code-block-content"]')
  await expect(contents).toHaveCount(3)
  for (let index = 0; index < 3; index += 1) {
    const content = contents.nth(index)
    await expect(content).toHaveAttribute('data-wrap', 'true')
    const geometry = await content.evaluate((element) => {
      const code = element.querySelector('[data-slot="code-block-code"]')
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        codeScrollWidth: code?.scrollWidth ?? 0,
      }
    })
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
    expect(geometry.codeScrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  }

  const output = contents.nth(1)
  const outputHeight = await output.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      scrollHeight: element.scrollHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    }
  })
  expect(outputHeight.scrollHeight).toBeGreaterThan(outputHeight.lineHeight * 2)

  // 复制保持工具原始文本，不受视觉换行影响；Windows 剪贴板把换行规范化为 CRLF。
  const readClipboard = async () =>
    (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
  const blocks = card.locator('[data-slot="code-block"]')
  await blocks.nth(0).getByRole('button', { name: '复制', exact: true }).click()
  await expect.poll(readClipboard).toBe(JSON.stringify({ note }, null, 2))
  await blocks.nth(1).getByRole('button', { name: '复制', exact: true }).click()
  await expect.poll(readClipboard).toBe(`OUTPUT:${note}`)

  // 助手 Markdown 代码块保持默认：不 wrap，长行横向滚动。
  const markdown = assistantMessages(page).last().locator('[data-slot="code-block-content"]').last()
  await expect(markdown).not.toHaveAttribute('data-wrap', 'true')
  const markdownGeometry = await markdown.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(markdownGeometry.scrollWidth).toBeGreaterThan(markdownGeometry.clientWidth)
})

const tooltipCases = [
  { id: 'top', side: 'top' },
  { id: 'bottom', side: 'bottom' },
  { id: 'left', side: 'left' },
  { id: 'right', side: 'right' },
  { id: 'flip-top', side: 'bottom' },
  { id: 'flip-bottom', side: 'top' },
  { id: 'flip-left', side: 'right' },
  { id: 'flip-right', side: 'left' },
] as const

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const intersects = (left: Rect, right: Rect): boolean => {
  const overlapX = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const overlapY =
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  return overlapX > 0.5 && overlapY > 0.5
}

test('Tooltip 箭头贴边、不遮文字，四向翻转与明暗主题一致', async ({ page }) => {
  const backgrounds: Record<string, string> = {}
  for (const theme of ['light', 'dark'] as const) {
    await page.goto(`/e2e/fixtures/tooltip.html?theme=${theme}`)
    const html = page.locator('html')
    if (theme === 'dark') await expect(html).toHaveClass(/dark/)
    else await expect(html).not.toHaveClass(/dark/)

    for (const item of tooltipCases) {
      const trigger = page.getByTestId(`tooltip-trigger-${item.id}`)
      await trigger.hover()
      const text = page.getByTestId(`tooltip-text-${item.id}`)
      await expect(text).toBeVisible()
      const popup = text.locator('..')
      const arrow = popup.locator('[data-slot="tooltip-arrow"]')
      await expect(arrow).toHaveAttribute('data-side', item.side)
      const popupBox = await boxOf(popup)
      const textBox = await boxOf(text)
      const arrowBox = await boxOf(arrow)
      expect(intersects(textBox, arrowBox)).toBe(false)

      if (item.side === 'top' || item.side === 'bottom') {
        expect(Math.abs(arrowBox.width - 12)).toBeLessThanOrEqual(1)
        expect(Math.abs(arrowBox.height - 6)).toBeLessThanOrEqual(1)
      } else {
        expect(Math.abs(arrowBox.width - 6)).toBeLessThanOrEqual(1)
        expect(Math.abs(arrowBox.height - 12)).toBeLessThanOrEqual(1)
      }
      if (item.side === 'top') {
        expect(Math.abs(arrowBox.y - (popupBox.y + popupBox.height))).toBeLessThanOrEqual(1)
      } else if (item.side === 'bottom') {
        expect(Math.abs(arrowBox.y + arrowBox.height - popupBox.y)).toBeLessThanOrEqual(1)
      } else if (item.side === 'left') {
        expect(Math.abs(arrowBox.x - (popupBox.x + popupBox.width))).toBeLessThanOrEqual(1)
      } else {
        expect(Math.abs(arrowBox.x + arrowBox.width - popupBox.x)).toBeLessThanOrEqual(1)
      }

      const colors = await arrow.evaluate((element) => ({
        arrow: getComputedStyle(element, '::before').backgroundColor,
        popup: getComputedStyle(element.parentElement as HTMLElement).backgroundColor,
        overflow: getComputedStyle(element).overflow,
      }))
      expect(colors.arrow).toBe(colors.popup)
      expect(colors.overflow).toBe('clip')
      backgrounds[theme] = colors.popup
    }
  }
  expect(backgrounds.light).not.toBe(backgrounds.dark)

  // 键盘聚焦触发器也必须打开同一套 Tooltip。
  await page.goto('/e2e/fixtures/tooltip.html?theme=light')
  await page.getByTestId('tooltip-trigger-top').focus()
  await expect(page.getByTestId('tooltip-text-top')).toBeVisible()
})

test('顶部提示为固定 toast：不改变布局，自动消失，悬停与键盘聚焦暂停', async ({
  page,
  request,
}) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `toast-${run}`)
  const name = `提示工作区-${run}`
  await createWorkspaceApi(request, name, [{ alias: 'p', path: project.path }])
  await openApp(page)

  const boxOfSlot = async (slot: string) => {
    const box = await page.locator(`[data-slot="${slot}"]`).boundingBox()
    if (!box) throw new Error(`缺少布局元素：${slot}`)
    return box
  }
  const layout = async () => ({
    header: await boxOfSlot('huan-header'),
    composer: await boxOfSlot('huan-composer'),
    messages: await boxOfSlot('huan-chat-view'),
  })
  const expectSameLayout = (
    before: Awaited<ReturnType<typeof layout>>,
    after: Awaited<ReturnType<typeof layout>>,
  ) => {
    for (const key of ['header', 'composer', 'messages'] as const) {
      expect(Math.abs(after[key].x - before[key].x)).toBeLessThan(0.5)
      expect(Math.abs(after[key].y - before[key].y)).toBeLessThan(0.5)
      expect(Math.abs(after[key].width - before[key].width)).toBeLessThan(0.5)
      expect(Math.abs(after[key].height - before[key].height)).toBeLessThan(0.5)
    }
  }

  // 管理工作区改名触发 workspaceStore 普通提示，且不切换当前会话选择。
  const before = await layout()
  await page.getByRole('button', { name: '管理工作区', exact: true }).first().click()
  const form = page.getByRole('dialog', { name: '管理工作区' })
  await expect(form).toBeVisible()
  await form.getByLabel('工作区名称').fill(`${name}-二`)
  await form.getByRole('button', { name: '保存', exact: true }).click()
  await expect(form).toHaveCount(0)

  const toast = page.locator('[data-slot="huan-workspace-notice"]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('工作区已更新。')
  expectSameLayout(before, await layout())

  // fixed 容器不占布局；仅 toast 本体可点击，顶部居中有可读宽度。
  const geometry = await toast.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const container = element.parentElement as HTMLElement
    const containerStyle = getComputedStyle(container)
    return {
      containerPosition: containerStyle.position,
      containerPointerEvents: containerStyle.pointerEvents,
      pointerEvents: style.pointerEvents,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewportWidth: innerWidth,
    }
  })
  expect(geometry.containerPosition).toBe('fixed')
  expect(geometry.containerPointerEvents).toBe('none')
  expect(geometry.pointerEvents).toBe('auto')
  expect(geometry.rect.y).toBeGreaterThanOrEqual(0)
  expect(geometry.rect.y).toBeLessThan(40)
  expect(
    Math.abs(geometry.rect.x + geometry.rect.width / 2 - geometry.viewportWidth / 2),
  ).toBeLessThan(1)
  expect(geometry.rect.width).toBeLessThanOrEqual(448)

  // 悬停暂停：超过默认时长仍保留。
  await toast.hover()
  await page.waitForTimeout(5_600)
  await expect(toast).toBeVisible()
  await page.mouse.move(12, 12)

  // 键盘焦点暂停：焦点在 toast 内时同样不消失。
  await toast.getByRole('button', { name: '关闭提示' }).focus()
  await page.waitForTimeout(5_600)
  await expect(toast).toBeVisible()

  // 失去焦点后按剩余时间继续，最终自动消失。
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(toast).toHaveCount(0, { timeout: 7_000 })
})

test('会话操作收进单一菜单：模型只在输入区，操作/确认/焦点与新目标适用项', async ({
  page,
  request,
}) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `menu-${run}`)
  const workspaceName = `菜单工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  await openApp(page)
  await startNewSession(page, workspaceName)

  const context = page.locator('[data-slot="huan-session-context"]')
  // C01：标题只写“新会话”，延迟创建与面板取目标的说明不再出现。
  await expect(context).toContainText('新会话')
  await expect(context).not.toContainText('新会话目标')
  await expect(context).not.toContainText('发送首条消息时创建')
  await expect(page.locator('[data-slot="huan-chat-view"]')).not.toContainText('发送首条消息')
  await expect(context.getByRole('combobox')).toHaveCount(0)
  const composer = page.locator('[data-slot="huan-composer"]')
  await expect(composer.getByRole('combobox')).toHaveCount(1)

  // 新会话目标只提供适用动作：运行操作与管理当前目标工作区。
  const newMenu = await openSessionActions(page)
  await expect(newMenu.getByRole('menuitem')).toHaveCount(2)
  await expect(newMenu.getByRole('menuitem', { name: '运行操作', exact: true })).toBeVisible()
  await expect(newMenu.getByRole('menuitem', { name: '管理项目', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(newMenu).toHaveCount(0)
  await expect(sessionActionsTrigger(page)).toBeFocused()

  // 键盘打开菜单，Esc 先关闭菜单并回到持久入口。
  await page.keyboard.press('Enter')
  const keyboardMenu = page.getByRole('menu')
  await expect(keyboardMenu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(keyboardMenu).toHaveCount(0)
  await expect(sessionActionsTrigger(page)).toBeFocused()

  // 菜单项打开弹层；关闭后焦点仍回菜单入口。
  await chooseSessionAction(page, '管理项目')
  const workspaceForm = page.getByRole('dialog', { name: '管理工作区' })
  await expect(workspaceForm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(workspaceForm).toHaveCount(0)
  await expect(sessionActionsTrigger(page)).toBeFocused()

  // 创建真实会话后，模型选择仍只在输入区，菜单覆盖全部适用操作。
  await selectModel(page)
  await sendMessage(page, `菜单会话-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(context.getByRole('combobox')).toHaveCount(0)
  await expect(composer.getByRole('combobox')).toHaveCount(1)

  const menu = await openSessionActions(page)
  for (const label of ['运行操作', '会话树', '克隆到新会话', '详情', '归档', '删除', '管理项目']) {
    await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
  await menu.getByRole('menuitem', { name: '详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '会话详情' })
  await expect(details).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(sessionActionsTrigger(page)).toBeFocused()

  // 删除仍需确认；取消后会话保留，焦点回到菜单入口。
  await chooseSessionAction(page, '删除')
  const confirm = page.getByRole('dialog', { name: '删除会话' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '取消' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(sessionActionsTrigger(page)).toBeFocused()
})

/** 在已发送短消息的会话中追加长内容（测试 2 的短/长对照）。 */
async function seedLongHistoryAfterShort(page: Page, prefix: string): Promise<void> {
  const lines = Array.from({ length: 90 }, (_, index) => `长历史第 ${index + 1} 行内容`)
  await sendMessage(page, `${prefix}\n${lines.join('\n')}`)
  await expect(assistantMessages(page)).toHaveCount(2)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect
    .poll(async () => (await scrollMetrics(page)).max, { timeout: 15_000 })
    .toBeGreaterThan(0)
}
