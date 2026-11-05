import { describe, expect, it } from 'vitest'
import { languageOfPath } from './code-syntax'

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
  ['README.md', 'md'],
  ['README.mdx', 'markdown'],
  ['script.py', 'py'],
  ['query.sql', 'sql'],
  ['config.yaml', 'yaml'],
  ['config.yml', 'yml'],
  ['src/main.rs', 'rs'],
  ['Cargo.toml', 'toml'],
  ['install.sh', 'sh'],
  ['install.bash', 'bash'],
  ['profile.zsh', 'zsh'],
  ['run.ps1', 'ps1'],
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
    expect(languageOfPath('dir.with.dots/PROFILE.ZSH')).toBe('zsh')
    expect(languageOfPath('C:\\repo\\dir.with.dots\\Cargo.TOML')).toBe('toml')
  })

  it('普通扩展名直接传递，识别常用无后缀文件', () => {
    expect(languageOfPath('main.go')).toBe('go')
    expect(languageOfPath('Main.java')).toBe('java')
    expect(languageOfPath('Dockerfile')).toBe('dockerfile')
    expect(languageOfPath('Makefile')).toBe('makefile')
    expect(languageOfPath('src/file.unknown')).toBe('unknown')
    expect(languageOfPath('archive.tar.gz')).toBe('gz')
    expect(languageOfPath('src.v2/file')).toBeUndefined()
    expect(languageOfPath('.gitignore')).toBeUndefined()
    expect(languageOfPath('file.')).toBeUndefined()
    expect(languageOfPath('')).toBeUndefined()
  })
})
