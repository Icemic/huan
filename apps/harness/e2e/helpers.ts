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

/** 线程列表项（按标题定位，避免依赖列表顺序）。 */
export const threadListItem = (page: Page, title: string) =>
  page.locator('[data-slot="aui_thread-list-item-trigger"]').filter({ hasText: title })

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
