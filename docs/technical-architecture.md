# 幻（huan）— 技术架构文档

**最后更新**：2026-11-02
**状态**：持续维护文档，随技术变更同步更新。当前实现：浏览器业务状态为 Zustand，Node 服务由 `host/` 模块组合，assistant-ui 运行依赖已移除，协议为 17。R9 的逐项证据见[最终核对记录](iteration/2026-11/2026-11-02-refactor-architecture-remediation-final.md)；整体阻塞与合并决定见[主路线图 §2.5](roadmap.md#25-整体架构整改阻塞子路线图)。
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
| 基础组件 | shadcn/ui官方CLI安装的base-nova组件 | 上游组件文件保持安装结果，业务层组合；主题tokens参考末语工坊，规则见AGENTS.md |
| 聊天 UI | 应用内 shadcn/Base UI 组合 | 消息、输入、工具与 data 展示直接绑定 Zustand；不引入 assistant-ui 运行时 |
| Markdown | `react-markdown` + `remark-gfm` | 应用展示层使用，保留代码块、表格与安全回退 |
| Agent 核心 | `@earendil-works/pi-coding-agent`（Pi SDK） | AgentSession、SessionManager、工具、扩展 |
| 代码查看/Diff | Monaco Editor（规划选型，尚未接入） | 增强阶段的查看 + diff editor（D-21），不作为 Pi GUI 基础依赖 |
| 状态管理 | Zustand | 公共 `serviceStore`/`windowStore` 与应用 feature store；React 只做 selector 绑定，不保留平行存储或订阅机制 |
| i18n | Lingui（源语言中文，首期仅中文包） | 编译期宏（D-22/D-25） |
| 包管理 | pnpm workspaces | monorepo；`@huan/*` 命名空间（D-13） |
| 测试 | Vitest | 单元与集成 |
| Lint/Format | Biome（已定，迭代①） | 单工具覆盖 lint + format |
| 许可证 | AGPL-3.0 | 仓库根 `LICENSE` |

**Pi GUI 能力规范**：以 [pi-gui-capabilities.md](pi-gui-capabilities.md) 为能力与验收依据，SDK 接口存在不等于 GUI 已可用；协议、Node 服务与界面共同承接原生行为。当前基准为 Pi SDK 1.4.0，协议版本为 17；HostInfo 提供 `protocolVersion`，浏览器同版比较，不匹配时停止业务初始化。

**UI依赖边界（2026-11-03）**：基础组件由shadcn官方CLI安装Base UI版本，`components/ui`默认保留生成文件，小范围修正须在修改处附近注释原因与差异；当前仅Tabs补传orientation。业务组合在外层，ScrollArea通过children与布局属性组合，不在上游文件插入滚动结构。全局导入`shadcn/tailwind.css`提供状态变体、`tw-animate-css`提供进出动效，120/180ms时长在CSS变量统一维护并尊重减少动态效果；业务Dialog保持受控Root到退出完成，关闭立即失效异步读取。主题tokens继续由应用维护。模型选择组合官方Combobox，独立思考强度菜单使用官方DropdownMenuRadioGroup；无自写通用Menu/模型选择器。ReUI尚未采用，Shiki由官方CodeBlock安装带入但当前未启用高亮。应用不直接依赖`radix-ui`/`cmdk`，不保留assistant-ui运行时。主题仅保存在浏览器localStorage。来源与版本见[应用许可说明](../apps/harness/THIRD-PARTY-NOTICES.md)，本次实施记录见[UI调整§5.12](iteration/2026-11/2026-11-03-feat-ui-adjustments.md#512-基础组件来源审计与官方安装整改)。

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
    react/                  # @huan/react：transport、纯归约/投影、Zustand 实例/动作与 React selector
    history/                # @huan/history：Checkpoint/ChangeSet 接口与关联元数据
  apps/
    harness/                # 通用 Harness 应用（首期：Web UI + Node服务）
```

### 依赖方向（强制）

```
apps/harness
  ├── @huan/core      → Pi SDK（Node）+ @huan/mcp → 官方 pi-mcp / Pi SDK
  ├── @huan/react     → zustand + @huan/protocol（React 为 peer）
  ├── @huan/history   → @huan/protocol
  └── @huan/protocol  → （无）
```

- `core` / `protocol` 不依赖 React；`react` 不依赖 Node/Rust；`protocol` 无运行时依赖。
- `@huan/react` 根入口提供实例、状态与 React 绑定；`@huan/react/client` 提供 HTTP/SSE transport，`@huan/react/model` 提供纯归约/投影。transport 子入口不依赖 React。
- 公共包不得 import 应用内部模块；应用之间无直接代码依赖。
- 平台特殊接口（Electron、Tauri、未来的原生桥）只出现在应用的 `bridge/` 或独立 adapter 包中。

**MCP 集成包边界**：`packages/mcp`（`@huan/mcp`）作为 Node 集成层，依赖官方 `@earendil-works/pi-mcp` 与 Pi SDK 公开 API。它与 Pi 内置 MCP 集成同层，负责管理与 Pi 工具桥接，不替代底层协议库，不依赖 core、React 或应用模块。HTTP/窗口交互归 core/应用，浏览器传输接口归 protocol。当前 core 按 loader/会话持有无界面 integration binding，注入 huan 的 named builtin:mcp；session_start读取共享配置后后台启动唯一manager，Pi工具/资源/权限与codemode/tool_search接入同一组连接。公开扩展MCP注册动态核对，未变化项保留连接；关闭资格同步失效，core在取消/失败/删除/dispose主动回收，重载关闭旧manager后用新上下文启动。core独立mcp-host broker提供配置/临时管理/详情和OAuth操作快照，按runtimeId+identity校验代次并共享每身份认证；OAuth/日志分别落于huan状态目录，官方库负责协议、PKCE与issuer校验，取消等待认证流程结算，刷新轮换写入文件后收尾。GUI由MCP面板提供服务器、配置与认证视图，按目标/请求代次隔离异步结果，关闭面板不取消认证；配置原文进入配置视图才读取，JSON草稿与revision为编辑权威，保存和应用分离。轮询独立于会话SSE，工具详情按需读取；用户/可信项目分别读取 `<agentDir>/mcp.json` / `<cwd>/.pi/mcp.json`，与 Pi TUI 共用服务器配置；凭据/日志仍在 huan 子目录，不共享 Pi 的认证/日志文件，huan 专属设置独立。配置有界读取、逐项校验、revision 防覆盖与单进程串行原子保存；跨进程同时编辑不承诺 CAS，未信任项目不读原文。未来可独立演进或替换为完善后的官方集成，不预建多后端框架；详见[共享配置修订](iteration/2026-11/2026-11-02-feat-mcp-shared-config.md)与[独立集成设计](iteration/2026-11/2026-11-02-feat-mcp-integration.md)。

---

## 3. Agent 运行时架构（@huan/core）

### 3.1 组成

- **组合根与资源所有权**：`host.ts` 解析固定启动配置、组合服务并暴露 `HarnessClient`；装配、目录、live 会话、操作协调、事件、导入、配置与模型分别由 `host/` 模块持有。
- **Session Host**：以 Pi SDK `createAgentSession` / `AgentSessionRuntime` 为基础，管理会话生命周期（新建、恢复、切换）、事件订阅与清理、模型与 Thinking 配置。
- **Tool & Extension 装配**：按应用 profile 装配工具集、扩展与 inline 扩展；CLI 内置扩展（codemode / tool_search / MCP）需要由应用显式注入（上游核对结论）。
- **Host UI 桥**：绑定 `ExtensionUIContext`，将 `confirm / select / input / editor` 请求传给 UI。版本化应用自定义 `kind` 是早期拟议能力，当前接口未提供。
- **快照投影**：将 Pi 事件映射为 GUI 协议，并生成已加载与未加载会话快照；当前不提供此前文档所称的统一 `rawPiEvent` 透传。live元数据统一从SessionManager的header和全文件记录投影创建时间、最近活动时间、首条用户消息与血缘；活动时间按Pi目录语义取全文件user/assistant消息最大时间戳。列表、HTTP/SSE快照与热详情共用该投影，前端仍按完整快照替换，不保留缺省字段作为补偿。

### 3.2 关键语义约束

- Pi `SessionManager` 是已提交消息与分支的权威来源；前端流式状态可乐观显示，以 Pi 完成事件（`message_end` / `agent_settled`）校正。
- 会话切换后事件订阅必须重新绑定；旧订阅不得改写新会话。
- 运行结束的规范边界为 `agent_settled`，不以最后一个 token 或 socket 关闭为准。浏览器与服务端均保持运行到 `agent_settled`；`agent_end` 只结束当前执行段，后续仍可能重试、压缩或继续。
- Prompt 在流式中必须明确 steer 或 followUp（Pi 语义）；输入队列反映 Pi 的服务端队列，支持整体清空。

### 3.2.1 多项目工作区（已实现）

工作区定义、会话归属、归档标记与未发送树位置由 `<agentDir>/huan/state.json` 管理，Pi 继续管理 cwd、消息和会话树。树位置只在结构操作边界写入 `{ leafId, entryCount }`；冷树、冷快照、冷详情与 `ensureOpen` 统一校验节点存在且条目水位未变后应用，否则以 Pi JSONL 为准。元数据按会话存储作用域与 sessionId 定位，单Node进程串行写入并原子替换文件，持久化成功后才提交内存；具体格式、权威来源和失败规则见[工作区设计 §4](iteration/2026-10/2026-10-31-feat-multi-project-workspaces.md#4-存储与协议)。workspaceId 为稳定身份，session cwd 为固定运行锚点，成员项目 path 为跨目录工具目标；workspacePath 在服务启动选项、会话元数据和模型目录查询中仍表示 cwd；创建输入使用 startProjectPath，工作区归属与列表过滤使用 workspaceId。按工作区查询会话跨越物理 cwd 存储分组，仍遵守既有 sessionDir 与用户空间作用域。

每个运行在 `before_agent_start` 取得已提交的工作区 revision 与成员快照，直到 agent_settled 结算保持稳定；变更在下一轮前应用。仅起始 cwd 装配项目代码与设置，其他成员的扩展/MCP不参与装配。工具、指令与事件状态按会话隔离，不修改进程 cwd。选择性复用 pi-workspaces 的根路径解析和工具委托，作为 huan 内嵌扩展装配；不加载整个插件，不使用其定义存储或自动激活，不要求用户安装。复用保留许可来源，禁止与用户插件重复注册同名工具。具体设计见[工作区迭代](iteration/2026-10/2026-10-31-feat-multi-project-workspaces.md)。当前实现已接入 `packages/core/src/workspace-store.ts`、协议工作区类型、服务端 CRUD/归属接口，以及应用 state 与两级侧栏；实施与验证记录见该迭代 §8，完成状态见 roadmap。

### 3.2.2 会话管理与只读统计

`getThreadDetails` 按需返回累计统计与活动分支上下文，累计覆盖全文件（含其他分支、已压缩历史和摘要计费）。热会话使用 SDK `getSessionStats`，冷会话通过公开 SessionManager 读取并按 SDK 统计规则聚合，与 SDK 对照测试；冷查询不装配项目资源或请求模型。详情与 token 事件分离，避免流式期间重复聚合。

### 3.2.3 会话树与结构导航

浏览器保持服务端先序节点顺序，以O(n)非递归索引生成分叉缩进、折叠与筛选后的可见行。展开ID集合归sessions feature store，首次加载展开活动路径，同leaf刷新保留手动操作；搜索只临时揭示命中分支。虚拟列表采用@tanstack/react-virtual，复用官方ScrollArea唯一Viewport，动态测量包含标签编辑的行高，按可见索引定位；leaf被类型过滤隐藏时定位最近可见祖先。展示状态不写入Pi或sidecar。

树由公开 `SessionManager.getTree/getEntries/getLeafId` 按需读取，节点使用实际 entryId；快照只携带 `leafId`、`treeRevision`（条目数 + 活动节点指纹）与 `treeOperation`，不随 token 附带整棵树。导航、标签、模型/Thinking、重命名共享每会话结构闸门：占用在 SDK await 前同步完成，发送预检看到闸门时明确拒绝 busy，结构操作与 run admission 不互相等待。运行中导航必须显式 `stopRunning`，先按停止语义失效预检、取回整体队列并等待运行结束；标签写 Pi label entry 后恢复原位置并刷新 sidecar 水位。导航返回的 `editorText` 只交给发起窗口，成功后广播权威快照；sidecar 保存失败时恢复可恢复的位置并如实报告，摘要已追加则标明不可逆。路径与失败边界见[会话树迭代](iteration/2026-10/2026-10-31-feat-session-tree.md)。

归档标记与归属共用原子串行存储，允许未归属会话单独保存 archived；更新归属保留归档，不改工作区 revision。删除文件后清理元数据，跨文件失败报告并支持重试；已知状态损坏时提前拒绝删除。显式刷新重扫当前会话存储作用域，服务端缓存与浏览器响应均防止旧扫描覆盖新结果。设计与验证见[会话管理迭代](iteration/2026-10/2026-10-31-feat-session-management-stats.md)。

### 3.2.4 独立分支与 JSONL 导入

fork/clone 使用独立 `SessionManager` 句柄调用公开 `createBranchedSession(targetLeafId)`，只复制根到目标路径；live 父 manager 不被切换或停止。`before` 目标为用户消息父节点并返回原文供发起窗口编辑，`at` 缺省当前 leaf；无对话路径使用 `SessionManager.create({ parentSession })` 建立空独立会话并继承父会话模型/Thinking。父会话空闲与 expectedRevision 在结构闸门内校验，`session_before_fork` 取消时不创建文件或元数据，子会话独立装配、继承工作区归属但不继承归档。

JSONL 导入先逐行严格解析并校验 header/ID/版本/条目/父链，旧版经公开 `migrateSessionEntries` 迁移，未知扩展条目透传；预览只读文件、目录与冲突，不装配项目。确认时重读源、重算冲突、经既有项目信任入口，再按服务范围串行独占写入；默认保留源 ID 与完整树，冲突副本只改 header ID/cwd/血缘与文件名。上传按 20MiB 限制，路径不使用上传文件名拼接，源文件永不改写；归属保存失败保留可发现的未归属文件并如实报告。fork/导入路由沿用既有鉴权、Host/Origin 与会话作用域校验。设计与验证见[独立分支与导入迭代](iteration/2026-10/2026-10-31-feat-session-fork-import.md)。

### 3.2.5 运行操作与上下文

用户Shell先发布有界运行态，再通过公开user_bash事件处理结果或自定义operations，普通命令交executeBash；取消覆盖扩展等待窗口。Shell与模型可并存，结构导航/压缩不得越过Shell；完成后用SDK持久历史替代瞬态卡，pendingBashMessages未处理完时保留完成态，断线重连取权威快照。Shell取消独立于模型取消。

手动compact共享结构闸门，abortCompaction取消；压缩错误/原因随事件与快照可见。自动压缩用户默认经独立SettingsManager串行保存、flush与磁盘校验后同步live缓存，不在保存失败时回写旧值。项目覆盖仍生效。模型范围由Pi用户enabledModels提供全局默认，huan工作区modelPatterns完整覆盖；项目enabledModels不再参与候选筛选。全局模型页与工作区管理使用完整目录，输入区、新建与主动切换使用最终候选。已有会话按原模型继续使用与发送，目录版本推进使订阅窗口重读候选。工作区覆盖存于原state.json，复用工作区revision；模型目录查询按工作区、完整目录标记与既有版本区分。具体设计见[UI调整§5.6](iteration/2026-11/2026-11-03-feat-ui-adjustments.md#56-两层模型范围产品规则)。

### 3.2.6 命令输入与Host UI

应用拦截内置slash与!命令，core拒绝保留内置被当prompt发送，其余交Pi按扩展→input→skill→模板语义执行。资源目录/参数补全只使用公开SDK；文件搜索限工作区成员，有界BFS并按目录gitignore过滤，不读取个人全局ignore，不预读内容。图片能力在首条/普通发送前校验；明确拒绝保留输入，HTTP异常按结果未知保留输入并同步，不能根据4xx推断业务副作用未发生；窗口文字草稿存sessionStorage，附件不持久化。

服务端交互在record发布前承接project_trust与session_start；首次订阅及重连投递seq权威快照，答复/取消/超时/销毁唯一结算。启动装配遇UI等待即先返回服务实例，HTTP可用后同一装配继续，不重跑扩展。线程UI通过host_ui_update独立投递，不清空聊天流；重连快照携带当前通知/status/widget等。有调用方的编辑器指令与命令目标定向窗口，无调用方须主动应用，服务端原子领取防多窗重复；窗口保留原草稿可恢复。模式rpc；终端组件与未交付shutdown显式不支持，ctx.reload 接入同会话资源重载。commandContextActions使用独立record而非替换父会话，setup/血缘/取消和withSession按公开SDK接入。详见[Host UI迭代](iteration/2026-10/2026-10-31-feat-host-ui-startup.md)。

### 3.2.7 设置与资源清单

设置接口接受显式global目标、会话ID或起始cwd。global只读取/保存agentDir/settings.json，不查询项目路径或信任；项目/会话配置路径固定为cwd/.pi/settings.json。项目原文需要通过信任检查；旧的“无受保护资源”缓存不能授权后来新增的配置。原文有界读取，经公开分发的Pi settings schema校验，SDK SettingsManager.fromStorage只合并本次安全读取的原文。未知字段保留，SHA-256 revision防止旧窗口覆盖；与既有设置操作共用串行写队列，同目录临时文件原子替换并回读确认。全局模型范围保存推进候选目录，自动压缩保存复用live设置缓存同步并保留项目覆盖；其余字段继续按重载/重启要求生效，live模型保持原选择。

应用settings-ui-store仅保存统一设置open/page，组合根编排按页加载与认证短期清理。七个垂直页签共用一个Dialog；用户JSON草稿仍由settings feature持有，MCP配置草稿由mcp feature持有。项目配置和会话实际资源分别通过明确目标入口读取，global MCP配置不创建连接。基础视觉组合直接采用官方base-nova源码，必要路径、方向选择器和token适配记录在应用第三方说明。

资源清单来自当前 live loader 或已装配缓存的公开 getters，展示来源、指令、系统提示片段、扩展/skill/模板/主题与 packages；配置全文不进入普通消息/快照。文本仅显式请求返回。具体设计见[设置与资源迭代](iteration/2026-11/2026-11-01-feat-settings-resources.md)。

### 3.2.8 同会话资源重载与基础内置装配

`reloadResources` 在现有会话结构闸门内调用公开 `AgentSession.reload`，消息、分支与订阅保持不替换。旧交互与指令结算，重载启动期请求经服务端通道应答；完成状态和资源版本广播使多窗命令目录失效。loader 的公开 reload 包装与首次装配共用信任解析，仅允许本次 bootstrap 用户扩展裁决，不使用旧项目处理器。空白页只重建目标 cwd 的待消费装配，新增受保护资源重新检查信任，不影响同 cwd 的 live 会话。失败可能已关闭旧扩展，明确报告并允许修复后重试。

codemode/tool-search 通过公开工厂按 named builtin/replaceable 装配，遵循 extensions 启停与 defaultTools；无MCP需求时默认不激活，嵌套工具事件保留 parentToolCallId。huan MCP工厂按相同约定装配，按配置exposure激活发现工具（尊重autoEnableCodemode），经SDK动态注册工具与资源；不注入官方MCP工厂。详见[Pi桥接](iteration/2026-11/2026-11-02-feat-mcp-pi-bridge.md)与[重载迭代](iteration/2026-11/2026-11-01-feat-resource-reload-builtins.md)。

### 3.2.9 Provider 认证

共享 ModelRuntime 承接 API key/OAuth 登录与退出；独立认证 broker 管理操作、单步回填与取消，不复用普通 Host UI。回填值只进入内存 resolver，provider 原始错误不进入日志/快照，凭据由 SDK 保存至指定 agentDir/auth.json。状态仅包含 provider、已存凭据类型、方法、授权链接/设备码与受控结果。取消先 abort，SDK 已提交成功则以成功结算；不响应取消的旧调用在完成结算前仍占用该 provider，避免后续凭据操作交错。

浏览器共享认证快照轮询（活动约 1 秒、空闲约 2 秒），只需可用性的组件订阅 authRevision；无订阅者时退订。登录/退出后本地刷新目录，当前模型保持原选择。退出不清除环境变量/models.json 或撤销远端授权。详见[认证迭代](iteration/2026-11/2026-11-02-feat-provider-auth.md)。

### 3.3 浏览器状态与移植来源

**当前边界**：`@huan/react` 的 `client/` 只做 HTTP/SSE transport；`model/` 是纯归约、消息展示、Host UI 与图片准备算法，不导入 React；`browser/` 由 `createHarnessBrowser` 组合 `serviceStore`、`windowStore`、`sessionActions` 与资源所有者；`react/` 只提供实例 Context、selector hooks 与 lease 绑定。组件不经过已删除的 extras/Controller，也不持有 Context 状态副本。

**订阅与释放**：应用 feature store 保存面板、草稿、查询与提交结果；公共 service store 保存目录、会话运行数据、认证/MCP 安全快照与目录查询。打开会话的 live 订阅由 `acquireThreadLease` 持有，根订阅由 `acquireRoot` 持有；最后引用在微任务确认后释放连接与完整会话缓存，目录元数据、窗口草稿和已提交内容保留。流式 `message_update`/`tool_execution_update` 按帧合并，终结和交互事件立即应用。

**历史迁移**：M2 曾以自研 Controller、aui runtime/types/extras 与仓库内展示编排实现浏览器运行时（历史来源：`@assistant-ui/react-pi@0.0.29`）。R3～R7 已删除这些状态与运行依赖，将业务状态迁入 Zustand，并以应用内 shadcn/Base UI 组合接通展示。旧路径 `packages/react/src/runtime/thread-controller.ts`、`packages/react/src/runtime/use-harness-runtime.ts` 与 `apps/harness/src/components/assistant-ui/*` 仅存在于历史记录，当前入口不包含这些路径。

**移植来源与许可**：`@huan/react` 仍包含从 `@assistant-ui/react-pi@0.0.29` 与 `@assistant-ui/core@0.3.27` 移植的 MIT 代码；`@huan/protocol` 包含 R5 从 react-pi 迁入的 wire 守卫。声明见 `packages/react/THIRD-PARTY-NOTICES.md`、`packages/protocol/THIRD-PARTY-NOTICES.md` 与 `packages/core/THIRD-PARTY-NOTICES.md`。`@huan/react` 的 `src/vendor/anti-corruption.ts` 保存仍有消费者的本地工具；R5 将 wire 守卫迁入 `@huan/protocol`。

---

## 4. 协议与传输（@huan/protocol）

- Node 服务与 UI 之间的接口为 JSON-safe 的 `HarnessClient`，按 host、认证、MCP、工作区、目录、会话与配置领域组合，不提供通用 RPC。
- 约定：
  - 命令通过类型化方法与 HTTP 请求/响应对应，无统一命令 `requestId`；Host UI 响应中的 `requestId` 只关联交互请求。
  - 会话事件信封为 `threadId + seq`，工具事件按需携带 `toolCallId/parentToolCallId`；无统一 `sessionId/runId` 事件信封。
  - 重连与首次订阅采用同一机制：订阅入口先交付带 `seq` 的权威快照，再在同一连接上接续实时事件。`seq` 可用于发现序号遗漏，但不依赖事件重放。
  - 协议常量为 17；HostInfo 提供 `protocolVersion`，浏览器启动时同版比较，不匹配时停止业务初始化。没有协议版本范围协商、每请求版本身份头或旧版兼容层；未知事件/字段保持宽容。
  - Host UI 为四种交互及安全投影；版本化应用自定义 `kind` 尚未实现。
- 传输可替换：首期 HTTP/SSE；Electron 主进程共置、Tauri sidecar 或未来本地 IPC 都实现同一 `HarnessClient` 接口。

### 4.1 多订阅者语义（多窗口并发）

架构明确支持多个 Web 窗口同时订阅同一会话：Node 服务持有全窗共享的权威状态，窗口只做呈现与交互入口。早期实现核对过 react-pi `ThreadSupervisor` 的扇出语义，当前实现沿用相同行为：

- `subscribe(threadId, listener)` 将 listener 加入该会话的监听 `Set`；`emit()` 向全部监听者扇出，单监听者抛错不影响其他（内部 try/catch 隔离）。
- 退订只移除该 listener；**断开不等于中止**（源注释："Disconnect ≠ abort: keep the record and its run alive"）。关闭一个窗口不影响其他窗口与运行中任务。
- 后加入的订阅者先收到带 `seq` 的权威快照，再接续实时事件；天然支持新开窗口立即看到完整现状。
- HTTP 层：每个事件连接（SSE）各自 subscribe，断开时 unsubscribe；多窗口即多连接，无单连接限制。

实现时必须处理的三个点：

1. **空闲会话的跨窗实时**：打开的会话视图通过浏览器实例的 `acquireThreadLease` 保持 live 订阅，根组件通过 `acquireRoot` 持有根订阅；最后引用释放后，重新打开以权威快照恢复。新建传输订阅始终请求快照，关闭后再连也补齐历史；快照仅含 SDK 已提交消息，直接到达的助手 message_end 可独立补齐。
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
  ├── components：工作区/会话/配置/认证面板与聊天展示
  ├── components/ui：官方安装的shadcn base-nova组件
  ├── state：应用 feature Zustand store 与 bootstrap
  └── @huan/react：transport、纯归约/投影、Zustand 实例/动作与 React selector
```

当前分层只有应用内静态展示组件与公共 selector；没有 `@huan/react` 公共 Thread/Composer 组件，也没有 `rendererId + schemaVersion` 注册接口。消息、工具与 data 由 `apps/harness/src/components/chat/` 按当前消费者静态分发，未知 data 走可读回退。

客户端消息、运行、队列与目录以 Node 服务为准；传输失败先恢复同步，业务请求保持单次派发。窗口选择、草稿由公共windowStore持有，面板由应用feature store持有；扩展命令通过自己的消息/通知/交互反馈业务结果，公共层不为任意副作用建立确认系统。

### 6.2 展示组合原则

聊天展示采用官方 shadcn/Base UI 组合，主题沿用 Base UI/Geist/紧凑 tokens；消息、Thinking、工具过程、附件、输入组与代码展示均在应用内组合。滚动、Markdown、附件、消息/data 渲染分别实现，保留单一滚动容器与单一输入框。展示绑定 Zustand 状态/动作，不保留 aui 编排或第二套运行时；视觉判断以实际读取产物为前提。旧聊天 V0 不再指导实施。

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
- **浏览器运行时与移植来源**：assistant-ui 运行依赖已删除；从 react-pi/core 移植的代码继续保留 MIT 许可，当前依赖与入口见 §2/§3.3。
- **协议与历史**：协议显式版本化；应用元数据（快照引用、关联 ID）支持版本迁移；兼容 Pi 原生 JSONL 会话格式，不修改 Pi 内部历史文件作为存储接口。
- **快照数据**：manifest 带格式版本；对象库可独立重建（孤儿 blob 定期回收）。

### 8.1 JSON-safe 边界

协议声明 JSON-safe，但 Node 进程内可能出现不可序列化载荷。`packages/core/src/host/json-safe.ts` 只在事件/快照输出边界处理扩展数据：BigInt 转为十进制字符串，非有限数字与数组中的 undefined 转为 null，对象中的 undefined/function/symbol 省略；当前祖先循环或编码异常转为可读的“不支持的扩展数据”标记。普通共享引用不当作循环。该处理不改变 SDK 执行参数、Pi 历史或已知协议字段；秘密识别仍由认证/配置领域负责。测试见 `packages/core/src/host/json-safe.test.ts`。

### 8.2 依赖升级回归清单

升级 `@earendil-works/pi-coding-agent`、`@huan/react` 或 `@huan/protocol` 前，逐项验证下列**行为要求**并跑对应测试：

| 行为要求 | 保护的行为 | 验证方式 |
| --- | --- | --- |
| `preflightResult('started')` 是否仍先于对应 `agent_start` 到达 | 服务端发送的预检/T 运行确认归属（`startingSend` → `currentRun` 移交） | `packages/core/src/host.test.ts` 预检窗口取消用例 |
| 回调抛错是否仍能阻止运行启动 | 退休/取消时的提交点拒绝（`retired` / `cancelled` 抛错路径） | 「预检通过后 dispose：零请求」用例 |
| `agent_start` 时运行已可中止且模型请求尚未发出 | 预检取消不发请求 | 「预检期间取消不产生模型调用」（`fetchCalls === 0`） |
| `agent_settled.aborted` 是否仍为中止意图的权威标志 | 取消/失败判定（取消不误报失败） | 「结算窗口」与「取消不喷掉后续失败」用例 |
| 延迟动作缓冲机制（当前为 `_deferredSettledActions` 私有字段）是否仍存在且语义一致 | 取消/退休时的延迟运行拦截；`host/shared.ts` 的 `discardDeferredRuns` 集中补偿，字段缺失时输出一次受控诊断并由 `agent_start` 清扫 | 「shutdown handler 提交的延迟运行不得逃逸」「SDK 已取走的延迟批次」用例；诊断路径见 `host/shared.ts` |
| 消息对象是否仍可能被原地改写（当前为 `_replaceMessageInPlace`） | 快照隔离（`isolateMessages` 的浅复制依据） | 「快照与后续 SDK 改写隔离」用例 |
| 事件联合是否有新增/变更字段 | 映射层穷尽性（编译期 never 检查会报错）与回放 fixture | `pnpm typecheck` + `apps/harness/src/event-replay.test.ts` |
| 浏览器归约/投影行为（`@huan/react` 的 `model/`） | 消费方状态还原 | `packages/react/src/model/*.test.ts` 与 `apps/harness/src/event-replay.test.ts` |

**原则**：以行为要求为准；升级后若有行为变化，先评估影响再决定适配方案，不直接改断言迁就实现。

---

## 9. 工程与质量

- 测试分层：浏览器使用 Playwright Chromium 验证应用页面与生产路由，单独 `test:e2e`；开发助手通过项目级 Playwright MCP 交互，模型与用户空间均隔离。Node 单元测试覆盖协议序列化、事件归约与投影、会话快照恢复；集成测试覆盖会话生命周期、工具调用、重连；回放测试覆盖「映射 → 传输 → 消费方」状态还原。R9 最终执行 82 文件 993 项通过、2 项平台跳过、85 条 Chromium；当前证据见[R9](iteration/2026-11/2026-11-02-refactor-architecture-remediation-final.md)。
- 文档与迭代流程见 `AGENTS.md` 与 `docs/roadmap.md`；开发与调试操作指南见 `docs/dev-guide.md`。
