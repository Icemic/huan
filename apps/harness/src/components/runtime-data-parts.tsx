/**
 * 运行相关数据消息的渲染器（bash 历史、压缩摘要、分支摘要）。
 *
 * 这些消息在投影里是 assistant-ui 的 data part；不注册渲染器时整条消息不可见。
 * 只注册本应用真正需要可读的三种，保持默认最小改动。
 */
import { useAssistantDataUI } from '@assistant-ui/react'
import { Trans } from '@lingui/react/macro'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

type BashExecutionData = {
  command?: unknown
  output?: unknown
  exitCode?: unknown
  cancelled?: unknown
  truncated?: unknown
  fullOutputPath?: unknown
  excludeFromContext?: unknown
}

/** `!` / `!!` 历史卡片：折叠展示命令与输出，并提供复制。 */
function BashExecutionPart({ data }: { data: BashExecutionData }) {
  const command = typeof data?.command === 'string' ? data.command : ''
  const output = typeof data?.output === 'string' ? data.output : ''
  const exitCode = typeof data?.exitCode === 'number' ? data.exitCode : undefined
  const cancelled = data?.cancelled === true
  const excludeFromContext = data?.excludeFromContext === true
  const fullOutputPath = typeof data?.fullOutputPath === 'string' ? data.fullOutputPath : undefined
  const { isCopied, copyToClipboard } = useCopyToClipboard()

  return (
    <details
      data-slot="huan-bash-message"
      className="group my-2 rounded-lg border bg-muted/20 px-2 py-1.5 text-sm"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
        <span className="font-mono">{command || 'Shell'}</span>
        {excludeFromContext && (
          <span className="rounded bg-muted px-1 py-0.5">
            <Trans>不进入上下文</Trans>
          </span>
        )}
        <span className="text-muted-foreground">
          {cancelled ? (
            <Trans>已取消</Trans>
          ) : exitCode !== undefined ? (
            <Trans>退出码 {exitCode}</Trans>
          ) : (
            <Trans>退出码未知</Trans>
          )}
        </span>
        {data?.truncated === true && (
          <span className="text-muted-foreground">
            <Trans>输出已截断</Trans>
          </span>
        )}
      </summary>
      {output && (
        <pre
          data-slot="huan-bash-message-output"
          className="mt-1 max-h-60 overflow-auto rounded bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap"
        >
          {output}
        </pre>
      )}
      <div className="mt-1 flex items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          aria-label="复制 Shell 输出"
          onClick={() => copyToClipboard(output)}
        >
          {isCopied ? (
            <CheckIcon aria-hidden className="size-3" />
          ) : (
            <CopyIcon aria-hidden className="size-3" />
          )}
          <Trans>复制输出</Trans>
        </Button>
        {fullOutputPath && (
          <span className="text-muted-foreground truncate text-xs">
            <Trans>完整输出：{fullOutputPath}</Trans>
          </span>
        )}
      </div>
    </details>
  )
}

type SummaryData = { summary?: unknown; tokensBefore?: unknown }

/** 压缩摘要：默认折叠，展开可读摘要正文。 */
function CompactionSummaryPart({ data }: { data: SummaryData }) {
  const summary = typeof data?.summary === 'string' ? data.summary : ''
  const tokensBefore = typeof data?.tokensBefore === 'number' ? data.tokensBefore : undefined
  return (
    <details
      data-slot="huan-compaction-summary"
      className="my-2 rounded-lg border bg-muted/30 px-2 py-1.5 text-sm"
    >
      <summary className="cursor-pointer text-xs">
        <Trans>上下文已压缩</Trans>
        {tokensBefore !== undefined && (
          <span className="text-muted-foreground">
            {' '}
            <Trans>（压缩前约 {tokensBefore} tokens）</Trans>
          </span>
        )}
      </summary>
      <div className="mt-1 text-xs whitespace-pre-wrap">{summary}</div>
    </details>
  )
}

/** 分支摘要（树导航产生）：默认折叠。 */
function BranchSummaryPart({ data }: { data: SummaryData }) {
  const summary = typeof data?.summary === 'string' ? data.summary : ''
  return (
    <details
      data-slot="huan-branch-summary"
      className="my-2 rounded-lg border bg-muted/30 px-2 py-1.5 text-sm"
    >
      <summary className="cursor-pointer text-xs">
        <Trans>分支摘要</Trans>
      </summary>
      <div className="mt-1 text-xs whitespace-pre-wrap">{summary}</div>
    </details>
  )
}

/** 挂在运行时内一次即可；不渲染任何可见节点。 */
export function RuntimeDataParts() {
  useAssistantDataUI({ name: 'pi-bash-execution', render: BashExecutionPart })
  useAssistantDataUI({ name: 'pi-compaction-summary', render: CompactionSummaryPart })
  useAssistantDataUI({ name: 'pi-branch-summary', render: BranchSummaryPart })
  return null
}
