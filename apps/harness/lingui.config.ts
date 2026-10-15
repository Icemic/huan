import { defineConfig } from '@lingui/cli'

// 源语言为中文，首期仅维护 zh-CN 单语言包（D-22 / D-25）。
export default defineConfig({
  sourceLocale: 'zh-CN',
  locales: ['zh-CN'],
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}',
      include: ['<rootDir>/src'],
    },
  ],
})
