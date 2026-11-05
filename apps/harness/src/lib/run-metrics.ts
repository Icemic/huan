/**
 * 本轮运行统计的纯展示计算：平均速度、耗时文本与状态占位。
 *
 * 使用服务端持续更新的用量和耗时计算，不按字符数推测。
 */

import type { HarnessRunMetrics } from '@huan/protocol'

/** 本轮平均速度（tokens/s）；数据不足时返回 undefined。 */
export const runMetricsSpeed = (metrics: HarnessRunMetrics | undefined): number | undefined => {
  if (!metrics) return undefined
  if (!(metrics.outputTokens > 0)) return undefined
  if (metrics.durationMs === undefined || !(metrics.durationMs > 0)) return undefined
  return (metrics.outputTokens * 1000) / metrics.durationMs
}

/** 平均速度文本；未知显示破折号。 */
export const formatRunMetricsSpeed = (speed: number | undefined): string => {
  if (speed === undefined || !Number.isFinite(speed)) return '—'
  if (speed >= 100) return `${Math.round(speed)} tok/s`
  if (speed >= 10) return `${speed.toFixed(1)} tok/s`
  return `${speed.toFixed(2)} tok/s`
}

/** 毫秒耗时文本；小于一秒保留毫秒，较长耗时用秒。未知显示破折号。 */
export const formatRunMetricsDuration = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  const seconds = value / 1000
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
}

/** 子卡片紧邻输入/输出与费用的本轮速度摘要。 */
export const runMetricsSummaryText = (metrics: HarnessRunMetrics | undefined): string => {
  if (!metrics) return ''
  if (metrics.status === 'running') {
    const speed = runMetricsSpeed(metrics)
    return `${speed === undefined ? '等待用量' : formatRunMetricsSpeed(speed)} · ${formatRunMetricsDuration(metrics.durationMs)} · 首响应 ${formatRunMetricsDuration(metrics.firstResponseMs)}`
  }
  return formatRunMetricsSpeed(runMetricsSpeed(metrics))
}

/** 悬浮详情中的首响应耗时。 */
export const runMetricsFirstResponseText = (metrics: HarnessRunMetrics | undefined): string =>
  formatRunMetricsDuration(metrics?.firstResponseMs)
