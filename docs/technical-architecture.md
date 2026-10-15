# 幻（huan）— 技术架构文档

**最后更新**：2026-10-15
**状态**：持续维护文档，随技术变更同步更新
**决策依据**：D-01～D-26（见 `docs/tmp/pi_harness_shared_architecture_draft.md` §14）；上游核对见该草案 §16

---

## 1. 技术栈

按 huan 自身需求独立选型（不沿用任何其他项目的技术方案）。

| 领域 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | 全量 TS，无 JS 混写 |
| 前端框架 | React 19 | 函数式组件 + Hooks |
| 构建 | Vite（应用，rolldown 内核）；tsc --noEmit（类型检查） | 开发服务器与生产构建；包零构建直引源码（见 §2 与 dev-guide §4.1） |
| 样式 | Tailwind CSS v4 | Utility-first |
| 基础组件 | shadcn 模式：组件源码拷入项目 | 对话框、按钮、菜单、树等；无头逻辑用 Base UI（默认）或 Radix |
| 聊天 UI | `@assistant-ui/react` + `@assistant-ui/react-pi` | 逻辑层直接依赖；主题组件经 CLI 拷入 |
| Agent 核心 | `@earendil-works/pi-coding-agent`（Pi SDK） | AgentSession、SessionManager、工具、扩展 |
| 代码查看/Diff | Monaco Editor（`monaco-editor`） | 查看 + diff editor（D-21） |
| 状态管理 | Zustand | 单一 store + selector 订阅；React 外可读写（D-24） |
| i18n | Lingui（源语言中文，首期仅中文包） | 编译期宏（D-22/D-25） |
| 包管理 | pnpm workspaces | monorepo；`@huan/*` 命名空间（D-13） |
| 测试 | Vitest | 单元与集成 |
| Lint/Format | Biome（已定，迭代①） | 单工具覆盖 lint + format |
| 许可证 | AGPL-3.0 | 仓库根 `LICENSE` |

**运行形态（首期）**：Node 宿主进程（运行 Pi SDK）+ 浏览器 UI（HTTP/SSE 传输）。桌面壳与宿主持有方式暂不锁定（D-12）；协议层按可替换传输设计。

---

## 2. 仓库结构与包边界

```
huan/
  AGENTS.md
  LICENSE                   # AGPL-3.0
  package.json              # workspace root
  pnpm-workspace.yaml
  docs/
  packages/
    protocol/               # @huan/protocol：纯 TS 类型 + schema，无运行时依赖
    core/                   # @huan/core：Pi SDK 集成、运行时生命周期、命令接口（Node）
    react/                  # @huan/react：assistant-ui 适配、通用会话 UI、Tool UI registry
    history/                # @huan/history：Checkpoint/ChangeSet 契约与关联元数据
  apps/
    harness/                # 通用 Harness 应用（首期：Web UI + Node 宿主）
```

### 依赖方向（强制）

```
apps/harness
  ├── @huan/core      → Pi SDK（Node）
  ├── @huan/react     → assistant-ui + @huan/protocol
  ├── @huan/history   → @huan/protocol
  └── @huan/protocol  → （无）
```

- `core` / `protocol` 不依赖 React；`react` 不依赖 Node/Rust；`protocol` 无运行时依赖。
- 公共包不得 import 应用内部模块；应用之间无直接代码依赖。
- 宿主特殊接口（Electron、Tauri、未来的原生桥）只出现在应用的 `bridge/` 或独立 adapter 包中。

---

## 3. Agent 运行时架构（@huan/core）

### 3.1 组成

- **Session Host**：以 Pi SDK `createAgentSession` / `AgentSessionRuntime` 为基础，管理会话生命周期（新建、恢复、切换）、事件订阅与清理、模型与 Thinking 配置。
- **Tool & Extension 装配**：按应用 profile 装配工具集、扩展与 inline 扩展；SDK 不自动加载 CLI 内置扩展（codemode / tool_search / MCP），需显式注入（上游核对结论）。
- **Host UI 桥**：绑定 `ExtensionUIContext`，路由 `confirm / select / input / editor` 到 UI；应用自定义交互以扩展 `kind` 携带版本化 schema（D-19）。
- **快照投影**：保留 Pi 原生事件（`rawPiEvent` 透传），同时投影出 GUI 常用状态。

### 3.2 关键语义约束

- Pi `SessionManager` 是已提交消息与分支的权威来源；前端流式状态可乐观显示，以 Pi 完成事件（`message_end` / `agent_settled`）校正。
- 会话切换后事件订阅必须重新绑定；旧订阅不得污染新会话。
- 运行结束以 `agent_settled`（Pi 不会再自动继续）为准，不以最后一个 token 或 socket 关闭为准。
- Prompt 在流式中必须明确 steer 或 followUp（Pi 语义）；输入队列镜像 Pi 的服务端队列，支持整体清空。

### 3.3 react-pi 采用分步（D-14）

| 阶段 | 做法 | 退出条件 |
| --- | --- | --- |
| 首期（闭环） | 直接 `usePiRuntime` + 官方 HTTP/SSE 形态；应用层完成验证 | 闭环验收通过 |
| 固化期 | 公共层以纯 reducer/投影（浏览器安全入口）+ 自研 Controller 为边界；`usePiRuntime` 不进入公共 API | 分支/树导航、Host UI 扩展、Checkpoint 关联落地 |

react-pi 已知缺口（调研核对）：无 fork/树导航、队列不可逐条编辑、附件仅图片、不暴露 skills/extensions、恢复仅快照无重放、Node supervisor 目录状态不跨重启持久化。缺口由公共 Controller 或应用功能补齐。

---

## 4. 协议与传输（@huan/protocol）

- Node 宿主与 UI 之间的契约以 react-pi 的 `PiClient` 形态为参照（RPC-isomorphic、JSON-safe），**不重新发明**已存在的稳定类型。
- 约定：
  - 命令（request/response）带 `requestId`；长操作用事件汇报状态。
  - 事件带 `sessionId`、必要时 `runId` / `toolCallId` 与单调序号。
  - 重连与首次订阅采用同一机制：订阅入口先交付带 `seq` 的权威快照，再在同一连接上接续实时事件（无「先请求快照再连接」的两步间隙）。有 `seq` 可用于发现缺口，但不依赖事件重放。
  - 协议显式版本化；未知事件/字段宽容处理。
  - 自定义 Host UI `kind` 使用版本化 schema 校验（`kind` 命名如 `editor.select-node`）。
- 传输可替换：首期 HTTP/SSE（官方样例形态）；Electron 主进程共置、Tauri sidecar 或未来本地 IPC 都实现同一 `PiClient` 契约。

### 4.1 多订阅者语义（多窗口并发）

架构明确支持多个 Web 窗口同时订阅同一会话：宿主是全窗唯一权威状态，窗口只做呈现与交互入口。已核实 react-pi `ThreadSupervisor` 源码符合此语义：

- `subscribe(threadId, listener)` 将 listener 加入该会话的监听 `Set`；`emit()` 向全部监听者扇出，单监听者抛错不影响其他（内部 try/catch 隔离）。
- 退订只移除该 listener；**断开不等于中止**（源注释："Disconnect ≠ abort: keep the record and its run alive"）——关闭一个窗口不影响其他窗口与运行中任务。
- 后加入的订阅者先收到带 `seq` 的权威快照，再接续实时事件；天然支持新开窗口立即看到完整现状。
- HTTP 层：每个事件连接（SSE）各自 subscribe，断开时 unsubscribe；多窗口即多连接，无单连接限制。

实现时必须处理的三个点：

1. **空闲会话的跨窗实时**：react-pi 已知限制——会话为空闲时打开不自动转直播，另一窗口发起运行后本窗口需刷新。我们在应用层对「打开的会话视图」使用长期订阅（对应 `controller.connect()`），消除该缺口。
2. **Host UI 并发响应**：两个窗口可能同时响应同一请求，按「先响应生效、重复响应幂等忽略」处理；验证 bridge 对重复 resolve 的实际行为。
3. **窗口本地状态不共享**：各窗口的选中会话、输入草稿、滚动位置等属于本地 UI 状态，默认不跨窗同步；仅经 Pi/宿主的状态（消息、运行状态、Host UI 请求、模型配置）全局一致。

---

## 5. Checkpoint 与 ChangeSet（@huan/history）

### 5.1 三个独立维度（长期有效）

| 维度 | 权威来源 | 代表 | 不负责 |
| --- | --- | --- | --- |
| Conversation History | Pi SessionManager | 消息树、分支、Compaction | 项目文件恢复 |
| Checkpoint | 应用快照 Provider | 某时点可恢复的工作区状态 | 决定 LLM 看到哪个分支 |
| ChangeSet | 差异记录 | 两状态之间的修改/操作集合 | 保证外部副作用可逆 |

**禁止把「跳转 Pi 旧会话节点」等同于「项目自动回退」。** 两者是显式、可独立执行的操作；组合命令需处理未保存改动、运行中的 Agent 与冲突。

### 5.2 内容寻址快照（D-16）

- **存储**：blob（按内容 hash）+ manifest（路径 → hash + 元数据）；应用数据目录下的对象库，不写入工作目录。
- **触发**：run 起止 / 工具调用前后，对受管文件扫描增量。
- **归因**：基准快照与变更后快照对比 + run/tool 元数据 → 区分 Agent 改动与用户改动；这是价值核心，任何后端都需自建边界快照。
- **忽略策略**：默认尊重工作区忽略约定（如 `.gitignore`）+ 内置排除（对象库自身、node_modules 等）；未跟踪/忽略文件的处理边界与重命名识别、符号链接、权限位、大文件阈值在 M2 迭代设计时细化。
- **外部改动检测**：恢复前比对待恢复文件的实际内容与快照元数据，检测到外部改动时展示冲突并允许取消，不静默覆盖。
- **Git 关系**：不做 Git 依赖、不碰用户 index/暂存区；未来如遇性能瓶颈，Git 仅可作为快照层之上的加速层。

### 5.3 Provider 契约

```ts
interface CheckpointProvider {
  capture(context: CaptureContext): Promise<CheckpointRef>;
  diff(base: CheckpointRef, target: CheckpointRef): Promise<ChangeSet>;
  restore(target: CheckpointRef, options: RestoreOptions): Promise<RestoreResult>;
}
```

接口需能表达：不支持恢复、部分成功、冲突、需用户确认、恢复中断。选择性恢复能力由 provider capability 声明，不在公共层假定所有实现能力相同。

---

## 6. UI 架构（@huan/react 与 apps/harness）

### 6.1 分层

```
apps/harness（页面装配、布局、主题）
  ├── features：会话列表、代码工作区、审查视图、设置
  ├── components/assistant-ui：assistant-ui 主题组件（CLI 拷入后自行维护）
  ├── components/ui：shadcn 模式基础组件（拷入）
  └── @huan/react：Thread/Composer 通用组件、Tool Renderer Registry、Host UI 渲染扩展点
```

- Tool Renderer Registry：按 `toolName` 或 `rendererId + schemaVersion` 匹配；未命中回退通用卡片（JSON/文本可读）。
- Tool 输出约定：返回稳定语义数据（对象 ID、摘要、前后值、错误码），不放 React element、不放不受控大体积快照。
- Host UI 请求渲染：工具关联请求渲染在工具卡片内；独立请求走侧通道组件。

### 6.2 代码工作区

- 布局：可拖拽分栏（文件树 / Monaco 查看 / Diff 审查 / 聊天区）。
- Monaco：`monaco-editor` + 语言支持；diff 使用内置 diff editor；worker 资源在桌面壳下需按打包方式配置（M2 处理）。
- 文件树：忽略规则与快照忽略策略共享同一套判定。

---

## 7. 安全模型

| 层 | 措施 |
| --- | --- |
| 通用 Harness | 以用户进程权限运行；敏感操作执行前呈现；提示词约束不作为安全边界 |
| 编辑器 Agent（D-20） | 受控资源加载（不引入用户通用扩展目录）、工具面仅编辑器 API、凭据与工作目录隔离；如实声明为进程内配置约束 |
| 升级项 | OS 级隔离（容器/沙箱）在面向不可信项目或第三方分发时评估 |
| 通用原则 | 工具白名单属于模型调用层，不是系统安全边界；跨进程/跨应用调用再次校验资源 ID、作用域、权限与参数 |

---

## 8. 兼容性与演进

- **Pi 兼容**：SDK 会话与 CLI 默认行为差异（内置扩展不自动加载等）通过启动配置对照测试保证；升级 Pi 版本前跑回归清单。
- **react-pi / assistant-ui**：锁定版本；升级前跑 UI 回归；适配层集中封装，避免散落。
- **协议与历史**：协议显式版本化；应用元数据（快照引用、关联 ID）支持版本迁移；兼容 Pi 原生 JSONL 会话格式，不修改 Pi 内部历史文件作为存储接口。
- **快照数据**：manifest 带格式版本；对象库可独立重建（孤儿 blob 定期回收）。

---

## 9. 工程与质量

- 每个里程碑对应一份迭代文档（`docs/iteration/<YYYY-MM>/`），分类遵循 AGENTS.md（feat/perf/bugfix/refactor/test）。
- 单元测试覆盖：协议序列化、事件归约与投影、快照 diff/恢复核心逻辑；集成测试覆盖：会话生命周期、工具调用、重连。
- 开发与调试操作指南见 `docs/dev-guide.md`（随骨架迭代建立）。
