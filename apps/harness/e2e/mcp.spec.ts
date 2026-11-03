/**
 * G1.4d4 浏览器验收：MCP 管理面板。
 *
 * 使用隔离临时用户空间、真实宿主路由与真实 Pi SDK；MCP 服务来自 e2e 本地
 * stdio/OAuth fixture。每个用例使用独立项目与临时 mcp.json，结束清理，
 * 不写全局默认 MCP 配置，也不访问公网或付费模型。
 */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessMcpAuthSnapshot } from '@huan/protocol'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  configureStream,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  finishStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  userMessages,
  workspaceGroup,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.afterEach(async ({ request }) => {
  await resetStream(request).catch(() => {})
})

async function captureMcp(page: Page, name: string): Promise<void> {
  await mkdir('test-results/mcp-review', { recursive: true })
  await page.screenshot({ path: `test-results/mcp-review/${name}.png` })
  const overflow = await mcpDialog(page).evaluate(
    (element) => element.scrollWidth > element.clientWidth + 2,
  )
  expect(overflow).toBe(false)
}

const mcpDialog = (page: Page) => page.getByRole('dialog', { name: 'MCP 服务器' })
const messageInput = (page: Page) => page.getByRole('textbox', { name: '消息输入' })

type FixtureInfo = {
  stdioFixturePath: string
  oauthOrigin: string
  oauthResourceUrl: string
  nodePath: string
}

async function fixtureInfo(request: APIRequestContext): Promise<FixtureInfo> {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/mcp-fixture`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as FixtureInfo
}

async function trustProject(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/api/pi/projects/trust`, {
    data: { path, trusted: true, remember: false },
  })
  expect(response.ok()).toBe(true)
}

async function writeProjectMcp(
  request: APIRequestContext,
  projectPath: string,
  content: string | null,
): Promise<void> {
  const response = await request.put(`${E2E_HOST_URL}/__e2e__/mcp-file`, {
    data: { scope: 'project', projectPath, content },
  })
  expect(response.ok()).toBe(true)
}

async function readProjectMcp(
  request: APIRequestContext,
  projectPath: string,
): Promise<string | null> {
  const response = await request.get(`${E2E_HOST_URL}/__e2e__/mcp-file`, {
    params: { scope: 'project', projectPath },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { content: string | null }).content
}

async function writeUserMcp(request: APIRequestContext, content: string | null): Promise<void> {
  const response = await request.put(`${E2E_HOST_URL}/__e2e__/mcp-file`, {
    data: { scope: 'user', content },
  })
  expect(response.ok()).toBe(true)
}

async function openMcp(page: Page): Promise<ReturnType<typeof mcpDialog>> {
  await page.getByRole('button', { name: 'MCP 服务器' }).click()
  const dialog = mcpDialog(page)
  await expect(dialog).toBeVisible()
  return dialog
}

async function openConfigTab(
  page: Page,
  scope: 'project' | 'user',
): Promise<ReturnType<typeof mcpDialog>> {
  const dialog = await openMcp(page)
  await dialog.getByRole('tab', { name: 'MCP 配置' }).click()
  const scopeTab = dialog.getByRole('tab', {
    name: scope === 'project' ? '编辑项目 MCP 配置' : '编辑用户 MCP 配置',
  })
  await expect(scopeTab).toBeEnabled()
  await scopeTab.click()
  return dialog
}

async function openJsonView(_page: Page, dialog: ReturnType<typeof mcpDialog>): Promise<void> {
  await dialog.getByRole('tab', { name: 'MCP JSON 原文' }).click()
}

async function openServersTab(_page: Page, dialog: ReturnType<typeof mcpDialog>): Promise<void> {
  await dialog.getByRole('tab', { name: 'MCP 服务器列表' }).click()
}

async function applyReload(_page: Page, dialog: ReturnType<typeof mcpDialog>): Promise<void> {
  await dialog.getByRole('button', { name: '应用 MCP 资源重载' }).click()
  await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('已应用资源重载')
}

async function saveConfig(_page: Page, dialog: ReturnType<typeof mcpDialog>): Promise<void> {
  await dialog.getByRole('button', { name: '保存 MCP 配置' }).click()
  await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('已保存')
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readPid(path: string): number | undefined {
  const text = readText(path).trim()
  if (!text) return undefined
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Windows 下 webServer 会被强制结束；测试自行回收 stdio fixture，避免锁住临时目录。 */
async function stopFixture(pidFile: string): Promise<void> {
  const pid = readPid(pidFile)
  if (!pid) return
  try {
    process.kill(pid)
  } catch {
    // 已退出时忽略。
  }
  for (let attempt = 0; attempt < 100 && processAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function configureTurns(
  request: APIRequestContext,
  turns: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }>,
): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns },
  })
  expect(response.ok()).toBe(true)
}

/** 创建一个可信项目、工作区与 live 会话；返回项目路径与工作区名。 */
async function createLiveSession(
  page: Page,
  request: APIRequestContext,
  label: string,
): Promise<{ projectPath: string; workspaceName: string }> {
  const run = Date.now().toString(36)
  const project = await createProject(request, `${label}-${run}`)
  await trustProject(request, project.path)
  const workspaceName = `MCP-${label}-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'mcp', path: project.path }])
  await openApp(page)
  await expect(workspaceGroup(page, workspaceName)).toBeVisible()
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `初始化 ${label}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  return { projectPath: project.path, workspaceName }
}

test('顶栏与 /mcp 打开同一面板，未知子命令不发模型', async ({ page }) => {
  await openApp(page)
  const dialog = await openMcp(page)
  await expect(dialog.getByRole('tab', { name: 'MCP 服务器列表' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await messageInput(page).fill('/mcp')
  await messageInput(page).press('Enter')
  await expect(mcpDialog(page)).toBeVisible()
  await expect(userMessages(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(messageInput(page)).toHaveValue('')

  // 未知子命令保留输入并给出受控提示，不把文本发给模型。
  await messageInput(page).fill('/mcp bogus demo')
  await messageInput(page).press('Enter')
  await expect(page.locator('[data-slot="huan-composer-notice"]')).toContainText('未知 /mcp 子命令')
  await expect(messageInput(page)).toHaveValue('/mcp bogus demo')
  await expect(userMessages(page)).toHaveCount(0)
  await messageInput(page).fill('')

  // 未知服务器只给受控提示，不把名称发给模型。
  await messageInput(page).fill('/mcp login missing')
  await messageInput(page).press('Enter')
  await expect(mcpDialog(page)).toBeVisible()
  await expect(mcpDialog(page).locator('[data-slot="huan-mcp-notice"]')).toContainText(
    '未知 MCP 服务器',
  )
  await expect(userMessages(page)).toHaveCount(0)
})

test('配置保存不连接，显式重载后真实调用工具/资源、动态工具与重载回收', async ({
  page,
  request,
}) => {
  const run = Date.now().toString(36)
  const { projectPath } = await createLiveSession(page, request, 'stdio')
  const fixture = await fixtureInfo(request)
  const pidFile = join(projectPath, `mcp-${run}.pid`)
  const sideEffectFile = join(projectPath, `mcp-${run}-side-effects.txt`)
  const resourceReadFile = join(projectPath, `mcp-${run}-resources.txt`)

  try {
    let dialog = await openConfigTab(page, 'project')
    await dialog.getByRole('button', { name: '新增 stdio 服务器' }).click()
    await dialog.getByLabel('服务器名称').fill('fixture')
    await dialog.getByLabel('stdio 命令').fill(fixture.nodePath)
    await dialog.getByLabel('stdio 参数').fill(fixture.stdioFixturePath)
    await dialog.getByRole('combobox', { name: '服务器 exposure' }).click()
    await page.getByRole('option', { name: 'direct', exact: true }).click()
    await dialog
      .getByLabel('环境变量')
      .fill(
        [
          `FIXTURE_PID_FILE=${pidFile}`,
          `FIXTURE_SIDE_EFFECT_FILE=${sideEffectFile}`,
          `FIXTURE_RESOURCE_READ_FILE=${resourceReadFile}`,
        ].join('\n'),
      )
    await dialog.getByRole('button', { name: '保存服务器' }).click()
    await expect(
      dialog.locator('[data-slot="huan-mcp-draft-server"][data-server-name="fixture"]'),
    ).toBeVisible()
    await saveConfig(page, dialog)
    await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('保存不会自动连接')

    // 保存 ≠ 连接：配置已落盘，但 live manager 尚未启动 fixture。
    expect(await readProjectMcp(request, projectPath)).toContain('fixture')
    await openServersTab(page, dialog)
    let row = dialog.locator('[data-slot="huan-mcp-server"][data-server-name="fixture"]')
    await expect(row).toHaveAttribute('data-state', 'not-connected')
    expect(readPid(pidFile)).toBeUndefined()

    await applyReload(page, dialog)
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 20_000 }).toBe('connected')
    const firstPid = await expect
      .poll(() => readPid(pidFile), { timeout: 20_000 })
      .toBeGreaterThan(0)
    void firstPid
    const pid = readPid(pidFile)
    expect(pid).toBeDefined()

    // 显式选择服务器才读取工具/资源目录（不执行工具、不读正文）。
    await dialog.getByRole('button', { name: '查看 fixture 详情' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-tool"][data-tool-name="echo"]')).toBeVisible()
    await captureMcp(page, 'servers-light')
    await page.evaluate(() => {
      document.documentElement.classList.add('dark', 'one-dark')
    })
    await captureMcp(page, 'servers-dark')
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark', 'one-dark')
    })
    await expect(
      dialog.locator('[data-slot="huan-mcp-resource"]').filter({ hasText: 'resource://fixture/0' }),
    ).toBeVisible()

    // 关闭弹层后模型运行才能操作输入区。
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // 确定性模型调用真实 MCP 工具与资源工具。
    await configureTurns(request, [
      { tool: { name: 'mcp__fixture__side_effect', args: {} } },
      {
        tool: {
          name: 'read_mcp_resource',
          args: { server: 'fixture', uri: 'resource://fixture/0' },
        },
      },
      { text: 'MCP完成' },
    ])
    await sendMessage(page, '调用 MCP 工具与资源')
    await expect(assistantMessages(page).last()).toContainText('MCP完成', { timeout: 30_000 })
    await expect.poll(() => readText(sideEffectFile)).toContain('side-effect')
    await expect.poll(() => readText(resourceReadFile)).toContain('resource://fixture/0')

    // 动态工具经 list_changed 扩展，并在详情中暴露本会话 exposure。
    await configureTurns(request, [
      { tool: { name: 'mcp__fixture__add_dynamic_tool', args: {} } },
      { text: '动态完成' },
    ])
    await sendMessage(page, '添加动态工具')
    await expect(assistantMessages(page).last()).toContainText('动态完成', { timeout: 30_000 })
    // 服务器/认证视图不会请求含秘密的配置原文。
    let configReads = 0
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/pi/mcp/config'))
        configReads += 1
    })
    dialog = await openMcp(page)
    row = dialog.locator('[data-slot="huan-mcp-server"][data-server-name="fixture"]')
    await openServersTab(page, dialog)
    expect(configReads).toBe(0)
    await expect(row).toContainText('6 工具', { timeout: 20_000 })
    await dialog.getByRole('button', { name: '查看 fixture 详情' }).click()
    const dynamicRow = dialog.locator('[data-slot="huan-mcp-tool"][data-tool-name="dynamic_tool"]')
    await expect(dynamicRow).toBeVisible()
    await dynamicRow.getByRole('combobox', { name: '工具 dynamic_tool exposure' }).click()
    await page.getByRole('option', { name: 'hidden', exact: true }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('本会话临时应用')
    await expect(
      dynamicRow.getByRole('combobox', { name: '工具 dynamic_tool exposure' }),
    ).toContainText('hidden')

    // 持久 exposure 走同一 JSON 草稿；重载同时验证旧 stdio PID 回收。
    await dialog.getByRole('tab', { name: 'MCP 配置' }).click()
    await openJsonView(page, dialog)
    const editor = dialog.getByRole('textbox', { name: 'MCP 配置 JSON' })
    const value = JSON.parse(await editor.inputValue()) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    value.mcpServers.fixture = { ...value.mcpServers.fixture, toolExposure: { echo: 'hidden' } }
    await editor.fill(`${JSON.stringify(value, null, 2)}\n`)
    await captureMcp(page, 'config-light')
    await saveConfig(page, dialog)
    const oldPid = readPid(pidFile)
    expect(oldPid).toBeDefined()
    await applyReload(page, dialog)
    await expect.poll(() => readPid(pidFile), { timeout: 20_000 }).not.toBe(oldPid)
    await expect.poll(() => (oldPid ? processAlive(oldPid) : true), { timeout: 20_000 }).toBe(false)

    await openServersTab(page, dialog)
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 20_000 }).toBe('connected')
    await dialog.getByRole('button', { name: '查看 fixture 详情' }).click()
    const echoRow = dialog.locator('[data-slot="huan-mcp-tool"][data-tool-name="echo"]')
    await expect(echoRow.getByRole('combobox', { name: '工具 echo exposure' })).toContainText(
      'hidden',
    )

    // 本会话临时重连、服务器 exposure 与启停；不写配置文件。
    await row.getByRole('button', { name: '重连 fixture' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('本会话临时应用')
    await row.getByRole('combobox', { name: 'fixture exposure' }).click()
    await page.getByRole('option', { name: 'hidden', exact: true }).click()
    await expect(row).toContainText('hidden', { timeout: 10_000 })
    await row.getByRole('button', { name: '停用 fixture' }).click()
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 15_000 }).toBe('disabled')
    await expect(dialog.locator('[data-slot="huan-mcp-details"]')).toBeVisible()
    await expect(dialog.locator('[data-slot="huan-mcp-details"]')).toContainText('已停用')
    await row.getByRole('button', { name: '启用 fixture' }).click()
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 20_000 }).toBe('connected')
  } finally {
    await stopFixture(pidFile)
    await writeProjectMcp(request, projectPath, null)
  }
})

test('连接失败修复后可恢复，无资源服务器仍显示工具详情', async ({ page, request }) => {
  const { projectPath } = await createLiveSession(page, request, 'recover')
  const fixture = await fixtureInfo(request)
  const pidFile = join(projectPath, 'recovered.pid')
  try {
    await writeProjectMcp(
      request,
      projectPath,
      JSON.stringify({
        mcpServers: {
          broken: { command: join(projectPath, 'missing-executable'), exposure: 'direct' },
        },
      }),
    )
    let dialog = await openMcp(page)
    await applyReload(page, dialog)
    const row = dialog.locator('[data-slot="huan-mcp-server"][data-server-name="broken"]')
    await expect(row).toHaveAttribute('data-state', 'failed', { timeout: 15_000 })
    await dialog.getByRole('tab', { name: 'MCP 配置' }).click()
    await dialog.getByRole('tab', { name: '编辑项目 MCP 配置' }).click()
    await openJsonView(page, dialog)
    await dialog.getByRole('textbox', { name: 'MCP 配置 JSON' }).fill(
      JSON.stringify({
        mcpServers: {
          broken: {
            command: fixture.nodePath,
            args: [fixture.stdioFixturePath],
            exposure: 'direct',
            env: {
              FIXTURE_PID_FILE: pidFile,
              FIXTURE_NO_RESOURCES: '1',
            },
          },
        },
      }),
    )
    await saveConfig(page, dialog)
    await applyReload(page, dialog)
    await openServersTab(page, dialog)
    await expect(row).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
    await dialog.getByRole('button', { name: '查看 broken 详情' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-tool"][data-tool-name="echo"]')).toBeVisible()
    await captureMcp(page, 'tools-only-light')
    await page.keyboard.press('Escape')
    dialog = await openMcp(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } finally {
    await stopFixture(pidFile)
    await writeProjectMcp(request, projectPath, null)
  }
})

test('项目未信任不读取配置，revision 冲突与非法配置保留草稿', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const untrusted = await createProject(request, `mcp-untrusted-${run}`)
  await writeProjectMcp(
    request,
    untrusted.path,
    `${JSON.stringify({ mcpServers: { hidden: { command: 'node', args: [] } } })}\n`,
  )
  const untrustedWorkspace = `MCP-未信任-${run}`
  await createWorkspaceApi(request, untrustedWorkspace, [{ alias: 'u', path: untrusted.path }])
  await openApp(page)
  await workspaceGroup(page, untrustedWorkspace)
    .getByRole('button', { name: new RegExp(untrustedWorkspace) })
    .click()
  let dialog = await openMcp(page)
  await dialog.getByRole('tab', { name: 'MCP 配置' }).click()
  await expect(dialog.getByRole('tab', { name: '编辑项目 MCP 配置' })).toBeDisabled()
  await expect(dialog.getByText(/项目未信任/).first()).toBeVisible()
  await expect(dialog.getByText('hidden', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const project = await createProject(request, `mcp-conflict-${run}`)
  await writeProjectMcp(request, project.path, '{"mcpServers":{}}\n')
  await trustProject(request, project.path)
  const workspaceName = `MCP-冲突-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'c', path: project.path }])
  // 新工作区由宿主列表提供；重新打开页面确保窗口状态已刷新。
  await openApp(page)
  await workspaceGroup(page, workspaceName)
    .getByRole('button', { name: new RegExp(workspaceName) })
    .click()
  dialog = await openConfigTab(page, 'project')
  await openJsonView(page, dialog)
  const editor = dialog.getByRole('textbox', { name: 'MCP 配置 JSON' })
  await expect(editor).toHaveValue(/"mcpServers"/)

  try {
    await editor.fill('{"mcpServers":{},"draftOnly":true}\n')
    // 模拟另一个窗口/进程修改同一文件。
    await writeProjectMcp(request, project.path, '{"mcpServers":{},"externalChange":true}\n')
    await dialog.getByRole('button', { name: '保存 MCP 配置' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-error"]')).toContainText('保存冲突')
    await expect(editor).toHaveValue(/"draftOnly":true/)

    // 显式重新读取才覆盖草稿；有未保存改动时先要求确认丢弃。
    await dialog.getByRole('button', { name: '重新读取 MCP 配置' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('未保存改动')
    await dialog.getByRole('button', { name: '确认重新读取 MCP 配置' }).click()
    await expect(editor).toHaveValue(/"externalChange":true/)
    await expect(editor).not.toHaveValue(/"draftOnly":true/)

    // 非法服务器配置由宿主校验拒绝，草稿保留并可修复。
    await editor.fill('{"mcpServers":{"bad":{"command":5}}}\n')
    await dialog.getByRole('button', { name: '保存 MCP 配置' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-issues"]').first()).toBeVisible()
    await expect(editor).toHaveValue(/"command":5/)
    expect(await readProjectMcp(request, project.path)).toContain('externalChange')
  } finally {
    await writeProjectMcp(request, project.path, null)
    await writeProjectMcp(request, untrusted.path, null)
  }
})

test('项目 override 只写三个持久字段，删除需要确认', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `mcp-override-${run}`)
  const userConfig = `${JSON.stringify(
    { mcpServers: { shared: { command: 'node', args: ['-e', ''] } } },
    null,
    2,
  )}
`
  const projectConfig = `${JSON.stringify({ mcpServers: { shared: { enabled: false } } }, null, 2)}
`
  await writeUserMcp(request, userConfig)
  await writeProjectMcp(request, project.path, projectConfig)
  await trustProject(request, project.path)
  const workspaceName = `MCP-override-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'o', path: project.path }])
  try {
    await openApp(page)
    await workspaceGroup(page, workspaceName)
      .getByRole('button', { name: new RegExp(workspaceName) })
      .click()
    const dialog = await openConfigTab(page, 'project')
    const effective = dialog.locator('[data-slot="huan-mcp-effective-server"]', {
      hasText: 'shared',
    })
    await expect(effective).toContainText('override')
    await expect(effective).toContainText('停用')

    await dialog.getByRole('button', { name: '修改 shared' }).click()
    const form = dialog.locator('[data-slot="huan-mcp-server-form"]')
    await expect(form).toContainText('override')
    await expect(form.getByLabel('stdio 命令')).toHaveCount(0)
    await form.getByRole('combobox', { name: '启用状态' }).click()
    await page.getByRole('option', { name: '启用', exact: true }).click()
    await form.getByRole('combobox', { name: '服务器 exposure' }).click()
    await page.getByRole('option', { name: 'direct', exact: true }).click()
    await form.getByLabel('工具 exposure').fill('echo=hidden')
    await form.getByRole('button', { name: '保存服务器' }).click()
    await saveConfig(page, dialog)

    const saved = JSON.parse((await readProjectMcp(request, project.path)) ?? '{}') as {
      mcpServers: Record<string, unknown>
    }
    expect(saved.mcpServers.shared).toEqual({
      enabled: true,
      exposure: 'direct',
      toolExposure: { echo: 'hidden' },
    })

    await dialog.getByRole('button', { name: '删除 shared' }).click()
    await expect(dialog.getByRole('button', { name: '确认删除 shared' })).toBeVisible()
    await dialog.getByRole('button', { name: '确认删除 shared' }).click()
    await openJsonView(page, dialog)
    const editor = dialog.getByRole('textbox', { name: 'MCP 配置 JSON' })
    await expect(editor).not.toHaveValue(/"shared"/)
  } finally {
    await writeProjectMcp(request, project.path, null)
    await writeUserMcp(request, null)
  }
})

test('OAuth 链接、回填、多窗接管、旧提示拒绝、取消、退出与 busy', async ({
  page,
  context,
  request,
}) => {
  const { projectPath } = await createLiveSession(page, request, 'oauth')
  const fixture = await fixtureInfo(request)
  let page2: Page | undefined
  try {
    let dialog = await openConfigTab(page, 'project')
    await dialog.getByRole('button', { name: '新增 HTTP 服务器' }).click()
    await dialog.getByLabel('服务器名称').fill('remote')
    await dialog.getByLabel('HTTP URL').fill(fixture.oauthResourceUrl)
    await dialog.getByRole('combobox', { name: '服务器 exposure' }).click()
    await page.getByRole('option', { name: 'direct', exact: true }).click()
    await dialog.getByRole('button', { name: '保存服务器' }).click()
    await saveConfig(page, dialog)
    await applyReload(page, dialog)

    await openServersTab(page, dialog)
    const row = dialog.locator('[data-slot="huan-mcp-server"][data-server-name="remote"]')
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 25_000 }).toBe('needs-auth')

    // /mcp login <server> 打开同一面板并只执行显式动作，不发送 prompt。
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await messageInput(page).fill('/mcp login remote')
    await messageInput(page).press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('tab', { name: 'MCP 认证' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(userMessages(page)).toHaveCount(1)

    const link = dialog.locator('[data-slot="huan-mcp-auth-url"]')
    await expect(link).toBeVisible({ timeout: 20_000 })
    const authUrl = await link.getAttribute('href')
    expect(authUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(await link.getAttribute('target')).toBe('_blank')
    expect(await link.getAttribute('rel')).toContain('noopener')

    const snapshot = (await (
      await request.get(`${E2E_HOST_URL}/api/pi/mcp/auth`)
    ).json()) as HarnessMcpAuthSnapshot
    const operation = snapshot.operations.find(
      (item) => item.server === 'remote' && item.kind === 'login' && item.prompt !== undefined,
    )
    expect(operation).toBeTruthy()
    if (!operation?.prompt) throw new Error('缺少 OAuth 回填提示')

    // 模拟用户打开授权页：真实 OAuth fixture 返回带 code/state 的回调地址。
    const authorize = await request.get(authUrl ?? '', { maxRedirects: 0 })
    expect(authorize.status()).toBe(302)
    const callbackUrl = authorize.headers().location
    expect(callbackUrl).toContain('code=')

    // 关闭本窗口面板不取消认证；第二窗口接管同一全局操作并回填。
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    page2 = await context.newPage()
    await openApp(page2)
    const dialog2 = await openMcp(page2)
    await dialog2.getByRole('tab', { name: 'MCP 认证' }).click()
    await expect(dialog2.locator('[data-slot="huan-mcp-auth-operation"]')).toContainText('remote')
    const prompt2 = dialog2.getByRole('textbox', { name: '授权回调 URL' })
    await expect(prompt2).toBeVisible()
    await captureMcp(page2, 'auth-light')
    await prompt2.fill(callbackUrl ?? '')
    await dialog2.getByRole('button', { name: '提交回填' }).click()
    // 已提交回填立即清空；随后提示表单随快照卸载。
    await expect(prompt2).toHaveValue('')
    await expect(
      dialog2.locator('[data-slot="huan-mcp-auth-result"][data-status="succeeded"]'),
    ).toBeVisible({ timeout: 25_000 })

    dialog = await openMcp(page)
    await dialog.getByRole('tab', { name: 'MCP 认证' }).click()
    await expect(
      dialog.locator('[data-slot="huan-mcp-auth-result"][data-status="succeeded"]'),
    ).toBeVisible({ timeout: 25_000 })

    // 旧 promptId 不能重复提交。
    const stale = await request.post(`${E2E_HOST_URL}/api/pi/mcp/auth/respond`, {
      data: {
        operationId: operation.id,
        promptId: operation.prompt.promptId,
        value: 'http://127.0.0.1:9/old',
      },
    })
    expect(await stale.json()).toMatchObject({ status: 'stale' })

    await openServersTab(page, dialog)
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 25_000 }).toBe('connected')

    // /mcp reconnect <server> 执行临时重连。
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await messageInput(page).fill('/mcp reconnect remote')
    await messageInput(page).press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('本会话临时应用')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // 运行中退出返回受控 busy；完成后可正常退出。
    await configureStream(request, ['busy-', 'done'])
    await sendMessage(page, 'OAuth busy 运行')
    await expect
      .poll(async () => {
        const state = await (await request.get(`${E2E_HOST_URL}/__e2e__/stream`)).json()
        return (state as { active: boolean }).active
      })
      .toBe(true)
    await releaseSegment(request)
    await expect(assistantMessages(page).last()).toContainText('busy-')
    await openMcp(page)
    await openServersTab(page, dialog)
    await row.getByRole('button', { name: '退出 remote' }).click()
    await expect(dialog.locator('[data-slot="huan-mcp-notice"]')).toContainText('暂不可用')
    await releaseSegment(request)
    await finishStream(request)
    await expect(assistantMessages(page).last()).toContainText('busy-done', { timeout: 20_000 })

    await openServersTab(page, dialog)
    await row.getByRole('button', { name: '退出 remote' }).click()
    await expect(
      dialog.locator('[data-slot="huan-mcp-auth-result"][data-status="succeeded"]').last(),
    ).toBeVisible({ timeout: 25_000 })

    // 再次登录后取消：操作保持 cancelling 直到真实流程结算。
    await openServersTab(page, dialog)
    await row.getByRole('button', { name: '登录 remote' }).click()
    const cancelButton = dialog.getByRole('button', { name: '取消 MCP 认证' })
    await expect(cancelButton).toBeVisible({ timeout: 20_000 })
    await cancelButton.click()
    await expect(
      dialog.locator('[data-slot="huan-mcp-auth-result"][data-status="cancelled"]').last(),
    ).toBeVisible({ timeout: 25_000 })

    // 取消后可重新发起；错误回填给出失败，随后再重开也不会复用旧提示。
    await openServersTab(page, dialog)
    await row.getByRole('button', { name: '登录 remote' }).click()
    const retryPrompt = dialog.getByRole('textbox', { name: '授权回调 URL' })
    await expect(retryPrompt).toBeVisible({ timeout: 20_000 })
    await retryPrompt.fill('http://127.0.0.1:9/wrong?code=wrong&state=wrong')
    await dialog.getByRole('button', { name: '提交回填' }).click()
    await expect(
      dialog.locator('[data-slot="huan-mcp-auth-result"][data-status="failed"]').last(),
    ).toBeVisible({ timeout: 25_000 })
    await openServersTab(page, dialog)
    await row.getByRole('button', { name: '登录 remote' }).click()
    await expect(dialog.getByRole('textbox', { name: '授权回调 URL' })).toHaveValue('')
    await dialog.getByRole('button', { name: '取消 MCP 认证' }).click()
    await expect(
      dialog.locator('[data-slot="huan-mcp-auth-result"][data-status="cancelled"]').last(),
    ).toBeVisible({ timeout: 25_000 })
  } finally {
    await page2?.close().catch(() => {})
    await writeProjectMcp(request, projectPath, null)
  }
})
