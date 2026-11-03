/**
 * 模型认证面板：API key 与 OAuth 登录、授权链接、设备码、短期回填、取消与退出。
 *
 * 认证安全快照只在公共 serviceStore；面板视图、短期回填与忙状态在 auth
 * feature Zustand。回填值提交前清空，不进入快照/日志；关闭面板不终止登录。
 */

import type {
  HarnessProviderAuthMethod,
  HarnessProviderAuthOperation,
  HarnessProviderAuthPrompt,
  HarnessProviderAuthProvider,
  HarnessProviderAuthSource,
} from '@huan/protocol'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { useAuthStore } from '@/state/app-context'

const sourceLabel = (source: HarnessProviderAuthSource | undefined): string | undefined => {
  switch (source) {
    case 'stored':
      return '本地凭据'
    case 'runtime':
      return '运行时凭据'
    case 'environment':
      return '环境变量'
    case 'fallback':
      return 'provider 默认'
    case 'models-json-key':
      return 'models.json key'
    case 'models-json-command':
      return 'models.json 命令'
    default:
      return undefined
  }
}

const phaseLabel = (operation: HarnessProviderAuthOperation): string => {
  switch (operation.phase) {
    case 'starting':
      return '正在开始'
    case 'waiting':
      return '等待 provider'
    case 'prompt':
      return '等待输入'
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

const activeOperation = (operation: HarnessProviderAuthOperation): boolean =>
  operation.phase !== 'succeeded' && operation.phase !== 'failed' && operation.phase !== 'cancelled'

function PromptForm({
  operation,
  prompt,
}: {
  operation: HarnessProviderAuthOperation
  prompt: HarnessProviderAuthPrompt
}) {
  const answers = useAuthStore((state) => state.answers)
  const submitting = useAuthStore((state) => state.submitting)
  const setAnswer = useAuthStore((state) => state.setAnswer)
  const submitPrompt = useAuthStore((state) => state.submitPrompt)
  const key = `${operation.id}|${prompt.promptId}`
  const answer = answers[key] ?? ''
  const busy = submitting !== undefined
  const inputId = `provider-auth-${operation.id}-${prompt.promptId}`

  if (prompt.kind === 'select') {
    return (
      <FieldGroup className="basis-full gap-2" data-slot="huan-provider-auth-prompt">
        <p>{prompt.message}</p>
        <div className="flex flex-wrap gap-2">
          {(prompt.options ?? []).map((option) => (
            <Button
              key={option.id}
              variant="outline"
              size="sm"
              disabled={busy}
              data-slot="huan-provider-auth-option"
              onClick={() => {
                setAnswer(operation.id, prompt.promptId, option.id)
                void submitPrompt(operation.id, prompt)
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {prompt.options?.some((option) => option.description) && (
          <ul className="text-muted-foreground list-inside list-disc text-xs">
            {prompt.options.map((option) =>
              option.description ? (
                <li key={option.id}>
                  {option.label}：{option.description}
                </li>
              ) : null,
            )}
          </ul>
        )}
      </FieldGroup>
    )
  }

  const secret = prompt.kind === 'secret'
  return (
    <form
      className="flex basis-full flex-col gap-2"
      data-slot="huan-provider-auth-prompt"
      onSubmit={(event) => {
        event.preventDefault()
        void submitPrompt(operation.id, prompt)
      }}
    >
      <Field>
        <FieldLabel htmlFor={inputId}>{prompt.message}</FieldLabel>
        <Input
          id={inputId}
          // secret 使用密码框；提交后 store 立即清空，关闭面板也会卸载。
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          autoCapitalize="off"
          spellCheck={false}
          maxLength={8_192}
          value={answer}
          placeholder={prompt.placeholder}
          disabled={busy}
          aria-label={secret ? '认证密钥' : prompt.kind === 'manual_code' ? '授权码' : '认证输入'}
          onChange={(event) => setAnswer(operation.id, prompt.promptId, event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={busy}>
            {busy && <Loader2Icon aria-hidden className="animate-spin" />}
            <Trans>提交</Trans>
          </Button>
        </div>
      </Field>
    </form>
  )
}

function OperationCard({ operation }: { operation: HarnessProviderAuthOperation }) {
  const cancelling = useAuthStore((state) => state.cancelling[operation.id] === true)
  const cancel = useAuthStore((state) => state.cancel)
  const setNotice = useAuthStore((state) => state.setNotice)
  const result = operation.result
  const canCancel = activeOperation(operation) && operation.phase !== 'cancelling'

  return (
    <Item
      data-slot="huan-provider-auth-operation"
      data-operation-id={operation.id}
      data-phase={operation.phase}
      className="flex-col items-stretch"
    >
      <ItemHeader>
        <ItemTitle>{operation.providerName}</ItemTitle>
        <span className="text-muted-foreground text-xs">
          {operation.kind === 'login' ? <Trans>登录</Trans> : <Trans>退出登录</Trans>} ·{' '}
          {phaseLabel(operation)}
        </span>
      </ItemHeader>

      {operation.events.length > 0 && (
        <ul
          className="flex basis-full flex-col gap-2 text-sm"
          data-slot="huan-provider-auth-events"
        >
          {operation.events.map((event) => (
            <li key={event.eventId}>
              {event.type === 'auth_url' ? (
                <div className="flex flex-col gap-1">
                  <span>
                    <Trans>需要浏览器授权。链接只会在你点击后打开。</Trans>
                  </span>
                  {isHttpUrl(event.url) && (
                    <a
                      className="text-primary inline-flex w-fit items-center gap-1 underline"
                      href={event.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      data-slot="huan-provider-auth-url"
                    >
                      <Trans>打开授权页</Trans>
                      <ExternalLinkIcon aria-hidden className="size-3" />
                    </a>
                  )}
                  {event.instructions && (
                    <span className="text-muted-foreground">{event.instructions}</span>
                  )}
                </div>
              ) : event.type === 'device_code' ? (
                <div className="flex flex-col gap-1">
                  <span>
                    <Trans>设备码</Trans>：
                    <code data-slot="huan-provider-auth-device-code">{event.userCode}</code>{' '}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="复制设备码"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(event.userCode)
                          .then(() => setNotice('设备码已复制。'))
                          .catch(() => setNotice('复制失败，请手工选择设备码。'))
                      }}
                    >
                      <CopyIcon aria-hidden />
                    </Button>
                  </span>
                  {isHttpUrl(event.verificationUri) && (
                    <a
                      className="text-primary inline-flex w-fit items-center gap-1 underline"
                      href={event.verificationUri}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <Trans>打开验证页</Trans>
                      <ExternalLinkIcon aria-hidden className="size-3" />
                    </a>
                  )}
                  {(event.intervalSeconds || event.expiresInSeconds) && (
                    <span className="text-muted-foreground text-xs">
                      {event.intervalSeconds ? (
                        <Trans>轮询间隔 {event.intervalSeconds} 秒</Trans>
                      ) : null}
                      {event.intervalSeconds && event.expiresInSeconds ? ' · ' : null}
                      {event.expiresInSeconds ? (
                        <Trans>有效期 {event.expiresInSeconds} 秒</Trans>
                      ) : null}
                    </span>
                  )}
                </div>
              ) : event.type === 'info' ? (
                <div className="flex flex-col gap-1">
                  <span>{event.message}</span>
                  {event.links?.map((link) =>
                    isHttpUrl(link.url) ? (
                      <a
                        key={link.url}
                        className="text-primary w-fit underline"
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {link.label ?? <Trans>打开链接</Trans>}
                      </a>
                    ) : null,
                  )}
                </div>
              ) : (
                <span className="text-muted-foreground">{event.message}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {operation.prompt && operation.phase === 'prompt' && (
        <PromptForm
          key={operation.prompt.promptId}
          operation={operation}
          prompt={operation.prompt}
        />
      )}

      {result && (
        <ItemDescription
          role="status"
          data-slot="huan-provider-auth-result"
          data-status={result.status}
          className={result.status === 'succeeded' ? 'basis-full text-foreground' : 'basis-full'}
        >
          {result.message}
        </ItemDescription>
      )}
      {canCancel && (
        <ItemFooter>
          <span
            className="text-muted-foreground text-xs"
            data-slot="huan-provider-auth-cancel-note"
          >
            <Trans>关闭面板后认证继续；要终止请点击取消认证</Trans>
          </span>
          <ItemActions>
            <Button
              variant="outline"
              size="sm"
              disabled={cancelling}
              onClick={() => void cancel(operation.id)}
              data-slot="huan-provider-auth-cancel"
            >
              {cancelling && <Loader2Icon aria-hidden className="animate-spin" />}
              <Trans>取消认证</Trans>
            </Button>
          </ItemActions>
        </ItemFooter>
      )}
    </Item>
  )
}

function ProviderRow({
  provider,
  focused,
  logoutCompleted,
}: {
  provider: HarnessProviderAuthProvider
  focused: boolean
  logoutCompleted: boolean
}) {
  const source = sourceLabel(provider.source)
  const busy = useAuthStore((state) => state.providerBusy[provider.providerId])
  const startLogin = useAuthStore((state) => state.startLogin)
  const logout = useAuthStore((state) => state.logout)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const run = (action: 'login' | 'logout', method?: HarnessProviderAuthMethod) => {
    if (action === 'login' && method) void startLogin(provider.providerId, method)
    else void logout(provider.providerId)
  }

  const canLogout =
    provider.configured &&
    provider.source !== 'environment' &&
    provider.source !== 'fallback' &&
    provider.source !== 'runtime' &&
    provider.source !== 'models-json-key' &&
    provider.source !== 'models-json-command'

  // 退出成功后若该 provider 仍由其他来源提供凭据，用现有快照与退出结果说明，
  // 不假设退出一定清除了环境变量或 models.json。
  const leftoverSource =
    provider.configured &&
    provider.source !== undefined &&
    provider.source !== 'stored' &&
    logoutCompleted
      ? source
      : undefined

  return (
    <Item
      ref={rowRef}
      data-slot="huan-provider-auth-provider"
      data-provider-id={provider.providerId}
      data-focused={focused ? 'true' : undefined}
      variant={focused ? 'outline' : 'default'}
      className={focused ? 'border-ring ring-3 ring-ring/50' : undefined}
    >
      <ItemContent>
        <ItemTitle>
          {provider.name}
          <code className="text-muted-foreground font-mono text-xs">{provider.providerId}</code>
        </ItemTitle>
      </ItemContent>
      <span
        className="flex flex-wrap items-center gap-2"
        data-slot="huan-provider-auth-status"
        data-configured={provider.configured ? 'true' : 'false'}
      >
        {provider.configured ? (
          <>
            <Badge variant="secondary">
              <ShieldCheckIcon aria-hidden />
              <Trans>已配置</Trans>
            </Badge>
            {provider.storedCredentialType && (
              <span className="text-muted-foreground text-xs">
                {provider.storedCredentialType === 'oauth' ? 'OAuth' : 'API key'}
              </span>
            )}
            {source && <span className="text-muted-foreground text-xs">{source}</span>}
          </>
        ) : (
          <Badge variant="outline">
            <Trans>未配置</Trans>
          </Badge>
        )}
      </span>

      {provider.ambientOnly && (
        <ItemDescription className="basis-full">
          <Trans>请在环境变量或 models.json 中配置凭据。</Trans>
        </ItemDescription>
      )}

      {!provider.ambientOnly && (
        <ItemFooter className="justify-start">
          <ItemActions className="flex-wrap">
            {provider.methods.map((method) =>
              method.loginable ? (
                <Button
                  key={method.type}
                  variant="outline"
                  size="sm"
                  disabled={busy !== undefined}
                  data-slot="huan-provider-auth-login"
                  data-method={method.type}
                  onClick={() => run('login', method.type)}
                >
                  {busy === 'login' && <Loader2Icon aria-hidden className="animate-spin" />}
                  <KeyRoundIcon aria-hidden />
                  {method.subscription
                    ? `使用 ${method.label} 登录（订阅）`
                    : `使用 ${method.label} 登录`}
                </Button>
              ) : (
                <span key={method.type} className="text-muted-foreground text-xs">
                  {method.label}（由环境/配置提供）
                </span>
              ),
            )}
          </ItemActions>
        </ItemFooter>
      )}

      {leftoverSource && (
        <ItemDescription
          className="basis-full text-xs"
          data-slot="huan-provider-auth-remaining-source"
        >
          <Trans>仍通过{leftoverSource}提供凭据，请修改对应配置</Trans>
        </ItemDescription>
      )}

      {canLogout && (
        <ItemFooter className="justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== undefined}
            data-slot="huan-provider-auth-logout"
            onClick={() => run('logout')}
          >
            {busy === 'logout' && <Loader2Icon aria-hidden className="animate-spin" />}
            <LogOutIcon aria-hidden />
            <Trans>退出登录</Trans>
          </Button>
        </ItemFooter>
      )}
    </Item>
  )
}

/** 模型与服务商页内的认证内容；开关、页签与关闭由统一设置容器负责。 */
export function ProviderAuthContent() {
  const snapshot = useServiceStore((state) => state.providerAuth)
  const focusedProvider = useAuthStore((state) => state.focusedProvider)
  const notice = useAuthStore((state) => state.notice)

  const providers = snapshot?.providers ?? []
  const operations = snapshot?.operations ?? []
  const latestByProvider = new Map<string, HarnessProviderAuthOperation>()
  for (const operation of operations) {
    const latest = latestByProvider.get(operation.providerId)
    if (!latest || operation.startedAt > latest.startedAt) {
      latestByProvider.set(operation.providerId, operation)
    }
  }
  const focusedMissing =
    focusedProvider !== undefined && snapshot !== undefined
      ? !providers.some((provider) => provider.providerId === focusedProvider)
      : false

  return (
    <div data-slot="huan-provider-auth" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-sm font-medium">
          <Trans>模型认证</Trans>
        </h3>
        <p className="text-muted-foreground text-xs">
          <Trans>管理模型服务商的登录凭据。</Trans>
        </p>
      </div>

      <details
        className="text-muted-foreground text-xs"
        data-slot="huan-provider-auth-credentials-note"
      >
        <summary className="cursor-pointer">
          <Trans>凭据说明</Trans>
        </summary>
        <p className="mt-1">
          <Trans>
            凭据保存在服务端用户空间的
            auth.json；退出登录仅移除此处保存的凭据，远端授权需在服务商处撤销。
          </Trans>
        </p>
      </details>

      {focusedMissing && (
        <Alert variant="destructive" data-slot="huan-provider-auth-notice">
          <AlertDescription>
            <Trans>找不到此服务商：{focusedProvider}，请重新选择。</Trans>
          </AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert role="status" data-slot="huan-provider-auth-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        {snapshot === undefined ? (
          <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2Icon aria-hidden className="size-4 animate-spin" />
            <Trans>正在读取认证状态…</Trans>
          </p>
        ) : (
          <>
            {operations.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-muted-foreground text-xs font-medium">
                  <Trans>认证操作</Trans>
                </h3>
                <ItemGroup className="gap-0">
                  {operations.map((operation, index) => (
                    <Fragment key={operation.id}>
                      {index > 0 && <ItemSeparator />}
                      <OperationCard operation={operation} />
                    </Fragment>
                  ))}
                </ItemGroup>
              </div>
            )}

            {providers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                <Trans>当前没有已注册的 provider。</Trans>
              </p>
            ) : (
              <ItemGroup className="gap-0">
                {providers.map((provider, index) => (
                  <Fragment key={provider.providerId}>
                    {index > 0 && <ItemSeparator />}
                    <ProviderRow
                      provider={provider}
                      focused={focusedProvider === provider.providerId}
                      logoutCompleted={
                        latestByProvider.get(provider.providerId)?.kind === 'logout' &&
                        latestByProvider.get(provider.providerId)?.phase === 'succeeded'
                      }
                    />
                  </Fragment>
                ))}
              </ItemGroup>
            )}
          </>
        )}
      </div>
    </div>
  )
}
