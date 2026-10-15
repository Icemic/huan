import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { I18nProvider } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { i18n } from './i18n'
import './index.css'

// 骨架占位页：验证 Tailwind、Lingui 与 workspace 包解析链路均可用。
function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold">幻</h1>
        <p className="text-neutral-400">
          <Trans>骨架已就绪</Trans>
        </p>
        <p className="font-mono text-sm text-neutral-500">protocol v{HARNESS_PROTOCOL_VERSION}</p>
      </div>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载节点')

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  </StrictMode>,
)
