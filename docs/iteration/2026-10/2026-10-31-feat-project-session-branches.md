# G1.2 项目、会话与分支设计

- 日期：2026-10-31
- 分类：feat
- 性质：阶段设计；具体实施按 roadmap 拆分，本文不维护完成状态
- 能力：ENV-03、SES-01～SES-07，补齐 ENV-02 与 RUN-06 的分支部分
- 依据：Pi SDK 1.4.0，产品设计与 Pi GUI 能力规范

## 1. 目标与边界

在 GUI 中进入宿主机器上的项目，处理项目资源信任，管理和继续会话，查看统计，并以 Pi 原生树结构导航、fork、clone 和导入 JSONL。保持现有多会话和多窗口运行，导航不改变项目文件。

按四个开发迭代交付，每个都有可用页面和自动化出口；首个迭代先解决项目信任，再扩展树和导入。继续复用原生 SessionManager、AgentSession 和现有 Controller，不建立第二份会话树或通用工作区平台。

## 2. 现状与 SDK 核对

| 事项 | 核对结果与设计影响 |
| --- | --- |
| 项目入口 | protocol 已有 create/list 的 workspacePath；React adapter 已接受 workspacePath，应用未提供入口。宿主可同时持有不同 cwd 的记录，无需全局 chdir |
| 信任 | SettingsManager.create 默认 projectTrusted=true；现有装配未传 resolveProjectTrust，因此当前不能声称保护了项目资源。必须在启动 bootstrap、冷打开和模型目录装配前处理 |
| SDK 信任接口 | 根入口公开 ProjectTrustStore、hasTrustRequiringProjectResources 与 ProjectTrustContext；ResourceLoader.reload 支持 resolveProjectTrust，先加载用户级扩展再交给回调判定。CLI 的 resolveProjectTrusted 与 emitProjectTrustEvent 未在根入口公开；实现前验证可用公开接入，禁止直接深导入 |
| 信任语义 | override → 用户扩展 project_trust → 最近父路径保存决定 → global defaultProjectTrust；默认 ask。sessionDir 提前读取例外、AGENTS 等上下文不受信任限制；信任不是沙箱 |
| 树导航 | SessionManager.getTree/getLeafId 和 AgentSession.navigateTree 可用；user 节点回到其父并返回 editorText，其他节点从目标继续；扩展可以取消或提供摘要 |
| fork/clone | CLI fork 用 AgentSessionRuntime.fork(entryId)；clone 是 fork(leafId,{position:'at'})，仅复制活动路径。runtime 会 abort、shutdown、dispose 并替换当前 session，不能直接替换 huan 的父记录 |
| 导入 | runtime.importFromJsonl 复制到当前 sessionDir 并保留 ID；原目录打开等组合可能导致同 ID 多文件，须与 G1.1 重复 ID 拒绝规则衔接 |
| 分支落点持久化 | SessionManager.branch/resetLeaf 仅改内存，不落盘；未发送新消息的无摘要跳转不能直接宣称重启后恢复该落点 |
| 统计 | getSessionStats 汇总所有条目含已压缩和其他分支的计费；getContextUsage 是当前模型上下文估计，不能混用 |
| 归档与列表 | 当前归档为宿主内存集合，列表只有标题过滤；本次补充明确范围、排序、命名过滤与外部变更刷新 |

源码依据相对于安装包：docs/security.md、docs/sessions.md；dist/core/trust-manager.d.ts、resource-loader.d.ts/js、project-trust.js、settings-manager.js、agent-session-runtime.d.ts/js、agent-session.d.ts/js、session-manager.d.ts/js；dist/modes/interactive/interactive-mode.js 的 showTreeSelector、showUserMessageSelector、handleCloneCommand。

## 3. 实施拆分

| 迭代 | 可交付操作 | 能力与验收 |
| --- | --- | --- |
| G1.2a 项目入口与信任 | 项目路径、最近项目、窗口独立切换；启动与冷打开信任；继续最近会话 | ENV-03、SES-01 基础；在测试扩展执行前取得决定，拒绝后仍可对话，重启读取保存决定 |
| G1.2b 会话管理与统计 | 搜索/排序/命名过滤、刷新、归档说明、会话详情与累计统计 | SES-01/02/03；冷/热会话一致，不把查看统计变成执行项目扩展 |
| G1.2c 会话树 | 树面板、标签、过滤、导航、摘要与取消、跨窗口同步 | SES-04、RUN-06 分支；编辑文本仅返回发起窗口，其他窗口更新活动上下文 |
| G1.2d 独立分支与导入 | 历史用户消息 fork、当前位置 clone、JSONL 导入并继续 | SES-05/06/07、ENV-02 分支/导入；父会话保留，扩展取消不生成成功结果，目标目录和 ID 无歧义 |

具体实现前补对应迭代细节；本设计确认后先实施 a，不并行开发四个迭代。

## 4. 项目入口与信任

### 4.1 页面与项目选择

页头显示当前项目完整路径，提供“打开项目”和最近项目。首期输入或粘贴宿主绝对路径；浏览器目录选择器只返回浏览器文件，不能冒充宿主路径。路径校验由 Node 完成，返回规范化路径和存在/目录错误。

项目选择属于窗口状态；切换只改变本窗口会话列表及新建目标。其他项目运行和其他窗口保持运行，不修改 process.cwd。先保持现有单列会话布局，最近项目从同一用户空间会话 header 与本机已选项目合并，窗口选中状态存浏览器本地；不另建项目数据库。不同宿主/用户空间的本地记录按宿主身份分开。

切换项目后提供“新建会话”和“继续最近”，不自动发消息。恢复旧会话以 header cwd 为准；无效 cwd 提示修复，用户可明确指定替代路径。默认 sessionDir 覆盖仍按 G1.1 启动作用域固定；默认分组随目标 cwd 改变，显式平铺按 header cwd 过滤。

新项目默认模型须按目标 cwd 的可信 settings 解析，env/宿主显式选项仍优先；不能继续套用启动项目默认模型。HostInfo 保留启动基准含义，项目信息另外显示该项目配置/信任结果，避免改写已有字段含义。

### 4.2 启动信任不能依赖已存在会话

宿主先建立可响应 health/项目状态的入口，再进行启动项目装配；受保护资源未经决定时项目为 needs-trust，尚不 bootstrap 项目扩展或联网目录刷新。仅用户配置可安全准备，模型/新建接口返回可识别的项目未就绪状态；不让启动挂在一个浏览器还无法回答的 Promise 上。

拒绝信任表示跳过受保护项目资源，不表示禁止进入项目。GUI 展示加载影响、实际决定来源和保存路径，提供本次允许/拒绝及保存当前路径决定；父路径已有决定明确展示继承来源。取消打开回到原项目，不写信任决定。允许后再装配，失败显示可重试错误。

信任机制采用 SDK 的 trust.json 与路径规则；a 的第一个技术验证必须证明用户级 project_trust 扩展和保存决定的优先级可经公开接口实现。若公开接口不足，记录具体缺口并讨论小型上游导出或必要适配，不以手写另一套信任算法静默替代。此验证应先于完整 GUI 编码。

查看冷历史、列表及只读统计不执行项目代码；真正开始运行、冷激活或获取项目扩展模型前检查信任。输入的路径、导入 cwd、历史 cwd 均走同一入口。信任变更影响下一次装配；不声称撤销信任能卸载已经执行的代码，页面说明需重开相关会话或重启。

### 4.3 协议方向

新增小型项目类型和接口：校验/查询项目、保存信任决定、列出已知项目；由 core 承接装配与 trust store，apps 提供页面和受保护 HTTP 路由。项目状态使用 ready/needs-trust/loading/failed，带可控来源与错误分类，不通过 thread Host UI 请求传递启动信任。

具体签名在 a 的验证后固定，避免此时建立尚无消费方的服务层。切换 UI 通过传入 workspacePath 更新现有 runtime adapter；核对旧 Controller 释放不停止宿主运行，并保留新建草稿的项目归属。

## 5. 会话管理与统计

默认搜索当前项目，提供“此用户空间全部项目”范围切换。列表显示显式名称/首条文本回退、cwd、最近活动，支持活动时间/创建时间/名称排序及仅命名过滤。搜索文案写清“名称与首条消息”；Pi 的既有 session picker 语义不要求全历史内容索引，本次不增加全文索引。

提供显式刷新，重新扫描当前作用域，外部 Pi 新增/删除会话后可见；列表在本窗口创建/改名/fork/clone/import 后更新，处理现有新会话标题不及时更新问题。归档持久化是否改变见 §9，决定前保持原行为并明确“宿主重启失效”。删除确认显示会话名称与路径；运行中删除继续复用既有退役流程。

详情面板展示 ID、文件、cwd、父会话、创建/活动时间、模型，以及用户/助手/工具数量、token 明细、累计费用、当前上下文估计。热会话直接用 SDK getSessionStats/getContextUsage；冷历史采用公开 SDK 的内存会话/投影能力核对计算路径，确保不执行扩展、不发送模型请求。若需要抽取少量聚合，必须用真实 SDK 输出对照。

## 6. 会话树与多窗口

树面板使用缩进列表，显示条目类型、文本摘要、时间、活动路径/节点及标签；过滤覆盖对话、工具、全部、已标记，并支持文本查找。使用 Pi entryId 定位，不用 transcript 数组下标推导。消息投影保留对应 entryId，历史用户消息可直接定位树节点或 fork。

树数据按需读取；快照携带当前 leafId 与分支 revision，必要时触发树重读，不在每个 token 事件附整棵树。导航、标签操作复用单会话修改互斥；请求包含预期 revision，过期时返回可重试冲突，避免两个窗口依据旧落点同时改变上下文。普通窗口切会话不产生 Pi session_before_switch，它是显示行为。

选用户节点将文本恢复到发起窗口编辑器；选其他节点清空/替换编辑器前处理本地草稿，避免静默丢失。导航前选择不摘要/摘要/自定义指令，遵循 branchSummarySkipPrompt；摘要期间可取消。成功后广播权威快照，让所有订阅窗口替换消息、上下文和落点。返回的 editorText 仅作用于发起窗口，不广播为所有窗口草稿。

运行中导航提供“停止并跳转”，明确告知会结束当前响应；整体取回队列交还发起窗口，先结束发送/运行再导航。摘要、压缩或其他结构修改期间禁用冲突操作；失败/扩展取消保留原树和草稿。摘要可能调用真实模型，必须显示进行中与失败，不作为纯本地切换呈现。

无摘要跳转的落点只存在内存；§9 决策前不承诺重启恢复。若持久化选择成立，只存用户空间 sidecar 的 sessionId/leafId，恢复时验证节点仍存在，不改写 Pi 原生条目；新条目落盘后以 SDK 为准。

## 7. fork、clone 和导入

fork 从选中用户消息之前复制活动路径，返回所选文本供编辑；clone 从当前叶子包含该节点复制。都新建独立 ID/文件，保留 parentSession 血缘，遵守解析后的目录，不直接拷贝整个含废弃分支的文件。

使用独立 SessionManager 句柄调用 createBranchedSession，避免修改 live 父 manager；第一条用户消息前 fork 使用空会话加 parentSession。宿主承接公开 extensionRunner 的 session_before_fork/相关 session_start 事件，保留扩展取消能力。父 live record 不 shutdown、不替换、不重绑到子会话；新记录独立打开。首次技术验证对照 CLI 的 fork/clone 事件、元数据、工具激活与上下文；不引入全局单一 AgentSessionRuntime。

初期要求源会话空闲；运行中给出先停止的入口，服务端仍检查状态。成功后仅发起窗口进入子会话，其他窗口继续看父会话。失败不改父路径，清理仅限本次创建的新文件，不冒充跨文件事务。

导入先支持宿主 JSONL 路径（可粘贴），清晰标明不是浏览器本地文件。解析 header/条目并验证可用 cwd；缺失或不存在时允许明确选择替代项目。确认目标项目、信任和目标存储目录后复制到所选空间；源文件保持原样。浏览器上传是否同批做见 §9。

导入保留 Pi 源 session ID：同一空间已有该 ID 时默认定位已有会话，内容不同则提示冲突，并提供“作为独立副本导入”。副本使用新 ID、记录父路径，保留完整树；不要复用仅复制活动分支的 clone。若 SDK 没有公开完整树改 ID 导入能力，d 开工时明确最小 JSONL header 转换方案与对照测试。目标文件名独立且不覆盖；非法格式不按 SDK 宽松读取静默降格为空会话。

## 8. 验证与回退

各迭代运行相关 Node 回归、类型检查、check/build，并扩展 Playwright 确定性场景。关键验证：

| 方面 | 验证 |
| --- | --- |
| 项目/信任 | 两个临时项目；扩展执行探针；拒绝/本次允许/保存/父路径继承；启动前无资源执行；新窗口及宿主重启 |
| 会话管理 | 外部新增后刷新、过滤排序、命名和删除；冷统计无扩展/网络；费用与 SDK 对照 |
| 树 | 多叉树、用户与其他节点、标签过滤、摘要取消/失败、双窗导航同步；草稿与队列不丢；落点重启按决定验收 |
| fork/clone | 父子独立、完整活动路径与废弃分支排除、首消息前 fork、扩展取消、session_start reason、同模型工具激活 |
| 导入 | 原文件不变、无效格式、cwd 覆盖、重复 ID、同名文件、存储作用域、完整树往返 |

每个子迭代可单独回退源码/协议/UI 变更；不迁移或覆盖用户 Pi 文件。新 sidecar 若采用，只包含 huan 元数据，删除后回到 Pi 原生恢复语义。禁止用浏览器刷新掩盖操作后的状态未更新。

## 9. 用户确认

用户已确认全部按建议：

1. 首期项目入口采用宿主路径输入与最近项目。
2. 在用户空间内持久化归档和树当前节点，保持 Pi JSONL 原样；在 b/c 实施。
3. d 同时提供宿主路径与浏览器 JSONL 上传。

按 a → b → c → d 实施，编码使用 opencode-go/deepseek-v4.1-flash:max，由主 agent 直接 review、修复与验证。

以下保留原建议说明：

1. 项目入口：首期宿主绝对路径输入 + 最近项目；需要时再加宿主目录浏览器。建议采用，以最小实现覆盖当前本机用途。
2. Pi 之外的元数据：建议用用户空间内一个 huan 元数据文件保存归档和未继续发送的树落点，使重启后保留；不改 Pi JSONL。用户可选择沿用 Pi 原生临时落点/现有临时归档，页面明确限制。
3. 导入：建议同批提供宿主路径和浏览器选择 JSONL 文件上传，适合 GUI 日常使用；若优先精简，先宿主路径即可，上传随后追加。

信任提示、模型失效、扩展取消等均已有能力规范约束，不再把遵循 Pi 行为作为额外产品选项。
