import { defineConfig } from 'vitest/config'

// 单元测试统一在仓库根运行，覆盖各包与应用的 src 目录。
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
