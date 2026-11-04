import { describe, expect, it } from 'vitest'
import {
  contextUsageCacheHitRate,
  contextUsageProgress,
  contextUsageTone,
  formatContextPercent,
  formatContextTokenCount,
} from './context-usage'

describe('上下文用量展示计算', () => {
  it('颜色阈值在 60/80 边界切换，未知值保持中性', () => {
    expect(contextUsageTone(undefined)).toBe('unknown')
    expect(contextUsageTone(null)).toBe('unknown')
    expect(contextUsageTone(Number.NaN)).toBe('unknown')
    expect(contextUsageTone(0)).toBe('primary')
    expect(contextUsageTone(59.9)).toBe('primary')
    expect(contextUsageTone(60)).toBe('warning')
    expect(contextUsageTone(79.9)).toBe('warning')
    expect(contextUsageTone(80)).toBe('destructive')
    expect(contextUsageTone(160)).toBe('destructive')
  })

  it('绘制进度裁剪到 0～100，百分比文本保留超窗原值', () => {
    expect(contextUsageProgress(null)).toBe(0)
    expect(contextUsageProgress(-5)).toBe(0)
    expect(contextUsageProgress(42.5)).toBe(42.5)
    expect(contextUsageProgress(160)).toBe(100)
    expect(formatContextPercent(160)).toBe('160.0%')
    expect(formatContextPercent(null)).toBe('—')
    expect(formatContextTokenCount(12345)).toBe('12.3K')
    expect(formatContextTokenCount(387_200)).toBe('387.2K')
    expect(formatContextTokenCount(1_340_000)).toBe('1.34M')
    expect(formatContextTokenCount(1_000_000)).toBe('1M')
    expect(formatContextTokenCount(899)).toBe('899')
  })

  it('缓存命中率按 input+cacheRead+cacheWrite 计算，分母为 0 时未知', () => {
    expect(
      contextUsageCacheHitRate({
        input: 50,
        output: 10,
        cacheRead: 30,
        cacheWrite: 20,
        total: 110,
      }),
    ).toBe(0.3)
    expect(
      contextUsageCacheHitRate({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0, total: 10 }),
    ).toBeUndefined()
    expect(
      contextUsageCacheHitRate({
        input: Number.NaN,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      }),
    ).toBeUndefined()
  })
})
