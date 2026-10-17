# 开发与调试指南

**最后更新**：2026-10-15
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
│   ├── core/       # @huan/core：Pi SDK 集成与运行时（Node）
│   ├── react/      # @huan/react：assistant-ui 适配与通用 UI
│   └── history/    # @huan/history：Checkpoint/ChangeSet 契约
├── apps/
│   └── harness/    # 通用 Harness 应用（Vite + React 19）
└── docs/
```

依赖方向（强制）：`apps/*` → `@huan/core` / `@huan/react` / `@huan/history` → `@huan/protocol`。`core` / `protocol` 不依赖 React；`react` 不依赖 Node。

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

- 常规验证：`pnpm check && pnpm test`。
- 界面验证：`pnpm dev` 后打开 http://localhost:8799/ 。
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
| `PI_CODING_AGENT_DIR` | Pi 默认（`~/.pi/agent`） | Pi 配置目录 |

宿主的默认模型解析链路（`@huan/core` 的 `model-catalog.ts` + `host.ts`）：**启动引导装配 → 共享 modelRuntime（provider 注册）→ 显式目录刷新（可联网）→ 解析 `PI_PROVIDER/PI_MODEL_ID` 或 settings.json 的 `defaultProvider/defaultModel`**。要点：

- 默认模型在**宿主启动时固定解析**（env 优先）；`settings.json` 的修改需重启宿主生效（`setModel` 的 `persist` 默认 false，会话级切换不写全局默认）。
- 每次冷打开会**按目标 cwd 重新装配** settings/扩展/资源；共享的只有 modelRuntime（provider 注册为合并语义，重装配幂等）。
- 装配期自带的目录刷新为 `allowNetwork: false`（不拉取扩展远程模型列表）；联网刷新是宿主启动时的**显式**动作。
- 装配诊断（扩展注册失败、目录刷新错误）经 `host.diagnostics()` 返回，应用在启动时打印。

### 7.3 认证与模型

- 已通过 `pi /login` 完成认证的机器无需额外配置。
- 自定义 provider（经 Pi 扩展注册，如 `~/.pi/agent/extensions/` 下的 provider 扩展）在宿主与模型选择器中均可用（迭代③起）。
- 模型选择器读取宿主真实注册表（含扩展 provider）；切换经 `setModel`（会话级，不修改全局默认）。
- **历史会话模型**：冷打开时由 SDK 从会话记录恢复（宿主不传默认模型）；如历史模型不可用/未配置认证，SDK 会回退到可用模型。恢复逻辑依赖 `sdk.js` 的「未传 model 才恢复」行为（已实测验证）。
- 目录刷新：启动时联网刷新一次（扩展 `fetchModels`）；失败保留缓存目录并记入 `host.diagnostics()`。

### 7.4 验证 Host UI 的方法（可复用）

在**工作目录**下创建 `.pi/extensions/` 临时扩展（如 `tmp/agent-workspace/.pi/extensions/ask-user.ts`），注册一个在 `execute` 中调用 `ctx.ui.confirm` / `ctx.ui.select` 的工具；重启宿主即可在对话中触发审批控件。验证完毕后删除该文件。扩展 API 见 `@earendil-works/pi-coding-agent` 的 `ToolDefinition` 与 `ExtensionAPI` 类型。

### 7.5 已知行为（非 bug）

- 空闲会话的实时订阅由应用层 `PiLiveSubscription` 组件维持（react-pi 默认只在运行中连接）；组件在 `src/components/pi-live-subscription.tsx`，依赖运行时内部对象中的 `controller`（未在公共类型声明，已用类型断言标注）。
- 队列（steer / follow-up）只做展示，不提供逐项操作（react-pi 无逐项 API，只支持整体清空）。
