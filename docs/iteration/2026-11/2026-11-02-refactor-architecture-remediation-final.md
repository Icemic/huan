# R9：最终实现与文档证据核对

日期：2026-11-02。分类：refactor。基线：`2056a55`（R8 已提交）。步骤与问题状态唯一由[子路线图](../../architecture-remediation-roadmap.md)维护。

## 1. 范围与方法

逐项核对 AR-01～43 及 R0 的 37 个能力 ID，按源码、自动化测试与实际执行分层记录证据，修正当前产品、技术架构、开发指南与运行状态文档。本轮同步当前产品中的待答请求位置、技术架构、开发指南、运行状态与项目速览，并清理注释与许可引用；历史迭代保持当时事实。

由主 agent 指定 `local/deepseek-v4.1-flash:max` 实施文档和必要小范围清理，主 agent 独立审查、修正并执行最终验证。R3～R8 已提供实现与正式测试；本轮不把测试数量当作能力证据，也不把旧迭代路径当作当前实现。2026-11-03 收尾轮仅回写 AR-34 的用户决定与整体状态，不新增实现或验证证据。

## 2. 最终实现与执行证据

### 2.1 实现状态

- 浏览器业务状态统一为 Zustand：公共 `serviceStore`/`windowStore` 与浏览器实例动作在 `packages/react/src/browser/`；应用 feature store 在 `apps/harness/src/state/`；React 只通过 selector 选择状态并调用稳定动作。旧 Controller、aui runtime/extras/repository 与模块单例业务状态已删除。
- `@huan/react` 依赖为 `@huan/protocol`、`zustand`（React 为 peer）；`assistant-ui`、`assistant-stream` 不在包声明、应用声明或 `pnpm-lock.yaml` 中。聊天展示改为 `apps/harness` 内的 shadcn/Base UI 组合，Markdown 使用 `react-markdown` 与 `remark-gfm`。
- 协议常量为 15；HostInfo 携带 `protocolVersion`，浏览器启动时同版比较，不匹配则停止业务初始化。领域客户端接口按 host、认证、MCP、工作区、目录、会话与配置组合，共用 wire 守卫归 `@huan/protocol`。
- Node 服务由 `packages/core/src/host.ts` 组合根与 `host/` 下装配、目录、live 会话、操作协调、事件、导入、配置、模型服务组成；保留统一准入、结构互斥、取消/退休与 MCP/认证资源边界。
- 扩展 unknown 载荷在 core 的事件/快照输出处转换为 JSON-safe；SDK 私有延迟动作补偿集中在 `host/shared.ts` 的 `discardDeferredRuns`，字段失效时输出一次受控诊断，并保留 `agent_start` 清扫。
- 许可与来源保留：`packages/react/THIRD-PARTY-NOTICES.md`、`packages/core/THIRD-PARTY-NOTICES.md`、`packages/mcp/THIRD-PARTY-NOTICES.md` 与新增的 `packages/protocol/THIRD-PARTY-NOTICES.md` 保持 MIT 声明；R5 迁入 `@huan/protocol` 的 wire 守卫补记来源。旧文件路径只在历史记录中出现，不作为当前入口。

### 2.2 主 agent 执行证据

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| `pnpm check` | 82 个测试文件、993 项通过、2 项 POSIX 权限测试在 Windows 跳过；lint 与全仓类型检查通过 | `huan-r9-main-check.log` |
| `pnpm build` | 通过；默认 JS 约 1124.5kB，保留既有大 chunk 警告 | `huan-r9-main-build.log` |
| `pnpm test:e2e` | 85/85 通过；8899/8898、单 worker、零重试 | `huan-r9-main-e2e.log` |
| 生产预览性能 | 250/1000 目录输入无关行执行 0、流式 0 且 SSE 不增；输入往返中位约 33/50ms；Markdown 60ms、240 节点树 671ms、1000 目录首次布局 454ms；JS 传输 335025B、解码 1125294B | `huan-r9-main-preview.log` |
| frozen-lockfile | 主agent通过；Lingui主agent提取438条、无msgid变更，行号引用变化已还原 | R8 记录 |
| 视觉 | 未实际读取截图产物，不宣称视觉合格 | 本轮记录 |

生产预览的往返时间包含 Playwright 与双帧等待，不作为 INP；长 Markdown、树和首次布局为代表性样本，不外推到全部设备与内容规模。

## 3. 37 个能力 ID 的最终证据

表中路径为当前实现；执行结果指 R9 主 agent 的完整 `pnpm check` 与 85 条 Chromium 运行。单个文件或用例通过不替代能力规范的全部子要求。证据按层级使用：protocol 的类型/守卫测试证明 wire 形状；server `sse-link.test.ts` 证明 JSON/SSE 解码与快照顺序；core 测试证明服务端行为；Chromium 流程证明界面可见内容。前三类不替代 GUI 可见性，GUI 通过也不替代服务端竞态断言。

### 3.1 用户空间、项目与会话

| ID | 当前实现 | 当前证据 | 结论 |
| --- | --- | --- | --- |
| ENV-01 | 目录解析、HostInfo 与服务状态面板 | `packages/core/src/session-dir.test.ts`「显式 agentDir 优先」「临时 HOME 与 SDK 目录对照」；`host-info.test.ts`「尚无会话也可查询固定空间及配置来源，不返回凭据」；`apps/harness/e2e/browser.spec.ts`「空白页显示默认模型错误、目录及来源，选有效模型后可发送并复制摘要」 | 已交付；认证提示由 AR-42 跟踪 |
| ENV-02 | sessionDir 的 option/env/settings/default 顺序与作用域 | `host-directory.test.ts`「新建与冷读都落在 <agentDir>/sessions/<编码 cwd>」「所有 cwd 共享平铺目录」「优先级：显式 sessionDir > 环境变量 > setting > 默认」「两个不同 agentDir 的服务并存」「链接越界」；`host-session-fork.test.ts`「平铺 sessionDir 覆盖下子文件写入同一平铺目录」；`host-session-import.test.ts`「依据源 cwd 的默认目录写入」 | 已交付 |
| ENV-03 | 项目入口、固定 cwd、信任与启动交互 | `host-project.test.ts`「未知信任不执行项目扩展」「显式允许装配一次并保存决定」「拒绝只跳过项目资源」；`host-ui-host.test.ts:365`「project_trust 扩展获得实际 RPC UI」、`:405`「启动装配期请求不清空、也不阻断服务返回」；`apps/harness/e2e/project.spec.ts`「拒绝成员项目信任仍可对话」「工作区成员信任在管理弹层完成」 | 已交付 |
| ENV-04 | 临时用户空间、合成模型、资源与网络隔离 | `host.test.ts`「初始化失败也释放临时空间、还原继承环境与 fetch」「fetch 桩只应答合成 provider 端点」；`apps/harness/e2e/server.ts` 固定 8899/8898 与临时用户空间；R9 85 条 Chromium 使用该启动器 | 已交付；平台跳过与历史异常见 AR-34（用户决定关闭） |
| SES-01 | 新建/打开/继续最近与历史模型恢复 | `host.test.ts`「新建会话使用默认模型」「创建时显式指定模型」「首条消息使用创建时指定的模型」；`host-session-tree.test.ts`「用户节点导航回到其父并返回 editorText；冷读沿用位置」；`apps/harness/e2e/browser.spec.ts`「新建、发送、切换及刷新后历史可读」；`e2e/project.spec.ts`「继续最近、归档与恢复在两级列表中可用」 | 已交付；回退原因由 AR-41 跟踪 |
| SES-02 | 搜索、排序、改名、归档与删除 | `host-session-management.test.ts`「旧扫描晚到不会覆盖显式刷新后的目录缓存」「名称与首条消息为独立字段」「未归属会话归档重启保留」；`apps/harness/e2e/session.spec.ts`「搜索限定名称与首条消息」「显式刷新发现外部新增会话」「详情展示累计统计与路径」「删除需确认」 | 已交付 |
| SES-03 | 累计统计、活动分支上下文与冷读 | `host-session-management.test.ts:376`「冷聚合与 SDK 统计一致」「热详情保留目录时间与父会话路径」「未知模型窗口不填零」「冷读详情不装配项目扩展、不联网」；`apps/harness/e2e/session.spec.ts`「详情展示累计统计与路径」 | 已交付 |
| SES-04 | 树、标签、导航、摘要与取回 | `host-session-tree.test.ts:266`「读取实际 entryId、活动路径与多叉结构」「用户节点导航」「非用户节点」「revision 冲突」「标签写在 Pi 文件」「停止并跳转取回整体队列」「分支摘要成功/取消」；`apps/harness/e2e/session-tree.spec.ts` 全部 5 条流程 | 已交付；迟到响应由 AR-40 跟踪 |
| SES-05 | 历史消息 fork | `host-session-fork.test.ts`「只复制根到所选用户消息之前」「用户消息位于首条时生成空子会话」「session_before_fork 取消」「运行中返回 busy」；`apps/harness/e2e/session-fork-import.spec.ts`「历史消息 fork 创建独立空分支，父子双窗互不影响并可继续发送」 | 已交付 |
| SES-06 | clone 当前活动路径 | `host-session-fork.test.ts`「复制当前完整活动路径」「空会话 clone」「切换模型与 Thinking 后 clone」；`apps/harness/e2e/session-fork-import.spec.ts`「克隆当前活动路径排除废弃分支」 | 已交付 |
| SES-07 | 路径/上传 JSONL 导入 | `host-session-import.test.ts`「坏 JSONL/重复 header/断链/环/未知版本被拒绝」「保留源 ID 与完整树」「cwd 不可用要求替代目录」「同 ID 冲突副本」「源在预览后变化时拒绝确认」「元数据损坏拒绝导入」；`apps/harness/e2e/session-fork-import.spec.ts`「路径导入拒绝非法 JSONL」「上传 JSONL 导入」「同 ID 冲突副本」「导入预览在途时关闭重开并换文件」 | 已交付 |

### 3.2 对话、输入与执行

| ID | 当前实现 | 当前证据 | 结论 |
| --- | --- | --- | --- |
| RUN-01 | 流式文本/Thinking、工具过程、图片与 data 展示；损坏图片回退由 AR-38 跟踪 | `packages/react/src/model/message-view.test.ts`「工具结果按 toolCallId 配对」「工具错误结果与图片输出按内容呈现」「嵌套工具保留 parentToolCallId」「data 回退保留来源」「实时工具的部分输出同时保留文本、图片与运行标记」；`apps/harness/e2e/browser.spec.ts`「回复期间连接断开再恢复」；`e2e/presentation.spec.ts` 图片与嵌套工具流程 | 已交付；损坏图片回退见 AR-38 |
| RUN-02 | steer/follow-up、队列、停止与取消 | `host.test.ts`「sendMessage 在输入被接受后即返回」「预检期间取消不会启动模型调用」「结算窗口内的发送可被取消」；`host-runtime-operations.test.ts`「扩展显式 steer 进入转向队列」；`session-actions.test.ts`「整体取回并列返回服务端与本地未派发文本」「已派发但结果未知的队列内容不被取回冒认」；`e2e/command-input.spec.ts`「运行中显式转向/后续、队列标注与整体取回」 | 已交付 |
| RUN-03 | 文件引用、图片选择/粘贴/拖入与能力校验 | `host-command-input.test.ts`「当前模型不支持图片时在预检前拒绝」「首条发送的图片能力在预检前校验」「按工作区成员返回 @alias 引用」；`apps/harness/e2e/command-input.spec.ts`「@ 文件引用来自当前工作区」「图片在不支持图像的模型下被拒绝」「粘贴图片生成浏览器附件」 | 已交付；跨目标目录失效由 AR-07 跟踪 |
| RUN-04 | 直接 Shell、输出、取消与上下文选项 | `host-runtime-operations.test.ts`「! 实时输出、退出码与历史消息」「!! 保留历史但排除模型上下文」「同一会话同时只允许一条 Shell」「可与模型运行并存」；`host-runtime-operations.test.ts:469`「服务销毁会取消并等待 Shell 结束」；`e2e/runtime-operations.spec.ts`「Shell 实时输出、历史卡片与 !! 排除上下文」「Shell 双窗实时、断线重连与独立取消」；`e2e/command-input.spec.ts`「输入 ! / !! 直接执行 Shell」 | 已交付 |
| RUN-05 | 运行/等待/重试/压缩/结算边界 | `packages/react/src/model/thread-state.test.ts`「agent_end 不提前空闲；agent_settled 才结算」；`apps/harness/src/event-replay.test.ts`「运行中状态：agent_end 仍保持 running」「agent_end(willRetry=true) 保持 running」；`e2e/run-settlement.spec.ts`「agent_end 后服务端与 GUI 保持 running」「自动继续期间保持 running」；`e2e/runtime-operations.spec.ts`「手动压缩成功、自动压缩保存与取消后恢复」 | 已交付 |
| RUN-06 | 首连、断流、重连、多窗与快照恢复 | `apps/harness/server/sse-link.test.ts`「快照优先」「live-only 订阅在断流重连后切回带快照的 URL」「服务端序号重置后新事件仍被应用」「畸形事件触发断流重连」；`create-browser.test.ts`「终结性流错误写入状态并关闭订阅」「流快照重置序号时重设实时状态基线」；`e2e/browser.spec.ts`「回复期间连接断开再恢复」「两页面订阅同一会话可同步」；`e2e/session-tree.spec.ts`「双窗口导航同步」 | 已交付 |
| RUN-07 | 长输入、IME/键盘、窗口草稿与本窗历史 | `window-store.test.ts`「文字/模型变化推进 draftRevision 并持久化文字」「输入历史去重、忽略空值并限制 50 项」；`composer-store.test.ts`「历史来自本窗输入历史并可恢复到浏览前草稿」「整体取回在草稿未变时写回」；`e2e/command-input.spec.ts`「两个窗口的草稿互不覆盖」「草稿刷新恢复、长输入取消与应用」「窗口输入历史只记录本窗口提交」「异步命令完成不清除同目标的新草稿」 | 已交付 |

### 3.3 模型、配置、资源与交互

| ID | 当前实现 | 当前证据 | 结论 |
| --- | --- | --- | --- |
| MOD-01 | 模型目录/刷新/范围/Thinking 与回退展示 | `host.test.ts:168`「返回实际注册表且包含合成 provider 模型」「setModel 生效」「setModel 对注册表外的模型报错」；`host-runtime-operations.test.ts`「目录透传 Thinking 能力（含 max）与输入模态」「Thinking max 可设置并持久化」「会话范围默认只改会话」；`e2e/runtime-operations.spec.ts`「模型目录刷新、范围保存与 Thinking max / input 能力」；`e2e/presentation.spec.ts` 历史回退原因 | 已交付；跨目标缓存由 AR-07 跟踪 |
| MOD-02 | API key/OAuth 登录、回填、取消、退出与多窗接管 | `provider-auth.test.ts`「secret 提示回填后立即清除」「取消前未提交时按 cancelled 结算」「取消与成功竞态」「退出登录移除已存凭据」；`provider-auth.test.ts:632`「API key 登录写入实际 auth.json」「OAuth 选择/手动码登录持久化」；`e2e/provider-auth.spec.ts` 5 条流程 | 已交付；认证提示由 AR-42 跟踪 |
| MOD-03 | 设置/资源原文、保存、revision 与信任 | `host-settings.test.ts`「返回用户/项目原文、revision、合并值与来源」「并发保存使用同一 revision 时只有一个成功」「项目未信任时拒绝写项目设置」「保存与旧自动压缩/模型范围写入共享队列」；`e2e/settings-resources.spec.ts`「常用项与 JSON 保存写盘」「外部修改导致保存冲突」「切换作用域保留未保存草稿」「未信任项目的项目设置不可编辑」 | 已交付 |
| MOD-04 | 手动/自动压缩、取消与项目覆盖 | `host-runtime-operations.test.ts`「手动压缩成功：写入摘要、原始 JSONL 保留」「压缩失败：保留历史并暴露错误」「取消压缩：原始树保持不变」「自动压缩保存到用户全局设置」「自动压缩写盘失败时如实返回」；`e2e/runtime-operations.spec.ts`「手动压缩成功、自动压缩保存与取消后恢复」 | 已交付 |
| MOD-05 | llama.cpp 专用管理 | 能力规范 §2.2 与 G1.4 阶段记录 | 用户确认排除；不计完成、不计失败 |
| RES-01 | 指令/system prompt/扩展/skill/模板/主题来源 | `host-settings.test.ts:386`「展示实际 loader 的指令/扩展/skill/模板与来源」「未信任项目不执行项目扩展」「packages 声明按字符串/对象两种形式投影」「快照与事件都不含设置原文」；`e2e/settings-resources.spec.ts:121`「顶栏与 /settings 打开同一面板，资源来自实际 loader」「资源正文按需加载」 | 已交付 |
| RES-02 | 命令目录/补全/执行与内置覆盖 | `host-command-input.test.ts`「活会话目录包含扩展、模板与 skill」；`host-command-input.test.ts:132`「模板参数与 skill 调用由 SDK 展开」「空白页按固定起始目录读取资源目录」「已知内置 slash 不会作为普通 prompt」「未知 slash 不当作内置命令拦截」；`apps/harness/src/components/pi-builtin-commands.test.ts`；`e2e/command-input.spec.ts`「命令目录展示内置/扩展/未实施阶段」「扩展命令经 SDK 执行且参数补全不进入模型」 | 已交付 |
| RES-03 | 同会话 reload 与多窗资源版本 | `host-reload.test.ts`「保持会话/消息/分支/订阅」「新增提示模板与修改 AGENTS.md 后重载生效」「重载前取消旧交互」「运行/Shell 与重载互斥」；`host-reload.test.ts:561`「dispose 中重载被取消并等待结束」；`e2e/resource-reload.spec.ts` 全部 5 条流程 | 已交付；锁异常见 AR-34（用户决定关闭） |
| RES-04 | confirm/select/input/editor、通知与定向应用 | `host-ui-host.test.ts`「confirm/select/input/editor 可应答」「状态/widget/标题/通知有界」「编辑器写入定向调用方窗口」「session_start 顺序请求可发现/应答」「取消启动请求使钩子获得原生取消值」；`host-store.test.ts`「editor 预填多行；每个请求独立答案」「工具关联请求无可见工具也保留待答入口与 prefill」；`e2e/host-ui.spec.ts` 全部 5 条流程；`e2e/presentation.spec.ts` 工具 editor 预填 | 已交付 |
| RES-05 | codemode/tool_search/MCP 命名内置与嵌套关系 | `host-reload.test.ts`「按 named builtin 装配且默认不激活；codemode 脚本的嵌套工具带 parentToolCallId」「extensions 设置禁用 builtin」「第三方同名工具替换」；`host-mcp.test.ts`「codemode 脚本调用 MCP 工具并保留嵌套 parentToolCallId」；`packages/mcp/src/integration.test.ts`「嵌套工具调用与进度携带 parentToolCallId」；`e2e/presentation.spec.ts`「嵌套工具：父子关系、进度与待答请求可发现可操作」 | 已交付 |

### 3.4 MCP、输出与附加交付

| ID | 当前实现 | 当前证据 | 结论 |
| --- | --- | --- | --- |
| MCP-01 | 共享用户/可信项目配置、stdio/HTTP、错误隔离 | `packages/mcp/src/config.test.ts`「用户/项目配置与 Pi 共享」「逐项跳过无效条目」「项目 override 只覆盖三字段」；`config-store.test.ts`「读到 Pi 共享的用户/项目服务器」「坏 JSON 可读取修复」「未信任项目读取/保存/加载都不触碰文件」；`e2e/mcp.spec.ts`「配置保存不连接」「连接失败修复后可恢复」 | 已交付 |
| MCP-02 | 连接、动态工具/资源、模型发现与调用 | `manager.test.ts`「连接失败互相隔离」「list_changed 刷新目录」「刷新失败撤下无法确认的目录」；`resources.test.ts`「文本/图片内容转换」「部分失败只返回受控错误」；`host-mcp.test.ts:293`「direct 工具经 stdio 服务执行」「deferred 工具经 tool_search 发现」；`e2e/mcp.spec.ts:238`「配置保存不连接，显式重载后调用工具/资源」「无资源服务器仍显示工具详情」 | 已交付；图片展示由 AR-38 跟踪 |
| MCP-03 | 临时启停、重连、exposure 与持久来源 | `manager.test.ts`「禁用/隐藏不会通过普通调用复活」「禁用会中止慢初始化」「临时精确 toolExposure 保留临时覆盖状态」「连续重连不会让旧启动结果关闭新连接」；`mcp-host-broker.test.ts`「busy/stale」；`e2e/mcp.spec.ts`「项目 override 只写三个持久字段」「OAuth...busy」 | 已交付 |
| MCP-04 | OAuth 授权、回填、退出、恢复与秘密隔离 | `oauth.test.ts`「loopback 登录保存凭据」「回填重定向可完成登录」「issuer 不符拒绝登录」「刷新轮换」；`oauth.test.ts:388`「logout 等待刷新写入文件」；`mcp-host.test.ts:370`「登录、回填一次领取、重连、详情、临时管理、退出与取消」「目标 reload/delete 取消失效旧认证」；`e2e/mcp.spec.ts`「OAuth 链接、回填、多窗接管、旧提示拒绝、取消、退出与 busy」 | 已交付 |
| MCP-05 | 配置新增/修改/删除、revision 与子进程回收 | `config-store.test.ts`「旧 revision 冲突」「不同 store 实例并发保存同一文件时只有一个成功」「写入失败时清理临时文件」；`stdio.test.ts`「慢初始化期间 close 会回收服务器进程与孙进程」；`host-mcp.test.ts`「同 cwd 两个会话使用独立进程」「reload 回收旧 PID」「dispose 回收慢初始化的 MCP 进程」；`e2e/mcp.spec.ts`「配置保存不连接」「删除需要确认」 | 已交付 |
| OUT-01 | 复制、Markdown 下载与部分导出 | `apps/harness/src/components/chat/chat-message.tsx` 与 `message-format.ts` 提供复制/Markdown 下载；未见完整 HTML/JSONL 导出与敏感确认流程 | G1.5 未启动；不计完成 |
| OUT-02 | 分享 | `/share` 仅出现在内置命令索引的未实施项，没有目标选择、上传确认或结果链接流程 | G1.5 未启动；不计完成 |
| OUT-03 | 诊断与报告 | `getHostInfo` 与服务状态面板可复制安全摘要；`/bug`、`/debug` 仍标 G1.5 | G1.5 未启动；不计完成 |
| OUT-04 | 快捷键、关闭与结束操作 | 已有输入快捷键、关闭页面与停止运行；帮助、版本/变更说明与明确结束操作仍未实施 | G1.5 未启动；不计完成 |

### 3.5 能力 ID 之外的交付

多项目工作区、Base UI 主题与刷新性能已按 R0 §5.3 的要求保留。当前证据：

- 工作区：`host-workspace.test.ts`、`workspace-store.test.ts`、`workspace-tools.test.ts` 的归属/成员/运行 revision/损坏冷读用例；`e2e/project.spec.ts` 8 条流程。
- 主题与键盘：`theme-store.test.ts`；`e2e/ui-base.spec.ts`「主题切换写入本地存储」「Dialog 内弹层按 Escape 逐层关闭」。
- 刷新性能：`create-browser.test.ts` 帧合并、`message-view.test.ts` 引用复用；`e2e/render-performance.spec.ts` 250/1000 目录无关行执行 0，生产预览数据见 §2.2。
- 安全与包边界：`apps/harness/server/host-routes.test.ts` 的 Host/Origin/token 顺序与请求体积限制；`@huan/react` 的 client/model/browser 无 Node 导入，`core`/`protocol`/`mcp` 无 React 导入，`apps/harness` 无反向包依赖。

## 4. AR 汇总与关闭记录

43 项全部关闭，逐项实现与测试见[子路线图 §3.7](../../architecture-remediation-roadmap.md#37-逐项最终实现与证据)。AR-34 的关闭依据为用户决定，见下表与本节说明。

| 项 | 状态 | 证据边界 |
| --- | --- | --- |
| AR-34 | 已关闭（用户决定） | provider-auth 重启偶发 false 已按实际刷新时序修正；host-reload EBUSY 未确定锁持有者；旧 Vite 转换空模块、默认 e2e 产物 500/trace 消失/Chromium 崩溃本轮未复现，也没有原因结论。此前多次通过或独立输出目录可用不能推断为环境原因；用户决定按开发环境/系统问题处理、不作为软件本身问题并接受剩余不确定性，原始证据边界保持不变 |

2026-11-03 用户决定：AR-34 涉及的现象按开发环境/系统问题处理，不作为软件本身问题，接受剩余不确定性后结束本次整改。锁持有者与历史工具异常原因仍未确定，本轮没有新增原因证据；该决定时尚未授权合并与push，随后合并事实见§6，G1.5未启动。

AR-38已补损坏图片错误提示、来源与无空预览，图片GUI断言实际解码成功；AR-41已用SDK SessionManager生成无消息历史，经导入打开并继续首条发送；SDK对此按新会话选择有效模型，不恢复仅设置条目的旧模型。AR-42已补缺凭据登录后同页就绪、退出恢复缺凭据的GUI流程，均在主agent85条全套内通过。


OUT-01～04 属 G1.5，不计入本次 32 项已交付能力；MOD-05 保持用户确认的排除状态。

## 5. 文档检查与回退

本轮对11份变更Markdown全文检查0命中、129项本地链接与章节有效，`git diff --check`及lint通过。主agent逐项核对闭合记录，补图片/空历史/认证GUI后亲验check/build/85条Chromium与生产性能。AR-34 收尾轮只改文档：对 6 份变更 Markdown 全文检查 0 命中、`git diff --check` 通过，未运行应用、测试或构建；AR-34由用户决定关闭后，R9开发整改收尾完成；随后合并与解除总阻塞见§6。

回退以代码/文档提交为单位，不回滚用户配置、会话或凭据。未push。

## 6. 本地合并记录

2026-11-03，用户确认fast-forward合并，主agent亲自将main从`5ff6565`快进至`377a60a`，完整保留refactor上的提交历史，没有新增合并提交。整改总阻塞已由[主路线图§2.5](../../roadmap.md#25-整体架构整改阻塞子路线图)解除；G1.5为下一阶段，尚未启动。refactor分支保留，未push。

合并后仅同步6份Markdown，主agent全文风格与本地链接检查、`git diff --check`通过；未改业务代码，未重跑应用、测试或构建，既有自动化结果仍指§2.2执行时点。
