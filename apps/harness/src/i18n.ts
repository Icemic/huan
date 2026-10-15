import { i18n } from '@lingui/core'
import { messages } from './locales/zh-CN.po'

// 初始化 i18n：源语言中文，首期仅中文语言包（D-22 / D-25）。
// .po 目录由 @lingui/vite-plugin 在开发与构建时直接编译消费。
i18n.loadAndActivate({ locale: 'zh-CN', messages })

export { i18n }
