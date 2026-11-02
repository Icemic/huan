/**
 * 工作区创建/编辑与新建会话弹层。
 *
 * 表单、列表控制与提示状态在应用工作区 Zustand store；工作区定义只在公共
 * serviceStore。成员路径健康与信任决定面板暂留 R6，本包只保留工作区保存与
 * 选择起始项目的业务动作，不恢复旧的模块级目录/HTTP 包装。
 */

import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, PlusIcon, Trash2Icon } from 'lucide-react'
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
import { useWorkspaceStore } from '@/state/app-context'

const mutationDisabled = (state: string | undefined): boolean =>
  state !== undefined && state !== 'ok'

/** 工作区管理/创建弹层。 */
export function WorkspaceManagerDialog() {
  const form = useWorkspaceStore((state) => state.form)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const closeWorkspaceForm = useWorkspaceStore((state) => state.closeWorkspaceForm)
  const setWorkspaceFormName = useWorkspaceStore((state) => state.setWorkspaceFormName)
  const setWorkspaceMember = useWorkspaceStore((state) => state.setWorkspaceMember)
  const addWorkspaceMember = useWorkspaceStore((state) => state.addWorkspaceMember)
  const removeWorkspaceMember = useWorkspaceStore((state) => state.removeWorkspaceMember)
  const saveWorkspaceForm = useWorkspaceStore((state) => state.saveWorkspaceForm)
  const disabled = mutationDisabled(workspaceState)

  return (
    <Dialog
      open={form.open}
      onOpenChange={(open) => {
        if (!open) closeWorkspaceForm()
      }}
    >
      <DialogContent
        aria-label={form.mode === 'edit' ? '管理工作区' : '新建工作区'}
        className="max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {form.mode === 'edit' ? <Trans>管理工作区</Trans> : <Trans>新建工作区</Trans>}
          </DialogTitle>
          <DialogDescription>
            <Trans>
              工作区包含一个或多个项目目录。会话固定使用起始项目作为 cwd；其他成员通过 @别名
              访问，不会装配它们的扩展。
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            <Trans>工作区名称</Trans>
          </span>
          <Input
            value={form.name}
            onChange={(event) => setWorkspaceFormName(event.target.value)}
            aria-label="工作区名称"
            placeholder="例如：幻开发"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              <Trans>项目成员</Trans>
            </span>
            <Button variant="outline" size="sm" onClick={addWorkspaceMember}>
              <PlusIcon aria-hidden className="size-4" />
              <Trans>添加成员</Trans>
            </Button>
          </div>
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {form.members.map((member) => (
              <div
                key={member.key}
                data-slot="huan-workspace-member"
                className="flex items-center gap-2 rounded-md border p-2"
              >
                <Input
                  className="w-32"
                  value={member.alias}
                  onChange={(event) =>
                    setWorkspaceMember(member.key, { alias: event.target.value })
                  }
                  aria-label="项目别名"
                  placeholder="别名"
                />
                <Input
                  className="min-w-0 flex-1"
                  value={member.path}
                  onChange={(event) => setWorkspaceMember(member.key, { path: event.target.value })}
                  aria-label="项目路径"
                  placeholder="/home/user/project"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="移除成员"
                  disabled={form.members.length <= 1}
                  onClick={() => removeWorkspaceMember(member.key)}
                >
                  <Trash2Icon aria-hidden className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {disabled && (
          <p role="alert" className="text-destructive text-sm">
            <Trans>工作区元数据不可用；请先修复 state.json。当前修改已禁用。</Trans>
          </p>
        )}
        {form.message && (
          <p role="alert" className="text-destructive text-sm">
            {form.message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={form.busy} onClick={closeWorkspaceForm}>
            <Trans>取消</Trans>
          </Button>
          <Button
            disabled={form.busy || disabled || form.name.trim().length === 0}
            onClick={() => void saveWorkspaceForm()}
          >
            {form.busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <Trans>保存</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建会话：把窗口起始项目写入 windowStore 的新会话目标。 */
export function NewSessionDialog() {
  const newSession = useWorkspaceStore((state) => state.newSession)
  const workspace = useServiceStore((state) =>
    newSession.workspaceId ? state.workspacesById[newSession.workspaceId] : undefined,
  )
  const closeNewSession = useWorkspaceStore((state) => state.closeNewSession)
  const setNewSessionPath = useWorkspaceStore((state) => state.setNewSessionPath)
  const startNewSession = useWorkspaceStore((state) => state.startNewSession)

  if (!workspace) return null

  return (
    <Dialog
      open={Boolean(newSession.workspaceId)}
      onOpenChange={(open) => {
        if (!open) closeNewSession()
      }}
    >
      <DialogContent aria-label="新建会话">
        <DialogHeader>
          <DialogTitle>
            <Trans>新建会话</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              选择起始项目。会话创建后 cwd 固定，可在同一工作区其他项目间通过 @别名 读写与执行命令。
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-sm">
            <Trans>起始项目</Trans>
          </span>
          <div className="flex flex-col gap-1">
            {workspace.projects.map((project) => (
              <label
                key={project.path}
                className="hover:bg-accent flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <input
                  type="radio"
                  name={`start-project-${workspace.id}`}
                  className="mt-1 size-4 accent-current"
                  value={project.path}
                  checked={newSession.selectedPath === project.path}
                  onChange={() => setNewSessionPath(project.path)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    @{project.alias}
                    {!project.available && (
                      <span className="text-destructive ms-2 text-xs">
                        <Trans>路径缺失</Trans>
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground w-full break-all text-xs">
                    {project.path}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeNewSession}>
            <Trans>取消</Trans>
          </Button>
          <Button disabled={!newSession.selectedPath} onClick={startNewSession}>
            <Trans>开始新会话</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
