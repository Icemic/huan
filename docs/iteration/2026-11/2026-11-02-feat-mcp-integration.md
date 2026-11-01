# G1.4d 独立 MCP 集成与配置隔离

日期：2026-11-02。能力范围为 MCP-01～05、RES-03/05 的 MCP 子项；阶段计划与完成状态由 [roadmap](../../roadmap.md) 维护。

## 1. 已确认目标与边界

独立 `@huan/mcp`（`packages/mcp`）是 Node 集成层，依赖官方 `@earendil-works/pi-mcp@1.4.0`，通过 Pi SDK 公开扩展 API 桥接；不注入官方 createMcpExtension，不使用第三方替代品、不 fork Pi、不私有深导入。选择性移植 Pi 1.4.0 配置/连接/OAuth 协调/工具资源逻辑，保留源码版本、指纹、版权许可与差异。首期保持会话级连接、启动连接、工具权限管线与 exposure 语义；不做按需连接、跨会话连接池、额外 transport、MCP Apps 或 llama 管理。

## 2. 存储与配置规则

| 用途 | huan 路径 |
| --- | --- |
| 用户服务器配置 | `<agentDir>/huan/mcp.json` |
| 项目服务器配置 | `<cwd>/.huan/mcp.json` |
| OAuth 凭据（后续连接阶段实现） | `<agentDir>/huan/mcp-auth.json` |
| 运行日志（后续连接阶段实现） | `<agentDir>/huan/mcp.log` |

不读取、合并、迁移或修改 `<agentDir>/mcp.json`、`<cwd>/.pi/mcp.json` 及 Pi 的 mcp-auth.json/mcp.log。空配置保持为空，不自动扫描其他客户端；未来导入须独立显式设计。继续复用 Pi agentDir 作为用户空间锚点，但 MCP 配置与认证状态独立。

配置形状保留 `mcpServers`、`autoEnableCodemode`。项目完整条目替换同名用户条目；仅 enabled/exposure/toolExposure 的项目 override 保留用户连接字段。用户/项目内命名碰撞以规范化 namespace 检测，使用 Map 保持线性检查；无效条目逐项诊断，不阻止其他有效服务器。项目完整条目禁止 auth.provider，项目 override 不可修改凭据字段。未知扩展字段在原文保存和条目编辑中保留，但 override 仅允许三个指定字段。

读取必须显式提供 agentDir/cwd/projectTrusted；未信任不读取项目原文，不将文件存在等同信任。仅展示/编辑不执行环境插值、`!command`、网络、OAuth 或子进程。后续 core 接入时必须把 `.huan/mcp.json` 纳入现有信任检测与 no-resources 缓存失效逻辑，不能另建信任权威。

配置原文只在显式编辑请求返回，不进普通运行快照。上限 512KiB（UTF-8 字节）；有界短读循环、BOM 支持、拒绝污染键与受控错误。SHA-256 基于实际字节，缺文件 revision 为 null。每个写入事务在规范化路径队列中完成重读/revision 检查/校验/同目录 wx 临时文件 0600/rename/回读；同进程不同 store 实例不能相互覆盖。拒绝目标或现有目录组件的符号链接，避免显式路径别名写入 Pi 配置；不承诺对恶意并发文件系统替换的 OS 沙箱防御。仅支持单宿主写事务，不宣称跨进程 CAS。保存只改磁盘，不自动连接或改变 live；配置 reload 与 runtime 应用明确分离。

## 3. 包职责与接口方向

- 配置存储对象固定 agentDir/cwd，通过 user/project scope 访问，不接受来自 HTTP 的任意文件路径；显式 projectTrusted 决定项目读取/保存准入。
- 无界面管理对象持有连接、配置版本、安全快照/订阅与管理操作；Pi extensionFactory 桥接同一实例。core 负责信任解析、会话归属、交互操作、多窗与协议投影；HTTP/React 不进入 MCP 包。
- 连接与认证操作串行/取消并检查生命周期代次；旧连接晚结果不得重新注册工具。关闭等待刷新凭据和子进程释放；会话重载只保留宿主层对象引用，不复用失效扩展上下文。
- 浏览器协议由 protocol 定义，不将 Node 包类型作为浏览器运行时依赖；不预建多后端框架，未来按官方接口能力再评估替换。

## 4. 开发阶段出口

阶段排序见 roadmap。本次首先交付独立包与隔离配置基础：路径/类型/校验/读取合并/安全保存与单元测试，不提前装配运行时，不声称 MCP GUI 已可用。后续分别交付管理运行时与 Pi 工具桥接、OAuth/宿主与 GUI，细节在进入相应阶段前补充。

## 5. d1 实施与验证记录

- 新增源码直引的 `@huan/mcp`，固定隔离路径、配置类型/校验/合并、scope 存储与整份原文保存；依赖锁只新增 workspace importer，使用官方 1.4.0 包。配置类型来自 SDK 根入口，首期尚不调用 pi-mcp 连接 API。
- 选择性移植发布包 source map 中的配置与服务器校验规则，来源路径、SHA-256、tarball integrity 与 MIT 版权在包内 THIRD-PARTY-NOTICES 记录并核对；未移植 registry/TUI/协议客户端。测试为本地边界回归，未宣称已经移植上游测试。
- 主 agent 独立 review 修复非法运行时 scope 绕过信任、timeout 数值溢出，以及保存结果未经确认却宣称原文件不变的措辞；补短读、stat后增长和未信任不执行文件I/O的确定性回归。
- 现有无效 UTF-8 文件不做有损解码，返回 readError 且不允许直接覆盖，须外部修复；坏 JSON/语义错误原文可通过 revision 编辑修复。允许显式 agentDir/cwd 根为符号链接，受管子目录及目标拒绝符号链接。保存校验拒绝新提交的已知错误，加载仍逐项跳过无效服务器。
- 主 agent 亲跑：配置53项通过、2项POSIX权限测试在Windows跳过；配置+认证定向68项通过、2项跳过；最终全仓 `pnpm check` 49文件813项通过、2项跳过，`pnpm build`通过（保留既有大chunk提示）。一次全仓执行曾在既有provider-auth用例的hasConfiguredAuth断言失败，相关定向和随后完整复跑通过；本次未改认证实现，偶发原因未确认。
- 本阶段未改变宿主/UI装配，未重跑Chromium，沿用此前63条通过记录；不将其表述为本轮新验证。后续项目配置接入须补 `.huan/mcp.json` 信任检测，当前存储API只接受调用方明确的信任结论。

## 6. 验证与回退

全部用临时目录与合成配置；给 Pi 文件写 sentinel，验证加载/保存均不使用、不改变它们。覆盖信任拒绝、用户项目覆盖、命名碰撞、exposure 通配、无效条目隔离、秘密不进入错误、超限/BOM/坏 JSON、并发旧 revision、未知字段、临时文件清理与 symlink 拒绝。使用官方 pi-mcp 公开 API 的类型边界；无私有导入、无凭据/个人会话访问。

主 agent 独立 review/修复，亲跑定向测试、全仓 check/build；配置基础不改变 GUI，无需为此重跑完整浏览器。后续装配运行时阶段须加真实本地 MCP 服务与浏览器成功/失败/取消/多窗和回收测试。每小阶段完成立即本地提交，不 push。若移植范围或生命周期设计出现阻塞，暂停并讨论。回退可移除未被宿主消费的包；新文件不迁移或更改 Pi 文件。
