# 幻（huan）— 技术架构文档

**最后更新**：2026-11-02
**状态**：持续维护文档，随技术变更同步更新。当前源码仍为 Controller + aui 混合运行时；已确认目标改为前端统一 Zustand 并移除 assistant-ui，尚未实施。[R1所有权设计](iteration/2026-11/2026-11-02-feat-architecture-remediation-ownership.md)已由用户确认，代码尚未改造；具体协议仍在[R2研究](iteration/2026-11/2026-11-02-feat-architecture-remediation-protocol.md)中核定，本文继续区分现状与目标。整体问题与计划见[整改子路线图](architecture-remediation-roadmap.md)。
**决策依据**：D-01～D-26（见 `docs/tmp/pi_harness_shared_architecture_draft.md` §14）；上游核对见该草案 §16

---

## 1. 技术栈

按 huan 自身需求独立选型（不沿用任何其他项目的技术方案）。

| 领域 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | 全量 TS，无 JS 混写 |
| 前端框架 | React 19 | 函数式组件 + Hooks |
| 构建 | Vite（应用，rolldown 内核）；tsc --noEmit（类型检查） | 开发服务器与生产构建；包零构建直引源码（见 §2 与 dev-guide §4.1） |
| 样式 | Tailwind CSS v4 | Utility-first |
| 基础组件 | shadcn 模式：组件源码拷入项目 | 按钮、对话框、弹层、选择器、折叠等无头逻辑统一用 Base UI；主题 tokens 与紧凑尺度参考末语工坊 |
| 聊天 UI | `@assistant-ui/react`（主题组件经 CLI 拷入） | 当前仍承担会话选择、composer、消息上下文与React绑定；Controller自研不表示前端已解耦 |
| Agent 核心 | `@earendil-works/pi-coding-agent`（Pi SDK） | AgentSession、SessionManager、工具、扩展 |
| 代码查看/Diff | Monaco Editor（规划选型，尚未接入） | 增强阶段的查看 + diff editor（D-21），不作为 Pi GUI 基础依赖 |
| 状态管理 | 当前：Controller自建store、aui及应用Context/模块store；目标：前端业务状态统一Zustand | 旧D-24推迟理由已失效；整改中删除平行存储/订阅机制，不复制旧Controller状态 |
| i18n | Lingui（源语言中文，首期仅中文包） | 编译期宏（D-22/D-25） |
| 包管理 | pnpm workspaces | monorepo；`@huan/*` 命名空间（D-13） |
| 测试 | Vitest | 单元与集成 |
| Lint/Format | Biome（已定，迭代①） | 单工具覆盖 lint + format |
| 许可证 | AGPL-3.0 | 仓库根 `LICENSE` |

**Pi GUI 能力规范**：以 [pi-gui-capabilities.md](pi-gui-capabilities.md) 为能力与验收依据，SDK 接口存在不等于 GUI 已可用；协议、Node服务、Controller 与界面共同承接原生行为。当前基准为 Pi SDK 1.4.0，协议版本为 14（新增MCP配置/管理/详情与独立OAuth操作接口；provider认证及既有重载接口保持）。

**UI 依赖边界（2026-10-31）**：应用自有组件统一使用 Base UI，`apps/harness` 源码与 `package.json` 不直接依赖 `radix-ui` / `cmdk`；`@assistant-ui/react` 内部的间接 Radix 依赖已接受，不维护 fork。主题仅保存在浏览器 localStorage，不写入 Pi 配置或 huan 工作区元数据。

**运行形态（首期）**：Node服务进程（运行 Pi SDK）+ 浏览器 UI（HTTP/SSE 传输）。桌面壳与进程持有方式暂不锁定（D-12）；协议层按可替换传输设计。

---

## 2. 仓库结构与包边界

```
huan/
  AGENTS.md
  LICENSE                   # AGPL-3.0
  package.json              # workspace root
  pnpm-workspace.yaml
  docs/
  packages/
    protocol/               # @huan/protocol：纯 TS 类型 + schema，无运行时依赖
    mcp/                    # @huan/mcp：官方 pi-mcp 之上的 Node 集成层
    core/                   # @huan/core：Pi SDK 集成、运行时生命周期、命令接口（Node）
    react/                  # @huan/react：浏览器侧运行时（reducer/投影/Controller/hook）+ assistant-ui 适配
    history/                # @huan/history：Checkpoint/ChangeSet 接口与关联元数据
  apps/
    harness/                # 通用 Harness 应用（首期：Web UI + Node服务）
```

### 依赖方向（强制）

```
apps/harness
  ├── @huan/core      → Pi SDK（Node）+ @huan/mcp → 官方 pi-mcp / Pi SDK
  ├── @huan/react     → assistant-ui + @huan/protocol
  ├── @huan/history   → @huan/protocol
  └── @huan/protocol  → （无）
```

- `core` / `protocol` 不依赖 React；`react` 不依赖 Node/Rust；`protocol` 无运行时依赖。
- 公共包不得 import 应用内部模块；应用之间无直接代码依赖。
- 平台特殊接口（Electron、Tauri、未来的原生桥）只出现在应用的 `bridge/` 或独立 adapter 包中。

**MCP 集成包边界**：`packages/mcp`（`@huan/mcp`）作为 Node 集成层，依赖官方 `@earendil-works/pi-mcp` 与 Pi SDK 公开 API。它与 Pi 内置 MCP 集成同层，负责管理与 Pi 工具桥接，不替代底层协议库，不依赖 core、React 或应用模块。HTTP/窗口交互归 core/应用，浏览器传输接口归 protocol。当前 core 按 loader/会话持有无界面 integration binding，注入 huan 的 named builtin:mcp；session_start读取共享配置后后台启动唯一manager，Pi工具/资源/权限与codemode/tool_search接入同一组连接。公开扩展MCP注册动态核对，未变化项保留连接；关闭资格同步失效，core在取消/失败/删除/dispose主动回收，重载关闭旧manager后用新上下文启动。core独立mcp-host broker提供配置/临时管理/详情和OAuth操作快照，按runtimeId+identity校验代次并共享每身份认证；OAuth/日志分别落于huan状态目录，官方库负责协议、PKCE与issuer校验，取消等待认证流程结算，刷新轮换写入文件后收尾。GUI由MCP面板提供服务器、配置与认证视图，按目标/请求代次隔离异步结果，关闭面板不取消认证；配置原文进入配置视图才读取，JSON草稿与revision为编辑权威，保存和应用分离。轮询独立于会话SSE，工具详情按需读取；用户/可信项目分别读取 `<agentDir>/mcp.json` / `<cwd>/.pi/mcp.json`，与 Pi TUI 共用服务器配置；凭据/日志仍在 huan 子目录，不共享 Pi 的认证/日志文件，huan 专属设置独立。配置有界读取、逐项校验、revision 防覆盖与单进程串行原子保存；跨进程同时编辑不承诺 CAS，未信任项目不读原文。未来可独立演进或替换为完善后的官方集成，不预建多后端框架；详见[共享配置修订](iteration/2026-11/2026-11-02-feat-mcp-shared-config.md)与[独立集成设计](iteration/2026-11/2026-11-02-feat-mcp-integration.md)。

---

## 3. Agent 运行时架构（@huan/core）

### 3.1 组成

- **Session Host**：以 Pi SDK `createAgentSession` / `AgentSessionRuntime` 为基础，管理会话生命周期（新建、恢复、切换）、事件订阅与清理、模型与 Thinking 配置。
- **Tool & Extension 装配**：按应用 profile 装配工具集、扩展与 inline 扩展；CLI 内置扩展（codemode / tool_search / MCP）需要由应用显式注入（上游核对结论）。
- **Host UI 桥**：绑定 `ExtensionUIContext`，将 `confirm / select / input / editor` 请求传给 UI。版本化应用自定义 `kind` 是早期拟议能力，当前接口未提供。
- **快照投影**：将 Pi 事件映射为 GUI 协议，并生成已加载与未加载会话快照；当前不提供此前文档所称的统一 `rawPiEvent` 透传。

### 3.2 关键语义约束

- Pi `SessionManager` 是已提交消息与分支的权威来源；前端流式状态可乐观显示，以 Pi 完成事件（`message_end` / `agent_settled`）校正。
- 会话切换后事件订阅必须重新绑定；旧订阅不得改写新会话。
- 运行结束的规范边界为 `agent_settled`，不以最后一个 token 或 socket 关闭为准。当前前端在 `agent_end` 提前空闲的问题已登记AR-11，尚未修复。
- Prompt 在流式中必须明确 steer 或 followUp（Pi 语义）；输入队列反映 Pi 的服务端队列，支持整体清空。

### 3.2.1 多项目工作区（已实现）

工作区定义、会话归属、归档标记与未发送树位置由 `<agentDir>/huan/state.json` 管理，Pi 继续管理 cwd、消息和会话树。树位置只在结构操作边界写入 `{ leafId, entryCount }`；冷树、冷快照、冷详情与 `ensureOpen` 统一校验节点存在且条目水位未变后应用，否则以 Pi JSONL 为准。元数据按会话存储作用域与 sessionId 定位，单Node进程串行写入并原子替换文件，持久化成功后才提交内存；具体格式、权威来源和失败规则见[工作区设计 §4](iteration/2026-10/2026-10-31-feat-multi-project-workspaces.md#4-存储与协议)。workspaceId 为稳定身份，session cwd 为固定运行锚点，成员项目 path 为跨目录工具目标；workspacePath 在服务启动选项、会话元数据和模型目录查询中仍表示 cwd；创建输入使用 startProjectPath，工作区归属与列表过滤使用 workspaceId。按工作区查询会话跨越物理 cwd 存储分组，仍遵守既有 sessionDir 与用户空间作用域。

每个运行在 `before_agent_start` 取得已提交的工作区 revision 与成员快照，直到 agent_settled 结算保持稳定；变更在下一轮前应用。仅起始 cwd 装配项目代码与设置，其他成员的扩展/MCP不参与装配。工具、指令与事件状态按会话隔离，不修改进程 cwd。选择性复用 pi-workspaces 的根路径解析和工具委托，作为 huan 内嵌扩展装配；不加载整个插件，不使用其定义存储或自动激活，不要求用户安装。复用保留许可来源，禁止与用户插件重复注册同名工具。具体设计见[工作区迭代](iteration/2026-10/2026-10-31-feat-multi-project-workspaces.md)。当前实现已接入 `workspace-store.ts`、协议工作区类型、服务端 CRUD/归属接口与两级工作区侧栏；实施与验证记录见该迭代 §8，完成状态见 roadmap。

### 3.2.2 会话管理与只读统计

协议 7 的 `getThreadDetails` 按需返回累计统计与活动分支上下文，累计覆盖全文件（含其他分支、已压缩历史和摘要计费）。热会话使用 SDK `getSessionStats`，冷会话通过公开 SessionManager 读取并按 SDK 统计规则聚合，与 SDK 对照测试；冷查询不装配项目资源或请求模型。详情与 token 事件分离，避免流式期间重复聚合。

### 3.2.3 会话树与结构导航

树由公开 `SessionManager.getTree/getEntries/getLeafId` 按需读取，节点使用实际 entryId；快照只携带 `leafId`、`treeRevision`（条目数 + 活动节点指纹）与 `treeOperation`，不随 token 附带整棵树。导航、标签、模型/Thinking、重命名共享每会话结构闸门：占用在 SDK await 前同步完成，发送预检看到闸门时明确拒绝 busy，结构操作与 run admission 不互相等待。运行中导航必须显式 `stopRunning`，先按停止语义失效预检、取回整体队列并等待运行结束；标签写 Pi label entry 后恢复原位置并刷新 sidecar 水位。导航返回的 `editorText` 只交给发起窗口，成功后广播权威快照；sidecar 保存失败时恢复可恢复的位置并如实报告，摘要已追加则标明不可逆。路径与失败边界见[会话树迭代](iteration/2026-10/2026-10-31-feat-session-tree.md)。

归档标记与归属共用原子串行存储，允许未归属会话单独保存 archived；更新归属保留归档，不改工作区 revision。删除文件后清理元数据，跨文件失败报告并支持重试；已知状态损坏时提前拒绝删除。显式刷新重扫当前会话存储作用域，服务端缓存与浏览器响应均防止旧扫描覆盖新结果。设计与验证见[会话管理迭代](iteration/2026-10/2026-10-31-feat-session-management-stats.md)。

### 3.2.4 独立分支与 JSONL 导入

fork/clone 使用独立 `SessionManager` 句柄调用公开 `createBranchedSession(targetLeafId)`，只复制根到目标路径；live 父 manager 不被切换或停止。`before` 目标为用户消息父节点并返回原文供发起窗口编辑，`at` 缺省当前 leaf；无对话路径使用 `SessionManager.create({ parentSession })` 建立空独立会话并继承父会话模型/Thinking。父会话空闲与 expectedRevision 在结构闸门内校验，`session_before_fork` 取消时不创建文件或元数据，子会话独立装配、继承工作区归属但不继承归档。

JSONL 导入先逐行严格解析并校验 header/ID/版本/条目/父链，旧版经公开 `migrateSessionEntries` 迁移，未知扩展条目透传；预览只读文件、目录与冲突，不装配项目。确认时重读源、重算冲突、经既有项目信任入口，再按服务范围串行独占写入；默认保留源 ID 与完整树，冲突副本只改 header ID/cwd/血缘与文件名。上传按 20MiB 限制，路径不使用上传文件名拼接，源文件永不改写；归属保存失败保留可发现的未归属文件并如实报告。协议 7 的 fork/导入路由沿用既有鉴权、Host/Origin 与会话作用域校验。设计与验证见[独立分支与导入迭代](iteration/2026-10/2026-10-31-feat-session-fork-import.md)。

### 3.2.5 运行操作与上下文

用户Shell先发布有界运行态，再通过公开user_bash事件处理结果或自定义operations，普通命令交executeBash；取消覆盖扩展等待窗口。Shell与模型可并存，结构导航/压缩不得越过Shell；完成后用SDK持久历史替代瞬态卡，pendingBashMessages未处理完时保留完成态，断线重连取权威快照。Shell取消独立于模型取消。

手动compact共享结构闸门，abortCompaction取消；压缩错误/原因随事件与快照可见。自动压缩用户默认经独立SettingsManager串行保存、flush与磁盘校验后同步live缓存，不在保存失败时回写旧值。项目覆盖仍生效。模型范围默认会话临时，保存默认是显式操作；选择器禁用范围外模型且保留当前模型展示，刷新代数使各窗重读目录。具体行为与验证见[运行操作](iteration/2026-10/2026-10-31-feat-runtime-operations.md)。

### 3.2.6 命令输入与Host UI

应用拦截内置slash与!命令，core拒绝保留内置被当prompt发送，其余交Pi按扩展→input→skill→模板语义执行。资源目录/参数补全只使用公开SDK；文件搜索限工作区成员，有界BFS并按目录gitignore过滤，不读取个人全局ignore，不预读内容。图片能力在首条/普通发送前校验，4xx未接受发送恢复文字与附件；窗口文字草稿存sessionStorage，附件不持久化。

服务端交互在record发布前承接project_trust与session_start；首次订阅及重连投递seq权威快照，答复/取消/超时/销毁唯一结算。启动装配遇UI等待即先返回服务实例，HTTP可用后同一装配继续，不重跑扩展。线程UI通过host_ui_update独立投递，不清空聊天流；重连快照携带当前通知/status/widget等。有调用方的编辑器指令与命令目标定向窗口，无调用方须主动应用，服务端原子领取防多窗重复；窗口保留原草稿可恢复。模式rpc；终端组件与未交付shutdown显式不支持，ctx.reload 接入同会话资源重载。commandContextActions使用独立record而非替换父会话，setup/血缘/取消和withSession按公开SDK接入。详见[Host UI迭代](iteration/2026-10/2026-10-31-feat-host-ui-startup.md)。

### 3.2.7 设置与资源清单

设置接口仅接受会话 ID 或起始 cwd，配置路径由服务端固定为 agentDir/settings.json 和 cwd/.pi/settings.json。项目原文需要通过信任检查；旧的“无受保护资源”缓存不能授权后来新增的配置。原文有界读取，经公开分发的 Pi settings schema 校验，SDK SettingsManager.fromStorage 只合并本次安全读取的原文。未知字段保留，SHA-256 revision 防止旧窗口覆盖；与既有设置操作共用串行写队列，同目录临时文件原子替换并回读确认。保存只改磁盘，不静默替换 live 模型、设置或资源；重载/重启要求单独说明。

资源清单来自当前 live loader 或已装配缓存的公开 getters，展示来源、指令、系统提示片段、扩展/skill/模板/主题与 packages；配置全文不进入普通消息/快照。文本仅显式请求返回。具体设计见[设置与资源迭代](iteration/2026-11/2026-11-01-feat-settings-resources.md)。

### 3.2.8 同会话资源重载与基础内置装配

`reloadResources` 在现有会话结构闸门内调用公开 `AgentSession.reload`，消息、分支与订阅保持不替换。旧交互与指令结算，重载启动期请求经服务端通道应答；完成状态和资源版本广播使多窗命令目录失效。loader 的公开 reload 包装与首次装配共用信任解析，仅允许本次 bootstrap 用户扩展裁决，不使用旧项目处理器。空白页只重建目标 cwd 的待消费装配，新增受保护资源重新检查信任，不影响同 cwd 的 live 会话。失败可能已关闭旧扩展，明确报告并允许修复后重试。

codemode/tool-search 通过公开工厂按 named builtin/replaceable 装配，遵循 extensions 启停与 defaultTools；无MCP需求时默认不激活，嵌套工具事件保留 parentToolCallId。huan MCP工厂按相同约定装配，按配置exposure激活发现工具（尊重autoEnableCodemode），经SDK动态注册工具与资源；不注入官方MCP工厂。详见[Pi桥接](iteration/2026-11/2026-11-02-feat-mcp-pi-bridge.md)与[重载迭代](iteration/2026-11/2026-11-01-feat-resource-reload-builtins.md)。

### 3.2.9 Provider 认证

共享 ModelRuntime 承接 API key/OAuth 登录与退出；独立认证 broker 管理操作、单步回填与取消，不复用普通 Host UI。回填值只进入内存 resolver，provider 原始错误不进入日志/快照，凭据由 SDK 保存至指定 agentDir/auth.json。状态仅包含 provider、已存凭据类型、方法、授权链接/设备码与受控结果。取消先 abort，SDK 已提交成功则以成功结算；不响应取消的旧调用在完成结算前仍占用该 provider，避免后续凭据操作交错。

浏览器共享认证快照轮询（活动约 1 秒、空闲约 2 秒），只需可用性的组件订阅 authRevision；无订阅者时退订。登录/退出后本地刷新目录，当前模型保持原选择。退出不清除环境变量/models.json 或撤销远端授权。详见[认证迭代](iteration/2026-11/2026-11-02-feat-provider-auth.md)。

### 3.3 react-pi 分步采用记录（D-14）

**React 订阅边界**：`useHarnessActions()` 按 Controller 生命周期返回稳定动作；状态消费者通过字段选择器订阅。完整 extras 仍可读取，但不用于仅执行动作的组件。游离 Host UI 请求的分组结果只随请求数组变化；长期连接直接依赖 Controller。侧栏从公开 assistant-ui 状态选择必要标题与远端 ID，字段未变时保持投影引用；会话行按自身显示字段比较，工作区动作 Context 与数据 Context 分开。关闭的树面板不订阅输入文字。设计与验证见[刷新性能迭代](iteration/2026-11/2026-11-01-perf-react-subscriptions.md)。

**既有M2边界**：以纯 reducer/投影与自研 Controller 移除 react-pi 依赖，`usePiRuntime` 不进入公共 API。当时明确保留 aui 类型与绑定，不代表完全解耦。新目标由整体整改设计确认，Controller现有存储/订阅机制不作为必须保留的边界。

**当前状态（M2 已完成，2026-10-18）**：Node 侧由 `@huan/core` 自研；浏览器侧由 `@huan/react` 自研（reducer / 消息投影 / Controller / 公共 hook / HTTP-SSE 客户端）。apps/harness 已不依赖 `@assistant-ui/react-pi`。当前Controller的发送/投影/repository类型、会话选择、composer与Provider/hook仍绑定`@assistant-ui/react`，Markdown依赖`@assistant-ui/react-markdown`，SSE底层解码直接依赖`assistant-stream/utils`。这些依赖将随整改移除。已确认的整体整改将前端业务状态统一Zustand并移除这些运行依赖，同时整理Node服务/协议/业务/展示/文档；[旧聊天方案](iteration/2026-11/2026-11-02-feat-chat-presentation.md)已失效。总阻塞见roadmap §2.5，细项仅由[子路线图](architecture-remediation-roadmap.md)维护。

**移植来源与许可**：`@huan/react` 的运行时实现移植自 `@assistant-ui/react-pi@0.0.29`（MIT）。相对上游的语义改动与第三方许可声明见 `packages/react/THIRD-PARTY-NOTICES.md` 与迭代文档 `2026-10-18-feat-react-controller.md` §5.1。

**内部子路径依赖已切断**：此前 react-pi 经 `@assistant-ui/core/internal` 等子路径引用上游内部工具（实证脆弱：`RunLeases` 在 core@0.3.21 中不存在，0.3.27 才加入）。`@huan/react` 以 `src/vendor/` 下的本地副本替代（11 个工具）。

react-pi原有能力由公共Controller与应用补齐了树/fork、命令目录与调用。仍保留SDK的整体队列边界、仅图片附件、权威快照恢复（不依赖重放）；完整资源管理已随G1.4交付，整改保留这些功能要求。

---

## 4. 协议与传输（@huan/protocol）

- Node服务与 UI 之间的接口以 Pi 的 `PiClient` 形态为参照（RPC-isomorphic、JSON-safe），复用已有稳定类型的结构。接口定义在 `@huan/protocol` 的 `HarnessClient`。
- 约定：
  - 命令通过类型化方法与HTTP请求/响应对应，当前无统一命令`requestId`；Host UI响应中的`requestId`只关联交互请求。
  - 会话事件信封为`threadId + seq`，工具事件按需携带`toolCallId/parentToolCallId`；当前无统一`sessionId/runId`事件信封。
  - 重连与首次订阅采用同一机制：订阅入口先交付带 `seq` 的权威快照，再在同一连接上接续实时事件（无「先请求快照再连接」的两步间隙）。有 `seq` 可用于发现序号遗漏，但不依赖事件重放。
  - 当前协议常量为14；尚未实现版本协商或不匹配拒绝。未知事件/字段宽容处理，版本策略在整改中核定。
  - 当前Host UI为四种交互及安全投影；版本化应用自定义`kind`尚未实现。
- 传输可替换：首期 HTTP/SSE（官方样例形态）；Electron 主进程共置、Tauri sidecar 或未来本地 IPC 都实现同一 `PiClient` 接口。

### 4.1 多订阅者语义（多窗口并发）

架构明确支持多个 Web 窗口同时订阅同一会话：Node服务持有全窗共享的权威状态，窗口只做呈现与交互入口。已核实 react-pi `ThreadSupervisor` 源码符合此语义：

- `subscribe(threadId, listener)` 将 listener 加入该会话的监听 `Set`；`emit()` 向全部监听者扇出，单监听者抛错不影响其他（内部 try/catch 隔离）。
- 退订只移除该 listener；**断开不等于中止**（源注释："Disconnect ≠ abort: keep the record and its run alive"）。关闭一个窗口不影响其他窗口与运行中任务。
- 后加入的订阅者先收到带 `seq` 的权威快照，再接续实时事件；天然支持新开窗口立即看到完整现状。
- HTTP 层：每个事件连接（SSE）各自 subscribe，断开时 unsubscribe；多窗口即多连接，无单连接限制。

实现时必须处理的三个点：

1. **空闲会话的跨窗实时**：运行时仅打开空闲会话时使用历史读取模式，缺少长期订阅的窗口需刷新才能看到另一窗口发起的运行。当前应用层对「打开的会话视图」使用长期订阅（`PiLiveSubscription`）解决此问题；该能力已在 M2 纳入公共 Controller（`useHarnessController().connect()`）；新建传输订阅始终请求权威快照，关闭后再连也补齐历史；快照仅含 SDK 已提交消息，直接到达的助手 message_end 可独立补齐。
2. **Host UI 并发响应**：两个窗口可能同时响应同一请求，按「先响应生效、重复响应幂等忽略」处理；验证 bridge 对重复 resolve 的实际行为。
3. **窗口本地状态不共享**：各窗口的选中会话、输入草稿、滚动位置等属于本地 UI 状态，默认不跨窗同步；仅经 Pi/服务端的状态（消息、运行状态、Host UI 请求、模型配置）全局一致。

---

## 5. Checkpoint 与 ChangeSet（@huan/history）

### 5.1 三个独立维度（长期有效）

| 维度 | 权威来源 | 代表 | 不负责 |
| --- | --- | --- | --- |
| Conversation History | Pi SessionManager | 消息树、分支、Compaction | 项目文件恢复 |
| Checkpoint | 应用快照 Provider | 某时点可恢复的工作区状态 | 决定 LLM 看到哪个分支 |
| ChangeSet | 差异记录 | 两状态之间的修改/操作集合 | 保证外部副作用可逆 |

**禁止把「跳转 Pi 旧会话节点」等同于「项目自动回退」。** 两者是显式、可独立执行的操作；组合命令需处理未保存改动、运行中的 Agent 与冲突。

### 5.2 内容寻址快照（D-16）

- **存储**：blob（按内容 hash）+ manifest（路径 → hash + 元数据）；应用数据目录下的对象库，不写入工作目录。
- **触发**：run 起止 / 工具调用前后，对受管文件扫描增量。
- **变更来源**：基准快照与变更后快照对比 + run/tool 元数据 → 区分 Agent 改动与用户改动；这是价值核心，任何后端都需自建边界快照。
- **忽略策略**：默认尊重工作区忽略约定（如 `.gitignore`）+ 内置排除（对象库自身、node_modules 等）。
- **外部改动检测**：恢复前比对待恢复文件的实际内容与快照元数据，检测到外部改动时展示冲突并允许取消，不静默覆盖。
- **Git 关系**：不做 Git 依赖、不碰用户 index/暂存区；未来如遇性能瓶颈，Git 仅可作为快照层之上的加速层。

**待细化的边界**（未跟踪/忽略文件、重命名识别、符号链接、权限位、大文件阈值）：在文件快照迭代设计中确定，保留范围见 `roadmap.md` §7。

### 5.3 Provider 接口

```ts
interface CheckpointProvider {
  capture(context: CaptureContext): Promise<CheckpointRef>;
  diff(base: CheckpointRef, target: CheckpointRef): Promise<ChangeSet>;
  restore(target: CheckpointRef, options: RestoreOptions): Promise<RestoreResult>;
}
```

接口需能表达：不支持恢复、部分成功、冲突、需用户确认、恢复中断。选择性恢复能力由 provider capability 声明，不在公共层假定所有实现能力相同。

---

## 6. UI 架构（@huan/react 与 apps/harness）

### 6.1 当前分层与已确认目标

```text
apps/harness（页面、应用业务绑定与布局）
  ├── components：工作区/会话/配置/认证等面板与业务hook
  ├── components/assistant-ui：本地维护的aui展示与编排
  ├── components/ui：Base UI基础组件
  └── @huan/react：transport、reducer/投影、Controller、aui适配与hooks
```

当前没有此前图示的独立features目录，也没有`@huan/react`公共Thread/Composer组件或`rendererId + schemaVersion`注册接口。工具/data渲染使用aui机制与应用本地回退；未知data的可读回退存在遗漏，见整改AR-14/24。

目标为Zustand状态与业务动作、React绑定、展示单向依赖。R1详细方案将公共浏览器状态规范化为serviceStore与windowStore，应用feature store保存面板业务，Node按装配/会话/操作与共享资源所有权分解；包入口、动作时序、资源关闭与旧文件处理见[R1设计](iteration/2026-11/2026-11-02-feat-architecture-remediation-ownership.md)，R1结构已确认，协议细节仍待R2核定。客户端消息/运行/队列以服务端为准，传输失败恢复同步，业务请求保持单次派发；扩展命令通过自己的消息/通知/交互反馈业务结果，公共层不为任意副作用建立确认系统。工具输出保持语义数据，工具内与独立Host UI入口继续可用；专用渲染按当前消费者静态组织。

### 6.2 展示组合原则

聊天展示优先采用shadcn AI Elements的完整组件组合和布局，ReUI按需补充，主题沿用Base UI/Geist/紧凑tokens。当前整体整改将移除aui状态与展示体系，新界面直接绑定最终Zustand状态/动作，保留全部已交付功能，不模拟旧DOM、不套用旧aui编排。滚动、Markdown、附件、消息/data渲染分别设计，不能因保留旧hook而留下另一套运行时。具体方案见整改R7，旧聊天V0不再指导实施。

### 6.3 代码工作区（规划，未实现）

- 布局：可拖拽分栏（文件树 / Monaco 查看 / Diff 审查 / 聊天区）。
- Monaco：`monaco-editor` + 语言支持；diff 使用内置 diff editor；worker 资源在桌面壳下需按打包方式配置（见 `roadmap.md` §7 与 §5.3）。
- 文件树：忽略规则与快照忽略策略共享同一套判定。

---

## 7. 安全模型

| 层 | 措施 |
| --- | --- |
| 通用 Harness | 以用户进程权限运行；敏感操作执行前呈现；提示词约束不作为安全边界 |
| 编辑器 Agent（D-20） | 受控资源加载（不引入用户通用扩展目录）、工具面仅编辑器 API、凭据与工作目录隔离；如实声明为进程内配置约束 |
| 升级项 | OS 级隔离（容器/沙箱）在面向不可信项目或第三方分发时评估 |
| 通用原则 | 工具白名单用于限制模型调用；系统权限由进程及操作系统控制；跨进程/跨应用调用再次校验资源 ID、作用域、权限与参数 |

---

## 8. 兼容性与演进

- **Pi 兼容**：SDK 会话与 CLI 默认行为差异（内置扩展需显式注入等）通过启动配置对照测试保证；升级 Pi 版本前跑 §8.2 回归清单并重审能力规范。
- **用户空间**：默认使用 Pi 空间；显式 agentDir 统一配置与默认会话。sessionDir 按 option → 环境变量 → 启动工作区 setting → 默认 cwd 分组解析，服务创建时固定；平铺覆盖可主动共享，跨 cwd 查找限当前空间。
- **测试空间**：默认自动化使用临时用户空间和确定性 provider；`@huan/core/testing` 为显式测试入口，不从生产主入口导出辅助。个人环境兼容验证单独显式运行。
- **项目与信任**：项目装配先通过公开 ResourceLoader 信任回调，使用所选用户空间 trust.json；未知时仅用户资源、历史只读，GUI 决定后装配项目资源。窗口选中的项目彼此独立，不改变进程 cwd。
- **服务诊断**：受保护的 `getHostInfo` 提供只读目录、配置来源及受控诊断代码；不透传任意扩展错误与凭据。无效默认模型不阻断服务启动或历史读取，可显式选有效模型新建。
- **react-pi / assistant-ui**：现有依赖和移植来源保留历史事实；目标是删除assistant-ui运行依赖，复用代码继续保留许可。公共层当前存在耦合，不能把“适配集中”作为已实现结论。
- **协议与历史**：协议显式版本化；应用元数据（快照引用、关联 ID）支持版本迁移；兼容 Pi 原生 JSONL 会话格式，不修改 Pi 内部历史文件作为存储接口。
- **快照数据**：manifest 带格式版本；对象库可独立重建（孤儿 blob 定期回收）。

### 8.1 JSON-safe 边界（待定策略）

协议声明 JSON-safe，但Node进程内可能出现不可序列化载荷（循环引用、BigInt、函数、Symbol）。当前约定：容忍未知字段，可序列化性由服务端映射层负责（JSON 往返测试覆盖代表性扩展数据）。

**待定**：异常载荷的边界策略（如 BigInt → 字符串、循环引用拒绝或标记为占位）与对应测试；触发条件见 `roadmap.md` §5.1。

### 8.2 依赖升级回归清单

升级 `@earendil-works/pi-coding-agent` / `@assistant-ui/react-pi` / `@assistant-ui/react` 任一版本前，逐项验证下列**行为要求**并跑对应测试：

| 行为要求 | 保护的行为 | 验证方式 |
| --- | --- | --- |
| `preflightResult('started')` 是否仍先于对应 `agent_start` 到达 | 服务端发送的预检/T 运行确认归属（`startingSend` → `currentRun` 移交） | `packages/core/src/host.test.ts` 预检窗口取消用例 |
| 回调抛错是否仍能阻止运行启动 | 退休/取消时的提交点拒绝（`retired` / `cancelled` 抛错路径） | 「预检通过后 dispose：零请求」用例 |
| `agent_start` 时运行已可中止且模型请求尚未发出 | 预检取消不发请求 | 「预检期间取消不产生模型调用」（`fetchCalls === 0`） |
| `agent_settled.aborted` 是否仍为中止意图的权威标志 | 取消/失败判定（取消不误报失败） | 「结算窗口」与「取消不喷掉后续失败」用例 |
| 延迟动作缓冲机制（当前为 `_deferredSettledActions` 私有字段）是否仍存在且语义一致 | 取消/退休时的延迟运行拦截（字段缺失时静默降级，但语义变化需重新设计） | 「shutdown handler 提交的延迟运行不得逃逸」、「SDK 已取走的延迟批次」用例 |
| 消息对象是否仍可能被原地改写（当前为 `_replaceMessageInPlace`） | 快照隔离（`isolateMessages` 的浅复制依据） | 「快照与后续 SDK 改写隔离」用例 |
| 事件联合是否有新增/变更字段 | 映射层穷尽性（编译期 never 检查会报错）与回放 fixture | `pnpm typecheck` + `apps/harness/src/event-replay.test.ts` |
| react-pi 的 reducer 行为（M2 后为 `@huan/react` 的 reducer） | 消费方状态还原 | 回放测试全部通过 |

**原则**：以行为要求为准；升级后若有行为变化，先评估影响再决定适配方案，不直接改断言迁就实现。

---

## 9. 工程与质量

- 测试分层：浏览器使用 Playwright Chromium 验证应用页面与生产路由，单独 `test:e2e`；开发助手通过项目级 Playwright MCP 交互，模型与用户空间均隔离。Node 单元测试覆盖协议序列化、事件归约与投影、快照 diff/恢复核心逻辑；集成测试覆盖会话生命周期、工具调用、重连；回放测试覆盖「映射 → 传输 → 消费方」状态还原。
- 文档与迭代流程见 `AGENTS.md` 与 `docs/roadmap.md`；开发与调试操作指南见 `docs/dev-guide.md`。
