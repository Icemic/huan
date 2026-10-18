/**
 * 批量释放 Controller。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的
 * `src/runtime/disposeControllers.ts`（MIT 许可）。改动：注释译为中文。
 * 逻辑与上游等价。
 *
 * 逐个释放并汇总错误：第一个错误被重抛，其余只记录，使一个 Controller 的
 * 释放失败不阻断其它 Controller 的清理。
 */
export const disposeControllers = (controllers: Iterable<{ dispose(): void }>) => {
  let cleanupFailed = false
  let cleanupError: unknown

  for (const controller of controllers) {
    try {
      controller.dispose()
    } catch (error) {
      if (cleanupFailed) {
        console.error(error)
      } else {
        cleanupFailed = true
        cleanupError = error
      }
    }
  }

  if (cleanupFailed) throw cleanupError
}
