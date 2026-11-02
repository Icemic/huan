# R2：协议与行为规范

日期：2026-11-02。分类：feat（改变跨端接口、事件与结果语义）。研究基线：`52aeea1`；业务代码仍与`5400b8f`一致，Pi SDK 1.4.0、当前协议14。

用户已确认[R1所有权设计](2026-11-02-feat-architecture-remediation-ownership.md)并授权继续R2。本文件记录R2研究与待确认协议草案；§10.3的取舍尚未决定，R2未完成、未实施。计划、问题状态与出口由[子路线图](../../architecture-remediation-roadmap.md)维护；能力与既有证据见[R0盘点](2026-11-02-test-architecture-remediation-inventory.md)。本轮只读研究并修改文档，未运行应用、业务测试、构建或探针，未委派编码。

## 1. 源码依据与结论

以下SDK路径均相对`apps/harness/node_modules/@earendil-works/pi-coding-agent/dist/core/`，只作读取依据；实施使用公开包入口，不深导入这些文件。

| 依据 | 确认的执行顺序/限制 | 本规范选择 |
| --- | --- | --- |
| `agent-session.js:1631`的prompt及`:1423`的_startRun | 扩展slash先执行，input可改写/handled，随后skill/模板展开；queued回调在入队后；started回调在准备后、agent.prompt前 | 接受与副作用分开；取消不能把已入队改写成未接受；首条拆为创建和发送 |
| `agent-session.d.ts:574/585/640`；JS的_queueSteer/_queueFollowUp及message_start处理 | 公开steer/followUp/clearQueue和queue_update只返回文本；SDK自身以indexOf文本维护展示队列，没有提交ID/逐项操作 | 服务队列与本窗提交分开，取消按文本次数认领；队列仅整体取回 |
| `agent-session.js:682/695/1449/1566` | agent_end后仍有retry/压缩/边界继续；settled扩展hook后才通知公共listener，再执行deferred局部批次 | 以服务端coordinator结算；预检/边界等待与模型run区分；保留必要SDK取消补偿 |
| `agent-session.js:1971/1011`；`agent-session.d.ts` | abort取消并等idle，dispose清监听/资源；没有公开API清除_deferredSettledActions或已取走局部批次 | 私有数组补偿集中、显式检测；agent_start永久退休守卫继续有效 |
| `packages/core/src/host.ts:5771/5855/6003` | 创建可内嵌initialMessage但只返回快照；发送有单独disposition；空会话文件可尚未写入 | 创建回执与消息回执分开，目录包含已创建live空会话 |
| `host.ts:2339`、`packages/core/src/event-mapping.ts` | core有currentRun归属；映射丢失settled.aborted；预检取消用agent_end兼任通知 | 运行事件携带受控结局；预检取消只更新该提交，不结束另一运行 |
| `packages/react/src/runtime/thread-state.ts:141`及client/event-source.ts | 快照省略部分字段保留旧值；只有threadId/seq，未知事件推进序号 | 完整快照明确覆盖范围；加入服务/record身份，连接代次拒绝旧回调 |
| SDK的`nested-tool-calls.js:16/85`与消息类型 | live子调用有parentToolCallId；持久nestedCalls是有界摘要，未保存完整子结果/进度 | live快照补工具执行；历史显示已有摘要及不完整标记，不伪造完整重放 |

SDK源码中的私有方法名只用于说明执行依据。旧测试通过、源码推导和未来验证分开记录；本轮不将任何AR标为已修复。

## 2. 版本、服务身份与接口分组

### 2.1 同版访问

整改目标协议版本为15；首次修改wire的实施提交再递增常量，最终同一版本覆盖本文件，不按WIP次数不断加版本。浏览器和Node按同一仓库版本部署；协议采用严格相等校验，暂不实现范围协商或旧版本adapter。

- 所有`/api/pi`业务请求携带`x-huan-protocol: 15`。服务端先执行Host/Origin/token校验，再校验版本，最后读取正文、取得装配或启动操作。缺失/不符返回426及受控`protocol-mismatch`信息，不执行业务。
- HTTP响应包括错误带`x-huan-protocol`和`x-huan-instance`。服务创建生成随机`serviceInstanceId`，仅用于区分本次运行的服务；health只保留既有ok，排除在版本要求外。
- getHostInfo增加protocolVersion/serviceInstanceId。客户端响应头与已知实例不符时先失效旧查询/提交目标，重新取HostInfo与权威快照；已经派发的变更不能据此重投。不存在可读版本头的旧响应显示“客户端与服务版本不一致”，停止业务重连，等待用户更新页面/服务。
- 每个live record创建随机`recordId`，同record reload保持，重新冷打开/服务重启改变。会话事件为`{ threadId, recordId, seq, ...body }`；SSE响应所属serviceInstanceId来自头，快照也带来源身份。不要将Pi sessionId另造为第二会话身份。

版本校验保护不匹配客户端副作用；instance/record身份保护旧异步结果。R1的connectionKey仍由应用配置，持久文字命名空间仍用服务地址/凭证作用域标识和存储作用域，不含短期instanceId，避免重启丢失文字草稿。

### 2.2 领域接口

`HarnessClient`保留为接口组合，HTTP方法仍逐项实现。分组类型直接声明现有方法，调用者使用所需分组或Pick；不引入按字符串反射调用的RPC分发器。

| 领域接口 | 方法责任 |
| --- | --- |
| HostClient / WorkspaceClient | HostInfo、安全交互、项目路径/信任/最近、工作区CRUD/归属、目录查询 |
| SessionClient | create/get/details/list、消息接受、停止、整体队列、树/标签/fork/import、命名/归档/删除及订阅 |
| ConfigurationClient / RuntimeClient | 设置/资源/reload、模型目录/Thinking/范围、Shell/压缩与取消 |
| ProviderAuthClient / McpClient | 保留现有独立认证与MCP管理接口，含安全快照、原文按需、runtime/identity检查 |

共用类型放protocol现有领域文件；新增`operations.ts`仅定义创建/发送回执，`errors.ts`定义跨端错误，`validation/`容纳共用wire守卫。protocol无外部运行依赖；HTTP路径和Header名处理留client/server，in-process调用直接使用类型与业务验证。

## 3. 创建与发送回执（推荐方案，待确认）

### 3.1 身份与有限保留

创建和发送由浏览器各生成UUID `operationId`，在派发前写入windowStore。首次创建与首次消息使用不同ID。请求带`expectedServiceInstanceId`及callerId；服务端在任何副作用前同步登记，创建由live-sessions持有登记，发送移交coordinator，查询由组合的SessionClient提供。记录属于进程内状态，不写Pi文件、sidecar或凭据存储。

新增`getOperation(operationId)`，HTTP为`GET /operations/:id`。它只读取登记，不创建会话、不重新执行；返回最小事实及revision。初始POST与查询共用同一回执形状：

```ts
type OperationRef = {
  operationId: string
  serviceInstanceId: string
  revision: number
  kind: 'create' | 'send'
}
type OperationState =
  | { phase: 'pending'; threadId?: string }
  | { phase: 'created'; threadId: string }
  | { phase: 'accepted'; threadId: string; disposition: 'started' | 'queued' | 'handled' }
  | { phase: 'cancelled'; threadId?: string; effects: 'none' | 'possible' }
  | { phase: 'failed'; threadId?: string; acceptance: 'not-accepted' | 'unknown'; effects: 'none' | 'possible'; error: WireError }
type OperationReceipt = OperationRef & OperationState
```

WireError由§9定义。pending不表示未产生副作用；accepted也不表示运行成功。发送一旦accepted，之后的模型失败、取消或队列清空由会话状态表达，不能把回执降为failed。handled表示扩展/input已处理，可能没有user消息。created表示会话及必要归属成功，消息尚未提交。

登记容量128个pending、512项终态及30分钟保留期是供评审的初始建议值，须在实施设计按负载确认。pending不按TTL删除，超出容量在执行前返回`operation-capacity`；终态按时间及容量移除。记录只保存ID、目标、状态、受控错误、创建结果threadId和不可逆请求摘要hash，不保存输入文字、图片、配置或回填原文。hash在core用固定字段的确定性编码计算，排除凭据；不把hash公开为身份或内容证明。

同进程同ID相同摘要返回已有回执，不再执行；不同输入返回`operation-id-conflict`。查询及重复请求按当前鉴权作用域限制，caller仅用于定向展示；同源可访问服务的窗口拥有既有相同业务权限，operationId也不提升权限。回执可能过期或服务重启丢失，所以禁止自动重投POST来查询，也不宣称跨重启exactly-once。GET返回`not-found`仅表示当前无记录，不证明操作未执行。请求ID只关联本次创建/发送，不用于给所有方法增加通用命令信封。

初始POST登记后等待接受/创建终态，最多等待1秒；尚未完成返回202 pending。操作在后台继续，浏览器串行GET（初始500ms，持续等待时1秒，网络失败退避至5秒）；终态立即停止，最后根lease释放停止本地查询但不取消服务端。超时或HTTP断开不改变登记事实。所有查询都检查serviceInstanceId、operationId和revision；较旧回执不能回退新状态。

### 3.2 新建与首条唯一流程

本节为候选方案，确认后移除createThread.initialMessage。建议流程为：捕获草稿及附件 → 图片本地准备和目标模型能力检查 → createThread → 确认created/threadId → 获取该会话快照/订阅 → sendMessage。创建输入显式workspaceId/startProjectPath/模型/Thinking；transport不读取草稿。发送仍在服务端检查图片能力，配置/扩展可能在期间变化，拒绝时保留已创建空会话与草稿。

创建完成就将live空会话合入唯一服务目录，即使Pi JSONL尚未生成。重扫合并live条目，标题可为空白占位；首条消息后用Pi实体数据替换。服务重启前未写文件的空会话可能消失，界面恢复为可创建目标并保留文字，不伪造持久成功。

创建失败保留已知threadId/文件可发现性：归属保存失败按现有规则退休record、保留可发现的未归属文件；未产生文件时如实说明。错误不能声称全部副作用已撤销。用户切换目标/关闭面板不会自动重新创建，也不会让晚创建成功夺回选择。创建结果未知则保留捕获内容，通过回执GET查找；记录已失/实例已换时提供显式重扫、选择已创建会话或“确认另建”的入口，重新创建使用新ID并提示重复风险。

### 3.3 发送接受与副作用

| SDK路径 | core记录事实的时点 | 失败/取消处理 |
| --- | --- | --- |
| started | SDK调用preflightResult(started)，下一步尚未发模型请求；记录接受后绑定startingSend | 回调前取消可拒绝启动；回调后取消是已接受运行被停止，保留accepted |
| queued | SDK已经写队列，再调用queued；先记录accepted，再执行停止所需清理 | 此时取消不能抛错伪装未入队；统一取消与队列取回动作处理已存在队列 |
| handled | 扩展slash或input已执行并返回handled | 记录accepted/handled；即使命令未写消息，也记本窗历史；关闭视图不撤销命令 |
| SDK在回调前抛错 | 服务端知道尚无接受，但扩展命令/input/before_agent_start可能执行过 | 无副作用的同步校验返回not-accepted/none；进入扩展后无法证明则unknown或not-accepted/possible，按可确认事实选择，恢复时禁止暗示可安全重发 |
| preflight等待中停止 | 取消资格立即失效，后续守卫阻止启动；命令先执行副作用仍可能存在 | 退出时提交回执cancelled并写effects，不广播会结束其他run的agent_end；无法中止hook时pending取消状态直到退出，UI显示正在取消 |

pending需要表达取消进度时增加`cancelRequested: true`，最终仍由实际回调/退出决定；不能先宣告cancelled再让旧回调接受。若SDK入队事件先于回执，service队列照常更新；回执只负责本地待确认提交移除，不添加第二个“已确认队列条目”。

SDK prompt返回但无preflightResult不默认为handled。当前settled期间prompt会立即返回并延迟执行，coordinator必须让新发送等待该边界结束后再调用，必要时调用公开isStreaming/isIdle与本地settled屏障判断；迟到回调仍归原操作。没有可确认结果时保持未知，不制造接受事实。

### 3.4 浏览器处理规则

windowStore的本地阶段为preparing、dispatching、awaitingReceipt、accepted、cancelled、rejected或unknown。权威messages只来自会话事件/快照，本窗未接受内容单独显示“正在提交”，不写入共享消息数组。accepted后撤下该提示并登记本窗历史一次，不按文本/时间戳/出现次数找对应消息；回执不承诺可定位Pi entryId。历史不从其他窗口user消息补记。

只在draftId/revision仍匹配时清空原草稿；同目标新输入保留。未接受/未知结果保留捕获文字与附件引用，用户可显式取回，取回也不能覆盖后来编辑。发送未知时先查回执，已失则查看当前历史/队列并由用户显式决定新ID发送，禁止后台自动重发。页面刷新按R1仅恢复文字，图片仍为内存资源，刷新前已丢失的图片不伪称可以恢复。

## 4. 队列、取消与运行

### 4.1 队列显示与整体取回

最终队列快照为`{ revision, steering: string[], followUp: string[] }`，revision由record每次队列更新递增。UI键仅为recordId/revision/mode/index，不叫提交ID；不保存跨revision身份。SDK给出的文本已可能经过input/模板改写；窗口已发送原文保留于本窗提交历史，不借此还原服务端来源。

本窗未确认提交与SDK队列是两个不同事实：前者有operationId，后者没有来源归属。accepted queued后本窗提示结束，仅显示SDK队列；任何窗口发送相同文字也不会认领本窗提交。Pi无逐项删除/提升，GUI只提供整体取回与停止。

整体取回请求固定threadId、recordId和操作开始时本窗尚未派发提交集合。先失效这批本地准备任务，再调用服务端clearQueue；core在coordinator中处理调用开始前尚未接受的发送取消资格，并同步调用公开clearQueue，返回精确取出的SDK文本及新的队列revision。后来的发送不加入旧取消集合，旧HTTP完成不能将新队列置空。

恢复时服务端取回文本与本地未派发原文分别呈现。无法证明一个未知提交是否已包含在取回文本中时，标明可能重复并由用户选择，禁止按相同文字合并/去重或把两组自动全部插入。已接受队列的图片恢复不在SDK公开clearQueue返回能力内，不从不可靠文本匹配认领附件；本窗捕获仍在内存时可单独找回。

SDK队列文本摘要本身对重复内容、纯图片或直接agent扩展入队的表示有限。保留其公开队列语义，GUI明确这是待处理文字摘要；不宣称每个底层消息都有稳定队列条目。本次关闭AR-15的标准是取消错误身份推断、精确表示确认边界及恢复行为，保持模型执行和整体操作，不另建替代Pi的执行队列。

### 4.2 停止的代次

每个record有独立`controlRevision`，变更请求带record/control前置条件时只用于发送、停止、整体取回及实际作用于live record的变更；冷目录操作继续使用其领域revision。新增发送必须使用当前已知expectedRecordId及expectedControlRevision；冷目标先完成live准入取得它们后再提交。stop与clearQueue也验证调用方所见的旧controlRevision，重复停止/取回收到stale时只读重查，禁止自动重新作用于后来运行。stop/clearQueue在服务端同步捕获当前在途集合并推进controlRevision；基于旧版本、在网络中迟到且尚未登记的发送返回stale，不偷偷加入下一轮。新请求须先取得新权威状态，使用新operationId。

stop返回最新controlRevision及`requested | settled | idle`，有界等待最多1秒后仍未结算返回requested；当前状态经SSE/快照持续可见。停止使此前未派发/预检发送失效、清空未交付队列、解除阻断交互、中止当前模型与自动继续。Shell用独立abort；手动结构操作的摘要/压缩有各自取消入口。退订、切换和页面关闭均不调用stop。

取消标记绑定旧owner/运行，新运行的错误独立判定；stop等待期间的新发送可以登记，但恢复SDK派发的充分条件仍须按§10.3确认，不能仅以一次idle或settled放行旧批次。clearQueue保持当前模型运行，但其开始前尚未接受发送不得晚补回旧队列。服务端动作与浏览器本地集合必须同时考虑，不能仅取消发起窗口的准备。

### 4.3 运行状态

新增会话运行投影`run`区分`idle | preparing | running | settling | cancelling`，及终态`success | failed | cancelled`；thread status保留idle/running/failed用于目录，由run及结构活动派生，浏览器只存规范化一次。preparing含本次SDK启动准备，普通等待admission只属于提交状态；Shell/手动compact/tree另有活动状态。

| 信号 | 允许的更新 | 禁止的推断 |
| --- | --- | --- |
| started回调/agent_start | 建立或延续同一coordinator运行，固定owner与runId | 不从HTTP接受推断运行成功 |
| agent_end | 完成本次低层agent段，清流式消息指针，保存候选错误，继续settling | willRetry=false也不能置idle |
| retry/compaction/before_settle | 更新阶段；自动继续仍属同一服务运行，agent_start可重复 | 手动压缩不能代替自动继续验收 |
| agent_settled | 携受控outcome及aborted，coordinator完成归属后发布；刷新树/来源映射 | preflight cancelled不伪造agent_settled或结束另一owner |
| 预检失败/handled | 只完成提交；如未建立模型运行，仍无run终态事件 | 不为适配旧UI制造假agent_end |
| error/断流 | error更新其所属操作/运行；transport错误显示连接状态 | socket关闭、失败提示或最后token不等于结算 |

runId只用于跨端运行归属与受控取消，按需要出现在运行投影/相关事件，不给所有协议对象添加统一runId。失败候选在重试成功后清除；SDK aborted与coordinator取消资格优先于assistant stopReason=error。取消不产生新的普通lastError；既有失败可以保留为历史结果，但不能冒充新运行失败。

## 5. 快照、序号、目录与重连

每次SSE连接必须先发完整权威快照，再发该边界后的事件；删除includeSnapshot=false路径。HTTP冷读/详情/树保持只读，不隐式开启订阅或执行项目扩展。正常live订阅仍先经信任与装配；损坏sidecar只允许冷模式，未就绪时明确错误。

### 5.1 完整快照

完整会话快照带`source: 'cold' | 'live'`、serviceInstanceId、live的recordId/seq/controlRevision。消息与entryId对应一并返回，队列、hostUiRequests和活动工具状态使用必需数组/对象，空即清空；readiness/contextUsage等可未知字段用明确null，不能以`?? oldValue`复用旧状态。readiness字段固定在会话数据，metadata仅保存其目录必要字段，避免重复源。

live快照包括SDK已提交消息、当前streamingMessage（如存在）、尚未完成工具执行/子调用和待答请求。服务端按SDK对象/entryId建立消息标识：持久消息用entryId，未提交使用record内生成的messageId；message_start/update/end与快照共享该ID，完成时更新来源entryId。仅内存关联用WeakMap/受控索引，不改Pi JSONL、不按文本猜消息身份。快照中途加入、后续直接message_end不能重复追加或遗漏。

host维护的活动工具表是执行事件恢复所需的最小投影，record持有，调用结束且持久结果可替代后释放；冷快照只返回已有持久信息。消息状态由一个字段表达，不在metadata和sessionData各存同义runStatus/queue。

### 5.2 增量与失效

- 每次打开/重连递增本地streamEpoch，旧连接回调/排队帧直接丢弃。首帧身份和seq重建该连接基线，服务/record变化先清前实例瞬态缓存，再应用完整快照。
- 同一record实时事件seq必须递增。重复或更小事件丢弃；发现缺号暂停增量并重新订阅获取快照，不把缺号后的消息当完整状态。不使用Last-Event-ID重放承诺。
- 完整快照可同seq重读；普通HTTP刷新结果只在请求epoch及开始时的会话版本仍有效时应用。较旧HTTP快照不能覆盖已收到的新事件；新连接首帧可在新record重置seq。
- 未知事件先验证信封和JSON限制，记录受控不支持代码并触发一次合并重查；连续未知不能制造无限重连。已知事件字段无效视为协议错误，停止本连接并显示错误；不可默默吞掉结算/交互事件。
- 流式帧合并只处理纯内容增量；接受/取消/交互/终结/身份变更先冲刷已缓冲内容，再按原序应用。断开缓冲未处理数据时用重连快照恢复。

### 5.3 目录字段覆盖范围

目录快照只负责目录字段及明确附带的live运行摘要；消息、工具、队列和敏感正文不随列表携带。每个实体保存字段组版本，列表扫描请求捕获开始版本，迟到扫描不得覆盖期间被事件/本窗操作更新的组；列表结果缺ID只移除该扫描范围内已确认不存在的冷目录项，保留已创建live空会话。

完整会话快照覆盖该会话全部状态；目录只读响应的字段省略只清其声明负责的目录字段，不能清live运行投影。显式重扫、聚焦和写入动作共用失效入口，不用DOM自定义事件。跨窗工作区定义仍通过聚焦/显式刷新读取；不新增无需求的广播基础设施。

## 6. SDK取消补偿

Pi 1.4.0公开abort/clearQueue/dispose不足以清除settled hook中延迟到下一轮的custom触发动作。保留两部分必要机制：

1. 将`_deferredSettledActions`数组清空集中在R1的sdk-cancellation模块；只在取消/退休所需边界调用。创建session时检查该字段是否为数组，并将当前SDK版本与检测结果留本地受控诊断；不再静默跳过。
2. 保留公开`session.agent.subscribe`的退休守卫，在agent_start时同步abort，禁止await与监听器互锁。SDK已splice到局部数组的延迟批次靠此拦截；退休后守卫随不可复用session保留，最终与session一起释放，不加入永久全局registry。
3. 停止期间阻止无owner延迟运行，准入同时等待本次捕获的prompt完成。公开waitForIdle只能说明当前idle，不能证明外层deferred局部批次已经退出；当前源码没有公开“全部旧批次已结束”信号。退休场景可永久禁止旧session启动；同session停止后恢复运行则需要进一步取舍，见§10.3，不能声称上述公开API已经解决。保持现有shutdown二次清空与“清空后同步dispose”的顺序，R8用既有延迟批次断言验证。

字段检测失败将该会话标为受控`execution-unavailable`并拒绝新增发送/副作用操作；冷历史继续可读。若公开API或SDK升级能证明替代方案有效，再删除私有补偿。R2保留上述最小例外，R5实现检测与失效处理，R8覆盖取消窗口/局部批次/下一轮隔离。此范围仅约束已捕获发送与SDK延迟批次，任意扩展自行启动的外部定时器仍须由扩展shutdown及record资格处理，不宣称撤销此前外部副作用。

## 7. 结构操作、定向交互与管理

### 7.1 固定目标与版本

树/fork/clone/标签使用threadId、recordId（live）、expectedTreeRevision；结构闸门在第一个await前同步取得，发送看到busy明确拒绝。import预览结果含源指纹，确认重读重验；source原文/文件不改。保存配置用target/scope/revision，管理MCP继续用runtimeId/identity；这些已有领域版本不替换成统一万能revision。

窗口应用异步结果同时检查draftId/draftRevision、selectionRevision和panelId/panelEpoch。服务端成功事实始终更新实体/操作结果，失效的UI来源不能改变后来视图或草稿；返回文本保留“取回/打开”入口。关闭视图不撤销已提交写入，取消请求只有服务端实际确认后才显示取消完成。

### 7.2 caller与指令领取（扩展方案，待选择）

本节接管/确认机制仅为完整恢复的候选；推荐范围见§10.3。确认前不将新增端点与持久化要求视为既定设计。

每个文档启动生成新的callerId，保存在窗口实例内存，刷新和复制标签页都会生成新ID；sessionStorage只保存文字/选择，不再保存服务调用者身份。服务端定向指令仍只允许匹配caller领取，后台无caller请求允许任一窗口主动领取；caller不是权限或凭证。

为保留刷新恢复，指令增加安全的`originOperationId`（有对应创建/发送来源时）和领取结果读取：发起窗口在sessionStorage仅保存未解决的operationId/旧callerId引用及允许恢复的指令文本，不保存认证回填/附件；新caller不能冒充旧caller。旧定向指令在有旧caller引用或对应originOperationId时可由用户显式接管，服务端原子修改领取者；同权限窗口的主动接管是既有多窗权限内操作，不能作为认证。UI显示来源窗口已变化，接管成功后由用户显式应用文本，其他窗口同时领取只一方成功。

领取API返回payload与`claimId`，同一caller/claimId重复查询只返回已领取结果、不执行第二次；容量与TTL采用30分钟、64项作为讨论起点，尚未确认。payload在record内保留至确认应用/显式忽略或record退休，容量满在产生新指令前报受控错误。客户端应用前先把可恢复文字/目标和旧草稿保存到窗口状态及sessionStorage白名单，再确认领取完成；刷新后恢复为待用户应用，不能自动再写一次。答案/私密原文不走此恢复通道。

本候选方案将当前“consume即删除”细化为领取与确认两个步骤，解决HTTP丢回执/刷新时既不能重新领取也找不到内容的问题；仅为已存在定向编辑器/命令目标使用，不推广为通用任务系统。本候选如获确认，再由R4/R5实施新增字段和端点，R8覆盖领取后换目标、刷新、重复确认与双窗接管。

### 7.3 四种交互及认证

confirm/select/input/editor保持原始协议联合，editor携prefill、input携placeholder；工具/游离/启动路径使用同一应答规范，select按原选项值应答，取消显式dismissed。每个请求独立ID，服务端应答返回accepted；重复/已结束为false，答案状态只清对应ID。无可见父工具时仍有可操作入口。

provider/MCP认证沿用独立broker，回填只在内存resolver短期存在；既有operation/prompt ID和runtime/identity规则保持。关闭面板清本地回填但不取消后台认证，GET/轮询可接管；成功后authRevision使目录失效，本地刷新不换当前模型。用户输入的URL/token、配置原文和认证原始错误禁止进入普通回执、事件、日志或sessionStorage。

### 7.4 模型与保存语义

历史恢复按Pi原模型/Thinking行为，不传新建默认覆盖历史。增加按会话的安全`modelResolution`：requested（可null）、effective（可null）、reason为restored/default/no-saved-model/model-not-registered/credentials-unavailable/no-model/unknown。根据公开SessionManager上下文、registry可用性和SDK返回结果归类，不解析英文异常字符串或公开modelFallbackMessage原文；无法确定用unknown。显式切模型后更新effective并结束该提示。

模型范围保存保留用户输入的patterns（含Thinking后缀）及解析models两组不同含义；core记录本次会话请求的patterns，后续SDK显式变更时投影resolved模式并标source，不能显示旧patterns为当前值。GUI提供模式原文与解析预览，常用模型勾选变更会明确替换为显式模型ID，保存前显示该原文变化；仅打开/保存未改表单不能丢Thinking后缀。

设置/MCP保存成功只代表文件已保存，资源重载独立操作。模型范围“临时已生效、默认保存失败”、导入“文件已写、归属保存失败”、重载“旧资源已关闭、新资源失败”都需表达已发生的部分结果，错误不得谎称无副作用。R1配置草稿draftRevision检查保持。

## 8. 消息、工具、JSON-safe与限额

### 8.1 独立展示数据

消息协议保留Pi可序列化内容形状与sourceEntryId；新增messageId用于live恢复，新增工具嵌套摘要类型对照SDK `nestedCalls`的calls/complete（ID/name/status/arguments或argumentsBytes/durationMs/error）。live子调用通过parentToolCallId呈现完整已收到事件；历史只显示SDK保存的摘要，complete=false/未保存结果明确标记，不能从工具成功推断有完整图片/子调用历史。完成的子调用在父工具尚未结束时保留最新结果供重连，父结果持久化后降为SDK摘要并释放完整瞬态内容；界面说明历史仅有摘要。

工具partial/final分开，输出按text/image内容呈现，details仅作安全通用data回退。未知角色/条目保留type与有界JSON表示；专用renderer缺失仍可读。live快照的工具状态和待答请求独立于助手content，避免无父toolCall时不可见。pure projection按ID索引关联，禁止每个工具遍历全部消息。

### 8.2 序列化规则与分帧候选

异常JS值转换属于R2必需设计；本节后半的分帧和数值预算为待评审候选，取舍见§10.3，尚未决定改变当前传输方法。

可信协议骨架逐字段构造；不把session/loader/Error整对象交给JSON.stringify。扩展的unknown参数、details、自定义内容单独转换：

| JS值 | wire结果 |
| --- | --- |
| null/string/boolean/有限number | 保留；数字NaN/Infinity转为受控`unavailable`标记 |
| undefined/function/symbol | 对象字段省略，数组位置用null；顶层unknown用null，附转换诊断 |
| bigint | `{ huanValue: 'bigint', value: 十进制字符串 }`，显示时标明表示法 |
| 循环/重复引用 | 只把当前祖先链循环变为`{ huanValue: 'unavailable', reason: 'circular' }`；普通共享对象可重复编码 |
| Date/其他对象/accessor | Date有效值转ISO；其他对象仅取own enumerable data descriptors，跳过getter/setter；不调用任意toJSON或String(error) |
| 深度/节点/字符串预算超限 | 对应unknown子树用带reason的unavailable标记，附安全issue路径；不裁断已知协议ID/事件骨架 |

unknown转换默认深度32、节点10,000、累计UTF-8 256KiB；每个unknown值处理一次，祖先集合检测循环，按预算停止。标记仅作显示，客户端不按标记重新执行/反序列化为对象；字段名碰撞不赋予业务含义。凭据先由领域投影剔除，此转换不是秘密识别器。

已知消息正文/图片不受unknown 256KiB截断。单SSE帧上限16MiB UTF-8，客户端行/事件限制按相同单位；完整快照可跨多帧，采用`sync_begin(syncId, recordId, seq, counts)`、按序`sync_chunk(syncId, index, section, payload)`与`sync_end(syncId, chunkCount)`。服务端在一个序号边界捕获隔离数据，再输出分块；期间增量按原序等待sync_end。客户端只缓冲本次同步数据，sync_end核对计数后一次性替换Zustand；未结束即断流则丢弃半成品、重新同步。每个消息内容的大字符串按UTF-8边界拆成最多1MiB片段，带messageId/内容字段/片段序号复原，不能切开JSON后当多个事件。

HTTP完整会话读取使用相同的有界SSE同步流，由client封装成getThread返回值；cold模式仍只读，客户端消费全部sync帧后返回。目录、详情、树仍按现有JSON方法返回；live订阅同步后继续事件，cold同步结束即关闭。长历史完整分块，禁止按单帧限额替换历史列表或省略消息；总同步预算256MiB，超过时明确返回`history-too-large`并保留旧视图，展示加载失败及会话文件位置，不将部分历史标成成功。该预算与新发送限额均是待确认目标，最终按代表性fixture验证，不能靠删断言满足。

单条实时消息/工具结果含大正文时同样分块重组后归约；非内容字段的单项异常或unknown载荷超限可用§8.2受控标记，必须保留结算/交互信封与ID。Pi文件原文保持原样；复制/下载使用完整已取得内容，确有不支持字段时说明转换情况。图片base64同样按片段复原，不能把不完整base64交给renderer。

SSE慢客户端维持现有500个待写上限并增加待写字节总量32MiB，超限断开后按快照恢复；重复因相同超限失败则显示受控错误停止自动重连。正文上限不是长Markdown性能预算，R7/R8仍需处理完整范围内的大内容。

### 8.3 输入限额建议（待确认）

保留导入20MiB、设置/MCP配置512KiB及现有正文包装余量，配置原文按需；认证回填沿用现有领域常量。新发送JSON正文最多24MiB，文本最多1MiB UTF-8，图片合计解码后最多16MiB、最多16张；超限在读取/解析对应阶段尽早拒绝，拒绝不创建模型运行。GUI准备前校验并保留输入，core再次校验，网络无法确认拒绝时仍按未知结果处理。这些是初始容量建议，最终值应依据现有SDK能力与代表性历史研究确定。新增限额属于本协议待确认设计，不能将实现旧基线描述为已有此限制。

## 9. 错误与校验

### 9.1 结果分类

预期领域结果保留各领域联合，例如busy/stale/conflict/cancelled/failed/partial；不统一包成看不出行为的boolean。请求解析/鉴权/协议/未找到/未处理异常使用受控错误结构：

```ts
type WireError = {
  code: string
  message: string
  effects: 'none' | 'possible' | 'committed'
  recovery: 'fix-input' | 'refresh' | 'inspect' | 'authenticate' | 'update-client'
}
```

code由protocol受控联合维护，表中string仅缩写；message来自固定模板及安全字段，任意SDK原始异常不直传。HTTP 400/401/403/404/409/413/415/426/429/500与领域原因对应，但状态码本身不证明未接受。结构/版本/输入在调用前拒绝可标effects=none；未知内部异常为possible；已知部分写入为committed并附领域事实。

client区分WireError与TransportError。网络失败、超时、用户Abort、本地JSON解析失败及无效响应对于已派发变更均属于outcome unknown；可用operation回执先查询，其余按领域重查。变更请求、工具副作用、OAuth回填的再次派发须由用户显式发起；只读GET可有界重试并受epoch限制。

### 9.2 校验归属

| 位置 | 负责 | 复用方式 |
| --- | --- | --- |
| protocol | wire联合、必需字段、互斥target、有限数字/ID/大小字段及事件形状 | 无外部运行依赖的守卫/解析函数；未知扩展字段保留但受JSON限制 |
| HTTP server | Host/Origin/token/版本在读body前；正文上限、路径/query/body解码、错误映射 | 使用protocol解析；不把无效成员flatMap丢弃后当成功 |
| core | 存储作用域、规范化路径/信任、expected版本、幂等登记/准入、SDK能力及文件保存 | in-process同样执行，不能信任GUI预检或仅路由验证 |
| HTTP client/SSE | 响应头/实例、Content-Type、JSON/已知事件守卫、流限额与连接错误 | 从protocol引用，删除react内部重复守卫；不读取草稿或决定业务目标 |
| Zustand业务动作 | 捕获本地目标、草稿/选择/面板版本、loading/error与恢复 | 不重复Node路径授权，不把异步完成当当前选择 |

协议类型结构断言、JSON往返、生产SSE传输、SDK行为与浏览器呈现分别有证据；任一层通过不代替其他层。会话里已有任意文本不因被展示就视为HTML可信，Markdown/链接/图片安全渲染在R7落实。

## 10. R1与子路线图核对

本文件先交付完整研究与协议草案。§10.3列出会改变现有恢复行为或显著增加协议机制的取舍，确认前R2保持设计中，不能据此授权R3实现。

### 10.1 R2交付范围与草案位置

| 子路线图R2要求 | 本文位置 | 对R1的具体化 |
| --- | --- | --- |
| 运行结算/取消/自动继续 | §4、§6 | coordinator统一结算、controlRevision防迟到发送、预检不伪造结束 |
| 提交结果/身份、队列边界 | §3、§4.1 | create/send独立有限回执；队列不认领来源、不增加逐项操作 |
| 错误与JSON-safe | §8、§9 | 受控效果分类、异常转换/正文限额、未知结果恢复 |
| 版本与校验归属 | §2、§5、§9.2 | 同版拒绝、服务/record/连接身份、守卫归protocol |
| 相关行为与证据 | §7、§11 | caller/指令恢复、模型回退/范围、子调用/图片/editor和组合验证 |

R1所有权保持：server权威、service/window/feature Zustand、资源句柄独立、现有包、MCP与provider broker、R3起拆aui、中途可不可用、最终完整验证。R2新增的回执归live/coordinator，指令领取归会话UI；窗口只保存自己的接受/恢复状态，不复制Node操作权威。

R1规定“默认仅文字持久化”的范围在定向指令完整恢复候选中建议增加白名单，当前尚未确认：仅operation引用与用户需主动应用的文字/目标，认证回填/配置原文/图片继续禁止。其他新字段均为已登记问题所需，未引入通用任务平台、逐项队列、文件回滚或G1.5输出能力。

### 10.2 AR关联与保持项

| AR | 规范与验收输入 |
| --- | --- |
| AR-08、AR-12、AR-13、AR-15、AR-40 | §3/§4/§7：接受与副作用分离，来源版本保护，历史本窗来源，整体队列及领取后恢复 |
| AR-11、AR-21 | §4.3/§6：settled与必要取消补偿，不保留错误idle断言 |
| AR-18、AR-19、AR-20、AR-25、AR-26、AR-43 | §2/§5/§8/§9：领域接口/同版/安全编码/覆盖范围及分层证据 |
| AR-07、AR-10、AR-16、AR-22、AR-37、AR-38、AR-39、AR-41、AR-42 | §5/§7/§8：目录版本、broker、固定目标、活动工具与图片、四种交互及模型原因 |
| 其余AR | 继续使用R1 §10逐项对应与子路线图原关闭条件；R2不删除、延期或关闭任何问题 |

### 10.3 需确认的设计取舍

| 事项 | 源码边界与推荐 | 影响 |
| --- | --- | --- |
| 创建/发送回执 | 推荐§3的有限进程内登记、GET查询及防同ID重复执行；保持Pi队列匿名，不建设精确消费关联 | 新增回执端点/容量/TTL，明确恢复边界；相较仅保存本地未知状态需要更多服务实现，但能确认丢回执操作 |
| 同session停止后旧deferred批次与新运行 | waitForIdle不是外层批次结束信号。推荐保留集中数组清理和agent级退休守卫；涉及SDK运行/结算的停止在执行实例退休后，显式重新装配恢复，持久会话ID和文字保留 | 重新装配会执行启动交互并重建MCP、重置临时模型范围等内存状态，须明确提示并恢复可证明的会话配置；此行为超出单纯搬模块，需用户确认。其他候选是增加一处SDK外层批次跟踪，但会扩大私有耦合，不作为默认选择 |
| 指令跨刷新恢复与大快照 | 推荐先采用小范围方案：新文档callerId、同窗领取结果可恢复，跨刷新仅保存文字并让用户显式处理；大快照优先保持现有完整传输限制，先做代表性规模测量后决定是否实施§8.2分帧 | §7.2的接管/确认机制、§8.2的分帧及新增数值上限均保留为待选设计，不先建设。采用完整方案会改变调用和恢复模型；采用较小方案需写明未确认领取结果与超限历史的错误处理，不静默丢内容 |

初步排除了“用公开waitForIdle直接证明旧批次已结束”的假设；它在SDK isIdle为true时立即返回，settled hook/外层局部数组仍可能继续执行。本轮只有源码依据，尚未复现“停止→新owner启动→旧局部动作恢复”的组合。AR-21需要补这组正式验证，当前退休型局部批次测试不能替代。

这些取舍均属于R2所需语义，未改变整体整改范围。推荐先确认回执与停止恢复方式，再按实际历史规模决定分帧；所有不确定处都有明确错误/恢复要求，不能以默认假设进入实现。

## 11. 实施与最终验证输入

候选机制经确认后才形成对应实施项；若采用较小方案，必须先更新规范与本表，不能用删断言代替方案取舍。

| 验证组 | 必须证明的行为 | 既有材料/后续责任 |
| --- | --- | --- |
| 接受/未知结果 | POST回执丢失后GET恢复；相同ID不再执行、冲突ID拒绝；过期/重启不重投；扩展副作用后失败显示可能影响；初始创建失败/空会话/图片拒绝可找回 | R0 RUN-02/03/07与SES-01；R2协议资产、R4/R5实现、R8浏览器/SDK |
| 队列/取消 | 双窗同文不认领；transform/模板/纯图片说明正确；先入队后取消仍accepted；旧controlRevision发送不入下一轮；取回不清新队列/新草稿 | 保留core预检/结算/clearQueue、Controller竞态语义，按最终接口迁移 |
| 结算/私有补偿 | agent_end到settled仍运行，自动重试/压缩/边界继续；取消不吞后续失败；私有字段缺失明确不可执行；shutdown及已取走局部批次零逃逸 | core host现有确定性延迟批次/取消测试，R8补完整GUI状态 |
| 快照与传输 | snapshot首帧/流式中途/直接message_end；记录身份变化/seq缺号/旧HTTP拒绝；contextUsage/readiness变null清旧值；已知坏事件停止、未知有界刷新；慢客户端/超限可解释 | production routes/SSE、JSON往返、reducer与本地服务分别验证 |
| 结构/交互/管理 | fork/import换目标、新草稿/重开/刷新；双窗领取/接管/重复确认；editor预填/多行；模型恢复三类及Thinking模式；保存≠应用/部分失败/认证秘密 | R0 SES/RES/MOD/MCP逐项表不减断言，R6/R7接入，R8验收 |
| JSON/安全/性能 | 循环/BigInt/getter/toJSON/深度/预算、有界标记；大图片/历史超限可读；协议拒绝先于副作用、冷读不执行；250/1000侧栏与连接数保持 | 协议/映射单元、SDK集成、生产浏览器分层；环境异常按AR-34另定位 |

本轮没有新增这些测试。R3～R7可WIP，最终R8补齐有效证据，R9按子路线图逐项关闭。规范确认后再确定编码工作包与授权，不将“继续R2”解释为允许开始实现。

## 12. 风险、检查与回退

主要风险为回执/指令保留变成无界缓存、SDK取消细节变化、未知结果误导重发、完整快照新增字段造成重复状态。通过容量/TTL、能力检测、明确effects与恢复入口、R1规范化存储及最终竞态验证处理。所有新增限额/回执/接管均是待确认目标，当前源码尚未提供。

本次文档检查：5份修改Markdown全文风格0命中、退出码0；116项本地链接/章节引用有效；AR-01～43编号与状态保持，R3～R9步骤保持；R1待定项与R2要求已在§10核对，源码引用路径/行号和SDK依据已复查；`git diff --check`通过。R1记录为用户已确认，R2保持研究中、取舍待确认，未标完成。业务源码/依赖/测试保持原样，未运行业务验证。回退仅涉及本次文档提交，不操作个人会话、共享配置或凭据。
