# 待办与迭代历史

**最后更新**：2026-11-02
**状态**：迭代**历史**记录 + **当下**环境/状态快照。

**计划请看 `docs/roadmap.md`**（唯一开发计划权威来源）。本文件只回答两个问题：「已经做过什么」与「现在处于什么状态」。

---

## 1. 当前状态

### 1.1 里程碑位置

- **已完成**：M0 骨架（迭代①）、M1 最小闭环（迭代②）、M1.5 宿主自研（迭代③ + 3 次补丁）、M2 公共层固化（迭代④）
- **当前状态**：`refactor`分支进行整体架构整改的文档与启动调研；原功能主线已阻塞，代码尚未改造。G1.4历史交付保留；G1.3发现结算、草稿、历史与数据回退遗漏，修复记录统一见[整改台账](architecture-remediation-roadmap.md)。
- **实现记录**：`iteration/2026-10/2026-10-31-feat-user-space-reliability.md`；core/harness 已统一 Pi 1.4.0
- **计划入口**：`roadmap.md` §2；能力与验收入口：`pi-gui-capabilities.md`

### 1.2 环境与运行

环境的**唯一权威说明**在 `docs/dev-guide.md`（环境要求、常用命令、启动方式、宿主配置、已知陷阱）。

快速启动（两个终端）：

```bash
pnpm --filter @huan/harness dev:server   # 终端 1：Node 宿主（Pi SDK 运行于此）
pnpm dev                                  # 终端 2：前端 → http://localhost:8799/
```

验证命令：`pnpm check`（已包含测试）、`pnpm build`、`pnpm test:e2e`。主 agent 在架构审查时重跑基线：983 项测试通过、2 项平台测试跳过，lint/全仓类型检查与生产构建通过（既有大 chunk 警告）。完整69条Chromium为G1.4d4历史验证，本轮未重跑全套。会话管理与统计的 review 和验证见 `iteration/2026-10/2026-10-31-feat-session-management-stats.md` §5。自动化使用临时用户空间与确定性模型，不依赖个人 Pi 配置。详细启动方式见 `dev-guide.md` §2 与 §7。

---

## 2. 迭代历史

按时间倒序。每项只记**已完成的事实**与链接；完整设计见对应迭代文档。

### G1.4d4 MCP 管理界面与整体验收（✅ 开发完成，`feat`）

记录：[MCP管理界面](iteration/2026-11/2026-11-02-feat-mcp-gui.md)

- 顶栏与/mcp路由共用Base UI面板，服务器/配置/OAuth交互、临时管理与持久草稿、详情、资源重载、跨窗认证接管已接入真实宿主。
- 主agent独立review修复配置误覆盖、原文按需读取、同目标重开代次、资源条件读取、单工具exposure发现和宽屏样式；补本地stdio/OAuth成功/失败/取消重开与多窗测试。
- 亲验983项通过、2项平台跳过、69条Chromium、check/build与Lingui413。截图已生成但当前环境禁用图片读取，未宣称视觉审阅；e2e独立输出目录完整复跑通过，既有provider-auth偶发断言失败后定向/完整复跑通过。

### G1.4d3 MCP OAuth 与宿主管理接口（✅ 开发完成，`feat`）

记录：[OAuth与宿主接口](iteration/2026-11/2026-11-02-feat-mcp-auth-host.md)

- 协议14，配置/临时管理/详情与独立认证快照/登录/退出/回填/取消接口；官方OAuth之上的凭据/刷新/回调协调与独立日志已接入core，GUI仍未提供。
- 主agent独立review修复多窗/多会话、秘密投影与文件边界，亲验976项通过、2项跳过、63条Chromium及check/build。

### G1.4d2b MCP Pi 工具与资源桥接（✅ 开发完成，`feat`）

记录：[Pi桥接](iteration/2026-11/2026-11-02-feat-mcp-pi-bridge.md)

- core实际按会话注入huan builtin:mcp，后台加载共享配置连接；动态工具/资源、codemode/tool_search、权限管线及扩展注册使用同一manager。创建取消、删除、重载、dispose主动回收；OAuth/日志存储与MCP管理GUI未接入。
- 主agent独立review修复exposure/目录/对账/关闭屏障/信任边界并补回归；亲验935项通过、2项跳过、63条Chromium及check/build。真实SDK/stdio覆盖调用/权限/资源/取消/重载/多会话PID回收。

### G1.4d2a MCP 连接管理（✅ 开发完成，`feat`）

记录：[MCP连接管理](iteration/2026-11/2026-11-02-feat-mcp-connections.md)

- 官方pi-mcp之上每会话独立manager，显式启动、stdio/HTTP、状态订阅、动态目录、临时管理、工具/资源请求与终态关闭；auth仅注入，未接入core/GUI/Pi工具注册。
- 主agent修复生命周期/重连/禁用/目录/认证优先级与命令回收竞态，亲验MCP包117项、全仓877项通过，2项平台跳过及check/build；真实本地transport与子孙进程回收通过，未重跑Chromium。

### MCP 共享配置修订（✅ 开发完成，`feat`）

记录：[共享配置](iteration/2026-11/2026-11-02-feat-mcp-shared-config.md)

- `@huan/mcp` 改为读写 Pi 用户/可信项目的 mcp.json，OAuth 凭据与日志仍独立；不迁移或合并 d1 原隔离路径。保存不自动影响 live，持久配置供双方后续加载。
- 主 agent 独立 review 并补双 scope 保存边界验证，亲验56项配置测试通过、2项平台跳过，全仓816项通过、2项跳过及check/build；未改UI或重跑Chromium。

### G1.4d1 MCP 独立包与配置隔离（✅ 开发完成，`feat`）

记录：[独立 MCP 集成](iteration/2026-11/2026-11-02-feat-mcp-integration.md)

- 初版新增 `@huan/mcp` 配置基础，用户 `<agentDir>/huan/mcp.json`、可信项目 `<cwd>/.huan/mcp.json`，当时不读取/合并/修改 Pi MCP 文件；该存储决定已由上方共享配置修订替代，凭据/日志仍独立。
- 逐项校验与覆盖、revision 防覆盖、有界读取和原子保存；主 agent 修复 scope/timeout 边界并补 I/O 回归，亲验813项通过、2项跳过及check/build。尚未装配 MCP 连接或 GUI。

### G1.4c 模型认证（✅ 开发完成，`feat`）

记录：[模型认证](iteration/2026-11/2026-11-02-feat-provider-auth.md)

- 协议13，指定 agentDir 内 API key/OAuth 登录、状态、回填、取消、退出与多窗接管；认证操作与普通Host UI/聊天隔离。
- 主 agent 修复取消未结算provider锁、轮询生命周期/宿主重启与认证版本订阅，亲验760项测试、63条Chromium、lint/类型/build。

### G1.4b 资源重载与基础内置装配（✅ 开发完成，`feat`）

记录：[资源重载](iteration/2026-11/2026-11-01-feat-resource-reload-builtins.md)

- 协议 12，/reload 与设置面板同会话重载、空白页待消费装配刷新、资源版本/多窗命令目录更新与启动交互应答；codemode/tool-search 按命名内置工厂装配。
- 主 agent 修复重载信任裁决、新增资源门控、空白装配并发/销毁与面板旧响应；亲验 738 项测试、59 条 Chromium、lint/类型/build。MCP 工厂仍未注入。

### G1.4a 设置与资源清单（✅ 开发完成，`feat`）

记录：[设置与资源](iteration/2026-11/2026-11-01-feat-settings-resources.md)

- 协议 11，用户/可信项目 JSON 与常用设置、校验/冲突/原子保存、实际 loader 资源来源与文本按需查询。
- 主 agent 修复安全有界合并、信任缓存与面板并发/草稿，亲验 718 项测试、54 条 Chromium、lint/类型/build；保存只写磁盘，当前会话等待重载。

### 输入与运行态刷新性能（✅ 开发完成，`perf`）

记录：[刷新性能](iteration/2026-11/2026-11-01-perf-react-subscriptions.md)

- 侧栏稳定必要字段投影、按行比较并按需挂载弹层；工作区动作与数据分开订阅。
- runtime actions 按 Controller 保持稳定，输入历史、关闭树面板和 Host UI 避免无关刷新；主 agent 直接修复首条创建/加载时序并补回归。
- 主 agent 亲验 687 项测试、49 条 Chromium、lint/类型/build。250/1,000 条合成历史的输入/流式窗口内，无关行不执行；生产构建按键往返中位数约 33ms，无长任务。

### G1.3b/c 命令输入与Host UI（✅ 开发完成，`feat`）

记录：[命令输入](iteration/2026-10/2026-10-31-feat-command-input.md)、[Host UI与启动交互](iteration/2026-10/2026-10-31-feat-host-ui-startup.md)

- 命令目录/补全与路由、文件引用（嵌套gitignore）、图片粘贴/能力校验、窗口草稿/历史/长输入和显式排队已接入。
- 启动信任/session_start交互可答，宿主通道支持跨窗接管；运行通知/status/widget与原子领取的定向编辑器指令可见，父子会话动作独立。
- 主agent直接修复异步草稿/补全竞态、Shell/设置、独立UI事件避免冲掉流式内容、原子领取与newSession初始化/血缘；累计亲验38文件685项、47条Chromium、lint/类型/build/Lingui299通过。

### G1.3a 运行操作与上下文（✅ 开发完成，`feat`）

记录：[运行操作](iteration/2026-10/2026-10-31-feat-runtime-operations.md)

- 协议 8：Shell 实时输出/取消/`!`与`!!`、压缩状态与失败原因、自动压缩用户设置、模型范围/刷新、Thinking `max` 与输入模态。
- 宿主、HTTP、react 运行时、会话上下文栏“运行操作”面板与数据消息渲染器已接入；Shell/压缩/删除/销毁竞态与设置写盘校验按设计处理。
- 主 agent直接review修复Shell自定义operations、钩子取消、历史替换、设置串行写入/缓存与选择器范围；亲验642项测试、33条Chromium、lint/全仓类型/build/Lingui275通过。后续b/c交付见上文。

### G1.2d 独立分支与 JSONL 导入（✅ 开发完成，`feat`）

记录：[独立分支与导入](iteration/2026-10/2026-10-31-feat-session-fork-import.md)

- 历史消息/树行 fork、上下文栏 clone、路径与浏览器上传导入、cwd 替代、冲突副本/完整树与信任入口已接入。
- 主 agent review 修复源指纹、缺失cwd替代、引用校验、流式上传上限与结构输入保护；亲验598项测试、29条Chromium、lint/类型/构建/Lingui235通过。

### G1.2c 会话树与跨窗导航（✅ 开发完成，`feat`）

记录：[会话树](iteration/2026-10/2026-10-31-feat-session-tree.md)

- 树/标签/过滤、导航和摘要取消、停止并跳转/队列取回、仅发起窗口替换草稿、sidecar 落点恢复已接入。
- 主 agent review 修复并亲验：566 项测试、24 条 Chromium、类型与构建通过。

### G1.2b 会话管理与统计（✅ 开发完成，`feat`）

记录：[会话管理与统计](iteration/2026-10/2026-10-31-feat-session-management-stats.md)

- 工作区范围、名称/首条消息搜索、排序和仅命名过滤；归档保存至 huan state.json，重启保留；删除前显示路径并确认。
- 只读详情区分全文件累计统计与当前分支上下文；冷查询不执行项目扩展或联网。
- 主 agent 修复热详情缺字段、刷新乱序、删除清理重试及名称清空；536 项测试、20 条 Chromium、类型与构建通过。

### Base UI 与末语工坊主题统一（✅ 开发完成，`refactor`）

记录：[UI 迭代](iteration/2026-10/2026-10-31-refactor-base-ui-theme.md)

- 自有组件统一 Base UI，cmdk 已移除；Radix 仅由 assistant-ui 间接引入。主题、Geist 字体与紧凑规格沿用末语工坊。
- 主 agent review 修复模型/Thinking 状态和折叠动画，并补附件回归；517 项测试、16 条 Chromium、类型检查与构建通过。

### 多项目工作区（✅ 开发完成，`feat`）

记录：[工作区迭代](iteration/2026-10/2026-10-31-feat-multi-project-workspaces.md)

- 工作区/会话两级列表，动态项目成员，固定会话 cwd，跨项目工具和指令已接入；state.json 保存定义与会话归属。
- 主 agent review 后修复指令去重、损坏状态运行入口、归档恢复与实际生效版本通知；517 项测试、12 条 Chromium、类型检查与构建通过。

### G1.2a 项目入口与信任（✅ 2026-10-31，`feat`）

记录：`docs/iteration/2026-10/2026-10-31-feat-project-trust.md`

- GUI 路径输入、最近项目、窗口独立选择、信任决定与继续最近已实现；未知信任时项目资源不执行，冷历史可读。
- 主 agent 直接简化重复扩展初始化并验收：480 项 Vitest、9 条 Chromium 流程、类型检查与构建通过。
- 此次原为无UI上下文；G1.3c已补启动交互通道，当前行为见对应记录。

### 浏览器验证基线（✅ 2026-10-31，`test`）

记录：`docs/iteration/2026-10/2026-10-31-test-browser-baseline.md`

- 增加四条真实 Chromium 流程：模型恢复与复制、会话历史、断流恢复、双页面同步。
- 真实生产路由和 Pi SDK 共用隔离启动环境；提供 `dev:e2e`、`test:e2e` 与 Playwright MCP。
- 主 agent 实测四条浏览器测试、464 项 Vitest、类型与构建通过；MCP 导航/页面快照/截图调用通过，图片视觉审阅受当前环境限制。

### G1.1 用户空间与可靠基线（✅ 2026-10-31，`feat`）

记录：`docs/iteration/2026-10/2026-10-31-feat-user-space-reliability.md`

- 统一用户空间与会话存储、隔离默认自动化；Pi 升级到 1.4.0。
- 修复重连遗漏、队列条目复活/并发回滚，以及快照后完成消息遗漏。
- 提供受保护 HostInfo、目录与配置来源、受控诊断代码；默认模型失效仍可启动和读历史。
- 主 agent 完成修复、复查与 464 项测试/类型/构建验证；未执行浏览器手工或个人环境兼容验证。

### Pi GUI 范围与能力规范（✅ 文档交付，2026-10-31，`feat`）

文档：`docs/iteration/2026-10/2026-10-31-feat-pi-gui-scope.md`

- 核对仓库实际 Pi 1.1.0 文档、SDK 声明与源码，建立 `pi-gui-capabilities.md` 的能力 ID 与验收要求。
- 用户确认 Pi GUI 优先，路线图新增 G1；会话分支与 MCP 纳入基础范围，文件快照和工作区增强延后。
- 记录当前检查结果，修正“会话列表无搜索”的旧误记；未修改运行时代码。

### 迭代④ M2 公共层固化（✅ 2026-10-18，`feat`）

文档：`docs/iteration/2026-10/2026-10-18-feat-react-controller.md`

- **`@huan/react` 成熟为公共包**：reducer、消息投影、Host UI 辅助、自研 Controller、公共 hook、HTTP/SSE 客户端、载荷校验；`vendor/` 层本地化全部 11 个上游 internal 工具
- **apps/harness 切换完成**：6 个文件改用 `@huan/react`，`@assistant-ui/react-pi` 依赖已完全移除（0.0.29）
- **移植策略**：发现 react-pi 的 npm 包同时发布原始 TS 源码与完整测试（`files: ["dist","src","README.md"]`），因此采用「复制源码 + 测试，改类型命名空间」而非参照编译产物重写
- **测试覆盖**：上游可移植用例 259 项中覆盖 243 项（94%）——`ThreadController` 75+2、`messageProjection` 34+2、`eventSource` 33+5、`threadState` 23+1、`hostUi` 22、`useHarnessRuntime` 系列 21、`httpClient` 33+6、`disposeControllers` 1；新增 vendor 单测 34 项
- **SSE 链路端到端验证**（roadmap §2.2 退出标准）：`apps/harness/server/sse-link.test.ts` 5 项，覆盖快照优先、live-only 断流恢复、序号重置、同批快照与增量、畸形事件断流恢复；为此把 SSE 路由抽为 `server/sse.ts`
- **回放测试切换到自研 reducer**：23 项 fixture 全复用
- **相对上游的语义改动**（顾问已审查）：`subscribe` 改为单订阅（不做 `sharedStreamCache`，顾问确认不会丢必要事件）；删除 Assistant Cloud 分支；`connect()` 提升为 extras 正式能力（替代应用侧类型断言 hack）
- **第三方许可**：新增 `packages/react/THIRD-PARTY-NOTICES.md`（react-pi / core / store 三方的版权声明与 MIT 全文）
- 全量 `pnpm check` 全绿（87 文件 lint、6 包类型、416 项测试）

### 事件回放验证（✅ 2026-10-18，`test`）

文档：`docs/iteration/2026-10/2026-10-18-test-event-replay.md`

- 回放链路：映射层输出 + 宿主直发事件 → JSON 往返 → 真实消费方 reducer
- fixture 层 22 项 + 集成层 1 项（真实宿主事件流与权威快照对齐）
- **修复**：快照隔离（`snapshotOf` 曾引用 SDK 活跃数组；且 SDK 会 `_replaceMessageInPlace` 原地改写消息对象）
- 变异验证 4 项全部被捕获

### 取消语义收敛与竞态测试（✅ 2026-10-17，`bugfix`）

文档：`docs/iteration/2026-10/2026-10-17-bugfix-cancel-semantics.md`

- **修复真实缺陷**：用户取消后会话被误标为 `failed` 并广播 error 事件
- 取消口径：`agent_settled.aborted` 为权威判据；失败结算移至 `agent_settled`
- 预检取消兜底三层：准入闸门 + 输入守卫扩展（ALS 归属）+ `agent_start` 中止
- 退休收尾：排空在途发送（5s 上限）；延迟动作三层拦截（含 agent 级兜底订阅）
- 9 条竞态用例（8 条经变异验证）

### 宿主标题口径统一（✅ 2026-10-17，`fix`）

提交 `4060a67`：live 路径读**全文件**首条 user 消息，与冷读口径一致（此前用 `getBranch()`，分支场景下与冷读不一致）。

### 迭代③ 公共层宿主自研（✅ 2026-10-17，`feat`）

文档：`docs/iteration/2026-10/2026-10-17-feat-core-host.md`

- `@huan/protocol`：协议类型定义 + 版本策略
- `@huan/core`：`createHarnessHost` 宿主（会话生命周期、事件映射、Host UI 桥、模型目录）
- 装配层：共享 modelRuntime + 按 cwd 每会话独立装配 + 诊断呈现
- **修复两个 supervisor 缺口**：历史会话模型恢复（新/冷语义分离）、模型目录可见（`getAvailableModels`/`setModel` 走真实目录）
- `server/` 迁移（删除 model-resolution）+ 前端模型选择器去 mock
- 端到端验证（API 级）+ 文档

### 迭代② 最小闭环应用（✅ 2026-10-16，`feat`）

文档：`docs/iteration/2026-10/2026-10-15-feat-minimal-loop.md`

- Node 宿主服务（Hono + 官方路由契约 + loopback/Origin/token 安全边界）
- 默认模型解析（加载用户扩展提取 provider 注册，自定义 provider 可用）
- SSE 端点与流式验证（经 Vite 代理逐字输出）
- 前端接入：usePiRuntime + assistant-ui Thread 主题（会话列表、Reasoning 折叠）
- 模型与 Thinking 切换、Host UI 审批闭环、中断 / Steer / Follow-up / 队列展示
- 多窗口实时同步（应用层 `PiLiveSubscription`）、断线恢复
- Lingui 文案接入、`server/` tsconfig 与 typecheck 接入

### 迭代① monorepo 骨架（✅ 2026-10-15，`feat`）

文档：`docs/iteration/2026-10/2026-10-15-feat-monorepo-skeleton.md`

- pnpm workspace、包边界（protocol / core / react / history）、应用脚手架
- 文档体系、构建 / 测试 / lint 工具链

---

## 3. 当下已知限制

当前实现中**用户可感知**的限制（技术债与长期计划见 `roadmap.md` §5）：

| 限制 | 说明 |
| --- | --- |
| 已发现的行为遗漏 | 前端在agent_end提前空闲；异步命令可能清空同会话新输入；其他窗口消息进入本窗输入历史；未知data缺可读回退。归整改AR-11～14，不视为已修复 |
| `settings.json` 修改需重启宿主 | 默认模型在宿主启动时固定解析（`setModel` 的 persist 默认 false）；其他可重载资源按设置面板提示处理 |
| 附件仅图片 | 无其他文件类型支持 |
| 资源管理边界 | 资源清单、配置/重载与命令调用已有入口；终端专属扩展组件按能力规范边界处理 |
| 外部会话并行改写 | 已加载 live 会话由宿主持有，外部 Pi 同时改写同一文件不提供多写者合并 |
| 无文件快照 / 回滚 | 属后续增强能力 |
| 会话搜索范围有限 | 只匹配显式名称与首条用户消息，不含全历史全文检索；支持全部/当前工作区范围与最近活动/创建时间/名称排序 |
| 自定义用户空间 | 配置与默认会话已统一；显式 sessionDir 可主动共享；标准项目资源发现不等于 OS 隔离 |
| MCP共享文件并行编辑 | 与Pi共用服务器定义；revision拒已发生修改，不承诺跨进程CAS，避免双方同时编辑；OAuth/日志独立 |
| 输出操作尚未完整 | 导出/分享等按G1.5验收；reload、认证、设置、MCP、Shell与compact已有入口 |
| 多窗口实时同步依赖应用层长期订阅 | `pi-live-subscription.tsx` 显式保持连接；运行时仅在 running 时自动连接 |

---

## 4. 图例

- 迭代文档命名：`docs/iteration/<YYYY-MM>/<YYYY-MM-DD>-<category>-<name>.md`
- 分类：`feat` / `perf` / `bugfix` / `refactor` / `test`（定义见 `AGENTS.md`）
- ✅ = 已完成（代码 + 自动化检查 + 文档齐备）；桌面手工检查与发布验证不阻塞迭代完成
