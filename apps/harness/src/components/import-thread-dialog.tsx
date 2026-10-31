/**
 * JSONL 导入弹层：宿主路径或浏览器上传、预览、cwd 修复、冲突副本与信任入口。
 *
 * 预览只读文件/目录/冲突，不装配项目；确认时宿主重新读取并校验源。
 * 上传文本按 20MiB 上限在浏览器先拦截（宿主仍会再次校验）。
 */
import { useAui } from '@assistant-ui/react'
import type {
  HarnessThreadImportPreview,
  HarnessThreadImportResult,
  HarnessThreadImportSource,
} from '@huan/protocol'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import {
  AlertTriangleIcon,
  FileUpIcon,
  FolderInputIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { harnessHttpClient } from './pi-http-client'
import { useWorkspace } from './workspace-context'
import { TrustDecisionPanel } from './workspace-manager'

/** 与宿主一致的浏览器上传文本上限（20MiB）。 */
const IMPORT_UPLOAD_LIMIT = 20 * 1024 * 1024

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

type SourceMode = 'path' | 'upload'

export type ImportThreadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportThreadDialog({ open, onOpenChange }: ImportThreadDialogProps) {
  const { i18n } = useLingui()
  const aui = useAui()
  const { workspaces, activeWorkspaceId, refresh, selectWorkspace, showNotice } = useWorkspace()
  const [workspaceId, setWorkspaceId] = useState<string>()
  const [mode, setMode] = useState<SourceMode>('path')
  const [path, setPath] = useState('')
  const [upload, setUpload] = useState<{ filename: string; content: string }>()
  const [cwdOverride, setCwdOverride] = useState('')
  const [preview, setPreview] = useState<HarnessThreadImportPreview>()
  const [existingId, setExistingId] = useState<string>()
  const [copyConfirmed, setCopyConfirmed] = useState(false)
  const [trustPath, setTrustPath] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // 打开时重置输入与预览；目标工作区默认跟随当前窗口。
  // 只用 open 作为触发条件：工作区列表刷新不应清空正在填写的导入输入。
  const defaultsRef = useRef({ activeWorkspaceId, workspaces })
  defaultsRef.current = { activeWorkspaceId, workspaces }
  useEffect(() => {
    if (!open) return
    const defaults = defaultsRef.current
    setWorkspaceId(defaults.activeWorkspaceId ?? defaults.workspaces[0]?.id)
    setMode('path')
    setPath('')
    setUpload(undefined)
    setCwdOverride('')
    setPreview(undefined)
    setExistingId(undefined)
    setCopyConfirmed(false)
    setTrustPath(undefined)
    setBusy(false)
    setError(undefined)
  }, [open])

  const workspace = workspaces.find((item) => item.id === workspaceId)
  const availableProjects = workspace?.projects.filter((project) => project.available) ?? []
  const source: HarnessThreadImportSource | undefined =
    mode === 'path'
      ? path.trim()
        ? { kind: 'path', path: path.trim() }
        : undefined
      : upload
        ? { kind: 'upload', filename: upload.filename, content: upload.content }
        : undefined

  const requestGeneration = useRef(0)
  const clearPreview = () => {
    requestGeneration.current += 1
    setPreview(undefined)
    setExistingId(undefined)
    setCopyConfirmed(false)
    setError(undefined)
    setTrustPath(undefined)
  }

  const pickFile = async (file: File | undefined) => {
    clearPreview()
    if (!file) {
      setUpload(undefined)
      return
    }
    if (file.size > IMPORT_UPLOAD_LIMIT) {
      setUpload(undefined)
      setError(i18n._(msg`文件超过 20MiB 上限，无法导入。`))
      return
    }
    const content = await file.text()
    if (content.length > IMPORT_UPLOAD_LIMIT) {
      setUpload(undefined)
      setError(i18n._(msg`文件超过 20MiB 上限，无法导入。`))
      return
    }
    setUpload({ filename: file.name, content })
  }

  const runPreview = async () => {
    if (!source || !workspaceId) return
    if (source.kind === 'upload' && source.content.length > IMPORT_UPLOAD_LIMIT) {
      setError(i18n._(msg`上传内容超过 20MiB 上限。`))
      return
    }
    setBusy(true)
    const generation = ++requestGeneration.current
    setError(undefined)
    setTrustPath(undefined)
    try {
      const next = await harnessHttpClient.previewThreadImport({
        source,
        workspaceId,
        ...(cwdOverride ? { cwdOverride } : {}),
      })
      if (generation !== requestGeneration.current) return
      setPreview(next)
      setExistingId(next.existingThreadId)
      setCopyConfirmed(false)
      if (next.status !== 'ok') setError(next.message ?? i18n._(msg`导入预览失败。`))
    } catch (caught) {
      if (generation === requestGeneration.current) setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const openExisting = async () => {
    if (!existingId) return
    if (workspaceId) selectWorkspace(workspaceId)
    onOpenChange(false)
    await aui.threads.switchToThread(existingId)
  }

  const runImport = async () => {
    if (!source || !workspaceId || !preview || preview.status !== 'ok' || !preview.cwd) return
    if (preview.conflict === 'conflict' && !copyConfirmed) {
      setError(i18n._(msg`请先勾选“作为独立副本导入”。`))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      // 与新建会话一致的信任入口：需要信任时先由用户决定，再重试导入。
      const info = await harnessHttpClient.getProject({ path: preview.cwd })
      if (info.status === 'needs-trust') {
        setTrustPath(preview.cwd)
        return
      }
      if (info.status === 'failed') {
        setError(i18n._(msg`目标项目装配失败，请检查路径与宿主诊断。`))
        return
      }
      const result: HarnessThreadImportResult = await harnessHttpClient.importThread({
        source,
        workspaceId,
        ...(cwdOverride ? { cwdOverride } : {}),
        ...(preview.conflict === 'conflict' ? { asCopy: true } : {}),
        ...(preview.source?.id ? { expectedSourceId: preview.source.id } : {}),
        ...(preview.source?.fingerprint
          ? { expectedSourceFingerprint: preview.source.fingerprint }
          : {}),
      })
      if (result.status === 'imported' && result.threadId) {
        selectWorkspace(workspaceId)
        await refresh()
        onOpenChange(false)
        // 导入后由 GUI 明确切入；宿主不会替换当前会话。
        await aui.threads.switchToThread(result.threadId)
        showNotice(i18n._(msg`会话已导入并打开。`))
        return
      }
      if (result.preview) setPreview(result.preview)
      if (result.existingThreadId) setExistingId(result.existingThreadId)
      if (result.status === 'metadata-failed' || result.status === 'imported') {
        await refresh()
      }
      setError(result.message ?? i18n._(msg`导入未完成。`))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const canPreview = Boolean(source && workspaceId) && !busy
  const canImport =
    Boolean(preview && preview.status === 'ok' && source && workspaceId) &&
    !busy &&
    preview?.conflict !== 'already-exists' &&
    (preview?.conflict !== 'conflict' || copyConfirmed)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="导入会话"
        data-slot="huan-import-dialog"
        className="flex max-h-[85vh] flex-col"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>导入 JSONL 会话</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              从宿主路径或浏览器上传导入 Pi 会话。默认保留源会话 ID 与完整树；预览不会装配项目代码。
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1 text-sm">
          <div className="flex flex-col gap-1">
            <span id="huan-import-workspace-label" className="text-muted-foreground text-xs">
              <Trans>目标工作区</Trans>
            </span>
            <Select
              value={workspaceId ?? ''}
              items={Object.fromEntries(workspaces.map((item) => [item.id, item.name]))}
              onValueChange={(value) => {
                setWorkspaceId(value ?? undefined)
                setCwdOverride('')
                clearPreview()
              }}
            >
              <SelectTrigger
                aria-label="目标工作区"
                aria-labelledby="huan-import-workspace-label"
                size="sm"
                className="w-full justify-between"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-muted-foreground mb-1 text-xs">
              <Trans>导入来源</Trans>
            </legend>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  className="size-3.5 accent-current"
                  name="import-source-mode"
                  checked={mode === 'path'}
                  onChange={() => {
                    setMode('path')
                    clearPreview()
                  }}
                />
                <Trans>宿主路径</Trans>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  className="size-3.5 accent-current"
                  name="import-source-mode"
                  checked={mode === 'upload'}
                  onChange={() => {
                    setMode('upload')
                    clearPreview()
                  }}
                />
                <Trans>上传 JSONL</Trans>
              </label>
            </div>
          </fieldset>

          {mode === 'path' ? (
            // 两种来源的输入框结构相似；显式 key 避免 React 复用同一 DOM 节点，
            // 否则切换来源时受控 value 消失会产生 controlled→uncontrolled 警告。
            <label key="path" htmlFor="huan-import-path" className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                <Trans>宿主机器上的 JSONL 绝对路径（不是浏览器本地文件）</Trans>
              </span>
              <div className="flex items-center gap-2">
                <FolderInputIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <Input
                  id="huan-import-path"
                  aria-label="宿主 JSONL 路径"
                  value={path}
                  placeholder="/path/to/session.jsonl"
                  className="h-8 text-sm"
                  onChange={(event) => {
                    setPath(event.target.value)
                    clearPreview()
                  }}
                />
              </div>
            </label>
          ) : (
            <label key="upload" htmlFor="huan-import-file" className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                <Trans>选择浏览器本地 .jsonl 文件（文本发送给受保护的宿主接口）</Trans>
              </span>
              <div className="flex items-center gap-2">
                <FileUpIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <Input
                  id="huan-import-file"
                  aria-label="选择 JSONL 文件"
                  type="file"
                  accept=".jsonl,application/jsonl,application/x-ndjson"
                  className="h-8 text-xs"
                  onChange={(event) => void pickFile(event.target.files?.[0])}
                />
              </div>
              {upload && (
                <span className="text-muted-foreground truncate text-xs">
                  {upload.filename} · {Math.ceil(upload.content.length / 1024)} KiB
                </span>
              )}
            </label>
          )}

          <div className="flex flex-col gap-1">
            <span id="huan-import-cwd-label" className="text-muted-foreground text-xs">
              <Trans>替代起始目录（源 cwd 不可用或不在工作区时必须选择成员）</Trans>
            </span>
            <Select
              value={cwdOverride || '__source__'}
              items={{
                __source__: i18n._(msg`使用源会话起始目录`),
                ...Object.fromEntries(
                  availableProjects.map((project) => [project.path, project.path]),
                ),
              }}
              onValueChange={(value) => {
                setCwdOverride(value === '__source__' ? '' : (value ?? ''))
                clearPreview()
              }}
            >
              <SelectTrigger
                aria-label="替代起始目录"
                aria-labelledby="huan-import-cwd-label"
                size="sm"
                className="w-full justify-between"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__source__">
                  <Trans>使用源会话起始目录</Trans>
                </SelectItem>
                {availableProjects.map((project) => (
                  <SelectItem key={project.path} value={project.path}>
                    @{project.alias} · {project.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-muted-foreground rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
            <Trans>
              导入内容只保存在本机宿主，不会上传到第三方；请确认 JSONL
              中没有不希望持久化的敏感信息。原文件不会被修改。
            </Trans>
          </p>

          {preview?.status === 'ok' && (
            <div
              data-slot="huan-import-preview"
              className="flex flex-col gap-1 rounded-md border px-2.5 py-2 text-xs"
            >
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <span className="text-muted-foreground">
                  <Trans>源会话</Trans>
                </span>
                <span className="truncate" title={preview.source?.id}>
                  {preview.source?.id ?? '-'}
                  {preview.source?.name ? ` · ${preview.source.name}` : ''}
                </span>
                <span className="text-muted-foreground">
                  <Trans>源 cwd</Trans>
                </span>
                <span className="break-all">{preview.source?.cwd || <Trans>（空）</Trans>}</span>
                <span className="text-muted-foreground">
                  <Trans>条目 / 版本</Trans>
                </span>
                <span>
                  {preview.source?.entries ?? '-'} / v{preview.source?.version ?? '-'}
                </span>
                <span className="text-muted-foreground">
                  <Trans>起始目录</Trans>
                </span>
                <span className="break-all">{preview.cwd}</span>
                <span className="text-muted-foreground">
                  <Trans>目标目录</Trans>
                </span>
                <span className="break-all">{preview.sessionDir}</span>
                <span className="text-muted-foreground">
                  <Trans>冲突</Trans>
                </span>
                <span>
                  {preview.conflict === 'already-exists' ? (
                    <Trans>已有完全相同的会话</Trans>
                  ) : preview.conflict === 'conflict' ? (
                    <Trans>同 ID 内容不同</Trans>
                  ) : (
                    <Trans>无</Trans>
                  )}
                </span>
              </div>
              {preview.conflict === 'conflict' && (
                <label className="mt-1 flex items-start gap-1.5">
                  <input
                    type="checkbox"
                    aria-label="作为独立副本导入"
                    className="mt-0.5 size-3.5 accent-current"
                    checked={copyConfirmed}
                    onChange={(event) => setCopyConfirmed(event.target.checked)}
                  />
                  <span>
                    <Trans>作为独立副本导入（新会话 ID，保留完整树与父会话血缘）</Trans>
                  </span>
                </label>
              )}
              {preview.conflict === 'already-exists' && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-muted-foreground">
                    <Trans>已有会话 ID：{existingId}</Trans>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => void openExisting()}
                  >
                    <Trans>打开已有会话</Trans>
                  </Button>
                </div>
              )}
              {preview.warnings && preview.warnings.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {preview.warnings.map((warning) => (
                    <li key={warning} className="flex items-start gap-1">
                      <AlertTriangleIcon
                        aria-hidden
                        className="text-muted-foreground mt-0.5 size-3 shrink-0"
                      />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {trustPath && (
            <div className="rounded-md border p-2">
              <div className="mb-2 flex items-center gap-1.5 text-xs">
                <ShieldAlertIcon aria-hidden className="text-destructive size-3.5" />
                <Trans>导入目标项目需要信任决定；拒绝后仍会使用用户级资源导入。</Trans>
              </div>
              <TrustDecisionPanel
                path={trustPath}
                onDone={(info) => {
                  setTrustPath(undefined)
                  if (info?.status === 'ready') void runImport()
                }}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            <Trans>取消</Trans>
          </Button>
          <Button variant="outline" disabled={!canPreview} onClick={() => void runPreview()}>
            {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <Trans>预览导入</Trans>
          </Button>
          <Button
            data-slot="huan-import-confirm"
            disabled={!canImport}
            onClick={() => void runImport()}
          >
            <Trans>确认导入</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 侧栏导入入口。 */
export function ImportThreadButton() {
  const [open, setOpen] = useState(false)
  const { i18n } = useLingui()
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={i18n._(msg`导入 JSONL`)}
        onClick={() => setOpen(true)}
      >
        <FileUpIcon aria-hidden className="size-4" />
      </Button>
      <ImportThreadDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
