# 第三方代码声明 — @huan/mcp

本包在 G1.4d1 中移植了 `@earendil-works/pi-coding-agent@1.4.0` 的 MCP
配置相关逻辑，并在 G1.4d2a 选择性移植连接、重试、动态目录与配置值解析规则。
移植内容按 MIT 许可保留版权声明。huan 不 fork Pi，也不从私有 dist 内部深导入；
配置类型、`getShellConfig` 与连接客户端均通过公开入口使用。

## 上游项目

- 包：`@earendil-works/pi-coding-agent`
- 版本：`1.4.0`
- 仓库：https://github.com/earendil-works/pi
- npm tarball integrity（来自 pnpm-lock.yaml）：
  `sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==`

### 移植来源与指纹

以下文件由发布包 `dist` 的 source map 提取，用作移植核对；SHA-256 为提取文本的
实际字节指纹：

| 上游源路径 | SHA-256 |
| --- | --- |
| `packages/coding-agent/src/extensions/mcp/config.ts` | `950e308e9f507080eb2c25b1dd69e7917a573bd9f72911444f53f4e3cfd6a140` |
| `packages/coding-agent/src/core/mcp-servers.ts` | `0aaad23b26f31f743bdd117754f4c871ea821279bf68f8ba5d71eccbb1602c6a` |
| `packages/coding-agent/src/extensions/mcp/runtime.ts` | `f2bf62f39179e2d956df3783f1d561667c589afd6f6ee94ebdaeaf6b22de154c` |
| `packages/coding-agent/src/core/resolve-config-value.ts` | `0f53dad47fe5d5d8837c022b7951ccd3bd5a9b577bd662f0986272110e83bcc7` |

另外参考但未直接复制运行时实现的路径：

- `packages/coding-agent/src/utils/text.ts`（BOM 剥离；本地为等价的一行实现）
- `packages/coding-agent/src/config.ts`（仅参考项目配置目录概念；本地与 Pi 一致使用 `.pi`）
- `packages/coding-agent/src/utils/shell.ts`（只通过公开 `getShellConfig()` 取得 shell
  配置，不复制其同步执行逻辑）

## 本地差异

### 配置（G1.4d1）

1. 用户/项目配置与 Pi 共用 `<agentDir>/mcp.json` 与 `<cwd>/.pi/mcp.json`，保留原文
   与未知字段；不读取、不迁移、不修改旧隔离路径 `huan/mcp.json` / `.huan/mcp.json`。
   OAuth 凭据与日志路径仍为 `<agentDir>/huan/mcp-auth.json` / `mcp.log`（本阶段只定义），不读写 Pi 的
   同名认证/日志文件。
2. 项目配置是否读取由调用方显式传入的 `projectTrusted` 决定，不以文件存在代替信任。
3. 保留 `mcpServers`、`autoEnableCodemode`、exposure 通配/别名、namespace 规范化、
   项目完整条目替换、`enabled`/`exposure`/`toolExposure` 三字段 override、逐项诊断、
   未知字段保留和项目 `auth.provider` 限制。
4. 增补：512 KiB UTF-8 有界读取、BOM 支持、实际字节 SHA-256 revision、拒绝无效
   UTF-8、原型污染键与嵌套深度检查、目标文件与 `<cwd>/.pi` 组件的符号链接拒绝
   （根 agentDir/cwd 符号链接仍允许）、同目录 `wx` 临时文件（0600）+ rename + 回读、
   单进程规范化路径写队列、强制 `expectedRevision`。revision 只检测读取后已发生的
   修改；与 Pi 同时编辑同一文件没有共同锁协议，不提供跨进程 CAS。
5. JSON 解析错误只保留位置，不回显可能包含秘密的原文；服务器校验错误不回显配置值。
6. 上游 `errors: string[]` 改为结构化 `McpConfigIssue[]`；读取结果与合并结果不再
   返回项目原文给普通快照调用方。
7. 本阶段不提供 `updateMcpServerConfig`/`addMcpServerConfig`/`removeMcpServerConfig`
   的条目级编辑；整份原文保存已能保留未知字段，条目编辑留待后续 GUI 阶段设计。

### 连接（G1.4d2a）

1. 新增每会话独立的 `McpConnectionManager`，构造只校验并克隆已通过配置校验/信任
   门控的条目；不读盘、不解析 `!command`、不创建 transport。显式 `start()` 后连接。
2. 使用官方 `@earendil-works/pi-mcp@1.4.0` 的 `McpClient`、`StdioTransport`、
   `StreamableHttpTransport`；测试另用公开 `@earendil-works/pi-mcp/testing` 内存
   transport。未复制 pi-mcp 的协议实现。
3. 管理快照只含身份、scope/source、启停/exposure、数量、摘要 revision 与受控错误码；
   不含 URL、env、headers、tokens、stderr 或原始异常。工具目录与 instructions 通过
   独立 Node 内部查询供后续 Pi 桥接使用。
4. opening 单飞；管理操作串行，但禁用/关闭立即失效并中止进行中的连接与请求。
   所有 client 的完整 `close()` promise 被记忆，避免官方第二次 `client.close()`
   在 transport 尚未关闭时提前完成；关闭等待慢初始化子进程与孙进程回收。
5. 动态 `notifications/tools/list_changed` 串行合并刷新，旧 client/旧代次结果被丢弃；
   刷新失败撤下无法确认的工具目录，连接状态保留受控错误码。
6. HTTP 连接瞬态错误按 250/1000ms 退避重试；只读资源/模板/读取最多额外重试一次。
   `tools/call` 没有应用层自动重试，HTTP 500/404（会话过期）也不重发，避免不明确
   副作用重复。
7. 取消覆盖等待连接与进行中的请求；取消后不再发送请求。per-entry timeout 夹在
   Node 定时器合法范围内，避免 Infinity/溢出被当成 1ms。
8. `env`/`headers` 在真正创建 transport 时解析 `$NAME`/`${NAME}`/`$$`/`$!` 与整值
   `!command`。命令改用异步、有界、可取消、10 秒超时的子进程，并通过公开
   `getShellConfig()` 解析 shell；不复制上游阻塞式 `execSync`/`spawnSync` 分支，
   也不做进程级结果缓存。构造与配置读取绝不执行命令。
9. auth 仅注入官方 `AuthProvider` 与可选 `settled`；`auth.provider` 通过动态回调
   每次请求读取 token，不缓存。401/额外 scope 投影为 `needs-auth`；本阶段不实现
   OAuth 凭据存储、登录流程或自动打开浏览器。
10. 临时启停与 exposure 只修改实例状态；持久化、Pi 工具注册、资源工具定义、
    core/harness 注入和 TUI 均留给后续阶段。

## 依赖说明

- `@earendil-works/pi-mcp@1.4.0` 是运行时依赖。G1.4d2a 使用其公开的
  `McpClient`、`StdioTransport`、`StreamableHttpTransport`、协议类型与 testing
  transport；没有私有深导入。npm tarball integrity：
  `sha512-92aZmmGsUpHHknYuKXZHRINQfahntw5hU9If0I0ZM49GojOaFHpkl5/GF3/aatqpt7v7GjZbBfpfSygGKW+pnw==`
- `@earendil-works/pi-coding-agent@1.4.0` 通过公开根入口使用配置类型与
  `getShellConfig`。

## MIT 许可原文

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
