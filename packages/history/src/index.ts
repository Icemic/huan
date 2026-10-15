/**
 * @huan/history：Checkpoint / ChangeSet 契约与关联元数据（M2 落地）。
 *
 * 设计约定（技术架构 §5）：
 * - 内容寻址快照（blob + manifest），不依赖 Git；
 * - Provider 契约表达：不支持恢复、部分成功、冲突、需确认、恢复中断；
 * - 与 Pi 会话通过稳定 ID（sessionId / runId / toolCallId）关联。
 * 当前为空占位，不预设接口。
 */
export {}
