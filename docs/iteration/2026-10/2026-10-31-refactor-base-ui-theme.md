# Base UI 与末语工坊主题统一

- 日期：2026-10-31
- 分类：refactor
- 关联：G1.2b 前的 UI 基础调整；Pi 行为与存储协议保持现有语义
- 决策：用户确认应用自有组件统一 Base UI，接受 assistant-ui 内部间接 Radix 依赖

## 1. 目标与范围

将 apps/harness 自有 UI 从 Radix 迁到 Base UI，移除应用直接 radix-ui/cmdk 依赖，保留 @assistant-ui/react 运行时。视觉沿用末语工坊 `D:/Workspace/moyu-workspace-old/fishflow/src` 的 Base UI 基础组件、ReUI 用法和界面主题，统一小圆角、紧凑控件和间距；不引入无使用场景的 Tree/DataGrid 等整套组件。

参考位置为 components/ui、components/reui、index.css 与主题切换实现。引用必要代码保留来源和许可。huan 独立维护源码，不跨仓库运行时 import，不复制 Tauri/编辑器特有状态与样式。中文注释与 Lingui 约定继续遵守。

## 2. 实施设计

### 2.1 组件与组合

替换 Button、Dialog、Popover、Tooltip、Avatar、Collapsible 及模型选择器的 Radix 直接使用，使用 Base UI 的 render/mergeProps/useRender 与相应状态/定位属性。assistant-ui primitives 可保留其公开组合接口，涉及弹层和菜单时使用本项目 Base UI 组件；避免一层 Escape 同时关闭两个弹层。

移除 cmdk。模型搜索选择采用 Base UI Combobox，保留 provider/modelId 值、模型搜索、选择、Thinking 级别、草稿和已存在会话设置语义；遵循可访问的列表/单选组合，不把交互式按钮塞进 listbox option。迁移可调整组件内部 API，调用方同步更新，不留下 Radix 兼容壳。

components.json 使用 Base UI style 和 assistant-ui style-aware registry。官方 Base UI 组件可作为参考，但其现有 model-selector 仍依赖 Command/cmdk，不能只重新安装组件就宣称已移除 cmdk。

### 2.2 视觉与主题

- 采用末语工坊界面配色的 light、dark、one-dark、solarized-light，不复制 editor-* 专用变量。
- radius 基准 0.25rem，按比例派生；紧凑按钮默认 32px、小号 28px、超小号 24px；列表/工具栏尽量遵循参考项目，保留清晰 focus/hover/disabled 状态。
- 统一控件、工作区侧栏、成员管理/信任、模型选择、输入区、消息与工具卡片的圆角和边距；聊天正文保持可阅读的字号与行高，不全局缩小文字。
- 字体沿用参考项目 Geist（本地依赖加载，中文系统回退）。主题入口采用简单选择，含跟随系统；仅浏览器本地保存，不占用 Pi 配置或 huan 工作区元数据。
- 保留多项目工作区/会话两级结构和现有产品行为。本轮不做布局重设计，不增加展示装饰与复杂动效。

### 2.3 依赖边界

应用及自有包源码没有 radix-ui/@radix-ui/cmdk 的直接 import，应用 package.json 不再直接声明 radix-ui/cmdk。pnpm why 仍可能显示 @assistant-ui/react 的内部 radix-ui 依赖，属于已接受范围，不维护 assistant-ui fork。依赖安装遵守 minimumReleaseAge，遇拦截显式选满足发布时间的版本。

## 3. 验证与回退

运行 pnpm check、pnpm build、pnpm lingui:extract 和现有 Chromium 回归。新增浏览器覆盖键盘模型搜索选择/Thinking、Dialog 内 Popover 的逐层 Escape 与焦点恢复、主题切换及恢复、紧凑规格。保留已有断流/双窗/工作区与信任回归，不以刷新掩盖状态未更新。

依赖核对分别检查源码 import、直接 dependencies 和 pnpm why 的间接链；视觉检查注明实际范围，以真实页面/计算样式与截图审阅为证据。自动化继续用隔离用户空间和合成模型，无个人凭据/会话或付费模型请求。

回退可撤回应用组件、样式、依赖和本地主题设置代码；不改 Pi JSONL、信任或 state.json。路线图为排期/完成状态唯一来源，完成后在本记录补充修改与亲验结果。

## 4. 开发实施记录

主体编码使用 `opencode-go/deepseek-v4.1-flash:max`，主 agent 已亲自 review、修复并完成验证。完成状态由 roadmap 维护。

### 4.1 自有组件与依赖

- 新增 `@base-ui/react@1.9.0`（满足 `minimumReleaseAge`）与 `@fontsource-variable/geist@5.3.0`，移除应用直接依赖 `radix-ui`、`cmdk`。
- `components/ui` 改为基础组件本地封装：Button、Dialog、Popover、Tooltip、Avatar、Collapsible、Input、Textarea，并新增主题使用的 Base UI Select。Button/Popover/Tooltip/Select 调用方改用 `render`，未保留 `asChild` 兼容壳。
- 删除 `components/ui/command.tsx` 与 app 内 cmdk 调用；`rg` 检查 apps/packages 源码无 `radix-ui`、`@radix-ui`、`cmdk` 直接 import，应用 `package.json` 不再声明这两个直接依赖。
- `pnpm why radix-ui` 仍显示 `radix-ui@1.8.0 ← @assistant-ui/react@0.15.28`，属于已接受的 assistant-ui 内部间接依赖；`pnpm why cmdk` 无结果。
- `apps/harness/components.json` 改为 `base-nova`，assistant-ui registry 使用 `https://r.assistant-ui.com/styles/{style}/{name}.json`，由 shadcn CLI 按 style 选择 Base UI 变体。
- 删除未再使用的 `model-selector.aui.tsx`，模型选择器统一由 `elements/model-selector.tsx` 维护；`ModelSelectorModelContext` 未被实际接线，不再保留无效包装。

### 4.2 模型选择与 Thinking

- 模型选择器改用 Base UI Combobox：输入框位于弹层内，按模型 id、名称、provider 与 keywords 过滤；值继续使用 `provider/modelId`。
- 列表使用 `Combobox.List` 的集合渲染函数，确保搜索过滤实际作用于列表；option 只包含模型展示信息。
- Thinking 改为 listbox 外的独立 radiogroup，支持 Tab 进入、方向键切换与 `data-checked` 样式，不在 option 内嵌按钮。
- 保留空白会话草稿：模型与 Thinking 在首条消息创建前写入 `pi-model-draft`，创建后清除草稿并以会话配置为准；已存在会话继续经 `extras.setModel` / `extras.setThinkingLevel`。
- 测试 fixture 的合成模型补充 `reasoning` 与 `thinkingLevelMap`，浏览器测试可覆盖真实 Thinking 级别；不改变宿主协议。

### 4.3 assistant-ui 弹层与工作区交互

- 助手消息的 ActionBarMore 由 assistant-ui Radix 下拉原语改为项目 Base UI Popover；导出 Markdown 直接使用 `ActionBarPrimitive.ExportMarkdown` 的 button 接口。
- 会话操作 Popover 改为受控并显式关闭；工作区成员“移除成员”改为 Base UI Popover 菜单，提供 Dialog 内嵌套 Popover 的真实回归场景。
- 附件预览 Dialog 与 Tooltip 通过 Base UI `render` 组合，移除 Radix Slot；TooltipIconButton 不再使用 Slot.Slottable。
- 修正紧凑缩略图下移除按钮的扩展命中区，避免其覆盖预览点击；预览、移除与关闭经真实页面手工核对。
- 保留 `@assistant-ui/react` 运行时及其内部弹层/组合原语；未 fork 或替换 assistant-ui。

### 4.4 主题与视觉

- `index.css` 采用 light、dark、one-dark、solarized-light 四套通用界面 tokens（未复制 editor-* 变量），`--radius` 为 `0.25rem`，半径按比例派生。
- 按钮默认 32px、小号 28px、超小号 24px；输入框 32px；侧栏行、模型触发器、发送/附件按钮与工具栏保持紧凑。
- 同步调整 composer 圆角/内边距、消息气泡、工具卡片、Reasoning、附件缩略图与操作栏弹层，避免只改根 radius。
- 字体使用本地 `@fontsource-variable/geist`，中文回退 PingFang SC / Microsoft YaHei / Noto Sans CJK SC；未设置全局 `user-select: none`，消息正文仍可复制。
- 新增 `lib/theme.ts` 与顶栏 ThemeSelector：system / light / dark / one-dark / solarized-light，系统主题变化即时重算；仅写入 localStorage `huan.theme`，不写 Pi 配置、`state.json` 或工作区元数据。
- 保留工作区/会话两级布局、项目成员、信任、模型目录与数据隔离行为；未新增 Tree/DataGrid 或布局重设计。
- 新增 `apps/harness/THIRD-PARTY-NOTICES.md`，记录 Base UI、shadcn/ui 与 Geist 字体来源和许可。

## 5. 自动化验证记录

| 检查 | 结果 |
| --- | --- |
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过（全部 workspace 与 app/server/e2e） |
| `pnpm test` | 517 项通过 |
| `pnpm build` | 通过；保留既有大 chunk 警告 |
| `pnpm lingui:extract` | 通过，zh-CN 94 条、无缺失 |
| `pnpm test:e2e` | 主 agent 实测 16 条 Chromium 通过 |

- 原有 12 条浏览器回归保留并通过；新增 `e2e/ui-base.spec.ts` 4 条：键盘模型搜索/Thinking/草稿、图片附件预览/移除与焦点恢复、主题切换与刷新/系统恢复及紧凑计算样式、Dialog 内 Popover 逐层 Escape 与焦点恢复。
- 实际页面核对：模型弹层 `listbox` 过滤、Thinking `radiogroup`、主题 `--background` 计算值（One Dark `#282c34`）、One Dark 刷新恢复、Dialog 内 Popover 第一层 Escape 后焦点回到“成员操作”、第二层回到“管理工作区”；附件缩略图预览 Dialog、Tooltip 触发与移除按钮手工通过。
- 主 agent 实测 `pnpm check`：517 项测试、lint 和全部类型检查通过；review 修复后再次完成 lint/typecheck、构建、文案提取及 16 条浏览器回归。依赖链核对确认 cmdk 已移除，Radix 仅由 assistant-ui 间接引入。
- 截图产物位于 `apps/harness/test-results`（不入 Git）；本轮验收依据页面 DOM、计算样式与真实交互，没有宣称完成截图视觉审阅。

## 6. 主 agent review 与限制

- 模型目录优先按当前会话的固定 cwd 查询，避免工作区内新建偏好改变后查询另一项目。
- Thinking 显示受草稿/会话配置控制，选择器按会话重建，避免未定义配置回退到上个会话内部状态。
- 修正关闭折叠面板的反向 keyframes，并移除本地样式的 Radix 面板高度变量。
- 附件预览/移除已补入自动化，验证 Esc 后焦点返回及移除不会误触预览。
- assistant-ui 内部 Radix 依赖按用户确认保留；后续升级需复跑弹层与焦点回归。
