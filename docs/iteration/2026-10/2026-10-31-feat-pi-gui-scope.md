# 迭代：Pi 基础能力 GUI 化的范围与验收规范

- **日期**：2026-10-31
- **分类**：feat
- **状态**：已完成（本次仅交付文档与源码盘点，未实现 G1 功能）
- **依据**：用户确认先使 Pi 基础能力在 GUI 可用，再用 huan 自迭代；分支、MCP 属必需能力，文件回滚等新增能力延后。

## 1. 目标与范围

建立持续维护的能力规范，将原先的差异化优先调整为 Pi GUI 优先。新增 `docs/pi-gui-capabilities.md`，同步 roadmap、产品与架构结论和运行现状。本次不修改运行时代码、依赖或用户配置。

文档职责：能力定义与验收要求归能力规范；计划、排序与完成状态归 roadmap；本次调研与验证证据归本文；运行现状归 todo。避免再建立一份独立排期。

## 2. 决策

| 事项 | 结论 |
| --- | --- |
| 短期目标 | Pi 自带的交互基础能力有 GUI 等价入口，随后以 huan 开发 huan；不以个人近期使用频率删减能力 |
| 保留与延后 | 会话树、fork、clone、MCP、认证、配置和原生命令纳入；文件快照、回滚、IDE 工作区、末语工坊接入延后 |
| 用户空间 | 默认沿用 Pi 用户空间（默认 `~/.pi/agent`）；支持手工指定其他目录。完整隔离及 sessionDir 优先级在功能迭代设计中明确 |
| 验证空间 | 默认自动化使用临时用户空间与确定性模型；真实个人环境兼容验证显式运行 |
| 实现方式 | 继续使用 SDK 与 HTTP/SSE；保留 Pi 行为语义，以 GUI 替代终端交互；不移植整个 TUI |

## 3. 调研基线

### 3.1 版本与来源

代码基线为 `1d03532`。`apps/harness` 与 `packages/core` 实际解析的 `@earendil-works/pi-coding-agent` 均为 **1.1.0**。以仓库安装包内的 docs、examples 和导出声明为依据，不以全局安装的较新 Pi 为基准。

阅读范围：`docs/{sdk,usage,slash-commands,sessions,configuration,settings,security,mcp,extensions,skills,prompt-templates}.md`、`examples/sdk/{11-sessions,14-codemode-mcp}.ts`，以及 `dist/core/{agent-session,agent-session-runtime,session-manager,model-runtime}.d.ts` 和 `dist/index.d.ts`。其他能力的详细 SDK 路径留待对应功能迭代继续核实。

### 3.2 当前实现与未接入能力

| 能力 | 本次源码盘点结论 | 依据 |
| --- | --- | --- |
| 用户目录 | 配置可指定；会话创建和查找未统一显式目录 | `server/config.ts`、`core/src/host.ts` 的 `SessionManager.create/list/listAll` |
| 工作区 | 环境变量可设置；GUI 无项目选择入口 | `server/config.ts`、`src/app.tsx` |
| 会话管理 | 新建、打开、改名、归档、删除已有实现；列表已有按标题过滤与日期分组，非全文搜索；归档为内存态 | `thread-list.aui.tsx`、`use-harness-runtime.ts`、`core/src/host.ts` |
| 分支与导入 | 协议未提供树导航、fork、clone、import 操作 | `protocol/src/client.ts` |
| 对话控制 | 流式、模型/Thinking、中止、队列与 Host UI 已有基础实现，需按新验收补验证 | `thread.aui.tsx`、`thread-controller.ts`、`core/src/host.ts` |
| Thinking 范围 | 协议到 `xhigh`；1.1.0 设置文档另列 `max`，须结合实际模型与类型核实差异 | `protocol/src/thread.ts`、Pi `docs/settings.md` |
| 上下文 | 自动压缩/重试事件有映射，用量有投影；缺手动 compact、完整统计和设置管理协议 | `event-mapping.ts`、`protocol/src/client.ts` |
| 命令与资源 | SDK 装配资源；GUI 无命令目录、资源清单与 reload 操作；不能据此认定所有命令可用 | `model-catalog.ts`、`protocol/src/client.ts` |
| 内置扩展与 MCP | 当前未显式注入 MCP、codemode、tool search 的工厂；无 MCP 管理协议 | `model-catalog.ts`、`core/src/host.ts`，对照 SDK example 14 |
| Host UI | confirm/select/input/editor 有桥接；多项状态和编辑器方法为空实现，custom 明确拒绝 | `core/src/host-ui.ts` |
| Shell 与输出 | 模型工具执行已有；用户 `!`/`!!`、导入导出和分享未暴露专用协议 | `protocol/src/client.ts`；`event-mapping.ts` 忽略 `bash_execution_update` |
| 重连 | 已 loaded Controller 再建连接会跳过快照，可能缺离线历史 | `thread-controller.ts` 的 `connect()` |

发现并修正旧文档误记：`todo.md` 的“会话列表无搜索”与实际标题搜索不符。本次不更改历史迭代的完成记录。

### 3.3 SDK 可用性与待核实边界

- `AgentSession.navigateTree`、`compact`、`reload`、`executeBash/abortBash`、`getSessionStats`、`exportToHtml/exportToJsonl` 有公开声明。
- `AgentSessionRuntime` 提供 new/switch/fork/import；fork 可指定位置，clone 的组合路径仍需核对 CLI 实现及生命周期，不直接写 JSONL 替代。
- `ModelRuntime` 提供 login/logout、凭据状态和模型刷新；认证交互仍需 GUI 协议。
- MCP/codemode/tool search 的创建函数有公开导出；SDK 不自动加载，且 `/mcp` 的现成交互涉及 TUI，需另行设计 GUI 承接方式。
- 会话目录文档包含独立环境变量与 setting；默认目录辅助函数在模块声明中存在，但未从包根导出。不能未经核实就复制路径算法或假定显式 agentDir 已完成会话隔离。

## 4. 验证记录

2026-10-31，本次文档修改前重跑：

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | 失败；lint 通过但有 1 个未使用 import 警告；全部类型检查通过；测试 381 通过、1 失败、34 跳过，2 个文件失败 |
| 失败原因 | 个人配置中的默认模型 `openai/deepseek-v4.1-flash` 不在注册表，宿主初始化失败；清理又调用未初始化的 `host.dispose()` |
| `pnpm build` | 通过；主 JS 约 1145 KB，gzip 343 KB，有大 chunk 警告 |
| 文档检查 | `git diff --check` 通过；6 份文档的本地 Markdown 链接及行尾空白检查通过；37 个唯一能力 ID 均在 roadmap 分配一次，无遗漏或重复 |
| 中文风格 | 已运行 skill 的 `check-doc-style.py` 并人工逐条检查候选；修改新增文字中的“完成门槛”“全绿”“接线”等表达，保留宿主、契约、归因等项目技术术语及历史标题；脚本仍有候选，未记为全部通过，未修改外部词表 |

没有进行浏览器手工验证、真实模型调用或外部 MCP 连接验证。本次仅做自审，无独立顾问审查；不把源码存在记为端到端已验收。

## 5. 自审与交付

- 能力规范包含 37 项 ID，定义 GUI 等价行为、失败路径与验收要求；roadmap 是唯一状态来源，当前未把任何 ID 记为整项功能已验收。
- roadmap 新增 G1 及阶段，下一迭代为 G1.1；保留原 M3 设计，迁入原 M4 的基础 Pi 能力，M5 延后；旧迭代记录未改写。
- product-design 回写 Pi TUI 替代目标与分支范围；technical-architecture 区分目标与当前实际依赖；todo 更新当前验证结果和限制。
- 本次文档检查完成；运行时基线仍失败，修复在 G1.1。未开展独立顾问 review，该流程偏差如实记录；功能迭代仍须按 roadmap 执行。

## 6. 风险与回退

- 能力规范使用稳定 ID，roadmap 关联 ID；新能力和例外先更新规范与计划，避免以体验优化名义恢复完整 IDE 范围。
- 对未核实 SDK 接口、TUI-only 设置及条件能力显式说明；不得以“SDK 支持”代替 GUI 验收。
- 本次仅修改文档，回退本次文档差异即可恢复原计划；不影响用户数据和运行行为。
