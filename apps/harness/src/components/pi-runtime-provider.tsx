import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter } from '@assistant-ui/react'
import { createPiHttpClient, usePiRuntime } from '@assistant-ui/react-pi'
import { useMemo, type ReactNode } from 'react'

/**
 * 把浏览器端的 PiClient（HTTP/SSE 经 /api/pi）接成 Pi 运行时。
 *
 * client 在应用生命周期内保持稳定。
 */
export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createPiHttpClient(), [])
  const adapters = useMemo(() => ({ attachments: new SimpleImageAttachmentAdapter() }), [])
  const runtime = usePiRuntime({ client, adapters })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
