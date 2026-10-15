# 迭代：最小闭环应用（Pi 会话跑通）

- **日期**：2026-10-15
- **分类**：feat
- **状态**：待开始（依赖迭代：monorepo 骨架与包边界）
- **决策依据**：D-11（先骨架后闭环）、D-12（宿主暂不锁定）、D-14（react-pi 分步采用）、D-15（首版仅会话列表）、D-19（Host UI）、D-26；技术架构 §3、§4；草案 §11 P0 通过标准

---

## 1. 目标

在 `apps/harness` 内跑通「Agent 经 Pi SDK 稳定运行 + 浏览器渲染与交互」的最小纵向闭环。

验收对标：草案 P0 通过标准（连续多轮对话与工具调用、中止后状态正确、切换会话不串消息、自定义工具显示进度与结果、断线重连可从快照恢复）+ 多窗口并发要求（技术架构 §4.1）。

## 2. 范围

### 2.1 做

1. **Node 宿主服务**（`apps/harness/server/`）：`createPiNodeClient` + HTTP 路由 + SSE；官方 route 契约移植（见 §3.2）。
2. **浏览器接入**：`createPiHttpClient` + `usePiRuntime` + assistant-ui `Thread` 主题组件（CLI 引入）。
3. **会话列表**：新建、打开、重命名、归档/取消归档、删除（D-15，react-pi 现成回环）。
4. **模型与 Thinking 切换**：`usePiRuntimeExtras` 驱动。
5. **Host UI 四类对话框**：工具关联（审批控件渲染在工具卡片内）+ 独立请求侧通道（复用 react-pi 已实现映射，D-19）。
6. **中断与队列**：Cancel、Steer / Follow-up、队列展示与整体清空。
7. **多窗口支持**：打开的会话采用长期订阅；验证扇出、断开不中止、Host UI 并发响应幂等。
8. **应用状态**：Zustand 接入（窗口本地 UI 状态：当前会话选择等，D-24）。
9. **i18n**：聊天区新增文案走 Lingui。

### 2.2 不做

- 会话分支 / 树导航（D-15）。
- 文件树 / Monaco / Checkpoint 审查（M2）。
- 桌面壳与打包（D-12）。
- 公共层固化（D-14 阶段 2，闭环验收通过后再做）。
- 编辑器工具（M4）。

## 3. 设计

### 3.1 进程与端口

```
浏览器 (Vite dev, 5173)
   │  fetch / SSE
   ▼  /api/pi/**（Vite server.proxy 转发）
Node 宿主进程 (8788)：@huan/core 之上，装配 createPiNodeClient
   │
   ▼
Pi SDK（AgentSession / SessionManager）
```

- 宿主端口默认 8788，可配；前端经 Vite 代理访问，避免开发期 CORS 处理。
- SSE 经代理验证逐字流式（若发现缓冲，调整代理配置并记录 dev-guide）。
- 生产形态不锁定（D-12）；宿主与本迭代只依赖「标准 Node HTTP 服务」这一形态。

### 3.2 宿主路由（移植 react-pi 官方契约）

```
GET    /api/pi/threads                 → PiThreadMetadata[]
POST   /api/pi/threads                 → PiThreadSnapshot（body: create input）
GET    /api/pi/threads/:id             → PiThreadSnapshot（只读快照）
PATCH  /api/pi/threads/:id             → 204（body: { title }）
POST   /api/pi/threads/:id/messages    → 204（body: { input }）
POST   /api/pi/threads/:id/cancel      → 204
GET    /api/pi/models                  → PiModelInfo[]
POST   /api/pi/threads/:id/model       → 204（body: { provider, modelId }）
POST   /api/pi/threads/:id/thinking    → 204（body: { level }）
POST   /api/pi/threads/:id/archive     → 204
POST   /api/pi/threads/:id/unarchive   → 204
DELETE /api/pi/threads/:id             → 204
POST   /api/pi/threads/:id/host-ui     → 204（body: { response }）
GET    /api/pi/threads/:id/events      → SSE of PiClientEvent
```

- HTTP 框架：Hono（轻量、TS 类型好、SSE 成熟）；若遇依赖或运行时问题可退化为 `node:http` 手写（契约不变）。
- 实现语义：SSE 断开时 unsubscribe 但**不 abort**；事件逐条透传（含 `seq`）；`host-ui` 响应转发至 bridge。

### 3.3 前端接入

- `PiRuntimeProvider`：`createPiHttpClient({ baseUrl: '/api/pi' })` + `usePiRuntime`。
- assistant-ui 主题组件（`components/assistant-ui/`）；自定义 Tool 回退卡片验证（含 Host UI 审批控件）。
- 会话列表：优先使用 assistant-ui / react-pi 现成组件（ThreadList 类）；缺什么补什么，不提前自建。
- 服务器状态与就绪度（`readiness`）：非 ready 时禁用输入并展示下一步提示文案。

### 3.4 多窗口语义（技术架构 §4.1 落地）

1. 打开的会话视图采用长期订阅（对 `controller.connect()` 的等效用法），消除「空闲会话不转直播」缺口。
2. 验证：窗口 A 发送，窗口 B 实时可见流式输出；关闭任一窗口不影响运行与另一窗口。
3. Host UI 重复响应（两窗口同时响应）：按幂等处理（先到生效）；验证 bridge 行为，不幂等则在客户端拦截。

### 3.5 配置与凭据

- 模型与凭据：复用 Pi 用户配置（`~/.pi`），已 `pi /login` 的用户无需额外配置；支持 `PI_PROVIDER` / `PI_MODEL_ID` 环境变量覆盖（记录于 dev-guide）。
- 工作目录：启动宿主时参数/环境变量指定（默认可在 dev-guide 固定为测试目录）；工作目录选择 UI 暂不做。

## 4. 兼容性与依赖

- 锁 react-pi 与 `@earendil-works/pi-coding-agent` 的 peer 版本组合，安装时验证；记录于 lockfile 与 dev-guide。
- Node >= 22.19；Windows/macOS 路径按 Node 语义处理。
- Pi 会话文件写入 Pi 默认位置（正常行为，不修改 Pi 内部历史结构）。

## 5. 验证（验收标准）

1. 多轮对话：连续 3+ 轮上下文正确。
2. 流式渲染：文本与 Reasoning 逐字更新；工具调用卡片显示进度与结果。
3. 工具运行真实生效（至少一个文件系统工具，如读取/写入测试目录文件）。
4. 中断：运行中点取消，状态回到正确（消息定格、可继续发送）。
5. 会话列表：新建 / 打开 / 重命名 / 归档 / 删除；切换会话不串消息。
6. 模型与 Thinking 切换生效，当前值显示正确。
7. 断线恢复：刷新页面后完整恢复当前会话快照；Host UI 待处理请求仍可见。
8. 多窗口：A 发 B 见流式输出；关闭 A 不影响 B 与运行；同时响应同一 Host UI 请求无异常。
9. Steer / Follow-up：运行中输入可排队（Enter=follow-up，Ctrl+Shift+Enter=steer），队列可整体清空并恢复到输入框。
10. 对照 Pi CLI 抽查：新建会话初始状态、中断后状态、会话命名行为与 CLI 一致。

## 6. 回滚

应用内新增功能；不改动 Pi 用户数据与配置结构。回滚 = revert 本迭代提交；Pi 会话文件不受影响。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| react-pi 与 Pi SDK 版本不兼容 | 安装时即验证；对照官方 with-pi 例子的行为基线 |
| SSE 经 Vite 代理缓冲导致非流式 | 优先验证逐字输出；必要时手动配置代理或前端直连宿主端口 |
| usePiRuntime 缺口（空闲会话不直播） | §3.4 长期订阅方案；若 API 不足则用 refresh + 订阅组合 |
| Host UI 并发响应非幂等 | 客户端层拦截重复响应 |
| Windows 终端/进程管理差异 | dev-guide 记录两平台启动方式（如 concurrently 或双终端） |

## 8. 实施清单

1. 宿主服务骨架（Hono + 路由表 + 静态配置）
2. `createPiNodeClient` 接入与 SSE 端点
3. 前端：PiRuntimeProvider + Thread 主题组件接入
4. 会话列表 UI（列表/新建/重命名/归档/删除）
5. 模型与 Thinking 切换 UI
6. Host UI：工具卡片审批控件 + 侧通道组件
7. 中断、Steer / Follow-up、队列展示
8. 多窗口长期订阅与幂等处理
9. Zustand 窗口本地状态接入
10. Lingui 文案接入
11. 全量验证（§5）与 dev-guide 更新

## 9. 完成口径

代码 + 自动化检查 + 文档完成后即标记完成。§5 中标注为「手工检查」性质的条目（多窗口、对照 CLI）按需记录结果，不阻塞迭代完成；发现问题另行建立迭代。
