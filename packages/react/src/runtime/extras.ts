/**
 * 运行时扩展（extras）通道实例。
 *
 * 出处：移植自 `@assistant-ui/react-pi@0.0.29` 的 `src/runtime/piExtras.ts`
 *（MIT 许可）。改动：命名 `piExtras` → `harnessExtras`；
 * `createRuntimeExtras` 改从本包 `../vendor/hooks.js` 引入
 *（上游从 `@assistant-ui/core/react` 引入，但该 API 被标注为 deprecated
 * 内部接口）；注释译为中文。
 *
 * extras 通过 assistant-ui 的 thread 状态侧带传递，公共 hook 用选择器
 * 订阅，避免全量重渲染。
 */
import { createRuntimeExtras } from '../vendor/hooks.js'
import type { HarnessRuntimeExtrasInternal } from './runtime-types.js'

export const harnessExtras = createRuntimeExtras<HarnessRuntimeExtrasInternal>('useHarnessRuntime')
