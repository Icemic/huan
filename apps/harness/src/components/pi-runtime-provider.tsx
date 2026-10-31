import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter } from '@assistant-ui/react'
import type { HarnessCreateThreadInput } from '@huan/protocol'
import { useHarnessRuntime } from '@huan/react'
import { type ReactNode, useMemo } from 'react'
import { harnessHttpClient } from './pi-http-client'

/**
 * 把浏览器端的 HarnessClient（HTTP/SSE 经 /api/pi）接成会话运行时。
 *
 * 会话列表覆盖整个存储作用域，以便左侧按工作区自行分组；新建会话的
 * 工作区/起始项目由窗口上下文在真正创建时提供，不重新挂载运行时。
 */
export function PiRuntimeProvider({
  createThreadInput,
  onError,
  readOnly = false,
  children,
}: {
  /** 新建会话时求值的窗口目标（工作区 + 起始项目）。 */
  createThreadInput: () => HarnessCreateThreadInput
  /** 运行时错误（如未信任项目启动失败）交给页面横幅显示。 */
  onError?: (error: unknown) => void
  /** 元数据损坏等场景下只允许查看冷历史，禁用发送与新运行。 */
  readOnly?: boolean
  children: ReactNode
}) {
  const adapters = useMemo(() => ({ attachments: new SimpleImageAttachmentAdapter() }), [])
  const runtime = useHarnessRuntime({
    client: harnessHttpClient,
    adapters,
    createThreadInput,
    isDisabled: readOnly,
    isSendDisabled: readOnly,
    ...(onError ? { onError } : {}),
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
