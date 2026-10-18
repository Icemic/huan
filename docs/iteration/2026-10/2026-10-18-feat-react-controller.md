# 迭代：M2 公共层固化（@huan/react 自研 Controller）

- **日期**：2026-10-18
- **分类**：feat
- **状态**：实施中
- **决策依据**：roadmap §2；D-05（react-pi 不成为公共 API 唯一基础）、D-14（分步采用：固化期以纯 reducer/投影 + 自研 Controller 为边界）；技术架构 §3.3、§4、§6

---

## 0. 决策记录

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 1. reducer / 投影来源 | **移植 react-pi 实现**（MIT），改类型为 `@huan/protocol`，保留出处声明 | 回放测试已锁定 22 项行为；「以 PiClient 形态为参照，不重新发明」是本项目既定原则（技术架构 §4） |
| 2. assistant-ui 接入 | **`useExternalStoreRuntime` + 自研 Controller 实现 `PiThreadControllerLike` 契约** | 官方支持的外部状态接入方式；UI 组件层零改动；满足 D-05 |
| 3. Controller API 形态 | **对照 `PiThreadControllerLike` 契约，重命名到 Harness 命名空间** | 该形态由 `useSyncExternalStore` 的 snapshot 语义与 assistant-ui 消费需求共同决定，非 react-pi 任意选择 |
| 4. hook 形态 | **保持 react-pi 的 hook 集合结构**（`useHarnessRuntime` / `useHarnessThreadState` / `useHarnessSession` / `useHarnessExtras` / `useHarnessHostUiRequests`） | selector 粒度是性能关键（`Object.is` 比较 + 引用稳定性） |
| 5. 多窗口连接共享 | **先不做**（不做 `sharedStreamCache`） | 已调研：apps/harness 无同页多组件订阅同一会话的场景；出现重复连接问题再补 |
| 6. SSE 解码 | **保留 `assistant-stream` 依赖**（用其公共导出 `SSEEventDecoder`） | `./utils` 是 package.json 正式导出路径（非 internal）；`@assistant-ui/react` 本已依赖它；自研属重复发明（技术架构 §4） |
| 7. 测试套件移植范围 | **全量移植**（约 8600 行） | A 方案的核心红利：react-pi npm 包内含完整原始测试，直接复用锁定行为（现有回放测试仅覆盖 reducer 一层） |
| 8. 移植代码注释语言 | **正文注释译为中文**，文件头标注出处/许可/改动摘要 | AGENTS.md 硬规范「代码文件中的注释必须中文书写」；S1 的 vendor 层已按此执行 |

**注**：决策 1~8 均按推荐执行。决策 7/8 建立在「npm 包内含原始 TS 源码与完整测试」的发现之上（见 §3.4）。

---

## 1. 目标

把浏览器侧运行时所有权从 `react-pi` 迁到 `@huan/react`：公共层以「纯 reducer/投影 + 自研 Controller + 公共 hook」为边界；apps/harness 切换到自研实现，仍沿用 assistant-ui 的 UI 组件。

退出标准见 roadmap §2.2（含 SSE 传输链路验证）。

## 2. 范围

### 2.1 做

1. `@huan/react` 的 reducer / 消息投影 / Controller / 公共 hook；
2. HTTP/SSE 客户端（浏览器侧传输实现，消费 `@huan/protocol`）；
3. apps/harness 切换到自研运行时；
4. 多窗口语义正式化（空闲会话长期订阅纳入 Controller）；
5. SSE 传输链路验证（回放测试接入真实编解码）；
6. 前端类型从 react-pi 迁到 `@huan/protocol`。

### 2.2 不做

- 分支/树导航 UI（roadmap §6.3：Controller 的**预留评审**在本迭代做，完整 UI 属后续）；
- Checkpoint 关联（M3）、附件扩展、skills/extensions UI 呈现。

## 3. 现状调研（已核对源码）

### 3.1 apps/harness 对 react-pi 的使用面（迁移清单）

| 文件 | 使用 | 迁移后 |
| --- | --- | --- |
| `pi-runtime-provider.tsx` | `usePiRuntime({ client, adapters })` | `@huan/react` 的 `useHarnessRuntime` |
| `pi-http-client.ts` | `createPiHttpClient`（+ 插件式包装 `createThread` 注入模型草稿） | `@huan/react` 的 `createHarnessHttpClient` |
| `pi-live-subscription.tsx` | `usePiRuntimeExtras()` 取内部 `controller.connect()`（**hack**，靠类型断言） | Controller 的正式能力（`connect()`） |
| `pi-model-selector.tsx` | `usePiSession`、`usePiRuntimeExtras`、`PiThinkingLevel` | `@huan/react` 的 `useHarnessSession` / `useHarnessExtras` |
| `app.tsx` | `usePiThreadState((s) => s.readiness)` | `useHarnessThreadState` |
| `event-replay.test.ts` | `createPiThreadState` / `reducePiThreadState` | 自研 reducer（fixture 全复用） |
| `thread.aui.tsx` 等 11 个 UI 文件 | `@assistant-ui/react`（**保留**） | 不变 |

**结论**：UI 组件层（assistant-ui primitives）不受影响；需替换的是运行时层（5 个文件 + 1 个测试）。

### 3.2 react-pi 的规模与结构（移植参照）

| 模块 | 行数 | 说明 |
| --- | --- | --- |
| `runtime/ThreadController.js` | 731 | 核心：状态/订阅/连接/发送/乐观消息/重连 |
| `node/ThreadSupervisor.js` | 590 | **不需要**（Node 侧已由 `@huan/core` 承担） |
| `runtime/messageProjection.js` | 516 | 消息投影（`PiAgentMessage` → assistant-ui `ThreadMessageLike`） |
| `runtime/usePiRuntime.js` | 407 | 与 assistant-ui 的接线（external store） |
| `client/eventSource.js` | 244 | SSE 解码 |
| `client/sharedStreamCache.js` | 295 | 浏览器侧多组件共享单个 SSE 连接（多窗口/多视图） |
| `client/httpClient.js` | 140 | HTTP 客户端 |
| `runtime/threadState.js` | 270 | reducer（**已有回放测试覆盖**） |
| `client/validation.js` | 86 | 事件载荷校验 |
| `runtime/hostUi.js` | 98 | Host UI 请求分流与响应构造 |
| `runtime/hooks.js` | 26 | 公共 hook |
| **合计** | **~2900** | 其中 Node 侧 590 不需要；**实际需自研 ~2300 行** |

**许可证**：react-pi 为 **MIT**（已核对 `package.json` 与 `LICENSE`），与本项目 AGPL-3.0 兼容；可移植，需在文件头注明来源与许可。

### 3.3 移植素材（关键发现）

react-pi 的 npm 包**同时发布原始 TS 源码与完整测试套件**（`package.json` → `files: ["dist", "src", "README.md"]`）：

| 目录 | 内容 | 对移植的意义 |
| --- | --- | --- |
| `src/**/*.ts(x)` | 原始 TS 源码（含类型注解与 JSDoc，约 5300 行生产代码） | **直接复制移植**，无需从 dist 反推；类型注解完整保留 |
| `src/**/*.test.ts(x)` | 完整测试套件（约 8600 行，Vitest + jsdom + react-dom/client） | **整套复制**，行为锁定从「22 项回放测试」扩展到上游全套测试 |
| `dist/*.js.map` | 亦含 `sourcesContent`（原始 TS） | 兜底校验材料 |

这实质改变了移植性质：从「参照编译产物重写」变为「复制源码 + 测试，改类型命名空间」。

### 3.4 assistant-ui 依赖清单（逐文件核对）

react-pi 生产代码对 assistant-ui 的依赖分三类：

**一、需自研替代（`internal` 子路径 / deprecated 内部 API，共 11 个工具，实际逻辑约 250 行）**

| 工具 | 来源路径 | 实现规模 | 性质 |
| --- | --- | --- | --- |
| `isRecord` | `core/internal` → `utils/json/is-json.js` | 16 行 | 类型守卫 |
| `invokeUserCallback` | `core/internal` → `utils/invoke-user-callback.js` | 19 行 | 回调异常包装 |
| `isParsableUrl` / `parseDataUrl` | `core/internal` → `utils/data-url.js` | 64 行 | data URL 解析 |
| `detectImageMediaType` | `core/internal` → `utils/image-media-type.js` | 141 行 | 字节签名表（GIF/PNG/JPEG/WebP/AVIF/HEIC） |
| `resolveImageMediaType` | `core/internal` → `utils/wire-media.js` | 59 行 | 媒体类型决议链 |
| `RunLeases` | `core/internal` → `utils/run-lease.js` | 25 行 | generation fence（异步迟到防护） |
| `bytesToBase64` | `core/internal` → `adapters/attachment.js` | ~10 行 | Buffer/btoa 分块编码 |
| `useLatestRef` | `core/react/internal` | ~16 行 | `useInsertionEffect` 写 ref |
| `useReplaySafeEffect` | `store/internal` | ~25 行 | StrictMode/Refresh 下防 cleanup 抖动 |
| `createRuntimeExtras` | `core/react`（标注 `@deprecated Internal API`） | ~30 行 | brand symbol + `useAuiState` 选择器 |

注：`useLatestRef` / `useReplaySafeEffect` 上游内部依赖 `@assistant-ui/tap/react-shim`，移植改用 React 原生 API（语义等价）。

**脆弱性实证**：`RunLeases` 在 `@assistant-ui/core@0.3.21` 的整个 dist 中**不存在**（逐文件搜索为空），0.3.27 起才加入。本工作区 `.pnpm` 中同时存在 core 0.3.21 / 0.3.27 两个版本与 react-pi 三个副本（版本分裂由 `@assistant-ui/react@0.15.22` 与 `0.15.28` 并存引起）；当前能运行依赖解析运气。**一个补丁级版本漂移即可让 internal 导入崩溃**——这是切除 internal 依赖的直接依据。

**二、保留（正式 API，不违反 D-05）**

- `@assistant-ui/react`：`useExternalStoreRuntime` / `useRemoteThreadListRuntime` / `useAui` / `useAuiState` / `ExportedMessageRepository` / `MessageNotSentError` / `isMessageNotSentError` 及类型；
- `assistant-stream`：`SSEEventDecoder` / `SSEEventDecoderError`（`./utils` 为正式导出；见决策点 6）。

**三、删除（apps/harness 不使用）**

- cloud 分支：`useCloudThreadListAdapter`、`PI_SDK`（`sdkIdentity.ts`）、`AssistantCloud` 类型 → `@huan/react` 不需要 `assistant-cloud` 依赖；
- `node/` 全部（`ThreadSupervisor` / `mapping` / `extensionUi` / `contextUsage` / `client`）：Node 侧已由 `@huan/core` 自研实现；
- `sharedStreamCache.ts`（决策点 5）。

**测试的额外 internal 依赖**：`resolveToolApprovalResponse`（86 行）、`toMessagePartStatus`（54 行），随对应测试一起自研。

**外部依赖面**：生产代码仅 3 处外部依赖——`assistant-stream/utils`（保留）、`assistant-cloud`（删除）、`node:fs/promises`（node/ 内，删除）。

### 3.5 关键接口契约（自研需满足）

**Controller**（`PiThreadControllerLike`，供 `useExternalStoreRuntime` 消费）：

```
getState / getStateSnapshot / getProjectedMessages / getMessageRepository / getVersion
connect / subscribe / subscribeMetadata / subscribeMessages
load / refresh / sendMessage / cancel / clearQueue / setModel / setThinkingLevel
respondToToolApproval / resumeToolCall / respondToHostUiRequest / dispose
```

**注意**：`useSyncExternalStore` 的 snapshot 语义有严格要求（引用只在通知时变化，否则 React 无限循环）——`getStateSnapshot` 的存在正是为此。

**assistant-ui 接入**：`ExternalStoreAdapter`（`@assistant-ui/react`）提供 `onNew` / `onCancel` / `onReload` / `setMessages` / `isRunning` / `messages` / `queue` / `onAddToolResult` 等钩子；`useExternalStoreRuntime` 是其运行时入口。这是官方支持的外部状态接入方式（非 hack）。

## 4. 决策点分析

### 决策点 1：reducer 与投影的来源

✅ **已定：选项 A（移植 react-pi 实现）**

| 选项 | 说明 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 移植 react-pi 实现**（MIT） | 复制 `threadState.js`（270 行）+ `messageProjection.js`（516 行），改类型为 `@huan/protocol`，保留文件头归属声明 | 行为完全一致（已有回放测试锁定）；工作量小；风险低 | 需维护移植副本；上游改进不会自动流入 |
| B. 重写 | 依据协议与回放 fixture 重新实现 | 完全自主；可按需简化 | 工作量大（~800 行）；行为差异风险（回放测试会暴露，但修复成本高） |

**推荐 A**。理由：回放测试已经用 react-pi 的 reducer 锁定了行为（22 项 fixture），移植能保证一致；MIT 兼容；且「以 PiClient 形态为参照，不重新发明」是本项目既定原则（技术架构 §4）。重写属于重复发明。

### 决策点 2：assistant-ui 接入方式

| 选项 | 说明 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. `useExternalStoreRuntime` + 自研 Controller 实现 `PiThreadControllerLike`** | 与 react-pi 相同的方式，但 Controller 换成自研 | 官方支持的路径（已验证可用）；UI 层零改动 | 需完整实现 ControllerLike 的 20 个方法 |
| B. 继续用 react-pi 的 `usePiRuntime`，只替换 reducer | 最小改动 | 工作量最小 | **不满足 D-05**（usePiRuntime 仍在关键路径）；T 不符合固化目标 |
| C. 直接用 `ExternalStoreAdapter`，不实现 ControllerLike | 更贴近 assistant-ui 原生 | 少一层抽象 | 需自行处理 snapshot 语义与订阅分层；react-pi 的 ControllerLike 形态已被验证（§3.1 的 407 行 `usePiRuntime` 就是适配层） |

**推荐 A**。理由：`ThreadController` 与 `usePiRuntime` 的分层已被 react-pi 验证（Controller 管状态与 Pi 语义，hook 管 React 接线）；照此分层自研，既满足 D-05，又保留已验证的架构。

### 决策点 3：Controller 的 API 形态

| 选项 | 说明 |
| --- | --- |
| **A. 对照 `PiThreadControllerLike` 契约，重命名到 Harness 命名空间** | `HarnessThreadController`，方法名保持语义一致但用本项目术语（如 `sendMessage` 接收 `HarnessSendMessageInput`） |
| B. 完全重新设计 | 例如合并 `subscribe*` 为单一事件总线 |

**推荐 A**。理由：`PiThreadControllerLike` 的形态由 `useSyncExternalStore` 的 `getStateSnapshot` 语义与 assistant-ui 的消费需求共同决定，不是 react-pi 的任意选择；重新设计会重复踩坑（如引用稳定性）。

### 决策点 4：hook 形态

| 选项 | 说明 |
| --- | --- |
| **A. 对照 react-pi 的 hook 集合** | `useHarnessRuntime` / `useHarnessThreadState` / `useHarnessSession` / `useHarnessExtras` / `useHarnessHostUiRequests` |
| B. 单一 `useHarness()` 返回全部 | 更简单但会导致全量重渲染（selector 无法细分） |

**推荐 A**。理由：selector 粒度是性能关键（`usePiThreadState` 的注释明确说明 `Object.is` 比较与引用稳定性要求）；单一 hook 会强迫消费方全部订阅。

### 决策点 5：多窗口连接共享（`sharedStreamCache` 的处理）

✅ **已定：先不做（YAGNI）**

react-pi 有 295 行的 `sharedStreamCache`（浏览器侧多组件共享同一 SSE 连接）。

**已调研**：apps/harness 当前只有 `pi-live-subscription.tsx` 一处订阅连接，不存在同页多组件消费同一会话的场景（多窗口是不同页面，不共享内存）。

**结论**：不自研该模块；若未来出现重复连接问题（如多视图并排）再补。

## 5. 实施计划

按「先建包（不影响应用）→ 再切换应用」分阶段，每阶段可独立提交：

| 阶段 | 内容 | 素材（react-pi src） |
| --- | --- | --- |
| S1 | `@huan/react` 骨架 + 自研 internal 工具 + 单测 | —（自研） |
| S2 | reducer + 消息投影 + hostUi + validation | `runtime/threadState.ts`(442) + `runtime/messageProjection.ts`(916) + `runtime/hostUi.ts`(170) + `client/validation.ts`(313) |
| S3 | HTTP/SSE 客户端 | `client/httpClient.ts`(294) + `client/eventSource.ts`(435) |
| S4 | Controller | `runtime/ThreadController.ts`(1170) |
| S5 | hook + runtime 接线 | `runtime/usePiRuntime.ts`(679) + `hooks.ts`(55) + `runtimeTypes.ts`(73) + `piExtras.ts`(5) + `disposeControllers.ts`(21) |
| S6 | 测试套件移植（含 Controller 的 2342 行测试） | 全部 `.test.*` |
| S7 | apps/harness 切换（6 文件）+ 回放测试切换 | — |
| S8 | SSE 链路端到端验证 + 顾问审查 + 第三方许可声明 | — |
| S9 | 文档回写 + 提交 | — |

**命名迁移**：`Pi*` → `Harness*`；类型统一从 `@huan/protocol` 引入；文件头注明来源（`@assistant-ui/react-pi@0.0.29`，MIT 许可）与改动摘要。

**`@huan/react` 依赖集**：`@assistant-ui/react`（peer）+ `react`（peer）+ `assistant-stream` + `@huan/protocol`（workspace）。

**新增开发依赖**：`jsdom` + `react-dom` + `@types/react-dom`（4 个 `useHarnessRuntime` 测试需要 DOM 环境）。

---

## 5.1 实施记录（已完成）

### 交付物

`packages/react/src/` 成熟度为可直接消费的公共包：

| 目录 | 内容 |
| --- | --- |
| `vendor/` | 11 个上游 internal 工具的本地副本（anti-corruption layer）+ 其单测（34 项） |
| `runtime/` | reducer、消息投影、hostUi、Controller、runtime 接线、hook |
| `client/` | 载荷校验、SSE 解码与重连、HTTP 客户端 |
| 根 | `event-types.ts`、`queue-ids.ts`、`error-text.ts`、`index.ts`（公共导出） |

### 测试覆盖

**移植覆盖：上游可移植用例 259 项中覆盖 243 项（94%）**

| 上游测试文件 | 上游 | 我方 | 说明 |
| --- | --- | --- | --- |
| `ThreadController.test.ts` | 75+2 | 75+2 | 全量 |
| `threadState.test.ts` | 23+1 | 23+1 | 全量 |
| `messageProjection.test.ts` | 34+2 | 34+2 | 全量 |
| `eventSource.test.ts` | 33+5 | 33+5 | 全量 |
| `hostUi.test.ts` | 22 | 22 | 全量 |
| `usePiRuntime*.test.tsx` | 21 | 21 | 全量 |
| `httpClient.test.ts` | 49 | 33+6 | 缺 16 项（sharedStreamCache 语义，决策点 5 不做）；补 6 项自研订阅语义 |
| `disposeControllers.test.ts` | 1 | 1 | 全量 |
| `ThreadSupervisor` 等 `node/*` | 57 | — | 不需要（Node 侧由 `@huan/core` 承担） |
| `usePiRuntime.cloud.test.tsx` | 4 | — | cloud 分支已删 |
| `vendor/anti-corruption.test.ts` | — | 34 | 自研新增 |

**新增验证**：
- `apps/harness/server/sse-link.test.ts`（5 项）——SSE 链路端到端：宿主编码 → HTTP/SSE → 客户端解码 → reducer，覆盖快照优先、live-only 断流恢复、序号重置、同批快照与增量、畸形事件断流恢复。
- `packages/react/src/client/http-client.test.ts` 新增 6 项——解码器限制的终止错误、事件投递、每订阅独立连接、监听者错误隔离、unsubscribe 关闭连接。
- `apps/harness/src/event-replay.test.ts`（23 项）——切换到自研 reducer，fixture 全复用。

### 相对上游的语义改动（顾问已审查）

| 改动 | 结论 |
| --- | --- |
| `subscribe` 改为单订阅（不做 sharedStreamCache） | 顾问确认：缺少 `pendingEvents` 缓冲不会丢必要事件——该缓冲只服务于「缓存快照回放」这一上游特有场景，本实现无缓存回放，故不需要。上层 Controller 的 30 秒断开宽限期保留。 |
| 删除 Assistant Cloud 分支 | 范围内的明确裁剪 |
| `connect()` 提升为 extras 正式能力 | 正确（替代应用侧的类型断言 hack） |
| 内部 hook 重命名 + 文件级 lint 抑制 | 不改变运行语义 |
| 两处正则捕获组改为解构默认值 | 等价（匹配成功后捕获组必然存在） |
| 消息投影 8 处 `[]!` 改为显式 undefined 守卫 | 对协议合法数组等价 |

### 顾问提出的已知遗留（不在本迭代范围）

**`connect()` 的快照请求判定**：`connect()` 按 `loadState !== 'loaded'` 决定是否请求快照。若 Controller 已加载 → 所有消费者释放 → 30 秒后连接关闭 → 其他窗口期间完成对话 → 再 `connect()`，因仍是 `loaded`，新连接用 `snapshot=false`，**离线期间的历史不会补齐**。`snapshotRecoveryUrl` 只覆盖同一 connection 对象的重连，不覆盖「关闭后新建」。

此为**上游同源行为**（上游 Controller 相同，且上游 live-only 监听者加入共享流时同样不会自动获得缓存快照），非移植引入。应与「新建传输订阅是否始终请求快照」一起作为独立 bugfix 讨论（roadmap §6.1 记录）。

---

## 6. 验证方式

- 移植的上游测试套件通过（S2~S6 各阶段）；回放测试 23 项通过（切换 reducer 导入后）
- SSE 传输链路验证：`apps/harness/server/sse-link.test.ts`（5 项，宿主 → HTTP/SSE → 客户端 → reducer）
- `pnpm check` 全绿（87 文件 lint、6 包类型、**416 项测试**）
- 移植代码不残留 `@assistant-ui/core/internal`、`@assistant-ui/store/internal`、`@assistant-ui/core/react/internal` 导入
- roadmap §2.5 的手工抽查清单（桌面环境，不阻塞迭代完成）

## 7. 风险与回滚

| 风险 | 应对 |
| --- | --- |
| 移植代码的隐蔽行为差异 | 上游测试全量移植（243 项）+ SSE 端到端验证 |
| Controller 的 snapshot 引用稳定性踩坑 | 原样移植 `getStateSnapshot` 实现，未做优化 |
| 切换范围大导致中途不可用 | 分 9 阶段，每阶段 `pnpm check` 全绿后推进 |
| 回滚 | react-pi 依赖已移除；如需回滚，revert 本迭代提交即可恢复原状 |
| 上游注释的英文本地化成本 | 已全部译为中文；术语（React/Pi/snapshot/seq 等）保留英文原名 |
| **第三方许可保留义务** | 已新增 `packages/react/THIRD-PARTY-NOTICES.md`（含 react-pi/core/store 三方的版权声明与 MIT 全文） |

## 8. 待确认

✅ 决策点 1~8 已确认（见 §0）。实施已完成（S1~S9），顾问审查结论见 §5.1。
