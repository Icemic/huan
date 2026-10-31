/**
 * 浏览器验收的隔离端口。
 *
 * 刻意避开日常开发的宿主 8788 / Vite 8799：测试可与本地开发同时运行，
 * 也不会误连到已启动的开发宿主。
 */
export const E2E_HOST_PORT = 8898
export const E2E_APP_PORT = 8899

export const E2E_HOST_URL = `http://127.0.0.1:${E2E_HOST_PORT}`
export const E2E_APP_URL = `http://127.0.0.1:${E2E_APP_PORT}`

/** 未显式配置分段时，合成模型的默认回复。 */
export const DEFAULT_TEST_REPLY = '这是确定性测试回复。'

/** 启动器预置的未归属会话标题（不写入 huan 工作区元数据）。 */
export const E2E_UNASSIGNED_TITLE = '预置未归属会话'
