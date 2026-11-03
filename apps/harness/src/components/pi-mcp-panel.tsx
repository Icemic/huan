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
import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  ExternalLinkIcon,
  Loader2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useId, useMemo } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useMcpStore, useSettingsUiStore } from '@/state/app-context'
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
  isGlobalMcpTarget,
  type McpConfigView,
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

const stateBadgeVariant = (
  state: McpServerRow['state'],
): 'secondary' | 'destructive' | 'outline' => {
  if (state === 'connected') return 'secondary'
  if (state === 'failed' || state === 'needs-auth') return 'destructive'
  return 'outline'
}

const activeAuthOperation = (operation: HarnessMcpAuthOperation): boolean =>
  operation.phase !== 'succeeded' && operation.phase !== 'failed' && operation.phase !== 'cancelled'

function Notice({ children }: { children: ReactNode }) {
  return (
    <Alert role="status" data-slot="huan-mcp-notice">
      <AlertDescription className="text-xs whitespace-pre-wrap">{children}</AlertDescription>
    </Alert>
  )
}

function IssueList({ issues }: { issues: readonly HarnessMcpConfigIssue[] }) {
  if (issues.length === 0) return null
  return (
    <Alert variant="destructive" data-slot="huan-mcp-issues">
      <AlertDescription>
        <ul className="list-disc ps-4 text-xs">
          {issues.map((issue) => (
            <li
              key={`${issue.kind}:${issue.scope}:${issue.file}:${issue.server ?? ''}:${issue.message}`}
            >
              <span className="font-mono">{issue.server ?? issue.kind}</span> {issue.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

function FileSummary({ file }: { file: HarnessMcpConfigFile }) {
  return (
    <Item data-slot="huan-mcp-file" className="flex-col items-stretch">
      <ItemHeader>
        <ItemTitle>
          {file.scope === 'user' ? <Trans>用户配置</Trans> : <Trans>项目配置</Trans>}
        </ItemTitle>
        <Badge variant={file.exists ? 'secondary' : 'outline'}>
          {file.exists ? (
            <Trans>已存在</Trans>
          ) : file.readable ? (
            <Trans>尚未创建（保存时写入）</Trans>
          ) : (
            <Trans>未读取（项目未信任）</Trans>
          )}
        </Badge>
      </ItemHeader>
      <ItemDescription className="font-mono break-all">{file.path}</ItemDescription>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{file.bytes} B</Badge>
        {file.tooLarge && (
          <Badge variant="destructive">
            <Trans>超过读取上限</Trans>
          </Badge>
        )}
      </div>
      <details className="text-xs" data-slot="huan-mcp-config-diagnostics">
        <summary className="text-muted-foreground cursor-pointer">
          <Trans>诊断详情</Trans>
        </summary>
        <span className="text-muted-foreground font-mono">
          <Trans>配置版本</Trans> {file.revision ? file.revision.slice(0, 12) : 'null'}
        </span>
      </details>
      {file.readError && (
        <Alert variant="destructive">
          <AlertDescription>{file.readError}</AlertDescription>
        </Alert>
      )}
      {file.issues.length > 0 && <IssueList issues={file.issues} />}
    </Item>
  )
}

function ExposureSelect({
  value,
  onValueChange,
  label,
  disabled,
  allowUnset = false,
  allowInherit = false,
  triggerId,
}: {
  value: HarnessMcpExposure | undefined
  onValueChange: (value: HarnessMcpExposure | null) => void
  label: string
  disabled: boolean
  allowUnset?: boolean
  allowInherit?: boolean
  triggerId?: string
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
      <SelectTrigger id={triggerId} size="sm" aria-label={label} className="w-36">
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
    <Item
      data-slot="huan-mcp-server"
      data-server-name={row.name}
      data-state={row.state}
      data-live={row.live ? 'true' : 'false'}
      variant={selected ? 'outline' : 'default'}
      className={selected ? 'border-ring ring-3 ring-ring/50' : undefined}
    >
      <ItemContent>
        <ItemTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5 font-semibold"
            aria-label={`查看 ${row.name} 详情`}
            onClick={onSelect}
          >
            {row.name}
          </Button>
          <Badge variant={stateBadgeVariant(row.state)} data-slot="huan-mcp-server-state">
            {stateLabel(row.state)}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          <span className="font-mono break-all">{row.identity}</span>
          <span>
            {' · '}
            {scopeLabel(row.scope)}
            {row.override ? ' · 项目覆盖' : ''}
          </span>
          {row.configPending && (
            <Badge variant="outline" data-slot="huan-mcp-config-pending" className="ms-1">
              <Trans>配置未应用</Trans>
            </Badge>
          )}
          {row.auth && (
            <span>
              {' · '}
              {authKindLabel(row.auth.kind)}
              {row.auth.hasCredentials ? ' · 已存凭据' : ''}
              {row.auth.needsRefresh ? ' · 待刷新' : ''}
            </span>
          )}
          {!row.live && (
            <span>
              {' · '}
              <Trans>应用配置后连接</Trans>
            </span>
          )}
          {row.scope === 'extension' && (
            <span>
              {' · '}
              <Trans>扩展临时注册不写入配置文件。</Trans>
            </span>
          )}
        </ItemDescription>
      </ItemContent>
      <span className="text-muted-foreground text-xs">
        {row.toolCount} 工具 · {row.hasResources ? '有资源' : '无资源'} · {row.exposure}
      </span>

      <ItemFooter className="justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          <Trans>本会话临时</Trans>
        </span>
        <ItemActions className="flex-wrap justify-end">
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
        </ItemActions>
      </ItemFooter>
      {row.error && (
        <Alert variant="destructive" data-slot="huan-mcp-server-error" className="basis-full">
          <AlertDescription>{row.error.message}</AlertDescription>
        </Alert>
      )}
      {!manageable && row.live && (
        <ItemDescription className="basis-full">
          <Trans>该服务器没有可交互认证信息。</Trans>
        </ItemDescription>
      )}
    </Item>
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
    <Item variant="outline" data-slot="huan-mcp-details" className="flex-col items-stretch">
      <ItemHeader>
        <ItemTitle>
          {details.server.name}
          <Badge variant={stateBadgeVariant(details.server.state)}>
            {stateLabel(details.server.state)}
          </Badge>
        </ItemTitle>
        <ItemActions>
          <Button
            variant="outline"
            size="xs"
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
        </ItemActions>
      </ItemHeader>
      <details className="text-xs" data-slot="huan-mcp-tool-diagnostics">
        <summary className="text-muted-foreground cursor-pointer">
          <Trans>诊断详情</Trans>
        </summary>
        <span className="text-muted-foreground font-mono">
          <Trans>工具版本</Trans> {details.server.toolRevision}
        </span>
      </details>
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
          <ItemGroup className="gap-0">
            {details.tools?.map((tool, index) => (
              <Fragment key={tool.name}>
                {index > 0 && <ItemSeparator />}
                <Item
                  size="xs"
                  data-slot="huan-mcp-tool"
                  data-tool-name={tool.name}
                  className="flex-col items-stretch"
                >
                  <ItemHeader>
                    <ItemContent>
                      <ItemTitle>
                        <span className="font-mono">{tool.name}</span>
                        {tool.title && (
                          <span className="text-muted-foreground font-normal">{tool.title}</span>
                        )}
                      </ItemTitle>
                      {tool.description && (
                        <ItemDescription className="text-xs">{tool.description}</ItemDescription>
                      )}
                    </ItemContent>
                    <ItemActions>
                      <ExposureSelect
                        value={tool.exposure}
                        onValueChange={(exposure) => onExposure(tool.name, exposure)}
                        label={`工具 ${tool.name} exposure`}
                        disabled={busy}
                        allowInherit
                      />
                    </ItemActions>
                  </ItemHeader>
                  {tool.annotations && (
                    <ItemDescription className="font-mono text-xs">
                      {[
                        tool.annotations.readOnlyHint ? 'readOnly' : undefined,
                        tool.annotations.destructiveHint ? 'destructive' : undefined,
                        tool.annotations.idempotentHint ? 'idempotent' : undefined,
                        tool.annotations.openWorldHint ? 'openWorld' : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '无注解标记'}
                    </ItemDescription>
                  )}
                  <details>
                    <summary className="text-muted-foreground cursor-pointer">inputSchema</summary>
                    <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                      {JSON.stringify(tool.inputSchema, null, 2)}
                    </pre>
                  </details>
                  {tool.outputSchema && (
                    <details>
                      <summary className="text-muted-foreground cursor-pointer">
                        outputSchema
                      </summary>
                      <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 whitespace-pre-wrap">
                        {JSON.stringify(tool.outputSchema, null, 2)}
                      </pre>
                    </details>
                  )}
                </Item>
              </Fragment>
            ))}
          </ItemGroup>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          <Trans>资源（只列目录，不读取正文）</Trans>
        </span>
        {(details.resources ?? []).length === 0 ? (
          <p className="text-muted-foreground text-xs">（无）</p>
        ) : (
          <ItemGroup className="gap-0">
            {details.resources?.map((resource, index) => (
              <Fragment key={resource.uri}>
                {index > 0 && <ItemSeparator />}
                <Item size="xs" data-slot="huan-mcp-resource" className="flex-col items-stretch">
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs break-all">{resource.uri}</ItemTitle>
                    <ItemDescription className="text-xs">
                      {resource.name}
                      {resource.mimeType ? ` · ${resource.mimeType}` : ''}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </ItemGroup>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">
          <Trans>资源模板</Trans>
        </span>
        {(details.resourceTemplates ?? []).length === 0 ? (
          <p className="text-muted-foreground text-xs">（无）</p>
        ) : (
          <ItemGroup className="gap-0">
            {details.resourceTemplates?.map((template, index) => (
              <Fragment key={template.uriTemplate}>
                {index > 0 && <ItemSeparator />}
                <Item size="xs">
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs break-all">
                      {template.uriTemplate}
                    </ItemTitle>
                    <ItemDescription className="text-xs">{template.name}</ItemDescription>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </ItemGroup>
        )}
      </div>
    </Item>
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
  const inputId = useId()

  return (
    <Item
      data-slot="huan-mcp-auth-operation"
      data-operation-id={operation.id}
      data-phase={operation.phase}
      className="flex-col items-stretch"
    >
      <ItemHeader>
        <ItemTitle>{operation.server}</ItemTitle>
        <span className="text-muted-foreground text-xs">
          {operation.kind === 'login' ? <Trans>登录</Trans> : <Trans>退出登录</Trans>} ·{' '}
          {mcpAuthPhaseLabel(operation.phase)}
        </span>
      </ItemHeader>
      <ItemDescription className="basis-full font-mono text-xs break-all">
        {operation.target.workspacePath}
      </ItemDescription>

      {operation.authUrl && isHttpUrl(operation.authUrl) && (
        <a
          className="text-primary inline-flex w-fit basis-full items-center gap-1 text-xs underline"
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
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>
            <Trans>授权链接不是 http(s)，已拒绝显示。</Trans>
          </AlertDescription>
        </Alert>
      )}

      {prompt && operation.phase === 'prompt' && (
        <form
          className="flex basis-full flex-col gap-2"
          data-slot="huan-mcp-auth-prompt"
          onSubmit={(event) => {
            event.preventDefault()
            void submitPrompt(operation, prompt)
          }}
        >
          <Field>
            <FieldLabel htmlFor={inputId}>{prompt.message || '回填授权回调 URL'}</FieldLabel>
            <Input
              id={inputId}
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
            <div className="flex justify-end">
              <Button type="submit" size="sm" aria-label="提交回填" disabled={promptBusy}>
                {promptBusy && <Loader2Icon aria-hidden className="animate-spin" />}
                <Trans>提交回填</Trans>
              </Button>
            </div>
          </Field>
        </form>
      )}

      {result && (
        <ItemDescription
          role="status"
          data-slot="huan-mcp-auth-result"
          data-status={result.status}
          className="basis-full text-xs"
        >
          {result.message}
          {result.reconnect === 'deferred' ? '（会话正忙，未强制重连）' : ''}
        </ItemDescription>
      )}

      {canCancel && (
        <ItemFooter className="justify-end">
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
        </ItemFooter>
      )}
    </Item>
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
  const fieldId = useId()
  const id = (name: string) => `${fieldId}-${name}`
  const set = <K extends keyof McpServerForm>(key: K, value: McpServerForm[K]) =>
    onChange({ ...form, [key]: value })
  return (
    <form
      className="flex flex-col gap-3"
      data-slot="huan-mcp-server-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">
            {editor.originalName ? <Trans>修改服务器</Trans> : <Trans>新增服务器</Trans>} ·{' '}
            {form.kind === 'override' ? '项目覆盖' : form.kind}
          </h3>
        </div>
        {form.kind === 'override' && (
          <p className="text-muted-foreground text-xs">
            <Trans>
              项目覆盖只修改启用状态、服务器 exposure 与
              toolExposure，且仅对用户配置中的同名服务器生效。
            </Trans>
          </p>
        )}
      </div>
      <FieldGroup className="gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={id('name')}>服务器名称</FieldLabel>
            <Input
              id={id('name')}
              aria-label="服务器名称"
              value={form.name}
              disabled={busy}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id('enabled')}>默认 enabled</FieldLabel>
            <Select
              value={form.enabled}
              items={enabledItems}
              onValueChange={(next) => set('enabled', next as McpServerForm['enabled'])}
              disabled={busy}
            >
              <SelectTrigger id={id('enabled')} size="sm" aria-label="启用状态" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>未设置（默认）</SelectItem>
                <SelectItem value="true">启用</SelectItem>
                <SelectItem value="false">停用</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={id('exposure')}>服务器 exposure</FieldLabel>
            <ExposureSelect
              value={form.exposure === 'unset' ? undefined : form.exposure}
              onValueChange={(exposure) => set('exposure', exposure ?? 'unset')}
              label="服务器 exposure"
              disabled={busy}
              allowUnset
              triggerId={id('exposure')}
            />
          </Field>
        </div>

        {form.kind === 'stdio' && (
          <>
            <Field>
              <FieldLabel htmlFor={id('command')}>stdio command</FieldLabel>
              <Input
                id={id('command')}
                aria-label="stdio 命令"
                value={form.command}
                disabled={busy}
                onChange={(event) => set('command', event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={id('args')}>stdio args（每行一个）</FieldLabel>
              <Textarea
                id={id('args')}
                aria-label="stdio 参数"
                rows={3}
                className="font-mono text-xs"
                value={form.argsText}
                disabled={busy}
                onChange={(event) => set('argsText', event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={id('env')}>环境变量（NAME=value，每行一个）</FieldLabel>
              <Textarea
                id={id('env')}
                aria-label="环境变量"
                rows={3}
                className="font-mono text-xs"
                value={form.envText}
                disabled={busy}
                onChange={(event) => set('envText', event.target.value)}
              />
            </Field>
          </>
        )}

        {form.kind === 'http' && (
          <>
            <Field>
              <FieldLabel htmlFor={id('url')}>HTTP URL</FieldLabel>
              <Input
                id={id('url')}
                aria-label="HTTP URL"
                value={form.url}
                disabled={busy}
                onChange={(event) => set('url', event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={id('headers')}>Headers（NAME=value，每行一个）</FieldLabel>
              <Textarea
                id={id('headers')}
                aria-label="HTTP headers"
                rows={3}
                className="font-mono text-xs"
                value={form.headersText}
                disabled={busy}
                onChange={(event) => set('headersText', event.target.value)}
              />
            </Field>
          </>
        )}

        <Field>
          <FieldLabel htmlFor={id('tool-exposure')}>
            toolExposure（tool=exposure，每行一个；支持 *）
          </FieldLabel>
          <Textarea
            id={id('tool-exposure')}
            aria-label="工具 exposure"
            rows={3}
            className="font-mono text-xs"
            value={form.toolExposureText}
            disabled={busy}
            onChange={(event) => set('toolExposureText', event.target.value)}
          />
        </Field>

        {localError && (
          <Alert variant="destructive">
            <AlertDescription>{localError}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            <Trans>取消</Trans>
          </Button>
          <Button type="submit" size="sm" aria-label="保存服务器" disabled={busy}>
            <Trans>保存到 JSON 草稿</Trans>
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

/**
 * 单个作用域的 MCP 配置编辑器。全局页固定 user，项目页固定 project；
 * 不在这里切换作用域，避免把用户配置与项目覆盖混在同一上下文。
 */
function ConfigEditor({ scope }: { scope: McpConfigScope }) {
  const targetKey = useMcpStore((state) => state.targetKey)
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
  const parsed = useMemo(() => (draft ? parseMcpDraft(draft.content) : undefined), [draft])
  const root = parsed?.value
  const servers = useMemo(() => (root ? listDraftServers(root, scope) : []), [root, scope])
  const file = snapshot?.files[scope]
  const scopeBlocked = scope === 'project' && snapshot !== undefined && !snapshot.projectTrusted
  const canEdit = !configLoading && !scopeBlocked && draft !== undefined && busy === undefined
  const configJsonId = useId()

  return (
    <div className="flex flex-col gap-3" data-slot="huan-mcp-config" data-scope={scope}>
      <Item>
        <ItemContent>
          <ItemDescription className="text-xs" data-slot="huan-mcp-scope">
            {scope === 'user' ? (
              <Trans>与 Pi 共用，适用于所有项目</Trans>
            ) : (
              <Trans>仅用于当前项目</Trans>
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="flex-wrap">
          <Button
            size="sm"
            variant="outline"
            aria-label={rereadConfirm ? '确认重新读取文件' : '重新读取文件'}
            disabled={busy !== undefined || !snapshot}
            onClick={() => void requestReread()}
          >
            <RefreshCwIcon aria-hidden />
            {rereadConfirm ? <Trans>确认重新读取文件</Trans> : <Trans>重新读取文件</Trans>}
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
            aria-label="保存"
            disabled={
              !dirty || busy !== undefined || !draft || !file || file.tooLarge || !!file.readError
            }
            onClick={() => void saveConfig()}
          >
            {busy === 'save' && <Loader2Icon aria-hidden className="animate-spin" />}
            <Trans>保存</Trans>
          </Button>
        </ItemActions>
      </Item>

      {file && <FileSummary file={file} />}
      {scope === 'project' && snapshot && !snapshot.projectTrusted && (
        <Alert variant="destructive" role="status">
          <AlertDescription>
            <Trans>
              项目未信任：不会读取或写入项目 MCP 配置。请先在项目信任面板允许；用户配置仍可编辑。
            </Trans>
          </AlertDescription>
        </Alert>
      )}

      {snapshot && (
        <details className="text-xs" data-slot="huan-mcp-effective">
          <summary className="cursor-pointer">
            <Trans>配置预览</Trans>
          </summary>
          <ItemGroup className="mt-1 gap-0">
            {snapshot.effective.servers.map((server, index) => (
              <Fragment key={server.name}>
                {index > 0 && <ItemSeparator />}
                <Item
                  size="xs"
                  data-slot="huan-mcp-effective-server"
                  data-server-name={server.name}
                >
                  <ItemContent>
                    <ItemTitle className="font-mono">{server.name}</ItemTitle>
                    <ItemDescription className="text-xs">
                      {scopeLabel(server.scope)}
                      {server.override ? ' · 项目覆盖' : ''} · {server.enabled ? '启用' : '停用'} ·{' '}
                      {server.exposure}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </ItemGroup>
          <IssueList issues={snapshot.effective.issues} />
        </details>
      )}

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
            <Alert variant="destructive" data-slot="huan-mcp-local-error">
              <AlertDescription>{parsed.error}</AlertDescription>
            </Alert>
          )}
          <IssueList issues={draft.issues} />
          <Tabs
            value={configView}
            onValueChange={(value) => setConfigView(value as McpConfigView)}
            className="gap-3"
          >
            <TabsList variant="line" aria-label="MCP 配置视图">
              <TabsTrigger value="common" aria-label="MCP 常用编辑">
                <Trans>常用编辑</Trans>
              </TabsTrigger>
              <TabsTrigger value="json" aria-label="MCP JSON 原文">
                <Trans>JSON 原文</Trans>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="common">
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
                      aria-label="新增项目覆盖"
                      disabled={!canEdit || !root}
                      onClick={() => openAddServer('override')}
                    >
                      <Trans>新增项目覆盖</Trans>
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

                {root && (
                  <ItemGroup className="gap-0">
                    {servers.map((server, index) => (
                      <Fragment key={server.name}>
                        {index > 0 && <ItemSeparator />}
                        <Item
                          data-slot="huan-mcp-draft-server"
                          data-server-name={server.name}
                          size="sm"
                        >
                          <ItemContent>
                            <ItemTitle>
                              <span className="font-mono">{server.name}</span>
                              <span className="text-muted-foreground text-xs font-normal">
                                {server.override ? '项目覆盖' : serverKindOf(server.raw)}
                              </span>
                            </ItemTitle>
                            <ItemDescription className="text-xs">
                              {typeof server.raw.command === 'string'
                                ? server.raw.command
                                : typeof server.raw.url === 'string'
                                  ? server.raw.url
                                  : ''}
                              {' · '}
                              {server.raw.enabled === false ? '停用' : '启用'}
                              {typeof server.raw.exposure === 'string'
                                ? ` · ${server.raw.exposure}`
                                : ''}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions className="flex-wrap justify-end">
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
                          </ItemActions>
                        </Item>
                      </Fragment>
                    ))}
                  </ItemGroup>
                )}

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
            </TabsContent>
            <TabsContent value="json">
              <Field>
                <FieldLabel htmlFor={configJsonId}>MCP 配置 JSON</FieldLabel>
                <Textarea
                  id={configJsonId}
                  aria-label="MCP 配置 JSON"
                  className="min-h-72 font-mono text-xs"
                  spellCheck={false}
                  value={draft.content}
                  disabled={!canEdit}
                  onChange={(event) => updateDraft(event.target.value)}
                />
              </Field>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

/**
 * 统一设置 → MCP 页的全局用户配置内容。
 *
 * 无 Dialog/触发器，只编辑用户配置并展示已有的 OAuth 进度；不建立连接、
 * 不探测路径、不显示项目/会话运行视图，也不提供“应用到当前会话”。
 */
export function GlobalMcpContent() {
  const open = useMcpStore((state) => state.open)
  const target = useMcpStore((state) => state.target)
  const notice = useMcpStore((state) => state.notice)
  const error = useMcpStore((state) => state.error)
  const openPanel = useMcpStore((state) => state.openPanel)
  const closeSettings = useSettingsUiStore((state) => state.close)
  const selection = useWindowStore((state) => state.selection)
  const mcpAuth = useServiceStore((state) => state.mcpAuth)
  const mcpAuthError = useServiceStore((state) => state.mcpAuthError)
  const threadId = selection?.kind === 'thread' ? selection.threadId : undefined

  if (!open || !isGlobalMcpTarget(target)) return null

  const authOperations = mcpAuth?.operations ?? []
  const activeAuthCount = authOperations.filter(activeAuthOperation).length
  const openContext = () => {
    if (!threadId) return
    // 关闭统一设置会清理短期视图；随后显式打开当前会话的 MCP 上下文，不创建临时会话。
    closeSettings()
    void openPanel({ target: { threadId } })
  }

  return (
    <div className="flex flex-col gap-3" data-slot="huan-mcp-global">
      {notice && <Notice>{notice}</Notice>}
      {error && (
        <Alert variant="destructive" role="status" data-slot="huan-mcp-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {mcpAuthError && (
        <Alert variant="destructive" role="status">
          <AlertDescription>{mcpAuthError}</AlertDescription>
        </Alert>
      )}

      <ConfigEditor scope="user" />

      <Item data-slot="huan-mcp-global-login">
        <ItemContent>
          <ItemDescription className="text-xs">
            <Trans>OAuth 登录需要会话连接；保存配置后从会话的 MCP 面板登录。</Trans>
          </ItemDescription>
        </ItemContent>
        {threadId && (
          <ItemActions>
            <Button variant="outline" size="sm" aria-label="打开当前会话 MCP" onClick={openContext}>
              <Trans>打开当前会话 MCP</Trans>
            </Button>
          </ItemActions>
        )}
      </Item>

      {activeAuthCount > 0 && (
        <p data-slot="huan-mcp-auth-policy" className="text-muted-foreground text-xs">
          <Trans>关闭设置后登录继续；要终止请取消认证。</Trans>
        </p>
      )}

      {authOperations.length > 0 && (
        <section data-slot="huan-mcp-global-auth" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            <Trans>认证进度</Trans>
          </h3>
          <ItemGroup className="gap-0">
            {authOperations.map((operation, index) => (
              <Fragment key={operation.id}>
                {index > 0 && <ItemSeparator />}
                <AuthOperationCard operation={operation} />
              </Fragment>
            ))}
          </ItemGroup>
        </section>
      )}
    </div>
  )
}

/**
 * 当前会话/项目的 MCP 上下文弹层。
 *
 * 无触发器，由会话操作或项目设置入口调用 mcpStore.openPanel 打开。
 * 会话视图只展示连接、临时操作、详情和认证，配置入口转到统一全局页；
 * 项目目标固定 project 作用域，不混入用户配置。
 */
export function ContextMcpDialog() {
  const open = useMcpStore((state) => state.open)
  const target = useMcpStore((state) => state.target)
  const targetKey = useMcpStore((state) => state.targetKey)
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
  const close = useMcpStore((state) => state.close)
  const openSettingsPage = useSettingsUiStore((state) => state.openPage)
  const setTab = useMcpStore((state) => state.setTab)
  const refreshLive = useMcpStore((state) => state.refreshLive)
  const applyReload = useMcpStore((state) => state.applyReload)
  const selectServer = useMcpStore((state) => state.selectServer)
  const loadDetails = useMcpStore((state) => state.loadDetails)
  const manage = useMcpStore((state) => state.manage)
  const startAuth = useMcpStore((state) => state.startAuth)
  const mcpAuth = useServiceStore((state) => state.mcpAuth)
  const mcpAuthError = useServiceStore((state) => state.mcpAuthError)
  const sessionMode = target?.threadId !== undefined
  const effectiveTab: McpTab = sessionMode ? (tab === 'auth' ? 'auth' : 'servers') : 'config'

  // 只有 live 会话需要轮询运行快照；项目配置和全局配置都不启动连接。
  useEffect(() => {
    if (!open || !sessionMode || !targetKey) return
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
  }, [open, sessionMode, targetKey, refreshLive])

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
  const live =
    sessionMode &&
    snapshot?.live === true &&
    snapshot.runtime !== undefined &&
    !snapshot.runtime.closed

  if (!open || !target || isGlobalMcpTarget(target)) return null

  const openGlobal = () => {
    // 会话视图的配置入口进入统一设置 MCP 页；不要在上下文弹层里混入用户配置编辑。
    close()
    openSettingsPage('mcp')
  }

  return (
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
            {sessionMode ? (
              <Trans>查看当前会话的 MCP 连接、工具和登录。</Trans>
            ) : (
              <Trans>编辑当前项目的 MCP 配置。</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pe-1">
          <Item size="xs" data-slot="huan-mcp-context-info">
            <ItemContent>
              <ItemDescription className="font-mono text-xs break-all">
                {workspacePath}
              </ItemDescription>
              <ItemDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {sessionMode ? <Trans>当前会话目录</Trans> : <Trans>起始目录</Trans>}
                </Badge>
                {snapshot && (
                  <Badge variant={live ? 'secondary' : 'outline'}>
                    {live ? <Trans>当前会话</Trans> : <Trans>尚未应用</Trans>}
                  </Badge>
                )}
                {configSnapshot && (
                  <Badge variant={configSnapshot.projectTrusted ? 'secondary' : 'outline'}>
                    {configSnapshot.projectTrusted ? (
                      <Trans>项目已信任</Trans>
                    ) : (
                      <Trans>项目未信任</Trans>
                    )}
                  </Badge>
                )}
              </ItemDescription>
            </ItemContent>
          </Item>

          {snapshot && (
            <details className="text-xs" data-slot="huan-mcp-runtime-diagnostics">
              <summary className="text-muted-foreground cursor-pointer">
                <Trans>诊断详情</Trans>
              </summary>
              <span className="text-muted-foreground font-mono">
                {snapshot.runtime ? (
                  <Trans>运行版本 {snapshot.runtime.revision}</Trans>
                ) : (
                  <Trans>尚无运行实例</Trans>
                )}
              </span>
            </details>
          )}

          {notice && <Notice>{notice}</Notice>}
          {error && (
            <Alert variant="destructive" role="status" data-slot="huan-mcp-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {targetError && (
            <Alert variant="destructive" role="status" data-slot="huan-mcp-error">
              <AlertDescription>{targetError}</AlertDescription>
            </Alert>
          )}
          {mcpAuthError && (
            <Alert variant="destructive" role="status">
              <AlertDescription>{mcpAuthError}</AlertDescription>
            </Alert>
          )}
          {sessionMode && activeAuthCount > 0 && (
            <p data-slot="huan-mcp-auth-policy" className="text-muted-foreground text-xs">
              <Trans>关闭面板后登录继续；要终止请取消认证。</Trans>
            </p>
          )}

          <Tabs
            value={effectiveTab}
            onValueChange={(value) => void setTab(value as McpTab)}
            className="gap-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <TabsList variant="line" aria-label="MCP 视图">
                {sessionMode ? (
                  <>
                    <TabsTrigger value="servers" aria-label="MCP 服务器列表">
                      <Trans>服务器</Trans>
                    </TabsTrigger>
                    <TabsTrigger value="auth" aria-label="MCP 认证">
                      <Trans>认证</Trans>
                      {activeAuthCount > 0 && <Badge variant="secondary">{activeAuthCount}</Badge>}
                    </TabsTrigger>
                  </>
                ) : (
                  <TabsTrigger value="config" aria-label="MCP 配置">
                    <Trans>配置</Trans>
                  </TabsTrigger>
                )}
              </TabsList>
              <div className="ms-auto flex flex-wrap items-center gap-2">
                {sessionMode && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="编辑全局 MCP 配置"
                    onClick={openGlobal}
                  >
                    <Trans>编辑全局配置</Trans>
                  </Button>
                )}
                <Button
                  size="sm"
                  aria-label={sessionMode ? '应用到当前会话' : '刷新项目资源'}
                  disabled={busy !== undefined}
                  onClick={() => void applyReload()}
                >
                  {busy === 'reload' ? (
                    <Loader2Icon aria-hidden className="animate-spin" />
                  ) : (
                    <RotateCwIcon aria-hidden />
                  )}
                  {sessionMode ? <Trans>应用到当前会话</Trans> : <Trans>刷新项目资源</Trans>}
                </Button>
              </div>
            </div>

            {sessionMode && (
              <TabsContent value="servers">
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
                      <Trans>当前没有 MCP 服务器配置；可在“编辑全局配置”或项目设置中添加。</Trans>
                    </p>
                  )}
                  <ItemGroup className="gap-0">
                    {rows.map((row, index) => (
                      <Fragment key={row.name}>
                        {index > 0 && <ItemSeparator />}
                        <ServerRowView
                          row={row}
                          selected={selected === row.name}
                          busy={busy !== undefined}
                          onSelect={() => void selectServer(row.name)}
                          onManage={(action) => void manage(row, action)}
                          onLogin={() => void startAuth('login', row)}
                          onLogout={() => void startAuth('logout', row)}
                        />
                      </Fragment>
                    ))}
                  </ItemGroup>
                  {detailsError && (
                    <Alert variant="destructive" role="status">
                      <AlertDescription>{detailsError}</AlertDescription>
                    </Alert>
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
              </TabsContent>
            )}

            {sessionMode && (
              <TabsContent value="auth">
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
                    <ItemGroup className="gap-0">
                      {authOperations.map((operation, index) => (
                        <Fragment key={operation.id}>
                          {index > 0 && <ItemSeparator />}
                          <AuthOperationCard operation={operation} />
                        </Fragment>
                      ))}
                    </ItemGroup>
                  )}
                </div>
              </TabsContent>
            )}

            {!sessionMode && (
              <TabsContent value="config">
                <ConfigEditor scope="project" />
              </TabsContent>
            )}
          </Tabs>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
