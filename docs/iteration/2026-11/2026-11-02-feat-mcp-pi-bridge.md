# G1.4d2b Pi MCP 工具与资源桥接

日期：2026-11-02。阶段状态唯一维护于 [roadmap](../../roadmap.md)。存储以[共享配置修订](2026-11-02-feat-mcp-shared-config.md)为准，连接基础见[d2a](2026-11-02-feat-mcp-connections.md)。

## 1. 范围与出口

在现有 `@huan/mcp` manager 上以 Pi SDK 公开扩展 API 注册工具、资源与发现入口，由 core 按会话装配。覆盖 MCP-01/02/03/05 与 RES-03/05 的运行时子项；完整 GUI 与 OAuth 仍分别由 d4/d3 负责。本阶段不新增 HTTP/浏览器管理契约，不用 prompt 冒充管理命令。

仅注入 huan 的 named `builtin:mcp`、replaceable 扩展，不注入官方 createMcpExtension。工厂注册 `/mcp` 作为替换标识与受控状态摘要，GUI 管理命令路由仍在 d4 接入。`extensions: ['-builtin:mcp']`、noExtensions 和第三方同名命令替换应与官方一致。codemode/tool_search 继续使用官方工厂，不收窄其他工具。

## 2. 包接口与生命周期

- 提供无界面 integration binding（扩展工厂、当前 manager 查询与幂等 close）；构造/工厂不连接、不执行配置命令。配置在 `session_start` 使用显式 agentDir/cwd/当前信任结论加载，然后后台启动唯一 manager，GUI 后续也只能使用该实例。
- 每次 loader 重载产生新扩展上下文与连接代次；旧 shutdown 同步撤销注册资格并等待完整 close。core 持有 binding，启动失败/取消、归属失败、删除及宿主 dispose 都能直接关闭，即使其他扩展 shutdown handler 阻塞或报错也不依赖它清理。
- 项目信任沿用 core 原权威及 `.pi/mcp.json` 现有检测。getProjectTrusted 在 session_start 时读取本次 loader 的决定，no-resources 之后新增受保护资源不可据旧结论加载；不读取其他工作区成员配置。目录/设置查询只装配工厂，不启动连接。
- 支持公开 `pi.getMcpServers()` 初始扩展注册与 `mcp_servers_change` 动态注册/替换/移除。配置的规范 namespace 优先；运行时条目使用独立 extension scope（不扩大磁盘配置 user/project scope）。manager 增补必要的条目对账/就绪等待，保留同一实例、未变条目的连接和代次安全；移除立即撤下工具后等待关闭，再连接替代项。
- 配置/连接诊断为受控中文信息，不回显 URL/env/token/原始异常；OAuth 只使用 d2a 注入边界，模型 provider token 通过公开 modelRegistry 每请求读取。日志/认证落盘留 d3。

## 3. Pi 桥接语义

1. 工具名 `mcp__server__tool` 规范化、64字符限制、哈希后缀；同一目录内所有规范化碰撞项都加后缀，使用 Map 计数保持 O(n)，工具所有权稳定。namespace 含配置描述/服务端 instructions；只接收布尔 annotations。
2. manager 目录版本变化时更新定义。withdrawn/disabled/hidden 工具重注册 hidden（SDK 无 unregister），直接暴露降级时从 active set 撤下，避免遗留声明。执行解析当前 manager，不能持有旧 connection；工具/资源请求仍经正常 ToolDefinition.execute 和 SDK 权限 hook，不从 codemode 另开旁路。
3. MCP codemode 映射 SDK deferred：可脚本调用、可发现，但不铺满 codemode 描述。配置要求时激活具有 reachesTools 的 codemode/tool_search，尊重 autoEnableCodemode:false；一次受控通知不可达。首次 prompt 等待 direct 连接最多10秒、可取消；tool_call 根据 reachesTools/namespace 等待相关后台连接，资源与搜索等全部就绪。关闭/取消唤醒等待，不增加新连接。
4. 每轮更新有界 `mcp_servers` 结构化系统段，不覆盖完整system prompt。描述每项最多250字符、整段4096字符；服务器数量裁剪使用线性累计，避免上游重复slice/join的二次复杂度。
5. 选择性移植官方结果/资源转换：20KiB UTF-8 中间截断及完整文本临时文件、图片、资源链接/二进制保存；脚本拿完整 CallToolResult 去顶层 `_meta`、保持 isError 与 structuredContent、正确嵌套outputSchema局部引用。临时文件随机目录与0600，不泄露原始保存异常。不复制TUI renderers或私有工具依赖。
6. 三资源工具保持官方名称、分页/全量/模板/读取、各服务器部分失败、最宽exposure、只读annotations；剔除列举的MCP Apps与icons/_meta，read拒绝已知MCP App URI/内容。无可用资源时hidden；资源工具预注册hidden，避免首次资源调用发生在工具尚未注册时无法等待。

## 4. 验证与回退

- 包内转换测试覆盖命名碰撞/长度、UTF-8输出边界、完整结构化结果/错误/_meta、schema refs、资源分页/二进制/图片/App过滤、隐藏/降级/动态撤回/取消/旧代次。manager新增操作补竞态，不削弱d2a测试。
- 真实 Pi SDK + 隔离用户空间 + loopback/stdio fixture + 确定性模型验证 direct、codemode、tool_search 调用成功，tool_call拒绝不执行服务器副作用、tool_result转换、嵌套进度parentToolCallId；初始及动态扩展注册、配置优先、builtin禁用/替换、无服务器。
- core 集成覆盖拒绝项目信任无项目进程、no-resources后新增配置、同cwd多会话连接独立、未消费目录查询不启动、reload保留会话/消息并回收旧PID、创建取消/宿主dispose及慢初始化回收。无需个人配置/凭据或付费模型。
- 主agent独立review/修复并亲跑定向、全仓check/build与既有Chromium回归（实际会话装配行为改变）；测试结束核实子进程/隔离服务清理，不把DOM通过称为视觉审阅。
- 完成文档与验证后本地提交，不push。回退可移除core注入和包桥接出口，无共享配置迁移。

## 5. 实施与验证记录

- 包内交付 `createMcpIntegration`、工具/资源转换与注册、初始/动态扩展MCP服务器对账；core 实际依赖并按 loader/会话持有binding，named builtin/replaceable装配。配置仅session_start加载，目录查询无连接；静态header、环境/命令值、provider token沿用d2a，OAuth/日志存储未实现。
- 主agent独立review直接修复：运行时exposure/禁用的资源工具与系统段仍用启动配置、目录刷新误撤下tool_search已加载声明、移除再注册复用旧同步标记、无关注册重置临时设置、普通调用越过旧transport关闭屏障、关闭时漏等正在detach的manager。补对应真实SDK与定序回归；关闭/重载不复用旧扩展上下文。
- 主agent补session_start之前新增项目配置的no-resources边界检查与真实宿主回归，沿用现有信任权威；新增disposed准入最初引用尚未初始化函数，修正为直接检查disposed，并重跑既有启动诊断/交互用例。
- 真实SDK验证direct首轮等待与超时、codemode/tool_search、资源分页/模板/读取、嵌套进度/parentToolCallId、直接与codemode嵌套权限拒绝无副作用、tool_result替换；core的真实stdio验证查询无进程、两会话独立PID、拒绝信任/no-resources新增配置、重载旧PID退出并保留历史、慢初始化dispose、阻塞启动的晚回调禁止连接、builtin禁用/替换与无服务器。
- 主agent亲跑最终 `pnpm check`：58文件935项通过、2项平台权限测试跳过（协议仍13，未改浏览器契约）；`pnpm build`通过，保留既有大chunk提示。亲跑 `pnpm test:e2e`：现有63条Chromium通过，覆盖既有成功/失败/取消/重载/多窗回归；MCP新行为由真实SDK/stdio测试验证，本轮未新增MCP GUI流程，也未做截图视觉验收。
- 并行跑全仓与浏览器时曾遇默认shell取消耗时919ms超过900ms、临时目录EBUSY及启动交互超时；保留原断言，相关定向与随后独立完整check通过。worker另报告既有provider-auth的hasConfiguredAuth偶发断言失败；未据此改认证实现或宣称已确认根因。
- 许可来源新增index/tools/resources/output-files的发布包source map SHA256，主agent重新计算核对一致；未新增外部依赖，lockfile仅core→mcp workspace映射。测试使用临时空间、内存/本地transport和合成模型，无个人凭据/会话或付费模型请求；进程检查未发现vitest、MCP fixture或本轮e2e服务残留。

开发出口已完成；整体MCP能力的GUI/OAuth验收仍按roadmap后续阶段推进。
