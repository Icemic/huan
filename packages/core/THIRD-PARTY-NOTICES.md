# 第三方许可与来源

本文件记录 `@huan/core` 中复用第三方源码的许可、来源与本地差异。新增或修改
复用时必须同步更新本文件。

## pi-workspaces

- 项目：pi-workspaces
- 作者：Stephen Zhang
- 来源：https://github.com/zhang-stephen/pi-workspaces
- 固定提交：`3d97e7acfafd92e737907a5453c16013a9f9dc1f`
- 上游版本：0.1.2
- 许可：MIT

### 本地使用范围

- `src/workspace-path.ts`：`@别名` 路径解析、路径比较键、词法包含检查与所属
  成员选择，参考并改写自上游 `src/path-resolver.ts`。
- `src/workspace-tools.ts`：文件工具委托与 bash `cwd` 参数的适配方案，参考并
  改写自上游 `src/tools.ts`。

只保留 huan 工作区所需的纯路径与工具适配；不加载上游插件，不复用其定义存储、
会话关联、自动激活、TUI 命令、状态栏、补全与首次触达注入逻辑。

### 本地差异

- 路径语法使用工作区成员的 `alias`（`@alias/path`），不沿用上游的 root 名称。
- 文件工具与搜索工具委托给 Pi 1.4.0 公开导出的 `createXxxToolDefinition`，
  不复制工具主体；SDK 内置的文件写入串行化、截断与渲染保持生效。
- bash 显式 `cwd` 通过克隆工具上下文并替换 `cwd` 实现，保留 `PI_*` 会话环境
  变量；上游在该分支丢弃上下文，导致变量被删除。
- 项目指令在 `before_agent_start` 按成员注入并标明路径范围；跳过 SDK 已从
  会话起始目录加载的同一指令文件，不采用上游的首次触达注入与会话根回退规则。
- 不包含上游的工作区定义校验、`<agentDir>` 扫描与 `pi-workspaces:active`
  自定义会话条目。

## MIT License

```text
MIT License

Copyright (c) 2026 Stephen Zhang

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
```
