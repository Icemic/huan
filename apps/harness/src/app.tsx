import { usePiThreadState } from '@assistant-ui/react-pi'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui'
import { PiModelSelector } from '@/components/pi-model-selector'
import { PiRuntimeProvider } from '@/components/pi-runtime-provider'
import { TooltipProvider } from '@/components/ui/tooltip'

/** 就绪度横幅：模型/凭据不可用时给出提示。 */
function ReadinessBanner() {
  const readiness = usePiThreadState((state) => state.readiness)
  if (!readiness || readiness.state === 'ready') return null
  return (
    <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {readiness.message ?? 'Pi 运行时没有可用模型。'}
    </div>
  )
}

/** 应用主界面：左侧会话列表 + 右侧聊天区。 */
export function App() {
  return (
    <PiRuntimeProvider>
      <TooltipProvider>
        <div className="flex h-dvh flex-col overflow-hidden">
          <header className="flex items-center gap-3 border-b px-4 py-2">
            <span className="font-semibold">幻</span>
            <div className="ml-auto flex items-center gap-2">
              <PiModelSelector />
            </div>
          </header>
          <ReadinessBanner />
          <div className="flex min-h-0 flex-grow">
            <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r">
              <div className="flex-1 overflow-y-auto p-3">
                <ThreadList />
              </div>
            </aside>
            <main className="flex min-h-0 min-w-0 flex-grow flex-col overflow-hidden">
              <Thread />
            </main>
          </div>
        </div>
      </TooltipProvider>
    </PiRuntimeProvider>
  )
}
