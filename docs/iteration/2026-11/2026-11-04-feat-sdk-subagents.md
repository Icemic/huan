# SDK 子 agent 与 Pi CLI 依赖清理

日期：2026-11-04。分类：feat。基线：`e71ea51`。本文记录调研、候选设计与验证证据；计划状态和决策结论唯一维护于[主路线图 §2.3](../../roadmap.md#23-当前阶段输入区上下文用量随后-g15)。原[UI调整](2026-11-03-feat-ui-adjustments.md)已结束，本次独立承接子会话需求。

## 1. 目标与边界

用户确认独立GUI的运行能力不要求外部Pi CLI。子agent改由Pi SDK执行，覆盖单个、并行与串行链式调用，保留上下文隔离、进度、结果、费用及取消清理。

本轮先核对公开接口与现有实现，D1～D5会议决策已全部确认，结论见§5与roadmap。调研中的候选建议以最终结论为准。现已按确认范围实施SDK子会话、工具与GUI，验证记录见§7。

关联ENV-01/04、RUN-01/02/05/06、RES-01/03/04/05。Pi官方README明确subagent不属于自带功能；此次补充huan能力设计，不追认其已在历史迭代验收。确认设计后补能力规范。

## 2. 故障与依赖审计

主会话由`host/live-sessions.ts`调用`createAgentSessionFromServices`创建。用户扩展`~/.pi/agent/extensions/subagent/index.ts`却复用`process.execPath`与`process.argv[1]`启动子进程，不传`execArgv`。按huan的tsx启动脚本推导，它会把服务端入口当Pi CLI，且丢失加载参数。

本地以`node --input-type=module -e "await import('./packages/core/src/index.ts')"`复现相同模块缺失错误，经tsx动态导入`@huan/core`成功。初始故障调查尚未执行完整子agent复现；当前隔离SDK与浏览器验证见§7。扩展的单个、并行和链式模式共用`runSingleAgent`；此前单个成功的原因仍未确认，不能认定为并发故障。

静态审计范围为仓库`apps`、`packages`及已检查的本地用户扩展源码。subagent是此范围唯一确认的Pi CLI启动依赖，不覆盖任意项目配置或整个生态。主会话、认证、配置、工具与内置能力使用SDK；Shell、npm/git包解析和MCP服务器保留各自外部程序需求。`RpcClient`也会启动Pi CLI，不适合作为此次替代路径。

## 3. 原扩展行为基准

| 部分 | 已核对行为 |
| --- | --- |
| 定义发现 | 每次调用读取用户agents目录；项目定义选择最近祖先`.pi/agents`；支持user/project/both，both时项目同名覆盖用户 |
| 定义字段 | name、description、model、tools及Markdown正文；tools支持逗号字符串或数组，空列表最终退到默认工具，不能表达明确禁用全部工具 |
| 配置选择 | 未指定model时继承发起会话模型与Thinking；指定model时交CLI解析模型及Thinking后缀；正文通过append-system-prompt追加，不替换全部系统提示 |
| 执行与历史 | 单个、最多8任务且4并发、链式替换`{previous}`；子进程使用`--no-session`，不继承父聊天记录，但会按cwd重新发现资源 |
| 结果与费用 | 链式失败停止，最终返回最后一步；并行逐任务汇总并限每任务50KiB模型可见文本；收集助手用量放details，未把这份统计作为工具顶层usage返回 |

这些行为供本次设计取舍参考。旧扩展自身并发上限只约束一次调用；模型在同一轮并行调用多个subagent工具时，总并发仍会叠加。

## 4. SDK 与 huan 接入约束

### 4.1 独立会话与资源所有权

Pi 1.4.0公开`createAgentSession`、`createAgentSessionServices`、`createAgentSessionFromServices`和`SessionManager.inMemory(cwd)`，支持独立model、thinkingLevel、tools、excludeTools及resourceLoader。不存在现成的subagent编排API；无需自建Agent Loop，也无需通过CLI。

子会话必须有独立SessionManager、扩展runtime、loader与工作区/MCP绑定。`PreparedProject`只允许一个live会话消费；共享父loader会覆盖会话动作绑定，一个会话dispose还会使共享扩展上下文失效。服务现有ModelRuntime可共享，但新装配注册provider会影响全服务目录，不能把它称为模型注册隔离。独立MCP绑定还可能增加stdio服务器进程数量。

现有`LiveSessions.openSession`会把记录发布到全局会话目录，并绑定完整命令动作，不能直接等同于“隐藏的一次性子任务”。SDK会话本身与会话列表是否可见是两个问题。

### 4.2 运行、取消与费用

每个任务独立订阅并调用`prompt()`，以`agent_settled`确认自动继续结束，检查终态错误或取消，不能把Promise正常返回当作模型成功。父工具signal需覆盖等待调度、装配、执行和清理；取消后不能再启动尚未执行的任务。

`AgentSession.dispose()`同步失效上下文并请求中止；子会话需接通父工具signal并在调用收尾释放独立持有的资源，沿用现有SDK关闭约定。现有`emitShutdown`会重新打开sessionFile，评估复用时注意其文件依赖。取消传递与资源释放属于实现职责，删除、重载、服务退出继续沿用已有流程；遇到具体问题再讨论，避免为每个入口另建策略。

子会话消息不写入父SessionManager。父工具结果可用顶层usage汇总子任务实际调用费用，含失败前已发生的费用；details中的展示统计仅供展示，父会话计费需要顶层usage。若保留子会话文件，还需明确父子统计是含委派费用还是独立费用，防止跨会话求和重复计算。

### 4.3 GUI 与交互

`parentToolCallId`由同一会话的`ctx.executeTool()`生成，不会跨SDK会话自动关联。子事件不能直接送入父`onSessionEvent`，否则可能改变父工具状态、运行结算和消息投影。

现有工具卡可通过`onUpdate.content`展示进度文本/图片，并展示最终content与details；实时details未进入展示投影，最终details目前是JSON。完整子聊天、Thinking、逐任务取消或结构化实时卡片需要明确的业务展示设计。

子会话的confirm/select/input/editor需准确关联父工具和具体任务。父bridge当前只在唯一待执行工具时推断toolCallId，不能直接拿来解决多任务关联。不能因改成SDK就默认丢弃审批，或让子扩展修改主输入框、切换主会话、关闭整个服务。

### 4.4 同名扩展与权限

SDK的replaceable内置扩展遇到同名第三方工具会被省略；若给SDK版subagent照搬此设置，旧CLI扩展可能继续生效。非replaceable同名注册只报告冲突并按加载顺序处理，也不是明确替代策略。

工具名称选择不构成OS权限隔离，且active工具与codemode/deferred可调用工具并不相同。禁止嵌套必须同时考虑模型直接调用、codemode入口和自定义扩展，不能仅从工具栏或active列表隐藏。项目agent Markdown包含可影响工具行为的指令，应遵循显式来源与项目授权规则。

### 4.5 其他产品的运行方式对照（2026-11-04）

对照官方文档与公开源码，区分独立上下文、OS进程、工作区和权限限制。产品文档中的thread/agent并不直接等于OS线程或进程。

| 产品/路径 | 公开资料支持的结论 | 不能据此推断的内容 |
| --- | --- | --- |
| Codex本地多agent | 公开core源码由LocalAgentControl调用ThreadManagerState.spawn_child_thread，再创建Session；该路径为同一服务中的会话/异步任务，未为每个子agent启动CLI进程。可查看子thread，并继承父sandbox/审批策略 | 云任务和工具沙箱可有其他隔离边界；不能推广到所有客户端部署 |
| VS Code/Copilot本地 | 官方描述独立上下文、工具结果内展示；公开execution subagent代码直接创建Conversation与ExecutionSubagentToolCallingLoop并run，属于内部调用循环实例 | 该公开实现只是已核对路径，不能断言所有Copilot自定义agent或托管后端完全相同。extension host进程隔离也不等于每个subagent独立进程 |
| Claude Code普通subagent | 官方说明独立上下文、工具/权限配置、前后台运行、可选worktree；与多独立会话和Agent Teams区分 | 普通subagent官方文档没有明确承诺每任务独立OS进程，不能把后台运行解释成子进程 |
| Claude Code Agent Teams | 实验功能，官方列出in-process及tmux/iTerm2分屏模式，默认in-process；队员为独立会话，可通信 | 普通subagent、团队会话和显示模式不是同一种能力，不应直接套用到huan |

常见组合是统一服务管理独立会话，在工具执行、独立后台任务或worktree层按需提供额外隔离；公开资料不足以统计各方案市场占比。Pi示例的每任务CLI进程只是其中一种实现。

D1建议据实际要求取舍：若主要目标是上下文隔离与轻量复用，方案A同进程符合已核对的常见内部编排方式；若要求用户扩展崩溃隔离和任务级强制终止，方案B自有SDK子进程更合适。此前会议口头建议B基于保留旧示例的进程边界，不能以“流行方案都使用独立进程”为理由。两种方案都需要独立资源生命周期，工作区并行写入隔离另行决定。

参考资料：

- [Codex子agent](https://developers.openai.com/codex/subagents)；[公开spawn实现](https://github.com/openai/codex/blob/71a4c070369fb761e51fd71009107f398d9f0f81/codex-rs/core/src/agent/control/spawn.rs)与[会话创建](https://github.com/openai/codex/blob/71a4c070369fb761e51fd71009107f398d9f0f81/codex-rs/core/src/thread_manager.rs)。
- [VS Code子agent](https://code.visualstudio.com/docs/agents/run/subagents)；[Copilot execution subagent源码](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/tools/node/executionSubagentTool.ts)；[extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)。
- [Claude Code子agent](https://code.claude.com/docs/en/sub-agents)与[Agent Teams](https://code.claude.com/docs/en/agent-teams)。

### 4.6 MCP继承与连接复用的行业对照

将子会话的工具可见性/启停策略与物理连接所有权分别判断，不能因继承工具就认定重新建连接，也不能因共享连接就共享全部权限。

| 产品 | 已核对行为 | 连接边界 |
| --- | --- | --- |
| Codex本地 | 官方文档要求子agent继承父权限、provider与MCP服务器，agent定义不能覆盖mcp_servers。公开ThreadManager持有McpManager，McpManager含连接池 | 所核对提交中，兼容MCP 2026-07-28的本地stdio服务器可按协议协商复用连接，保留每聊天请求作用域与lease；旧协议和启动时请求输入的服务器保持私有。不能概括为全部连接共享 |
| VS Code本地/Copilot已核对路径 | 官方定义默认继承父选定工具，自定义agent可覆盖工具；公开execution subagent通过现有IToolsService取工具并调用 | 支持“统一工具服务＋子任务工具选择”的设计判断，尚未逐一核对所有MCP传输及harness的连接归属；不能断言每个子任务重连或全部共享 |
| Claude Code | 官方subagent文档明确默认继承可用MCP工具，可按tools/disallowedTools缩减；mcpServers字段支持引用父服务器与内联专属定义 | 字符串引用明确共享父会话连接；内联定义随子agent启动连接、完成断开，且受定义来源信任规则约束 |
| Pi示例 | 每任务新CLI进程，按cwd装配资源，无huan工作区临时配置继承 | 各进程独立创建MCP连接 |

行业资料支持采用“继承父可用能力、显式缩减或专属追加”的组合，但连接共享需要请求级取消、交互归属、连接资格与生命周期支持。huan现有MCP按会话独立持有；会议中的B建议基于现有实现降低改造范围，连接独立是否适用仍按需求决定。C方案可节约启动/连接成本，增加共享状态服务器与取消收尾的处理要求。D3c已确认本迭代采用独立连接，见§5。

补充来源：[Codex文档](https://developers.openai.com/codex/subagents)、[McpManager](https://github.com/openai/codex/blob/71a4c070369fb761e51fd71009107f398d9f0f81/codex-rs/core/src/mcp.rs)、[连接池](https://github.com/openai/codex/blob/71a4c070369fb761e51fd71009107f398d9f0f81/codex-rs/codex-mcp/src/connection_pool.rs)、[VS Code子agent](https://code.visualstudio.com/docs/agents/run/subagents)、[Copilot工具调用循环](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/prompt/node/executionSubagentToolCallingLoop.ts)、[Claude MCP作用域](https://code.claude.com/docs/en/sub-agents#scope-mcp-servers-to-a-subagent)。源码结论限定于以上固定提交。

## 5. 会议待决策问题

本节记录已确认的会议结果，结论以roadmap对应ID为准。D1～D5全部确认，会议结束；实施遇到需要扩大范围的具体问题时再讨论。

| ID | 问题与选项 | 建议及影响 |
| --- | --- | --- |
| D1 | 运行方式：同进程独立SDK会话，或huan自有worker/子进程内运行SDK？ | 已确认方案A，结论见roadmap §2.3。采用同一Node服务内的独立SDK会话，每会话独立消息及资源绑定；共享进程故障边界，使用SDK与工具协作取消 |
| D2 | 记录与展示：内存任务＋父工具汇总；持久子记录但不进普通列表；或正式子会话可打开？是否要求完整聊天/Thinking及逐任务取消？ | 已确认方案B，结论见roadmap §2.3。保存完整子会话记录，从父工具打开只读聊天查看正文、Thinking、工具与错误；普通会话列表保持现有内容。父工具按任务显示状态、结果与费用，并提供逐任务取消 |
| D3a | 定义来源、模型与Thinking | 已确认沿用agents文件及现有作用域规则，按所选agentDir读取用户定义，每次调用重读。默认继承父模型/Thinking，范围外旧模型允许继承；显式模型遵守工作区最终范围，未指定Thinking则继承父值并按模型能力调整；无模型、缺凭据和显式越界均报错。结论见roadmap §2.3 |
| D3b | 工具及cwd/工作区 | 已确认工具方案B：定义tools优先，未指定则继承父发起时的工具配置；子会话独立权限检查。默认继承父cwd与工作区，显式cwd按目标重新检查资源信任，工作区成员保持原样。共享实际文件，结论见roadmap §2.3 |
| D3c | 扩展/MCP与交互授权 | 已确认MCP方案B及交互方案A，结论见roadmap §2.3。独立装配扩展与连接，同cwd继承父临时启停/工具暴露选择，换cwd用目标配置，动态服务器由子扩展注册。子任务的confirm/select/input/editor需在本迭代转发到现有Host UI并关联任务；任务取消解除其等待，跨会话编辑器/结构与服务关闭动作明确拒绝 |
| D4a | 嵌套与并发额度 | 已确认1A/2A，结论见roadmap §2.3。子agent禁止再次委派，每次并行调用最多8项且最多4项同时执行，其余在本次调用中等待；不同调用可叠加，不设服务或主会话共享额度 |
| D4b | 失败与取消 | 已确认方案1A：并行单项失败/取消仅影响该项，链式当前步失败/取消后停止后续。父运行停止沿用已有流程，子SDK会话接父工具signal，等待任务响应同一取消；调用结束释放自身资源。用户要求按实际成本控制范围，删除/重载/服务退出沿用现有行为，具体实现问题出现时再讨论 |
| D5 | 旧扩展冲突 | 已确认方案B，结论见roadmap §2.3。huan内subagent固定使用内置SDK实现，排除外部同名工具注册并提示来源；个人文件与TUI行为保持，外部扩展其他工具/事件保持。优先公开注册能力，若必须移除整个扩展则先讨论，按实际问题限定改动 |

交互能力现状：`packages/core/src/host-ui.ts`已桥接confirm/select/input/editor；`apps/harness/src/components/pi-thread-host-ui.tsx`提供输入区附近的会话应答卡片，`pi-host-interactions.tsx`提供启动期交互。缺少的是子会话到父页面的任务归属与应答路由。此次交互决定包含实际接通与验证；通用模型可调用的提问工具属于另一项能力，目前没有内置注册，本次决定仅承接扩展/工具通过SDK发起的交互。

## 6. 最小实施拆分

实施顺序为core的SDK子会话与工具编排、协议/HTTP/浏览器状态和只读查看、逐任务取消，最后定向验证与文档同步。服务端与GUI共用新增任务接口，本次作为一组集成改动完成验证后提交，避免留下不可操作的中间入口。

子记录采用所选agentDir下`huan/subagents/<parentId>/<taskId>/session.jsonl`及同目录`task.json`，使用独立Pi SessionManager保存；目录独立于普通sessions扫描，父工具details保存任务ID与摘要。运行任务由父工具调用持有，结束后释放SDK实例，记录按需只读加载。文件标识由服务端生成和校验，客户端仅传parentId/taskId。

协议提供`getSubagentTask(parentThreadId, taskId)`返回任务摘要、子会话消息快照与待答请求，`cancelSubagentTask`取消单项，`respondSubagentTask`应答子任务交互。父工具onUpdate只汇总任务状态与费用，完整消息通过按需读取接口查看。打开的只读面板在任务运行时轮询读取，终态停止；不新增子事件总线或把子会话写入普通会话列表。工具卡支持逐任务打开与取消，复用既有消息投影和Host UI表单样式，子记录不提供编辑/导航/发送动作。

已补能力规范RUN-08，协议新增客户端方法后升至18。D5优先通过公开loader结果排除外部同名工具，保留同扩展其他注册。若公开接口无法达成则暂停讨论。相关验证使用隔离配置与合成模型，费用、任务结果、取消与资源释放分别检查。

## 7. 实施与定向验证

实施时在隔离agentDir和合成模型下，从主SDK实际工具调用发起单个、并行、链式任务；使全局Pi CLI不可用，确认没有CLI启动。复用现有服务及浏览器测试，不另建通用验证平台。

检查上下文/工作区绑定隔离、模型与工具覆盖、任务来源与审批、失败和取消、等待任务不再启动、费用计入、重载/删除/dispose清理。按D2确认结果验证完整子记录持久化、刷新后从父工具打开只读聊天、普通列表排除子记录，以及逐任务取消不影响其他并行任务。相关测试不得读取个人凭据/会话，不使用8799/8788。

实施完成：子agent通过进程内独立SDK会话执行，模型/Thinking与工具在任务创建时固定；单次调用最多8项/4并发，链式传递前序输出并遇失败停止。等待任务有稳定ID，可单独取消。子记录目录独立于普通会话扫描，父工具仅保留任务摘要与费用，完整记录按需只读打开。父工具signal接通子任务，关闭资源沿用既有SDK约定，没有CLI启动路径或新恢复机制。

通过公开loader的extensionsOverride只移除外部同名工具注册，保留其他工具与事件，来源提示进入资源诊断；没有修改个人扩展。MCP绑定独立，同cwd复制父会话启停/exposure选择，在文件和扩展注册条目合并后应用，后续动态注册仍生效，磁盘配置保持原样。子任务Host UI请求显示agent与任务来源，父卡显示“等待你的答复”，查看面板可应答和取消。运行时details进入消息投影，最终结果整体替换临时值，防止残留运行状态。

主agent独立review，修正等待任务的取消通知、发起时配置捕获、未信任项目沿用用户资源的规则、子快照运行状态、退出动画正文保留与同名来源诊断。子任务装配期的信任扩展询问也走同一任务桥，逐项取消中止等待，取消后后续询问立即返回。子会话运行事件只维护自身状态，不进入父会话结算。SDK在首条助手消息前可能尚未写入文件，收尾通过公开header/entries保存已发生记录，取消前消息仍可查看。

亲验全仓类型检查、11文件139项相关单测、14条不同Chromium流程通过；单测覆盖定义/模式/并发额度、链式上下文与费用、父停止取消4个运行和1个等待任务、模型范围/凭据、MCP临时覆盖、外部同名替代、HTTP与状态代次。浏览器覆盖单个/并行SDK委派、审批与逐项取消、冷记录重开，以及原Host UI和设置资源流程。首轮并行用例仅因“失败：subagent”标题无空格导致定位失败，修正定位后通过，保留任务行为断言。

本次未运行全仓单测、生产构建或完整浏览器套件，未读图，不宣称视觉验收。另以空目录替换测试进程PATH，确认找不到pi命令后，通过绝对Node路径运行host-subagent的链式与父取消两项SDK集成测试，2项通过，日志为`huan-subagent-no-cli.log`。源码核对及该运行验证均未经过CLI。测试仍使用现有隔离agentDir、合成模型、8899/8898单worker。日志见本机Temp的`huan-subagent-types-final-6.log`、`huan-subagent-unit-final-7.log`、`huan-subagent-e2e-final-2.log`；最后MCP动态选择修正后重跑2条子任务流程通过，见`huan-subagent-e2e-mcp-final.log`。未读取个人凭据/会话，未停止8799/8788。

用户手工验证：用户反馈已验证，使用表现正常，并确认本轮无后续步骤时整理提交；本次开发收尾，不另加验收事项。

## 8. 核对来源

以下上游路径相对`@earendil-works/pi-coding-agent@1.4.0`安装包，未修改依赖。

| 来源 | 结论依据 |
| --- | --- |
| README、docs/sdk.md、docs/extensions.md、docs/configuration.md、docs/security.md、docs/cli-integration.md | subagent非内置、SDK入口、资源/信任、事件/usage与CLI边界 |
| examples/sdk/03-custom-prompt.ts、06-extensions.ts、11-sessions.ts、12-full-control.ts、14-codemode-mcp.ts | 追加提示、独立runtime、内存会话与内置工厂 |
| examples/extensions/subagent/README.md；当前用户扩展index.ts和agents.ts | 三种模式、agent定义、模型继承与原CLI启动行为 |
| dist/core/sdk.d.ts、agent-session-services.d.ts、extensions/types.d.ts、resource-loader.d.ts | 会话参数、工具可调用范围、交互上下文与loader选项 |
| dist/core/agent-session.js、agent-session-runtime.js、resource-loader.js | dispose/shutdown区别、replaceable与同名冲突规则 |
| huan的host/live-sessions.ts、host/project-assembly.ts、host/shared.ts、host/session-events.ts | 单会话装配所有权、目录发布、工作区/MCP清理与交互关联 |
| huan的packages/react/src/model/message-view.ts、apps/harness/src/components/chat/tool-part.tsx、packages/core/src/session-stats.ts | 进度/最终details展示与工具usage统计 |

## 9. 风险与回退

风险包括模型/工具规则被继承逻辑扩大、并发费用与MCP资源增长、交互关联错误、清理遗漏、同名扩展仍走CLI，以及把子事件混入父记录。按D1～D5确认结果限定实现范围，再做最小改动。

回退仅涉及本迭代新增SDK子会话、工具及必要GUI/协议改动，保留既有主会话和用户文件；回退后仍遵守禁止依赖Pi CLI的约束，个人扩展保持原样。
