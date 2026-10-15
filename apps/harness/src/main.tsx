import { I18nProvider } from '@lingui/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { i18n } from './i18n'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载节点')

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <App />
    </I18nProvider>
  </StrictMode>,
)
