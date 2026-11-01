/**
 * 公共 hook：会话运行时状态的订阅入口。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/runtime/hooks.ts`
 * （MIT 许可）。改动：命名 `Pi*` → `Harness*`，注释译为中文。
 * 逻辑与上游等价。
 *
 * 设计：hook 分成多个（而非单个返回全部字段的 hook），使消费方按需订阅
 * 细粒度选择器。选择器结果用 `Object.is` 比较，因此组件只在该值变化时重渲染。
 */

'use client'

import type { HarnessHostUiRequest, HarnessThreadMetadata } from '@huan/protocol'
import { useMemo } from 'react'
import { harnessExtras } from './extras.js'
import type { HarnessRuntimeActions, HarnessRuntimeExtras } from './runtime-types.js'
import type { HarnessThreadControllerLike } from './thread-controller.js'
import type { HarnessThreadState } from './thread-state.js'
import {
  EMPTY_RUNTIME_ACTIONS,
  EMPTY_RUNTIME_EXTRAS,
  NOOP_CONTROLLER,
  useHarnessControllerStateSelector,
} from './use-harness-runtime.js'

/** 当前会话的完整运行时扩展（含状态、元数据与动作）。 */
export const useHarnessExtras = (): HarnessRuntimeExtras =>
  harnessExtras.use((e) => e, EMPTY_RUNTIME_EXTRAS)

/** 当前会话 Controller（树导航等需要稳定动作引用的消费方使用）。 */
export const useHarnessController = (): HarnessThreadControllerLike =>
  harnessExtras.use((e) => e.controller, NOOP_CONTROLLER)

/**
 * 与当前 Controller 绑定的稳定动作集合。
 *
 * 只需要动作的组件应使用本 hook 而非 `useHarnessExtras()`：动作不随消息、
 * 队列或 Host UI 状态变化，切换 Controller 时才更新引用。
 */
export const useHarnessActions = (): HarnessRuntimeActions =>
  harnessExtras.use((e) => e.actions, EMPTY_RUNTIME_ACTIONS)

/** 当前会话的元数据；未关联会话时为 `null`。 */
export const useHarnessSession = (): HarnessThreadMetadata | null =>
  harnessExtras.use((e) => e.metadata, null)

/**
 * 实时会话状态，可选经选择器投影。
 *
 * 选择结果用 `Object.is` 比较，因此组件只在该值变化时重渲染。
 * 返回新对象或数组字面量的选择器会在每次 controller 通知时重渲染；
 * 应选择原始值，或返回已记忆化的引用。
 */
export function useHarnessThreadState(): HarnessThreadState
export function useHarnessThreadState<T>(selector: (state: HarnessThreadState) => T): T
export function useHarnessThreadState<T>(selector?: (state: HarnessThreadState) => T) {
  const controller = harnessExtras.use((e) => e.controller, NOOP_CONTROLLER)
  return useHarnessControllerStateSelector(controller, selector ?? ((state) => state as T))
}

const EMPTY_HOST_UI_REQUESTS: readonly HarnessHostUiRequest[] = []

const UNAVAILABLE_RESPOND: HarnessRuntimeActions['respondToHostUiRequest'] = async () => {
  throw new Error('Pi runtime is not ready yet')
}

/**
 * 待处理的游离 Host UI 请求，附带应答函数。
 *
 * 请求数组与应答动作分别按字段订阅；其他线程状态更新不会让调用方重渲染。
 */
export const useHarnessHostUiRequests = () => {
  const requests = harnessExtras.use((e) => e.hostUiRequests, EMPTY_HOST_UI_REQUESTS)
  const respond = harnessExtras.use((e) => e.actions.respondToHostUiRequest, UNAVAILABLE_RESPOND)

  return useMemo(() => ({ requests, respond }), [requests, respond])
}
