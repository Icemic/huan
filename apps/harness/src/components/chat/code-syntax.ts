/**
 * 代码语法高亮的路径语言识别。
 *
 * 高亮语言由 lib/highlighter.tsx 统一从 shiki/langs 解析；这里只处理文件名
 * 和扩展名与语言名不同的情况，普通扩展名直接交给 Shiki。
 */

/** 文件扩展名与语言名不同的映射，其余交给 Shiki 自带别名表。 */
const PATH_LANGUAGES = new Map<string, string>([
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['htm', 'html'],
  ['mdx', 'markdown'],
  ['psm1', 'powershell'],
  ['psd1', 'powershell'],
])

/** 同时处理 Windows/POSIX 路径；未知语言由统一高亮入口按文本显示。 */
export function languageOfPath(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  if (name === 'dockerfile' || name === 'makefile') return name
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = name.slice(dot + 1)
  return PATH_LANGUAGES.get(extension) ?? (extension || undefined)
}
