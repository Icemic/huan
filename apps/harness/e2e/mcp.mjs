import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'

// MCP 和自动化测试复用已安装的 Chromium，浏览器配置只保存在内存。
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
const child = spawn(
  process.execPath,
  [
    cli,
    '--executable-path',
    chromium.executablePath(),
    '--isolated',
    '--headless',
    '--output-dir',
    'apps/harness/test-results/mcp',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))
