/**
 * 输入区上下文用量的纯展示计算：颜色阈值、进度裁剪与缓存命中率。
 *
 * 进度只限制绘制范围；百分比文本保留服务端原值，允许超过 100%。
 * 缓存命中率按现有协议字段计算，不推断服务商是否报告缓存。
 */

import type { HarnessThreadStats } from '@huan/protocol'

/** 上下文用量颜色分组；unknown 使用中性色。 */
export type ContextUsageTone = 'unknown' | 'primary' | 'warning' | 'destructive'

/** 小于 60% primary，60% 至小于 80% warning，80% 及以上 destructive。 */
export const contextUsageTone = (percent: number | null | undefined): ContextUsageTone => {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'unknown'
  if (percent < 60) return 'primary'
  if (percent < 80) return 'warning'
  return 'destructive'
}

/** 环形与横向进度共用同一裁剪结果；未知用量不画进度。 */
export const contextUsageProgress = (percent: number | null | undefined): number => {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 0
  return Math.min(Math.max(percent, 0), 100)
}

/**
 * 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。
 *
 * 分母为 0 或非有限值时返回 undefined，由界面显示占位符而不是伪造 0%。
 */
export const contextUsageCacheHitRate = (
  tokens: HarnessThreadStats['tokens'],
): number | undefined => {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined
  return tokens.cacheRead / denominator
}

/** 按十进制 K/M 缩写，用有限精度保持输入区浮窗紧凑。 */
export const formatContextTokenCount = (value: number): string => {
  if (value < 1000) return String(value)
  const divisor = value >= 1_000_000 ? 1_000_000 : 1000
  const scaled = value / divisor
  const precision = scaled < 10 ? 2 : 1
  return `${Number(scaled.toFixed(precision))}${divisor === 1000 ? 'K' : 'M'}`
}

/** 百分比文本；未知值显示破折号。 */
export const formatContextPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}
