/**
 * 工作区管理、新建会话、未归属接入与信任决定弹层。
 *
 * 只提交宿主 CRUD；路径健康与信任信息来自宿主查询，不在浏览器推断。
 * 修改携带 revision，冲突时展示重读提示并刷新权威定义。
 */

import { useAui } from '@assistant-ui/react'
import type {
  HarnessProjectInfo,
  HarnessThreadMetadata,
  HarnessWorkspace,
  HarnessWorkspaceMutationResult,
  HarnessWorkspaceProjectInput,
} from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import {
  CheckCircle2Icon,
  FolderPlusIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  Trash2Icon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
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
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { harnessHttpClient } from './pi-http-client'
import { useWorkspace } from './workspace-context'

type MemberDraft = {
  key: string
  alias: string
  path: string
  available?: boolean
  checking?: boolean
  trust?: HarnessProjectInfo
  trustFailed?: boolean
}

let memberKeySeed = 0
const nextMemberKey = () => {
  memberKeySeed += 1
  return `member-${memberKeySeed}`
}

const draftFromProject = (project: HarnessWorkspace['projects'][number]): MemberDraft => ({
  key: nextMemberKey(),
  alias: project.alias,
  path: project.path,
  available: project.available,
})

const mutationErrorText = (result: HarnessWorkspaceMutationResult): string => {
  if (result.ok) return ''
  switch (result.error) {
    case 'conflict':
      return '工作区已在其他窗口更新，已重新读取权威定义；请确认后再次保存。'
    case 'state-unavailable':
      return '工作区元数据不可用；冷历史仍可查看，但修改已禁用。'
    case 'not-found':
      return '工作区已不存在，请刷新列表。'
    case 'invalid':
      return `工作区输入无效：${result.reason ?? '未知原因'}`
  }
}

function TrustBadge({ info }: { info: HarnessProjectInfo | undefined }) {
  if (!info) return null
  if (info.status === 'failed') {
    return (
      <span className="text-destructive inline-flex items-center gap-1 text-xs">
        <ShieldAlertIcon aria-hidden className="size-3.5" />
        <Trans>装配失败</Trans>
      </span>
    )
  }
  if (info.status === 'needs-trust') {
    return (
      <span className="text-destructive inline-flex items-center gap-1 text-xs">
        <ShieldAlertIcon aria-hidden className="size-3.5" />
        <Trans>需要信任决定</Trans>
      </span>
    )
  }
  if (info.trust.decision === 'trusted') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <ShieldCheckIcon aria-hidden className="size-3.5" />
        <Trans>已信任</Trans>
      </span>
    )
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
      <ShieldXIcon aria-hidden className="size-3.5" />
      <Trans>仅用户资源</Trans>
    </span>
  )
}

/** 信任决定面板（内嵌在管理/新建弹层中，避免叠加多个 Dialog）。 */
function TrustDecisionPanel({
  path,
  onDone,
}: {
  path: string
  onDone: (info: HarnessProjectInfo | undefined) => void
}) {
  const [info, setInfo] = useState<HarnessProjectInfo>()
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    void harnessHttpClient
      .getProject({ path })
      .then((next) => {
        if (active) setInfo(next)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [path])

  const decide = async (trusted: boolean) => {
    setBusy(true)
    setError(false)
    try {
      const next = await harnessHttpClient.decideProjectTrust({
        path,
        trusted,
        ...(remember ? { remember: true } : {}),
      })
      onDone(next)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm">
        <Trans>
          该项目包含需要信任的本地资源。允许后项目扩展会以你的用户权限运行；拒绝仍可对话，但不会加载项目资源。
        </Trans>
      </p>
      <p className="text-muted-foreground break-all text-xs">{path}</p>
      {info && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            <Trans>当前状态</Trans>
          </span>
          <TrustBadge info={info} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          <Trans>信任查询或保存失败，请查看宿主终端后重试。</Trans>
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
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => onDone(undefined)}>
          <Trans>稍后处理</Trans>
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
          <Trans>本次拒绝</Trans>
        </Button>
        <Button disabled={busy} onClick={() => void decide(true)}>
          {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
          <Trans>本次允许</Trans>
        </Button>
      </div>
    </div>
  )
}

/** 工作区管理/创建弹层。 */
export function WorkspaceManagerDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: HarnessWorkspace
}) {
  const { refresh, showNotice, state } = useWorkspace()
  const [revision, setRevision] = useState(workspace?.revision)
  const [name, setName] = useState('')
  const [members, setMembers] = useState<MemberDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [trustPath, setTrustPath] = useState<string>()

  const inspect = useCallback(async (member: MemberDraft) => {
    const path = member.path.trim()
    if (!path) return
    setMembers((current) =>
      current.map((item) => (item.key === member.key ? { ...item, checking: true } : item)),
    )
    try {
      const check = await harnessHttpClient.checkProjectPath(path)
      const available = !check.error && check.exists && check.isDirectory
      let trust: HarnessProjectInfo | undefined
      let trustFailed = false
      if (available) {
        try {
          trust = await harnessHttpClient.inspectProjectTrust({ path: check.path })
        } catch {
          trustFailed = true
        }
      }
      setMembers((current) =>
        current.map((item) =>
          item.key === member.key
            ? { ...item, checking: false, available, trust, trustFailed }
            : item,
        ),
      )
    } catch {
      setMembers((current) =>
        current.map((item) =>
          item.key === member.key ? { ...item, checking: false, available: false } : item,
        ),
      )
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setMessage(undefined)
    setTrustPath(undefined)
    setName(workspace?.name ?? '')
    setRevision(workspace?.revision)
    const drafts = workspace
      ? workspace.projects.map(draftFromProject)
      : [{ key: nextMemberKey(), alias: '', path: '' }]
    setMembers(drafts)
    // 现有成员打开时检查路径健康与信任；新成员在失焦/保存时检查。
    if (workspace) for (const member of drafts) void inspect(member)
  }, [inspect, open, workspace])

  const updateMember = (key: string, patch: Partial<MemberDraft>) => {
    setMembers((current) =>
      current.map((member) => (member.key === key ? { ...member, ...patch } : member)),
    )
  }

  const applyConflict = (next: HarnessWorkspace) => {
    setName(next.name)
    setRevision(next.revision)
    setMembers(next.projects.map(draftFromProject))
    void refresh()
  }

  const save = async () => {
    const projects: HarnessWorkspaceProjectInput[] = members
      .filter((member) => member.alias.trim() || member.path.trim())
      .map((member) => ({ alias: member.alias.trim(), path: member.path.trim() }))
    setBusy(true)
    setMessage(undefined)
    try {
      const result = workspace
        ? await harnessHttpClient.updateWorkspace({
            workspaceId: workspace.id,
            expectedRevision: revision ?? workspace.revision,
            name: name.trim(),
            projects,
          })
        : await harnessHttpClient.createWorkspace({ name: name.trim(), projects })
      if (!result.ok) {
        setMessage(mutationErrorText(result))
        if (result.workspace) applyConflict(result.workspace)
        return
      }
      await refresh()
      showNotice(workspace ? '工作区已更新。' : '工作区已创建。')
      onOpenChange(false)
    } catch {
      setMessage('保存失败，请检查宿主连接后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label={workspace ? '管理工作区' : '新建工作区'} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {workspace ? <Trans>管理工作区</Trans> : <Trans>新建工作区</Trans>}
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
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="工作区名称"
            placeholder="例如：幻开发"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              <Trans>项目成员</Trans>
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setMembers((current) => [...current, { key: nextMemberKey(), alias: '', path: '' }])
              }
            >
              <PlusIcon aria-hidden className="size-4" />
              <Trans>添加成员</Trans>
            </Button>
          </div>
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {members.map((member) => (
              <div
                key={member.key}
                data-slot="huan-workspace-member"
                className="flex flex-col gap-1 rounded-md border p-2"
              >
                <div className="flex items-center gap-2">
                  <Input
                    className="w-32"
                    value={member.alias}
                    onChange={(event) => updateMember(member.key, { alias: event.target.value })}
                    onBlur={() => void inspect(member)}
                    aria-label="项目别名"
                    placeholder="别名"
                  />
                  <Input
                    className="min-w-0 flex-1"
                    value={member.path}
                    onChange={(event) =>
                      updateMember(member.key, {
                        path: event.target.value,
                        available: undefined,
                        trust: undefined,
                        trustFailed: false,
                      })
                    }
                    onBlur={() => void inspect(member)}
                    aria-label="项目路径"
                    placeholder="/home/user/project"
                  />
                  <Popover>
                    <PopoverTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="成员操作"
                          className="data-popup-open:bg-accent"
                        />
                      }
                    >
                      <MoreHorizontalIcon aria-hidden className="size-4" />
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-36 p-1">
                      <PopoverClose
                        render={
                          <button
                            type="button"
                            className="text-destructive hover:bg-destructive/10 flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm disabled:pointer-events-none disabled:opacity-50"
                            disabled={members.length === 1}
                          />
                        }
                        onClick={() =>
                          setMembers((current) => current.filter((item) => item.key !== member.key))
                        }
                      >
                        <Trash2Icon aria-hidden className="size-4" />
                        <Trans>移除成员</Trans>
                      </PopoverClose>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="flex min-h-5 flex-wrap items-center gap-2 px-1 text-xs">
                  {member.checking ? (
                    <span className="text-muted-foreground inline-flex items-center gap-1">
                      <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                      <Trans>检查路径与信任…</Trans>
                    </span>
                  ) : member.available === true ? (
                    <span className="text-muted-foreground inline-flex items-center gap-1">
                      <CheckCircle2Icon aria-hidden className="size-3.5" />
                      <Trans>路径可用</Trans>
                    </span>
                  ) : member.available === false ? (
                    <span className="text-destructive inline-flex items-center gap-1">
                      <ShieldAlertIcon aria-hidden className="size-3.5" />
                      <Trans>路径缺失或不是目录；记录会保留，会话仍固定原起始目录。</Trans>
                    </span>
                  ) : null}
                  {member.trustFailed && (
                    <span className="text-destructive">
                      <Trans>项目装配检查失败</Trans>
                    </span>
                  )}
                  <TrustBadge info={member.trust} />
                  {member.trust?.status === 'needs-trust' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1 text-xs"
                      onClick={() => setTrustPath(member.path.trim())}
                    >
                      <Trans>决定信任</Trans>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {trustPath ? (
          <TrustDecisionPanel
            path={trustPath}
            onDone={(info) => {
              setTrustPath(undefined)
              if (info) {
                setMembers((current) =>
                  current.map((member) =>
                    member.path.trim() === trustPath ? { ...member, trust: info } : member,
                  ),
                )
              }
            }}
          />
        ) : null}

        {state !== 'ok' && (
          <p role="alert" className="text-destructive text-sm">
            <Trans>工作区元数据不可用；请先修复 state.json。当前修改已禁用。</Trans>
          </p>
        )}
        {message && (
          <p role="alert" className="text-destructive text-sm">
            {message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button
            disabled={busy || state !== 'ok' || name.trim().length === 0 || members.length === 0}
            onClick={() => void save()}
          >
            {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <Trans>保存</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建会话：选择该窗口的起始项目；偏好按工作区保存在 sessionStorage。 */
export function NewSessionDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: HarnessWorkspace
}) {
  const aui = useAui()
  const { startProjectFor, beginNewSession, showNotice } = useWorkspace()
  const [selected, setSelected] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [trustPath, setTrustPath] = useState<string>()

  useEffect(() => {
    if (!open) return
    setMessage(undefined)
    setTrustPath(undefined)
    setSelected(startProjectFor(workspace) ?? '')
  }, [open, startProjectFor, workspace])

  const start = () => {
    if (!selected) return
    beginNewSession(workspace.id, selected)
    showNotice(`新会话将以 ${selected} 作为固定起始目录。`)
    onOpenChange(false)
    // 实际 Pi 会话在首条消息发送时创建；工作区与起始项目已写入窗口目标。
    void aui.threads.switchToNewThread()
  }

  const confirm = async () => {
    if (!selected) return
    setBusy(true)
    setMessage(undefined)
    try {
      const info = await harnessHttpClient.getProject({ path: selected })
      if (info.status === 'failed') {
        setMessage('起始项目装配失败，请检查路径与宿主诊断。')
        return
      }
      if (info.status === 'needs-trust') {
        setTrustPath(selected)
        return
      }
      start()
    } catch {
      setMessage('无法检查起始项目，请查看宿主连接后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                  checked={selected === project.path}
                  onChange={() => setSelected(project.path)}
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

        {trustPath ? (
          <TrustDecisionPanel
            path={trustPath}
            onDone={(info) => {
              if (info?.status === 'ready') {
                setTrustPath(undefined)
                start()
              } else {
                setTrustPath(undefined)
              }
            }}
          />
        ) : null}

        {message && (
          <p role="alert" className="text-destructive text-sm">
            {message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button disabled={busy || !selected} onClick={() => void confirm()}>
            {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <Trans>开始新会话</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 未归属会话明确加入工作区。 */
export function AssignWorkspaceDialog({
  open,
  onOpenChange,
  thread,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  thread: HarnessThreadMetadata
}) {
  const { workspaces, refresh, showNotice, state } = useWorkspace()
  const [workspaceId, setWorkspaceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    if (!open) return
    setWorkspaceId(workspaces[0]?.id ?? '')
    setMessage(undefined)
  }, [open, workspaces])

  const assign = async () => {
    if (!workspaceId) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await harnessHttpClient.assignThreadWorkspace({
        threadId: thread.id,
        workspaceId,
      })
      if (!result.ok) {
        setMessage(
          result.error === 'state-unavailable'
            ? '工作区元数据不可用，无法保存会话归属。'
            : '工作区或会话已不存在，请刷新后重试。',
        )
        return
      }
      await refresh()
      showNotice('会话已加入工作区。')
      onOpenChange(false)
    } catch {
      setMessage('保存会话归属失败，请检查宿主连接后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="加入工作区">
        <DialogHeader>
          <DialogTitle>
            <Trans>加入工作区</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>该会话没有工作区归属。请明确选择目标工作区；宿主不会按 cwd 自动猜测。</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <span className="break-all">
            {thread.title ?? <Trans>未命名会话</Trans>}
            {thread.workspacePath ? ` — ${thread.workspacePath}` : ''}
          </span>
          <select
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            aria-label="目标工作区"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>
        {state !== 'ok' && (
          <p role="alert" className="text-destructive text-sm">
            <Trans>工作区元数据不可用，会话归属修改已禁用。</Trans>
          </p>
        )}
        {message && (
          <p role="alert" className="text-destructive text-sm">
            {message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button disabled={busy || state !== 'ok' || !workspaceId} onClick={() => void assign()}>
            {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <FolderPlusIcon aria-hidden className="size-4" />
            <Trans>加入</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
