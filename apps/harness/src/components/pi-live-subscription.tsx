import { usePiRuntimeExtras } from '@assistant-ui/react-pi'
import { useEffect } from 'react'

/** react-pi 运行时的内部扩展对象中含 controller（未在公共类型声明）。 */
type ControllerHolder = {
  controller?: { connect: () => () => void }
}

/**
 * 空闲会话的长期订阅维护组件。
 *
 * react-pi 只在会话 running 时自动 connect()，空闲会话打开时只加载快照、
 * 不建立事件流。多窗口场景下，一个窗口在会话中发起运行，其他已打开该会话
 * 的窗口不会收到实时更新（技术架构 §4.1 记录的限制）。
 *
 * 本组件在挂载时为当前会话建立长期订阅，卸载时释放；滚动变化或窗口切换
 * 都不影响——只要会话视图打开，就保持事件流连接。
 */
export function PiLiveSubscription() {
  const extras = usePiRuntimeExtras()

  const controller = (extras as ControllerHolder).controller

  useEffect(() => {
    if (!controller) return
    const release = controller.connect()
    return () => release()
  }, [controller])

  return null
}
