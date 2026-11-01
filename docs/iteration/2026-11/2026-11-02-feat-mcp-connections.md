# G1.4d2a MCP 连接管理

日期：2026-11-02。能力为 MCP-01/02/03/05 的连接子项；计划状态仅由 [roadmap](../../roadmap.md) 维护。存储以[共享配置修订](2026-11-02-feat-mcp-shared-config.md)为准，本次不改配置位置。

## 1. 范围与出口

在 `@huan/mcp` 交付无界面、每会话独立的连接管理对象，使用官方 pi-mcp 客户端与 stdio/streamable HTTP transport。构造只初始化内存；显式 start 后连接启用服务器。提供状态订阅、目录查询、重连、临时启停/exposure、工具/资源请求与幂等关闭；实例不复用跨会话连接，不更改进程cwd。配置加载/保存与连接对象独立，不新增自动读盘路径。

本小阶段只在包内使用与测试，不注入 core/harness，不实现 Pi 工具注册（d2b）、OAuth凭据/登录（d3）、HTTP或GUI（d3/d4）。Node层工具请求入口供后续Pi桥接，不是对模型暴露的权限绕过通道，宿主不得将其直接注册为HTTP工具执行接口。

## 2. 设计

- 工厂接受显式 cwd、已经过配置校验/信任门控的条目快照，可注入 transport/auth provider/环境与输出解析上下文以便测试。所有输入克隆；start/目录查询/管理操作都有明确运行状态。配置与extension注册的优先级留给d2b，不以文件存在判断信任。
- 状态按 connecting/connected/disconnected/needs-auth/failed/closed/disabled 区分。管理snapshot只含服务器身份、scope/source、启停/exposure、数量、受控错误码与消息；不含URL、env、headers、tokens、stderr、原始异常或内容。原始目录（tools/instructions）仅通过独立Node内部查询供Pi桥接；订阅发布复制的权威状态，监听者异常不阻止其他监听者；目录变化可触发revision，旧快照不被后续原地修改。
- 每服务器连接opening单飞，重连/启停串行；销毁/禁用先立即失效并abort在途连接/请求，不能被排队操作或晚到列表重开。关闭追踪所有client/transport的完整close promise与在途任务，避免官方client.close第二次调用提前返回造成假清理。manager.close为终态，旧对象不能start；各条目失败互相隔离；namespace碰撞拒绝且不能静默覆盖。
- 官方行为作为起点：tools capability存在才listTools，resources列表按需读取；动态tools/list_changed刷新串行/合并处理防旧结果覆盖，failed刷新撤下不可确认目录。断线下次调用可重连。HTTP连接瞬态错误（408/429/5xx但不含501、网络TypeError）可按250/1000ms重试；读取资源类最多额外重试一次；tools/call无应用层自动重试，避免不明确副作用重复。404会话过期也不在本阶段自动重发tools/call。取消应覆盖等待连接和请求，不能在取消后发送请求。
- stdio cwd相对会话cwd，~/~展开与官方一致，command/args不是shell串；env/header支持$NAME/${NAME}/$$/$!与整值!command。只在真正建立transport时解析，解析失败受控，不回显秘密。!command用异步有界可取消子进程（10秒、输出上限），借助SDK公开getShellConfig而非私有导入，按cwd运行并回收；不照搬上游阻塞execSync。环境与headers已解析值不进入快照。auth.provider经注入回调每请求取token（不缓存），OAuth仅注入公开AuthProvider及可选settled，不存盘；401/要求额外scope投影needs-auth，绝不自动打开浏览器。
- 请求timeout依据条目，限于Node定时器合法范围，不允许Infinity/溢出引发1ms误超时。基础connection timeout限制初始化/发现。资源分页/模板MethodNotFound空返回，资源/模板查询工具退避等待可取消。工具元数据与server instructions为不可信服务端数据，仅做目录传递，不执行。动态列表或连接事件不得泄露配置值到错误。
- 临时管理仅改实例，持久化由后续core调用配置store协调；exposure保留单工具覆盖优先语义。disabled/hidden服务器不得被普通调用重新连上；资源可用性按有效server/tool exposure供桥接判定。所有管理入口不得生成第二套探测连接。

## 3. d2a 实施与验证记录

- 新增 manager/connection/config-values 及内存、真实本地 HTTP、真实 stdio/命令进程树 fixtures；未新增依赖、未注入core或GUI。配置存储维持共享服务器定义与独立认证/日志路径。
- 主agent独立review修复：重连失败被吞、启动旧代次关闭新连接、禁用/启用期间普通调用拿到旧connection、发送前exposure复查、目录revision重建单调性与初始化期间通知丢失；服务端索引改Map，避免逐调用扫描全部服务器。
- 修复公开OAuth工厂与显式Authorization/provider配置优先级、官方OAuth需授权异常识别；增加transport外层幂等close追踪，覆盖SDK内部connect失败自行关闭的路径，且不修改注入transport本体（避免内存transport对端互相close死锁）。close先发布终态资格与promise，避免监听回调重入。
- 默认命令执行器按块积累有界stdout，取消/超时等待child close和Windows taskkill整树回收；补真实shell子孙PID退出、超时、等待token取消不发请求、初始目录通知、exposure版本、重连失败/启动竞态和close重入回归。测试曾捕获禁用启用旧connection竞态，修复后全套通过；未削弱原断言。
- 主agent亲验：MCP包8文件117项通过、2项平台权限测试跳过；全仓 `pnpm check` 54文件877项通过、2项跳过，lint/全仓类型通过；`pnpm build`通过（既有大chunk提示）。最后close重入顺序调整后再次亲跑117项定向通过。未改GUI，未重跑Chromium；此前63条记录不作本轮新证据。
- 真实transport与命令fixture使用临时空间/loopback，测试结束未发现本轮vitest或MCP fixture残留进程；未访问个人凭据/会话。现阶段auth仅注入，不宣称OAuth持久化、日志管理或Pi工具权限桥接已完成。d2b仍需真实SDK工具管线验证。

## 4. 移植与验证

选择性移植 Pi 1.4.0 runtime.ts 的连接、重试、目录刷新与资源调用规则，及 resolve-config-value.ts 的值解析；删除私有目录、TUI和同步shell依赖。更新包内THIRD-PARTY-NOTICES：来源文本SHA256、许可与行为差异；不复制协议实现。

用临时目录/本地HTTP和真实stdio子进程验证真实MCP初始化、工具调用/进度、资源分页/模板、断线重连、tools变更通知、needs-auth、瞬态连接/只读重试、取消后不发送、请求副作用不重试、运行中关闭及子进程回收、慢初始化关闭、并发重连/禁用/晚结果、隔离失败与snapshot无秘密、只构造不连接、值解析与取消。竞态可用官方testing内存transport定序，但不能替代真实transport测试。无个人配置/凭据或付费模型请求。

subagent实施，主agent独立review/修复、亲跑定向与全仓check/build；不改UI故本小阶段不重跑Chromium。验证和文档完成立即本地提交，再启动d2b。包未被宿主使用，回退移除新增运行时入口即可，不迁移用户文件。如发现需要改变生命周期或扩大范围，暂停讨论。
