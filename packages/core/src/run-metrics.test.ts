import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { latestRunMetricsFromBranch, persistRunMetrics, RunMetricsRecorder } from './run-metrics.js'

const delta = (type: string, text: string) => ({ type, delta: text })
const assistant = (output: number) => ({
  role: 'assistant',
  usage: { output },
})

describe('RunMetricsRecorder：单轮运行统计', () => {
  it('持续发布运行中耗时，结算后停止更新', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const recorder = new RunMetricsRecorder(() => now)
      const update = vi.fn()
      recorder.begin()
      recorder.publish(update)
      now = 500
      vi.advanceTimersByTime(500)
      expect(update).toHaveBeenLastCalledWith({
        status: 'running',
        outputTokens: 0,
        durationMs: 500,
      })
      recorder.settle('completed')
      vi.advanceTimersByTime(1000)
      expect(update).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('跨多次模型调用累计输出，等待工具不中断计时', () => {
    let now = 0
    const recorder = new RunMetricsRecorder(() => now)
    expect(recorder.begin()).toEqual({ status: 'running', outputTokens: 0 })

    now = 100
    recorder.observeDelta(delta('text_delta', ''))
    now = 250
    recorder.observeDelta(delta('thinking_delta', '想法'))
    now = 500
    recorder.observeMessage(assistant(10))
    // 工具执行等待期间没有消息事件，时间仍计入总墙钟耗时。
    now = 1500
    recorder.observeDelta(delta('toolcall_delta', '{"path"'))
    recorder.observeMessage(assistant(5))

    now = 3000
    expect(recorder.settle('completed')).toEqual({
      status: 'completed',
      outputTokens: 15,
      durationMs: 3000,
      firstResponseMs: 250,
    })
    // 已结算统计不再随可控时钟变化。
    now = 9000
    expect(recorder.current()?.durationMs).toBe(3000)
  })

  it('重试沿用同一轮；agent_end 不触发结算', () => {
    let now = 0
    const recorder = new RunMetricsRecorder(() => now)
    recorder.begin()
    now = 100
    recorder.observeDelta(delta('text_delta', '第一次'))
    now = 200
    recorder.observeMessage(assistant(8))
    // 失败重试：新的模型调用继续累加，不重置启动时间与首响应。
    // SDK重试可能再次发送agent_start，仍需保留同一轮的时间与输出。
    expect(recorder.begin().outputTokens).toBe(8)
    now = 400
    recorder.observeDelta(delta('text_delta', '重试'))
    now = 500
    recorder.observeMessage(assistant(12))
    expect(recorder.current()).toEqual({
      status: 'running',
      outputTokens: 20,
      firstResponseMs: 100,
      durationMs: 500,
    })
    now = 2000
    expect(recorder.settle('completed')).toMatchObject({
      outputTokens: 20,
      durationMs: 2000,
      firstResponseMs: 100,
    })
  })

  it('流式用量按响应累计快照替换，工具等待继续增长，结束不重复加计', () => {
    let now = 0
    const recorder = new RunMetricsRecorder(() => now)
    recorder.begin()
    now = 100
    recorder.observePartial(assistant(5))
    recorder.observePartial(assistant(10))
    expect(recorder.current()).toMatchObject({ outputTokens: 10, durationMs: 100 })
    recorder.observeMessage(assistant(10))
    now = 1000
    expect(recorder.current()).toMatchObject({ outputTokens: 10, durationMs: 1000 })
    recorder.observePartial(assistant(3))
    expect(recorder.current()?.outputTokens).toBe(13)
    recorder.observeMessage(assistant(7))
    expect(recorder.settle('completed')?.outputTokens).toBe(17)
  })

  it('新的完整运行重置上一轮数据', () => {
    let now = 0
    const recorder = new RunMetricsRecorder(() => now)
    recorder.begin()
    now = 50
    recorder.observeDelta(delta('text_delta', '旧'))
    recorder.observeMessage(assistant(3))
    now = 100
    recorder.settle('completed')

    now = 1000
    expect(recorder.begin()).toEqual({ status: 'running', outputTokens: 0 })
    expect(recorder.current()).toEqual({ status: 'running', outputTokens: 0, durationMs: 0 })
    now = 1250
    recorder.observeDelta(delta('toolcall_delta', '{}'))
    now = 1500
    expect(recorder.settle('cancelled')).toEqual({
      status: 'cancelled',
      outputTokens: 0,
      durationMs: 500,
      firstResponseMs: 250,
    })
  })

  it('失败与取消保留已报告用量和实际耗时；零/非法用量不累加', () => {
    let now = 0
    const recorder = new RunMetricsRecorder(() => now)
    recorder.begin()
    recorder.observeMessage(assistant(0))
    recorder.observeMessage(assistant(-5))
    recorder.observeMessage(assistant(Number.NaN))
    recorder.observeMessage({ role: 'user', usage: { output: 100 } })
    now = 750
    recorder.observeMessage(assistant(4))
    expect(recorder.settle('failed')).toEqual({
      status: 'failed',
      outputTokens: 4,
      durationMs: 750,
    })
  })

  it('没有增量内容时首响应保持未知；结算幂等', () => {
    let now = 0
    const recorder = new RunMetricsRecorder(() => now)
    recorder.begin()
    now = 100
    recorder.observeDelta(delta('text_start', ''))
    recorder.observeDelta(delta('thinking_delta', ''))
    now = 500
    const settled = recorder.settle('completed')
    expect(settled).toEqual({ status: 'completed', outputTokens: 0, durationMs: 500 })
    now = 900
    expect(recorder.settle('failed')).toEqual(settled)
  })
})

describe('运行统计的独立保存', () => {
  it('重开按目标分支读取最近统计，保存不改变Pi条目', () => {
    const directory = mkdtempSync(join(tmpdir(), 'huan-metrics-'))
    try {
      const file = join(directory, 'session.jsonl')
      let branch = [{ id: 'a' }]
      const source = {
        getBranch: () => branch,
        getLeafId: () => branch.at(-1)?.id ?? null,
        getSessionFile: () => file,
      }
      const first = { status: 'completed' as const, outputTokens: 10, durationMs: 1000 }
      persistRunMetrics(source, first)
      branch = [{ id: 'a' }, { id: 'b' }]
      const second = { ...first, outputTokens: 20 }
      persistRunMetrics(source, second)
      expect(branch).toEqual([{ id: 'a' }, { id: 'b' }])
      expect(latestRunMetricsFromBranch({ ...source })).toEqual(second)
      branch = [{ id: 'a' }, { id: 'c' }]
      expect(latestRunMetricsFromBranch({ ...source })).toEqual(first)
      branch = [{ id: 'd' }]
      expect(latestRunMetricsFromBranch({ ...source })).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
