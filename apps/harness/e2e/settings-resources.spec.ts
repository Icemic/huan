/**
 * G1.4a 浏览器验收：设置与资源面板。
 *
 * 真实宿主/路由 + 隔离临时用户空间；资源文本只在显式查询时出现。
 * 设置文件控制端点仅存在于测试启动器，用于制造外部修改与核对写盘结果。
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import { createProject, createWorkspaceApi, openApp } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' })
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: '设置与资源' })
const jsonEditor = (page: Page) => settingsDialog(page).getByRole('textbox', { name: '设置 JSON' })
const notice = (page: Page) => settingsDialog(page).locator('[data-slot="huan-settings-notice"]')

async function readSettingsFile(
  request: APIRequestContext,
  scope: 'user' | 'project' = 'user',
  projectPath?: string,
): Promise<string | null> {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/settings-file`, {
    params: { scope, ...(projectPath ? { projectPath } : {}) },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { content: string | null }).content
}

async function writeSettingsFile(
  request: APIRequestContext,
  content: string | null,
  scope: 'user' | 'project' = 'user',
  projectPath?: string,
): Promise<void> {
  const response = await request.put(`${E2E_HOST_URL}/__e2e__/settings-file`, {
    data: { scope, ...(projectPath ? { projectPath } : {}), content },
  })
  expect(response.ok()).toBe(true)
}

/** 打开面板并切到指定视图。 */
async function openSettings(page: Page, tab: '常用项' | 'JSON 原文' | '资源清单') {
  await page.getByRole('button', { name: '设置与资源' }).click()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: tab }).click()
  return dialog
}

test('顶栏与 /settings 打开同一面板，资源来自真实 loader 且文本按需加载', async ({
  page,
  request,
}) => {
  await openApp(page)
  const dialog = await openSettings(page, 'JSON 原文')
  await expect(jsonEditor(page)).toHaveValue(/"defaultProvider"/)
  await expect(dialog.getByRole('tab', { name: /编辑用户设置/ })).toBeVisible()

  await dialog.getByRole('tab', { name: '资源清单' }).click()
  await expect(dialog.getByText(/command-probe\.js/).first()).toBeVisible()
  // 文本只在显式请求时获取：按钮切换到“隐藏”即证明走了 includeText 查询。
  await dialog.getByRole('button', { name: '显示指令与系统提示文本' }).click()
  await expect(dialog.getByRole('button', { name: '隐藏指令与系统提示文本' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // /settings 复用同一面板，不创建用户消息。
  await messageInput(page).fill('/settings')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(settingsDialog(page)).toBeVisible()
  await expect(page.locator('[data-slot="aui_user-message-root"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settingsDialog(page)).toHaveCount(0)
  await expect(messageInput(page)).toHaveValue('')

  // 控制端点仍可用（用于后续用例核对写盘）。
  expect(await readSettingsFile(request)).toContain('defaultProvider')
})

test('常用项与 JSON 保存写盘、保留未知字段，非法类型被拒绝', async ({ page, request }) => {
  const original = await readSettingsFile(request)
  try {
    await openApp(page)
    const dialog = await openSettings(page, '常用项')
    await dialog.getByLabel('默认模型 ID').fill('test-model-b')
    await dialog.getByRole('button', { name: '保存设置' }).click()
    await expect(notice(page)).toContainText('已保存')
    await expect(notice(page)).toContainText('待重载')
    const afterCommon = JSON.parse((await readSettingsFile(request)) ?? '{}') as Record<
      string,
      unknown
    >
    expect(afterCommon.defaultModel).toBe('test-model-b')

    // JSON：整份文件语义，未知字段写入磁盘。
    await dialog.getByRole('tab', { name: 'JSON 原文' }).click()
    const current = JSON.parse(await jsonEditor(page).inputValue()) as Record<string, unknown>
    const withUnknown = { ...current, e2eUnknown: { nested: true } }
    await jsonEditor(page).fill(`${JSON.stringify(withUnknown, null, 2)}\n`)
    await dialog.getByRole('button', { name: '保存设置' }).click()
    await expect(notice(page)).toContainText('已保存')
    const afterJson = JSON.parse((await readSettingsFile(request)) ?? '{}') as Record<
      string,
      unknown
    >
    expect(afterJson.e2eUnknown).toEqual({ nested: true })
    expect(afterJson.defaultModel).toBe('test-model-b')

    // 非法已知字段：宿主拒绝且磁盘保持上一次有效内容。
    const invalid = { ...afterJson, retry: { enabled: 'yes' } }
    await jsonEditor(page).fill(`${JSON.stringify(invalid, null, 2)}\n`)
    await dialog.getByRole('button', { name: '保存设置' }).click()
    await expect(dialog.locator('[data-slot="huan-settings-issues"]')).toContainText(
      '/retry/enabled',
    )
    const afterInvalid = JSON.parse((await readSettingsFile(request)) ?? '{}') as Record<
      string,
      unknown
    >
    expect(afterInvalid.retry).toBeUndefined()
    expect(afterInvalid.e2eUnknown).toEqual({ nested: true })
  } finally {
    await writeSettingsFile(request, original)
  }
})

test('外部修改导致保存冲突，重新加载后可继续', async ({ page, request }) => {
  const original = await readSettingsFile(request)
  try {
    await openApp(page)
    await openSettings(page, 'JSON 原文')
    const current = JSON.parse((await jsonEditor(page).inputValue()) as string) as Record<
      string,
      unknown
    >
    await jsonEditor(page).fill(`${JSON.stringify({ ...current, conflictDraft: true }, null, 2)}\n`)

    // 模拟另一个窗口/进程修改同一文件。
    const external = {
      ...(JSON.parse(original ?? '{}') as Record<string, unknown>),
      externalChange: true,
    }
    await writeSettingsFile(request, `${JSON.stringify(external, null, 2)}\n`)

    await settingsDialog(page).getByRole('button', { name: '保存设置' }).click()
    await expect(notice(page)).toContainText('保存冲突')
    await settingsDialog(page).getByRole('button', { name: '重新加载设置与资源' }).click()
    await expect(jsonEditor(page)).toHaveValue(/"externalChange": true/)
  } finally {
    await writeSettingsFile(request, original)
  }
})

test('切换作用域保留未保存草稿', async ({ page, request }) => {
  const originalUser = await readSettingsFile(request)
  const originalProject = await readSettingsFile(request, 'project')
  try {
    await openApp(page)
    const dialog = await openSettings(page, 'JSON 原文')
    const userValue = JSON.parse(await jsonEditor(page).inputValue()) as Record<string, unknown>
    await jsonEditor(page).fill(`${JSON.stringify({ ...userValue, userDraft: 1 }, null, 2)}\n`)
    await expect(dialog.locator('[data-slot="huan-settings-unsaved"]')).toBeVisible()

    await dialog.getByRole('tab', { name: /编辑项目设置/ }).click()
    await expect(jsonEditor(page)).not.toHaveValue(/"userDraft"/)
    await jsonEditor(page).fill('{"projectDraft":1}\n')

    await dialog.getByRole('tab', { name: /编辑用户设置/ }).click()
    await expect(jsonEditor(page)).toHaveValue(/"userDraft": 1/)
    await expect(
      dialog
        .getByRole('tab', { name: /编辑用户设置/ })
        .locator('[data-slot="huan-settings-dirty"]'),
    ).toBeVisible()

    // 重新加载丢弃草稿（保留磁盘原文）。
    await dialog.getByRole('button', { name: '重新加载设置与资源' }).click()
    await expect(jsonEditor(page)).not.toHaveValue(/"userDraft"/)
    await dialog.getByRole('tab', { name: /编辑项目设置/ }).click()
    await expect(jsonEditor(page)).toHaveValue('{"projectDraft":1}\n')
  } finally {
    await writeSettingsFile(request, originalUser)
    await writeSettingsFile(request, originalProject, 'project')
  }
})

test('未信任项目的项目设置不可编辑', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `settings-untrusted-${run}`, {
    settings: { defaultModel: 'test-model-b' },
  })
  const name = `设置未信任-${run}`
  await createWorkspaceApi(request, name, [{ alias: 'alpha', path: project.path }])
  await openApp(page)
  // 新建会话对话框会先要求信任决定；本次拒绝后仍可进入空白页（项目资源不加载）。
  await page
    .locator('[data-slot="huan-workspace-group"]')
    .filter({ hasText: name })
    .getByRole('button', { name: '新建会话', exact: true })
    .click()
  const newSession = page.getByRole('dialog', { name: '新建会话' })
  await expect(newSession).toBeVisible()
  await newSession.getByRole('button', { name: '开始新会话' }).click()
  await newSession.getByRole('button', { name: '本次拒绝' }).click()
  await expect(newSession).toHaveCount(0)
  const dialog = await openSettings(page, '常用项')
  await expect(dialog.locator('[data-slot="huan-settings-target"]')).toContainText(project.path)
  await expect(dialog).toContainText('项目未信任：不读取也不写入项目设置')
  await expect(dialog.getByRole('tab', { name: /编辑项目设置/ })).toBeDisabled()
  // 用户设置仍可编辑。
  await expect(dialog.getByRole('tab', { name: /编辑用户设置/ })).toBeEnabled()
})
