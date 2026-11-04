/**
 * 输入区上下文用量浮窗的真实浏览器验收。
 *
 * 顶部用量与累计统计来自真实宿主：用量夹具经既有导入 API 写入真实会话文件，
 * 压缩走真实 Pi SDK 与合成 provider。测试只观察既有 HTTP 请求，不替换后端。
 */
import { writeFile } from 'node:fs/promises'
import type { APIRequestContext, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  configureStream,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  finishStream,
  messageInput,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  threadListItem,
  userMessages,
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

test.afterEach(async ({ request }) => {
  await resetStream(request)
  expect(browserErrors).toEqual([])
})

const trigger = (page: Page) => page.locator('[data-huan-context-usage-trigger]')
const popover = (page: Page) => page.locator('[data-huan-context-usage]')
const percentText = (page: Page) =>
  popover(page).locator('[data-slot="huan-context-usage-percent"]')
const compactButton = (page: Page) =>
  popover(page).getByRole('button', { name: '立即压缩上下文', exact: true })

const isCompactRequest = (url: string): boolean =>
  /^\/api\/pi\/threads\/[^/]+\/compact$/.test(new URL(url).pathname)

/** 新建隔离工作区，避免跨用例共享归属与资源。 */
async function prepareWorkspace(
  request: APIRequestContext,
  label: string,
): Promise<{ workspaceName: string }> {
  const run = Date.now().toString(36)
  const project = await createProject(request, `${label}-${run}`)
  const workspaceName = `${label}工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  return { workspaceName }
}

/** 与 runtime-operations 相同的长历史准备：确保会话文件存在且可压缩。 */
async function sendLongMessage(page: Page, text: string): Promise<void> {
  await sendMessage(page, `${text} ${'上下文历史'.repeat(24)}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
}

/** 构造带真实 usage/model_change 的 Pi JSONL，用于稳定的顶部用量与累计统计。 */
function usageSessionJsonl(input: { id: string; cwd: string; title: string }): string {
  const base = Date.parse('2026-11-04T00:00:00.000Z')
  const at = (offset: number) => new Date(base + offset).toISOString()
  const header = {
    type: 'session',
    version: 3,
    id: input.id,
    timestamp: at(0),
    cwd: input.cwd,
  }
  const entries: Record<string, unknown>[] = [
    {
      type: 'model_change',
      id: 'entry-model',
      parentId: null,
      timestamp: at(1),
      provider: 'huan-test',
      modelId: 'test-model-a',
    },
    {
      type: 'message',
      id: 'entry-user',
      parentId: 'entry-model',
      timestamp: at(2),
      message: {
        role: 'user',
        content: [{ type: 'text', text: input.title }],
        timestamp: base + 2,
      },
    },
    {
      type: 'message',
      id: 'entry-assistant',
      parentId: 'entry-user',
      timestamp: at(3),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '用量夹具回复' }],
        api: 'openai-completions',
        provider: 'huan-test',
        model: 'test-model-a',
        usage: {
          input: 18_000,
          output: 500,
          cacheRead: 3_000,
          cacheWrite: 500,
          totalTokens: 22_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: base + 3,
      },
    },
  ]
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/** 经现有导入 API 写入夹具会话；返回会话标题。 */
async function importUsageFixture(
  request: APIRequestContext,
  testInfo: TestInfo,
  input: { workspaceId: string; cwd: string; run: string },
): Promise<string> {
  const title = `用量夹具-${input.run}`
  const sourcePath = testInfo.outputPath(`composer-context-usage-${input.run}.jsonl`)
  await writeFile(
    sourcePath,
    usageSessionJsonl({ id: `e2e-usage-${input.run}`, cwd: input.cwd, title }),
  )
  const response = await request.post(`${E2E_HOST_URL}/api/pi/threads/import`, {
    data: {
      source: { kind: 'path', path: sourcePath },
      workspaceId: input.workspaceId,
    },
  })
  expect(response.ok()).toBe(true)
  const result = (await response.json()) as { status?: string; threadId?: string }
  expect(result).toMatchObject({ status: 'imported' })
  expect(result.threadId).toBeTruthy()
  return title
}

test('浮窗点击、延迟悬停、移入可点与 Esc 展示真实用量和阈值颜色', async ({
  page,
  request,
}, testInfo) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `用量-${run}`)
  const workspaceName = `用量工作区-${run}`
  const workspace = await createWorkspaceApi(request, workspaceName, [
    { alias: 'p', path: project.path },
  ])
  const title = await importUsageFixture(request, testInfo, {
    workspaceId: workspace.id,
    cwd: project.path,
    run,
  })

  await openApp(page)
  await startNewSession(page, workspaceName)
  await threadListItem(page, title).click()
  await expect(userMessages(page).first()).toContainText(title)

  // 点击立即打开：顶部用量、进度与累计统计全部来自真实宿主数据。
  await expect(popover(page)).toHaveCount(0)
  await trigger(page).click()
  const view = popover(page)
  await expect(view).toBeVisible()
  await expect(view.locator('[data-slot="huan-context-usage-tokens"]')).toHaveText('22K / 32.8K')
  await expect(percentText(page)).toHaveText('67.1%')
  await expect(percentText(page)).toHaveClass(/text-amber-600/)
  await expect(trigger(page).locator('circle').nth(1)).toHaveClass(/stroke-amber-500/)
  await expect(view.getByRole('progressbar', { name: '上下文窗口占用' })).toHaveAttribute(
    'aria-valuenow',
    '67',
  )
  const stats = view.locator('[data-slot="huan-context-usage-stats"]')
  await expect(stats.locator('dd').nth(0)).toHaveText('18K')
  await expect(stats.locator('dd').nth(1)).toHaveText('500')
  await expect(stats.locator('dd').nth(2)).toHaveText('3K')
  await expect(stats.locator('dd').nth(3)).toHaveText('14.0%')
  const bounds = await view.boundingBox()
  const sendBounds = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox()
  const triggerBounds = await trigger(page).boundingBox()
  expect(bounds?.width).toBeLessThanOrEqual(300)
  expect(triggerBounds?.width).toBe(28)
  expect(triggerBounds && sendBounds && triggerBounds.x < sendBounds.x).toBe(true)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle('dark', dark),
      theme === 'dark',
    )
    await page.screenshot({ path: testInfo.outputPath(`context-usage-${theme}.png`) })
  }

  await page.keyboard.press('Escape')
  await expect(view).toHaveCount(0)

  // 短停不打开；继续停留时轮询等待延迟打开，不固定睡眠。
  await trigger(page).hover()
  // 在 600ms 阈值前持续观察，防止误用默认短延迟却同样通过最终打开断言。
  await expect(view).not.toBeAttached()
  await page.waitForTimeout(200)
  await expect(view).not.toBeAttached()
  await page.mouse.move(0, 0)
  await expect(view).toHaveCount(0)
  await trigger(page).hover()
  await expect(view).toBeVisible({ timeout: 5_000 })

  // 移入浮窗后可点击内容且浮窗保持打开。
  await view.getByText('本会话累计', { exact: true }).click()
  await expect(view).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(view).toHaveCount(0)
})

test('浮窗按钮无提示词压缩保留草稿，压缩后未知且运行中禁用', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '浮窗压缩')
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendLongMessage(page, `浮窗压缩一-${run}`)
  await sendLongMessage(page, `浮窗压缩二-${run}`)
  await sendLongMessage(page, `浮窗压缩三-${run}`)

  const draft = `浮窗草稿-${run}`
  await messageInput(page).fill(draft)
  await trigger(page).click()
  const view = popover(page)
  await expect(view).toBeVisible()
  await expect(compactButton(page)).toBeEnabled()

  const compactRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && isCompactRequest(request.url()),
  )
  await compactButton(page).click()
  const sent = await compactRequest
  expect(sent.postDataJSON()).toEqual({})
  await expect(
    page.locator('[data-slot="huan-compaction-status"][data-status="compacted"]'),
  ).toContainText('上下文已压缩')
  await expect(messageInput(page)).toHaveValue(draft)
  await expect(percentText(page)).toHaveText('—')
  await expect(view).toContainText('压缩后用量待更新')
  await expect(compactButton(page)).toBeEnabled()

  // 运行中再次打开浮窗：按钮禁用且给出简短原因。
  await page.keyboard.press('Escape')
  await expect(view).toHaveCount(0)
  await configureStream(request, ['运行中回复'])
  await sendMessage(page, `运行中压缩-${run}`)
  await expect(page.getByRole('button', { name: '停止当前运行' })).toBeVisible()
  await trigger(page).click()
  await expect(view).toBeVisible()
  await expect(compactButton(page)).toBeDisabled()
  await expect(view).toContainText('运行中暂不可压缩')

  await releaseSegment(request)
  await finishStream(request)
  await expect(assistantMessages(page).last()).toContainText('运行中回复')
})

test('/compact 运行期间立即清空命令，可停止或在消息行取消，刷新保留结果', async ({
  page,
  request,
}) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '取消命令压缩')
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  for (let index = 0; index < 3; index++) await sendLongMessage(page, `取消压缩-${run}-${index}`)

  for (const fromRow of [false, true]) {
    await configureStream(request, ['摘要仍在等待'])
    await messageInput(page).fill('/compact 保留关键决策')
    await messageInput(page).press('Enter')
    const row = page.locator('[data-slot="huan-compaction-status"]')
    await expect(row).toHaveAttribute('data-status', 'running')
    await expect(messageInput(page)).toHaveValue('')
    const draft = `后来编辑的草稿-${fromRow}`
    await messageInput(page).fill(draft)
    if (fromRow) {
      await page.reload()
      await expect(row).toHaveAttribute('data-status', 'running')
      await row.getByRole('button', { name: '取消压缩', exact: true }).click()
    } else {
      const stop = page.getByRole('button', { name: '停止当前运行' })
      await expect(stop).toBeEnabled()
      await stop.click()
    }
    await expect(row).toHaveAttribute('data-status', 'cancelled')
    await expect(row).toContainText('压缩已取消')
    await expect(messageInput(page)).toHaveValue(draft)
    await page.reload()
    await expect(row).toHaveAttribute('data-status', 'cancelled')
    await resetStream(request)
  }
})

test('/compact 带指令直接请求压缩，不打开运行面板或发送普通聊天', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '命令压缩')
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendLongMessage(page, `命令压缩一-${run}`)
  await sendLongMessage(page, `命令压缩二-${run}`)
  await sendLongMessage(page, `命令压缩三-${run}`)

  const chatRequests: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    const pathname = new URL(request.url()).pathname
    if (/^\/api\/pi\/threads\/[^/]+\/messages$/.test(pathname)) chatRequests.push(pathname)
  })

  const instructions = `保留关键决策-${run}`
  const compactRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && isCompactRequest(request.url()),
  )
  await messageInput(page).fill(`/compact ${instructions}`)
  await messageInput(page).press('Enter')
  const sent = await compactRequest
  expect(sent.postDataJSON()).toEqual({ customInstructions: instructions })

  await expect(
    page.locator('[data-slot="huan-compaction-status"][data-status="compacted"]'),
  ).toContainText('上下文已压缩')
  await expect(messageInput(page)).toHaveValue('')
  await expect(page.getByRole('dialog', { name: '运行操作' })).toHaveCount(0)
  expect(chatRequests).toEqual([])
  await expect(userMessages(page).filter({ hasText: '/compact' })).toHaveCount(0)

  // 压缩后上下文用量未知，而不是伪造 0%。
  await trigger(page).click()
  const view = popover(page)
  await expect(view).toBeVisible()
  await expect(percentText(page)).toHaveText('—')
  await expect(view).toContainText('压缩后用量待更新')
  await page.keyboard.press('Escape')
  const resultRow = page.locator('[data-slot="huan-compaction-status"][data-status="compacted"]')
  await expect(resultRow).toHaveCount(1)
  await sendMessage(page, `压缩后的消息-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  const resultBox = await resultRow.boundingBox()
  const replyBox = await assistantMessages(page).last().boundingBox()
  expect(resultBox && replyBox && resultBox.y < replyBox.y).toBe(true)
  await page.reload()
  await expect(resultRow).toHaveCount(1)
  await expect(page.locator('[data-slot="huan-compaction-summary"]')).toHaveCount(0)
})
