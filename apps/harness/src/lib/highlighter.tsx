import * as React from "react"
import {
  createHighlighterCore,
  type GrammarState,
  type HighlighterCore,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { type BundledLanguage, bundledLanguages } from "shiki/langs"

// 本地修改：使用 Shiki 自带的动态语言表及别名，删除重复白名单和未使用的
// highlightCode 包装；token 同时携带四套配色，由应用主题 class 选择。

let highlighter: Promise<HighlighterCore> | undefined

function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
      import("shiki/themes/solarized-light.mjs"),
      import("shiki/themes/one-dark-pro.mjs"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })

  return highlighter
}

// 解析 Shiki 自带语言及别名，纯文本和未知语言不加载分词器。
function getLanguage(language: string) {
  const name = language.trim().toLowerCase()

  if (name === "ansi") return name
  return Object.hasOwn(bundledLanguages, name) ? name as BundledLanguage : null
}

// 本地修改：按需加载语言，保留原上游分行与语法状态接口。
export async function loadHighlighter(language: string) {
  const lang = getLanguage(language)

  if (!lang) {
    return null
  }

  const shiki = await getHighlighter()

  if (lang !== "ansi" && !shiki.getLoadedLanguages().includes(lang)) {
    await shiki.loadLanguage(bundledLanguages[lang])
  }

  return {
    // Returns one React node per line, and the grammar state after the last
    // line. Pass that state back to continue where the code left off.
    highlight(code: string, state?: GrammarState) {
      const tokenize = (text: string) =>
        shiki.codeToTokens(text, {
          lang,
          themes: {
            light: "github-light",
            dark: "github-dark",
            oneDark: "one-dark-pro",
            solarized: "solarized-light",
          },
          defaultColor: false,
          // 本地修改：实测 JS 引擎单行 5,000/10,000 字符约需 0.9/3.6 秒；
          // 仅让超长单行由 Shiki 保留文本，其余行继续高亮，避免整块退回。
          tokenizeMaxLineLength: 2_000,
          grammarState: state,
        }).tokens

      // ANSI has no grammar state, so each line is tokenized on its own and
      // gets the same colors whether it arrives in one piece or streams.
      const tokens =
        lang === "ansi"
          ? code.split("\n").flatMap((line) => tokenize(line))
          : tokenize(code)

      return {
        lines: tokens.map((line) =>
          line.map((token, index) => (
            <span
              key={index}
              style={token.htmlStyle as React.CSSProperties}
              className="huan-syntax-token"
            >
              {token.content}
            </span>
          ))
        ),
        state: shiki.getLastGrammarState(tokens),
      }
    },
  }
}
