/**
 * 子agent 装配集成测试。
 *
 * 用隔离 agentDir/workspace 与真实 Pi loader 验证 D5：外部同名 subagent 工具被
 * 内置 SDK 实现替代，扩展其他工具/事件与来源诊断保留；子会话注入的工具拒绝嵌套。
 * 另用真实 session_start 验证子会话 MCP 临时 override 只影响内存装配、不写回磁盘。
 * 不启动完整宿主、模型请求或浏览器测试。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentSession,
  createAgentSessionFromServices,
  ExtensionRunner,
  type ExtensionToolContext,
  ModelRegistry,
  ProjectTrustStore,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectAssembly, type ProjectAssemblyDeps } from './host/project-assembly.js'
import { createHostInteractions } from './host-interactions.js'
import { createSharedModelRuntime } from './model-catalog.js'
import type { SubagentTaskRunner } from './subagent-tool.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_RESOURCE_ISOLATION,
  type TestFetchStub,
} from './test-support.js'

let env: IsolatedPiEnv
let fetchStub: TestFetchStub
const assemblies: ProjectAssembly[] = []

beforeEach(async () => {
  env = await createIsolatedPiEnv('huan-subagent-assembly-')
  fetchStub = installTestFetch()
})

afterEach(async () => {
  // 新用例自行释放会话；这里兜底关闭仍归 ProjectAssembly 所有的 MCP binding。
  for (const assembly of assemblies.splice(0)) {
    for (const binding of assembly.pendingBindingList()) await assembly.closeBinding(binding)
  }
  fetchStub.restore()
  await env.cleanup()
  expect(fetchStub.unexpected()).toEqual([])
})

/** 外部旧扩展：同名 subagent + 一个其他工具 + 一个会话事件。 */
async function writeLegacySubagentExtension(fileName: string): Promise<void> {
  const dir = join(env.workspace, '.pi', 'extensions')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, fileName),
    `export default function (pi) {
  pi.on('session_start', () => {})
  pi.registerTool({
    name: 'subagent',
    description: 'legacy CLI subagent',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'legacy' }] }),
  })
  pi.registerTool({
    name: 'legacy-other',
    description: 'legacy other tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'other' }] }),
  })
}
`,
    'utf8',
  )
}

/** 第二个扩展制造另一个工具冲突，用于证明原 error 不被一并吞掉。 */
async function writeConflictingExtension(fileName: string): Promise<void> {
  const dir = join(env.workspace, '.pi', 'extensions')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, fileName),
    `export default function (pi) {
  pi.registerTool({
    name: 'legacy-other',
    description: 'conflicting other tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'conflict' }] }),
  })
}
`,
    'utf8',
  )
}

function fakeRunner(): SubagentTaskRunner {
  return {
    createTask: () => {
      throw new Error('装配测试不应创建子任务')
    },
    runTask: async () => {
      throw new Error('装配测试不应执行子任务')
    },
  }
}

async function createAssembly(
  diagnostics: string[],
  safeDiagnostics: Set<string>,
  mcpOAuth?: ProjectAssemblyDeps['mcpOAuth'],
): Promise<{
  assembly: ProjectAssembly
  modelRuntime: Awaited<ReturnType<typeof createSharedModelRuntime>>
}> {
  const modelRuntime = await createSharedModelRuntime(env.agentDir)
  await modelRuntime.refresh({ allowNetwork: false })
  const assembly = new ProjectAssembly({
    agentDir: env.agentDir,
    workspacePath: env.workspace,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    modelRuntime,
    // 默认假 OAuth 不用于无 MCP 的装配测试；需要验证未启动时注入计数 fake。
    mcpOAuth: mcpOAuth ?? ({} as ProjectAssemblyDeps['mcpOAuth']),
    mcpLog: { write: async () => {} },
    interactions: createHostInteractions(),
    trustStore: new ProjectTrustStore(env.agentDir),
    diagnose: (message) => diagnostics.push(message),
    addSafeDiagnostic: (code) => safeDiagnostics.add(code),
    refreshCatalog: async () => {},
    refreshCatalogOnStart: false,
    listScopeInfos: async () => [],
    workspaceSnapshotOf: () => null,
    subagents: fakeRunner(),
  })
  assemblies.push(assembly)
  return { assembly, modelRuntime }
}

describe('子agent 项目装配', () => {
  it('外部 subagent 工具被替代，其他工具/事件与来源诊断保留，子会话拒绝嵌套', async () => {
    await writeLegacySubagentExtension('10-legacy-subagent.js')
    await writeConflictingExtension('20-legacy-conflict.js')
    await writeFile(join(env.workspace, '.pi', 'APPEND_SYSTEM.md'), '项目追加\n', 'utf8')

    const diagnostics: string[] = []
    const safeDiagnostics = new Set<string>()
    const { assembly } = await createAssembly(diagnostics, safeDiagnostics)

    const main = await assembly.prepare(env.workspace, true, false)
    const mainExtensions = main.trust.resourceLoader.getExtensions()
    const legacy = mainExtensions.extensions.find((extension) =>
      extension.path.endsWith('10-legacy-subagent.js'),
    )
    expect(legacy).toBeDefined()
    // 只摘除同名子agent工具；扩展本身、其他工具和事件处理器仍保留。
    expect([...(legacy?.tools.keys() ?? [])]).toEqual(['legacy-other'])
    expect(legacy?.handlers.has('session_start')).toBe(true)
    const builtin = mainExtensions.extensions.find(
      (extension) => extension.path === 'builtin:subagent',
    )
    expect(builtin?.tools.has('subagent')).toBe(true)

    // 本次替代产生的 subagent 冲突被过滤；其他工具的原始冲突仍保留。
    expect(
      mainExtensions.errors.some((error) =>
        error.error.startsWith('Tool "subagent" conflicts with '),
      ),
    ).toBe(false)
    expect(
      mainExtensions.errors.some((error) => error.error.includes('Tool "legacy-other" conflicts')),
    ).toBe(true)
    expect(
      diagnostics.some(
        (message) => message.includes('10-legacy-subagent.js') && message.includes('外部 subagent'),
      ),
    ).toBe(true)
    expect(safeDiagnostics.has('assembly-warning')).toBe(true)

    const child = await assembly.prepare(env.workspace, true, false, {
      subagent: true,
      appendSystemPrompt: ['AGENT BODY'],
    })
    // 追加定义正文时保留项目 APPEND_SYSTEM.md，不替换既有追加提示。
    expect(child.trust.resourceLoader.getAppendSystemPrompt()).toEqual(['项目追加\n', 'AGENT BODY'])
    const childBuiltin = child.trust.resourceLoader
      .getExtensions()
      .extensions.find((extension) => extension.path === 'builtin:subagent')
    const definition = childBuiltin?.tools.get('subagent')?.definition
    expect(definition).toBeDefined()
    await expect(
      definition?.execute(
        'child-call',
        { agent: 'legacy', task: 'nested' } as never,
        undefined,
        undefined,
        { cwd: env.workspace } as ExtensionToolContext,
      ),
    ).rejects.toThrow(/禁止嵌套/)
  })

  it('子会话 MCP override 在真实 session_start 生效且不写回磁盘', async () => {
    // 文件条目本身启用且暴露 direct；override 只应影响本次内存装配。
    const configText = `${JSON.stringify(
      {
        mcpServers: {
          demo: {
            command: 'huan-test-missing-mcp-command',
            args: ['--never-run'],
            enabled: true,
            exposure: 'direct',
          },
        },
      },
      null,
      2,
    )}\n`
    const configPath = join(env.agentDir, 'mcp.json')
    await writeFile(configPath, configText, 'utf8')

    const diagnostics: string[] = []
    const safeDiagnostics = new Set<string>()
    let oauthCalls = 0
    const { assembly, modelRuntime } = await createAssembly(diagnostics, safeDiagnostics, {
      createAuthProvider: () => {
        oauthCalls += 1
        throw new Error('禁用的 stdio 服务器不应创建 OAuth provider')
      },
    })

    const prepared = await assembly.prepare(env.workspace, true, false, {
      mcpOverrides: {
        demo: {
          enabled: false,
          exposure: 'hidden',
          toolExposure: { read: 'hidden' },
        },
      },
    })

    // 复用 prepare 产出的真实 loader/settings，而不是另建不含 MCP 工厂的装配。
    const sessionManager = SessionManager.inMemory(env.workspace)
    const services = {
      cwd: env.workspace,
      agentDir: env.agentDir,
      modelRuntime,
      settingsManager: prepared.trust.settingsManager,
      resourceLoader: prepared.trust.resourceLoader,
      diagnostics: [],
    }
    let session: AgentSession | undefined
    try {
      const created = await createAgentSessionFromServices({ services, sessionManager })
      session = created.session
      // 与宿主一致：建立扩展绑定后才触发 session_start，MCP 配置此时加载。
      await session.bindExtensions({})

      const manager = prepared.mcp.getManager()
      expect(manager).toBeDefined()
      if (!manager) throw new Error('MCP manager 未启动')
      // session_start 只发起后台 start；等待落定后再判断是否有进程尝试。
      await manager.start()

      const entry = manager.getServerEntry('demo')
      expect(entry.scope).toBe('user')
      expect(entry.config).toMatchObject({
        command: 'huan-test-missing-mcp-command',
        args: ['--never-run'],
        enabled: false,
        exposure: 'hidden',
        toolExposure: { read: 'hidden' },
      })

      const server = manager.snapshot().servers.find((candidate) => candidate.name === 'demo')
      // disabled 槽位在 start 中直接落定，不解析/执行不存在的 command。
      expect(manager.snapshot().started).toBe(true)
      expect(server).toMatchObject({ enabled: false, exposure: 'hidden', state: 'disabled' })
      expect(server?.error).toBeUndefined()
      expect(oauthCalls).toBe(0)
      // 原文逐字节不变：override 仅在内存合并，不写回 mcp.json。
      expect(await readFile(configPath, 'utf8')).toBe(configText)
    } finally {
      if (session) {
        const extensions = prepared.trust.resourceLoader.getExtensions()
        const runner = new ExtensionRunner(
          extensions.extensions,
          extensions.runtime,
          env.workspace,
          sessionManager,
          new ModelRegistry(modelRuntime),
        )
        try {
          await runner.emit({ type: 'session_shutdown', reason: 'quit' })
        } finally {
          session.dispose()
        }
      }
      await assembly.closeBinding(prepared.mcp)
    }
  })
})
