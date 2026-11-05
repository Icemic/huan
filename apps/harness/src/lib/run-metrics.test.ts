import type { HarnessRunMetrics } from '@huan/protocol'
import { describe, expect, it } from 'vitest'
import {
  formatRunMetricsDuration,
  formatRunMetricsSpeed,
  runMetricsFirstResponseText,
  runMetricsSpeed,
  runMetricsSummaryText,
} from './run-metrics'

const metrics = (overrides: Partial<HarnessRunMetrics> = {}): HarnessRunMetrics => ({
  status: 'completed',
  outputTokens: 120,
  durationMs: 2000,
  firstResponseMs: 350,
  ...overrides,
})

describe('run-metrics 展示计算', () => {
  it('结算后按输出与墙钟耗时计算平均速度', () => {
    expect(runMetricsSpeed(metrics())).toBe(60)
    expect(formatRunMetricsSpeed(60)).toBe('60.0 tok/s')
  })

  it('运行中也按已报告用量计算，输出为0或耗时无效时等待数据', () => {
    expect(runMetricsSpeed(metrics({ status: 'running' }))).toBe(60)
    expect(runMetricsSpeed(metrics({ outputTokens: 0 }))).toBeUndefined()
    expect(runMetricsSpeed(metrics({ durationMs: undefined }))).toBeUndefined()
    expect(runMetricsSpeed(metrics({ durationMs: 0 }))).toBeUndefined()
  })

  it('卡片运行中显示速度、耗时与首响应，缺失数据用占位', () => {
    expect(runMetricsSummaryText(metrics({ status: 'running' }))).toBe(
      '60.0 tok/s · 2.00 s · 首响应 350 ms',
    )
    expect(runMetricsSummaryText(metrics({ outputTokens: 0 }))).toBe('—')
    expect(runMetricsSummaryText(undefined)).toBe('')
    expect(runMetricsFirstResponseText(undefined)).toBe('—')
  })

  it('耗时按量级切换毫秒与秒', () => {
    expect(formatRunMetricsDuration(350)).toBe('350 ms')
    expect(formatRunMetricsDuration(2500)).toBe('2.50 s')
    expect(formatRunMetricsDuration(12500)).toBe('12.5 s')
    expect(formatRunMetricsDuration(undefined)).toBe('—')
  })
})
