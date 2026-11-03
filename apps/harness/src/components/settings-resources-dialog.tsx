/**
 * 项目/会话设置与资源弹层：明确绑定所选项目或当前会话，编辑项目 settings.json，
 * 查看实际加载的资源并按需重载。
 *
 * 全局用户设置由统一设置的 GlobalSettingsContent 承接；本组件不提供全局入口，
 * 也不把项目设置标成工作区级配置。目标、草稿、保存/重载状态仍在 settings store。
 */

import type { HarnessSettingsIssue } from '@huan/protocol'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon, RotateCwIcon } from 'lucide-react'
import { useEffect, useId, useMemo } from 'react'
import {
  CommonSettingsForm,
  parseSettingsDraft,
  SettingsFileSummary,
} from '@/components/settings-forms'
import { SettingsEffectivePreview } from '@/components/settings-inspector'
import { SettingsResourcePane } from '@/components/settings-resource-pane'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useSettingsStore } from '@/state/app-context'
import { settingsScopedDraftKey, settingsSnapshotTargetKey } from '@/state/settings-store'

type ContextSettingsTab = 'common' | 'json' | 'resources'

/**
 * 项目与会话资源设置。
 *
 * 打开方式由显式入口调用 `openPanel(target, { scope: 'project', tab })`；
 * 全局目标不归本组件处理。
 */
export function ContextSettingsDialog() {
  const open = useSettingsStore((state) => state.open)
  const target = useSettingsStore((state) => state.target)
  const targetKey = useSettingsStore((state) => state.targetKey)
  const tab = useSettingsStore((state) => state.tab)
  const scope = useSettingsStore((state) => state.scope)
  const snapshot = useSettingsStore((state) => state.snapshot)
  const resources = useSettingsStore((state) => state.resources)
  const showText = useSettingsStore((state) => state.showText)
  const loading = useSettingsStore((state) => state.loading)
  const resourceLoading = useSettingsStore((state) => state.resourceLoading)
  const saving = useSettingsStore((state) => state.saving)
  const reloading = useSettingsStore((state) => state.reloading)
  const notice = useSettingsStore((state) => state.notice)
  const error = useSettingsStore((state) => state.error)
  const resourceError = useSettingsStore((state) => state.resourceError)
  const drafts = useSettingsStore((state) => state.drafts)
  const reloadConfirm = useSettingsStore((state) => state.reloadConfirm)
  const close = useSettingsStore((state) => state.close)
  const setTab = useSettingsStore((state) => state.setTab)
  const setScope = useSettingsStore((state) => state.setScope)
  const loadResources = useSettingsStore((state) => state.loadResources)
  const reloadFromDisk = useSettingsStore((state) => state.reloadFromDisk)
  const applyResourceReload = useSettingsStore((state) => state.applyResourceReload)
  const updateDraft = useSettingsStore((state) => state.updateDraft)
  const updateObject = useSettingsStore((state) => state.updateObject)
  const resetDraft = useSettingsStore((state) => state.resetDraft)
  const save = useSettingsStore((state) => state.save)
  const syncResourceRevision = useSettingsStore((state) => state.syncResourceRevision)
  const metadata = useServiceStore((state) =>
    target?.threadId ? state.threadsById[target.threadId] : undefined,
  )
  const jsonId = useId()

  const activeTab: ContextSettingsTab = tab === 'json' || tab === 'resources' ? tab : 'common'
  const key = settingsScopedDraftKey(targetKey, 'project')
  const draft = drafts[key]
  const parsed = useMemo(() => (draft ? parseSettingsDraft(draft.content) : undefined), [draft])
  const dirty = draft !== undefined && draft.content !== draft.baseContent
  const file = snapshot?.files.project
  const ready =
    target !== undefined &&
    target.global !== true &&
    snapshot !== undefined &&
    settingsSnapshotTargetKey(snapshot) === targetKey
  const scopeBlocked = !ready || snapshot?.projectTrusted !== true
  const formDisabled =
    !ready ||
    !draft ||
    parsed?.error !== undefined ||
    scopeBlocked ||
    file?.tooLarge === true ||
    scope !== 'project'

  // 上下文入口固定项目作用域；模型页等用户作用域标签不在此弹层展示。
  useEffect(() => {
    if (!open || target?.global === true) return
    if (tab !== 'common' && tab !== 'json' && tab !== 'resources') setTab('common')
  }, [open, target?.global, tab, setTab])

  useEffect(() => {
    if (!open || target?.global === true) return
    if (scope !== 'project' && (!snapshot || snapshot.projectTrusted)) setScope('project')
  }, [open, target?.global, scope, snapshot, setScope])

  // 目标会话资源版本推进时只重读；不重置未保存草稿。
  useEffect(() => {
    if (!open) return
    syncResourceRevision(metadata?.resourceRevision)
  }, [metadata?.resourceRevision, open, syncResourceRevision])

  if (!open || target?.global === true) return null

  const title = '项目设置与资源'
  const pathLabel = target?.threadId ? '会话目录' : '项目目录'

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent
        data-slot="huan-context-settings-dialog"
        aria-label={title}
        className="flex max-h-[85dvh] max-w-3xl flex-col"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>项目设置与资源</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>管理所选项目的设置，查看已加载的资源。</Trans>
          </DialogDescription>
        </DialogHeader>

        {!target && (
          <Alert role="status">
            <AlertDescription>
              <Trans>当前没有可用的项目或会话；请从工作区选择项目。</Trans>
            </AlertDescription>
          </Alert>
        )}

        {target && (
          <ScrollArea
            className="min-h-0 flex-1"
            contentProps={{ className: 'flex flex-col gap-3 pe-1' }}
          >
            {(notice || error) && (
              <Alert
                variant={error ? 'destructive' : 'default'}
                role={error ? 'alert' : 'status'}
                data-slot="huan-settings-notice"
              >
                <AlertDescription className="whitespace-pre-wrap">
                  {error ?? notice}
                </AlertDescription>
              </Alert>
            )}

            {snapshot && (
              <div
                data-slot="huan-settings-target"
                className="text-muted-foreground flex flex-wrap items-center gap-2"
              >
                <span className="font-mono break-all">{snapshot.target.workspacePath}</span>
                <Badge variant="outline">{pathLabel}</Badge>
                <Badge variant={snapshot.projectTrusted ? 'secondary' : 'destructive'}>
                  {snapshot.projectTrusted ? (
                    <Trans>项目已信任</Trans>
                  ) : snapshot.trust.decision === 'needs-trust' ? (
                    <Trans>项目待信任决定</Trans>
                  ) : (
                    <Trans>项目未信任</Trans>
                  )}
                </Badge>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!ready || saving || reloading || scope !== 'project'}
                onClick={() => void reloadFromDisk()}
              >
                {loading ? (
                  <Loader2Icon aria-hidden className="animate-spin" />
                ) : (
                  <RefreshCwIcon aria-hidden />
                )}
                {reloadConfirm ? <Trans>确认重新读取文件</Trans> : <Trans>重新读取文件</Trans>}
              </Button>
              <Button
                size="sm"
                disabled={!ready || saving || reloading}
                onClick={() => void applyResourceReload()}
              >
                {reloading || metadata?.reload?.status === 'running' ? (
                  <Loader2Icon aria-hidden className="animate-spin" />
                ) : (
                  <RotateCwIcon aria-hidden />
                )}
                {target?.threadId ? <Trans>应用到当前会话</Trans> : <Trans>刷新项目资源</Trans>}
              </Button>
            </div>

            {snapshot && !snapshot.projectTrusted && (
              <Alert variant="destructive">
                <AlertDescription>
                  <Trans>
                    项目未信任：不读取也不写入项目设置。请先允许项目；已加载资源仍可查看。
                  </Trans>
                </AlertDescription>
              </Alert>
            )}

            {dirty && (
              <FieldDescription role="status" data-slot="huan-settings-unsaved">
                <Trans>有未保存的改动</Trans>
              </FieldDescription>
            )}

            {file && <SettingsFileSummary file={file} />}

            {parsed?.error && (
              <Alert variant="destructive" data-slot="huan-settings-local-error">
                <AlertTitle>
                  <Trans>JSON 解析错误</Trans>
                </AlertTitle>
                <AlertDescription>{parsed.error}</AlertDescription>
              </Alert>
            )}
            {draft && draft.issues.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>
                  <Trans>字段校验失败</Trans>
                </AlertTitle>
                <AlertDescription>
                  <ul
                    data-slot="huan-settings-issues"
                    className="flex list-disc flex-col gap-1 ps-4"
                  >
                    {draft.issues.map((issue: HarnessSettingsIssue) => (
                      <li key={`${issue.kind}:${issue.path}:${issue.message}`}>
                        <span className="font-mono">{issue.path}</span> {issue.message}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <Tabs value={activeTab} onValueChange={(value) => setTab(value as ContextSettingsTab)}>
              <TabsList variant="line" aria-label="项目设置视图">
                <TabsTrigger value="common">
                  <Trans>常用项</Trans>
                </TabsTrigger>
                <TabsTrigger value="json">
                  <Trans>JSON 原文</Trans>
                </TabsTrigger>
                <TabsTrigger value="resources">
                  <Trans>资源清单</Trans>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="common" className="flex flex-col gap-3">
                {!draft ? (
                  <FieldDescription>
                    <Trans>项目设置没有可编辑的原文（未信任、读取失败或文件过大）。</Trans>
                  </FieldDescription>
                ) : parsed?.value ? (
                  <CommonSettingsForm
                    value={parsed.value}
                    onChange={updateObject}
                    disabled={formDisabled}
                  />
                ) : (
                  <FieldDescription>
                    <Trans>先修复 JSON 解析错误，常用项表单才可用。</Trans>
                  </FieldDescription>
                )}
              </TabsContent>

              <TabsContent value="json">
                {!draft ? (
                  <FieldDescription>
                    <Trans>项目设置没有可编辑的原文（未信任、读取失败或文件过大）。</Trans>
                  </FieldDescription>
                ) : (
                  <Field data-disabled={!ready || scopeBlocked || saving}>
                    <FieldLabel htmlFor={jsonId}>
                      <Trans>设置 JSON</Trans>
                    </FieldLabel>
                    <Textarea
                      id={jsonId}
                      className="min-h-72 font-mono"
                      spellCheck={false}
                      value={draft.content}
                      disabled={!ready || scopeBlocked || saving}
                      onChange={(event) => updateDraft(event.target.value)}
                    />
                  </Field>
                )}
              </TabsContent>

              <TabsContent value="resources" className="flex flex-col gap-3">
                {resourceError && (
                  <Alert variant="destructive">
                    <AlertDescription>{resourceError}</AlertDescription>
                  </Alert>
                )}
                {!resources ? (
                  <FieldDescription className="flex items-center gap-2">
                    <Loader2Icon aria-hidden className="animate-spin" />
                    <Trans>正在读取资源清单…</Trans>
                  </FieldDescription>
                ) : (
                  <SettingsResourcePane
                    resources={resources}
                    showText={showText}
                    busy={resourceLoading}
                    onToggleText={() => void loadResources(!showText)}
                  />
                )}
              </TabsContent>
            </Tabs>

            {snapshot && activeTab !== 'resources' && (
              <SettingsEffectivePreview snapshot={snapshot} />
            )}
          </ScrollArea>
        )}

        <DialogFooter>
          {activeTab !== 'resources' && (
            <Button
              variant="outline"
              disabled={!dirty || saving || scope !== 'project'}
              onClick={resetDraft}
            >
              <Trans>重置改动</Trans>
            </Button>
          )}
          {activeTab !== 'resources' && (
            <Button
              disabled={
                !ready ||
                !draft ||
                !dirty ||
                saving ||
                reloading ||
                scopeBlocked ||
                scope !== 'project' ||
                !!file?.readError ||
                !!file?.tooLarge
              }
              onClick={() => void save()}
            >
              {saving ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
              <Trans>保存</Trans>
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
