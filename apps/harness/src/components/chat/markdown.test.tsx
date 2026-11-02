import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown'

describe('MarkdownText（GFM 与代码块组合）', () => {
  it('渲染表格、链接、围栏代码块与图片', () => {
    const html = renderToStaticMarkup(
      <MarkdownText
        text={[
          '| 列一 | 列二 |',
          '| --- | --- |',
          '| 1 | 2 |',
          '',
          '[示例](https://example.com/docs)',
          '',
          '```ts',
          'const value = 1',
          '```',
          '',
          '![说明](data:image/png;base64,AAAA)',
        ].join('\n')}
      />,
    )
    expect(html).toContain('<table')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('data-slot="code-block"')
    expect(html).toContain('const value = 1')
    expect(html).toContain('alt="说明"')
  })

  it('空文本不生成容器', () => {
    expect(renderToStaticMarkup(<MarkdownText text="" />)).toBe('')
  })
})
