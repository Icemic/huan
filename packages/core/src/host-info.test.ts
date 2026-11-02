import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnessHost, type HarnessHost } from './host.js'
import {
  createIsolatedPiEnv,
  type IsolatedPiEnv,
  installTestFetch,
  TEST_API_KEY,
  TEST_MODEL_A,
  TEST_PROVIDER,
  TEST_RESOURCE_ISOLATION,
  TEST_UNAUTH_MODEL,
  TEST_UNAUTH_PROVIDER,
} from './test-support.js'

let env: IsolatedPiEnv
let hosts: HarnessHost[]
let fetchStub: ReturnType<typeof installTestFetch>

beforeEach(async () => {
  for (const key of [
    'PI_PROVIDER',
    'PI_MODEL_ID',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
  ]) {
    vi.stubEnv(key, undefined)
  }
  env = await createIsolatedPiEnv('huan-host-info-')
  hosts = []
  fetchStub = installTestFetch()
})

afterEach(async () => {
  try {
    for (const host of hosts) await host.dispose()
    expect(fetchStub.unexpected()).toEqual([])
  } finally {
    fetchStub.restore()
    await env.cleanup()
    vi.unstubAllEnvs()
  }
})

async function open() {
  const host = await createHarnessHost({
    workspacePath: env.workspace,
    agentDir: env.agentDir,
    refreshCatalogOnStart: false,
    resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
  })
  hosts.push(host)
  return host
}

describe('只读宿主状态与默认模型恢复', () => {
  it('尚无会话也可查询固定空间及配置来源，不返回凭据', async () => {
    const host = await open()
    const info = await host.getHostInfo()
    expect(info).toMatchObject({
      workspacePath: env.workspace,
      agentDir: env.agentDir,
      agentDirSource: 'option',
      sessionStorage: { mode: 'grouped', directory: env.defaultSessionDir(), source: 'default' },
      defaultModel: {
        provider: TEST_PROVIDER,
        modelId: TEST_MODEL_A,
        providerSource: 'settings',
        modelIdSource: 'settings',
        readiness: { state: 'ready' },
      },
    })
    expect(JSON.stringify(info)).not.toContain(TEST_API_KEY)
    expect(await host.listThreads()).toEqual([])
    // 返回值被消费者修改，不影响宿主保存的配置。
    info.defaultModel.provider = 'changed'
    expect((await host.getHostInfo()).defaultModel.provider).toBe(TEST_PROVIDER)
  })

  it('无效默认模型不会阻断启动和冷历史；显式有效模型可创建新会话', async () => {
    const seed = SessionManager.create(env.workspace, env.defaultSessionDir())
    seed.appendModelChange(TEST_PROVIDER, TEST_MODEL_A)
    seed.appendMessage({ role: 'user', content: 'history', timestamp: 1 })
    const id = seed.getSessionId()
    vi.stubEnv('PI_MODEL_ID', 'missing-model')
    const host = await open()
    expect((await host.getHostInfo()).defaultModel).toMatchObject({
      providerSource: 'settings',
      modelIdSource: 'env',
      readiness: { state: 'unavailable-model' },
    })
    expect((await host.getThread(id)).messages).toHaveLength(1)
    await expect(host.createThread()).rejects.toThrow('默认模型不在注册表中')
    expect(await readdir(env.defaultSessionDir())).toHaveLength(1)
    const created = await host.createThread({
      model: { provider: TEST_PROVIDER, modelId: TEST_MODEL_A },
    })
    expect(created.readiness?.state).toBe('ready')
    expect(created.metadata.config?.modelId).toBe(TEST_MODEL_A)
    await expect(
      host.createThread({ model: { provider: 'missing', modelId: 'missing' } }),
    ).rejects.toThrow('not in Pi')
  })

  it('恢复缺失模型时按会话暴露受控回退原因与有效模型', async () => {
    const seed = SessionManager.create(env.workspace, env.defaultSessionDir())
    seed.appendModelChange('missing', 'gone-model')
    seed.appendMessage({ role: 'user', content: 'history', timestamp: 1 })
    const id = seed.getSessionId()
    const host = await open()
    // 打开 live 会话但不发起模型请求。
    await host.listCommands({ threadId: id })
    const snapshot = await host.getThread(id)
    expect(snapshot.metadata.modelFallback).toMatchObject({
      reason: 'restore-failed',
      requested: { provider: 'missing', modelId: 'gone-model' },
      active: { provider: TEST_PROVIDER, modelId: TEST_MODEL_A },
    })
    expect(snapshot.metadata.modelFallback?.message).not.toContain(TEST_API_KEY)
    expect(snapshot.readiness?.state).toBe('ready')
  })

  it('live 且尚未落盘的会话仍在目录中可发现', async () => {
    const host = await open()
    const created = await host.createThread()
    // 新建会话在首条消息前不一定已有 JSONL；目录不能只依赖磁盘 infos。
    expect(existsSync(created.metadata.sessionFile ?? '')).toBe(false)
    const listed = await host.listThreads()
    expect(listed.map((item) => item.id)).toContain(created.metadata.id)
  })

  it('缺凭据可见且运行失败，不调用网络', async () => {
    await writeFile(
      join(env.agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: TEST_UNAUTH_PROVIDER,
        defaultModel: TEST_UNAUTH_MODEL,
      }),
    )
    const host = await open()
    expect((await host.getHostInfo()).defaultModel.readiness.state).toBe('missing-credentials')
    const created = await host.createThread()
    expect(created.readiness?.state).toBe('missing-credentials')
    await expect(
      host.sendMessage(created.metadata.id, { content: 'must not run' }),
    ).rejects.toThrow()
    expect(fetchStub.calls()).toBe(0)
  })

  it('环境目录在创建时固定并注明共享的平铺作用域', async () => {
    const directory = join(env.root, 'shared')
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', directory)
    const host = await open()
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(env.root, 'changed'))
    expect((await host.getHostInfo()).sessionStorage).toEqual({
      mode: 'flat',
      root: directory,
      directory,
      source: 'env',
    })
  })

  it('扩展诊断仅暴露安全代码，不透传任意错误原文', async () => {
    const secret = 'private-token-that-must-not-leak'
    const extensions = join(env.agentDir, 'extensions')
    await mkdir(extensions, { recursive: true })
    await writeFile(
      join(extensions, 'failing.ts'),
      `export default function () { throw new Error('${secret}') }`,
    )
    const host = await open()
    expect(host.diagnostics().some((line) => line.includes(secret))).toBe(true)
    const info = await host.getHostInfo()
    expect(info.diagnostics).toContain('assembly-warning')
    expect(JSON.stringify(info)).not.toContain(secret)
  })
})
