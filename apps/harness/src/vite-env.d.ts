/// <reference types="vite/client" />

// Lingui 的 Vite 插件允许直接导入 .po 目录文件，这里补充其模块类型声明。
declare module '*.po' {
  import type { Messages } from '@lingui/core'

  export const messages: Messages
}
