/// <reference types="vite/client" />

// 由 vite.config.ts 的 define 注入：宿主访问凭证（开发期通常为空串）。
declare const __HUAN_TOKEN__: string

// Lingui 的 Vite 插件允许直接导入 .po 目录文件，这里补充其模块类型声明。
declare module '*.po' {
  import type { Messages } from '@lingui/core'

  export const messages: Messages
}
