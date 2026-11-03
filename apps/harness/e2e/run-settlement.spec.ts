/**
 * 运行结算边界验收：agent_end 不等于空闲，agent_settled 才回到 idle。
 *
 * 窗口由隔离临时项目内的测试扩展制造：`agent_before_settle` 先等待文件 gate。
 * 按 Pi SDK 的执行顺序（`agent-session.js` 中 `_startRun` 与 `_handleAgentEvent`），
 * 公开的 `agent_end` 事件在 before_settle 之前已发出并完成扩展分发，因此
 * gate 进入时服务端已越过 agent_end，但尚未发出 `agent_settled`。测试不靠固定
 * 等待时间，只用 gate 文件和服务端/浏览器状态推进。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { E2E_HOST_URL } from './config.js'
import {
  assistantMessages,
  createProject,
  createWorkspaceApi,
  openApp,
  resetStream,
  selectModel,
  sendMessage,
  startNewSession,
  workspaceGroup,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.afterEach(async ({ request }) => {
  await resetStream(request)
})

/** 结算 gate 文件（位于隔离临时项目内）。 */
type SettleGate = {
  enabled: string
  entered: string
  release: string
  continueArmed: string
  continued: string
}

/** 最小会话快照形状（只声明本用例断言的字段）。 */
type ThreadSnapshot = {
  metadata: { status: string; compactionActive?: boolean; retryActive?: boolean }
  messages: readonly { role: string; content?: unknown }[]
}

/** 在隔离临时项目里写一个只服务结算窗口的扩展。 */
function writeSettleProbe(projectPath: string, gate: SettleGate): void {
  const extensionDir = join(projectPath, '.pi', 'extensions')
  mkdirSync(extensionDir, { recursive: true })
  writeFileSync(
    join(extensionDir, 'settle-probe.js'),
    `import { existsSync, rmSync, writeFileSync } from 'node:fs'

export default function (pi) {
  pi.on('agent_before_settle', async () => {
    // 自动继续：只消费一次 armed 标记，下一次结算才进入 gate。助手回复后
    // 直接 continue 没有可运行上下文，必须先追加一条不显示的 custom_message。
    if (existsSync(${JSON.stringify(gate.continueArmed)})) {
      rmSync(${JSON.stringify(gate.continueArmed)}, { force: true })
      writeFileSync(${JSON.stringify(gate.continued)}, 'continued')
      return {
        entries: [
          {
            type: 'custom_message',
            customType: 'e2e-continue',
            content: 'E2E 自动继续一次',
            display: false,
          },
        ],
        continue: true,
      }
    }
    if (!existsSync(${JSON.stringify(gate.enabled)})) return
    writeFileSync(${JSON.stringify(gate.entered)}, String(Date.now()))
    const deadline = Date.now() + 45_000
    while (!existsSync(${JSON.stringify(gate.release)})) {
      if (Date.now() > deadline) throw new Error('settle gate timeout')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
}
`,
  )
}

/** 新建只含一个项目的隔离工作区，并写入结算探针扩展。 */
async function prepareSettleWorkspace(
  request: APIRequestContext,
  label: string,
): Promise<{ workspaceName: string; gate: SettleGate }> {
  const run = Date.now().toString(36)
  const project = await createProject(request, `${label}-${run}`)
  const workspaceName = `${label}工作区-${run}`
  await createWorkspaceApi(request, workspaceName, [{ alias: 'p', path: project.path }])
  const gate: SettleGate = {
    enabled: join(project.path, '.pi', 'gate-enabled'),
    entered: join(project.path, '.pi', 'gate-entered'),
    release: join(project.path, '.pi', 'gate-release'),
    continueArmed: join(project.path, '.pi', 'continue-armed'),
    continued: join(project.path, '.pi', 'continue-done'),
  }
  writeSettleProbe(project.path, gate)
  return { workspaceName, gate }
}

/** 放行仍被阻塞的结算；保留 entered/release 供失败后核对，只撤掉会再触发的开关。 */
function releaseGate(gate: SettleGate): void {
  writeFileSync(gate.release, 'released')
  rmSync(gate.enabled, { force: true })
  rmSync(gate.continueArmed, { force: true })
}

/** 在管理工作区弹层完成项目信任决定（本次允许）。 */
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

/** 按标题读取会话快照（显式刷新作用域缓存）。 */
async function threadSnapshotByTitle(
  request: APIRequestContext,
  title: string,
): Promise<ThreadSnapshot> {
  const list = await request.get(`${E2E_HOST_URL}/api/pi/threads?refresh=true`)
  expect(list.ok()).toBe(true)
  const threads = (await list.json()) as Array<{ id: string; title?: string }>
  const hit = threads.find((thread) => thread.title === title)
  if (!hit) throw new Error(`未找到会话：${title}`)
  const response = await request.get(`${E2E_HOST_URL}/api/pi/threads/${hit.id}`)
  expect(response.ok()).toBe(true)
  return (await response.json()) as ThreadSnapshot
}

/** 会话快照中助手文本（只用于确认 agent_end 产物已落地）。 */
function assistantTexts(snapshot: ThreadSnapshot): string[] {
  return snapshot.messages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
    return (message.content as Array<{ type?: unknown; text?: unknown }>).flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
  })
}

/** 最近一条助手消息外层（`data-status` 由运行状态投影）。 */
const lastAssistantWrapper = (page: Page) => assistantMessages(page).last().locator('xpath=..')

async function scriptTurns(request: APIRequestContext, turns: unknown[]): Promise<void> {
  const response = await request.post(`${E2E_HOST_URL}/__e2e__/model-turns`, {
    data: { turns },
  })
  expect(response.ok()).toBe(true)
}

test('agent_end 后服务端与 GUI 保持 running，agent_settled 才结算', async ({ page, request }) => {
  const { workspaceName, gate } = await prepareSettleWorkspace(request, '结算窗口')
  await openApp(page)
  await trustWorkspaceProject(page, workspaceName)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  writeFileSync(gate.enabled, 'enabled')
  const title = `结算窗口-${Date.now().toString(36)}`
  try {
    await scriptTurns(request, [{ text: 'SETTLE-WINDOW-TEXT' }])
    await sendMessage(page, title)
    // gate 进入意味着服务端已发出 agent_end、尚未发出 agent_settled。
    await expect.poll(() => existsSync(gate.entered), { timeout: 20_000 }).toBe(true)

    // 服务端进展点：运行仍未结算，agent_end 的助手消息已落地；
    // running 不是压缩/重试造成的，而是结算窗口本身。
    const running = await threadSnapshotByTitle(request, title)
    expect(running.metadata.status).toBe('running')
    expect(running.metadata.compactionActive).toBe(false)
    expect(running.metadata.retryActive).toBe(false)
    expect(assistantTexts(running).join('\n')).toContain('SETTLE-WINDOW-TEXT')

    // GUI：正文已经完整呈现，但运行状态仍为 running（agent_end 不提前空闲）。
    await expect(assistantMessages(page).last()).toContainText('SETTLE-WINDOW-TEXT')
    await expect(page.locator('[data-slot="huan-run-status"]')).toContainText('运行中')
    await expect(lastAssistantWrapper(page)).toHaveAttribute('data-status', 'running')
  } finally {
    releaseGate(gate)
  }

  // agent_settled 后才回到 idle，消息正文保留。
  await expect
    .poll(async () => (await threadSnapshotByTitle(request, title)).metadata.status)
    .toBe('idle')
  await expect(page.locator('[data-slot="huan-run-status"]')).toHaveCount(0)
  await expect(assistantMessages(page).last()).toContainText('SETTLE-WINDOW-TEXT')
  await expect(lastAssistantWrapper(page)).toHaveAttribute('data-status', 'complete')
})

test('自动继续期间保持 running，第二次结算后才回到 idle', async ({ page, request }) => {
  const { workspaceName, gate } = await prepareSettleWorkspace(request, '自动继续')
  await openApp(page)
  await trustWorkspaceProject(page, workspaceName)
  await startNewSession(page, workspaceName)
  await selectModel(page)
  writeFileSync(gate.enabled, 'enabled')
  writeFileSync(gate.continueArmed, 'armed')
  const title = `自动继续-${Date.now().toString(36)}`
  try {
    // 第一次 agent_end 后 before_settle 请求继续；第二次 agent_end 后才进入 gate。
    await scriptTurns(request, [{ text: 'CONTINUE-FIRST' }, { text: 'CONTINUE-SECOND' }])
    await sendMessage(page, title)
    await expect.poll(() => existsSync(gate.entered), { timeout: 20_000 }).toBe(true)
    expect(existsSync(gate.continued)).toBe(true)

    // 服务端仍 running，且两次运行的助手消息都已落地。
    const running = await threadSnapshotByTitle(request, title)
    expect(running.metadata.status).toBe('running')
    expect(running.metadata.compactionActive).toBe(false)
    expect(running.metadata.retryActive).toBe(false)
    const texts = assistantTexts(running).join('\n')
    expect(texts).toContain('CONTINUE-FIRST')
    expect(texts).toContain('CONTINUE-SECOND')

    // GUI：两段回复可见，运行状态没有在两次 agent_end 之间提前结算。
    await expect(assistantMessages(page).filter({ hasText: 'CONTINUE-FIRST' })).toHaveCount(1)
    await expect(assistantMessages(page).last()).toContainText('CONTINUE-SECOND')
    await expect(page.locator('[data-slot="huan-run-status"]')).toContainText('运行中')
    await expect(assistantMessages(page).last().locator('xpath=..')).toHaveAttribute(
      'data-status',
      'running',
    )
  } finally {
    releaseGate(gate)
  }

  await expect
    .poll(async () => (await threadSnapshotByTitle(request, title)).metadata.status)
    .toBe('idle')
  await expect(page.locator('[data-slot="huan-run-status"]')).toHaveCount(0)
  await expect(assistantMessages(page).last()).toContainText('CONTINUE-SECOND')
  await expect(lastAssistantWrapper(page)).toHaveAttribute('data-status', 'complete')
})
