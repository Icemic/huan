/**
 * 上游 React hook 与 runtime extras 通道的本地副本（anti-corruption layer）。
 *
 * 出处：`@assistant-ui/core@0.3.27`（`react/runtimes/assistant-transport/
 * useLatestRef`、`runtime/utils/runtime-extras-brand`、`react/runtimes/
 * createRuntimeExtras`）与 `@assistant-ui/store@0.3.19`
 * （`utils/useReplaySafeEffect`）。许可：MIT。
 *
 * 为什么复制而不是导入：
 * - `useLatestRef` / `useReplaySafeEffect` 只经 `core/react/internal` 与
 *   `store/internal` 暴露（内部子路径）；
 * - `createRuntimeExtras` 虽在 `core/react` 公共路径，但上游标注
 *   `@deprecated Internal API ... may change or be removed without notice`，
 *   其依赖的 `createRuntimeExtrasBrand` 未公开导出。
 *
 * 改动：上游经 `@assistant-ui/tap/react-shim` 引用 React API，此处改为直接
 * 从 `react` 导入（shim 仅是 re-export，语义等价）；并对 brand 的 extras
 * 访问做了类型收紧。逻辑保持等价。
 */

import { useAuiState } from '@assistant-ui/react'
import { useEffect, useInsertionEffect, useRef, useState } from 'react'

/**
 * 把最新值写入 ref，在 `useInsertionEffect` 阶段同步（早于 layout effect 与
 * 常规 effect），供事件回调读取「当前」值而不进入依赖。
 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useInsertionEffect(() => {
    ref.current = value
  }, [value])
  return ref
}

const depsEqual = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

/**
 * 能在「重放」下存活的 `useEffect`。
 *
 * Fast Refresh 与 StrictMode 双挂载会在同一 tick 内先跑 cleanup 再跑 setup
 * 且依赖未变；两者都被跳过，因此 effect 启动的工作继续运行。依赖变化时仍先
 * 跑旧 cleanup 再 setup；卸载或 `<Activity>` 隐藏则在下一个微任务跑 cleanup。
 */
export function useReplaySafeEffect(
  effect: () => (() => void) | undefined,
  deps: readonly unknown[],
): void {
  const [cell] = useState<{
    pending: { deps: readonly unknown[]; cleanup?: () => void } | undefined
  }>(() => ({ pending: undefined }))
  useEffect(
    () => {
      const pending = cell.pending
      cell.pending = undefined
      let current: { deps: readonly unknown[]; cleanup?: () => void }
      if (pending !== undefined && depsEqual(pending.deps, deps)) {
        current = pending
      } else {
        pending?.cleanup?.()
        current = { deps, cleanup: effect() ?? undefined }
      }
      return () => {
        cell.pending = current
        queueMicrotask(() => {
          if (cell.pending !== current) return
          cell.pending = undefined
          current.cleanup?.()
        })
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖由调用方通过 deps 参数显式传入，本函数语义与 React 的 useEffect 一致
    deps as unknown as readonly unknown[],
  )
}

/** extras 通道的非 React 半侧：per-instance 的 brand symbol 与读写原语。 */
type RuntimeExtrasBrand<T extends object> = {
  provide: (value: T) => T
  is: (extras: unknown) => extras is T
  tryGet: (extras: unknown) => T | undefined
  assert: (extras: unknown) => T
}

/**
 * 创建一个 runtime extras 通道的框架无关半侧。
 *
 * symbol 是 per-instance 的：适配器包创建一次 brand，所有绑定导入同一实例。
 */
function createRuntimeExtrasBrand<T extends object>(runtimeName: string): RuntimeExtrasBrand<T> {
  const brand: unique symbol = Symbol(`${runtimeName} extras`)
  const is = (extras: unknown): extras is T =>
    typeof extras === 'object' && extras !== null && brand in extras
  const assert = (extras: unknown): T => {
    if (!is(extras)) {
      throw new Error(`The current thread is not backed by the ${runtimeName} runtime.`)
    }
    return extras
  }
  const provide = (value: T): T => {
    Object.defineProperty(value, brand, {
      value: true,
      enumerable: false,
      configurable: true,
    })
    return value
  }
  const tryGet = (extras: unknown): T | undefined => (is(extras) ? extras : undefined)
  return { provide, is, tryGet, assert }
}

/** runtime extras 通道（含 React 侧 `use` 选择器）。 */
export type RuntimeExtras<T extends object> = RuntimeExtrasBrand<T> & {
  /** 断言读取当前会话 extras（在 React 渲染外使用）。 */
  get: (client: unknown) => T
  /** 订阅式选择器；无 fallback 时 extras 不匹配会抛错。 */
  use: {
    (): T
    <R>(select: (extras: T) => R, fallback: R): R
    <R>(select: ((extras: T) => R) | undefined): R
  }
}

/**
 * 创建 runtime extras 通道。
 *
 * 适配器用它把类型化的 extras 挂到 assistant-ui 的 thread 状态上，
 * 公共 hook 再用 `use` 按选择器订阅，避免全量重渲染。
 */
export function createRuntimeExtras<T extends object>(runtimeName: string): RuntimeExtras<T> {
  const { provide, is, tryGet, assert } = createRuntimeExtrasBrand<T>(runtimeName)
  const get = (client: unknown): T =>
    assert(
      (
        client as {
          thread: { getState(): { extras?: unknown } }
        }
      ).thread.getState().extras,
    )
  const use = (select?: (extras: T) => unknown, ...rest: unknown[]) => {
    const hasFallback = rest.length > 0
    const fallback = rest[0]
    return useAuiState((state: { thread: { extras?: unknown } }) => {
      const extras = state.thread.extras
      if (is(extras)) return select ? select(extras) : extras
      if (hasFallback) return fallback
      return assert(extras)
    })
  }
  return { provide, is, tryGet, assert, get, use: use as RuntimeExtras<T>['use'] }
}
