// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试需要直接书写 MCP 的 ${NAME} 模板字面量

/**
 * 配置值解析测试（G1.4d2a）。
 *
 * 覆盖 $NAME/${NAME}/$$/$!、缺失环境变量、异步 !command 的 cwd/超时/输出上限/
 * 取消，以及 header/env 批量解析。默认 shell 测试在无可用 shell 时跳过。
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getShellConfig } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import {
  expandMcpHomePath,
  isMcpCommandValue,
  MCP_COMMAND_MAX_OUTPUT_BYTES,
  MCP_COMMAND_TIMEOUT_MS,
  type McpCommandRunner,
  McpValueResolutionError,
  resolveMcpEnvValues,
  resolveMcpHeaders,
  resolveMcpValue,
  runMcpShellCommand,
} from './index.js'

function shellAvailable(): boolean {
  try {
    getShellConfig()
    return true
  } catch {
    return false
  }
}

/** 有界等待文件出现；用于确认命令已启动，避免固定延时或无限等待。 */
async function waitForFile(path: string, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('模板解析', () => {
  it('支持 $NAME、${NAME}、$$ 与 $!', async () => {
    const env = { TOKEN: 'secret-value', HOST: 'example.test' }
    await expect(resolveMcpValue('$TOKEN', 'test', { env })).resolves.toBe('secret-value')
    await expect(resolveMcpValue('${TOKEN}', 'test', { env })).resolves.toBe('secret-value')
    await expect(resolveMcpValue('a-$TOKEN-b', 'test', { env })).resolves.toBe('a-secret-value-b')
    await expect(resolveMcpValue('$$TOKEN', 'test', { env })).resolves.toBe('$TOKEN')
    await expect(resolveMcpValue('$!literal', 'test', { env })).resolves.toBe('!literal')
    await expect(resolveMcpValue('${TOKEN}-${HOST}', 'test', { env })).resolves.toBe(
      'secret-value-example.test',
    )
  })

  it('非法模板保持字面量', async () => {
    await expect(resolveMcpValue('${NOT-VALID}', 'test', { env: {} })).resolves.toBe('${NOT-VALID}')
    await expect(resolveMcpValue('cost: $', 'test', { env: {} })).resolves.toBe('cost: $')
    await expect(resolveMcpValue('cost: $1', 'test', { env: {} })).resolves.toBe('cost: $1')
  })

  it('缺失环境变量返回受控错误，不回显其它值', async () => {
    const secret = 'HUAN-SECRET-ENV'
    try {
      await resolveMcpValue(`prefix-${'$MISSING'}-${secret}`, 'MCP env "MISSING_KEY"', {
        env: {},
      })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(McpValueResolutionError)
      const value = error as McpValueResolutionError
      expect(value.code).toBe('missing-env')
      expect(value.message).toContain('MISSING')
      expect(value.message).not.toContain(secret)
    }
  })

  it('识别整值命令与 ~ 展开', () => {
    expect(isMcpCommandValue('!echo x')).toBe(true)
    expect(isMcpCommandValue('$$!echo')).toBe(false)
    expect(expandMcpHomePath('~')).not.toBe('~')
    expect(expandMcpHomePath('~/x').endsWith('x')).toBe(true)
    expect(expandMcpHomePath('C:\\tmp')).toBe('C:\\tmp')
  })
})

describe('!command', () => {
  it('使用注入执行器，传入 cwd、超时与输出上限', async () => {
    const calls: unknown[] = []
    const runCommand: McpCommandRunner = async (command, options) => {
      calls.push({ command, options })
      return ' resolved '
    }
    await expect(
      resolveMcpValue('!read-token', 'test', {
        cwd: 'D:\\workspace',
        runCommand,
      }),
    ).resolves.toBe('resolved')
    expect(calls).toEqual([
      {
        command: 'read-token',
        options: {
          cwd: 'D:\\workspace',
          timeoutMs: MCP_COMMAND_TIMEOUT_MS,
          maxOutputBytes: MCP_COMMAND_MAX_OUTPUT_BYTES,
        },
      },
    ])
  })

  it('空输出或执行器异常返回 command-failed', async () => {
    await expect(
      resolveMcpValue('!empty', 'test', { runCommand: async () => '   ' }),
    ).rejects.toMatchObject({ code: 'command-failed' })
    await expect(
      resolveMcpValue('!boom', 'test', {
        runCommand: async () => {
          throw new Error('raw secret should not leak')
        },
      }),
    ).rejects.toMatchObject({ code: 'command-failed' })
  })

  it('取消后不再执行或立即结束等待', async () => {
    let called = false
    const controller = new AbortController()
    controller.abort()
    await expect(
      resolveMcpValue('!never', 'test', {
        signal: controller.signal,
        runCommand: async () => {
          called = true
          return 'x'
        },
      }),
    ).rejects.toMatchObject({ code: 'command-cancelled' })
    expect(called).toBe(false)

    const running = new AbortController()
    const pending = resolveMcpValue('!slow', 'test', {
      signal: running.signal,
      runCommand: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('late'), 1_000)
        }),
    })
    setTimeout(() => running.abort(), 20)
    await expect(pending).rejects.toMatchObject({ code: 'command-cancelled' })
  })

  it.skipIf(!shellAvailable())('默认 shell 异步执行并支持取消', async () => {
    const started = Date.now()
    await expect(
      resolveMcpValue('!node -e "process.stdout.write(\'shell-ok\')"', 'test', {
        cwd: process.cwd(),
      }),
    ).resolves.toBe('shell-ok')
    expect(Date.now() - started).toBeLessThan(10_000)

    const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-command-cancel-'))
    const fixture = fileURLToPath(
      new URL('./test-fixtures/command-tree.mjs', import.meta.url),
    ).replaceAll('\\', '/')
    const controller = new AbortController()
    const pending = resolveMcpValue(`!node "${fixture}"`, 'test', {
      cwd: dir,
      signal: controller.signal,
    })
    // 立即接住拒绝，测试清理期间也不会产生未处理拒绝。
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      // 先等启动标记确认命令已运行，再执行取消，不用固定延时猜测启动完成。
      // 取消耗时包含 Windows taskkill 回收进程树，不设固定上限；回收由下一用例断言。
      await waitForFile(join(dir, 'command-pids.json'), 5000, '默认 shell 命令未启动')
      controller.abort()
      expect(await outcome).toMatchObject({ code: 'command-cancelled' })
    } finally {
      controller.abort()
      await outcome
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!shellAvailable())('取消默认 shell 后已等待子孙进程回收', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huan-mcp-command-tree-'))
    const fixture = fileURLToPath(
      new URL('./test-fixtures/command-tree.mjs', import.meta.url),
    ).replaceAll('\\', '/')
    const controller = new AbortController()
    const pending = resolveMcpValue(`!node "${fixture}"`, 'test', {
      cwd: dir,
      signal: controller.signal,
    })
    // 立即接住拒绝，测试清理期间也不会产生未处理拒绝。
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      const path = join(dir, 'command-pids.json')
      await waitForFile(path, 5000, '进程树未启动')
      const pids = JSON.parse(await readFile(path, 'utf8')) as number[]
      controller.abort()
      expect(await outcome).toMatchObject({ code: 'command-cancelled' })
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    } finally {
      controller.abort()
      await outcome
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!shellAvailable())('默认 shell 超时在回收后返回受控失败', async () => {
    await expect(
      runMcpShellCommand('node -e "setInterval(() => {}, 1000)"', {
        cwd: process.cwd(),
        timeoutMs: 80,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'command-failed' })
  })

  it.skipIf(!shellAvailable())('默认 shell 的输出有界', async () => {
    await expect(
      resolveMcpValue(
        `!node -e "process.stdout.write('x'.repeat(${MCP_COMMAND_MAX_OUTPUT_BYTES + 1024}))"`,
        'test',
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 'command-failed' })
  })
})

describe('批量解析', () => {
  it('解析 header 与 env，保留空字符串，不泄露值', async () => {
    const env = { TOKEN: 'abc' }
    await expect(
      resolveMcpHeaders({ Authorization: 'Bearer $TOKEN', 'X-Empty': '' }, 'MCP server "docs"', {
        env,
      }),
    ).resolves.toEqual({ Authorization: 'Bearer abc', 'X-Empty': '' })
    await expect(resolveMcpHeaders(undefined, 'x', { env })).resolves.toBeUndefined()
    await expect(resolveMcpHeaders({}, 'x', { env })).resolves.toBeUndefined()
    await expect(
      resolveMcpEnvValues({ TOKEN: '${TOKEN}', LITERAL: 'x' }, 'MCP server "docs"', { env }),
    ).resolves.toEqual({ TOKEN: 'abc', LITERAL: 'x' })
  })
})
