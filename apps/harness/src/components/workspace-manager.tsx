/**
 * 工作区创建/编辑、新建会话预检与信任决定。
 *
 * 表单、路径健康、信任查询和忙状态都在工作区 feature Zustand；组件只选择
 * 状态并触发动作。工作区定义与目录仍只来自公共 serviceStore。
 */

import type { HarnessProjectInfo } from '@huan/protocol'
import { selectHarnessModelCatalog, useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  CheckCircle2Icon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemHeader } from '@/components/ui/item'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMcpStore, useSettingsStore, useWorkspaceStore } from '@/state/app-context'
import type { WorkspaceMemberDraft } from '@/state/workspace-store'
import { ModelScopeEditor } from './model-scope-editor'

const mutationDisabled = (state: string | undefined): boolean =>
  state !== undefined && state !== 'ok'

function TrustBadge({ info }: { info: HarnessProjectInfo | undefined }) {
  if (!info) return null
  if (info.status === 'failed') {
    return (
      <Badge variant="destructive">
        <ShieldAlertIcon aria-hidden />
        <Trans>装配失败</Trans>
      </Badge>
    )
  }
  if (info.status === 'needs-trust') {
    return (
      <Badge variant="destructive">
        <ShieldAlertIcon aria-hidden />
        <Trans>需要信任决定</Trans>
      </Badge>
    )
  }
  if (info.trust.decision === 'trusted') {
    return (
      <Badge variant="secondary">
        <ShieldCheckIcon aria-hidden />
        <Trans>已信任</Trans>
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <ShieldXIcon aria-hidden />
      <Trans>仅用户资源</Trans>
    </Badge>
  )
}

/** 信任决定面板：状态来自工作区 store；调用方负责打开。 */
export function TrustDecisionPanel({
  path,
  onDone,
  intentKind = 'none',
}: {
  path: string
  onDone?: (info: HarnessProjectInfo | undefined) => void
  /** 同一面板由不同入口打开；只显示匹配来源的信任状态。 */
  intentKind?: 'none' | 'new-session' | 'standalone'
}) {
  const trust = useWorkspaceStore((state) => state.trust)
  const setRemember = useWorkspaceStore((state) => state.setTrustRemember)
  const decideTrust = useWorkspaceStore((state) => state.decideTrust)
  const closeTrust = useWorkspaceStore((state) => state.closeTrust)
  const rememberId = useId()

  // 是否显示由调用方按 open 决定；这里只校验路径，使关闭请求后的面板能随
  // 对话框继续渲染到退出动画结束。
  if (trust.path !== path) return null
  const intentMatches =
    intentKind === 'none' ? trust.intent === undefined : trust.intent?.kind === intentKind
  if (!intentMatches) return null
  const active = trust.info
  return (
    <Item
      data-slot="huan-trust-panel"
      variant="muted"
      size="sm"
      className="flex-col items-stretch gap-2"
    >
      <ItemContent className="gap-1">
        <p className="text-sm">
          <Trans>
            该项目包含需要信任的本地资源。允许后项目扩展会以你的用户权限运行；拒绝仍可对话，但不会加载项目资源。
          </Trans>
        </p>
        <p className="text-muted-foreground break-all text-xs">{path}</p>
        {trust.loading ? (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            <Trans>正在查询项目信任…</Trans>
          </span>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              <Trans>当前状态</Trans>
            </span>
            <TrustBadge info={active} />
          </div>
        )}
        {trust.error && (
          <Alert variant="destructive">
            <AlertDescription>
              <Trans>信任查询或保存失败，请查看宿主终端后重试。</Trans>
            </AlertDescription>
          </Alert>
        )}
      </ItemContent>
      <Field orientation="horizontal" className="gap-2">
        <Checkbox
          id={rememberId}
          checked={trust.remember}
          disabled={trust.busy}
          onCheckedChange={(checked) => setRemember(checked)}
        />
        <FieldLabel htmlFor={rememberId} className="cursor-pointer font-normal">
          <Trans>记住此决定（写入当前路径的 trust.json）</Trans>
        </FieldLabel>
      </Field>
      <ItemActions className="flex-wrap justify-end">
        <Button
          variant="outline"
          disabled={trust.busy}
          onClick={() => {
            closeTrust()
            onDone?.(undefined)
          }}
        >
          <Trans>稍后处理</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={trust.busy}
          onClick={() => void decideTrust(false).then((info) => onDone?.(info))}
        >
          <Trans>本次拒绝</Trans>
        </Button>
        <Button
          disabled={trust.busy}
          onClick={() => void decideTrust(true).then((info) => onDone?.(info))}
        >
          {trust.busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
          <Trans>本次允许</Trans>
        </Button>
      </ItemActions>
    </Item>
  )
}

/** 工作区管理/创建弹层。 */
export function WorkspaceManagerDialog() {
  const form = useWorkspaceStore((state) => state.form)
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const workspaceRevision = useServiceStore((state) =>
    form.workspaceId ? state.workspacesById[form.workspaceId]?.revision : undefined,
  )
  const authRevision = useServiceStore((state) => state.providerAuth?.authRevision)
  const modelEntry = useServiceStore((state) => {
    if (!form.modelCatalogPath) return undefined
    return selectHarnessModelCatalog(state, {
      workspacePath: form.modelCatalogPath,
      ...(form.workspaceId ? { workspaceId: form.workspaceId } : {}),
      all: true,
    })
  })
  const closeWorkspaceForm = useWorkspaceStore((state) => state.closeWorkspaceForm)
  const finishCloseWorkspaceForm = useWorkspaceStore((state) => state.finishCloseWorkspaceForm)
  const setWorkspaceFormName = useWorkspaceStore((state) => state.setWorkspaceFormName)
  const setWorkspaceModelScopeMode = useWorkspaceStore((state) => state.setWorkspaceModelScopeMode)
  const setWorkspaceFormModelPatterns = useWorkspaceStore(
    (state) => state.setWorkspaceFormModelPatterns,
  )
  const loadWorkspaceModels = useWorkspaceStore((state) => state.loadWorkspaceModels)
  const refreshWorkspaceModels = useWorkspaceStore((state) => state.refreshWorkspaceModels)
  const setWorkspaceMember = useWorkspaceStore((state) => state.setWorkspaceMember)
  const inspectWorkspaceMember = useWorkspaceStore((state) => state.inspectWorkspaceMember)
  const openTrust = useWorkspaceStore((state) => state.openTrust)
  const addWorkspaceMember = useWorkspaceStore((state) => state.addWorkspaceMember)
  const removeWorkspaceMember = useWorkspaceStore((state) => state.removeWorkspaceMember)
  const saveWorkspaceForm = useWorkspaceStore((state) => state.saveWorkspaceForm)
  const openContextSettings = useSettingsStore((state) => state.openPanel)
  const openContextMcp = useMcpStore((state) => state.openPanel)
  const disabled = mutationDisabled(workspaceState)
  const models = modelEntry?.models ?? []
  const nameId = useId()
  const scopeId = useId()
  // 项目设置/MCP 是独立弹层；先关闭工作区管理器，等退出完成后再打开，避免嵌套焦点。
  const pendingOpen = useRef<(() => void) | undefined>(undefined)
  const openAfterClose = (action: () => void) => {
    pendingOpen.current = action
    closeWorkspaceForm()
  }

  // 完整目录只服务自定义范围；打开表单或版本变化时读取。继承全局不查询，
  // 避免信任未决的项目装配被目录请求触发。范围切换由 store 动作读取，不重复触发。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 目录版本是 serviceStore 查询键，范围切换由动作触发
  useEffect(() => {
    if (!form.open || form.modelScopeMode !== 'custom') return
    void loadWorkspaceModels()
  }, [
    form.open,
    form.workspaceId,
    form.modelCatalogPath,
    form.revision,
    workspaceRevision,
    authRevision,
    loadWorkspaceModels,
  ])

  return (
    <Dialog
      open={form.open}
      onOpenChange={(open) => {
        if (!open) closeWorkspaceForm()
      }}
      onOpenChangeComplete={(open) => {
        if (open) return
        // 退出动画完成后再清空表单并执行关闭后打开动作，避免退出时正文变空。
        finishCloseWorkspaceForm()
        const action = pendingOpen.current
        pendingOpen.current = undefined
        action?.()
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
        </DialogHeader>

        <Field className="gap-1 text-sm">
          <FieldLabel htmlFor={nameId} className="text-muted-foreground font-normal">
            <Trans>工作区名称</Trans>
          </FieldLabel>
          <Input
            id={nameId}
            value={form.name}
            onChange={(event) => setWorkspaceFormName(event.target.value)}
            placeholder="例如：幻开发"
          />
        </Field>

        <div className="flex flex-col gap-2" data-slot="huan-workspace-model-scope">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              <Trans>模型范围</Trans>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !form.modelCatalogPath ||
                form.busy ||
                form.modelRefreshing ||
                modelEntry?.loading === true
              }
              onClick={() => void refreshWorkspaceModels()}
            >
              {form.modelRefreshing || modelEntry?.loading ? (
                <Loader2Icon aria-hidden className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon aria-hidden className="size-4" />
              )}
              <Trans>刷新目录</Trans>
            </Button>
          </div>
          <RadioGroup
            value={form.modelScopeMode}
            onValueChange={(value) => {
              if (value === 'inherit' || value === 'custom') setWorkspaceModelScopeMode(value)
            }}
            aria-label="模型范围模式"
            className="flex flex-wrap gap-4 text-sm"
          >
            <Field orientation="horizontal" className="w-auto gap-2">
              <RadioGroupItem id={`${scopeId}-inherit`} value="inherit" />
              <FieldLabel htmlFor={`${scopeId}-inherit`} className="cursor-pointer font-normal">
                <Trans>跟随全局</Trans>
              </FieldLabel>
            </Field>
            <Field orientation="horizontal" className="w-auto gap-2">
              <RadioGroupItem id={`${scopeId}-custom`} value="custom" />
              <FieldLabel htmlFor={`${scopeId}-custom`} className="cursor-pointer font-normal">
                <Trans>自定义</Trans>
              </FieldLabel>
            </Field>
          </RadioGroup>
          {modelEntry?.error && (
            <Alert variant="destructive">
              <AlertDescription>
                <Trans>模型目录读取失败，请重试。</Trans>
              </AlertDescription>
            </Alert>
          )}
          {form.modelScopeMode === 'custom' &&
            (modelEntry?.loading && models.length === 0 ? (
              <p
                role="status"
                className="text-muted-foreground inline-flex items-center gap-1.5 text-sm"
              >
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                <Trans>正在读取模型目录…</Trans>
              </p>
            ) : models.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                <Trans>没有可用模型，请刷新目录。</Trans>
              </p>
            ) : (
              <ModelScopeEditor
                models={models}
                value={form.modelPatterns}
                onChange={setWorkspaceFormModelPatterns}
                disabled={form.busy || disabled}
              />
            ))}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              <Trans>项目成员</Trans>
              <span className="ms-2 text-xs">
                <Trans>可用 @别名 引用项目。</Trans>
              </span>
            </span>
            <Button variant="outline" size="sm" onClick={addWorkspaceMember}>
              <PlusIcon aria-hidden className="size-4" />
              <Trans>添加成员</Trans>
            </Button>
          </div>
          <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-72">
            <div className="flex flex-col gap-2">
              {form.members.map((member: WorkspaceMemberDraft) => (
                <Item
                  key={member.key}
                  data-slot="huan-workspace-member"
                  variant="outline"
                  size="sm"
                  className="items-stretch gap-1.5"
                >
                  <ItemHeader>
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
                      onChange={(event) =>
                        setWorkspaceMember(member.key, { path: event.target.value })
                      }
                      onBlur={() => void inspectWorkspaceMember(member.key)}
                      aria-label="项目路径"
                      placeholder="/home/user/project"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="移除成员"
                      disabled={form.members.length <= 1}
                      onClick={() => removeWorkspaceMember(member.key)}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </ItemHeader>
                  <ItemContent className="gap-1">
                    <div className="flex min-h-5 flex-wrap items-center gap-2 text-xs">
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
                          size="xs"
                          onClick={() => void openTrust(member.path.trim())}
                        >
                          <Trans>决定信任</Trans>
                        </Button>
                      )}
                      {member.path.trim() && (
                        <>
                          <Button
                            variant="ghost"
                            size="xs"
                            data-slot="huan-workspace-member-settings"
                            onClick={() =>
                              openAfterClose(
                                () =>
                                  void openContextSettings({ workspacePath: member.path.trim() }),
                              )
                            }
                          >
                            <Settings2Icon aria-hidden />
                            <Trans>设置</Trans>
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            data-slot="huan-workspace-member-mcp"
                            onClick={() =>
                              openAfterClose(
                                () =>
                                  void openContextMcp({
                                    target: { workspacePath: member.path.trim() },
                                  }),
                              )
                            }
                          >
                            <ServerIcon aria-hidden />
                            <Trans>MCP</Trans>
                          </Button>
                        </>
                      )}
                    </div>
                    {member.path.trim() && <TrustDecisionPanel path={member.path.trim()} />}
                  </ItemContent>
                </Item>
              ))}
            </div>
          </ScrollArea>
        </div>

        {disabled && (
          <Alert variant="destructive">
            <AlertDescription>
              <Trans>工作区元数据不可用；请先修复 state.json。当前修改已禁用。</Trans>
            </AlertDescription>
          </Alert>
        )}
        {form.message && (
          <Alert variant="destructive">
            <AlertDescription>{form.message}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={form.busy} onClick={closeWorkspaceForm}>
            <Trans>取消</Trans>
          </Button>
          <Button
            disabled={
              form.busy || form.modelRefreshing || disabled || form.name.trim().length === 0
            }
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

/** 新建会话：选择起始项目并执行路径/信任预检。 */
export function NewSessionDialog() {
  const newSession = useWorkspaceStore((state) => state.newSession)
  const workspace = useServiceStore((state) =>
    newSession.workspaceId ? state.workspacesById[newSession.workspaceId] : undefined,
  )
  const workspaceState = useServiceStore((state) => state.workspaceState)
  const closeNewSession = useWorkspaceStore((state) => state.closeNewSession)
  const finishCloseNewSession = useWorkspaceStore((state) => state.finishCloseNewSession)
  const setNewSessionPath = useWorkspaceStore((state) => state.setNewSessionPath)
  const startNewSession = useWorkspaceStore((state) => state.startNewSession)
  const trust = useWorkspaceStore((state) => state.trust)
  const projectGroupId = useId()

  if (!workspace) return null
  const disabled = mutationDisabled(workspaceState)

  return (
    <Dialog
      open={newSession.open}
      onOpenChange={(open) => {
        if (!open) closeNewSession()
      }}
      onOpenChangeComplete={(open) => {
        // 退出动画完成后再清空面板，避免关闭时内容立即消失。
        if (!open) finishCloseNewSession()
      }}
    >
      <DialogContent aria-label="新建会话">
        <DialogHeader>
          <DialogTitle>
            <Trans>新建会话</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>选择起始项目。</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-sm">
            <Trans>起始项目</Trans>
          </span>
          <RadioGroup
            value={newSession.selectedPath}
            onValueChange={(value) => {
              if (typeof value === 'string') setNewSessionPath(value)
            }}
            aria-label="起始项目"
            className="gap-1"
          >
            {workspace.projects.map((project, index) => {
              const fieldId = `${projectGroupId}-${index}`
              return (
                <Field
                  key={project.path}
                  orientation="horizontal"
                  className="hover:bg-accent items-start gap-2 rounded-lg px-2 py-1.5 text-sm"
                >
                  <RadioGroupItem id={fieldId} value={project.path} className="mt-1" />
                  <FieldLabel
                    htmlFor={fieldId}
                    className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 font-normal leading-snug"
                  >
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
                  </FieldLabel>
                </Field>
              )
            })}
          </RadioGroup>
        </div>

        {newSession.message && (
          <Alert variant="destructive">
            <AlertDescription>{newSession.message}</AlertDescription>
          </Alert>
        )}
        {newSession.checking && (
          <p
            role="status"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-sm"
          >
            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            <Trans>正在检查起始项目与信任…</Trans>
          </p>
        )}
        {trust.open && trust.intent?.kind === 'new-session' && (
          <TrustDecisionPanel path={trust.path} intentKind="new-session" />
        )}

        <DialogFooter>
          <Button variant="outline" disabled={newSession.checking} onClick={closeNewSession}>
            <Trans>取消</Trans>
          </Button>
          <Button
            disabled={newSession.checking || !newSession.selectedPath || disabled}
            onClick={() => void startNewSession()}
          >
            {newSession.checking ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : null}
            <Trans>开始新会话</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** `/trust` 等独立入口：显示当前全局信任面板，不复制第二份状态。 */
export function TrustDecisionDialog() {
  const trust = useWorkspaceStore((state) => state.trust)
  const closeTrust = useWorkspaceStore((state) => state.closeTrust)
  const finishCloseTrust = useWorkspaceStore((state) => state.finishCloseTrust)
  // 只按来源判断是否挂载：关闭请求后 store 保留面板内容，供退出动画渲染。
  if (trust.intent?.kind !== 'standalone') return null
  return (
    <Dialog
      open={trust.open}
      onOpenChange={(open) => !open && closeTrust()}
      onOpenChangeComplete={(open) => {
        // 退出动画完成后再清空独立信任状态。
        if (!open) finishCloseTrust()
      }}
    >
      <DialogContent data-slot="huan-command-trust" aria-label="项目信任">
        <DialogHeader>
          <DialogTitle>
            <Trans>项目信任</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>信任是加载项目资源的前提，不等同于操作系统沙箱。</Trans>
          </DialogDescription>
        </DialogHeader>
        <TrustDecisionPanel path={trust.path} intentKind="standalone" onDone={() => closeTrust()} />
        <DialogFooter>
          <Button variant="outline" onClick={closeTrust}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
