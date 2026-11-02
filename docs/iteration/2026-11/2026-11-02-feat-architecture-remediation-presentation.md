# R7：最终聊天展示与依赖清理

日期：2026-11-02。分类：feat。基线：`f6c04ec`。按已确认所有权、精简协议和[子路线图](../../architecture-remediation-roadmap.md)实施；旧聊天V0～V3失效，不复用其aui绑定方案。

## 最终组合

官方shadcn Base UI组合负责Message/Bubble、Thinking/工具过程、Attachment、输入组与代码展示；应用chat从Zustand选择数据并调用现有feature动作。单一消息滚动容器和单一输入框，最终消息与输入列对齐；Geist/明暗token/紧凑尺度/4px保持。采用官方实际组合，来源记录与视觉判断分开；不把复制源码或测试通过当视觉验收。

## 功能范围

完整text/thinking/image/tool/data、嵌套/独立工具、部分与最终输出、editor预填与全部待答入口、复制/Markdown下载/树定位与fork、流式结算/错误/重连；输入多行IME/键盘/历史/补全/图片选择粘贴拖入/长输入/模型队列与停止/整体取回。上滚不强拉、迟到图片/折叠保持阅读位置，焦点遵循来源。命令面板与管理入口实际连现有store。

删除剩余aui组件/运行依赖及移植过时注释，保留MIT来源，Markdown替代用成熟且符合发布龄的现有/新增依赖，不增加通用渲染平台。R8迁正式回放与浏览器定位，最终check/build/Lingui/隔离e2e与性能全量验证。

## 执行

指定max worker实施，主agent独立review/修正/亲验后提交。阶段不能通过空壳/占位保留功能假象。回退代码提交，不动个人数据，文档全文零命中。## 执行记录

worker实际local/deepseek-v4.1-flash/max。官方registry组合、本地Markdown、完整composer/chat、子工具与图片/data、树定位/fork/复制/下载及有效回放迁移已接通；assistant-ui生态及assistant-stream运行依赖已删除，增加实际服务端测试消费的纯model子入口。

主agent阅读最终chat/composer/scroll/feature状态、投影与许可/依赖变更，亲自修正冷读空缓存不加载、组件卸载后首帧滚动未取消、主题尺度中的大圆角，以及前阶段Pick声明格式检查。亲验typecheck、test与build通过；未在本阶段声称浏览器/视觉/性能验收。R8继续正式浏览器测试迁移及实际页面核对，截图必须实际读取后才可判断。

