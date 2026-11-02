/**
 * 聊天滚动跟随：只在读者位于底部时跟随新输出；上滚后不强行拉回。
 *
 * 新输出提示与回底按钮属于 DOM 交互状态；ResizeObserver 处理迟到图片、
 * 折叠和流式布局变化。折叠状态本身仍在 chat feature store。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const NEAR_BOTTOM_PX = 48

export interface StickToBottom {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  following: boolean
  hasNewOutput: boolean
  onScroll: () => void
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

export const useStickToBottom = (threadKey: string, contentVersion: unknown): StickToBottom => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [hasNewOutput, setHasNewOutput] = useState(false)
  const previousVersion = useRef(contentVersion)
  const previousThread = useRef<string | undefined>(undefined)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = scrollRef.current
    if (!element) return
    followingRef.current = true
    setFollowing(true)
    setHasNewOutput(false)
    element.scrollTo({ top: element.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX
    if (followingRef.current !== nearBottom) {
      followingRef.current = nearBottom
      setFollowing(nearBottom)
    }
    if (nearBottom) setHasNewOutput(false)
  }, [])

  // 切换线程：回到跟随状态并落到最新消息。
  useEffect(() => {
    if (previousThread.current === threadKey) return
    previousThread.current = threadKey
    followingRef.current = true
    setFollowing(true)
    setHasNewOutput(false)
    // 调度属于本次effect，卸载后取消；StrictMode重挂仍会取得自己的首帧。
    const frame = requestAnimationFrame(() => scrollToBottom('auto'))
    return () => {
      cancelAnimationFrame(frame)
      previousThread.current = undefined
    }
  }, [scrollToBottom, threadKey])

  // 新内容到达：跟随则保持底部；上滚则只提示。
  useEffect(() => {
    if (previousVersion.current === contentVersion) return
    previousVersion.current = contentVersion
    if (followingRef.current) {
      const frame = requestAnimationFrame(() => scrollToBottom('auto'))
      return () => cancelAnimationFrame(frame)
    }
    setHasNewOutput(true)
    return undefined
  }, [contentVersion, scrollToBottom])

  // 图片/折叠/字体导致的尺寸变化：跟随底部时重新贴底；上滚时保留原生锚点。
  useEffect(() => {
    const element = contentRef.current
    const viewport = scrollRef.current
    if (!element || !viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToBottom('auto')
    })
    observer.observe(element)
    // 输入区增高/附件行出现会改变视口高度；跟随底部时同步贴底。
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [scrollToBottom])

  return { scrollRef, contentRef, following, hasNewOutput, onScroll, scrollToBottom }
}
