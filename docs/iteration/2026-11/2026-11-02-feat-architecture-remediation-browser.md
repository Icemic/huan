# R3：Zustand与浏览器运行时实施

日期：2026-11-02。分类：feat（实现已确认的浏览器API与状态模型）。基线：`9bcf157`。

## 1. 依据与范围

依据[R1](2026-11-02-feat-architecture-remediation-ownership.md)、[精简R2](2026-11-02-feat-architecture-remediation-protocol.md)及[复杂度审查](2026-11-02-refactor-architecture-design-complexity.md)。用户已确认R2并授权持续实施到R9，局部决定记录在[实施调整](2026-11-02-refactor-architecture-implementation-decisions.md)。步骤与AR状态唯一维护于[子路线图](../../architecture-remediation-roadmap.md)。

R3建立service/window Zustand状态、纯事件归约、连接资源及React selector接入，删除Controller/aui状态公开入口。覆盖AR-01～07/09～11/31/36/43的浏览器基础部分，保留其他AR的后续实施与验收。能力涉及ENV/SES目录、RUN-01/05/06/07与模型/认证查询基础，不新增产品范围。

## 2. 工作包

1. 公共浏览器基础：在现有react包建立service/window与资源所有者，重用纯事件算法，消除同义字段双存。完整快照清除可选旧值；agent_end保持运行到settled。连接按实际消费者引用计数释放，dispose不可复活，旧响应失效。
2. React与应用接入：Context只传实例，bootstrap显式创建client；移除旧runtime/Controller接入、模型草稿注入、DOM目录通知与模块bridge状态；应用feature的具体业务在R4/R6继续迁移，不建替代兼容API。
3. 正式测试：迁移归约与资源行为断言，保留历史测试中的有效要求。旧UI/业务消费者允许暂时报错，但不通过测试排除、@ts-ignore或占位方法隐瞒；尚未迁移的旧测试在记录中列出，R8接通。

实现允许按这些工作包提交WIP，子代理不自行提交。主agent逐包review、亲自修正并运行针对性验证后提交。R4负责提交/附件/分支业务；R5负责Node及wire必要调整；R6负责面板业务；R7接最终展示并清依赖，不要求R3重新实现全部应用。

## 3. 验证与回退

使用假client的正式单元测试验证：唯一元数据实体、迟到读取/事件、快照可选值清除、结算边界、lease/StrictMode重挂与dispose、作用域独立及草稿版本。可用时对公共包执行类型检查；应用全量报错仅记录迁移断点，不搭兼容层。最终check/build/Lingui/浏览器与性能归R8。

自动化保持临时空间/合成模型，不接个人凭据/会话/开发助手MCP，不停止8799/8788服务。Markdown全文风格零命中与diff检查后提交。回退以分支提交为单位，不回滚个人数据。

## 4. 执行记录

### R3a：公共浏览器基础

worker实际模型为local/deepseek-v4.1-flash、reasoning=max。新增browser service/window/resources、React实例Context/selector、独立model投影；删除旧Controller/runtime/extras及aui状态公开导出，增加纯client子入口与Zustand直接依赖。

主agent通读新store/resources/model/React绑定并亲自修正：目录版本循环复制、驱逐后旧运行状态、取消预检误结束其他运行、认证迟到读取、附件恢复覆盖新编辑、附件引用遍历、终止断流重连、根MCP发现/释放、entryId独立更新漏投影。对应检查与回归随提交记录。

旧Controller中发送/图片准备/停止/整体取回/树与模型动作的有效断言尚待R4/R8迁移，来源固定为`9bcf157:packages/react/src/runtime/thread-controller.test.ts`；旧runtime绑定测试按R0迁移分类处理，不将删旧文件当功能通过。应用仍导入旧hooks及reducer形状，全量typecheck在apps/harness失败，符合WIP约定；无兼容导出或测试排除。

主agent亲验公共包类型通过、针对性测试通过；全量typecheck确认protocol/mcp/core/history/react通过，应用出现预期旧API断点。未运行全量业务/build/e2e。
### R3b：应用实例与目录接入

worker实际local/deepseek-v4.1-flash/max。bootstrap实际挂到main/App，目录/工作区定义来自公共serviceStore，窗口选择来自windowStore，工作区feature持列表/表单，主题迁Zustand。删除旧runtime provider/live订阅组件、HTTP业务包装、模型/认证单例与bridge，旧面板暂时断开。

主agent阅读bootstrap、workspace业务/侧栏及公共查询，亲自纠正保存迟到关闭新表单、冲突用权威值覆盖草稿两处问题，并加正式回归。公共包类型通过；公共包和应用state针对性测试通过。应用旧composer/管理/消息组件仍有已知旧API断点，不以vite单独打包成功当最终构建通过。R3基础接入完成，功能与AR最终关闭留R4～R8。
