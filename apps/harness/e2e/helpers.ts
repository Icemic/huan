import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { DEFAULT_TEST_REPLY, E2E_HOST_URL } from './config.js'

/** 合成模型的默认回复。 */
export const DEFAULT_REPLY = DEFAULT_TEST_REPLY

/** 助手消息行（最终组件的稳定标记，不依赖旧 aui DOM）。 */
export const assistantMessages = (page: Page) =>
  page.locator('[data-slot="huan-message"][data-role="assistant"]')

/** 用户消息行。 */
export const userMessages = (page: Page) =>
  page.locator('[data-slot="huan-message"][data-role="user"]')

/** 输入框（最终组件使用中文可访问名）。 */
export const messageInput = (page: Page) => page.getByRole('textbox', { name: '消息输入' })

/** 发送按钮。 */
export const sendButton = (page: Page) => page.getByRole('button', { name: '发送消息' })

/** 等待页面完成宿主信息与目标解析，输入框可用。 */
export async function waitForApp(page: Page): Promise<void> {
  await expect(page.locator('[data-slot="huan-header"]')).toBeVisible()
  await expect(messageInput(page)).toBeVisible()
  await expect(messageInput(page)).toBeEnabled()
}

/** 打开页面并等待应用就绪（空白页即可用）。 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  await waitForApp(page)
}

/** 从输入区的模型选择器选一个宿主真实注册表中的模型。 */
export async function selectModel(page: Page, name = 'Test Model A'): Promise<void> {
  const trigger = page.locator('[data-slot="huan-composer"]').getByRole('combobox')
  await trigger.click()
  await page.locator('[data-slot="model-selector-content"]').getByRole('option', { name }).click()
  await expect(trigger).toContainText(name)
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await messageInput(page).fill(text)
  await sendButton(page).click()
}

/** 会话上下文条的单一操作菜单入口。 */
export const sessionActionsTrigger = (page: Page) =>
  page
    .locator('[data-slot="huan-session-context"]')
    .getByRole('button', { name: '会话操作', exact: true })

/** 打开会话操作菜单并返回弹层。 */
export async function openSessionActions(page: Page) {
  await sessionActionsTrigger(page).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

/** 从会话操作菜单选择一项；弹层打开由菜单项动作负责。 */
export async function chooseSessionAction(page: Page, name: string): Promise<void> {
  const menu = await openSessionActions(page)
  await menu.getByRole('menuitem', { name, exact: true }).click()
}

/** 会话列表项（按标题定位，避免依赖列表顺序）。 */
export const threadListItem = (page: Page, title: string) =>
  page.locator('[data-slot="huan-session-trigger"]').filter({ hasText: title })

/** 会话行（含操作按钮与副行信息）。 */
export const sessionRow = (page: Page, title: string) =>
  page.locator('[data-slot="huan-session-row"]').filter({ hasText: title })

/** 经会话详情重命名（侧栏与宿主列表都应以新名称刷新）。 */
export async function renameThread(page: Page, title: string, nextTitle: string): Promise<void> {
  await threadListItem(page, title).click()
  await chooseSessionAction(page, '详情')
  const dialog = page.getByRole('dialog', { name: '会话详情' })
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole('textbox', { name: '会话名称' })
  await input.fill(nextTitle)
  await dialog.getByRole('button', { name: '保存名称' }).click()
  await expect(dialog.getByRole('status')).toContainText('会话已命名')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
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
  await expect(messageInput(page)).toBeVisible()
  // 新会话必须真正切到空白线程，否则首条消息会落到旧会话。
  await expect(userMessages(page)).toHaveCount(0)
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
