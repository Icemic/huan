import { useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { ThreadList } from '@/components/assistant-ui/elements/thread-list.aui'
import { PiHostStatus } from '@/components/pi-host-status'
import { PiLiveSubscription } from '@/components/pi-live-subscription'
import { PiRuntimeProvider } from '@/components/pi-runtime-provider'
import { ProjectProvider, useProject } from '@/components/project-context'
import { ProjectContinueRecent, ProjectGate, ProjectTrustBanner } from '@/components/project-panel'
import { ProjectSwitcher } from '@/components/project-switcher'
import { TooltipProvider } from '@/components/ui/tooltip'

/** 就绪度横幅：模型/凭据不可用时给出提示。 */
function ReadinessBanner() {
  const readiness = useHarnessThreadState((state) => state.readiness)
  if (!readiness || readiness.state === 'ready') return null
  return (
    <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {readiness.message ?? <Trans>Pi 运行时没有可用模型。</Trans>}
    </div>
  )
}

/**
 * 当前项目的会话工作区。
 *
 * 运行时按项目重建：旧 Controller 只退订事件，不停止宿主运行；其他项目的
 * 运行与其他窗口不受影响。切换项目不改变 process.cwd。
 */
function ProjectWorkspace() {
  const { project } = useProject()
  if (!project) return null

  const canRun = project.status === 'ready'
  return (
    <PiRuntimeProvider key={project.path} workspacePath={project.path} readOnly={!canRun}>
      {canRun && <PiLiveSubscription />}
      <ProjectTrustBanner />
      <PiHostStatus />
      <ReadinessBanner />
      <div className="flex min-h-0 flex-grow">
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r">
          <div className="flex flex-col gap-1 border-b p-2">
            <ProjectContinueRecent />
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <ThreadList />
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-grow flex-col overflow-hidden">
          <Thread />
        </main>
      </div>
    </PiRuntimeProvider>
  )
}

/** 应用主界面：页头项目入口 + 左侧会话列表 + 右侧聊天区。 */
export function App() {
  return (
    <ProjectProvider>
      <TooltipProvider>
        <div className="flex h-dvh flex-col overflow-hidden">
          <header className="flex items-center gap-3 border-b px-4 py-2">
            <span className="font-semibold">幻</span>
            <ProjectSwitcher />
          </header>
          <ProjectGate>
            <ProjectWorkspace />
          </ProjectGate>
        </div>
      </TooltipProvider>
    </ProjectProvider>
  )
}
