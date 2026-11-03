import type { Plugin } from 'vite'

/**
 * 生产预览构建的会话行探针。
 *
 * 仅由 e2e 启动器的预览分支传入：开发模式继续用源码路由注入，默认
 * `vite build` 与业务组件都不包含计数器。页面标记用于证明本次产物确实
 * 经过注入，避免在计数恒为 0 时误判通过。
 */
export const RENDER_REVIEW_MARKER = 'huan-e2e-render-review'

const SIDEBAR_MODULE = /[/\\]src[/\\]components[/\\]workspace-sidebar\.tsx(?:\?.*)?$/
const ROW_FUNCTION = /(function SessionRowComponent\([\s\S]*?\)\s*\{)/

/** 与开发路由相同的函数入口计数：只统计非当前会话行。 */
export function renderReviewPlugin(): Plugin {
  let instrumented = false
  return {
    name: 'huan-e2e-render-review',
    enforce: 'pre',
    transform(code, id) {
      if (!SIDEBAR_MODULE.test(id)) return
      if (!ROW_FUNCTION.test(code)) {
        throw new Error(`生产性能探针找不到 SessionRowComponent：${id}`)
      }
      instrumented = true
      // 源码在 react/oxc 转换与压缩前注入，产物无需依赖稳定的函数名。
      return {
        code: code.replace(ROW_FUNCTION, '$1 if (!active) window.__renderReview.rows += 1;'),
        map: null,
      }
    },
    // 模块移动或改名时让构建失败，避免标记存在但没有计数器的假通过。
    buildEnd() {
      if (!instrumented) {
        throw new Error('生产性能探针没有经过 workspace-sidebar.tsx')
      }
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: RENDER_REVIEW_MARKER, content: 'instrumented' },
          injectTo: 'head',
        },
      ]
    },
  }
}
