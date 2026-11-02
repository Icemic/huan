/**
 * MCP 管理面板（G1.4d4）。
 *
 * 入口：顶栏“MCP 服务器”与 `/mcp [login|logout|reconnect] [server]` 意图。
 * 只调用 d3 的公开宿主接口；目标在面板打开时固定，关闭后重新打开才重新选择，
 * 避免其他窗口切换会话时把旧异步结果附着到新目标。
 *
 * 状态边界：
 * - target 快照只在面板打开时轮询；auth 快照仅在面板打开或仍有活动操作时轮询；
 * - JSON 草稿是配置唯一编辑权威，保存带 revision；保存 ≠ 应用，重载必须显式；
 * - 工具/资源详情只在显式选择服务器时查询，不执行工具、不读取资源正文；
 * - OAuth 回填只提交给宿主内存，提交后立即清空本地输入，不写入任何持久存储。
 */
import type {
  HarnessMcpAuthOperation,
  HarnessMcpConfigFile,
  HarnessMcpConfigIssue,
  HarnessMcpConfigSnapshot,
  HarnessMcpDetails,
  HarnessMcpExposure,
  HarnessMcpManageAction,
  HarnessMcpServerAuth,
  HarnessMcpServerState,
  HarnessMcpSnapshot,
  HarnessMcpTargetInput,
} from '@huan/protocol'
import { HarnessHttpError, useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  ExternalLinkIcon,
  Loader2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  Trash2Icon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { clearPiIntent, usePiIntent } from './pi-command-intents'
import { harnessHttpClient } from './pi-http-client'
import {
  refreshMcpAuthSnapshot,
  setMcpAuthPanelOpen,
  useMcpAuthError,
  useMcpAuthSnapshot,
} from './pi-mcp-auth-store'
import {
  applyServerForm,
  emptyServerForm,
  formatMcpDraft,
  formFromServer,
  listDraftServers,
  MCP_EXPOSURES,
  type McpConfigDraft,
  type McpConfigDraftMap,
  type McpConfigScope,
  type McpServerForm,
  type McpServerKind,
  mcpDraftKey,
  parseMcpDraft,
  removeDraftServer,
  serverKindOf,
} from './pi-mcp-config'
import { bumpResourceVersion } from './resource-version'
import { useWorkspace } from './workspace-context'

const PENDING_THREAD_ID = '__pending__'
const UNSET = '__unset__'
const INHERIT = '__inherit__'
const exposureItems = Object.fromEntries(MCP_EXPOSURES.map((value) => [value, value])) as Record<
  string,
  string
>
const exposureWithUnsetItems = { [UNSET]: '未设置（默认）', ...exposureItems }
const enabledItems = { [UNSET]: '未设置（默认）', true: '启用', false: '停用' }

type ServerRow = {
  name: string
  identity: string
  scope: 'user' | 'project' | 'extension'
  override: boolean
  enabled: boolean
  exposure: HarnessMcpExposure
  state: HarnessMcpServerState
  toolCount: number
  hasResources: boolean
  auth?: HarnessMcpServerAuth
  error?: { code: string; message: string }
  live: boolean
  configPending: boolean
}

const stateLabel = (state: HarnessMcpServerState): string => {
  switch (state) {
    case 'connecting':
      return '连接中'
    case 'connected':
      return '已连接'
    case 'disconnected':
      return '已断开'
    case 'needs-auth':
      return '需要认证'
    case 'failed':
      return '失败'
    case 'closed':
      return '已关闭'
    case 'disabled':
      return '已停用'
    case 'not-connected':
      return '未连接'
  }
}

const authKindLabel = (kind: HarnessMcpServerAuth['kind']): string => {
  switch (kind) {
    case 'oauth':
      return 'OAuth'
    case 'static-header':
      return '静态 Header'
    case 'provider':
      return 'provider 凭据'
    case 'stdio':
      return 'stdio'
  }
}

const phaseLabel = (operation: HarnessMcpAuthOperation): string => {
  switch (operation.phase) {
    case 'starting':
      return '正在开始'
    case 'waiting':
      return '等待授权'
    case 'prompt':
      return '等待回填'
    case 'verifying':
      return '正在验证'
    case 'cancelling':
      return '正在取消'
    case 'succeeded':
      return '成功'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
  }
}

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const activeAuthOperation = (operation: HarnessMcpAuthOperation): boolean =>
  operation.phase !== 'succeeded' && operation.phase !== 'failed' && operation.phase !== 'cancelled'

const targetKeyOf = (target: HarnessMcpTargetInput | undefined): string | undefined => {
  if (!target) return undefined
  if (target.threadId) return `t:${target.threadId}`
  if (target.workspacePath) return `w:${target.workspacePath}`
  return undefined
}

const targetOfSnapshot = (target: HarnessMcpSnapshot['target']): string =>
  target.kind === 'session' ? `t:${target.threadId ?? ''}` : `w:${target.workspacePath}`

const scopeLabel = (scope: 'user' | 'project' | 'extension'): string => {
  if (scope === 'user') return '用户'
  if (scope === 'project') return '项目'
  return '扩展临时'
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      data-slot="huan-mcp-notice"
      className="bg-muted/50 rounded-md border px-2 py-1.5 text-xs whitespace-pre-wrap"
    >
      {children}
    </div>
  )
}

function FileSummary({ file }: { file: HarnessMcpConfigFile }) {
  return (
    <div data-slot="huan-mcp-file" className="flex flex-col gap-1 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {file.scope === 'user' ? <Trans>用户 MCP 配置</Trans> : <Trans>项目 MCP 配置</Trans>}
        </span>
        <span className="text-muted-foreground break-all">{file.path}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-2">
        <span>
          {file.exists ? (
            <Trans>已存在</Trans>
          ) : file.readable ? (
            <Trans>尚未创建（保存时写入）</Trans>
          ) : (
            <Trans>未读取（项目未信任）</Trans>
          )}
        </span>
        <span>{file.bytes} B</span>
        <span className="font-mono">
          revision {file.revision ? file.revision.slice(0, 12) : 'null'}
        </span>
        {file.tooLarge && (
          <span className="text-destructive">
            <Trans>超过读取上限</Trans>
          </span>
        )}
      </div>
      {file.readError && <p className="text-destructive">{file.readError}</p>}
      {file.issues.length > 0 && <IssueList issues={file.issues} />}
    </div>
  )
}

function IssueList({ issues }: { issues: readonly HarnessMcpConfigIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul data-slot="huan-mcp-issues" className="text-destructive list-disc ps-4 text-xs">
      {issues.map((issue) => (
        <li
          key={`${issue.kind}:${issue.scope}:${issue.file}:${issue.server ?? ''}:${issue.message}`}
        >
          <span className="font-mono">{issue.server ?? issue.kind}</span> {issue.message}
        </li>
      ))}
    </ul>
  )
}

function ExposureSelect({
  value,
  onValueChange,
  label,
  disabled,
  allowUnset = false,
  allowInherit = false,
}: {
  value: HarnessMcpExposure | undefined
  onValueChange: (value: HarnessMcpExposure | null) => void
  label: string
  disabled: boolean
  allowUnset?: boolean
  allowInherit?: boolean
}) {
  const current = value ?? (allowInherit ? INHERIT : UNSET)
  return (
    <Select
      value={current}
      items={allowInherit ? { [INHERIT]: '跟随服务器', ...exposureItems } : exposureWithUnsetItems}
      onValueChange={(next) => {
        if (next === INHERIT) onValueChange(null)
        else if (next === UNSET) onValueChange(null)
        else onValueChange(next as HarnessMcpExposure)
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowInherit && <SelectItem value={INHERIT}>跟随服务器</SelectItem>}
        {!allowInherit && allowUnset && <SelectItem value={UNSET}>未设置（默认）</SelectItem>}
        {MCP_EXPOSURES.map((exposure) => (
          <SelectItem key={exposure} value={exposure}>
            {exposure}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ServerRowView({
  row,
  selected,
  busy,
  onSelect,
  onManage,
  onLogin,
  onLogout,
}: {
  row: ServerRow
  selected: boolean
  busy: boolean
  onSelect: () => void
  onManage: (action: HarnessMcpManageAction) => void
  onLogin: () => void
  onLogout: () => void
}) {
  const manageable = row.live && row.auth !== undefined
  const oauth = row.auth?.kind === 'oauth' && row.auth.loginable
  return (
    <section
      data-slot="huan-mcp-server"
      data-server-name={row.name}
      data-state={row.state}
      data-live={row.live ? 'true' : 'false'}
      className={`flex flex-col gap-2 rounded-lg border p-3 ${selected ? 'ring-ring ring-2' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 font-semibold"
          aria-label={`查看 ${row.name} 详情`}
          onClick={onSelect}
        >
          {row.name}
        </Button>
        <span
          className={`rounded px-1.5 text-[11px] ${
            row.state === 'connected'
              ? 'bg-primary/10 text-primary'
              : row.state === 'failed' || row.state === 'needs-auth'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground'
          }`}
          data-slot="huan-mcp-server-state"
        >
          {stateLabel(row.state)}
        </span>
        <span className="text-muted-foreground text-xs">
          {scopeLabel(row.scope)}
          {row.override ? ' · 项目 override' : ''}
        </span>
        {row.configPending && (
          <span
            className="rounded bg-amber-500/10 px-1.5 text-[11px] text-amber-700 dark:text-amber-400"
            data-slot="huan-mcp-config-pending"
          >
            <Trans>配置未应用</Trans>
          </span>
        )}
        <span className="text-muted-foreground ms-auto text-xs">
          {row.toolCount} 工具 · {row.hasResources ? '有资源' : '无资源'} · {row.exposure}
        </span>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono break-all">{row.identity}</span>
        {row.auth && (
          <span>
            {authKindLabel(row.auth.kind)}
            {row.auth.hasCredentials ? ' · 已存凭据' : ''}
            {row.auth.needsRefresh ? ' · 待刷新' : ''}
          </span>
        )}
        {!row.live && (
          <span>
            <Trans>未连接：保存配置后需显式应用资源重载。</Trans>
          </span>
        )}
        {row.scope === 'extension' && (
          <span>
            <Trans>扩展临时注册不写入配置文件。</Trans>
          </span>
        )}
      </div>

      {row.error && (
        <p className="text-destructive text-xs" data-slot="huan-mcp-server-error">
          {row.error.message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-[11px]">
          <Trans>本会话临时</Trans>
        </span>
        <Button
          variant="outline"
          size="xs"
          aria-label={row.enabled ? `停用 ${row.name}` : `启用 ${row.name}`}
          disabled={!manageable || busy}
          onClick={() => onManage({ type: 'setEnabled', enabled: !row.enabled })}
        >
          {row.enabled ? <Trans>停用</Trans> : <Trans>启用</Trans>}
        </Button>
        <ExposureSelect
          value={row.exposure}
          onValueChange={(exposure) => exposure && onManage({ type: 'setExposure', exposure })}
          label={`${row.name} exposure`}
          disabled={!manageable || busy}
        />
        <Button
          variant="outline"
          size="xs"
          aria-label={`重连 ${row.name}`}
          disabled={!manageable || busy}
          onClick={() => onManage({ type: 'reconnect' })}
        >
          <RefreshCwIcon aria-hidden />
          <Trans>重连</Trans>
        </Button>
        {oauth && (
          <>
            <Button
              variant="outline"
              size="xs"
              aria-label={`登录 ${row.name}`}
              disabled={!manageable || busy}
              onClick={onLogin}
            >
              <PlugZapIcon aria-hidden />
              <Trans>登录</Trans>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`退出 ${row.name}`}
              disabled={!manageable || busy || !row.auth?.hasCredentials}
              onClick={onLogout}
            >
              <Trans>退出登录</Trans>
            </Button>
          </>
        )}
      </div>
      {!manageable && (
        <p className="text-muted-foreground text-xs">
          {row.live ? (
            <Trans>该服务器没有可交互认证信息。</Trans>
          ) : (
            <Trans>连接建立前不能执行运行态操作；先应用资源重载。</Trans>
          )}
        </p>
      )}
    </section>
  )
}

function ToolDetails({
  details,
  busy,
  onExposure,
  onRefresh,
}: {
  details: HarnessMcpDetails | undefined
  busy: boolean
  onExposure: (tool: string, exposure: HarnessMcpExposure | null) => void
  onRefresh: () => void
}) {
  if (!details) return null
  return (
    <section data-slot="huan-mcp-details" className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{details.server.name}</strong>
        <span className="text-muted-foreground text-xs">
          {stateLabel(details.server.state)} · toolRevision {details.server.toolRevision}
        </span>
        <Button
          variant="outline"
          size="xs"
          className="ms-auto"
          aria-label="刷新 MCP 详情"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? (
            <Loader2Icon aria-hidden className="animate-spin" />
          ) : (
            <RefreshCwIcon aria-hidden />
          )}
          <Trans>刷新详情</Trans>
        </Button>
      </div>
      {details.instructions && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            <Trans>服务器 instructions</Trans>
          </span>
          <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 text-xs whitespace-pre-wrap">
            {details.instructions}
          </pre>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          <Trans>工具（本会话 exposure）</Trans>
        </span>
        {(details.tools ?? []).length === 0 ? (
          <p className="text-muted-foreground text-xs">（无）</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {details.tools?.map((tool) => (
              <li
                key={tool.name}
                data-slot="huan-mcp-tool"
                data-tool-name={tool.name}
                className="flex flex-col gap-1 rounded-md border p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{tool.name}</span>
                  {tool.title && <span>{tool.title}</span>}
                  <ExposureSelect
                    value={tool.exposure}
                    onValueChange={(exposure) => onExposure(tool.name, exposure)}
                    label={`工具 ${tool.name} exposure`}
                    disabled={busy}
                    allowInherit
                  />
                </div>
                {tool.description && <p className="text-muted-foreground">{tool.description}</p>}
                {tool.annotations && (
                  <p className="text-muted-foreground font-mono">
                    {[
                      tool.annotations.readOnlyHint ? 'readOnly' : undefined,
                      tool.annotations.destructiveHint ? 'destructive' : undefined,
                      tool.annotations.idempotentHint ? 'idempotent' : undefined,
                      tool.annotations.openWorldHint ? 'openWorld' : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '无注解标记'}
                  </p>
                )}
                <details>
                  <summary className="text-muted-foreground cursor-pointer">inputSchema</summary>
                  <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                    {JSON.stringify(tool.inputSchema, null, 2)}
                  </pre>
                </details>
                {tool.outputSchema && (
                  <details>
                    <summary className="text-muted-foreground cursor-pointer">outputSchema</summary>
                    <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                      {JSON.stringify(tool.outputSchema, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          <Trans>资源（只列目录，不读取正文）</Trans>
        </span>
        {(details.resources ?? []).length === 0 ? (
          <p className="text-muted-foreground text-xs">（无）</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {details.resources?.map((resource) => (
              <li key={resource.uri} data-slot="huan-mcp-resource" className="text-xs">
                <span className="font-mono">{resource.uri}</span> · {resource.name}
                {resource.mimeType ? ` · ${resource.mimeType}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          <Trans>资源模板</Trans>
        </span>
        {(details.resourceTemplates ?? []).length === 0 ? (
          <p className="text-muted-foreground text-xs">（无）</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {details.resourceTemplates?.map((template) => (
              <li key={template.uriTemplate} className="font-mono text-xs">
                {template.uriTemplate} · {template.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function PromptForm({
  operation,
  promptId,
  onNotice,
}: {
  operation: HarnessMcpAuthOperation
  promptId: string
  onNotice: (message: string | undefined) => void
}) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)

  // 提示切换时丢弃旧输入；组件以 promptId 为 key 重新挂载。
  // biome-ignore lint/correctness/useExhaustiveDependencies: promptId 变化必须重置。
  useEffect(() => {
    setAnswer('')
    setBusy(false)
  }, [promptId])

  const submit = async () => {
    if (busy) return
    const submitted = answer
    // 提交前立即清空；错误提示也不带提交值，不写任何持久草稿。
    setAnswer('')
    setBusy(true)
    onNotice(undefined)
    try {
      const result = await harnessHttpClient.respondMcpAuth({
        operationId: operation.id,
        promptId,
        value: submitted,
      })
      if (result.status === 'stale') onNotice('该 MCP 认证提示已失效，请查看最新状态。')
      else if (result.status === 'invalid') onNotice(result.message)
      await refreshMcpAuthSnapshot()
    } catch {
      onNotice('提交 MCP 认证输入失败，请检查宿主连接后重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      data-slot="huan-mcp-auth-prompt"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1 text-xs">
        <span>{operation.prompt?.message ?? '回填授权回调 URL'}</span>
        <Input
          aria-label="授权回调 URL"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={8_192}
          value={answer}
          placeholder={operation.prompt?.placeholder}
          disabled={busy}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" aria-label="提交回填" disabled={busy}>
          {busy && <Loader2Icon aria-hidden className="animate-spin" />}
          <Trans>提交回填</Trans>
        </Button>
      </div>
    </form>
  )
}

function AuthOperationCard({
  operation,
  onNotice,
}: {
  operation: HarnessMcpAuthOperation
  onNotice: (message: string | undefined) => void
}) {
  const [cancelling, setCancelling] = useState(false)
  const result = operation.result
  const canCancel = activeAuthOperation(operation) && operation.phase !== 'cancelling'

  const cancel = async () => {
    if (cancelling) return
    setCancelling(true)
    onNotice(undefined)
    try {
      const answer = await harnessHttpClient.cancelMcpAuth(operation.id)
      if (answer.status === 'not-found') onNotice('该 MCP 认证操作已不存在。')
      else if (answer.status === 'finished') onNotice('该 MCP 认证操作已经结束，取消未生效。')
      await refreshMcpAuthSnapshot()
    } catch {
      onNotice('取消 MCP 认证失败，请检查宿主连接。')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <section
      data-slot="huan-mcp-auth-operation"
      data-operation-id={operation.id}
      data-phase={operation.phase}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{operation.server}</strong>
        <span className="text-muted-foreground text-xs">
          {operation.kind === 'login' ? <Trans>登录</Trans> : <Trans>退出登录</Trans>} ·{' '}
          {phaseLabel(operation)}
        </span>
        <span className="text-muted-foreground ms-auto font-mono text-[11px] break-all">
          {operation.target.workspacePath}
        </span>
      </div>

      {operation.authUrl && isHttpUrl(operation.authUrl) && (
        <a
          className="text-primary inline-flex w-fit items-center gap-1 text-xs underline"
          href={operation.authUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-slot="huan-mcp-auth-url"
        >
          <Trans>打开授权页</Trans>
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      )}
      {operation.authUrl && !isHttpUrl(operation.authUrl) && (
        <p className="text-destructive text-xs">
          <Trans>授权链接不是 http(s)，已拒绝显示。</Trans>
        </p>
      )}

      {operation.prompt && operation.phase === 'prompt' && (
        <PromptForm
          key={operation.prompt.promptId}
          operation={operation}
          promptId={operation.prompt.promptId}
          onNotice={onNotice}
        />
      )}

      {result && (
        <p
          role="status"
          data-slot="huan-mcp-auth-result"
          data-status={result.status}
          className={`text-xs ${result.status === 'succeeded' ? '' : 'text-muted-foreground'}`}
        >
          {result.message}
          {result.reconnect === 'deferred' ? '（会话正忙，未强制重连）' : ''}
        </p>
      )}

      {canCancel && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            aria-label="取消 MCP 认证"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling && <Loader2Icon aria-hidden className="animate-spin" />}
            <Trans>取消认证</Trans>
          </Button>
        </div>
      )}
    </section>
  )
}

type EditorState = {
  originalName?: string
  form: McpServerForm
}

function ServerFormFields({
  editor,
  onChange,
  onCancel,
  onSubmit,
  busy,
  localError,
}: {
  editor: EditorState
  onChange: (next: McpServerForm) => void
  onCancel: () => void
  onSubmit: () => void
  busy: boolean
  localError: string | undefined
}) {
  const form = editor.form
  const set = <K extends keyof McpServerForm>(key: K, value: McpServerForm[K]) =>
    onChange({ ...form, [key]: value })
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-slot="huan-mcp-server-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">
          {editor.originalName ? <Trans>修改服务器</Trans> : <Trans>新增服务器</Trans>} ·{' '}
          {form.kind === 'override' ? 'override' : form.kind}
        </strong>
        {form.kind === 'override' && (
          <span className="text-muted-foreground text-xs">
            <Trans>项目 override 只写 enabled / exposure / toolExposure。</Trans>
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-xs">
          <span>服务器名称</span>
          <Input
            aria-label="服务器名称"
            value={form.name}
            disabled={busy}
            onChange={(event) => set('name', event.target.value)}
          />
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1 text-xs">
            <span>默认 enabled</span>
            <Select
              value={form.enabled}
              items={enabledItems}
              onValueChange={(next) => set('enabled', next as McpServerForm['enabled'])}
              disabled={busy}
            >
              <SelectTrigger size="sm" aria-label="启用状态" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>未设置（默认）</SelectItem>
                <SelectItem value="true">启用</SelectItem>
                <SelectItem value="false">停用</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ExposureSelect
            value={form.exposure === 'unset' ? undefined : form.exposure}
            onValueChange={(exposure) => set('exposure', exposure ?? 'unset')}
            label="服务器 exposure"
            disabled={busy}
            allowUnset
          />
        </div>
      </div>

      {form.kind === 'stdio' && (
        <>
          <div className="flex flex-col gap-1 text-xs">
            <span>stdio command</span>
            <Input
              aria-label="stdio 命令"
              value={form.command}
              disabled={busy}
              onChange={(event) => set('command', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>stdio args（每行一个）</span>
            <Textarea
              aria-label="stdio 参数"
              rows={3}
              className="font-mono text-xs"
              value={form.argsText}
              disabled={busy}
              onChange={(event) => set('argsText', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>环境变量（NAME=value，每行一个）</span>
            <Textarea
              aria-label="环境变量"
              rows={3}
              className="font-mono text-xs"
              value={form.envText}
              disabled={busy}
              onChange={(event) => set('envText', event.target.value)}
            />
          </div>
        </>
      )}

      {form.kind === 'http' && (
        <>
          <div className="flex flex-col gap-1 text-xs">
            <span>HTTP URL</span>
            <Input
              aria-label="HTTP URL"
              value={form.url}
              disabled={busy}
              onChange={(event) => set('url', event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>Headers（NAME=value，每行一个）</span>
            <Textarea
              aria-label="HTTP headers"
              rows={3}
              className="font-mono text-xs"
              value={form.headersText}
              disabled={busy}
              onChange={(event) => set('headersText', event.target.value)}
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1 text-xs">
        <span>toolExposure（tool=exposure，每行一个；支持 *）</span>
        <Textarea
          aria-label="工具 exposure"
          rows={3}
          className="font-mono text-xs"
          value={form.toolExposureText}
          disabled={busy}
          onChange={(event) => set('toolExposureText', event.target.value)}
        />
      </div>

      {localError && (
        <p role="alert" className="text-destructive text-xs">
          {localError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          <Trans>取消</Trans>
        </Button>
        <Button type="submit" size="sm" aria-label="保存服务器" disabled={busy}>
          <Trans>保存到 JSON 草稿</Trans>
        </Button>
      </div>
    </form>
  )
}

function ConfigEditor({
  scope,
  onScopeChange,
  snapshot,
  files,
  draft,
  disabled,
  busy,
  dirtyScopes,
  onContentChange,
  onSave,
  onReread,
  onReset,
  onNotice,
}: {
  scope: McpConfigScope
  onScopeChange: (scope: McpConfigScope) => void
  snapshot: HarnessMcpConfigSnapshot | undefined
  files: { user: HarnessMcpConfigFile; project: HarnessMcpConfigFile } | undefined
  draft: McpConfigDraft | undefined
  disabled: boolean
  busy: boolean
  dirtyScopes: { user: boolean; project: boolean }
  onContentChange: (content: string) => void
  onSave: () => void
  onReread: () => void
  onReset: () => void
  onNotice: (message: string | undefined) => void
}) {
  const [view, setView] = useState<'common' | 'json'>('common')
  const [editor, setEditor] = useState<EditorState>()
  const [localError, setLocalError] = useState<string>()
  const [deleteName, setDeleteName] = useState<string>()
  const [confirmReread, setConfirmReread] = useState(false)
  const dirty = dirtyScopes[scope]
  const parsed = useMemo(() => (draft ? parseMcpDraft(draft.content) : undefined), [draft])
  const file = files ? files[scope] : undefined
  const root = parsed?.value
  const scopeBlocked = scope === 'project' && snapshot !== undefined && !snapshot.projectTrusted
  const canEdit = !disabled && !scopeBlocked && draft !== undefined && busy === false
  const servers = useMemo(() => (root ? listDraftServers(root, scope) : []), [root, scope])
  useEffect(() => {
    if (!dirty) setConfirmReread(false)
  }, [dirty])

  const reread = () => {
    if (dirty && !confirmReread) {
      setConfirmReread(true)
      onNotice('当前作用域有未保存改动；再次点击“确认重新读取”将丢弃该草稿。')
      return
    }
    setConfirmReread(false)
    onReread()
  }

  const openAdd = (kind: McpServerKind) => {
    setEditor({ form: emptyServerForm(kind) })
    setLocalError(undefined)
    setDeleteName(undefined)
    setView('common')
  }

  const openEdit = (name: string) => {
    const server = servers.find((item) => item.name === name)
    if (!server) return
    setEditor({
      originalName: name,
      form: formFromServer(
        name,
        server.raw,
        server.override ? 'override' : serverKindOf(server.raw),
      ),
    })
    setLocalError(undefined)
    setDeleteName(undefined)
    setView('common')
  }

  const applyEditor = () => {
    if (!editor || !root) return
    const result = applyServerForm(root, editor.originalName, editor.form)
    if (result.error !== undefined) {
      setLocalError(result.error)
      return
    }
    onContentChange(formatMcpDraft(result.root))
    setEditor(undefined)
    setLocalError(undefined)
    onNotice('服务器改动已写入 JSON 草稿；保存只写磁盘，需显式应用资源重载。')
  }

  const removeServer = (name: string) => {
    if (!root) return
    onContentChange(formatMcpDraft(removeDraftServer(root, name)))
    setDeleteName(undefined)
    onNotice(`已从 JSON 草稿删除 ${name}；保存只写磁盘。`)
  }

  return (
    <div className="flex flex-col gap-3" data-slot="huan-mcp-config">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="MCP 配置作用域" className="flex gap-1">
          <Button
            size="sm"
            variant={scope === 'user' ? 'secondary' : 'outline'}
            role="tab"
            aria-selected={scope === 'user'}
            aria-label="编辑用户 MCP 配置"
            onClick={() => onScopeChange('user')}
          >
            <Trans>用户</Trans>
            {dirtyScopes.user && <DirtyBadge />}
          </Button>
          <Button
            size="sm"
            variant={scope === 'project' ? 'secondary' : 'outline'}
            role="tab"
            aria-selected={scope === 'project'}
            aria-label="编辑项目 MCP 配置"
            disabled={snapshot !== undefined && !snapshot.projectTrusted}
            onClick={() => onScopeChange('project')}
          >
            <Trans>项目</Trans>
            {dirtyScopes.project && <DirtyBadge />}
          </Button>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label={confirmReread ? '确认重新读取 MCP 配置' : '重新读取 MCP 配置'}
            disabled={busy || !snapshot}
            onClick={reread}
          >
            <RefreshCwIcon aria-hidden />
            {confirmReread ? <Trans>确认重新读取</Trans> : <Trans>重新读取</Trans>}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="重置 MCP 草稿"
            disabled={!dirty || busy}
            onClick={onReset}
          >
            <Trans>重置改动</Trans>
          </Button>
          <Button
            size="sm"
            aria-label="保存 MCP 配置"
            disabled={!dirty || busy || !draft || !file || file.tooLarge || !!file.readError}
            onClick={onSave}
          >
            {busy && <Loader2Icon aria-hidden className="animate-spin" />}
            <Trans>保存 MCP 配置</Trans>
          </Button>
        </div>
      </div>

      {file && <FileSummary file={file} />}
      {snapshot && !snapshot.projectTrusted && (
        <p role="status" className="text-destructive text-xs">
          <Trans>
            项目未信任：不会读取或写入项目 MCP 配置。请先在项目信任面板允许；用户配置仍可编辑。
          </Trans>
        </p>
      )}

      {snapshot && (
        <details className="text-xs" data-slot="huan-mcp-effective">
          <summary className="cursor-pointer">
            <Trans>磁盘合并后的有效服务器（未应用到 live 会话）</Trans>
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {snapshot.effective.servers.map((server) => (
              <li
                key={server.name}
                data-slot="huan-mcp-effective-server"
                data-server-name={server.name}
              >
                <span className="font-mono">{server.name}</span> · {scopeLabel(server.scope)}
                {server.override ? ' · override' : ''} · {server.enabled ? '启用' : '停用'} ·{' '}
                {server.exposure}
              </li>
            ))}
          </ul>
          <IssueList issues={snapshot.effective.issues} />
        </details>
      )}

      <div role="tablist" aria-label="MCP 配置视图" className="flex gap-1">
        <Button
          size="sm"
          variant={view === 'common' ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={view === 'common'}
          aria-label="MCP 常用编辑"
          onClick={() => setView('common')}
        >
          <Trans>常用编辑</Trans>
        </Button>
        <Button
          size="sm"
          variant={view === 'json' ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={view === 'json'}
          aria-label="MCP JSON 原文"
          onClick={() => setView('json')}
        >
          <Trans>JSON 原文</Trans>
        </Button>
      </div>

      {!draft && (
        <p className="text-sm">
          <Trans>该作用域没有可编辑的原文（未信任、读取失败或文件过大）。</Trans>
        </p>
      )}

      {draft && (
        <>
          {parsed?.error && (
            <p role="alert" data-slot="huan-mcp-local-error" className="text-destructive text-xs">
              {parsed.error}
            </p>
          )}
          <IssueList issues={draft.issues} />
          {view === 'json' ? (
            <div className="flex flex-col gap-1">
              <Textarea
                aria-label="MCP 配置 JSON"
                className="min-h-72 font-mono text-xs"
                spellCheck={false}
                value={draft.content}
                disabled={!canEdit}
                onChange={(event) => onContentChange(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                <Trans>
                  这里编辑完整文件内容；常用表单、新增和删除也只改这份草稿。未知字段保留，
                  保存会整体替换该文件；保存成功后仍需显式应用资源重载。
                </Trans>
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-slot="huan-mcp-common">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="新增 stdio 服务器"
                  disabled={!canEdit || !root}
                  onClick={() => openAdd('stdio')}
                >
                  <Trans>新增 stdio</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="新增 HTTP 服务器"
                  disabled={!canEdit || !root}
                  onClick={() => openAdd('http')}
                >
                  <Trans>新增 HTTP</Trans>
                </Button>
                {scope === 'project' && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="新增项目 override"
                    disabled={!canEdit || !root}
                    onClick={() => openAdd('override')}
                  >
                    <Trans>新增 override</Trans>
                  </Button>
                )}
              </div>

              {!root && (
                <p className="text-muted-foreground text-xs">
                  <Trans>先修复 JSON 解析错误，常用表单才可用。</Trans>
                </p>
              )}

              {scope === 'project' && (
                <p className="text-muted-foreground text-xs">
                  <Trans>
                    项目 override 只写 enabled、exposure、toolExposure，且需要与用户服务器同名；
                    扩展临时注册不会写入任何配置文件。
                  </Trans>
                </p>
              )}

              {root && servers.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  <Trans>草稿中还没有服务器条目。</Trans>
                </p>
              )}

              {root &&
                servers.map((server) => (
                  <div
                    key={server.name}
                    data-slot="huan-mcp-draft-server"
                    data-server-name={server.name}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
                  >
                    <span className="font-mono font-medium">{server.name}</span>
                    <span className="text-muted-foreground">
                      {server.override ? '项目 override' : serverKindOf(server.raw)}
                    </span>
                    <span className="text-muted-foreground">
                      {typeof server.raw.command === 'string'
                        ? server.raw.command
                        : typeof server.raw.url === 'string'
                          ? server.raw.url
                          : ''}
                    </span>
                    <span className="text-muted-foreground">
                      {server.raw.enabled === false ? '停用' : '启用'}
                      {typeof server.raw.exposure === 'string' ? ` · ${server.raw.exposure}` : ''}
                    </span>
                    <div className="ms-auto flex gap-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label={`修改 ${server.name}`}
                        disabled={!canEdit}
                        onClick={() => openEdit(server.name)}
                      >
                        <Trans>修改</Trans>
                      </Button>
                      {deleteName === server.name ? (
                        <Button
                          variant="destructive"
                          size="xs"
                          aria-label={`确认删除 ${server.name}`}
                          disabled={!canEdit}
                          onClick={() => removeServer(server.name)}
                        >
                          <Trash2Icon aria-hidden />
                          <Trans>确认删除</Trans>
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-label={`删除 ${server.name}`}
                          disabled={!canEdit}
                          onClick={() => setDeleteName(server.name)}
                        >
                          <Trash2Icon aria-hidden />
                          <Trans>删除</Trans>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}

              {editor && (
                <ServerFormFields
                  editor={editor}
                  onChange={(form) => setEditor({ ...editor, form })}
                  onCancel={() => {
                    setEditor(undefined)
                    setLocalError(undefined)
                  }}
                  onSubmit={applyEditor}
                  busy={!canEdit}
                  localError={localError}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DirtyBadge() {
  return (
    <span className="bg-muted ms-1 rounded px-1 text-xs">
      <Trans>未保存</Trans>
    </span>
  )
}

export function McpDialog() {
  const metadata = useHarnessThreadState((state) => state.metadata)
  const { workspaces, activeWorkspaceId, startProjectFor } = useWorkspace()
  const intent = usePiIntent()
  const authSnapshot = useMcpAuthSnapshot()
  const authError = useMcpAuthError()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'servers' | 'config' | 'auth'>('servers')
  const [target, setTarget] = useState<HarnessMcpTargetInput>()
  const [targetKey, setTargetKey] = useState<string>()
  const [snapshot, setSnapshot] = useState<HarnessMcpSnapshot>()
  const [configSnapshot, setConfigSnapshot] = useState<HarnessMcpConfigSnapshot>()
  const [drafts, setDrafts] = useState<McpConfigDraftMap>({})
  const [scope, setScope] = useState<McpConfigScope>('user')
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [details, setDetails] = useState<HarnessMcpDetails>()
  const [detailsError, setDetailsError] = useState<string>()
  const [detailsBusy, setDetailsBusy] = useState(false)
  const [targetError, setTargetError] = useState<string>()
  const [seedIntent, setSeedIntent] = useState<
    { id: number; mode?: string; server?: string } | undefined
  >()

  const panelGeneration = useRef(0)
  const targetGeneration = useRef(0)
  const configGeneration = useRef(0)
  const saveGeneration = useRef(0)
  const manageGeneration = useRef(0)
  const detailsGeneration = useRef(0)
  const handledIntent = useRef<number | undefined>(undefined)
  const lastRuntime = useRef<string | undefined>(undefined)
  const targetKeyRef = useRef<string | undefined>(undefined)

  const pending = !metadata.id || metadata.id === PENDING_THREAD_ID
  const workspace = metadata.workspaceId
    ? workspaces.find((item) => item.id === metadata.workspaceId)
    : workspaces.find((item) => item.id === activeWorkspaceId)
  const currentCwd = metadata.workspacePath ?? (workspace ? startProjectFor(workspace) : undefined)
  const currentTarget = useMemo<HarnessMcpTargetInput | undefined>(() => {
    if (!pending) return { threadId: metadata.id }
    return currentCwd ? { workspacePath: currentCwd } : undefined
  }, [pending, metadata.id, currentCwd])

  const liveSnapshot =
    snapshot && targetKey && targetOfSnapshot(snapshot.target) === targetKey ? snapshot : undefined
  const readyConfig =
    configSnapshot && targetKey && targetOfSnapshot(configSnapshot.target) === targetKey
      ? configSnapshot
      : undefined
  const runtimeId = liveSnapshot?.runtime?.runtimeId
  const draft = targetKey ? drafts[mcpDraftKey(targetKey, scope)] : undefined
  const dirtyScopes = useMemo(() => {
    const dirtyOf = (nextScope: McpConfigScope): boolean => {
      if (!targetKey) return false
      const next = drafts[mcpDraftKey(targetKey, nextScope)]
      return next !== undefined && next.content !== next.baseContent
    }
    return { user: dirtyOf('user'), project: dirtyOf('project') }
  }, [drafts, targetKey])
  const configReady = readyConfig !== undefined

  const rows = useMemo<ServerRow[]>(() => {
    const map = new Map<string, ServerRow>()
    const configured = new Map(
      (readyConfig?.effective.servers ?? []).map((server) => [server.name, server]),
    )
    for (const server of readyConfig?.effective.servers ?? []) {
      map.set(server.name, {
        name: server.name,
        identity: server.identity,
        scope: server.scope,
        override: server.override,
        enabled: server.enabled,
        exposure: server.exposure,
        state: server.enabled ? 'not-connected' : 'disabled',
        toolCount: 0,
        hasResources: false,
        live: false,
        configPending: false,
      })
    }
    for (const server of liveSnapshot?.servers ?? []) {
      const config = configured.get(server.name)
      map.set(server.name, {
        name: server.name,
        identity: server.identity,
        scope: server.scope,
        override: server.override,
        enabled: server.enabled,
        exposure: server.exposure,
        state: server.state,
        toolCount: server.toolCount,
        hasResources: server.hasResources,
        auth: server.auth,
        ...(server.error ? { error: server.error } : {}),
        live: liveSnapshot?.runtime !== undefined && !liveSnapshot.runtime.closed,
        configPending:
          config !== undefined &&
          (config.enabled !== server.enabled || config.exposure !== server.exposure),
      })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [readyConfig, liveSnapshot])

  const selectedRow = rows.find((row) => row.name === selected)

  const applyLiveSnapshot = useCallback((next: HarnessMcpSnapshot) => {
    setSnapshot(next)
    const nextRuntime = next.runtime?.runtimeId
    if (nextRuntime !== lastRuntime.current) {
      lastRuntime.current = nextRuntime
      // runtime 替换后旧 schema/instructions 不再权威，等用户重新选择。
      detailsGeneration.current += 1
      setDetailsBusy(false)
      setDetails(undefined)
      setDetailsError(undefined)
    }
  }, [])

  const fetchTarget = useCallback(async () => {
    if (!target) return
    const generation = ++targetGeneration.current
    try {
      const next = await harnessHttpClient.getMcp(target)
      if (generation !== targetGeneration.current) return
      applyLiveSnapshot(next)
      setTargetError(undefined)
    } catch {
      if (generation === targetGeneration.current) {
        setTargetError('无法刷新 MCP 服务器状态；将自动重试。')
      }
    }
  }, [target, applyLiveSnapshot])

  const initializeDrafts = useCallback(
    (next: HarnessMcpConfigSnapshot, key: string, resetScope?: McpConfigScope) => {
      setDrafts((current) => {
        const updated = { ...current }
        for (const nextScope of ['user', 'project'] as const) {
          const nextKey = mcpDraftKey(key, nextScope)
          if (resetScope === nextScope) delete updated[nextKey]
          const file = nextScope === 'user' ? next.files.user : next.files.project
          const existing = updated[nextKey]
          if (
            (!existing || existing.content === existing.baseContent) &&
            file.readable &&
            !file.tooLarge
          ) {
            const content = file.exists ? file.content : '{}\n'
            updated[nextKey] = {
              content,
              baseContent: content,
              revision: file.revision,
              issues: [],
            }
          }
        }
        return updated
      })
    },
    [],
  )

  const fetchConfig = useCallback(
    async (options?: { resetScope?: McpConfigScope }) => {
      if (!target || !targetKey) return
      const generation = ++configGeneration.current
      setBusy((current) => current ?? 'config')
      try {
        const next = await harnessHttpClient.getMcpConfig(target)
        if (generation !== configGeneration.current) return
        setConfigSnapshot(next)
        initializeDrafts(next, targetKey, options?.resetScope)
      } catch (error) {
        if (generation === configGeneration.current) {
          setNotice(configFailure(error))
        }
      } finally {
        if (generation === configGeneration.current) {
          setBusy((current) => (current === 'config' ? undefined : current))
        }
      }
    },
    [target, targetKey, initializeDrafts],
  )

  const openPanel = useCallback(
    (seed?: { id: number; mode?: string; server?: string }) => {
      panelGeneration.current += 1
      targetGeneration.current += 1
      configGeneration.current += 1
      saveGeneration.current += 1
      manageGeneration.current += 1
      detailsGeneration.current += 1
      setDetailsBusy(false)
      const nextTarget = currentTarget
      const nextKey = targetKeyOf(nextTarget)
      setOpen(true)
      setTarget(nextTarget)
      setTargetKey(nextKey)
      targetKeyRef.current = nextKey
      setSnapshot(undefined)
      setConfigSnapshot(undefined)
      setSelected(undefined)
      setDetails(undefined)
      setDetailsError(undefined)
      setTargetError(undefined)
      setNotice(undefined)
      setBusy(undefined)
      setTab('servers')
      lastRuntime.current = undefined
      if (seed) setSeedIntent(seed)
      else setSeedIntent(undefined)
    },
    [currentTarget],
  )

  useEffect(() => {
    if (intent?.kind !== 'mcp') return
    const mode = intent.payload?.mode
    openPanel({
      id: intent.id,
      ...(mode ? { mode } : {}),
      ...(intent.payload?.server ? { server: intent.payload.server } : {}),
    })
    clearPiIntent(intent.id)
  }, [intent, openPanel])

  // 打开时只读一次配置；target 快照随后按需轮询。关闭/换目标使在途结果失效。
  useEffect(() => {
    if (!open || !target || !targetKey) return
    targetKeyRef.current = targetKey
    setMcpAuthPanelOpen(true)
    return () => {
      panelGeneration.current += 1
      targetGeneration.current += 1
      configGeneration.current += 1
      saveGeneration.current += 1
      manageGeneration.current += 1
      detailsGeneration.current += 1
      if (targetKeyRef.current === targetKey) targetKeyRef.current = undefined
      setMcpAuthPanelOpen(false)
    }
  }, [open, target, targetKey])

  // 原文可能含凭据；只有用户进入配置视图才请求，服务器与认证视图不读取。
  useEffect(() => {
    if (open && target && targetKey && tab === 'config' && !readyConfig) void fetchConfig()
  }, [open, target, targetKey, tab, readyConfig, fetchConfig])

  // target 轮询只在面板打开时运行；无 SSE，串行等待上一次响应。
  useEffect(() => {
    if (!open || !target) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      await fetchTarget()
      if (!cancelled) timer = setTimeout(() => void run(), 1_500)
    }
    void run()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, target, fetchTarget])

  // 目标切到未信任项目时避免停留于不可编辑的项目作用域。
  useEffect(() => {
    if (readyConfig && !readyConfig.projectTrusted && scope === 'project') setScope('user')
  }, [readyConfig, scope])

  const updateDraft = (content: string) => {
    if (!targetKey) return
    const key = mcpDraftKey(targetKey, scope)
    setDrafts((current) => {
      const existing = current[key]
      if (!existing) return current
      return { ...current, [key]: { ...existing, content, issues: [] } }
    })
  }

  const resetDraft = () => {
    if (!draft) return
    updateDraft(draft.baseContent)
    // updateDraft 会清空 issues；这里恢复基线时也清除宿主问题。
    if (targetKey) {
      const key = mcpDraftKey(targetKey, scope)
      setDrafts((current) => {
        const existing = current[key]
        if (!existing) return current
        return { ...current, [key]: { ...existing, issues: [] } }
      })
    }
    setNotice(undefined)
  }

  const saveConfig = async () => {
    if (!draft || !target || !targetKey || busy) return
    const version = ++saveGeneration.current
    setBusy('save')
    setNotice(undefined)
    try {
      const result = await harnessHttpClient.saveMcpConfig({
        target,
        scope,
        content: draft.content,
        expectedRevision: draft.revision,
      })
      if (version !== saveGeneration.current) return
      if (result.status === 'saved') {
        setConfigSnapshot(result.snapshot)
        setDrafts((current) => ({
          ...current,
          [mcpDraftKey(targetKey, scope)]: {
            content: draft.content,
            baseContent: draft.content,
            revision: result.revision,
            issues: [],
          },
        }))
        setNotice(`${result.apply.message}（保存不会自动连接或应用；请点“应用 MCP 资源重载”。）`)
        return
      }
      if (result.status === 'invalid') {
        setDrafts((current) => {
          const key = mcpDraftKey(targetKey, scope)
          const existing = current[key]
          if (!existing) return current
          return { ...current, [key]: { ...existing, issues: result.issues } }
        })
        setNotice(result.message)
        return
      }
      setNotice(result.message)
    } catch (error) {
      if (version === saveGeneration.current) setNotice(configFailure(error))
    } finally {
      if (version === saveGeneration.current) setBusy(undefined)
    }
  }

  const reload = async () => {
    if (!target || busy) return
    const version = ++saveGeneration.current
    setBusy('reload')
    setNotice(undefined)
    try {
      const result = await harnessHttpClient.reloadResources({ ...target, trigger: 'api' })
      if (version !== saveGeneration.current) return
      if (result.status !== 'reloaded') {
        setNotice(result.message)
        await fetchTarget()
        return
      }
      if (result.kind === 'workspace') bumpResourceVersion()
      await fetchTarget()
      setNotice(
        `已应用资源重载（资源版本 ${result.resourceRevision}）；${
          result.kind === 'session'
            ? '当前会话已使用新的 MCP 配置。'
            : '该起始目录的待消费装配已刷新；不会创建会话。'
        }`,
      )
    } catch (error) {
      if (version === saveGeneration.current) setNotice(configFailure(error))
    } finally {
      if (version === saveGeneration.current) setBusy(undefined)
    }
  }

  const loadDetails = useCallback(
    async (serverName: string, runtimeIdOverride?: string, toolsOnly = false) => {
      if (!target) return
      const expectedRuntimeId = runtimeIdOverride ?? runtimeId
      if (!expectedRuntimeId) {
        setDetailsError('连接建立后才能读取工具与资源目录。')
        return
      }
      const generation = ++detailsGeneration.current
      setDetailsBusy(true)
      setDetailsError(undefined)
      try {
        const server = liveSnapshot?.servers.find((item) => item.name === serverName)
        const include =
          !toolsOnly && server?.enabled && server.hasResources && server.exposure !== 'hidden'
            ? (['tools', 'resources', 'resource-templates'] as const)
            : (['tools'] as const)
        const result = await harnessHttpClient.getMcpDetails({
          target,
          expectedRuntimeId,
          server: serverName,
          include,
        })
        if (generation !== detailsGeneration.current) return
        if (result.status === 'ok') {
          setDetails(result.details)
          setSelected(serverName)
          return
        }
        setDetails(undefined)
        setDetailsError(result.message)
        if (result.status === 'stale' || result.status === 'busy') void fetchTarget()
      } catch {
        if (generation === detailsGeneration.current) {
          setDetailsError('读取工具与资源目录失败；未显示服务器原始错误。')
        }
      } finally {
        if (generation === detailsGeneration.current) setDetailsBusy(false)
      }
    },
    [target, runtimeId, fetchTarget, liveSnapshot],
  )

  const manage = useCallback(
    async (row: ServerRow, action: HarnessMcpManageAction) => {
      if (!target || !row.live || !runtimeId || busy) return
      const version = ++manageGeneration.current
      setBusy(`manage:${row.name}`)
      setNotice(undefined)
      try {
        const result = await harnessHttpClient.manageMcp({
          target,
          expectedRuntimeId: runtimeId,
          server: row.name,
          expectedIdentity: row.identity,
          action,
        })
        if (version !== manageGeneration.current) return
        if (result.status === 'applied') {
          applyLiveSnapshot(result.snapshot)
          setNotice(`已在本会话临时应用 ${row.name} 的管理操作；未写入配置文件。`)
          if (selected === row.name) {
            await loadDetails(row.name, result.snapshot.runtime?.runtimeId, true)
          }
          return
        }
        setNotice(result.message)
        // busy/stale 不自动重试原写操作；只刷新权威快照，保留配置草稿。
        await fetchTarget()
      } catch {
        if (version === manageGeneration.current) {
          setNotice('MCP 管理操作失败；请检查宿主连接后重试。')
        }
      } finally {
        if (version === manageGeneration.current) setBusy(undefined)
      }
    },
    [target, runtimeId, busy, selected, loadDetails, fetchTarget, applyLiveSnapshot],
  )

  const runAuthAction = useCallback(
    async (kind: 'login' | 'logout', row: ServerRow) => {
      if (!target || !row.live || !runtimeId || busy) return
      const keyAtStart = targetKeyRef.current
      const generation = panelGeneration.current
      const isCurrent = () =>
        targetKeyRef.current === keyAtStart && generation === panelGeneration.current
      setBusy(kind)
      setNotice(undefined)
      try {
        const input = {
          target,
          expectedRuntimeId: runtimeId,
          server: row.name,
          expectedIdentity: row.identity,
        }
        const result =
          kind === 'login'
            ? await harnessHttpClient.startMcpLogin(input)
            : await harnessHttpClient.logoutMcp(input)
        if (!isCurrent()) {
          // 面板已关闭/换目标：旧结果不附着新视图，但认证快照是全局的，仍刷新。
          await refreshMcpAuthSnapshot()
          return
        }
        if (result.status === 'started') {
          setTab('auth')
          setNotice(
            kind === 'login'
              ? '已开始 MCP 登录；关闭面板不会取消认证。'
              : '已开始 MCP 退出登录流程。',
          )
        } else if (result.status === 'busy') {
          setNotice(result.message ?? 'MCP 认证操作正忙；请等待当前操作结束。')
        } else if (result.status === 'stale') {
          setNotice(result.message)
          await fetchTarget()
        } else {
          setNotice(result.message)
        }
        await refreshMcpAuthSnapshot()
      } catch {
        if (isCurrent()) setNotice('启动 MCP 认证操作失败；请检查宿主连接后重试。')
      } finally {
        if (isCurrent()) setBusy(undefined)
      }
    },
    [target, runtimeId, busy, fetchTarget],
  )

  // 命令意图在快照就绪后只执行一次；未知服务器只给受控提示，不发模型请求。
  useEffect(() => {
    if (!open || !seedIntent || !liveSnapshot || !targetKey) return
    if (handledIntent.current === seedIntent.id) return
    handledIntent.current = seedIntent.id
    const { mode, server } = seedIntent
    setSeedIntent(undefined)
    if (!server) {
      if (mode) setNotice('请选择要操作的 MCP 服务器。')
      return
    }
    const row = rows.find((item) => item.name === server)
    if (!row) {
      setNotice(`未知 MCP 服务器：${server}。该名称不会发送给模型。`)
      return
    }
    setSelected(row.name)
    if (!row.live) {
      setNotice(`服务器 ${server} 尚未连接；请先应用资源重载。`)
      return
    }
    if (mode === 'login') void runAuthAction('login', row)
    else if (mode === 'logout') void runAuthAction('logout', row)
    else if (mode === 'reconnect') void manage(row, { type: 'reconnect' })
    else void loadDetails(row.name)
  }, [open, seedIntent, liveSnapshot, targetKey, rows, loadDetails, runAuthAction, manage])

  const authOperations = authSnapshot?.operations ?? []
  const activeAuthCount = authOperations.filter(activeAuthOperation).length

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="MCP 服务器"
        data-slot="huan-mcp-trigger"
        onClick={() => openPanel()}
      >
        <ServerIcon aria-hidden className="size-3.5" />
        <Trans>MCP</Trans>
        {activeAuthCount > 0 && (
          <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4">
            {activeAuthCount}
          </span>
        )}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false)
        }}
      >
        <DialogContent
          data-slot="huan-mcp-dialog"
          aria-label="MCP 服务器"
          className="flex max-h-[88dvh] max-w-5xl flex-col sm:max-w-5xl"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>MCP 服务器</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                配置与 Pi 共用 `mcp.json`；保存只写磁盘，显式应用资源重载后当前会话才会连接。
                避免同时在 Pi 与 huan 编辑同一文件：revision 只能检测已发生的外部修改。
                临时启停/exposure 只影响本会话。OAuth 回填只提交给宿主内存，关闭面板不会取消登录。
              </Trans>
            </DialogDescription>
          </DialogHeader>

          {!target && (
            <p role="status" className="text-sm">
              <Trans>当前没有可用的会话或起始目录；请先选择工作区/项目。</Trans>
            </p>
          )}

          {target && (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pe-1">
              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono break-all">
                  {liveSnapshot?.target.workspacePath ??
                    readyConfig?.target.workspacePath ??
                    target.workspacePath ??
                    ''}
                </span>
                <span>
                  {target.threadId ? (
                    <Trans>当前会话固定 cwd</Trans>
                  ) : (
                    <Trans>空白页起始目录</Trans>
                  )}
                </span>
                {liveSnapshot && (
                  <span>
                    {liveSnapshot.live ? <Trans>live 会话</Trans> : <Trans>仅配置</Trans>}
                    {liveSnapshot.runtime ? ` · runtime ${liveSnapshot.runtime.revision}` : ''}
                  </span>
                )}
                {readyConfig && (
                  <span>
                    {readyConfig.projectTrusted ? (
                      <Trans>项目已信任</Trans>
                    ) : (
                      <Trans>项目未信任</Trans>
                    )}
                  </span>
                )}
              </div>

              {notice && <Notice>{notice}</Notice>}
              {targetError && (
                <p role="status" className="text-destructive text-xs">
                  {targetError}
                </p>
              )}
              {authError && (
                <p role="status" className="text-destructive text-xs">
                  {authError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label="MCP 视图" className="flex gap-1">
                  <Button
                    size="sm"
                    variant={tab === 'servers' ? 'secondary' : 'ghost'}
                    role="tab"
                    aria-selected={tab === 'servers'}
                    aria-label="MCP 服务器列表"
                    onClick={() => setTab('servers')}
                  >
                    <Trans>服务器</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant={tab === 'config' ? 'secondary' : 'ghost'}
                    role="tab"
                    aria-selected={tab === 'config'}
                    aria-label="MCP 配置"
                    onClick={() => setTab('config')}
                  >
                    <Trans>配置</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant={tab === 'auth' ? 'secondary' : 'ghost'}
                    role="tab"
                    aria-selected={tab === 'auth'}
                    aria-label="MCP 认证"
                    onClick={() => setTab('auth')}
                  >
                    <Trans>认证</Trans>
                    {activeAuthCount > 0 && (
                      <span className="bg-primary text-primary-foreground ms-1 rounded-full px-1 text-[10px]">
                        {activeAuthCount}
                      </span>
                    )}
                  </Button>
                </div>
                <div className="ms-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    aria-label="应用 MCP 资源重载"
                    disabled={busy !== undefined}
                    onClick={() => void reload()}
                  >
                    {busy === 'reload' ? (
                      <Loader2Icon aria-hidden className="animate-spin" />
                    ) : (
                      <RotateCwIcon aria-hidden />
                    )}
                    <Trans>应用资源重载</Trans>
                  </Button>
                </div>
              </div>

              {tab === 'servers' && (
                <div className="flex flex-col gap-2" data-slot="huan-mcp-servers">
                  {!liveSnapshot && (
                    <p
                      role="status"
                      className="text-muted-foreground flex items-center gap-2 text-xs"
                    >
                      <Loader2Icon aria-hidden className="size-3 animate-spin" />
                      <Trans>正在读取 MCP 服务器状态…</Trans>
                    </p>
                  )}
                  {rows.length === 0 && liveSnapshot && (
                    <p className="text-muted-foreground text-sm">
                      <Trans>当前没有 MCP 服务器配置；在“配置”中新增。</Trans>
                    </p>
                  )}
                  {rows.map((row) => (
                    <ServerRowView
                      key={row.name}
                      row={row}
                      selected={selected === row.name}
                      busy={busy !== undefined}
                      onSelect={() => {
                        setSelected(row.name)
                        detailsGeneration.current += 1
                        setDetails(undefined)
                        setDetailsError(undefined)
                        if (row.live) void loadDetails(row.name)
                      }}
                      onManage={(action) => void manage(row, action)}
                      onLogin={() => void runAuthAction('login', row)}
                      onLogout={() => void runAuthAction('logout', row)}
                    />
                  ))}
                  {detailsError && (
                    <p role="status" className="text-destructive text-xs">
                      {detailsError}
                    </p>
                  )}
                  {selectedRow?.live && details?.server.name === selectedRow.name && (
                    <ToolDetails
                      details={details}
                      busy={detailsBusy}
                      onExposure={(tool, exposure) => {
                        if (!selectedRow) return
                        void manage(selectedRow, { type: 'setToolExposure', tool, exposure })
                      }}
                      onRefresh={() => void loadDetails(selectedRow.name)}
                    />
                  )}
                </div>
              )}

              {tab === 'config' && (
                <ConfigEditor
                  key={`${targetKey ?? 'none'}:${scope}`}
                  scope={scope}
                  onScopeChange={setScope}
                  snapshot={readyConfig}
                  files={readyConfig?.files}
                  draft={draft}
                  disabled={!configReady}
                  busy={busy !== undefined}
                  dirtyScopes={dirtyScopes}
                  onContentChange={updateDraft}
                  onSave={() => void saveConfig()}
                  onReread={() => {
                    setNotice(undefined)
                    void fetchConfig({ resetScope: scope })
                  }}
                  onReset={resetDraft}
                  onNotice={setNotice}
                />
              )}

              {tab === 'auth' && (
                <div className="flex flex-col gap-2" data-slot="huan-mcp-auth">
                  {authSnapshot === undefined ? (
                    <p className="text-muted-foreground flex items-center gap-2 text-xs">
                      <Loader2Icon aria-hidden className="size-3 animate-spin" />
                      <Trans>正在读取 MCP 认证状态…</Trans>
                    </p>
                  ) : authOperations.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      <Trans>当前没有 MCP 认证操作；可在服务器行内登录或退出 OAuth。</Trans>
                    </p>
                  ) : (
                    authOperations.map((operation) => (
                      <AuthOperationCard
                        key={operation.id}
                        operation={operation}
                        onNotice={setNotice}
                      />
                    ))
                  )}
                  <p className="text-muted-foreground text-xs">
                    <Trans>
                      认证操作由宿主统一管理，可跨窗口接管；关闭面板不会取消，回填值不会进入快照或日志。
                    </Trans>
                  </p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false)
              }}
            >
              <Trans>关闭</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 配置保存/读取错误的受控文案；不回显服务端原始异常或响应正文。 */
function configFailure(error: unknown): string {
  if (error instanceof HarnessHttpError) {
    switch (error.code) {
      case 'mcp-config-conflict':
        return '保存冲突：MCP 配置已在其他窗口或进程被修改。草稿已保留，请先“重新读取”再合并。'
      case 'mcp-config-untrusted':
        return '项目未信任，不能读取或写入项目 MCP 配置。'
      case 'mcp-config-too-large':
        return 'MCP 配置超过大小上限，未保存；草稿已保留。'
      case 'mcp-config-write-failed':
        return '写入 MCP 配置失败；列出的草稿未丢失。'
      default:
        return 'MCP 配置操作失败；请检查宿主连接后重试。'
    }
  }
  return 'MCP 配置操作失败；请检查宿主连接后重试。'
}
