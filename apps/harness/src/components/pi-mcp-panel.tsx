/**
 * MCP 管理面板：服务器运行态、共享配置原文/常用表单与 OAuth 认证。
 *
 * 业务状态（target/panelEpoch、配置草稿、dirty/revision、运行详情、短期回填）
 * 全部在 mcp feature Zustand；本组件只选择状态并触发动作。配置文件与 Pi 共用
 * `mcp.json`：保存只写磁盘，必须显式应用资源重载；常见表单只改同一份 JSON 原文。
 */

import type {
  HarnessMcpAuthOperation,
  HarnessMcpConfigFile,
  HarnessMcpConfigIssue,
  HarnessMcpDetails,
  HarnessMcpExposure,
  HarnessMcpManageAction,
} from '@huan/protocol'
import { useServiceStore } from '@huan/react'
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
import { type ReactNode, useEffect, useMemo } from 'react'
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
import { useMcpStore } from '@/state/app-context'
import {
  listDraftServers,
  MCP_EXPOSURES,
  type McpConfigScope,
  type McpServerForm,
  mcpDraftKey,
  parseMcpDraft,
  serverKindOf,
} from '@/state/mcp-config'
import {
  type McpServerRow,
  type McpTab,
  mcpAuthPhaseLabel,
  selectMcpServerRows,
} from '@/state/mcp-store'

const UNSET = '__unset__'
const INHERIT = '__inherit__'
const exposureItems = Object.fromEntries(MCP_EXPOSURES.map((value) => [value, value])) as Record<
  string,
  string
>
const exposureWithUnsetItems = { [UNSET]: '未设置（默认）', ...exposureItems }
const enabledItems = { [UNSET]: '未设置（默认）', true: '启用', false: '停用' }

const stateLabel = (state: McpServerRow['state']): string => {
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

const authKindLabel = (kind: NonNullable<McpServerRow['auth']>['kind']): string => {
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

const scopeLabel = (scope: 'user' | 'project' | 'extension'): string => {
  if (scope === 'user') return '用户'
  if (scope === 'project') return '项目'
  return '扩展临时'
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

function Notice({ children }: { children: ReactNode }) {
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
        if (next === INHERIT || next === UNSET) onValueChange(null)
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
  row: McpServerRow
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
  details: HarnessMcpDetails
  busy: boolean
  onExposure: (tool: string, exposure: HarnessMcpExposure | null) => void
  onRefresh: () => void
}) {
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

function AuthOperationCard({ operation }: { operation: HarnessMcpAuthOperation }) {
  const answers = useMcpStore((state) => state.answers)
  const submitting = useMcpStore((state) => state.submitting)
  const cancelling = useMcpStore((state) => state.cancelling[operation.id] === true)
  const setAnswer = useMcpStore((state) => state.setAnswer)
  const submitPrompt = useMcpStore((state) => state.submitPrompt)
  const cancelAuth = useMcpStore((state) => state.cancelAuth)

  const prompt = operation.prompt
  const promptKey = prompt ? `${operation.id}|${prompt.promptId}` : undefined
  const answer = promptKey ? (answers[promptKey] ?? '') : ''
  const promptBusy = promptKey !== undefined && submitting === promptKey
  const result = operation.result
  const canCancel = activeAuthOperation(operation) && operation.phase !== 'cancelling'

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
          {mcpAuthPhaseLabel(operation.phase)}
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

      {prompt && operation.phase === 'prompt' && (
        <form
          className="flex flex-col gap-2"
          data-slot="huan-mcp-auth-prompt"
          onSubmit={(event) => {
            event.preventDefault()
            void submitPrompt(operation, prompt)
          }}
        >
          <div className="flex flex-col gap-1 text-xs">
            <span>{prompt.message || '回填授权回调 URL'}</span>
            <Input
              aria-label="授权回调 URL"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={8_192}
              value={answer}
              placeholder={prompt.placeholder}
              disabled={promptBusy}
              onChange={(event) => setAnswer(operation.id, prompt.promptId, event.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" aria-label="提交回填" disabled={promptBusy}>
              {promptBusy && <Loader2Icon aria-hidden className="animate-spin" />}
              <Trans>提交回填</Trans>
            </Button>
          </div>
        </form>
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
            onClick={() => void cancelAuth(operation.id)}
          >
            {cancelling && <Loader2Icon aria-hidden className="animate-spin" />}
            <Trans>取消认证</Trans>
          </Button>
        </div>
      )}
    </section>
  )
}

function ServerFormFields({
  editor,
  onChange,
  onCancel,
  onSubmit,
  busy,
  localError,
}: {
  editor: { originalName?: string; form: McpServerForm }
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

function DirtyBadge() {
  return (
    <span className="bg-muted ms-1 rounded px-1 text-xs">
      <Trans>未保存</Trans>
    </span>
  )
}

function ConfigEditor() {
  const targetKey = useMcpStore((state) => state.targetKey)
  const scope = useMcpStore((state) => state.scope)
  const setScope = useMcpStore((state) => state.setScope)
  const configView = useMcpStore((state) => state.configView)
  const setConfigView = useMcpStore((state) => state.setConfigView)
  const snapshot = useMcpStore((state) => state.configSnapshot)
  const drafts = useMcpStore((state) => state.drafts)
  const configLoading = useMcpStore((state) => state.configLoading)
  const busy = useMcpStore((state) => state.busy)
  const editor = useMcpStore((state) => state.editor)
  const editorError = useMcpStore((state) => state.editorError)
  const deleteName = useMcpStore((state) => state.deleteName)
  const rereadConfirm = useMcpStore((state) => state.rereadConfirm)
  const updateDraft = useMcpStore((state) => state.updateDraft)
  const saveConfig = useMcpStore((state) => state.saveConfig)
  const requestReread = useMcpStore((state) => state.requestReread)
  const resetDraft = useMcpStore((state) => state.resetDraft)
  const openAddServer = useMcpStore((state) => state.openAddServer)
  const openEditServer = useMcpStore((state) => state.openEditServer)
  const updateServerForm = useMcpStore((state) => state.updateServerForm)
  const cancelServerEditor = useMcpStore((state) => state.cancelServerEditor)
  const applyServerEditor = useMcpStore((state) => state.applyServerEditor)
  const requestDeleteServer = useMcpStore((state) => state.requestDeleteServer)
  const cancelDeleteServer = useMcpStore((state) => state.cancelDeleteServer)
  const confirmDeleteServer = useMcpStore((state) => state.confirmDeleteServer)

  const draft = targetKey ? drafts[mcpDraftKey(targetKey, scope)] : undefined
  const dirty = draft ? draft.content !== draft.baseContent : false
  const dirtyScopes = useMemo(() => {
    const dirtyOf = (nextScope: McpConfigScope): boolean => {
      if (!targetKey) return false
      const next = drafts[mcpDraftKey(targetKey, nextScope)]
      return next !== undefined && next.content !== next.baseContent
    }
    return { user: dirtyOf('user'), project: dirtyOf('project') }
  }, [drafts, targetKey])
  const parsed = useMemo(() => (draft ? parseMcpDraft(draft.content) : undefined), [draft])
  const root = parsed?.value
  const servers = useMemo(() => (root ? listDraftServers(root, scope) : []), [root, scope])
  const file = snapshot?.files[scope]
  const scopeBlocked = scope === 'project' && snapshot !== undefined && !snapshot.projectTrusted
  const canEdit = !configLoading && !scopeBlocked && draft !== undefined && busy === undefined

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
            onClick={() => setScope('user')}
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
            onClick={() => setScope('project')}
          >
            <Trans>项目</Trans>
            {dirtyScopes.project && <DirtyBadge />}
          </Button>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label={rereadConfirm ? '确认重新读取 MCP 配置' : '重新读取 MCP 配置'}
            disabled={busy !== undefined || !snapshot}
            onClick={() => void requestReread()}
          >
            <RefreshCwIcon aria-hidden />
            {rereadConfirm ? <Trans>确认重新读取</Trans> : <Trans>重新读取</Trans>}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="重置 MCP 草稿"
            disabled={!dirty || busy !== undefined}
            onClick={resetDraft}
          >
            <Trans>重置改动</Trans>
          </Button>
          <Button
            size="sm"
            aria-label="保存 MCP 配置"
            disabled={
              !dirty || busy !== undefined || !draft || !file || file.tooLarge || !!file.readError
            }
            onClick={() => void saveConfig()}
          >
            {busy === 'save' && <Loader2Icon aria-hidden className="animate-spin" />}
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

      <p className="text-muted-foreground text-xs">
        {scope === 'user' ? (
          <Trans>
            用户配置位于当前 agentDir 的 mcp.json，与 Pi 及其他项目共用；保存会影响所有使用该
            agentDir 的会话。这里只能检测已发生的外部修改，避免同时在 Pi 与 huan 编辑同一文件。
          </Trans>
        ) : (
          <Trans>
            项目配置只对该项目生效；项目 override 只写 enabled、exposure、toolExposure，且需要
            与用户服务器同名。扩展临时注册不会写入任何配置文件。
          </Trans>
        )}
      </p>

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
          variant={configView === 'common' ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={configView === 'common'}
          aria-label="MCP 常用编辑"
          onClick={() => setConfigView('common')}
        >
          <Trans>常用编辑</Trans>
        </Button>
        <Button
          size="sm"
          variant={configView === 'json' ? 'secondary' : 'ghost'}
          role="tab"
          aria-selected={configView === 'json'}
          aria-label="MCP JSON 原文"
          onClick={() => setConfigView('json')}
        >
          <Trans>JSON 原文</Trans>
        </Button>
      </div>

      {configLoading && !draft && (
        <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2Icon aria-hidden className="size-3 animate-spin" />
          <Trans>正在读取 MCP 配置原文…</Trans>
        </p>
      )}
      {!configLoading && !draft && (
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
          {configView === 'json' ? (
            <div className="flex flex-col gap-1">
              <Textarea
                aria-label="MCP 配置 JSON"
                className="min-h-72 font-mono text-xs"
                spellCheck={false}
                value={draft.content}
                disabled={!canEdit}
                onChange={(event) => updateDraft(event.target.value)}
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
                  onClick={() => openAddServer('stdio')}
                >
                  <Trans>新增 stdio</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="新增 HTTP 服务器"
                  disabled={!canEdit || !root}
                  onClick={() => openAddServer('http')}
                >
                  <Trans>新增 HTTP</Trans>
                </Button>
                {scope === 'project' && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="新增项目 override"
                    disabled={!canEdit || !root}
                    onClick={() => openAddServer('override')}
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
                        onClick={() => openEditServer(server.name)}
                      >
                        <Trans>修改</Trans>
                      </Button>
                      {deleteName === server.name ? (
                        <>
                          <Button
                            variant="destructive"
                            size="xs"
                            aria-label={`确认删除 ${server.name}`}
                            disabled={!canEdit}
                            onClick={confirmDeleteServer}
                          >
                            <Trash2Icon aria-hidden />
                            <Trans>确认删除</Trans>
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`取消删除 ${server.name}`}
                            disabled={!canEdit}
                            onClick={cancelDeleteServer}
                          >
                            <Trans>取消</Trans>
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-label={`删除 ${server.name}`}
                          disabled={!canEdit}
                          onClick={() => requestDeleteServer(server.name)}
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
                  onChange={updateServerForm}
                  onCancel={cancelServerEditor}
                  onSubmit={applyServerEditor}
                  busy={!canEdit}
                  localError={editorError}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const tabButton = (tab: McpTab, active: McpTab): boolean => tab === active

export function McpDialog() {
  const open = useMcpStore((state) => state.open)
  const target = useMcpStore((state) => state.target)
  const tab = useMcpStore((state) => state.tab)
  const snapshot = useMcpStore((state) => state.snapshot)
  const configSnapshot = useMcpStore((state) => state.configSnapshot)
  const notice = useMcpStore((state) => state.notice)
  const error = useMcpStore((state) => state.error)
  const targetError = useMcpStore((state) => state.targetError)
  const targetLoading = useMcpStore((state) => state.targetLoading)
  const busy = useMcpStore((state) => state.busy)
  const selected = useMcpStore((state) => state.selected)
  const details = useMcpStore((state) => state.details)
  const detailsError = useMcpStore((state) => state.detailsError)
  const detailsLoading = useMcpStore((state) => state.detailsLoading)
  const openPanel = useMcpStore((state) => state.openPanel)
  const close = useMcpStore((state) => state.close)
  const setTab = useMcpStore((state) => state.setTab)
  const refreshLive = useMcpStore((state) => state.refreshLive)
  const applyReload = useMcpStore((state) => state.applyReload)
  const selectServer = useMcpStore((state) => state.selectServer)
  const loadDetails = useMcpStore((state) => state.loadDetails)
  const manage = useMcpStore((state) => state.manage)
  const startAuth = useMcpStore((state) => state.startAuth)
  const mcpAuth = useServiceStore((state) => state.mcpAuth)
  const mcpAuthError = useServiceStore((state) => state.mcpAuthError)

  useEffect(() => {
    if (!open || !target) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      timer = setTimeout(() => {
        void (async () => {
          await refreshLive()
          if (!cancelled) schedule()
        })()
      }, 1_500)
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, target, refreshLive])

  const rows = useMemo(
    () =>
      selectMcpServerRows({
        snapshot,
        configSnapshot,
      }),
    [snapshot, configSnapshot],
  )
  const selectedRow = rows.find((row) => row.name === selected)
  const authOperations = mcpAuth?.operations ?? []
  const activeAuthCount = authOperations.filter(activeAuthOperation).length
  const workspacePath =
    snapshot?.target.workspacePath ??
    configSnapshot?.target.workspacePath ??
    target?.workspacePath ??
    ''
  const live = snapshot?.live === true && snapshot.runtime !== undefined && !snapshot.runtime.closed

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="MCP 服务器"
        data-slot="huan-mcp-trigger"
        onClick={() => void openPanel()}
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
          if (!next) close()
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
                <span className="font-mono break-all">{workspacePath}</span>
                <span>
                  {target.threadId ? (
                    <Trans>当前会话固定 cwd</Trans>
                  ) : (
                    <Trans>空白页起始目录</Trans>
                  )}
                </span>
                {snapshot && (
                  <span>
                    {live ? <Trans>live 会话</Trans> : <Trans>仅配置</Trans>}
                    {snapshot.runtime ? ` · runtime ${snapshot.runtime.revision}` : ''}
                  </span>
                )}
                {configSnapshot && (
                  <span>
                    {configSnapshot.projectTrusted ? (
                      <Trans>项目已信任</Trans>
                    ) : (
                      <Trans>项目未信任</Trans>
                    )}
                  </span>
                )}
              </div>

              {notice && <Notice>{notice}</Notice>}
              {error && (
                <p role="status" className="text-destructive text-xs">
                  {error}
                </p>
              )}
              {targetError && (
                <p role="status" className="text-destructive text-xs">
                  {targetError}
                </p>
              )}
              {mcpAuthError && (
                <p role="status" className="text-destructive text-xs">
                  {mcpAuthError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label="MCP 视图" className="flex gap-1">
                  <Button
                    size="sm"
                    variant={tabButton('servers', tab) ? 'secondary' : 'ghost'}
                    role="tab"
                    aria-selected={tab === 'servers'}
                    aria-label="MCP 服务器列表"
                    onClick={() => void setTab('servers')}
                  >
                    <Trans>服务器</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant={tabButton('config', tab) ? 'secondary' : 'ghost'}
                    role="tab"
                    aria-selected={tab === 'config'}
                    aria-label="MCP 配置"
                    onClick={() => void setTab('config')}
                  >
                    <Trans>配置</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant={tabButton('auth', tab) ? 'secondary' : 'ghost'}
                    role="tab"
                    aria-selected={tab === 'auth'}
                    aria-label="MCP 认证"
                    onClick={() => void setTab('auth')}
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
                    onClick={() => void applyReload()}
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
                  {targetLoading && !snapshot && (
                    <p
                      role="status"
                      className="text-muted-foreground flex items-center gap-2 text-xs"
                    >
                      <Loader2Icon aria-hidden className="size-3 animate-spin" />
                      <Trans>正在读取 MCP 服务器状态…</Trans>
                    </p>
                  )}
                  {rows.length === 0 && snapshot && (
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
                      onSelect={() => void selectServer(row.name)}
                      onManage={(action) => void manage(row, action)}
                      onLogin={() => void startAuth('login', row)}
                      onLogout={() => void startAuth('logout', row)}
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
                      busy={detailsLoading}
                      onExposure={(tool, exposure) => {
                        if (!selectedRow) return
                        void manage(selectedRow, { type: 'setToolExposure', tool, exposure })
                      }}
                      onRefresh={() => void loadDetails(selectedRow.name)}
                    />
                  )}
                </div>
              )}

              {tab === 'config' && <ConfigEditor />}

              {tab === 'auth' && (
                <div className="flex flex-col gap-2" data-slot="huan-mcp-auth">
                  {mcpAuth === undefined ? (
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
                      <AuthOperationCard key={operation.id} operation={operation} />
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
            <Button variant="ghost" onClick={close}>
              <Trans>关闭</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
