import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 清理浏览器验收的临时用户空间。
 *
 * Windows 上 Playwright 无法优雅结束 webServer（强制结束进程），因此由
 * 测试运行器在关闭服务器后统一删除输出目录内的临时根。
 */
export default async function globalTeardown(): Promise<void> {
  await rm(resolve(import.meta.dirname, '..', 'test-results', 'e2e'), {
    recursive: true,
    force: true,
  })
}
