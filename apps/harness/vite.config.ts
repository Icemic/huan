import path from 'node:path'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 应用开发服务器：/api/pi 代理到本地 Node 宿主（8788）。
// Vite 8 使用 rolldown 与 oxc，Lingui 宏经 @rolldown/plugin-babel 的 preset 接入。
export default defineConfig({
  plugins: [react(), tailwindcss(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  // 访问凭证：宿主与前端读取同一环境变量；留空表示宿主不校验。
  define: {
    __HUAN_TOKEN__: JSON.stringify(process.env.HUAN_TOKEN ?? ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 8799,
    strictPort: true,
    proxy: {
      '/api/pi': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: false,
      },
    },
  },
})
