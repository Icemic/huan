/**
 * vendor/anti-corruption 的单元测试。
 *
 * 覆盖上游工具的边界行为：`parseDataUrl` / `dataUrlMediaType`
 * （媒体类型决议）、`detectImageMediaType`（字节嗅探）、`bytesToBase64`
 * 与用户回调隔离。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  bytesToBase64,
  dataUrlMediaType,
  detectImageMediaType,
  invokeUserCallback,
  isParsableUrl,
  isRecord,
  parseDataUrl,
  resolveImageMediaType,
} from './anti-corruption.js'

describe('isRecord', () => {
  it('接受普通对象，拒绝 null / 数组 / 原始值', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(1)).toBe(false)
  })
})

describe('invokeUserCallback', () => {
  it('无回调时是 no-op', () => {
    expect(invokeUserCallback('t', 'n', undefined)).toBeUndefined()
  })

  it('同步抛错被吞掉并记录', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      invokeUserCallback('t', 'n', () => {
        throw new Error('boom')
      }),
    ).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('返回的 promise 拒绝被吞掉', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = invokeUserCallback('t', 'n', () => Promise.reject(new Error('async')))
    await expect(result).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('透传参数', () => {
    const spy = vi.fn()
    invokeUserCallback('t', 'n', spy, 1, 'two')
    expect(spy).toHaveBeenCalledWith(1, 'two')
  })
})

describe('parseDataUrl', () => {
  it('解析 base64 data URL 并小写化 media type', () => {
    expect(parseDataUrl('data:image/PNG;base64,AAAA')).toEqual({
      mimeType: 'image/png',
      data: 'AAAA',
    })
  })

  it('省略类型时用 fallback', () => {
    expect(parseDataUrl('data:;base64,AAAA')).toEqual({
      mimeType: 'application/octet-stream',
      data: 'AAAA',
    })
    expect(parseDataUrl('data:;base64,AAAA', 'text/plain')).toEqual({
      mimeType: 'text/plain',
      data: 'AAAA',
    })
  })

  it('忽略带参数的类型', () => {
    expect(parseDataUrl('data:image/png;charset=utf-8;base64,AAAA')?.mimeType).toBe('image/png')
  })

  it('非 base64 或非 data URL 返回 null', () => {
    expect(parseDataUrl('data:text/plain,hello')).toBeNull()
    expect(parseDataUrl('https://example.com/a.png')).toBeNull()
    expect(parseDataUrl('')).toBeNull()
  })
})

describe('dataUrlMediaType', () => {
  it('接受非 base64 data URL', () => {
    expect(dataUrlMediaType('data:text/plain,hello')).toBe('text/plain')
  })

  it('base64 省略类型时为 application/octet-stream', () => {
    expect(dataUrlMediaType('data:;base64,AAAA')).toBe('application/octet-stream')
  })

  it('非 base64 省略类型时为 text/plain', () => {
    expect(dataUrlMediaType('data:,hello')).toBe('text/plain')
  })

  it('无 data URL 头或缺少逗号时返回 undefined', () => {
    expect(dataUrlMediaType('not-a-url')).toBeUndefined()
    expect(dataUrlMediaType('data:image/png;base64')).toBeUndefined()
  })
})

describe('isParsableUrl', () => {
  it('区分 url 与裸 base64', () => {
    expect(isParsableUrl('https://example.com')).toBe(true)
    expect(isParsableUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isParsableUrl('AAAA')).toBe(false)
  })
})

describe('detectImageMediaType', () => {
  // 各格式的真实前导字节的 base64 前缀
  it.each([
    ['image/gif', 'R0lGODlh'],
    ['image/png', 'iVBORw0KGgo'],
    ['image/jpeg', '/9j/4AAQ'],
    ['image/bmp', 'Qk1AAAAA'],
    ['image/avif', 'AAAAIGZ0eXBhdmlm'],
    ['image/heic', 'AAAAGGZ0eXBoZWlj'],
  ])('嗅探 %s', (expected, base64) => {
    expect(detectImageMediaType(base64)).toBe(expected)
  })

  it('未知签名返回 undefined', () => {
    expect(detectImageMediaType('AAAAAAAA')).toBeUndefined()
  })

  it('非 base64 输入不抛错', () => {
    expect(() => detectImageMediaType('!!!not-base64!!!')).not.toThrow()
    expect(detectImageMediaType('')).toBeUndefined()
  })
})

describe('resolveImageMediaType', () => {
  it('优先使用图片 contentType', () => {
    expect(resolveImageMediaType('AAAA', 'image/webp')).toBe('image/webp')
  })

  it('忽略通配 contentType，回落到 data URL 声明', () => {
    expect(resolveImageMediaType('data:image/jpeg;base64,/9j/4AAQ', 'image/*')).toBe('image/jpeg')
  })

  it('回落到位图嗅探', () => {
    expect(resolveImageMediaType('iVBORw0KGgo')).toBe('image/png')
  })

  it('最终兜底 image/png', () => {
    expect(resolveImageMediaType('AAAA')).toBe('image/png')
  })

  it('url 载荷不参与嗅探', () => {
    expect(resolveImageMediaType('https://example.com/a.png')).toBe('image/png')
  })
})

describe('bytesToBase64', () => {
  it('编码字节', () => {
    expect(bytesToBase64(new Uint8Array([71, 73, 70]))).toBe('R0lG')
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
  })

  it('大输入分块编码（跨 chunkSize 边界）', () => {
    const bytes = new Uint8Array(70000).fill(65)
    // 70000 字节超过 32768 的分块阈值，覆盖多轮 subarray 拼接
    const encoded = bytesToBase64(bytes)
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
    expect(encoded.length).toBe(93336)
  })

  it('无 Buffer 环境走 btoa 分块分支', () => {
    const bytes = new Uint8Array(70000).fill(65)
    // 先在 Buffer 可用时算好期望值，再屏蔽它以强制走浏览器路径
    const expected = bytesToBase64(bytes)
    const original = (globalThis as { Buffer?: unknown }).Buffer
    try {
      ;(globalThis as { Buffer?: unknown }).Buffer = undefined
      expect(bytesToBase64(bytes)).toBe(expected)
    } finally {
      ;(globalThis as { Buffer?: unknown }).Buffer = original
    }
  })
})
