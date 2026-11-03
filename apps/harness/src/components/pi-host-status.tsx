/**
 * 宿主状态：协议版本、默认模型 readiness、用户空间/会话目录与诊断。
 *
 * 宿主信息与受控错误在公共 serviceStore；刷新忙状态在 host feature。登录/
 * 退出后由 host store 重新读取 readiness，不在界面暗示“认证修改必须重启”。
 */

import type { HarnessConfigSource } from '@huan/protocol'
import { HARNESS_PROTOCOL_VERSION } from '@huan/protocol'
import { useServiceStore } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { KeyRoundIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from '@/components/ui/item'
import { Separator } from '@/components/ui/separator'
import { useHostStore, useSettingsUiStore } from '@/state/app-context'

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

/** 服务与诊断页内的宿主内容；开关、页签与关闭由统一设置容器负责。 */
export function HostStatusContent() {
  const host = useServiceStore((state) => state.host)
  const hostLoading = useServiceStore((state) => state.hostLoading)
  const hostError = useServiceStore((state) => state.hostError)
  const refreshing = useHostStore((state) => state.refreshing)
  const refreshHostInfo = useHostStore((state) => state.refreshHostInfo)
  const openPage = useSettingsUiStore((state) => state.openPage)
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
    <div data-slot="huan-host-status" className="flex flex-col gap-3 text-sm">
      <h3 className="font-heading text-sm font-medium">
        <Trans>宿主状态</Trans>
      </h3>

      {hostError && (
        <Alert variant="destructive">
          <AlertDescription>{hostError}</AlertDescription>
        </Alert>
      )}
      {protocolMismatch && host && (
        <Alert variant="destructive">
          <AlertDescription>
            <Trans>
              协议版本不匹配：宿主 {host.protocolVersion}，页面 {HARNESS_PROTOCOL_VERSION}。
              请更新页面或宿主，当前不进行业务初始化。
            </Trans>
          </AlertDescription>
        </Alert>
      )}
      {!host && hostLoading && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
          <Trans>正在查询宿主配置…</Trans>
        </p>
      )}
      {needsModel && readiness && (
        <Item
          variant="outline"
          role="status"
          data-slot="huan-host-readiness"
          data-state={readiness.state}
        >
          <ItemContent>
            <ItemDescription className="text-foreground">
              {readiness.state === 'missing-credentials' ? (
                <Trans>默认模型缺少凭据，请登录或选择其他模型</Trans>
              ) : readiness.state === 'unavailable-model' ? (
                <Trans>默认模型不可用：{readiness.message}</Trans>
              ) : (
                <Trans>启动默认模型未配置：{readiness.message}</Trans>
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openPage('models', { mode: 'login' })}
            >
              <KeyRoundIcon aria-hidden />
              <Trans>登录服务商</Trans>
            </Button>
          </ItemActions>
        </Item>
      )}
      {host && (
        <>
          <dl className="flex flex-col">
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>工作目录</Trans>
              </dt>
              <dd className="min-w-0 flex-1 break-all">{host.workspacePath}</dd>
            </Item>
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>用户空间</Trans>
              </dt>
              <dd className="min-w-0 flex-1 break-all">
                {host.agentDir} ({sourceLabel(host.agentDirSource)})
                <span
                  className="text-muted-foreground block text-xs"
                  data-slot="huan-host-restart-note"
                >
                  <Trans>启动时读取，修改后需重启服务</Trans>
                </span>
              </dd>
            </Item>
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>会话目录</Trans>
              </dt>
              <dd className="min-w-0 flex-1 break-all">
                {host.sessionStorage.directory} ({sourceLabel(host.sessionStorage.source)})
                <span
                  className="text-muted-foreground block text-xs"
                  data-slot="huan-host-restart-note"
                >
                  <Trans>启动时读取，修改后需重启服务</Trans>
                </span>
              </dd>
            </Item>
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>存储方式</Trans>
              </dt>
              <dd>
                <Badge variant="secondary">
                  {host.sessionStorage.mode === 'grouped' ? (
                    <Trans>按工作目录分组</Trans>
                  ) : (
                    <Trans>显式共享的平铺目录</Trans>
                  )}
                </Badge>
              </dd>
            </Item>
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>启动默认模型</Trans>
              </dt>
              <dd className="min-w-0 flex-1 break-all">
                {host.defaultModel.provider ?? '—'} / {host.defaultModel.modelId ?? '—'}
                <span
                  className="text-muted-foreground block text-xs"
                  data-slot="huan-host-restart-note"
                >
                  <Trans>启动时读取，修改后需重启服务</Trans>
                </span>
              </dd>
            </Item>
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>Provider 来源</Trans>
              </dt>
              <dd className="min-w-0 flex-1">{sourceLabel(host.defaultModel.providerSource)}</dd>
            </Item>
            <Item size="xs">
              <dt className="text-muted-foreground shrink-0">
                <Trans>模型来源</Trans>
              </dt>
              <dd className="min-w-0 flex-1">{sourceLabel(host.defaultModel.modelIdSource)}</dd>
            </Item>
          </dl>
          {host.diagnostics.length > 0 && (
            <ItemGroup className="gap-2">
              {host.diagnostics.map((code) => (
                <Item key={code} variant="muted" size="sm" data-slot="huan-host-diagnostic">
                  <ItemContent>
                    <ItemDescription>
                      {code === 'assembly-warning' ? (
                        <Trans>资源装配存在警告，详细原因请查看宿主终端。</Trans>
                      ) : code === 'catalog-refresh-failed' ? (
                        <Trans>模型目录刷新失败，当前目录可能来自缓存。</Trans>
                      ) : (
                        <Trans>历史会话恢复时发生了模型回退，请核对会话当前模型。</Trans>
                      )}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
        </>
      )}

      <Separator />
      <div className="flex flex-wrap items-center gap-2">
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
      </div>
    </div>
  )
}
