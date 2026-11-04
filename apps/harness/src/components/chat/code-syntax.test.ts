import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  highlightLanguageOf,
  languageOfPath,
  withinHighlightLimits,
} from './code-syntax'

const pathCases: Array<[path: string, language: string]> = [
  ['src/app.ts', 'ts'],
  ['src/app.mts', 'ts'],
  ['src/app.cts', 'ts'],
  ['src/app.js', 'js'],
  ['src/app.mjs', 'js'],
  ['src/app.cjs', 'js'],
  ['src/app.jsx', 'jsx'],
  ['src/app.tsx', 'tsx'],
  ['src/app.json', 'json'],
  ['src/app.css', 'css'],
  ['src/app.html', 'html'],
  ['src/app.htm', 'html'],
  ['README.md', 'markdown'],
  ['README.mdx', 'markdown'],
  ['script.py', 'py'],
  ['query.sql', 'sql'],
  ['config.yaml', 'yaml'],
  ['config.yml', 'yaml'],
  ['src/main.rs', 'rust'],
  ['Cargo.toml', 'toml'],
  ['install.sh', 'bash'],
  ['install.bash', 'bash'],
  ['profile.zsh', 'bash'],
  ['run.ps1', 'powershell'],
  ['module.psm1', 'powershell'],
  ['data.psd1', 'powershell'],
]

describe('languageOfPath（按路径后缀识别语言）', () => {
  it('映射已安装语言的后缀', () => {
    for (const [path, language] of pathCases) {
      expect(languageOfPath(path), path).toBe(language)
    }
  })

  it('兼容 Windows、POSIX 分隔符与大小写', () => {
    expect(languageOfPath('C:\\repo\\src\\App.TSX')).toBe('tsx')
    expect(languageOfPath('C:\\repo\\src\\App.MTS')).toBe('ts')
    expect(languageOfPath('/repo/src/App.Ts')).toBe('ts')
    expect(languageOfPath('dir.with.dots/PROFILE.ZSH')).toBe('bash')
    expect(languageOfPath('C:\\repo\\dir.with.dots\\Cargo.TOML')).toBe('toml')
  })

  it('没有后缀或后缀未知时返回 undefined', () => {
    expect(languageOfPath('Dockerfile')).toBeUndefined()
    expect(languageOfPath('Makefile')).toBeUndefined()
    expect(languageOfPath('src/file.unknown')).toBeUndefined()
    expect(languageOfPath('archive.tar.gz')).toBeUndefined()
    expect(languageOfPath('file.constructor')).toBeUndefined()
    expect(languageOfPath('file.__proto__')).toBeUndefined()
    expect(languageOfPath('file.toString')).toBeUndefined()
    expect(languageOfPath('src.v2/file')).toBeUndefined()
    expect(languageOfPath('.gitignore')).toBeUndefined()
    expect(languageOfPath('file.')).toBeUndefined()
    expect(languageOfPath('')).toBeUndefined()
  })

  it('映射结果都能被高亮语言识别', () => {
    for (const [, language] of pathCases) {
      expect(highlightLanguageOf(language)).toBe(language)
    }
  })
})

describe('highlightLanguageOf（围栏语言归一化）', () => {
  it('接受现有语法名与别名并忽略大小写和空白', () => {
    expect(highlightLanguageOf('ts')).toBe('ts')
    expect(highlightLanguageOf(' TS ')).toBe('ts')
    expect(highlightLanguageOf('Typescript')).toBe('typescript')
    expect(highlightLanguageOf('js')).toBe('js')
    expect(highlightLanguageOf('md')).toBe('md')
    expect(highlightLanguageOf('yml')).toBe('yml')
    expect(highlightLanguageOf('sh')).toBe('sh')
    expect(highlightLanguageOf('shell')).toBe('shell')
    expect(highlightLanguageOf('ShellScript')).toBe('shellscript')
    expect(highlightLanguageOf('zsh')).toBe('zsh')
    expect(highlightLanguageOf('PowerShell')).toBe('powershell')
    expect(highlightLanguageOf('diff')).toBe('diff')
  })

  it('未指定或未知语言返回 undefined', () => {
    expect(highlightLanguageOf('')).toBeUndefined()
    expect(highlightLanguageOf('   ')).toBeUndefined()
    expect(highlightLanguageOf(undefined)).toBeUndefined()
    expect(highlightLanguageOf(null)).toBeUndefined()
    expect(highlightLanguageOf('ansi')).toBeUndefined()
    expect(highlightLanguageOf('text')).toBeUndefined()
    expect(highlightLanguageOf('unknown-lang')).toBeUndefined()
  })
})

describe('withinHighlightLimits', () => {
  const linesOf = (count: number) => Array.from({ length: count }, () => 'x').join('\n')

  it('按显示口径统计空行、CRLF 与末尾换行', () => {
    expect(withinHighlightLimits('')).toBe(true)
    expect(withinHighlightLimits('\n')).toBe(true)
    expect(withinHighlightLimits('a\n\nb\n')).toBe(true)
    expect(withinHighlightLimits('a\r\nb\r\n')).toBe(true)
  })

  it('字符上限包含边界值', () => {
    expect(withinHighlightLimits('')).toBe(true)
    expect(withinHighlightLimits('a'.repeat(HIGHLIGHT_MAX_CHARS))).toBe(true)
    expect(withinHighlightLimits('a'.repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(false)
  })

  it('行数上限包含边界值，末尾单个换行不额外计数', () => {
    expect(withinHighlightLimits(linesOf(HIGHLIGHT_MAX_LINES))).toBe(true)
    expect(withinHighlightLimits(linesOf(HIGHLIGHT_MAX_LINES + 1))).toBe(false)
    expect(withinHighlightLimits(`${linesOf(HIGHLIGHT_MAX_LINES)}\n`)).toBe(true)
    expect(withinHighlightLimits(`${linesOf(HIGHLIGHT_MAX_LINES + 1)}\n`)).toBe(false)
    expect(withinHighlightLimits('\n'.repeat(HIGHLIGHT_MAX_LINES))).toBe(true)
    expect(withinHighlightLimits('\n'.repeat(HIGHLIGHT_MAX_LINES + 1))).toBe(false)
  })

  it('CRLF 行数与字符超限都退回纯文本', () => {
    const crlf = Array.from({ length: HIGHLIGHT_MAX_LINES }, () => 'x').join('\r\n')
    expect(withinHighlightLimits(crlf)).toBe(true)
    expect(withinHighlightLimits(`${crlf}\r\nx`)).toBe(false)
    expect(withinHighlightLimits('x\n'.repeat(HIGHLIGHT_MAX_CHARS))).toBe(false)
  })
})
