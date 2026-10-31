import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  assistantMessages,
  configureStream,
  createProject,
  DEFAULT_REPLY,
  decideTrust,
  finishStream,
  openApp,
  openProject,
  projectSwitcher,
  releaseSegment,
  resetStream,
  selectModel,
  sendMessage,
  userMessages,
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

const markerLines = (marker: string | undefined): number => {
  if (!marker || !existsSync(marker)) return 0
  return readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).length
}

test('输入项目路径后展示信任来源，允许并记住后才执行项目扩展', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `trusted-${run}`, { extension: true })
  expect(markerLines(project.marker)).toBe(0)

  await openApp(page)
  await openProject(page, project.path)

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('项目需要信任确认')).toBeVisible()
  await expect(dialog.getByText(project.path)).toBeVisible()
  await expect(dialog.getByText('等待用户回答')).toBeVisible()
  expect(markerLines(project.marker)).toBe(0)

  await decideTrust(page, 'allow', true)
  await expect(projectSwitcher(page)).toContainText(project.name)
  expect(markerLines(project.marker)).toBe(1)

  // 已保存的信任决定在刷新后仍显示来源与保存路径，不再自动弹层。
  await page.reload()
  await expect(projectSwitcher(page)).toContainText(project.name)
  const trustButton = page.getByRole('button', { name: '查看项目信任状态' })
  await expect(trustButton.getByText('已信任')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await trustButton.click()
  await expect(dialog.getByText('本次决定')).toBeVisible()
  await expect(dialog.getByText(project.path).last()).toBeVisible()
})

test('拒绝信任仍可对话且不执行项目扩展', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `denied-${run}`, { extension: true })

  await openApp(page)
  await openProject(page, project.path)
  await decideTrust(page, 'deny')

  await expect(projectSwitcher(page)).toContainText(project.name)
  await expect(
    page.getByRole('button', { name: '查看项目信任状态' }).getByText('仅用户资源'),
  ).toBeVisible()
  expect(markerLines(project.marker)).toBe(0)

  await selectModel(page)
  await sendMessage(page, `拒绝项目后仍可对话-${run}`)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)
  expect(markerLines(project.marker)).toBe(0)
})

test('窗口项目选择独立，切换项目不终止运行，继续最近恢复已完成回复', async ({
  page,
  context,
  request,
}) => {
  const run = Date.now().toString(36)
  const projectA = await createProject(request, `running-a-${run}`)
  const projectB = await createProject(request, `running-b-${run}`)

  await openApp(page)
  await openProject(page, projectA.path)
  await expect(projectSwitcher(page)).toContainText(projectA.name)
  await selectModel(page)
  const first = `项目 A 的历史-${run}`
  await sendMessage(page, first)
  await expect(assistantMessages(page).last()).toContainText(DEFAULT_REPLY)

  const segment1 = '切换项目前的第一段。'
  const segment2 = '切换项目后完成第二段。'
  await configureStream(request, [segment1, segment2])
  await sendMessage(page, `项目 A 的运行-${run}`)
  await releaseSegment(request)
  await expect(assistantMessages(page).last()).toContainText(segment1, { timeout: 20_000 })

  // 运行中切到项目 B：本窗口列表换项目，但宿主运行继续。
  await openProject(page, projectB.path)
  await expect(projectSwitcher(page)).toContainText(projectB.name)

  // 第二个窗口保持自己的项目选择（默认启动项目），不受第一个窗口影响。
  const page2 = await context.newPage()
  await openApp(page2)
  await expect(projectSwitcher(page2)).not.toContainText(projectB.name)

  await releaseSegment(request)
  await finishStream(request)

  // 切回项目 A 并继续最近：断开的窗口靠新订阅/快照看到完整回复。
  await openProject(page, projectA.path)
  await expect(projectSwitcher(page)).toContainText(projectA.name)
  await page.getByRole('button', { name: '继续最近' }).click()
  await expect(assistantMessages(page).last()).toContainText(`${segment1}${segment2}`, {
    timeout: 20_000,
  })
  await expect(userMessages(page).last()).toContainText(`项目 A 的运行-${run}`)
  // 历史仍在：继续最近打开的是最近会话。
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
})

test('继续最近在没有历史时回到空白新建页且不发送消息', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const empty = await createProject(request, `empty-${run}`)

  await openApp(page)
  await openProject(page, empty.path)
  await expect(projectSwitcher(page)).toContainText(empty.name)

  await page.getByRole('button', { name: '继续最近' }).click()
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible()
  await expect(userMessages(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()

  // 项目中没有历史项，新建页即空白页。
  await expect(page.locator('[data-slot="aui_thread-list-item-trigger"]')).toHaveCount(0)
})

test('最近项目列表来自同一用户空间并可直接打开', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const project = await createProject(request, `recent-${run}`)

  await openApp(page)
  await openProject(page, project.path)
  await expect(projectSwitcher(page)).toContainText(project.name)

  await page.locator('[data-slot="huan-project-switcher"]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('最近项目')).toBeVisible()
  await dialog.getByRole('button', { name: new RegExp(project.name) }).click()
  await expect(projectSwitcher(page)).toContainText(project.name)
})
