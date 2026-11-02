import { describe, expect, it } from 'vitest'
import { toJsonSafe, UNSUPPORTED_EXTENSION_DATA } from './json-safe.js'

describe('扩展 unknown 载荷的 JSON-safe 边界', () => {
  it('BigInt/非有限数字/undefined 按受控规则转换', () => {
    const value: Record<string, unknown> = {
      big: 9007199254740993n,
      nan: Number.NaN,
      infinity: Number.POSITIVE_INFINITY,
      missing: undefined,
      nested: { keep: 1, drop: undefined },
      array: [undefined, 1n, Number.NaN],
    }
    expect(toJsonSafe(value)).toEqual({
      big: '9007199254740993',
      nan: null,
      infinity: null,
      nested: { keep: 1 },
      array: [null, '1', null],
    })
  })

  it('循环引用与无法读取的子载荷使用受控标记', () => {
    const value: Record<string, unknown> = { name: '循环' }
    value.self = value
    const throwing = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        throw new Error('secret detail')
      },
    })
    const converted = toJsonSafe({ value, throwing }) as {
      value: { self: string }
      throwing: { bad: string }
    }
    expect(converted.value.self).toBe(UNSUPPORTED_EXTENSION_DATA)
    expect(converted.throwing.bad).toBe(UNSUPPORTED_EXTENSION_DATA)
    expect(JSON.stringify(converted)).not.toContain('secret detail')
  })

  it('普通共享引用不误判为循环', () => {
    const shared = { ok: true }
    expect(toJsonSafe({ a: shared, b: shared })).toEqual({
      a: { ok: true },
      b: { ok: true },
    })
  })

  it('Date 按 JSON 语义输出，函数/符号省略', () => {
    const value = toJsonSafe({
      date: new Date('2026-01-02T03:04:05.000Z'),
      fn: () => undefined,
      symbol: Symbol('x'),
    })
    expect(value).toEqual({ date: '2026-01-02T03:04:05.000Z' })
  })
})
