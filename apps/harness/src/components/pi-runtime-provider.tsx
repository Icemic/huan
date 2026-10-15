import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter } from '@assistant-ui/react'
import { createPiHttpClient, usePiRuntime } from '@assistant-ui/react-pi'
import { type ReactNode, useMemo } from 'react'

/**
 * 把浏览器端的 PiClient（HTTP/SSE 经 /api/pi）接成 Pi 运行时。
 *
 * client 在应用生命周期内保持稳定；workspacePath 用于限定会话列表与新建会话。
 * 图片附件沿用 react-pi 的直通适配器。
 */
export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createPiHttpClient(), [])
  const adapters = useMemo(() => ({ attachments: new SimpleImageAttachmentAdapter() }), [])
  const runtime = usePiRuntime({ client, adapters })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
