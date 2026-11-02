import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// 单元测试统一在仓库根运行，覆盖各包与应用的 src / server 目录。
// 默认 Node 环境；需要 DOM 的测试文件用 `// @vitest-environment jsdom` 单独声明。
export default defineConfig({
  resolve: {
    // 应用组件测试复用 tsconfig 的 @ 别名，避免测试与生产解析两套路径。
    alias: [
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL('./apps/harness/src/', import.meta.url))}`,
      },
    ],
  },
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/server/**/*.test.{ts,tsx}',
    ],
    environment: 'node',
  },
})
