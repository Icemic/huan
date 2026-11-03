/**
 * 最终展示模型验收：工具图片、嵌套子调用与待答请求、工具编辑原文、未知
 * 数据回退、历史模型回退原因。
 *
 * 数据来自真实 Pi SDK：合成模型由测试控制端点驱动，工具由隔离用户空间的
 * 扩展探针注册；不访问个人空间，也不使用付费模型。
 */
import { expect, type Locator, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  chooseSessionAction,
  createProject,
  createWorkspaceApi,
  DEFAULT_REPLY,
  messageInput,
  openApp,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  threadListItem,
  userMessages,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

/** 配置脚本化模型轮次（工具调用或文本）。 */
async function scriptTurns(
  request: import('@playwright/test').APIRequestContext,
  turns: unknown[],
): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns },
  })
  expect(response.ok()).toBe(true)
}

/** 展开已完成（非错误）的工具折叠行。 */
async function expandTool(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `已运行 ${name}` }).click()
}

/** 图片节点存在不等于真实解码成功：必须等到浏览器得到非零自然尺寸。 */
async function expectDecodedImage(image: Locator): Promise<void> {
  await image.scrollIntoViewIfNeeded()
  await expect
    .poll(async () => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
}

test('工具图片：纯图片与图文混合结果在会话与重开后可见', async ({ page, request }) => {
  const run = Date.now().toString(36)
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)

  // 图文混合：文本与图片同时呈现。
  await scriptTurns(request, [{ tool: { name: 'e2e-image', args: {} } }, { text: '混合完成' }])
  await sendMessage(page, `混合图片-${run}`)
  await expect(assistantMessages(page).last()).toContainText('混合完成')
  await expandTool(page, 'e2e-image')
  const mixedCard = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-image' }).last()
  await expect(mixedCard).toContainText('IMAGE-MIXED-TEXT')
  const mixedImages = mixedCard.locator('[data-slot="huan-tool-images"] img')
  await expect(mixedImages).toHaveCount(1)
  await expect(mixedImages.first()).toHaveAttribute('alt', '工具 e2e-image 输出图片 1')
  await expectDecodedImage(mixedImages.first())

  // 纯图片：没有文本也要能看到图片，而不是空结果。
  await scriptTurns(request, [
    { tool: { name: 'e2e-image', args: { mode: 'pure' } } },
    { text: '纯图片完成' },
  ])
  await sendMessage(page, `纯图片-${run}`)
  await expect(assistantMessages(page).last()).toContainText('纯图片完成')
  const toolCards = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-image' })
  const pureCard = toolCards.last()
  await pureCard.getByRole('button').first().click()
  const pureImages = pureCard.locator('[data-slot="huan-tool-images"] img')
  await expect(pureImages).toHaveCount(1)
  await expectDecodedImage(pureImages.first())

  // 重开历史：图片来自持久结果，不依赖内存中的执行状态。
  const title = `混合图片-${run}`
  await page.reload()
  await threadListItem(page, title).click()
  const historyCard = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-image' }).last()
  await historyCard.getByRole('button').first().click()
  const historyImages = historyCard.locator('[data-slot="huan-tool-images"] img')
  await expect(historyImages).toHaveCount(1)
  await expectDecodedImage(historyImages.first())
})

test('工具损坏图片：受控错误保留原替代文本与来源，不生成空预览', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const title = `损坏图片-${run}`
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)

  await scriptTurns(request, [
    { tool: { name: 'e2e-image', args: { mode: 'broken' } } },
    { text: '损坏图片完成' },
  ])
  await sendMessage(page, title)
  await expect(assistantMessages(page).last()).toContainText('损坏图片完成')
  await expandTool(page, 'e2e-image')
  const card = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-image' }).last()
  const error = card.locator('[data-slot="huan-image-error"]')
  await expect(error).toBeVisible()
  await expect(error).toContainText('图片加载失败')
  await expect(error).toContainText('原替代文本：工具 e2e-image 输出图片 1')
  await expect(error).toContainText('来源：data:image/png;base64,')
  // 失败图不再渲染 img 或预览触发器，避免打开只有空图片框的 Dialog。
  await expect(card.locator('[data-slot="huan-tool-images"] img')).toHaveCount(0)
  await expect(
    card.getByRole('button', { name: '预览图片：工具 e2e-image 输出图片 1' }),
  ).toHaveCount(0)

  // 重开历史后错误仍可读，不依赖一次性内存状态。
  await page.reload()
  await threadListItem(page, title).click()
  await expandTool(page, 'e2e-image')
  const historyError = page
    .locator('[data-slot="trace"]')
    .filter({ hasText: 'e2e-image' })
    .last()
    .locator('[data-slot="huan-image-error"]')
  await expect(historyError).toContainText('图片加载失败')
  await expect(historyError).toContainText('原替代文本：工具 e2e-image 输出图片 1')
})

test('嵌套工具：父子关系、进度与待答请求可发现可操作', async ({ page, request }) => {
  const run = Date.now().toString(36)
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)

  await scriptTurns(request, [{ tool: { name: 'e2e-nested', args: {} } }, { text: '嵌套完成' }])
  await sendMessage(page, `嵌套工具-${run}`)

  // 子工具阻塞在确认请求上：应答入口在输入区上方，带工具关联标识。
  const requestCard = page
    .locator('[data-slot="huan-host-ui-request"]')
    .filter({ hasText: 'E2E 子工具确认' })
  await expect(requestCard).toBeVisible({ timeout: 20_000 })
  await expect(requestCard.locator('[data-slot="huan-request-tool"]')).toContainText('工具关联')
  // 工具行明确显示等待交互，而不是“已完成”。请求归属到正在执行的父工具调用。
  const pendingParent = page.getByRole('button', { name: '等待交互：e2e-nested' })
  await expect(pendingParent).toBeVisible()
  // 展开父项可见带 parentToolCallId 的子调用行（父子关系来自执行事件）。
  await pendingParent.click()
  const nested = page.locator('[data-slot="huan-nested-tools"]').last()
  await expect(nested).toBeVisible()
  const childLine = nested.locator('[data-parent-tool-call-id]').first()
  await expect(childLine).toHaveAttribute('data-parent-tool-call-id', /^call_/)
  await expect(nested).toContainText('e2e-child-ask')
  // 子工具在确认前上报了固定进度：展开子调用后，部分输出与参数都必须在正文可见，
  // 不能只核对名字行。
  await childLine.click()
  const childCard = nested
    .locator('[data-slot="trace"]')
    .filter({ hasText: 'e2e-child-ask' })
    .last()
  await expect(childCard).toContainText('CHILD-PROGRESS:nested-progress-arg')
  await expect(childCard).toContainText('"note": "nested-progress-arg"')
  await expect(childCard).toContainText('工具仍在运行，以下为部分输出。')

  await requestCard.getByRole('button', { name: '允许' }).click()
  await expect(assistantMessages(page).last()).toContainText('嵌套完成', { timeout: 20_000 })
  await expect(page.getByRole('button', { name: '等待交互：e2e-nested' })).toHaveCount(0)

  // 历史记录保留有界子调用摘要与父工具输出。
  await expandTool(page, 'e2e-nested')
  const parentCard = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-nested' }).last()
  await expect(parentCard).toContainText('NESTED-PARENT-DONE')
  const summary = parentCard.locator('[data-slot="huan-nested-calls"]')
  await expect(summary).toContainText('子调用摘要')
  await expect(summary).toContainText('e2e-child-ask')
  await expect(summary).toContainText('nested-progress-arg')
})

test('工具关联的编辑器请求保留原文与多行编辑', async ({ page, request }) => {
  const run = Date.now().toString(36)
  await openApp(page)
  await startNewSession(page, 'workspace')
  await selectModel(page)

  await scriptTurns(request, [{ tool: { name: 'e2e-editor', args: {} } }, { text: '编辑器完成' }])
  await sendMessage(page, `编辑器原文-${run}`)

  const requestCard = page
    .locator('[data-slot="huan-host-ui-request"]')
    .filter({ hasText: 'E2E 编辑器请求' })
  await expect(requestCard).toBeVisible({ timeout: 20_000 })
  const editor = requestCard.getByRole('textbox', { name: '交互编辑器' })
  // 工具关联的 editor 请求必须带原文预填，并与游离请求行为一致。
  await expect(editor).toHaveValue('第一行原文\n第二行原文')
  await editor.fill('第一行原文\n第二行原文\n第三行修订')
  await requestCard.getByRole('button', { name: '提交' }).click()
  await expect(assistantMessages(page).last()).toContainText('编辑器完成', { timeout: 20_000 })
  await expect(requestCard).toHaveCount(0)
  // 工具收到的是完整多行原文（换行在结果里以 | 呈现）。
  await expandTool(page, 'e2e-editor')
  const editorCard = page.locator('[data-slot="trace"]').filter({ hasText: 'e2e-editor' }).last()
  await expect(editorCard).toContainText('EDITOR-ANSWER:第一行原文|第二行原文|第三行修订')
})

/** 用宿主进程内真实 SessionManager 生成 setup-only 导入源。 */
async function createSetupOnlySource(
  request: import('@playwright/test').APIRequestContext,
  input: { cwd: string; provider: string; modelId: string; name: string },
): Promise<{ sourcePath: string; threadId: string; name: string; cwd: string }> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/sessions/setup-only-source`, {
    data: input,
  })
  expect(response.ok()).toBe(true)
  return (await response.json()) as {
    sourcePath: string
    threadId: string
    name: string
    cwd: string
  }
}

/** 写入导入源文件并返回宿主可读的绝对路径。 */
async function writeSource(
  _request: import('@playwright/test').APIRequestContext,
  testInfo: import('@playwright/test').TestInfo,
  name: string,
  content: string,
): Promise<string> {
  const { writeFile } = await import('node:fs/promises')
  const file = testInfo.outputPath(name)
  await writeFile(file, content)
  return file
}

const TIMESTAMP = '2026-11-02T00:00:00.000Z'

/** 构造带额外条目的 Pi JSONL（用于未知数据与模型回退场景）。 */
function sessionJsonl(options: {
  id: string
  cwd: string
  text: string
  model?: { provider: string; model: string }
  extraEntries?: Record<string, unknown>[]
}): string {
  const { id, cwd, text, model = { provider: 'huan-test', model: 'test-model-a' } } = options
  const userTimestamp = Date.parse(TIMESTAMP) + 1
  const header = { type: 'session', version: 3, id, timestamp: TIMESTAMP, cwd }
  const entries: Record<string, unknown>[] = [
    {
      type: 'message',
      id: 'entry-user',
      parentId: null,
      timestamp: new Date(userTimestamp).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: userTimestamp },
    },
    {
      type: 'message',
      id: 'entry-assistant',
      parentId: 'entry-user',
      timestamp: new Date(userTimestamp + 1).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '导入回答' }],
        api: 'openai-completions',
        provider: model.provider,
        model: model.model,
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
    ...(options.extraEntries ?? []),
  ]
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/** 经 GUI 从宿主路径导入并打开会话。 */
async function importSource(
  page: import('@playwright/test').Page,
  sourcePath: string,
  workspaceName: string,
): Promise<void> {
  await page.getByRole('button', { name: '导入 JSONL', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导入 JSONL 会话' })
  await dialog.getByRole('combobox', { name: '目标工作区' }).click()
  await page.getByRole('option', { name: workspaceName, exact: true }).click()
  await dialog.getByLabel('服务端 JSONL 绝对路径').fill(sourcePath)
  await dialog.getByRole('button', { name: '预览导入' }).click()
  await expect(dialog.locator('[data-slot="huan-import-preview"]')).toBeVisible({
    timeout: 20_000,
  })
  await dialog.getByRole('button', { name: '确认导入' }).click()
  await expect(dialog.getByRole('status')).toContainText('会话已导入', { timeout: 20_000 })
  await dialog.getByRole('button', { name: '打开已导入会话' }).click()
  await expect(dialog).toHaveCount(0)
}

test('未知数据条目可读，不因缺专用 renderer 丢失', async ({ page, request }, testInfo) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `presentation-${run}`)
  const workspaceName = `展示工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  const text = `未知数据-${run}`
  const source = await writeSource(
    request,
    testInfo,
    'unknown.jsonl',
    sessionJsonl({
      id: `e2e-unknown-${run}`,
      cwd: project.path,
      text,
      extraEntries: [
        {
          type: 'message',
          id: 'entry-future',
          parentId: 'entry-assistant',
          timestamp: new Date(Date.parse(TIMESTAMP) + 3).toISOString(),
          message: { role: 'future-role', payload: { marker: `FUTURE-${run}` } },
        },
      ],
    }),
  )
  await openApp(page)
  await importSource(page, source, workspaceName)
  await expect(userMessages(page).first()).toContainText(text)
  const unknown = page.locator('[data-slot="huan-unknown-data"]').last()
  await expect(unknown).toBeVisible()
  await expect(unknown).toContainText('future-role')
  await expect(unknown).toContainText(`FUTURE-${run}`)
})

test('无消息历史的导入会话使用有效模型并可继续首条发送', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `empty-history-${run}`)
  const workspaceName = `空历史工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  const title = `空历史会话-${run}`
  // 真实 SessionManager 生成 model_change + session_info，没有 user/assistant 消息。
  const source = await createSetupOnlySource(request, {
    cwd: project.path,
    provider: 'huan-test',
    modelId: 'test-model-b',
    name: title,
  })

  await openApp(page)
  await importSource(page, source.sourcePath, workspaceName)
  // 导入后直接打开该空会话，不做页面刷新或目录重扫。
  await expect(threadListItem(page, title)).toBeVisible()
  await expect(page.locator('[data-slot="huan-session-context"]')).toContainText(project.path)
  await expect(userMessages(page)).toHaveCount(0)
  await expect(assistantMessages(page)).toHaveCount(0)

  // 真实宿主快照必须仍是 0 消息、ready 且带有效模型。
  await expect
    .poll(async () => {
      const response = await request.get(`${E2E_HOST_URL}/api/pi/threads/${source.threadId}`)
      if (!response.ok()) return `http-${response.status()}`
      const body = (await response.json()) as {
        messages?: unknown[]
        readiness?: { state?: string }
        metadata?: { config?: { provider?: string; modelId?: string } }
      }
      return `${body.messages?.length ?? -1}:${body.readiness?.state ?? 'none'}:${
        body.metadata?.config?.provider ?? '-'
      }:${body.metadata?.config?.modelId ?? '-'}`
    })
    .toMatch(/^0:ready:huan-test:.+$/)
  // Pi SDK 仅在有消息历史时才恢复 model_change；本会话保存 B 但空历史实际使用
  // 首个可用模型 A（不是失败回退），因此无回退原因且选择器已有有效模型。
  await expect(page.locator('[data-slot="huan-session-fallback"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="huan-composer"]').getByRole('combobox')).toContainText(
    'Test Model A',
  )

  // 同一空会话可直接发送首条消息，证明恢复后的模型可用。
  await sendMessage(page, `空历史首条-${run}`)
  await expect(userMessages(page).last()).toContainText(`空历史首条-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
})

test('历史模型不可用时展示受控回退原因且不泄露原始错误', async ({ page, request }, testInfo) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `fallback-${run}`)
  const workspaceName = `回退工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  const text = `回退会话-${run}`
  const source = await writeSource(
    request,
    testInfo,
    'fallback.jsonl',
    sessionJsonl({
      id: `e2e-fallback-${run}`,
      cwd: project.path,
      text,
      model: { provider: 'huan-test', model: 'ghost-model' },
    }),
  )
  await openApp(page)
  // 可用模型的新会话没有回退提示；无消息历史由独立用例覆盖。
  await startNewSession(page, workspaceName)
  await selectModel(page)
  await sendMessage(page, `正常会话-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  await expect(page.locator('[data-slot="huan-session-fallback"]')).toHaveCount(0)

  await importSource(page, source, workspaceName)
  await expect(userMessages(page).first()).toContainText(text)
  // 先确认宿主已经记录按会话投影的回退原因（进展点来自真实宿主），再看界面。
  await expect
    .poll(
      async () => {
        const response = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
        const listed = (await response.json()) as Array<{
          title?: string
          modelFallback?: { reason?: string }
          config?: { provider?: string; modelId?: string }
        }>
        const hit = listed.find((item) => item.title === text)
        return hit?.modelFallback?.reason
      },
      { timeout: 20_000 },
    )
    .toBe('restore-failed')
  // 不手动重扫或reload；live首帧必须自动更新回退原因。
  const fallback = page.locator('[data-slot="huan-session-fallback"]')
  await expect(fallback).toBeVisible({ timeout: 20_000 })
  await expect(fallback).toContainText('huan-test/ghost-model')
  await expect(fallback).not.toContainText('Error:')
  await expect(fallback).not.toContainText('at ')

  // 服务诊断只展示全局状态；按会话的回退原因在会话详情核对。
  await chooseSessionAction(page, '详情')
  const details = page.getByRole('dialog', { name: '会话详情' })
  await expect(details).toBeVisible()
  const detailsFallback = details.locator('[data-slot="huan-details-fallback"]')
  await expect(detailsFallback).toContainText('历史恢复时原模型不可用')
  await expect(detailsFallback).toContainText('huan-test/ghost-model')
  await expect(detailsFallback).toContainText('已使用')
  await expect(detailsFallback).not.toContainText('Error:')
  await expect(detailsFallback).not.toContainText('at ')
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)

  // 会话仍可继续对话（使用有效模型）。
  await messageInput(page).fill(`回退后继续-${run}`)
  await selectModel(page)
  await sendMessage(page, `回退后继续-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
})
