import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_API_KEY,
  TEST_BASE_URL,
  TEST_MODEL_A,
  TEST_MODEL_B,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  TEST_UNAUTH_MODEL,
  TEST_UNAUTH_PROVIDER,
  type TestFetchStub,
} from './test-support.js'

/**
 * 宿主集成测试：真实 Pi SDK + 隔离的临时用户空间 + 合成 provider。
 *
 * 隔离口径（迭代设计 §4.1）：不读写个人 `~/.pi/agent`；不继承 `PI_*` 环境；
 * fetch 只应答合成 provider 端点（确定性 SSE），其它请求一律失败并计数。
 */
const TESTED_ENV_KEYS = [
  'PI_PROVIDER',
  'PI_MODEL_ID',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
] as const

let env: IsolatedPiEnv
let workspace: string
let host: HarnessHost

/** 等待文件出现（确定性握手：避免用固定睡眠猜执行阶段）。 */
async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`等待文件超时：${filePath}`)
}

/** 用隔离用户空间创建宿主（测试默认值集中在此，避免漏加隔离项）。 */
function createTestHost(
  overrides: Partial<Parameters<typeof createHarnessHost>[0]> = {},
  targetEnv: IsolatedPiEnv = env,
): Promise<HarnessHost> {
  return createHarnessHost({
    workspacePath: targetEnv.workspace,
    agentDir: targetEnv.agentDir,
    // 测试不联网刷新目录（依赖合成 provider 与缓存），避免拖慢用例。
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    ...overrides,
  })
}

/**
 * 测试 fixture 的完整生命周期。
 *
 * 创建（环境变量隔离 → 临时用户空间 → fetch 桩 → 宿主）与清理放在同一处：
 * 任何一步失败都先执行与正常结束相同的清理再抛出，避免 beforeAll 失败后
 * afterAll 二次抛错，并保证临时目录、继承环境与全局 fetch 一定被还原。
 */
type HostFixture = {
  env: IsolatedPiEnv | undefined
  host: HarnessHost | undefined
  fetchStub: TestFetchStub | undefined
  savedEnv: Map<string, string | undefined>
  disposed: boolean
}

async function createHostFixture(
  options: {
    /** 复用调用方已创建的隔离空间（清理责任同时移交 fixture）；默认新建。 */
    env?: IsolatedPiEnv
    /** 创建宿主的工厂（默认使用模块级隔离空间与测试默认值）。 */
    createHost?: (targetEnv: IsolatedPiEnv) => Promise<HarnessHost>
  } = {},
): Promise<HostFixture> {
  const fixture: HostFixture = {
    env: undefined,
    host: undefined,
    fetchStub: undefined,
    savedEnv: new Map(),
    disposed: false,
  }
  try {
    for (const key of TESTED_ENV_KEYS) {
      fixture.savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    fixture.env = options.env ?? (await createIsolatedPiEnv('huan-host-test-'))
    fixture.fetchStub = installTestFetch()
    const targetEnv = fixture.env
    fixture.host = await (options.createHost ?? ((testEnv) => createTestHost({}, testEnv)))(
      targetEnv,
    )
    return fixture
  } catch (error) {
    await disposeHostFixture(fixture)
    throw error
  }
}

/** 释放 fixture（幂等）：每一步独立执行，互不因前一步失败而跳过。 */
async function disposeHostFixture(fixture: HostFixture | undefined): Promise<void> {
  if (!fixture || fixture.disposed) return
  fixture.disposed = true
  const failures: unknown[] = []
  const attempt = async (action: () => unknown) => {
    try {
      await action()
    } catch (error) {
      failures.push(error)
    }
  }
  // 先读取非预期请求证据，避免被后续清理错误掩盖。
  const unexpected = fixture.fetchStub?.unexpected() ?? []
  await attempt(() => fixture.host?.dispose())
  await attempt(() => fixture.fetchStub?.restore())
  for (const [key, value] of fixture.savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await attempt(() => fixture.env?.cleanup())
  if (unexpected.length > 0) {
    failures.push(new Error(`测试发生非预期网络请求：${unexpected.join('，')}`))
  }
  const [first] = failures
  if (first !== undefined) throw first instanceof Error ? first : new Error(String(first))
}

let fixture: HostFixture | undefined

beforeAll(async () => {
  fixture = await createHostFixture()
  if (!fixture.env || !fixture.host) throw new Error('测试 fixture 初始化不完整')
  env = fixture.env
  workspace = env.workspace
  host = fixture.host
})

afterAll(async () => {
  await disposeHostFixture(fixture)
})

describe('模型目录（修复②：扩展 provider 可见）', () => {
  it('返回真实注册表且包含合成 provider 模型', async () => {
    const models = await host.getAvailableModels()
    expect(models.length).toBeGreaterThan(0)
    const ids = models.map((model) => `${model.provider}/${model.modelId}`)
    expect(ids).toContain(`${TEST_PROVIDER}/${TEST_MODEL_A}`)
    expect(ids).toContain(`${TEST_PROVIDER}/${TEST_MODEL_B}`)
    // 缺凭据模型不应出现在可用目录（可见性由 auth 决定）。
    expect(ids).not.toContain(`${TEST_UNAUTH_PROVIDER}/${TEST_UNAUTH_MODEL}`)
  })

  it('本地临时扩展 registerProvider 注册的 provider 可见并可用于新建会话', async () => {
    // 回归「扩展注册 provider → 共享 modelRuntime → 目录/会话」的真实链路：
    // 不依赖个人环境的扩展，扩展文件只落在临时工作区里。
    const extensionEnv = await createIsolatedPiEnv('huan-host-extension-')
    const extensionDir = join(extensionEnv.workspace, '.pi', 'extensions')
    const providerId = 'huan-test-ext'
    const modelId = 'ext-model'
    await mkdir(extensionDir, { recursive: true })
    await writeFile(
      join(extensionDir, 'register-provider.ts'),
      `
export default function (pi) {
  pi.registerProvider(${JSON.stringify(providerId)}, {
    name: 'Huan Test Extension Provider',
    baseUrl: ${JSON.stringify(TEST_BASE_URL)},
    api: 'openai-completions',
    apiKey: ${JSON.stringify(TEST_API_KEY)},
    models: [
      {
        id: ${JSON.stringify(modelId)},
        name: 'Extension Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16384,
        maxTokens: 2048,
      },
    ],
  })
}
`,
    )

    let extensionHost: HarnessHost | undefined
    try {
      extensionHost = await createTestHost({}, extensionEnv)
      const ids = (await extensionHost.getAvailableModels()).map(
        (model) => `${model.provider}/${model.modelId}`,
      )
      expect(ids).toContain(`${providerId}/${modelId}`)

      const created = await extensionHost.createThread({
        model: { provider: providerId, modelId },
      })
      expect(created.metadata.config?.provider).toBe(providerId)
      expect(created.metadata.config?.modelId).toBe(modelId)
      await extensionHost.deleteThread(created.metadata.id)
    } finally {
      await extensionHost?.dispose()
      await extensionEnv.cleanup()
    }
  }, 60_000)

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
    expect(snapshot.metadata.config?.provider).toBe(TEST_PROVIDER)
    expect(snapshot.metadata.config?.modelId).toBe(TEST_MODEL_A)
    expect(snapshot.readiness?.state).toBe('ready')
    await host.deleteThread(snapshot.metadata.id)
  })

  it('创建时显式指定模型（空白页选模型场景）覆盖默认模型', async () => {
    const snapshot = await host.createThread({
      model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_B },
    })
    expect(snapshot.metadata.config?.provider).toBe(TEST_PROVIDER)
    expect(snapshot.metadata.config?.modelId).toBe(TEST_MODEL_B)
    // 读回（冷/热一致）。
    const after = await host.getThread(snapshot.metadata.id)
    expect(after.metadata.config?.modelId).toBe(TEST_MODEL_B)
    await host.deleteThread(snapshot.metadata.id)
  })

  it('创建时指定的模型不存在则报错（不静默回退默认模型）', async () => {
    await expect(
      host.createThread({ model: { provider: 'nope', modelId: 'missing' } }),
    ).rejects.toThrow(/not in Pi's model registry/)
  })

  it('创建时指定 thinkingLevel 生效（或按模型能力被规范到合法级别）', async () => {
    const snapshot = await host.createThread({
      model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_B },
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
      model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_B },
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
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(assistantModel).toBe(`${TEST_PROVIDER}/${TEST_MODEL_B}`)
    await host.deleteThread(id)
  }, 90_000)

  it('setModel 生效（快照 config 更新）且能切回', async () => {
    const created = await host.createThread()
    const id = created.metadata.id
    await host.setModel(id, { provider: TEST_PROVIDER, modelId: TEST_MODEL_B })
    const after = await host.getThread(id)
    expect(after.metadata.config?.modelId).toBe(TEST_MODEL_B)
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
    const coldHost = await createTestHost()
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

    const coldHost = await createTestHost()
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

    const coldHost = await createTestHost()
    expect((await coldHost.getThread(id)).metadata.title).toBe(prompt)
    expect((await coldHost.listThreads()).find((item) => item.id === id)?.title).toBe(prompt)
    await coldHost.dispose()

    await host.deleteThread(id)
  }, 90_000)

  it('分支历史：全文件首条 user 消息口径（热读与冷读一致）', async () => {
    // 构造「文件首条 ≠ 当前分支首条」的会话（不依赖模型生成）：
    // 根下先写 A，再 resetLeaf() 回到「无父节点」，写入 B 作为新根。
    // 此时文件顺序首条是 A，而当前分支（leaf 侧）首条是 B。
    // 注：探针会话显式传隔离会话目录，不依赖进程环境变量。
    const now = Date.now()
    const userMessage = (text: string) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      timestamp: now,
    })
    const probeDir = env.defaultSessionDir(workspace)
    const seed = SessionManager.create(workspace, probeDir)
    seed.appendMessage(userMessage('文件首条 A'))
    seed.resetLeaf()
    seed.appendMessage(userMessage('当前分支首条 B'))
    const sessionFile = seed.getSessionFile()
    if (!sessionFile) throw new Error('无法创建分支探针会话')

    // 先确认构造本身符合预期：全文件首条是 A，当前分支首条是 B。
    const branchTexts = seed
      .getBranch()
      .filter((entry) => entry.type === 'message')
      .map((entry) => (entry as { message?: { role?: string; content?: unknown } }).message)
      .filter((message) => message?.role === 'user')
    expect(branchTexts.length).toBeGreaterThan(0)

    const info = (await SessionManager.list(workspace, probeDir)).find(
      (item) => item.path === sessionFile,
    )
    if (!info) throw new Error('无法定位探针会话')
    expect(info.firstMessage).toBe('文件首条 A')
    const id = info.id

    // 冷读：Pi 全文件顺序的首条 user 消息是 A。
    const coldHost = await createTestHost()
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
    const first = await createTestHost()
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

    const second = await createTestHost()
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
    // 确定性握手：input hook 写 entered 标记后阻塞，测试据此确认已进入预检窗口；
    // 取消后放行，并用 agent_settled 作为「本次发送已彻底结束」的信号。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const enteredFile = join(workspace, 'input-hook-entered')
    const releaseFile = join(workspace, 'input-hook-release')
    const settledFile = join(workspace, 'agent-settled')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('input', async () => {
    writeFileSync(${JSON.stringify(enteredFile)}, 'entered')
    const release = ${JSON.stringify(releaseFile)}
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return undefined
  })
  pi.on('agent_settled', async () => {
    writeFileSync(${JSON.stringify(settledFile)}, 'settled')
  })
}
`
    await writeFile(join(extensionDir, 'pause-input.ts'), extensionSource)

    const isolated = await createTestHost()
    // 模型请求计数：断言取消后**零请求**（比「无产出文本」更强，
    // 能捕获「已发出但尚未返回」的请求）。
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      globalThis.fetch = ((input: unknown, init?: unknown) => {
        fetchCalls += 1
        return realFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1])
      }) as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // 发起发送（会停在 input hook 的预检阶段）；等待确认已进入预检窗口后取消。
      const sending = isolated.sendMessage(id, { content: 'this must never run' })
      await waitForFile(enteredFile, 20_000)
      await isolated.cancelRun(id)
      // 放行预检：若取消未兜底，prompt 会继续进入 _runAgentPrompt 并调用模型。
      await writeFile(releaseFile, 'go')
      await sending

      // 等待「本次发送彻底结束」的确定性信号（而非固定睡眠猜模型耗时）。
      // 注：取消路径可能不触发 agent_settled（未真正启动运行），因此这里只作为
      // 有则更好的边界；关键断言是下面的「零模型请求」。
      await waitForFile(settledFile, 5_000).catch(() => {
        // 取消未启动运行时不会有 settled，属预期。
      })
      // 给可能正在发出中的请求留出极短窗口，避免「请求已发出但计数未到」。
      await new Promise((resolve) => setTimeout(resolve, 500))

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
      // 模型请求必须为零：取消不得让 provider 真正收到调用。
      expect(fetchCalls).toBe(0)
      // 断言边界：取消后没有模型产出的文本（thinking/toolCall/报错不在本测试承诺内）。
      expect(producedText).toEqual([])
      expect(snapshot.metadata.status).toBe('idle')
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
      await rm(join(extensionDir, 'pause-input.ts'), { force: true })
    }
  }, 60_000)

  it('预检期取消不吞掉后续真实失败（运行级归属隔离）', async () => {
    // 防住「集合级取消判定」最隐蔽的缺陷：已取消的 A 仍卡在预检（在途标记为
    // cancelled）时，B 也发出并真实失败——B 的失败不得被 A 的取消标记掩盖。
    // 设计语义（准入闸门）：B 会等 A 的运行收尾后才开始自己的预检，
    // 而不是并发越过预检；因此这里也顺带验证串行化的顺序性。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const enteredFile = join(workspace, 'isolate-entered')
    const releaseFile = join(workspace, 'isolate-release')
    const bEnteredFile = join(workspace, 'isolate-b-entered')
    // hook 只阻塞带 PAUSE_MARKER 的输入（A），B 不受阻塞；
    // B 进入预检时写标记，用于断言「B 在 A 之后才进入预检」。
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('input', async (event) => {
    if (!event.text.includes('PAUSE_MARKER')) {
      writeFileSync(${JSON.stringify(bEnteredFile)}, 'entered')
      return undefined
    }
    writeFileSync(${JSON.stringify(enteredFile)}, 'entered')
    const release = ${JSON.stringify(releaseFile)}
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return undefined
  })
}
`
    await writeFile(join(extensionDir, 'isolate-input.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch

    try {
      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：停在预检 → 取消（保持阻塞，A 的 cancelled 标记仍在集合中）。
      const sendingA = isolated.sendMessage(id, { content: 'PAUSE_MARKER must never run' })
      await waitForFile(enteredFile, 20_000)
      await isolated.cancelRun(id)

      // B：真实失败（mock fetch 返回 400；400 不触发 SDK 自动重试）。
      // 准入闸门使 B 等待 A 的启动窗口，B 尚未进入预检。
      globalThis.fetch = (async () =>
        new Response('{"error":{"message":"boom from test"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch
      const sendingB = isolated.sendMessage(id, { content: 'this must fail' })
      // B 不得在 A 结算前进入预检（闸门已验证占窗者未释放）。
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(existsSync(bEnteredFile)).toBe(false)

      // 释放 A：A 的运行被兜底中止并结算，随后 B 才开始预检并真实失败。
      await writeFile(releaseFile, 'go')
      await sendingA
      await sendingB

      const deadlineB = Date.now() + 30_000
      let snapshot = await isolated.getThread(id)
      while (Date.now() < deadlineB) {
        snapshot = await isolated.getThread(id)
        if (snapshot.metadata.status === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      // A 的取消标记不得吞掉 B 的失败。
      expect(snapshot.metadata.status).toBe('failed')
      expect(snapshot.lastError).toContain('boom from test')
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
      await rm(join(extensionDir, 'isolate-input.ts'), { force: true })
    }
  }, 90_000)

  it('取消窗口内的输入不泄漏进队列（输入守卫在提交点拒收）', async () => {
    // 根因（SDK 行为）：`prompt()` 在 input hook 之后才判定「流式中 → 入队」，
    // 因此「已取消但仍在 hook 里」的输入会在此后入队，滞留到下次运行被执行。
    // 宿主注入的 input 守卫扩展在提交点用 `handled` 拒收它。
    //
    // 时序（在闸门语义下）：A 运行中 → B 停 input hook（此刻 isStreaming 为真，
    // 闸门按「正常运行」放行 B 走 SDK 排队分支，不进占窗）→ 取消 B → 放行 hook
    // → B 不得进入队列（守卫拒收 + 提交点拒绝兜底）。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const enteredFile = join(workspace, 'guard-entered')
    const releaseFile = join(workspace, 'guard-release')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('input', async (event) => {
    if (!event.text.includes('QUEUE_MARKER')) return undefined
    writeFileSync(${JSON.stringify(enteredFile)}, 'entered')
    const release = ${JSON.stringify(releaseFile)}
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return undefined
  })
}
`
    await writeFile(join(extensionDir, 'guard-input.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      // mock 慢速成功响应：A 保持流式约 4 秒（给取消留出窗口），随后自然结束。
      globalThis.fetch = (async () => {
        fetchCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 4_000))
        const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
        const body =
          chunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
            ],
          }) +
          chunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          'data: [DONE]\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：启动运行并保持流式。
      await isolated.sendMessage(id, { content: 'hold the stream open' })
      const deadlineRunning = Date.now() + 20_000
      while (Date.now() < deadlineRunning) {
        if ((await isolated.getThread(id)).metadata.status === 'running') break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      // B：进入 input hook 后阻塞（此刻 A 流式中，闸门按正常运行放行）。
      const sendingB = isolated.sendMessage(id, { content: 'QUEUE_MARKER must be dropped' })
      await waitForFile(enteredFile, 20_000)

      // 取消 B（A 也一并中止）；B 仍在 hook 中。
      const cancelling = isolated.cancelRun(id)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await isolated.cancelRun(id).catch(() => {})
      // 放行 B：守卫/提交点应拒收它，不得入队。
      await writeFile(releaseFile, 'go')
      await sendingB
      await cancelling.catch(() => {})

      // 等运行结算。
      const deadlineIdle = Date.now() + 30_000
      while (Date.now() < deadlineIdle) {
        if ((await isolated.getThread(id)).metadata.status === 'idle') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const snapshot = await isolated.getThread(id)
      // 核心断言 1：已取消的输入不得滞留队列（否则下次运行会执行它）。
      expect(snapshot.metadata.queuedMessages ?? []).toEqual([])
      // 核心断言 2：被取消的 B 不得触发模型请求（只应有 A 的 1 次）。
      expect(fetchCalls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
      await rm(join(extensionDir, 'guard-input.ts'), { force: true })
    }
  }, 90_000)

  it('运行中的排队不因闸门被推迟（steer/followUp 即时入队）', async () => {
    // 防回归：闸门若对「正常运行中」也等待结算，steer/follow-up 会被推迟到
    // 整次运行结束后才送达，破坏排队语义（迭代③ §3.3 契约）。
    // 断言：B 在 A 仍流式时即被接受并入队，且 clearQueue 能取回其文本。
    const isolated = await createTestHost()
    const realFetch = globalThis.fetch

    try {
      // mock 慢速成功响应：A 保持流式足够久（给 B 入队留出窗口）。
      globalThis.fetch = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 6_000))
        const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
        const body =
          chunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
            ],
          }) +
          chunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          'data: [DONE]\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：启动运行并保持流式。
      await isolated.sendMessage(id, { content: 'hold the stream open' })
      const deadlineRunning = Date.now() + 20_000
      while (Date.now() < deadlineRunning) {
        if ((await isolated.getThread(id)).metadata.status === 'running') break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      // B：运行中发送——必须及时被接受（不得等 A 结算）。
      const startedAt = Date.now()
      await isolated.sendMessage(id, { content: 'queued while running' })
      expect(Date.now() - startedAt).toBeLessThan(2_000)

      // B 已进入 SDK 队列（此时 A 仍在运行）。
      const deadlineQueued = Date.now() + 5_000
      let metadata = (await isolated.getThread(id)).metadata
      while (Date.now() < deadlineQueued) {
        metadata = (await isolated.getThread(id)).metadata
        if ((metadata.queuedMessages ?? []).length > 0) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect((metadata.queuedMessages ?? []).map((item) => item.content)).toContain(
        'queued while running',
      )

      // clearQueue 能取回它（队列语义完整）。
      const cleared = await isolated.clearQueue(id)
      const clearedTexts = [...cleared.steering, ...cleared.followUp]
      expect(clearedTexts).toContain('queued while running')

      await isolated.cancelRun(id)
      // 等结算，避免影响后续用例。
      const deadlineIdle = Date.now() + 30_000
      while (Date.now() < deadlineIdle) {
        if ((await isolated.getThread(id)).metadata.status === 'idle') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
    }
  }, 90_000)

  it('扩展的延迟触发运行（triggerTurn）在退休后不得发出请求', async () => {
    // 路径（SDK agent-session.js:1805）：扩展 `sendMessage(..., { triggerTurn: true })`
    // 在结算窗口（`_isEmittingAgentSettled`）被压入 `_deferredSettledActions`，
    // 之后直接调 `_runAgentPrompt`——不经输入守卫、不经 `preflightResult`。
    // 宿主唯一够得到的钩子是 `agent_start`（退休兜底中止）。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const settledEnteredFile = join(workspace, 'trigger-settled-entered')
    const settledReleaseFile = join(workspace, 'trigger-settled-release')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('agent_settled', async () => {
    if (!existsSync(${JSON.stringify(settledEnteredFile)})) {
      writeFileSync(${JSON.stringify(settledEnteredFile)}, 'entered')
      // 在结算窗口内提交一个「触发运行」的自定义消息（即被延迟的动作）。
      pi.sendMessage(
        { customType: 'test-trigger', content: [{ type: 'text', text: 'TRIGGER_MARKER' }] },
        { triggerTurn: true },
      )
      const release = ${JSON.stringify(settledReleaseFile)}
      while (!existsSync(release)) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  })
}
`
    await writeFile(join(extensionDir, 'trigger-turn.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      globalThis.fetch = (async () => {
        fetchCalls += 1
        return new Response('{"error":{"message":"must not be called twice"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：自然结束（mock 400 一次），停在扩展的 settled hook（延迟动作已入队）。
      await isolated.sendMessage(id, { content: 'A finishes naturally' })
      await waitForFile(settledEnteredFile, 60_000)
      expect(fetchCalls).toBe(1)

      // 会话退休（dispose）；随后放行 settled hook 触发延迟动作。
      await isolated.dispose()
      await writeFile(settledReleaseFile, 'go')
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // 核心断言：延迟触发的运行在 `agent_start` 处被中止，不得发出模型请求。
      expect(fetchCalls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      await rm(join(extensionDir, 'trigger-turn.ts'), { force: true })
    }
  }, 90_000)

  it('shutdown handler 内提交的延迟运行不得逃逸（退休收尾二次清空）', async () => {
    // 缺口背景（顾问指出）：退休入口的清空发生在 `emitShutdown()` **之前**，
    // 若扩展的 `session_shutdown` handler 再次提交 `sendMessage(triggerTurn)`，
    // 该动作会在 `_isEmittingAgentSettled` 期间重新进入 `_deferredSettledActions`，
    // 并在宿主 dispose/退订后被 SDK 执行——此时没有任何防线能拦。
    // 修复：`emitShutdown` 之后**再清一次**（与 dispose 同步链内，中间不插 await）。
    //
    // 注：「SDK 已 splice 取走的局部批次」由同组的第二次 settled 握手用例覆盖，
    // 此处只验证成员数组在收尾后不再残留（提交两个动作以增强区分度）。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const settledEnteredFile = join(workspace, 'shutdown-settled-entered')
    const settledReleaseFile = join(workspace, 'shutdown-settled-release')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('agent_settled', async () => {
    if (!existsSync(${JSON.stringify(settledEnteredFile)})) {
      writeFileSync(${JSON.stringify(settledEnteredFile)}, 'entered')
      const release = ${JSON.stringify(settledReleaseFile)}
      while (!existsSync(release)) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  })
  pi.on('session_shutdown', () => {
    // 收尾期间连续提交两个延迟动作：第一个被清空拦下；第二个若在清空
    // 与 dispose 之间被 SDK 取走，则只能由 agent 级兜底订阅中止。
    pi.sendMessage(
      { customType: 'shutdown-trigger-1', content: [{ type: 'text', text: 'SHUTDOWN_MARKER' }] },
      { triggerTurn: true },
    )
    pi.sendMessage(
      { customType: 'shutdown-trigger-2', content: [{ type: 'text', text: 'SHUTDOWN_MARKER' }] },
      { triggerTurn: true },
    )
  })
}
`
    await writeFile(join(extensionDir, 'shutdown-trigger.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      globalThis.fetch = (async () => {
        fetchCalls += 1
        return new Response('{"error":{"message":"must not be called twice"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：自然结束，停在阻塞的 settled hook —— 结算窗口。
      await isolated.sendMessage(id, { content: 'A finishes naturally' })
      await waitForFile(settledEnteredFile, 60_000)
      expect(fetchCalls).toBe(1)

      // dispose：跑到 emitShutdown（此时扩展重新入队延迟动作）并完成收尾。
      await isolated.dispose()
      // 放行 settled hook：SDK 会执行已捕获的延迟动作（若有）。
      await writeFile(settledReleaseFile, 'go')
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // 核心断言：shutdown 期间提交的延迟运行不得发出模型请求。
      expect(fetchCalls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      await rm(join(extensionDir, 'shutdown-trigger.ts'), { force: true })
    }
  }, 90_000)

  it('SDK 已取走的延迟批次（splice 局部数组）不得逃逸（agent 级兜底）', async () => {
    // 顾问指出的最深缺口，已由探针实证：
    // SDK 在 `_emitAgentSettled()` 里先 `splice(0)` 把延迟动作取入**局部**数组，
    // 再逐个 `await action()`。若退休发生在「第一个动作的运行进行中」，
    // 后续动作在局部数组里——清空成员数组够不到；只能由直连 `session.agent`
    // 的兜底订阅在 `agent_start` 处中止（探针实测：不保留订阅时请求数 2→3）。
    //
    // 时序（与探针一致）：
    // 1. A 完成（请求#1）→ hook#1 提交两个 triggerTurn 动作 X、Y 并阻塞；
    // 2. 放行 hook#1 → SDK splice 取走 [X, Y] → 执行 X（请求#2）→ 进入 hook#2 并阻塞；
    //    此时 Y 在 SDK 的局部数组里；
    // 3. 此刻 dispose（清空成员数组无效；session 已空闲，abort 也不留意图）；
    // 4. 放行 hook#2 → 外层循环继续执行 Y → 必须被 agent 级订阅中止。
    // 断言：最终请求数为 2（A + X），Y 不得产生请求#3。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const entered1File = join(workspace, 'splice-entered-1')
    const release1File = join(workspace, 'splice-release-1')
    const entered2File = join(workspace, 'splice-entered-2')
    const release2File = join(workspace, 'splice-release-2')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
let count = 0
export default function (pi) {
  pi.on('agent_settled', async () => {
    count += 1
    if (count === 1) {
      pi.sendMessage({ customType: 'x', content: [{ type: 'text', text: 'X' }] }, { triggerTurn: true })
      pi.sendMessage({ customType: 'y', content: [{ type: 'text', text: 'Y' }] }, { triggerTurn: true })
      writeFileSync(${JSON.stringify(entered1File)}, 'entered')
      while (!existsSync(${JSON.stringify(release1File)})) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } else if (count === 2) {
      writeFileSync(${JSON.stringify(entered2File)}, 'entered')
      while (!existsSync(${JSON.stringify(release2File)})) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  })
}
`
    await writeFile(join(extensionDir, 'splice-batch.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      globalThis.fetch = (async () => {
        fetchCalls += 1
        return new Response('{"error":{"message":"batch probe"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：1 次请求，停在 hook#1（两个延迟动作已提交）。
      await isolated.sendMessage(id, { content: 'A finishes naturally' })
      await waitForFile(entered1File, 60_000)
      expect(fetchCalls).toBe(1)

      // 放行 hook#1 → SDK 取走 [X, Y] 并执行 X（请求#2）→ 进入 hook#2 阻塞。
      await writeFile(release1File, 'go')
      await waitForFile(entered2File, 60_000)
      expect(fetchCalls).toBe(2)

      // 此刻 Y 在 SDK 局部数组里：dispose 后放行 hook#2，Y 不得启动。
      await isolated.dispose()
      await writeFile(release2File, 'go')
      await new Promise((resolve) => setTimeout(resolve, 3_000))

      // 核心断言：Y 被 agent 级订阅中止，请求数仍为 2。
      expect(fetchCalls).toBe(2)
    } finally {
      globalThis.fetch = realFetch
      await rm(join(extensionDir, 'splice-batch.ts'), { force: true })
    }
  }, 120_000)

  it('等待已取消运行结算的发送可被再次取消唤醒（不悬挂）', async () => {
    // 路径：A 运行中 → 取消（A 的 settled 因扩展 hook 阻塞迟迟不到）→
    // B 进入闸门，等待 `run.settled` → 再次取消 → B 必须能退出该等待，
    // 而不是悬挂到 A 最终结算（SDK 层无法中断永久阻塞的 hook）。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const settledEnteredFile = join(workspace, 'settled-hook-entered')
    const settledReleaseFile = join(workspace, 'settled-hook-release')
    const bEnteredFile = join(workspace, 'settle-b-entered')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('agent_settled', async () => {
    if (!existsSync(${JSON.stringify(settledEnteredFile)})) {
      writeFileSync(${JSON.stringify(settledEnteredFile)}, 'entered')
      const release = ${JSON.stringify(settledReleaseFile)}
      while (!existsSync(release)) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  })
  pi.on('input', async (event) => {
    if (event.text.includes('B_MARKER')) writeFileSync(${JSON.stringify(bEnteredFile)}, 'entered')
    return undefined
  })
}
`
    await writeFile(join(extensionDir, 'pause-settled.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch

    try {
      // 慢响应：A 保持运行，直到取消；取消后其 settled hook 会阻塞。
      globalThis.fetch = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20_000))
        return new Response('{"error":{"message":"slow"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      await isolated.sendMessage(id, { content: 'hold for cancel' })
      const deadlineRunning = Date.now() + 20_000
      while (Date.now() < deadlineRunning) {
        if ((await isolated.getThread(id)).metadata.status === 'running') break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      // 取消 A：其 settled hook 将阻塞（进入等待）。
      void isolated.cancelRun(id).catch(() => {})
      await waitForFile(settledEnteredFile, 30_000)

      // B：进入闸门，等待 A 的 settled（A 被取消 → 走 run.settled 分支）。
      const sendingB = isolated.sendMessage(id, { content: 'B_MARKER waits for settled' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      // B 尚未进入预检：它还在等 A 结算。
      expect(existsSync(bEnteredFile)).toBe(false)

      // 再次取消：B 必须被唤醒并退出（而非悬挂在 run.settled 上）。
      const cancelWake = Date.now() + 5_000
      await isolated.cancelRun(id)
      const bFinished = await Promise.race([
        sendingB.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ])
      expect(bFinished).toBe(true)
      expect(Date.now()).toBeLessThan(cancelWake)

      // 放行 settled hook，收尾。
      await writeFile(settledReleaseFile, 'go')
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
      await rm(join(extensionDir, 'pause-settled.ts'), { force: true })
    }
  }, 90_000)

  it('结算窗口内的发送可被取消（延迟动作不得逃过取消追踪）', async () => {
    // 根因（SDK 行为）：`_emitAgentSettled()` 期间 `_isEmittingAgentSettled` 为真，
    // `prompt()` 会把调用静默压入 `_deferredSettledActions` 并**立即返回**
    // （agent-session.js:1517）。若宿主在此时放行新发送，它会误判「已接受」
    // 并移除跟踪；此后取消再也够不到它，放行 settled hook 后输入仍会启动。
    // 宿主的对策：闸门等待任一在途运行的 `settled`；且提交点对已取消发送抛错。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const settledEnteredFile = join(workspace, 'defer-settled-entered')
    const settledReleaseFile = join(workspace, 'defer-settled-release')
    const bEnteredFile = join(workspace, 'defer-b-entered')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('agent_settled', async () => {
    if (!existsSync(${JSON.stringify(settledEnteredFile)})) {
      writeFileSync(${JSON.stringify(settledEnteredFile)}, 'entered')
      const release = ${JSON.stringify(settledReleaseFile)}
      while (!existsSync(release)) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
  })
  pi.on('input', async (event) => {
    if (event.text.includes('B_MARKER')) writeFileSync(${JSON.stringify(bEnteredFile)}, 'entered')
    return undefined
  })
}
`
    await writeFile(join(extensionDir, 'pause-deferred.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      // mock 成功的最小 SSE 响应：A 恰好发出 1 次请求并自然结束
      // （避免真实模型的多轮工具调用干扰计数）。
      globalThis.fetch = (async () => {
        fetchCalls += 1
        const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
        const body =
          chunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
            ],
          }) +
          chunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          'data: [DONE]\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // A：自然结束（不取消），但停在阻塞的 settled hook —— 即「结算窗口」。
      await isolated.sendMessage(id, { content: 'A finishes naturally' })
      await waitForFile(settledEnteredFile, 60_000)
      await new Promise((resolve) => setTimeout(resolve, 300))

      // B：在结算窗口中间发送。
      const sendingB = isolated.sendMessage(id, { content: 'B_MARKER must not slip through' })
      let bOutcome: 'pending' | 'settled' = 'pending'
      void sendingB.then(
        () => {
          bOutcome = 'settled'
        },
        () => {
          bOutcome = 'settled'
        },
      )

      // 【闸门独有信号】在**任何取消之前**：B 仍在闸门等待（pending）。
      // 若闸门缺失，SDK 会把 B 静默压入延迟队列并**立即返回**（settled）——
      // 此时尚未取消，其他取消防线无法掩盖差异。
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(bOutcome).toBe('pending')
      // 且 B 尚未进入预检（input hook 未执行）。
      expect(existsSync(bEnteredFile)).toBe(false)

      // 取消 B：闸门等待应被唤醒，B 及时返回（不悬挂到 A 结算）。
      await isolated.cancelRun(id)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(bOutcome).toBe('settled')

      // 放行 A 的 settled hook：被取消的 B 不得启动运行。
      await writeFile(settledReleaseFile, 'go')
      await sendingB.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // 核心断言：只应有 A 的 1 次请求；被取消的 B 不得发出模型请求。
      expect(fetchCalls).toBe(1)
      const snapshot = await isolated.getThread(id)
      expect(snapshot.metadata.status).toBe('idle')
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
      await rm(join(extensionDir, 'pause-deferred.ts'), { force: true })
    }
  }, 120_000)
})

describe('装配与生命周期竞态（顾问审查要求：确定性）', () => {
  it('装配期间 dispose：创建被取消，且 dispose 后操作全部拒绝', async () => {
    // 确定性握手：扩展进入 session_start 后写 entered 标记再阻塞；
    // 测试等到 entered（证明装配已进入目标窗口），在**仍阻塞时**完成 dispose，
    // 然后放行——此时若缺少最后一次取消检查，创建会成功并发布失效 record。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const enteredFile = join(workspace, 'start-hook-entered')
    const releaseFile = join(workspace, 'start-hook-release')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('session_start', async () => {
    writeFileSync(${JSON.stringify(enteredFile)}, 'entered')
    const release = ${JSON.stringify(releaseFile)}
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })
}
`
    await writeFile(join(extensionDir, 'pause-start.ts'), extensionSource)

    const isolated = await createTestHost()

    // 提前挂载结果处理，避免取消后的未处理 rejection。
    let createOutcome: { ok: true } | { ok: false; error: unknown } | undefined
    const creating = isolated
      .createThread()
      .then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
      .then((outcome) => {
        createOutcome = outcome
        return outcome
      })

    // 等待扩展明确进入 session_start（而非靠固定睡眠猜时序）。
    await waitForFile(enteredFile, 20_000)
    // 仍阻塞时完成 dispose：此后放行装配。
    await isolated.dispose()
    await writeFile(releaseFile, 'go')

    const outcome = await creating
    expect(createOutcome?.ok).toBe(false)
    if (!outcome.ok) expect(String(outcome.error)).toMatch(/cancelled|disposed/i)

    // dispose 后所有操作都必须拒绝 / 幂等。
    await expect(isolated.listThreads()).rejects.toThrow(/disposed/)
    await expect(isolated.createThread()).rejects.toThrow(/disposed/)
    await expect(isolated.dispose()).resolves.toBeUndefined()

    await rm(join(extensionDir, 'pause-start.ts'), { force: true })
  }, 60_000)

  it('预检通过后（before_agent_start 阻塞）dispose：零模型请求', async () => {
    // 缺口背景（顾问指出）：输入守卫只能拦「尚未通过守卫」的输入；
    // 通过守卫后停在 before_agent_start 的 prompt，在 dispose 排空超时后
    // 仍可能继续进入 `_runAgentPrompt()` 启动运行（此时宿主已退订，
    // 无 agent_start 可兜底）。宿主的对策是在 `preflightResult('started')`
    // 中检查 retired 并抛出（SDK 不捕获该回调异常，prompt 以拒绝收尾）。
    //
    // Pi 1.4 语义：`preflightResult('started')` 在 `_prepareRun()`（含本 hook）
    // **之后**才回调，因此不能再先 await sendMessage 再等 hook 进入；按语义改为
    // 先等 hook 进入标记、期间不 await 发送，再 dispose、放行，最后等发送收尾。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const enteredFile = join(workspace, 'before-start-entered')
    const releaseFile = join(workspace, 'before-start-release')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('before_agent_start', async (event) => {
    // 1.4 起事件按 messageType 区分（用户输入 / 扩展 custom 消息）：只阻塞用户输入。
    if (event.messageType !== 'user') return undefined
    writeFileSync(${JSON.stringify(enteredFile)}, 'entered')
    const release = ${JSON.stringify(releaseFile)}
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return undefined
  })
}
`
    await writeFile(join(extensionDir, 'pause-before-start.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch
    let fetchCalls = 0

    try {
      globalThis.fetch = ((input: unknown, init?: unknown) => {
        fetchCalls += 1
        return realFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1])
      }) as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      // 发送：停在 before_agent_start（已过输入守卫）。
      // 不 await：1.4 下发送的「已接受」回调要等本 hook 返回。
      let sendOutcome: unknown = 'pending'
      const sending = isolated.sendMessage(id, { content: 'must not reach provider' }).then(
        () => {
          sendOutcome = 'resolved'
        },
        (error: unknown) => {
          sendOutcome = error
        },
      )
      await waitForFile(enteredFile, 20_000)

      // dispose（排空与 abort 各有 5s 上限；此处 hook 仍阻塞，两者都会超时）。
      await isolated.dispose()
      // 放行：若 retired 检查缺失，prompt 会继续启动运行并发出模型请求。
      await writeFile(releaseFile, 'go')
      await sending
      // 取消/退休属预期结果：发送不得被上报为失败，也不得假成功与否无关。
      expect(sendOutcome, String(sendOutcome)).toBe('resolved')
      await new Promise((resolve) => setTimeout(resolve, 1_500))

      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      await rm(join(extensionDir, 'pause-before-start.ts'), { force: true })
    }
  }, 60_000)

  it('A/B 双会话的扩展动作互不串扰（每 live session 独立装配）', async () => {
    // 机制背景（已核对 SDK，并用探针实测）：
    // - 扩展 API 持有**装配级 runtime** 引用（`createExtensionAPI(extension, runtime, ...)`）；
    // - `ExtensionRunner.bindCore()` 把 sendMessage/setModel/appendEntry 等动作写入该 runtime
    //   （runner.js：「Copy actions into the shared runtime」）；
    // - 每次装配产出**不同** runtime（探针实测）。
    // 因此若两个 live session 复用同一套装配产物，后打开者会把先打开者的动作目标改到自己身上。
    //
    // 验证分两段，覆盖「启动时」与「启动后」两个窗口：
    // 1. session_start 注入 marker（走共享 runtime 通道）；
    // 2. 两个会话都 live 之后，通过扩展命令再次触发 marker（携带目标会话 id），
    //    确认动作打到正确的会话。仅第 1 段无法排除「启动后串扰」。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const extensionSource = `
export default function (pi) {
  pi.on('session_start', async () => {
    pi.sendMessage({ customType: 'ab-start', content: 'start-marker', display: true })
  })
  pi.registerCommand('ping-marker', {
    description: 'send a marker through the shared-runtime action channel',
    handler: async (args, ctx) => {
      pi.sendMessage({
        customType: 'ab-ping',
        content: 'ping:' + args + ':' + ctx.sessionManager.getSessionId(),
        display: true,
      })
    },
  })
}
`
    await writeFile(join(extensionDir, 'ab-marker.ts'), extensionSource)

    const isolated = await createTestHost()

    try {
      const a = await isolated.createThread()
      const b = await isolated.createThread()
      expect(a.metadata.id).not.toBe(b.metadata.id)

      const countMarkers = (snapshot: { messages: readonly { role: string }[] }, type: string) =>
        snapshot.messages.filter(
          (message) =>
            message.role === 'custom' && (message as { customType?: string }).customType === type,
        ).length

      // 段 1：各自恰好 1 条启动 marker（共享 runtime 时 A 为 0、B 为 2）。
      const afterStartA = await isolated.getThread(a.metadata.id)
      const afterStartB = await isolated.getThread(b.metadata.id)
      expect(countMarkers(afterStartA, 'ab-start')).toBe(1)
      expect(countMarkers(afterStartB, 'ab-start')).toBe(1)

      // 段 2：两会话都 live 后，经扩展命令触发动作，确认打到正确会话。
      // 依次 A → B → A，验证不是「只有最后绑定的会话生效」。
      await isolated.sendMessage(a.metadata.id, { content: '/ping-marker aa' })
      await isolated.sendMessage(b.metadata.id, { content: '/ping-marker bb' })
      await isolated.sendMessage(a.metadata.id, { content: '/ping-marker a2' })

      const afterA = await isolated.getThread(a.metadata.id)
      const afterB = await isolated.getThread(b.metadata.id)
      const pingsOf = (snapshot: { messages: readonly unknown[] }) =>
        snapshot.messages
          .filter(
            (message) =>
              (message as { role?: string }).role === 'custom' &&
              (message as { customType?: string }).customType === 'ab-ping',
          )
          .map((message) => String((message as { content?: unknown }).content))

      const pingsA = pingsOf(afterA)
      const pingsB = pingsOf(afterB)
      // A 收到自己那条 aa 与 a2（且携带 A 的会话 id）；B 收到 bb。
      expect(pingsA.some((text) => text.includes('ping:aa:'))).toBe(true)
      expect(pingsA.some((text) => text.includes('ping:a2:'))).toBe(true)
      expect(pingsA.every((text) => text.includes(a.metadata.id))).toBe(true)
      expect(pingsB.length).toBe(1)
      expect(pingsB[0]).toContain('ping:bb:')
      expect(pingsB[0]).toContain(b.metadata.id)
    } finally {
      // 统一收尾：登记落盘会话，释放宿主，清理扩展。
      for (const id of []) void id
      await isolated.dispose()
      await rm(join(extensionDir, 'ab-marker.ts'), { force: true })
    }
  }, 90_000)

  it('快照与后续 SDK 改写隔离（消息对象不得被原地替换污染）', async () => {
    // 缺口背景（顾问指出，已核对 SDK 源码）：扩展在 `message_end` hook 返回
    // 替换消息时，SDK 用 `_replaceMessageInPlace()`（delete 所有键 + assign）
    // **原地改写**已进入 `state.messages` 的对象。因此在 hook 等待期间取得的
    // 快照，即使复制了数组，其消息对象仍会被随后改写。
    // 修复：`isolateMessages()` 逐条浅复制消息对象。
    //
    // 握手：hook 在 message_end 时写 entered 并阻塞；测试在此期间取快照，
    // 放行（hook 返回替换文本）后再看同一份快照——原快照必须保持原内容。
    const extensionDir = join(workspace, '.pi', 'extensions')
    await mkdir(extensionDir, { recursive: true })
    const enteredFile = join(workspace, 'snapshot-isolation-entered')
    const releaseFile = join(workspace, 'snapshot-isolation-release')
    const extensionSource = `
import { existsSync, writeFileSync } from 'node:fs'
export default function (pi) {
  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant') return undefined
    writeFileSync(${JSON.stringify(enteredFile)}, 'entered')
    const release = ${JSON.stringify(releaseFile)}
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // 返回替换消息：SDK 会原地改写已有对象。
    return { message: { ...event.message, content: [{ type: 'text', text: 'REPLACED_BY_HOOK' }] } }
  })
}
`
    await writeFile(join(extensionDir, 'replace-message.ts'), extensionSource)

    const isolated = await createTestHost()
    const realFetch = globalThis.fetch

    try {
      globalThis.fetch = (async () => {
        const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
        const body =
          chunk({
            id: 'chatcmpl-iso',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'iso',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'ORIGINAL_TEXT' },
                finish_reason: null,
              },
            ],
          }) +
          chunk({
            id: 'chatcmpl-iso',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'iso',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          'data: [DONE]\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }) as unknown as typeof fetch

      const created = await isolated.createThread()
      const id = created.metadata.id

      await isolated.sendMessage(id, { content: '触发替换' })
      await waitForFile(enteredFile, 60_000)

      // hook 仍阻塞时取快照（此时对象尚未被替换）。
      const during = await isolated.getThread(id)
      const assistantDuring = during.messages.find((message) => message.role === 'assistant')
      expect(JSON.stringify(assistantDuring)).toContain('ORIGINAL_TEXT')

      // 同一时点另建订阅：直接保留订阅者拿到的消息引用（不自行复制），
      // 用于单独验证「交付给订阅者的对象」也被隔离。
      let subscribedAssistant: unknown
      const unsubscribe = isolated.subscribe(
        id,
        (event) => {
          if (event.type !== 'snapshot') return
          subscribedAssistant = event.snapshot.messages.find(
            (message) => message.role === 'assistant',
          )
        },
        { includeSnapshot: true },
      )
      // 断言订阅确实拿到了助手消息（避免空集合导致的假通过）。
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(JSON.stringify(subscribedAssistant)).toContain('ORIGINAL_TEXT')

      // 放行 hook → SDK 原地改写消息对象。
      await writeFile(releaseFile, 'go')
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const current = await isolated.getThread(id)
        if (
          current.metadata.status === 'idle' &&
          current.messages.some((m) => m.role === 'assistant')
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await new Promise((resolve) => setTimeout(resolve, 300))

      // 权威快照已反映替换（确认替换确实发生）。
      const after = await isolated.getThread(id)
      const assistantAfter = after.messages.find((message) => message.role === 'assistant')
      expect(JSON.stringify(assistantAfter)).toContain('REPLACED_BY_HOOK')

      // 核心断言：**先前取得的快照**不得被改写（隔离生效）。
      expect(JSON.stringify(assistantDuring)).toContain('ORIGINAL_TEXT')
      expect(JSON.stringify(assistantDuring)).not.toContain('REPLACED_BY_HOOK')
      // 订阅者保留的引用同样不得被污染。
      expect(JSON.stringify(subscribedAssistant)).toContain('ORIGINAL_TEXT')
      expect(JSON.stringify(subscribedAssistant)).not.toContain('REPLACED_BY_HOOK')
      unsubscribe()
    } finally {
      globalThis.fetch = realFetch
      await isolated.dispose()
      await rm(join(extensionDir, 'replace-message.ts'), { force: true })
    }
  }, 90_000)
})

describe('测试隔离（fixture 生命周期）', () => {
  it('初始化失败也释放临时空间、还原继承环境与 fetch', async () => {
    const previousFetch = globalThis.fetch
    const failedEnv = await createIsolatedPiEnv('huan-fixture-fail-')
    // 模拟继承的 PI_* 值：清理必须把它恢复（而不是丢弃或泄漏到后续用例）。
    process.env.PI_PROVIDER = 'inherited-should-be-restored'
    try {
      await expect(
        createHostFixture({
          env: failedEnv,
          createHost: async () => {
            throw new Error('模拟宿主初始化失败')
          },
        }),
      ).rejects.toThrow('模拟宿主初始化失败')
      // 临时根已删除（初始化失败不残留、不二次抛错）。
      expect(existsSync(failedEnv.root)).toBe(false)
      // 继承环境被还原为进入前的值。
      expect(process.env.PI_PROVIDER).toBe('inherited-should-be-restored')
      // 全局 fetch 还原为套件自己的确定性桩。
      expect(globalThis.fetch).toBe(previousFetch)
    } finally {
      delete process.env.PI_PROVIDER
    }
  }, 30_000)

  it('fetch 桩只应答合成 provider 端点，其它本机地址计入意外请求', async () => {
    const stub = installTestFetch()
    try {
      // 任意其它 localhost 端口都不得被当成成功响应（可能掩盖请求打错端点）。
      await expect(fetch('http://localhost:1234/v1/chat/completions')).rejects.toThrow(
        /非预期网络请求/,
      )
      expect(stub.unexpected()).toEqual(['http://localhost:1234/v1/chat/completions'])

      const response = await fetch(`${TEST_BASE_URL}/chat/completions`)
      expect(response.status).toBe(200)
      expect(stub.calls()).toBe(1)
      expect(stub.unexpected()).toHaveLength(1)
    } finally {
      stub.restore()
    }
  })
})
