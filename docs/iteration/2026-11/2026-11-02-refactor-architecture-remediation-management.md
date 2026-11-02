# R6：管理业务与面板接入

日期：2026-11-02。分类：refactor。基线：`d463ce2`。依据已确认R1/R2，状态见[子路线图](../../architecture-remediation-roadmap.md)，局部决定见[实施调整](2026-11-02-refactor-architecture-implementation-decisions.md)。

## 范围

设置/资源/reload、模型与Thinking/范围/Shell/压缩、provider/MCP认证与MCP配置管理、工作区信任/健康、会话管理/详情与树/fork/import、Host UI业务状态迁入应用feature Zustand，JSX只选择状态并触发动作。保留秘密按需读取、dirty原文、保存≠应用、后台认证与唯一manager、目标/面板/草稿版本。沿用现有Base UI和有效领域算法，删除旧aui/模块store依赖。

R6必须将实际管理入口挂回App；R7负责聊天/输入/工具/data最终组合与样式及剩余依赖清理。可按领域分包提交，避免单包重写全部UI。每包指定max worker实施，主agent独立review/修正/隔离验证后提交。

## 验证

正式feature测试覆盖成功/失败/关闭重开/迟到/dirty保存/秘密/认证继续，复用R0分层证据，不机械排列组合。typecheck按新入口检查，旧chat断点留R7。最终check/build/Lingui/e2e归R8，临时空间与本地fixture，不接个人/付费资源。文档全文零命中与diff检查后提交，回退以提交为单位。## R6a执行记录

worker实际local/deepseek-v4.1-flash/max，设置/认证/Host交互/信任与会话面板实际挂回App，业务进入feature store。主agent通读settings/auth/host状态及会话/信任异步路径，亲自修正Host待答索引二次遍历、关闭设置释放资源正文、重载后迟到刷新写新面板。亲验公共包和应用state测试通过；最终chat/MCP/runtime仍断开，全量验证继续R8。本包不将单独vite打包成功算完整构建。

R6b继续MCP、模型与运行管理。
