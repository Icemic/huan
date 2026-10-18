/**
 * 队列条目 ID 方案——`"<mode>:<index>"`。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/queueIds.ts`
 *（MIT 许可）。改动：命名 `Pi*` → `Harness*`；注释译为中文。
 *
 * 由宿主的 `HarnessQueuedMessage` 与运行时的 composer 队列条目共用，
 * 并被 UI 解析（例如把 steering 条目与 follow-up 区分样式）。
 */

export type HarnessQueueMode = 'steer' | 'followUp'

export const harnessQueueItemId = (mode: HarnessQueueMode, index: number): string =>
  `${mode}:${index}`

export const isHarnessSteerQueueItemId = (id: string): boolean => id.startsWith('steer:')
