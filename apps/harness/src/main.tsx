import { I18nProvider } from '@lingui/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { createHarnessApp } from './bootstrap'
import { i18n } from './i18n'
import './index.css'

// bootstrap 在 React 挂载前应用本地主题，避免首帧闪白。
const app = createHarnessApp()

// 开发期 HMR 替换模块时销毁旧实例，避免重复订阅与残留监听。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    app.dispose()
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载节点')

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <App app={app} />
    </I18nProvider>
  </StrictMode>,
)
