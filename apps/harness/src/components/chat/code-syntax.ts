/**
 * 代码语法高亮的纯函数：语言识别与显示规模上限。
 *
 * 高亮本身由官方 useHighlightedCode 负责；这里只决定哪些代码可以进入
 * 高亮组件。语言表与 lib/highlighter.tsx 当前安装的语法及别名保持一致，
 * 未列出的语言一律退回纯文本，不触发动态导入。
 */

/** 超过任一上限时保留完整纯文本，避免在浏览器里分词超大内容。 */
export const HIGHLIGHT_MAX_CHARS = 100_000
export const HIGHLIGHT_MAX_LINES = 2_000

/** 已安装的 Shiki 语言名及 highlighter 声明的别名。 */
const HIGHLIGHT_LANGUAGES = new Set([
  'bash',
  'css',
  'diff',
  'html',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'python',
  'sql',
  'tsx',
  'typescript',
  'yaml',
  'rust',
  'toml',
  'pwsh',
  'ps1',
  'powershell',
  // lib/highlighter.tsx 中的别名。
  'js',
  'md',
  'py',
  'sh',
  'shell',
  'shellscript',
  'ts',
  'yml',
  'zsh',
])

/** 路径后缀到语言的映射；只列已安装语法，未知后缀不猜测。 */
const PATH_LANGUAGES = new Map<string, string>([
  ['ts', 'ts'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['js', 'js'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['jsx', 'jsx'],
  ['tsx', 'tsx'],
  ['json', 'json'],
  ['css', 'css'],
  ['html', 'html'],
  ['htm', 'html'],
  ['md', 'markdown'],
  ['mdx', 'markdown'],
  ['py', 'py'],
  ['sql', 'sql'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['rs', 'rust'],
  ['toml', 'toml'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['psd1', 'powershell'],
])

/** 归一化并校验围栏代码语言；未指定或未知语言返回 undefined。 */
export function highlightLanguageOf(language: string | null | undefined): string | undefined {
  const name = language?.trim().toLowerCase()
  return name && HIGHLIGHT_LANGUAGES.has(name) ? name : undefined
}

/**
 * 按文件路径后缀识别语言。
 *
 * 同时兼容 Windows 与 POSIX 分隔符和大小写；没有后缀或后缀未知时返回
 * undefined，不以文件名猜测语言。
 */
export function languageOfPath(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return PATH_LANGUAGES.get(name.slice(dot + 1).toLowerCase())
}

/** O(n) 检查高亮上限；字符超限立即返回，行数超限时提前结束扫描。 */
export function withinHighlightLimits(value: string): boolean {
  if (value.length > HIGHLIGHT_MAX_CHARS) return false
  const end = value.endsWith('\n') ? value.length - 1 : value.length
  let lines = 1
  for (let index = 0; index < end; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lines += 1
      if (lines > HIGHLIGHT_MAX_LINES) return false
    }
  }
  return true
}
