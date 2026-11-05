/**
 * SDK 子agent 最小真实浏览器验收：单个与并行任务。
 *
 * 链路为真实宿主 + 真实 Pi SDK：合成模型按轮次先由父会话发起 subagent，
 * 再由子会话调用 e2e-child-ask 等待确认；审批通过后子会话继续并回到父会话。
 * 子agent 定义只存在于测试启动器创建的隔离 agentDir 中，不读写个人空间。
 * 链式调度由 core/unit 覆盖，本文件只保留单个与并行两条最小浏览器链路。
 */
import type { HarnessRunMetrics } from '@huan/protocol'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import {
  formatRunMetricsDuration,
  formatRunMetricsSpeed,
  runMetricsSpeed,
} from '../src/lib/run-metrics.js'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  openApp,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  threadListItem,
  waitForApp,
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

type SnapshotPart = { type?: string; text?: string }

type SnapshotMessage = {
  role?: string
  toolName?: string
  content?: unknown
}

type ThreadSnapshot = {
  metadata: { id: string; title?: string; runMetrics?: HarnessRunMetrics }
  messages: SnapshotMessage[]
}

type TaskView = {
  task: { status: string; runMetrics?: HarnessRunMetrics }
  requests: Array<{ kind?: string; title?: string }>
}

/** 配置脚本化模型轮次；请求按 FIFO 消费，子会话与父会话共用同一控制面。 */
async function scriptTurns(
  request: APIRequestContext,
  turns: Array<Record<string, unknown>>,
): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns },
  })
  expect(response.ok()).toBe(true)
}

/** 读取当前普通会话列表标题；子记录目录不属于普通会话目录。 */
async function threadTitles(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(response.ok()).toBe(true)
  const threads = (await response.json()) as Array<{ title?: string }>
  return threads.flatMap((thread) => (thread.title ? [thread.title] : []))
}

/** 按标题读取父会话快照，用于核对工具结果持久化内容。 */
async function threadSnapshotByTitle(
  request: APIRequestContext,
  title: string,
): Promise<ThreadSnapshot> {
  const threadsResponse = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(threadsResponse.ok()).toBe(true)
  const threads = (await threadsResponse.json()) as Array<{ id: string; title?: string }>
  const hit = threads.find((thread) => thread.title === title)
  if (!hit) throw new Error(`未找到会话：${title}`)
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads/${hit.id}`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as ThreadSnapshot
}

/** 父工具结果中的文本（子任务最终输出/取消原因都在这里）。 */
function toolResultText(snapshot: ThreadSnapshot, toolName: string): string {
  return snapshot.messages
    .flatMap((message) => {
      if (message.role !== 'toolResult' || message.toolName !== toolName) return []
      const content = Array.isArray(message.content) ? message.content : []
      return content.flatMap((part) => {
        if (typeof part !== 'object' || part === null) return []
        const typed = part as SnapshotPart
        return typed.type === 'text' && typeof typed.text === 'string' ? [typed.text] : []
      })
    })
    .join('\n')
}

/** 读取子任务视图；与面板相同的服务端接口，用于确认请求与终态。 */
async function getTaskView(
  request: APIRequestContext,
  parentThreadId: string,
  taskId: string,
): Promise<TaskView> {
  const response = await request.get(
    `${E2E_HOST_URL}/api/pi/threads/${parentThreadId}/subagents/${taskId}`,
  )
  expect(response.ok()).toBe(true)
  return (await response.json()) as TaskView
}

const subagentTrigger = (page: Page) =>
  page.getByRole('button', { name: /^(?:运行 |已运行 |失败：\s*)subagent/ }).last()

/** 展开父 subagent 工具；失败态默认展开，避免再次点击收起。 */
async function ensureSubagentToolOpen(page: Page): Promise<void> {
  const trigger = subagentTrigger(page)
  await expect(trigger).toBeVisible({ timeout: 20_000 })
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
}

const taskCard = (scope: Page | Locator, text: string): Locator =>
  scope.locator('[data-slot="huan-subagent-task"]').filter({ hasText: text })

async function taskIdOf(card: Locator): Promise<string> {
  const taskId = await card.getAttribute('data-task-id')
  if (!taskId) throw new Error('子任务卡缺少 taskId')
  return taskId
}

/** 从父工具卡打开只读子任务面板。 */
async function openTaskView(page: Page, marker: string): Promise<Locator> {
  const card = taskCard(page, marker)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.getByRole('button', { name: '查看' }).click()
  const dialog = page.locator('[data-slot="huan-subagent-dialog"]')
  await expect(dialog).toBeVisible()
  return dialog
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="huan-subagent-dialog"]')).toHaveCount(0)
}

/** 子任务的 confirm 请求必须显示来源（agent 与任务 ID），并提供允许按钮。 */
async function expectChildConfirm(dialog: Locator): Promise<Locator> {
  const request = dialog
    .locator('[data-slot="huan-subagent-request"]')
    .filter({ hasText: 'E2E 子工具确认' })
  await expect(request).toBeVisible({ timeout: 20_000 })
  await expect(request.locator('[data-slot="huan-subagent-request-source"]')).toContainText(
    'e2e-worker',
  )
  return request
}

/** 等待子任务完成并显示最终正文。 */
async function expectChildCompleted(dialog: Locator, text: string): Promise<void> {
  await expect(dialog.locator('[data-slot="huan-subagent-status"]')).toHaveAttribute(
    'data-status',
    'completed',
    { timeout: 20_000 },
  )
  await expect(dialog.locator('[data-slot="huan-subagent-messages"]')).toContainText(text, {
    timeout: 20_000,
  })
}

/** 展开子会话内的工具卡，核对确认后的真实工具输出。 */
async function expectChildToolOutput(dialog: Locator): Promise<void> {
  const trigger = dialog.getByRole('button', { name: '已运行 e2e-child-ask' })
  await expect(trigger).toBeVisible({ timeout: 20_000 })
  await trigger.click()
  const card = dialog.locator('[data-slot="trace"]').filter({ hasText: 'e2e-child-ask' }).last()
  await expect(card).toContainText('CHILD-ALLOWED')
}

/** 普通列表与侧栏均不得出现子会话（子记录独立于 sessions 目录）。 */
async function expectNoChildInLists(page: Page, request: APIRequestContext): Promise<void> {
  expect((await threadTitles(request)).some((title) => title.startsWith('e2e-worker:'))).toBe(false)
  await expect(
    page.locator('[data-slot="huan-session-trigger"]').filter({ hasText: 'e2e-worker:' }),
  ).toHaveCount(0)
}

test('单个子任务：确认后完成，刷新父工具仍可打开冷记录', async ({ page, request }, testInfo) => {
  const run = Date.now().toString(36)
  const title = `子任务单个-${run}`
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)

  await scriptTurns(request, [
    {
      tool: {
        name: 'subagent',
        args: { agent: 'e2e-worker', task: 'CHILD-TASK', tasks: [], chain: [] },
      },
      outputTokens: 10,
    },
    { tool: { name: 'e2e-child-ask', args: { note: 'single-note' } }, outputTokens: 20 },
    { text: 'CHILD-RESULT', outputTokens: 30 },
    { text: 'PARENT-SINGLE-DONE', outputTokens: 40 },
  ])
  await sendMessage(page, title)

  await ensureSubagentToolOpen(page)
  const card = taskCard(page, 'CHILD-TASK')
  await expect(card).toBeVisible({ timeout: 20_000 })
  const taskId = await taskIdOf(card)
  const parent = await threadSnapshotByTitle(request, title)

  const dialog = await openTaskView(page, 'CHILD-TASK')
  const requestCard = await expectChildConfirm(dialog)
  await expect(requestCard.locator('[data-slot="huan-subagent-request-source"]')).toContainText(
    taskId.slice(0, 8),
  )

  // 服务端视图与面板一致：任务运行中且恰好有一个待答 confirm。
  const running = await getTaskView(request, parent.metadata.id, taskId)
  expect(running.task.status).toBe('running')
  expect(running.task.runMetrics?.status).toBe('running')
  await expect(card).toContainText('tok/s')
  const initialDuration = running.task.runMetrics?.durationMs ?? 0
  await expect
    .poll(
      async () =>
        (await getTaskView(request, parent.metadata.id, taskId)).task.runMetrics?.durationMs ?? 0,
    )
    .toBeGreaterThan(initialDuration + 500)
  await expect(card).toContainText('首响应')
  await closeDialog(page)
  await page.locator('[data-huan-context-usage-trigger]').click()
  const runningMetrics = page.locator('[data-slot="huan-context-usage-run"]')
  await expect(runningMetrics).toContainText('tok/s')
  await expect(runningMetrics).toContainText('已用时间')
  await expect(runningMetrics).toContainText('首响应')
  await expect(page.locator('[data-huan-context-usage]')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('run-metrics-running.png') })
  await page.keyboard.press('Escape')
  await openTaskView(page, 'CHILD-TASK')
  expect(running.requests.filter((item) => item.kind === 'confirm')).toHaveLength(1)

  await requestCard.getByRole('button', { name: '允许' }).click()
  await expectChildCompleted(dialog, 'CHILD-RESULT')
  await expectChildToolOutput(dialog)
  await expect(card).toHaveAttribute('data-status', 'completed', { timeout: 20_000 })
  await expect(card).toContainText('CHILD-RESULT')
  await closeDialog(page)

  await expect(assistantMessages(page).last()).toContainText('PARENT-SINGLE-DONE', {
    timeout: 20_000,
  })
  await expect
    .poll(async () => toolResultText(await threadSnapshotByTitle(request, title), 'subagent'), {
      timeout: 20_000,
    })
    .toContain('CHILD-RESULT')
  await expectNoChildInLists(page, request)

  const childMetrics = (await getTaskView(request, parent.metadata.id, taskId)).task.runMetrics
  const parentMetrics = (await threadSnapshotByTitle(request, title)).metadata.runMetrics
  expect(childMetrics?.outputTokens).toBe(50)
  expect(parentMetrics?.outputTokens).toBe(50)
  expect(childMetrics?.durationMs).toBeGreaterThan(childMetrics?.firstResponseMs ?? 0)
  expect(parentMetrics?.durationMs).toBeGreaterThan(childMetrics?.durationMs ?? 0)
  const childSpeed = formatRunMetricsSpeed(runMetricsSpeed(childMetrics))
  await expect(card).toContainText(childSpeed)
  await page.locator('[data-huan-context-usage-trigger]').click()
  const metricsView = page.locator('[data-slot="huan-context-usage-run"]')
  await expect(metricsView).toContainText(formatRunMetricsSpeed(runMetricsSpeed(parentMetrics)))
  await expect(metricsView).toContainText(formatRunMetricsDuration(parentMetrics?.firstResponseMs))
  await expect(page.locator('[data-huan-context-usage]')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('run-metrics.png') })
  await page.keyboard.press('Escape')

  // 刷新页面后父工具结果来自持久会话；子任务只能从父卡重开冷记录。
  await page.reload()
  await waitForApp(page)
  await threadListItem(page, title).click()
  await expectNoChildInLists(page, request)
  await expect(assistantMessages(page).last()).toContainText('PARENT-SINGLE-DONE')
  await ensureSubagentToolOpen(page)
  const coldCard = taskCard(page, 'CHILD-TASK')
  await expect(coldCard).toHaveAttribute('data-status', 'completed')
  await expect(coldCard).toContainText('CHILD-RESULT')
  await expect(coldCard).toContainText(childSpeed)
  expect((await threadSnapshotByTitle(request, title)).metadata.runMetrics).toEqual(parentMetrics)
  const coldDialog = await openTaskView(page, 'CHILD-TASK')
  await expectChildCompleted(coldDialog, 'CHILD-RESULT')
  await expectChildToolOutput(coldDialog)
  await expect(coldDialog).toContainText(childSpeed)
  await closeDialog(page)
})

test('并行子任务：逐项确认、取消一项并完成另一项，普通列表无子记录', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const title = `子任务并行-${run}`
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)

  await scriptTurns(request, [
    {
      tool: {
        name: 'subagent',
        args: {
          tasks: [
            { agent: 'e2e-worker', task: 'CHILD-A' },
            { agent: 'e2e-worker', task: 'CHILD-B' },
          ],
        },
      },
    },
    { tool: { name: 'e2e-child-ask', args: { note: 'child-a' } } },
    { tool: { name: 'e2e-child-ask', args: { note: 'child-b' } } },
    { text: 'CHILD-A-DONE' },
    { text: 'PARENT-PARALLEL-DONE' },
  ])
  await sendMessage(page, title)

  await ensureSubagentToolOpen(page)
  const cardA = taskCard(page, 'CHILD-A')
  const cardB = taskCard(page, 'CHILD-B')
  await expect(cardA).toBeVisible({ timeout: 20_000 })
  await expect(cardB).toBeVisible({ timeout: 20_000 })
  const taskIdA = await taskIdOf(cardA)
  const taskIdB = await taskIdOf(cardB)
  const parent = await threadSnapshotByTitle(request, title)

  // 依次打开两个任务的视图，确认两侧都已停在真实 confirm 上。
  const dialogA = await openTaskView(page, 'CHILD-A')
  const requestA = await expectChildConfirm(dialogA)
  await expect(requestA.locator('[data-slot="huan-subagent-request-source"]')).toContainText(
    taskIdA.slice(0, 8),
  )
  const runningA = await getTaskView(request, parent.metadata.id, taskIdA)
  expect(runningA.task.status).toBe('running')
  expect(runningA.requests.filter((item) => item.kind === 'confirm')).toHaveLength(1)
  await closeDialog(page)

  const dialogB = await openTaskView(page, 'CHILD-B')
  const requestB = await expectChildConfirm(dialogB)
  await expect(requestB.locator('[data-slot="huan-subagent-request-source"]')).toContainText(
    taskIdB.slice(0, 8),
  )
  const runningB = await getTaskView(request, parent.metadata.id, taskIdB)
  expect(runningB.task.status).toBe('running')
  expect(runningB.requests.filter((item) => item.kind === 'confirm')).toHaveLength(1)
  await closeDialog(page)

  // 在面板内取消 B；其待答请求应一并解除，A 保持等待。
  const cancelDialog = await openTaskView(page, 'CHILD-B')
  await expectChildConfirm(cancelDialog)
  await cancelDialog.getByRole('button', { name: '取消任务' }).click()
  await expect(cancelDialog.locator('[data-slot="huan-subagent-status"]')).toHaveAttribute(
    'data-status',
    'cancelled',
    { timeout: 20_000 },
  )
  await expect(cancelDialog.locator('[data-slot="huan-subagent-request"]')).toHaveCount(0)
  const cancelled = await getTaskView(request, parent.metadata.id, taskIdB)
  expect(cancelled.task.status).toBe('cancelled')
  expect(cancelled.requests).toEqual([])
  await closeDialog(page)

  // 再批准 A；脚本下一轮文本只会被仍在运行的 A 消费。
  const approveDialog = await openTaskView(page, 'CHILD-A')
  const approveRequest = await expectChildConfirm(approveDialog)
  await approveRequest.getByRole('button', { name: '允许' }).click()
  await expectChildCompleted(approveDialog, 'CHILD-A-DONE')
  await expectChildToolOutput(approveDialog)
  await closeDialog(page)

  await expect(assistantMessages(page).last()).toContainText('PARENT-PARALLEL-DONE', {
    timeout: 20_000,
  })
  await ensureSubagentToolOpen(page)
  await expect(cardA).toHaveAttribute('data-status', 'completed', { timeout: 20_000 })
  await expect(cardB).toHaveAttribute('data-status', 'cancelled')
  await expect
    .poll(async () => toolResultText(await threadSnapshotByTitle(request, title), 'subagent'), {
      timeout: 20_000,
    })
    .toContain('### [e2e-worker] cancelled')
  await expectNoChildInLists(page, request)
})
