# G1.2b 会话管理与统计

- 日期：2026-10-31
- 分类：feat
- 能力：SES-02、SES-03；SES-01 管理入口补充
- 依据：Pi 1.4.0；项目/会话阶段设计 §5、工作区设计 §4

## 1. 目标与范围

在现有工作区一级、会话二级列表上补齐明确范围的搜索、排序、仅命名过滤、外部文件刷新、删除确认、持久归档与只读详情。不加入树导航或 fork/clone/import；沿用 Base UI 与紧凑主题。

搜索明确限定显式名称和首条用户消息（不是全文）。保留现有多工作区同时展示的默认行为，范围控件提供“全部工作区（含未归属）”和“当前工作区”；选中范围可见。排序支持最近活动降序、创建时间降序、名称升序，同值以 ID 稳定排序。“继续最近”始终按活动时间选未归档会话，不受名称排序或搜索影响。列表条目展示 cwd、活动时间（可用紧凑副行/悬浮完整路径），命名状态独立于回退标题。

## 2. 数据与接口

### 2.1 归档元数据

在既有 `<agentDir>/huan/state.json` 的 `sessionMetadata[storeId][sessionId]` 增加可选 `archived`；`workspaceId` 改可选，支持未归属会话持久归档。本次扩展沿用开发期 version 1，不迁移文件。归属更新必须保留归档；归档/恢复不改工作区 revision，也不改 Pi JSONL；损坏/未知版本状态禁止写入。仍复用同一串行原子写队列，落盘成功后广播快照。删除成功后清除该会话元数据；文件删除与 sidecar 不承诺跨文件事务，失败需报告，不伪造成功。

### 2.2 列表刷新

扩展 `listThreads` 输入 `refresh`，显式刷新及窗口重新聚焦时清除并重新扫描作用域缓存；普通操作沿用已存在失效机制。扫描期间旧 promise 不得覆盖新缓存。列表元数据增加独立 `name` 与首条消息搜索字段，冷/热均按全文件口径。所有现有客户端/fake client、HTTP 与协议版本同步。

外部 Pi 修改只读目录可刷新；不以目录刷新替换运行中的 live SessionManager。已加载 live 会话由宿主持有，外部同时改写该文件不提供多写者合并保证。

### 2.3 只读详情

新增 `getThreadDetails(threadId)` 与受保护 HTTP 接口，返回元数据、全部条目累计统计、当前活动分支上下文。展示 ID、路径、cwd、工作区、父会话、创建/活动时间、模型、用户/助手/工具结果/工具调用数量、输入/输出/缓存读写/总 token、累计费用（USD）、上下文估计与窗口。

热会话直接使用 SDK `getSessionStats()` / `getContextUsage()`。冷会话只打开作用域校验后的 SessionManager，按 SDK 1.4.0 全条目聚合规则实现小型函数，覆盖 assistant、toolResult、usage、compaction、branch_summary 的 usage；用真实 SDK 输出对照，避免构造带资源装配的临时 AgentSession。当前上下文继续复用现有 `deriveContextUsage` 与本地模型目录；未知模型窗口明确显示不可用，压缩后未知 tokens 显示未知，不填零。

详情按需请求，打开/手动刷新时更新；不在每 token 更新中反复聚合整棵树，不加入全历史索引。弹层请求切换/卸载时防止旧结果串入。

## 3. GUI 行为

列表提供可见范围、排序、仅命名与归档过滤，中文文案经 Lingui。所有会话（含未归属）都可查看详情、改名、归档/恢复、删除；未归属仍保留明确加入工作区入口。删除必须先经 Base UI Dialog 确认，显示名称与完整文件路径，说明运行中会停止任务并永久删除会话文件，取消不写数据；不删除项目文件。操作错误可见，运行中删除复用现有退役机制。

归档是组织标记，重启后保留，不停止任务。当前窗口离开归档会话仅改变视图，其他窗口不受影响。详情只读，不通过订阅隐式激活冷会话。

## 4. 验证与回退

- Store：归档重启恢复、未归属归档/再归属保留、storeId 隔离、原子写失败与损坏保护、删除清理。
- Core：外部新增/删除/改名显式刷新；冷热 name/首消息一致；统计对照真实 SDK，含其他分支、压缩/摘要/usage/tool usage；冷读无扩展执行/网络；未知模型与压缩后未知上下文。
- HTTP/client：新输入/详情往返、安全中间件、错误传播；协议升级更新相关测试。
- Chromium：原有 16 条全保留，补搜索范围/排序/命名、外部刷新、详情/归档恢复、删除取消及确认。测试只用临时用户空间与合成模型。
- 主 agent 直接 review、修复并执行 check/build/lingui/e2e，文档记录实际证据；不以页面 reload 掩盖状态不更新。

回退本轮源码/协议/UI 即可；Pi JSONL 格式不变。归档仅在 huan sidecar，移除 sidecar 会丢 huan 组织信息，不作为常规回退操作。后续树落点保持独立迭代。

## 5. 开发实施与验证记录

主体编码由 `opencode-go/deepseek-v4.1-flash`（reasoning=max）完成，开始时确认三个模型环境变量。主 agent 已独立 review、直接修复并完成最终自动化验证；以下表格为主 agent 实测结果。

### 5.1 已实现范围

- 协议（`packages/protocol`）：`HarnessThreadMetadata` 增加独立 `name` 与 `firstMessageText`；新增 `HarnessThreadStats` / `HarnessThreadDetails`；`HarnessClient.listThreads` 增加 `refresh`，新增 `getThreadDetails`；协议版本 4 → 5。
- 元数据（`packages/core/src/workspace-store.ts`）：`sessionMetadata[storeId][sessionId]` 的 `workspaceId` 改为可选并新增可选 `archived`；新增 `setSessionArchived`、`removeSessionMetadata`；归属更新保留归档；归档/恢复不改 revision；清空归档且无归属时删除空条目；损坏/未知版本仍禁止一切写入。文件格式继续 version 1。
- 冷统计（`packages/core/src/session-stats.ts`）：按 SDK 1.4.0 `getSessionStats()` 口径聚合 `getEntries()`：`usage`、`compaction`/`branch_summary` 自带 usage、`assistant` usage 与 toolCall 计数、`toolResult` usage；字段缺失按 0 容错。未深导入 SDK 子路径，也未构造临时 AgentSession。
- 宿主（`packages/core/src/host.ts`）：移除内存归档集合，改为 sidecar 权威；`listThreads` 支持显式刷新并修正「旧扫描 promise 覆盖新缓存」的竞态（写回前比对当前缓存条目）；冷/热列表都提供 `name`/`firstMessageText`；`getThreadDetails` 热会话用 `getSessionStats()`/`getContextUsage()`，冷会话只打开作用域校验后的 `SessionManager` 并用 `deriveContextUsage` 计算当前分支上下文；删除文件成功后清理该会话元数据，清理失败会报错；归档/恢复对未归属会话同样可用。
- HTTP / 客户端：`GET /api/pi/threads?refresh=true`、`GET /api/pi/threads/:id/details` 走既有 Host/Origin/凭证中间件；`@huan/react` HTTP 客户端与 `isThreadDetails` 守卫同步；测试 fake client 补齐新方法。
- GUI（`apps/harness`）：列表增加可见范围（全部工作区含未归属 / 当前工作区）、排序（最近活动 / 创建时间 / 名称，同值以 ID 稳定）、仅命名、已归档过滤与「搜索名称与首条消息」说明；条目副行显示 cwd 末两级与活动时间，悬浮显示完整路径与时间；新建 `session-dialogs.tsx` 提供只读详情（元数据、全文件累计统计、当前分支上下文/记录数、费用）与删除确认（名称、完整会话文件路径、运行中会停止任务、取消不写数据）；未归属会话与已归属会话共用「详情/重命名/归档、恢复/删除」菜单，并保留「加入工作区」入口；「继续最近」改用未过滤的未归档列表按活动时间选取。
- 显式刷新：刷新按钮与窗口聚焦/恢复会清空宿主作用域缓存后重扫；普通操作仍沿用既有失效机制。
- 文档：`dev-guide.md` 更新 Chromium 流程数与会话管理/统计说明；`todo.md` 移除已不成立的「归档状态不跨重启」并更新搜索范围说明；`technical-architecture.md` 协议版本 4 → 5。

### 5.2 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过：Biome、全 workspace typecheck、29 文件 536 项 Vitest |
| `pnpm build` | 通过；保留既有大 chunk 警告 |
| `pnpm lingui:extract` | 通过；zh-CN 源文案 136 条 |
| `pnpm test:e2e` | 20 条 Chromium 全部通过（原有 16 条保留 + `e2e/session.spec.ts` 新增 4 条） |

新增/更新的关键测试：

- `packages/core/src/host-session-management.test.ts`（9 条）：名称/首条消息字段与外部新增/改名/删除只在显式刷新后可见；未归属归档重启保留、归属更新保留归档、删除清理元数据；损坏元数据禁止归档/恢复且不覆盖文件；冷热统计与真实 SDK 输出一致（覆盖其他分支、压缩、分支摘要、独立 usage、toolResult usage，并证明热读确实走了 SDK 路径）；未知模型窗口不填零、压缩后上下文为 `tokens: null`；冷读详情不执行项目扩展且零网络请求。
- `packages/core/src/workspace-store.test.ts`（+4 条）：未归属归档/再归属保留/重启恢复/清除与删除清理、归档空条目清理、损坏状态禁写、空元数据条目按损坏处理。
- `apps/harness/server/project-routes.test.ts`（+2 条）与 `packages/react/src/client/http-client.test.ts`（+3 条）：刷新参数、详情往返、401 保护、500 传播与畸形载荷拒绝。
- `apps/harness/e2e/session.spec.ts`（4 条）：搜索只命中名称/首条消息、范围/排序/仅命名过滤；外部新增会话需显式刷新才可见；详情统计与归档恢复（含未归属详情）；删除取消不写数据、确认后会话不再复活。

### 5.3 实现说明

- `HarnessThreadDetails` 比设计多一个必填 `branchEntryCount`，用于直观区分「全文件累计」与「当前活动分支」；不改变统计口径。
- 名称排序使用 `localeCompare('zh-Hans-CN')`（中文按拼音、拉丁字母顺序），同值以 ID 升序；e2e 在「仅命名」视图中断言 A/Z 顺序，避免中文与拉丁字母混排区域差异。
- 详情弹层提供「刷新详情」按钮（打开时也会请求），满足「打开/手动刷新时更新」；请求代次在关闭/切换/卸载后作废，避免旧结果串入。
- 列表行「当前会话」判定改为按运行时 `remoteId` 解析主线程：经 `initialize()` 创建的远端会话在 assistant-ui 中保留 `__LOCALID_*` 映射 ID，直接比较 `mainThreadId` 会失效；该修正同时让归档/删除当前会话后正确离开视图（此前行高亮判断同样受影响）。
- 删除的文件与 sidecar 无跨文件事务：文件删除成功但元数据清理失败时，页面提示「文件可能已删除、元数据清理失败」，不伪报成功。
- 未归属会话行同时提供「加入工作区」图标按钮与完整操作菜单，避免为归档/删除再增加分组级入口。

### 5.4 已知限制（本轮不处理）

- 详情每次请求重算聚合，不建立全历史索引，也不在 token 事件中聚合整棵树；会话很多时按需开销仍为 O(条目数)。
- 搜索只覆盖名称与首条消息，不提供全文检索。
- 外部直接改写已加载 live 会话文件仍无多写者合并保证（与设计一致）。
- 主 agent 验证覆盖 DOM、交互与计算样式，本轮未进行截图视觉审阅。

### 5.5 主 agent review 修复

- 热详情补齐目录时间和父会话路径，回归验证冷热一致。
- 浏览器刷新增加请求代次，旧响应不得覆盖新列表。补宿主旧扫描缓存和浏览器响应倒序回归。
- 已知 state.json 损坏时在删除文件前拒绝；文件已删但元数据清理失败时再次删除可继续清理，补失败重试回归。
- 当前会话补列表逻辑统一解析 remoteId；名称可清空，reducer 同步显式 name 并恢复首条消息标题；补浏览器和 reducer 回归。
- HTTP 元数据守卫补 name、firstMessageText、workspaceId 字段检查；浏览器增加“继续最近不受搜索过滤影响”的断言。
- 主 agent 最终运行 `pnpm check`、`pnpm test:e2e`、`pnpm build` 与 `pnpm lingui:extract`；结果见 §5.2。
