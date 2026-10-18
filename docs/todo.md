# 待办与迭代历史

**最后更新**：2026-10-18
**状态**：迭代**历史**记录 + **当下**环境/状态快照。

**计划请看 `docs/roadmap.md`**（唯一开发计划权威来源）。本文件只回答两个问题：「已经做过什么」与「现在处于什么状态」。

---

## 1. 当前状态

### 1.1 里程碑位置

- **已完成**：M0 骨架（迭代①）、M1 最小闭环（迭代②）、M1.5 宿主自研（迭代③ + 3 次补丁）、M2 公共层固化（迭代④）
- **进行中**：无
- **下一步**：M3 Checkpoint 与变更审查——详见 `roadmap.md` §2

### 1.2 环境与运行

环境的**唯一权威说明**在 `docs/dev-guide.md`（环境要求、常用命令、启动方式、宿主配置、已知陷阱）。

快速启动（两个终端）：

```bash
pnpm --filter @huan/harness dev:server   # 终端 1：Node 宿主（Pi SDK 运行于此）
pnpm dev                                  # 终端 2：前端 → http://localhost:8799/
```

验证命令：`pnpm check && pnpm test`（当前 416 项测试全绿）。详细信息见 `dev-guide.md` §2 与 §7。

---

## 2. 迭代历史

按时间倒序。每项只记**已完成的事实**与链接；完整设计见对应迭代文档。

### 迭代④ M2 公共层固化（✅ 2026-10-18，`feat`）

文档：`docs/iteration/2026-10/2026-10-18-feat-react-controller.md`

- **`@huan/react` 成熟为公共包**：reducer、消息投影、Host UI 辅助、自研 Controller、公共 hook、HTTP/SSE 客户端、载荷校验；`vendor/` 层本地化全部 11 个上游 internal 工具
- **apps/harness 切换完成**：6 个文件改用 `@huan/react`，`@assistant-ui/react-pi` 依赖已完全移除（0.0.29）
- **移植策略**：发现 react-pi 的 npm 包同时发布原始 TS 源码与完整测试（`files: ["dist","src","README.md"]`），因此采用「复制源码 + 测试，改类型命名空间」而非参照编译产物重写
- **测试覆盖**：上游可移植用例 259 项中覆盖 243 项（94%）——`ThreadController` 75+2、`messageProjection` 34+2、`eventSource` 33+5、`threadState` 23+1、`hostUi` 22、`useHarnessRuntime` 系列 21、`httpClient` 33+6、`disposeControllers` 1；新增 vendor 单测 34 项
- **SSE 链路端到端验证**（roadmap §2.2 退出标准）：`apps/harness/server/sse-link.test.ts` 5 项，覆盖快照优先、live-only 断流恢复、序号重置、同批快照与增量、畸形事件断流恢复；为此把 SSE 路由抽为 `server/sse.ts`
- **回放测试切换到自研 reducer**：23 项 fixture 全复用
- **相对上游的语义改动**（顾问已审查）：`subscribe` 改为单订阅（不做 `sharedStreamCache`，顾问确认不会丢必要事件）；删除 Assistant Cloud 分支；`connect()` 提升为 extras 正式能力（替代应用侧类型断言 hack）
- **第三方许可**：新增 `packages/react/THIRD-PARTY-NOTICES.md`（react-pi / core / store 三方的版权声明与 MIT 全文）
- 全量 `pnpm check` 全绿（87 文件 lint、6 包类型、416 项测试）

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
| 已加载会话重新连接不补离线历史 | `connect()` 在 `loadState === 'loaded'` 时用 `snapshot=false`；连接关闭（30 秒宽限）后重连不会补齐离线期间的变化。上游同源行为，详见 `roadmap.md` §5.1 |
| 多窗口实时同步依赖应用层长期订阅 | `pi-live-subscription.tsx` 显式保持连接；运行时仅在 running 时自动连接 |

---

## 4. 图例

- 迭代文档命名：`docs/iteration/<YYYY-MM>/<YYYY-MM-DD>-<category>-<name>.md`
- 分类：`feat` / `perf` / `bugfix` / `refactor` / `test`（定义见 `AGENTS.md`）
- ✅ = 已完成（代码 + 自动化检查 + 文档齐备）；桌面手工检查与发布验证不阻塞迭代完成
