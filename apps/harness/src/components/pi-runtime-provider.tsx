import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter } from '@assistant-ui/react'
import { useHarnessRuntime } from '@huan/react'
import { type ReactNode, useMemo } from 'react'
import { harnessHttpClient } from './pi-http-client'

/**
 * 把浏览器端的 HarnessClient（HTTP/SSE 经 /api/pi）接成会话运行时。
 *
 * client 为模块级单例（见 pi-http-client.ts），与模型选择器共用。
 */
export function PiRuntimeProvider({
  workspacePath,
  readOnly = false,
  children,
}: {
  /** 本窗口当前项目；切换项目时由上层重建运行时。 */
  workspacePath: string
  /** 信任未决定时只读：可查看冷历史，但禁用发送与新运行。 */
  readOnly?: boolean
  children: ReactNode
}) {
  const adapters = useMemo(() => ({ attachments: new SimpleImageAttachmentAdapter() }), [])
  const runtime = useHarnessRuntime({
    client: harnessHttpClient,
    adapters,
    workspacePath,
    isDisabled: readOnly,
    isSendDisabled: readOnly,
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
