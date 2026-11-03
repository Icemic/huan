import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  chooseSessionAction,
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
  threadListItem,
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

async function prepareWorkspace(
  request: APIRequestContext,
  label: string,
): Promise<{ workspaceId: string; workspaceName: string; projectPath: string }> {
  const run = Date.now().toString(36)
  const project = await createProject(request, `${label}-${run}`)
  const workspaceName = `${label}工作区-${run}`
  const workspace = await createWorkspaceApi(request, workspaceName, [
    { alias: 'p', path: project.path },
  ])
  return { workspaceId: workspace.id, workspaceName, projectPath: project.path }
}

const treeDialog = (page: Page) => page.getByRole('dialog', { name: '会话树' })
const treeRows = (page: Page) => treeDialog(page).locator('[data-slot="huan-tree-row"]')

async function openTree(page: Page): Promise<void> {
  await chooseSessionAction(page, '会话树')
  await expect(treeDialog(page)).toBeVisible()
  await expect(treeRows(page).first()).toBeVisible()
}

async function navigateToRow(page: Page, rowText: string): Promise<void> {
  const row = treeRows(page).filter({ hasText: rowText }).first()
  await row.hover()
  await row.getByRole('button', { name: '跳转到此节点' }).click()
}

/** 按标题（显式名称或首条用户消息）读取会话 ID。 */
async function threadIdByTitle(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(response.ok()).toBe(true)
  const threads = (await response.json()) as Array<{ id: string; title?: string }>
  const hit = threads.find((thread) => thread.title === title)
  if (!hit) throw new Error(`未找到会话：${title}`)
  return hit.id
}

/** 在指定工作区分组内展开并点击会话（新窗口默认折叠自定义工作区）。 */
async function openThreadInWorkspace(
  page: Page,
  workspaceName: string,
  title: string,
): Promise<void> {
  const group = workspaceGroup(page, workspaceName)
  const expand = group.getByRole('button', { name: '展开工作区' })
  if ((await expand.count()) > 0) await expand.click()
  await threadListItem(page, title).click()
}

const TIMESTAMP = '2026-10-31T00:00:00.000Z'

type SourceOptions = {
  id: string
  cwd: string
  text: string
  reply?: string
  extraEntries?: readonly Record<string, unknown>[]
}

/**
 * 构造最小合法 Pi 会话 JSONL。
 *
 * 助手条目使用隔离用户空间中的合成 provider/model，导入后可继续发送；
 * 额外未知类型条目用于验证副本保留完整树而不是只复制活动路径。
 */
function sessionJsonl(options: SourceOptions): string {
  const { id, cwd, text, reply = '导入回答', extraEntries = [] } = options
  const userId = 'entry-user'
  const assistantId = 'entry-assistant'
  const userTimestamp = Date.parse(TIMESTAMP) + 1
  const header = { type: 'session', version: 3, id, timestamp: TIMESTAMP, cwd }
  const entries: Record<string, unknown>[] = [
    {
      type: 'message',
      id: userId,
      parentId: null,
      timestamp: new Date(userTimestamp).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: userTimestamp,
      },
    },
    {
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: new Date(userTimestamp + 1).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        api: 'openai-completions',
        provider: 'huan-test',
        model: 'test-model-a',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: userTimestamp + 1,
      },
    },
    ...extraEntries.map((entry) => ({ ...entry })),
  ]
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/** 在 Playwright 输出目录写源文件，返回宿主可读取的绝对路径。 */
async function writeSource(name: string, content: string): Promise<string> {
  const file = test.info().outputPath(name)
  await writeFile(file, content)
  return file
}

const importDialog = (page: Page) => page.getByRole('dialog', { name: '导入 JSONL 会话' })

async function openImport(page: Page) {
  await page.getByRole('button', { name: '导入 JSONL' }).click()
  const dialog = importDialog(page)
  await expect(dialog).toBeVisible()
  return dialog
}

async function chooseWorkspace(page: Page, dialog: ReturnType<typeof importDialog>, name: string) {
  await dialog.getByRole('combobox', { name: '目标工作区' }).click()
  await page.getByRole('option', { name, exact: true }).click()
}

/** 确认导入并打开结果（面板显式提供“打开已导入会话”）。 */
async function confirmImport(_page: Page, dialog: ReturnType<typeof importDialog>): Promise<void> {
  await dialog.getByRole('button', { name: '确认导入' }).click()
  await expect(dialog.getByRole('status')).toContainText('会话已导入', { timeout: 20_000 })
  await dialog.getByRole('button', { name: '打开已导入会话' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })
}

/** 走完整路径导入 GUI 流程（预览 + 确认 + 自动切入）。 */
async function importPath(
  page: Page,
  workspaceName: string,
  sourcePath: string,
  expectedText: string,
): Promise<void> {
  const dialog = await openImport(page)
  await chooseWorkspace(page, dialog, workspaceName)
  await dialog.getByLabel('宿主 JSONL 路径').fill(sourcePath)
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.locator('[data-slot="huan-import-preview"]')).toBeVisible()
  await confirmImport(page, dialog)
  await expect(userMessages(page).first()).toContainText(expectedText)
}

test('历史消息 fork 创建独立空分支，父子双窗互不影响并可继续发送', async ({
  page,
  context,
  request,
}) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '分叉')
  const first = `分叉第一问-${run}`
  const second = `分叉第二问-${run}`
  const childQuestion = `子会话问题-${run}`
  const parentQuestion = `父会话问题-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await sendMessage(page, second)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  // 第二窗口停在父会话，保留自己的未发送草稿。
  const page2 = await context.newPage()
  await openApp(page2)
  await openThreadInWorkspace(page2, workspaceName, first)
  await expect(userMessages(page2)).toHaveCount(2)
  const parentDraft = `父窗口草稿-${run}`
  await page2.getByRole('textbox', { name: '消息输入' }).fill(parentDraft)

  // 树用户行也提供 fork 入口；取消后不创建任何会话。
  await openTree(page)
  const treeFirstRow = treeRows(page).filter({ hasText: first }).first()
  await treeFirstRow.hover()
  await treeFirstRow.getByRole('button', { name: '从这条消息分叉' }).click()
  const treeForkDialog = page.getByRole('dialog', { name: '从这条消息分叉' })
  await expect(treeForkDialog).toBeVisible()
  await treeForkDialog.getByRole('button', { name: '取消' }).click()
  await treeDialog(page).getByRole('button', { name: '关闭' }).first().click()

  // 历史用户消息入口 fork 第一条消息。
  const firstBubble = userMessages(page).first()
  await firstBubble.hover()
  await firstBubble.getByRole('button', { name: '从这条用户消息分叉' }).click()
  const dialog = page.getByRole('dialog', { name: '从这条消息分叉' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '创建独立分支' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })

  // 发起窗口切入空子会话并恢复原文；父窗口历史与草稿不动。
  await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(first)
  await expect(userMessages(page)).toHaveCount(0)
  await expect(userMessages(page2)).toHaveCount(2)
  await expect(page2.getByRole('textbox', { name: '消息输入' })).toHaveValue(parentDraft)

  // 父窗口继续发送，子会话不受影响。
  await page2.getByRole('textbox', { name: '消息输入' }).fill(parentQuestion)
  await page2.getByRole('button', { name: '发送消息' }).click()
  await expect(userMessages(page2)).toHaveCount(3)
  await expect(userMessages(page2).last()).toContainText(parentQuestion)
  await expect(userMessages(page)).toHaveCount(0)

  // 子会话独立发送并更新列表标题；父窗口保持三条历史。
  await sendMessage(page, childQuestion)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(userMessages(page)).toHaveCount(1)
  await expect(userMessages(page).first()).toContainText(childQuestion)
  await expect(threadListItem(page, childQuestion)).toBeVisible()
  await expect(userMessages(page2)).toHaveCount(3)
  await expect(userMessages(page2).filter({ hasText: childQuestion })).toHaveCount(0)
})

test('克隆当前活动路径排除废弃分支；父子各自发送互不污染', async ({ page, context, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '克隆')
  const first = `克隆第一问-${run}`
  const abandoned = `废弃分支A-${run}`
  const kept = `保留分支B-${run}`
  const keptReply = `保留回答B-${run}`
  const abandonedReply = `废弃回答A-${run}`
  const childExtra = `克隆后追问-${run}`
  const parentName = `克隆父会话-${run}`

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  // 先在第一条助手回复后形成保留分支 B（当前 leaf）。
  await configureStream(request, [keptReply])
  await sendMessage(page, kept)
  await releaseSegment(request)
  await finishStream(request)
  await expect(assistantMessages(page).last()).toContainText(keptReply)

  // 跳回第一条助手回复，再形成废弃分支 A。
  await openTree(page)
  await navigateToRow(page, DEFAULT_REPLY)
  await treeDialog(page).getByRole('button', { name: '确认跳转' }).click()
  await expect(treeDialog(page).getByText('已跳转到所选节点。')).toBeVisible()
  await treeDialog(page).getByRole('button', { name: '关闭' }).first().click()
  await expect(userMessages(page)).toHaveCount(1)
  await configureStream(request, [abandonedReply])
  await sendMessage(page, abandoned)
  await releaseSegment(request)
  await finishStream(request)
  await expect(assistantMessages(page).last()).toContainText(abandonedReply)

  // 再跳回保留分支 B 的助手回复，确保 clone 复制的是它的活动路径。
  await openTree(page)
  await navigateToRow(page, keptReply)
  await treeDialog(page).getByRole('button', { name: '确认跳转' }).click()
  await expect(treeDialog(page).getByText('已跳转到所选节点。')).toBeVisible()
  await treeDialog(page).getByRole('button', { name: '关闭' }).first().click()
  await expect(userMessages(page)).toHaveCount(2)

  const parentId = await threadIdByTitle(request, first)
  // 会话操作菜单 clone 当前落点。
  await chooseSessionAction(page, '克隆到新会话')
  const dialog = page.getByRole('dialog', { name: '克隆当前会话' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '克隆为独立会话' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })

  // 子会话只含活动路径：第一条与分支 B，不含废弃分支 A。
  await expect(userMessages(page)).toHaveCount(2)
  await expect(userMessages(page).nth(0)).toContainText(first)
  await expect(userMessages(page).nth(1)).toContainText(kept)
  await expect(userMessages(page).filter({ hasText: abandoned })).toHaveCount(0)
  await expect(assistantMessages(page).filter({ hasText: abandonedReply })).toHaveCount(0)
  await expect(assistantMessages(page).last()).toContainText(keptReply)
  // 完整树中也没有废弃分支（不是只隐藏了活动路径）。
  await openTree(page)
  await treeDialog(page).getByRole('button', { name: '全部', exact: true }).click()
  await expect(treeRows(page).filter({ hasText: abandonedReply })).toHaveCount(0)
  await treeDialog(page).getByRole('button', { name: '关闭' }).first().click()

  // 父会话与克隆子会话首条消息相同；显式命名父会话后再从另一窗口打开，避免重名。
  const renamed = await request.patch(`${E2E_HOST_URL}/api/pi/threads/${parentId}`, {
    data: { title: parentName },
  })
  expect(renamed.ok()).toBe(true)
  const page2 = await context.newPage()
  await openApp(page2)
  await openThreadInWorkspace(page2, workspaceName, parentName)
  // 父会话活动路径与克隆子会话相同（第一条 + 分支 B），但完整树保留废弃分支。
  await expect(userMessages(page2)).toHaveCount(2)
  await openTree(page2)
  await treeDialog(page2).getByRole('button', { name: '全部', exact: true }).click()
  await expect(treeRows(page2).filter({ hasText: abandonedReply })).toHaveCount(1)
  await treeDialog(page2).getByRole('button', { name: '关闭' }).first().click()

  // 子会话继续发送；父窗口历史与完整树不变。
  await sendMessage(page, childExtra)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(userMessages(page)).toHaveCount(3)
  await expect(userMessages(page2)).toHaveCount(2)
  await expect(userMessages(page2).filter({ hasText: childExtra })).toHaveCount(0)
})

test('路径导入拒绝非法 JSONL；cwd 非成员时必须选择替代目录后导入', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName, projectPath } = await prepareWorkspace(request, '路径导入')
  const invalid = await writeSource('invalid.jsonl', '{"type":"session"\n{"broken"\n')
  const text = `路径导入问题-${run}`
  const missingCwd = join(test.info().outputPath('missing-project'), 'project')
  const source = await writeSource(
    'cwd.jsonl',
    sessionJsonl({ id: `e2e-cwd-${run}`, cwd: missingCwd, text }),
  )

  await openApp(page)
  const dialog = await openImport(page)
  await chooseWorkspace(page, dialog, workspaceName)

  // 非法 JSONL：坏行不被宽松跳过，确认按钮保持禁用。
  await dialog.getByLabel('宿主 JSONL 路径').fill(invalid)
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.getByRole('alert')).toContainText('合法 JSON')
  await expect(dialog.getByRole('button', { name: '确认导入' })).toBeDisabled()

  // cwd 不属于目标工作区：要求显式选择成员作为替代目录。
  await dialog.getByLabel('宿主 JSONL 路径').fill(source)
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.getByRole('alert')).toContainText('源起始目录不在目标工作区内')
  await expect(dialog.getByRole('button', { name: '确认导入' })).toBeDisabled()

  await dialog.getByRole('combobox', { name: '替代起始目录' }).click()
  await page.getByRole('option').filter({ hasText: projectPath }).click()
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.locator('[data-slot="huan-import-preview"]')).toBeVisible()
  await expect(dialog.getByText(/将使用所选成员作为替代起始目录/)).toBeVisible()
  await confirmImport(page, dialog)
  await expect(userMessages(page).first()).toContainText(text)

  // 导入会话确实以所选成员为 cwd，而不是源文件的缺失路径。
  const threadId = await threadIdByTitle(request, text)
  const snapshot = await request.get(`${E2E_HOST_URL}/api/pi/threads/${threadId}`)
  expect(snapshot.ok()).toBe(true)
  const body = (await snapshot.json()) as { metadata: { workspacePath?: string } }
  expect(body.metadata.workspacePath).toBe(projectPath)
})

test('上传 JSONL 导入后列表自动更新并可继续发送', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName, projectPath } = await prepareWorkspace(request, '上传导入')
  const text = `上传导入问题-${run}`
  const content = sessionJsonl({ id: `e2e-upload-${run}`, cwd: projectPath, text })

  await openApp(page)
  const dialog = await openImport(page)
  await chooseWorkspace(page, dialog, workspaceName)
  await dialog.getByRole('radio', { name: '上传 JSONL' }).check()
  await dialog.locator('input[type="file"]').setInputFiles({
    name: `upload-${run}.jsonl`,
    mimeType: 'application/jsonl',
    buffer: Buffer.from(content, 'utf8'),
  })
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.locator('[data-slot="huan-import-preview"]')).toBeVisible()
  await expect(dialog.locator('[data-slot="huan-import-preview"]')).toContainText(
    `e2e-upload-${run}`,
  )
  await confirmImport(page, dialog)
  await expect(userMessages(page).first()).toContainText(text)
  await expect(threadListItem(page, text)).toBeVisible()

  // 导入后是普通宿主会话：可继续发送并得到合成模型回复。
  await sendMessage(page, `上传后继续-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(userMessages(page).last()).toContainText(`上传后继续-${run}`)
})

test('同 ID 冲突可作为独立副本导入，保留完整树且不覆盖已有会话', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceId, workspaceName, projectPath } = await prepareWorkspace(request, '冲突导入')
  const id = `e2e-conflict-${run}`
  const firstText = `冲突原始问题-${run}`
  const secondText = `冲突副本问题-${run}`
  const sameId = `e2e-same-${run}`
  const sameText = `完全相同问题-${run}`
  const sameSource = await writeSource(
    'same.jsonl',
    sessionJsonl({ id: sameId, cwd: projectPath, text: sameText }),
  )
  const sourceA = await writeSource(
    'conflict-a.jsonl',
    sessionJsonl({ id, cwd: projectPath, text: firstText }),
  )
  const sourceB = await writeSource(
    'conflict-b.jsonl',
    sessionJsonl({
      id,
      cwd: projectPath,
      text: secondText,
      extraEntries: [
        // 非活动分支：未知扩展条目，父链仍指向助手回复。
        {
          type: 'future_entry',
          id: 'future-entry',
          parentId: 'entry-assistant',
          timestamp: new Date(Date.parse(TIMESTAMP) + 2).toISOString(),
          payload: { keep: true },
        },
        // 活动落点放在另一个兄弟节点，确保 future_entry 不是活动路径。
        {
          type: 'custom',
          id: 'tip-entry',
          parentId: 'entry-assistant',
          timestamp: new Date(Date.parse(TIMESTAMP) + 3).toISOString(),
          customType: 'e2e-tip',
        },
      ],
    }),
  )

  // 经宿主接口预置一个「未打开」的同源会话；打开会由 SDK 规范化追加条目，
  // 因此 already-exists 必须在未打开状态下验证。
  const preimport = await request.post(`${E2E_HOST_URL}/api/pi/threads/import`, {
    data: {
      source: { kind: 'path', path: sameSource },
      workspaceId,
      expectedSourceId: sameId,
    },
  })
  expect(preimport.ok()).toBe(true)
  expect(((await preimport.json()) as { status: string }).status).toBe('imported')

  await openApp(page)
  // 相同内容：定位既有会话，不复制。
  const same = await openImport(page)
  await chooseWorkspace(page, same, workspaceName)
  await same.getByLabel('宿主 JSONL 路径').fill(sameSource)
  await same.getByRole('button', { name: '预览导入' }).click()
  await expect(same.getByText('已有完全相同的会话')).toBeVisible()
  await expect(same.getByRole('button', { name: '确认导入' })).toBeDisabled()
  await same.getByRole('button', { name: '打开已有会话' }).click()
  await expect(same).toHaveCount(0)
  await expect(userMessages(page).first()).toContainText(sameText)

  await importPath(page, workspaceName, sourceA, firstText)

  // 同 ID 不同内容：未勾选副本时确认禁用；勾选后以新 ID 导入完整树。
  const conflict = await openImport(page)
  await chooseWorkspace(page, conflict, workspaceName)
  await conflict.getByLabel('宿主 JSONL 路径').fill(sourceB)
  await conflict.getByRole('button', { name: '预览导入' }).click()
  await expect(conflict.getByText('同 ID 内容不同')).toBeVisible()
  await expect(conflict.getByRole('button', { name: '确认导入' })).toBeDisabled()
  await conflict.getByRole('checkbox', { name: '作为独立副本导入' }).check()
  await confirmImport(page, conflict)
  await expect(userMessages(page).first()).toContainText(secondText)

  // 副本保留完整树：未知扩展条目作为非活动节点存在。
  const copyId = await threadIdByTitle(request, secondText)
  const treeResponse = await request.get(`${E2E_HOST_URL}/api/pi/threads/${copyId}/tree`)
  expect(treeResponse.ok()).toBe(true)
  const tree = (await treeResponse.json()) as {
    nodes: Array<{ entryType: string; active: boolean }>
  }
  const future = tree.nodes.find((node) => node.entryType === 'future_entry')
  expect(future).toBeTruthy()
  expect(future?.active).toBe(false)
  expect(tree.nodes.some((node) => node.entryType === 'message')).toBe(true)

  // 会话树“全部”过滤能看到该非活动节点。
  await openTree(page)
  await treeDialog(page).getByRole('button', { name: '全部', exact: true }).click()
  await expect(treeRows(page).filter({ hasText: 'future_entry' })).toHaveCount(1)
})

test('分叉在途时关闭弹层并输入新草稿，迟到成功不切换也不覆盖', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const { workspaceName } = await prepareWorkspace(request, '迟到分叉')
  const question = `迟到分叉问题-${run}`
  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, question)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(threadListItem(page, question)).toBeVisible()

  const bubble = userMessages(page).first()
  await bubble.hover()
  await bubble.getByRole('button', { name: '从这条用户消息分叉' }).click()
  const dialog = page.getByRole('dialog', { name: '从这条消息分叉' })
  await expect(dialog).toBeVisible()

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/fork', async (route) => {
    await gate
    await route.continue()
  })
  try {
    const responded = page.waitForResponse((response) => response.url().endsWith('/fork'))
    await dialog.getByRole('button', { name: '创建独立分支' }).click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const draft = `迟到分叉草稿-${run}`
    await page.getByRole('textbox', { name: '消息输入' }).fill(draft)
    release()
    const response = await responded
    expect(response.ok()).toBe(true)
    // 迟到成功不得把窗口切到子会话，也不得覆盖本窗口新草稿。
    await page.waitForTimeout(500)
    await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(draft)
    await expect(userMessages(page).first()).toContainText(question)
    await expect(page.getByRole('dialog', { name: '从这条消息分叉' })).toHaveCount(0)
  } finally {
    await page.unroute('**/fork')
  }
})

test('导入预览在途时关闭重开并换文件，迟到结果不写入新面板', async ({
  page,
  request,
}, testInfo) => {
  const run = Date.now().toString(36)
  const { workspaceName, projectPath } = await prepareWorkspace(request, '迟到导入')
  const first = await writeSource(
    'late-a.jsonl',
    sessionJsonl({ id: `e2e-late-a-${run}`, cwd: projectPath, text: `迟到导入甲-${run}` }),
  )
  const second = await writeSource(
    'late-b.jsonl',
    sessionJsonl({ id: `e2e-late-b-${run}`, cwd: projectPath, text: `迟到导入乙-${run}` }),
  )
  await openApp(page)

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/threads/import/preview', async (route) => {
    await gate
    await route.continue()
  })
  try {
    const firstDialog = await openImport(page)
    await chooseWorkspace(page, firstDialog, workspaceName)
    await firstDialog.getByLabel('宿主 JSONL 路径').fill(first)
    const stalePreviewed = page.waitForResponse((response) =>
      response.url().includes('/threads/import/preview'),
    )
    await firstDialog.getByRole('button', { name: '预览导入' }).click()
    // 预览在途时关闭面板，换一个文件重开：旧结果不得写进新面板。
    await page.keyboard.press('Escape')
    await expect(firstDialog).toHaveCount(0)
    const dialog = await openImport(page)
    await chooseWorkspace(page, dialog, workspaceName)
    await dialog.getByLabel('宿主 JSONL 路径').fill(second)
    release()
    expect((await stalePreviewed).ok()).toBe(true)
    await page.waitForTimeout(500)
    await expect(dialog.locator('[data-slot="huan-import-preview"]')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '确认导入' })).toBeDisabled()

    // 新面板仍可正常预览自己的文件。
    await dialog.getByRole('button', { name: '预览导入' }).click()
    await expect(dialog.locator('[data-slot="huan-import-preview"]')).toBeVisible({
      timeout: 20_000,
    })
    await expect(dialog.locator('[data-slot="huan-import-preview"]')).toContainText(
      `e2e-late-b-${run}`,
    )
    void testInfo
  } finally {
    await page.unroute('**/threads/import/preview')
  }
})
