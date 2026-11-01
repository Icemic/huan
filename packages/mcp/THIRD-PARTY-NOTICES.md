# 第三方代码声明 — @huan/mcp

本包在 G1.4d1 中选择了 `@earendil-works/pi-coding-agent@1.4.0` 的 MCP 配置相关
逻辑进行移植，并按 MIT 许可保留版权声明。huan 不 fork Pi，也不从私有 dist 内部
深导入；配置类型只通过该包的公开根入口使用。

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

另外参考但未直接复制运行时实现的路径：

- `packages/coding-agent/src/utils/text.ts`（BOM 剥离；本地为等价的一行实现）
- `packages/coding-agent/src/config.ts`（仅参考项目配置目录概念；本地固定为 `.huan`）

## 本地差异

huan 只移植配置阶段需要的内容，并针对隔离存储做了以下调整：

1. 路径改为 `<agentDir>/huan/mcp.json` 与 `<cwd>/.huan/mcp.json`；不读取、不迁移
   或修改 `<agentDir>/mcp.json`、`<cwd>/.pi/mcp.json`、`mcp-auth.json`、`mcp.log`。
2. 项目配置是否读取由调用方显式传入的 `projectTrusted` 决定，不以文件存在代替信任。
3. 保留 `mcpServers`、`autoEnableCodemode`、exposure 通配/别名、namespace 规范化、
   项目完整条目替换、`enabled`/`exposure`/`toolExposure` 三字段 override、逐项诊断、
   未知字段保留和项目 `auth.provider` 限制。
4. 未移植 `McpServerRegistry`、扩展注册、连接协调、工具/资源、OAuth 流程或 TUI 交互；
   这些属于后续阶段，本包不预建运行时架构。
5. 增补：512 KiB UTF-8 有界读取、BOM 支持、实际字节 SHA-256 revision、拒绝无效
   UTF-8、原型污染键与嵌套深度检查、读取/保存的符号链接拒绝、同目录 `wx` 临时文件
   （0600）+ rename + 回读、单进程规范化路径写队列、强制 `expectedRevision`。
6. JSON 解析错误只保留位置，不回显可能包含秘密的原文；服务器校验错误不回显配置值。
7. 上游 `errors: string[]` 改为结构化 `McpConfigIssue[]`；读取结果与合并结果不再
   返回项目原文给普通快照调用方。
8. 本阶段不提供 `updateMcpServerConfig`/`addMcpServerConfig`/`removeMcpServerConfig`
   的条目级编辑；整份原文保存已能保留未知字段，条目编辑留待后续 GUI 阶段设计。

## 依赖说明

- `@earendil-works/pi-mcp@1.4.0` 已声明为运行时依赖，计划用于后续连接阶段；G1.4d1
  没有复制或调用其代码。npm tarball integrity：
  `sha512-92aZmmGsUpHHknYuKXZHRINQfahntw5hU9If0I0ZM49GojOaFHpkl5/GF3/aatqpt7v7GjZbBfpfSygGKW+pnw==`
- `@earendil-works/pi-coding-agent@1.4.0` 仅通过公开根入口使用配置相关类型。

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
