import path from 'node:path'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 应用开发服务器；后续迭代在此追加 /api/pi 代理到 Node 宿主（迭代②）。
// Vite 8 使用 rolldown 与 oxc，Lingui 宏经 @rolldown/plugin-babel 的 preset 接入。
export default defineConfig({
  plugins: [react(), tailwindcss(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
})
