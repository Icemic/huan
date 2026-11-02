# 整体架构整改：所有权与启动设计

日期：2026-11-02。分类：feat（涉及公共API与架构变更）。关联：[整改子路线图](../../architecture-remediation-roadmap.md) R0/R1；步骤和问题状态仅由子路线图维护。本文保存当时启动研究。候选结构与待定项现由[R1所有权设计](2026-11-02-feat-architecture-remediation-ownership.md)、[R2协议方案](2026-11-02-feat-architecture-remediation-protocol.md)及[复杂度审查](2026-11-02-refactor-architecture-design-complexity.md)取代；以下旧候选不再形成实施要求，历史检查记录保持原样。

## 1. 已确认目标与研究方式

前端业务状态统一Zustand，移除assistant-ui生态运行依赖；同时整理Node服务、协议、模块、业务流程和文档。`refactor`中间提交允许不可用，只在最终合并验收。不以过渡adapter、旧接口或每阶段检查通过组织实施。

研究以代码/类型/测试阅读和Git历史为依据。本轮未修改业务代码、依赖或测试，未运行构建、业务测试或探针。Zustand已安装，公开`zustand/vanilla`提供`createStore/getState/setState/subscribe`，无需为研究安装新包。本文方案未通过运行验证。

## 2. 启动调研发现

### 2.1 前端并非只需替换一个消息store

| 当前入口 | 实际责任 | 最终需要明确的归属 |
| --- | --- | --- |
| `packages/react/src/runtime/thread-controller.ts` | 持state/stateSnapshot、投影/repository、三组listeners，处理load/connect/send/cancel/queue、乐观条目及代次 | Zustand会话状态与业务动作；连接/中止等资源由实例持有，删除旧存储订阅体系 |
| `runtime/use-harness-runtime.ts` | Controller registry、React订阅、aui适配、NOOP占位、首条初始化乐观消息、目录adapter | 明确的浏览器实例、窗口选择、创建/提交动作；删除aui初始化路径和无效占位动作 |
| `runtime/hooks.ts` / `extras.ts` | 经aui thread extras取Controller/metadata/actions | React直接使用Zustand selector及稳定动作，不经过另一个运行时 |
| `workspace-context.tsx` / `workspace-sidebar.tsx` | 服务实例/工作区/会话目录、选择/展开/创建偏好，与aui目录合并 | 目录唯一缓存、窗口独立选择、按需派生分组 |
| `pi-composer-controller.ts` | 命令/补全、草稿/历史/长输入、图片预检、Shell、排队、提交后清理 | 业务动作和草稿状态；DOM事件处理只保留必要绑定，不继续巨型hook |
| `pi-http-client.ts` | 创建时读取全局模型草稿、派发DOM事件使目录重查 | 纯transport，显式业务动作传入完整input并负责目录失效 |
| `pi-model-*` / `resource-version` / bridges / theme | 各自的模块缓存、订阅、一次性意图 | 有作用域的Zustand状态与动作；取消分散的业务单例 |
| 设置、MCP、认证、树、运行操作面板 | 原文/安全快照、草稿、目标、查询代次、busy/error和大量JSX | 按目标/面板实例的状态与业务流程；安全内容不进入普通消息或全局持久化 |

### 2.2 Node服务应先确定所有权，再拆模块

`core/src/host.ts`的关键关联包括：

- 装配：projectRuntimes/pendingProjects、可信ResourceLoader、共享ModelRuntime、未消费pending装配和启动交互。
- live会话：records/pendingOpens/recordsBySessionFile、generation、资源与事件订阅、MCP binding。
- 操作：startingSends/inFlight/currentRun/admission、单会话structure、Shell、树/分支/重载。
- 数据：sessionDir作用域/目录缓存、WorkspaceStore、已加载与未加载会话metadata/snapshot/details。
- 清理：先使资格失效，再解除交互、取消并等待运行和结构操作结束、回收MCP/扩展，最后关闭共享OAuth/log。

这些关系保护并发行为。先按模块名单拆host会让共享可变状态变成大量双向回调，因此R1必须先写唯一持有者与操作调用方向。认证broker/MCP manager已有相对独立边界，优先复核和接入，不整体推倒重写。

### 2.3 协议研究的优先级

当前`HarnessClient`是全部能力的集合。`HARNESS_PROTOCOL_VERSION=14`目前未见服务端/客户端协商；统一命令requestId、rawPiEvent和sessionId信封没有对应实现。不能先按架构旧图补字段。

最先核定的是运行结束、输入接受与失败、未知结果、请求/队列身份、快照重置与迟到响应。目录/面板方法按领域组织是第二层问题，schema生成或新增公共包不作为前提。

## 3. 建议的最终职责模型

这是用于收敛R1的候选模型，具体类型、文件清单与拆包方案须在R1确认。固定原则不再讨论是否使用Zustand、是否保留aui状态或是否缩小为UI替换。

### 3.1 状态与资源所有权表

| 数据/资源 | 权威与作用域 | 前端状态/动作建议 | 持久化、失效与销毁 |
| --- | --- | --- | --- |
| 消息、分支、模型、运行、队列、Host UI | Pi/服务端权威；按服务实例+会话ID | 每会话Zustand store；快照/事件统一进入动作；乐观提交有独立身份 | 不把前端缓存写Pi文件；重连权威快照恢复，generation拒旧事件 |
| 工作区/会话目录、元数据健康 | 服务端权威；按agentDir/session存储作用域 | 实例内目录store；live元数据合并同一实体缓存，分组/搜索为派生 | 显式重扫/业务写入/权威通知失效；不用第二份aui目录 |
| 当前会话、工作区、创建目标、模型预选 | 当前窗口权威 | 窗口Zustand store；空白目标为显式类型，不用`__pending__`假会话 | sessionStorage按目标与服务实例隔离；切换只改变视图，不中止后台 |
| 文字、附件、输入历史、提交记录 | 当前窗口/草稿目标权威 | 草稿store，提交固定revision/附件身份/目标；历史只接本窗动作 | 仅文字按既有规则持久化；附件/预览URL受控释放，不存base64历史 |
| 模型/命令目录、资源版本 | 服务端结果；目标+版本有键缓存 | Zustand查询状态与明确失效动作 | 资源reload/认证/目录revision失效，旧响应不能覆盖新目标 |
| 设置/MCP配置原文与编辑草稿 | 服务端文件权威；前端未保存草稿为窗口/目标/面板实例所有 | 面板Zustand store；安全摘要和可能含秘密的编辑状态分开 | 仅编辑时读取，保存≠应用；不得默认persist/devtools记录秘密 |
| provider/MCP认证与启动交互安全投影 | 服务端broker权威 | 实例Zustand缓存；轮询/订阅由资源所有者启动和关闭 | 关闭面板不取消后台操作；回填秘密短生命周期、不进持久化/普通快照 |
| 面板开关、命令意图、树定位、主题 | 窗口业务状态 | Zustand窗口/feature store；以动作取代模块listeners/DOM通知 | 主题按localStorage；一次性意图消费与目标固定，无跨实例单例串扰 |
| 线程展示模型、工具/data分发 | 从会话状态派生 | 纯投影/selector或有明确依赖的缓存，不成为另一份可写业务状态 | 稳定来源entryId/toolCallId；仅变更段重算，未知数据有回退 |
| SSE/fetch/AbortController/timer/预览URL/DOM ref | 当前浏览器实例/会话/组件资源 | 无独立业务store；在闭包或资源表持有句柄，业务状态写Zustand | acquire/release/dispose明确，资源结束不能私自改当前窗口目标 |

一套状态机制允许按领域/实例组织多个Zustand store。不得为每个组件随意创建永久store；每个实例的创建者、消费者和释放者必须能在表中定位。组件内部交互细节不要求重写React/Base UI本身，但共享状态、业务表单草稿、请求状态和流程进度不能留作平行业务状态。

### 3.2 模块与包的候选边界

```text
apps/harness/server → @huan/core → @huan/mcp / Pi SDK
                           ↓
                     @huan/protocol
                           ↑
浏览器transport → Zustand stores + 业务动作 → React selectors → 应用界面
```

建议先在现有`packages/react`内部划清transport、纯模型/归约/投影、Zustand实例与业务动作、React绑定；应用专属命令/管理面板留应用层。模块单向引用，React绑定不成为业务动作前提。

是否新增独立浏览器包，应以依赖图和非React消费者需求决定；当前不先建新包，也不因包名叫react就让纯transport依赖aui。目标是最终边界清楚，无需复制上游scope/client/runtime层次。

实例工厂显式接收client和服务实例/窗口作用域，Context可传实例；资源表不再持有消息/草稿等可订阅业务状态。Zustand动作可以异步调用transport，纯reducer可由set调用；不再通过复制状态绕回旧Controller。

Node服务候选模块为装配/信任、目录与冷读、live会话生命周期、操作协调、配置/资源服务及既有认证/MCP服务。具体拆分以能消除共享可变所有权为准，避免每个HTTP方法一个转发文件。

## 4. 开工前必须写清的业务时序

### 4.1 首次创建与发送

1. 提交动作一次性捕获窗口目标、模型/Thinking、文本、附件身份与草稿revision，生成本地提交ID；校验/异步图片读取不会重新读取“当前会话”作为目标。
2. 显式执行创建/信任/启动交互，结果绑定本次提交；用户切换目标或关闭视图不使晚结果夺回窗口，也禁止自行重试创建。
3. 向确定的会话发送，区分started/queued/handled/cancelled、明确未接受及执行结果未知。清空/恢复只处理本次草稿版本，新输入保留。
4. 权威事件与请求回执可能先后颠倒；乐观消息按身份/可实现的协议关联协调。目录、窗口选择与草稿迁移由业务动作明确更新，不靠DOM通知/effect猜测。
5. 明确本地取消是否尚未派发、是否已被服务端接受；关闭窗口与停止运行分开。无幂等保障的网络错误须保留未知结果，禁止自行重投。

### 4.2 其他必须纳入同一设计的流程

| 流程 | 关键边界 |
| --- | --- |
| 已有会话发送/steer/follow-up/取回/停止 | 本地未派发、服务端已接受、重复文本、取消租约与下一轮运行隔离 |
| 树导航/fork/clone/import | 结构闸门、revision、队列取回、子会话独立、只有发起窗改目标/草稿、失败不丢内容 |
| 设置/MCP保存与reload | 原文按需、共享文件冲突、保存和live应用分开、目标重开generation、旧连接完整回收 |
| 认证/Host UI/定向编辑器 | 后台流程不依赖Dialog存活、秘密不进缓存日志、双窗唯一领取、关闭/重开/服务重启 |
| 窗口/会话实例释放 | StrictMode重挂、切换/删除/最后消费者释放、在途fetch与SSE晚回调、认证轮询与图片URL清理 |

## 5. 建议的启动顺序与交付判据

### 5.1 先完成R0/R1设计

下一份设计以本文§3为基础补齐到每个业务状态/资源/公开动作的去向；同时把G1.1～G1.4的要求逐项关联旧证据与最终回归。对尚未调查的部分标明空缺，不宣称整体审计完成。

R1确认时必须能回答：谁创建浏览器实例、谁选择会话、谁拥有未发送草稿、一次提交何时固定目标、资源如何关闭、服务端如何结算。应附最终目录与依赖图、主要类型草案和旧文件处理清单，不要求运行原型。

### 5.2 然后确定R2协议与行为规范并给首个编码工作包

建议首个编码工作包覆盖最终前端状态基础、会话目录/选择、事件归约及创建/提交动作所需边界，直接替换旧机制；旧界面可以暂时无法编译。Node服务拆分按R5依赖推进，不因这个编码顺序被取消。

公开接口不清时先解决语义，不先生成大量store方法。输入/取消/队列/结算是最先需要讨论的跨端行为要求；Markdown库、滚动库和具体视觉组合可在展示接入设计时确定。

### 5.3 尚需收敛的设计细节

- Zustand实例划分与store粒度：候选为服务实例作用域目录、每会话、窗口/草稿、按需feature面板；依赖图确认后固定，避免任意全局单例。
- 客户端提交ID是否进入wire、如何关联Pi队列/消息：现有协议只有文本队列；先核对SDK可提供的确认边界，不能承诺Pi不支持的逐项队列操作或exactly-once。
- 版本策略/JSON-safe/错误分类：选择最小可执行规则，同时纠正旧文档；不建设通用多后端/RPC框架。
- Node服务模块间所有权与关闭顺序：共享资源集中持有，record资源随record终止，准备中装配也必须回收。
- 认证与配置秘密的状态边界：Zustand统一管理不等于所有store都可持久化或被调试工具记录；在详细设计固定哪些状态可观测、何时清空。

这些是后续R1/R2设计内容，不要求用户重新选择已确认原则。确认具体设计后才安排worker编码；过程中需要验证关键疑点时先说明并取得相应授权，不再擅自新增探针。

## 6. 风险、最终验证与回退

中间分支不可用会把部分问题集中到集成阶段，通过所有权/时序/删除清单和问题清单控制风险，不维护过渡架构。跨端行为偏差先讨论后修订；未确认的设计不派发编码。

最终验证按子路线图§6，覆盖全部已交付能力和本次缺陷，不沿用错误断言、旧测试计数或撤回V1结果。回退以分支提交为单位，不处理个人数据；合并前须用户确认，默认仅本地提交。

## 7. 本次文档交付检查

此前已检查本次8份Markdown的本地链接/章节锚点、AR-01～36的唯一性与顺序，`git diff --check`通过；业务源码/依赖仍与5400b8f一致。此前文档风格检查剩余246处命中，未全部改完，交付说明漏报了该状态。本次对8份Markdown全文执行风格检查，结果为0命中、退出码0；在AGENTS.md规定以后必须将全部命中改完并复查至退出码0，既有正文、历史标题和项目术语均须处理。检查脚本、词表与白名单保持原样。本地链接与章节锚点共检查99项（含18项来自其他文档的引用），均有效；AR-01～36唯一且顺序正确，`git diff --check`通过。业务源码与依赖保持原样，未运行check/build/浏览器，文档检查不计为功能验收。
