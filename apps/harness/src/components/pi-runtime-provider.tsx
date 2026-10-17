import { AssistantRuntimeProvider, SimpleImageAttachmentAdapter } from '@assistant-ui/react'
import { usePiRuntime } from '@assistant-ui/react-pi'
import { type ReactNode, useMemo } from 'react'
import { piHttpClient } from './pi-http-client'

/**
 * 把浏览器端的 PiClient（HTTP/SSE 经 /api/pi）接成 Pi 运行时。
 *
 * client 为模块级单例（见 pi-http-client.ts），与模型选择器共用。
 */
export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const adapters = useMemo(() => ({ attachments: new SimpleImageAttachmentAdapter() }), [])
  const runtime = usePiRuntime({ client: piHttpClient, adapters })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
