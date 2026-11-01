/**
 * 宿主内置扩展装配（G1.4b）。
 *
 * 只使用 SDK 根入口公开工厂，并遵循 CLI 的 named builtin / replaceable 约定：
 * - `builtin: true`：作为 `builtin:<name>` 资源参与 `extensions` 设置的启停
 *   （例如 `-builtin:codemode`）与项目 `+/-/!` 覆盖，且在项目信任解析之后加载；
 * - `replaceable: true`：第三方扩展注册同名工具/命令时替换内置实现，而不是
 *   两份同时运行。
 *
 * 这些扩展注册的工具默认不激活（`defaultActive: false`），需要用户设置
 * `defaultTools`（如 `+codemode`、`+tool_search`）显式启用；宿主不把工具
 * 收窄为 allowlist，也不移除 huan 工作区工具。MCP 工厂与连接/凭据生命周期
 * 随 G1.4d 装配，这里刻意不包含。
 */
import {
  createCodemodeExtension,
  createToolSearchExtension,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent'

/** 返回宿主注入的内置扩展工厂（每次装配独立实例，工厂内部状态不跨会话共享）。 */
export function createBuiltinExtensionFactories(): InlineExtension[] {
  return [
    {
      name: 'codemode',
      builtin: true,
      replaceable: true,
      factory: createCodemodeExtension(),
    },
    {
      name: 'tool-search',
      builtin: true,
      replaceable: true,
      factory: createToolSearchExtension(),
    },
  ]
}
