# G1.2c 会话树与跨窗口导航

- 日期：2026-10-31
- 分类：feat
- 能力：SES-04、SES-01 分支恢复、RUN-06 分支同步
- 前置：G1.2b（536 项测试、20 条 Chromium）；Pi SDK 1.4.0

## 1. 范围与权威

沿用阶段设计 §6：树浏览、文本/类型/标签过滤、标签编辑、导航（不摘要/摘要/自定义指令）、摘要取消、运行中停止并跳转、跨窗同步及未发送落点重启恢复。只改变会话上下文，不恢复项目文件。fork/clone/import 留给紧接的 G1.2d。

树由公开 SessionManager.getTree/getEntries/getLeafId 提供，SDK navigateTree 执行导航及扩展事件；用户/custom_message 节点遵循 SDK 返回 editorText 的规则，其他节点从目标后继续。用真实 entryId，不用 transcript 下标定位。提供轻量树节点 DTO（ID、父 ID、类型/角色、摘要、时间、标签、活动路径），不把整棵树放入 token 事件。

## 2. 接口与并发

新增 getThreadTree、navigateThreadTree、setThreadEntryLabel、cancelThreadTreeNavigation，受现有 HTTP 校验保护并更新协议版本/客户端/fakes。快照元数据包含 leafId（可 null）、treeRevision 和 treeOperation 状态；树按需读取。revision 可用记录版本/指纹，但必须保证普通新条目/标签/导航后旧请求被拒绝，不能仅数叶子节点。

会话结构修改在 SDK await 前同步占用单会话闸门；导航/标签与发送预检、模型/Thinking 修改、重命名、删除、压缩、其他导航互斥或明确拒绝 busy，避免 await 后仍有请求穿过。不能把结构操作锁与 run admission 互相等待造成死锁。SDK 导航摘要期间可取消（abortBranchSummary），等待状态通过快照告知所有窗口。扩展取消、摘要失败不伪报成功，编辑器草稿保持原状。删除/宿主退出需取消并排空结构操作后收尾，不能在退休 record 上继续提交。

运行中导航必须显式 stopRunning=true（GUI 文案“停止并跳转”），先按现有取消约定使预检失效、取回整体队列并停止/排空运行，再在已占用的结构操作窗导航。返回取回队列给发起窗口，失败亦不得静默丢失已取回队列。返回 editorText 不向其他窗口广播。成功后统一广播权威 snapshot，重连按 snapshot 恢复；其余窗口保留本地草稿。

## 3. 未发送落点持久化

在既有 sessionMetadata[storeId][sessionId] 增加可选树落点（leafId 可 null）和保存时文件/条目水位，保留 workspaceId/archived。冷树、冷快照、冷详情和 ensureOpen 装配之前统一应用有效落点；节点不存在或水位不同（外部 Pi/正常发送追加条目）则忽略落点，以 Pi JSONL 为准。不能让旧 sidecar 覆盖之后真正落盘的新分支。保存落点不改 Pi JSONL，无摘要导航不追加虚构消息。

只在结构操作边界写 sidecar，不每 token 写入。标签本身经 appendLabelChange 落在 Pi 文件，需保持非叶节点导航后的落点语义。存储继续 version 1、同一原子串行队列；允许只有树落点的未归属元数据；归属/归档/树落点更新互相保留。损坏状态禁止结构修改，冷历史仍可读。

导航成功但 sidecar 保存失败必须显式报错并恢复可恢复的原落点/上下文，向窗口提供权威状态，不声称完成持久化；SDK 已生成摘要等不可逆追加需如实标明而非假装跨文件事务。回归覆盖失败边界。

## 4. GUI 与投影

会话上下文栏提供“会话树”，Base UI Dialog/面板的紧凑缩进列表（不引入整套树库）；显示活动节点/路径和标签，搜索、对话/工具/全部/已标记过滤。树行提供标签和跳转操作，历史用户消息提供定位树节点入口，投影保留对应 sourceEntryId（不从 timestamp 或数组索引猜测）。定位能力应能供 d 的 fork 复用。

导航前确认本地非空草稿的替换，成功只替换发起窗口编辑器；其他窗口仅更新历史/当前落点。显示取回队列并可复制/恢复到编辑器，不默默拼接然后自动发送。branchSummarySkipPrompt 影响摘要默认提示，仍提供显式摘要选项和自定义指令，摘要可能计费且进行中可取消。切换/关闭面板不停止宿主任务，重新打开可获当前操作状态。

## 5. 验证与回退

- Store：落点含 null/水位、归属/归档不丢、重启/写失败/损坏保护。
- Core：多叉树、真实 SDK 用户/非用户导航、标签、摘要成功/扩展取消/失败/取消、revision 冲突、发送/删除/取消竞态；重启恢复及新条目使旧落点失效；冷树不执行扩展/联网；项目文件不变。
- Controller/投影：snapshot 替换清除旧流式/工具/队列，entryId 对齐；双窗只发起方收到编辑文本；保留全部既有可靠性测试。
- Chromium：原20条保留，补真实树/标签/过滤/导航、草稿确认、双窗消息与本地草稿、断流恢复、摘要等待取消与队列恢复（合成模型，不付费）。
- 主体编码 DeepSeek Flash max；主 agent 直接 review/修复并亲验 check/build/lingui/e2e，文档记录实际证据。

回退源码/协议/UI 变更；Pi 文件继续原生格式，sidecar 树落点可不再使用。已写入的 Pi 标签/摘要为原生历史，不自动删除。完成后继续独立 G1.2d。

## 6. 实施记录（2026-10-31）

> 主体编码与开发自测完成后，主 agent 已直接 review、修复与亲验；结果见 §6.5，完成状态由 roadmap 维护。

### 6.1 交付面

- 协议升至 6：新增 `HarnessThreadTree`、`HarnessThreadTreeNode`、`HarnessThreadTreeOperation`、`HarnessTreeNavigateInput/Result`、`HarnessTreeLabelInput/Result`、`HarnessTreeCancelResult`；快照增加 `leafId`、`treeRevision`、`treeOperation` 与并行 `messageEntryIds`。
- HTTP 新增 `GET /threads/:id/tree`、`POST /threads/:id/tree/navigate`、`POST /threads/:id/tree/label`、`POST /threads/:id/tree/cancel`；结构 busy 统一 409 `thread-structure-busy`。
- core 新增 `session-tree.ts`：先序扁平树、活动路径、标签、kind/摘要、`v1:<entryCount>:<leafId>` revision、sidecar 落点校验与预期 leaf；不深导入 SDK helper，不重写 `navigateTree`。
- host 增加单会话结构闸门、运行中停止并取回队列、摘要进行中状态与取消、导航/标签 sidecar 持久化、保存失败恢复、删除/销毁前排空结构操作。
- workspace-store 在既有 `sessionMetadata` 中增加 `leaf: { leafId, entryCount }`；保留归属/归档，允许仅树落点；非法水位/leafId 视为损坏。
- react 增加 HTTP 客户端/校验、Controller 树动作与快照应用、消息投影 `sourceEntryId`、`useHarnessController`；fakes 与 controller 测试同步扩展。
- harness 增加“会话树”Dialog：紧凑缩进、搜索、对话/工具/全部/已标记过滤、标签编辑、导航确认（不摘要/摘要/自定义）、草稿替换确认、停止并跳转、摘要取消、取回队列复制/恢复、历史用户消息定位。

### 6.2 关键实现决定

1. **revision 用条目数 + 活动落点**：任一 append 都会推进 leaf 或改变条目数；仅计数叶子不足以拒绝旧请求。冷树打开前与 `ensureOpen` 应用同一落点，故冷读 revision 与随后 live record 一致。
2. **sidecar 水位用 entryCount**：`applyStoredSessionLeaf` 仅在 entryCount 相同且 leafId 存在时 `branch/resetLeaf`；外部 Pi 或正常发送追加条目后旧落点自动失效，不覆盖 Pi JSONL。
3. **标签是书签**：`appendLabelChange` 后恢复操作前 leaf；若既有 sidecar 落点仍匹配，则用新条目数刷新水位，保持非叶导航落点跨重启有效。
4. **运行中导航**：要求 `stopRunning=true`，先标记预检/startingSend 失效、取回队列、清空并排空运行；失败或 busy 仍返回 `recoveredQueue`。结束摘要会中止摘要模型请求，但不移动活动落点。
5. **持久化失败**：导航后保存 sidecar 失败时用公开 `branch/resetLeaf + refreshContext` 恢复精确旧落点；若已生成摘要，保留摘要条目并如实返回 `summaryCommitted`，不伪装跨文件事务。删除/销毁先取消并排空结构操作，退休 record 不再提交。
6. **消息定位**：host 用 `buildSessionProjection()` 的 `sourceEntry` 与实时消息对象身份对齐，输出并行 `messageEntryIds`；投影据此写入 `metadata.custom.pi.sourceEntryId`，不从时间戳或数组下标猜测。
7. **UI 状态**：树按需读取；快照中的 `treeOperation` 让所有窗口看到摘要进行中并可取消；关闭面板不取消宿主任务；`editorText` 只交给发起窗口，其他窗口保留草稿。

### 6.3 偏差与已知边界

- **运行中重命名**：保留既有行为（现有回归在首条消息运行中立即重命名），因此重命名在结构闸门内允许 `allowRunning`；它仍与其他结构操作/sidecar 写入互斥，但不会拒绝正在运行/预检的会话。原因是不削弱已有测试与用户可见能力；设计中的“互斥或明确拒绝 busy”按“占用闸门且不穿过”实现。
- **保存失败恢复**：主 agent 改为公开 `branch/resetLeaf + refreshContext`，精确恢复包含用户/custom 节点与 null 的落点，不重复触发扩展导航钩子。
- **取回队列去重**：服务端返回文本与本地未确认队列按“文本多重集”取最大重数合并；无法区分不同窗口发送的完全相同文本，这是协议只返回文本、不带请求 ID 的边界。
- **冷树摘要默认提示**：冷树只读全局 settings（`projectTrusted:false`）以不触发项目信任语义；live 树使用会话装配后的完整 settings。因此冷树首次打开时 `branchSummarySkipPrompt` 可能与项目级设置不同，导航成功后的树刷新会改正。
- **摘要默认值**：GUI 始终显式展示不摘要/摘要/自定义选项并默认不摘要，`branchSummarySkipPrompt` 只影响提示文案；这是为了避免用户未确认就产生计费。需要“跳过询问默认不摘要”的用户可直接确认默认项。
- **sidecar 保存粒度**：只在导航/标签边界写；不每 token 写，也不在普通发送后主动清理旧落点（靠水位失效）。
- **摘要失败/取消不产生虚构消息**：失败返回 `failed`，扩展取消返回 `cancelled`，摘要取消返回 `aborted`；均不写摘要，快照保持原落点。
- **pi-workspaces 冲突**：沿用既有拒绝装配逻辑，本迭代未改变。

### 6.4 开发自测证据

- `pnpm test`：30 个测试文件、566 项通过（G1.2b 基线 536 项全部保留）。
- 新增 core 18 项：多叉树、真实 entryId、用户/非用户导航、JSONL 不变、标签水位、revision 冲突、运行中 busy、停止并取回队列、摘要成功/取消/失败、扩展取消、删除排空、sidecar 保存失败恢复、冷树工具/标签/损坏落点、null 落点重启、冷树不执行扩展/联网。
- 新增 store 3 项、HTTP 路由 3 项、Controller 5 项；协议/HTTP/react client/fakes/版本同步。
- `pnpm --filter @huan/harness exec playwright test e2e/session-tree.spec.ts`：4 条通过；全量 `pnpm test:e2e`：24 条通过（原 20 条保留）。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm lingui:extract`、`pnpm lingui:compile` 通过；构建保留既有大 chunk 警告。
- 浏览器场景覆盖：树/标签/过滤/搜索、空与非空草稿替换、历史消息定位、双窗同步与本地草稿保留、运行中停止并跳转/取回队列、摘要等待与取消。合成模型控制仅使用隔离临时用户空间，无付费请求。

### 6.5 主要文件

- `packages/protocol/src/tree.ts`、`thread.ts`、`client.ts`、`index.ts`
- `packages/core/src/session-tree.ts`、`host.ts`、`workspace-store.ts`、`index.ts`
- `packages/core/src/host-session-tree.test.ts`、`workspace-store.test.ts`
- `packages/react/src/client/http-client.ts`、`client/validation.ts`、`runtime/thread-controller.ts`、`runtime/thread-state.ts`、`runtime/message-projection.ts`、`runtime/hooks.ts`、`runtime/runtime-types.ts`、`runtime/use-harness-runtime.ts`
- `apps/harness/server/app.ts`、`server/project-routes.test.ts`
- `apps/harness/src/components/session-tree-dialog.tsx`、`session-tree-bridge.ts`、`session-context-bar.tsx`、`assistant-ui/elements/thread.aui.tsx`
- `apps/harness/e2e/session-tree.spec.ts`

### 6.6 未做事项

- 未实现 d 的 fork/clone/import；未把 `extensionRunner` fork 事件或独立 `SessionManager` 抽象提前加入。
- 未修改参考仓库、未请求付费模型、未读取个人凭据/会话、未 git commit/push。
- roadmap 已记录 SES-04 与 RUN-06 分支同步验收；后续独立分支见 d 迭代。

### 6.5 主 agent review 与亲验

- 亲验 check（566 项测试）、24 条 Chromium、build、Lingui186；既有大 chunk 提示保留。
- 修复结构保存失败后的精确恢复、导航 HTTP 失败时本地队列取回、树请求乱序与会话切换后旧请求回写、非用户节点草稿清空确认、键盘访问树行操作。
- 运行结算与压缩完成补权威快照，更新真实来源 entryId 和树版本；原快照隔离回归固定保留首份订阅引用，全部原断言继续生效。
- 没有进行截图视觉审阅。
