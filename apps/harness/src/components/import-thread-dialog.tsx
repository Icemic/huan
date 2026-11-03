/**
 * JSONL 导入弹层：宿主路径或浏览器上传、预览、cwd 修复、冲突副本与信任入口。
 *
 * 输入、文件读取代次、预览、冲突确认与错误都在 sessions feature Zustand；
 * 预览只读文件/目录/冲突，确认时宿主再次校验源指纹。上传文本不持久化。
 */

import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  AlertTriangleIcon,
  FileUpIcon,
  FolderInputIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-react'
import { useRef } from 'react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useSessionsStore, useWorkspaceStore } from '@/state/app-context'
import { TrustDecisionPanel } from './workspace-manager'

const SOURCE_SENTINEL = '__source__'

export function ImportThreadDialog() {
  const panel = useSessionsStore((state) => state.importPanel)
  const closeImport = useSessionsStore((state) => state.closeImport)
  const setMode = useSessionsStore((state) => state.setImportMode)
  const setPath = useSessionsStore((state) => state.setImportPath)
  const readFile = useSessionsStore((state) => state.readImportFile)
  const configureImport = useSessionsStore((state) => state.configureImport)
  const setCopyConfirmed = useSessionsStore((state) => state.setImportCopyConfirmed)
  const openExisting = useSessionsStore((state) => state.openExistingImport)
  const openImported = useSessionsStore((state) => state.openImportedThread)
  const previewImport = useSessionsStore((state) => state.previewImport)
  const confirmImport = useSessionsStore((state) => state.confirmImport)
  const workspaceIds = useServiceStore((state) => state.workspaceIds)
  const workspacesById = useServiceStore((state) => state.workspacesById)
  const openTrust = useWorkspaceStore((state) => state.openTrust)
  const trust = useWorkspaceStore((state) => state.trust)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!panel.open) return null

  const workspaces = workspaceIds.flatMap((id) => {
    const workspace = workspacesById[id]
    return workspace ? [workspace] : []
  })
  const workspace = panel.workspaceId ? workspacesById[panel.workspaceId] : undefined
  const availableProjects = workspace?.projects.filter((project) => project.available) ?? []
  const preview = panel.preview
  const canPreview = Boolean(panel.source && panel.workspaceId) && !panel.busy && !panel.fileReading
  const canImport =
    Boolean(preview && preview.status === 'ok' && panel.source && panel.workspaceId) &&
    !panel.busy &&
    preview?.conflict !== 'already-exists' &&
    (preview?.conflict !== 'conflict' || panel.copyConfirmed)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeImport()
      }}
    >
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
            <Trans>从 JSONL 文件导入 Pi 会话。</Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea
          className={cn(
            'flex min-h-0 flex-1 flex-col text-sm',
            '*:data-[slot=scroll-area-viewport]:flex-1',
          )}
        >
          <div className="flex flex-col gap-3 pe-1">
            <div className="flex flex-col gap-1">
              <span id="huan-import-workspace-label" className="text-muted-foreground text-xs">
                <Trans>目标工作区</Trans>
              </span>
              <Select
                value={panel.workspaceId ?? ''}
                items={Object.fromEntries(workspaces.map((item) => [item.id, item.name]))}
                onValueChange={(value) => {
                  if (value) configureImport({ workspaceId: value, cwdOverride: '' })
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
                <SelectContent className="overflow-hidden" alignItemWithTrigger={false}>
                  <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[min(18rem,var(--available-height))]">
                    {workspaces.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </ScrollArea>
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
                    checked={panel.mode === 'path'}
                    onChange={() => setMode('path')}
                  />
                  <Trans>服务端文件</Trans>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    className="size-3.5 accent-current"
                    name="import-source-mode"
                    checked={panel.mode === 'upload'}
                    onChange={() => setMode('upload')}
                  />
                  <Trans>上传文件</Trans>
                </label>
              </div>
            </fieldset>

            {panel.mode === 'path' ? (
              <label key="path" htmlFor="huan-import-path" className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  <Trans>服务端 JSONL 绝对路径</Trans>
                </span>
                <div className="flex items-center gap-2">
                  <FolderInputIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                  <Input
                    id="huan-import-path"
                    aria-label="服务端 JSONL 绝对路径"
                    value={panel.path}
                    placeholder="/path/to/session.jsonl"
                    className="h-8 text-sm"
                    onChange={(event) => setPath(event.target.value)}
                  />
                </div>
              </label>
            ) : (
              <label key="upload" htmlFor="huan-import-file" className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  <Trans>选择本地 .jsonl 文件</Trans>
                </span>
                <div className="flex items-center gap-2">
                  <FileUpIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                  <Input
                    ref={fileRef}
                    id="huan-import-file"
                    aria-label="选择 JSONL 文件"
                    type="file"
                    accept=".jsonl,application/jsonl,application/x-ndjson"
                    className="h-8 text-xs"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      void readFile(file)
                      // 允许再次选择同一文件。
                      event.target.value = ''
                    }}
                  />
                </div>
                {panel.fileReading && (
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                    <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                    <Trans>正在读取文件…</Trans>
                  </span>
                )}
                {panel.upload && (
                  <span className="text-muted-foreground truncate text-xs">
                    {panel.upload.filename} · {Math.ceil(panel.upload.content.length / 1024)} KiB
                  </span>
                )}
                {panel.fileError && (
                  <span role="alert" className="text-destructive text-xs">
                    {panel.fileError}
                  </span>
                )}
              </label>
            )}

            <div className="flex flex-col gap-1">
              <span id="huan-import-cwd-label" className="text-muted-foreground text-xs">
                <Trans>替代起始目录</Trans>
              </span>
              <Select
                value={panel.cwdOverride || SOURCE_SENTINEL}
                items={{
                  [SOURCE_SENTINEL]: '使用源会话起始目录',
                  ...Object.fromEntries(
                    availableProjects.map((project) => [project.path, project.path]),
                  ),
                }}
                onValueChange={(value) => {
                  configureImport({ cwdOverride: value === SOURCE_SENTINEL ? '' : (value ?? '') })
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
                <SelectContent className="overflow-hidden" alignItemWithTrigger={false}>
                  <ScrollArea className="*:data-[slot=scroll-area-viewport]:max-h-[min(18rem,var(--available-height))]">
                    <SelectItem value={SOURCE_SENTINEL}>
                      <Trans>使用源会话起始目录</Trans>
                    </SelectItem>
                    {availableProjects.map((project) => (
                      <SelectItem key={project.path} value={project.path}>
                        @{project.alias} · {project.path}
                      </SelectItem>
                    ))}
                  </ScrollArea>
                </SelectContent>
              </Select>
            </div>

            <p className="text-muted-foreground bg-muted/40 rounded-md border px-2.5 py-2 text-xs">
              <Trans>
                会话将保存到服务端，请确认其中没有不希望保留的敏感信息。原文件保持不变。
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
                    <Trans>源起始目录</Trans>
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
                      aria-label="作为新会话导入"
                      className="mt-0.5 size-3.5 accent-current"
                      checked={panel.copyConfirmed}
                      onChange={(event) => setCopyConfirmed(event.target.checked)}
                    />
                    <span>
                      <Trans>作为新会话导入</Trans>
                    </span>
                  </label>
                )}
                {preview.conflict === 'already-exists' && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-muted-foreground">
                      <Trans>已有会话 ID：{preview.existingThreadId}</Trans>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => openExisting()}
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

            {panel.trustPath && (
              <div className="rounded-md border p-2">
                <div className="mb-2 flex items-center gap-1.5 text-xs">
                  <ShieldAlertIcon aria-hidden className="text-destructive size-3.5" />
                  <Trans>导入目标项目需要信任决定；拒绝后仍会使用用户级资源导入。</Trans>
                </div>
                {trust.open && trust.path === panel.trustPath ? (
                  <TrustDecisionPanel path={panel.trustPath} />
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openTrust(panel.trustPath ?? '')}
                  >
                    <Trans>决定信任</Trans>
                  </Button>
                )}
              </div>
            )}

            {panel.error && (
              <p role="alert" className="text-destructive text-sm">
                {panel.error}
              </p>
            )}
            {panel.notice && (
              <div
                role="status"
                className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2 text-xs"
              >
                <span>{panel.notice}</span>
                {panel.importedThreadId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => openImported()}
                  >
                    <Trans>打开已导入会话</Trans>
                  </Button>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" disabled={panel.busy} onClick={closeImport}>
            <Trans>取消</Trans>
          </Button>
          <Button variant="outline" disabled={!canPreview} onClick={() => void previewImport()}>
            {panel.busy ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : null}
            <Trans>预览导入</Trans>
          </Button>
          <Button
            data-slot="huan-import-confirm"
            disabled={!canImport}
            onClick={() => void confirmImport()}
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
  const openImport = useSessionsStore((state) => state.openImport)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label="导入 JSONL"
      onClick={() => openImport(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {})}
    >
      <FileUpIcon aria-hidden className="size-4" />
    </Button>
  )
}
