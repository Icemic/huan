# R4：提交与分支业务实施

日期：2026-11-02。分类：feat。基线：`1320f68`。依据已确认R1/R2与复杂度审查，状态见[子路线图](../../architecture-remediation-roadmap.md)。小范围决定见[实施调整](2026-11-02-refactor-architecture-implementation-decisions.md)。

## 目标与范围

统一本窗创建/普通发送/steer/followUp/Shell、图片准备、草稿和输入历史、停止/整体取回，以及树/fork/clone/import/定向编辑器的业务动作。公共session动作与应用composer/session feature采用Zustand，固定来源版本，权威队列直接展示。不新增通用操作结果表、wire身份或自动重发。

## 实施与验收

worker使用local/deepseek-v4.1-flash:max，主agent独立review/修正/验证后提交。纯图片算法复用原vendor与Controller来源，正式测试迁移`9bcf157:packages/react/src/runtime/thread-controller.test.ts`有效发送/取消/队列/图片/结构断言；不要按旧数量或旧API验收。

R4业务入口须实际组合到browser/app；最终输入和聊天布局归R7，复杂管理表单归R6，阶段WIP允许旧组件报错。针对性覆盖固定目标/模型/附件、同目标新草稿、handled历史、结果未知后同步不重投、在途准备取消、同文队列、取回不清新队列、结构迟到保护。

安全与冷读边界不变，隔离验证不接个人空间。Markdown全文零命中与diff检查后本地提交，回退以提交为单位。## 执行记录

R4业务已实现，worker实际local/deepseek-v4.1-flash/max。公共session-actions、图片准备、应用composer/sessions feature已组合到browser/bootstrap；旧aui composer hook删除，选中会话live/cold按元数据健康状态分开。

主agent阅读提交、草稿迁移、图片、结构和导入流程，亲自修正：派发前取消资格、创建后错误目标丢失、HTTP4xx错误等同未执行、导入前await后资格、导入返回后await目录导致旧面板复活、同面板并行树读取、fork期间新草稿/销毁、定向consume销毁后写入。HTTP异常统一视为结果未知并同步，明确业务拒绝由result表达；该决定符合精简R2，不增加重发机制。

主agent亲验公共包typecheck通过，公共包与应用state针对性测试通过。尚未接的复杂内置面板、Host UI应答与运行管理交R6，最终composer/chat/键盘/焦点归R7；旧回放与UI仍有预期断点，R8完整迁移。发送等旧有效断言已由新session-actions/composer/sessions正式测试承接，R8继续核对取消与未知结果组合，不能以新测试数量证明全部验收。

