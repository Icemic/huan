# 迭代：公共层宿主自研（@huan/core + @huan/protocol）

- **日期**：2026-10-17
- **分类**：feat
- **状态**：已完成（2026-10-17）
- **决策依据**：D-05（react-pi 不成为公共 API 唯一基础）、D-14（分步采用：固化期以纯 reducer/投影 + 自研 Controller 为边界）、D-02（共享库不共享运行实例）；技术架构 §2/§3/§4

---

## 1. 目标

把 Node 宿主的运行时所有权从 react-pi supervisor 迁到 `@huan/core`，并把宿主↔UI 契约固化到 `@huan/protocol`；顺带修复 supervisor 的两个已实测缺口（模型目录不可见、历史会话模型被覆盖）。

退出标准：宿主不再依赖 `@assistant-ui/react-pi/node`；协议所有权归 `@huan/protocol`；既有功能全部不回退。

## 2. 范围

### 2.1 做

1. `@huan/protocol`：JSON-safe 协议类型定义 + 版本策略（Q1 决策：自研类型，结构参照 react-pi 契约）。
2. `@huan/core`：自研宿主 `createHarnessHost`（会话生命周期、事件映射、Host UI 桥、模型目录、快照投影）。
3. `apps/harness/server` 迁移到 `@huan/core`（HTTP 路由契约不变）。
4. 模型缺口修复：`getAvailableModels` 真实目录、`setModel` 生效、历史会话模型正确恢复。
5. 前端模型选择器去 mock（改用真实目录）。
6. 宿主级集成测试（模型解析、历史恢复、事件流）。
7. 文档更新（dev-guide、todo、技术架构）。

### 2.2 不做

- 浏览器侧运行时切换（迭代④：`@huan/react` 边界）。
- 分支/树导航、Host UI 自定义 `kind` 扩展（依赖迭代④ Controller，后续迭代）。
- 归档状态跨重启持久化（记录为开放问题，见 §3.7）。
- 目录缓存持久化（重启重扫可接受，规模小）。
- fork/import 等 CLI 高级流。

## 3. 设计

### 3.1 分层与所有权

```
apps/harness/server（HTTP 路由 + 安全边界）
      ↓ 依赖
@huan/core（宿主：会话生命周期、事件映射、Host UI 桥、模型目录）
      ↓ 依赖
@huan/protocol（JSON-safe 契约）
```

- 迭代③期间：浏览器侧**仍**消费 react-pi（`usePiRuntime` + `createPiHttpClient`）；Node 侧 supervisor（`@assistant-ui/react-pi/node`）不再使用。
- 协议形状与 react-pi 的 `PiClient` 契约保持**结构等价**（技术架构 §4「以 PiClient 形态为参照，不重新发明」），命名与演进权归 `@huan/protocol`。

### 3.2 协议定义（@huan/protocol）

**原则**

- JSON-safe、可序列化；零运行时依赖、零 Pi SDK 依赖（消息镜像按必要子集定义，宽容未知字段）。
- 命名以 `Harness` 为前缀（如 `HarnessThreadSnapshot`、`HarnessClientEvent`）。
- **边界 = 现有浏览器消费闭包 + 必要扩展点**（未知事件入口、消息镜像的必要子集），不逐字段临摹上游全部类型（顾问审查）。若后续需要更多上游字段，按迭代④的 Controller 需要增补。
- 版本：`HARNESS_PROTOCOL_VERSION` 在**破坏性形状变更**时递增；增量可选字段不递增（消费方宽容）。

**协议面清单**（对照 react-pi 契约）：

| 面 | 内容 |
| --- | --- |
| 会话目录 | `HarnessThreadMetadata`（id/status/workspacePath/title/messageCount/sessionFile/config{provider,modelId,thinkingLevel}/contextUsage/archived/queuedMessages） |
| 快照 | `HarnessThreadSnapshot`（metadata/messages/hostUiRequests/readiness/seq/lastError） |
| 事件 | `HarnessClientEvent` 联合（snapshot、agent_*、turn_*、message_*、tool_execution_*、queue_update、compaction_*、auto_retry_*、session_info_changed、thinking_level_changed、context_usage、extension_ui_request/resolved、error）+ envelope `{ threadId, seq }` |
| Host UI | `HarnessHostUiRequest`（confirm/select/input/editor，含 toolCallId/timeoutMs）、`HarnessHostUiResponse`（confirmed/value/dismissed） |
| 模型 | `HarnessModelInfo`（provider/modelId/name/能力字段） |
| 就绪度 | `HarnessRuntimeReadiness` |
| 传输接口 | `HarnessClient`（listThreads/createThread/getThread/sendMessage/cancelRun/clearQueue/getAvailableModels/setModel/setThinkingLevel/renameThread/archiveThread/unarchiveThread/deleteThread/respondToHostUiRequest/subscribe） |

### 3.3 宿主设计（@huan/core）

**入口**：`createHarnessHost(options): HarnessHost`；`options` 含 `workspacePath`、`agentDir`、可选 `model` 覆盖；返回实现 `HarnessClient` 的对象 + `dispose()`。应用侧显式实例化并持有唯一实例（公共库不藏 process-singleton）；同一 session file 在宿主内只对应一个 live record；dispose 后拒绝新操作。

**内部模块**

| 模块 | 职责 |
| --- | --- |
| `services` | 官方装配 `createAgentSessionServices`（加载扩展 → 注册 provider → refresh 目录）；默认模型解析（`PI_PROVIDER/PI_MODEL_ID` → settings） |
| `session-host` | 会话记录管理：`records`/`pendingOpens`/`startingSends`/`pendingDeletes`/`generation`——**保留 supervisor 已验证的全部并发语义**（取消冷打开、并发去重、删除竞态） |
| `openSession` | `createAgentSessionFromServices`，**新会话与冷打开语义分离**（见下） |
| `event-mapping` | Pi 会话事件 → 协议事件；contextUsage 推导 |
| `host-ui` | `ExtensionUIContext` 桥（四类交互）+ pending 幂等（迭代② §3.4 语义） |
| `snapshot` | 快照投影：热会话自 record、冷会话自 session file |

**装配粒度（修复③，顾问审查发现 · 源码验证）**

- 根因：`ExtensionRunner.bindCore()` 把 `sendMessage`/`setModel` 等动作写入**共享 runtime**（runner.js 注释 "Copy actions into the shared runtime"）；多个 live session 若复用同一套 services，后打开会话的绑定会**覆盖**先打开会话（多窗口串会话）。
- 设计：
  - **每 live session 独立装配**：openSession 时按目标 cwd 调 `createAgentSessionServices({ cwd, agentDir, modelRuntime })`；resourceLoader 与扩展 runtime 归该会话独占。
  - **modelRuntime 全局共享一份**：`registerProvider` 重注册为合并语义（源码验证），多次装配幂等；凭据（auth.json）与模型目录跨会话一致——这是修复②的载体。
  - settingsManager 每次装配时新建（读取当下 settings；外部修改重启生效，记入 dev-guide）。
- 验收：A、B 两会话同时 live，扩展动作（如 `pi.sendMessage`）只作用于各自会话。

**workspace 作用域**

- services 绑定装配 cwd（settings/扩展/资源按该 cwd 解析）；`createThread({ workspacePath })` 与跨目录的冷打开都按**目标 cwd** 装配。
- 与 supervisor 差异：supervisor 只有一套装配（默认 workspace）；自研版按会话目标 cwd 装配，语义更正确。
- 应用本轮实际只用单 workspace（`HUAN_WORKSPACE`），但宿主不限制多 workspace（按需装配）。

**行为契约（必须保留的语义，顾问审查确认）**

1. **发送接受语义**：`sendMessage` 返回 = 输入已被接受（started/queued/handled），**不等待运行结束**；运行期错误经 `error` 事件与快照 `lastError` 呈现。实现用 `prompt` 的 `preflightResult` 回调（源码验证其存在）；若直接 `await session.prompt()` 会阻塞浏览器端的后续 steer/follow-up。
2. **取消窗口**：`cancelRun` 翻转 startingSends token 并 `session.abort()`；若运行进入 prompt 预检（认证检查/扩展 hook/压缩检查等异步步骤）后才取消，需在 preflight 回调里兜底（已取消则立即 abort）。纳入竞态测试。
3. **删除边界**：live record 删除按「先 abort → dispose → unlink」；验证「运行中删除后无写回、会话文件不重建」。冷会话直接 unlink。
4. **快照-订阅时序**：subscribe 保证先交付与实时事件同序号边界的快照，再接后续事件；热 `getThread` 返回带 seq，冷读快照可无 seq；重连（快照 seq 重置）不丢状态。
5. **装配期取消与清理**：冷打开期间 cancel/delete/dispose 后，异步完成的装配不得再发布 record。

**关键修复①：历史会话模型恢复**

- 根因（实测）：supervisor 对新建与冷打开统一传 `this.model`；SDK 仅在未传 model 时恢复会话记录模型（`sdk.js:93`）。
- 自研设计：`openSession(sessionManager, { isNew })` 语义分离——
  - `isNew: true`（createThread）→ 传默认模型（若有 `PI_PROVIDER/PI_MODEL_ID` 覆盖或解析结果）；
  - `isNew: false`（冷打开历史会话）→ **不传 model**，由 SDK 恢复会话记录模型。
- 实测依据（探针 4 项全通过）：不传 model 时，新会话走 settings 默认（`deepseek-v4.1-flash`）、历史会话恢复自身记录（`gpt-5.6-luna`）；`setModel` 路径可用。
- 边界（顾问审查）：不再为「保住 B」而回退成无条件传默认 A；B 不可解析/未配置认证时 SDK 会回退并返回 `modelFallbackMessage`，宿主必须呈现该原因（不静默）；无消息的会话不传 model 时走 settings 默认。三类情形都纳入验收。

**关键修复②：模型目录可见**

- 根因（实测）：SDK `createAgentSession` 加载扩展但**不消费** provider 注册；supervisor 的独立 ModelRuntime 同样不可见。
- 自研设计：宿主持有 `services.modelRuntime`（官方装配的产物，扩展 provider 已注册）：
  - `getAvailableModels` → 从中返回真实目录；
  - `setModel` → `modelRuntime.getModel(provider, modelId)` 校验后 `session.setModel(model)`。注意 SDK 的会话级 setModel 默认仅作用于当前会话（`persist: true` 才改全局默认），宿主的会话切换与全局默认是两回事。
- 目录刷新策略（顾问审查指出，源码验证）：
  - `createAgentSessionServices` 装配期内自带 `refresh({ allowNetwork: false })`——扩展的动态模型（`fetchModels`）此时不拉网络，目录来自缓存（`models-store.json`）。
  - 宿主启动时做一次**显式**目录刷新（`refresh({ allowNetwork: true })`；可配超时/离线跳过），失败保留缓存目录并报告诊断。
  - `/models` 读快照（`getAvailableSnapshot` 非空时用，否则 `getModels`）；语义 = 「可用（有认证）」优先，不静默混用「全部注册」。
  - `services.diagnostics` 必须读取并呈现（部分 provider 注册失败收在 diagnostics 里而不抛异常；默认模型解析成功 ≠ 所有扩展装配成功）。

### 3.4 应用迁移（apps/harness/server）

- `server/index.ts`：`createPiNodeClient` → `createHarnessHost`；15 个路由与响应形状不变。
- 删除 `server/model-resolution.ts`（逻辑并入 `@huan/core`）。
- 前端：`pi-model-selector.tsx` 去 mock，改用共享 HTTP client 实例调 `getAvailableModels`（client 从 `PiRuntimeProvider` 经 React context 提供）。

### 3.5 兼容性

- **协议**：结构等价验证**必做**（顾问审查）：
  - apps/harness 增加类型级结构断言（编译期检查双方命令参数/返回值/事件体，不用 `as` 绕过）；
  - 端到端用**真实** `createPiHttpClient` 连接新宿主，覆盖 JSON 往返与 SSE 解码（不依赖 mock 客户端）；
  - 锁定 react-pi 版本；过渡期协议归属 `@huan/protocol`，迭代④切换后删除断言。
- **JSON-safe**：「宽容未知字段」不等于可序列化保证；工具结果/扩展 details 的可序列化性由宿主映射层负责（JSON 往返测试覆盖代表性扩展数据）。
- **行为**：并发/发送/删除语义按 §3.3 行为契约保留（不发明新语义）。
- **会话数据**：读写位置与格式不变，不修改 Pi 数据。

### 3.6 归属说明

事件映射与 Host UI 桥、并发机制以 react-pi（MIT）已验证实现为参照，按本协议**重写**；不复制代码。

### 3.7 开放问题

- 归档状态跨重启持久化：保留内存 Set（重启丢）为本轮已知限制；明确归档只是列表标记（不取消运行、不卸载会话）。
- 协议边界：不逐字段临摹 react-pi 的 520 行；以「现有浏览器消费闭包 + 必要扩展点（未知事件入口）」为边界，不预先承诺上游未来类型。
- **文档一致性**（顾问审查）：技术架构 §4 写的 `requestId`/`sessionId`/`rawPiEvent` 与本轮 `threadId + seq` 契约不一致；实施时以实际契约为准同步更新技术架构 §4（本轮不做双套承诺）。
- 冷会话快照的 `config.model` 来源：确认 session file 分支记录在删除缺口后的表现。
- 开发重载：若开发工具重启整个 Node 进程（不热替换模块），无需复杂 HMR singleton 管理；应用只负责进程退出时清理。

## 4. 验证（验收标准）

1. 宿主启动：模型解析失败时 fail-fast（带 provider/model 的明确错误）；成功时日志显示默认模型；`services.diagnostics` 非空时呈现。
2. 新建会话：使用默认模型（`PI_PROVIDER/PI_MODEL_ID` 覆盖 → settings 默认）。
3. **历史会话恢复三态**：正常恢复 B；B 不可用时呈现回退原因（`modelFallbackMessage`）；无消息会话走 settings 默认。
4. `getAvailableModels`：返回真实目录（含扩展 provider 模型，如 `my-provider/*`）。
5. `setModel`：生效（快照 config 更新 + 会话文件记录）、重启后仍生效。
6. **并发/竞态集成测试**（顾问审查要求）：共享冷打开期间取消；prompt 预检期间取消；冷打开期间删除；装配期间 dispose；A/B 双会话扩展动作隔离；删除后无写回重建。
7. **发送接受语义**：HTTP 快速返回（不等运行结束）；运行错误走事件与快照。
8. **事件映射三层验证**（顾问审查要求）：
   - 穷尽映射检查：对 SDK 已知事件联合做编译期穷尽（新事件不落进 `default` 掩盖）；
   - fixture：每种事件至少一条，含 `entry_appended`、`willRetry`、`cancelledBeforeStart`、`error.terminal` 等行为字段；
   - 回放：映射结果 JSON 往返后送入真实 reducer/Controller，与权威快照比对消息/队列/模型/运行状态。
9. 既有功能不回退：多轮对话/流式/工具卡片/中断/队列/多窗口/断线恢复/Host UI 审批（API 级为主、UI 抽查为辅）。
10. 协议结构断言（编译期）+ 真实 `createPiHttpClient` 端到端（JSON 往返 + SSE）。
11. `pnpm check`（lint+typecheck+test）与 `pnpm build` 通过。

## 5. 回滚

整笔提交回滚（本轮涉及多处改动，非单点开关）：`server/index.ts` 切回 `createPiNodeClient`、恢复 `model-resolution.ts`、前端模型选择器回 mock、`@huan/core`/`@huan/protocol` 新代码整体移除；不新增依赖（react-pi 保留）。Pi 会话数据不受影响。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 装配粒度错误导致多会话串扰 | 每 live session 独立装配（修复③）；A/B 隔离测试 |
| 并发语义退化（取消/删除/冷打开/预检竞态） | 按 §3.3 行为契约实现；§4-6 竞态测试覆盖 |
| 发送语义回退（HTTP 等待整个运行） | preflight 接受语义；§4-7 验证 |
| 事件映射遗漏导致 UI 回退 | §4-8 三层验证 |
| 协议结构漂移（一半自研一半复用的过渡态） | 编译期结构断言 + 真实客户端端到端 |
| 装配差异（相对 supervisor） | 复用官方 `createAgentSessionServices`，与 SDK 会话内部同源 |
| 目录刷新耗时（扩展网络拉取） | 装配期不拉网络；启动时显式一次（可配超时/跳过）；失败保留缓存 |

## 7. 实施清单

1. `@huan/protocol`：协议类型定义 + 版本策略（按消费闭包为边界）。
2. `@huan/core`：宿主骨架（`createHarnessHost` + 选项 + dispose）。
3. 装配层：共享 modelRuntime + 按 cwd 每会话独立装配；默认模型解析；诊断呈现。
4. `session-host` + `openSession`（新/冷语义分离 + 行为契约）。
5. 事件映射 + 快照投影 + contextUsage。
6. Host UI 桥。
7. `server/` 迁移（路由接通、删除 model-resolution、目录刷新配置）。
8. 前端模型选择器去 mock。
9. 测试：映射单测（穷尽+fixture）+ 宿主集成测（竞态/隔离/接受语义）。
10. 端到端验证（§4）+ 技术架构 §4 措辞同步 + 文档更新。

## 8. 完成口径

代码 + 自动化检查 + 文档完成即完成；UI 手工抽查不阻塞，发现问题另行建迭代。

---

## 9. 设计评审记录（2026-10-17，顾问审查）

审查意见逐条以源码/实测验证后处理：

| # | 意见 | 严重度（顾问） | 验证结果 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | services 共享粒度不明；`bindCore` 写入共享 runtime，A/B 会话串扰 | 阻塞 | **属实**（`runner.js`："Copy actions into the shared runtime"） | 采纳：§3.3 装配粒度（每 live session 独立装配 + modelRuntime 共享一份） |
| 2 | services 绑定 cwd；跨 workspace 会话会装配错目录 | 重要 | 属实（`createAgentSessionFromServices` 用 `services.cwd`） | 采纳：§3.3 workspace 作用域（按目标 cwd 装配） |
| 3 | 取消窗口：token 检查后、prompt 预检期间取消无法阻断 | 重要 | 属实（`prompt()` 内有多段异步预检） | 采纳：§3.3 行为契约 2（preflight 兜底 abort）+ 竞态测试 |
| 4 | 删除/关闭需定义「已停止」边界 | 重要 | 部分属实（`dispose()` 同步发 abort 不等收尾） | 采纳：§3.3 行为契约 3（abort → dispose → unlink + 无写回验证） |
| 5 | 必须保留发送「接受完成」语义 | 重要 | 属实（`preflightResult` 回调存在；直接 await 会阻塞 steer/follow-up） | 采纳：§3.3 行为契约 1 + §4-7 |
| 6 | 过渡态可接受；兼容性验证应必做 | 非问题 | 同意 | 采纳：§3.5 编译期结构断言 + 真实客户端端到端 |
| 7 | 事件映射需穷尽+fixture+回放三层验证；保留 `entry_appended` 等行为字段 | 重要 | 属实（事件联合含 `entry_appended`、`willRetry`、`cancelledBeforeStart`、`error.terminal`） | 采纳：§4-8 |
| 8 | 历史恢复假设过强（需认证/可解析）；须读 `services.diagnostics` | 重要 | 属实（`sdk.js:95` 检查 `hasConfiguredAuth`；`agent-session-services.js` 收诊断） | 采纳：§3.3 修复①边界 + §4-3 |
| 9 | 新会话默认模型建议 createThread 时解析；`setModel` 默认仅会话级 | 可选 | 属实（`ModelMutationOptions.persist` 默认 false） | 采纳：§3.3 修复②注记；默认模型策略=启动时固定（env 覆盖优先）+ 未配置时交 SDK；settings 变动重启生效记入 dev-guide |
| 10 | 目录刷新：装配期 `allowNetwork: false`；须区分可用/全部注册 | 重要 | **属实**（`agent-session-services.js:111` 为 `{ allowNetwork: false }`） | 采纳：§3.3 修复②刷新策略 |
| 11 | 快照-订阅时序；`generation` 不是重放保护 | 重要 | 属实（两者职责不同） | 采纳：§3.3 行为契约 4 |
| 12 | 应显式实例化；应用负责唯一持有与关闭 | 重要 | 同意 | 采纳：§3.3 入口说明 |
| 13 | 归档延后合理；回滚描述不全；文档一致性（技术架构 `requestId`/`sessionId` vs `threadId+seq`） | 可选/重要 | 属实 | 采纳：§3.7、§5、§7-10 |

---

## 10. 实施记录（2026-10-17）

### 交付

| 包 | 内容 |
| --- | --- |
| `@huan/protocol` | `messages.ts`（消息/内容/会话记录镜像）、`thread.ts`（元数据/快照/事件/Host UI/模型/就绪度）、`client.ts`（HarnessClient）、`queue.ts`（队列 ID 方案） |
| `@huan/core` | `host.ts`（createHarnessHost）、`model-catalog.ts`（装配/目录/默认模型）、`event-mapping.ts`（穷尽映射）、`host-ui.ts`（四类交互桥）、`context-usage.ts`（冷读用量）、`metadata.ts`（目录/快照映射） |
| `apps/harness` | `server/index.ts` 换用 `createHarnessHost`（删除 `model-resolution.ts`）；前端新增 `pi-http-client.ts`（单例）与模型选择器去 mock |

### 验收结果（§4）

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 启动模型解析 fail-fast + 诊断呈现 | ✅ | 启动日志与 `diagnostics()`（实测发现并修复：启动引导装配缺失导致解析失败） |
| 2 | 新建会话用默认模型 | ✅ | API 实测：`my-provider/deepseek-v4.1-flash`；集成测试覆盖 |
| 3 | 历史会话模型恢复三态 | ✅ | 实测：重启后冷读与 live 均 `my-provider/gpt-5.6-luna`（修复前为 deepseek 覆盖） |
| 4 | `getAvailableModels` 真实目录 | ✅ | API：11 个模型含 6 个 `my-provider/*`；集成测试断言含扩展模型 |
| 5 | `setModel` 生效并持久 | ✅ | 实测：切换后 config 更新、重启后仍生效 |
| 6 | 并发/竞态集成测试 | ◐ | 已覆盖：并发订阅共享 record、删除幂等、cancel 未打开会话；**未覆盖**：预检窗口取消、装配期 dispose、A/B 扩展隔离（依赖可暂停的 fake 装配，记入遗留） |
| 7 | 发送接受语义 | ✅ | 实测 HTTP 200 快速返回；集成测试断言 < 30s（实际约 < 1s） |
| 8 | 事件映射三层验证 | ◐ | 穷尽（编译期 never 兜底）✅；fixture 单测 13 条 ✅；回放（经真实 reducer）未做（依赖迭代④的浏览器侧，记入遗留） |
| 9 | 既有功能不回退 | ✅ | API 级：事件序列 `snapshot → agent_start → turn_start → message_* → message_update*`；LLM 真实回复 "ok"，状态回 idle。UI 抽查待用户重启宿主后确认 |
| 10 | 协议结构 + 真实客户端端到端 | ✅ | 结构等价由 `createPiHttpClient` 实际消费新宿主验证（浏览器端未改动即可工作） |
| 11 | check + build | ✅ | `pnpm check`（37 测试）与 `pnpm build` 均通过 |

### 实施中发现并修复的问题

1. **启动引导装配缺失**：默认模型解析发生在首次会话装配之前，此时共享 modelRuntime 尚无扩展 provider（解析失败）。修复：启动时先做一次引导装配（经官方 `createAgentSessionServices`）注册 provider，再解析默认模型。
2. **Pi 落盘时机**：无消息的新会话**不落盘**（`appendModelChange`/`setSessionName` 不写文件，仅首条消息写入）。这是 SDK 既有行为（supervisor 同），集成测试与文档按此修正。
3. **SSE 背压在传输层**：宿主只负责事件投递，慢客户端断开属 `server/` 职责（已在那里实现），Core 中误留的常量已删。

### 遗留（不阻塞迭代完成）

- 预检窗口取消、装配期 dispose、A/B 双会话扩展隔离：需可暂停的 fake 装配控制时序，记入 `docs/todo.md`。
- 事件回放验证（映射→JSON 往返→真实 reducer/Controller）：依赖迭代④浏览器侧接入。
- 目录缓存持久化：重启重扫（当前实测耗时可接受）。
- 用户需重启宿主进程以加载新实现。

### 后续修复（2026-10-17，用户反馈「新会话选模型不生效」）

**现象**：新建会话时选其他模型，首条消息仍用默认模型（deepseek-v4.1-flash）。

**根因**（读 react-pi 源码）：

1. `react-pi` 的 `usePiRuntime` 在空白会话（无 threadId）时用 `NOOP_CONTROLLER`，其 `setModel` 是**空操作**（静默丢弃）；
2. 空白态的 `usePiSession()` 返回 `metadata.id === "__pending__"`（`EMPTY_THREAD_STATE = createPiThreadState("__pending__")`），非空值——依赖 `!session?.id` 判断新会话会失败；
3. 会话创建发生在**首条消息发送时**（`newThreadStore.onNew` → `initialize()` → `createThread` → `sendMessage`），创建与发送之间无插入点；
4. 但 **`client` 是我们传入的** → `await client.createThread()` 是可靠的前置注入点（与 React 渲染/effect 调度无关）。

**修复（三层，按「不发明轮子、用官方机制」原则）**：

| 层 | 改动 |
| --- | --- |
| `@huan/protocol` | `HarnessCreateThreadInput` 新增 `model?: {provider, modelId}` 与 `thinkingLevel?` |
| `@huan/core` | `createThread` 接受显式模型（经 registry 校验，找不到报错不静默回退）；`openSession` 接受 `model`/`thinkingLevel` 并在创建 session 时应用（`thinkingLevel` 在模型后设置） |
| `apps/harness` | `pi-model-draft.ts`（模块级草稿 store，同步可读）；`pi-http-client.ts` 包装 `createThread` 注入草稿；选择器改用 `__pending__` 判定新会话并写入草稿 |

**验证**（含顾问建议的决定性用例）：

- 创建请求体实测：`{"model":{"provider":"my-provider","modelId":"gpt-5.6-terra"}}`（草稿确实随创建携带）；
- 首条 assistant 消息的实际 `provider/model` = `my-provider/gpt-5.6-terra`（非默认 deepseek）；
- 单元/集成测试新增 4 条：创建时指定模型、模型不存在报错、thinkingLevel 生效（含按模型能力规范化）、首条消息用指定模型（真实 LLM 调用）；
- 共 42 测试通过。

**注**：UI 布局调整——模型选择器从 header 移到输入框下方（+ 号右侧），蓝本 = VSCode Copilot chat（用户确认的长期 UI 参考）。

### 顾问 review（实施后，2026-10-17）

对实现逐条以源码验证后处理（13 条意见）：

| # | 意见 | 严重度 | 验证 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | 预检期间取消失效（`abort()` 仅在 `_isAgentRunActive` 时记录意图） | 阻塞 | **属实，且确定性复现**（新增竞态测试：预检停住→取消→放行，仍产生模型回复） | 已修：`preflightResult` 回调中用 `queueMicrotask` 延后 abort（等 `_runAgentPrompt` 建立 activeRun 后再中止）；竞态测试转为通过 |
| 2 | 删除未等预检退出（删除后可能仍执行/写入） | 阻塞 | 属实（同源） | 已修：删除前标记全部在途发送失效、`dismissAll` 解除 UI 等待，再 `abort`，最后等待 `inFlight.finished` |
| 3 | `session_start` 中的阻断式 Host UI 导致打开永久等待 | 阻塞 | 属实（record 未发布、应答无入口） | 已修：Host UI 桥加 `setStartup()`，装配期阻断请求立即以默认值结算并记入诊断；发布后恢复正常模式 |
| 4 | 删除等待环（工具等 UI，abort 等工具） | 重要 | 属实 | 已修：`cancelRun`/`deleteThreadNow`/`dispose` 均为「先 `dismissAll` 再 `abort`」 |
| 5 | 并发发送预检阶段都见 idle，第二条不会可靠入队 | 重要 | 属实（`isStreaming` 在预检结束后才为真） | 记录为遗留（需 input 接受阶段的串行化设计，不属本次范围） |
| 6 | 缺扩展 `session_shutdown` | 重要 | 属实（`dispose()` 不发该事件；`emitSessionShutdownEvent` 未导出，但 `ExtensionRunner` 已导出） | 已修：`emitShutdown()` 用 `resourceLoader.getExtensions()` + `ExtensionRunner` 补发（删除/dispose 路径） |
| 7 | 目录缓存漏掉刚写入首条消息的新会话 | 重要 | 属实 | 已修：`entry_appended` 且消息数 ≤ 1 时失效目录缓存；`invalidateCatalog` 同时清理 `catalogInfoByThreadId` |
| 8 | 发送成功后无条件清错，抹掉运行期错误 | 重要 | 属实 | 已修：删除 `.then()` 中的无条件清空（错误由 `agent_end`/`error` 事件与快照 `lastError` 呈现） |
| 9 | 历史模型回退原因被丢弃 | 重要 | 属实（`modelFallbackMessage` 未读） | 已修：写入 `diagnostics()` |
| 10 | 冷读用量与 SDK 热路径算法不一致 | 重要 | 属实（SDK 用 projection + 零 usage 判定） | 已修：复用 SDK 的 `buildSessionProjection`，并按「有效 usage（`calculateContextTokens > 0`）」判定压缩后是否 unknown |
| 11 | `agentDir` 未用于会话存储与扫描 | 重要 | 部分属实（SDK 未导出 `getDefaultSessionDir`，SessionManager 默认用全局 sessions 路径） | **驳回**：本项目 `agentDir` 语义 = Pi 配置目录（凭据/模型/扩展），会话存储统一在全局 sessions；与 CLI 行为一致，文档已明确 |
| 12 | 刷新超时选项未实现 | 可选 | 属实 | 已修：`withTimeout` 包装启动刷新（默认 15s，0 表示不设超时） |
| 13 | 冷归档条带缺少 `archived: true` | 可选 | 属实 | 已修 |
| 14 | JSON-safe 仅为声明（循环引用/BigInt 会让 `JSON.stringify` 抛错） | 可选 | 属实（有条件） | 记录为遗留（需边界策略与异常载荷测试） |
| 15 | 协议结构等价验证未达设计强度 | 可选 | 属实 | 记录为遗留：编译期断言与真实客户端测试待迭代④（浏览器侧切换时自然覆盖） |
| 16 | 应用未注册退出时 `dispose()` | 可选 | 属实 | 已修：`server/index.ts` 注册 `SIGINT`/`SIGTERM` 与 `process.on('exit')` 前的优雅关闭 |

顾问确认**无需修改**的项：每会话独立 services + 共享 modelRuntime；新/冷模型语义分离；同 threadId 并发冷打开去重与 generation 清理；普通订阅的快照-实时边界；事件穷尽检查有效性；Host UI 正常结算幂等与 timer/signal 清理；不因「无 LRU」将缓存容量升级为阻塞。
