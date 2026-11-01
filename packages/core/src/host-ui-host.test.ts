/**
 * G1.3c：宿主级交互通道、运行期 Host UI 与 commandContextActions。
 *
 * 真实 Pi SDK + 隔离临时用户空间 + 合成 provider；扩展源码写在临时 agentDir，
 * 不读取个人 Pi 配置，也不允许非合成端点联网。扩展内的标记路径使用字面量
 * （不用 process.env），避免依赖扩展执行环境的进程变量。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

let env: IsolatedPiEnv
let host: HarnessHost | undefined
let fetchStub: TestFetchStub
let savedEnv: Map<string, string | undefined>

const ISOLATED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 轮询直到回调返回非 undefined；用于等待异步交互登记。 */
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 4_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (value !== undefined) return value
    await delay(10)
  }
  throw new Error('等待条件超时')
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf-8')).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function startHost(extensionSource?: string): Promise<HarnessHost> {
  if (extensionSource) {
    await mkdir(join(env.agentDir, 'extensions'), { recursive: true })
    await writeFile(join(env.agentDir, 'extensions', 'probe.js'), extensionSource)
  }
  return createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
  })
}

async function threadRequest(threadId: string, kind: string) {
  return waitFor(async () => {
    const snapshot = await host?.getThread(threadId)
    return snapshot?.hostUiRequests?.find((request) => request.kind === kind)
  })
}

async function hostRequest(kind: string, scopeKind?: 'project' | 'session') {
  return waitFor(async () => {
    const snapshot = await host?.getHostInteractions()
    return snapshot?.requests.find(
      (request) =>
        request.kind === kind && (scopeKind === undefined || request.scope.kind === scopeKind),
    )
  })
}

beforeEach(async () => {
  savedEnv = new Map()
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  env = await createIsolatedPiEnv('huan-host-ui-')
  fetchStub = installTestFetch('ok')
})

afterEach(async () => {
  await host?.dispose()
  host = undefined
  fetchStub.restore()
  await env.cleanup()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const runtimeUiExtension = `export default function (pi) {
  pi.registerCommand('ask', {
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm('确认标题', '确认消息')
      ctx.ui.notify('confirm:' + confirmed, 'info')
      const choice = await ctx.ui.select('选择', ['alpha', 'beta'])
      ctx.ui.notify('select:' + choice, 'info')
      const text = await ctx.ui.input('输入', '占位')
      ctx.ui.notify('input:' + text, 'info')
      const edited = await ctx.ui.editor('编辑', 'prefill')
      ctx.ui.notify('editor:' + edited, 'info')
    },
  })
}
`

describe('运行期 Host UI', () => {
  it('confirm/select/input/editor 可应答、非法 select 值被拒绝且重复应答幂等', async () => {
    host = await startHost(runtimeUiExtension)
    const threadId = (await host.createThread()).metadata.id
    const sending = host.sendMessage(threadId, { content: '/ask' })

    const confirm = await threadRequest(threadId, 'confirm')
    expect(confirm).toMatchObject({ title: '确认标题', message: '确认消息' })
    // 重复/非法应答不影响 pending。
    await host.respondToHostUiRequest(threadId, { requestId: confirm.id, value: 'x' })
    expect((await host.getThread(threadId)).hostUiRequests).toHaveLength(1)
    await host.respondToHostUiRequest(threadId, { requestId: confirm.id, confirmed: true })
    await host.respondToHostUiRequest(threadId, { requestId: confirm.id, confirmed: false })

    const select = await threadRequest(threadId, 'select')
    await host.respondToHostUiRequest(threadId, { requestId: select.id, value: 'gamma' })
    expect((await host.getThread(threadId)).hostUiRequests).toHaveLength(1)
    await host.respondToHostUiRequest(threadId, { requestId: select.id, value: 'beta' })

    const input = await threadRequest(threadId, 'input')
    await host.respondToHostUiRequest(threadId, { requestId: input.id, value: '文本' })

    const editor = await threadRequest(threadId, 'editor')
    expect(editor).toMatchObject({ prefill: 'prefill' })
    await host.respondToHostUiRequest(threadId, { requestId: editor.id, value: '多行\n编辑' })

    await sending
    const snapshot = await host.getThread(threadId)
    expect(snapshot.hostUiRequests ?? []).toHaveLength(0)
    const notifications = snapshot.hostUi?.notifications ?? []
    expect(notifications.map((item) => item.message)).toEqual([
      'confirm:true',
      'select:beta',
      'input:文本',
      'editor:多行\n编辑',
    ])
  })

  it('超时按默认值结算并从快照消失', async () => {
    host = await startHost(`export default function (pi) {
  pi.registerCommand('timeout', {
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm('超时', '等待', { timeout: 30 })
      ctx.ui.notify('timeout:' + confirmed, 'warning')
    },
  })
}
`)
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '/timeout' })
    const snapshot = await waitFor(async () => {
      const current = await host?.getThread(threadId)
      return current?.hostUi?.notifications.length ? current : undefined
    })
    expect(snapshot.hostUiRequests ?? []).toHaveLength(0)
    expect(snapshot.hostUi?.notifications.at(-1)?.message).toBe('timeout:false')
  })

  it('已中止的 signal 立即结算并从快照消失', async () => {
    host = await startHost(`export default function (pi) {
  pi.registerCommand('abortsignal', {
    handler: async (_args, ctx) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)
      const confirmed = await ctx.ui.confirm('中止信号', '等待', { signal: controller.signal })
      ctx.ui.notify('abort:' + confirmed, 'warning')
    },
  })
}
`)
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '/abortsignal' })
    const snapshot = await waitFor(async () => {
      const current = await host?.getThread(threadId)
      return current?.hostUi?.notifications.length ? current : undefined
    })
    expect(snapshot.hostUiRequests ?? []).toHaveLength(0)
    expect(snapshot.hostUi?.notifications.at(-1)?.message).toBe('abort:false')
  })

  it('状态/widget/标题/通知有界且不覆盖会话名称', async () => {
    host = await startHost(`export default function (pi) {
  pi.registerCommand('state', {
    handler: async (_args, ctx) => {
      for (let i = 0; i < 25; i += 1) ctx.ui.notify('n' + i, i % 2 ? 'warning' : 'info')
      ctx.ui.setStatus('alpha', '工作中')
      ctx.ui.setWidget('beta', ['第一行', '第二行'], { placement: 'belowEditor' })
      ctx.ui.setTitle('扩展标题提示')
      ctx.ui.setWorkingMessage('自定义等待')
      ctx.ui.setWorkingVisible(false)
      ctx.ui.setHiddenThinkingLabel('折叠思考')
    },
  })
  pi.registerCommand('clearstate', {
    handler: async (_args, ctx) => {
      ctx.ui.setStatus('alpha', undefined)
      ctx.ui.setWidget('beta', undefined)
    },
  })
}
`)
    const created = await host.createThread({ title: '会话名称' })
    const threadId = created.metadata.id
    await host.sendMessage(threadId, { content: '/state' })
    const snapshot = await host.getThread(threadId)
    expect(snapshot.metadata.name).toBe('会话名称')
    expect(snapshot.hostUi?.title).toBe('扩展标题提示')
    expect(snapshot.hostUi?.statuses).toEqual([{ key: 'alpha', text: '工作中' }])
    expect(snapshot.hostUi?.widgets).toEqual([
      { key: 'beta', lines: ['第一行', '第二行'], placement: 'belowEditor' },
    ])
    expect(snapshot.hostUi?.notifications).toHaveLength(20)
    expect(snapshot.hostUi?.notifications.at(-1)?.message).toBe('n24')
    expect(snapshot.hostUi?.workingMessage).toBe('自定义等待')
    expect(snapshot.hostUi?.workingVisible).toBe(false)
    expect(snapshot.hostUi?.hiddenThinkingLabel).toBe('折叠思考')

    await host.sendMessage(threadId, { content: '/clearstate' })
    const cleared = await host.getThread(threadId)
    expect(cleared.hostUi?.statuses).toEqual([])
    expect(cleared.hostUi?.widgets).toEqual([])
  })

  it('编辑器写入定向调用方窗口；后台无调用方不冒充答案', async () => {
    const marker = join(env.root, 'editor.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.registerCommand('editor-write', {
    handler: async (_args, ctx) => {
      appendFileSync(${JSON.stringify(marker)}, 'before:' + ctx.ui.getEditorText() + '\\n')
      ctx.ui.setEditorText('替换文本')
      appendFileSync(${JSON.stringify(marker)}, 'after:' + ctx.ui.getEditorText() + '\\n')
      ctx.ui.pasteToEditor('粘贴内容')
      appendFileSync(${JSON.stringify(marker)}, 'mirror:' + ctx.ui.getEditorText() + '\\n')
    },
  })
  pi.registerCommand('read-editor', {
    handler: async (_args, ctx) => {
      appendFileSync(${JSON.stringify(marker)}, 'read:' + ctx.ui.getEditorText() + '\\n')
    },
  })
}
`)
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '/editor-write' }, { callerId: 'window-a' })
    const snapshot = await host.getThread(threadId)
    expect(snapshot.hostUi?.editorDirective).toMatchObject({
      text: '替换文本粘贴内容',
      mode: 'set',
      callerId: 'window-a',
    })
    expect(await readLines(marker)).toEqual([
      'before:/editor-write',
      'after:替换文本',
      'mirror:替换文本粘贴内容',
    ])

    // 消费后不再出现（重连不重复应用）。
    const directive = snapshot.hostUi?.editorDirective
    expect(directive).toBeDefined()
    expect(
      await host.consumeHostUiDirective(threadId, directive?.id ?? '', {
        callerId: 'window-b',
      }),
    ).toBe(false)
    const claimed = await Promise.all([
      host.consumeHostUiDirective(threadId, directive?.id ?? '', { callerId: 'window-a' }),
      host.consumeHostUiDirective(threadId, directive?.id ?? '', { callerId: 'window-a' }),
    ])
    expect(claimed).toEqual([true, false])
    expect((await host.getThread(threadId)).hostUi?.editorDirective).toBeUndefined()

    // 另一个窗口读取自己的镜像，不串入上一个调用方的文本。
    await host.sendMessage(threadId, { content: '/read-editor' }, { callerId: 'window-b' })
    expect(await readLines(marker)).toContain('read:/read-editor')
  })

  it('终端专属组件不被执行，只产生可见的不支持通知', async () => {
    host = await startHost(`export default function (pi) {
  pi.registerCommand('terminal-only', {
    handler: async (_args, ctx) => {
      ctx.ui.setFooter(() => {
        throw new Error('不应执行')
      })
      ctx.ui.setWidget('component', () => {
        throw new Error('不应执行组件工厂')
      })
    },
  })
}
`)
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '/terminal-only' })
    const snapshot = await host.getThread(threadId)
    const messages = snapshot.hostUi?.notifications.map((item) => item.message) ?? []
    expect(messages.some((message) => message.includes('setFooter'))).toBe(true)
    expect(messages.some((message) => message.includes('setWidget(component)'))).toBe(true)
  })
})

describe('启动期宿主交互通道', () => {
  it('session_start 顺序请求在 record 发布前可发现/应答，且钩子只执行一次', async () => {
    const marker = join(env.root, 'startup.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    appendFileSync(${JSON.stringify(marker)}, 'start:' + ctx.mode + ':' + ctx.hasUI + '\\n')
    const confirmed = await ctx.ui.confirm('启动确认', '允许启动？')
    appendFileSync(${JSON.stringify(marker)}, 'confirm:' + confirmed + '\\n')
    if (confirmed) {
      const name = await ctx.ui.input('启动输入', 'name')
      appendFileSync(${JSON.stringify(marker)}, 'input:' + name + '\\n')
    }
  })
}
`)
    const creating = host.createThread()
    const confirm = await hostRequest('confirm', 'session')
    await host.respondToHostInteraction({ requestId: confirm.id, confirmed: true })
    const input = await hostRequest('input')
    await host.respondToHostInteraction({ requestId: input.id, value: '会话名' })
    const created = await creating
    expect(created.metadata.id).toBeTruthy()
    expect(await readLines(marker)).toEqual(['start:rpc:true', 'confirm:true', 'input:会话名'])
    // 发布后宿主启动请求消失。
    expect((await host.getHostInteractions()).requests).toHaveLength(0)
  })

  it('取消启动请求使钩子获得原生取消值', async () => {
    const marker = join(env.root, 'cancel.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    const confirmed = await ctx.ui.confirm('取消确认', '继续？')
    appendFileSync(${JSON.stringify(marker)}, 'confirm:' + confirmed + '\\n')
  })
}
`)
    const creating = host.createThread()
    const confirm = await hostRequest('confirm', 'session')
    await host.respondToHostInteraction({ requestId: confirm.id, dismissed: true })
    await creating
    expect(await readLines(marker)).toEqual(['confirm:false'])
  })

  it('project_trust 扩展获得真实 RPC UI；同 cwd 只发起一次交互', async () => {
    const projectPath = join(env.root, 'trusted-project')
    await mkdir(join(projectPath, '.pi', 'extensions'), { recursive: true })
    const projectMarker = join(env.root, 'project.marker')
    await writeFile(
      join(projectPath, '.pi', 'extensions', 'probe.js'),
      `import { appendFileSync } from 'node:fs'
export default function () { appendFileSync(${JSON.stringify(projectMarker)}, 'project\\n') }
`,
    )
    const trustMarker = join(env.root, 'trust.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('project_trust', async (_event, ctx) => {
    appendFileSync(${JSON.stringify(trustMarker)}, 'trust:' + ctx.cwd + '\\n')
    const ok = await ctx.ui.confirm('信任项目', ctx.cwd)
    appendFileSync(${JSON.stringify(trustMarker)}, 'answer:' + ok + '\\n')
    return { trusted: ok ? 'yes' : 'no' }
  })
}
`)

    const first = host.getProject({ path: projectPath })
    const second = host.getProject({ path: projectPath })
    const request = await hostRequest('confirm', 'project')
    // 两路查询共享同一装配：只出现一个请求。
    expect((await host.getHostInteractions()).requests).toHaveLength(1)
    await host.respondToHostInteraction({ requestId: request.id, confirmed: true })
    const [left, right] = await Promise.all([first, second])
    expect(left.status).toBe('ready')
    expect(right.status).toBe('ready')
    expect(await readLines(trustMarker)).toEqual([`trust:${projectPath}`, 'answer:true'])
    expect(await readLines(projectMarker)).toEqual(['project'])

    // 只读信任摘要不触发交互。
    const summary = await host.inspectProjectTrust({ path: projectPath })
    expect(summary.status).not.toBe('failed')
    expect((await host.getHostInteractions()).requests).toHaveLength(0)
  })

  it('启动装配期请求不清空、也不阻断宿主返回；应答后后台装配完成', async () => {
    const startupEnv = await createIsolatedPiEnv('huan-startup-trust-')
    try {
      await mkdir(join(startupEnv.workspace, '.pi', 'extensions'), { recursive: true })
      const projectMarker = join(startupEnv.root, 'project.marker')
      await writeFile(
        join(startupEnv.workspace, '.pi', 'extensions', 'probe.js'),
        `import { appendFileSync } from 'node:fs'
export default function () { appendFileSync(${JSON.stringify(projectMarker)}, 'project\\n') }
`,
      )
      const trustMarker = join(startupEnv.root, 'trust.marker')
      await mkdir(join(startupEnv.agentDir, 'extensions'), { recursive: true })
      await writeFile(
        join(startupEnv.agentDir, 'extensions', 'trust.js'),
        `import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('project_trust', async (_event, ctx) => {
    appendFileSync(${JSON.stringify(trustMarker)}, 'ask\\n')
    const ok = await ctx.ui.confirm('启动信任', ctx.cwd)
    return { trusted: ok ? 'yes' : 'no' }
  })
}
`,
      )
      const started = Date.now()
      host = await createHarnessHost({
        workspacePath: startupEnv.workspace,
        agentDir: startupEnv.agentDir,
        refreshCatalogOnStart: false,
        resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
      })
      // 宿主必须先返回，不能等浏览器。
      expect(Date.now() - started).toBeLessThan(3_000)
      const request = await hostRequest('confirm', 'project')
      await host.respondToHostInteraction({ requestId: request.id, confirmed: true })
      const project = await waitFor(async () => {
        const info = await host?.getProject({ path: startupEnv.workspace })
        return info?.status === 'ready' ? info : undefined
      })
      expect(project.trust.origin).toBe('extension')
      expect(await readLines(trustMarker)).toEqual(['ask'])
      expect(await readLines(projectMarker)).toEqual(['project'])
      expect((await host.getHostInteractions()).requests).toHaveLength(0)
    } finally {
      await host?.dispose()
      host = undefined
      await startupEnv.cleanup()
    }
  })

  it('宿主销毁会结算待答启动请求，未发布的会话不出现', async () => {
    const marker = join(env.root, 'dispose.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    const confirmed = await ctx.ui.confirm('销毁确认', '等待')
    appendFileSync(${JSON.stringify(marker)}, 'confirm:' + confirmed + '\\n')
  })
}
`)
    const snapshots: number[] = []
    const release = host.subscribeHostInteractions((event) => {
      snapshots.push(event.snapshot.requests.length)
    })
    const creating = host.createThread()
    await hostRequest('confirm', 'session')
    const disposing = host.dispose()
    await expect(creating).rejects.toThrow()
    await disposing
    release()
    expect(snapshots.at(-1)).toBe(0)
    expect(await readLines(marker)).toEqual(['confirm:false'])
  })
})

describe('commandContextActions', () => {
  it('newSession 创建独立会话并可经 withSession 写入内容；父会话保留', async () => {
    const marker = join(env.root, 'new-session.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.registerCommand('newcmd', {
    handler: async (_args, ctx) => {
      const result = await ctx.newSession({
        withSession: async (next) => {
          appendFileSync(${JSON.stringify(marker)}, 'next:' + next.sessionManager.getSessionId() + '\\n')
          await next.sendMessage(
            { customType: 'huan-test', content: '初始化内容', display: false },
            { triggerTurn: false },
          )
        },
      })
      appendFileSync(${JSON.stringify(marker)}, 'cancelled:' + result.cancelled + '\\n')
    },
  })
}
`)
    const parent = (await host.createThread()).metadata.id
    await host.sendMessage(parent, { content: '/newcmd' })
    const lines = await readLines(marker)
    expect(lines.some((line) => line === 'cancelled:false')).toBe(true)
    const nextLine = lines.find((line) => line.startsWith('next:'))
    expect(nextLine).toBeTruthy()
    const nextId = nextLine?.slice('next:'.length) ?? ''
    expect(nextId).not.toBe(parent)
    const next = await host.getThread(nextId)
    expect(next.messages.some((message) => message.role === 'custom')).toBe(true)
    expect((await host.getThread(parent)).hostUi?.commandTarget).toMatchObject({
      action: 'newSession',
      threadId: nextId,
    })
    // 父 record 仍可读，且新会话已作为独立 record 存在。
    expect((await host.getThread(parent)).metadata.id).toBe(parent)
  })

  it('newSession 在绑定前应用setup和血缘，并尊重扩展取消', async () => {
    const marker = join(env.root, 'setup.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_before_switch', (event) => {
    if (event.reason === 'new') return { cancel: false }
  })
  pi.on('session_start', (event, ctx) => {
    if (event.reason === 'new') {
      appendFileSync(${JSON.stringify(marker)}, 'setup:' + ctx.sessionManager.getSessionName() + '\\n')
    }
  })
  pi.registerCommand('setupcmd', {
    handler: async (_args, ctx) => {
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (manager) => manager.appendSessionInfo('setup-name'),
      })
    },
  })
}
`)
    const parent = (await host.createThread()).metadata.id
    await host.sendMessage(parent, { content: '/setupcmd' })
    const target = (await host.getThread(parent)).hostUi?.commandTarget?.threadId
    expect(target).toBeDefined()
    expect(await readLines(marker)).toEqual(['setup:setup-name'])
    expect((await host.getThread(target ?? '')).metadata.name).toBe('setup-name')
  })

  it('waitForIdle 正常结算；shutdown 明确不支持', async () => {
    const marker = join(env.root, 'wait.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.registerCommand('waitcmd', {
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      appendFileSync(${JSON.stringify(marker)}, 'wait:ok\\n')
    },
  })
  pi.registerCommand('shutdowncmd', {
    handler: async (_args, ctx) => {
      try {
        ctx.shutdown()
        appendFileSync(${JSON.stringify(marker)}, 'shutdown:none\\n')
      } catch (error) {
        appendFileSync(${JSON.stringify(marker)}, 'shutdown:' + error.name + '\\n')
      }
    },
  })
}
`)
    const threadId = (await host.createThread()).metadata.id
    await host.sendMessage(threadId, { content: '/waitcmd' })
    await host.sendMessage(threadId, { content: '/shutdowncmd' })
    expect(await readLines(marker)).toEqual([
      'wait:ok',
      'shutdown:UnsupportedHostCommandActionError',
    ])
  })

  it('fork/navigateTree/switchSession 与独立会话操作衔接；reload 走真实重载', async () => {
    const marker = join(env.root, 'command.marker')
    host = await startHost(`import { appendFileSync } from 'node:fs'
export default function (pi) {
  pi.registerCommand('forkcmd', {
    handler: async (args, ctx) => {
      const result = await ctx.fork(args)
      appendFileSync(${JSON.stringify(marker)}, 'fork:' + result.cancelled + '\\n')
    },
  })
  pi.registerCommand('navcmd', {
    handler: async (args, ctx) => {
      const result = await ctx.navigateTree(args)
      appendFileSync(${JSON.stringify(marker)}, 'nav:' + result.cancelled + '\\n')
    },
  })
  pi.registerCommand('switchcmd', {
    handler: async (args, ctx) => {
      const result = await ctx.switchSession(args)
      appendFileSync(${JSON.stringify(marker)}, 'switch:' + result.cancelled + '\\n')
    },
  })
  pi.registerCommand('reloadcmd', {
    handler: async (_args, ctx) => {
      try {
        await ctx.reload()
        appendFileSync(${JSON.stringify(marker)}, 'reload:no-error\\n')
      } catch (error) {
        appendFileSync(${JSON.stringify(marker)}, 'reload:' + error.name + '\\n')
      }
    },
  })
}
`)
    const parent = (await host.createThread()).metadata.id
    // 导航/fork 要求空闲：显式等待首轮 agent_settled（命令不会隐式停止运行）。
    const activeHost = host
    if (!activeHost) throw new Error('host 尚未创建')
    const settled = new Promise<void>((resolve) => {
      const release = activeHost.subscribe(
        parent,
        (event) => {
          if (event.type !== 'agent_settled') return
          release()
          resolve()
        },
        { includeSnapshot: false },
      )
    })
    await host.sendMessage(parent, { content: '第一条' })
    await settled
    const userNode = await waitFor(async () => {
      const tree = await host?.getThreadTree(parent)
      return tree?.nodes.find((node) => node.kind === 'user')
    })
    const leafBefore = (await host.getThread(parent)).metadata.leafId
    await host.sendMessage(parent, { content: `/navcmd ${userNode.entryId}` })
    expect(await readLines(marker)).toContain('nav:false')
    expect((await host.getThread(parent)).metadata.leafId).not.toBe(leafBefore)

    await host.sendMessage(parent, { content: `/forkcmd ${userNode.entryId}` })
    expect(await readLines(marker)).toContain('fork:false')
    expect((await host.getThread(parent)).hostUi?.commandTarget?.action).toBe('fork')

    const other = await host.createThread()
    await host.sendMessage(other.metadata.id, { content: '另一个会话' })
    const otherFile = await waitFor(async () => {
      const snapshot = await host?.getThread(other.metadata.id)
      const file = snapshot?.metadata.sessionFile
      if (!file) return undefined
      try {
        await readFile(file)
        return file
      } catch {
        return undefined
      }
    })
    await host.sendMessage(parent, { content: `/switchcmd ${otherFile}` })
    expect(await readLines(marker)).toContain('switch:false')

    // ctx.reload：真实重载（不是空成功），同一会话、同一消息记录不被替换。
    const beforeReload = await host.getThread(parent)
    await host.sendMessage(parent, { content: '/reloadcmd' })
    expect(await readLines(marker)).toContain('reload:no-error')
    const afterReload = await host.getThread(parent)
    expect(afterReload.metadata.id).toBe(beforeReload.metadata.id)
    expect(afterReload.metadata.reload).toMatchObject({
      trigger: 'extension',
      status: 'succeeded',
    })
    expect(afterReload.metadata.resourceRevision).toBeGreaterThan(
      beforeReload.metadata.resourceRevision ?? 0,
    )
    expect(afterReload.messages).toEqual(beforeReload.messages)
  })
})
