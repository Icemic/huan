# G1.3a 运行操作与上下文

- 日期：2026-10-31
- 阶段设计：[命令、输入与上下文](2026-10-31-feat-commands-input-context.md)
- 能力：RUN-04、MOD-01/04；RUN-01/05相关状态子项
- 基线：Pi1.4.0，598测试/29Chromium，协议7

## 1. 目标与范围

1. GUI直接运行用户Shell、查看实时输出与取消，!纳入上下文、!!排除上下文，均保留历史。
2. GUI手动压缩（可附指令）、取消，显示自动压缩开关及其保存范围，失败保留历史并允许恢复。
3. 模型目录显式刷新、能力模态/Thinking完整透传（含max）、会话模型范围配置与切换；用户默认范围仅显式保存。

本迭代先建立操作面板和RPC动作；完整slash路由、文件引用/草稿、HostUI在b/c实施。本迭代若拦截!与/compact，必须记录具体入口及范围，其他命令不伪报执行。

## 2. 设计

### 2.1 Shell

- 公共动作executeThreadBash/abortThreadBash（命名按现有风格调整），调用公开SDK user_bash扩展事件→executeBash，options.excludeFromContext承接!!。如扩展handled，自定义结果也按SDK recordBashResult语义保留。
- 每会话同时一条用户Shell；第二条明确busy。结构操作、删除、冷打开、运行发送与Shell互斥策略统一可见：Shell可与模型运行并存（SDK pendingBashMessages保证持久顺序），树导航/fork/压缩不得越过正在执行Shell；停止Shell独立于停止模型，删除/销毁先取消并释放等待。
- 宿主在await前登记shellId/command/excludeFromContext/输出，实时事件带id。只维护有界输出（按SDK输出截断规则或明确上限）以便重连；完成后以持久bashExecution+最终快照替换运行态，不重复消息。禁止每个chunk全树聚合。
- UI操作面板明确工作目录/非沙箱风险、上下文包含选项、运行/退出码/取消/错误；历史卡片折叠/复制，实时输出可读。窗口关闭不取消，其他窗口可接管取消。

### 2.2 压缩

- 手动compact前必须空闲，无发送预检、Shell、结构操作；在SDK await前占用结构闸门。运行中显式先停止，或提示先停止再操作，不隐式取消工作。compact与树导航摘要的取消互不混淆。
- 返回started/长操作状态与结果，或以现有HTTP长请求+实时事件同步；刷新/断线仍能看到compactionActive、reason与错误。取消用公开abortCompaction；压缩中发送明确busy且保留输入，不静默投递。
- compaction_end保留errorMessage/结果必要摘要，agent_settled为运行结算权威；失败不抹除原始消息树。
- 自动压缩开关调用SDK setter，界面明确保存到当前agentDir用户设置，不误称临时会话参数。切换成功后同步已打开会话的有效状态（独立settingsManager的缓存需要处理），未来会话也恢复。

### 2.3 模型与Thinking

- HarnessThinkingLevel增加max，模型thinkingLevels依SDK能力列表，不硬编码模型名称。HarnessModelInfo增加input模态，历史fallback消息保持可见。
- 模型范围按Pi enabledModels/resolveModelScope公开规则解析，允许空范围表示全部，包含不可用/无匹配诊断。默认只改会话scopedModels；保存用户默认是独立显式操作，保持其他设置字段。新会话/冷打开读取保存范围。
- 当前结构闸门与运行时不能切换模型/Thinking的规则不变；选择器标明原因，范围配置不意外换模型；显式循环/选择时使用有效scope。目录刷新调用真实modelRuntime，不重建live session或执行付费prompt。

## 3. 协议与界面

协议加一版；client/HTTP/校验/fakes/controller/hook/投影贯通，core不依赖React、react不依赖Node。应用使用Base UI Dialog/Popover/Select；面板通过上下文栏/输入区可发现入口，必要长输出自定义renderer，不新增cmdk/Radix直接依赖。i18n中文。

模型目录刷新、范围与自动压缩保存必须显式指定会话/固定cwd，不能使用窗口当前工作区替代live cwd。新建空白页可刷新目录；需要会话的操作提示先建立会话。

## 4. 验证

- core真实SDK：Shell输出增量/!和!!模型context/退出码/取消/并发/删除和销毁/运行并存/user_bash处理；压缩成功/失败/取消/结构互斥/原树保留/自动设置重启及live一致；模型范围解析/保存与其他字段保留/Thinking max。
- react：新事件归约、快照恢复、失败状态及取消、Shell完成不重复；HTTP路由鉴权/非法输入、客户端载荷校验。
- Chromium在原29条基础增加Shell双窗实时与重连/取消、上下文压缩（合成摘要）/取消和恢复、模型范围/刷新/Thinking能力；不通过reload掩盖状态传播。
- 最终主agent亲验pnpm check、build、lingui:extract、test:e2e，记录具体数量与未测事项。

## 5. 风险与回退

Shell外部副作用无法撤销；界面明确直执行。压缩可能产生费用，真实自动化仅合成provider。SettingsManager并发缓存须避免丢写；保存失败如实报错，不假成功。公开SDK确实无法支撑时暂停受影响项并报告证据，不私有深导入。代码回退按迭代提交，不迁移Pi JSONL。

## 6. 实施与验证记录

主体编码后由主 agent 独立 review、直接修复并亲验；完成状态由 roadmap 维护。

### 6.1 协议与宿主

- 协议升到 8：`HarnessThinkingLevel` 增加 `max`；`HarnessModelInfo` 增加 `input` 模态；新增运行操作契约（`runtime.ts`）：
  - Shell：`HarnessBashRun` / `HarnessBashStartResult` / `HarnessBashAbortResult`，事件 `bash_start` / `bash_output` / `bash_end`，快照 `bash`；
  - 压缩：`compaction` 运行态（原因与最近失败）、`compaction_end` 增加 `reason` / `errorMessage` / `tokensBefore` / `estimatedTokensAfter`、`HarnessCompactionOutcome`；
  - 模型：`HarnessModelScope`（会话范围、解析诊断、已保存默认）、`HarnessModelRefreshResult`、自动压缩保存结果。
- `@huan/core`：
  - Shell 走公开 `user_bash` 扩展事件 + `executeBash` / `recordBashResult`；`!!` 经 `excludeFromContext` 承接；先同步发布运行态，再异步等待扩展决定；取消覆盖钩子窗口，防并发与取消后启动；输出有界（120k 字符，增量事件带 `dropped`），完成后以持久 `bashExecution` 消息替换运行态；删除/销毁先取消并等待；
  - 手动压缩占用结构闸门，失败/取消保留原始消息树，`abortCompaction` 只取消压缩；用户设置通过独立SettingsManager串行写入、flush与磁盘校验，失败不改live缓存或反向回写旧值，成功后同步各live会话缓存；
  - 模型范围经公开 `resolveModelScopeWithDiagnostics`；空范围=全部；非空但无匹配时不静默扩大范围；保存用户默认是独立显式操作（写后校验磁盘）；新会话与冷打开读取已保存范围；目录刷新走共享 `modelRuntime.refresh`（不重建会话、不发起模型请求），同一时刻只跑一次；
  - Thinking 能力按 SDK 规则解析（`xhigh`/`max` 需显式映射，非推理模型仅 `off`），并透传模型输入模态。
- HTTP：新增 `/threads/:id/bash`、`/bash/abort`、`/compact`、`/compact/abort`、`/auto-compaction`、`/model-scope`（GET/POST）、`/models/refresh`；非法载荷 400，沿用统一 Host/Origin/凭证校验。
- `@huan/react`：新增事件与结果守卫、Shell/压缩状态归约、Controller/extras 动作与 HTTP 路由、`bash_*` 事件通知状态订阅者（修复只改内部状态不触发渲染的问题）。
- 应用：会话上下文栏新增“运行操作”面板（Shell 实时输出/取消/上下文选择、压缩与自动压缩、模型目录刷新/范围/能力标签）；补齐 bash/压缩/分支摘要数据消息渲染器（折叠、复制）。

### 6.2 主 agent 自动化验证

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过（0 error / 0 warning） |
| `pnpm check` | 通过：全 workspace 类型检查 + 642 项测试（33 个测试文件） |
| `pnpm lingui:extract` | 通过：zh-CN 275 条 |
| `pnpm build` | 通过（保留既有大 chunk 警告） |
| `pnpm test:e2e` | 通过：33 条 Chromium（原 29 + 新增 4） |

新增自动化覆盖：

- core（真实 SDK + 临时空间 + 合成模型）：`!` 实时输出/退出码/上下文纳入、`!!` 排除但保留历史、并发 busy、与模型运行并存且不重复、结构互斥、删除取消、扩展 `user_bash` 代执行与启动期并发拒绝；压缩成功/失败/取消/结构互斥/原树保留/自动压缩写盘与多会话一致性/写盘失败不伪报；模型范围解析与保存、无匹配诊断、重启冷读、Thinking max、输入模态、目录刷新。
- react：bash 事件归约与通知、快照恢复、压缩错误与取消、HTTP 路由与畸形载荷拒绝、Controller 动作转发与失败记录。
- Chromium：Shell 实时输出与历史卡片、双窗实时 + 断流重连 + 独立取消、手动压缩成功与取消后恢复、自动压缩保存/新会话继承、目录刷新、范围保存与继承、Thinking max 与图像输入标签。

### 6.3 未完成与已知限制

- 本迭代只做 a 阶段：完整 slash 路由、文件引用/草稿/输入历史、Host UI 通道与启动期交互仍属 b/c，未实现。
- 压缩中发送在宿主明确返回 busy 并保留服务端状态；浏览器输入框的“保留草稿”体验依赖 b 阶段的输入恢复，本轮未扩展。
- Shell 外部副作用不可撤销；面板已明示非沙箱与固定起始目录。
- 冷读的自动压缩开关按用户设置显示（不加载项目设置），项目覆盖只有打开为 live 会话后才会反映；已在代码注释中说明。
- 模型范围面板按 `provider/modelId` 保存；带 `:thinking` 后缀的原始模式在保存时会归一化为模型 ID。
- 主 agent review直接修复：user_bash的自定义operations委托、钩子等待期的运行态与取消、重复Shell结果不误匹配旧历史、有界完成输出、用户设置串行独立写入及缓存loader消费前reload、异步作用域解析后的退休校验、面板切会话请求隔离、目录刷新代数与模型选择器范围禁用。新增4条core回归，既有浏览器范围用例补真实选择器禁用断言。
- 主 agent亲验check（642项/33文件）、build、Lingui275、33条Chromium；仅既有大chunk提示。未做截图视觉审阅。
- b/c继续按阶段设计实施；本迭代完成不代表G1.3全阶段验收。
