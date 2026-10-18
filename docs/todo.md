# 待办与迭代历史

**最后更新**：2026-10-18
**状态**：迭代**历史**记录 + **当下**环境/状态快照。

**计划请看 `docs/roadmap.md`**（唯一开发计划权威来源）。本文件只回答两个问题：「已经做过什么」与「现在处于什么状态」。

---

## 1. 当前状态

### 1.1 里程碑位置

- **已完成**：M0 骨架（迭代①）、M1 最小闭环（迭代②）、M1.5 宿主自研（迭代③ + 3 次补丁）
- **进行中**：无
- **下一步**：M2 公共层固化（`@huan/react` 自研 Controller）——详见 `roadmap.md` §2

### 1.2 环境与运行

环境的**唯一权威说明**在 `docs/dev-guide.md`（环境要求、常用命令、启动方式、宿主配置、已知陷阱）。

快速启动（两个终端）：

```bash
pnpm --filter @huan/harness dev:server   # 终端 1：Node 宿主（Pi SDK 运行于此）
pnpm dev                                  # 终端 2：前端 → http://localhost:8799/
```

验证命令：`pnpm check && pnpm test`（当前 88 项测试全绿）。详细信息见 `dev-guide.md` §2 与 §7。

---

## 2. 迭代历史

按时间倒序。每项只记**已完成的事实**与链接；完整设计见对应迭代文档。

### 事件回放验证（✅ 2026-10-18，`test`）

文档：`docs/iteration/2026-10/2026-10-18-test-event-replay.md`

- 回放链路：映射层输出 + 宿主直发事件 → JSON 往返 → 真实消费方 reducer
- fixture 层 22 项 + 集成层 1 项（真实宿主事件流与权威快照对齐）
- **修复**：快照隔离（`snapshotOf` 曾引用 SDK 活跃数组；且 SDK 会 `_replaceMessageInPlace` 原地改写消息对象）
- 变异验证 4 项全部被捕获

### 取消语义收敛与竞态测试（✅ 2026-10-17，`bugfix`）

文档：`docs/iteration/2026-10/2026-10-17-bugfix-cancel-semantics.md`

- **修复真实缺陷**：用户取消后会话被误标为 `failed` 并广播 error 事件
- 取消口径：`agent_settled.aborted` 为权威判据；失败结算移至 `agent_settled`
- 预检取消兜底三层：准入闸门 + 输入守卫扩展（ALS 归属）+ `agent_start` 中止
- 退休收尾：排空在途发送（5s 上限）；延迟动作三层拦截（含 agent 级兜底订阅）
- 9 条竞态用例（8 条经变异验证）

### 宿主标题口径统一（✅ 2026-10-17，`fix`）

提交 `4060a67`：live 路径读**全文件**首条 user 消息，与冷读口径一致（此前用 `getBranch()`，分支场景下与冷读不一致）。

### 迭代③ 公共层宿主自研（✅ 2026-10-17，`feat`）

文档：`docs/iteration/2026-10/2026-10-17-feat-core-host.md`

- `@huan/protocol`：协议类型定义 + 版本策略
- `@huan/core`：`createHarnessHost` 宿主（会话生命周期、事件映射、Host UI 桥、模型目录）
- 装配层：共享 modelRuntime + 按 cwd 每会话独立装配 + 诊断呈现
- **修复两个 supervisor 缺口**：历史会话模型恢复（新/冷语义分离）、模型目录可见（`getAvailableModels`/`setModel` 走真实目录）
- `server/` 迁移（删除 model-resolution）+ 前端模型选择器去 mock
- 端到端验证（API 级）+ 文档

### 迭代② 最小闭环应用（✅ 2026-10-16，`feat`）

文档：`docs/iteration/2026-10/2026-10-15-feat-minimal-loop.md`

- Node 宿主服务（Hono + 官方路由契约 + loopback/Origin/token 安全边界）
- 默认模型解析（加载用户扩展提取 provider 注册，自定义 provider 可用）
- SSE 端点与流式验证（经 Vite 代理逐字输出）
- 前端接入：usePiRuntime + assistant-ui Thread 主题（会话列表、Reasoning 折叠）
- 模型与 Thinking 切换、Host UI 审批闭环、中断 / Steer / Follow-up / 队列展示
- 多窗口实时同步（应用层 `PiLiveSubscription`）、断线恢复
- Lingui 文案接入、`server/` tsconfig 与 typecheck 接入

### 迭代① monorepo 骨架（✅ 2026-10-15，`feat`）

文档：`docs/iteration/2026-10/2026-10-15-feat-monorepo-skeleton.md`

- pnpm workspace、包边界（protocol / core / react / history）、应用脚手架
- 文档体系、构建 / 测试 / lint 工具链

---

## 3. 当下已知限制

当前实现中**用户可感知**的限制（技术债与长期计划见 `roadmap.md` §6）：

| 限制 | 说明 |
| --- | --- |
| `settings.json` 修改需重启宿主 | 默认模型在宿主启动时固定解析（`setModel` 的 persist 默认 false） |
| 归档状态不跨重启 | 内存态标记，重启丢失 |
| 附件仅图片 | 无其他文件类型支持 |
| skills / extensions 不暴露 UI | SDK 层已支持加载，界面不呈现 |
| 会话分支 / 树导航不可用 | Pi 侧数据完整保留，UI 未做（D-15） |
| 无 Checkpoint / 回滚 | 属 M3 |
| 会话列表无搜索 | 按需添加 |

---

## 4. 图例

- 迭代文档命名：`docs/iteration/<YYYY-MM>/<YYYY-MM-DD>-<category>-<name>.md`
- 分类：`feat` / `perf` / `bugfix` / `refactor` / `test`（定义见 `AGENTS.md`）
- ✅ = 已完成（代码 + 自动化检查 + 文档齐备）；桌面手工检查与发布验证不阻塞迭代完成
