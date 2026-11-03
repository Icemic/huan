/**
 * 统一全局设置的内容区：按页展示用户 settings.json 的兄弟分类。
 *
 * 本组件不渲染 Dialog、不管理左侧全局导航；页面由父级统一容器切换。
 * 用户 JSON 草稿仍归 settings feature store，切页不复制也不重置；
 * 全局目标打开时只加载用户设置，模型目录和文件预览在对应页按需读取。
 */

import { selectHarnessModelCatalog, useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useId, useMemo } from 'react'
import { ModelScopeEditor } from '@/components/model-scope-editor'
import {
  ConversationFields,
  DefaultModelFields,
  parseSettingsDraft,
  SettingsFileSummary,
  setField,
  ToolsFields,
  TransportField,
} from '@/components/settings-forms'
import { SettingsEffectivePreview } from '@/components/settings-inspector'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { useSettingsStore } from '@/state/app-context'
import { settingsScopedDraftKey, settingsSnapshotTargetKey } from '@/state/settings-store'

/** 统一导航后用户可编辑的全局分类；其余页面由兄弟内容组件承接。 */
export type GlobalSettingsPage = 'models' | 'conversation' | 'tools' | 'advanced'

/**
 * 全局用户设置草稿的派生状态。
 *
 * 内容区与底部动作共用同一份读取与判断，避免各自复制草稿状态；
 * 草稿仍只有 settings store 一份，这里不保存任何副本。
 */
function useGlobalSettingsDraft() {
  const target = useSettingsStore((state) => state.target)
  const targetKey = useSettingsStore((state) => state.targetKey)
  const snapshot = useSettingsStore((state) => state.snapshot)
  const loading = useSettingsStore((state) => state.loading)
  const saving = useSettingsStore((state) => state.saving)
  const reloading = useSettingsStore((state) => state.reloading)
  const drafts = useSettingsStore((state) => state.drafts)
  const reloadConfirm = useSettingsStore((state) => state.reloadConfirm)
  const updateDraft = useSettingsStore((state) => state.updateDraft)
  const updateObject = useSettingsStore((state) => state.updateObject)
  const resetDraft = useSettingsStore((state) => state.resetDraft)
  const save = useSettingsStore((state) => state.save)
  const reloadFromDisk = useSettingsStore((state) => state.reloadFromDisk)

  const key = settingsScopedDraftKey(targetKey, 'user')
  const draft = drafts[key]
  const parsed = useMemo(() => (draft ? parseSettingsDraft(draft.content) : undefined), [draft])
  const dirty = draft !== undefined && draft.content !== draft.baseContent
  const file = snapshot?.files.user
  const ready =
    target?.global === true &&
    targetKey === 'g' &&
    snapshot !== undefined &&
    settingsSnapshotTargetKey(snapshot) === targetKey
  const formDisabled = !ready || !draft || parsed?.error !== undefined || file?.tooLarge === true

  return {
    target,
    snapshot,
    draft,
    parsed,
    dirty,
    file,
    ready,
    formDisabled,
    loading,
    saving,
    reloading,
    reloadConfirm,
    updateDraft,
    updateObject,
    resetDraft,
    save,
    reloadFromDisk,
  }
}

/**
 * 用户设置文件的底部动作。
 *
 * 由统一容器在页面内容最后渲染：模型页的认证区块位于表单之后、
 * 本动作之前，保存入口不会被认证内容隔开。
 */
export function SettingsSaveActions() {
  const {
    draft,
    dirty,
    ready,
    formDisabled,
    file,
    loading,
    saving,
    reloading,
    reloadConfirm,
    resetDraft,
    save,
    reloadFromDisk,
  } = useGlobalSettingsDraft()

  return (
    <div data-slot="huan-settings-actions" className="flex flex-wrap items-center gap-2">
      <p className="text-muted-foreground" data-slot={dirty ? 'huan-settings-unsaved' : undefined}>
        {dirty ? <Trans>有未保存的改动</Trans> : <Trans>保存所有设置更改</Trans>}
      </p>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || saving || reloading}
          onClick={() => void reloadFromDisk()}
        >
          {loading ? (
            <Loader2Icon aria-hidden className="animate-spin" />
          ) : (
            <RefreshCwIcon aria-hidden />
          )}
          {reloadConfirm ? <Trans>确认重新读取文件</Trans> : <Trans>重新读取文件</Trans>}
        </Button>
        <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={resetDraft}>
          <Trans>重置改动</Trans>
        </Button>
        <Button
          size="sm"
          disabled={
            !ready ||
            !draft ||
            !dirty ||
            saving ||
            reloading ||
            formDisabled ||
            !!file?.readError ||
            !!file?.tooLarge
          }
          onClick={() => void save()}
        >
          {saving ? <Loader2Icon aria-hidden className="animate-spin" /> : null}
          <Trans>保存</Trans>
        </Button>
      </div>
    </div>
  )
}

/**
 * 全局设置内容。
 *
 * `page` 只决定本页字段；保存与重置由容器在页面之后渲染同一份用户 JSON 草稿。
 * 认证内容由统一容器在本组件之后嵌入模型页，本组件不创建认证入口。
 */
export function GlobalSettingsContent({
  page,
}: {
  page: 'models' | 'conversation' | 'tools' | 'advanced'
}) {
  const open = useSettingsStore((state) => state.open)
  const notice = useSettingsStore((state) => state.notice)
  const error = useSettingsStore((state) => state.error)
  const loadModelCatalog = useSettingsStore((state) => state.loadModelCatalog)
  const refreshModelCatalog = useSettingsStore((state) => state.refreshModelCatalog)
  const modelRefreshing = useSettingsStore((state) => state.modelRefreshing)
  const modelError = useSettingsStore((state) => state.modelError)
  const {
    target,
    snapshot,
    draft,
    parsed,
    file,
    ready,
    formDisabled,
    loading,
    saving,
    updateDraft,
    updateObject,
  } = useGlobalSettingsDraft()
  const jsonId = useId()

  // 全局目标按协议使用空路径：目录请求只带 all=true，不要求 cwd。
  const modelWorkspacePath = target?.global === true ? '' : undefined
  const catalogEntry = useServiceStore((state) =>
    modelWorkspacePath !== undefined
      ? selectHarnessModelCatalog(state, { workspacePath: modelWorkspacePath, all: true })
      : undefined,
  )
  const authRevision = useServiceStore((state) => state.providerAuth?.authRevision)
  const catalog = catalogEntry?.models ?? []
  const catalogPending = catalogEntry === undefined || catalogEntry.loading
  const catalogError = modelError ?? catalogEntry?.error

  // biome-ignore lint/correctness/useExhaustiveDependencies: 认证版本是 serviceStore 查询键，用于认证后重读目录。
  useEffect(() => {
    if (!open || !ready || page !== 'models' || modelWorkspacePath === undefined) return
    void loadModelCatalog()
  }, [authRevision, loadModelCatalog, modelWorkspacePath, open, page, ready])

  const enabledModels = useMemo(() => {
    const raw = parsed?.value?.enabledModels
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  }, [parsed])

  const changeEnabledModels = (patterns: string[]) => {
    const value = parsed?.value
    if (!value) return
    const current = Array.isArray(value.enabledModels) ? value.enabledModels : []
    if (
      current.length === patterns.length &&
      current.every((item, index) => item === patterns[index])
    ) {
      return
    }
    updateObject(setField(value, ['enabledModels'], patterns))
  }

  const renderPage = () => {
    if (page === 'advanced') {
      return (
        <FieldGroup data-slot="huan-global-settings-advanced">
          {parsed?.value ? (
            <TransportField value={parsed.value} onChange={updateObject} disabled={formDisabled} />
          ) : null}
          <FieldSeparator />
          <Field data-disabled={!ready || saving}>
            <FieldLabel htmlFor={jsonId}>
              <Trans>设置 JSON</Trans>
            </FieldLabel>
            <Textarea
              id={jsonId}
              className="min-h-72 font-mono"
              spellCheck={false}
              value={draft?.content ?? ''}
              disabled={!ready || saving}
              onChange={(event) => updateDraft(event.target.value)}
            />
          </Field>
          {file && snapshot ? (
            <div data-slot="huan-settings-file-preview" className="flex flex-col gap-2">
              <SettingsFileSummary file={file} />
              <SettingsEffectivePreview snapshot={snapshot} />
            </div>
          ) : null}
        </FieldGroup>
      )
    }

    if (!parsed?.value) {
      return (
        <FieldDescription>
          <Trans>先修复 JSON 解析错误，此页表单才可用。</Trans>
        </FieldDescription>
      )
    }

    if (page === 'models') {
      return (
        <FieldGroup data-slot="huan-global-settings-models">
          <DefaultModelFields
            value={parsed.value}
            onChange={updateObject}
            disabled={formDisabled}
          />
          <FieldSeparator />
          <FieldSet>
            <FieldLegend>
              <Trans>模型范围</Trans>
            </FieldLegend>
            <FieldDescription>
              <Trans>未设置或空列表表示全部模型；工作区可单独覆盖。</Trans>
            </FieldDescription>
            <FieldGroup>
              <Field orientation="responsive">
                <FieldContent>
                  <FieldDescription>
                    {catalogPending ? (
                      <span className="flex items-center gap-1">
                        <Loader2Icon aria-hidden className="size-4 animate-spin" />
                        <Trans>正在读取模型目录…</Trans>
                      </span>
                    ) : catalog.length > 0 ? (
                      <Trans>可用于范围选择的模型：{catalog.length} 个</Trans>
                    ) : (
                      <Trans>模型目录为空；请刷新模型目录。</Trans>
                    )}
                  </FieldDescription>
                </FieldContent>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!ready || modelRefreshing}
                  onClick={() => void refreshModelCatalog()}
                >
                  {modelRefreshing ? (
                    <Loader2Icon aria-hidden className="animate-spin" />
                  ) : (
                    <RefreshCwIcon aria-hidden />
                  )}
                  <Trans>刷新模型目录</Trans>
                </Button>
              </Field>
              {catalogError && (
                <Alert variant="destructive">
                  <AlertDescription>{catalogError}</AlertDescription>
                </Alert>
              )}
              {!catalogPending && catalog.length > 0 && (
                <ModelScopeEditor
                  models={catalog}
                  value={enabledModels}
                  onChange={changeEnabledModels}
                  disabled={formDisabled || modelRefreshing}
                />
              )}
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
      )
    }

    if (page === 'conversation') {
      return (
        <FieldGroup data-slot="huan-global-settings-conversation">
          <ConversationFields
            value={parsed.value}
            onChange={updateObject}
            disabled={formDisabled}
          />
        </FieldGroup>
      )
    }

    return (
      <FieldGroup data-slot="huan-global-settings-tools">
        <ToolsFields value={parsed.value} onChange={updateObject} disabled={formDisabled} />
      </FieldGroup>
    )
  }

  return (
    <div data-slot="huan-global-settings" data-page={page} className="flex flex-col gap-4">
      {(notice || error) && (
        <Alert
          variant={error ? 'destructive' : 'default'}
          role={error ? 'alert' : 'status'}
          data-slot="huan-settings-notice"
        >
          <AlertDescription className="whitespace-pre-wrap">{error ?? notice}</AlertDescription>
        </Alert>
      )}

      {!target || (loading && !snapshot) ? (
        <FieldDescription className="flex items-center gap-2">
          <Loader2Icon aria-hidden className="size-4 animate-spin" />
          <Trans>正在读取用户设置…</Trans>
        </FieldDescription>
      ) : !snapshot ? (
        <Alert role="status">
          <AlertDescription>
            <Trans>用户设置尚未读取；请关闭后重试。</Trans>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {file?.readError && (
            <Alert variant="destructive">
              <AlertDescription>{file.readError}</AlertDescription>
            </Alert>
          )}
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
                <ul data-slot="huan-settings-issues" className="flex list-disc flex-col gap-1 ps-4">
                  {draft.issues.map((issue) => (
                    <li key={`${issue.kind}:${issue.path}:${issue.message}`}>
                      <span className="font-mono">{issue.path}</span> {issue.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {renderPage()}
        </>
      )}
    </div>
  )
}
