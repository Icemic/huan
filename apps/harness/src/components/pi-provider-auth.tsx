/**
 * 模型认证面板（G1.4c）。
 *
 * 交互边界：
 * - 关闭视图不会终止登录，只有显式“取消”会 abort；
 * - secret 输入使用密码框，关闭/提交/提示切换时清空，不写入任何持久草稿；
 * - 回填值只经 HTTP 请求交给宿主内存 resolver，不进入快照或提示文案；
 * - 授权链接由用户点击，宿主与页面都不会自动打开浏览器。
 */
import type {
  HarnessProviderAuthMethod,
  HarnessProviderAuthOperation,
  HarnessProviderAuthPrompt,
  HarnessProviderAuthProvider,
  HarnessProviderAuthSource,
} from '@huan/protocol'
import { Trans } from '@lingui/react/macro'
import {
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
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
import { clearPiIntent, usePiIntent } from './pi-command-intents'
import { harnessHttpClient } from './pi-http-client'
import { refreshProviderAuthSnapshot, useProviderAuthSnapshot } from './pi-provider-auth-store'

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
  onNotice,
}: {
  operation: HarnessProviderAuthOperation
  prompt: HarnessProviderAuthPrompt
  onNotice: (message: string | undefined) => void
}) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const inputId = useId()

  // 提示切换（或同一操作的新提示）时丢弃旧输入，避免把上一个提示的值误提交。
  // 组件以 promptId 为 key 重新挂载；这里再显式清空，覆盖快速切换场景。
  // biome-ignore lint/correctness/useExhaustiveDependencies: promptId 变化必须重置输入。
  useEffect(() => {
    setAnswer('')
    setBusy(false)
  }, [prompt.promptId])

  const respond = async (value: string) => {
    if (busy) return
    const submitted = value
    // 先清空本地输入，再提交；任何错误文案都不回显提交值。
    setAnswer('')
    setBusy(true)
    onNotice(undefined)
    try {
      const result = await harnessHttpClient.respondProviderAuthPrompt({
        operationId: operation.id,
        promptId: prompt.promptId,
        value: submitted,
      })
      if (result.status === 'stale') {
        onNotice('该认证提示已失效，请查看最新状态后重新操作。')
      } else if (result.status === 'invalid') {
        onNotice(result.message)
      }
      await refreshProviderAuthSnapshot()
    } catch {
      onNotice('提交认证输入失败，请检查宿主连接后重试。')
    } finally {
      setBusy(false)
    }
  }

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
              onClick={() => void respond(option.id)}
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
        void respond(answer)
      }}
    >
      <label htmlFor={inputId} className="flex flex-col gap-1">
        <span>{prompt.message}</span>
        <Input
          id={inputId}
          // secret 使用密码框；关闭面板即卸载，输入不进入页面持久状态。
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          autoCapitalize="off"
          spellCheck={false}
          maxLength={8_192}
          value={answer}
          placeholder={prompt.placeholder}
          disabled={busy}
          aria-label={secret ? '认证密钥' : prompt.kind === 'manual_code' ? '授权码' : '认证输入'}
          onChange={(event) => setAnswer(event.target.value)}
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

function OperationCard({
  operation,
  onNotice,
}: {
  operation: HarnessProviderAuthOperation
  onNotice: (message: string | undefined) => void
}) {
  const [cancelling, setCancelling] = useState(false)
  const result = operation.result
  const showResult = result !== undefined
  const canCancel = activeOperation(operation) && operation.phase !== 'cancelling'

  const cancel = async () => {
    if (cancelling) return
    setCancelling(true)
    onNotice(undefined)
    try {
      const answer = await harnessHttpClient.cancelProviderAuth(operation.id)
      if (answer.status === 'not-found') onNotice('该认证操作已不存在。')
      else if (answer.status === 'finished') onNotice('该认证操作已经结束，取消未生效。')
      await refreshProviderAuthSnapshot()
    } catch {
      onNotice('取消认证失败，请检查宿主连接。')
    } finally {
      setCancelling(false)
    }
  }

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
                          .then(() => onNotice('设备码已复制。'))
                          .catch(() => onNotice('复制失败，请手工选择设备码。'))
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
          onNotice={onNotice}
        />
      )}

      {showResult && (
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
            onClick={() => void cancel()}
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
  onNotice,
}: {
  provider: HarnessProviderAuthProvider
  focused: boolean
  onNotice: (message: string | undefined) => void
}) {
  const source = sourceLabel(provider.source)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const rowRef = useRef<HTMLElement>(null)

  // /login <provider> 打开面板时让目标行可见（provider 列表可能很长）。
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const run = async (action: 'login' | 'logout', method?: HarnessProviderAuthMethod) => {
    setPending(action)
    onNotice(undefined)
    try {
      const result =
        action === 'login' && method
          ? await harnessHttpClient.startProviderLogin({
              providerId: provider.providerId,
              method,
            })
          : await harnessHttpClient.logoutProvider(provider.providerId)
      if (result.status === 'invalid') {
        onNotice(result.message)
      } else if (result.status === 'busy') {
        onNotice('该 provider 已有进行中的认证操作，请先完成或取消。')
      } else {
        onNotice(
          action === 'login'
            ? `已开始 ${provider.name} 的登录流程。关闭面板不会终止登录。`
            : `已开始 ${provider.name} 的退出流程。`,
        )
      }
      await refreshProviderAuthSnapshot()
    } catch {
      onNotice('操作失败，请检查宿主连接后重试。')
    } finally {
      setPending(undefined)
    }
  }

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
                disabled={pending !== undefined}
                data-slot="huan-provider-auth-login"
                data-method={method.type}
                onClick={() => void run('login', method.type)}
              >
                {pending === 'login' && <Loader2Icon aria-hidden className="animate-spin" />}
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

      {provider.configured &&
        provider.source !== 'environment' &&
        provider.source !== 'fallback' &&
        provider.source !== 'runtime' &&
        provider.source !== 'models-json-key' &&
        provider.source !== 'models-json-command' && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending !== undefined}
              data-slot="huan-provider-auth-logout"
              onClick={() => void run('logout')}
            >
              {pending === 'logout' && <Loader2Icon aria-hidden className="animate-spin" />}
              <LogOutIcon aria-hidden />
              <Trans>退出登录</Trans>
            </Button>
          </div>
        )}
    </section>
  )
}

/** 顶栏认证入口与面板；/login、/logout 通过意图桥复用同一组件。 */
export function ProviderAuthDialog() {
  const snapshot = useProviderAuthSnapshot()
  const intent = usePiIntent()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [focusedProvider, setFocusedProvider] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (intent?.kind !== 'provider-auth') return
    setOpen(true)
    setFocusedProvider(intent.payload?.provider)
    setNotice(
      intent.payload?.mode === 'logout'
        ? '请在该 provider 行内选择“退出登录”。'
        : intent.payload?.mode === 'login'
          ? '请选择该 provider 的登录方式。'
          : undefined,
    )
    clearPiIntent(intent.id)
  }, [intent])

  useEffect(() => {
    if (open) {
      // 打开时重读权威快照（其他窗口/外部 Pi 的变更也能看到）。
      void refreshProviderAuthSnapshot()
      return
    }
    // 关闭视图不取消登录；只清空本窗口的提示与输入（输入组件随内容卸载）。
    setNotice(undefined)
    setFocusedProvider(undefined)
  }, [open])

  const providers = snapshot?.providers ?? []
  const operations = snapshot?.operations ?? []
  const focusedMissing =
    focusedProvider !== undefined && snapshot !== undefined
      ? !providers.some((provider) => provider.providerId === focusedProvider)
      : false
  const activeCount = operations.filter(activeOperation).length

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="模型认证"
        data-slot="huan-provider-auth-trigger"
        onClick={() => setOpen(true)}
      >
        <KeyRoundIcon aria-hidden className="size-3.5" />
        <Trans>认证</Trans>
        {activeCount > 0 && (
          <span
            className="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4"
            data-slot="huan-provider-auth-active-count"
          >
            {activeCount}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
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
                需要点“取消认证”。退出登录只移除本地已存凭据，不清除环境变量、models.json
                或远端授权。
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
                      <OperationCard
                        key={operation.id}
                        operation={operation}
                        onNotice={setNotice}
                      />
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
                      onNotice={setNotice}
                    />
                  ))
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
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
