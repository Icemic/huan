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
      <CodeBlock>
        <HighlightedCodeContent value={value} language={language} lineNumbers />
      </CodeBlock>
    </main>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Fixture />)
