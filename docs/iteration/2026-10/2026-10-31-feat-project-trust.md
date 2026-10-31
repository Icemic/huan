# G1.2a 项目入口与信任

- 日期：2026-10-31
- 分类：feat
- 范围：ENV-03、SES-01 项目入口与继续最近；阶段设计见 2026-10-31-feat-project-session-branches.md

## 设计

用户确认路径输入+最近项目、后续持久化归档/树节点与双入口导入。当前只做 a：项目路径规范化、窗口独立项目选择、信任状态与保存决定、继续最近。切项目不停止其他会话，不使用 process.chdir。

先验证 SDK 的公开接入：ResourceLoader.loadProjectTrustExtensions、reload.resolveProjectTrust、公开 Extension.handlers 与 ProjectTrustHandler、ProjectTrustStore、SettingsManager。SDK 根入口不导出信任解析辅助，可通过公开 handler map 做极小顺序派发，保持 undecided/异常继续、yes/no 首个决定、remember 及保存/父路径/default 优先级。不得深导入或改个人全局 Pi。若验证接口不成立，报告实际阻塞再调整。

启动项目未知信任时不得提前执行项目资源；宿主可先处于未装配/等待决定状态，health 与项目状态可用。core 提供项目状态与决定，冷历史读取仍可用，创建/运行和项目模型装配先通过相同信任入口。仅装配需要延迟，不增加后台任务框架。默认模型按目标项目可信设置解析；sessionDir 仍按 G1.1 固定启动作用域。

前端页头显示项目路径和切换入口，输入路径+最近项目，信任弹层显示风险与来源，支持本次允许/拒绝和记住决定。选择项目为窗口本地状态，最近项目按用户空间隔离；复用 useHarnessRuntime workspacePath 选项。继续最近无历史则显示空白新建页，不发送消息。

## 验证与回退

临时项目扩展写探针，证明未知/拒绝不执行、允许执行、父路径继承、default 和用户扩展决定一致；宿主启动不等待页面无法回答的请求。Node 覆盖冷/热入口与项目默认模型、保存重启；Playwright 覆盖项目切换、信任和继续最近，保留浏览器基线。主 agent review 并直接修复，最终 check/build/e2e。无用户数据迁移，可回退新增接口/UI和延迟装配代码。

## 实施记录

- 状态：开发完成
- 主体编码使用 `opencode-go/deepseek-v4.1-flash:max`；子进程确认 `PI_REASONING_LEVEL=max`，未更换 provider。
- 公开 SDK 验证：可用 DefaultResourceLoader.reload.resolveProjectTrust 与公开 Extension.handlers 保留用户扩展决定顺序；未深导入内部模块。主 agent 将初稿预加载+reload 两次初始化简化为单次 reload，并增加用户工厂仅一次、拒绝仍加载用户模板的测试。
- 宿主按规范化 cwd 保存项目装配与信任，未知时不执行项目扩展；启动/冷激活/新建统一入口，冷历史可读。用户决定和 trust.json 保存/父路径继承有测试覆盖。首个会话复用已准备 loader，后续会话独立装配。
- SDK 服务工厂不接受现成 loader，因此用公开 AgentSessionServices 形状与 createAgentSessionFromServices 接入；扩展 provider 注册后执行本地 refresh，不额外联网。主 agent 补齐此步骤及当前项目模型目录参数，协议升为 3。
- 页面提供路径输入、最近项目、信任风险/来源/记住决定、继续最近。窗口项目存 sessionStorage，按用户空间和启动项目隔离；切换退订前端 Controller，不停止宿主任务。没有历史时保留空白页。
- 主 agent 实测 `pnpm check`：24 文件、480 项测试，全部类型检查通过；仅既有 sse-link 未使用 import 警告。`pnpm build` 通过，保留大 chunk 提示。
- 主 agent 实测 `pnpm test:e2e`：9 项 Chromium 通过，包括新增的信任允许/拒绝、保存提示、双窗项目独立、切项目不停止运行、继续最近与最近列表。没有真实凭据、个人会话或付费模型请求。
- 当前用户扩展信任回调使用无 UI 上下文；可按 cwd 自动作决定，依赖 ctx.ui 的扩展会获得无交互回答并继续到保存/default/GUI 决定。完整启动期扩展交互不在本次引入通用任务框架；作为能力限制记录，后续 Host UI 验收需核对。
- 归档持久化、统计、树与导入保留在 b/c/d；不把整个 G1.2 标为完成。
