import type { HarnessConfigSource, HarnessHostInfo } from '@huan/protocol'
import { useHarnessSession } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { harnessHttpClient } from './pi-http-client'
import { PiModelSelector } from './pi-model-selector'
import { useProviderAuthRevision } from './pi-provider-auth-store'

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

/** 空白会话也能查看用户空间与启动诊断，不把认证信息或任意服务端错误带入页面。 */
export function PiHostStatus() {
  const session = useHarnessSession()
  const [info, setInfo] = useState<HarnessHostInfo>()
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  // 认证/退出后重新读取 readiness；不自动切换当前模型。
  const authRevision = useProviderAuthRevision()

  // attempt 是用户主动重新查询的触发器，不是请求参数；authRevision 变化也需重读。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次显式重试或认证变化都需要重新查询。
  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    harnessHttpClient
      .getHostInfo()
      .then((value) => {
        if (active) {
          setInfo(value)
          setCopyState('idle')
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [attempt, authRevision])

  const readiness = info?.defaultModel.readiness
  const pending = !session?.id || session.id === '__pending__'
  const needsModel = pending && readiness && readiness.state !== 'ready'
  const retry = (
    <Button
      variant="outline"
      size="sm"
      disabled={loading}
      onClick={() => setAttempt((value) => value + 1)}
    >
      <Trans>重新查询</Trans>
    </Button>
  )

  const copy = async () => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section className="border-b px-4 py-2 text-sm" aria-label="Pi host status">
      {failed && (
        <div role="alert" className="flex items-center justify-between gap-3 text-destructive">
          <Trans>
            无法查询宿主。请检查服务是否启动、端口和访问凭证是否一致；启动失败的详细原因请查看宿主终端。
          </Trans>
          {retry}
        </div>
      )}
      {loading && !info && (
        <p role="status">
          <Trans>正在查询宿主配置…</Trans>
        </p>
      )}
      {needsModel && (
        <div className="flex flex-wrap items-center gap-3 py-1" role="status">
          <span>
            {readiness.state === 'missing-credentials' ? (
              <Trans>
                启动默认模型缺少凭据。可在此选择已配置的模型；认证配置修改后需重启宿主。
              </Trans>
            ) : (
              <Trans>
                启动默认模型未配置或不可用。可在此选择模型开始新会话，已有历史仍可查看。
              </Trans>
            )}
          </span>
          <PiModelSelector />
        </div>
      )}
      {info && (
        <details>
          <summary className="cursor-pointer">
            <Trans>宿主信息与诊断</Trans>
          </summary>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-2">
            <dt>
              <Trans>工作目录</Trans>
            </dt>
            <dd className="break-all">{info.workspacePath}</dd>
            <dt>
              <Trans>用户空间</Trans>
            </dt>
            <dd className="break-all">
              {info.agentDir} ({sourceLabel(info.agentDirSource)})
            </dd>
            <dt>
              <Trans>会话目录</Trans>
            </dt>
            <dd className="break-all">
              {info.sessionStorage.directory} ({sourceLabel(info.sessionStorage.source)})
            </dd>
            <dt>
              <Trans>存储方式</Trans>
            </dt>
            <dd>
              {info.sessionStorage.mode === 'grouped' ? (
                <Trans>按工作目录分组</Trans>
              ) : (
                <Trans>显式共享的平铺目录</Trans>
              )}
            </dd>
            <dt>
              <Trans>启动默认模型</Trans>
            </dt>
            <dd className="break-all">
              {info.defaultModel.provider ?? '—'} / {info.defaultModel.modelId ?? '—'}
            </dd>
            <dt>
              <Trans>Provider 来源</Trans>
            </dt>
            <dd>{sourceLabel(info.defaultModel.providerSource)}</dd>
            <dt>
              <Trans>模型来源</Trans>
            </dt>
            <dd>{sourceLabel(info.defaultModel.modelIdSource)}</dd>
          </dl>
          <p>
            <Trans>
              手工设置 PI_CODING_AGENT_DIR 指定用户空间；PI_CODING_AGENT_SESSION_DIR
              可单独指定会话目录。修改后重启宿主。重新查询只读取当前状态，不会重载配置。
            </Trans>
          </p>
          {info.diagnostics.length > 0 && (
            <ul className="list-inside list-disc py-2">
              {info.diagnostics.map((code) => (
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
          <div className="flex items-center gap-2 py-2">
            {!failed && retry}
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              <Trans>复制诊断摘要</Trans>
            </Button>
            {copyState !== 'idle' && (
              <span role="status">
                {copyState === 'copied' ? (
                  <Trans>已复制</Trans>
                ) : (
                  <Trans>复制失败，请手工选择信息复制。</Trans>
                )}
              </span>
            )}
          </div>
        </details>
      )}
    </section>
  )
}
