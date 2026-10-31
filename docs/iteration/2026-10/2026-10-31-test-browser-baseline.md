# 浏览器验证基线

- 日期：2026-10-31
- 分类：test
- 范围：G1.1 的页面验收，后续 G1 的浏览器回归基础

## 目标与设计

采用 Playwright Test 验证真实页面、HTTP/SSE 路由和 Pi SDK；通过项目级 Playwright MCP 支持开发助手交互检查。临时用户空间、合成模型与可控响应复用现有 core 测试辅助。仅抽取必要的服务器路由注册供生产和测试启动共用，不增加生产 testMode。

测试启动器启动隔离宿主和 Vite，默认模型故意失效，页面选择有效模型恢复。测试使用独立端口；关闭时释放服务器与临时目录。提供独立 `test:e2e` 和交互调试启动命令，保留失败截图和 trace；生成产物忽略入 Git。依赖固定版本并遵守 minimumReleaseAge。

## 验收

1. 空白页显示默认模型错误、目录及来源，选有效模型后可发送；验证复制摘要。
2. 新建、发送、切换及刷新后历史可读。
3. 回复期间连接断开再恢复，完成回复不遗漏或重复；保留确定性控制，不靠长时间 sleep。
4. 两页面订阅同一会话可同步，关闭其中一个页面不终止运行。

首期只运行 Chromium，不引入截图像素基准或多浏览器矩阵。页面可访问名称优先用于定位，必要时增加少量稳定标识。

## MCP

项目配置 `.pi/mcp.json` 使用固定版本的 Playwright MCP 与独立浏览器环境。验证连接和浏览器操作；当前会话若需要 `/reload` 才能看到工具，明确记录，并通过 Playwright 脚本完成本轮浏览器验收。

## 验证与回退

主 agent review 并直接修复问题，执行 `pnpm test:e2e`、`pnpm check` 和 `pnpm build`，检查截图及控制台。新增能力属于测试基础设施，可移除新增配置、脚本和依赖回退，生产路由抽取保持行为一致。

## 实施证据

- 状态：开发完成
- 主体编码：`opencode-go/deepseek-v4.1-flash` subagent；主 agent 直接 review、增加控制台/pageerror 断言并完成最终验证。
- 路由抽取为 `server/app.ts`，生产与浏览器启动器共用；隔离环境与模型解析复用 core/testing。分段模型响应在测试进程 fetch 中提供，通过控制端点释放，不额外维护模型服务。
- Playwright Test 固定 1.64.1，MCP 固定 0.0.83；依赖正常 pnpm 安装，未绕过发布龄。MCP 自带 Playwright 版本不同，通过小启动脚本指定测试安装的 Chromium 可执行文件，避免再下载浏览器。
- 主 agent 实测 `pnpm test:e2e` 四项通过，覆盖真实剪贴板、离线期间完成后快照补齐、关闭发起运行页面后另一页面完成。页面脚本与控制台 error 均为空。subagent 另报告 repeat-each=3 共 12 项通过，区别于主 agent 本次实际执行。
- 主 agent 实测 `pnpm check`：464 项 Vitest、全部类型检查通过；保留既有 sse-link 未使用 import 警告。`pnpm build` 通过，保留既有大 chunk 提示。
- MCP 经 stdio JSON-RPC 实际 initialize、tools/list（25 项）、browser_navigate、browser_snapshot、browser_take_screenshot、browser_close 通过。当前会话工具集需要 `/reload` 才能直接调用新增工具，本轮通过命令发出相同 MCP 请求。截图生成于忽略目录，当前环境禁用图片读取，未做截图视觉审阅。
- Windows 自动测试结束由 globalTeardown 清理临时空间；交互强杀可能留下 test-results/e2e 临时目录，开发指南说明手动清理。未改个人 MCP 配置、凭据、会话，未发模型付费请求。
- 审查发现当前页面对 system 消息可能投影空 assistant 节点、会话标题需刷新才能更新。测试按真实内容定位，未将这些既有呈现限制混入基础设施修改；后续会话管理及输出迭代按需求处理。
