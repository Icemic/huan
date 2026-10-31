import { defineConfig, devices } from '@playwright/test'
import { E2E_APP_URL } from './e2e/config.js'

/**
 * 浏览器验收：真实页面 + 真实宿主路由 + 真实 Pi SDK。
 *
 * 首期只跑 Chromium；失败保留截图与 trace，产物目录已忽略入 Git。
 * 启动器（e2e/server.ts）使用独立端口与临时用户空间，见该文件说明。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: E2E_APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec tsx e2e/server.ts',
    url: E2E_APP_URL,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
