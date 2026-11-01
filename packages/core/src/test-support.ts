/**
 * 测试辅助：隔离的 Pi 用户空间与确定性模型响应。
 *
 * 仅供自动化测试使用：经子路径 `@huan/core/testing` 显式导入，不从生产入口
 * `@huan/core` 导出（避免测试实现进入应用打包路径）。
 * 目标（迭代设计 §4.1）：
 * - 每组用例使用临时 agentDir / workspace / sessions，不读写个人 Pi 配置；
 * - 合成 provider + 虚假测试 key + 确定性流，覆盖两个可用模型与一个缺凭据模型；
 * - 默认禁止非预期联网：fetch 只应答合成 provider 端点，其余地址一律失败并计数；
 * - 探针会话显式传测试会话目录，清理只触及临时根。
 *
 * 注意：自定义 agentDir 无法隔离全局 Agent Skills 与祖先上下文；测试需同时
 * 通过 `resourceLoaderOptions` 关闭这些发现（见 `TEST_RESOURCE_ISOLATION`）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSessionDir } from './session-dir.js'

/** 合成 provider（本地、不联网）。 */
export const TEST_PROVIDER = 'huan-test'
/** 合成 provider 的第二个模型。 */
export const TEST_MODEL_A = 'test-model-a'
export const TEST_MODEL_B = 'test-model-b'
/** 缺凭据 provider（models.json 无 apiKey，且不设置环境变量），用于可见性断言。 */
export const TEST_UNAUTH_PROVIDER = 'huan-test-noauth'
export const TEST_UNAUTH_MODEL = 'test-model-c'
/** 虚假测试 key（不是任何真实凭据）。 */
export const TEST_API_KEY = 'huan-test-key-not-real'
/** 不可达的本机地址：即使 fetch 未被替换也不会访问外部网络。 */
export const TEST_BASE_URL = 'http://127.0.0.1:9/v1'

/** 资源隔离选项：关闭个人/祖先资源发现，但保留临时工作区内的测试扩展。 */
export const TEST_RESOURCE_ISOLATION = {
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const

/** 隔离环境。 */
export type IsolatedPiEnv = {
  /** 临时根（所有临时文件的唯一父目录）。 */
  root: string
  agentDir: string
  workspace: string
  /** 显式指定的默认会话目录（探针 SessionManager 必须显式传它）。 */
  defaultSessionDir: (cwd?: string) => string
  cleanup: () => Promise<void>
}

const testModel = (id: string, name: string, input: readonly string[] = ['text', 'image']) => ({
  id,
  name,
  input: [...input],
  reasoning: true,
  // 让浏览器测试可覆盖模型选择器中的 Thinking 控件；合成 provider 不解析该字段。
  // max 必须由模型显式映射才可用（与 SDK 的可用级别规则一致）。
  thinkingLevelMap: {
    off: 'off',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  },
  contextWindow: 32_768,
  maxTokens: 4_096,
})

/** 合成 models.json：一个带虚假 key 的 provider + 一个缺凭据 provider。 */
function testModelsConfig() {
  return {
    providers: {
      [TEST_PROVIDER]: {
        baseUrl: TEST_BASE_URL,
        api: 'openai-completions',
        apiKey: TEST_API_KEY,
        models: [
          // A 声明图像输入，B 只声明文本：用于验证 input 能力透传。
          testModel(TEST_MODEL_A, 'Test Model A', ['text', 'image']),
          testModel(TEST_MODEL_B, 'Test Model B', ['text']),
        ],
      },
      [TEST_UNAUTH_PROVIDER]: {
        baseUrl: TEST_BASE_URL,
        api: 'openai-completions',
        models: [testModel(TEST_UNAUTH_MODEL, 'Test Model C')],
      },
    },
  }
}

/**
 * 创建隔离的用户空间与工作区。
 *
 * 写入合成 models.json 与最少 settings.json（默认模型指向测试 provider），
 * 不复制、不读取任何个人配置。`parentDir` 用于把临时根放进可整体清理的
 * 目录（浏览器验收的 Playwright 输出目录），默认仍使用系统临时目录。
 */
export async function createIsolatedPiEnv(
  prefix = 'huan-core-test-',
  options: { parentDir?: string } = {},
): Promise<IsolatedPiEnv> {
  const root = await mkdtemp(join(options.parentDir ?? tmpdir(), prefix))
  const agentDir = join(root, 'agent')
  const workspace = join(root, 'workspace')
  try {
    await mkdir(agentDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(
      join(agentDir, 'models.json'),
      `${JSON.stringify(testModelsConfig(), null, 2)}\n`,
    )
    await writeFile(
      join(agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: TEST_PROVIDER, defaultModel: TEST_MODEL_A }, null, 2)}\n`,
    )
  } catch (error) {
    // 初始化中途失败也要清掉已创建的临时根，避免测试失败时留下垃圾目录。
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return {
    root,
    agentDir,
    workspace,
    defaultSessionDir: (cwd = workspace) => defaultSessionDir(agentDir, cwd),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** 构造 OpenAI-compatible 的确定性 SSE 响应（单段文本 + stop）。 */
export function createTestSseResponse(text = 'ok'): Response {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  const body =
    chunk({
      id: 'chatcmpl-huan-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'huan-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }) +
    chunk({
      id: 'chatcmpl-huan-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'huan-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) +
    'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 合成 provider 端点的 origin（只有它会被应答；其它地址均视为非预期联网）。 */
const TEST_ORIGIN = new URL(TEST_BASE_URL).origin
/** 合成 provider 的 baseUrl 路径前缀（`/v1/`）。 */
const TEST_PATH_PREFIX = `${new URL(TEST_BASE_URL).pathname.replace(/\/$/, '')}/`

type FetchInput = Parameters<typeof fetch>[0]

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** 测试 fetch 桩。 */
export type TestFetchStub = {
  /** 合成 provider 端点的请求次数（已由确定性 SSE 应答）。 */
  calls: () => number
  /** 被拒绝的非预期请求地址；测试结束时应为空（非空说明发生了意外联网）。 */
  unexpected: () => readonly string[]
  /** 还原原始 fetch（幂等）。 */
  restore: () => void
}

/**
 * 安装确定性 fetch 桩并禁止非预期联网。
 *
 * 只应答合成 provider 自己的端点（`TEST_BASE_URL` 的 origin 且路径位于其
 * baseUrl 之下）；其它任意地址（包括其它 localhost 端口）都计入
 * `unexpected()` 并直接失败，不发出真实请求。这样「任意本机地址都返回成功」
 * 不会掩盖请求打到错误端点的缺陷。
 *
 * 调用方必须在 finally 内 `restore()`，并在结束前断言 `unexpected()` 为空。
 * 需要额外计数的用例可在其基础上再包一层。
 */
export function installTestFetch(reply = 'ok'): TestFetchStub {
  const previous = globalThis.fetch
  let calls = 0
  const unexpected: string[] = []
  let restored = false
  globalThis.fetch = (async (input: FetchInput, init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input)
    let isSyntheticProvider = false
    try {
      const parsed = new URL(url)
      isSyntheticProvider =
        parsed.origin === TEST_ORIGIN && parsed.pathname.startsWith(TEST_PATH_PREFIX)
    } catch {
      // 非法 URL 按非预期请求处理。
    }
    if (!isSyntheticProvider) {
      unexpected.push(url)
      throw new Error(`测试禁止非预期网络请求：${url}`)
    }
    calls += 1
    // init 只为保持签名一致；确定性响应不读取请求体。
    void init
    return createTestSseResponse(reply)
  }) as typeof fetch
  return {
    calls: () => calls,
    unexpected: () => [...unexpected],
    restore: () => {
      if (restored) return
      restored = true
      globalThis.fetch = previous
    },
  }
}
