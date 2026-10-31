# G1.2d 独立分支与 JSONL 导入

- 日期：2026-10-31
- 分类：feat
- 能力：SES-05、SES-06、SES-07、ENV-02 分支/导入；SES-01 子会话恢复
- 前置：G1.2c（主 agent 566 项测试、24 条 Chromium）

## 1. 范围与公开 SDK 组合

提供历史用户消息 fork、当前落点 clone、宿主路径和浏览器上传两种 JSONL 导入。遵守阶段设计 §7，复用 c 的真实 entryId、结构闸门、目录作用域和信任入口。父会话不退休/替换/停订阅；子会话独立 ID、文件、live record，仅发起窗口切入。

fork 发送公开 extensionRunner 的 session_before_fork（position=before）；clone 使用 position=at。扩展取消则不创建文件/元数据。校验 expectedRevision，并要求源会话空闲；运行中显示先停止入口（显式调用既有取消），不静默中止父会话。

使用独立 SessionManager 句柄调用 createBranchedSession(targetLeafId)，仅复制根到目标路径，保留 SDK 的标签重建、compaction 引用与 parentSession。fork 用户节点目标为其父，返回用户文本；目标为 null 时 create/newSession({parentSession})。clone 当前 leaf（允许空会话的 null 生成空独立子会话）。按源 cwd 的 resolveSessionDirFor 及作用域检查写入，子会话继承显式工作区归属但不继承归档。冷源先走信任装配后才能发扩展事件，不用裸冷文件绕过扩展取消。

openSession 增加最小 sessionStartEvent 传递，子会话 reason=fork、previousSessionFile=父路径，对照 CLI runtime 行为；禁用直接使用 runtime.fork 替换父记录。子资源独立装配，保留恢复模型/Thinking/工具状态及工作区运行快照。

## 2. 导入流程

GUI 选择目标工作区，输入宿主绝对路径或上传 .jsonl；提供预览（源 ID/cwd/名称/条目数、目标存储目录、冲突说明）、可选替代 cwd（必须显式选择并校验为目标工作区成员）。原 cwd 有效且是成员时默认可用；不在成员内/缺失/不存在时提示选成员作为替代，不根据上传文件名推断宿主路径。导入前显示敏感内容提醒但不上传第三方。

新增 previewThreadImport/importThread 的小型协议输入，源为 discriminated path 或 content+filename；宿主路径只从宿主读取，浏览器文件以文本发给受保护接口。预览只解析/校验/检查目录，不能执行项目代码；确认导入时调用已有 getProject/信任流程，needs-trust 按现有GUI交互允许/拒绝后重试。拒绝信任仍允许导入并使用用户级资源。

严格逐行解析 JSON（空行可跳过）：单个首行 session header、有效 ID/时间与支持版本、条目对象/ID 唯一/父链可用、结构基本有效；拒绝坏行、重复 header、未知版本及断链/循环，不把 SDK 宽松跳过坏行冒充成功。标准旧版 v1/v2 可经公开 parseSessionEntries/migrateSessionEntries 转为当前格式，验证后再复制；如支持旧版需加真实 SDK 对照测试。允许未知扩展条目类型透传，不能为所有消息字段再造庞大 schema。HTTP 限制上传文本为合理上限（如20MiB），错误清楚。

默认保留源 session ID 和完整树，重新扫描整个目标作用域检查重复 ID。已有完全相同内容时返回 already-exists 并定位既有会话，不复制/不擅自改变其归属或落点；同 ID 内容不同返回 conflict，GUI 明确“作为独立副本导入”。副本仅转换 header ID（随机UUID），必要时 cwd override、parentSession 血缘和文件名，所有树条目及引用保留原样；不是只复制活动路径的 clone。宿主路径源记录父路径；浏览器来源无真实宿主路径，不伪造 parentSession。

预览不是授权 token：确认时必须重新读取源/校验/冲突与目标作用域，防源变化。并发导入按宿主范围串行提交，避免两个请求同 ID 各写一份。文件以独占写入避免覆盖，路径不使用用户上传文件名进行拼接，创建前后遵守 session scope symlink 保护；源文件永不改写。先写 Pi 文件→保存归属→报告成功；元数据失败留下可发现未归属文件并如实报告，不虚构跨文件事务。预览/导入不替换当前会话，成功后GUI切入才激活或宿主明确独立打开。

## 3. 生命周期与 GUI

在 c 的树用户行/历史消息菜单提供 fork；上下文栏提供 clone，侧栏提供导入。先确认本地草稿去向，选中文本只返回发起窗口；新建切换后恢复编辑器文本，防把文本写回父会话。其他窗口继续看父历史和本地草稿，父子各自可发送。成功刷新列表，不能靠 reload 显示子会话。

结构闸门加入 fork/clone 与源发送/导航/删除互斥；有 await 时检查退休/取消，子文件或资源失败只清理本次新建记录与文件，不删除源或已有冲突文件。扩展事件可能触发延迟发送，父持有闸门时需明确隔离；退役时排空结构任务。不做额外通用事务框架。

使用 Base UI 与 Lingui、紧凑规格。错误（冲突、非法JSONL、路径/cwd、信任、busy、取消、写失败）可见并保留输入，失败不伪报成功。

## 4. 验证与回退

- Core：fork首用户前、分叉选中路径/clone排除废弃分支、标签/compaction保留、parentSession、启动事件和扩展取消、父live不受影响、默认/平铺目录、同ID并发导入、完整树副本、原文件不变、源变化重验、坏行/断链/版本/cwd错误与信任。
- SDK 对照：createBranchedSession 活动路径、session_before_fork position、session_start fork/reason/previousSessionFile；确认模型/Thinking/工具可继续。
- HTTP/React：参数/错误/权限/上传上限和新协议版本，已有fakes同步。
- Chromium：原24条保留，补fork/clone父子独立与双窗、历史消息入口、路径与上传导入、冲突副本/非法文件/cwd修复、列表自动更新并继续发送；只用隔离合成模型。
- 主 agent review并直接修复，亲验check/build/lingui/e2e，回写roadmap/product/technical/todo与本记录。全部完成后停在下一阶段G1.3前，不擅自推进配置/MCP。

回退源码、协议与GUI即可；新生成的Pi子会话/导入文件是标准历史，不自动删除用户数据。无快照/文件回滚行为。

## 5. 实施记录（2026-10-31）

> 主体编码与开发自测后，主 agent 已独立 review、直接修复并完成累计验收；本节表述最终实现，完成状态由 roadmap 维护。

### 5.1 交付面

- 协议升至 7：新增 `HarnessThreadForkInput/Result`、JSONL 导入预览/确认契约与错误码；快照继续复用 c 的 `leafId`/`treeRevision`/`treeOperation` 与真实 `messageEntryIds`。
- core 新增 `session-fork.ts`：用独立 `SessionManager` 句柄调用 `createBranchedSession(targetLeafId)`，只复制根到目标路径；`before` 目标为用户消息父节点并返回原文，`at` 缺省当前 leaf，空分支使用 `SessionManager.create({ parentSession })`。
- core 新增 `session-import.ts`：逐行严格 JSON 解析、header/ID/时间/版本/条目/父链/环校验；v1/v2 经公开 `migrateSessionEntries` 迁移；未知扩展条目透传；内容语义比较、副本 ID/血缘/cwd/文件名规划、独占写入文本构建。
- 宿主新增 `forkThread`、`previewThreadImport`、`importThread`：fork 走 `session_before_fork` 扩展与结构闸门，子会话独立装配并继承工作区归属、不继承归档；导入先分析目标作用域与同 ID 冲突，确认时重读源、走项目信任入口、串行独占写入，再保存归属。
- HTTP 新增 `POST /threads/:id/fork`、`POST /threads/import/preview`、`POST /threads/import`；上传文本 20MiB 上限，超限返回 413；路由保持既有鉴权/Host/Origin 校验。
- react 增加 fork 客户端/校验与 Controller `forkThread`，导入沿用 HTTP 客户端的能力由 GUI 直接调用；fakes 与协议版本同步。
- harness 新增 `session-fork-dialog.tsx`、`session-fork-bridge.ts`、`import-thread-dialog.tsx`；历史用户消息与树用户行提供 fork，上下文栏提供 clone，侧栏提供导入。导入弹层包含路径/上传、预览、cwd 替代、敏感提醒、already-exists 打开既有、冲突副本、信任决定与失败保留输入。

### 5.2 关键实现决定

1. **父会话绝不参与分叉写入**：分叉使用独立 `SessionManager.open(sourceFile)`，不调用 live 父 manager 的 `createBranchedSession`；扩展事件只在父 record 上发，fork 内的延迟发送动作统一丢弃。删除/关闭可能与 fork 的 await 交错，因此在项目装配与子会话打开后复查退役状态，已退役则清理本次子文件并返回 cancelled。
2. **空分支语义**：目标路径没有用户/助手对话（首条用户消息之前、首个用户消息父节点为 null、或空会话 clone）时创建带 `parentSession` 的空会话，并显式继承父会话当前模型/Thinking；非空分支交给 SDK 从条目恢复。
3. **扩展取消零副作用**：`session_before_fork` 返回 cancel 或抛错时不创建文件、不写归属、不改变父历史；GUI 显示取消原因。
4. **导入严格性与透传**：不把 SDK 宽松跳过坏行当作成功；当前版本保留条目原文，旧版迁移后重新序列化；未知条目只校验 tree 基字段。
5. **预览不是授权**：确认时重新读取源、重新扫描目标作用域并重算冲突；源 ID 或完整文本 SHA-256 指纹与预览不一致返回 `source-changed`。
6. **冲突副本完整树**：同 ID 内容不同时只有 `asCopy` 才写新随机 UUID；header 只改 ID/cwd/parentSession，条目及未知扩展条目原样保留，不使用上传文件名拼路径。
7. **跨文件失败如实报告**：先独占写 Pi 文件，再保存归属；归属保存失败保留可发现的未归属文件并返回 `metadata-failed`，不伪报跨文件事务。
8. **并发与作用域**：导入确认在宿主内单队列串行；写前用解析后的 cwd 与 sessionDir 做 scope/symlink 校验；上传正文由 bodyLimit 逐块限制为24MiB（含JSON包装），内容另以UTF-8字节限制20MiB；无 Content-Length 的请求也受限制。
9. **路径字符安全**：header 时间戳统一规范为 ISO 后再拼目标文件名，避免 `2026/10/31` 这类可解析时间产生子目录；相对源 cwd 不按宿主进程目录隐式解析，而是要求显式选择工作区成员。

### 5.3 偏差与已知边界

- **空分支文件落盘时机**：fork 到首条用户消息之前会创建空子会话，SDK 在首条消息前不落盘文件，因此侧栏在子会话首次发送后才出现该条目；这与新建空会话的既有行为一致，不影响父子独立与切换。
- **already-exists 的语义比较**：既有会话被宿主打开后，SDK 可能规范化追加 Thinking/模型条目；此时同一源再导入会按 `conflict` 处理并要求副本，而不是误判为完全相同。e2e 使用未打开的预置会话验证 already-exists，打开后的场景按冲突处理。
- **源 cwd 与文件名**：源 header 的 cwd 必须是绝对路径，否则按 `cwd-required` 要求替代目录；header 时间戳只用于可读排序/文件名，写入前规范为 ISO，不把路径分隔符带进文件名。
- **上传上限**：内容按 UTF-8 字节限制20MiB，HTTP正文含包装限制24MiB；测试覆盖无长度流式请求超限。
- **浏览器扩展场景**：`session_before_fork` 取消与 `session_start(reason=fork, previousSessionFile)` 在 core 用真实 SDK 对照覆盖；GUI 的取消原因展示由类型/结果处理代码与 core 回归保障，未单独搭建取消型项目扩展的浏览器 e2e。
- **clone 的活动路径**：clone 复制 current leaf 的活动路径；用户在树中跳到用户消息后再发送会形成兄弟分支（不是替换原用户消息），e2e 按该语义验证废弃分支不会进入 clone。
- **列表标题重名**：fork/clone 子会话与父会话可能共享首条消息标题；GUI 不伪造额外标题，测试通过显式命名或历史条数区分。
- **未做视觉审阅**：本轮未进行截图级视觉 review；只验证交互、可访问名称与浏览器控制台无错误。

### 5.4 主 agent 累计验证证据

- `pnpm check`：lint、全 workspace 类型检查、32 个测试文件 598 项全部通过（c 基线 566 项全部保留）。
- 新增 core 测试：`host-session-fork.test.ts` 12 项（首用户前、废弃分支排除、标签/compaction、parentSession、扩展取消、session_start、busy/结构闸门、平铺目录、失败清理、模型/Thinking 恢复）；`host-session-import.test.ts` 15 项（路径/上传、严格坏行、完整树、cwd 修复、冲突副本、并发、源变化、v1 迁移、信任、元数据失败）。
- `pnpm --filter @huan/harness exec playwright test e2e/session-fork-import.spec.ts`：5 条通过；全量 `pnpm test:e2e`：29 条通过（原 24 条全部保留）。
- 新增 Chromium 场景：历史消息/树行 fork 与双窗父子独立、clone 排除废弃分支、路径导入非法文件与 cwd 替代、上传导入后继续发送、同 ID 冲突副本与完整树/已存在会话打开。
- `pnpm build`、`pnpm lingui:extract`（235 条）、`pnpm lingui:compile` 通过；构建仅保留既有大 chunk 警告。
- 修复导入弹层在“宿主路径↔上传”切换时 React 复用同一 `<input>` 导致的 controlled→uncontrolled 控制台错误（为两个分支加 key），浏览器回归无控制台错误。
- 全部自动化使用隔离临时用户空间与确定性合成模型，无个人凭据、会话或付费模型请求。

### 5.5 主要文件

- `packages/protocol/src/fork.ts`、`import.ts`、`client.ts`、`index.ts`
- `packages/core/src/session-fork.ts`、`session-import.ts`、`host.ts`、`index.ts`
- `packages/core/src/host-session-fork.test.ts`、`host-session-import.test.ts`
- `packages/react/src/client/http-client.ts`、`client/validation.ts`、`runtime/thread-controller.ts`、`runtime/runtime-types.ts`、`runtime/hooks.ts`、`runtime/use-harness-runtime.ts`
- `apps/harness/server/app.ts`、`server/project-routes.test.ts`
- `apps/harness/src/components/session-fork-dialog.tsx`、`session-fork-bridge.ts`、`import-thread-dialog.tsx`、`session-context-bar.tsx`、`assistant-ui/elements/thread.aui.tsx`、`workspace-sidebar.tsx`
- `apps/harness/e2e/session-fork-import.spec.ts`

### 5.6 主 agent review 修复

- 源完整文本指纹贯通预览/确认/GUI，补同 ID 内容变化回归；缺失 cwd 允许明确指定成员替代，补回归。
- 校验压缩/标签/上下文编辑的条目引用，防导入无效引用后 SDK 冷读失败。
- 上传改 UTF-8 字节限制，并用现有 Hono bodyLimit 拦截超限流式正文；HTTP 回归覆盖指纹传递和无 Content-Length 超限。
- 导入提交前复查工作区成员与宿主生命周期；结构闸门期间拦截扩展直接 prompt 的输入，避免父会话在 fork 钩子内穿过。
- 主 agent 亲验 check（598 项）、29 条 Chromium、build、Lingui235；最后 HTTP/校验补充后类型/lint与13条路由测试通过。
- 未修改参考仓库、未读取个人凭据或会话、未请求付费模型；没有截图视觉审阅。
