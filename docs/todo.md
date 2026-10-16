# 待办

**最后更新**：2026-10-15
**说明**：当前迭代待办 + 后续里程碑概览。迭代文档见 `docs/iteration/2026-10/`。

---

## 当前迭代

### 迭代① monorepo 骨架与包边界（✅ 已完成 2026-10-15）

文档：`docs/iteration/2026-10/2026-10-15-feat-monorepo-skeleton.md`

- [x] workspace 基础：root package.json、pnpm-workspace.yaml、tsconfig.base.json、Biome、.gitignore
- [x] `packages/protocol` 骨架（版本常量占位）
- [x] `packages/core` 骨架（占位）
- [x] `packages/react` 骨架（占位）
- [x] `packages/history` 骨架（占位）
- [x] `apps/harness` 脚手架：Vite + React 19 + Tailwind v4 + Lingui + Zustand
- [x] Vitest 根配置 + 占位测试
- [x] root 脚本：dev / build / check / test / lint
- [x] 文档：dev-guide.md、AGENTS.md 速览补齐、todo.md
- [x] git 首次提交

验证记录：check / test / build / dev 浏览器验证 / lingui extract 全部通过（详见迭代文档 §9）。

### 迭代② 最小闭环应用（✅ 已完成 2026-10-16）

文档：`docs/iteration/2026-10/2026-10-15-feat-minimal-loop.md`

- [x] Node 宿主服务（Hono + createPiNodeClient + 官方路由契约 + loopback/Origin/token 安全边界）
- [x] 默认模型解析（加载用户扩展提取 provider 注册 + 默认模型，自定义 provider 可用）
- [x] SSE 端点与流式验证（经 Vite 代理逐字输出）
- [x] 前端接入：usePiRuntime + assistant-ui Thread 主题（含会话列表、Reasoning 折叠）
- [x] 模型与 Thinking 切换（选择器 UI 已接；目录当前为本地 mock，待 supervisor 装配修复）
- [x] Host UI：工具卡片审批控件完整闭环（select 验证通过）
- [x] 中断、Steer / Follow-up、队列展示
- [x] 多窗口实时同步（应用层 PiLiveSubscription）
- [x] 断线恢复（快照完整恢复）
- [x] Lingui 文案接入（应用文案）
- [x] `server/` tsconfig 与 typecheck 接入
- [x] Zustand——评估后未实施（无真实需求，推迟至出现窗口级自主状态时）

---

## 后续里程碑概览

### M2 Checkpoint 与变更审查（下一里程碑，D-18 优先）

- [ ] 内容寻址快照后端设计：存储布局、忽略策略、大文件阈值、重命名识别
- [ ] 快照触发：run / 工具调用边界
- [ ] ChangeSet 与 manifest diff
- [ ] Monaco Diff 审查视图（文件级接受/撤销）
- [ ] 选择性恢复 + 外部改动冲突检测
- [ ] Provider 契约落地（`@huan/history`）

### M3 日用强化

- [ ] Pi 配置/扩展生态兼容（对照 CLI 加载行为）
- [ ] 文件树与代码浏览（Monaco 查看）
- [ ] 常用交互打磨（按真实使用痛点）
- [ ] 公共层固化（D-14 阶段 2：纯 reducer/投影 + 自研 Controller）

### M4 末语工坊接入

- [ ] 设计启动（M4 开始前细化边界，D-17）
- [ ] Editor Bridge、编辑器上下文工具、专用 Tool UI、事务撤销适配

---

## 待细化事项

| 事项 | 计划处理时机 |
| --- | --- |
| 快照存储位置与忽略策略细节 | M2 设计时 |
| 会话分支 / 树导航 UI | 公共层固化阶段（D-15） |
| 桌面宿主评估（Electron / Tauri / 其他） | 闭环验收后（D-12） |
| OS 级沙箱升级（编辑器 Agent） | 面向不可信项目或第三方分发时（D-20） |
| 附件能力（目前仅图片 passthrough） | 按需求评估 |
| skills / extensions 在 UI 中的呈现 | 按需求评估 |
| CI 建立（frozen-lockfile 安装 + check + test + build） | 闭环跑通后按需（顾问 review 延后项） |
| 宿主访问凭证完整设计 | 迭代②（§3.5 已有基础方案） |
| `@huan/react` peerDependencies 声明 | 首次实现组件时 |
| **react-pi supervisor 缺口**：不加载用户扩展，`getAvailableModels` 与 `setModel` 拿不到扩展注册的 provider（如 my-provider）。当前对策：模型选择器用本地 mock（`pi-model-selector.tsx`）。正确修法：supervisor 的 `getModelRuntime()` 接入扩展加载（stage 2 自研宿主的既定职责）。处理时机：公共层固化阶段 | |
| Zustand 窗口本地状态：当前无自主状态需要管理（会话选择/草稿均由 react-pi 内部管理）；出现窗口级状态需求（如布局偏好、多窗口差异化视图）时引入 | |
