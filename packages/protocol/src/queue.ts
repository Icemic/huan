/**
 * 队列条目 ID 方案：`"<mode>:<index>"`。
 *
 * 宿主生成的队列镜像条目与 UI 的输入队列条目共用，UI 依此区分 steer 与 follow-up。
 */
export type HarnessQueueMode = 'steer' | 'followUp'

/** 生成队列条目 ID。 */
export const harnessQueueItemId = (mode: HarnessQueueMode, index: number): string =>
  `${mode}:${index}`

/** 判断队列条目是否为 steer。 */
export const isHarnessSteerQueueItemId = (id: string): boolean => id.startsWith('steer:')
