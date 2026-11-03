import { readFile, writeFile } from 'node:fs/promises'
import type { HarnessThreadMetadata } from '@huan/protocol'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  createProject,
  createWorkspaceApi,
  openApp,
  resetStream,
  userMessages,
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

test.afterEach(async ({ request }) => {
  await resetStream(request)
  expect(browserErrors).toEqual([])
})

type SessionFixture = {
  title: string
  createdAt: string
  updatedAt: string
}

type CreatedSession = SessionFixture & {
  id: string
  path: string
}

type SessionOrders = {
  fixtures: readonly SessionFixture[]
  recent: readonly string[]
  created: readonly string[]
}

/**
 * 三个会话的时间刻意让“最近活动”“创建时间”“ID 升序”互不相同：
 * - A：最早创建，活动时间居中；
 * - B：居中创建，最近活动；
 * - C：最晚创建，活动时间最早。
 *
 * 未修复 live 元数据时，打开会话会丢失时间并按 ID 升序回退，因此两种排序
 * 的期望顺序都不能与回退顺序重合。
 */
function createSessionOrders(prefix: string): SessionOrders {
  const first = {
    title: `${prefix}A`,
    createdAt: '2026-01-10T12:00:00.000Z',
    updatedAt: '2026-03-20T12:00:00.000Z',
  }
  const second = {
    title: `${prefix}B`,
    createdAt: '2026-01-20T12:00:00.000Z',
    updatedAt: '2026-03-30T12:00:00.000Z',
  }
  const third = {
    title: `${prefix}C`,
    createdAt: '2026-01-30T12:00:00.000Z',
    updatedAt: '2026-03-10T12:00:00.000Z',
  }
  return {
    fixtures: [first, second, third],
    recent: [second.title, first.title, third.title],
    created: [third.title, second.title, first.title],
  }
}

/** 轮询到真实写入的 JSONL 可读且包含消息条目，再返回解析后的条目。 */
async function waitForSessionEntries(path: string): Promise<Record<string, unknown>[]> {
  let entries: Record<string, unknown>[] = []
  await expect
    .poll(
      async () => {
        try {
          const content = await readFile(path, 'utf8')
          entries = content
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
          return entries.some((entry) => entry.type === 'message')
        } catch {
          return false
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return entries
}

/** 在宿主扫描前直接改写真实 JSONL：header 决定 created，消息时间决定 modified。 */
async function rewriteSessionTimes(path: string, fixture: SessionFixture): Promise<void> {
  const createdAt = new Date(fixture.createdAt).toISOString()
  const updatedAt = new Date(fixture.updatedAt).toISOString()
  const updatedAtMs = Date.parse(updatedAt)
  const entries = await waitForSessionEntries(path)
  let headerFound = false
  let messageFound = false
  for (const entry of entries) {
    if (entry.type === 'session') {
      entry.timestamp = createdAt
      headerFound = true
      continue
    }
    if (entry.type !== 'message') continue
    entry.timestamp = updatedAt
    const message = entry.message
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`会话消息条目格式无效：${path}`)
    }
    const messageRecord = message as Record<string, unknown>
    messageRecord.timestamp = updatedAtMs
    messageFound = true
  }
  if (!headerFound || !messageFound) {
    throw new Error(`会话文件缺少 header 或 message：${path}`)
  }
  const content = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  await writeFile(path, content)
  // 回读确认改写已经落盘，后续扫描不会再读到原始时间。
  expect(await readFile(path, 'utf8')).toBe(content)
}

async function createExternalSession(
  request: APIRequestContext,
  fixture: SessionFixture,
): Promise<CreatedSession> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/sessions`, {
    data: { text: fixture.title, name: fixture.title },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { id?: unknown; path?: unknown }
  if (typeof body.id !== 'string' || typeof body.path !== 'string') {
    throw new Error('测试会话路由未返回 id/path')
  }
  await rewriteSessionTimes(body.path, fixture)
  return { ...fixture, id: body.id, path: body.path }
}

async function assignSession(
  request: APIRequestContext,
  threadId: string,
  workspaceId: string,
): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/api/pi/threads/${threadId}/workspace`, {
    data: { workspaceId },
  })
  expect(response.ok()).toBe(true)
  const result = (await response.json()) as { ok?: unknown }
  expect(result.ok).toBe(true)
}

async function rescanThreads(request: APIRequestContext): Promise<HarnessThreadMetadata[]> {
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as HarnessThreadMetadata[]
}

/**
 * 在页面打开前生成并改写三条真实会话；最后显式重扫宿主目录，确保初始冷列表
 * 使用改写后的时间，而不是更早的目录缓存。
 */
async function prepareSessions(
  request: APIRequestContext,
  fixtures: readonly SessionFixture[],
  workspaceId?: string,
): Promise<readonly CreatedSession[]> {
  const sessions: CreatedSession[] = []
  for (const fixture of fixtures) {
    sessions.push(await createExternalSession(request, fixture))
  }
  // 外部新增文件需显式重扫后才能由服务端定位并修改归属。
  await rescanThreads(request)
  if (workspaceId) {
    for (const session of sessions) await assignSession(request, session.id, workspaceId)
  }
  const listed = await rescanThreads(request)
  for (const session of sessions) {
    const metadata = listed.find((item) => item.id === session.id)
    if (!metadata) throw new Error(`宿主列表未包含会话：${session.title}`)
    expect(metadata.createdAt).toBe(new Date(session.createdAt).toISOString())
    expect(metadata.updatedAt).toBe(new Date(session.updatedAt).toISOString())
  }
  return sessions
}

function titleAt(titles: readonly string[], index: number): string {
  const title = titles[index]
  if (!title) throw new Error('会话顺序缺少目标条目')
  return title
}

function sessionIdOf(sessions: readonly CreatedSession[], title: string): string {
  const session = sessions.find((item) => item.title === title)
  if (!session) throw new Error(`未找到会话：${title}`)
  return session.id
}

const unassignedRows = (page: Page): Locator =>
  page.locator('[data-slot="huan-unassigned-group"] [data-slot="huan-session-row"]')

async function chooseSort(page: Page, option: string): Promise<void> {
  await page.getByRole('combobox', { name: '会话排序' }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** 逐行断言真实 DOM 顺序，并确认标题与活动时间同时存在。 */
async function expectSessionRows(rows: Locator, titles: readonly string[]): Promise<void> {
  await expect(rows).toHaveCount(titles.length)
  for (const [index, title] of titles.entries()) {
    const row = rows.nth(index)
    await expect(row).toContainText(title)
    await expect(row).toContainText(/\d{2}-\d{2} \d{2}:\d{2}/)
  }
}

async function clickSessionRow(rows: Locator, title: string): Promise<void> {
  await rows.filter({ hasText: title }).locator('[data-slot="huan-session-trigger"]').click()
}

async function openSessionAndWaitHistory(rows: Locator, page: Page, title: string): Promise<void> {
  await clickSessionRow(rows, title)
  await expect(userMessages(page).first()).toContainText(title, { timeout: 20_000 })
}

/**
 * 打开会话并等待 live 快照真正反映到界面。
 *
 * SSE 响应只代表连接建立；等到模型选择器显示当前会话的真实模型配置，才说明
 * 首帧快照已替换冷目录元数据。冷读路径没有该模型配置，不能提前满足条件。
 */
async function openSessionAndWaitLive(
  page: Page,
  rows: Locator,
  title: string,
  threadId: string,
  contextText: string,
): Promise<void> {
  const liveResponse = page.waitForResponse(
    (response) =>
      response.status() === 200 && response.url().includes(`/api/pi/threads/${threadId}/events`),
  )
  await clickSessionRow(rows, title)
  await liveResponse
  await expect(page.locator('[data-slot="huan-session-context"]')).toContainText(contextText)
  await expect(userMessages(page).first()).toContainText(title, { timeout: 20_000 })
  const modelValue = page.locator('[data-slot="huan-composer"] [data-slot="model-selector-value"]')
  await expect(modelValue).toBeVisible()
  await expect(modelValue).not.toHaveText('选择模型', { timeout: 20_000 })
}

/** 点击侧栏显式刷新，并等待真实目录重扫完成（按钮退出 busy）。 */
async function refreshWorkspaceCatalog(page: Page): Promise<void> {
  const refreshButton = page.getByRole('button', { name: '刷新工作区', exact: true })
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'GET' &&
      candidate.url().includes('/api/pi/threads?') &&
      candidate.url().includes('refresh=true'),
  )
  await refreshButton.click()
  expect((await response).ok()).toBe(true)
  await expect(refreshButton).toBeEnabled()
}

/**
 * 两种排序共用同一流程：先以当前排序打开中间条并等待 live 快照，再切换排序、
 * 切换会话后重开中间条，最后在两种排序下显式刷新。
 */
async function exerciseSessionOrdering(input: {
  page: Page
  rows: Locator
  prefix: string
  sessions: readonly CreatedSession[]
  orders: SessionOrders
  contextText: string
}): Promise<void> {
  const { page, rows, prefix, sessions, orders, contextText } = input
  await page.getByLabel('搜索会话').fill(prefix)
  // 初始冷目录顺序。
  await expectSessionRows(rows, orders.recent)

  // 创建时间排序下先打开中间条，等待 SSE 首帧快照，再断言顺序与时间。
  await chooseSort(page, '创建时间')
  await expectSessionRows(rows, orders.created)
  const createdMiddle = titleAt(orders.created, 1)
  await openSessionAndWaitLive(
    page,
    rows,
    createdMiddle,
    sessionIdOf(sessions, createdMiddle),
    contextText,
  )
  await expectSessionRows(rows, orders.created)

  // 切到最近活动：同一个 live 会话仍必须留在确定位置。
  await chooseSort(page, '最近活动')
  await expectSessionRows(rows, orders.recent)
  const recentMiddle = titleAt(orders.recent, 1)
  await openSessionAndWaitLive(
    page,
    rows,
    recentMiddle,
    sessionIdOf(sessions, recentMiddle),
    contextText,
  )
  await expectSessionRows(rows, orders.recent)

  // 切换会话再重开中间条：不因释放/重建 live 租约掉到底部。
  const alternate = titleAt(orders.recent, 0)
  await openSessionAndWaitHistory(rows, page, alternate)
  await openSessionAndWaitLive(
    page,
    rows,
    recentMiddle,
    sessionIdOf(sessions, recentMiddle),
    contextText,
  )
  await expectSessionRows(rows, orders.recent)

  // 最近活动与创建时间下分别显式刷新，顺序和时间都不得消失。
  await refreshWorkspaceCatalog(page)
  await expectSessionRows(rows, orders.recent)
  await chooseSort(page, '创建时间')
  await expectSessionRows(rows, orders.created)
  await refreshWorkspaceCatalog(page)
  await expectSessionRows(rows, orders.created)
}

test('未归属会话在打开、切换与刷新后保持最近活动/创建排序', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const prefix = `排序未归属-${run}-`
  const orders = createSessionOrders(prefix)
  const sessions = await prepareSessions(request, orders.fixtures)

  await openApp(page)
  await exerciseSessionOrdering({
    page,
    rows: unassignedRows(page),
    prefix,
    sessions,
    orders,
    contextText: '未归属会话',
  })
})

test('工作区会话在打开、切换与刷新后保持最近活动/创建排序', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const prefix = `排序工作区-${run}-`
  const orders = createSessionOrders(prefix)
  const project = await createProject(request, `order-${run}`)
  const workspaceName = `排序工作区-${run}`
  const workspace = await createWorkspaceApi(request, workspaceName, [
    { alias: 'p', path: project.path },
  ])
  const sessions = await prepareSessions(request, orders.fixtures, workspace.id)

  await openApp(page)
  const group = workspaceGroup(page, workspaceName)
  await expect(group).toBeVisible()
  const expand = group.getByRole('button', { name: '展开工作区' })
  if ((await expand.count()) > 0) await expand.click()

  await exerciseSessionOrdering({
    page,
    rows: group.locator('[data-slot="huan-session-row"]'),
    prefix,
    sessions,
    orders,
    contextText: workspaceName,
  })
})
