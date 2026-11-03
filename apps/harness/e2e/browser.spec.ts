import { expect, test } from '@playwright/test'
import {
  assistantMessages,
  configureStream,
  controlInfo,
  DEFAULT_REPLY,
  disconnectClients,
  finishStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  streamState,
  subscriptions,
  threadListItem,
  userMessages,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

let browserErrors: string[] = []

test.beforeEach(async ({ context }) => {
  browserErrors = []
  // 所有页面（含双窗口测试）都收集脚本异常与控制台错误。
  context.on('page', (page) => {
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
  })
})

test.afterEach(async ({ request }) => {
  // 失败时也要解除可能仍在等待的模型响应，避免影响后续用例。
  await resetStream(request)
  expect(browserErrors).toEqual([])
})

test('空白页显示默认模型错误、目录及来源，选有效模型后可发送并复制摘要', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const info = await controlInfo(request)
  await openApp(page)

  await page.getByRole('button', { name: '宿主状态' }).click()
  const hostStatus = page.getByRole('dialog', { name: '宿主状态' })
  await expect(hostStatus.getByText('默认模型不可用：所选模型不在注册表中')).toBeVisible()
  await expect(hostStatus.getByText(info.workspacePath)).toBeVisible()
  await expect(hostStatus.getByText(`${info.agentDir} (显式参数)`)).toBeVisible()
  await expect(hostStatus.getByText('e2e-missing-provider / e2e-missing-model')).toBeVisible()

  await page.bringToFront()
  await hostStatus.getByRole('button', { name: '复制诊断摘要' }).click()
  await expect(hostStatus.getByText('已复制')).toBeVisible()
  const summary = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
  expect(summary.workspacePath).toBe(info.workspacePath)
  expect(summary.agentDir).toBe(info.agentDir)
  expect(summary.defaultModel.readiness.state).toBe('unavailable-model')
  await page.keyboard.press('Escape')
  await expect(hostStatus).toHaveCount(0)

  // 选有效模型后，空白会话可以创建并发送首条消息。
  await selectModel(page)
  await sendMessage(page, '选择模型后发送')
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
})

test('新建、发送、切换及刷新后历史可读', async ({ page }) => {
  // 标题来自首条用户消息；加时间戳避免重复运行（--repeat-each）时重名。
  const run = Date.now().toString(36)
  const first = `历史消息一-新建会话-${run}`
  const second = `历史消息二-第二个会话-${run}`

  await openApp(page)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  await startNewSession(page)
  await selectModel(page)
  await sendMessage(page, second)
  await expect(userMessages(page)).toHaveCount(1)
  await expect(userMessages(page).first()).toContainText(second)
  // 新会话由首条消息创建；先等宿主创建、归属保存和侧栏刷新完成再重载。
  await expect(threadListItem(page, second)).toBeVisible()

  // 列表标题在页面加载时从会话文件推导；刷新后两个会话都有可读标题。
  await page.reload()
  await expect(threadListItem(page, first)).toBeVisible()
  await expect(threadListItem(page, second)).toBeVisible()

  // 切回第一个会话：只显示该会话的消息。
  await threadListItem(page, first).click()
  await expect(userMessages(page)).toHaveCount(1)
  await expect(userMessages(page).first()).toContainText(first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  // 再次刷新：切换与历史读取仍可重复。
  await page.reload()
  await threadListItem(page, first).click()
  await expect(userMessages(page).first()).toContainText(first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  await threadListItem(page, second).click()
  await expect(userMessages(page).first()).toContainText(second)
})

test('回复期间连接断开再恢复，完成回复不遗漏或重复', async ({ page, request }) => {
  const prompt = '重连测试消息'
  const segment1 = '断线前的第一段。'
  const segment2 = '恢复后的第二段。'

  await configureStream(request, [segment1, segment2])
  await openApp(page)
  await selectModel(page)
  await sendMessage(page, prompt)
  await expect.poll(async () => (await streamState(request)).active).toBe(true)

  // 第一段到达后断开事件流；宿主侧订阅计数确认连接真的消失。
  await releaseSegment(request)
  await expect(assistantMessages(page).last()).toContainText(segment1)
  // 页面离线 + 干净结束事件流：保证断开后不会立刻重连，便于确定性断言。
  const beforeDisconnect = (await subscriptions(request)).totalSubscriptions
  await page.context().setOffline(true)
  await disconnectClients(request)
  await expect.poll(async () => (await subscriptions(request)).activeSubscriptions).toBe(0)

  // 断开期间模型继续产出并结束（宿主不因客户端断开而中止运行）。
  await releaseSegment(request)
  await finishStream(request)
  await expect.poll(async () => (await streamState(request)).completed).toBe(1)

  // 恢复网络后客户端重新订阅，并靠快照补齐断开期间的内容。
  await page.context().setOffline(false)
  await expect
    .poll(async () => (await subscriptions(request)).totalSubscriptions, { timeout: 10_000 })
    .toBeGreaterThan(beforeDisconnect)

  // 重连后以快照恢复：完整回复只出现一次。
  const message = assistantMessages(page).last()
  await expect(assistantMessages(page).filter({ hasText: segment1 })).toHaveCount(1)
  await expect(message).toContainText(`${segment1}${segment2}`, { timeout: 20_000 })
  const text = await message.innerText()
  expect(text.split(segment1).length - 1).toBe(1)
  expect(text.split(segment2).length - 1).toBe(1)
  await expect(userMessages(page)).toHaveCount(1)
})

test('两页面订阅同一会话可同步，关闭其中一个页面不终止运行', async ({ page, context, request }) => {
  const first = `双页历史消息-${Date.now().toString(36)}`
  const second = '双页同步消息'
  const segment1 = '同步第一段。'
  const segment2 = '同步第二段。'

  await openApp(page)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  // 第二个页面打开同一会话，建立独立订阅。
  const page2 = await context.newPage()
  await page2.goto('/')
  await threadListItem(page2, first).click()
  await expect(userMessages(page2).first()).toContainText(first)

  await configureStream(request, [segment1, segment2])
  await sendMessage(page, second)
  await expect.poll(async () => (await streamState(request)).active).toBe(true)
  await releaseSegment(request)
  await expect(assistantMessages(page).last()).toContainText(segment1)
  await expect(assistantMessages(page2).last()).toContainText(segment1)

  // 关闭发起运行的页面，运行应在宿主继续，并由另一个页面观察到完成。
  await page.close()
  await releaseSegment(request)
  await finishStream(request)

  await expect(assistantMessages(page2).last()).toContainText(`${segment1}${segment2}`, {
    timeout: 20_000,
  })
  await expect(page2.getByRole('button', { name: '发送消息' })).toBeVisible()
})
