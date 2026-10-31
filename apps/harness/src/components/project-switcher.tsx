import type { HarnessProjectTrust, HarnessProjectTrustOrigin } from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import { FolderOpenIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { type ProjectUiError, useProject } from './project-context'

const originLabel = (origin: HarnessProjectTrustOrigin) => {
  switch (origin) {
    case 'explicit':
      return <Trans>本次决定</Trans>
    case 'extension':
      return <Trans>用户扩展决定</Trans>
    case 'saved':
      return <Trans>已保存决定</Trans>
    case 'default':
      return <Trans>默认策略</Trans>
    case 'ask':
      return <Trans>等待用户回答</Trans>
    case 'no-resources':
      return <Trans>无受保护资源</Trans>
    case 'none':
      return <Trans>未评估</Trans>
  }
}

const errorLabel = (code: ProjectUiError) => {
  switch (code) {
    case 'invalid-path':
      return <Trans>路径无效，请输入宿主机上的绝对路径。</Trans>
    case 'not-found':
      return <Trans>路径不存在，请检查后重试。</Trans>
    case 'not-directory':
      return <Trans>该路径不是目录，请选择项目目录。</Trans>
    case 'load-failed':
      return <Trans>项目装配失败，请查看宿主终端后重试。</Trans>
  }
}

/** 信任摘要徽标：让页面始终能看到实际决定来源。 */
function TrustBadge({ trust }: { trust: HarnessProjectTrust }) {
  if (trust.decision === 'trusted') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <ShieldCheckIcon aria-hidden className="size-3.5" />
        {trust.origin === 'no-resources' ? <Trans>无受保护资源</Trans> : <Trans>已信任</Trans>}
      </span>
    )
  }
  if (trust.decision === 'untrusted') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <ShieldXIcon aria-hidden className="size-3.5" />
        <Trans>仅用户资源</Trans>
      </span>
    )
  }
  return (
    <span className="text-destructive inline-flex items-center gap-1 text-xs">
      <ShieldAlertIcon aria-hidden className="size-3.5" />
      <Trans>需要信任决定</Trans>
    </span>
  )
}

/** 信任说明与操作：允许/拒绝 + 可选记住当前路径。 */
function TrustPrompt({ onDone }: { onDone: () => void }) {
  const { pendingTrust, busy, error, decideTrust, cancelTrust } = useProject()
  const [remember, setRemember] = useState(false)
  if (!pendingTrust) return null
  const trust = pendingTrust.trust

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>
          <Trans>项目需要信任确认</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            该项目包含 Pi
            扩展、项目设置、技能或模板等本地资源。允许后这些代码会以你的用户权限运行；信任不是沙箱。拒绝仍可对话和查看历史，但不会加载项目资源。
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          <Trans>项目路径</Trans>
        </dt>
        <dd className="break-all">{pendingTrust.path}</dd>
        <dt className="text-muted-foreground">
          <Trans>决定来源</Trans>
        </dt>
        <dd>{originLabel(trust.origin)}</dd>
        <dt className="text-muted-foreground">
          <Trans>默认策略</Trans>
        </dt>
        <dd>
          {trust.defaultPolicy === 'always' ? (
            <Trans>总是允许</Trans>
          ) : trust.defaultPolicy === 'never' ? (
            <Trans>总是拒绝</Trans>
          ) : (
            <Trans>询问</Trans>
          )}
        </dd>
        {trust.savedPath && (
          <>
            <dt className="text-muted-foreground">
              <Trans>保存决定</Trans>
            </dt>
            <dd className="break-all">{trust.savedPath}</dd>
          </>
        )}
      </dl>
      {trust.extensionErrorCount > 0 && (
        <p role="status" className="text-destructive text-sm">
          <Trans>用户扩展的信任处理出现错误，已跳过并继续评估；详情见宿主终端。</Trans>
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {errorLabel(error)}
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-current"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        <Trans>记住此决定（写入当前路径的 trust.json）</Trans>
      </label>
      <p className="text-muted-foreground text-xs">
        <Trans>
          信任变更只影响下一次装配；已经执行的代码不会卸载。需要完全生效时请重新打开相关会话或重启宿主。
        </Trans>
      </p>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => cancelTrust()}>
          <Trans>取消</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void decideTrust({ trusted: false, remember }).then((done) => {
              if (done) onDone()
            })
          }
        >
          <Trans>本次拒绝</Trans>
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void decideTrust({ trusted: true, remember }).then((done) => {
              if (done) onDone()
            })
          }
        >
          <Trans>本次允许</Trans>
        </Button>
      </DialogFooter>
    </div>
  )
}

/** 页头项目入口：当前路径、信任来源、打开对话框与最近项目。 */
export function ProjectSwitcher() {
  const {
    project,
    hostInfo,
    recent,
    busy,
    error,
    pendingTrust,
    openProject,
    reviewTrust,
    cancelTrust,
  } = useProject()
  const [open, setOpen] = useState(false)
  const [draftPath, setDraftPath] = useState('')

  // 打开对话框时以当前项目路径为起点；不覆盖用户正在编辑的草稿。
  useEffect(() => {
    if (open && !pendingTrust) setDraftPath(project?.path ?? hostInfo?.workspacePath ?? '')
  }, [open, pendingTrust, project?.path, hostInfo?.workspacePath])

  const handleOpenChange = (next: boolean) => {
    if (!next && pendingTrust) cancelTrust()
    setOpen(next)
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto min-w-0 justify-start px-2 py-1"
        onClick={() => setOpen(true)}
        aria-label="打开项目"
        data-slot="huan-project-switcher"
      >
        <FolderOpenIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">
          {project?.name ?? hostInfo?.workspacePath}
        </span>
        <span className="text-muted-foreground hidden max-w-80 truncate text-xs sm:inline">
          {project?.path ?? hostInfo?.workspacePath}
        </span>
      </Button>
      {project && (
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 hover:bg-accent"
          onClick={() => reviewTrust()}
          aria-label="查看项目信任状态"
        >
          <TrustBadge trust={project.trust} />
        </button>
      )}

      <Dialog open={open || Boolean(pendingTrust)} onOpenChange={handleOpenChange}>
        <DialogContent aria-label={pendingTrust ? '项目信任确认' : '打开项目'}>
          {pendingTrust ? (
            <TrustPrompt key={pendingTrust.path} onDone={() => setOpen(false)} />
          ) : (
            <div className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>
                  <Trans>打开项目</Trans>
                </DialogTitle>
                <DialogDescription>
                  <Trans>
                    输入宿主机器上的项目绝对路径。浏览器目录选择器返回的是浏览器文件，不能作为宿主项目路径。
                  </Trans>
                </DialogDescription>
              </DialogHeader>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void openProject(draftPath).then((opened) => {
                    if (opened) setOpen(false)
                  })
                }}
              >
                <Input
                  autoFocus
                  value={draftPath}
                  onChange={(event) => setDraftPath(event.target.value)}
                  aria-label="项目路径"
                  placeholder="/home/user/project"
                />
                <Button type="submit" disabled={busy || draftPath.trim().length === 0}>
                  <Trans>打开</Trans>
                </Button>
              </form>
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {errorLabel(error)}
                </p>
              )}
              <div className="flex flex-col gap-1">
                <p className="text-muted-foreground text-xs">
                  <Trans>最近项目</Trans>
                </p>
                {recent.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    <Trans>暂无最近项目。</Trans>
                  </p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto">
                    {recent.map((item) => (
                      <li key={item.path}>
                        <button
                          type="button"
                          className="hover:bg-accent flex w-full flex-col items-start rounded-md px-2 py-1.5 text-start"
                          onClick={() => {
                            void openProject(item.path).then((opened) => {
                              if (opened) setOpen(false)
                            })
                          }}
                        >
                          <span className="truncate text-sm">{item.name}</span>
                          <span className="text-muted-foreground w-full truncate text-xs">
                            {item.path}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
