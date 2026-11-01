# G1.3c 必要Host UI与启动期交互

- 日期：2026-10-31
- 阶段：[命令、输入与上下文](2026-10-31-feat-commands-input-context.md)
- 能力：RES-04、ENV-03启动期交互、RUN-01/05必要状态
- 基线：a642/33；b主体659/42、主agent已修复ignore与输入竞态，当前累计单测660通过，浏览器待最后全量复跑

## 1. 目标与原则

confirm/select/input/editor与通知、状态、文本widget、必要编辑器操作在GUI可用；启动的project_trust/session_start也可回答。模式rpc，明确TUI专属边界，不以静默默认false/undefined冒充用户取消。Pi/宿主单一权威；所有等待在取消、超时、销毁后可结算，多窗首个有效应答生效。

独立宿主交互通道覆盖record尚未发布的装配期，不重跑扩展工厂/钩子来回放答案。服务器可用后再按需装配项目，宿主初始化不能因等待浏览器而无法启动HTTP。启动诊断和默认模型解析依赖要保留；必要的bootstrap拆分需集中、最小改动，不另造通用job框架。

## 2. 宿主交互通道

- 新增宿主级snapshot订阅/查询与应答接口，沿既有Host/Origin/token校验。请求具ID、作用域（project cwd或session id/operation）、类型/标题/关联工具/超时。首订阅和重连以权威快照，状态seq单调；无凭据/任意扩展堆栈进普通快照。
- project_trust使用真实ProjectTrustContext(hasUI:true/mode:rpc)，用户扩展顺序与现有优先级保持；同cwd共享装配只有一份交互，不缓存答案重跑。ctx.ui.notify可见。inspectProjectTrust仍只读无UI，不触发交互。
- session_start期间先注册桥至宿主交互域，允许create/open HTTP仍等待钩子，但另一条通道可发现/应答；不用提前把半初始化record放进会话目录冒充ready。session完成发布后，普通线程UI请求仍可保持现有工具卡片/侧通道，宿主启动请求消失且不重复。
- 全局页面常驻订阅（不依赖选中会话），展示待答请求/取消。关闭一个窗口不自动取消任务；重新打开可继续回答。显式取消启动请求令钩子获得原生取消值；宿主dispose/open signal中止则dismiss并不发布退休session。HTTP长请求断开不把共享装配误取消。
- 扩展没有设置timeout时宿主持有等待到用户应答/显式取消/销毁；超时按SDK默认值结算且UI能识别消失；不得保留永不清理pending表或timer。

## 3. 运行期Host UI

- confirm/select/input/editor保留toolCallId，双窗重复应答幂等，select非法值不能交给扩展；已中止signal立即结算。已有editor类型多行交互完整可用。
- notify可见且有界；setStatus按key设置/清除，setWidget仅文本行/placement；setTitle作为会话扩展标题提示，不能覆盖会话名称或全窗document.title。快照持有当前状态，断线补齐；通知采用有界列表/ID，不在每次snapshot重复弹toast。
- setWorkingMessage/Visible、hiddenThinkingLabel等必要状态以文本/标志承接；自定义指示器/组件/主题/终端输入/addAutocompleteProvider、custom、header/footer等终端专属明确说明不支持，不自动执行函数来转React。
- setEditorText/pasteToEditor/getEditorText：以调用命令/发送的窗口调用方ID为定向上下文，无调用方（后台扩展）则呈现“应用到输入框”请求由窗口主动接受，不能广播自动覆盖所有草稿。提交前同步调用方草稿镜像供getEditorText，临时镜像不进入JSONL/全局用户配置；过期调用方不串入其他会话。已有本地文字/附件时替换需确认或保留旧文本可找回。成功消费有唯一ID，重连不重复应用；草稿本身仍窗口权威。
- ctx.mode设rpc并hasUI真实；commandContextActions中newSession/fork/switchSession/navigateTree与已实现独立会话/分支操作衔接，发起窗明确接收目标，不替换父live record；waitForIdle正确实现且避免本命令自等；尚未实现reload/shutdown等操作明确抛可识别不支持，不能默认空成功。若需把RES-03最小reload提前才能满足基础能力，先报告具体依赖，不整包实施G1.4。

## 4. 验证

保留a/b测试，新增真实SDK：启动project_trust与session_start阻断问答零重复执行、多次顺序请求、拒绝/取消/timeout/已abort/dismiss/dispose、异常清理、并发同cwd/多窗应答、会话未发布但请求可回答、通知/status/widget恢复、编辑器定向和无调用方手动接受、commandContextActions实际结果/诚实错误。

浏览器：启动扩展询问（HTTP已可用），拒绝/确认后创建成功、关闭发起窗口另一窗接管、超时和重复响应无假成功；工具内与独立交互、编辑器只改发起窗保留另一窗草稿、notify/status/widget可见。用隔离用户扩展与合成模型，不个人凭据/付费请求，不reload遮掩状态。

主体DeepSeek Flash max，主agent独立review直接修复亲验check/build/Lingui/test:e2e；最后回写长期文档和roadmap能力清单，未测事项如实记录。回退代码按迭代，原始Pi会话可读；不做数据迁移框架。

## 5. 实施与验证

主体由 DeepSeek Flash max 编码，主agent独立review并直接修复，累计亲验见§5.4；完成状态在roadmap维护。

### 5.1 实现

- **协议**：新增宿主级交互请求/快照/事件/应答类型（作用域为 project cwd 或 session），线程快照新增 `hostUi`（状态、文本 widget、通知、标题提示、编辑器指令、命令目标）；`sendMessage` 增加可选 `callerId` 传输元数据。协议版本升至 10。
- **宿主交互通道**：`host-interactions.ts` 提供 pending 表、单调 seq 权威快照、订阅、作用域取消、幂等应答、超时/中止结算与销毁清理；HTTP 新增查询、SSE 与应答路由，沿既有 Host/Origin/token 校验。
- **启动期**：`project_trust` 使用真实 `ProjectTrustContext(hasUI:true, mode:rpc)`，confirm/select/input 进入宿主通道，notify 作为有界通知；`inspectProjectTrust` 仍走无 UI 路径。启动装配若遇到交互请求，宿主先返回并让 HTTP 可用，装配在后台继续；同 cwd 的后续查询复用同一进行中装配，不重跑扩展工厂。`session_start` 桥在 record 发布前接入宿主通道，发布后切回线程通道并清掉遗留启动请求。
- **运行期 Host UI**：confirm/select/input/editor 保留工具关联、非法 select 值拒绝、重复应答幂等、超时/中止结算；notify/status/widget/title/working 状态与 hiddenThinkingLabel 进入线程快照；`setFooter`/`setHeader`/`setEditorComponent`/`addAutocompleteProvider`/`setWorkingIndicator`/终端输入等终端专属能力不执行工厂，只产生可见不支持通知；`custom` 明确拒绝。
- **编辑器定向**：`sendMessage` 的调用方窗口 ID 沿异步链传递；`setEditorText`/`pasteToEditor` 生成带唯一 ID 的定向指令，`getEditorText` 读取该窗口的临时草稿镜像（仅内存）。前端只让目标窗口或主动接受的窗口应用，不自动覆盖草稿；旧文本在窗口内可恢复，线程UI增量经`host_ui_update`独立投递，重连由快照补齐，避免清空流式消息。编辑器指令消费返回原子领取结果，只允许目标caller领取，无调用方指令首个领取者生效。
- **commandContextActions**：`mode` 绑定 `rpc`；`waitForIdle` 直连会话；`newSession`/`fork`/`switchSession` 创建或打开独立 record 并用命令目标提示发起窗，父 live record 不替换；`navigateTree` 复用宿主结构闸门；`reload`/`shutdown` 抛出可识别的 `UnsupportedHostCommandActionError`。命令执行中的当前发送不再阻断其自身的结构操作。
- **前端**：新增页面级常驻宿主交互面板（Base UI Dialog处理顶层焦点与背景inert）、线程扩展状态/通知/widget/游离请求、输入框上/下文本 widget、编辑器指令应用/忽略/恢复与命令目标打开入口；`PiRunStatus` 承接 workingMessage/workingVisible。

### 5.2 验证证据

- `pnpm check`：Biome、全 workspace 类型检查、**680** 项单元测试通过（a/b 既有 660 项保留，新增 20 项覆盖宿主交互、运行期 UI、编辑器定向、启动期 project_trust/session_start、超时/中止/取消/销毁、commandContextActions、waitForIdle/shutdown 与 SSE 传输）。
- `pnpm build`：harness `tsc --noEmit` 与 Vite 生产构建通过。
- `pnpm lingui:extract`：`zh-CN` 源语言目录 **298** 条（此前 285 条）。
- `pnpm test:e2e`：Chromium **45** 条全部通过（a/b 既有 42 条保留，新增 3 条：运行期通知/状态/widget/标题与编辑器恢复、游离 confirm、启动期项目信任与 session_start 在会话创建/首条消息中应答）。
- 测试均使用 `@huan/core/testing` 临时用户空间与合成 provider，不读取个人凭据/会话，不请求付费模型；启动期信任测试另行使用独立临时空间。

### 5.3 已知限制与风险

- `newSession`在扩展绑定前应用setup和parentSession，触发session_before_switch/new与session_start/new；fork与树导航保留返回的编辑文本，switchSession尊重扩展取消，父live record保持独立。
- `reload`/`shutdown` 按设计明确不支持；资源重载仍需 G1.4。
- `hiddenThinkingLabel` 以文本/标志承接并显示，未改写实际 Thinking 折叠组件文案；`setWorkingIndicator` 等动画/终端组件按不支持处理。
- 宿主侧 `pasteToEditor` 的草稿镜像按末尾追加（无光标信息）；前端应用指令时按输入框光标插入，二者在极端并发下可能不同步。
- 宿主通知保留最近 20 条；前端“忽略”只是当前窗口本地隐藏，刷新后仍会从权威快照恢复。
- 启动装配遇到交互时后台继续进行；完成前 `getProject`/首次会话会等待同一装配，期间冷历史与 HTTP 可用。
### 5.4 主agent review与最终验证

- 直接修复HostUI状态更新不再发送完整聊天快照；补reducer回归保持流式消息/工具状态。
- 编辑器/命令目标原子领取、caller定向与重复领取拒绝；补前端双窗草稿不覆盖，连续set+paste正确合并；快照隔离避免订阅者修改宿主UI状态。
- 补newSession setup/血缘/扩展事件、fork与树导航editorText、首条创建caller传递、启动open signal组合取消；后台请求被销毁后不再注册新等待。
- 宿主交互改为Base UI模态，键盘/辅助技术可达；测试先应答顶层信任再操作底层Dialog。新增关闭发起窗后另一窗接管用例；其启动仅跳过不适用的背景可见等待，原openApp断言保留。
- 最终亲验`pnpm check`：38文件/685项；`pnpm test:e2e`：47条全部通过；build/Lingui299通过，仅既有大chunk提示。未做截图视觉审阅。
- reload/shutdown等阶段边界仍明确提示，未推进G1.4。
