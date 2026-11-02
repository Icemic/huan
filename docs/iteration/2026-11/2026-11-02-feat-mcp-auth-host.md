# G1.4d3 MCP OAuth 与宿主管理接口

日期：2026-11-02。计划与状态见[roadmap](../../roadmap.md)。接续[d2b](2026-11-02-feat-mcp-pi-bridge.md)，存储以[共享配置修订](2026-11-02-feat-mcp-shared-config.md)为准。

## 1. 范围与接口

本阶段交付官方pi-mcp OAuth之上的凭据/刷新/登录协调、独立日志、core管理broker、protocol/HTTP/typed client接口。d4再提供界面与浏览器整体验收。只使用SDK/pi-mcp公开入口，不接入官方内置MCP，不新增协议客户端或第三方adapter。

- `@huan/mcp` 提供OAuth service：按显式agentDir创建，凭据固定 `<agentDir>/huan/mcp-auth.json`，按规范服务器名+完整URL隔离；不读取Pi凭据、不迁移历史。并发文件写入沿用安全有界I/O/同进程路径队列/原子rename，拒symlink、坏文件不覆盖。单宿主内跨会话共享每身份的刷新/登录/退出锁；多进程强事务不承诺，不把锁命名伪装成跨进程CAS。
- 选择性移植上游OAuth协调，PKCE/discovery/DCR/CIMD/refresh/state/issuer校验使用官方库。用户点击授权页，不自动开浏览器；loopback与回填重定向并存，严格origin/path/state校验。clientSecret只在实际运行解析，命令解析可取消；OAuth请求15秒有界，取消必须关闭callback。刷新不因工具取消丢失轮换token，关闭等待保存；logout/新登录不能被旧刷新晚结果覆盖。
- 配置无Authorization和无auth.provider的HTTP连接注入OAuth provider；静态header/provider仍优先。needs-auth保留challenge供显式登录，scope追加保持官方语义。成功登录/退出只对同identity的live manager进行就绪刷新/重连，不能自动替换配置或模型；认证存在宿主域，关闭页面不取消，reload/删除目标使旧操作取消或失效，不把结果附着新identity。
- 日志只接收MCP notifications/message，固定huan路径、0600、新目录0700、单条有界与5MiB轮换；原始服务器数据可能含秘密，普通快照不含日志文本/原始异常，显式日志查询也只提供受控状态/路径而不自动公开原始内容。

## 2. 浏览器契约与准入

新增 `protocol/mcp.ts`（无Node依赖）与HarnessClient：getMcp(target)、get/saveMcpConfig、manageMcp、get/start/respond/cancelMcpAuth/logoutMcp。target沿用threadId/workspacePath恰一。查询冷会话/空白页只读配置/已存在binding，不为面板启动探测连接、不新建会话；runtime管理仅live manager可用。配置原文/含秘密只显式编辑查询返回，不进普通快照。工具schema/instructions及资源目录在显式详情查询时提供，普通列表只摘要。配置编辑整份JSON保留未知字段，支持user/project；已有save revision/信任检查复用。

管理以预期运行时generation和服务器身份校验，返回 stale/busy/unavailable/failed，不把重载后新manager当作原目标。临时enabled/exposure/toolExposure与持久保存分开；工具精确exposure通过manager临时方法，持久编辑用原文保存（GUI可安全JSON保留未知字段并加project override）。重连/启停/OAuth受结构/运行准入，运行中禁用或改暴露拒busy，避免改变已验证工具语义；查询与取消OAuth不受busy限制。重连可有界后台操作并通过轮询状态查看，不能启动另一套连接。

认证快照独立于普通Host UI/消息，只含operationId/server/phase/授权链接/回填prompt/受控终态，无token/clientSecret/PKCE verifier/回填值。操作ID与promptID一次领取、多窗可接管；取消保持cancelling直到真实流程settled，已确认提交以真实结果为准。每身份互斥、终态记录有界；错误受控，URL只http(s)，回填上限8KiB。全局auth seq及target runtimeId使多窗失效可恢复，不增会话SSE流量。

HTTP单独mcp-routes模块，沿用Host/Origin/token；配置正文上限768KiB（原文512KiB），普通管理/认证16KiB。运行态契约与SDK工具schema序列化JSON-safe。typed client完整覆盖，不把Node包导入浏览器。协议版本升14，所有fixture与握手断言同步。

## 3. 实施与验证记录

- `@huan/mcp`新增OAuth service与日志，选择性移植Pi1.4.0协调，官方库执行OAuth协议；core注入宿主共享service/log，独立mcp-host broker与协议14/HTTP/typed client交付。配置原文仅显式读取，冷目标不启动连接，管理使用唯一live manager并校验runtimeId+identity。
- 主agent独立review修复：OAuth默认fetch提前捕获绕过后续网络隔离、回填error_description泄露原始错误、凭据写入超限缺检查、日志UTF-8边界及目录换symlink检查、退出读凭据期间多窗互斥竞态；登录成功改为遍历同身份live目标，空闲重连/忙时标记，不因旧目标invalidated重新连接。补多窗退出与多会话回归。
- 主agent亲跑定向196项通过/2项平台跳过；最终全仓 `pnpm check`：64文件976项通过、2项跳过，lint/全仓类型通过；`pnpm build`通过（既有大chunk提示）；现有63条Chromium全部通过。OAuth本地真实HTTP验证callback/回填/state/issuer/取消/刷新轮换/scope/退出及端口回收；core/HTTP验证busy/stale/信任/revision/多窗/生命周期和无Content-Length正文上限。
- 无新增GUI，未做MCP界面验收或截图视觉审阅；d4继续完成。全程临时用户空间/本地服务/合成模型，无个人凭据/会话与付费请求。默认日志可能包含服务器发来的任意data，只作本地文件，不进入普通HTTP快照。跨进程CAS与远端logout撤销不作保证。


## 4. 验证、风险与回退

1. 官方OAuth配合本地authorization/token/resource服务器，验证PKCE/state/issuer、真实loopback与粘贴回填、刷新单飞与轮换、额外scope、401、登录失败/取消/重开/退出、callback端口回收、错服务器/URL隔离、损坏文件/symlink/并发保存、日志轮换/有界与普通快照无秘密。
2. core+HTTP验证正确target、冷目标不建连接、busy/stale/generation、保存冲突/信任/不自动应用、同identity跨会话登录刷新、多窗一次回填/取消、reload/dispose旧结果不重连、body无content-length上限及Host/Origin/token。
3. 主agent独立review修复并亲跑相关定向、全仓check/build；d3无界面变更但协议/会话行为改变则跑现有Chromium。文档更新后本地提交，再启动d4。依赖minimumReleaseAge保持，不访问个人凭据/会话，不发付费模型请求。
4. 回退core注入与接口即可停用，不改Pi文件；新认证文件保留但不会被Pi消费。不承诺logout远端撤销或多进程并发强一致。若公开库无法保持安全状态/生命周期，暂停讨论，不私有深导入。
