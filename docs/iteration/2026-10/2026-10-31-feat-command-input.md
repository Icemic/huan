# G1.3b 命令目录与输入

- 日期：2026-10-31
- 阶段设计：[命令、输入与上下文](2026-10-31-feat-commands-input-context.md)
- 前置：a运行操作，主agent642项测试/33条Chromium
- 能力：RES-02、RUN-02/03/07；RUN-01/05剩余展示与交互状态核对

## 1. 目标

普通prompt、内置命令、扩展/模板/skill、Shell分别按Pi交互语义执行；提供可发现目录、参数补全与文件引用；输入历史/草稿/长输入与错误恢复可用。保留队列整体取回和分支编辑语义。不实施c的独立HostUI通道与启动期交互，不提前展开G1.4配置/MCP。

## 2. 命令路由

- 宿主提供公开SDK资源命令目录（扩展invocationName、description/argumentHint/sourceInfo，模板，skill启用开关）与扩展参数补全查询。内置索引由应用维护，不能深导入SDK slash表。目录应说明覆盖，内置优先，其余交给session.prompt处理扩展→input→skill→模板；未知非内置slash沿SDK原样透传。
- 已交付GUI操作均可用slash打开相应面板或直接执行带参数动作：/model、/thinking、/scoped-models、/compact、/new、/resume、/name、/session、/tree、/fork、/clone、/import、/trust、/copy。需要二次确认的fork/clone/import/信任沿用现有Dialog，不因slash跳过确认。缺参数打开专用入口，有参数应可回填/执行，不静默忽略。
- G1.4/G1.5尚未实施的Pi内置命令（settings/login/logout/llama/reload/export/share/bug/debug/hotkeys/changelog/quit等）明确提示尚无入口或既有等价路径，禁止普通prompt误发模型。支持范围/未实现原因在命令目录可见，未实现不宣称成功。
- 输入!与!!在提交处解析后走a的直接Shell动作；前缀去掉，!!设置excludeFromContext。只匹配输入首部，普通文本中间的!不误触发，附件不混入Shell或内置动作并明确提示。
- 前后端共享最小命令行为契约：宿主sendMessage亦须拒绝保留内置命令绕过GUI成为普通prompt（可返回类型化错误/明确命令路由结果），扩展命令覆盖内置遵循Pi TUI；不构造全套通用command bus。创建首条消息也遵守路由，空白页必须能选模型/命令而不误创建会话。

## 3. 输入体验

### 3.1 命令与文件补全

输入/触发按钮提供可键盘操作的Base UI列表；/目录与参数提示，扩展getArgumentCompletions按需调用，防旧请求覆盖。宿主文件查询限当前会话/选中工作区成员，支持@alias路径、空格引用、cwd与跨成员。只返回路径/类型，不将文件内容预读成prompt；插入引用保持Pi交互语义。尊重隐藏文件与忽略约定、排除.git和node_modules；查询限量/可取消，不全仓每按键递归无界扫描。若现有SDK打包fd公开接口可复用优先，无须新增工具依赖。绝对路径/canonical symlink作用域明确，搜索不等于OS沙箱，未知目录不遍历个人空间。

### 3.2 图片

现有选择/拖入基础补粘贴，并在送出前校验当前模型input image；新会话草稿模型也校验。拒绝时保留文字与附件，不能把附件清掉。浏览器上传与宿主路径区别可见；图片预览/移除焦点回归不削弱。

### 3.3 草稿与历史

每浏览器窗口按会话ID/cwd的草稿写sessionStorage，防跨窗口自动覆盖，刷新/切会话可恢复；新建草稿键绑定工作区+起始cwd，后端会话建立后转移。附件base64不进持久存储，明确刷新仅恢复文字。输入历史是本窗口已提交的文字（有上限），键盘在空框/首尾位置浏览，输入法合成不触发发送或历史切换；失败后文字/附件可找回。长输入可展开Dialog编辑，Esc取消保留原草稿。历史消息编辑复用fork确认与原文恢复，不覆盖Pi记录。

### 3.4 队列与状态

明确选择steer或follow-up，排队显示类型，可整体取回，不实现SDK不支持的逐项删除/提升。取回包括Controller尚未确认的乐观输入，失败不复活。检查文本/Thinking/工具参数与输出/错误/图片和长内容通用回退；压缩/重试/交互等待/取消/失败状态可区分，agent_settled前不得提前空闲。相关能力按完成清单逐项回写，不能只凭UI控件存在验收。

## 4. 风险、验证与回退

先读取当前runtime/assistant-ui composer API，再选最小接入点；不另建第二套会话或输入权威状态。App特有内置动作留应用层，文件/命令目录等可复用RPC贯通protocol/core/react/HTTP。禁止直接Radix/cmdk；代码注释中文，文案Lingui。

自动化保持642项/33条基线，补真实SDK命令覆盖/模板参数/skill加载/扩展参数补全（零付费）、文件查询含symlink/成员/忽略/中文空格、图片不兼容保留、草稿刷新/切窗隔离/首条/错误、长输入/IME/历史、显式steer/follow-up与整体取回。Chromium真实HTTP/SSE无需个人凭据，不用reload遮掩跨窗状态。最终check/build/Lingui/test:e2e由主体自测后主agent独立review直接修复亲验。

回退按迭代提交；草稿为窗口文本缓存可清理，不改Pi文件格式或恢复项目文件。若必须改变设计或公开SDK真阻塞，先报告证据讨论。

## 5. 实施与验证

### 5.1 主体实现

- **命令路由**：应用维护 Pi 1.4.0 内置行为索引（含 `/debug` 与隐藏彩蛋的守卫名单），`/model`、`/thinking`、`/scoped-models`、`/compact`、`/new`、`/resume`、`/name`、`/session`、`/tree`、`/fork`、`/clone`、`/import`、`/trust`、`/copy` 均可从输入首部执行；`/fork`、`/clone`、`/import`、`/trust` 复用既有确认弹层。`/settings`、`/login`、`/logout`、`/llama`、`/reload` 显示 G1.4，`/export`、`/share`、`/bug`、`/debug`、`/hotkeys`、`/changelog`、`/quit` 显示 G1.5，未实施命令不发送给模型。
- **提交守卫**：`sendMessage` 与 `createThread.initialMessage` 在宿主预检前拒绝已知内置 slash（`ReservedBuiltinCommandError`，HTTP 409）；未知 slash、扩展、模板与 skill 仍交给 SDK 原有顺序。`handled` 提交点补发权威快照，客户端据 `sendMessage` 的 `disposition` 撤销乐观输入，避免扩展命令留下假用户消息。
- **资源目录与补全**：新增 `GET /commands`、`POST /commands/arguments`、`POST /files`；活会话组合公开 `extensionRunner.getRegisteredCommands()`、`promptTemplates`、`resourceLoader.getSkills()`，空白页按固定起始 cwd 读取 loader 且不创建会话。目录保留来源、参数提示、遮蔽关系与 skill 开关；扩展参数补全按需调用并做旧请求代次保护。
- **文件引用**：按当前会话/选中工作区的成员返回 `@alias/路径` 或 cwd 相对路径，只返回路径/类型，不预读内容。查询有 6000 条目、12 层深度、100 条结果上限，跳过隐藏条目、`node_modules`/`vendor` 与符号链接；HTTP 请求中止会停止宿主侧遍历。
- **图片与输入体验**：沿用浏览器附件适配器，选择/粘贴/拖入均生成附件；提交前按会话 `modelInput` 或新会话草稿模型校验 image 能力，拒绝时保留文字与附件。草稿按宿主作用域 + 会话 ID/cwd 写 sessionStorage，跨窗口隔离、刷新恢复文字；pending→thread 迁移与 fork/clone 目标草稿用一次性覆盖避免互相清空。增加命令面板、`/` 与 `@` 键盘补全、长输入 Dialog（Esc 取消保留）、本窗口历史上限 50、IME 合成保护。
- **队列与状态**：运行中显式选择转向/后续，队列条标注类型并支持整体取回（含 Controller 尚未确认的乐观条目）；新增运行状态条区分压缩、重试、交互等待、Shell 与失败，空闲仍以 `agent_settled` 为准。压缩进行中普通输入保留并提示，不静默发送。

### 5.2 验证证据（主体自测与最终亲验）

- `pnpm check`：lint、全 workspace 类型检查通过；`37` 个测试文件、`659` 项测试通过（保留 a 的 642 项基线，新增 17 项）。
- 新增自动化覆盖：真实 SDK 的命令目录/模板参数/skill/空白页、内置提交守卫、图片能力预检、文件查询（成员、中文空格、隐藏/依赖目录、symlink、限额）；HTTP 路由与 409/415 类型化错误；React `4xx → MessageNotSentError` 与恢复；应用命令合并冲突。
- `pnpm lingui:extract`：`zh-CN` 目录 `285` 条；`pnpm build` 通过。
- `pnpm test:e2e`：`42` 条 Chromium 流程通过（原 33 条基线 + 9 条：命令面板/内置路由、扩展命令与参数补全、`@` 文件引用、图片能力拒绝、粘贴附件、双窗草稿隔离、草稿/长输入/历史、`!`/`!!`、steer/follow-up 与整体取回）。全程真实 HTTP/SSE、临时用户空间与合成模型，无个人凭据或付费请求。

### 5.3 限制与后续

- 文件查询使用 `ignore@7.0.8` 处理成员根及子目录 `.gitignore`（含否定规则），跳过隐藏/依赖目录与symlink，BFS采用游标而非shift。全局Git ignore配置不读取个人环境；当前规则限定成员目录。新增嵌套规则回归。
- 主agent修复补全在防抖期/切会话时的旧响应失效、无别名引用补@/空格引号、`/import <path>`回填、扩展/模板图片不误当内置拒绝、异步动作不清除其他会话草稿、取回失败仍交还已取消本地队列；目录遮蔽与真实SDK执行按扩展→skill→模板。
- 空白页命令目录需要装配固定起始项目资源（受信任门控）才能列出扩展/模板/skill；不创建会话，信任未决时仅显示内置命令。
- 队列仍只支持整体取回，不实现 Pi 不提供的逐项删除/提升；模型选择草稿不进入 sessionStorage（刷新只恢复文字）；5xx 发送不自动回投，4xx 未接受发送才恢复输入。
- 独立 Host UI 通道、启动期交互与编辑器定向仍属 c；本次未实现，也未以自由文本或默认空成功替代。
- 主agent最终累计亲验：38文件/685项测试、47条Chromium、lint/全部类型检查/build/Lingui299通过。补真实SDK模板/skill展开、显式扩展steer、队列取回失败与gitignore回归。中途文件引用引号期望已按实际引用语义更新，最终全量无跳过。
- 以上659/42为主体自测；未做截图视觉审阅。b/c交付完成状态统一见roadmap。
