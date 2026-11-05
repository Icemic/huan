import { readFile, rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { colorShellContext, executeColoredBash } from './shell.js'

describe('Shell颜色与SDK输出保留', () => {
  it('尊重颜色环境且扩展operations收到默认环境', async () => {
    expect(colorShellContext({ command: '', cwd: '', env: { NO_COLOR: '' } }).env.FORCE_COLOR).toBeUndefined()
    expect(colorShellContext({ command: '', cwd: '', env: { FORCE_COLOR: '0' } }).env.FORCE_COLOR).toBe('0')
    const chunks: string[] = []
    const result = await executeColoredBash('hello', process.cwd(), {
      signal: new AbortController().signal,
      onChunk: (value) => chunks.push(value),
      commandPrefix: 'prefix',
      operations: { async exec(command, _cwd, options) {
        expect(command).toBe('prefix\nhello')
        expect(options.env?.TERM).toBeDefined()
        options.onData(Buffer.from('\u001b[31'))
        options.onData(Buffer.from('mred\u001b[0m'))
        return {exitCode:7}
      } },
    })
    expect(result).toMatchObject({output:'\u001b[31mred\u001b[0m',exitCode:7,cancelled:false})
    expect(chunks.join('')).toBe(result.output)
  })

  it('截断保留尾部，完整输出文件包含原始ANSI', async () => {
    const output = `\u001b[31m${'line\n'.repeat(3_000)}\u001b[0m`
    const result = await executeColoredBash('large', process.cwd(), {
      signal: new AbortController().signal, onChunk: () => {},
      operations:{ async exec(_command,_cwd,options) { options.onData(Buffer.from(output)); return {exitCode:0} } },
    })
    expect(result.truncated).toBe(true)
    expect(result.output).toContain('\u001b[0m')
    expect(result.fullOutputPath).toBeDefined()
    const path = result.fullOutputPath
    if (!path) throw new Error('SDK未保存完整输出')
    try { expect(await readFile(path, 'utf8')).toBe(output) }
    finally { await rm(path, {force:true}) }
  })
})
