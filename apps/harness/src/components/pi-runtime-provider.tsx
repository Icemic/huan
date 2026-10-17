import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter } from '@assistant-ui/react'
import { createPiHttpClient, usePiRuntime } from '@assistant-ui/react-pi'
import { type ReactNode, useMemo } from 'react'

/**
 * 把浏览器端的 PiClient（HTTP/SSE 经 /api/pi）接成 Pi 运行时。
 *
 * client 在应用生命周期内保持稳定；宿主启用凭证时，所有请求（含 SSE）携带
 * x-huan-token 头。
 */
export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      createPiHttpClient(
        __HUAN_TOKEN__ ? { headers: { 'x-huan-token': __HUAN_TOKEN__ } } : undefined,
      ),
    [],
  )
  const adapters = useMemo(() => ({ attachments: new SimpleImageAttachmentAdapter() }), [])
  const runtime = usePiRuntime({ client, adapters })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
