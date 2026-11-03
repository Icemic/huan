import type { HarnessModelInfo } from '@huan/protocol'
import { describe, expect, it, vi } from 'vitest'

// 组件文件含 Lingui 宏；纯助手测试不加载真实宏转换链。
vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: unknown }) => children,
}))

import {
  modelKeyOf,
  modelPatternMatchesModel,
  modelPatternsSelectModel,
  parseModelPatternText,
  stripModelThinkingSuffix,
  toggleModelPattern,
} from './model-scope-editor'

const model = (provider: string, modelId: string, name?: string): HarnessModelInfo => ({
  provider,
  modelId,
  ...(name ? { name } : {}),
})

const alpha = model('provider', 'alpha')
const beta = model('provider', 'beta')
const gamma = model('other', 'gamma')
const catalog = [alpha, beta, gamma]

describe('模型范围编辑：patterns 匹配与普通多选', () => {
  it('精确键、模型 ID、通配与 Thinking 后缀按 Pi 规则匹配', () => {
    expect(modelKeyOf(alpha)).toBe('provider/alpha')
    expect(stripModelThinkingSuffix('provider/alpha:max')).toBe('provider/alpha')
    expect(modelPatternMatchesModel('provider/alpha:high', alpha)).toBe(true)
    expect(modelPatternMatchesModel('alpha', alpha)).toBe(true)
    expect(modelPatternMatchesModel('provider/*', alpha)).toBe(true)
    expect(modelPatternMatchesModel('*beta', beta)).toBe(true)
    expect(modelPatternMatchesModel('provider/*:high', beta)).toBe(true)
    expect(modelPatternMatchesModel('provider/*', gamma)).toBe(false)
    expect(modelPatternMatchesModel('', alpha)).toBe(false)
  })

  it('空 patterns 表示全部；取消一个模型时展开为其余精确键', () => {
    expect(modelPatternsSelectModel([], alpha)).toBe(true)
    expect(toggleModelPattern([], catalog, beta, false)).toEqual(['provider/alpha', 'other/gamma'])
  })

  it('勾选只追加精确模式，已包含或空 patterns 表示全部时不缩小范围', () => {
    expect(toggleModelPattern(['provider/beta:max'], catalog, alpha, true)).toEqual([
      'provider/beta:max',
      'provider/alpha',
    ])
    expect(
      toggleModelPattern(['provider/alpha:max', 'provider/*:high'], catalog, alpha, true),
    ).toEqual(['provider/alpha:max', 'provider/*:high'])
    expect(toggleModelPattern([], catalog, alpha, true)).toEqual([])
  })

  it('取消只删除该模型的精确模式并保留通配与其他模式', () => {
    expect(
      toggleModelPattern(['provider/alpha:max', 'provider/*:high'], catalog, alpha, false),
    ).toEqual(['provider/*:high'])
    // 只由通配包含时普通多选无法表达排除。
    expect(toggleModelPattern(['provider/*'], catalog, beta, false)).toEqual(['provider/*'])
  })

  it('取消最后一项时保持原模式，避免空 patterns 重新表示全部', () => {
    expect(toggleModelPattern(['provider/alpha'], catalog, alpha, false)).toEqual([
      'provider/alpha',
    ])
    expect(toggleModelPattern(['provider/alpha:max'], catalog, alpha, false)).toEqual([
      'provider/alpha:max',
    ])
    // 目录只有一个模型时取消同样不能得到空 patterns。
    expect(toggleModelPattern([], [alpha], alpha, false)).toEqual([])
  })

  it('高级原文按行保留空白过滤，不重写模式内容', () => {
    expect(parseModelPatternText('provider/*:high\n\n other/model \r\n')).toEqual([
      'provider/*:high',
      ' other/model ',
    ])
  })
})
