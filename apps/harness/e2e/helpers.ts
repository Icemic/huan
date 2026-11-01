import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { DEFAULT_TEST_REPLY, E2E_HOST_URL } from './config.js'

/** 合成模型的默认回复。 */
export const DEFAULT_REPLY = DEFAULT_TEST_REPLY

export const assistantMessages = (page: Page) =>
  page.locator('[data-slot="aui_assistant-message-root"]')

export const userMessages = (page: Page) => page.locator('[data-slot="aui_user-message-root"]')

/** 打开页面并等待宿主状态区渲染（空白页即可见）。 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Pi host status' })).toBeVisible()
}

/** 从输入区的模型选择器选一个宿主真实注册表中的模型。 */
export async function selectModel(page: Page, name = 'Test Model A'): Promise<void> {
  const composer = page.locator('[data-slot="aui_composer-shell"]')
  await composer.getByRole('combobox').click()
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await expect(composer.getByRole('combobox')).toContainText(name)
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message input' }).fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
}

/** 会话列表项（按标题定位，避免依赖列表顺序）。 */
export const threadListItem = (page: Page, title: string) =>
  page.locator('[data-slot="huan-session-trigger"]').filter({ hasText: title })

/** 会话行（含操作按钮与副行信息）。 */
export const sessionRow = (page: Page, title: string) =>
  page.locator('[data-slot="huan-session-row"]').filter({ hasText: title })

/** 经会话操作菜单重命名（侧栏与宿主列表都应以新名称刷新）。 */
export async function renameThread(page: Page, title: string, nextTitle: string): Promise<void> {
  const row = sessionRow(page, title)
  await row.hover()
  await row.getByRole('button', { name: '会话操作' }).click()
  await page.getByRole('button', { name: '重命名', exact: true }).click()
  const input = page.getByRole('textbox', { name: '重命名会话' })
  await input.fill(nextTitle)
  await input.press('Enter')
  await expect(threadListItem(page, nextTitle)).toBeVisible()
}

/** 工作区分组（按显示名称定位）。 */
export const workspaceGroup = (page: Page, name: string) =>
  page.locator('[data-slot="huan-workspace-group"]').filter({ hasText: name })

/** 在当前展开的工作区（或指定工作区）开始一个空白新会话。 */
export async function startNewSession(page: Page, workspaceName?: string): Promise<void> {
  const group = workspaceName
    ? workspaceGroup(page, workspaceName)
    : page.locator('[data-slot="huan-workspace-group"]').first()
  await group.getByRole('button', { name: '新建会话', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '开始新会话' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible()
  // 新会话必须真正切到空白线程，否则首条消息会落到旧会话。
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveCount(0)
}

/** 直接经真实 HTTP 路由创建工作区（用于准备多工作区场景）。 */
export async function createWorkspaceApi(
  request: APIRequestContext,
  name: string,
  projects: Array<{ alias: string; path: string }>,
) {
  const response = await request.post(`${E2E_HOST_URL}/api/pi/workspaces`, {
    data: { name, projects },
  })
  await expectOk(response)
  const result = (await response.json()) as
    | { ok: true; workspace: { id: string; name: string; revision: number } }
    | { ok: false; error: string }
  if (!result.ok) throw new Error(`创建工作区失败：${result.error}`)
  return result.workspace
}

/** 读取/恢复工作区 state.json（损坏文件场景使用）。 */
export async function workspaceState(request: APIRequestContext): Promise<string | null> {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/workspace-state`)
  await expectOk(response)
  return ((await response.json()) as { content: string | null }).content
}

export async function writeWorkspaceState(
  request: APIRequestContext,
  content: string | null,
): Promise<void> {
  await expectOk(
    await request.put(`${E2E_HOST_URL}/__e2e__/workspace-state`, { data: { content } }),
  )
}

async function expectOk(response: Awaited<ReturnType<APIRequestContext['post']>>) {
  expect(response.ok()).toBe(true)
}

export async function controlInfo(request: APIRequestContext) {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/info`)
  await expectOk(response)
  return (await response.json()) as {
    workspacePath: string
    agentDir: string
  }
}

export async function subscriptions(request: APIRequestContext) {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/subscriptions`)
  await expectOk(response)
  return (await response.json()) as { totalSubscriptions: number; activeSubscriptions: number }
}

/** 配置下一次模型响应：分段输出，每段需显式释放，结束需显式完成。 */
export async function configureStream(
  request: APIRequestContext,
  segments: string[],
): Promise<void> {
  await expectOk(await request.post(`${E2E_HOST_URL}/__e2e__/stream`, { data: { segments } }))
}

export async function releaseSegment(request: APIRequestContext): Promise<void> {
  await expectOk(await request.post(`${E2E_HOST_URL}/__e2e__/stream/release`))
}

export async function finishStream(request: APIRequestContext): Promise<void> {
  await expectOk(await request.post(`${E2E_HOST_URL}/__e2e__/stream/finish`))
}

/** 断开宿主侧连接，模拟回复期间的事件流中断。 */
export async function disconnectClients(request: APIRequestContext): Promise<void> {
  await expectOk(await request.post(`${E2E_HOST_URL}/__e2e__/disconnect`))
}

export async function resetStream(request: APIRequestContext): Promise<void> {
  await expectOk(await request.post(`${E2E_HOST_URL}/__e2e__/stream/reset`))
}

export async function streamState(request: APIRequestContext) {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/stream`)
  await expectOk(response)
  return (await response.json()) as { completed: number; active: boolean }
}

/** 由宿主临时根创建的隔离项目；marker 仅在写入项目扩展时存在。 */
export type E2eProject = {
  path: string
  name: string
  marker?: string
}

/** 创建隔离项目（可选项目扩展探针/项目 settings/启动期交互标记）。 */
export async function createProject(
  request: APIRequestContext,
  name: string,
  options: {
    extension?: boolean
    settings?: Record<string, unknown>
    askTrust?: boolean
    askStartup?: boolean
  } = {},
): Promise<E2eProject> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/projects`, {
    data: { name, ...options },
  })
  await expectOk(response)
  return (await response.json()) as E2eProject
}
