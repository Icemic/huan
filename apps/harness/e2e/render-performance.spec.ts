import { writeFile } from 'node:fs/promises'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  assistantMessages,
  chooseSessionAction,
  configureStream,
  controlInfo,
  finishStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  streamState,
  subscriptions,
} from './helpers.js'
import { RENDER_REVIEW_MARKER } from './render-review.js'

/** 一段代表性长 Markdown：标题、列表、表格、代码块与结尾标记。 */
function buildLongMarkdown(prefix: string, tail: string): string {
  const lines: string[] = [
    `## ${prefix} 长输出标题`,
    '',
    `${prefix} 正文首段，用于验证长内容布局。`,
    '',
  ]
  for (let index = 0; index < 40; index += 1) {
    lines.push(
      `### 小节 ${index + 1}`,
      '',
      `- 条目 ${index + 1}-甲：${prefix}`,
      `- 条目 ${index + 1}-乙`,
      '',
    )
  }
  lines.push('| 列一 | 列二 |', '| --- | --- |', '| A | B |', '')
  lines.push('```ts', `const tail = '${tail}'`, '```', '', `结尾标记：${tail}`, '')
  return lines.join('\n')
}

/** 写入 120 轮会话的 JSONL（导入后用于树面板长列表测量）。 */
async function writeTreeSource(
  request: APIRequestContext,
  prefix: string,
): Promise<{ path: string; workspaceName: string }> {
  const info = await controlInfo(request)
  const header = {
    type: 'session',
    version: 3,
    id: `e2e-perf-tree-${Date.now().toString(36)}`,
    timestamp: new Date().toISOString(),
    cwd: info.workspacePath,
  }
  const entries: Record<string, unknown>[] = []
  let parentId: string | null = null
  for (let index = 0; index < 120; index += 1) {
    const userId = `user-${index}`
    const assistantId = `assistant-${index}`
    const timestamp = Date.now() + index * 2
    entries.push({
      type: 'message',
      id: userId,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${prefix}-第 ${index} 问` }],
        timestamp,
      },
    })
    entries.push({
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: new Date(timestamp + 1).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${prefix}-第 ${index} 答` }],
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
        timestamp: timestamp + 1,
      },
    })
    parentId = assistantId
  }
  const content = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
  const response = await request.put('http://127.0.0.1:8898/__e2e__/file', {
    data: { root: 'workspace', path: `perf-tree-${prefix}.jsonl`, content },
  })
  expect(response.ok()).toBe(true)
  // 选择包含导入源 cwd 的工作区：全套运行时目录里还有其他工作区。
  const workspaces = (await (
    await request.get('http://127.0.0.1:8898/api/pi/workspaces')
  ).json()) as {
    workspaces: Array<{ name: string; projects: Array<{ path: string }> }>
  }
  const target = workspaces.workspaces.find((workspace) =>
    workspace.projects.some((project) => project.path === info.workspacePath),
  )
  expect(target).toBeTruthy()
  return {
    path: `${info.workspacePath}\\perf-tree-${prefix}.jsonl`,
    workspaceName: (target as { name: string }).name,
  }
}

/** 经 GUI 导入并打开会话；之后由调用方打开树面板。 */
async function openImportedSession(
  page: Page,
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
  await expect(dialog.getByRole('status')).toContainText('会话已导入', { timeout: 30_000 })
  await dialog.getByRole('button', { name: '打开已导入会话' }).click()
  await expect(dialog).toHaveCount(0)
}

// 只在测试浏览器内观察提交并计数函数入口，不向生产组件加入计数器。
test('大量历史下输入与流式输出不刷新无关会话行', async ({ page, context, request }, testInfo) => {
  test.setTimeout(300_000)
  await context.addInitScript(() => {
    const review = { rows: 0, commits: 0, longTasks: [] as number[] }
    const browserWindow = window as unknown as {
      __renderReview: typeof review
      __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
    }
    browserWindow.__renderReview = review
    const renderers = new Map()
    browserWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: unknown) {
        renderers.set(1, renderer)
        return 1
      },
      onCommitFiberRoot() {
        review.commits += 1
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
    }
    new PerformanceObserver((list) => {
      review.longTasks.push(...list.getEntries().map((entry) => entry.duration))
    }).observe({ type: 'longtask' })
  })
  let instrumented = false
  await page.route('**/src/components/workspace-sidebar.tsx*', async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    // Fiber 的 PerformedWork 标记在 bailout 后可保留，直接计数函数入口更可靠。
    // 仅统计无关会话行；当前会话的运行态与接受后的活动时间更新允许刷新自身。
    const body = source.replace(
      /(function SessionRowComponent\([\s\S]*?\)\s*\{)/,
      '$1 if (!active) window.__renderReview.rows += 1;',
    )
    instrumented ||= body !== source
    await route.fulfill({ response, body })
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const prefix = `性能历史-${Date.now().toString(36)}`
  const ids: string[] = []
  const resetCounters = () =>
    page.evaluate(() => {
      const review = (
        window as unknown as {
          __renderReview: { rows: number; commits: number; longTasks: number[] }
        }
      ).__renderReview
      review.rows = 0
      review.commits = 0
      review.longTasks = []
    })
  const readCounters = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __renderReview: { rows: number; commits: number; longTasks: number[] }
          }
        ).__renderReview,
    )
  const measurements: unknown[] = []
  const t0 = Date.now()
  const mark = (label: string) => console.log('PHASE', label, Date.now() - t0)
  try {
    await openApp(page)
    // 预览模式没有源码模块可拦截，由临时产物构建插件写入标记，证明已注入。
    instrumented ||= (await page.locator(`meta[name="${RENDER_REVIEW_MARKER}"]`).count()) > 0
    mark('app-ready')
    for (const target of [250, 1000]) {
      // 准备 1,250 条合成历史是分钟级工作：并发写文件，避免把准备时间算进测量。
      while (ids.length < target) {
        const batch = Math.min(25, target - ids.length)
        const created = await Promise.all(
          Array.from({ length: batch }, async () => {
            const index = ids.length
            const response = await request.post('http://127.0.0.1:8898/__e2e__/sessions', {
              data: { text: `${prefix}-${index}`, name: `${prefix}-${index}` },
            })
            expect(response.ok()).toBe(true)
            return ((await response.json()) as { id: string }).id
          }),
        )
        ids.push(...created)
      }
      mark(`created-${target}`)
      await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
      const rows = page.locator('[data-slot="huan-session-row"]').filter({ hasText: prefix })
      await expect(rows).toHaveCount(target)
      const input = page.getByRole('textbox', { name: '消息输入', exact: true })
      await input.fill('')
      await input.focus()
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await resetCounters()
      const latency: number[] = []
      // 该值是 Playwright 键入往返加双帧等待，只用于同环境对照，不是浏览器 INP。
      for (const character of 'abcdefghijklmnopqrst') {
        const start = performance.now()
        await page.keyboard.type(character)
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
        latency.push(performance.now() - start)
      }
      const counters = await readCounters()
      measurements.push({ target, latency, ...counters })
      console.log(JSON.stringify({ target, latency, ...counters }))
      expect(instrumented).toBe(true)
      expect(counters.commits).toBeGreaterThan(0)
      expect(counters.rows).toBe(0)
      await expect(input).toHaveValue('abcdefghijklmnopqrst')
      mark(`typed-${target}`)
    }
    await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('')
    mark('select-model')
    await selectModel(page)
    await sendMessage(page, `${prefix}-准备`)
    mark('sent-first')
    await expect(assistantMessages(page).last()).toBeVisible()
    await expect(page.locator('[data-slot="huan-run-status"]')).toHaveCount(0)
    mark('first-reply-settled')
    await configureStream(request, ['性能输出一。', '性能输出二。', '性能输出三。'])
    await sendMessage(page, `${prefix}-运行`)
    // 运行中的状态行是提交被接受的可见信号；目录刷新不在发送路径上。
    await expect(page.locator('[data-slot="huan-run-status"]')).toBeVisible()
    await expect.poll(async () => (await streamState(request)).active).toBe(true)
    await releaseSegment(request)
    await expect(assistantMessages(page).last()).toContainText('性能输出一。')
    const before = await subscriptions(request)
    await resetCounters()
    await releaseSegment(request)
    await expect(assistantMessages(page).last()).toContainText('性能输出二。')
    await releaseSegment(request)
    await expect(assistantMessages(page).last()).toContainText('性能输出三。')
    const streamCounters = await readCounters()
    measurements.push({ stream: streamCounters })
    expect(streamCounters.rows).toBe(0)
    expect((await subscriptions(request)).totalSubscriptions).toBe(before.totalSubscriptions)
    await finishStream(request)
    await expect.poll(async () => (await streamState(request)).completed).toBe(1)
    mark('stream-done')

    // 代表性长 Markdown：一次输出约 200 行含标题/列表/表格/代码块的内容。
    const markdownTail = `MD-END-${prefix}`
    await configureStream(request, [buildLongMarkdown(prefix, markdownTail)])
    await sendMessage(page, `${prefix}-长输出`)
    await expect.poll(async () => (await streamState(request)).active).toBe(true)
    await resetCounters()
    const markdownStart = Date.now()
    await releaseSegment(request)
    await finishStream(request)
    const markdownMessage = assistantMessages(page).last()
    await expect(markdownMessage).toContainText(markdownTail, { timeout: 60_000 })
    const markdownMs = Date.now() - markdownStart
    const markdownView = {
      ms: markdownMs,
      headings: await markdownMessage.locator('h2, h3').count(),
      tables: await markdownMessage.locator('table').count(),
      codeBlocks: await markdownMessage.locator('[data-slot="code-block"]').count(),
      ...(await readCounters()),
    }
    measurements.push({ markdown: markdownView })
    console.log(JSON.stringify({ markdown: markdownView }))
    // 长输出渲染不能连带刷新无关会话行。
    expect(markdownView.rows).toBe(0)
    expect(markdownView.headings).toBeGreaterThan(0)
    expect(markdownView.tables).toBe(1)
    expect(markdownView.codeBlocks).toBeGreaterThan(0)

    // 代表性长树：导入 120 轮会话后测量树面板首次列出全部节点的时间。
    console.log('phase tree: writing source')
    const treeSource = await writeTreeSource(request, prefix)
    console.log('phase tree: importing')
    await openImportedSession(page, treeSource.path, treeSource.workspaceName)
    console.log('phase tree: opening panel')
    const treeStart = Date.now()
    await chooseSessionAction(page, '会话树')
    const treeDialog = page.getByRole('dialog', { name: '会话树' })
    await expect(treeDialog).toBeVisible()
    const treeRows = treeDialog.locator('[data-slot="huan-tree-row"]')
    await expect(treeRows.first()).toBeVisible()
    const treeMs = Date.now() - treeStart
    const treeCount = await treeRows.count()
    measurements.push({ tree: { ms: treeMs, rows: treeCount } })
    console.log(JSON.stringify({ tree: { ms: treeMs, rows: treeCount } }))
    expect(treeCount).toBeGreaterThan(200)
    await page.keyboard.press('Escape')
    await expect(treeDialog).toHaveCount(0)

    // 首次布局：在 1,000 条历史目录下重新加载，测量到输入可用与正文可见。
    console.log('phase reload')
    const firstLayoutStart = Date.now()
    await page.reload()
    await expect(page.getByRole('textbox', { name: '消息输入' })).toBeEnabled()
    await expect(page.locator('[data-slot="huan-chat-messages"]')).toBeVisible()
    const firstLayoutMs = Date.now() - firstLayoutStart
    const layoutMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined
      const scripts = (
        performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      ).filter((entry) => entry.initiatorType === 'script')
      return {
        domContentLoaded: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
        firstPaint: Math.round(performance.getEntriesByType('paint')[0]?.startTime ?? 0),
        nodes: document.querySelectorAll('*').length,
        jsTransferBytes: scripts.reduce((sum, entry) => sum + entry.transferSize, 0),
        jsDecodedBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      }
    })
    measurements.push({ firstLayout: { ms: firstLayoutMs, ...layoutMetrics } })
    console.log(JSON.stringify({ firstLayout: { ms: firstLayoutMs, ...layoutMetrics } }))
    measurements.push({
      method: {
        inputLatency: 'Playwright 键入往返（含双帧等待），不是浏览器 INP',
        jsBytes: 'performance resource timing，initiatorType=script',
      },
    })
    expect(errors).toEqual([])
  } finally {
    await resetStream(request)
    // 外部创建的历史逐条经公开 API 删除，避免给其余流程留下大列表。
    await page.close()
    // 并发清理，避免清理阶段把整个用例拖过超时。
    for (let index = 0; index < ids.length; index += 25) {
      const batch = ids.slice(index, index + 25)
      const removed = await Promise.all(
        batch.map((id) => request.delete(`http://127.0.0.1:8898/api/pi/threads/${id}`)),
      )
      for (const response of removed) expect(response.ok()).toBe(true)
    }
    const report = JSON.stringify(measurements, null, 2)
    await testInfo.attach('render-performance.json', {
      body: report,
      contentType: 'application/json',
    })
    // 主 agent 需要直接读取的测量结果（不进仓库）。
    await writeFile(
      process.env.HUAN_PERF_REPORT ??
        'C:/Users/Icemic/AppData/Local/Temp/huan-r8/render-performance-report.json',
      report,
    )
  }
})
