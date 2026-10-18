/**
 * 错误 → 文本的浏览器安全转换。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/utils.ts`（MIT 许可）。
 * 改动：注释译为中文。
 */

/** 把任意抛出错转为可读文本。 */
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
