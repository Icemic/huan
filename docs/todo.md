# 待办与迭代历史

**最后更新**：2026-11-05
**状态**：迭代**历史**记录 + **当下**环境/状态快照。

**计划请看 `docs/roadmap.md`**（唯一开发计划权威来源）。本文件只回答两个问题：「已经做过什么」与「现在处于什么状态」。

---

## 1. 当前状态

### 1.1 里程碑位置

- **已完成**：M0 骨架（迭代①）、M1 最小可用应用（迭代②）、M1.5 Node运行时自研（迭代③ + 3 次补丁）、M2 公共层固化（迭代④）
- **当前状态**：`refactor` 分支的 R0～R9 开发整改已完成，并按用户确认本地快进合并到main（`377a60a`）：R3～R8 完成 Zustand 浏览器状态、Node/协议、业务动作、管理面板、最终展示与测试迁移，R9 完成文档与证据核对。浏览器业务状态为 Zustand，assistant-ui 运行依赖已移除，协议为 15。R9 主 agent 最终执行 993 项通过、2 项平台跳过、85 条 Chromium、build 与生产预览性能通过；43 项 AR 全部关闭，其中 AR-34 由用户按开发环境/系统问题决定关闭，锁持有者与历史工具异常原因保持未确定。整改总阻塞已解除，G1.5为下一阶段但未启动，未push；详细状态见[整改子路线图](architecture-remediation-roadmap.md)，证据见[R9](iteration/2026-11/2026-11-02-refactor-architecture-remediation-final.md)。
- **当前UI状态**：本轮UI调整已按用户确认开发完成，最终代码提交`e71ea51`，协议17。组件由官方CLI安装，ScrollArea在业务层组合，仅Tabs有注明的最小修正；整改提交为`85eede7`。主agent完整回归：85文件1041项通过、2项平台跳过，102条Chromium与构建通过。回归发现的提前目录查询、关闭按钮和共享测试数据问题已修复；截图未完成读图，视觉审阅未完成。执行事实见[UI调整迭代§5.13](iteration/2026-11/2026-11-03-feat-ui-adjustments.md#513-本轮完整回归)，计划见roadmap §2.3。此后输入区重排、统一动效以及会话树分支折叠/虚拟列表均已完成定向验证，证据见同迭代§5.14～5.17；这些批次未重新执行完整回归。
- **SDK子agent**：已完成[独立迭代](iteration/2026-11/2026-11-04-feat-sdk-subagents.md)，协议18。huan内置subagent通过独立SDK会话执行单个/并行/链式任务，保留完整只读子记录，支持逐任务取消与Host UI应答。固定替代外部同名工具，其他注册及个人文件保持。全仓类型检查、11文件139项定向单测、14条Chromium及定向Biome通过，未运行全仓回归/build。计划与完成状态见roadmap §2.3。
- **实现记录**：`iteration/2026-10/2026-10-31-feat-user-space-reliability.md`；core/harness 已统一 Pi 1.4.0
- **输入区上下文用量**：环形入口及600ms浮窗已接通；命令压缩立即清空输入，停止和状态行取消可用。消息区统一显示进行中/完成/取消/失败，成功摘要可展开且不重复。最新134项定向单测、19条Chromium及全仓类型通过，见[修订记录§5](iteration/2026-11/2026-11-04-feat-composer-context-usage.md#5-压缩取消与消息展示修订方案已确认)。
- **计划入口**：`roadmap.md` §2；能力与验收入口：`pi-gui-capabilities.md`

### 1.2 环境与运行

环境的**唯一权威说明**在 `docs/dev-guide.md`（环境要求、常用命令、启动方式、服务配置、已知陷阱）。

快速启动（两个终端）：

```bash
pnpm --filter @huan/harness dev:server   # 终端 1：Node服务（Pi SDK 运行于此）
pnpm dev                                  # 终端 2：前端 → http://localhost:8799/
```

验证命令：`pnpm check`（已包含测试）、`pnpm build`、`pnpm test:e2e`。最近一次完整UI回归由主agent执行：85文件1041项通过、2项平台跳过，lint/全仓类型检查与生产构建通过（既有大chunk警告）；102条Chromium在8899/8898单worker通过。R9的993项/85条与生产预览性能、G1.4d4的983项/69条均为历史时点。自动化使用临时用户空间与确定性模型，不依赖个人Pi配置。详细启动方式见`dev-guide.md`§2与§7，本轮证据见UI调整§5.13。

---

## 2. 迭代历史

按时间倒序。每项只记**已完成的事实**与链接；完整设计见对应迭代文档。

官方transformer高亮已修正：文件diff按两侧代码语法展示，彩色括号与ANSI前景/背景/装饰已接通；34项单测、6条Chromium及应用类型通过，见[消息流§10](iteration/2026-11/2026-11-04-feat-message-stream-presentation.md#10-官方transformer文件差异语法与ansi)。ANSI空白背景合并及空参数重置的遗漏已修正，2条专项Chromium通过，见同迭代§10.5。两种Shell执行颜色保留已完成，45项相关单测、core/应用类型及6条Shell/消息Chromium通过。追加9条合并回归为7通过、2失败：既有分段流未出现assistant、Chromium新页面崩溃，均保留未确定原因，见同迭代§10.4。

### 子agent三模式调用修复（✅ 开发完成）

记录：[调用修复](iteration/2026-11/2026-11-05-bugfix-subagent-invocation.md)

保留single/parallel/chain，模式按有效内容判断，空占位不再冲突；提示提供示例与用户agent目录，错误指出字段。主agent亲验26项定向测试、core类型与1条Chromium通过，未全仓测试/build；协议19保持。

### 本轮运行速度（✅ 开发完成）

记录：[本轮运行速度](iteration/2026-11/2026-11-05-feat-run-token-speed.md)

主、子agent按最近完整运行自身输出tokens除以含工具等待的总耗时计算，首响应单列；运行中每500ms更新速度、已用时间与首响应，结束后冻结并保存。主agent亲验193项定向单测、后续23项；持续展示修订后58项、全仓类型与1条Chromium通过，截图已读取；协议19，未全仓测试/build。

### 消息代码语法高亮（✅ 开发完成）

记录：[消息流展示§9](iteration/2026-11/2026-11-04-feat-message-stream-presentation.md#9-高亮与工具展示重构)

- Markdown、read/write、编辑片段与实际diff、Shell命令及JSON统一使用Shiki与四主题配色；删除重复语言表及整块规模回退。按实测仅跳过超长单行分词，完整内容与复制保留。
- 主agent亲验30项单测、6条Chromium、应用/server/e2e类型通过，四主题截图已读取。分段流偶发无assistant消息的原因仍未确定，最终同次6条通过；未运行全仓测试/build。首批12项/5条证据保留在§8。

### 消息流展示调整：第一轮（✅ 开发完成）

记录：[消息流展示](iteration/2026-11/2026-11-04-feat-message-stream-presentation.md#7-第一轮实施记录)

- read/write/edit/bash按文件、替换差异与命令专门展示，完整参数和结果可查。
- 用户Shell右侧muted布局，压缩及相关摘要统一14px；subagent卡片保持。
- 后续修正read零值/null、bash空命令/null超时及SDK支持的编辑参数形状；25项单测、3条Chromium与应用类型通过，见同迭代§7.1。
- 主agent亲验40项定向单测、18条Chromium、全仓类型及定向Biome通过；未全仓测试/build，截图未读图。

### 输入区上下文用量与直接压缩（✅ 开发完成）

记录：[上下文用量](iteration/2026-11/2026-11-04-feat-composer-context-usage.md)

- 环形用量与浮窗区分当前上下文及累计统计，颜色按60%/80%切换；立即压缩保留草稿。
- 输入框`/compact [提示词]`直接执行，旧面板仍可编辑指令和取消。
- 初版28项定向单测/18条Chromium保留为历史证据；取消及消息行修订后134项定向单测、19条Chromium、全仓类型与定向Biome通过。协议18未变，未全仓回归/build，明暗截图未读图。

### SDK子agent与Pi CLI依赖清理（✅ 开发完成）

记录：[SDK子agent](iteration/2026-11/2026-11-04-feat-sdk-subagents.md)

- 单次调用最多8项、同时4项，禁止嵌套；模型/工具/工作区与MCP按确认规则继承，连接独立。
- 完整子记录不进入普通会话列表，从父工具打开只读聊天；支持任务级取消及审批应答，费用汇总至父工具。
- 139项定向单测、14条Chromium与全仓类型通过，协议18；未执行全仓测试/build，未读图。

### UI调整与完整回归（✅ 开发完成）

记录：[UI调整](iteration/2026-11/2026-11-03-feat-ui-adjustments.md)

- 完成七页统一设置、全局/工作区模型范围、ScrollArea组合、会话时间投影、输入区+菜单与官方组件重新安装，协议17。
- 完整回归1041项通过、2项平台跳过，102条Chromium与生产构建通过；此后输入区、动画和会话树按批次定向验证，完整回归结果不代表最后提交重新全测。
- 输入区重排、统一120/180ms动画、会话树分支折叠与虚拟列表均已完成，最后提交`e71ea51`；2026-11-04用户确认本轮结束。
- 组件整改提交`85eede7`，截图未完成读图；未push。

### R9 文档与最终证据核对（✅ 开发完成，`refactor`）

记录：[R9最终核对](iteration/2026-11/2026-11-02-refactor-architecture-remediation-final.md)

- 逐项核对 AR-01～43 与 37 个能力 ID，更新主路线图、整改子路线图、技术架构、开发指南、运行状态与 AGENTS 项目速览。
- 记录主 agent 最终执行证据：993 项通过/2 跳过、85 条 Chromium、build 与生产预览性能；补损坏图片、空历史和认证就绪 GUI 证据；视觉未读取。
- AR-34 由用户决定按开发环境/系统问题关闭，保留锁持有者与历史工具异常原因未确定；43 项 AR 全部关闭；随后已按用户确认快进合并到main。
- 只改文档与展示层小范围修正（图片解码提示、空历史与认证就绪证据），协议与服务端行为未变；提交 `126f682`，收尾 `377a60a`；已本地快进合并到main，未push。

### R8 集成回归与最终问题修复（✅ 开发记录，`test`）

记录：[集成回归](iteration/2026-11/2026-11-02-test-architecture-remediation-integration.md)

- 迁移原 69 条浏览器流程的旧定位，新增图片、嵌套工具、editor 原文、回退原因与结算窗口流程；保留多窗、断流、取消和迟到响应断言。
- 主 agent 修正 live 首帧冷读失效、目录合并回退原因、命令草稿版本、工作区关闭重开、输入回焦与资源正文断言。
- 主 agent 最终执行 991 项通过/2 跳过、82 条 Chromium、build 与生产预览性能通过；EBUSY 锁持有者与旧工具异常保留 R9 判断。

### R7 最终聊天展示与依赖清理（✅ 开发记录，`feat`）

记录：[展示接入](iteration/2026-11/2026-11-02-feat-architecture-remediation-presentation.md)

- 官方 shadcn/Base UI 组合接通消息、工具、data、输入与滚动；删除 assistant-ui 状态与运行依赖，保留 MIT 来源。
- 主 agent 修正冷读空缓存、卸载后首帧滚动、主题圆角与声明格式；R8 继续浏览器与性能验证。

### R6 管理业务与面板接入（✅ 开发记录，`refactor`）

记录：[管理业务](iteration/2026-11/2026-11-02-refactor-architecture-remediation-management.md)

- 设置、认证、MCP、模型、运行、工作区、会话与 Host UI 业务进入应用 feature Zustand，面板接通实际入口。
- 主 agent 修正 Host 待答索引、设置资源释放、重载迟到刷新、Shell/压缩 busy 与范围原文。

### R5 Node 所有权与协议（✅ 开发记录，`refactor`）

记录：[Node 与协议](iteration/2026-11/2026-11-02-refactor-architecture-remediation-node.md)

- host 拆为装配、目录、live、协调、事件、操作、导入、配置与模型模块；协议 15、共用 wire 守卫、JSON-safe、会话回退与活动工具快照接入。
- 主 agent 限定 live records 持有、修正 SSE 多 data 行与 JSON 特殊键；core/protocol/react 针对性测试通过。

### R4 提交、队列与分支业务（✅ 开发记录，`feat`）

记录：[业务动作](iteration/2026-11/2026-11-02-feat-architecture-remediation-actions.md)

- 创建、发送、steer/followUp、Shell、图片准备、草稿/历史、停止/取回、树/fork/import 与定向动作进入 Zustand。
- 主 agent 修正派发前取消、创建后目标、未知结果同步、导入 await 失效与同面板并发；未接面板交 R6/R7。

### R3 Zustand 与浏览器运行时（✅ 开发记录，`feat`）

记录：[浏览器运行时](iteration/2026-11/2026-11-02-feat-architecture-remediation-browser.md)

- 建立 service/window store、纯归约、连接资源与 React selector；删除 Controller/aui 公开入口与旧 runtime。
- 主 agent 修正目录版本、取消预检、认证迟到、附件恢复、断流重连与 entryId 投影；应用旧组件暂留 WIP。

### R2 协议与行为规范（设计交付，`feat`）

记录：[R2协议研究](iteration/2026-11/2026-11-02-feat-architecture-remediation-protocol.md)

- 明确服务端权威、提交结果/队列边界、结算/取消、JSON-safe、版本与校验归属；删除无依据的恢复机制。
- [复杂度审查](iteration/2026-11/2026-11-02-refactor-architecture-design-complexity.md)回写删减；后续由 R3～R7 实施。

### R1 状态与资源所有权、目标架构（设计交付，`feat`）

记录：[R1所有权设计](iteration/2026-11/2026-11-02-feat-architecture-remediation-ownership.md)

- 明确服务连接实例的规范化Zustand状态、窗口草稿/提交与应用feature状态；逐项规定创建、持久化、失效、释放及敏感原文处理。
- 给出Node装配/会话/准入/结构/配置服务的唯一持有者、资源转移与关闭矩阵，以及双端文件/API迁移清单。
- 对照子路线图全部43个AR与37个稳定能力ID；本次仅交付文档，未运行业务验证，未改业务代码。

### R0 能力与历史验收盘点（文档交付，`test`）

记录：[R0能力盘点](iteration/2026-11/2026-11-02-test-architecture-remediation-inventory.md)

- 对照37个稳定能力ID、工作区、主题和性能要求，关联实现、现存断言、历史执行与最终验证需求。
- 补登记嵌套工具展示、工具图片、editor预填、结构操作晚响应、模型回退原因和认证提示问题，另登记完整快照省略字段时保留旧值的疑点；具体状态由整改子路线图维护。
- 本次只读源码/测试/历史并修改文档，未运行业务测试、构建或探针。

### G1.4d4 MCP 管理界面与整体验收（✅ 开发完成，`feat`）

记录：[MCP管理界面](iteration/2026-11/2026-11-02-feat-mcp-gui.md)

- 顶栏与/mcp路由共用Base UI面板，服务器/配置/OAuth交互、临时管理与持久草稿、详情、资源重载、跨窗认证接管已接入Node服务。
- 主agent独立review修复配置误覆盖、原文按需读取、同目标重开代次、资源条件读取、单工具exposure发现和宽屏样式；补本地stdio/OAuth成功/失败/取消重开与多窗测试。
- 亲验983项通过、2项平台跳过、69条Chromium、check/build与Lingui413。截图已生成但当前环境禁用图片读取，未宣称视觉审阅；e2e在独立输出目录复测，全部通过；既有provider-auth偶发断言失败后，定向与全套复测均通过。

### G1.4d3 MCP OAuth 与服务管理接口（✅ 开发完成，`feat`）

记录：[OAuth与服务接口](iteration/2026-11/2026-11-02-feat-mcp-auth-host.md)

- 协议14，配置/临时管理/详情与独立认证快照/登录/退出/回填/取消接口；官方OAuth之上的凭据/刷新/回调协调与独立日志已接入core，GUI仍未提供。
- 主agent独立review修复多窗/多会话、秘密投影与文件边界，亲验976项通过、2项跳过、63条Chromium及check/build。

### G1.4d2b MCP Pi 工具与资源桥接（✅ 开发完成，`feat`）

记录：[Pi桥接](iteration/2026-11/2026-11-02-feat-mcp-pi-bridge.md)

- core实际按会话注入huan builtin:mcp，后台加载共享配置连接；动态工具/资源、codemode/tool_search、权限管线及扩展注册使用同一manager。创建取消、删除、重载、dispose主动回收；OAuth/日志存储与MCP管理GUI未接入。
- 主agent独立review修复exposure/目录/注册核对/关闭屏障/信任边界并补回归；亲验935项通过、2项跳过、63条Chromium及check/build。SDK/stdio覆盖调用/权限/资源/取消/重载/多会话PID回收。

### G1.4d2a MCP 连接管理（✅ 开发完成，`feat`）

记录：[MCP连接管理](iteration/2026-11/2026-11-02-feat-mcp-connections.md)

- 官方pi-mcp之上每会话独立manager，显式启动、stdio/HTTP、状态订阅、动态目录、临时管理、工具/资源请求与终态关闭；auth仅注入，未接入core/GUI/Pi工具注册。
- 主agent修复生命周期/重连/禁用/目录/认证优先级与命令回收竞态，亲验MCP包117项、全仓877项通过，2项平台跳过及check/build；本地transport与子孙进程回收通过，未重跑Chromium。

### MCP 共享配置修订（✅ 开发完成，`feat`）

记录：[共享配置](iteration/2026-11/2026-11-02-feat-mcp-shared-config.md)

- `@huan/mcp` 改为读写 Pi 用户/可信项目的 mcp.json，OAuth 凭据与日志仍独立；不迁移或合并 d1 原隔离路径。保存只更新文件，持久配置供双方后续加载。
- 主 agent 独立 review 并补双 scope 保存边界验证，亲验56项配置测试通过、2项平台跳过，全仓816项通过、2项跳过及check/build；未改UI或重跑Chromium。

### G1.4d1 MCP 独立包与配置隔离（✅ 开发完成，`feat`）

记录：[独立 MCP 集成](iteration/2026-11/2026-11-02-feat-mcp-integration.md)

- 初版新增 `@huan/mcp` 配置基础，用户 `<agentDir>/huan/mcp.json`、可信项目 `<cwd>/.huan/mcp.json`，当时不读取/合并/修改 Pi MCP 文件；该存储决定已由上方共享配置修订替代，凭据/日志仍独立。
- 逐项校验与覆盖、revision 防覆盖、有界读取和原子保存；主 agent 修复 scope/timeout 边界并补 I/O 回归，亲验813项通过、2项跳过及check/build。尚未装配 MCP 连接或 GUI。

### G1.4c 模型认证（✅ 开发完成，`feat`）

记录：[模型认证](iteration/2026-11/2026-11-02-feat-provider-auth.md)

- 协议13，指定 agentDir 内 API key/OAuth 登录、状态、回填、取消、退出与多窗接管；认证操作与普通Host UI/聊天隔离。
- 主 agent 修复取消未结算provider锁、轮询生命周期/服务重启与认证版本订阅，亲验760项测试、63条Chromium、lint/类型/build。

### G1.4b 资源重载与基础内置装配（✅ 开发完成，`feat`）

记录：[资源重载](iteration/2026-11/2026-11-01-feat-resource-reload-builtins.md)

- 协议 12，/reload 与设置面板同会话重载、空白页待消费装配刷新、资源版本/多窗命令目录更新与启动交互应答；codemode/tool-search 按命名内置工厂装配。
- 主 agent 修复重载信任裁决、新增资源信任检查、空白装配并发/销毁与面板旧响应；亲验 738 项测试、59 条 Chromium、lint/类型/build。MCP 工厂仍未注入。

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
- 启动信任/session_start交互可答，服务端通道支持跨窗接管；运行通知/status/widget与原子领取的定向编辑器指令可见，父子会话动作独立。
- 主agent直接修复异步草稿/补全竞态、Shell/设置、独立UI事件避免冲掉流式内容、原子领取与newSession初始化/血缘；累计亲验38文件685项、47条Chromium、lint/类型/build/Lingui299通过。

### G1.3a 运行操作与上下文（✅ 开发完成，`feat`）

记录：[运行操作](iteration/2026-10/2026-10-31-feat-runtime-operations.md)

- 协议 8：Shell 实时输出/取消/`!`与`!!`、压缩状态与失败原因、自动压缩用户设置、模型范围/刷新、Thinking `max` 与输入模态。
- 服务端、HTTP、react 运行时、会话上下文栏“运行操作”面板与数据消息渲染器已接入；Shell/压缩/删除/销毁竞态与设置写盘校验按设计处理。
- 主 agent直接review修复Shell自定义operations、钩子取消、历史替换、设置串行写入/缓存与选择器范围；亲验642项测试、33条Chromium、lint/全仓类型/build/Lingui275通过。后续b/c交付见上文。

### G1.2d 独立分支与 JSONL 导入（✅ 开发完成，`feat`）

记录：[独立分支与导入](iteration/2026-10/2026-10-31-feat-session-fork-import.md)

- 历史消息/树行 fork、上下文栏 clone、路径与浏览器上传导入、cwd 替代、冲突副本/完整树与信任入口已接入。
- 主 agent review 修复源指纹、缺失cwd替代、引用校验、流式上传上限与结构输入保护；亲验598项测试、29条Chromium、lint/类型/构建/Lingui235通过。

### G1.2c 会话树与跨窗导航（✅ 开发完成，`feat`）

记录：[会话树](iteration/2026-10/2026-10-31-feat-session-tree.md)

- 树/标签/过滤、导航和摘要取消、停止并跳转/队列取回、仅发起窗口替换草稿、sidecar 树位置恢复已接入。
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

- 增加四条 Chromium 流程：模型恢复与复制、会话历史、断流恢复、双页面同步。
- 生产路由和 Pi SDK 共用隔离启动环境；提供 `dev:e2e`、`test:e2e` 与 Playwright MCP。
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
- **测试覆盖**：上游可移植用例 259 项中覆盖 243 项（94%）：`ThreadController` 75+2、`messageProjection` 34+2、`eventSource` 33+5、`threadState` 23+1、`hostUi` 22、`useHarnessRuntime` 系列 21、`httpClient` 33+6、`disposeControllers` 1；新增 vendor 单测 34 项
- **SSE 端到端验证**（roadmap §2.2 退出标准）：`apps/harness/server/sse-link.test.ts` 5 项，覆盖快照优先、live-only 断流恢复、序号重置、一次接收的快照与增量、畸形事件断流恢复；为此把 SSE 路由抽为 `server/sse.ts`
- **回放测试切换到自研 reducer**：23 项 fixture 全复用
- **相对上游的语义改动**（顾问已审查）：`subscribe` 改为单订阅（不做 `sharedStreamCache`，顾问确认不会丢必要事件）；删除 Assistant Cloud 分支；`connect()` 提升为 extras 正式能力（替代应用侧类型断言 hack）
- **第三方许可**：新增 `packages/react/THIRD-PARTY-NOTICES.md`（react-pi / core / store 三方的版权声明与 MIT 全文）
- 全量 `pnpm check` 通过（87 文件 lint、6 包类型、416 项测试）

### 事件回放验证（✅ 2026-10-18，`test`）

文档：`docs/iteration/2026-10/2026-10-18-test-event-replay.md`

- 回放流程：映射层输出 + 服务端直发事件 → JSON 往返 → 消费方 reducer
- fixture 层 22 项 + 集成层 1 项（服务端事件流与权威快照一致）
- **修复**：快照隔离（`snapshotOf` 曾引用 SDK 活跃数组；且 SDK 会 `_replaceMessageInPlace` 原地改写消息对象）
- 变异验证 4 项全部被捕获

### 取消语义收敛与竞态测试（✅ 2026-10-17，`bugfix`）

文档：`docs/iteration/2026-10/2026-10-17-bugfix-cancel-semantics.md`

- **修复缺陷**：用户取消后会话被误标为 `failed` 并广播 error 事件
- 取消判定：`agent_settled.aborted` 为权威判据；失败结算移至 `agent_settled`
- 预检取消三项保护：准入闸门 + 输入守卫扩展（ALS 归属）+ `agent_start` 中止
- 退休收尾：等待在途发送结束（5s 上限）；延迟动作三项拦截（含 agent 订阅检查）
- 9 条竞态用例（8 条经变异验证）

### 服务端标题读取规则统一（✅ 2026-10-17，`fix`）

提交 `4060a67`：live 路径读**全文件**首条 user 消息，与冷读规则一致（此前用 `getBranch()`，分支场景下与冷读不一致）。

### 迭代③ 公共层Node运行时自研（✅ 2026-10-17，`feat`）

文档：`docs/iteration/2026-10/2026-10-17-feat-core-host.md`

- `@huan/protocol`：协议类型定义 + 版本策略
- `@huan/core`：`createHarnessHost` 服务实例（会话生命周期、事件映射、Host UI 桥、模型目录）
- 装配层：共享 modelRuntime + 按 cwd 每会话独立装配 + 诊断呈现
- **修复两个 supervisor 遗漏**：历史会话模型恢复（新/冷语义分离）、模型目录可见（`getAvailableModels`/`setModel` 使用已注册的模型目录）
- `server/` 迁移（删除 model-resolution）+ 前端模型选择器去 mock
- 端到端验证（API 级）+ 文档

### 迭代② 最小可用应用（✅ 2026-10-16，`feat`）

文档：`docs/iteration/2026-10/2026-10-15-feat-minimal-loop.md`

- Node服务（Hono + 官方路由接口 + loopback/Origin/token 安全边界）
- 默认模型解析（加载用户扩展提取 provider 注册，自定义 provider 可用）
- SSE 端点与流式验证（经 Vite 代理逐字输出）
- 前端接入：usePiRuntime + assistant-ui Thread 主题（会话列表、Reasoning 折叠）
- 模型与 Thinking 切换、Host UI 审批应答、中断 / Steer / Follow-up / 队列展示
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
| 环境与系统异常记录（非待办缺陷） | 历史观察到 provider-auth 偶发 false（已按实际刷新时序修正并复测）、host-reload 清理 EBUSY、默认 e2e 产物 500/trace 消失/Chromium 崩溃与 Vite 旧转换空模块；用户决定按开发环境/系统问题处理，其中锁持有者与异常原因保持未确定。截图未实际读取，不宣称视觉合格；历史行为遗漏已由 R3～R9 修复，证据见 R9 |
| `settings.json` 修改需重启服务 | 默认模型在服务启动时固定解析（`setModel` 的 persist 默认 false）；其他可重载资源按设置面板提示处理 |
| 附件仅图片 | 无其他文件类型支持 |
| subagent扩展兼容 | huan固定使用内置SDK工具，外部同名注册被排除并提示来源，其他工具/事件保留；不保证任意依赖CLI/TUI的扩展自动兼容 |
| 资源管理边界 | 资源清单、配置/重载与命令调用已有入口；终端专属扩展组件按能力规范边界处理 |
| 外部会话并行改写 | 已加载 live 会话由服务端持有，外部 Pi 同时改写同一文件不提供多写者合并 |
| 无文件快照 / 回滚 | 属后续增强能力 |
| 会话搜索范围有限 | 只匹配显式名称与首条用户消息，不含全历史全文检索；支持全部/当前工作区范围与最近活动/创建时间/名称排序 |
| 自定义用户空间 | 配置与默认会话已统一；显式 sessionDir 可主动共享；标准项目资源发现不等于 OS 隔离 |
| MCP共享文件并行编辑 | 与Pi共用服务器定义；revision拒已发生修改，不承诺跨进程CAS，避免双方同时编辑；OAuth/日志独立 |
| 输出操作尚未完整 | 导出/分享等按G1.5验收；reload、认证、设置、MCP、Shell与compact已有入口 |
| 多窗口实时同步 | 打开的会话由浏览器实例 lease 与根订阅维持；最后引用释放后重新打开以权威快照恢复，不保留旧的长期订阅组件 |

---

## 4. 图例

- 迭代文档命名：`docs/iteration/<YYYY-MM>/<YYYY-MM-DD>-<category>-<name>.md`
- 分类：`feat` / `perf` / `bugfix` / `refactor` / `test`（定义见 `AGENTS.md`）
- ✅ = 已完成（代码 + 自动化检查 + 文档齐备）；桌面手工检查与发布验证不阻塞迭代完成
