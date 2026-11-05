/**
 * 本地修改：替换CLI附带的token渲染入口，统一使用官方HAST及transformer。
 *
 * 只在这里创建 Shiki 实例：使用 JS 正则引擎与随包语言表按需加载，四种
 * 应用主题同时产出 CSS 变量。完整代码交给 codeToHast()，官方彩色括号
 * transformer 因此能看到全部括号；ANSI 由 Shiki 的特殊语言一次解析。
 * HAST 行再经 hast-util-to-jsx-runtime 转为 React，不拼接 HTML。
 */

import { transformerColorizedBrackets } from '@shikijs/colorized-brackets'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { createHighlighterCore, type HighlighterCore, type ShikiTransformer } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { type BundledLanguage, bundledLanguages } from 'shiki/langs'
import stripAnsi from 'strip-ansi'

// 与 index.css 的主题 class 对应；颜色键同时决定 --shiki-* 变量名。
const THEMES = {
  light: 'github-light',
  dark: 'github-dark',
  oneDark: 'one-dark-pro',
  solarized: 'solarized-light',
} as const

const TOKEN_CLASS = 'huan-syntax-token'

const tokenClassTransformer: ShikiTransformer = {
  span(node) {
    this.addClassToHast(node, TOKEN_CLASS)
  },
}

const bracketTransformer = transformerColorizedBrackets()

const jsxRuntime = {
  Fragment,
  jsx,
  jsxs,
  development: false,
  elementAttributeNameCase: 'react',
  stylePropertyNameCase: 'css',
} as const

type LanguageName = keyof typeof bundledLanguages

let highlighterPromise: Promise<HighlighterCore> | undefined

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
      import('shiki/themes/solarized-light.mjs'),
      import('shiki/themes/one-dark-pro.mjs'),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })

  return highlighterPromise
}

// 语言名统一去空白、转小写后只接受 Shiki 自带语言；ansi 是特殊语言，
// 不加载语法，未知语言按原文展示。
function normalizeLanguage(language: string | undefined): LanguageName | 'ansi' | null {
  const name = language?.trim().toLowerCase()
  if (!name) return null
  if (name === 'ansi') return 'ansi'
  return Object.hasOwn(bundledLanguages, name) ? (name as LanguageName) : null
}

async function loadHighlighter(language: string) {
  const instance = await getHighlighter()
  if (language !== 'ansi' && !instance.getLoadedLanguages().includes(language)) {
    await instance.loadLanguage(bundledLanguages[language as BundledLanguage])
  }
  return instance
}

function plainLines(value: string): ReactNode[] {
  return value.split(/\r?\n/)
}

function linesOfHast(tree: ReturnType<HighlighterCore['codeToHast']>): ReactNode[] {
  const pre = tree.children.find((node) => node.type === 'element' && node.tagName === 'pre')
  if (pre?.type !== 'element') return []
  const code = pre.children.find((node) => node.type === 'element' && node.tagName === 'code')
  if (code?.type !== 'element') return []

  const lines: ReactNode[] = []
  for (const line of code.children) {
    if (line.type !== 'element' || line.tagName !== 'span') continue
    // 空行保留空字符串，让 CodeBlockLine 仍输出换行，复制选区不丢空行。
    lines.push(
      line.children.length === 0
        ? ''
        : toJsxRuntime({ type: 'root', children: line.children }, jsxRuntime),
    )
  }
  return lines
}

function highlightLines(
  instance: HighlighterCore,
  language: LanguageName | 'ansi',
  value: string,
): ReactNode[] {
  const tree = instance.codeToHast(value, {
    lang: language,
    themes: THEMES,
    defaultColor: false,
    // 与实测一致：超长单行保留原文，其他行继续高亮。
    tokenizeMaxLineLength: 2_000,
    // ANSI 只解析控制序列，不参与括号配对。
    transformers:
      language === 'ansi' ? [tokenClassTransformer] : [bracketTransformer, tokenClassTransformer],
  })
  return linesOfHast(tree)
}

/**
 * 返回同步高亮函数。语言首次使用时异步加载，加载完成后同一渲染周期即可
 * 同步分词；调用方用 useMemo 缓存完整代码的结果。
 */
export function useCodeHighlighter(language: string | undefined) {
  const name = normalizeLanguage(language)
  const [loaded, setLoaded] = useState<{ language: string; highlighter: HighlighterCore } | null>(
    null,
  )
  const instance = loaded?.language === name ? loaded.highlighter : null

  useEffect(() => {
    if (!name) return
    let cancelled = false
    loadHighlighter(name).then(
      (next) => {
        if (!cancelled) setLoaded({ language: name, highlighter: next })
      },
      (error: unknown) => {
        if (!cancelled) console.error(`代码高亮加载失败：${name}`, error)
      },
    )
    return () => {
      cancelled = true
    }
  }, [name])

  return useMemo(() => {
    return (value: string) => {
      if (!name || !instance) return plainLines(name === 'ansi' ? stripAnsi(value) : value)
      return highlightLines(instance, name, value)
    }
  }, [name, instance])
}
