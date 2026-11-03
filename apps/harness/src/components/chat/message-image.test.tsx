// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageImage } from './message-image'

// 单元测试只关注加载/失败状态，不需要真实 Dialog；同时避免引入 Lingui 宏编译。
vi.mock('@/components/ui/dialog', async () => {
  const { createElement, Fragment } = await import('react')
  const passthrough = ({ children }: { children?: unknown }) =>
    createElement(Fragment, null, children as never)
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogTitle: passthrough,
    DialogTrigger: passthrough,
  }
})

let root: Root | undefined
let container: HTMLElement | undefined

const renderImage = (src: string, alt = '测试图片') => {
  if (!root || !container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  act(() => {
    root?.render(createElement(MessageImage, { src, alt, preview: false }))
  })
  return container
}

const imageElement = (): HTMLImageElement => {
  const image = container?.querySelector('img')
  if (!(image instanceof HTMLImageElement)) throw new Error('图片元素不存在')
  return image
}

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = undefined
  container?.remove()
  container = undefined
})

describe('MessageImage 损坏图片回退', () => {
  it('加载失败展示替代文本与来源，换源后重置失败状态', () => {
    const broken = 'data:image/png;base64,not-an-image'
    const current = renderImage(broken, '工具输出图片 1')
    act(() => {
      imageElement().dispatchEvent(new Event('error'))
    })

    const error = current.querySelector('[data-slot="huan-image-error"]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain('图片加载失败')
    expect(error?.textContent).toContain('原替代文本：工具输出图片 1')
    expect(error?.textContent).toContain(`来源：${broken}`)
    expect(current.querySelector('img')).toBeNull()
    expect(current.querySelector('[aria-label="预览图片：工具输出图片 1"]')).toBeNull()

    // 同一组件实例换到新的 src：旧图的失败状态不能继续遮住新图。
    renderImage('https://example.com/next.png', '下一张图片')
    expect(current.querySelector('[data-slot="huan-image-error"]')).toBeNull()
    expect(imageElement().getAttribute('src')).toBe('https://example.com/next.png')
  })

  it('加载成功显示完整不透明度，换 src 后回到加载态', () => {
    renderImage('https://example.com/first.png')
    act(() => {
      imageElement().dispatchEvent(new Event('load'))
    })
    expect(imageElement().className).toContain('opacity-100')

    renderImage('https://example.com/second.png')
    expect(imageElement().getAttribute('src')).toBe('https://example.com/second.png')
    expect(imageElement().className).toContain('opacity-70')
  })
})
