import { expect, test } from '@playwright/test'
import {
  assistantMessages,
  configureStream,
  finishStream,
  openApp,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  streamState,
  subscriptions,
} from './helpers.js'

// 只在测试浏览器内观察提交并计数函数入口，不向生产组件加入计数器。
test('大量历史下输入与流式输出不刷新无关会话行', async ({ page, context, request }, testInfo) => {
  test.setTimeout(120_000)
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
  try {
    await openApp(page)
    for (const target of [250, 1000]) {
      while (ids.length < target) {
        const response = await request.post('http://127.0.0.1:8898/__e2e__/sessions', {
          data: { text: `${prefix}-${ids.length}`, name: `${prefix}-${ids.length}` },
        })
        expect(response.ok()).toBe(true)
        ids.push((await response.json()).id)
      }
      await page.getByRole('button', { name: '刷新工作区', exact: true }).click()
      const rows = page.locator('[data-slot="huan-session-row"]').filter({ hasText: prefix })
      await expect(rows).toHaveCount(target)
      const input = page.getByRole('textbox', { name: 'Message input', exact: true })
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
    }
    await page.getByRole('textbox', { name: 'Message input', exact: true }).fill('')
    await selectModel(page)
    await sendMessage(page, `${prefix}-准备`)
    await expect(assistantMessages(page).last()).toBeVisible()
    await expect(page.locator('[data-slot="huan-run-status"]')).toHaveCount(0)
    await configureStream(request, ['性能输出一。', '性能输出二。', '性能输出三。'])
    const listUpdated = page.waitForResponse(
      (response) =>
        response.url().includes('/api/pi/threads?') && response.request().method() === 'GET',
    )
    await sendMessage(page, `${prefix}-运行`)
    await listUpdated
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
    expect(errors).toEqual([])
  } finally {
    await resetStream(request)
    // 外部创建的历史逐条经公开 API 删除，避免给其余流程留下大列表。
    await page.close()
    for (const id of ids) {
      const response = await request.delete(`http://127.0.0.1:8898/api/pi/threads/${id}`)
      expect(response.ok()).toBe(true)
    }
    await testInfo.attach('render-performance.json', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    })
  }
})
