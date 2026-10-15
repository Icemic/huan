# 迭代：monorepo 骨架与包边界

- **日期**：2026-10-15
- **分类**：feat
- **状态**：已完成（2026-10-15）
- **决策依据**：D-11（先骨架后闭环）、D-13（pnpm monorepo + @huan/* + AGPL）、D-23～D-25（UI 栈 / Zustand / Lingui）；技术架构 §1、§2、§9

---

## 1. 目标

建立 pnpm monorepo 骨架与工具链：仓库可安装、可检查、可测试、可启动空壳应用；确立 `@huan/*` 包边界与依赖方向；文档体系（`dev-guide.md`、`todo.md`、AGENTS.md 速览）就位。

只建结构，不预设复杂接口（D-11）：本轮不写协议类型、Controller、Checkpoint 契约。

## 2. 范围

### 2.1 做

1. **workspace 基础**：root `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、Biome 配置、`.gitignore`、`engines`（Node >= 22.19）。
2. **四个公共包骨架**：`protocol` / `core` / `react` / `history`，各自 package.json + tsconfig + 最小 `src/index.ts`（仅占位导出）。
3. **应用脚手架** `apps/harness`：Vite + React 19 + TS strict + Tailwind v4 + shadcn init（flavor 与 assistant-ui 主题一致）+ Lingui 初始化 + Zustand 安装。
4. **测试与检查**：Vitest 根配置（含一条占位测试）；typecheck / lint 脚本。
5. **脚本**：`dev` / `build` / `check` / `test` / `lint` 在 root 可用。
6. **文档**：`docs/dev-guide.md` 建立；`docs/todo.md` 建立；`AGENTS.md`「项目速览」补齐。
7. **git 首次提交**。

### 2.2 不做

- 不接 Pi SDK / react-pi / assistant-ui 聊天组件（迭代②）。
- 不实现协议类型、运行时 Controller、Checkpoint 契约。
- 不做打包/发布形态（桌面宿主未锁定，D-12）。

## 3. 设计

### 3.1 目录结构

```
huan/
├── package.json              # workspace root（private）
├── pnpm-workspace.yaml       # packages: ["packages/*", "apps/*"]
├── tsconfig.base.json        # 共享 TS 选项（strict、bundler 解析）
├── biome.json                # lint + format
├── .gitignore
├── AGENTS.md
├── LICENSE                   # AGPL-3.0（已就位）
├── docs/
│   ├── product-design.md
│   ├── technical-architecture.md
│   ├── dev-guide.md          # 本迭代建立
│   ├── todo.md               # 本迭代建立
│   └── iteration/2026-10/
├── packages/
│   ├── protocol/             # @huan/protocol：纯 TS 类型，无运行时依赖
│   ├── core/                 # @huan/core：Pi SDK 集成与运行时（Node）
│   ├── react/                # @huan/react：assistant-ui 适配与通用 UI
│   └── history/              # @huan/history：Checkpoint/ChangeSet 契约
└── apps/
    └── harness/              # 通用 Harness 应用（Vite + React）
        ├── index.html
        ├── vite.config.ts
        └── src/
```

### 3.2 源码直引 + 零构建开发

- 每个包的 `exports` 直接指向 `src/index.ts`（types 同源）；Vite 与 `tsx` 直接消费 TS 源码，开发期不需要构建包产物。
- 各包独立 `tsc --noEmit` 类型检查（不使用 project references），root `check` 脚本聚合。
- `moduleResolution: bundler`（tsconfig.base 统一）。
- 生产阶段再决定包产物策略（宿主形态未锁定，不提前引入）。

> 注意：该模式下包只能被转译器（Vite / tsx）消费；Node 直接运行 TS 文件需经 tsx。迭代②的宿主进程用 tsx 运行，符合此约定。

### 3.3 工具链决策（收敛技术架构 §1 待定项）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| Lint/Format | **Biome** | 单工具、快、配置少；TS/React 规则覆盖足够个人项目 |
| 类型检查 | `tsc --noEmit`（strict 全开） | 标准做法 |
| 测试 | Vitest | 与 Vite 同生态 |
| Node | >= 22.19（engines + dev-guide 记录） | Pi SDK 要求 |

### 3.4 应用脚手架内容

- Vite `react-ts` 模板；React 19；TS strict。
- Tailwind v4（`@tailwindcss/vite` 插件方式）。
- shadcn init：无头 flavor 与 assistant-ui 主题保持一致（assistant-ui CLI 默认 Base UI；以 CLI 实际支持为准）；本轮仅 init，不批量 add 组件。
- Lingui：安装 + `lingui.config.ts` + i18n 入口 + 页面一条示例文案，验证提取链路（`pnpm lingui extract`）。
- Zustand：仅安装依赖，无 store。

### 3.5 包占位内容

- `protocol`：导出 `HARNESS_PROTOCOL_VERSION` 常量（协议显式版本化的最小占位）。
- `core` / `react` / `history`：`index.ts` 仅含说明性注释与空导出，内容在对应迭代填充。

## 4. 兼容性与依赖

- Node >= 22.19（Pi SDK 要求）；pnpm 10。
- 骨架期无运行时外部依赖；应用依赖（React、Tailwind、Lingui、Zustand）为当前稳定大版本，安装时记录实际版本于 lockfile。
- 不引入与迭代②无关的依赖。

## 5. 验证（验收标准）

1. 干净目录 `pnpm install` 成功。
2. `pnpm check` 通过（lint + 全 workspace typecheck）。
3. `pnpm test` 通过（占位测试）。
4. `pnpm dev` 启动应用；浏览器显示空壳页：Tailwind 样式生效、Lingui 示例文案正确渲染、`@huan/protocol` 的版本常量显示在页面上（验证包解析链路）。
5. `pnpm lingui extract` 能提取到示例文案。
6. `docs/dev-guide.md` 记录环境要求与全部常用命令。

## 6. 回滚

纯新增内容，无破坏性变更。回滚 = revert 本迭代提交；无数据迁移影响。

## 7. 实施清单

1. root：`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`biome.json`、`.gitignore`
2. `packages/protocol`：package.json + tsconfig + index.ts（版本常量）
3. `packages/core`：package.json + tsconfig + index.ts（占位）
4. `packages/react`：package.json + tsconfig + index.ts（占位）
5. `packages/history`：package.json + tsconfig + index.ts（占位）
6. `apps/harness`：Vite 脚手架 + Tailwind v4 + shadcn init + Lingui + Zustand
7. Vitest 根配置 + 占位测试
8. root 脚本：dev / build / check / test / lint
9. `docs/dev-guide.md`；`docs/todo.md`；`AGENTS.md` 速览补齐
10. git 首次提交

## 8. 完成口径

代码 + 自动化检查（check/test）+ 文档完成后即标记完成（AGENTS.md 迭代完成口径）。手工检查不阻塞。

---

## 9. 实施记录（2026-10-15）

### 实际版本（均满足 15 天发布龄约束）

| 依赖 | 版本 |
| --- | --- |
| TypeScript | 5.9.3（catalog 统一） |
| Vite | 8.3.1（rolldown 内核，overrides 固定 `rolldown: 1.2.12`） |
| Vitest | 5.0.3 |
| Biome | 2.5.14 |
| React / ReactDOM | 19.3.0 |
| Lingui（core/react/cli/vite-plugin/babel-macro） | 6.8.0 |
| Zustand | 5.0.15 |
| Tailwind CSS / @tailwindcss/vite | 4.3.3 |
| @vitejs/plugin-react | 6.1.1 |
| @rolldown/plugin-babel | 0.2.4 |

### 与设计的偏差（已修正）

1. **Lingui 宏接入方式**：Vite 8 的 `@vitejs/plugin-react` 已移除 `babel` 选项（改用 oxc）。实际接入为 `@rolldown/plugin-babel` + `linguiTransformerBabelPreset()`（Lingui 官方对 Vite 8 的推荐形态）。
2. **Lingui 运行时**：v6 要求 `<I18nProvider>` 包裹根组件，缺省会运行时报错；已在 `main.tsx` 接入。
3. **Biome 配置**：`linter.rules.recommended` 已弃用（v2 直接启用推荐规则）；忽略路径写法跟随 `useBiomeIgnoreFolder` 规则；行尾设 `crlf`（Windows）。
4. **供应链拦截**：`minimumReleaseAge`（用户设置 15 天）拦下了 biome 2.5.15、vite 8.3.4、rolldown 1.2.14 等过新版本，全部显式降级至满足约束的最新版。

### 验证结果

- `pnpm check` 通过（Biome 27 文件 + 5 包 typecheck）。
- `pnpm test` 通过（1 测试）。
- `pnpm build` 通过（227.84 kB JS + 5.79 kB CSS，gzip 71.88 kB + 1.90 kB）。
- `pnpm dev` + 浏览器验证：Tailwind 样式生效、Lingui 文案「骨架已就绪」正确渲染、`@huan/protocol` 版本常量显示（workspace 包解析链路验证）。
- `pnpm lingui:extract` 提取到 1 条文案（zh-CN source）。

### 遗留说明

- `.po`（`src/locales/zh-CN.po`）为提取产物，需提交版本控制（构建依赖其存在；首次克隆后若缺失先跑 `pnpm lingui:extract`）。
- dev-guide 已记录已知陷阱：Vite 8 插件 API 变化、rolldown 版本固定、workspace 包安装方式、HMR 中间态报错。
