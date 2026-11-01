# G1.4c 模型认证

日期：2026-11-02。范围 MOD-02，阶段设计见[配置/资源/认证/MCP](2026-11-01-feat-configuration-resources-auth-mcp.md)，状态见 [roadmap](../../roadmap.md)。

## 设计

1. 用共享 ModelRuntime 的公开 getProviders/getProvider、listCredentials、getProviderAuthStatus、login/logout 接口。不读取/返回 auth.json 原文；API key 与 OAuth 保存在既有选定 agentDir/auth.json。仅暴露 provider ID/名称、可登录方法、已存凭据类型与安全状态，不通过 getAuth 读取密钥。logout 不声称清除环境变量/models.json 或撤销远端凭据。
2. 单独宿主认证操作 broker：操作身份、provider、阶段、进度/授权 URL/device code、当前 prompt（text/secret/select/manual_code）、完成/失败/取消、安全错误。start 返回后异步 login；查询/订阅恢复进度，多窗可接管；同 provider 登录/退出互斥，不改变当前运行模型。prompt 回填只进入内存 resolver，不在快照、事件、日志或普通消息保存提交值；secret 用密码输入且关闭后清空。
3. AuthInteraction.signal 与 per-prompt.signal 都接入取消；全程取消、单步回填幂等，回调抢先完成的 prompt 立即失效。宿主 dispose abort 并排空，不允许晚结果反活。鉴权/Origin/Host 与现有 API 相同，POST 正文小上限，URL 只允许 http(s)，页面打开链接由用户点击，不让宿主自动打开浏览器。
4. 原始 provider 错误可能含密钥/回填 URL，不进入普通日志/事件；仅返回受控分类与可重试提示。CredentialSynchronizationError 要明确“凭据可能已保存，但本地状态同步失败”，不能自动重试登录/覆盖。取消与持久化提交点竞态须正确表示：以 SDK 返回/明确存储状态确认，不能刚成功又被取消误标丢失。
5. 认证结束后本地安全刷新模型目录/就绪度并广播可用性版本，各窗模型选择器与 host status 更新；不自动选模型/联网付费请求。GUI 顶栏/命令面板有认证入口，/login [provider] /logout [provider] 打开同一面板，provider ID 按目录验证，不发送给模型。无凭据/ambient-only 方法明确说明。
6. 复用 AuthInteraction 的类型通过 Parameters<ModelRuntime['login']> 推导，若需 pi-ai 类型只能显式依赖公开根入口；禁止SDK私有深导入。模块拆独立 provider-auth.ts，host.ts仅接线。UI Base UI Dialog，关闭视图不终止登录，显式取消按钮；后续重开能看到状态。

## 验证

临时 agentDir，公开原生合成 provider 扩展或可注入安全测试边界模拟 API key、OAuth auth_url/device_code/manual_code/select，真实 ModelRuntime 持久化与重启恢复、logout、取消、prompt.abort 回调抢先、同provider互斥、多窗接管、坏凭据写盘失败、synchronization错误与敏感值不进入快照/日志/普通消息。网络只本地，禁止个人凭据/真实provider/付费请求。HTTP 响应校验与非法/超限/过期ID，浏览器成功/取消/回填/退出及关闭重开，主 agent 独立review直接修复亲验 check/build/完整浏览器后提交 c，再 d。

## 回退与风险

凭据写入为 Pi 标准文件，由 SDK 管理锁与持久化；取消不承诺撤销已提交凭据。回退 c UI/协议不删除已存凭据。环境凭据不做读取输出；状态查询避免触发 secret command。provider 自定义 callback 可能不遵守 signal，broker 需界定晚结果并在销毁时不广播、不保活敏感输入。

## 实施与验证

- 独立认证 broker、协议13、typed HTTP/客户端、Base UI 面板与 /login/logout 已实现；凭据写入指定 agentDir，回填值只在 resolver 中传递，provider 错误受控投影。认证后只本地刷新可用性，不自动换模型。
- 主 agent 独立 review 后直接修复：取消宽限期过后但旧 SDK 调用未结算时仍保持 provider 互斥（登录/退出均 busy），补断言；disposed 后不启动可用性钩子；共享浏览器轮询移到订阅生命周期并在无人订阅时清理，支持宿主重启 seq 回退；模型区/host status 仅订阅认证版本，避免授权进度导致无关重渲染。
- 主 agent 亲验 pnpm check：46 文件/760 项、lint/全仓类型通过；pnpm build 通过（既有大 chunk 提示）。最终完整 Chromium 63 条全部通过，含认证4条、大列表、断流、多窗、重载和树导航。
- 自定义 provider 不响应 signal 时5秒后显示取消结果未确认，晚到成功/同步失败修正状态，但在 SDK 真正结算前不允许同provider新操作。logout 不清除环境/models.json/运行时凭据，也不撤销远端授权。
- 认证状态共享轮询活动约1秒、空闲约2秒，不新增长期SSE连接。文案363条，测试仅使用隔离空间与合成provider，不调用真实provider。
