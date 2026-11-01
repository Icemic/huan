/**
 * G1.4c 认证 broker 单元测试。
 *
 * 只使用合成 provider、临时目录与受控运行时；不读取个人凭据、不访问真实
 * provider。重点覆盖：秘密回填不进入快照/日志、提示竞态、取消与持久化
 * 提交竞态、同 provider 互斥、多窗口回填、dispose 晚结果与 URL 白名单。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CreateModelRuntimeOptions,
  CredentialSynchronizationError,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent'
import type { HarnessProviderAuthSnapshot } from '@huan/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProviderAuthBroker,
  type ProviderAuthBroker,
  type ProviderAuthRuntime,
} from './provider-auth.js'

type Provider = ReturnType<ProviderAuthRuntime['getProviders']>[number]
type ProviderAuth = Provider['auth']
type Credential = Awaited<ReturnType<ProviderAuthRuntime['login']>>
type ApiKeyCredential = Extract<Credential, { type: 'api_key' }>
type AuthInteraction = Parameters<ProviderAuthRuntime['login']>[2]
type ApiKeyLogin = NonNullable<NonNullable<ProviderAuth['apiKey']>['login']>
type OAuthLogin = NonNullable<NonNullable<ProviderAuth['oauth']>['login']>

afterEach(() => {
  // 日志 spy 失败时也要恢复，避免影响后续用例。
  vi.restoreAllMocks()
})

const SECRET = 'sk-synthetic-secret-value-do-not-leak'

const apiKeyProvider = (id: string, login: ApiKeyLogin): Provider => {
  const auth: ProviderAuth = {
    apiKey: {
      name: '测试 API key',
      login,
      resolve: async ({ credential }) =>
        credential?.key ? { auth: { apiKey: credential.key }, source: 'test' } : undefined,
    },
  }
  return {
    id,
    name: `${id} 名称`,
    auth,
    getModels: () => [],
  } as unknown as Provider
}

const oauthProvider = (id: string, login: OAuthLogin): Provider => {
  const auth: ProviderAuth = {
    oauth: {
      name: '测试 OAuth',
      login,
      refresh: async (credential) => credential,
      toAuth: async () => ({ apiKey: 'oauth-access' }),
    },
  }
  return {
    id,
    name: `${id} OAuth`,
    auth,
    getModels: () => [],
  } as unknown as Provider
}

type FakeRuntimeOptions = {
  providers: Provider[]
  login?: ProviderAuthRuntime['login']
  logout?: ProviderAuthRuntime['logout']
  statuses?: Map<string, ReturnType<ProviderAuthRuntime['getProviderAuthStatus']>>
  credentials?: Map<string, Credential>
}

function createFakeRuntime(options: FakeRuntimeOptions) {
  const credentials = options.credentials ?? new Map<string, Credential>()
  const statuses = options.statuses ?? new Map()
  const login: ProviderAuthRuntime['login'] =
    options.login ??
    (async (providerId, type, interaction) => {
      const provider = options.providers.find((item) => item.id === providerId)
      const method = type === 'oauth' ? provider?.auth.oauth : provider?.auth.apiKey
      if (!method?.login) throw new Error('login unsupported')
      const credential = await (method.login as (input: AuthInteraction) => Promise<Credential>)(
        interaction,
      )
      credentials.set(providerId, credential)
      return credential
    })
  const logout: ProviderAuthRuntime['logout'] =
    options.logout ??
    (async (providerId) => {
      credentials.delete(providerId)
    })
  const runtime: ProviderAuthRuntime = {
    getProviders: () => options.providers,
    listCredentials: async () =>
      [...credentials.entries()].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    getProviderAuthStatus: (providerId) => {
      const status = statuses.get(providerId)
      if (status) return status
      return credentials.has(providerId)
        ? { configured: true, source: 'stored' }
        : { configured: false }
    },
    login,
    logout,
  }
  return { runtime, credentials, statuses }
}

const waitFor = async <T>(
  read: () => T | undefined,
  message: string,
  timeoutMs = 1_500,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${message}`)
}

const operationOf = (snapshot: HarnessProviderAuthSnapshot, id?: string) =>
  id ? snapshot.operations.find((operation) => operation.id === id) : snapshot.operations[0]

const lastSnapshot = (broker: ProviderAuthBroker): HarnessProviderAuthSnapshot => broker.snapshot()

describe('认证 broker：回填与秘密边界', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  it('secret 提示回填后立即清除，重复回填 stale，且不进入快照/日志', async () => {
    const logs: string[] = []
    const spy = (level: 'log' | 'info' | 'warn' | 'error') =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
    const spies = [spy('log'), spy('info'), spy('warn'), spy('error')]
    const secret = SECRET
    const { runtime, credentials } = createFakeRuntime({
      providers: [
        apiKeyProvider('fake-provider', async (interaction) => {
          interaction.notify({ type: 'progress', message: '正在验证合成密钥' })
          const key = await interaction.prompt({
            type: 'secret',
            message: '输入合成 API key',
            placeholder: 'sk-...',
          })
          return { type: 'api_key', key }
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    const start = await broker.startLogin('fake-provider', 'api_key')
    expect(start.status).toBe('started')
    const prompt = await waitFor(() => operationOf(lastSnapshot(broker))?.prompt, 'secret 提示出现')
    expect(prompt.kind).toBe('secret')
    expect(JSON.stringify(lastSnapshot(broker))).not.toContain(secret)

    const operationId = operationOf(lastSnapshot(broker))?.id ?? ''
    expect(broker.respond({ operationId, promptId: prompt.promptId, value: secret })).toEqual({
      status: 'accepted',
    })
    // 提交后快照不再含提示，也不含值。
    expect(JSON.stringify(lastSnapshot(broker))).not.toContain(secret)
    expect(operationOf(lastSnapshot(broker))?.prompt).toBeUndefined()
    // 第二个窗口持旧 promptId 回填：拒绝且不改变状态。
    expect(
      broker.respond({ operationId, promptId: prompt.promptId, value: 'second-window-value' }),
    ).toEqual({ status: 'stale' })

    const done = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'succeeded' ? operation : undefined
    }, '登录成功')
    expect(done.result?.status).toBe('succeeded')
    expect(credentials.get('fake-provider')?.type).toBe('api_key')
    expect(JSON.stringify(lastSnapshot(broker))).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(secret)
    for (const items of spies) items.mockRestore()
  })

  it('select 选项只在目录内有效，非法值不进入 resolver', async () => {
    const { runtime } = createFakeRuntime({
      providers: [
        oauthProvider('oauth-provider', async (interaction) => {
          const mode = await interaction.prompt({
            type: 'select',
            message: '选择授权方式',
            options: [
              { id: 'url', label: '网页授权' },
              { id: 'device', label: '设备码' },
            ],
          })
          return {
            type: 'oauth',
            refresh: 'refresh',
            access: mode,
            expires: Date.now() + 3_600_000,
          }
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('oauth-provider', 'oauth')
    const prompt = await waitFor(() => operationOf(lastSnapshot(broker))?.prompt, 'select 提示出现')
    const operationId = operationOf(lastSnapshot(broker))?.id ?? ''
    expect(
      broker.respond({ operationId, promptId: prompt.promptId, value: 'javascript:alert(1)' }),
    ).toEqual({ status: 'invalid', message: '所选选项无效。' })
    expect(operationOf(lastSnapshot(broker))?.phase).toBe('prompt')
    expect(broker.respond({ operationId, promptId: prompt.promptId, value: 'url' })).toEqual({
      status: 'accepted',
    })
  })

  it('prompt.signal 先完成时提示立即失效，登录仍按成功结算', async () => {
    let promptRejected = false
    const { runtime } = createFakeRuntime({
      providers: [
        oauthProvider('callback-provider', async (interaction) => {
          const promptController = new AbortController()
          void interaction
            .prompt({
              type: 'manual_code',
              message: '输入授权码',
              signal: promptController.signal,
            })
            .catch(() => {
              promptRejected = true
            })
          interaction.notify({
            type: 'auth_url',
            url: 'https://example.invalid/oauth',
            instructions: '测试授权页',
          })
          setTimeout(() => promptController.abort(), 10)
          return {
            type: 'oauth',
            refresh: 'refresh',
            access: 'access',
            expires: Date.now() + 3_600_000,
          }
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('callback-provider', 'oauth')
    const prompt = await waitFor(
      () => operationOf(lastSnapshot(broker))?.prompt,
      'manual_code 提示出现',
    )
    const operationId = operationOf(lastSnapshot(broker))?.id ?? ''
    const done = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'succeeded' ? operation : undefined
    }, '回调抢先成功后仍成功')
    expect(promptRejected).toBe(true)
    expect(done.prompt).toBeUndefined()
    expect(broker.respond({ operationId, promptId: prompt.promptId, value: 'late-code' })).toEqual({
      status: 'stale',
    })
  })

  it('授权 URL 只保留 http(s)，非法链接不进入快照', async () => {
    const { runtime } = createFakeRuntime({
      providers: [
        oauthProvider('url-provider', async (interaction) => {
          interaction.notify({ type: 'auth_url', url: 'javascript:alert(1)' })
          interaction.notify({
            type: 'info',
            message: '带链接',
            links: [
              { url: 'file:///private/secret', label: 'bad' },
              { url: 'https://example.invalid/ok', label: 'ok' },
            ],
          })
          interaction.notify({
            type: 'device_code',
            userCode: 'CODE-123',
            verificationUri: 'http://example.invalid/device',
          })
          await interaction.prompt({ type: 'text', message: '等待' })
          return {
            type: 'oauth',
            refresh: 'refresh',
            access: 'access',
            expires: Date.now() + 3_600_000,
          }
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('url-provider', 'oauth')
    const operation = await waitFor(() => {
      const current = operationOf(lastSnapshot(broker))
      return current && current.events.length >= 2 ? current : undefined
    }, '安全事件出现')
    expect(operation.events).toEqual([
      {
        eventId: expect.any(String),
        type: 'info',
        message: '带链接',
        links: [{ url: 'https://example.invalid/ok', label: 'ok' }],
      },
      {
        eventId: expect.any(String),
        type: 'device_code',
        userCode: 'CODE-123',
        verificationUri: 'http://example.invalid/device',
      },
    ])
    expect(JSON.stringify(operation)).not.toContain('javascript:')
    expect(JSON.stringify(operation)).not.toContain('file://')
  })
})

describe('认证 broker：取消、竞态与互斥', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  it('取消前未提交时按 cancelled 结算，凭据不写入', async () => {
    const { runtime, credentials } = createFakeRuntime({
      providers: [
        apiKeyProvider(
          'cancel-provider',
          (interaction) =>
            new Promise((_resolve, reject) => {
              interaction.signal?.addEventListener('abort', () => {
                const error = new Error('aborted')
                error.name = 'AbortError'
                reject(error)
              })
            }),
        ),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('cancel-provider', 'api_key')
    const operationId = operationOf(lastSnapshot(broker))?.id ?? ''
    const cancelled = broker.cancel(operationId)
    expect(cancelled.status).toBe('cancelling')
    const done = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'cancelled' ? operation : undefined
    }, '取消结算')
    expect(done.result?.status).toBe('cancelled')
    expect(credentials.has('cancel-provider')).toBe(false)
    expect(broker.cancel(operationId).status).toBe('finished')
  })

  it('取消与成功竞态：凭据已提交时保留 succeeded，不误标取消丢失', async () => {
    const { runtime, credentials } = createFakeRuntime({
      providers: [
        apiKeyProvider('race-provider', async () => {
          // 模拟 provider 不响应 signal，但稍后返回已提交的凭据。
          await new Promise((resolve) => setTimeout(resolve, 25))
          return { type: 'api_key', key: 'race-key' }
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 200 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('race-provider', 'api_key')
    const operationId = operationOf(lastSnapshot(broker))?.id ?? ''
    broker.cancel(operationId)
    const done = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'succeeded' ? operation : undefined
    }, '取消竞态仍成功')
    expect(done.result?.message).toContain('取消请求到达前认证已完成')
    expect(credentials.has('race-provider')).toBe(true)
  })

  it('取消宽限期后标记未确认，晚到成功升级为 succeeded', async () => {
    const { runtime } = createFakeRuntime({
      providers: [
        apiKeyProvider('late-provider', async () => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          return { type: 'api_key', key: 'late-key' }
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 20 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('late-provider', 'api_key')
    const operationId = operationOf(lastSnapshot(broker))?.id ?? ''
    broker.cancel(operationId)
    const cancelled = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'cancelled' ? operation : undefined
    }, '宽限期后取消')
    expect(cancelled.result?.credentialUncertain).toBe(true)
    expect((await broker.startLogin('late-provider', 'api_key')).status).toBe('busy')
    expect((await broker.logout('late-provider')).status).toBe('busy')
    const upgraded = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'succeeded' ? operation : undefined
    }, '晚到成功升级')
    expect(upgraded.result?.status).toBe('succeeded')
  })

  it('CredentialSynchronizationError 明确为同步失败，原始错误与秘密不外泄', async () => {
    const { runtime } = createFakeRuntime({
      providers: [apiKeyProvider('sync-provider', async () => ({ type: 'api_key', key: SECRET }))],
      login: async () => {
        throw new CredentialSynchronizationError(
          'sync-provider',
          'login',
          { type: 'api_key', key: SECRET },
          { cause: new Error(`存储失败：${SECRET}`) },
        )
      },
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    await broker.startLogin('sync-provider', 'api_key')
    const done = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'failed' ? operation : undefined
    }, '同步失败结算')
    expect(done.result?.code).toBe('sync-failed')
    expect(done.result?.message).toContain('凭据可能已保存')
    expect(done.result?.credentialUncertain).toBe(true)
    expect(JSON.stringify(lastSnapshot(broker))).not.toContain(SECRET)
  })

  it('退出时本地状态同步失败明确提示凭据可能已移除，不伪装成功', async () => {
    const credentials = new Map<string, Credential>([
      ['logout-sync', { type: 'api_key', key: 'stored-key' }],
    ])
    const { runtime } = createFakeRuntime({
      providers: [apiKeyProvider('logout-sync', async () => ({ type: 'api_key', key: 'x' }))],
      credentials,
      logout: async () => {
        throw new CredentialSynchronizationError('logout-sync', 'logout', undefined, {
          cause: new Error('同步失败'),
        })
      },
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    expect((await broker.logout('logout-sync')).status).toBe('started')
    const done = await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'failed' ? operation : undefined
    }, '退出同步失败结算')
    expect(done.result?.code).toBe('sync-failed')
    expect(done.result?.message).toContain('凭据可能已移除')
  })

  it('同 provider 登录/退出互斥，不同 provider 可并行', async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { runtime } = createFakeRuntime({
      providers: [
        apiKeyProvider('a-provider', async () => {
          await first
          return { type: 'api_key', key: 'a-key' }
        }),
        apiKeyProvider('b-provider', async () => ({ type: 'api_key', key: 'b-key' })),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    expect((await broker.startLogin('a-provider', 'api_key')).status).toBe('started')
    const second = await broker.startLogin('a-provider', 'api_key')
    expect(second.status).toBe('busy')
    const logout = await broker.logout('a-provider')
    expect(logout.status).toBe('busy')
    expect((await broker.startLogin('b-provider', 'api_key')).status).toBe('started')
    releaseFirst?.()
    await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker), undefined)
      return operation &&
        lastSnapshot(broker).operations.every((item) => item.phase === 'succeeded')
        ? true
        : undefined
    }, '两个 provider 并行完成')
  })

  it('退出登录移除已存凭据；ambient-only 与运行时来源明确拒绝', async () => {
    const credentials = new Map<string, Credential>([
      ['stored-provider', { type: 'api_key', key: 'stored-key' }],
    ])
    const statuses = new Map<string, ReturnType<ProviderAuthRuntime['getProviderAuthStatus']>>([
      ['ambient-provider', { configured: true, source: 'environment', label: SECRET }],
      ['runtime-provider', { configured: true, source: 'runtime' }],
    ])
    const { runtime } = createFakeRuntime({
      providers: [
        apiKeyProvider('stored-provider', async () => ({ type: 'api_key', key: 'x' })),
        apiKeyProvider('ambient-provider', async () => ({ type: 'api_key', key: 'x' })),
        apiKeyProvider('runtime-provider', async () => ({ type: 'api_key', key: 'x' })),
      ],
      statuses,
      credentials,
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100 })
    cleanups.push(() => broker.dispose())
    await broker.refresh()
    const snapshot = lastSnapshot(broker)
    expect(JSON.stringify(snapshot)).not.toContain(SECRET)
    expect(snapshot.providers.find((item) => item.providerId === 'ambient-provider')).toMatchObject(
      {
        configured: true,
        source: 'environment',
      },
    )

    const ambient = await broker.logout('ambient-provider')
    expect(ambient.status).toBe('invalid')
    const runtimeOnly = await broker.logout('runtime-provider')
    expect(runtimeOnly.status).toBe('invalid')

    expect((await broker.logout('stored-provider')).status).toBe('started')
    await waitFor(() => {
      const operation = operationOf(lastSnapshot(broker))
      return operation?.phase === 'succeeded' ? operation : undefined
    }, '退出成功')
    expect(credentials.has('stored-provider')).toBe(false)
    expect(lastSnapshot(broker).authRevision).toBeGreaterThan(0)
  })

  it('dispose 中止并排空；晚结果不再广播，提示被拒绝', async () => {
    let resolveLogin: ((credential: ApiKeyCredential) => void) | undefined
    let promptRejected = false
    const { runtime } = createFakeRuntime({
      providers: [
        apiKeyProvider('dispose-provider', (interaction) => {
          void interaction.prompt({ type: 'secret', message: '输入密钥' }).catch(() => {
            promptRejected = true
          })
          return new Promise<ApiKeyCredential>((resolve) => {
            resolveLogin = resolve
          })
        }),
      ],
    })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 100, disposeDrainMs: 20 })
    await broker.refresh()
    const events: HarnessProviderAuthSnapshot[] = []
    broker.subscribe((event) => events.push(event.snapshot))
    await broker.startLogin('dispose-provider', 'api_key')
    await waitFor(() => operationOf(lastSnapshot(broker))?.prompt, 'dispose 前提示出现')
    await broker.dispose()
    await waitFor(() => (promptRejected ? true : undefined), 'dispose 拒绝提示')
    const count = events.length
    resolveLogin?.({ type: 'api_key', key: 'late-secret' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.length).toBe(count)
    expect(lastSnapshot(broker).operations).toEqual([])
  })
})

describe('认证 broker：真实 ModelRuntime 持久化与重启', () => {
  const cleanupDirs: string[] = []
  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const nativeProvider = (
    id: string,
    auth: ProviderAuth,
  ): Parameters<ModelRuntime['registerNativeProvider']>[0] =>
    ({
      id,
      name: `${id} 合成`,
      auth,
      getModels: () => [],
      stream: () => {
        throw new Error('认证测试 provider 不提供模型请求')
      },
      streamSimple: () => {
        throw new Error('认证测试 provider 不提供模型请求')
      },
    }) as unknown as Parameters<ModelRuntime['registerNativeProvider']>[0]

  const createRuntime = async (
    dir: string,
    provider: Parameters<ModelRuntime['registerNativeProvider']>[0],
    options: Partial<CreateModelRuntimeOptions> = {},
  ): Promise<ModelRuntime> => {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, 'auth.json'),
      modelsPath: join(dir, 'models.json'),
      refreshOnCreate: false,
      allowModelNetwork: false,
      ...options,
    })
    runtime.registerNativeProvider(provider)
    return runtime
  }

  it('API key 登录写入真实 auth.json，重启后仍可用，logout 后移除', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huan-auth-api-'))
    cleanupDirs.push(dir)
    const provider = nativeProvider('native-api', {
      apiKey: {
        name: '合成 API key',
        login: async (interaction) => {
          const key = await interaction.prompt({ type: 'secret', message: '输入合成 key' })
          return { type: 'api_key', key }
        },
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: 'test' } : undefined,
      },
    } as ProviderAuth)
    const runtime = await createRuntime(dir, provider)
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 200 })
    try {
      await broker.refresh()
      expect(
        broker.snapshot().providers.find((item) => item.providerId === 'native-api'),
      ).toMatchObject({ configured: false })
      await broker.startLogin('native-api', 'api_key')
      const prompt = await waitFor(
        () => operationOf(lastSnapshot(broker))?.prompt,
        '真实运行时提示出现',
      )
      broker.respond({
        operationId: operationOf(lastSnapshot(broker))?.id ?? '',
        promptId: prompt.promptId,
        value: 'synthetic-auth-key',
      })
      await waitFor(() => {
        const operation = operationOf(lastSnapshot(broker))
        return operation?.phase === 'succeeded' ? operation : undefined
      }, '真实运行时登录成功')
      expect(runtime.hasConfiguredAuth('native-api')).toBe(true)
      expect(
        (await runtime.listCredentials()).find((item) => item.providerId === 'native-api'),
      ).toEqual({ providerId: 'native-api', type: 'api_key' })
    } finally {
      await broker.dispose()
    }

    // 模拟宿主重启：新的 ModelRuntime 只共享 authPath，重新注册同一 provider。
    const restarted = await createRuntime(dir, provider)
    // 与宿主启动一致：注册后做一次本地目录/可用性刷新。
    await restarted.refresh({ allowNetwork: false })
    expect(
      (await restarted.listCredentials()).find((item) => item.providerId === 'native-api'),
    ).toEqual({ providerId: 'native-api', type: 'api_key' })
    expect(restarted.hasConfiguredAuth('native-api')).toBe(true)
    const auth = await restarted.getAuth('native-api')
    expect(auth?.auth.apiKey).toBe('synthetic-auth-key')

    const broker2 = createProviderAuthBroker({ runtime: restarted, cancelGraceMs: 200 })
    try {
      await broker2.refresh()
      expect(
        lastSnapshot(broker2).providers.find((item) => item.providerId === 'native-api'),
      ).toMatchObject({ configured: true, storedCredentialType: 'api_key' })
      expect((await broker2.logout('native-api')).status).toBe('started')
      await waitFor(() => {
        const operation = operationOf(lastSnapshot(broker2))
        return operation?.phase === 'succeeded' ? operation : undefined
      }, '真实运行时退出成功')
      expect(restarted.hasConfiguredAuth('native-api')).toBe(false)
      expect(
        (await restarted.listCredentials()).some((item) => item.providerId === 'native-api'),
      ).toBe(false)
    } finally {
      await broker2.dispose()
    }
  })

  it('OAuth 选择/手动码登录持久化，重启后凭据类型为 oauth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huan-auth-oauth-'))
    cleanupDirs.push(dir)
    const provider = nativeProvider('native-oauth', {
      oauth: {
        name: '合成 OAuth',
        login: async (interaction) => {
          await interaction.prompt({
            type: 'select',
            message: '选择授权方式',
            options: [
              { id: 'url', label: '网页授权' },
              { id: 'device', label: '设备码' },
            ],
          })
          const code = await interaction.prompt({ type: 'manual_code', message: '输入授权码' })
          if (code !== 'test-code') throw new Error('合成授权码错误')
          return {
            type: 'oauth',
            refresh: 'synthetic-refresh',
            access: 'synthetic-access',
            expires: Date.now() + 3_600_000,
          }
        },
        refresh: async (credential) => credential,
        toAuth: async () => ({ apiKey: 'synthetic-oauth-access' }),
      },
    } as ProviderAuth)
    const runtime = await createRuntime(dir, provider)
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 200 })
    try {
      await broker.refresh()
      await broker.startLogin('native-oauth', 'oauth')
      const select = await waitFor(
        () => operationOf(lastSnapshot(broker))?.prompt,
        'OAuth 选择提示',
      )
      expect(select.kind).toBe('select')
      broker.respond({
        operationId: operationOf(lastSnapshot(broker))?.id ?? '',
        promptId: select.promptId,
        value: 'url',
      })
      const manual = await waitFor(() => {
        const prompt = operationOf(lastSnapshot(broker))?.prompt
        return prompt?.kind === 'manual_code' ? prompt : undefined
      }, 'OAuth 手动码提示')
      broker.respond({
        operationId: operationOf(lastSnapshot(broker))?.id ?? '',
        promptId: manual.promptId,
        value: 'test-code',
      })
      await waitFor(() => {
        const operation = operationOf(lastSnapshot(broker))
        return operation?.phase === 'succeeded' ? operation : undefined
      }, 'OAuth 登录成功')
    } finally {
      await broker.dispose()
    }

    const restarted = await createRuntime(dir, provider)
    expect(
      (await restarted.listCredentials()).find((item) => item.providerId === 'native-oauth'),
    ).toEqual({ providerId: 'native-oauth', type: 'oauth' })
    const auth = await restarted.getAuth('native-oauth')
    expect(auth?.auth.apiKey).toBe('synthetic-oauth-access')
  })

  it('凭据写盘失败时不泄露原始错误与密钥，操作显示 login-failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huan-auth-fail-'))
    cleanupDirs.push(dir)
    type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>
    const failingStore: CredentialStore = {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error(`磁盘写入失败 ${SECRET}`)
      },
      delete: async () => {},
    }
    const provider = nativeProvider('native-fail', {
      apiKey: {
        name: '合成 API key',
        login: async () => ({ type: 'api_key', key: SECRET }),
        resolve: async () => undefined,
      },
    } as ProviderAuth)
    const runtime = await createRuntime(dir, provider, { credentials: failingStore })
    const broker = createProviderAuthBroker({ runtime, cancelGraceMs: 200 })
    try {
      await broker.refresh()
      await broker.startLogin('native-fail', 'api_key')
      const done = await waitFor(() => {
        const operation = operationOf(lastSnapshot(broker))
        return operation?.phase === 'failed' ? operation : undefined
      }, '写盘失败结算')
      expect(done.result?.code).toBe('login-failed')
      expect(JSON.stringify(lastSnapshot(broker))).not.toContain(SECRET)
    } finally {
      await broker.dispose()
    }
  })
})
