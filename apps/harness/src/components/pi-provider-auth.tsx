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
import { useEffect, useRef } from 'react'
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
import { useRestoreTriggerFocus } from '@/hooks/use-restore-trigger-focus'
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
      <div className="flex flex-col gap-2" data-slot="huan-provider-auth-prompt">
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
      </div>
    )
  }

  const secret = prompt.kind === 'secret'
  return (
    <form
      className="flex flex-col gap-2"
      data-slot="huan-provider-auth-prompt"
      onSubmit={(event) => {
        event.preventDefault()
        void submitPrompt(operation.id, prompt)
      }}
    >
      <label htmlFor={inputId} className="flex flex-col gap-1">
        <span>{prompt.message}</span>
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
        {secret && (
          <span className="text-muted-foreground text-xs">
            <Trans>密钥只提交给宿主内存中的认证流程，不会进入快照、日志或聊天记录。</Trans>
          </span>
        )}
      </label>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Loader2Icon aria-hidden className="animate-spin" />}
          <Trans>提交</Trans>
        </Button>
      </div>
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
    <section
      data-slot="huan-provider-auth-operation"
      data-operation-id={operation.id}
      data-phase={operation.phase}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{operation.providerName}</strong>
        <span className="text-muted-foreground">
          {operation.kind === 'login' ? <Trans>登录</Trans> : <Trans>退出登录</Trans>} ·{' '}
          {phaseLabel(operation)}
        </span>
      </div>

      {operation.events.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-slot="huan-provider-auth-events">
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
        <p
          role="status"
          data-slot="huan-provider-auth-result"
          data-status={result.status}
          className={result.status === 'succeeded' ? '' : 'text-muted-foreground'}
        >
          {result.message}
        </p>
      )}
      {canCancel && (
        <div className="flex justify-end">
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
        </div>
      )}
    </section>
  )
}

function ProviderRow({
  provider,
  focused,
}: {
  provider: HarnessProviderAuthProvider
  focused: boolean
}) {
  const source = sourceLabel(provider.source)
  const busy = useAuthStore((state) => state.providerBusy[provider.providerId])
  const startLogin = useAuthStore((state) => state.startLogin)
  const logout = useAuthStore((state) => state.logout)
  const rowRef = useRef<HTMLElement>(null)

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

  return (
    <section
      ref={rowRef}
      data-slot="huan-provider-auth-provider"
      data-provider-id={provider.providerId}
      data-focused={focused ? 'true' : undefined}
      className={`flex flex-col gap-2 rounded-lg border p-3 ${focused ? 'ring-ring ring-2' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{provider.name}</strong>
        <code className="text-muted-foreground text-xs">{provider.providerId}</code>
        <span
          className="ms-auto text-xs"
          data-slot="huan-provider-auth-status"
          data-configured={provider.configured ? 'true' : 'false'}
        >
          {provider.configured ? (
            <>
              <ShieldCheckIcon aria-hidden className="inline size-3.5" /> <Trans>已配置</Trans>
              {provider.storedCredentialType && (
                <span className="text-muted-foreground">
                  {' '}
                  · {provider.storedCredentialType === 'oauth' ? 'OAuth' : 'API key'}
                </span>
              )}
              {source && <span className="text-muted-foreground"> · {source}</span>}
            </>
          ) : (
            <Trans>未配置</Trans>
          )}
        </span>
      </div>

      {provider.ambientOnly ? (
        <p className="text-muted-foreground text-xs">
          <Trans>
            该 provider 只支持环境变量或 models.json
            凭据，没有交互登录入口；退出登录也不会清除这些来源。
          </Trans>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
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
        </div>
      )}

      {canLogout && (
        <div>
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
        </div>
      )}
    </section>
  )
}

/** 顶栏认证入口与面板；`/login`、`/logout` 打开同一面板。 */
export function ProviderAuthDialog() {
  const snapshot = useServiceStore((state) => state.providerAuth)
  const open = useAuthStore((state) => state.open)
  const focusedProvider = useAuthStore((state) => state.focusedProvider)
  const notice = useAuthStore((state) => state.notice)
  const openPanel = useAuthStore((state) => state.openPanel)
  const closePanel = useAuthStore((state) => state.closePanel)
  const triggerRef = useRestoreTriggerFocus(open)

  if (!open) {
    return (
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="模型认证"
        data-slot="huan-provider-auth-trigger"
        onClick={() => void openPanel()}
      >
        <KeyRoundIcon aria-hidden className="size-3.5" />
        <Trans>认证</Trans>
        {(snapshot?.operations ?? []).filter(activeOperation).length > 0 && (
          <span
            className="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4"
            data-slot="huan-provider-auth-active-count"
          >
            {(snapshot?.operations ?? []).filter(activeOperation).length}
          </span>
        )}
      </Button>
    )
  }

  const providers = snapshot?.providers ?? []
  const operations = snapshot?.operations ?? []
  const focusedMissing =
    focusedProvider !== undefined && snapshot !== undefined
      ? !providers.some((provider) => provider.providerId === focusedProvider)
      : false

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closePanel()
      }}
    >
      <DialogContent
        data-slot="huan-provider-auth-dialog"
        aria-label="模型认证"
        className="flex max-h-[85dvh] max-w-2xl flex-col"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>模型认证</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              API key 与 OAuth 凭据保存在当前用户空间的 auth.json，由 Pi SDK 管理。
              回填值只提交给宿主内存中的认证流程，不会写入快照、日志或聊天；关闭面板不会终止登录，
              需要点“取消认证”。退出登录只移除本地已存凭据，不清除环境变量、models.json 或远端授权。
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {focusedMissing && (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-slot="huan-provider-auth-notice"
          >
            <Trans>未知 provider：请从列表中可用的 provider 选择；该 ID 不会发送给模型。</Trans>
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm" data-slot="huan-provider-auth-notice">
            {notice}
          </p>
        )}

        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
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
                  {operations.map((operation) => (
                    <OperationCard key={operation.id} operation={operation} />
                  ))}
                </div>
              )}

              {providers.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  <Trans>当前没有已注册的 provider。</Trans>
                </p>
              ) : (
                providers.map((provider) => (
                  <ProviderRow
                    key={provider.providerId}
                    provider={provider}
                    focused={focusedProvider === provider.providerId}
                  />
                ))
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closePanel}>
            <Trans>关闭</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
