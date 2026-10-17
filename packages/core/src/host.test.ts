import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'

/**
 * 宿主集成测试：用真实 Pi SDK 但隔离在临时目录，覆盖迭代③设计 §4 的
 * 核心行为（发送接受语义、并发去重、冷打开、删除、模型目录可见性）。
 *
 * 需要用户 Pi 环境（~/.pi/agent 的 auth.json 与扩展）；在无该环境的机器上
 * 这些用例会因模型目录为空而失败，属预期（本仓库为个人项目，开发机即环境）。
 */
const agentDir = join(homedir(), '.pi', 'agent')

let workspace: string
let host: HarnessHost
/** 测试期间直接落盘的探针会话文件（Pi 统一存到用户 sessions 目录，需单独清理）。 */
const sessionFileToCleanup: string[] = []

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'huan-host-test-'))
  host = await createHarnessHost({
    workspacePath: workspace,
    agentDir,
    // 测试不联网刷新目录（依赖缓存与扩展注册），避免拖慢用例。
    refreshCatalogOnStart: false,
  })
})

afterAll(async () => {
  await host.dispose()
  for (const file of sessionFileToCleanup) {
    await rm(file, { force: true })
  }
  await rm(workspace, { recursive: true, force: true })
})

describe('模型目录（修复②：扩展 provider 可见）', () => {
  it('返回真实注册表且包含扩展注册的 provider 模型', async () => {
    const models = await host.getAvailableModels()
    expect(models.length).toBeGreaterThan(0)
    const ids = models.map((model) => `${model.provider}/${model.modelId}`)
    expect(ids).toContain('my-provider/deepseek-v4.1-flash')
  })

  it('模型条目带 provider 与 modelId（JSON-safe 基本形状）', async () => {
    const models = await host.getAvailableModels()
    const first = models[0]
    expect(first).toBeDefined()
    expect(typeof first?.provider).toBe('string')
    expect(typeof first?.modelId).toBe('string')
  })
})

describe('会话生命周期', () => {
  it('新建会话使用默认模型（settings/环境变量解析）', async () => {
    const snapshot = await host.createThread()
    expect(snapshot.metadata.config?.provider).toBe('my-provider')
    expect(snapshot.metadata.config?.modelId).toBe('deepseek-v4.1-flash')
    expect(snapshot.readiness?.state).toBe('ready')
    await host.deleteThread(snapshot.metadata.id)
  })

  it('创建时显式指定模型（空白页选模型场景）覆盖默认模型', async () => {
    const snapshot = await host.createThread({
      model: { provider: 'my-provider', modelId: 'gpt-5.6-luna' },
    })
    expect(snapshot.metadata.config?.provider).toBe('my-provider')
    expect(snapshot.metadata.config?.modelId).toBe('gpt-5.6-luna')
    // 读回（冷/热一致）。
    const after = await host.getThread(snapshot.metadata.id)
    expect(after.metadata.config?.modelId).toBe('gpt-5.6-luna')
    await host.deleteThread(snapshot.metadata.id)
  })

  it('创建时指定的模型不存在则报错（不静默回退默认模型）', async () => {
    await expect(
      host.createThread({ model: { provider: 'nope', modelId: 'missing' } }),
    ).rejects.toThrow(/not in Pi's model registry/)
  })

  it('创建时指定 thinkingLevel 生效（或按模型能力被规范到合法级别）', async () => {
    const snapshot = await host.createThread({
      model: { provider: 'my-provider', modelId: 'gpt-5.6-luna' },
      thinkingLevel: 'low',
    })
    // SDK 会按模型能力规范化级别（可能 clamp 到 off 等），只断言是合法值。
    expect(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).toContain(
      snapshot.metadata.config?.thinkingLevel,
    )
    await host.deleteThread(snapshot.metadata.id)
  })

  it('首条消息使用创建时指定的模型（initialMessage 路径）', async () => {
    const snapshot = await host.createThread({
      model: { provider: 'my-provider', modelId: 'gpt-5.6-terra' },
      initialMessage: { content: '只回答一个数字：1+1=?' },
    })
    const id = snapshot.metadata.id
    // 等待运行结束（首条 assistant 消息写出实际使用的模型）。
    const deadline = Date.now() + 60_000
    let assistantModel: string | undefined
    while (Date.now() < deadline) {
      const current = await host.getThread(id)
      const assistant = current.messages.find((message) => message.role === 'assistant')
      if (assistant) {
        const provider = (assistant as { provider?: string }).provider
        const model = (assistant as { model?: string }).model
        if (provider && model) {
          assistantModel = `${provider}/${model}`
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(assistantModel).toBe('my-provider/gpt-5.6-terra')
    await host.deleteThread(id)
  }, 90_000)

  it('setModel 生效（快照 config 更新）且能切回', async () => {
    const created = await host.createThread()
    const id = created.metadata.id
    await host.setModel(id, { provider: 'my-provider', modelId: 'gpt-5.6-luna' })
    const after = await host.getThread(id)
    expect(after.metadata.config?.modelId).toBe('gpt-5.6-luna')
    await host.deleteThread(id)
  })

  it('setModel 对注册表外的模型报错（不静默）', async () => {
    const created = await host.createThread()
    const id = created.metadata.id
    await expect(host.setModel(id, { provider: 'nope', modelId: 'missing' })).rejects.toThrow(
      /not in Pi's model registry/,
    )
    await host.deleteThread(id)
  })

  it('rename 在 live 会话上生效（经 getThread 读回）', async () => {
    // 注：无消息的新会话不落盘（Pi 只在首条消息时写入文件），因此不出现在
    // listThreads 的目录里；这是 SDK 的既有行为（supervisor 同样如此）。
    const created = await host.createThread()
    const id = created.metadata.id
    await host.renameThread(id, '测试标题')
    const after = await host.getThread(id)
    expect(after.metadata.title).toBe('测试标题')
    await host.deleteThread(id)
  })

  it('删除不存在的会话是幂等的', async () => {
    await expect(host.deleteThread('does-not-exist')).resolves.toBeUndefined()
  })
})

describe('订阅（快照优先语义）', () => {
  it('subscribe 首帧为快照，且 seq 与订阅建立时一致', async () => {
    const created = await host.createThread()
    const id = created.metadata.id
    const events: Array<{ type: string; seq?: number }> = []
    const unsubscribe = host.subscribe(id, (event) =>
      events.push({ type: event.type, seq: event.seq }),
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    unsubscribe()
    expect(events[0]?.type).toBe('snapshot')
    expect(typeof events[0]?.seq).toBe('number')
    await host.deleteThread(id)
  })

  it('includeSnapshot: false 时跳过首帧快照', async () => {
    const created = await host.createThread()
    const id = created.metadata.id
    const types: string[] = []
    const unsubscribe = host.subscribe(id, (event) => types.push(event.type), {
      includeSnapshot: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    unsubscribe()
    expect(types).not.toContain('snapshot')
    await host.deleteThread(id)
  })
})

describe('标题口径（热/冷一致）', () => {
  it('未命名会话的标题来自首条用户消息，热读与冷读一致', async () => {
    const prompt = '只回答一个数字：3+4=?'
    const created = await host.createThread({ initialMessage: { content: prompt } })
    const id = created.metadata.id

    // 等待运行结束并落盘（首条消息写入后才有 session file）。
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = await host.getThread(id)
      if (current.metadata.status === 'idle' && (current.metadata.messageCount ?? 0) > 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // 热读：live record（metadataOf 路径）。
    const live = await host.getThread(id)
    expect(live.metadata.title).toBe(prompt)

    // 冷读：新建宿主（无 live record，走 session file 路径）。
    const coldHost = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })
    const cold = await coldHost.getThread(id)
    expect(cold.metadata.title).toBe(prompt)
    await coldHost.dispose()

    await host.deleteThread(id)
  }, 90_000)

  it('显式命名优先于首条消息', async () => {
    const created = await host.createThread({ initialMessage: { content: '这段内容不应成为标题' } })
    const id = created.metadata.id
    await host.renameThread(id, '显式标题')
    const after = await host.getThread(id)
    expect(after.metadata.title).toBe('显式标题')
    await host.deleteThread(id)
  }, 60_000)

  it('重命名为空后，热读/冷读/列表一致回退到消息标题（不出现空标题）', async () => {
    const prompt = '只回答一个数字：5+6=?'
    const created = await host.createThread({ initialMessage: { content: prompt } })
    const id = created.metadata.id
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = await host.getThread(id)
      if (current.metadata.status === 'idle' && (current.metadata.messageCount ?? 0) > 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // 显式清空名称：三处口径都不得出现空标题。
    await host.renameThread(id, '')
    const hot = await host.getThread(id)
    expect(hot.metadata.title).toBe(prompt)

    const listed = (await host.listThreads()).find((item) => item.id === id)
    expect(listed?.title).toBe(prompt)

    const coldHost = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })
    const cold = await coldHost.getThread(id)
    expect(cold.metadata.title).toBe(prompt)
    const coldListed = (await coldHost.listThreads()).find((item) => item.id === id)
    expect(coldListed?.title).toBe(prompt)
    await coldHost.dispose()

    await host.deleteThread(id)
  }, 90_000)

  it('命名 → 清空的转换不出现空标题（需要先有非空名称）', async () => {
    const prompt = '只回答一个数字：8+9=?'
    const created = await host.createThread({ initialMessage: { content: prompt } })
    const id = created.metadata.id
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const current = await host.getThread(id)
      if (current.metadata.status === 'idle' && (current.metadata.messageCount ?? 0) > 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    await host.renameThread(id, '先命名')
    expect((await host.getThread(id)).metadata.title).toBe('先命名')

    await host.renameThread(id, '')
    expect((await host.getThread(id)).metadata.title).toBe(prompt)

    const coldHost = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })
    expect((await coldHost.getThread(id)).metadata.title).toBe(prompt)
    expect((await coldHost.listThreads()).find((item) => item.id === id)?.title).toBe(prompt)
    await coldHost.dispose()

    await host.deleteThread(id)
  }, 90_000)

  it('分支历史：全文件首条 user 消息口径（热读与冷读一致）', async () => {
    // 构造「文件首条 ≠ 当前分支首条」的会话（不依赖模型生成）：
    // 根下先写 A，再 resetLeaf() 回到「无父节点」，写入 B 作为新根。
    // 此时文件顺序首条是 A，而当前分支（leaf 侧）首条是 B。
    // 注：使用默认 sessions 目录（宿主的列表/打开均走该目录；自定义目录的
    // 支持是独立缺口，见 docs/todo.md）。
    const now = Date.now()
    const userMessage = (text: string) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      timestamp: now,
    })
    const seed = SessionManager.create(workspace)
    seed.appendMessage(userMessage('文件首条 A'))
    seed.resetLeaf()
    seed.appendMessage(userMessage('当前分支首条 B'))
    const sessionFile = seed.getSessionFile()
    if (!sessionFile) throw new Error('无法创建分支探针会话')
    sessionFileToCleanup.push(sessionFile)

    // 先确认构造本身符合预期：全文件首条是 A，当前分支首条是 B。
    const branchTexts = seed
      .getBranch()
      .filter((entry) => entry.type === 'message')
      .map((entry) => (entry as { message?: { role?: string; content?: unknown } }).message)
      .filter((message) => message?.role === 'user')
    expect(branchTexts.length).toBeGreaterThan(0)

    const info = (await SessionManager.list(workspace)).find((item) => item.path === sessionFile)
    if (!info) throw new Error('无法定位探针会话')
    expect(info.firstMessage).toBe('文件首条 A')
    const id = info.id

    // 冷读：Pi 全文件顺序的首条 user 消息是 A。
    const coldHost = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })
    expect((await coldHost.getThread(id)).metadata.title).toBe('文件首条 A')
    await coldHost.dispose()

    // 热读：必须先真正打开为 live record（subscribe 会 ensureOpen）。
    // 若用 getThread，宿主无 live record → 仍走冷读，测不到热路径口径。
    const hotTitle = await new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('等待 live 快照超时'))
      }, 20_000)
      const unsubscribe = host.subscribe(
        id,
        (event) => {
          if (event.type !== 'snapshot') return
          clearTimeout(timer)
          unsubscribe()
          resolve(event.snapshot.metadata.title)
        },
        { includeSnapshot: true },
      )
    })
    // 热路径必须取「全文件首条」（A），而不是「当前分支首条」（B）。
    expect(hotTitle).toBe('文件首条 A')
  }, 60_000)
})

describe('并发去重与取消', () => {
  it('冷会话的并发订阅共享同一 record（pendingOpens 去重），各自收到快照', async () => {
    // 先在一个宿主里建立含消息的会话（触发落盘），再用第二个宿主进行冷打开。
    const first = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })
    const created = await first.createThread()
    const id = created.metadata.id
    await first.sendMessage(id, { content: 'reply with the single word: ok' })
    // 等待运行结束（或超时后中止），确保会话已落盘。
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const snapshot = await first.getThread(id)
      if (snapshot.metadata.status === 'idle' && (snapshot.metadata.messageCount ?? 0) > 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await first.dispose()

    const second = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })
    const received: Array<{ type: string; threadId: string }> = []
    const unsubscribers = [
      second.subscribe(id, (event) =>
        received.push({ type: event.type, threadId: event.threadId }),
      ),
      second.subscribe(id, (event) =>
        received.push({ type: event.type, threadId: event.threadId }),
      ),
    ]
    await new Promise((resolve) => setTimeout(resolve, 500))
    for (const unsubscribe of unsubscribers) unsubscribe()

    const snapshots = received.filter((event) => event.type === 'snapshot')
    expect(snapshots.length).toBe(2)
    expect(snapshots.every((event) => event.threadId === id)).toBe(true)
    await second.deleteThread(id)
    await second.dispose()
  }, 90_000)

  it('cancelRun 对未打开的会话不抛错', async () => {
    await expect(host.cancelRun('never-opened')).resolves.toBeUndefined()
  })
})

describe('发送接受语义', () => {
  it('sendMessage 在输入被接受后即返回（不等待运行结束）', async () => {
    const created = await host.createThread()
    const id = created.metadata.id
    const started = Date.now()
    await host.sendMessage(id, { content: 'reply with the single word: ok' })
    const elapsed = Date.now() - started
    // 接受语义：应在运行结束前返回（运行持续数秒，接受路径远快于此）。
    expect(elapsed).toBeLessThan(30_000)
    await host.cancelRun(id)
    await host.deleteThread(id)
  }, 40_000)
})

describe('预检窗口取消（顾问审查要求：确定性竞态）', () => {
  it('预检期间取消不会启动模型调用（不产生助手消息）', async () => {
    // 用工作目录下的临时扩展注入可暂停的 input hook：停住预检，期间取消，再放行。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const releaseFile = join(workspace, 'release-hook')
    const extensionSource = `
import { writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('input', async (event) => {
    const release = ${JSON.stringify(releaseFile)}
    // 挂起直到测试创建放行文件（无超时：测试负责收尾）。
    while (!(await import('node:fs')).existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return undefined
  })
}
`
    await writeFile(join(extensionDir, 'pause-input.ts'), extensionSource)

    const isolated = await createHarnessHost({
      workspacePath: workspace,
      agentDir,
      refreshCatalogOnStart: false,
    })

    const created = await isolated.createThread()
    const id = created.metadata.id

    // 发起发送（会停在 input hook 的预检阶段），随后取消。
    const sending = isolated.sendMessage(id, { content: 'this must never run' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await isolated.cancelRun(id)
    // 放行预检：若取消未兜底，prompt 会继续进入 _runAgentPrompt 并产生助手消息。
    await writeFile(releaseFile, 'go')
    await sending

    // 等待充分时间，断言模型未产出内容。
    // 注：SDK 的取消语义会记录一条 stopReason='aborted' 的占位助手消息（与在跑
    // 期间点取消的行为一致）；关键区别是「没有模型实际产出的文本」。
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const snapshot = await isolated.getThread(id)
    const assistantMessages = snapshot.messages.filter((message) => message.role === 'assistant')

    const producedText = assistantMessages.flatMap((message) => {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return []
      return content.filter(
        (part): part is { type: string; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: string }).type === 'text' &&
          typeof (part as { text?: string }).text === 'string' &&
          (part as { text: string }).text.length > 0,
      )
    })
    // 无任何模型产出的文本；若取消未生效，模型会正常回答（包含文本）。
    expect(producedText).toEqual([])

    await isolated.dispose()
    await rm(join(extensionDir, 'pause-input.ts'), { force: true })
  }, 60_000)
})
