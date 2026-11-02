/**
 * 宿主内置扩展装配（G1.4b）。
 *
 * 只使用 SDK 根入口公开工厂，并遵循 CLI 的 named builtin / replaceable 约定：
 * - `builtin: true`：作为 `builtin:<name>` 资源参与 `extensions` 设置的启停
 *   （例如 `-builtin:codemode`）与项目 `+/-/!` 覆盖，且在项目信任解析之后加载；
 * - `replaceable: true`：第三方扩展注册同名工具/命令时替换内置实现，而不是
 *   两份同时运行。
 *
 * codemode/tool_search 的发现工具默认不激活（`defaultActive: false`），需要用户设置
 * `defaultTools`（如 `+codemode`、`+tool_search`）显式启用；宿主不把工具收窄为
 * allowlist，也不移除 huan 工作区工具。MCP 由调用方传入无界面集成 binding 的
 * 工厂（不注入官方 `createMcpExtension`），同样按 named builtin、replaceable
 * 语义装配，因此 `-builtin:mcp` 与第三方 `/mcp` 替换都有效；其工具按配置的
 * exposure 注册，direct 工具默认可直接调用。
 */
import {
  createCodemodeExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent'

/**
 * 返回宿主注入的内置扩展工厂（每次装配独立实例，工厂内部状态不跨会话共享）。
 *
 * `mcp` 必须由宿主按会话装配传入；查询/目录路径也会得到独立 binding，但工厂
 * 本身不读取配置、不建立连接，连接只发生在 session_start。
 */
export function createBuiltinExtensionFactories(mcp?: ExtensionFactory): InlineExtension[] {
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
    // MCP 最后装配：其 session_start 依赖 codemode/tool_search 已注册，
    // 才能在需要时激活发现工具。
    ...(mcp
      ? [
          {
            name: 'mcp',
            builtin: true,
            replaceable: true,
            factory: mcp,
          } satisfies InlineExtension,
        ]
      : []),
  ]
}
