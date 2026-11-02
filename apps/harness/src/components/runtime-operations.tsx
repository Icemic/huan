/**
 * 运行操作面板：直接 Shell、上下文压缩与模型范围。
 *
 * 入口放在会话上下文栏；`/compact`、`/scoped-models` 命令打开对应分段。
 * 业务状态（固定 target、表单、busy、模型范围 patterns 原文与目录查询）
 * 全部在 runtime feature Zustand；本组件只选择状态并触发动作。
 * Shell/压缩结果始终来自服务端事件，不猜测成功；取消不伪装为完成。
 */

import type { HarnessBashRun } from '@huan/protocol'
import { selectHarnessModelCatalog, useServiceStore } from '@huan/react'
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
import { type ReactNode, useEffect, useMemo } from 'react'
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
import { useRuntimeStore } from '@/state/app-context'
import { scopeModelKeysForPatterns } from '@/state/runtime-store'

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

export function RuntimeOperationsPanel() {
  const open = useRuntimeStore((state) => state.open)
  const target = useRuntimeStore((state) => state.target)
  const section = useRuntimeStore((state) => state.section)
  const shellCommand = useRuntimeStore((state) => state.shellCommand)
  const shellExcludeFromContext = useRuntimeStore((state) => state.shellExcludeFromContext)
  const compactInstructions = useRuntimeStore((state) => state.compactInstructions)
  const patternsText = useRuntimeStore((state) => state.patternsText)
  const basePatternsText = useRuntimeStore((state) => state.basePatternsText)
  const saveAsDefault = useRuntimeStore((state) => state.saveAsDefault)
  const busy = useRuntimeStore((state) => state.busy)
  const notice = useRuntimeStore((state) => state.notice)
  const error = useRuntimeStore((state) => state.error)
  const scopeError = useRuntimeStore((state) => state.scopeError)
  const scope = useRuntimeStore((state) => state.scope)
  const scopeLoading = useRuntimeStore((state) => state.scopeLoading)
  const openPanel = useRuntimeStore((state) => state.openPanel)
  const close = useRuntimeStore((state) => state.close)
  const setShellCommand = useRuntimeStore((state) => state.setShellCommand)
  const setShellExcludeFromContext = useRuntimeStore((state) => state.setShellExcludeFromContext)
  const setCompactInstructions = useRuntimeStore((state) => state.setCompactInstructions)
  const setSaveAsDefault = useRuntimeStore((state) => state.setSaveAsDefault)
  const loadCatalog = useRuntimeStore((state) => state.loadCatalog)
  const refreshCatalog = useRuntimeStore((state) => state.refreshCatalog)
  const loadScope = useRuntimeStore((state) => state.loadScope)
  const updatePatternsText = useRuntimeStore((state) => state.updatePatternsText)
  const resetPatternsDraft = useRuntimeStore((state) => state.resetPatternsDraft)
  const toggleScopeModel = useRuntimeStore((state) => state.toggleScopeModel)
  const saveScope = useRuntimeStore((state) => state.saveScope)
  const runShell = useRuntimeStore((state) => state.runShell)
  const abortShell = useRuntimeStore((state) => state.abortShell)
  const compact = useRuntimeStore((state) => state.compact)
  const abortCompaction = useRuntimeStore((state) => state.abortCompaction)
  const toggleAutoCompaction = useRuntimeStore((state) => state.toggleAutoCompaction)

  const threadId = target?.threadId
  const workspacePath = target?.workspacePath
  const metadata = useServiceStore((state) => (threadId ? state.threadsById[threadId] : undefined))
  const session = useServiceStore((state) =>
    threadId ? state.sessionDataById[threadId] : undefined,
  )
  const entry = useServiceStore((state) =>
    target
      ? selectHarnessModelCatalog(state, {
          workspacePath: target.workspacePath,
          ...(target.threadId ? { threadId: target.threadId } : {}),
        })
      : undefined,
  )
  const authRevision = useServiceStore((state) => state.providerAuth?.authRevision)
  const catalog = entry?.models ?? []
  const catalogLoading = entry?.loading === true
  const selectedKeys = useMemo(
    () => scopeModelKeysForPatterns(patternsText, catalog),
    [patternsText, catalog],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: 认证/目录版本是 serviceStore 查询键
  useEffect(() => {
    if (!open || !target) return
    // 认证版本/会话目录版本变化时重新读取；serviceStore 以同一目标版本为键。
    void loadCatalog()
  }, [open, target, authRevision, metadata?.modelCatalogRevision, loadCatalog])

  const bash = session?.bash
  const compactionActive = metadata?.compactionActive === true
  const autoCompaction = metadata?.autoCompactionEnabled
  const compactionError = session?.compactionError
  const patternsDirty = patternsText !== basePatternsText

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs"
        aria-label="运行操作"
        onClick={() => void openPanel()}
      >
        <TerminalIcon aria-hidden className="size-3.5" />
        <Trans>运行操作</Trans>
      </Button>
      <DialogContent
        data-slot="huan-runtime-operations"
        data-active-section={section}
        className="max-w-xl"
      >
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
          {error && (
            <p role="status" className="text-destructive text-xs">
              {error}
            </p>
          )}
          {scopeError && (
            <p role="status" className="text-destructive text-xs">
              {scopeError}
            </p>
          )}

          {/* ---- 直接 Shell ---- */}
          <section className="flex flex-col gap-2" aria-label="用户 Shell">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">
                <Trans>用户 Shell</Trans>
              </h3>
              {workspacePath && (
                <span className="text-muted-foreground max-w-64 truncate font-mono text-xs">
                  {workspacePath}
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
                value={shellExcludeFromContext ? 'exclude' : 'include'}
                items={{ include: '纳入上下文', exclude: '不进入上下文（!!）' }}
                onValueChange={(value) => setShellExcludeFromContext(value === 'exclude')}
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
              value={shellCommand}
              onChange={(event) => setShellCommand(event.target.value)}
              placeholder="echo hello"
              disabled={!threadId || bash?.status === 'running'}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  !threadId ||
                  busy === 'shell' ||
                  !shellCommand.trim() ||
                  bash?.status === 'running'
                }
                onClick={() => void runShell()}
              >
                <PlayIcon aria-hidden className="size-3.5" />
                <Trans>运行 Shell</Trans>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bash?.status !== 'running' || busy === 'shell-abort'}
                onClick={() => void abortShell()}
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
              {compactionActive ? (
                <span className="inline-flex items-center gap-1 text-xs">
                  <Loader2Icon aria-hidden className="size-3 animate-spin" />
                  <Trans>压缩中（{compactionReasonLabel(metadata?.compactionReason)}）</Trans>
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">
                  <Trans>空闲</Trans>
                </span>
              )}
            </div>
            {compactionError && <StatusLine tone="error">{compactionError}</StatusLine>}
            <StatusLine tone="muted">
              <Trans>
                压缩失败或取消都会保留原始消息树；压缩可能产生模型费用。运行中请先停止再压缩。
              </Trans>
            </StatusLine>
            <Textarea
              aria-label="压缩指令"
              rows={2}
              value={compactInstructions}
              onChange={(event) => setCompactInstructions(event.target.value)}
              placeholder="可选：告诉模型摘要应重点保留什么"
              disabled={!threadId || compactionActive}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!threadId || compactionActive || busy === 'compact'}
                onClick={() => void compact()}
              >
                <Trans>压缩上下文</Trans>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!compactionActive || busy === 'compact-abort'}
                onClick={() => void abortCompaction()}
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
                onClick={() => void toggleAutoCompaction()}
              >
                <Trans>自动压缩：{autoCompaction ? '开' : '关'}</Trans>
              </Button>
              <StatusLine tone="muted">
                <Trans>
                  开关保存到当前 agentDir 用户设置，对所有会话生效；项目设置若覆盖会如实提示。
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
                disabled={busy === 'refresh' || !workspacePath}
                onClick={() => void refreshCatalog()}
              >
                {busy === 'refresh' ? (
                  <Loader2Icon aria-hidden className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon aria-hidden className="size-3" />
                )}
                <Trans>刷新目录</Trans>
              </Button>
              {threadId && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={scopeLoading || busy !== undefined}
                  onClick={() => void loadScope()}
                >
                  <Trans>{scopeLoading ? '读取范围…' : '重新读取范围'}</Trans>
                </Button>
              )}
            </div>
            <StatusLine tone="muted">
              <Trans>
                刷新只更新共享目录，不重建会话、不发起模型请求。范围默认只作用于当前会话；
                勾选“保存为用户默认”才写入用户设置并影响未来会话。patterns 原文保留 Thinking
                后缀，未编辑时不会改写。
              </Trans>
            </StatusLine>
            {threadId ? (
              <>
                <div className="flex flex-col gap-1">
                  {catalogLoading && catalog.length === 0 ? (
                    <StatusLine tone="muted">
                      <Loader2Icon aria-hidden className="me-1 inline size-3 animate-spin" />
                      <Trans>正在读取模型目录…</Trans>
                    </StatusLine>
                  ) : (
                    catalog.map((model) => {
                      const key = `${model.provider}/${model.modelId}`
                      const checked = selectedKeys.includes(key)
                      return (
                        <Button
                          key={key}
                          size="sm"
                          variant={checked ? 'secondary' : 'outline'}
                          aria-pressed={checked}
                          aria-label={`会话模型 ${key}`}
                          className="justify-start"
                          onClick={() => toggleScopeModel(model, catalog)}
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
                    })
                  )}
                  {!catalogLoading && catalog.length === 0 && (
                    <StatusLine tone="muted">
                      <Trans>目录为空；请先刷新模型目录。</Trans>
                    </StatusLine>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    <Trans>patterns 原文（每行一个，可保留 :thinking 后缀）</Trans>
                  </span>
                  <Textarea
                    aria-label="模型范围 patterns"
                    rows={4}
                    className="font-mono text-xs"
                    value={patternsText}
                    onChange={(event) => updatePatternsText(event.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!patternsDirty || busy !== undefined}
                      onClick={resetPatternsDraft}
                    >
                      <Trans>重置 patterns</Trans>
                    </Button>
                    <Button
                      size="sm"
                      variant={saveAsDefault ? 'secondary' : 'outline'}
                      aria-pressed={saveAsDefault}
                      aria-label="同时保存为用户默认"
                      onClick={() => setSaveAsDefault(!saveAsDefault)}
                    >
                      <Trans>同时保存为用户默认</Trans>
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy === 'scope' || scopeLoading}
                      onClick={() => void saveScope()}
                    >
                      <SlidersHorizontalIcon aria-hidden className="size-3.5" />
                      <Trans>保存会话范围</Trans>
                    </Button>
                  </div>
                </div>
                {scope?.savedPatterns && (
                  <StatusLine tone="muted">
                    <Trans>已保存用户默认：{scope.savedPatterns.join('、')}</Trans>
                  </StatusLine>
                )}
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
