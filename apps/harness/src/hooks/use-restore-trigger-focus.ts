/**
 * 弹层关闭后把焦点还给入口按钮。
 *
 * 部分面板的入口按钮只在关闭时渲染（打开时整块换成 Dialog），Base UI 无法
 * 找到原触发器，关闭后焦点会落回文档；这里在关闭的同一帧把焦点交还。
 */

import { useEffect, useRef } from 'react'

export function useRestoreTriggerFocus<T extends HTMLElement = HTMLButtonElement>(open: boolean) {
  const triggerRef = useRef<T | null>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus()
    wasOpen.current = open
  }, [open])
  return triggerRef
}
