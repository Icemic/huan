/**
 * 单连接纯函数测试（G1.4d2a）：请求超时限制在 Node 定时器合法范围内，
 * 避免 Infinity/溢出被 Node 当成 1ms。
 */

import { describe, expect, it } from 'vitest'
import { resolveMcpRequestTimeoutMs } from './index.js'

const MAX_TIMER_MS = 2_147_483_647

describe('请求超时', () => {
  it('缺省、非有限值与非正数回退 60 秒', () => {
    expect(resolveMcpRequestTimeoutMs(undefined)).toBe(60_000)
    expect(resolveMcpRequestTimeoutMs(Number.POSITIVE_INFINITY)).toBe(60_000)
    expect(resolveMcpRequestTimeoutMs(Number.NaN)).toBe(60_000)
    expect(resolveMcpRequestTimeoutMs(0)).toBe(60_000)
    expect(resolveMcpRequestTimeoutMs(-1)).toBe(60_000)
  })

  it('有限秒数换算为毫秒并夹在 Node 合法范围内', () => {
    expect(resolveMcpRequestTimeoutMs(60)).toBe(60_000)
    expect(resolveMcpRequestTimeoutMs(0.0001)).toBe(1)
    expect(resolveMcpRequestTimeoutMs(1e12)).toBe(MAX_TIMER_MS)
    expect(resolveMcpRequestTimeoutMs(2_147_483.648)).toBe(MAX_TIMER_MS)
  })
})
