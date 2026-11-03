/**
 * 宿主状态：协议版本、默认模型 readiness、用户空间/会话目录、诊断与会话
 * 模型回退原因。
 *
 * 宿主信息与受控错误在公共 serviceStore；刷新忙状态在 host feature。登录/
 * 退出后由 host store 重新读取 readiness，不在界面暗示“认证修改必须重启”。
 */

import type { HarnessConfigSource } from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { useServiceStore, useWindowStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { KeyRoundIcon, Loader2Icon, RefreshCwIcon, ServerIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRestoreTriggerFocus } from '@/hooks/use-restore-trigger-focus'
import { useAuthStore, useHostStore } from '@/state/app-context'

const sourceLabel = (source: HarnessConfigSource) => {
  switch (source) {
    case 'option':
      return <Trans>显式参数</Trans>
    case 'env':
      return <Trans>环境变量</Trans>
    case 'settings':
      return <Trans>配置文件</Trans>
    case 'default':
      return <Trans>默认规则</Trans>
  }
}

const fallbackReasonLabel = (reason: string | undefined): string => {
  switch (reason) {
    case 'restore-failed':
      return '历史恢复时原模型不可用'
    case 'no-model':
      return '没有可用模型'
    default:
      return '模型回退原因未知'
  }
}

/** 当前会话的受控回退说明；普通诊断不携带任意扩展错误。 */
function SessionFallbackNotice() {
  const selection = useWindowStore((state) => state.selection)
  const metadata = useServiceStore((state) =>
    selection?.kind === 'thread' ? state.threadsById[selection.threadId] : undefined,
  )
  const fallback = metadata?.modelFallback
  if (!fallback) return null
  return (
    <div
      data-slot="huan-model-fallback"
      role="status"
      className="rounded-md border px-2 py-1.5 text-xs"
    >
      <span className="font-medium">{fallbackReasonLabel(fallback.reason)}</span>
      <span className="text-muted-foreground">
        {fallback.requested
          ? `；原模型 ${fallback.requested.provider}/${fallback.requested.modelId}`
          : ''}
        {fallback.active ? `；当前使用 ${fallback.active.provider}/${fallback.active.modelId}` : ''}
      </span>
      <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{fallback.message}</p>
    </div>
  )
}

/** 顶栏宿主入口与诊断面板。 */
export function PiHostStatus() {
  const host = useServiceStore((state) => state.host)
  const hostLoading = useServiceStore((state) => state.hostLoading)
  const hostError = useServiceStore((state) => state.hostError)
  const refreshing = useHostStore((state) => state.refreshing)
  const statusOpen = useHostStore((state) => state.statusOpen)
  const openStatus = useHostStore((state) => state.openStatus)
  const closeStatus = useHostStore((state) => state.closeStatus)
  const refreshHostInfo = useHostStore((state) => state.refreshHostInfo)
  const openAuth = useAuthStore((state) => state.openPanel)
  const triggerRef = useRestoreTriggerFocus(statusOpen)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const readiness = host?.defaultModel.readiness
  const protocolMismatch = host !== undefined && host.protocolVersion !== HARNESS_PROTOCOL_VERSION
  const needsModel = readiness && readiness.state !== 'ready'

  const copy = async () => {
    if (!host) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(host, null, 2))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="宿主状态"
        data-slot="huan-host-status-trigger"
        onClick={openStatus}
      >
        {hostLoading && !host ? (
          <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <ServerIcon aria-hidden className="size-3.5" />
        )}
        <Trans>宿主</Trans>
        {protocolMismatch || hostError ? (
          <span className="bg-destructive size-1.5 rounded-full" aria-hidden />
        ) : null}
      </Button>
      <Dialog
        open={statusOpen}
        onOpenChange={(next) => {
          if (!next) closeStatus()
          setCopyState('idle')
        }}
      >
        <DialogContent
          data-slot="huan-host-status"
          aria-label="宿主状态"
          className="flex max-h-[85dvh] max-w-2xl flex-col"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>宿主状态</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                这里只展示宿主受控诊断。登录/退出后会自动重新读取
                readiness；启动配置（用户空间、会话目录）修改后需要重启宿主。
              </Trans>
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-3 overflow-auto text-sm">
            {hostError && (
              <div role="alert" className="text-destructive rounded-md border px-2.5 py-2 text-xs">
                {hostError}
              </div>
            )}
            {protocolMismatch && host && (
              <div role="alert" className="text-destructive rounded-md border px-2.5 py-2 text-xs">
                <Trans>
                  协议版本不匹配：宿主 {host.protocolVersion}，页面 {HARNESS_PROTOCOL_VERSION}。
                  请更新页面或宿主，当前不进行业务初始化。
                </Trans>
              </div>
            )}
            {!host && hostLoading && (
              <p className="text-muted-foreground flex items-center gap-2 text-xs">
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                <Trans>正在查询宿主配置…</Trans>
              </p>
            )}
            {needsModel && readiness && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
                role="status"
                data-slot="huan-host-readiness"
                data-state={readiness.state}
              >
                <span className="min-w-0 flex-1">
                  {readiness.state === 'missing-credentials' ? (
                    <Trans>
                      默认模型缺少凭据。可先登录
                      provider，或选择其他已配置模型；登录后此处会自动刷新。
                    </Trans>
                  ) : readiness.state === 'unavailable-model' ? (
                    <Trans>默认模型不可用：{readiness.message}</Trans>
                  ) : (
                    <Trans>启动默认模型未配置：{readiness.message}</Trans>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    closeStatus()
                    void openAuth({ mode: 'login' })
                  }}
                >
                  <KeyRoundIcon aria-hidden />
                  <Trans>登录 provider</Trans>
                </Button>
              </div>
            )}
            <SessionFallbackNotice />
            {host && (
              <>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt>
                    <Trans>工作目录</Trans>
                  </dt>
                  <dd className="break-all">{host.workspacePath}</dd>
                  <dt>
                    <Trans>用户空间</Trans>
                  </dt>
                  <dd className="break-all">
                    {host.agentDir} ({sourceLabel(host.agentDirSource)})
                  </dd>
                  <dt>
                    <Trans>会话目录</Trans>
                  </dt>
                  <dd className="break-all">
                    {host.sessionStorage.directory} ({sourceLabel(host.sessionStorage.source)})
                  </dd>
                  <dt>
                    <Trans>存储方式</Trans>
                  </dt>
                  <dd>
                    {host.sessionStorage.mode === 'grouped' ? (
                      <Trans>按工作目录分组</Trans>
                    ) : (
                      <Trans>显式共享的平铺目录</Trans>
                    )}
                  </dd>
                  <dt>
                    <Trans>启动默认模型</Trans>
                  </dt>
                  <dd className="break-all">
                    {host.defaultModel.provider ?? '—'} / {host.defaultModel.modelId ?? '—'}
                  </dd>
                  <dt>
                    <Trans>Provider 来源</Trans>
                  </dt>
                  <dd>{sourceLabel(host.defaultModel.providerSource)}</dd>
                  <dt>
                    <Trans>模型来源</Trans>
                  </dt>
                  <dd>{sourceLabel(host.defaultModel.modelIdSource)}</dd>
                </dl>
                {host.diagnostics.length > 0 && (
                  <ul className="list-inside list-disc text-xs">
                    {host.diagnostics.map((code) => (
                      <li key={code}>
                        {code === 'assembly-warning' ? (
                          <Trans>资源装配存在警告，详细原因请查看宿主终端。</Trans>
                        ) : code === 'catalog-refresh-failed' ? (
                          <Trans>模型目录刷新失败，当前目录可能来自缓存。</Trans>
                        ) : (
                          <Trans>历史会话恢复时发生了模型回退，请核对会话当前模型。</Trans>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={refreshing} onClick={() => void refreshHostInfo()}>
              <RefreshCwIcon aria-hidden />
              <Trans>重新查询</Trans>
            </Button>
            <Button variant="outline" disabled={!host} onClick={() => void copy()}>
              <Trans>复制诊断摘要</Trans>
            </Button>
            {copyState !== 'idle' && (
              <span role="status" className="text-muted-foreground text-xs">
                {copyState === 'copied' ? (
                  <Trans>已复制</Trans>
                ) : (
                  <Trans>复制失败，请手工选择信息复制。</Trans>
                )}
              </span>
            )}
            <Button variant="ghost" onClick={closeStatus}>
              <Trans>关闭</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
