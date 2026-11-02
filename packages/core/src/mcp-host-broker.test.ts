/**
 * MCP broker 管理准入单测（G1.4d3）。
 *
 * 真实宿主集成测试覆盖连接与 OAuth；这里用显式 adapter 定序 busy/stale，
 * 避免依赖运行中的模型流。
 */
import {
  type McpConnectionManager,
  type McpOAuthService,
  type McpServerEntry,
  mcpServerIdentity,
} from '@huan/mcp'
import { describe, expect, it } from 'vitest'
import { createMcpHost } from './mcp-host.js'

const entry: McpServerEntry = {
  name: 'demo',
  config: { url: 'https://example.invalid/mcp', exposure: 'direct' },
  source: '/tmp/mcp.json',
  scope: 'user',
}

const manager = {
  getServerEntry: () => structuredClone(entry),
  snapshot: () => ({
    revision: 1,
    started: true,
    closed: false,
    servers: [
      {
        name: 'demo',
        scope: 'user' as const,
        source: '/tmp/mcp.json',
        enabled: true,
        exposure: 'direct' as const,
        state: 'connected' as const,
        toolCount: 1,
        hasResources: false,
        toolRevision: 1,
      },
    ],
  }),
} as unknown as McpConnectionManager

const oauth = {
  createAuthProvider: () => undefined,
  login: async () => undefined,
  logout: async () => true,
  hasCredentials: async () => false,
  close: async () => undefined,
} satisfies McpOAuthService

const target = { kind: 'workspace' as const, workspacePath: '/ws' }
const identity = mcpServerIdentity(entry)

const createBroker = (busy: boolean, oauthImpl: McpOAuthService = oauth) =>
  createMcpHost({
    agentDir: '/tmp/agent',
    oauth: oauthImpl,
    resolveTarget: async () => ({
      target,
      cwd: '/ws',
      trust: { decision: 'trusted', requiresTrust: false, origin: 'trust' },
      record: {},
    }),
    getLive: () => ({
      runtimeId: 'runtime-1',
      manager,
      busy,
      acquireIdle: () => (busy ? undefined : { release: () => {} }),
    }),
  })

describe('MCP broker 管理准入', () => {
  it('运行中拒绝临时管理/登录并返回 busy', async () => {
    const broker = createBroker(true)
    const managed = await broker.manageMcp({
      target,
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: identity,
      action: { type: 'setExposure', exposure: 'hidden' },
    })
    expect(managed.status).toBe('busy')

    const login = await broker.startMcpLogin({
      target,
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: identity,
    })
    expect(login.status).toBe('busy')
    if (login.status === 'busy') expect(login.message).toContain('运行')
    await broker.dispose()
  })

  it('runtimeId 或服务器身份不符返回 stale，不触碰 manager', async () => {
    const broker = createBroker(false)
    const oldRuntime = await broker.manageMcp({
      target,
      expectedRuntimeId: 'old-runtime',
      server: 'demo',
      expectedIdentity: identity,
      action: { type: 'reconnect' },
    })
    expect(oldRuntime.status).toBe('stale')
    const oldIdentity = await broker.manageMcp({
      target,
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: 'mcp:demo:changed',
      action: { type: 'reconnect' },
    })
    expect(oldIdentity.status).toBe('stale')
    await broker.dispose()
  })

  it('退出凭据检查期间另一窗口已启动操作时返回busy', async () => {
    const releases: ((value: boolean) => void)[] = []
    let finish: (() => void) | undefined
    const broker = createBroker(false, {
      ...oauth,
      hasCredentials: () => new Promise((resolve) => releases.push(resolve)),
      logout: () =>
        new Promise((resolve) => {
          finish = () => resolve(true)
        }),
    })
    const input = {
      target,
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: identity,
    }
    const first = broker.logoutMcp(input)
    const second = broker.logoutMcp(input)
    await new Promise((resolve) => setTimeout(resolve, 0))
    releases[0]?.(true)
    expect((await first).status).toBe('started')
    releases[1]?.(true)
    expect((await second).status).toBe('busy')
    finish?.()
    await broker.dispose()
  })

  it('登录成功刷新所有同身份live会话，忙会话不被中断', async () => {
    const records = [{}, {}, {}]
    const reconnected: number[] = []
    const released: number[] = []
    const broker = createMcpHost({
      agentDir: '/tmp/agent',
      oauth,
      resolveTarget: async () => ({
        target,
        cwd: '/ws',
        trust: { decision: 'trusted', requiresTrust: false, origin: 'trust' },
        record: records[0],
      }),
      listLive: () => records,
      getLive: (record) => {
        const index = records.indexOf(record as object)
        return {
          runtimeId: `runtime-${index + 1}`,
          manager: {
            ...manager,
            reconnect: async () => {
              reconnected.push(index)
            },
          } as unknown as McpConnectionManager,
          busy: index === 2,
          acquireIdle: () => ({
            release: () => {
              released.push(index)
            },
          }),
        }
      },
    })
    const started = await broker.startMcpLogin({
      target,
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: identity,
    })
    expect(started.status).toBe('started')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reconnected).toEqual([0, 1])
    expect(released).toEqual([0, 1])
    await broker.dispose()
  })

  it('取消退出不会在真实删除完成后覆盖为 cancelled', async () => {
    let finishLogout: (() => void) | undefined
    const delayedLogout = {
      ...oauth,
      hasCredentials: async () => true,
      logout: () =>
        new Promise<boolean>((resolve) => {
          finishLogout = () => resolve(true)
        }),
    } satisfies McpOAuthService
    const broker = createBroker(false, delayedLogout)
    const started = await broker.logoutMcp({
      target,
      expectedRuntimeId: 'runtime-1',
      server: 'demo',
      expectedIdentity: identity,
    })
    expect(started.status).toBe('started')
    if (started.status !== 'started') throw new Error('退出未启动')
    expect(broker.cancelMcpAuth(started.operation.id).status).toBe('cancelling')
    finishLogout?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const snapshot = await broker.getMcpAuth()
    const operation = snapshot.operations.find((entry) => entry.id === started.operation.id)
    expect(operation?.phase).toBe('succeeded')
    expect(operation?.result?.status).toBe('succeeded')
    await broker.dispose()
  })
})
