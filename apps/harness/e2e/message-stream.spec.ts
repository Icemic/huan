/**
 * 消息流第一轮验收：内置文件/命令工具的专门内容与用户 Shell 来源布局。
 *
 * 数据来自真实 Pi SDK：合成模型只决定工具调用，工具由隔离工作区内的真实
 * read/write/edit/bash 执行；不访问个人空间，也不使用付费模型。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  createProject,
  createWorkspaceApi,
  messageInput,
  openApp,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  threadListItem,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

async function scriptTurns(
  request: import('@playwright/test').APIRequestContext,
  turns: unknown[],
): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns },
  })
  expect(response.ok()).toBe(true)
}

/** 按标题文本定位工具折叠触发器（专门工具不再使用“已运行 xxx”）。 */
const toolTrigger = (page: Page, text: string) =>
  page
    .getByRole('button', { name: new RegExp(text.replaceAll('.', '\\.').replaceAll(' ', '\\s*')) })
    .last()

const normalizedClipboard = async (page: Page): Promise<string> =>
  (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')

test('内置 read/write/edit/bash 使用专门内容并保留原文复制', async ({ page, request }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const run = Date.now().toString(36)
  const project = await createProject(request, `消息流-${run}`)
  const workspaceName = `消息流工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  await writeFile(
    join(project.path, 'sample.ts'),
    ['line-1', 'line-2', 'line-3', ''].join('\n'),
    'utf8',
  )

  await openApp(page)
  await startNewSession(page, workspaceName)
  await selectModel(page)

  // write：标题显示写入行数，内容逐行带行号，空行与末尾换行不丢失。
  const content = 'export const a = 1\nexport const b = 2\nexport const c = 3\n'
  await scriptTurns(request, [
    { tool: { name: 'write', args: { path: 'sample.ts', content } } },
    { text: '写入完成' },
  ])
  await sendMessage(page, `写入工具-${run}`)
  await expect(assistantMessages(page).last()).toContainText('写入完成')
  const writeTrigger = toolTrigger(page, '写入 sample.ts')
  await expect(writeTrigger).toContainText('3 行')
  await writeTrigger.click()
  const writeCard = page.locator('[data-slot="huan-write-content"]').last()
  await expect(writeCard).toContainText('export const b = 2')
  await expect(writeCard.locator('[data-slot="code-block-line"]')).toHaveCount(3)
  await writeCard.hover()
  await writeCard.getByRole('button', { name: '复制写入内容' }).click()
  await expect.poll(() => normalizedClipboard(page)).toBe(content)

  await writeFile(join(project.path, 'read-sample.ts'), 'line-1\nline-2\nline-3\n', 'utf8')

  // read：标题只描述请求范围，展开显示精确起始行与最多行数。
  await scriptTurns(request, [
    { tool: { name: 'read', args: { path: 'read-sample.ts', offset: 1, limit: 2 } } },
    { text: '读取完成' },
  ])
  await sendMessage(page, `读取工具-${run}`)
  await expect(assistantMessages(page).last()).toContainText('读取完成')
  const readTrigger = toolTrigger(page, '读取 read-sample.ts')
  await expect(readTrigger).toContainText('1–2 行')
  await readTrigger.click()
  const readCard = page.locator('[data-slot="huan-read-content"]').last()
  await expect(readCard).toContainText('起始行 1 · 最多 2 行')
  await expect(readCard).toContainText('line-1')
  await expect(readCard).toContainText('line-2')
  await expect(readCard).not.toContainText('line-3')
  // read 第一轮不做行号或语法高亮，内容保持纯文本。
  await expect(readCard.locator('[data-slot="code-block-line"]')).toHaveCount(0)
  await readCard.hover()
  await readCard.getByRole('button', { name: '复制读取内容' }).click()
  await expect.poll(() => normalizedClipboard(page)).toContain('line-1\nline-2')

  // edit：成功后展示实际补丁，并保留默认收起的完整替换段。
  await scriptTurns(request, [
    {
      tool: {
        name: 'edit',
        args: {
          path: 'sample.ts',
          edits: [{ oldText: 'export const b = 2', newText: 'export const b = 20' }],
        },
      },
    },
    { text: '编辑完成' },
  ])
  await sendMessage(page, `编辑工具-${run}`)
  await expect(assistantMessages(page).last()).toContainText('编辑完成')
  const editTrigger = toolTrigger(page, '编辑 sample.ts')
  await expect(editTrigger).toContainText('1 处')
  await editTrigger.click()
  const diffCard = page.locator('[data-slot="huan-edit-diff"]').last()
  await expect(diffCard).toContainText('首处第2行')
  await expect(diffCard).toContainText('export const b = 2')
  await expect(diffCard).toContainText('export const b = 20')
  const editCard = page
    .locator('[data-slot="trace"]')
    .filter({ has: page.locator('[data-tool-name="edit"]') })
    .last()
  const segments = editCard.locator('summary').filter({ hasText: '替换内容' })
  await expect(segments).toBeVisible()
  await segments.click()
  await expect(page.locator('[data-slot="huan-edit-before"]').last()).toContainText(
    'export const b = 2',
  )
  await expect(page.locator('[data-slot="huan-edit-after"]').last()).toContainText(
    'export const b = 20',
  )

  // bash：命令与输出分成两块，显式 timeout 只显示传入值。
  await scriptTurns(request, [
    { tool: { name: 'bash', args: { command: 'cat sample.ts', timeout: 60 } } },
    { text: '命令完成' },
  ])
  await sendMessage(page, `命令工具-${run}`)
  await expect(assistantMessages(page).last()).toContainText('命令完成')
  const bashTrigger = toolTrigger(page, '执行 cat sample.ts')
  await bashTrigger.click()
  const bashCard = page
    .locator('[data-slot="trace"]')
    .filter({ has: page.locator('[data-tool-name="bash"]') })
    .last()
  await expect(bashCard.locator('[data-slot="huan-command-block"]')).toContainText('超时 60s')
  await expect(bashCard.locator('[data-slot="huan-output-block"]')).toContainText(
    'export const b = 20',
  )

  await expect(writeCard.locator('pre')).toHaveCSS('font-size', '14px')
  await expect(writeCard.locator('[data-slot="code-block-line"]').first()).toHaveCSS(
    'line-height',
    '22px',
  )

  // 空写入、失败多段替换均来自真实工具，失败时仍能查看完整请求。
  await scriptTurns(request, [
    { tool: { name: 'write', args: { path: 'empty.ts', content: '' } } },
    {
      tool: {
        name: 'edit',
        args: {
          path: 'sample.ts',
          edits: [
            { oldText: 'missing-one', newText: 'new-one' },
            { oldText: 'missing-two', newText: 'new-two' },
          ],
        },
      },
    },
    { text: '边界验证完成' },
  ])
  await sendMessage(page, `边界工具-${run}`)
  await expect(assistantMessages(page).last()).toContainText('边界验证完成')
  await toolTrigger(page, '写入 empty.ts').click()
  const emptyCard = page.locator('[data-slot="huan-write-content"]').last()
  await expect(emptyCard).toContainText('空内容 · 0 行')
  const failedEdit = toolTrigger(page, '编辑 sample.ts').last()
  await expect(failedEdit).toHaveAttribute('aria-expanded', 'true')
  const failedBody = failedEdit.locator('..')
  await expect(failedBody).toContainText('missing-one')
  await expect(failedBody).toContainText('missing-two')
  await expect(failedBody.locator('[data-slot="huan-edit-diff"]')).toHaveCount(0)
  await expect(failedBody.locator('[data-slot="huan-edit-before"]')).toHaveCount(2)
  await failedEdit.click()
  await expect(failedEdit).toHaveAttribute('aria-expanded', 'false')

  // 窄屏隐藏标题范围元数据；展开内容不受影响。
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(readTrigger).toBeVisible()
  await expect(readTrigger.getByText('1–2 行')).toBeHidden()
  await expect(readCard).toContainText('起始行 1 · 最多 2 行')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true)
  await page.screenshot({
    path: test.info().outputPath('message-stream-narrow.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({
    path: test.info().outputPath('message-stream-light.png'),
    fullPage: true,
  })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: test.info().outputPath('message-stream-dark.png'), fullPage: true })

  // 重开历史后专门内容仍来自持久结果，不依赖内存执行状态。
  await page.reload()
  await threadListItem(page, `写入工具-${run}`).click()
  await toolTrigger(page, '执行 cat sample.ts').click()
  await expect(page.locator('[data-slot="huan-output-block"]').last()).toContainText(
    'export const b = 20',
  )
})

test('用户 Shell 右对齐展示来源，命令/输出完整且不提供消息动作', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const run = Date.now().toString(36)
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)
  await sendMessage(page, `建立 Shell 会话-${run}`)
  await expect(assistantMessages(page).last()).toBeVisible()

  const command = `printf 'shell-source-${run}\\n'`
  await messageInput(page).fill(`!${command}`)
  await messageInput(page).press('Enter')
  const card = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(card).toContainText(command)
  await expect(card).toContainText('退出码 0')
  const message = page
    .locator('[data-slot="huan-message"][data-role="assistant"]')
    .filter({ has: card })
    .last()
  await expect(message).toHaveAttribute('data-align', 'end')
  // Shell 专用消息不显示助手复制/下载栏。
  await expect(message.getByRole('button', { name: '复制消息' })).toHaveCount(0)
  await expect(message.getByRole('button', { name: '下载此消息的 Markdown' })).toHaveCount(0)

  await expect(message).toHaveCSS('font-size', '14px')
  await card.getByRole('button').first().focus()
  await page.keyboard.press('Enter')
  const commandBlock = page.locator('[data-slot="huan-user-shell-command"]').last()
  const outputBlock = page.locator('[data-slot="huan-user-shell-output"]').last()
  await expect(commandBlock).toContainText(command)
  await expect(outputBlock).toContainText(`shell-source-${run}`)
  await commandBlock.hover()
  await commandBlock.getByRole('button', { name: '复制命令' }).click()
  // 复制命令不含装饰性 `!`。
  await expect.poll(() => normalizedClipboard(page)).toBe(command)

  // !!：保留提示符与上下文排除说明，展开后仍显示完整命令与输出。
  const excluded = `echo shell-excluded-${run}`
  await messageInput(page).fill(`!!${excluded}`)
  await messageInput(page).press('Enter')
  const excludedCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(excludedCard).toContainText(`!! ${excluded}`)
  await excludedCard.getByRole('img', { name: '不进入模型上下文' }).hover()
  await expect(page.getByRole('tooltip')).toHaveText('不进入模型上下文')
  await expect(excludedCard.getByRole('img', { name: '不进入模型上下文' })).toBeVisible()
  await excludedCard.getByRole('button').first().click()
  await expect(page.locator('[data-slot="huan-user-shell-command"]').last()).toContainText(excluded)
  await expect(page.locator('[data-slot="huan-user-shell-output"]').last()).toContainText(
    `shell-excluded-${run}`,
  )

  // 非零退出默认展开，标题保留错误退出码。
  const failure = `node -e "console.log('shell-fail-${run}'); process.exit(3)"`
  await messageInput(page).fill(`!${failure}`)
  await messageInput(page).press('Enter')
  const failureCard = page.locator('[data-slot="huan-bash-message"]').last()
  await expect(failureCard).toContainText('退出码 3')
  await expect(failureCard.locator('[data-slot="huan-user-shell-output"]')).toContainText(
    `shell-fail-${run}`,
  )
  await page.setViewportSize({ width: 390, height: 900 })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true)
  await page.screenshot({ path: test.info().outputPath('user-shell-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: test.info().outputPath('user-shell-light.png'), fullPage: true })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: test.info().outputPath('user-shell-dark.png'), fullPage: true })
})

test('导入历史保留零值、空值及 SDK 支持的工具参数形状', async ({ page, request }, testInfo) => {
  const project = await createProject(request, `参数边界-${Date.now().toString(36)}`)
  const workspaceName = `参数边界工作区-${Date.now().toString(36)}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  const cases = [
    { name: 'read', args: { path: 'zero.ts', offset: 0, limit: 200 }, output: 'ZERO-READ' },
    { name: 'read', args: { path: 'null.ts', offset: null, limit: null }, output: 'NULL-READ' },
    { name: 'read', args: { path: 'limit-zero.ts', limit: 0 }, output: '' },
    { name: 'bash', args: { command: 'echo null', timeout: null }, output: 'NULL-TIMEOUT' },
    { name: 'bash', args: { command: '' }, output: '' },
    { name: 'write', args: { path: 'empty.ts', content: '' }, output: 'EMPTY-WRITE' },
    {
      name: 'edit',
      args: { path: 'object.ts', edits: { oldText: 'before-object', newText: '' } },
      output: 'OBJECT-EDIT',
    },
    {
      name: 'edit',
      args: { path: 'json.ts', edits: '[{"oldText":"before-json","newText":"after-json"}]' },
      output: 'JSON-EDIT',
    },
    {
      name: 'edit',
      args: { path: 'legacy.ts', oldText: 'before-legacy', newText: '' },
      output: 'LEGACY-EDIT',
    },
  ]
  const timestamp = Date.now()
  const entries: unknown[] = [
    {
      type: 'session',
      version: 3,
      id: `edges-${timestamp}`,
      timestamp: new Date(timestamp).toISOString(),
      cwd: project.path,
    },
  ]
  let parentId: string | null = null
  for (const [index, item] of cases.entries()) {
    const callId = `call-${index}`
    const assistantId = `assistant-${index}`
    const resultId = `result-${index}`
    entries.push(
      {
        type: 'message',
        id: assistantId,
        parentId,
        timestamp: new Date(timestamp + index * 2 + 1).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: item.name, arguments: item.args }],
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
          stopReason: 'toolUse',
          timestamp: timestamp + index * 2 + 1,
        },
      },
      {
        type: 'message',
        id: resultId,
        parentId: assistantId,
        timestamp: new Date(timestamp + index * 2 + 2).toISOString(),
        message: {
          role: 'toolResult',
          toolCallId: callId,
          toolName: item.name,
          content: [{ type: 'text', text: item.output }],
          isError: false,
          timestamp: timestamp + index * 2 + 2,
        },
      },
    )
    parentId = resultId
  }
  const sourcePath = testInfo.outputPath('tool-parameter-edges.jsonl')
  await writeFile(sourcePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  await openApp(page)
  await page.getByRole('button', { name: '导入 JSONL', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导入 JSONL 会话' })
  await dialog.getByRole('combobox', { name: '目标工作区' }).click()
  await page.getByRole('option', { name: workspaceName, exact: true }).click()
  await dialog.getByLabel('服务端 JSONL 绝对路径').fill(sourcePath)
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.locator('[data-slot="huan-import-preview"]')).toBeVisible()
  await dialog.getByRole('button', { name: '确认导入' }).click()
  await expect(dialog.getByRole('status')).toContainText('会话已导入')
  await dialog.getByRole('button', { name: '打开已导入会话' }).click()
  await expect(dialog).toHaveCount(0)

  for (const [index, item] of cases.entries()) {
    const card = page.locator('[data-slot="huan-tool-part"]').filter({
      has: page.locator(`[data-tool-call-id="call-${index}"]`),
    })
    const trigger = card.locator('[data-slot="trace-collapsible-trigger"]').first()
    await expect(trigger).not.toContainText('已运行')
    await trigger.click()
    if (item.output) await expect(card).toContainText(item.output)
    if (index === 0) {
      await expect(trigger).toContainText('1–200 行')
      await expect(card).toContainText('起始行 1（offset: 0）')
    }
    if (index === 1 || index === 3) {
      await card.getByText('其他参数', { exact: true }).click()
      await expect(card).toContainText('null')
    }
    if (index === 2) {
      await expect(trigger).toContainText('最多 0 行')
      await expect(card).toContainText('空内容')
    }
    if (index === 4) await expect(card.locator('[data-slot="huan-command-block"]')).toBeVisible()
    if (index >= 6) await expect(card.locator('[data-slot="huan-edit-before"]')).toBeVisible()
  }
})
