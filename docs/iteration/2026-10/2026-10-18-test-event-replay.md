# 迭代：事件回放验证（@huan/core ↔ @huan/protocol ↔ apps/harness）

- **日期**：2026-10-18
- **分类**：test
- **状态**：已完成（2026-10-18）
- **决策依据**：迭代③设计 §4-8（事件映射三层验证：穷尽 + fixture + 回放）

---

## 1. 目标

完成迭代③遗留的第三层验证：**映射结果 → JSON 往返 → 真实消费方 reducer → 与权威状态对比**，并在过程中修复发现的快照隔离缺陷。

退出标准：

1. 回放链路覆盖「映射层输出」与「宿主直发事件」两类事件源；
2. 回放终态与宿主权威快照一致（消息、运行状态、队列、模型配置、seq）；
3. 关键 fixture 经变异验证（破坏实现能被捕获）；
4. 全部检查通过（lint + typecheck + test）。

## 2. 范围

### 2.1 做

1. 回放测试（fixture 层 + 集成层）；
2. 快照隔离修复（数组 + 消息对象）；
3. `docs/todo.md` 的状态更新。

### 2.2 不做

- 宿主→浏览器的 SSE 传输链路验证（属迭代④，`@huan/react` 消费侧）；
- 自研 reducer/Controller（迭代④）。

## 3. 落点选择

**问题**：回放测试需要一个"真实 reducer"，但哪个算真实？

| 候选 | 评估 |
| --- | --- |
| `@huan/react` 新建最小 reducer | ❌ 空占位；D-14 决策该边界属迭代④，提前做会返工 |
| `@huan/core` 内自建参考实现 | ❌ core 禁止依赖 React 生态；自建参考实现无法证明真实消费方行为 |
| **apps/harness 用 react-pi 的 reducer** | ✅ 当前真实消费路径（`PiRuntimeProvider` → `usePiRuntime`）；依赖关系合法；不侵入迭代④ |

**已核实的前提**：

- `reducePiThreadState` / `createPiThreadState` 是 react-pi 的**公开导出**（`dist/index.d.ts`），注释明确 browser-safe（不 import `@earendil-works/*`）；
- react-pi 的事件联合（`PiClientEventBody`）与 `@huan/protocol` 的 `HarnessClientEventBody` 逐字段结构对齐；
- Node 环境可直接导入（已实测）。

**迭代④衔接**：自研 Controller 落地后，替换测试文件里的 reducer 导入即可复用全部 fixture。

## 4. 测试结构

文件：`apps/harness/src/event-replay.test.ts`（23 项）

### 4.1 辅助函数

| 函数 | 职责 |
| --- | --- |
| `envelope(body, seq)` | 补传输信封（`threadId` + `seq`）——reducer 依赖它做去重与排序 |
| `replay(events)` | JSON 往返（模拟 SSE）后逐条送入 reducer |
| `mapped(event, turnIndex)` | 经 `mapSessionEvent` 走真实映射链路 |

### 4.2 事件源分类（fixture 构造的依据）

| 类别 | 来源 | 例子 |
| --- | --- | --- |
| **映射层** | SDK 会话事件经 `mapSessionEvent` | `agent_start`、`message_*`、`tool_execution_*`、`queue_update`、`compaction_*`、`auto_retry_*`、`session_info_changed`、`thinking_level_changed`、`entry_appended` |
| **宿主直发** | 宿主自行 emit（不经映射层） | `snapshot`、`error`、`context_usage`、`extension_ui_request/resolved`、`agent_end(cancelledBeforeStart)` |

### 4.3 fixture 层覆盖（22 项）

- **运行生命周期**：完整一轮、无快照冷启动、`agent_start`/`agent_end` 状态迁移、`willRetry` 保持 running；
- **流式内容**：`message_start` → `message_update`×2 → 中间态断言 → `message_end` 收敛；
- **工具执行**：`start → update → end`（含错误/成功标记）；
- **队列**：`queue_update` 分流、重连快照清空旧队列；
- **活动标记**：compaction / auto_retry 的开始与结束分支；
- **元数据**：重命名（含清空）、thinking level、context usage；
- **错误与取消**：`error` 置失败、`error(terminal)`、`agent_start` 清除错误、`cancelledBeforeStart` 不引入失败；
- **seq 水位线**：旧事件丢弃（去重/乱序）、快照可降低 seq（宿主重启序号重置）；
- **前向兼容**：未知事件忽略但推进 seq；
- **Host UI**：请求订阅与结算；
- **重连恢复**：快照携带 `lastError` 与 `readiness`。

### 4.4 集成层（1 项）

真实宿主 + mock SSE → 订阅收集真实事件流 → `sendMessage` → 条件等待（**有超时失败**：必须收到助手文本且状态回 idle）→ `replay(events)` 与 `getThread()` 权威快照对比：

- 消息角色序列 + **JSON 归一化后完全一致**（不只比角色）；
- 助手回复文本确实被还原；
- 运行状态、模型配置、队列口径一致；
- seq 水印 == 最后事件 seq == 权威快照 seq；
- 首帧快照是「订阅时点」的状态（不含后续运行的助手消息）。

## 5. 发现并修复的缺陷

### 5.1 快照活引用（数组）

`snapshotOf` 直接引用 `record.session.messages`（SDK 内部活跃数组），订阅者拿到的"seq N 时的权威快照"会被后续运行追加。

**探针证据**：

```
snapshot messages roles: ['system','user','assistant']   ← 订阅时点应为 []
replay messages: [..., 'system','user','assistant']      ← 快照污染 + 增量叠加 = 重复
```

### 5.2 快照消息对象被原地改写

即使复制数组也不够：扩展在 `message_end` hook 返回替换消息时，SDK 用 `_replaceMessageInPlace()`（`delete` 所有键 + `Object.assign`）**原地改写**已进入 `state.messages` 的对象（已核对 `agent-session.js` 源码）。

**修复**：`isolateMessages()` 逐条浅复制消息对象（两层隔离）：

```ts
const isolateMessages = (messages: readonly unknown[]): HarnessAgentMessage[] =>
  messages.map((message) => ({ ...(message as object) })) as HarnessAgentMessage[]
```

**回归测试**：「快照与后续 SDK 改写隔离」——暂停 `message_end` hook → 取快照（断言含 `ORIGINAL_TEXT`）→ 放行（hook 返回 `REPLACED_BY_HOOK`）→ 断言先前快照未被污染、权威快照已反映替换。

## 6. 变异验证

| 变异 | 结果 |
| --- | --- |
| `agent_end` 映射丢弃 `willRetry` | fixture「willRetry 保持 running」失败 ✅ |
| `session_info_changed` 清空时也带 `name` | fixture「重命名清空」失败 ✅ |
| `snapshotOf` 改回活数组引用 | 集成层失败（首帧快照被污染）✅ |
| `isolateMessages` 只复制数组 | 「快照隔离」失败（`REPLACED_BY_HOOK` 污染）✅ |

## 7. 类型边界

协议侧 `HarnessAnyClientEvent` 含「未知事件兜底」开放变体，reducer 入参是窄联合。两处断言（均有注释说明依据）：

1. `replay()` 内 `event as Parameters<typeof reducePiThreadState>[1]`——依据：已核对 reducer 的 `default` 分支对未知类型只记 `seq` 并忽略，这正是两侧约定的前向兼容行为；
2. 集成层读首帧快照时显式收窄（`as { messages?: ... }`）——开放变体妨碍 TS 判别。

**不**在 `@huan/protocol` 引入 react-pi 专用 narrow（会污染公共协议层；类型守卫也无法证明两套载荷兼容）。

## 8. 风险与已知边界

| 边界 | 说明 |
| --- | --- |
| 上游 reducer 行为变更 | react-pi 升级时需回归本文件的 fixture（§6 的变异项是重点） |
| 协议联合新增事件 | 新增已知事件时，fixture 层应补对应回放用例（映射层单测先行） |
| 传输链路 | 宿主→浏览器 SSE 的编码/解码验证属迭代④ |

## 9. 后续

- 迭代④：`@huan/react` 的自研 Controller 落地后，替换本测试的 reducer 导入；
- SSE 传输链路测试（经 `createPiHttpClient` 进入 reducer，属迭代④ §4-10）。
