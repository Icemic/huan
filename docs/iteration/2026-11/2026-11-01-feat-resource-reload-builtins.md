# G1.4b 资源重载与基础内置装配

日期：2026-11-01。范围见[阶段设计](2026-11-01-feat-configuration-resources-auth-mcp.md)，状态见 [roadmap](../../roadmap.md)。

## 目标

交付 RES-03 与 RES-05 的 codemode/tool-search 子项：GUI /reload、设置面板重载，刷新资源清单/命令目录，保持同一会话、消息、活动分支及其他窗口草稿。MCP 工厂因需明确 agentDir 配置/凭据注入及完整管理契约，随 d 一起装配验证，RES-05 在此只标子项。

## 设计

1. 热会话调用公开 AgentSession.reload，保持 record/session/订阅不替换。reload 进入结构闸门，与模型运行、发送、Shell、压缩/树操作互斥，busy 如实反馈。使用宿主 caller 上下文时不得自等在途命令。支持扩展命令 ctx.reload，旧运行时上下文按 SDK 失效。
2. 重载前取消旧 uiBridge pending/宿主 session scope 请求，清空旧扩展 UI 状态/指令，并有事件广播。重载期间进入 startup 模式，让 session_start 请求通过宿主交互通道可发现/应答；每次重载记录独立操作身份与状态，前端断开不取消工作，可从另窗应答。dispose/retire 取消请求并排空，失败/busy 不伪报完成；不得删除消息/草稿。
3. SDK reload 不再传 resolveProjectTrust，因此在创建时为公开 ResourceLoader.reload 加入宿主信任检查包装：首次装配仍用原有 prepareProjectTrust，后续每次 loader reload 前重查受保护资源存在与保存/显式信任策略。新出现需信任的资源不得沿用 no-resources；无明确授权时拒绝并提示先完成信任。保持现有已拒绝项目用户级资源可重载。必要时调用公开 prepareProjectTrust 的同语义辅助函数，不直接复制两套信任解析。禁止重载过程中重复执行扩展工厂/重复 session_start。
4. 设置先 flush 再 reload，refresh provider 本地目录，不联网；beforeSessionStart 更新 workspaceBinding.loadedInstructionPaths、provider 注册与必要模型目录。资源加载失败保留可诊断状态，释放闸门可重试；若 SDK 已关闭旧运行时，不能称已回滚。默认模型/Thinking 不覆盖既有选择，scope/sessionDir 按已约定保存/重启语义处理。
5. 新增 reload API/结果、状态快照/事件（含开始/完成/失败和资源版本）；/reload 与面板按钮走同一路径。空白页目标仅更新对应 cwd 的待消费装配，不创建会话，不停止同 cwd 其他会话；可明确提示只重载本目标。资源版本使各窗口命令目录/设置与资源面板更新，异步旧结果失效。设置面板原“重新加载”是丢弃当前原文草稿的重读，须与“应用资源重载”明确区分，不能覆盖未保存草稿。
6. codemode/tool_search 用 SDK 根入口工厂，按 CLI named builtin/replaceable 约定装配，遵循 extensions 启停和替换、defaultTools；加载后惯常不激活，配置 +codemode/+tool_search 生效。测试验证脚本嵌套工具进度与 parentToolCallId。不要把 huan 工作区七工具意外移除或给所有工具 allowlist。

## 验证

真实 SDK：新增/删除/修改模板与指令后的重载、改 settings 后合并、扩展 shutdown/start 各一次、旧交互取消、新启动请求可答；busy、失败后再试、多窗口资源版本/命令目录更新、消息和分支/草稿不变；no-resources 后出现项目资源不执行、信任拒绝与允许边界；dispose 中重载取消不泄漏。内置启停/替换和 codemode/tool_search 真调用及 nested parent 关系。

浏览器：/reload、设置保存→重载应用、资源/命令目录更新、双窗口、启动confirm接管、未保存草稿不覆盖。使用临时空间、合成 provider，禁止个人 MCP/auth。主 agent 独立 review/修复、亲验 check/build/浏览器后提交 b，再进入 c。

## 风险与回退

reload 已执行 shutdown 后的失败不能恢复旧扩展资源，必须明确失败可重试；不调用私有 SDK 字段。共享 provider 注册可能影响其他会话，沿用现有幂等本地刷新并补回归。不支持跨进程设置事务。不改变 Pi JSONL 或 sidecar schema；回退仅撤销 b 的新增代码。

## 实施与验证

- subagent 实施协议/宿主/Controller/UI，主 agent 独立 review、直接修复并亲验。协议 12；/reload 与设置面板复用同路径，ctx.reload 真实执行且不自等。
- 主 agent 修复信任裁决：只能使用本次 bootstrap 新加载的用户扩展，不允许旧项目扩展自行授权或使用旧版用户处理器；补回归验证用户允许策略改成 undecided 后项目扩展不执行。空白页无 pending 装配时也重新检查新增项目资源，补对应回归；live 配置查询保留新增受保护资源门控。
- 主 agent 补空白页按 cwd 重载互斥、装配消费准入、销毁后取消结果及 session_start 前退休检查；空白资源清单优先目标 pending loader。设置面板重载响应在关闭/切换后失效。
- codemode/tool_search 使用公开 named builtin 工厂，真实脚本 read 子调用及 tool_search deferred 命中、禁用/替换有 SDK 回归；parentToolCallId 已贯通事件与状态，视觉嵌套呈现不在本阶段新增。
- 主 agent 亲验 pnpm check：43 文件/738 项，lint/全仓类型通过；pnpm build 通过（既有大 chunk 提示）。补充修复后再次定向验证 reload/settings。最终完整 Chromium 59 条全部通过，含重载五条新流程及大列表/断流/多窗/树导航回归。
- 无个人 MCP/auth、真实历史或付费模型请求。文案 342 条。
