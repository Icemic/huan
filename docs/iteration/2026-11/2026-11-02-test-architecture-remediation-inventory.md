# R0：已交付能力与验收证据盘点

日期：2026-11-02。分类：test（整理验收要求与验证资产）。盘点基线：`92b4c30`，业务源码与`5400b8f`一致；Pi SDK 1.4.0，协议14。计划和问题状态由[整改子路线图](../../architecture-remediation-roadmap.md)维护。

## 1. 目标、范围与方法

将[能力规范](../../pi-gui-capabilities.md)中的每项要求关联到当前实现、既有断言、历史执行记录和整改后必须保留或补充的证据，作为R1/R2设计及R8测试迁移的输入。

覆盖全部37个稳定能力ID：32项属于G1.1～G1.4已交付范围，MOD-05经用户确认排除，OUT-01～04仍属G1.5。另核对多项目工作区、主题与刷新性能等已交付要求。能力的具体遗漏在子路线图登记，本文只保存盘点证据。

本次由主agent阅读规范、源码、测试断言、历史迭代与Git记录；没有运行应用、构建、业务测试或探针，没有修改业务源码、依赖与测试。本次再审查以[复杂度审查记录](2026-11-02-refactor-architecture-design-complexity.md)为依据。表内“已有断言”表示已阅读测试，执行结果仅引用历史记录；表格保存行为要求与证据入口，验证按缺失行为选择合适层级，不要求每项都新增独立浏览器流程或排列全部组合。已有有效证据可复用；验证不足本身不证明实现错误。没有逐行证明全部实现正确，也没有将源码阅读作为运行或视觉验证。

### 1.1 证据引用约定

表内路径缩写：

```text
C = packages/core/src/
R = packages/react/src/
P = packages/protocol/src/
A = apps/harness/src/components/
H = apps/harness/server/
E = apps/harness/e2e/
M = packages/mcp/src/
```

文件后的行号定位本次源码基线，后续移动代码时以测试名称和行为要求追踪。表中所列测试是对应行为的具体证据入口，不能由某文件的总通过数量推断所有子要求都已覆盖。

### 1.2 历史执行记录索引

| 代号 | 记录 | 可引用的历史结果与边界 |
| --- | --- | --- |
| D1 | [G1.1](../2026-10/2026-10-31-feat-user-space-reliability.md) §10 | 464项及check/build；目录、取消、重连；当时未执行个人环境兼容验证 |
| D2 | [项目信任](../2026-10/2026-10-31-feat-project-trust.md)、[工作区](../2026-10/2026-10-31-feat-multi-project-workspaces.md) §8 | 480→517项、9→12条Chromium；信任、归属与动态成员 |
| D3 | [会话统计](../2026-10/2026-10-31-feat-session-management-stats.md) §5、[会话树](../2026-10/2026-10-31-feat-session-tree.md) §6、[分支与导入](../2026-10/2026-10-31-feat-session-fork-import.md) §5 | 536→566→598项、20→24→29条Chromium；扩展取消型fork没有单独浏览器用例 |
| D4 | [运行操作](../2026-10/2026-10-31-feat-runtime-operations.md) §6、[命令输入](../2026-10/2026-10-31-feat-command-input.md) §5、[启动交互](../2026-10/2026-10-31-feat-host-ui-startup.md) §5 | 最终685项、47条Chromium；其中结束状态、本窗历史、草稿保护和数据回退声明有遗漏 |
| D5 | [设置与资源](2026-11-01-feat-settings-resources.md)、[重载](2026-11-01-feat-resource-reload-builtins.md)、[模型认证](2026-11-02-feat-provider-auth.md) | 718→738→760项、54→59→63条Chromium；保存与应用、启动交互、认证安全边界 |
| D6 | [共享配置](2026-11-02-feat-mcp-shared-config.md)、[连接](2026-11-02-feat-mcp-connections.md)、[Pi桥接](2026-11-02-feat-mcp-pi-bridge.md)、[OAuth与管理](2026-11-02-feat-mcp-auth-host.md)、[MCP GUI](2026-11-02-feat-mcp-gui.md) | 最终983项通过、2项平台跳过、69条Chromium；认证及测试环境偶发问题原因未确定；截图未审阅 |
| D7 | [Base UI主题](../2026-10/2026-10-31-refactor-base-ui-theme.md)、[刷新性能](2026-11-01-perf-react-subscriptions.md) | 主题键盘/焦点与250/1000会话输入、流式输出的无关行计数；不覆盖长Markdown、超长树或首次布局 |

这些结果属于各自执行时点。此前审查重跑983项和build只提供旧基线证据，未重跑69条浏览器套件。已撤回聊天V1/V2的结果不在本表中使用。

## 2. 用户空间、项目与会话

### 2.1 ENV-01～04

| ID | 必须保留的子要求与实现 | 已读断言和历史证据 | 整改后证据要求与问题关联 |
| --- | --- | --- | --- |
| ENV-01 | 默认Pi目录、显式agentDir与来源展示：`C/session-dir.ts`的resolveAgentDir；`C/host.ts`初始化与getHostInfo；`A/pi-host-status.tsx` | `C/session-dir.test.ts:76`显式优先；`:120`临时HOME下与SDK目录对照；`C/host-info.test.ts:59`目录/来源及无凭据；`E/browser.spec.ts:42`诊断摘要与空白页选模型；D1 | 保留默认规则和自定义目录两条路径；浏览器状态统一后仍能在无效默认模型下读取目录。界面认证重启提示纠正见AR-42 |
| ENV-02 | sessionDir的option/env/settings/default顺序、平铺共享与分组隔离；创建/枚举/打开/删除、fork/import共用作用域：`C/session-dir.ts`、host目录入口、`session-fork.ts`、`session-import.ts` | `C/host-directory.test.ts:108/138/237/281/310/347/433`分别断言默认、平铺、顺序、双空间、跨cwd、重复ID与链接越界；`C/host-session-fork.test.ts:476`平铺分支；`C/host-session-import.test.ts:406`源cwd默认目录与上传文件名；D1/D3 | 保留作用域一致性和越界拒绝；补足创建、分支、导入、删除共用作用域的具体不足，复用现有分层证据；没有跨层差异时不再机械新增全流程组合。资源所有权与协议校验归AR-18/22 |
| ENV-03 | 项目路径输入/重进、固定cwd、信任允许/拒绝/保存/重启；启动project_trust交互：`C/project-trust.ts`、host项目入口、`A/workspace-manager.tsx` | `C/host-project.test.ts:126/165/209/231`分别检查未授权不执行、保存重启、拒绝仍用用户资源、目标项目默认模型；`C/host-ui-host.test.ts:365/405`检查启动交互和HTTP可用；`E/project.spec.ts:282/305`检查标记文件与GUI决定；D2/D4 | 保留扩展决定顺序、每cwd装配与未信任冷读；浏览器刷新只证明页面恢复，进程重启由core断言支持。跨层装配/销毁归AR-17/22 |
| ENV-04 | 临时用户空间、合成模型、限制资源发现、网络允许列表及失败清理：`C/test-support.ts`、`E/server.ts`/`model-control.ts`、`E/config.ts` | `C/host.test.ts:1704/1729`检查初始化失败清理、继承环境恢复和意外网络拒绝；`E/server.ts`删除继承PI环境并传TEST_RESOURCE_ISOLATION；端口8899/8898；D1/D6 | 迁移后继续检查个人/祖先资源隔离、测试专属入口和进程回收；新测试不读取开发助手MCP配置。平台跳过与环境异常单列，归AR-34 |

### 2.2 SES-01～07

| ID | 必须保留的子要求与实现 | 已读断言和历史证据 | 整改后证据要求与问题关联 |
| --- | --- | --- | --- |
| SES-01 | 新建/打开/继续最近；恢复cwd、活动分支、模型/Thinking与消息：host的createThread/ensureOpen/openSession、`A/workspace-sidebar.tsx`、`R/runtime/use-harness-runtime.ts` | `C/host.test.ts:242/250/280`新建默认/显式模型与首条；`C/host-session-tree.test.ts:287/321`重启恢复活动位置；`C/host-session-fork.test.ts:331`子会话模型与继续；`E/browser.spec.ts:74`历史切换/页面刷新；`E/project.spec.ts:46`继续最近；D1～D3 | 保留新建与历史恢复的不同模型选择规则。补普通历史模型可用/失效/无消息三种情况的明确断言，覆盖回退原因可见；AR-08/40/41。首次发送须固定目标、模型和草稿版本 |
| SES-02 | 名称/首条消息搜索、排序/仅命名、改名/清空、删除确认、持久归档、路径/时间与外部刷新：host列表/WorkspaceStore、`A/workspace-sidebar.tsx`/`session-dialogs.tsx` | `C/host-session-management.test.ts:215/244/284/340`旧扫描拒绝、外部修改、归档重启与删除重试；`C/host.test.ts:405/459`清空名称与分支标题；`E/session.spec.ts:58/158/220/282`过滤/迟到响应/详情归档/删除；D3 | 保留搜索范围说明和显式重扫；单一目录替换双目录后验证标题/归档/活动时间。跨窗工作区定义目前依赖显式刷新，不能宣称即时广播；AR-04/05/31 |
| SES-03 | ID/文件、消息/token/费用累计、压缩后原历史、分支上下文与累计计费分开：`C/session-stats.ts`/`context-usage.ts`、host详情、`A/session-dialogs.tsx` | `C/host-session-management.test.ts:376`固定usage、跨分支/压缩/摘要/toolResult费用且与SDK热读相等；`:410/422/445`父路径/未知窗口/冷读不执行资源；`E/session.spec.ts:220`只断言页面字段可见及消息数；D3 | 数值正确性由core断言支持，浏览器仍需核对分支导航/压缩后的展示与未知值。快照缺contextUsage时沿用旧值需在R2确定完整替换规则，归AR-43 |
| SES-04 | 树节点/活动路径/标签/过滤；用户节点恢复文本、其他节点继续、保留分支、摘要选择/取消、取回队列：`C/session-tree.ts`及host结构动作、`A/session-tree-dialog.tsx` | `C/host-session-tree.test.ts:287/321/374/399/495/524/579/733`检查用户/非用户、revision、标签、取回、摘要、持久失败、删除取消；`E/session-tree.spec.ts:76/145/182/236`检查GUI过滤/双窗草稿/停止取回/摘要取消；D3 | 保留来源entryId与水位校验；补摘要期间关闭/重开、切换目标及同目标新草稿的迟到响应。现有confirmNavigation只检查threadId，另有回调未统一失效，归AR-12/40 |
| SES-05 | 从历史用户消息之前创建独立子会话、恢复所选文本、父会话保持、扩展取消与失败明确：`C/session-fork.ts`/host、`A/session-fork-dialog.tsx`及历史菜单 | `C/host-session-fork.test.ts:180/221/274/355/383/441/490`检查原文/路径/空分支/取消/启动/结构互斥/失败清理；`E/session-fork-import.spec.ts:193`父子双窗及继续；D3 | 保留独立SessionManager与父会话不切换；扩展取消有core证据，缺独立GUI取消型扩展用例。补请求完成时发起视图已关闭/目标变化的处理；AR-40 |
| SES-06 | clone当前活动路径、排除废弃分支、独立继续和模型继承：host的forkThread(position=at)、`A/session-context-bar.tsx` | `C/host-session-fork.test.ts:307/318/331`当前leaf、空会话、模型/Thinking与继续；`E/session-fork-import.spec.ts:263`父子各自发送且废弃分支不进入副本；D3 | 保留完整分支选择与空会话延迟写文件的既有规则；延迟完成不得改变用户后来选中的会话，归AR-40 |
| SES-07 | 路径/上传JSONL、严格格式、缺cwd替代、源文件不变、目标空间、冲突副本及失败可恢复：`C/session-import.ts`/host、`A/import-thread-dialog.tsx` | `C/host-session-import.test.ts:189/231/310/355/447/526/540/582/620/709`覆盖预览只读、坏行、源不变、cwd、冲突、并发、指纹、旧版和元数据失败；`E/session-fork-import.spec.ts:352/396/427`路径/上传/完整树副本；D3 | 保留20MiB内容限制、源重验、信任与完整树语义。补关闭重开/换文件/换目标后的旧读取、预览和导入结果；当前pickFile及runImport没有统一代次保护，归AR-40 |

## 3. 对话、输入与执行

| ID | 必须保留的子要求与实现 | 已读断言和历史证据 | 整改后证据要求与问题关联 |
| --- | --- | --- | --- |
| RUN-01 | 流式文本/Thinking、工具参数/部分/最终/错误结果、图片、折叠复制、长输出与历史回退：`R/runtime/message-projection.ts`、`A/assistant-ui/elements/thread.aui.tsx`/`tool-fallback.aui.tsx`、`A/runtime-data-parts.tsx` | `R/runtime/message-projection.test.ts:123`文本/Thinking/tool分组；core事件映射与controller流式测试；`E/browser.spec.ts:114`文本断流恢复；`E/mcp.spec.ts:238`只断言最终回复和工具副作用/资源读取标记；D4/D6 | 已知data无renderer不可见（AR-14）；图片被转换为modelContent后默认工具组件不读取（AR-38）；嵌套调用状态未投影（AR-37）。补已知/未知数据、纯图片/混合结果、独立toolResult、重开历史与长输出的可见内容断言，不能以服务端调用成功替代 |
| RUN-02 | steer/follow-up选择、排队显示、整体取回、停止覆盖预检/在途准备；取消不误报失败、不丢内容或重复派发：host发送/取消、controller pendingSends、composer | `C/host.test.ts:563/577/663/742/848/931/996/1073/1157/1242`接受与取消竞态；`C/host-runtime-operations.test.ts:416`扩展steer；`R/runtime/thread-controller.test.ts:1906/1986/2350/2410/2441/2471`消费不复活、取回失败与新队列保护；`E/command-input.spec.ts:251`显式队列；D1/D4 | 这些竞态语义保留，测试按最终状态接口迁移。重复文本跨窗的身份认领归AR-15；未知HTTP结果保留可恢复内容且禁止自行重发，须在R2明确定义并补浏览器证据；AR-08/33 |
| RUN-03 | 工作区路径搜索/补全、中文空格/别名、图片选择/粘贴/拖入、能力校验及来源区分：`C/resource-queries.ts`、`A/pi-composer-controller.ts`、当前附件adapter | `C/host-command-input.test.ts:210/232/255/314/331`图片拒绝、首条拒绝、成员/忽略/链接；`E/command-input.spec.ts:93/106/132`路径插入、拒绝保留、粘贴移除；`E/ui-base.spec.ts:65`预览焦点；D4 | 现有@浏览器用例只验证插入文本，需关联实际工具路径解析；图片正向发送/结果呈现、拖入和准备期间换目标需补最终证据。缓存按目标隔离归AR-07，提交时固定文本/附件/模型归AR-08 |
| RUN-04 | 直接Shell执行、输出增量与有界截断、取消、!进入上下文/!!排除、历史卡与独立于模型的生命周期：host的runThreadBash、`A/runtime-operations.tsx`和composer | `C/host-runtime-operations.test.ts:293/340/363/389/447/468/479/521/551/583/601`验证上下文、取消、模型并存、结构互斥、清理、扩展委托及历史匹配；`E/runtime-operations.spec.ts:78/121`输出/双窗/取消；`E/command-input.spec.ts:228`输入命令分流；D4 | 浏览器Shell“断线重连”用例在断开后等待500ms并检查旧运行文字，未检查新订阅或断开期间新输出；补确定性恢复断言，归AR-33。Shell启动响应清新输入归AR-12，运行面板跨目标迟到状态归AR-16 |
| RUN-05 | 运行、工具/交互等待、重试、自动/手动压缩、取消/失败和最终结算可区分；自动继续结束前保持运行：host的currentRun、reducer及PiRunStatus | `C/host.test.ts`结算与取消竞态；`R/runtime/thread-state.test.ts:500`错误要求willRetry=false即idle；`apps/harness/src/event-replay.test.ts:166`同样认可提前idle；`E/runtime-operations.spec.ts:166`仅手动压缩成功/取消；D4 | AR-11确认提前空闲，AR-33包含两处相反断言。补agent_end到agent_settled间等待、自动重试失败/成功、超窗压缩后继续、取消结算和UI状态；嵌套等待入口归AR-37/39 |
| RUN-06 | 首连/断流/关闭再连/刷新/多窗的消息、分支、队列、交互恢复；关闭窗口不停止任务：host快照、`H/sse.ts`、`R/client/event-source.ts`、controller和长期订阅 | `H/sse-link.test.ts:115`起使用假发送源验证生产SSE路由/解码/恢复；controller测试检查迟到load与seq重置；`E/browser.spec.ts:114/155`离线完成补齐与关闭发起窗；`E/session-tree.spec.ts:145`分支同步；D1/D3/D4 | 区分假源传输、SDK事件回放和浏览器三种证据，不能称同一测试覆盖完整SDK。补队列/交互离线变化与重启后的代表性恢复证据，不做全部对象×断线方式的组合矩阵；状态/资源代次与关闭规则归AR-09/19/22/26/33 |
| RUN-07 | 多行/长输入、IME与键盘、窗口草稿和本窗历史、错误恢复、分支编辑：composer、sessionStorage及fork入口 | `E/command-input.spec.ts:152/167/201`双窗草稿/刷新、长输入取消应用、旧历史不补记；controller检查图片准备取消与失败；D4/D7 | AR-12同目标异步完成清新草稿，AR-13他窗消息记入本窗历史。handled命令历史也不能从共享消息推断。补组合输入期间不误发的事件断言及快捷键路径；实际输入法行为按平台适用性检查，合成事件仅证明组合输入事件处理。另补发送拒绝/未知结果、首条创建等待、同目标新输入和切走再返回；AR-08/33/40 |

## 4. 模型、配置、资源与交互

### 4.1 MOD-01～05

| ID | 必须保留的子要求与实现 | 已读断言和历史证据 | 整改后证据要求与问题关联 |
| --- | --- | --- | --- |
| MOD-01 | 注册模型目录/刷新/选择/范围、Thinking含max、不可用与回退原因：`C/model-catalog.ts`、host模型动作、`A/pi-model-selector.tsx`/`runtime-operations.tsx` | `C/host.test.ts:168/178/306`注册目录、扩展模型与切换；`C/host-runtime-operations.test.ts:832/841/848/896/907`能力、max、范围持久化/无匹配/刷新；`E/ui-base.spec.ts:30`首条模型草稿；`E/runtime-operations.spec.ts:228`禁用范围外选择与max；D4 | 目录请求失败保留前目标条目、无键共享缓存归AR-07；回退只记全局诊断代码归AR-41。历史设计已披露范围面板保存会把带Thinking后缀的模式转为模型ID，R2须明确显示和保存规则并补验证，归AR-18/33 |
| MOD-02 | API key/OAuth、授权页/回填/取消/退出、多窗接管、指定空间保存与秘密隔离：`C/provider-auth.ts`、`H/provider-auth-routes.ts`、`A/pi-provider-auth*.ts*` | `C/provider-auth.test.ts:146/199/235/346/378/402/431/482/515/558/628/702/770`覆盖提示、取消提交竞态、同步失败、互斥、退出、销毁、持久化与失败；`E/provider-auth.spec.ts:47/69/103/145`入口/秘密/关闭重开/双窗；D5 | 保留认证独立于普通Host UI、关闭视图继续、环境凭据退出边界。hasConfiguredAuth偶发false归AR-34；浏览器轮询作用域归AR-10；认证修改需重启的旧提示归AR-42 |
| MOD-03 | 常用项/JSON、用户/可信项目优先级、临时会话覆盖、未知字段、验证冲突与保存/重载/重启说明：`C/settings-store.ts`/host、`A/settings-resources-dialog.tsx` | `C/host-settings.test.ts:96/163/201/234/263/275/294/302/331`原文/修复/revision/串行/大小/信任/保存≠应用；`E/settings-resources.spec.ts:82/129/156/189`写文件、未知字段、冲突、草稿与未信任；D5 | 保存结果与当前live值分开，JSON包含秘密时按需加载且禁持久化/调试记录。状态迁移保留目标/面板代次和每scope草稿；AR-16/18/20 |
| MOD-04 | 手动附指令压缩、自动开关/有效项目覆盖、过程失败/取消、原历史保留与结构互斥：host压缩/设置操作、runtime面板 | `C/host-runtime-operations.test.ts:665/699/719/735/744/765/801/814`成功/失败/取消/删除/并发/持久化/写失败；`E/runtime-operations.spec.ts:166`成功/取消/新会话继承；D4 | 保留取消后继续和SDK原历史访问。自动压缩/重试之后的完整运行状态需要补浏览器证据，不能由手动compact代替；AR-11/33；面板迟到结果归AR-16 |
| MOD-05 | llama.cpp专用管理经用户确认排除；稳定ID保留 | 能力规范§2.2；G1.4阶段记录 | 不计入32项已交付能力，不计失败或延期；通用模型调用仍由MOD-01/02覆盖 |

### 4.2 RES-01～05

| ID | 必须保留的子要求与实现 | 已读断言和历史证据 | 整改后证据要求与问题关联 |
| --- | --- | --- | --- |
| RES-01 | 指令/system prompt/扩展/skill/模板/主题/packages来源与诊断；遵守信任与已配置加载规则：`C/resource-inventory.ts`、host资源查询、设置资源面板 | `C/host-settings.test.ts:386/461/479/491`实际loader来源、未信任不执行、packages两种声明与快照无原文；`E/settings-resources.spec.ts:51`检查扩展文件名及文本按钮切换；D5 | 浏览器“显示文本”按钮变为“隐藏”只证明请求状态变化，未证明具体指令正文正确显示；补精确内容/来源断言，归AR-33。保留查询加载态与磁盘态区别、原文按需读取 |
| RES-02 | 目录/参数/补全/执行、内置与扩展→skill→模板覆盖顺序、未知slash语义及空白页不误建会话：`C/resource-queries.ts`、`P/commands.ts`、应用命令索引与composer | `C/host-command-input.test.ts:101/132/168/184/201`目录、SDK模板/skill展开、空白页、守卫、未知slash；`A/pi-builtin-commands.test.ts`同名优先；`E/command-input.spec.ts:32/65`内置面板/扩展参数且无消息；D4 | 保留实际执行与不支持提示的区别；扩展handled的本窗输入历史归AR-13；命令等待后草稿归AR-12。旧g1.4阶段标签已由后续交付更新，G1.5仍显示未实施 |
| RES-03 | 同会话reload、设置/指令/资源和多窗目录刷新、旧交互结束、新启动请求可答、MCP回收：host重载、`C/resource-reload.ts`、composer/设置面板 | `C/host-reload.test.ts:323/398/464/523/556/591/636/704/718`检查会话不替换、设置/指令、启动UI、busy、销毁、新资源信任和空白目标；`E/resource-reload.spec.ts:81/103/134/164/183`命令/草稿/双窗/交互/空白；`C/host-mcp.test.ts:536`PID回收；D5/D6 | 保留保存≠应用、失败可能已关闭旧扩展、目标固定和单次装配。回收和取消顺序归AR-22，本次EBUSY尚未确定为环境原因，仍归AR-34；命令完成草稿保护归AR-12 |
| RES-04 | confirm/select/input/editor、通知/status/widget、编辑器定向与恢复、取消/超时/幂等、启动交互和诚实的不支持反馈：`C/host-ui.ts`/`host-interactions.ts`、浏览器工具/游离交互 | `C/host-ui-host.test.ts:121/158/178/200/243/297/321/348/365/456/482/520/581`四种返回、超时/中止、状态、定向、不支持、启动、销毁及独立会话动作；`E/host-ui.spec.ts:33/66/88/109/140`通知/定向/游离confirm/接管/启动；D4/D5 | 现有core四种应答通过不代表GUI四种输入完整；工具关联editor丢prefill，应答组件虽使用Textarea支持多行，初始原文仍为空（AR-39）。同目标连续请求、工具/游离路径、默认折叠时待答可发现及迟到领取须有GUI证据；命令目标切换归AR-40 |
| RES-05 | MCP/codemode/tool_search按named builtin启停替换/defaultTools，工具权限与嵌套进度/父子关系：`C/builtin-extensions.ts`、`M/integration.ts`和host装配 | `C/host-reload.test.ts:770/852/873`codemode子调用、禁用、同名替换；`C/host-mcp.test.ts:293/314/365/386/631/645/661`direct/codemode/deferred/权限/禁用/替换/空配置；`M/integration.test.ts:478`嵌套SDK事件；D5/D6 | 服务端与reducer保留parentToolCallId，但当前投影未消费，GUI关系与进度未完成验收，归AR-37。保留共享唯一manager，运行测试从SDK执行一直检查到可见子调用及等待入口 |

## 5. MCP、输出与附加交付

### 5.1 MCP-01～05

| ID | 必须保留的子要求与实现 | 已读断言和历史证据 | 整改后证据要求与问题关联 |
| --- | --- | --- | --- |
| MCP-01 | 共享用户/可信项目配置、覆盖/校验/未知字段、stdio/HTTP、错误隔离及无服务器可用：`M/config.ts`/`store.ts`/`manager.ts`/`connection.ts` | `M/config.test.ts:172/200/293/427`未知字段/逐项拒绝/override/未信任拒读；`M/config-store.test.ts:193/296/539/579`共用文件、原文保留、独立凭据和旧路径不读；`M/http.test.ts:145`、`M/stdio.test.ts:80`本地连接；`C/host-mcp.test.ts:661`无服务器；D6 | 保留共享定义与独立认证/日志、错误分项处理、查询不连接。跨进程CAS从未承诺；配置/连接权威和生命周期归AR-17/22，不因架构整改无故重写底层MCP |
| MCP-02 | 连接/来源/错误、动态工具与资源详情、模型发现/调用/读取：MCP manager/integration、`C/mcp-host.ts`、`A/pi-mcp-panel.tsx` | `M/manager.test.ts:202/300/341/381/420/444`目录与错误/动态竞态；`M/resources.test.ts:83/129/159`分页与文本/图片转换；`C/host-mcp.test.ts:293/365`模型调用/发现；`E/mcp.spec.ts:238/395`实际副作用、资源读取标记、动态目录和失败修复；D6 | 保留详情按需查询、部分失败与无resources能力仍显示工具。资源图片转换已有包测试，但聊天中可见性缺失归AR-38；嵌套工具展示归AR-37 |
| MCP-03 | 服务器/工具临时启停、重连、四种exposure、持久来源及项目override/扩展注册区分：manager、broker、GUI JSON/表单 | `M/manager.test.ts:508/530/571/656/716/786/813/903`禁用/隐藏/晚启动/关闭/暴露/重连失败/条目替换；`C/mcp-host-broker.test.ts:75/97`busy/stale；`E/mcp.spec.ts:238/511`临时字段、JSON持久toolExposure及三字段override；D6 | 保留临时动作不写文件、保存不影响live、runtimeId+identity校验；晚响应不得更新新目标面板。认证后同身份连接刷新与忙会话保持有broker断言，归AR-10/16/22 |
| MCP-04 | GUI授权/回填/退出/恢复；身份与URL隔离、秘密不进消息/普通快照：`M/oauth.ts`、`C/mcp-host.ts`、MCP认证UI | `M/oauth.test.ts:187/226/248/267/308/348/388/415/511/552/574`本地OAuth、state/issuer、回收、刷新/scope/退出/身份/坏文件；`C/mcp-host.test.ts:370/519/561`一次回填、目标失效、销毁；`E/mcp.spec.ts:572`多窗/旧提示/取消重开/退出/busy；D6 | 保留官方OAuth协议与本地测试服务，认证回填短期存活；登录/刷新/退出互斥和轮换文件保存不得降为仅UI模拟；AR-10/16/22 |
| MCP-05 | 新增/修改/删除、保留无关字段、共享影响/revision提示、重载/结束时回收连接子进程：config store、MCP面板、host关闭 | `M/config-store.test.ts:626/673/707/730`旧revision/外部已改/同进程并发/写失败；`M/stdio.test.ts:194`慢初始化及孙进程；`C/host-mcp.test.ts:504/536/578/596`会话隔离/重载/慢初始化/晚启动；`E/mcp.spec.ts:238/448/511`PID回收/冲突保草稿/删除确认；D6 | 切换浏览器视图保持后台会话运行；连接随其所属会话重载、删除和服务退出回收，不能把视图切换改为终止任务。销毁矩阵、平台权限跳过及异常原因归AR-22/34 |

### 5.2 OUT-01～04的现有部分

| ID | 当前实现与盘点结论 | 后续边界 |
| --- | --- | --- |
| OUT-01 | 已有回复复制、`/copy`、aui Markdown下载；未见完整HTML/JSONL导出与敏感确认验收 | 保留已有动作；完整能力仍属G1.5，Markdown下载不能替代HTML/JSONL或活动分支要求 |
| OUT-02 | 内置索引列出`/share`未实施；没有分享目标选择/上传确认/结果链接的完整GUI流程 | 仍属G1.5，整改不新增分享服务 |
| OUT-03 | 已有getHostInfo与安全摘要复制；`/bug`/`/debug`仍标G1.5 | 保留诊断部分；会话内容导出/上传审阅和报告适配不计已交付 |
| OUT-04 | 现有输入快捷键、关闭页面及停止运行；命令索引的hotkeys/changelog/quit未实施 | 保留多窗关闭不终止运行；帮助、版本/变更说明与明确结束操作仍属G1.5 |

### 5.3 能力ID之外的既有交付

| 交付 | 当前证据 | 整改后的保留要求 |
| --- | --- | --- |
| 多项目工作区 | `C/workspace-store.test.ts`原子写/revision/损坏状态；`C/host-workspace.test.ts:122/187/221/277/318/353`归属/未归属/起始资源/运行revision/损坏冷读/只读信任；`C/workspace-tools.test.ts:227/285/329/363/398/438/468/502`跨成员工具与运行快照；`E/project.spec.ts`两级列表/成员/固定cwd/归属/信任；D2 | 工作区ID稳定、session cwd固定、每次运行固定成员revision、其他成员不装配扩展/MCP、旧会话明确加入、损坏元数据不覆盖；工作区改名跨窗目前通过显式刷新读取 |
| Base UI主题与键盘 | `E/ui-base.spec.ts:30/65/92/149`模型键盘/附件焦点/主题恢复/弹层Escape；D7 | 沿用Base UI、Geist、现有明暗tokens、紧凑尺度与4px规范；图片/DOM检查不能替代视觉审阅 |
| 输入与流式刷新性能 | `R/runtime/thread-controller.test.ts:2531/2581/2643/2692/2733/2756`帧合并、引用共享、前缀不重算和状态发布；`E/render-performance.spec.ts`250/1000会话无关行执行与SSE数量；D7 | 重写状态接口后保留行为约束，源码注入计数器须迁移到最终组件。生产33ms为历史Playwright往返中位值，不能称INP；长Markdown/树/首次布局另归AR-32 |
| 安全与包边界 | `H/host-routes.test.ts`Host/Origin/token先于读取；设置/认证/MCP路由的正文限制与目标校验；`C/test-support.ts`专用testing入口 | 保留服务校验和秘密按需读取；迁移测试可以保留假client做路由单元验证，实际执行证据仍须SDK与本地服务。静态依赖检查归AR-36，JSON-safe归AR-20 |

## 6. 本次新增证据与问题

问题生命周期、责任步骤和关闭条件只维护在子路线图AR-37～43，本文保存对应源码推导。

1. **嵌套工具没有进入展示模型（AR-37）**：`C/event-mapping.ts`传递parentToolCallId，`R/runtime/thread-state.ts`保存子调用；`message-projection.ts:185`只遍历助手content中的toolCall，读取同ID的执行状态，没有遍历独立子调用或读取parentToolCallId。SDK的codemode子调用属于独立执行事件，已有`C/host-mcp.test.ts:314`和`M/integration.test.ts:478`仅验证SDK事件。子调用参数、进度、错误与工具关联交互缺少可见入口。
2. **工具图片未显示（AR-38）**：`message-projection.ts:88`把非纯文本输出转换为modelContent；`A/assistant-ui/elements/tool-fallback.aui.tsx:1080`只接收result并在1155行显示ToolFallbackResult，没有读取modelContent；应用未注册其他工具renderer。纯图片结果的result为空文字，图片不会由当前默认组件显示。包层资源转换测试和浏览器资源读取标记均不能证明聊天图片可见。
3. **工具editor预填丢失（AR-39）**：`R/runtime/host-ui.ts`将input/editor统一投影为display=text，仅保留标题，未传prefill；工具组件answer初始化及新等待状态重置为空串，Textarea支持多行但未收到预填原文。游离请求组件`A/pi-thread-host-ui.tsx`使用prefill，因而同一editor请求在两条路径上行为不同。现有`R/runtime/host-ui.test.ts:191`和`R/runtime/message-projection.test.ts:604`虽构造带prefill的editor，却精确要求输出省略prefill；这两项断言也须随最终交互模型纠正，并补工具路径的预填和多行编辑证据。
4. **结构操作晚结果改变后来的视图或输入（AR-40）**：`A/session-tree-dialog.tsx`的confirmNavigation只比较当前threadId，未比较草稿版本/面板代次；`session-fork-dialog.tsx`成功后直接switchToThread并写composer，没有检查发起目标仍有效；`import-thread-dialog.tsx`的runImport与pickFile也缺少统一的关闭重开/目标代次检查。`PiThreadHostUi`命令目标领取后还会await刷新再切换，没有窗口选择版本判断。这些是源码确认的保护缺失，本次未运行复现；R2须确定用户显式打开、后台完成和窗口后来选择的优先级。
5. **历史模型回退原因缺少会话归属（AR-41）**：`C/host.ts:2521`得到modelFallbackMessage后仅追加本地diagnostics和全局model-fallback代码；record/快照没有原因字段。`A/pi-host-status.tsx`只在初次/手工/认证版本变化时查询，且仅显示通用回退提示。已有普通模型切换/子会话继承断言，未见正常历史、失效历史和无消息三种恢复及具体原因展示的完整证据。
6. **认证修复提示仍要求重启（AR-42）**：`A/pi-host-status.tsx`缺凭据分支仍显示“认证配置修改后需重启”，但组件已订阅认证版本并重查，G1.4c也已提供登录后刷新目录。此前只纠正开发指南，遗漏产品文案。现有浏览器认证测试验证目录新增，没有检查缺凭据提示的修复指引。
7. **完整快照省略字段时沿用旧值（AR-43，待核实）**：`R/runtime/thread-state.ts`的applySnapshot使用`metadata.contextUsage ?? state.contextUsage`和`readiness ?? state.readiness`。新快照无法表达的未知值可能保留上次已知结果。R2须明确完整替换与增量更新的区别，核对树导航、模型/资源变化及重连；本次只确认保留旧值的代码路径，尚未运行证明具体错误展示。

AR-07补充源码证据：模型选择器换projectPath时没有清空models或设置目标加载态，请求失败也保留旧条目；无键共享缓存又被命令补全和图片预检读取。跨目标目录错误仍需最终运行证据，现有取消旧请求仅防止晚响应覆盖，未解决前目标缓存继续使用。

AR-33补充证据：提前idle断言同时存在于reducer测试和应用回放；editor投影测试精确要求丢弃prefill；Shell恢复测试未证明重新订阅；资源文本测试只检查按钮状态；provider/手动compact成功不能代替自动重试/自动压缩继续；工具执行与资源转换测试不能代替图片、嵌套工具或editor可见内容检查。R8应按这些行为补齐，不以新增用例数量验收。

## 7. 测试迁移分类与最终验收输入

| 处理 | 现有测试/材料 | 最终要求 |
| --- | --- | --- |
| 保留行为，按最终接口迁移 | core目录/信任/树/fork/import/结构互斥/取消；MCP配置、连接、OAuth、权限与子孙进程；生产路由安全/大小限制 | 不降低拒绝副作用、源文件不变、取消后不派发、多窗独立、原子失败和完整回收断言 |
| 改正错误断言 | `R/runtime/thread-state.test.ts:500`、`apps/harness/src/event-replay.test.ts:166`中提前结束的断言，以及host-ui/message-projection测试中editor省略prefill的断言 | 正常运行保持到agent_settled；editor保留预填；预检拒绝、取消前未启动和失败另按R2规范处理 |
| 替换实现相关测试 | useHarnessRuntime系列、Controller私有存储/listeners、aui extras/repository/NOOP、MessageNotSentError桥接 | 改为Zustand动作、提交结果、资源所有权和React订阅行为；仅服务旧aui接入且无保留行为的测试随实现删除，逐项说明 |
| 迁移浏览器定位与计数 | aui data-slot/class、复制/附件/工具审批控件、性能源码注入 | 使用最终组件的可访问名称和稳定标记；保留业务断言与无关行/SSE约束，不能保留旧外壳只为满足定位器 |
| 补充组合与异常证据 | AR-08/11～15/20/22/26/32～34/37～43及表内不足 | 覆盖同目标新输入、换目标/重开、同文跨窗、接受结果未知、自动继续、图片/子调用/editor、秘密与销毁的具体不足；历史异常按AR-34证据要求判断，不机械增加排列组合；使用临时空间/合成模型/本地服务 |

R0交付的是可追踪的盘点，问题仍由后续步骤处理。R1以本文每行的要求确定唯一状态/资源所有者与迁移去向；R2明确状态/提交/版本/JSON-safe及错误语义；R8将最终实现与每项证据逐项对应。R3移除aui状态后旧界面允许不可用，R7接通最终展示并清理剩余引用；无需为中间可用增加同步适配。

## 8. 风险、验证与回退

主要风险是把“测试存在”“历史执行通过”和“全部验收满足”混用。表中已将缺断言、源码缺陷、历史限制和待运行疑点分别说明；后续新增发现继续登记稳定AR编号。本次没有改变能力定义、排除项或G1.5范围，也没有修改历史迭代正文。

### 8.1 文档检查记录

文档检查在本次提交前执行：修改的4份Markdown全文风格检查为0命中、退出码0；本地链接与章节引用、37个能力ID逐项覆盖、AR-01～43唯一连续以及源码引用路径/行号范围均检查通过；`git diff --check`通过。业务源码、依赖与测试保持原样。

业务验证留待获实施授权后的对应步骤。文档可按本次提交恢复，不涉及用户配置、会话或凭据。
