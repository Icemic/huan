/**
 * 会话消息的细粒度读取与增量投影。
 *
 * 只订阅当前会话的权威运行数据与运行状态；投影器缓存放在组件实例内，
 * 通过共享引用避免无关消息重渲染。这里不把消息复制到任何第二 store。
 */

import type { HarnessMessageView } from '@huan/react'
import {
  HarnessMessageViewProjector,
  selectThreadRunStatus,
  useServiceStore,
  useThreadSession,
} from '@huan/react'
import { useCallback, useMemo, useRef } from 'react'

const EMPTY: readonly HarnessMessageView[] = []

/** 读取并投影当前会话；线程切换时重建投影器，同一线程复用增量缓存。 */
export const useMessageViews = (threadId: string | undefined): readonly HarnessMessageView[] => {
  const session = useThreadSession(threadId)
  const runStatus = useServiceStore(
    useCallback(
      (state) => {
        const metadata = threadId ? state.threadsById[threadId] : undefined
        return metadata ? selectThreadRunStatus(metadata) : 'idle'
      },
      [threadId],
    ),
  )
  const cache = useRef<
    { threadId: string | undefined; projector: HarnessMessageViewProjector } | undefined
  >(undefined)
  return useMemo(() => {
    if (!threadId || !session) {
      cache.current = undefined
      return EMPTY
    }
    if (cache.current?.threadId !== threadId) {
      cache.current = { threadId, projector: new HarnessMessageViewProjector() }
    }
    const compaction = session.compaction
    return cache.current.projector.project({
      messages: session.messages,
      messageEntryIds: session.messageEntryIds,
      toolExecutions: session.toolExecutions,
      runStatus,
      ...(compaction && (compaction.active || compaction.status) ? { compaction } : {}),
    })
  }, [session, runStatus, threadId])
}
