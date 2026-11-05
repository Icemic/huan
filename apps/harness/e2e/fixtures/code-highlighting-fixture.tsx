/** 同一组件接收替换内容和语言，验证官方高亮 hook 清除旧语法状态。 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HighlightedCodeContent } from '@/components/chat/highlighted-code'
import { CodeBlock } from '@/components/ui/code-block'
import '@/index.css'

function Fixture() {
  const [value, setValue] = useState('/* old comment\ncontinued */\nconst alpha = 1\n\n')
  const [language, setLanguage] = useState('ts')
  return (
    <main className="mx-auto max-w-2xl p-6">
      <button
        type="button"
        onClick={() => setValue('const replaced = "new"\r\n\r\nconst end = 2\r\n')}
      >
        替换内容
      </button>
      <button
        type="button"
        onClick={() => {
          setLanguage('python')
          setValue('print("changed")\n')
        }}
      >
        切换语言
      </button>
      <button type="button" onClick={() => { setLanguage('json'); setValue('{"enabled": true, "count": 2}') }}>
        JSON
      </button>
      <button type="button" onClick={() => { setLanguage('go'); setValue('package main\nfunc main() {}') }}>
        Go
      </button>
      <button type="button" onClick={() => { setLanguage('ts'); setValue('function run() {\n  return [Math.max(1, 2)]\n}') }}>括号</button>
      <button type="button" onClick={() => { setLanguage('ansi'); setValue('\u001b[31mred\nstill red\u001b[0m\n\u001b[1;4;48;2;12;34;56mstyled\u001b[0m') }}>ANSI</button>
      <CodeBlock>
        <HighlightedCodeContent value={value} language={language} lineNumbers />
      </CodeBlock>
      <section data-testid="patch">
        <CodeBlock>
          <HighlightedCodeContent language="ts" diff value={'--- a.ts\n+++ a.ts\n@@ -1,3 +1,3 @@\n const text = "hello"\n-/* before\n+const added = "after"\n console.log(text)'} />
        </CodeBlock>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Fixture />)
