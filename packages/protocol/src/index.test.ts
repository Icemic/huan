import { describe, expect, it } from 'vitest'
import { HARNESS_PROTOCOL_VERSION } from './index'

describe('protocol 版本常量', () => {
  it('为不小于 1 的正整数，当前为 17', () => {
    expect(Number.isInteger(HARNESS_PROTOCOL_VERSION)).toBe(true)
    expect(HARNESS_PROTOCOL_VERSION).toBe(19)
  })
})
