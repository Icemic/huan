# R5：Node所有权与协议实施

日期：2026-11-02。分类：refactor。基线：`55f39d2`。按已确认R1/R2及复杂度审查实施，状态由[子路线图](../../architecture-remediation-roadmap.md)维护，局部决定见[实施调整](2026-11-02-refactor-architecture-implementation-decisions.md)。

## 范围与方法

按所有权整理host装配/目录/live生命周期/准入与操作、设置/资源服务，复用现有MCP及认证broker。模块数量依实际需要，禁止万能context和双向回调网。保留冷读/信任、取消/退休与资源收尾，不改变正常停止为重建执行实例。

同步必要协议调整：同版比较、共用wire守卫归protocol、领域client接口组合、扩展JSON-safe、按会话模型回退原因、未写文件live目录可发现、完整快照活动工具恢复。实际wire首改版本15，浏览器Node同版部署，不做兼容协商。

## 验证与风险

主agent规划→指定max worker实施→主agent独立review/修正/验证→提交。core/protocol/transport正式测试保持有效取消/文件/秘密/资源/多窗断言，增加具体新边界；针对SDK未证组合先核对后决定，不建通用恢复系统。

默认临时空间与本地fixture，不请求个人/付费资源；不停止8799/8788。应用尚为WIP，不为中间类型通过接兼容API。Markdown全文零命中和diff检查后提交，回退仅代码提交。## 执行记录

worker实际local/deepseek-v4.1-flash/max。host拆为装配、目录、live、协调、事件、操作、导入、配置及共享模型模块；协议15、共用wire守卫、局部JSON-safe、会话模型回退、活动工具快照、live目录和标准SSE解析已接入。

主agent阅读组合根/共享类型、依赖声明、资源转移/退休、准入及事件投影、JSON与SSE实现，亲自将records限定为live私有持有、服务依赖改为实际方法Pick，并修正SSE多data行反复reduce的二次遍历与JSON对象特殊键的赋值问题。组合根延迟回调仅供现有SDK命令/重载调用，不引入通用注册系统。

主agent亲验core/protocol/react类型通过，50文件669项core/protocol/react/生产路由测试顺序执行通过。worker并行运行曾出现host-reload临时目录EBUSY，顺序通过仅是本轮结果，未证明此前异常原因，AR-34保持。应用旧UI仍为WIP；未执行完整UI/build/e2e，Node功能最终证据继续R8。
