/**
 * G1.4a 浏览器验收：设置与资源面板。
 *
 * 真实宿主/路由 + 隔离临时用户空间；资源文本只在显式查询时出现。
 * 设置文件控制端点仅存在于测试启动器，用于制造外部修改与核对写盘结果。
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  openApp,
  selectModel,
  sendMessage,
  startNewSession,
  workspaceGroup,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

const messageInput = (page: Page) => page.getByRole('textbox', { name: '消息输入' })
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

/** 按标题读取当前会话 ID（显式刷新作用域缓存）。 */
async function threadIdByTitle(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(response.ok()).toBe(true)
  const threads = (await response.json()) as Array<{ id: string; title?: string }>
  const hit = threads.find((thread) => thread.title === title)
  if (!hit) throw new Error(`未找到会话：${title}`)
  return hit.id
}

/** 最小资源快照形状（只声明本用例断言的字段）。 */
type ResourceSnapshot = {
  loadedFrom: 'session' | 'assembly'
  projectResourcesLoaded: boolean
  instructions: readonly { path: string; bytes: number; text?: string }[]
  systemPrompt?: {
    source?: string
    bytes: number
    text?: string
    append: readonly { source?: string; bytes: number; text?: string }[]
  }
}

async function getResources(
  request: APIRequestContext,
  params: Record<string, string>,
): Promise<ResourceSnapshot> {
  const response = await request.get(
    `${E2E_HOST_URL}/api/pi/resources?${new URLSearchParams(params)}`,
  )
  expect(response.ok()).toBe(true)
  return (await response.json()) as ResourceSnapshot
}

/** 写入临时项目内的文件（项目路径由测试启动器创建，属于隔离根内）。 */
async function writeProjectFile(
  projectPath: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = join(projectPath, ...relative.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/** 在管理工作区弹层完成项目信任决定（本次允许），不写持久信任。 */
async function trustWorkspaceProject(page: Page, workspaceName: string): Promise<void> {
  await workspaceGroup(page, workspaceName).getByRole('button', { name: '管理工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '管理工作区' })
  await expect(dialog.getByText('需要信任决定')).toBeVisible()
  await dialog.getByRole('button', { name: '决定信任' }).click()
  await dialog.getByRole('button', { name: '本次允许' }).click()
  await expect(dialog.getByText('已信任')).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
}

test('顶栏与 /settings 打开同一面板，资源来自真实 loader', async ({ page, request }) => {
  await openApp(page)
  const dialog = await openSettings(page, 'JSON 原文')
  await expect(jsonEditor(page)).toHaveValue(/"defaultProvider"/)
  await expect(dialog.getByRole('tab', { name: /编辑用户设置/ })).toBeVisible()

  await dialog.getByRole('tab', { name: '资源清单' }).click()
  // 资源清单来自真实 loader：扩展路径与命令/工具计数的实际内容。
  await expect(dialog.getByText(/command-probe\.js/).first()).toBeVisible()
  await expect(dialog.getByText(/命令 3，工具 4/).first()).toBeVisible()
  // 正文按需加载由下方独立用例核对：显式 includeText 与 GUI 显示/隐藏。
  await expect(dialog.getByRole('button', { name: '显示指令/系统提示文本' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // /settings 复用同一面板，不创建用户消息。
  await messageInput(page).fill('/settings')
  await messageInput(page).press('Escape')
  await messageInput(page).press('Enter')
  await expect(settingsDialog(page)).toBeVisible()
  await expect(page.locator('[data-slot="huan-message"][data-role="user"]')).toHaveCount(0)
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

test('资源正文按需加载：显式 includeText 返回真实 system prompt，GUI 显示后隐藏清空', async ({
  page,
  request,
}) => {
  const run = Date.now().toString(36)
  const marker = `E2E-SYSTEM-PROMPT-${run}`
  const project = await createProject(request, `prompt-text-${run}`)
  // 真实 system prompt 来自项目 SYSTEM.md（隔离临时项目内），不是个人/祖先资源；
  // noContextFiles 仍然保持开启，不能为了读取指令正文而关闭隔离。
  await writeProjectFile(
    project.path,
    '.pi/SYSTEM.md',
    `# E2E 系统提示\n${marker}\n这行文本只在显式请求资源正文时返回。\n`,
  )
  const seen = join(project.path, 'prompt-seen.marker')
  const missing = join(project.path, 'prompt-missing.marker')
  // 专属项目扩展：真实运行一次，确认 session 的 system prompt 含有同一段资源文本；
  // 并返回带固定 marker 的系统提示，证明该返回值只作用于本次运行（不进入资源清单）。
  await writeProjectFile(
    project.path,
    '.pi/extensions/prompt-probe.js',
    `import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('before_agent_start', (event) => {
    if (!event.systemPrompt.includes(${JSON.stringify(marker)})) {
      appendFileSync(${JSON.stringify(missing)}, 'missing\\n')
      return
    }
    appendFileSync(${JSON.stringify(seen)}, 'seen\\n')
    return { systemPrompt: event.systemPrompt + '\\n\\nE2E-RUN-PROMPT-APPEND' }
  })
}
`,
  )
  const workspaceName = `资源正文工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])

  await openApp(page)
  await trustWorkspaceProject(page, workspaceName)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  const title = `资源正文-${run}`
  await sendMessage(page, title)
  await expect.poll(() => existsSync(seen), { timeout: 20_000 }).toBe(true)
  expect(existsSync(missing)).toBe(false)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  const threadId = await threadIdByTitle(request, title)
  // 普通查询只有字节数，没有任何正文（包括 marker）。
  const bare = await getResources(request, { threadId })
  expect(bare.loadedFrom).toBe('session')
  expect(bare.projectResourcesLoaded).toBe(true)
  expect(bare.instructions).toEqual([])
  expect(bare.systemPrompt?.bytes).toBeGreaterThan(0)
  expect(bare.systemPrompt?.text).toBeUndefined()
  expect(JSON.stringify(bare)).not.toContain(marker)

  // 显式 includeText 才返回正文；来源是项目 SYSTEM.md。
  const withText = await getResources(request, { threadId, includeText: 'true' })
  expect(withText.systemPrompt?.source).toContain('SYSTEM.md')
  expect(withText.systemPrompt?.text).toContain(marker)
  // 扩展强制提示属于单次运行，不得混入“已加载资源”正文。
  expect(withText.systemPrompt?.text).not.toContain('E2E-RUN-PROMPT-APPEND')

  // GUI：打开时不显示正文，点击“显示”后出现 marker，点击“隐藏”后文本真的被清除。
  const dialog = await openSettings(page, '资源清单')
  await expect(dialog.getByText(/System prompt/)).toBeVisible()
  await expect(dialog.getByText(marker)).toHaveCount(0)
  await dialog.getByRole('button', { name: '显示指令/系统提示文本' }).click()
  await expect(dialog.getByRole('button', { name: '隐藏指令/系统提示文本' })).toBeVisible()
  await expect(dialog.getByText(marker)).toBeVisible()
  await dialog.getByRole('button', { name: '隐藏指令/系统提示文本' }).click()
  await expect(dialog.getByRole('button', { name: '显示指令/系统提示文本' })).toBeVisible()
  await expect(dialog.getByText(marker)).toHaveCount(0)
})
