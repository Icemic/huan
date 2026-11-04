# 开发与调试指南

**最后更新**：2026-11-04
**状态**：持续维护文档。动手改代码前先读本文件。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | >= 22.19.0 | Pi SDK 要求；开发机使用 Node 24 |
| pnpm | 10.x | `packageManager` 字段已固定 `pnpm@10.34.5` |
| 操作系统 | Windows / macOS / Linux | 开发验证以 Windows 为主 |

仓库根 `pnpm-workspace.yaml` 设置了 `minimumReleaseAge: 4320`（3 天）：所有依赖必须发布满 3 天才会被安装，用于降低供应链风险。遇到 `ERR_PNPM_NO_MATURE_MATCHING_VERSION` 时，查询满足发布龄的版本并显式降级。

## 2. 常用命令（仓库根目录）

```bash
pnpm install          # 安装全部 workspace 依赖
pnpm dev              # 启动 apps/harness 开发服务器（Vite，端口 8799）
pnpm build            # 生产构建（tsc --noEmit && vite build）
pnpm check            # lint（Biome）+ 全 workspace 类型检查 + 测试
pnpm lint             # 仅 Biome 检查
pnpm lint:fix         # Biome 自动修复
pnpm typecheck        # 全 workspace tsc --noEmit（含根配置文件）
pnpm test             # Vitest 单元测试（根运行，覆盖 packages/*/src、apps/*/src 与 apps/*/server）
pnpm lingui:extract   # 提取文案到 src/locales/zh-CN.po
pnpm lingui:compile   # 编译文案（构建流程已内置，一般不需要单独跑）
```

## 3. 仓库结构

```
huan/
├── packages/
│   ├── protocol/   # @huan/protocol：纯 TS 类型与 schema，无运行时依赖
│   ├── mcp/        # @huan/mcp：官方 pi-mcp 之上的 Node 集成层
│   ├── core/       # @huan/core：Pi SDK 集成与运行时（Node）
│   ├── react/      # @huan/react：transport、纯归约/投影、Zustand 实例/动作与 React selector
│   └── history/    # @huan/history：Checkpoint/ChangeSet 接口
├── apps/
│   └── harness/    # 通用 Harness 应用（Vite + React 19）
└── docs/
```

依赖方向（强制）：`apps/*` → `@huan/core` / `@huan/react` / `@huan/history` → `@huan/protocol`；core 可消费 `@huan/mcp`，后者依赖官方 pi-mcp / Pi SDK 公开 API，不反向依赖 core。`core` / `mcp` / `protocol` 不依赖 React；`react` 不依赖 Node。

MCP 服务器配置与 Pi TUI 共用：用户 `<agentDir>/mcp.json`、可信项目 `<cwd>/.pi/mcp.json`；持久修改影响双方后续加载，当前live配置保持原样。OAuth 凭据/日志仍独立于 Pi，路径为 `<agentDir>/huan/mcp-auth.json` / `<agentDir>/huan/mcp.log`；huan 专属设置独立存储。当前 core 已按会话注入 huan 的 `builtin:mcp`，读取共享配置并后台连接，工具/资源经 Pi 权限管线注册，支持 codemode/tool_search 与动态扩展注册；目录查询不启动连接。可用静态 Authorization、环境/命令值及 provider token 认证；OAuth 登录与独立认证/日志保存已接入，认证操作通过独立服务端通道提供授权链接、回填与取消；管理接口支持运行态启停/重连/exposure和配置读写。统一设置的MCP页编辑用户共享配置，项目配置从工作区成员入口打开；会话操作中的MCP与 `/mcp [login|logout|reconnect] [server]` 提供服务器状态/工具资源详情、本会话启停与暴露及OAuth回填；配置页才读取原文，错误/冲突保留草稿。配置保存后需显式资源重载，旧连接在重载、删除、创建取消和服务进程退出时回收。不要同时在 Pi 与 huan 编辑同一配置：revision 可检测已发生的外部修改，但不提供跨进程 CAS；冲突时重读再保存。旧隔离配置路径不迁移、不作 fallback。

## 4. 开发期约定

### 4.1 源码直引 + 零构建

- 每个包的 `exports` 直接指向 `src/index.ts`；Vite 与 tsx 直接消费 TS 源码，**开发期不构建包产物**。
- 各包独立 `tsc --noEmit` 检查（无 project references）。
- `moduleResolution: bundler` 统一在 `tsconfig.base.json`。
- 注意：包只能被转译器消费。Node 直接运行 TS 需经 tsx（迭代②Node进程即用 tsx）。
- 生产阶段的包产物策略待部署形态确定后再定。

### 4.2 代码规范

- 本项目新增或修改的注释一律中文；安装的上游源码原有注释保留（详见AGENTS.md）。
- Biome 负责 lint + format：2 空格缩进、单引号、无分号；行尾统一 LF（`.gitattributes` 同步约束，避免跨平台漂移）。
- TS strict 全开，附带 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`。

### 4.3 UI组件安装与维护

组件来源、上游文件维护与小范围修改的注释要求以[AGENTS.md](../AGENTS.md)为准。项目使用Base UI版本的shadcn/ui或ReUI组件，当前shadcn样式为`base-nova`，配置位于`apps/harness/components.json`。

从包含components.json的应用目录运行官方shadcn CLI安装；使用满足依赖发布龄约束的明确版本，先预览生成内容和依赖变化。安装工具完成的路径与图标转换属于安装结果，后续以该结果为比较基准。主题在全局CSS tokens配置，业务组合放在`components/ui`之外。不得通过下载内部registry原始模板、手工改写占位图标和补写交互来冒充CLI安装结果。

### 4.4 动效速度

全局样式`apps/harness/src/index.css`导入`tw-animate-css`，沿用官方组件的进入/退出动画；通过`--motion-duration-fast: 120ms`控制菜单、选择器与Tooltip，通过`--motion-duration-normal: 180ms`控制Dialog及遮罩。调整速度只改这两个变量，加载旋转等持续动画不受影响。系统偏好减少动态效果时关闭界面进出动效。

业务Dialog使用受控open，避免关闭时直接return null截断退出动画。关闭请求立即失效异步读取，视图清理由官方onOpenChangeComplete触发；关闭期间重开须保留新面板。原面板数据可供退出展示，不复制一份动画缓存。

### 4.5 i18n（Lingui v6）

- 源语言中文，首期仅 `zh-CN` 单语言包。
- 应用入口须用 `<I18nProvider i18n={i18n}>` 包裹根组件（Lingui v6 要求，缺了会运行时报错）。
- 宏写法：`import { Trans } from '@lingui/react/macro'`。
- 新增文案后跑 `pnpm lingui:extract` 更新 `.po`；构建与 dev 由插件自动编译，不需要手动 compile。
- Vite 8 使用 rolldown/oxc，Lingui 宏经 `@rolldown/plugin-babel` + `linguiTransformerBabelPreset` 接入（见 `apps/harness/vite.config.ts`）；当前配置使用该插件的API。

## 5. 已知陷阱

| 陷阱 | 说明与处理 |
| --- | --- |
| Vite 8 插件 API 变化 | `@vitejs/plugin-react` 已无 `babel` 选项（改用 oxc）。Lingui 宏接 `@rolldown/plugin-babel`。 |
| rolldown 版本漂移 | Vite 8 依赖 rolldown，其新版可能不满足发布龄约束；已在 `pnpm-workspace.yaml` overrides 固定 `rolldown: 1.2.12`。升级 Vite 时需同步评估。 |
| `.po` 文件缺失导致构建失败 | 首次克隆后先 `pnpm lingui:extract`（`src/locales/zh-CN.po` 需要存在）。 |
| `@huan/*` 包安装报 404 | workspace 包必须用 `workspace:*` 协议声明依赖（如 `pnpm add @huan/protocol` 会去 registry 找，应手动写入 package.json）。 |
| 热重载残留报错 | Vite HMR 过程中偶发的 `I18nProvider is not defined` / `createRoot` 重复调用报错，整页刷新后消失，属中间态。 |

## 6. 验证方式

当前整体架构整改允许`refactor`中间提交不可用，不要求逐步运行以下完整验证。最终合并前仍须完成；具体约束见[整改子路线图](architecture-remediation-roadmap.md)。只读调研或文档任务不包含运行应用、测试或新增探针的授权。

- 常规验证：`pnpm check`（已包含测试）与 `pnpm build`；默认自动化使用临时用户空间，无需个人认证。
- 界面验证：`pnpm dev` 后打开 http://localhost:8799/ 。
- 浏览器回归：首次运行 `pnpm --filter @huan/harness exec playwright install chromium`，随后 `pnpm test:e2e`；交互测试面板为 `pnpm test:e2e:ui`。当前Chromium覆盖102条流程，单worker，不并行运行多套实例。
- 主题验证：顶栏主题选择写入浏览器 localStorage `huan.theme`，只影响当前浏览器；不改 Pi 配置、`settings.json` 或 huan `state.json`。
- 隔离调试：`pnpm dev:e2e` 启动页面 http://127.0.0.1:8899 与服务端 8898，临时用户空间和确定性模型，无需个人凭据。默认模型故意缺少凭据，可登录合成认证provider或先选 Test Model A 再发送。Ctrl+C 退出；Windows 强制结束时残留位于 `apps/harness/test-results/e2e`，可删除。自动测试有统一清理。
- 项目 `.pi/mcp.json` 配置 Playwright MCP，执行 `/reload` 后接入工具；使用独立内存浏览器，复用上述安装的 Chromium。依赖已锁定，无需每次 npx 下载。先启动隔离页面，再调用导航/快照/点击工具。MCP 输出位于 `apps/harness/test-results/mcp`。
- 生产性能对照：`HUAN_E2E_PREVIEW=1 pnpm dev:e2e`（PowerShell 先设置 `$env:HUAN_E2E_PREVIEW='1'`）。复用相同隔离服务与端口，启动时按当前源码构建带测试计数的临时产物，再启动 Vite preview；默认 `pnpm build` 不包含计数。不要与其他浏览器测试同时运行。输入/流式测试在 `e2e/render-performance.spec.ts`，覆盖 250/1,000 条合成历史，测试附件记录往返时间与组件入口计数；开发模式含 StrictMode，时间包含自动化与双帧开销。
- Playwright 产物隔离：需要排查默认 `test-results` 下产物消失或并行外部工具干扰时，可用 `HUAN_E2E_OUTPUT_DIR="C:/Users/Icemic/AppData/Local/Temp/huan-playwright-run" pnpm test:e2e` 指定独立输出目录；仍单 worker、同一时刻只运行一套隔离服务。该选项不改变测试断言或应用行为。
- 浏览器失败产物位于 `apps/harness/test-results`，包括截图和 trace；使用 `pnpm --filter @huan/harness exec playwright show-trace <trace.zip路径>` 查看。产物不入 Git。
- 容器与检查的覆盖范围：typecheck 覆盖全部 workspace 包；测试根运行（`vitest.config.ts` 统一 include）。

## 7. 迭代②：服务端与前端（已实现）

### 7.1 启动方式（两个终端）

```bash
# 终端 1：Node服务（Pi SDK 运行于此）
pnpm --filter @huan/harness dev:server

# 终端 2：前端
pnpm dev          # → http://localhost:8799/
```

前端经 Vite 代理（`/api/pi` → `127.0.0.1:8788`）访问服务端，避免 CORS。

### 7.2 服务配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HUAN_PORT` | 8788 | 服务端口 |
| `HUAN_WORKSPACE` | `tmp/agent-workspace`（仓库内） | Agent 工作目录 |
| `HUAN_ALLOWED_HOSTS` | `localhost:8799,127.0.0.1:8799,localhost:<HUAN_PORT>,127.0.0.1:<HUAN_PORT>`（随端口生成） | 允许的 Host（防 DNS rebinding；含直连与经 Vite 代理两种形态） |
| `HUAN_ALLOWED_ORIGINS` | `http://localhost:8799,http://127.0.0.1:8799` | 允许的来源 |
| `HUAN_TOKEN` | 空（不校验） | 访问凭证（开发期留空）。非空时前端经 Vite `define` 注入同名值并自动带 `x-huan-token` 头；需服务端与前端用同一值启动 |
| `PI_PROVIDER` / `PI_MODEL_ID` | 无 | 覆盖默认模型；缺省时读取 Pi settings.json |
| `PI_CODING_AGENT_DIR` | Pi 默认（`~/.pi/agent`） | 用户配置与默认会话空间 |
| `PI_CODING_AGENT_SESSION_DIR` | 无 | 单独覆盖会话目录，平铺存储，可主动共享；优先于 setting |

服务端默认模型解析流程（`@huan/core` 的 `model-catalog.ts` + `host.ts`）：**启动引导装配 → 共享 modelRuntime（provider 注册）→ 显式目录刷新（可联网）→ 解析 `PI_PROVIDER/PI_MODEL_ID` 或 settings.json 的 `defaultProvider/defaultModel`**。要点：

- 默认模型在**服务启动时固定解析**（env 优先）；`settings.json` 的修改需重启服务生效（`setModel` 的 `persist` 默认 false，会话内模型切换不写全局默认）。
- 每次冷打开会**按目标 cwd 重新装配** settings/扩展/资源；共享的只有 modelRuntime（provider 注册为合并语义，重装配幂等）。
- 装配期自带的目录刷新为 `allowNetwork: false`（不拉取扩展远程模型列表）；联网刷新是服务启动时的**显式**动作。
- 装配诊断（扩展注册失败、目录刷新错误）经 `host.diagnostics()` 返回，应用在启动时打印。

### 7.3 认证与模型

左侧按工作区一级、会话二级展示；工作区管理弹层支持名称、成员别名/路径、增删与路径健康/信任摘要。新建会话在该工作区选择起始项目，窗口偏好保存在 sessionStorage，创建后 cwd 固定。首次遇到受保护成员项目资源时，信任面板允许/拒绝后才继续装配；拒绝仍可使用用户资源对话。“记住此决定”写入所选 agentDir/trust.json 的当前路径条目，不写项目目录。无归属的既有 Pi 会话在“未归属会话”分组中明确加入工作区，服务端不会按 cwd 猜测。工作区、会话归属与归档标记存放在 `<agentDir>/huan/state.json`；归档是 huan sidecar 组织标记，未归属会话也可归档，重启保留且不修改 Pi JSONL；损坏时冷历史只读可用，相关修改禁用。会话列表支持范围/排序/仅命名/已归档过滤，搜索仅匹配显式名称与首条用户消息；显式刷新（按钮或窗口重新聚焦）会清空并重扫服务作用域缓存。会话详情按需查询：热会话用 SDK `getSessionStats()`，冷会话只读文件聚合（复用 `deriveContextUsage`），不装配项目扩展、不联网；累计统计覆盖全文件（含其他分支与已压缩历史），与当前活动分支上下文分开显示。删除需确认，成功删除文件后清理 sidecar 元数据。同一元数据文件由单Node进程管理，支持多个浏览器窗口；外部修改或修复文件后需重启服务。工作区目前支持创建、改名和成员编辑，尚无删除入口。

G1.1 起可在页面的服务诊断面板查看用户目录、会话存储方式及默认模型字段来源；支持复制安全摘要和重新查询。`GET /api/pi/host` 需通过现有访问校验，health 仍只返回 ok。目录与默认配置在服务启动时固定，重新查询不等于重载。

会话目录优先级：服务端 `sessionDir` 参数 → `PI_CODING_AGENT_SESSION_DIR` → 启动工作区合并 setting → `<agentDir>/sessions/<编码 cwd>`。显式/env 相对路径按启动进程目录解析，setting 相对路径按启动工作区解析；指定覆盖时不再追加 cwd 分组。无效默认模型不阻止服务启动，空白会话可选有效模型恢复新建；GUI认证修改后会刷新本地目录，不要求为登录/退出重启服务，启动默认模型仍按前述固定解析。

- 认证可直接通过huan设置中的模型与服务商入口完成，无需安装Pi CLI；若所选agentDir已有Pi认证（例如此前通过`pi /login`登录），可直接复用。
- 自定义 provider（经 Pi 扩展注册，如 `~/.pi/agent/extensions/` 下的 provider 扩展）在服务端与模型选择器中均可用（迭代③起）。
- 模型选择器读取服务端模型注册表（含扩展 provider）；切换经 `setModel`（作用于当前会话，不修改全局默认）。
- **历史会话模型**：如历史已有消息，冷打开时由 SDK 从会话记录恢复（服务端不传默认模型）；如历史模型不可用/未配置认证，SDK 会回退到可用模型，并展示受控原因。只有设置条目而无消息的空历史按SDK新会话规则选择有效模型。恢复逻辑依赖 `sdk.js` 的「未传 model 才恢复」行为（已实测验证）。
- 目录刷新：启动时联网刷新一次（扩展 `fetchModels`）；失败保留缓存目录并记入 `host.diagnostics()`。

### 7.4 验证 Host UI 的方法（可复用）

在**工作目录**下创建 `.pi/extensions/` 临时扩展（如 `tmp/agent-workspace/.pi/extensions/ask-user.ts`），注册一个在 `execute` 中调用 `ctx.ui.confirm` / `ctx.ui.select` 的工具；重启服务即可在对话中触发审批控件。验证完毕后删除该文件。扩展 API 见 `@earendil-works/pi-coding-agent` 的 `ToolDefinition` 与 `ExtensionAPI` 类型。

### 7.5 已知行为（非 bug）

- 内置`subagent`从所选agentDir的`agents`目录与最近祖先`.pi/agents`读取定义，默认user scope；huan固定使用SDK实现，外部同名工具只移除该注册并在资源诊断提示，个人文件和扩展其他注册保留。父工具卡可查看完整只读子聊天、逐项取消；“等待你的答复”表示需打开查看面板应答。子记录保存于`<agentDir>/huan/subagents/<parentId>/<taskId>/`，不进入普通会话列表。
- 顶栏“认证”或 `/login [provider]`、`/logout [provider]` 打开模型认证面板。支持 API key 与 provider OAuth 提示、授权页/设备码、回填、取消和退出；关闭面板不取消操作，多窗口可接管。凭据写入当前 agentDir/auth.json，普通快照/消息不包含回填值；退出仅移除已存凭据，环境变量/models.json 仍可能提供认证。状态轮询约 1～2 秒，本地可用性刷新后保持当前模型。
- 顶栏“设置与资源”或 `/settings` 打开同一面板，支持用户/可信项目常用项与 JSON 原文，保留未知字段；保存前校验，revision 不符明确冲突。保存只写磁盘，当前会话需重载才能应用；`/reload` 或面板“应用到当前会话”在空闲时刷新当前会话设置/指令/扩展。“重新读取文件”重读磁盘，当前作用域有未保存改动时先确认，再次点击“确认重新读取文件”才丢弃草稿；编辑、切换作用域/目标或关闭面板后取消确认，读取失败保留草稿。空白页“刷新项目资源”只更新起始目录的装配。sessionDir/代理等按提示重启服务。资源清单来自实际 loader，指令/system prompt 文本仅显式请求时加载；未信任项目配置不返回原文。
- 会话上下文栏的“运行操作”面板集中提供直接 Shell（`!` / `!!`）、手动/自动压缩。Shell 与压缩、分叉、树导航互斥；取消 Shell 不停止模型运行。Shell 输出在服务端有界（120k 字符），持久历史以 `bashExecution` 消息为准。自动压缩开关保存到当前 `agentDir` 用户设置，写盘失败会如实报错，未确认保存时不修改live缓存。全局模型范围在设置“模型”页或`/scoped-models`管理，对应Pi用户settings.json的enabledModels；工作区管理的自定义范围完整替换全局，清除后跟随全局。保存后新建与主动选模读取最终候选，已有会话按旧模型继续使用与发送；运行操作只保留Shell与压缩。
- 打开的会话视图由浏览器实例的 `acquireThreadLease` 维持 live 订阅，根组件由 `acquireRoot` 持有根订阅；最后引用在微任务确认后释放连接与完整会话缓存。应用不保留旧的 `PiLiveSubscription`/Controller 连接层，组合见 `packages/react/src/browser/resources.ts` 与 `apps/harness/src/bootstrap.ts`。
- 输入框支持`/`命令目录/补全、`@`成员文件引用、`!`/`!!`直接Shell；添加图片收在输入区+菜单，粘贴/拖入同样可用；/补全展示命令来源与未实施阶段。Shift+Enter换行，Enter发送，Ctrl/Cmd+Enter运行中转向；可显式选转向/后续、整体取回队列。上下键浏览本窗口输入历史，多行内容直接在输入框编辑。模型、思考强度与会话操作位于输入区左侧，按钮统一28px高；/与@补全悬浮于输入区上方，不占页面布局。
- 窗口文字草稿按服务作用域与会话/cwd保存在sessionStorage；刷新只恢复文字，图片附件不持久化。图片支持选择/拖入/粘贴，发送前校验模型能力。
- 启动期扩展交互由页面的服务交互对话框应答，不要求先打开会话；关闭页面不取消请求，其他窗口可接管。扩展输入框修改须点击应用，目标窗口独立且旧文本可恢复。
- 队列仅整体取回（Pi无逐项API）；运行操作面板支持独立取消Shell与压缩。
