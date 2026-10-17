# 迭代：取消语义收敛与竞态测试（@huan/core）

- **日期**：2026-10-17
- **分类**：bugfix
- **状态**：已完成（2026-10-17）
- **决策依据**：AGENTS.md「从根本上解决问题」；迭代③设计 §3.3 行为契约（sendMessage 接受语义、subscribe 快照边界、cancelRun 语义）

---

## 1. 目标

收敛迭代③遗留的竞态测试项（预检窗口取消、装配期 dispose、A/B 隔离），并在过程中修复**取消语义**的真实缺陷。

退出标准：

1. 预检期取消不发出模型请求；
2. 取消不把会话标为失败（不置 `lastError`、不广播 error 事件）；
3. 取消判定绑定当前运行，不被此前的取消干扰；
4. 三条竞态用例落地且经变异验证有效；
5. 全部测试通过（lint + typecheck + test）。

## 2. 范围

### 2.1 做

1. 预检期取消兜底（准入闸门 + `agent_start` 中止 + 输入守卫）；
2. 取消/失败口径修正（`agent_settled.aborted` 为权威判据）；
3. 退休收尾排空（`dispose`/`delete` 等待在途发送退出）；
4. 延迟动作拦截（`_deferredSettledActions` 的成员数组清空 + 局部批次兜底）；
5. 竞态测试与变异验证；
6. 协议契约补充（`cancelRun` 停止语义）。

### 2.2 不做

- 事件回放验证（依赖迭代④浏览器侧接入）；
- `agentDir` 用于会话存储（独立缺口，见 `docs/todo.md`）。

## 3. 背景：SDK 的三个缺口

本迭代的多数复杂度来自 Pi SDK（v1.1.0）的既有边界，均已核对源码：

| 缺口 | SDK 行为 | 源码位置 |
| --- | --- | --- |
| 预检期取消无效 | `abort()` 只在 `_isAgentRunActive` 为真时记录中止意图；`_runAgentPrompt()` 启动时还会重置该标志 | `agent-session.js` 的 `abort()` / `_runAgentPrompt()` |
| 「运行中」判定不等于「会入队」 | `prompt()` 在 input hook 之后才判定 `isStreaming`；结果可能是排队，也可能是启动运行 | `prompt()` 的 streaming 分支 |
| 结算窗口的静默缓冲 | `_emitAgentSettled()` 期间 `prompt()` 被压入 `_deferredSettledActions` 并**立即返回**；且该方法先 `splice(0)` 取入局部数组再逐个 `await` | `_emitAgentSettled()` / `prompt()` / `sendCustomMessage()` |
| 取消被误分类为错误 | provider 的 `lazyStream` setup 失败路径把 `stopReason` 写死为 `"error"`（即使中止） | `pi-ai` 的 `lazy.js` |

另外 SDK **没有**「预检期取消」的官方语义：官方 RPC 模式（`rpc-mode.js`）的 `abort` 只是直接透传 `session.abort()`，TUI 模式同样不处理。因此宿主必须自行兜底。

## 4. 设计

### 4.1 取消与失败口径

- **权威判据**：`agent_settled.aborted`（SDK 直接取自 `_agentRunAbortRequested`），不受消息 `stopReason` 分类影响；
- **失败结算时机**：`agent_settled`（不是 `agent_end`——其后仍可能重试/压缩/继续）；
- **取消语义**：不置 `lastError`、不广播 error 事件、保留既有 `lastError`（取消不消灭此前的失败记录）；
- **成功轮次**：清除此前残留的 `lastError`。

### 4.2 运行归属

```ts
type CurrentRun = {
  owner: InFlightSend | undefined   // 触发本次运行的发送
  cancelled: boolean                // 运行自身是否被取消
  pendingError: string | undefined  // 候选失败（agent_end 记录）
  settled: Promise<void>            // 结算信号（免轮询）
  markSettled: () => void
}
```

归属槽 `startingSend` 由 `preflightResult('started')` 写入、`agent_start` 消费。取消判定只看**当前运行**的做法避免了一个隐蔽缺陷：已取消的 A 仍在途时，B 的真实失败不得被 A 的取消标记吞掉。

### 4.3 准入闸门（`acquireAdmission`）

保证每会话同时至多一个发送处于「预检 → 运行确认」段，防止两个发送并发越过 SDC 预检后互相提前结算（`_runAgentPrompt()` 的 `finally` 无条件发 `agent_settled`）。

判据用的是 SDK 内部状态组合：

| 状态 | `session.isStreaming` | 宿主动作 |
| --- | --- | --- |
| 正常运行中 | `true` | 放行：交给 SDK 的排队分支（steer/follow-up 即时入队） |
| 结算窗口（扩展 settled hook 执行中） | `false`（SDK 已置 `_isAgentRunActive = false`） | 等待 `run.settled`，可被取消/退休唤醒 |
| 有占窗者 | — | 等待 `admission.done`，可被唤醒 |

### 4.4 输入守卫（合成扩展）

通过 `createHostServices({ extensionFactories })` 注入（SDK 文档：inline extensions 追加在文件扩展之后），用 `input` 事件的 `handled` 语义在**提交点**拒收：

- 会话已退休的输入；
- 已取消发送的输入——归属通过 `AsyncLocalStorage` 传递（不用文本匹配：SDK 的 `emitInput()` 会把前一个 handler 的 `transform.text` 往下传，文本会变）。

### 4.5 延迟动作拦截

扩展的 `sendMessage(..., { triggerTurn: true })` 会在结算窗口被压入 `_deferredSettledActions`，之后由 SDK 直接调 `_runAgentPrompt()`——该路径不经输入守卫、不经 `preflightResult`。三层处理：

1. **成员数组清空**：取消/退休时 `discardDeferredRuns()`；
2. **收尾后二次清空**：`emitShutdown` 之后（扩展的 `session_shutdown` handler 可能再次提交），与 `session.dispose()` 同一同步链，中间不插 await；
3. **agent 级兜底订阅**：SDK 先 `splice(0)` 把动作取入**局部数组**再逐个执行，成员数组清空够不到已取走的部分。直连 `session.agent` 的订阅（不受 `session.dispose()` 影响）在 `agent_start` 时中止这类运行。该订阅**刻意不提供退订**（局部批次链的结束没有可靠信号），record 成为孤立环随会话 GC 回收。

### 4.6 退休与排空

`dispose` / `deleteThreadNow` 的统一收尾顺序：

```
retired = true → 唤醒闸门等待者 → discardDeferredRuns → 标记在途发送 cancelled
  → dismissAll（解除阻断式 UI）→ abort → drainInFlight（5s 上限）
  → emitShutdown → discardDeferredRuns → session.dispose → unsubscribe
```

`drainInFlight` 有上限：SDK 层无法中断阻塞在输入 hook 里的预检。

## 5. 验证

### 5.1 测试（64 项全绿，其中竞态用例 7 条）

| 用例 | 断言要点 |
| --- | --- |
| 预检期间取消不产生模型调用 | `fetchCalls === 0`、无产出文本、状态 `idle` |
| 预检期取消不吞掉后续真实失败 | 闸门串行使 B 在 A 结算前不进入预检；`lastError` 含 B 的具体错误 |
| 取消窗口内的输入不泄漏进队列 | `queuedMessages` 为空、`fetchCalls === 1` |
| 运行中的排队不因闸门被推迟 | `sendMessage` 及时返回、`queuedMessages` 含 B、`clearQueue()` 可取回 |
| 等待已取消运行结算的发送可被再次取消唤醒 | B 在 3 秒内退出等待（不悬挂） |
| 预检通过后（`before_agent_start` 阻塞）dispose | `fetchCalls === 0` |
| 结算窗口内的发送可被取消 | 取消前 B 仍 pending（闸门独有信号）、取消后及时结算、`fetchCalls === 1` |
| shutdown handler 内提交的延迟运行不得逃逸 | 二次清空生效、`fetchCalls === 1` |
| SDK 已取走的延迟批次不得逃逸 | 第二次 settled 握手确认 `splice` 已发生；放行后 `fetchCalls` 仍为 2 |

### 5.2 变异验证

| 变异 | 结果 |
| --- | --- |
| 注释掉 `agent_start` 的取消中止 | 状态变 `running`，预检取消用例失败 |
| 判定改为扫描整个 `inFlight` 集合 | B 的真实失败被吞（状态 `idle`），隔离用例失败 |
| 绕过准入闸门 | B 在 A 结算前进入预检，隔离用例失败 |
| 闸门条件改回「只等已取消运行」 | 结算窗口用例失败（`bOutcome` 变 `settled`） |
| 跳过 shutdown 后的二次清空 | `fetchCalls === 2`，逃逸用例失败 |
| 禁用 agent 级兜底订阅 | `fetchCalls === 3`（局部批次逃逸），用例失败 |
| 禁用输入守卫 | 队列残留 `followUp:0`（纵深防御下需多防线同禁才复现） |

### 5.3 探针实证

一次关键结论由探针（非测试）确定：SDK `splice(0)` 取走的局部批次确实会在退休后启动运行（`FINAL fetch=3`），修复后为 `2`。这推翻了「该时序不可达」的初步推断，并促成 agent 级兜底订阅的设计。

## 6. 兼容性与影响

- **协议**：`cancelRun` 补充「停止语义」说明（中止运行 + 丢弃未送达输入 + 覆盖预检窗口 + 取消不算失败）；无形状变更，`HARNESS_PROTOCOL_VERSION` 不变。
- **`createHostServices`**：新增可选 `extensionFactories`（宿主注入合成扩展）。
- **行为变化**：取消不再把会话标为 `failed`（此前会）；这与产品预期一致（取消是用户主动行为）。

## 7. 风险与已知边界

| 边界 | 说明 |
| --- | --- |
| 永久阻塞的输入 hook | SDK 层无法中断；取消会唤醒等待者，但阻塞本身只能等其返回 |
| 局部批次链的结束 | 无可靠信号，agent 级订阅永久保留（孤立环，随会话 GC） |
| `_deferredSettledActions` 私有字段 | 通过类型断言访问；SDK 字段缺失时静默跳过（退化为不拦截，仍有 agent 级兜底） |
| SDK 升级 | `preflightResult` 的调用位置与异常传播、`_deferredSettledActions` 字段名需回归验证 |

## 8. 后续

- 事件回放验证（迭代④，浏览器侧接入后）；
- 扩展显式 `steer` 路径的排队用例（当前只覆盖默认 `followUp`）。
