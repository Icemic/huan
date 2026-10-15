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

仓库根 `pnpm-workspace.yaml` 设置了 `minimumReleaseAge: 21600`（15 天）：所有依赖必须发布满 15 天才会被安装，用于降低供应链风险。遇到 `ERR_PNPM_NO_MATURE_MATCHING_VERSION` 时，查询满足发布龄的版本并显式降级（不要用 `minimumReleaseAgeExclude`，除非有明确理由）。

## 2. 常用命令（仓库根目录）

```bash
pnpm install          # 安装全部 workspace 依赖
pnpm dev              # 启动 apps/harness 开发服务器（Vite，默认 5173）
pnpm build            # 生产构建（tsc --noEmit && vite build）
pnpm check            # lint（Biome）+ 全 workspace 类型检查
pnpm lint             # 仅 Biome 检查
pnpm lint:fix         # Biome 自动修复
pnpm typecheck        # 全 workspace tsc --noEmit
pnpm test             # Vitest 单元测试（根运行，覆盖 packages/*/src 与 apps/*/src）
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
- Biome 负责 lint + format：2 空格缩进、单引号、无分号；行尾 CRLF（Windows 开发环境）。
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
- 界面验证：`pnpm dev` 后打开 http://localhost:5173/ 。
- 容器与检查的覆盖范围：typecheck 覆盖全部 workspace 包；测试根运行（`vitest.config.ts` 统一 include）。

## 7. 迭代②预告（开发环境相关）

- Node 宿主进程：`apps/harness/server/`，用 tsx 运行，默认端口 8788。
- Vite dev 配置将加入 `/api/pi` 代理指向宿主（避免 CORS）。
- 需要本机已通过 `pi /login` 完成 Pi 认证，或设置 `PI_PROVIDER` / `PI_MODEL_ID` 环境变量。
