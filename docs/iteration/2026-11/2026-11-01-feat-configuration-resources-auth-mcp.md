# G1.4 配置、资源、认证与 MCP

日期：2026-11-01。计划与阶段完成状态由 [roadmap](../../roadmap.md) 维护。

## 目标与分期

使设置、资源重载、模型认证及 MCP 管理在 GUI 完成。每个小阶段由 subagent 实施，主 agent 独立审阅、修复、亲验并本地提交，之后开始下一阶段。

| 小阶段 | 范围 | 能力 |
| --- | --- | --- |
| a 设置与资源清单 | 用户/项目设置读取、常用表单、JSON 编辑校验/冲突检测/保存；生效值与来源、已加载指令/模板/skill/扩展/packages 和诊断 | MOD-03、RES-01 |
| b 重载与内置装配 | 同会话 reload 生命周期、信任门控、旧交互结算、目录更新；codemode/tool-search/MCP 的公开内置工厂 | RES-03、RES-05 |
| c 模型认证 | provider 登录状态、API key/OAuth 浏览器授权与回填/取消/退出，选定 agentDir 持久化 | MOD-02 |
| d MCP 管理 | 配置/连接/工具资源、启停/暴露/重连、OAuth 和生命周期 | MCP-01～05 |

这些阶段顺序处理依赖，保留既有会话、工作区与断流语义。公开 SDK 不足以实现某操作时记录具体缺口并讨论；不能用未公开源码深导入或将管理命令发给模型代替。

## SDK 1.4.0 调研

- 根入口公开 SettingsManager、ResourceLoader、getPackageDir、ModelRuntime、createMcpExtension/createCodemodeExtension/createToolSearchExtension。settings schema 随包分发于 schemas/settings.schema.json；SettingsSchema 本身未从根入口导出。
- SDK 的 SettingsManager 不自动校验所有字段，也没有任意 JSON 的统一 setter。常用 setter 只能覆盖部分字段；GUI 原文编辑需要独立校验与持久化，保留未知字段。
- SDK AgentSession.reload 先 session_shutdown、invalidate，再 settings/loader reload，最后 session_start；它没有重新传 resolveProjectTrust。宿主必须保证 reload 的信任边界。
- MCP 工厂能注入 transport/config/credentials/openUrl，但公开返回值仅 ExtensionFactory，无独立 manager API；/mcp 的非 TUI 路径支持状态、login/logout/reconnect，启停/exposure 等管理能力需继续核实可复用边界。
- llama 扩展的 factory 未从 SDK 根导出；用户已确认排除 llama.cpp 专用管理（MOD-05），无需接入该扩展。

## 范围决定

用户确认 MCP 内建方案仅使用官方实现，排除第三方 MCP 替代品；llama.cpp 专用管理不在 huan 范围内。MCP 剩余路线为补 Pi 上游公开管理接口，或基于官方 `@earendil-works/pi-mcp` 维护 huan 集成层，决策状态见 roadmap。两条路线均须满足能力规范，不以解析终端状态文本或私有深导入替代公开管理接口。

## 验证与边界

自动化只使用隔离临时用户空间、合成 provider 和本地 MCP/auth 服务。每阶段包含协议/HTTP 校验、真实 SDK 集成、浏览器成功/失败/取消/多窗测试及 pnpm check/build。不得读取个人 auth/sessions，不调用付费模型，不 push。维持 Base UI、中文注释、minimumReleaseAge 和刷新性能边界。
