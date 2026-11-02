# 聊天展示升级：shadcn AI Elements 组件与布局

日期：2026-11-02。源码基线：`5400b8f`，Pi SDK 1.4.0、协议14。实施授权、排序、阶段状态和待决策项由 [roadmap §2.5](../../roadmap.md#25-聊天展示升级方案与实施门槛) 维护。本轮只交付设计，不改业务代码、依赖或测试。

## 1. 目标与设计原则

改善聊天界面的组件组织、信息层级和布局，使后续UI/UX调整更方便。优先使用 shadcn AI Elements 提供的组件与布局，结合 ReUI 的组合方式；采用新布局，不要求新组件模拟旧 assistant-ui 布局。功能和状态语义保持完整，必要时在官方组合模式上补充 huan 专有操作。

组件、布局、主题和运行时分开处理：

| 层次 | 本次原则 |
| --- | --- |
| 组件 | 优先 shadcn AI Elements 的 Message、Reasoning、Tool/Trace、Prompt Input、Attachment 等实际可用组合；基础交互选Base UI版本 |
| 布局 | 以官方模式为起点重新组织消息、工具过程、动作区和输入区；旧DOM、卡片嵌套、按钮位置不作为兼容要求 |
| 主题 | 继续现有本地Geist、明暗tokens、紧凑尺度与4px圆角；不照搬官网主题。需要改变主题规范时另行讨论 |
| 状态与执行 | 保留 assistant-ui runtime/composer/会话选择、huan Controller/reducer/投影及Pi后端，不新建状态管理替代层 |

功能保持按用户可完成的任务验收，不按旧像素、旧DOM或截图相似度验收；也不把“新模板没这个入口”作为删功能的理由。若官方模式缺少队列、分支或Host UI等能力，优先在新组合内添加适当入口，而不是整体退回旧布局。

本文使用 `feat` 分类，因为用户可见的布局与交互组织发生变化；不新增模型或宿主能力。本方案替代本轮未提交的彻底去依赖草稿，后者未实施，不作为后续计划保留。

## 2. 当前依赖与保留边界

路径相对仓库根；`elements/*` 为 `apps/harness/src/components/assistant-ui/elements/*`。

| 当前能力 / 源文件 | 分类 | 新展示采用方向 | 保留的行为/状态 |
| --- | --- | --- | --- |
| `ThreadPrimitive`、`MessagePrimitive`；`elements/thread.aui.tsx` | 视觉 + 上下文 | Chat、Message、Bubble及官方消息布局 | 用现有消息上下文/选择器传入props；来源entryId、角色、稳定消息ID不变 |
| `reasoning.aui.tsx`、`tool-group.aui.tsx`、`tool-fallback.aui.tsx` | 展示 + 局部交互 + 动作绑定 | Reasoning、Trace、Tool、Code Block，按官方过程展示组织 | 思考/工具部分与最终输出、错误、计时、嵌套parentToolCallId、审批/输入/取消保持 |
| `ComposerPrimitive`、`AttachmentPrimitive`；`attachment.aui.tsx`、`pi-composer-controller.ts` | 视觉 + composer状态 | Prompt Input、Input Group、Attachment；重新组织附件和工具栏 | aui文字/附件与发送为唯一入口；命令、历史、草稿、长输入、图片预检和快捷键逻辑复用 |
| `ActionBarPrimitive`、Suggestion、分支/历史动作 | 展示 + 事件 | 基础Button/Tooltip/Dropdown与Suggestion模式 | 复制、树定位/fork/clone等已交付动作保留；按真实能力呈现条件动作 |
| `runtime-data-parts.tsx` 的Shell、压缩、分支摘要 | 渲染分发 + 展示 | Terminal、Trace等所需组合 | 保留现有 `useAssistantDataUI` 分发或等价aui公开渲染入口，不重写数据模型 |
| `ThreadPrimitive.Viewport`、`useScrollLock` | 滚动交互 | 优先在既有滚动机制内更换布局与按钮 | 初期保留流式跟随、主动上滚、回底、折叠稳定；滚动引擎和视觉布局分别决策 |
| `@assistant-ui/react-markdown`；`markdown-text.tsx` | Markdown引擎 + 展示 | 重新组织代码头、复制、表格及排版组件 | 初期保留渲染引擎/GFM/流式处理，按公开components API定制；不因采用新Code Block就更换解析器 |
| `useRemoteThreadListRuntime`、`useExternalStoreRuntime`、`AssistantRuntimeProvider` | 会话/运行时状态 | 保留 | 不重写会话选择、首条初始化、当前Controller绑定与目录适配 |
| `useAui`、`useAuiState`、extras、自有hooks | 状态读取与动作 | 保留，组件边界按需读取 | 稳定动作/细粒度订阅，不在新组件内镜像另一份composer/messages/queue |
| aui消息/repository/AppendMessage、queue/approval适配 | 类型与语义接线 | 保留 | 不调整`@huan/react`公开契约、投影分组或发送错误恢复规则 |
| `assistant-stream/utils`；`packages/react/src/client/event-source.ts` | SSE解码 | 保留 | 不更换parser，不改协议14、重连、seq/generation或大小限制 |

当前已自研Controller/reducer/HTTP-SSE，但前端仍依赖aui状态层。本次不以依赖数量减少或卸载aui为指标；它提供的无头组件和状态hook可以继续使用，不要求为了消除名字而重写。

## 3. 组件接线与状态约束

```text
Pi / core / mcp → protocol / HTTP-SSE → huan Controller/reducer/投影
                                              ↓
                     assistant-ui runtime / composer / message contexts
                                              ↓ 选择所需状态与稳定动作
                     本地展示绑定 + Base UI / shadcn AI Elements组合
```

### 3.1 接线方式

- 复用aui公开hook、消息枚举/上下文与无头primitive；其存在不要求保留旧DOM。新展示组件通过props接收文本、状态、工具数据和动作。简单的一次性渲染直接组合，不为每个按钮新建包装层或通用多后端adapter。
- `pi-composer-controller.ts` 继续处理内置命令、文件补全、输入历史和Shell分流。新输入外观接现有composer文字、附件和动作；官方示例中的本地`useState`文件数组、`useChat`、模型发送不照搬。
- 输入框选择受控值绑定或aui Input的组合方式之一，以实际公开API验证为准；一个DOM输入、一个发送入口。按钮点击、Enter、Ctrl/Cmd+Enter和表单submit不能重复发起。
- 保留现有消息投影与按工具ID关联审批。树/fork/import、workspace-sidebar、定向Host UI继续调用同一aui runtime，视觉调整不另改会话/草稿所有权。
- 折叠、选中tab等局部状态可由React/Base UI组件管理；不把展开状态与工具执行状态混为一体，不复制消息或队列权威。

### 3.2 官方模式与已有机制的冲突处理

| 场景 | 处理原则 |
| --- | --- |
| Prompt Input示例自管文字/文件 | 采用其组件和布局，状态接现有aui；禁止两份文件数组、双写text或双发送 |
| Chat示例使用AI SDK `useChat` | 只取展示结构，保留Pi和现有runtime，不新增AI SDK协议适配 |
| Message Scroller自带滚动运行时 | 优先保留aui滚动引擎并应用新消息布局；不嵌套两套scroll viewport。若官方布局确需新引擎，先验证隔离fixture并讨论范围，再单独安排 |
| Tool/Confirmation示例直接继续工具 | 改接既有Host UI答复/审批动作，保留取消/超时/stale/双窗领取；前端不新增执行权限 |
| 模板未涵盖Pi功能 | 在官方布局中补相应入口与状态；仅有voice/feedback等未配置模板代码不计已交付能力，不为迁移新建这些能力 |

## 4. 布局与功能映射设计

| 区域 | 布局依据与允许变化 | 不可缺失 |
| --- | --- | --- |
| 聊天主区与空白页 | 采用Chat/Message层级与内容宽度组织，允许移除旧气泡/边框和重排欢迎区 | 错误/运行中/等待、历史与流式正文、回底入口、可读长输出 |
| 助手过程区 | Reasoning/Trace/Tool组成过程展示，允许调整折叠、分组和摘要位置 | 文本/Thinking/工具调用顺序可理解，部分/最终输出、错误/取消/嵌套关系、无专用渲染回退 |
| 用户消息与动作 | Message + 按钮/菜单组织，旧按钮位置可改变 | 文本/图片/文件显示，复制、定位树节点、历史fork；不改成覆盖已提交记录 |
| 输入与附件区 | 优先Prompt Input组合结构，附件与模型/Thinking/发送工具栏可重排 | `/`/`@`补全、`!`/`!!`、历史/长输入、选择/拖入/粘贴、模型校验、转向/后续、停止/取回队列、草稿恢复 |
| Shell/摘要与Host UI | Terminal/Trace/Confirmation等组合；专有状态补入同一信息层级 | 实时输出/独立取消、压缩/分支摘要、工具内审批与独立宿主交互；不能隐藏必须用户应答的请求 |

本轮先聚焦聊天主区及直接关联的输入、工具与消息动作；工作区侧栏、顶栏及设置/MCP/认证面板仅做必要的接线与一致性调整，不把整个应用重设计混入。ReUI用于所需组件/布局的补充，具体选用源码及许可需盘点，不预先引入整套ReUI或另一套主题系统。

既有主题token约束控制颜色、字型、圆角与控件规格，不要求继续旧的消息嵌套、页面宽度、工具卡片堆叠或工具栏布局。若AI Elements布局需更合理的内容间距，可在该布局内调整；不把“紧凑”解释为逐像素模仿旧界面。

## 5. 阶段设计与实施门槛

阶段编号V0～V3仅用于本方案，状态与排序见roadmap；本轮不启动任何实现阶段。

| 阶段 | 设计内容 | 交付/出口 |
| --- | --- | --- |
| V0 组件与功能对照 | 以具体官方Base UI示例逐项选择组件/布局；列出新组件树、全部功能入口映射、aui公开接线；需要新包时查成熟版本/许可/传递依赖 | 设计可直接指导实施；无法在现有runtime中组合的项先讨论，不先写替代状态层 |
| V1 消息与工具展示 | Chat/Message/Reasoning/Tool/Trace、图片/数据摘要、Markdown外观和消息动作；复用composer与滚动引擎 | 新消息/工具布局可运行；工具交互与树/fork动作、回退和滚动无回归，独立验证提交 |
| V2 输入与附件展示 | Prompt Input/Input Group/Attachment，重排模型/Thinking/命令与发送工具栏，接回现有composer和命令控制 | 全部输入/附件/队列/快捷键功能通过，无双状态、双发送与新API兼容层，独立验证提交 |
| V3 全体验收与清理 | 新布局完整回归、明暗与窄屏/键盘、性能对照；清理被替换的本地展示实现/无用CSS与文案 | 当前依赖如实保留，许可与架构同步；本轮不以卸载包或更换parser为出口 |

V0需要先选定具体示例并完成入口映射，再授权实施。V1/V2可以复用现有无头primitive与上下文，不长期保留两套可切换展示。每阶段代码/验证/文档完成立即本地提交，默认不push；实施由worker完成，主agent独立review/修复/亲验。设计与取舍由主agent负责。

新增依赖遵守`minimumReleaseAge: 4320`，不绕过发布龄。官方Message Scroller当前Base registry依赖`@shadcn/react/message-scroller`，源码复制不等于零运行时依赖。既有aui间接Radix按项目决定保留，新增自有组件仍用Base UI，不直接引入Radix/cmdk。普通组件优先复用本地ui层，避免重复维护两个Button/Dialog系统。

## 6. 验收、风险与回退

### 6.1 功能与性能

- 以上一开发阶段65文件、983项通过/2项平台跳过、69条Chromium为历史基线，见[d4记录](2026-11-02-feat-mcp-gui.md)。本轮文档阶段未复跑；实施前采集当时基线。可以更新DOM定位和测试计数器位置，不能用保留旧data-slot外壳或降低断言掩盖新组件未接通。
- 保留SES-01～07、RUN-01～07、MOD-01、RES-02/04及其跨窗行为；模型认证/设置/MCP/资源重载面板作为整体回归，OUT已有复制等动作保持，G1.5未交付项不借视觉迭代宣称完成。条件能力对照真实adapter/宿主能力，不能把模板占位按钮算功能。
- 输入重点检查IME/Enter/快捷键、命令分流、旧历史不补记、草稿按窗口/目标恢复、首条初始化/信任等待、图片拒绝保留、提交后新输入、转向/后续/整体取回和停止；错误不能吞掉、不自动重投未知结果。
- 工具重点检查部分/最终/错误输出、并行/嵌套、审批/选择/输入、取消/超时/双窗应答、未知工具/数据回退、Shell/摘要及定向编辑器文本；折叠不能卸掉必须可见的交互而无提示。
- 保留250/1,000会话纯输入/流式期间无关列表行执行为0、SSE不随输入/token增加；稳定动作、按字段订阅、关闭弹层不订阅输入保持。生产同机同fixture测前后中位/P95/长任务，不预先宣称性能提高，不把Playwright双rAF往返称INP。

### 6.2 布局与视觉

视觉验收依据是新组件结构和官方布局原则，不是与旧截图相似。检查明暗主题、窄屏无横向溢出、长代码/工具输出、图片迟到布局、键盘焦点/Escape、可访问名称、读者上滚不被拉回、折叠不跳动及reduced-motion。

DOM/功能回归与截图视觉审阅分别记录。视觉方向需在实际可见产物上核对；图片读取受限时据实说明并保留截图供用户审阅，不能将功能测试通过写成视觉通过。平台手工检查按项目完成口径不阻塞开发完成，发现问题另建迭代。

### 6.3 验证与回退

各代码阶段执行 `pnpm check`、`pnpm build`、Lingui提取及相关Chromium；最终完整Chromium。用隔离用户空间、合成模型、本地stdio/OAuth fixture，不访问个人凭据/会话或付费模型，不停止用户8799/8788服务。环境偶发错误保留证据、定向及完整复跑，不削弱竞态/断流断言，不靠reload绕过状态传播。

主要风险来自新展示组件隐含自管状态、表单重复提交、滚动引擎叠加、工具上下文丢失和新版DOM扩大订阅。遇到需要重写runtime才能继续的情况，暂停相关部分讨论，不自动扩大为去依赖。

回退以阶段提交为单位恢复旧展示代码，不回滚个人Pi文件、共享配置或凭据。仍使用的aui移植实现保留MIT声明；复制shadcn/ReUI组件前核对版本/源路径/许可与本地差异，不因换目录删除来源说明。

## 7. 调研来源与未验证边界

访问日期2026-11-02。网页/registry内容只证明组件与示例存在；未安装候选包，不代表React19/构建/性能与全部接线已经验证。

- [shadcn AI Elements](https://ui.shadcn.com/docs/ai-elements)：官方组合与Base UI示例路径。
- [Chat](https://ui.shadcn.com/docs/ai-elements/base/chat.md)、[Prompt Input](https://ui.shadcn.com/docs/ai-elements/base/prompt-input.md)、[Tool](https://ui.shadcn.com/docs/ai-elements/base/tool.md)：组件结构与示例状态接线可分离。
- [Message Scroller](https://ui.shadcn.com/docs/components/base/message-scroller.md)、[Base registry](https://ui.shadcn.com/r/styles/base-nova/message-scroller.json)：额外滚动runtime依赖需单独核查，当前设计保留aui滚动。
- [ReUI文档](https://reui.io/docs)：补充组件组合来源；文档存在Base UI/Radix路线，选取时核对具体版本，不能不经检查整套导入。
- 本仓库 `packages/react/src/runtime/*`、`src/client/event-source.ts`、应用 `components/assistant-ui/elements/*`、`pi-composer-controller.ts`、`runtime-data-parts.tsx`、树/fork/import/Host UI调用与相关测试；订阅约束见[刷新性能记录](2026-11-01-perf-react-subscriptions.md)。
