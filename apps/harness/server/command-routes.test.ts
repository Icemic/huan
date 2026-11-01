/**
 * G1.3b 命令/文件路由与类型化提交错误。
 *
 * 生产路由 + 真实 HTTP 客户端；客户端方法用受控 mock，不启动 SDK。
 */

import { ImageInputUnsupportedError, ReservedBuiltinCommandError } from '@huan/core'
import type { HarnessClient } from '@huan/protocol'
import { createHarnessHttpClient, HarnessHttpError } from '@huan/react'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import type { ServerConfig } from './config.js'

const config: ServerConfig = {
  workspacePath: '/workspace',
  agentDir: '/private/agent',
  port: 8788,
  allowedHosts: ['localhost:8788'],
  allowedOrigins: ['http://localhost:8799'],
  token: 'test-token',
}

const headers = {
  host: 'localhost:8788',
  origin: 'http://localhost:8799',
  'x-huan-token': 'test-token',
}

const setup = (overrides: Partial<HarnessClient> = {}) => {
  const client = {
    listCommands: vi.fn(async () => ({
      commands: [
        {
          name: 'plan',
          description: '计划',
          source: 'extension' as const,
          sourceInfo: {
            path: '/tmp/plan.ts',
            source: 'local',
            scope: 'user' as const,
            origin: 'top-level' as const,
          },
          supportsArguments: true,
        },
      ],
      skillCommandsEnabled: true,
      diagnostics: [],
    })),
    getCommandArgumentCompletions: vi.fn(async () => [{ value: 'alpha', label: 'alpha' }]),
    searchFiles: vi.fn(async () => ({
      files: [
        {
          path: '/workspace/src/main.ts',
          reference: '@app/src/main.ts',
          relativePath: 'src/main.ts',
          kind: 'file' as const,
          alias: 'app',
          workspaceName: '测试',
        },
      ],
      truncated: false,
    })),
    sendMessage: vi.fn(async () => ({ disposition: 'started' as const })),
    ...overrides,
  } as unknown as HarnessClient
  const app = createApp(client, config)
  const http = createHarnessHttpClient({
    baseUrl: 'http://localhost:8788/api/pi',
    headers,
    fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
  })
  return { app, client, http }
}

describe('命令目录与文件引用路由', () => {
  it('读取目录、扩展参数补全与文件引用', async () => {
    const { http, client } = setup()
    const catalog = await http.listCommands({ workspacePath: '/workspace' })
    expect(catalog.commands[0]?.name).toBe('plan')
    expect(client.listCommands).toHaveBeenCalledWith({ workspacePath: '/workspace' })

    const completions = await http.getCommandArgumentCompletions({
      workspacePath: '/workspace',
      name: 'plan',
      prefix: 'a',
    })
    expect(completions).toEqual([{ value: 'alpha', label: 'alpha' }])

    const files = await http.searchFiles({
      workspaceId: 'ws_1',
      workspacePath: '/workspace',
      query: 'main',
    })
    expect(files.files[0]?.reference).toBe('@app/src/main.ts')
    expect(client.searchFiles).toHaveBeenCalledWith(
      { workspaceId: 'ws_1', workspacePath: '/workspace', query: 'main' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('缺少会话/目录时拒绝目录查询', async () => {
    const { app } = setup()
    const response = await app.request('/api/pi/commands', { headers })
    expect(response.status).toBe(400)
  })

  it('保留内置命令返回 409，HTTP 客户端保留错误码', async () => {
    const { http } = setup({
      sendMessage: vi.fn(async () => {
        throw new ReservedBuiltinCommandError('model')
      }),
    })
    await expect(http.sendMessage('t1', { content: '/model' })).rejects.toMatchObject({
      name: 'HarnessHttpError',
      status: 409,
      code: 'reserved-builtin-command',
      command: 'model',
    })
  })

  it('图片能力拒绝返回 415 与受控错误码', async () => {
    const { http } = setup({
      sendMessage: vi.fn(async () => {
        throw new ImageInputUnsupportedError('huan-test', 'text-only')
      }),
    })
    const error = await http.sendMessage('t1', { content: '图' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(HarnessHttpError)
    expect(error).toMatchObject({
      status: 415,
      code: 'image-input-unsupported',
    })
  })
})
