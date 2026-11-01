/**
 * G1.4c 浏览器验收：模型认证面板。
 *
 * 真实宿主 + 真实 ModelRuntime + 合成原生 provider（临时 agentDir）。
 * 只使用合成密钥/授权码，不读取个人 auth.json，不访问真实 provider。
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { E2E_APP_URL, E2E_HOST_URL } from './config.js'
import { openApp } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const PROVIDER_ID = 'huan-auth-test'
const SYNTHETIC_KEY = 'synthetic-e2e-key'

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' })
const authDialog = (page: Page) => page.getByRole('dialog', { name: '模型认证' })
const providerRow = (page: Page) =>
  authDialog(page).locator(
    `[data-slot="huan-provider-auth-provider"][data-provider-id="${PROVIDER_ID}"]`,
  )
const result = (page: Page) =>
  authDialog(page).locator('[data-slot="huan-provider-auth-result"]').last()

async function openAuth(page: Page) {
  await page.getByRole('button', { name: '模型认证' }).click()
  await expect(authDialog(page)).toBeVisible()
  await expect(providerRow(page)).toBeVisible()
}

async function resetProviderAuth(request: APIRequestContext) {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/provider-auth/reset`)
  expect(response.ok()).toBe(true)
}

async function snapshotJson(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/pi/provider-auth')
    return response.text()
  })
}

test.beforeEach(async ({ request }) => {
  await resetProviderAuth(request)
})

test('顶栏与 /login 打开同一面板；未知 provider 不发送给模型', async ({ page }) => {
  await openApp(page)
  await openAuth(page)
  await expect(providerRow(page)).toContainText('认证测试 Provider')
  await page.keyboard.press('Escape')
  await expect(authDialog(page)).toHaveCount(0)

  // 未知 provider 只在本地提示，不产生用户消息。
  await messageInput(page).fill('/login not-a-real-provider')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(page.getByRole('status').filter({ hasText: '未知 provider' })).toBeVisible()
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveCount(0)

  // 已知 provider 打开同一面板并聚焦目标行。
  await messageInput(page).fill(`/login ${PROVIDER_ID}`)
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(authDialog(page)).toBeVisible()
  await expect(providerRow(page)).toHaveAttribute('data-focused', 'true')
})

test('API key 登录成功；密钥不出现在页面与认证快照，模型目录更新', async ({ page }) => {
  await openApp(page)
  await openAuth(page)
  await providerRow(page)
    .getByRole('button', { name: /测试 API key 登录/ })
    .click()
  await expect(authDialog(page).getByText('输入合成 API key')).toBeVisible()
  const secretInput = authDialog(page).getByLabel('认证密钥')
  // 先输入一个临时值再关闭：重新打开时输入必须已被清空，登录继续等待。
  await secretInput.fill('temporary-secret-not-submitted')
  await page.keyboard.press('Escape')
  await expect(authDialog(page)).toHaveCount(0)
  await openAuth(page)
  await expect(authDialog(page).getByLabel('认证密钥')).toHaveValue('')
  await authDialog(page).getByLabel('认证密钥').fill(SYNTHETIC_KEY)
  await authDialog(page).getByRole('button', { name: '提交' }).click()
  await expect(result(page)).toContainText('登录成功')
  await expect(providerRow(page).locator('[data-slot="huan-provider-auth-status"]')).toContainText(
    'API key',
  )
  await expect(authDialog(page).getByLabel('认证密钥')).toHaveCount(0)
  // 页面文本与认证快照都不包含合成密钥。
  expect(await page.content()).not.toContain(SYNTHETIC_KEY)
  expect(await snapshotJson(page)).not.toContain(SYNTHETIC_KEY)
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveCount(0)

  // 登录后模型选择器会按认证版本重读目录，合成模型进入可用列表。
  await page.keyboard.press('Escape')
  const composer = page.locator('[data-slot="aui_composer-shell"]')
  await composer.getByRole('combobox').click()
  await expect(page.getByRole('option', { name: /认证测试模型/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('OAuth 关闭重开保留进度；选择/授权链接/手动码完成后可退出', async ({ page }) => {
  await openApp(page)
  await openAuth(page)
  await providerRow(page)
    .getByRole('button', { name: /测试 OAuth 登录/ })
    .click()
  await expect(authDialog(page).getByText('选择授权方式')).toBeVisible()

  // 关闭视图不终止登录；重新打开仍能看到同一操作与提示。
  await page.keyboard.press('Escape')
  await expect(authDialog(page)).toHaveCount(0)
  await openAuth(page)
  await expect(authDialog(page)).toContainText('选择授权方式')

  await authDialog(page).getByRole('button', { name: '授权链接', exact: true }).click()
  const authLink = authDialog(page).getByRole('link', { name: /打开授权页/ })
  await expect(authLink).toHaveAttribute('href', 'http://127.0.0.1:9/oauth')
  // 链接只展示，不自动打开浏览器；页面仍停留在应用内。
  expect(new URL(page.url()).origin).toBe(new URL(E2E_APP_URL).origin)

  await authDialog(page).getByLabel('授权码').fill('test-code')
  await authDialog(page).getByRole('button', { name: '提交' }).click()
  await expect(result(page)).toContainText('登录成功')
  await expect(providerRow(page).locator('[data-slot="huan-provider-auth-status"]')).toContainText(
    'OAuth',
  )
  expect(await snapshotJson(page)).not.toContain('synthetic-access')
  expect(await snapshotJson(page)).not.toContain('synthetic-refresh')

  // 重开面板仍显示已配置；退出登录后状态更新为未配置。
  await page.keyboard.press('Escape')
  await openAuth(page)
  await expect(providerRow(page).locator('[data-slot="huan-provider-auth-status"]')).toContainText(
    'OAuth',
  )
  await providerRow(page).getByRole('button', { name: '退出登录' }).click()
  await expect(result(page)).toContainText('已退出登录')
  await expect(providerRow(page).locator('[data-slot="huan-provider-auth-status"]')).toContainText(
    '未配置',
  )
})

test('多窗口接管回填；显式取消使两窗立即看到取消结果', async ({ page, context }) => {
  await openApp(page)
  const second = await context.newPage()
  await openApp(second)
  try {
    await openAuth(page)
    await providerRow(page)
      .getByRole('button', { name: /测试 OAuth 登录/ })
      .click()
    await expect(authDialog(page).getByText('选择授权方式')).toBeVisible()

    // 第二窗口打开同一面板并完成“授权链接”选择。
    await openAuth(second)
    await expect(authDialog(second)).toContainText('选择授权方式')
    await authDialog(second).getByRole('button', { name: '授权链接', exact: true }).click()

    // 回到第一窗口：选择已生效，出现手动码；在两窗都可见。
    await expect(authDialog(page).getByLabel('授权码')).toBeVisible()
    await expect(authDialog(second).getByLabel('授权码')).toBeVisible()

    // 第二窗口点击取消，第一窗口同步显示取消结果。
    await authDialog(second).getByRole('button', { name: '取消认证' }).click()
    await expect(result(second)).toContainText('取消')
    await expect(result(page)).toContainText('取消')
    await expect(
      providerRow(page).locator('[data-slot="huan-provider-auth-status"]'),
    ).toContainText('未配置')
  } finally {
    await second.close()
  }
})
