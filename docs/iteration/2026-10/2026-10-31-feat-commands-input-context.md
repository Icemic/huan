# G1.3 命令、输入与上下文：阶段设计

- 日期：2026-10-31
- 基准：Pi SDK 1.4.0；协议7；598项测试、29条Chromium
- 能力：RUN-01～05、RUN-07、MOD-01/04、RES-02/04，补ENV-03启动期交互
- 状态与排期唯一来源：[roadmap](../../roadmap.md)。本文记设计与调研，不另存完成表。

## 1. 目标与边界

GUI可完成Pi日常命令、文件/图片输入、直接Shell、上下文管理及必要扩展交互。沿用真实SDK，窗口关闭不停止任务，取消不当失败，多窗口恢复权威状态。保留现有Base UI紧凑主题、固定cwd和工作区运行快照；不引入IDE、文件回滚、任意TUI转React、认证/MCP配置管理。

## 2. 分项实施

### a 运行操作与上下文

独立迭代实现直接Shell、压缩、模型范围与Thinking能力，具体设计见[运行操作](2026-10-31-feat-runtime-operations.md)。涉及RUN-04、MOD-01/04、RUN-01/05子项；未完成其他子项不标全阶段验收。

### b 命令目录与输入

- 命令路由区分应用内置动作、SDK扩展命令、skill、模板与普通输入；内置优先，再由SDK执行扩展→input→skill→模板。未实施的内置命令明确提示可用阶段，不能发给模型冒充执行。无同名宿主命令的未知slash保持SDK语义。
- 目录来自公开session/resourceLoader/extensionRunner，保留invocationName、参数提示与扩展参数补全，显示来源/冲突；不手工展开模板或skill。
- 文件引用为宿主成员目录查询与补全，插入明确@alias/路径引用；浏览器上传图片与宿主路径区分。图片含选择、粘贴、拖入，提交前校验模型image输入能力。
- 输入历史、每窗口每会话草稿恢复、长输入展开与快捷键；历史消息编辑复用已交付fork而非覆盖记录。运行中可选steer/follow-up，整体取回队列。扩展steer与失败恢复补自动化。

### c 必要Host UI

- 模式绑定rpc；保留confirm/select/input/editor、超时/取消/幂等应答，补可见通知、状态、文本widget和编辑器操作；终端组件明确报告不支持。
- 编辑器本地状态不跨窗覆盖，扩展发起的编辑指令定向发起窗口；无调用方时以明确的请求/接受操作呈现，不任意覆盖所有窗口草稿。
- 启动期交互在record发布前亦可发现、应答。采用独立宿主交互通道，不重跑具有副作用的扩展工厂/钩子来回放答案；bootstrap阶段先启动可查询的宿主，项目资源按需装配。按cwd共享的装配请求具唯一交互ID，取消/销毁释放等待，不持有线程结构闸门而等待无法访问的UI。
- commandContextActions遵循现有独立会话语义；不以默认空成功承接会话切换/重载等操作。G1.4的reload可先做必要依赖，但不借此扩大整个配置阶段。

## 3. 公开SDK调研

核对安装包dist/core/agent-session.js及.d.ts、extensions/runner.js、modes/interactive/interactive-mode.js、公开文档sdk/slash-commands/skills/prompt-templates/rpc-extension-ui。

- prompt处理扩展命令后执行input，再skill与模板；TUI在调用prompt之前拦截内置命令。根入口不导出内置slash表，应用需维护行为索引。
- 交互@补全只插入文本；CLI启动文件参数处理不是交互prompt语义。
- executeBash发bash_execution_update；recordBashResult持久化bashExecution，!!通过excludeFromContext排除模型输入但保留历史。TUI发user_bash扩展事件后执行，限制一条用户Shell。
- compact/abortCompaction公开；setAutoCompactionEnabled保存Pi设置。压缩事件有错误/结果；手动压缩期间prompt拒绝，GUI保留输入并明确忙碌，不静默吞丢。
- setScopedModels为会话内存，SettingsManager.enabledModels为全局持久配置；本轮显式区分会话临时范围与保存用户默认。resolveModelScopeFromModels为公开解析器。
- SDK Thinking含max；现有协议仅到xhigh，需要补齐；模型input模态应透传。
- 当前HostUI在启动期自动默认结算，project_trust为无UI。完整能力须独立通道，不能仅去掉startup开关后导致打开HTTP永久等待而无应答入口。

## 4. 调研补正与开发验收

`resolveModelScopeFromModels`存在于安装包内部声明但未由根入口公开导出，实际实现使用公开`resolveModelScopeWithDiagnostics`。命令遮蔽按运行时扩展→skill→模板，input hook在后两者前处理。公开API以编译及真实SDK回归为准。

- a/b/c完成主体编码及主agent独立review/直接修复。最终亲验38文件/685项测试、47条Chromium、lint/全workspace类型、生产build、Lingui299；原598/29基线保留，自动化无个人数据/付费请求。
- 重点回归：SDK模板/skill展开与扩展显式steer、嵌套gitignore、Shell自定义operations/钩子取消、设置串行保存、队列取回失败、UI增量保持流式内容、编辑器原子领取/双窗定向、启动交互跨窗接管与newSession初始化/血缘。
- 文档链接/JSON与git diff --check已检查；措辞脚本报告为人工候选。未做截图级视觉审阅。
- 配置/认证/资源reload/MCP及输出分享仍归G1.4/5，GUI明确提示。终端专属组件不转React；文件查询仅成员内gitignore，附件刷新只恢复文字。

## 5. 验证与回退

各迭代先设计、DeepSeek Flash max主体编码，主agent直接review/修复并亲验。保持598/29基线，补真实SDK的Shell上下文排除/取消/重连、压缩失败/取消/历史保留、命令覆盖/补全、图像能力和输入恢复、HostUI多窗/启动/销毁测试。只用临时空间与合成模型，不读取个人凭据或会话、不请求付费模型。

每个迭代运行check/build/Lingui和全量Chromium，按实际证据回写长期文档与roadmap。回退按迭代提交撤回，Pi历史保持可读；已执行Shell外部副作用不可回退，压缩原始树保留，用户设置修改需明确范围。
