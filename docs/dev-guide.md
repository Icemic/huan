# 开发与调试指南

**最后更新**：2026-11-01
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
pnpm lingui:compile   # 编译文案（构建链已内置，一般不需要单独跑）
```

## 3. 仓库结构

```
huan/
├── packages/
│   ├── protocol/   # @huan/protocol：纯 TS 类型与 schema，无运行时依赖
│   ├── mcp/        # @huan/mcp：官方 pi-mcp 之上的 Node 集成层
│   ├── core/       # @huan/core：Pi SDK 集成与运行时（Node）
│   ├── react/      # @huan/react：浏览器侧运行时（reducer/Controller/hook）+ assistant-ui 适配
│   └── history/    # @huan/history：Checkpoint/ChangeSet 契约
├── apps/
│   └── harness/    # 通用 Harness 应用（Vite + React 19）
└── docs/
```

依赖方向（强制）：`apps/*` → `@huan/core` / `@huan/react` / `@huan/history` → `@huan/protocol`；core 可消费 `@huan/mcp`，后者依赖官方 pi-mcp / Pi SDK 公开 API，不反向依赖 core。`core` / `mcp` / `protocol` 不依赖 React；`react` 不依赖 Node。

MCP 服务器配置与 Pi TUI 共用：用户 `<agentDir>/mcp.json`、可信项目 `<cwd>/.pi/mcp.json`；持久修改影响双方后续加载，保存不自动改变 live。OAuth 凭据/日志仍独立于 Pi，路径为 `<agentDir>/huan/mcp-auth.json` / `<agentDir>/huan/mcp.log`；huan 专属设置独立存储。当前包只提供配置基础，尚未装配连接或 GUI。不要同时在 Pi 与 huan 编辑同一配置：revision 可检测已发生的外部修改，但不提供跨进程 CAS；冲突时重读再保存。旧隔离配置路径不迁移、不作 fallback。

## 4. 开发期约定

### 4.1 源码直引 + 零构建

- 每个包的 `exports` 直接指向 `src/index.ts`；Vite 与 tsx 直接消费 TS 源码，**开发期不构建包产物**。
- 各包独立 `tsc --noEmit` 检查（无 project references）。
- `moduleResolution: bundler` 统一在 `tsconfig.base.json`。
- 注意：包只能被转译器消费。Node 直接运行 TS 需经 tsx（迭代②宿主进程即用 tsx）。
- 生产阶段的包产物策略待宿主形态确定后再定。

### 4.2 代码规范

- 注释一律中文（AGENTS.md 规定）。
- Biome 负责 lint + format：2 空格缩进、单引号、无分号；行尾统一 LF（`.gitattributes` 同步约束，避免跨平台漂移）。
- TS strict 全开，附带 `noUncheckedIndexedAccess`、`verbatimModuleSyntax`。

### 4.3 i18n（Lingui v6）

- 源语言中文，首期仅 `zh-CN` 单语言包。
- 应用入口须用 `<I18nProvider i18n={i18n}>` 包裹根组件（Lingui v6 要求，缺了会运行时报错）。
- 宏写法：`import { Trans } from '@lingui/react/macro'`。
- 新增文案后跑 `pnpm lingui:extract` 更新 `.po`；构建与 dev 由插件自动编译，不需要手动 compile。
- Vite 8 使用 rolldown/oxc，Lingui 宏经 `@rolldown/plugin-babel` + `linguiTransformerBabelPreset` 接入（见 `apps/harness/vite.config.ts`），不是旧版的 `react({ babel: {...} })` 写法。

## 5. 已知陷阱

| 陷阱 | 说明与处理 |
| --- | --- |
| Vite 8 插件 API 变化 | `@vitejs/plugin-react` 已无 `babel` 选项（改用 oxc）。Lingui 宏接 `@rolldown/plugin-babel`。 |
| rolldown 版本漂移 | Vite 8 依赖 rolldown，其新版可能不满足发布龄约束；已在 `pnpm-workspace.yaml` overrides 固定 `rolldown: 1.2.12`。升级 Vite 时需同步评估。 |
| `.po` 文件缺失导致构建失败 | 首次克隆后先 `pnpm lingui:extract`（`src/locales/zh-CN.po` 需要存在）。 |
| `@huan/*` 包安装报 404 | workspace 包必须用 `workspace:*` 协议声明依赖（如 `pnpm add @huan/protocol` 会去 registry 找，应手动写入 package.json）。 |
| 热重载残留报错 | Vite HMR 过程中偶发的 `I18nProvider is not defined` / `createRoot` 重复调用报错，整页刷新后消失，属中间态。 |

## 6. 验证方式

- 常规验证：`pnpm check`（已包含测试）与 `pnpm build`；默认自动化使用临时用户空间，无需个人认证。
- 界面验证：`pnpm dev` 后打开 http://localhost:8799/ 。
- 浏览器回归：首次运行 `pnpm --filter @huan/harness exec playwright install chromium`，随后 `pnpm test:e2e`；交互测试面板为 `pnpm test:e2e:ui`。当前 Chromium 覆盖 63 条流程，单 worker，不并行运行多套实例。
- 主题验证：顶栏主题选择写入浏览器 localStorage `huan.theme`，只影响当前浏览器；不改 Pi 配置、`settings.json` 或 huan `state.json`。
- 隔离调试：`pnpm dev:e2e` 启动页面 http://127.0.0.1:8899 与宿主 8898，临时用户空间和确定性模型，无需个人凭据。默认模型故意无效，先选 Test Model A 再发送。Ctrl+C 退出；Windows 强制结束时残留位于 `apps/harness/test-results/e2e`，可删除。自动测试有统一清理。
- 项目 `.pi/mcp.json` 配置 Playwright MCP，执行 `/reload` 后接入工具；使用独立内存浏览器，复用上述安装的 Chromium。依赖已锁定，无需每次 npx 下载。先启动隔离页面，再调用导航/快照/点击工具。MCP 输出位于 `apps/harness/test-results/mcp`。
- 生产性能对照：先 `pnpm build`，再 `HUAN_E2E_PREVIEW=1 pnpm dev:e2e`（PowerShell 先设置 `$env:HUAN_E2E_PREVIEW='1'`）。复用相同隔离宿主与端口，页面改为 Vite preview；不要与其他浏览器测试同时运行。大列表输入/流式回归位于 `e2e/render-performance.spec.ts`，覆盖 250/1,000 条合成历史，测试附件记录往返时间与组件入口计数；开发模式含 StrictMode，时间包含自动化与双帧开销。
- 浏览器失败产物位于 `apps/harness/test-results`，包括截图和 trace；使用 `pnpm --filter @huan/harness exec playwright show-trace <trace.zip路径>` 查看。产物不入 Git。
- 容器与检查的覆盖范围：typecheck 覆盖全部 workspace 包；测试根运行（`vitest.config.ts` 统一 include）。

## 7. 迭代②：宿主与前端（已实现）

### 7.1 启动方式（两个终端）

```bash
# 终端 1：Node 宿主（Pi SDK 运行于此）
pnpm --filter @huan/harness dev:server

# 终端 2：前端
pnpm dev          # → http://localhost:8799/
```

前端经 Vite 代理（`/api/pi` → `127.0.0.1:8788`）访问宿主，避免 CORS。

### 7.2 宿主配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HUAN_PORT` | 8788 | 宿主端口 |
| `HUAN_WORKSPACE` | `tmp/agent-workspace`（仓库内） | Agent 工作目录 |
| `HUAN_ALLOWED_HOSTS` | `localhost:8799,127.0.0.1:8799,localhost:<HUAN_PORT>,127.0.0.1:<HUAN_PORT>`（随端口生成） | 允许的 Host（防 DNS rebinding；含直连与经 Vite 代理两种形态） |
| `HUAN_ALLOWED_ORIGINS` | `http://localhost:8799,http://127.0.0.1:8799` | 允许的来源 |
| `HUAN_TOKEN` | 空（不校验） | 访问凭证（开发期留空）。非空时前端经 Vite `define` 注入同名值并自动带 `x-huan-token` 头；需宿主与前端用同一值启动 |
| `PI_PROVIDER` / `PI_MODEL_ID` | 无 | 覆盖默认模型；缺省时读取 Pi settings.json |
| `PI_CODING_AGENT_DIR` | Pi 默认（`~/.pi/agent`） | 用户配置与默认会话空间 |
| `PI_CODING_AGENT_SESSION_DIR` | 无 | 单独覆盖会话目录，平铺存储，可主动共享；优先于 setting |

宿主的默认模型解析链路（`@huan/core` 的 `model-catalog.ts` + `host.ts`）：**启动引导装配 → 共享 modelRuntime（provider 注册）→ 显式目录刷新（可联网）→ 解析 `PI_PROVIDER/PI_MODEL_ID` 或 settings.json 的 `defaultProvider/defaultModel`**。要点：

- 默认模型在**宿主启动时固定解析**（env 优先）；`settings.json` 的修改需重启宿主生效（`setModel` 的 `persist` 默认 false，会话级切换不写全局默认）。
- 每次冷打开会**按目标 cwd 重新装配** settings/扩展/资源；共享的只有 modelRuntime（provider 注册为合并语义，重装配幂等）。
- 装配期自带的目录刷新为 `allowNetwork: false`（不拉取扩展远程模型列表）；联网刷新是宿主启动时的**显式**动作。
- 装配诊断（扩展注册失败、目录刷新错误）经 `host.diagnostics()` 返回，应用在启动时打印。

### 7.3 认证与模型

左侧按工作区一级、会话二级展示；工作区管理弹层支持名称、成员别名/路径、增删与路径健康/信任摘要。新建会话在该工作区选择起始项目，窗口偏好保存在 sessionStorage，创建后 cwd 固定。首次遇到受保护成员项目资源时，信任面板允许/拒绝后才继续装配；拒绝仍可使用用户资源对话。“记住此决定”写入所选 agentDir/trust.json 的当前路径条目，不写项目目录。无归属的既有 Pi 会话在“未归属会话”分组中明确加入工作区，宿主不会按 cwd 猜测。工作区、会话归属与归档标记存放在 `<agentDir>/huan/state.json`；归档是 huan sidecar 组织标记，未归属会话也可归档，重启保留且不修改 Pi JSONL；损坏时冷历史只读可用，相关修改禁用。会话列表支持范围/排序/仅命名/已归档过滤，搜索仅匹配显式名称与首条用户消息；显式刷新（按钮或窗口重新聚焦）会清空并重扫宿主作用域缓存。会话详情按需查询：热会话用 SDK `getSessionStats()`，冷会话只读文件聚合（复用 `deriveContextUsage`），不装配项目扩展、不联网；累计统计覆盖全文件（含其他分支与已压缩历史），与当前活动分支上下文分开显示。删除需确认，成功删除文件后清理 sidecar 元数据。同一元数据文件由单宿主管理，支持多个浏览器窗口；外部修改或修复文件后需重启宿主。工作区目前支持创建、改名和成员编辑，尚无删除入口。

G1.1 起可在页面“宿主信息与诊断”查看用户目录、会话存储方式及默认模型字段来源；支持复制安全摘要和重新查询。`GET /api/pi/host` 需通过现有访问校验，health 仍只返回 ok。目录与默认配置在宿主启动时固定，重新查询不等于重载。

会话目录优先级：宿主 `sessionDir` 参数 → `PI_CODING_AGENT_SESSION_DIR` → 启动工作区合并 setting → `<agentDir>/sessions/<编码 cwd>`。显式/env 相对路径按启动进程目录解析，setting 相对路径按启动工作区解析；指定覆盖时不再追加 cwd 分组。无效默认模型不阻止宿主启动，空白会话可选有效模型恢复新建；认证修改仍需重启。

- 已通过 `pi /login` 完成认证的机器无需额外配置。
- 自定义 provider（经 Pi 扩展注册，如 `~/.pi/agent/extensions/` 下的 provider 扩展）在宿主与模型选择器中均可用（迭代③起）。
- 模型选择器读取宿主真实注册表（含扩展 provider）；切换经 `setModel`（会话级，不修改全局默认）。
- **历史会话模型**：冷打开时由 SDK 从会话记录恢复（宿主不传默认模型）；如历史模型不可用/未配置认证，SDK 会回退到可用模型。恢复逻辑依赖 `sdk.js` 的「未传 model 才恢复」行为（已实测验证）。
- 目录刷新：启动时联网刷新一次（扩展 `fetchModels`）；失败保留缓存目录并记入 `host.diagnostics()`。

### 7.4 验证 Host UI 的方法（可复用）

在**工作目录**下创建 `.pi/extensions/` 临时扩展（如 `tmp/agent-workspace/.pi/extensions/ask-user.ts`），注册一个在 `execute` 中调用 `ctx.ui.confirm` / `ctx.ui.select` 的工具；重启宿主即可在对话中触发审批控件。验证完毕后删除该文件。扩展 API 见 `@earendil-works/pi-coding-agent` 的 `ToolDefinition` 与 `ExtensionAPI` 类型。

### 7.5 已知行为（非 bug）

- 顶栏“认证”或 `/login [provider]`、`/logout [provider]` 打开模型认证面板。支持 API key 与 provider OAuth 提示、授权页/设备码、回填、取消和退出；关闭面板不取消操作，多窗口可接管。凭据写入当前 agentDir/auth.json，普通快照/消息不包含回填值；退出仅移除已存凭据，环境变量/models.json 仍可能提供认证。状态轮询约 1～2 秒，本地可用性刷新不自动切换模型。
- 顶栏“设置与资源”或 `/settings` 打开同一面板，支持用户/可信项目常用项与 JSON 原文，保留未知字段；保存前校验，revision 不符明确冲突。保存只写磁盘，当前会话不自动应用；`/reload` 或面板“应用资源重载”在空闲时刷新当前会话设置/指令/扩展。原“重新加载”只重读磁盘原文，不是应用资源重载；空白页重载只更新目标 cwd 的待消费装配。sessionDir/代理等按提示重启宿主。资源清单来自实际 loader，指令/system prompt 文本仅显式请求时加载；未信任项目配置不返回原文。
- 会话上下文栏的“运行操作”面板集中提供直接 Shell（`!` / `!!`）、手动/自动压缩与模型目录/范围设置。Shell 与压缩、分叉、树导航互斥；取消 Shell 不停止模型运行。Shell 输出在宿主侧有界（120k 字符），持久历史以 `bashExecution` 消息为准。自动压缩开关保存到当前 `agentDir` 用户设置，写盘失败会如实报错，未确认保存时不修改live缓存。模型范围默认只作用于当前会话，勾选“保存为用户默认”才写入用户设置。
- 空闲会话的实时订阅由应用层 `PiLiveSubscription` 组件维持（运行时默认只在运行中自动连接）；组件在 `src/components/pi-live-subscription.tsx`，调用 `@huan/react` 的 `useHarnessController().connect()`（M2 起为公共类型声明的能力）。
- 输入框支持`/`命令目录/补全、`@`成员文件引用、`!`/`!!`直接Shell；命令按钮可查看可用来源及未实施命令。Shift+Enter换行，Enter发送，Ctrl/Cmd+Enter运行中转向；可显式选转向/后续、整体取回队列。上下键浏览本窗口输入历史，展开编辑支持长输入。
- 窗口文字草稿按宿主作用域与会话/cwd保存在sessionStorage；刷新只恢复文字，图片附件不持久化。图片支持选择/拖入/粘贴，发送前校验模型能力。
- 启动期扩展交互由页面级宿主Dialog应答，不要求先打开会话；关闭页面不取消请求，其他窗口可接管。扩展输入框修改须点击应用，目标窗口独立且旧文本可恢复。
- 队列仅整体取回（Pi无逐项API）；运行操作面板支持独立取消Shell与压缩。
