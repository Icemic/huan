/**
 * 运行操作面板：直接 Shell、上下文压缩与模型范围。
 *
 * 入口放在会话上下文栏（与工作区/项目信息同一行），打开后是紧凑的多段面板。
 * 所有动作经 `@huan/react` 的稳定 actions → 宿主 RPC；面板只展示权威状态，不自行
 * 猜测成功（压缩失败、自动压缩保存失败都会如实显示）。
 */
import type {
  HarnessBashRun,
  HarnessCompactionOutcome,
  HarnessModelInfo,
  HarnessModelScope,
} from '@huan/protocol'
import { useHarnessActions, useHarnessThreadState } from '@huan/react'
import { Trans } from '@lingui/react/macro'
import {
  BanIcon,
  CircleStopIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { useWorkspace } from './workspace-context'

const PENDING_THREAD_ID = '__pending__'

const modelKey = (model: { provider: string; modelId: string }) =>
  `${model.provider}/${model.modelId}`

const errorText = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** Shell/压缩共用的状态行。 */
function StatusLine({ tone, children }: { tone: 'muted' | 'error'; children: ReactNode }) {
  return (
    <p className={tone === 'error' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
      {children}
    </p>
  )
}

/** 一块有界输出（折叠较长内容，保留复制入口由浏览器选择完成）。 */
function OutputBlock({ run }: { run: HarnessBashRun }) {
  const result = run.result
  return (
    <div data-slot="huan-shell-run" className="flex flex-col gap-1 rounded-md border p-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span className="text-foreground font-mono">{run.command}</span>
        {run.excludeFromContext && (
          <span className="rounded bg-muted px-1 py-0.5">
            <Trans>不进入上下文</Trans>
          </span>
        )}
        {run.status === 'running' ? (
          <span className="inline-flex items-center gap-1">
            <Loader2Icon aria-hidden className="size-3 animate-spin" />
            <Trans>运行中</Trans>
          </span>
        ) : result?.error ? (
          <span className="text-destructive">
            <Trans>失败</Trans>
          </span>
        ) : result?.cancelled ? (
          <span>
            <Trans>已取消</Trans>
          </span>
        ) : (
          <span>
            <Trans>退出码 {result?.exitCode ?? '未知'}</Trans>
          </span>
        )}
        {run.outputTruncated && (
          <span>
            <Trans>实时输出已截断</Trans>
          </span>
        )}
        {result?.truncated && (
          <span>
            <Trans>结果已截断</Trans>
          </span>
        )}
      </div>
      {run.output && (
        <pre
          data-slot="huan-shell-output"
          className="max-h-48 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap"
        >
          {run.output}
        </pre>
      )}
      {result?.error && <StatusLine tone="error">{result.error}</StatusLine>}
      {result?.fullOutputPath && (
        <StatusLine tone="muted">
          <Trans>完整输出：{result.fullOutputPath}</Trans>
        </StatusLine>
      )}
    </div>
  )
}

/** 压缩触发原因的中文标签（仅展示，不改变语义）。 */
function compactionReasonLabel(reason: 'manual' | 'threshold' | 'overflow' | undefined): string {
  if (reason === 'manual') return '手动'
  if (reason === 'threshold') return '阈值'
  if (reason === 'overflow') return '超窗'
  return '自动'
}

/** 压缩结果的可读提示；失败与取消都不伪装成成功。 */
function compactionNotice(outcome: HarnessCompactionOutcome): string {
  switch (outcome.status) {
    case 'compacted':
      return `压缩完成（${outcome.tokensBefore ?? '?'} → ${outcome.estimatedTokensAfter ?? '?'} tokens）`
    case 'cancelled':
      return outcome.message ?? '压缩已取消，原始消息树保持不变'
    case 'busy':
      return outcome.message
    case 'failed':
      return outcome.message
  }
}

export function RuntimeOperationsPanel() {
  const threadId = useHarnessThreadState((state) => state.metadata.id)
  return <RuntimeOperationsPanelContent key={threadId} />
}

function RuntimeOperationsPanelContent() {
  const actions = useHarnessActions()
  const metadata = useHarnessThreadState((state) => state.metadata)
  const bash = useHarnessThreadState((state) => state.bash)
  const compaction = useHarnessThreadState((state) => state.compaction)
  const { workspaces, activeWorkspaceId, startProjectFor, hostInfo } = useWorkspace()

  const pendingThread = !metadata.id || metadata.id === PENDING_THREAD_ID
  const threadId = pendingThread ? undefined : metadata.id
  const workspace = metadata.workspaceId
    ? workspaces.find((item) => item.id === metadata.workspaceId)
    : workspaces.find((item) => item.id === activeWorkspaceId)
  const cwd = metadata.workspacePath ?? (workspace ? startProjectFor(workspace) : undefined)

  const [open, setOpen] = useState(false)
  const intent = usePiIntent()
  useEffect(() => {
    if (intent?.kind !== 'runtime-operations') return
    setOpen(true)
    clearPiIntent(intent.id)
  }, [intent])
  const [command, setCommand] = useState('')
  const [excludeFromContext, setExcludeFromContext] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [catalog, setCatalog] = useState<readonly HarnessModelInfo[]>([])
  const [scope, setScope] = useState<HarnessModelScope | undefined>(undefined)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [saveAsDefault, setSaveAsDefault] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const autoCompaction = metadata.autoCompactionEnabled

  /** 目录 + 会话范围：打开面板时读取；空白页只读目录（仍需要固定起始目录）。 */
  useEffect(() => {
    if (!open || !cwd) return
    let active = true
    void (async () => {
      try {
        const models = await harnessHttpClient.getAvailableModels({ workspacePath: cwd })
        if (!active) return
        setCatalog(models)
        if (threadId) {
          const current = await actions.getModelScope()
          if (!active) return
          setScope(current)
          setSelected(
            current.patterns.length > 0
              ? current.models.map(modelKey)
              : models.map((model) => modelKey(model)),
          )
        }
      } catch (error) {
        if (active) setNotice(errorText(error))
      }
    })()
    return () => {
      active = false
    }
  }, [actions, open, threadId, cwd])

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setNotice(undefined)
    void action()
      .catch((error: unknown) => {
        if (mounted.current) setNotice(errorText(error))
      })
      .finally(() => {
        if (mounted.current) setBusy(undefined)
      })
  }

  const submitShell = () =>
    run('shell', async () => {
      const result = await actions.runBash({
        command,
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
      })
      if (!mounted.current) return
      if (result.status === 'started') {
        setCommand('')
        return
      }
      setNotice(result.message)
    })

  const submitCompact = () =>
    run('compact', async () => {
      const outcome = await actions.compact({
        ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}),
      })
      if (mounted.current) setNotice(compactionNotice(outcome))
    })

  const toggleAuto = () =>
    run('auto', async () => {
      if (autoCompaction === undefined) {
        setNotice('会话尚未就绪，暂时无法修改自动压缩设置')
        return
      }
      const result = await actions.setAutoCompaction(!autoCompaction)
      if (!mounted.current) return
      if (result.status === 'failed') {
        setNotice(result.message)
        return
      }
      setNotice(
        result.overridden
          ? (result.message ?? '用户默认已保存，但项目设置覆盖了当前会话')
          : `自动压缩已${result.enabled ? '开启' : '关闭'}（已保存到当前用户设置）`,
      )
    })

  const refreshCatalog = () =>
    run('refresh', async () => {
      const result = await actions.refreshModels(
        threadId || !cwd ? undefined : { workspacePath: cwd },
      )
      if (!mounted.current) return
      setCatalog(result.models)
      setNotice(
        result.failedProviders.length === 0
          ? '模型目录已刷新'
          : result.failedProviders.includes('*')
            ? '模型目录刷新未完成（超时或异常），仍显示缓存目录'
            : `部分 provider 目录刷新失败：${result.failedProviders.join('、')}（仍显示缓存目录）`,
      )
    })

  const saveScope = () =>
    run('scope', async () => {
      const result = await actions.setModelScope({
        patterns: [...selected],
        ...(saveAsDefault ? { saveAsDefault: true } : {}),
      })
      if (!mounted.current) return
      setScope(result)
      // 以宿主返回的权威范围回显选择（无匹配时不会把未生效的选择留在界面上）。
      setSelected(result.patterns.length > 0 ? result.models.map(modelKey) : catalog.map(modelKey))
      setNotice(
        result.message ??
          (result.persistence === 'saved'
            ? '会话范围已应用并保存为用户默认'
            : '会话范围已应用到当前会话'),
      )
      if (result.diagnostics.length > 0) {
        setNotice(
          `${result.message ?? '会话范围已应用'}\n${result.diagnostics
            .map((item) => item.message)
            .join('\n')}`,
        )
      }
    })

  const toggleModel = (key: string) => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="运行操作"
        onClick={() => setOpen(true)}
      >
        <TerminalIcon aria-hidden className="size-3.5" />
        <Trans>运行操作</Trans>
      </Button>
      <DialogContent data-slot="huan-runtime-operations" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>运行操作</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[70dvh] flex-col gap-3 overflow-y-auto pe-1 text-sm">
          {notice && (
            <div
              role="status"
              data-slot="huan-runtime-notice"
              className="rounded-md border bg-muted/50 px-2 py-1.5 text-xs whitespace-pre-wrap"
            >
              {notice}
            </div>
          )}

          {/* ---- 直接 Shell ---- */}
          <section className="flex flex-col gap-2" aria-label="用户 Shell">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">
                <Trans>用户 Shell</Trans>
              </h3>
              {cwd && (
                <span className="text-muted-foreground max-w-64 truncate font-mono text-xs">
                  {cwd}
                </span>
              )}
            </div>
            <StatusLine tone="muted">
              <Trans>
                `!` 纳入模型上下文，`!!` 仅保留历史；命令在固定起始目录直接执行，不提供沙箱，
                外部副作用无法撤销。
              </Trans>
            </StatusLine>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                value={excludeFromContext ? 'exclude' : 'include'}
                items={{ include: '纳入上下文', exclude: '不进入上下文（!!）' }}
                onValueChange={(value) => setExcludeFromContext(value === 'exclude')}
                disabled={!threadId}
              >
                <SelectTrigger size="sm" aria-label="Shell 上下文" className="w-45">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="include">纳入上下文</SelectItem>
                  <SelectItem value="exclude">不进入上下文（!!）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea
              aria-label="Shell 命令"
              rows={2}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="echo hello"
              disabled={!threadId || bash?.status === 'running'}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  !threadId || busy === 'shell' || !command.trim() || bash?.status === 'running'
                }
                onClick={submitShell}
              >
                <PlayIcon aria-hidden className="size-3.5" />
                <Trans>运行 Shell</Trans>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bash?.status !== 'running'}
                onClick={() => run('shell-abort', () => actions.abortBash().then(() => {}))}
              >
                <CircleStopIcon aria-hidden className="size-3.5" />
                <Trans>取消 Shell</Trans>
              </Button>
              {!threadId && (
                <StatusLine tone="muted">
                  <Trans>先建立或打开会话，才能执行 Shell。</Trans>
                </StatusLine>
              )}
            </div>
            {bash && <OutputBlock run={bash} />}
          </section>

          {/* ---- 上下文压缩 ---- */}
          <section className="flex flex-col gap-2 border-t pt-3" aria-label="上下文压缩">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">
                <Trans>上下文压缩</Trans>
              </h3>
              {compaction.active ? (
                <span className="inline-flex items-center gap-1 text-xs">
                  <Loader2Icon aria-hidden className="size-3 animate-spin" />
                  <Trans>压缩中（{compactionReasonLabel(compaction.reason)}）</Trans>
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">
                  <Trans>空闲</Trans>
                </span>
              )}
            </div>
            {compaction.error && <StatusLine tone="error">{compaction.error}</StatusLine>}
            <StatusLine tone="muted">
              <Trans>
                压缩失败或取消都会保留原始消息树；压缩可能产生模型费用。运行中请先停止再压缩。
              </Trans>
            </StatusLine>
            <Textarea
              aria-label="压缩指令"
              rows={2}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="可选：告诉模型摘要应重点保留什么"
              disabled={!threadId || compaction.active}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!threadId || compaction.active || busy === 'compact'}
                onClick={submitCompact}
              >
                <Trans>压缩上下文</Trans>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!compaction.active}
                onClick={() => run('compact-abort', () => actions.abortCompaction().then(() => {}))}
              >
                <Trans>取消压缩</Trans>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={autoCompaction ? 'secondary' : 'outline'}
                aria-pressed={autoCompaction === true}
                aria-label="自动压缩"
                disabled={!threadId || autoCompaction === undefined || busy === 'auto'}
                onClick={toggleAuto}
              >
                <Trans>自动压缩：{autoCompaction ? '开' : '关'}</Trans>
              </Button>
              <StatusLine tone="muted">
                <Trans>
                  开关保存到当前 agentDir 用户设置（{hostInfo?.agentDir ?? '用户目录'}），
                  对所有会话生效；项目设置若覆盖会如实提示。
                </Trans>
              </StatusLine>
            </div>
            {!threadId && (
              <StatusLine tone="muted">
                <Trans>先建立或打开会话，才能压缩或修改自动压缩。</Trans>
              </StatusLine>
            )}
          </section>

          {/* ---- 模型目录与范围 ---- */}
          <section className="flex flex-col gap-2 border-t pt-3" aria-label="模型范围">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">
                <Trans>模型目录与范围</Trans>
              </h3>
              <Button
                size="xs"
                variant="outline"
                disabled={busy === 'refresh' || !cwd}
                onClick={refreshCatalog}
              >
                {busy === 'refresh' ? (
                  <Loader2Icon aria-hidden className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon aria-hidden className="size-3" />
                )}
                <Trans>刷新目录</Trans>
              </Button>
            </div>
            <StatusLine tone="muted">
              <Trans>
                刷新只更新共享目录，不重建会话、不发起模型请求。范围默认只作用于当前会话；
                勾选“保存为用户默认”才写入用户设置并影响未来会话。
              </Trans>
            </StatusLine>
            {threadId ? (
              <>
                <div className="flex flex-col gap-1">
                  {catalog.map((model) => {
                    const key = modelKey(model)
                    const checked = selected.includes(key)
                    return (
                      <Button
                        key={key}
                        size="sm"
                        variant={checked ? 'secondary' : 'outline'}
                        aria-pressed={checked}
                        aria-label={`会话模型 ${key}`}
                        className="justify-start"
                        onClick={() => toggleModel(key)}
                      >
                        <span className="truncate">{model.name ?? model.modelId}</span>
                        <span className="text-muted-foreground ms-auto flex items-center gap-1 text-xs">
                          <span>{model.provider}</span>
                          {model.input?.includes('image') && (
                            <span className="rounded bg-muted px-1">
                              <Trans>图像</Trans>
                            </span>
                          )}
                          {model.availableThinkingLevels?.includes('max') && (
                            <span className="rounded bg-muted px-1">max</span>
                          )}
                        </span>
                      </Button>
                    )
                  })}
                  {catalog.length === 0 && (
                    <StatusLine tone="muted">
                      <Trans>目录为空；请先刷新模型目录。</Trans>
                    </StatusLine>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={saveAsDefault ? 'secondary' : 'outline'}
                    aria-pressed={saveAsDefault}
                    aria-label="同时保存为用户默认"
                    onClick={() => setSaveAsDefault((value) => !value)}
                  >
                    <Trans>同时保存为用户默认</Trans>
                  </Button>
                  <Button size="sm" disabled={busy === 'scope'} onClick={saveScope}>
                    <SlidersHorizontalIcon aria-hidden className="size-3.5" />
                    <Trans>保存会话范围</Trans>
                  </Button>
                  {scope?.savedPatterns && (
                    <StatusLine tone="muted">
                      <Trans>已保存用户默认：{scope.savedPatterns.join('、')}</Trans>
                    </StatusLine>
                  )}
                </div>
                {scope && scope.diagnostics.length > 0 && (
                  <ul className="text-destructive list-disc ps-4 text-xs">
                    {scope.diagnostics.map((item) => (
                      <li key={`${item.code}:${item.pattern}`}>{item.message}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <StatusLine tone="muted">
                <Trans>
                  空白页可以刷新目录；模型范围与自动压缩需要先建立会话（使用会话固定起始目录）。
                </Trans>
              </StatusLine>
            )}
          </section>

          {!threadId && (
            <StatusLine tone="muted">
              <BanIcon aria-hidden className="me-1 inline size-3" />
              <Trans>需要会话的操作在左侧新建会话后可用。</Trans>
            </StatusLine>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
