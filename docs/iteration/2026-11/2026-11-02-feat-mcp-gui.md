# G1.4d4 MCP 管理界面与整体验收

日期：2026-11-02。接续[d3](2026-11-02-feat-mcp-auth-host.md)，状态唯一维护于[roadmap](../../roadmap.md)。本阶段完成MCP-01～05及RES-03/05剩余MCP子项。

## 1. 界面与交互

沿用现有紧凑Geist/Base UI/主题，不做全局重设计。顶栏“MCP”与`/mcp [login|logout|reconnect] [server]`打开同一面板，命令不发模型；server参数只选中/执行显式动作，未知值显示受控错误。空白页目标为所选起始cwd，可编辑共享配置但不建连接；live按固定threadId管理，不跟其他窗口选中目标漂移。

面板分服务器、配置、认证三部分：
- 服务器列表展示状态、scope/项目override、工具数/资源、认证资格与受控错误；选中项按需查询工具schema/instructions、资源/模板，不会自行执行工具或读取资源正文。临时启停/重连/服务器和单工具exposure显式标注“本会话”，忙/stale保持当前草稿并刷新权威快照。
- 配置按用户/项目切换，JSON原文编辑与常用新增/修改/删除入口共用同一草稿，不覆盖未知字段。允许用户直接编辑完整条目，支持stdio/HTTP模板，删除确认。持久enabled/exposure/toolExposure可通过保留未知字段的JSON更新实现，项目override只写允许三字段；扩展临时注册不能被当文件条目保存。原文可修复坏JSON，错误/冲突保草稿；只显式重新读取才覆盖对应未改草稿或经确认丢弃。提示共享Pi影响、避免双方同时编辑、保存不应用；显式应用资源重载复用既有接口/代次。
- OAuth展示授权链接（用户点击、noopener）、回填URL、进度/取消/退出与终态；秘密回填提交后立即清空。全局operations可跨窗口接管，关闭面板不取消，旧prompt不能重复提交。目标切换/卸载不把旧异步结果附着新面板；auth全局快照和target轮询串行可清理，无新增SSE，不在输入/token流上刷新面板/列表。

## 2. 状态与安全

只在面板打开或有活动认证时按需轮询；一个页面共享auth轮询，活动1秒/空闲2秒，target快照独立；seq回退按服务端重启清缓存，generation/target key拒绝旧响应。schema/instructions和配置原文不存全局消息或localStorage。配置草稿按target/scope在面板生命周期保留，显式切换不丢内容。

只调用d3协议接口，runtimeId+identity从最近快照获取，stale禁止自动重试原写操作。OAuth URL仅http(s)，回填只走respond；错误不转发原始服务器异常。无runtime时管理按钮禁用并说明。资源目录读取失败不清空配置/认证状态；服务端文本按普通文本渲染，不能作为HTML执行。

## 3. 验证与回退

1. 主agent独立review状态所有权/多窗/取消/草稿并修复；type/lint/Lingui/build和全仓check。
2. 隔离e2e本地stdio与OAuth/HTTP fixture：GUI新增/修改/删除配置、外部revision冲突、未信任项目拒读、保存≠应用、重载调用、动态工具、临时/持久exposure、busy/失败恢复、OAuth链接+回填+取消重开+退出、第二窗口接管和旧prompt拒绝、reload/dispose进程回收。成功调用必须由实际SDK/fixture支持，不能用HTTP mock替代。
3. 全部Chromium回归（含性能/多窗）；截图只记录并亲自查看后再声明视觉审阅，至少明暗主题主面板/配置/认证，检查溢出/焦点/键盘。测试不得访问个人配置/付费模型，开发用户8799/8788服务不动。
## 4. 实施与验证记录

- 新增Base UI MCP面板（服务器/配置/认证）、共享JSON与常用表单唯一草稿、顶栏与/mcp命令意图；静态状态不发prompt，临时管理/保存/reload明确分开，OAuth跨窗回填/取消/退出沿用d3独立快照。新增本地stdio与OAuth/HTTP e2e fixture，网络只放行明确loopback来源。
- 主agent独立review修复：新增/重命名同名条目误覆盖、stdio参数trim丢空值、JSON深度/保留键预检、服务器/认证视图提前读取秘密原文、干净草稿重开不更新、同目标重开迟到认证结果、无资源/hidden/disabled详情误请求资源而整页失败、默认sm:max-w-lg覆盖宽屏布局；单工具临时exposure同步发现激活与系统段。补纯函数、SDK与浏览器回归，未削弱旧断言。
- 主agent亲验最终 `pnpm check`：65文件983项通过、2项平台权限跳过，lint/全仓类型通过；`pnpm build`通过（既有大chunk提示）；Lingui413无missing。一次完整check触发既有provider-auth.test.ts:663的hasConfiguredAuth偶发断言，定向与随后完整check通过，未改旧断言/认证实现，原因未确认。
- 主agent亲跑6条MCP定向通过；完整Chromium采用独立产物目录 `HUAN_E2E_OUTPUT_DIR=test-results/mcp-final pnpm test:e2e`（个人绝对路径已替换为示例路径）：69条全部通过（含既有性能/断流/多窗）。覆盖配置保存不连接、实际工具/资源调用、动态工具、临时/持久暴露、PID重载回收、连接失败修复与无资源目录、未信任/冲突/非法草稿、项目override/删除确认、OAuth链接/回填/多窗/旧prompt/取消重开/错误恢复/退出/busy。
- 默认输出目录完整执行曾出现Chromium崩溃、500与trace文件消失，基础UI定向通过；重复默认全套仍有文件消失，加入可选独立outputDir后完整通过。未据此宣称已查明原因或修复Chromium平台问题；应用/测试断言未因环境错误放宽。用户开发8799/8788服务未停止。
- 生成服务器明暗、配置、认证与无资源详情截图，DOM溢出断言通过；当前read工具明确禁用图片读取，因此未做截图视觉审阅。此限制不阻塞开发完成；截图不作为视觉通过证据。

### 能力验收证据

| 能力 | 本轮与前序证据 |
| --- | --- |
| MCP-01 | d1安全共享配置、d2实际stdio/HTTP、d3认证；GUI新增/保存/reload/无服务器/失败修复 |
| MCP-02 | 动态目录、工具/资源详情、实际SDK调用与分页模板、e2e工具/资源成功 |
| MCP-03 | 服务器/工具临时exposure、启停/重连、JSON持久字段与项目override、busy/stale |
| MCP-04 | 官方OAuth实际loopback/回填/state/issuer/刷新/scopes，GUI多窗接管/取消/重开/失败/退出 |
| MCP-05、RES-03/05 | GUI配置维护/revision冲突、显式资源重载、会话生命周期PID回收、named builtin替换及权限/嵌套管线 |

共享定义的跨进程编辑不承诺CAS；凭据/日志独立，logout不承诺远端撤销。文件快照/回滚与llama专用管理不在本阶段范围。开发完成状态以roadmap为准。
